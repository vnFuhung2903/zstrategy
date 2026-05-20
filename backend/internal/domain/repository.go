package domain

import (
	"context"
	"time"
)

type StrategyRepository interface {
	Save(ctx context.Context, s *PendingStrategy) error
	GetByHash(ctx context.Context, commitmentHash string) (*PendingStrategy, error)
	UpdateStatus(ctx context.Context, commitmentHash string, status StrategyStatus) error
	ListPending(ctx context.Context) ([]*PendingStrategy, error)
	// CountByStatus returns the number of rows in the given status. Used by
	// stats queries (e.g. KeeperHealth.MonitoredCount = count of PENDING).
	CountByStatus(ctx context.Context, status StrategyStatus) (int64, error)
	// ResetStuckExecuting flips EXECUTING rows whose updated_at is older than
	// `olderThan` back to PENDING and returns them so the monitor can resume them.
	// Pass `0` to reset all EXECUTING rows regardless of age (use at startup).
	ResetStuckExecuting(ctx context.Context, olderThan time.Duration) ([]*PendingStrategy, error)
}

type ExecutionRepository interface {
	Save(ctx context.Context, r *ExecutionRecord) error
	UpdateStatus(ctx context.Context, commitmentHash string, status ExecutionStatus, txHash string, blockNumber, gasUsed uint64, executedAt *time.Time) error
	ExistsByHash(ctx context.Context, commitmentHash string) (bool, error)
	// FindByHash returns nil if no row matches. Used by the metrics path to
	// attach the original `kind` label to terminal-state counters.
	FindByHash(ctx context.Context, commitmentHash string) (*ExecutionRecord, error)
	GetStatistics(ctx context.Context, chainID int64) (*Statistics, error)
	List(ctx context.Context, chainID int64, kind string, limit, offset int) ([]*ExecutionRecord, error)
}
