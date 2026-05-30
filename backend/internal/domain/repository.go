package domain

import (
	"context"
	"time"
)

type IntentRepository interface {
	Save(ctx context.Context, s *PendingIntent) error
	GetByHash(ctx context.Context, commitmentHash string) (*PendingIntent, error)
	UpdateStatus(ctx context.Context, commitmentHash string, status IntentStatus) error
	ListPending(ctx context.Context) ([]*PendingIntent, error)
	// CountByStatus returns the number of rows in the given status. Used by
	// stats queries (e.g. KeeperHealth.MonitoredCount = count of PENDING).
	CountByStatus(ctx context.Context, status IntentStatus) (int64, error)
	// ResetStuckExecuting flips EXECUTING rows whose updated_at is older than
	// `olderThan` back to PENDING and returns them so the monitor can resume them.
	// Pass `0` to reset all EXECUTING rows regardless of age (use at startup).
	ResetStuckExecuting(ctx context.Context, olderThan time.Duration) ([]*PendingIntent, error)
}

type ExecutionRepository interface {
	Save(ctx context.Context, r *ExecutionRecord) error
	UpdateStatus(ctx context.Context, commitmentHash string, status ExecutionStatus, txHash string, blockNumber, gasUsed uint64, executedAt *time.Time) error
	UpdateKind(ctx context.Context, commitmentHash string, kind IntentKind) error
	ExistsByHash(ctx context.Context, commitmentHash string) (bool, error)
	// FindByHash returns nil if no row matches. Used by the metrics path to
	// attach the original `kind` label to terminal-state counters.
	FindByHash(ctx context.Context, commitmentHash string) (*ExecutionRecord, error)
	GetStatistics(ctx context.Context, chainID int64) (*Statistics, error)
	List(ctx context.Context, chainID int64, filters ExecutionFilters, limit, offset int) ([]*ExecutionRecord, error)
}
