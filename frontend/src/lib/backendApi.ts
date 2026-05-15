/**
 * Go backend API client.
 *
 * Strategies are registered here (not directly to the keeper). The backend
 * persists strategy metadata, forwards encrypted shares to the keeper, and
 * manages per-commitment monitoring goroutines.
 */

const BACKEND_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080";

export interface PostStrategyBody {
  commitmentHash: `0x${string}`;
  kind: "ORDER_FILL" | "DCA";
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** bigint stringified — tokenIn smallest unit. */
  size: string;
  /** bigint stringified — tokenOut smallest unit. */
  minOut: string;
  /** Unix timestamp. */
  expiry: number;
  /** bigint stringified — Chainlink 8-decimal denomination. "0" for DCA. */
  limitPrice: string;
  /** 0 = BUY, 1 = SELL. */
  direction: 0 | 1;
  /** 32-byte hex. */
  nonce: `0x${string}`;
  /** keccak256(user_secret || nonce), 32-byte hex. */
  nullifier: `0x${string}`;
  scheduledLo?: number;
  scheduledHi?: number;
  encryptedShares: Array<{ keeperId: string; ciphertext: string }>;
}

export interface PostDcaGroupBody {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  encryptedShares: Array<{ keeperId: string; ciphertext: string }>;
  rounds: Array<{
    commitmentHash: `0x${string}`;
    nonce: `0x${string}`;
    nullifier: `0x${string}`;
    size: string;
    minOut: string;
    expiry: number;
    scheduledLo: number;
    scheduledHi: number;
    roundIndex: number;
  }>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Backend ${path}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export const backendApi = {
  postStrategy:  (body: PostStrategyBody)  => postJson<{ status: string; commitmentHash: string }>("/api/v1/strategies", body),
  postDcaGroup:  (body: PostDcaGroupBody)  => postJson<{ status: string; saved: number }>("/api/v1/dca-strategies", body),
};
