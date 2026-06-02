import { createHash, timingSafeEqual } from "node:crypto";
import type { Hex } from "./types";

export function strip0x(value: Hex | string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function fromHex(value: Hex): Uint8Array {
  const hex = strip0x(value);
  if (hex.length % 2 !== 0) {
    throw new Error("hex value has odd length");
  }
  return Buffer.from(hex, "hex");
}

export function sha256Hex(value: string | Uint8Array): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function constantTimeEqualHex(a: Hex, b: Hex): boolean {
  const aa = Buffer.from(strip0x(a), "hex");
  const bb = Buffer.from(strip0x(b), "hex");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        sorted[key] = sortValue(child);
      }
    }
    return sorted;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}
