/**
 * Keeper-network API client.
 *
 * The frontend only needs to fetch the keeper public-key set for ECIES
 * encryption of Shamir shares. Strategy registration is now sent to the
 * Go backend (backendApi.ts), which forwards shares to the keeper.
 */

import type { KeeperPubkey } from "./threshold";

const KEEPER_BASE = process.env.NEXT_PUBLIC_KEEPER_URL ?? "http://localhost:3001";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${KEEPER_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Keeper ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const keeperApi = {
  listKeepers: () => getJson<{ keepers: KeeperPubkey[]; threshold: number; total: number }>("/api/keepers"),
};
