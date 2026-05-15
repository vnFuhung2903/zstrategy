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

  // `keccak: true` selects the EVM-compatible Honk transcript hash. If the
  // bb.js version doesn't accept this option (e.g. older releases use
  // `UltraKeccakHonkBackend` instead), bump bb.js to ≥ 0.99 to match how the
  // OrderFillVerifier.sol was generated.
  const { proof } = await backend.generateProof(witness, { keccak: true });

  return ("0x" + bytesToHex(proof)) as `0x${string}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
