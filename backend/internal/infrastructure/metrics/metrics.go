package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var IntentsRegistered = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_strategies_registered_total",
	Help: "Total commitments registered, by chain and kind.",
}, []string{"chain_id", "kind"})

var ExecutionsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_executions_total",
	Help: "Total commitment terminal events, by chain, kind, and status.",
}, []string{"chain_id", "kind", "status"})

var PendingIntents = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "zstrategy_pending_strategies",
	Help: "Currently monitored pending intents, by kind.",
}, []string{"kind"})

var MonitorEvalDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "zstrategy_monitor_eval_duration_seconds",
	Help:    "Duration of a single monitor tick evaluation, by kind.",
	Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5},
}, []string{"kind"})

var IndexerEventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "zstrategy_chain_indexer_events_total",
	Help: "On-chain events ingested by the indexer.",
}, []string{"event"})
