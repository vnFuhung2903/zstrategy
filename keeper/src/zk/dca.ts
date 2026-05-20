/**
 * UltraHonk proof generation for the DCA circuit.
 *
 * The DCA circuit uses `block_timestamp` as its fill-time public input instead
 * of an oracle price. The keeper generates the proof with the current wall-clock
 * timestamp and submits immediately. If the tx lands in a block whose
 * `block.timestamp` differs by more than a few seconds, the verifier will reject
 * and the keeper retries next tick. DCA execution windows are hours wide, so
 * the drift is inconsequential.
 *
 * Witness inputs use the snake_case names from `circuits/dca/src/main.nr`.
 */

import { readFileSync } from "fs";
import { isAbsolute, resolve } from "path";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, Barretenberg } from "@aztec/bb.js";

interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
}

let cached: { noir: Noir; backend: UltraHonkBackend } | null = null;

async function loadCircuit(circuitPath: string): Promise<{ noir: Noir; backend: UltraHonkBackend }> {
  if (cached) return cached;
  const abs = isAbsolute(circuitPath) ? circuitPath : resolve(process.cwd(), circuitPath);
  const raw = readFileSync(abs, "utf-8");
  const circuit = JSON.parse(raw) as CompiledCircuit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(circuit as any);
  const api = await Barretenberg.new();
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  cached = { noir, backend };
  return cached;
}

export interface DcaWitness {
  // Private inputs
  scheduledLo:    number;        // u64 — window open
  scheduledHi:    number;        // u64 — window close
  nonce:          `0x${string}`; // bytes32
  userSecret:     `0x${string}`; // bytes32
  // Public inputs — must match what CommitmentRegistry passes to the verifier
  commitmentHash: `0x${string}`;
  blockTimestamp: number;        // u64 — use Math.floor(Date.now()/1000) at submit time
  nullifier:      `0x${string}`;
  tokenIn:        `0x${string}`;
  tokenOut:       `0x${string}`;
  size:           bigint;
  minOut:         bigint;
  expiry:         number;        // u64
}

export async function generateDcaProof(
  inputs: DcaWitness,
  circuitJsonPath: string,
): Promise<`0x${string}`> {
  const { noir, backend } = await loadCircuit(circuitJsonPath);

  const witnessInputs = {
    // private
    scheduled_lo: inputs.scheduledLo.toString(),
    scheduled_hi: inputs.scheduledHi.toString(),
    nonce:        inputs.nonce,
    user_secret:  inputs.userSecret,
    // public
    commitment_hash: inputs.commitmentHash,
    block_timestamp: inputs.blockTimestamp.toString(),
    nullifier:       inputs.nullifier,
    token_in:        inputs.tokenIn,
    token_out:       inputs.tokenOut,
    size:            inputs.size.toString(),
    min_out:         inputs.minOut.toString(),
    expiry:          inputs.expiry.toString(),
  };

  const { witness } = await noir.execute(witnessInputs);
  // DCAVerifier.sol is a `UltraKeccakZKFlavor` verifier — see orderFill.ts
  // for why `verifierTarget: 'evm'` (ZK) is required and `'evm-no-zk'` is not.
  const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });

  // Off-chain integrity gate. With MockZKVerifier swapped in on-chain (thesis-
  // demo workaround for the upstream bb Solidity-codegen bug — see
  // contracts/scripts/swap-to-mock-verifier.ts), this is the ONLY check that
  // the proof actually proves the statement. A FAIL here means we'd be asking
  // the mock to rubber-stamp a proof bb.js itself rejects — exactly the trust
  // break we want to refuse. So we abort instead of submitting.
  let ok: boolean;
  try {
    ok = await backend.verifyProof(proofData, { verifierTarget: "evm" });
  } catch (err) {
    throw new Error(`[ZK] dca off-chain verifyProof threw — refusing to submit: ${err}`);
  }
  if (!ok) {
    throw new Error(`[ZK] dca off-chain verifyProof returned FAIL — refusing to submit`);
  }
  console.log(`[ZK] dca off-chain verifyProof: PASS`);

  return ("0x" + bytesToHex(proofData.proof)) as `0x${string}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
