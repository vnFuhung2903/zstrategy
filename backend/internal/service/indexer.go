package service

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/infrastructure/metrics"
)

type IndexerService struct {
	repo       domain.ExecutionRepository
	intentRepo domain.IntentRepository
	Monitor    *MonitorService
	Enclave    EnclaveClient
}

func NewIndexerService(repo domain.ExecutionRepository, intentRepo domain.IntentRepository) *IndexerService {
	return &IndexerService{
		repo:       repo,
		intentRepo: intentRepo,
	}
}

func (s *IndexerService) pruneEnclavePackage(commitmentHash string) {
	if s.Enclave == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Enclave.Prune(ctx, commitmentHash); err != nil {
		log.Printf("[Indexer] prune enclave package for %s...: %v", commitmentHash[:10], err)
	}
}

func (s *IndexerService) pruneFinalized(commitmentHash string) {
	s.pruneEnclavePackage(commitmentHash)
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
	k := onChainKindToIntentKind(kind)
	if s.intentRepo != nil {
		pending, err := s.intentRepo.GetByHash(ctx, commitmentHash)
		if err != nil {
			return fmt.Errorf("lookup pending intent kind: %w", err)
		}
		if pending != nil {
			k = pending.Kind
		}
	}
	metrics.IntentsRegistered.WithLabelValues(strconv.FormatInt(chainID, 10), string(k)).Inc()
	return s.repo.Save(ctx, &domain.ExecutionRecord{
		CommitmentHash: commitmentHash,
		ChainID:        chainID,
		Status:         domain.StatusRegistered,
		Kind:           k,
		RegisteredAt:   blockTime,
	})
}

func (s *IndexerService) UpdateExecutionIntentKind(ctx context.Context, commitmentHash string, kind domain.IntentKind) error {
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

func (s *IndexerService) HandleExecuted(ctx context.Context, commitmentHash, txHash string, chainID int64, blockNumber, gasUsed uint64, blockTime time.Time) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentExecuted").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues(strconv.FormatInt(chainID, 10), kind, string(domain.StatusExecuted)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.IntentDone)
	}
	go s.pruneFinalized(commitmentHash)
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
			Kind:           domain.IntentKind(kind),
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
	return nil
}

func (s *IndexerService) HandleCancelled(ctx context.Context, commitmentHash, txHash string, blockNumber uint64) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentCancelled").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues("0", kind, string(domain.StatusCancelled)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.IntentDone)
	}
	go s.pruneFinalized(commitmentHash)
	return s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusCancelled, txHash, blockNumber, 0, nil)
}

func (s *IndexerService) HandleExpired(ctx context.Context, commitmentHash string, blockNumber uint64) error {
	metrics.IndexerEventsTotal.WithLabelValues("CommitmentExpired").Inc()
	kind := s.lookupKindLabel(ctx, commitmentHash)
	metrics.ExecutionsTotal.WithLabelValues("0", kind, string(domain.StatusExpired)).Inc()
	if s.Monitor != nil {
		s.Monitor.StopMonitoring(commitmentHash)
		s.Monitor.UpdateStatus(ctx, commitmentHash, domain.IntentDone)
	}
	go s.pruneFinalized(commitmentHash)
	return s.repo.UpdateStatus(ctx, commitmentHash, domain.StatusExpired, "", blockNumber, 0, nil)
}

func (s *IndexerService) lookupKindLabel(ctx context.Context, commitmentHash string) string {
	rec, err := s.repo.FindByHash(ctx, commitmentHash)
	if err != nil || rec == nil {
		if s.intentRepo != nil {
			pending, pendingErr := s.intentRepo.GetByHash(ctx, commitmentHash)
			if pendingErr == nil && pending != nil {
				return string(pending.Kind)
			}
		}
		return string(domain.KindLimit)
	}
	return string(rec.Kind)
}

func onChainKindToIntentKind(kind string) domain.IntentKind {
	if kind == string(domain.KindDCA) {
		return domain.KindDCA
	}
	return domain.KindLimit
}
