const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export interface Statistics {
  chain_id:         number;
  total_registered: number;
  total_executions: number;
  total_cancelled:  number;
  total_expired:    number;
  success_rate:     number;
  avg_latency_ms:   number;
  avg_gas_used:     number;
}

export interface ExecutionRecord {
  id:              number;
  commitment_hash: string;
  tx_hash:         string;
  chain_id:        number;
  block_number:    number;
  gas_used:        number;
  status:          "registered" | "executed" | "cancelled" | "expired";
  kind:            "ORDER_FILL" | "DCA";
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

async function fetchJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  stats: async (chainId = 421614): Promise<Statistics> => {
    const json = await fetchJson(`/api/v1/stats?chain_id=${chainId}`);
    return json.data as Statistics;
  },
  executions: async (chainId = 421614, limit = 20, offset = 0):
      Promise<{ data: ExecutionRecord[]; limit: number; offset: number }> => {
    return await fetchJson(`/api/v1/executions?chain_id=${chainId}&limit=${limit}&offset=${offset}`);
  },
  keeperHealth: async (): Promise<KeeperHealth> => {
    const json = await fetchJson("/api/v1/keeper/health");
    return json.data as KeeperHealth;
  },
};
