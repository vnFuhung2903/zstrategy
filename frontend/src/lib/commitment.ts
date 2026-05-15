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
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint64", "uint64", "uint8", "bytes32", "bytes32"],
      [p.tokenIn, p.tokenOut, p.size, p.minOut, p.expiry, p.price, p.direction, p.nonce, p.userSecret],
    ),
  );
}

export function nullifierHash(userSecret: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "bytes32"], [userSecret, nonce]));
}

/** strategyId = keccak256(owner || nonce). Public — used as the message the wallet signs. */
export function deriveStrategyId(owner: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["address", "bytes32"], [owner, nonce]));
}

/** user_secret = keccak256(signature). Wallet signature on strategyId is deterministic. */
export function deriveUserSecret(signature: `0x${string}`): `0x${string}` {
  return keccak256(signature);
}

export function randomBytes32(): `0x${string}` {
  const arr = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

/** Build the human-readable string the wallet is asked to sign. */
export function strategyIdSigningMessage(strategyId: `0x${string}`): string {
  return `zstrategy: derive user_secret for strategyId=${strategyId}`;
}
