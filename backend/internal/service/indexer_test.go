package service

import (
	"context"
	"testing"
	"time"

	"github.com/zstrategy/backend/internal/domain"
)

type fakeExecutionRepo struct {
	records     map[string]*domain.ExecutionRecord
	lastFilters domain.ExecutionFilters
	lastLimit   int
	lastOffset  int
}

func newFakeExecutionRepo() *fakeExecutionRepo {
	return &fakeExecutionRepo{records: make(map[string]*domain.ExecutionRecord)}
}

func (r *fakeExecutionRepo) Save(_ context.Context, rec *domain.ExecutionRecord) error {
	cp := *rec
	r.records[rec.CommitmentHash] = &cp
	return nil
}

func (r *fakeExecutionRepo) UpdateStatus(_ context.Context, commitmentHash string, status domain.ExecutionStatus, txHash string, blockNumber, gasUsed uint64, executedAt *time.Time) error {
	rec := r.records[commitmentHash]
	if rec == nil {
		rec = &domain.ExecutionRecord{CommitmentHash: commitmentHash}
		r.records[commitmentHash] = rec
	}
	rec.Status = status
	rec.TxHash = txHash
	rec.BlockNumber = blockNumber
	rec.GasUsed = gasUsed
	rec.ExecutedAt = executedAt
	return nil
}

func (r *fakeExecutionRepo) UpdateKind(_ context.Context, commitmentHash string, kind domain.CommitmentKind) error {
	rec := r.records[commitmentHash]
	if rec == nil {
		rec = &domain.ExecutionRecord{CommitmentHash: commitmentHash}
		r.records[commitmentHash] = rec
	}
	rec.Kind = kind
	return nil
}

func (r *fakeExecutionRepo) ExistsByHash(_ context.Context, commitmentHash string) (bool, error) {
	_, ok := r.records[commitmentHash]
	return ok, nil
}

func (r *fakeExecutionRepo) FindByHash(_ context.Context, commitmentHash string) (*domain.ExecutionRecord, error) {
	return r.records[commitmentHash], nil
}

func (r *fakeExecutionRepo) GetStatistics(_ context.Context, chainID int64) (*domain.Statistics, error) {
	return &domain.Statistics{ChainID: chainID}, nil
}

func (r *fakeExecutionRepo) List(_ context.Context, _ int64, filters domain.ExecutionFilters, limit, offset int) ([]*domain.ExecutionRecord, error) {
	r.lastFilters = filters
	r.lastLimit = limit
	r.lastOffset = offset
	return nil, nil
}

type fakeStrategyRepo struct {
	byHash map[string]*domain.PendingStrategy
}

func (r fakeStrategyRepo) Save(context.Context, *domain.PendingStrategy) error { return nil }
func (r fakeStrategyRepo) GetByHash(_ context.Context, commitmentHash string) (*domain.PendingStrategy, error) {
	return r.byHash[commitmentHash], nil
}
func (r fakeStrategyRepo) UpdateStatus(context.Context, string, domain.StrategyStatus) error {
	return nil
}
func (r fakeStrategyRepo) ListPending(context.Context) ([]*domain.PendingStrategy, error) {
	return nil, nil
}
func (r fakeStrategyRepo) CountByStatus(context.Context, domain.StrategyStatus) (int64, error) {
	return 0, nil
}
func (r fakeStrategyRepo) ResetStuckExecuting(context.Context, time.Duration) ([]*domain.PendingStrategy, error) {
	return nil, nil
}

func TestHandleRegisteredPreservesMarketKindFromPendingStrategy(t *testing.T) {
	ctx := context.Background()
	hash := "0xmarket"
	execRepo := newFakeExecutionRepo()
	strategyRepo := fakeStrategyRepo{byHash: map[string]*domain.PendingStrategy{
		hash: {CommitmentHash: hash, Kind: domain.KindMarket},
	}}
	svc := NewIndexerService(execRepo, strategyRepo, "", "")

	if err := svc.HandleRegistered(ctx, hash, string(domain.KindOrderFill), 421614, time.Now()); err != nil {
		t.Fatalf("HandleRegistered: %v", err)
	}

	if got := execRepo.records[hash].Kind; got != domain.KindMarket {
		t.Fatalf("kind = %q, want %q", got, domain.KindMarket)
	}
}

func TestUpdateExecutionKindUpgradesExistingMarketRecord(t *testing.T) {
	ctx := context.Background()
	hash := "0xrace"
	execRepo := newFakeExecutionRepo()
	execRepo.records[hash] = &domain.ExecutionRecord{CommitmentHash: hash, Kind: domain.KindOrderFill}
	svc := NewIndexerService(execRepo, nil, "", "")

	if err := svc.UpdateExecutionKind(ctx, hash, domain.KindMarket); err != nil {
		t.Fatalf("UpdateExecutionKind: %v", err)
	}

	if got := execRepo.records[hash].Kind; got != domain.KindMarket {
		t.Fatalf("kind = %q, want %q", got, domain.KindMarket)
	}
}

func TestStatsServicePassesSafeExecutionFilters(t *testing.T) {
	ctx := context.Background()
	execRepo := newFakeExecutionRepo()
	svc := NewStatsService(execRepo, nil, nil, "")
	filters := domain.ExecutionFilters{
		Query:  "0xabc",
		Status: domain.StatusExecuted,
		Kind:   domain.KindMarket,
	}

	if _, err := svc.GetExecutions(ctx, 421614, filters, 0, 7); err != nil {
		t.Fatalf("GetExecutions: %v", err)
	}

	if execRepo.lastLimit != 20 {
		t.Fatalf("limit = %d, want default 20", execRepo.lastLimit)
	}
	if execRepo.lastOffset != 7 {
		t.Fatalf("offset = %d, want 7", execRepo.lastOffset)
	}
	if execRepo.lastFilters != filters {
		t.Fatalf("filters = %#v, want %#v", execRepo.lastFilters, filters)
	}
}
