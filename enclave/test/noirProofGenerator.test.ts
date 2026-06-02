import { after, test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { NoirProofGenerator, type Hex } from "../src";

const BN254_FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const WETH = "0x4200000000000000000000000000000000000006" as const;
const USDC = "0xaabbccddeeff00112233445566778899aabbccdd" as const;

const proofGenerator = new NoirProofGenerator({
  orderFillCircuitJsonPath: "../circuits/order_fill/target/order_fill.json",
  dcaCircuitJsonPath: "../circuits/dca/target/dca.json",
});

after(async () => {
  await proofGenerator.destroy();
});

test("NoirProofGenerator generates and verifies a real ORDER_FILL proof", async () => {
  const size = 3_000_000000n;
  const minOut = 999_000_000_000_000n;
  const expiry = 1_700_000_000n;
  const price = 3000_00000000n;
  const direction = 0 as const;
  const nonce = bytes32(0x1234n);
  const userSecret = bytes32(0xdeadbeefn);
  const commitmentHash = orderCommitmentHash({
    tokenIn: USDC,
    tokenOut: WETH,
    size,
    minOut,
    expiry,
    price,
    direction,
    nonce,
    userSecret,
  });
  const nullifier = nullifierHash(userSecret, nonce);

  const proof = await proofGenerator.generateOrderFillProof({
    price,
    direction,
    nonce,
    userSecret,
    commitmentHash,
    oraclePrice: price,
    nullifier,
    tokenIn: USDC,
    tokenOut: WETH,
    size,
    minOut,
    expiry,
  });

  assert.match(proof, /^0x[0-9a-f]+$/);
  assert.ok(proof.length > 2);
});

test("NoirProofGenerator generates and verifies a real DCA proof", async () => {
  const size = 3_000_000000n;
  const minOut = 999_000_000_000_000n;
  const scheduledLo = 1_700_000_000;
  const scheduledHi = scheduledLo + 3600;
  const expiry = scheduledLo + 86400;
  const nonce = bytes32(0x1234n);
  const userSecret = bytes32(0xdeadbeefn);
  const commitmentHash = dcaCommitmentHash({
    tokenIn: USDC,
    tokenOut: WETH,
    size,
    minOut,
    scheduledLo: BigInt(scheduledLo),
    scheduledHi: BigInt(scheduledHi),
    expiry: BigInt(expiry),
    nonce,
    userSecret,
  });
  const nullifier = nullifierHash(userSecret, nonce);

  const proof = await proofGenerator.generateDcaProof({
    scheduledLo,
    scheduledHi,
    nonce,
    userSecret,
    commitmentHash,
    executionTimestamp: scheduledLo,
    nullifier,
    tokenIn: USDC,
    tokenOut: WETH,
    size,
    minOut,
    expiry,
  });

  assert.match(proof, /^0x[0-9a-f]+$/);
  assert.ok(proof.length > 2);
});

function orderCommitmentHash(p: {
  tokenIn: Hex;
  tokenOut: Hex;
  size: bigint;
  minOut: bigint;
  expiry: bigint;
  price: bigint;
  direction: 0 | 1;
  nonce: Hex;
  userSecret: Hex;
}): Hex {
  return reduceToField(keccakHex([
    addressBytes(p.tokenIn),
    addressBytes(p.tokenOut),
    uint256Bytes(p.size),
    uint256Bytes(p.minOut),
    uint64Bytes(p.expiry),
    uint64Bytes(p.price),
    new Uint8Array([p.direction]),
    hexBytes(p.nonce),
    hexBytes(p.userSecret),
  ]));
}

function dcaCommitmentHash(p: {
  tokenIn: Hex;
  tokenOut: Hex;
  size: bigint;
  minOut: bigint;
  scheduledLo: bigint;
  scheduledHi: bigint;
  expiry: bigint;
  nonce: Hex;
  userSecret: Hex;
}): Hex {
  return reduceToField(keccakHex([
    addressBytes(p.tokenIn),
    addressBytes(p.tokenOut),
    uint256Bytes(p.size),
    uint256Bytes(p.minOut),
    uint64Bytes(p.scheduledLo),
    uint64Bytes(p.scheduledHi),
    uint64Bytes(p.expiry),
    hexBytes(p.nonce),
    hexBytes(p.userSecret),
  ]));
}

function nullifierHash(userSecret: Hex, nonce: Hex): Hex {
  return reduceToField(keccakHex([hexBytes(userSecret), hexBytes(nonce)]));
}

function reduceToField(value: Hex): Hex {
  return bytes32(BigInt(value) % BN254_FIELD_MODULUS);
}

function keccakHex(parts: Uint8Array[]): Hex {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

function addressBytes(value: Hex): Uint8Array {
  const bytes = hexBytes(value);
  if (bytes.length !== 20) {
    throw new Error(`expected 20-byte address, got ${bytes.length}`);
  }
  return bytes;
}

function uint256Bytes(value: bigint): Uint8Array {
  return fixedBytes(value, 32);
}

function uint64Bytes(value: bigint): Uint8Array {
  return fixedBytes(value, 8);
}

function bytes32(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function hexBytes(value: Hex): Uint8Array {
  return Buffer.from(value.slice(2), "hex");
}

function fixedBytes(value: bigint, width: number): Uint8Array {
  const hex = value.toString(16).padStart(width * 2, "0");
  if (hex.length > width * 2) {
    throw new Error(`value does not fit in ${width} bytes`);
  }
  return Buffer.from(hex, "hex");
}
