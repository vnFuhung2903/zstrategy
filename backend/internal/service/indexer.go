package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/infrastructure/metrics"
)

type IndexerService struct {
	repo            domain.ExecutionRepository
	strategyRepo    domain.StrategyRepository
	Monitor         *MonitorService
	keeperURL       string
	keeperAPISecret string
	httpClient      *http.Client
	mu              sync.Mutex
	executedWaiters map[string][]chan *domain.ExecutionRecord
}

func NewIndexerService(repo domain.ExecutionRepository, strategyRepo domain.StrategyRepository, keeperURL, keeperAPISecret string) *IndexerService {
	return &IndexerService{
		repo:            repo,
		strategyRepo:    strategyRepo,
		keeperURL:       keeperURL,
		keeperAPISecret: keeperAPISecret,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
		executedWaiters: make(map[string][]chan *domain.ExecutionRecord),
	}
}

var ErrExecutionWaitTimeout = errors.New("execution wait timed out")

// pruneKeeperShares fires a fire-and-forget DELETE to the keeper so encrypted
// share rows for a finalized commitment do not accumulate. The keeper's
// nullifier check on-chain is the real anti-replay; this is just storage hygiene.
func (s *IndexerService) pruneKeeperShares(commitmentHash string) {
	if s.keeperURL == "" {
		return
	}
	url := strings.TrimRight(s.keeperURL, "/") + "/api/shares/" + commitmentHash
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		log.Printf("[Indexer] build prune request: %v", err)
		return
	}
	if s.keeperAPISecret != "" {
		req.Header.Set("Authorization", "Bearer "+s.keeperAPISecret)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		log.Printf("[Indexer] prune shares for %s...: %v", commitmentHash[:10], err)
		return
	}
	resp.Body.Close()
}

func (s *IndexerService) HandleRegistered(ctx context.Context, commitmentHash, kind string, chainID int64, blockTime time.Time) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentRegistered").Inc()
	exists, err := s.repo.ExistsByHash(ctx, commitmentHash)
	if err != nil {
		return fmt.Errorf("check existence: %w", err)
	}
	if exists {
		return nil
	}
	k := domain.CommitmentKind(kind)
	if s.strategyRepo != nil {
		pending, err := s.strategyRepo.GetByHash(ctx, commitmentHash)
		if err != nil {
			return fmt.Errorf("lookup pending strategy kind: %w", err)
		}
		if pending != nil && pending.Kind == domain.KindMarket {
			k = domain.KindMarket
		}
	}
	if k != domain.KindDCA && k != domain.KindMarket {
		k = domain.KindOrderFill
	}
	metrics.StrategiesRegistered.WithLabelValues(strconv.FormatInt(chainID, 10), string(k)).Inc()
	return s.repo.Save(ctx, &domain.ExecutionRecord{
		CommitmentHash: commitmentHash,
		ChainID:        chainID,
		Status:         domain.StatusRegistered,
		Kind:           k,
		RegisteredAt:   blockTime,
	})
}

func (s *IndexerService) UpdateExecutionKind(ctx context.Context, commitmentHash string, kind domain.CommitmentKind) error {
	if kind != domain.KindMarket {
		return nil
	}
	rec, err := s.repo.FindByHash(ctx, commitmentHash)
	if err != nil || rec == nil {
		return err
	}
	if rec.Kind == domain.KindMarket {
		return nil
	}
	return s.repo.UpdateKind(ctx, commitmentHash, kind)
}

func (s *IndexerService) WaitForExecuted(ctx context.Context, commitmentHash string, timeout time.Duration) (*domain.ExecutionRecord, error) {
	rec, err := s.repo.FindByHash(ctx, commitmentHash)
	if err != nil {
		return nil, err
	}
	if rec != nil && rec.Status == domain.StatusExecuted {
		return rec, nil
	}

	ch := make(chan *domain.ExecutionRecord, 1)
	s.mu.Lock()
	s.executedWaiters[commitmentHash] = append(s.executedWaiters[commitmentHash], ch)
	s.mu.Unlock()
	defer s.removeExecutedWaiter(commitmentHash, ch)

	// Close the check/register race: the event may have been indexed just after
	// the first DB read and before this waiter was attached.
	rec, err = s.repo.FindByHash(ctx, commitmentHash)
	if err != nil {
		return nil, err
	}
	if rec != nil && rec.Status == domain.StatusExecuted {
		return rec, nil
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case rec := <-ch:
		return rec, nil
	case <-timer.C:
		return nil, ErrExecutionWaitTimeout
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *IndexerService) removeExecutedWaiter(commitmentHash string, ch chan *domain.ExecutionRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()

	waiters := s.executedWaiters[commitmentHash]
	for i, waiter := range waiters {
		if waiter == ch {
			waiters = append(waiters[:i], waiters[i+1:]...)
			break
		}
	}
	if len(waiters) == 0 {
		delete(s.executedWaiters, commitmentHash)
		return
	}
	s.executedWaiters[commitmentHash] = waiters
}

func (s *IndexerService) notifyExecuted(rec *domain.ExecutionRecord) {
	s.mu.Lock()
	waiters := s.executedWaiters[rec.CommitmentHash]
	delete(s.executedWaiters, rec.CommitmentHash)
	s.mu.Unlock()

	for _, ch := range waiters {
		select {
		case ch <- rec:
		default:
		}
	}
}

func (s *IndexerService) HandleExecuted(ctx context.Context, commitmentHash, txHash string, chainID int64, blockNumber, gasUsed uint64, blockTime time.Time) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentExecuted").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues(strconv.FormatInt(chainID, 10), kind, string(domain.StatusExecuted)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.StrategyDone)
	}
	go s.pruneKeeperShares(commitmentHash)
	if err := s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusExecuted, txHash, blockNumber, gasUsed, &blockTime); err != nil {
		return err
	}
	rec, err := s.repo.FindByHash(ctx, commitmentHash)
	if err != nil {
		return err
	}
	if rec == nil {
		rec = &domain.ExecutionRecord{
			CommitmentHash: commitmentHash,
			ChainID:        chainID,
			Status:         domain.StatusExecuted,
			Kind:           domain.CommitmentKind(kind),
			TxHash:         txHash,
			BlockNumber:    blockNumber,
			GasUsed:        gasUsed,
			RegisteredAt:   blockTime,
			ExecutedAt:     &blockTime,
		}
		if err := s.repo.Save(ctx, rec); err != nil {
			return err
		}
	}
	s.notifyExecuted(rec)
	return nil
}

func (s *IndexerService) HandleCancelled(ctx context.Context, commitmentHash, txHash string, blockNumber uint64) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentCancelled").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues("0", kind, string(domain.StatusCancelled)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.StrategyDone)
	}
	go s.pruneKeeperShares(commitmentHash)
	return s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusCancelled, txHash, blockNumber, 0, nil)
}

func (s *IndexerService) HandleExpired(ctx context.Context, commitmentHash string, blockNumber uint64) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentExpired").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues("0", kind, string(domain.StatusExpired)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.StrategyDone)
	}
	go s.pruneKeeperShares(commitmentHash)
	return s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusExpired, "", blockNumber, 0, nil)
}

// lookupKindLabel returns "ORDER_FILL" or "DCA" for an existing record so the
// terminal-event metric carries the same kind label as the register event.
// On miss (no row yet) we fall back to "ORDER_FILL" — the metric is best-effort,
// not authoritative.
func (s *IndexerService) lookupKindLabel(ctx context.Context, commitmentHash string) string {
	rec, err := s.repo.FindByHash(ctx, commitmentHash)
	if err != nil || rec == nil {
		if s.strategyRepo != nil {
			pending, pendingErr := s.strategyRepo.GetByHash(ctx, commitmentHash)
			if pendingErr == nil && pending != nil {
				return string(pending.Kind)
			}
		}
		return string(domain.KindOrderFill)
	}
	return string(rec.Kind)
}
