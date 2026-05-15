import { ethers } from "ethers";
import { registryWriter } from "../chain/contracts";
import { ethUsdOracle } from "../chain/oracle";
import { config } from "../config";
import { ExecuteRequest } from "../types";
import { generateOrderFillProof } from "../zk/orderFill";
import { generateDcaProof } from "../zk/dca";

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Notify the Go backend that a strategy is definitively done (e.g. nullifier
 * spent, retry budget exhausted). Fire-and-forget: if the call fails, the
 * 10-minute stuck-EXECUTING sweeper will eventually unwedge it anyway.
 */
async function notifyBackendDone(commitmentHash: string, reason: string): Promise<void> {
  if (!config.backendUrl) return;
  const url = `${config.backendUrl.replace(/\/+$/, "")}/api/v1/strategies/${commitmentHash}/done`;
  try {
    await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${config.apiSecret}`,
      },
      body: JSON.stringify({ reason }),
    });
  } catch (err) {
    console.warn(`[Submitter] backend done callback failed: ${err}`);
  }
}

/**
 * Submit executeCommitment with exponential backoff retry.
 *
 * Accepts a fully-resolved ExecuteRequest (user_secret already reconstructed
 * by the /api/execute handler). Generates the ZK proof, submits the tx, and
 * retries on transient failures.
 */
export async function submitExecution(req: ExecuteRequest): Promise<string> {
  let lastError: Error = new Error("unknown");

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    try {
      console.log(
        `[Submitter] attempt=${attempt + 1}/${config.maxRetries} ` +
        `hash=${req.commitmentHash.slice(0, 10)}...`,
      );

      let proof: `0x${string}`;

      if (req.kind === "DCA") {
        const blockTimestamp = Math.floor(Date.now() / 1000);
        proof = await generateDcaProof(
          {
            scheduledLo:    req.scheduledLo!,
            scheduledHi:    req.scheduledHi!,
            nonce:          req.nonce as `0x${string}`,
            userSecret:     req.userSecret as `0x${string}`,
            commitmentHash: req.commitmentHash as `0x${string}`,
            blockTimestamp,
            nullifier:      req.nullifier as `0x${string}`,
            tokenIn:        req.tokenIn  as `0x${string}`,
            tokenOut:       req.tokenOut as `0x${string}`,
            size:           req.size,
            minOut:         req.minOut,
            expiry:         req.expiry,
          },
          config.dcaCircuitJsonPath,
        );
      } else {
        // ORDER_FILL: contract reads Chainlink at execution; proof must match.
        const oracle = await ethUsdOracle.fetchPrice();
        proof = await generateOrderFillProof(
          {
            price:          req.limitPrice,
            direction:      req.direction === "SELL" ? 1 : 0,
            nonce:          req.nonce as `0x${string}`,
            userSecret:     req.userSecret as `0x${string}`,
            commitmentHash: req.commitmentHash as `0x${string}`,
            oraclePrice:    oracle.price,
            nullifier:      req.nullifier as `0x${string}`,
            tokenIn:        req.tokenIn  as `0x${string}`,
            tokenOut:       req.tokenOut as `0x${string}`,
            size:           req.size,
            minOut:         req.minOut,
            expiry:         BigInt(req.expiry),
          },
          config.circuitJsonPath,
        );
      }

      // ── Preflight via eth_call ────────────────────────────────────────
      // Simulate the on-chain call before paying real gas. Catches:
      //   • "GasVault: insufficient gas balance" — user-fixable, sweeper retries
      //   • "Registry: invalid proof"            — verifier rejected the proof
      //   • "Registry: nullifier spent"          — race with another execute
      //   • "Registry: stale oracle"             — feed went stale during proof gen
      // We pin the real-submit gasPrice to `previewGasPrice` so the contract's
      // `_debitGas` cost matches what we simulated. Otherwise a gas spike
      // between preflight and submit could pass simulation but revert the
      // real tx with the user's tank just-barely-too-small.
      const feeData = await registryWriter.runner!.provider!.getFeeData();
      const previewGasPrice = feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
      try {
        await registryWriter.executeCommitment.staticCall(
          req.commitmentHash, req.nullifier, proof,
          { gasPrice: previewGasPrice },
        );
      } catch (preflightErr) {
        const msg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
        console.warn(`[Submitter] preflight reverted: ${msg}`);
        if (isUserFixableRevert(msg)) {
          // Don't notifyBackendDone — the backend's 10-min stuck-EXECUTING
          // sweeper will reset to PENDING; if the user has topped up by then,
          // the next monitor tick re-triggers. Keeps strategy recoverable.
          throw new Error(`[Submitter] user-fixable revert for ${req.commitmentHash}: ${msg}`);
        }
        if (isDefinitiveRevert(msg)) {
          await notifyBackendDone(req.commitmentHash, `preflight: ${msg}`);
          throw new Error(`[Submitter] preflight definitive revert for ${req.commitmentHash}: ${msg}`);
        }
        // Non-definitive (RPC hiccup, etc.) — fall through and let real submit try
      }

      const tx: ethers.TransactionResponse = await registryWriter.executeCommitment(
        req.commitmentHash,
        req.nullifier,
        proof,
        { gasPrice: previewGasPrice },
      );

      console.log(`[Submitter] tx submitted: ${tx.hash}`);
      const receipt = await tx.wait(1);

      if (!receipt || receipt.status !== 1) {
        throw new Error(`Transaction reverted: ${tx.hash}`);
      }

      console.log(`[Submitter] executed hash=${req.commitmentHash.slice(0, 10)}... tx=${tx.hash}`);
      return tx.hash;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Submitter] attempt ${attempt + 1} failed: ${lastError.message}`);

      if (isUserFixableRevert(lastError.message)) {
        // Same path as the preflight branch: leave the strategy EXECUTING in
        // the backend; the stuck-EXECUTING sweeper recovers it after 10 min.
        console.warn(`[Submitter] user-fixable revert — not retrying, sweeper will resume`);
        throw new Error(`[Submitter] user-fixable revert for ${req.commitmentHash}: ${lastError.message}`);
      }

      if (isDefinitiveRevert(lastError.message)) {
        console.error(`[Submitter] definitive revert — not retrying`);
        await notifyBackendDone(req.commitmentHash, lastError.message);
        throw new Error(`[Submitter] definitive revert for ${req.commitmentHash}: ${lastError.message}`);
      }

      const backoffMs = config.retryBaseDelayMs * Math.pow(2, attempt);
      console.log(`[Submitter] retrying in ${backoffMs}ms...`);
      await delay(backoffMs);
    }
  }

  // Retry budget exhausted — terminal from this fill's perspective. Don't
  // notify for user-fixable errors so the user can still recover (the loop
  // above already exits early for those, but defend in depth).
  if (!isUserFixableRevert(lastError.message)) {
    await notifyBackendDone(req.commitmentHash, `max retries exceeded: ${lastError.message}`);
  }
  throw new Error(
    `[Submitter] max retries exceeded for ${req.commitmentHash}: ${lastError.message}`,
  );
}

/**
 * Reverts the user can recover from by changing their state off-chain
 * (e.g. topping up the gas tank). The keeper must NOT call `notifyBackendDone`
 * for these — that would mark the strategy permanently DONE and orphan it,
 * preventing recovery. Instead, throw and let the backend's stuck-EXECUTING
 * sweeper reset the row to PENDING after its timeout, by which point the
 * user may have fixed the underlying issue.
 */
function isUserFixableRevert(message: string): boolean {
  return message.includes("GasVault: insufficient gas balance");
}

function isDefinitiveRevert(message: string): boolean {
  const definitive = [
    "Registry: not pending",
    "Registry: nullifier spent",
    "Registry: expired",
    "Registry: invalid proof",
    "Registry: paused",
    "Registry: stale oracle",
    "Registry: no price feed",
  ];
  return definitive.some(r => message.includes(r));
}
