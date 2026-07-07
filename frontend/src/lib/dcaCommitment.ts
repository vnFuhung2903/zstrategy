import { keccak256, encodePacked } from "viem";
import { reduceToField } from "./commitment";

export interface DcaPreimageFields {
  tokenIn:     `0x${string}`;
  tokenOut:    `0x${string}`;
  size:        bigint;
  minOut:      bigint;
  scheduledLo: bigint;
  scheduledHi: bigint;
  expiry:      bigint;
  nonce:       `0x${string}`;
  userSecret:  `0x${string}`;
}

export function dcaCommitmentHash(p: DcaPreimageFields): `0x${string}` {
  return reduceToField(keccak256(
    encodePacked(
      ["address", "address", "uint256", "uint256", "uint64", "uint64", "uint64", "bytes32", "bytes32"],
      [p.tokenIn, p.tokenOut, p.size, p.minOut, p.scheduledLo, p.scheduledHi, p.expiry, p.nonce, p.userSecret],
    ),
  ));
}

export function dcaNullifierHash(userSecret: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return reduceToField(keccak256(encodePacked(["bytes32", "bytes32"], [userSecret, nonce])));
}
