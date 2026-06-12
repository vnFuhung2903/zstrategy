package service

import (
	"context"
	"encoding/json"
	"time"

	"fmt"
	"github.com/redis/go-redis/v9"
	"github.com/zstrategy/backend/internal/domain"
)

const statsCacheTTL = 30 * time.Second

type StatsService struct {
	repo  domain.ExecutionRepository
	cache *redis.Client
}

func NewStatsService(repo domain.ExecutionRepository, cache *redis.Client) *StatsService {
	return &StatsService{
		repo:  repo,
		cache: cache,
	}
}

func (s *StatsService) GetStatistics(ctx context.Context, chainID int64) (*domain.Statistics, error) {
	key := fmt.Sprintf("stats:chain:%d", chainID)

	if s.cache != nil {
		if b, err := s.cache.Get(ctx, key).Bytes(); err == nil {
			var stats domain.Statistics
			if json.Unmarshal(b, &stats) == nil {
				return &stats, nil
			}
		}
	}

	stats, err := s.repo.GetStatistics(ctx, chainID)
	if err != nil {
		return nil, err
	}

	if s.cache != nil {
		if b, err := json.Marshal(stats); err == nil {
			s.cache.Set(ctx, key, b, statsCacheTTL)
		}
	}
	return stats, nil
}

func (s *StatsService) GetExecutions(ctx context.Context, chainID int64, filters domain.ExecutionFilters, limit, offset int) ([]*domain.ExecutionRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return s.repo.List(ctx, chainID, filters, limit, offset)
}
