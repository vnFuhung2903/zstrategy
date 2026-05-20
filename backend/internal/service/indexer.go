package service

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/infrastructure/metrics"
)

type IndexerService struct {
	repo            domain.ExecutionRepository
	Monitor         *MonitorService
	keeperURL       string
	keeperAPISecret string
	httpClient      *http.Client
}

func NewIndexerService(repo domain.ExecutionRepository, keeperURL, keeperAPISecret string) *IndexerService {
	return &IndexerService{
		repo:            repo,
		keeperURL:       keeperURL,
		keeperAPISecret: keeperAPISecret,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
	}
}

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
	if k != domain.KindDCA {
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

func (s *IndexerService) HandleExecuted(ctx context.Context, commitmentHash, txHash string, chainID int64, blockNumber, gasUsed uint64, blockTime time.Time) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentExecuted").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues(strconv.FormatInt(chainID, 10), kind, string(domain.StatusExecuted)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.StrategyDone)
	}
	go s.pruneKeeperShares(commitmentHash)
	return s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusExecuted, txHash, blockNumber, gasUsed, &blockTime)
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
		return string(domain.KindOrderFill)
	}
	return string(rec.Kind)
}
