package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/zstrategy/backend/internal/domain"
	"fmt"
)

const statsCacheTTL = 30 * time.Second

type StatsService struct {
	repo         domain.ExecutionRepository
	strategyRepo domain.StrategyRepository
	cache        *redis.Client
	keeperURL    string
	httpClient   *http.Client
}

func NewStatsService(repo domain.ExecutionRepository, strategyRepo domain.StrategyRepository, cache *redis.Client, keeperURL string) *StatsService {
	return &StatsService{
		repo:         repo,
		strategyRepo: strategyRepo,
		cache:        cache,
		keeperURL:    keeperURL,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *StatsService) GetStatistics(ctx context.Context, chainID int64) (*domain.Statistics, error) {
	key := fmt.Sprintf("stats:chain:%d", chainID)

	if b, err := s.cache.Get(ctx, key).Bytes(); err == nil {
		var stats domain.Statistics
		if json.Unmarshal(b, &stats) == nil {
			return &stats, nil
		}
	}

	stats, err := s.repo.GetStatistics(ctx, chainID)
	if err != nil {
		return nil, err
	}

	if b, err := json.Marshal(stats); err == nil {
		s.cache.Set(ctx, key, b, statsCacheTTL)
	}
	return stats, nil
}

func (s *StatsService) GetExecutions(ctx context.Context, chainID int64, kind string, limit, offset int) ([]*domain.ExecutionRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return s.repo.List(ctx, chainID, kind, limit, offset)
}

func (s *StatsService) GetKeeperHealth(ctx context.Context) (*domain.KeeperHealth, error) {
	resp, err := s.httpClient.Get(s.keeperURL + "/api/health")
	if err != nil {
		return &domain.KeeperHealth{Online: false, LastSeenAt: time.Now()}, nil
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return &domain.KeeperHealth{Online: false, LastSeenAt: time.Now()}, nil
	}

	var raw struct {
		Status        string `json:"status"`
		ExecutedCount int    `json:"executedCount"`
		FailedCount   int    `json:"failedCount"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return &domain.KeeperHealth{Online: false, LastSeenAt: time.Now()}, nil
	}

	monitored := 0
	if s.strategyRepo != nil {
		if n, err := s.strategyRepo.CountByStatus(ctx, domain.StrategyPending); err == nil {
			monitored = int(n)
		}
	}

	return &domain.KeeperHealth{
		Online:         raw.Status == "ok",
		MonitoredCount: monitored,
		ExecutedCount:  raw.ExecutedCount,
		FailedCount:    raw.FailedCount,
		LastSeenAt:     time.Now(),
	}, nil
}
