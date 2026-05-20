/**
 * UltraHonk proof generation for the OrderFill circuit.
 *
 * Loads the compiled circuit JSON (output of `nargo compile`) once and reuses
 * the Noir interpreter + Barretenberg backend across calls. Proof bytes are
 * keccak-flavored to match the `--oracle_hash keccak` Solidity verifier the
 * user generated via `bb write_solidity`.
 *
 * Witness inputs use the snake_case names from `circuits/order_fill/src/main.nr`.
 * Public inputs are returned in main.nr declaration order — we don't pass them
 * back up because the Solidity registry assembles them from on-chain state at
 * fill time. We only need the proof bytes here.
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

export interface OrderFillWitness {
  // Private inputs (the privacy-bearing fields)
  price: bigint;
  direction: 0 | 1;
  nonce: `0x${string}`;
  userSecret: `0x${string}`;
  // Public inputs (must agree with what the registry feeds the verifier)
  commitmentHash: `0x${string}`;
  oraclePrice: bigint;
  nullifier: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: bigint;
  minOut: bigint;
  expiry: bigint;
}

/**
 * Generate the UltraHonk proof. Returns `0x`-prefixed hex bytes ready for
 * `CommitmentRegistry.executeCommitment(_, _, proof)`.
 */
export async function generateOrderFillProof(
  inputs: OrderFillWitness,
  circuitJsonPath: string,
): Promise<`0x${string}`> {
  const { noir, backend } = await loadCircuit(circuitJsonPath);

  const witnessInputs = {
    // private
    price:        inputs.price.toString(),
    direction:    inputs.direction === 1,
    nonce:        inputs.nonce,
    user_secret:  inputs.userSecret,
    // public
    commitment_hash: inputs.commitmentHash,
    oracle_price:    inputs.oraclePrice.toString(),
    nullifier:       inputs.nullifier,
    token_in:        inputs.tokenIn,
    token_out:       inputs.tokenOut,
    size:            inputs.size.toString(),
    min_out:         inputs.minOut.toString(),
    expiry:          inputs.expiry.toString(),
  };

  const { witness } = await noir.execute(witnessInputs);

  // OrderFillVerifier.sol is a `UltraKeccakZKFlavor` verifier (see the
  // "matching UltraKeccakZKFlavor" comment in the generated contract). The
  // ZK flavor's proof carries extra Libra commitments + masking polynomials,
  // so a non-ZK proof fails the verifier's bare `require(proof.length ==
  // expectedProofSize)` with empty revert data. `verifierTarget: 'evm'`
  // selects the EVM-targeted ZK Honk flavor; `'evm-no-zk'` would generate
  // the wrong shape. (bb.js 4.x deprecated the old `{ keccak: true }` /
  // `{ keccakZK: true }` flags in favor of `verifierTarget`.)
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
    throw new Error(`[ZK] order_fill off-chain verifyProof threw — refusing to submit: ${err}`);
  }
  if (!ok) {
    throw new Error(`[ZK] order_fill off-chain verifyProof returned FAIL — refusing to submit`);
  }
  console.log(`[ZK] order_fill off-chain verifyProof: PASS`);

  return ("0x" + bytesToHex(proofData.proof)) as `0x${string}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
