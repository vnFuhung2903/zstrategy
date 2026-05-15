package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"gorm.io/gorm"
)

type ExecutionRepo struct {
	db *gorm.DB
}

func NewExecutionRepo(db *gorm.DB) *ExecutionRepo {
	return &ExecutionRepo{db: db}
}

func (r *ExecutionRepo) Save(ctx context.Context, rec *domain.ExecutionRecord) error {
	if err := r.db.WithContext(ctx).Create(rec).Error; err != nil {
		return fmt.Errorf("save execution record: %w", err)
	}
	return nil
}

func (r *ExecutionRepo) UpdateStatus(
	ctx context.Context,
	commitmentHash string,
	status domain.ExecutionStatus,
	txHash string,
	blockNumber, gasUsed uint64,
	executedAt *time.Time,
) error {
	updates := map[string]any{
		"status":       status,
		"tx_hash":      txHash,
		"block_number": blockNumber,
		"gas_used":     gasUsed,
		"executed_at":  executedAt,
	}
	err := r.db.WithContext(ctx).
		Model(&domain.ExecutionRecord{}).
		Where("commitment_hash = ?", commitmentHash).
		Updates(updates).Error
	if err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	return nil
}

func (r *ExecutionRepo) ExistsByHash(ctx context.Context, commitmentHash string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).
		Model(&domain.ExecutionRecord{}).
		Where("commitment_hash = ?", commitmentHash).
		Count(&count).Error
	return count > 0, err
}

func (r *ExecutionRepo) GetStatistics(ctx context.Context, chainID int64) (*domain.Statistics, error) {
	type row struct {
		Status string
		Kind   string
		Count  int64
		AvgMs  float64
		AvgGas float64
	}
	var rows []row
	err := r.db.WithContext(ctx).Raw(`
		SELECT
			status,
			kind,
			COUNT(*) AS count,
			COALESCE(
				AVG(EXTRACT(EPOCH FROM (executed_at - registered_at)) * 1000)
				FILTER (WHERE executed_at IS NOT NULL), 0
			) AS avg_ms,
			COALESCE(AVG(gas_used) FILTER (WHERE gas_used > 0), 0) AS avg_gas
		FROM execution_records
		WHERE chain_id = ?
		GROUP BY status, kind
	`, chainID).Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("get statistics: %w", err)
	}

	stats := &domain.Statistics{
		ChainID: chainID,
		ByKind:  make(map[string]*domain.KindBreakdown),
	}

	// Aggregate latency and gas across (status=executed, kind=*) rows. Each row
	// already holds a per-group average; we weight by Count to get the overall
	// mean so multi-kind systems don't have one kind silently overwrite another.
	var weightedLatency, weightedGas float64
	var latencyN, gasN int64

	for _, row := range rows {
		if _, ok := stats.ByKind[row.Kind]; !ok {
			stats.ByKind[row.Kind] = &domain.KindBreakdown{}
		}
		kb := stats.ByKind[row.Kind]
		switch domain.ExecutionStatus(row.Status) {
		case domain.StatusRegistered:
			stats.TotalRegistered += row.Count
			kb.TotalRegistered += row.Count
		case domain.StatusExecuted:
			stats.TotalExecutions += row.Count
			kb.TotalExecuted += row.Count
			if row.AvgMs > 0 {
				weightedLatency += row.AvgMs * float64(row.Count)
				latencyN += row.Count
			}
			if row.AvgGas > 0 {
				weightedGas += row.AvgGas * float64(row.Count)
				gasN += row.Count
			}
		case domain.StatusCancelled:
			stats.TotalCancelled += row.Count
			kb.TotalCancelled += row.Count
		case domain.StatusExpired:
			stats.TotalExpired += row.Count
			kb.TotalExpired += row.Count
		}
	}

	if latencyN > 0 {
		stats.AvgLatencyMs = weightedLatency / float64(latencyN)
	}
	if gasN > 0 {
		stats.AvgGasUsed = weightedGas / float64(gasN)
	}
	if settled := stats.TotalExecutions + stats.TotalCancelled + stats.TotalExpired; settled > 0 {
		stats.SuccessRate = float64(stats.TotalExecutions) / float64(settled) * 100
	}
	return stats, nil
}

func (r *ExecutionRepo) List(ctx context.Context, chainID int64, kind string, limit, offset int) ([]*domain.ExecutionRecord, error) {
	var records []*domain.ExecutionRecord
	q := r.db.WithContext(ctx).Where("chain_id = ?", chainID)
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	err := q.Order("registered_at DESC").Limit(limit).Offset(offset).Find(&records).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("list executions: %w", err)
	}
	return records, nil
}
