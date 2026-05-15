package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"gorm.io/gorm"
)

type StrategyRepo struct {
	db *gorm.DB
}

func NewStrategyRepo(db *gorm.DB) *StrategyRepo {
	return &StrategyRepo{db: db}
}

func (r *StrategyRepo) Save(ctx context.Context, s *domain.PendingStrategy) error {
	if err := r.db.WithContext(ctx).Create(s).Error; err != nil {
		return fmt.Errorf("save pending strategy: %w", err)
	}
	return nil
}

func (r *StrategyRepo) GetByHash(ctx context.Context, commitmentHash string) (*domain.PendingStrategy, error) {
	var s domain.PendingStrategy
	err := r.db.WithContext(ctx).
		Where("commitment_hash = ?", commitmentHash).
		First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get pending strategy: %w", err)
	}
	return &s, nil
}

func (r *StrategyRepo) UpdateStatus(ctx context.Context, commitmentHash string, status domain.StrategyStatus) error {
	err := r.db.WithContext(ctx).
		Model(&domain.PendingStrategy{}).
		Where("commitment_hash = ?", commitmentHash).
		Update("status", status).Error
	if err != nil {
		return fmt.Errorf("update strategy status: %w", err)
	}
	return nil
}

func (r *StrategyRepo) CountByStatus(ctx context.Context, status domain.StrategyStatus) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).
		Model(&domain.PendingStrategy{}).
		Where("status = ?", status).
		Count(&n).Error; err != nil {
		return 0, fmt.Errorf("count by status: %w", err)
	}
	return n, nil
}

func (r *StrategyRepo) ResetStuckExecuting(ctx context.Context, olderThan time.Duration) ([]*domain.PendingStrategy, error) {
	cutoff := time.Now().Add(-olderThan)

	var stuck []*domain.PendingStrategy
	q := r.db.WithContext(ctx).
		Where("status = ?", domain.StrategyExecuting)
	if olderThan > 0 {
		q = q.Where("updated_at < ?", cutoff)
	}
	if err := q.Find(&stuck).Error; err != nil {
		return nil, fmt.Errorf("find stuck executing: %w", err)
	}
	if len(stuck) == 0 {
		return nil, nil
	}

	hashes := make([]string, 0, len(stuck))
	for _, s := range stuck {
		hashes = append(hashes, s.CommitmentHash)
	}

	if err := r.db.WithContext(ctx).
		Model(&domain.PendingStrategy{}).
		Where("commitment_hash IN ?", hashes).
		Update("status", domain.StrategyPending).Error; err != nil {
		return nil, fmt.Errorf("reset stuck executing: %w", err)
	}

	for _, s := range stuck {
		s.Status = domain.StrategyPending
	}
	return stuck, nil
}

func (r *StrategyRepo) ListPending(ctx context.Context) ([]*domain.PendingStrategy, error) {
	var strategies []*domain.PendingStrategy
	err := r.db.WithContext(ctx).
		Where("status = ?", domain.StrategyPending).
		Find(&strategies).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("list pending strategies: %w", err)
	}
	return strategies, nil
}
