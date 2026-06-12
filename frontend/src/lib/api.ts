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
export type IntentKind = "LIMIT" | "MARKET" | "DCA";
export type IntentCircuitKind = "ORDER_FILL" | "DCA";

export interface ExecutionRecord {
  id:              number;
  commitment_hash: string;
  tx_hash:         string;
  chain_id:        number;
  block_number:    number;
  gas_used:        number;
  status:          ExecutionStatus;
  kind:            IntentKind;
  registered_at:   string;
  executed_at:     string | null;
}

export interface DashboardDistributionItem {
  kind:      IntentKind;
  total:     number;
  executed:  number;
  pending:   number;
  cancelled: number;
  expired:   number;
}

export interface DashboardActivityItem {
  id:             number;
  commitment_ref: string;
  tx_ref?:        string;
  chain_id:       number;
  kind:           IntentKind;
  status:         ExecutionStatus;
  occurred_at:    string;
}

export interface DashboardAnalytics {
  chain_id:                          number;
  total_vault_value_usd:             number | null;
  total_executions:                  number;
  pending_order_fill_commitments:    number;
  pending_dca_commitments:           number;
  intent_distribution:               DashboardDistributionItem[];
  recent_activity:                   DashboardActivityItem[];
}

export interface ExecutionTicket {
  version:         number;
  chainId:         number;
  registry:        `0x${string}`;
  commitmentHash:  `0x${string}`;
  kind:            IntentCircuitKind;
  nullifier:       `0x${string}`;
  fillRef:         string;
  proof:           `0x${string}`;
  ticketExpiresAt: number;
  executor?:       `0x${string}`;
  packageHash:     `0x${string}`;
  proverId:        `0x${string}`;
  proverReceipt:   ProverReceipt;
}

export interface ProverReceipt {
  proverId:        `0x${string}`;
  ticketExpiresAt: number;
  signature:       `0x${string}`;
}

export interface ExecutorTicketEnvelope {
  commitmentHash:  `0x${string}`;
  chainId:         number;
  registry:        `0x${string}`;
  intentKind:      IntentKind;
  circuitKind:     IntentCircuitKind;
  ticketExpiresAt: number;
  leasedBy?:       `0x${string}`;
  leaseExpiresAt?: number;
  ticket:          ExecutionTicket;
}

// Two response envelope shapes the backend uses:
//   1. ok(c, data)            → {"data": <data>}                  // stats
//   2. raw with metadata      → {"data": [...], "limit": N, ...}  // paginated executions
// Each endpoint method below knows its own shape — no heuristic unwrap, since
// /executions and ok() both have a top-level "data" key with different
// semantics (collapsed vs. envelope).

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(await apiErrorMessage(res, path));
  return res.json();
}

async function fetchJson(path: string): Promise<unknown> {
  return requestJson(path);
}

async function apiErrorMessage(res: Response, path: string): Promise<string> {
  let detail = "";
  try {
    const body = await res.json() as { error?: string; reason?: string };
    detail = body.reason ?? body.error ?? "";
  } catch {
    detail = await res.text().catch(() => "");
  }
  return `API ${path}: ${res.status}${detail ? ` - ${detail}` : ""}`;
}

export const api = {
  dashboard: async (chainId = DEFAULT_CHAIN_ID): Promise<DashboardAnalytics> => {
    const json = await fetchJson(`/api/v1/dashboard?chain_id=${chainId}`);
    return (json as { data: DashboardAnalytics }).data;
  },
  stats: async (chainId = DEFAULT_CHAIN_ID): Promise<Statistics> => {
    const json = await fetchJson(`/api/v1/stats?chain_id=${chainId}`);
    return (json as { data: Statistics }).data;
  },
  executions: async (
    chainId = DEFAULT_CHAIN_ID,
    limit = 20,
    offset = 0,
    filters: { q?: string; status?: ExecutionStatus | ""; kind?: IntentKind | "" } = {},
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
  executorTickets: async (chainId = DEFAULT_CHAIN_ID, limit = 20):
      Promise<{ data: ExecutorTicketEnvelope[]; limit: number }> => {
    const params = new URLSearchParams({
      chain_id: String(chainId),
      limit:    String(limit),
    });
    return await fetchJson(`/api/v1/executor/tickets?${params.toString()}`) as { data: ExecutorTicketEnvelope[]; limit: number };
  },
  claimExecutorTicket: async (chainId: number, executor: `0x${string}`, commitmentHash?: `0x${string}`): Promise<ExecutorTicketEnvelope | null> => {
    const params = new URLSearchParams({ chain_id: String(chainId) });
    const res = await fetch(`${BASE}/api/v1/executor/tickets/claim?${params.toString()}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ executor, ...(commitmentHash ? { commitmentHash } : {}) }),
      cache:   "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await apiErrorMessage(res, "/api/v1/executor/tickets/claim"));
    const json = await res.json() as { data: ExecutorTicketEnvelope };
    return json.data;
  },
};
