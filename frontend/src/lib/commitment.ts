import { keccak256, encodePacked } from "viem";
import type { IntentDirection } from "./intentStore";

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
  expiry: bigint;
  price: bigint;
  direction: IntentDirection;
  nonce: `0x${string}`;
  userSecret: `0x${string}`;
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

export function deriveIntentId(owner: `0x${string}`, nonce: `0x${string}`): `0x${string}` {
  return keccak256(encodePacked(["address", "bytes32"], [owner, nonce]));
}

export function deriveUserSecret(signature: `0x${string}`): `0x${string}` {
  return reduceToField(keccak256(signature));
}

export function randomBytes32(): `0x${string}` {
  for (;;) {
    const arr = crypto.getRandomValues(new Uint8Array(32));
    const hex = `0x${Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
    if (BigInt(hex) < BN254_FIELD_MODULUS) return hex;
  }
}

export function intentIdSigningMessage(intentId: `0x${string}`): string {
  return `zstrategy: derive user_secret for intentId=${intentId}`;
}
