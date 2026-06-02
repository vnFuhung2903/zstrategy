import { strict as assert } from "assert";
import test from "node:test";

import { parseClaimedTicket, parseUint64, validateTicket } from "./execute-ticket";

const CHAIN_ID = 421614;
const REGISTRY = addr("99");
const COMMITMENT = hash("01");
const EXECUTOR = addr("ee");

test("validates a complete ORDER_FILL ticket envelope", () => {
  const claimed = parseClaimedTicket(ticketResponse());

  assert.doesNotThrow(() => validateTicket(claimed, BigInt(CHAIN_ID), EXECUTOR));
  assert.equal(claimed.ticket.fillRef, "0");
});

test("rejects ORDER_FILL tickets with nonzero fillRef", () => {
  const claimed = parseClaimedTicket(ticketResponse({ ticket: { fillRef: "123" } }));

  assert.throws(() => validateTicket(claimed, BigInt(CHAIN_ID), EXECUTOR), /ORDER_FILL ticket must use fillRef 0/);
});

test("rejects tickets that do not match the response envelope", () => {
  const claimed = parseClaimedTicket(ticketResponse({ commitmentHash: hash("02") }));

  assert.throws(() => validateTicket(claimed, BigInt(CHAIN_ID), EXECUTOR), /commitmentHash does not match/);
});

test("rejects missing required ticket fields", () => {
  const body = ticketResponse();
  delete (body.data.ticket as Record<string, unknown>).nullifier;

  assert.throws(() => parseClaimedTicket(body), /ticket.nullifier is required/);
});

test("rejects tickets bound to a different executor", () => {
  const claimed = parseClaimedTicket(ticketResponse({ ticket: { executor: addr("dd") } }));

  assert.throws(() => validateTicket(claimed, BigInt(CHAIN_ID), EXECUTOR), /bound to a different address/);
});

test("accepts uint64 fillRef and rejects values above uint64", () => {
  assert.equal(parseUint64("18446744073709551615", "fillRef"), (1n << 64n) - 1n);
  assert.throws(() => parseUint64("18446744073709551616", "fillRef"), /exceeds uint64/);
});

function ticketResponse(overrides: {
  commitmentHash?: string;
  registry?: string;
  chainId?: number;
  ticket?: Record<string, unknown>;
} = {}) {
  const ticket = {
    version: 1,
    chainId: overrides.chainId ?? CHAIN_ID,
    registry: overrides.registry ?? REGISTRY,
    commitmentHash: COMMITMENT,
    kind: "ORDER_FILL",
    nullifier: hash("77"),
    fillRef: "0",
    proof: "0xabcd",
    ticketExpiresAt: Math.floor(Date.now() / 1000) + 60,
    packageHash: hash("88"),
    proverIds: ["simulated"],
    proverSignature: "0x99",
    ...(overrides.ticket ?? {}),
  };

  return {
    data: {
      commitmentHash: overrides.commitmentHash ?? COMMITMENT,
      chainId: overrides.chainId ?? CHAIN_ID,
      registry: overrides.registry ?? REGISTRY,
      ticket,
    },
  };
}

function hash(byte: string): string {
  return `0x${byte.repeat(32)}`;
}

function addr(byte: string): string {
  return `0x${byte.repeat(20)}`;
}
