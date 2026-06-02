/**
 * Go backend API client.
 *
 * Intents are registered here after the on-chain commitment confirms. The
 * backend stores public metadata plus an encrypted witness package; plaintext
 * witness fields stay in the browser and then inside the simulated enclave.
 */

import type { EncryptedWitnessPackage } from "./enclaveWitness";

const BACKEND_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080";

export interface PostOrderIntentBody {
  commitmentHash: `0x${string}`;
  kind: "LIMIT" | "MARKET";
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: string;
  minOut: string;
  expiry: number;
  witnessPackage: EncryptedWitnessPackage;
}

export interface PostDcaIntentBody {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  rounds: Array<{
    commitmentHash: `0x${string}`;
    size: string;
    minOut: string;
    expiry: number;
    roundIndex: number;
    witnessPackage: EncryptedWitnessPackage;
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
  postOrderIntent: (body: PostOrderIntentBody) => postJson<{ status: string; commitmentHash: string }>("/api/v1/intents/order", body),
  postDcaIntent:   (body: PostDcaIntentBody) => postJson<{ status: string; saved: number }>("/api/v1/intents/dca", body),
};
