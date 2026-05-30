package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"gorm.io/gorm"
)

type IntentRepo struct {
	db *gorm.DB
}

func NewIntentRepo(db *gorm.DB) *IntentRepo {
	return &IntentRepo{db: db}
}

func (r *IntentRepo) Save(ctx context.Context, s *domain.PendingIntent) error {
	if err := r.db.WithContext(ctx).Create(s).Error; err != nil {
		return fmt.Errorf("save pending intent: %w", err)
	}
	return nil
}

func (r *IntentRepo) GetByHash(ctx context.Context, commitmentHash string) (*domain.PendingIntent, error) {
	var s domain.PendingIntent
	err := r.db.WithContext(ctx).
		Where("commitment_hash = ?", commitmentHash).
		First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get pending intent: %w", err)
	}
	return &s, nil
}

func (r *IntentRepo) UpdateStatus(ctx context.Context, commitmentHash string, status domain.IntentStatus) error {
	err := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ?", commitmentHash).
		Update("status", status).Error
	if err != nil {
		return fmt.Errorf("update intent status: %w", err)
	}
	return nil
}

func (r *IntentRepo) CountByStatus(ctx context.Context, status domain.IntentStatus) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("status = ?", status).
		Count(&n).Error; err != nil {
		return 0, fmt.Errorf("count by status: %w", err)
	}
	return n, nil
}

func (r *IntentRepo) ResetStuckExecuting(ctx context.Context, olderThan time.Duration) ([]*domain.PendingIntent, error) {
	cutoff := time.Now().Add(-olderThan)

	var stuck []*domain.PendingIntent
	q := r.db.WithContext(ctx).
		Where("status = ?", domain.IntentExecuting)
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
		Model(&domain.PendingIntent{}).
		Where("commitment_hash IN ?", hashes).
		Update("status", domain.IntentPending).Error; err != nil {
		return nil, fmt.Errorf("reset stuck executing: %w", err)
	}

	for _, s := range stuck {
		s.Status = domain.IntentPending
	}
	return stuck, nil
}

func (r *IntentRepo) ListPending(ctx context.Context) ([]*domain.PendingIntent, error) {
	var intents []*domain.PendingIntent
	err := r.db.WithContext(ctx).
		Where("status = ?", domain.IntentPending).
		Find(&intents).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("list pending intents: %w", err)
	}
	return intents, nil
}
