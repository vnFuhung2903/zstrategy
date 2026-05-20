/**
 * Prometheus metrics exposed by the keeper at GET /metrics.
 *
 * Metric names are a stable contract shared with the Grafana dashboard at
 * `infra/grafana/dashboards/zstrategy.json` — renaming or deleting a metric
 * is a breaking change.
 *
 * `collectDefaultMetrics` adds Node.js process/runtime stats (heap, GC,
 * event-loop lag) for free; useful for diagnosing WASM proof-gen pressure on
 * heap and event loop.
 */

import { Registry, Counter, Histogram, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "keeper_node_" });

export const executionsTotal = new Counter({
  name: "keeper_executions_total",
  help: "Outcomes of /api/execute fire-and-forget submissions.",
  labelNames: ["status"] as const, // success | failed
  registers: [registry],
});

export const proofGenerationSeconds = new Histogram({
  name: "keeper_proof_generation_seconds",
  help: "Time to generate one UltraHonk proof (bb.js WASM), by circuit.",
  labelNames: ["kind"] as const, // ORDER_FILL | DCA
  // bb.js typically takes 15–45s in Node; bucket out to 120s for slow boxes.
  buckets: [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120],
  registers: [registry],
});

export const shamirReconstructionSeconds = new Histogram({
  name: "keeper_shamir_reconstruction_seconds",
  help: "Time to reconstruct user_secret from Shamir shares (k-of-N).",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "keeper_http_requests_total",
  help: "HTTP requests served by the keeper API, by route and status class.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});
