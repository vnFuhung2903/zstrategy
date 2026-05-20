import { ethers } from "ethers";
import { registryWriter } from "../chain/contracts";
import { fetchPairPrice } from "../chain/oracle";
import { config } from "../config";
import { ExecuteRequest } from "../types";
import { generateOrderFillProof } from "../zk/orderFill";
import { generateDcaProof } from "../zk/dca";
import { proofGenerationSeconds } from "../metrics";

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
      const proofTimer = proofGenerationSeconds.labels(req.kind).startTimer();

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
        // Derive the pair price from two registry feeds — same formula as _readOraclePrice.
        const pairPrice = await fetchPairPrice(req.tokenIn, req.tokenOut);
        proof = await generateOrderFillProof(
          {
            price:          req.limitPrice,
            direction:      req.direction === "SELL" ? 1 : 0,
            nonce:          req.nonce as `0x${string}`,
            userSecret:     req.userSecret as `0x${string}`,
            commitmentHash: req.commitmentHash as `0x${string}`,
            oraclePrice:    pairPrice,
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
      proofTimer();

      // 10× safety buffer on the fetched fee. Proof generation takes ~30s and
      // can be retried, so the base fee at submission time may exceed what we
      // sampled here; without the buffer the node can reject with "max fee per
      // gas less than block base fee". The buffer raises the gas-tank debit by
      // ~10× in stable periods but keeps fills landing through fee spikes.
      // Frontend's PER_EXECUTION_GAS_PRICE_WEI is sized to match (see
      // `useGasVault.ts`).
      const GAS_PRICE_BUFFER = 10n;
      const feeData = await registryWriter.runner!.provider!.getFeeData();
      const baseGasPrice = feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
      const previewGasPrice = baseGasPrice * GAS_PRICE_BUFFER;

      // Pin gasLimit so ethers v6 skips eth_estimateGas. Arbitrum's
      // estimateGas binary-searches gas values and is known to return
      // spurious empty-data reverts during that search for txs whose
      // sub-calls (UniswapV3 swap, verifier) are complex — even when an
      // eth_call at a fixed gas would succeed. 5_000_000 is ~4× the
      // worst-case expected ~1.2M (UltraHonk verify ~800k + swap ~200k +
      // vault/debit overhead). Reverted txs on Arbitrum still consume gas,
      // so we don't want this absurdly high.
      const PINNED_GAS_LIMIT = 5_000_000n;
      const tx: ethers.TransactionResponse = await registryWriter.executeCommitment(
        req.commitmentHash,
        req.nullifier,
        proof,
        { gasPrice: previewGasPrice, gasLimit: PINNED_GAS_LIMIT },
      );

      console.log(`[Submitter] tx submitted: ${tx.hash}`);

      // ethers v6: tx.wait() THROWS on revert (the receipt comes back inside
      // the error). Capture the receipt from either branch so we always have
      // it to drive the post-mortem.
      let receipt: ethers.TransactionReceipt | null = null;
      try {
        receipt = await tx.wait(1);
      } catch (waitErr) {
        const r = (waitErr as { receipt?: ethers.TransactionReceipt | null }).receipt;
        if (r) receipt = r;
        else throw waitErr;
      }

      if (!receipt || receipt.status !== 1) {
        // Reverted on-chain. Re-run the same call as eth_call at the failing
        // block to recover the decodable revert reason — the receipt itself
        // doesn't carry the revert data, but a replay eth_call does.
        console.warn(
          `[Submitter] tx reverted on-chain hash=${tx.hash} ` +
          `block=${receipt?.blockNumber} gasUsed=${receipt?.gasUsed} ` +
          `— replaying as eth_call to recover revert reason...`,
        );
        try {
          await registryWriter.runner!.provider!.call({
            to:       await registryWriter.getAddress(),
            from:     await (registryWriter.runner as ethers.Signer).getAddress(),
            data:     registryWriter.interface.encodeFunctionData(
              "executeCommitment",
              [req.commitmentHash, req.nullifier, proof],
            ),
            gasPrice: previewGasPrice,
            gasLimit: PINNED_GAS_LIMIT,
            blockTag: receipt?.blockNumber,
          });
        } catch (replayErr) {
          const m = replayErr instanceof Error ? replayErr.message : String(replayErr);
          // ethers stuffs decoded custom-error selectors into `.data` on the
          // thrown error — log it raw so we can grep on-chain for the selector.
          const data = (replayErr as { data?: string }).data;
          throw new Error(
            `Transaction reverted: ${tx.hash} — replay revert: ${m}` +
            (data ? ` (data=${data})` : ""),
          );
        }
        throw new Error(
          `Transaction reverted: ${tx.hash} (replay at block ${receipt?.blockNumber} did NOT reproduce — likely transient state, e.g. pool/oracle moved by the time we re-queried)`,
        );
      }

      console.log(`[Submitter] executed hash=${req.commitmentHash.slice(0, 10)}... tx=${tx.hash}`);
      return tx.hash;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Submitter] attempt ${attempt + 1} failed: ${lastError.message}`);

      if (isUserFixableRevert(lastError.message)) {
        // Leave the strategy EXECUTING in the backend; the stuck-EXECUTING
        // sweeper recovers it after 10 min, by which point the user may have
        // fixed the underlying issue (e.g. topped up the gas tank).
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
