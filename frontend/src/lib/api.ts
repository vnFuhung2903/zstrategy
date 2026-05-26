const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const DEFAULT_CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? "421614");

export interface Statistics {
  chain_id:         number;
  total_registered: number;
  total_executions: number;
  total_cancelled:  number;
  total_expired:    number;
  success_rate:     number;
  avg_latency_ms:   number;
  avg_gas_used:     number;
  by_kind:          Record<string, {
    total_registered: number;
    total_executed:   number;
    total_cancelled:  number;
    total_expired:    number;
  }>;
}

export type ExecutionStatus = "registered" | "executed" | "cancelled" | "expired";
export type ExecutionKind = "ORDER_FILL" | "DCA" | "MARKET";

export interface ExecutionRecord {
  id:              number;
  commitment_hash: string;
  tx_hash:         string;
  chain_id:        number;
  block_number:    number;
  gas_used:        number;
  status:          ExecutionStatus;
  kind:            ExecutionKind;
  registered_at:   string;
  executed_at:     string | null;
}

export interface KeeperHealth {
  online:          boolean;
  monitored_count: number;
  executed_count:  number;
  failed_count:    number;
  last_seen_at:    string;
}

// Two response envelope shapes the backend uses:
//   1. ok(c, data)            → {"data": <data>}                  // stats, keeper health
//   2. raw with metadata      → {"data": [...], "limit": N, ...}  // paginated executions
// Each endpoint method below knows its own shape — no heuristic unwrap, since
// /executions and ok() both have a top-level "data" key with different
// semantics (collapsed vs. envelope).

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  stats: async (chainId = DEFAULT_CHAIN_ID): Promise<Statistics> => {
    const json = await fetchJson(`/api/v1/stats?chain_id=${chainId}`);
    return (json as { data: Statistics }).data;
  },
  executions: async (
    chainId = DEFAULT_CHAIN_ID,
    limit = 20,
    offset = 0,
    filters: { q?: string; status?: ExecutionStatus | ""; kind?: ExecutionKind | "" } = {},
  ):
      Promise<{ data: ExecutionRecord[]; limit: number; offset: number }> => {
    const params = new URLSearchParams({
      chain_id: String(chainId),
      limit:    String(limit),
      offset:   String(offset),
    });
    if (filters.q) params.set("q", filters.q);
    if (filters.status) params.set("status", filters.status);
    if (filters.kind) params.set("kind", filters.kind);
    return await fetchJson(`/api/v1/executions?${params.toString()}`) as { data: ExecutionRecord[]; limit: number; offset: number };
  },
  keeperHealth: async (): Promise<KeeperHealth> => {
    const json = await fetchJson("/api/v1/keeper/health");
    return (json as { data: KeeperHealth }).data;
  },
};
