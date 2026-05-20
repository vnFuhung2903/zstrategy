// Package metrics defines the Prometheus metrics exposed by the backend at
// GET /metrics. Counters are zero-valued at process start; histograms have
// buckets sized for the latencies we expect (sub-second for monitor evals,
// seconds for keeper trigger round-trips).
//
// All metric *names* are stable contract — Grafana dashboards reference them
// in infra/grafana/dashboards/zstrategy.json. Renaming or deleting a metric
// is a breaking change.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// StrategiesRegistered counts CommitmentRegistered events the chain indexer
// has processed. Labels: chain_id, kind (ORDER_FILL|DCA).
var StrategiesRegistered = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_strategies_registered_total",
	Help: "Total commitments registered, by chain and kind.",
}, []string{"chain_id", "kind"})

// ExecutionsTotal counts terminal-state transitions (executed/cancelled/expired)
// observed by the chain indexer. Labels: chain_id, kind, status.
var ExecutionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_executions_total",
	Help: "Total commitment terminal events, by chain, kind, and status.",
}, []string{"chain_id", "kind", "status"})

// PendingStrategies is the live count of in-flight monitor goroutines. Bumped
// up on StartMonitoring, down on StopMonitoring. Labels: kind.
var PendingStrategies = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "zstrategy_pending_strategies",
	Help: "Currently monitored pending strategies, by kind.",
}, []string{"kind"})

// MonitorEvalDuration tracks how long a single monitor-tick evaluation takes
// (oracle reads dominate for ORDER_FILL; near-zero for DCA/MARKET). Labels: kind.
var MonitorEvalDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "zstrategy_monitor_eval_duration_seconds",
	Help:    "Duration of a single monitor tick evaluation, by kind.",
	Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5},
}, []string{"kind"})

// KeeperTriggerTotal counts POST /api/execute results, labelled by outcome:
//
//   - accepted   – 202/200 from keeper
//   - rejected   – keeper returned non-2xx (oracle re-verify failed etc.)
//   - error      – HTTP layer error (timeout, DNS, refused)
var KeeperTriggerTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_keeper_trigger_total",
	Help: "Outcomes of monitor → keeper POST /api/execute calls.",
}, []string{"outcome"})

// IndexerEventsTotal counts each event the chain indexer dispatches. Labels: event.
var IndexerEventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_chain_indexer_events_total",
	Help: "On-chain events ingested by the indexer.",
}, []string{"event"})
