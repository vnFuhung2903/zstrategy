/**
 * Commitment + nullifier derivation for the OrderFill circuit.
 *
 * Encoding MUST stay byte-identical to `circuits/order_fill/src/main.nr` and
 * the Solidity public-input layout in `CommitmentRegistry.executeCommitment`.
 *
 * Preimage (185 bytes, packed big-endian):
 *   tokenIn(20) || tokenOut(20) || size(32) || minOut(32) || expiry(8)
 *     || price(8) || direction(1) || nonce(32) || user_secret(32)
 */

import { keccak256, encodePacked } from "viem";
import type { StrategyDirection } from "./strategyStore";

// BN254 scalar field modulus. The Noir `Field` type is this group, and both
// noir_js (off-chain prover) and OrderFillVerifier.sol (on-chain) reject any
// public input ≥ P with "Input exceeds field modulus" / `ValueGeFieldOrder`.
// Most keccak256 outputs and CSPRNG bytes are ≥ P (P ≈ 0.19 × 2^256), so we
// must reduce every Field-typed value (commitment, nullifier, user_secret,
// nonce) before it crosses a circuit boundary.
//
// Reducing the *output* hashes is not enough on its own — `nonce` and
// `user_secret` also appear as raw 32 bytes inside the commitment preimage,
// and the circuit recomputes the commitment using their canonical Field-to-
// bytes encoding (i.e. `(value mod P)` as 32 BE bytes). If we let the raw
// bytes drift away from the reduced encoding, off-chain and in-circuit
// commitments disagree and the proof fails the equality assertion. Forcing
// the inputs themselves < P at generation keeps both encodings identical.
export const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function reduceToField(value: `0x${string}`): `0x${string}` {
  const reduced = BigInt(value) % BN254_FIELD_MODULUS;
  return ("0x" + reduced.toString(16).padStart(64, "0")) as `0x${string}`;
}

export interface PreimageFields {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: bigint;
  minOut: bigint;
  expiry: bigint; // uint64 — pass as bigint to viem
  price: bigint; // uint64
  direction: StrategyDirection;
  nonce: `0x${string}`; // bytes32
  userSecret: `0x${string}`; // bytes32
}

export function commitmentHash(p: PreimageFields): `0x${string}` {
  return reduceToField(keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint64", "uint64", "uint8", "bytes32", "bytes32"],
      [p.tokenIn, p.tokenOut, p.size, p.minOut, p.expiry, p.price, p.direction, p.nonce, p.userSecret],
    ),
  ));
}

export function nullifierHash(userSecret: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return reduceToField(keccak256(encodePacked(["bytes32", "bytes32"], [userSecret, nonce])));
}

/** strategyId = keccak256(owner || nonce). Public — used as the message the wallet signs. */
export function deriveStrategyId(owner: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["address", "bytes32"], [owner, nonce]));
}

/** user_secret = keccak256(signature) reduced mod P. Wallet signature on strategyId is deterministic. */
export function deriveUserSecret(signature: `0x${string}`): `0x${string}` {
  return reduceToField(keccak256(signature));
}

// Nonce is used both as a raw 32-byte slice of the commitment preimage and as
// a Noir `Field` witness. Rejection-sample so the value < P; otherwise the
// two encodings diverge (see BN254_FIELD_MODULUS comment).
export function randomBytes32(): `0x${string}` {
  for (;;) {
    const arr = crypto.getRandomValues(new Uint8Array(32));
    const hex = `0x${Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    if (BigInt(hex) < BN254_FIELD_MODULUS) return hex;
  }
}

/** Build the human-readable string the wallet is asked to sign. */
export function strategyIdSigningMessage(strategyId: `0x${string}`): string {
  return `zstrategy: derive user_secret for strategyId=${strategyId}`;
}
