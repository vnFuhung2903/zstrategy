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

func (r *IntentRepo) SaveBatch(ctx context.Context, intents []*domain.PendingIntent) error {
	if len(intents) == 0 {
		return nil
	}
	if err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return tx.Create(&intents).Error
	}); err != nil {
		return fmt.Errorf("save pending intents batch: %w", err)
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
		Updates(map[string]any{"status": status}).Error
	if err != nil {
		return fmt.Errorf("update intent status: %w", err)
	}
	return nil
}

func (r *IntentRepo) ClaimForEvaluation(ctx context.Context, commitmentHash string) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentPending).
		Updates(map[string]any{
			"status":     domain.IntentEvaluating,
			"last_error": "",
		})
	if tx.Error != nil {
		return false, fmt.Errorf("claim intent evaluation: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
}

func (r *IntentRepo) StoreTicket(ctx context.Context, commitmentHash, ticket string, ticketExpiresAt time.Time) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentEvaluating).
		Updates(map[string]any{
			"status":            domain.IntentTicketReady,
			"ticket":            ticket,
			"ticket_expires_at": ticketExpiresAt,
			"leased_by":         "",
			"lease_expires_at":  nil,
			"last_error":        "",
		})
	if tx.Error != nil {
		return false, fmt.Errorf("store execution ticket: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
}

func (r *IntentRepo) ClaimTicketLease(ctx context.Context, commitmentHash, leasedBy string, now, leaseExpiresAt time.Time) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentTicketReady).
		Where("ticket_expires_at IS NOT NULL AND ticket_expires_at > ?", now).
		Where("(lease_expires_at IS NULL OR lease_expires_at <= ? OR LOWER(leased_by) = LOWER(?))", now, leasedBy).
		Updates(map[string]any{
			"leased_by":        leasedBy,
			"lease_expires_at": leaseExpiresAt,
		})
	if tx.Error != nil {
		return false, fmt.Errorf("claim ticket lease: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
}

func (r *IntentRepo) MarkFailed(ctx context.Context, commitmentHash, reason string) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentEvaluating).
		Updates(map[string]any{
			"status":     domain.IntentFailed,
			"last_error": reason,
		})
	if tx.Error != nil {
		return false, fmt.Errorf("mark intent failed: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
}

func (r *IntentRepo) ResetEvaluation(ctx context.Context, commitmentHash string) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentEvaluating).
		Updates(map[string]any{
			"status":            domain.IntentPending,
			"ticket":            "null",
			"ticket_expires_at": nil,
			"leased_by":         "",
			"lease_expires_at":  nil,
		})
	if tx.Error != nil {
		return false, fmt.Errorf("reset intent evaluation: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
}

func (r *IntentRepo) ResetTicket(ctx context.Context, commitmentHash, reason string) (bool, error) {
	tx := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash = ? AND status = ?", commitmentHash, domain.IntentTicketReady).
		Updates(map[string]any{
			"status":            domain.IntentPending,
			"ticket":            "null",
			"ticket_expires_at": nil,
			"leased_by":         "",
			"lease_expires_at":  nil,
			"last_error":        reason,
		})
	if tx.Error != nil {
		return false, fmt.Errorf("reset execution ticket: %w", tx.Error)
	}
	return tx.RowsAffected == 1, nil
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
		Where("status = ?", domain.IntentEvaluating)
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
		Where("commitment_hash IN ? AND status = ?", hashes, domain.IntentEvaluating).
		Updates(map[string]any{
			"status":            domain.IntentPending,
			"ticket":            "null",
			"ticket_expires_at": nil,
			"leased_by":         "",
			"lease_expires_at":  nil,
		}).Error; err != nil {
		return nil, fmt.Errorf("reset stuck executing: %w", err)
	}

	var resumed []*domain.PendingIntent
	if err := r.db.WithContext(ctx).
		Where("commitment_hash IN ? AND status = ?", hashes, domain.IntentPending).
		Find(&resumed).Error; err != nil {
		return nil, fmt.Errorf("reload reset stuck executing: %w", err)
	}
	return resumed, nil
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

func (r *IntentRepo) ListTicketReady(ctx context.Context) ([]*domain.PendingIntent, error) {
	var intents []*domain.PendingIntent
	err := r.db.WithContext(ctx).
		Where("status = ?", domain.IntentTicketReady).
		Find(&intents).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("list ticket-ready intents: %w", err)
	}
	return intents, nil
}

func (r *IntentRepo) ResetExpiredTickets(ctx context.Context, now time.Time) ([]*domain.PendingIntent, error) {
	var expired []*domain.PendingIntent
	if err := r.db.WithContext(ctx).
		Where("status = ? AND ticket_expires_at IS NOT NULL AND ticket_expires_at <= ?", domain.IntentTicketReady, now).
		Find(&expired).Error; err != nil {
		return nil, fmt.Errorf("find expired tickets: %w", err)
	}
	if len(expired) == 0 {
		return nil, nil
	}

	hashes := make([]string, 0, len(expired))
	for _, s := range expired {
		hashes = append(hashes, s.CommitmentHash)
	}

	if err := r.db.WithContext(ctx).
		Model(&domain.PendingIntent{}).
		Where("commitment_hash IN ? AND status = ? AND ticket_expires_at IS NOT NULL AND ticket_expires_at <= ?", hashes, domain.IntentTicketReady, now).
		Updates(map[string]any{
			"status":            domain.IntentPending,
			"ticket":            "null",
			"ticket_expires_at": nil,
			"leased_by":         "",
			"lease_expires_at":  nil,
		}).Error; err != nil {
		return nil, fmt.Errorf("reset expired tickets: %w", err)
	}

	var resumed []*domain.PendingIntent
	if err := r.db.WithContext(ctx).
		Where("commitment_hash IN ? AND status = ?", hashes, domain.IntentPending).
		Find(&resumed).Error; err != nil {
		return nil, fmt.Errorf("reload reset expired tickets: %w", err)
	}
	return resumed, nil
}
