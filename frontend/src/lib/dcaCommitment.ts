/**
 * Commitment + nullifier derivation for the DCA circuit.
 *
 * Encoding MUST stay byte-identical to `circuits/dca/src/main.nr` compute_commitment.
 *
 * Preimage (192 bytes, packed big-endian):
 *   tokenIn(20) || tokenOut(20) || size(32) || minOut(32) ||
 *   scheduledLo(8) || scheduledHi(8) || expiry(8) ||
 *   nonce(32) || user_secret(32)
 */

import { keccak256, encodePacked } from "viem";

export interface DcaPreimageFields {
  tokenIn:     `0x${string}`;
  tokenOut:    `0x${string}`;
  size:        bigint; // uint256
  minOut:      bigint; // uint256
  scheduledLo: bigint; // uint64 — window open (Unix seconds)
  scheduledHi: bigint; // uint64 — window close
  expiry:      bigint; // uint64 — commitment deadline
  nonce:       `0x${string}`; // bytes32
  userSecret:  `0x${string}`; // bytes32
}

export function dcaCommitmentHash(p: DcaPreimageFields): `0x${string}` {
  return keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint64", "uint64", "uint64", "bytes32", "bytes32"],
      [p.tokenIn, p.tokenOut, p.size, p.minOut, p.scheduledLo, p.scheduledHi, p.expiry, p.nonce, p.userSecret],
    ),
  );
}

export function dcaNullifierHash(userSecret: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["bytes32", "bytes32"], [userSecret, nonce]));
}
