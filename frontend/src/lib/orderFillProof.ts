/**
 * UltraHonk proof generation for the OrderFill circuit (browser side).
 *
 * Mirrors `keeper/src/zk/orderFill.ts` so the same proof bytes can be produced
 * in the browser (self-execute fallback) or by the keeper (default path).
 *
 * The compiled circuit JSON is served from `/circuits/order_fill.json` —
 * `frontend/scripts/copy-circuit.mjs` copies it from
 * `circuits/order_fill/target/order_fill.json` before dev/build.
 *
 * bb.js + noir_js are dynamic-imported on first call so the (large) WASM
 * payload doesn't bloat the initial bundle and never tries to load on the
 * server during SSR.
 */

import type { StrategyDirection } from "./strategyStore";

interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
}

let cachedCircuit: CompiledCircuit | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedNoir: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedBackend: any = null;

async function loadCircuit(): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  noir: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  backend: any;
}> {
  if (cachedNoir && cachedBackend) return { noir: cachedNoir, backend: cachedBackend };

  if (!cachedCircuit) {
    const res = await fetch("/circuits/order_fill.json");
    if (!res.ok) {
      throw new Error(
        `Failed to load circuit JSON (HTTP ${res.status}). ` +
        `Run \`nargo compile\` in circuits/order_fill, then restart the dev server.`,
      );
    }
    cachedCircuit = (await res.json()) as CompiledCircuit;
  }

  const [{ Noir }, { UltraHonkBackend, Barretenberg }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cachedNoir = new Noir(cachedCircuit as any);
  const api = await Barretenberg.new();
  cachedBackend = new UltraHonkBackend(cachedCircuit.bytecode, api);
  return { noir: cachedNoir, backend: cachedBackend };
}

export interface OrderFillWitness {
  // Private
  price: bigint;
  direction: StrategyDirection; // 0 = BUY, 1 = SELL
  nonce: `0x${string}`;
  userSecret: `0x${string}`;
  // Public (must agree with what the registry feeds the verifier on-chain)
  commitmentHash: `0x${string}`;
  oraclePrice: bigint;
  nullifier: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: bigint;
  minOut: bigint;
  expiry: bigint;
}

export async function generateOrderFillProof(inputs: OrderFillWitness): Promise<`0x${string}`> {
  const { noir, backend } = await loadCircuit();

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
  // `keccak: true` selects the EVM-compatible Honk transcript that matches
  // ZKVerifier.sol generated via `bb write_solidity --oracle_hash keccak`.
  const { proof } = (await backend.generateProof(witness, { keccak: true })) as { proof: Uint8Array };

  let hex = "";
  for (let i = 0; i < proof.length; i++) hex += proof[i].toString(16).padStart(2, "0");
  return ("0x" + hex) as `0x${string}`;
}
