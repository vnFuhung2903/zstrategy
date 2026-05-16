package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/redis/go-redis/v9"
	"github.com/zstrategy/backend/config"
	handler "github.com/zstrategy/backend/internal/handler/http"
	"github.com/zstrategy/backend/internal/indexer"
	"github.com/zstrategy/backend/internal/infrastructure"
	"github.com/zstrategy/backend/internal/repository"
	"github.com/zstrategy/backend/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// ── Database ──────────────────────────────────────────────────────────────
	log.Println("[main] running database migrations...")
	if err := infrastructure.RunMigrations(infrastructure.MigrationsFS, cfg.DatabaseURL); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	db, err := infrastructure.NewDB(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}

	// ── Redis ─────────────────────────────────────────────────────────────────
	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("parse redis url: %v", err)
	}
	redisClient := redis.NewClient(redisOpts)
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := redisClient.Ping(pingCtx).Err(); err != nil {
		log.Printf("[main] redis not reachable (%v) — stats caching disabled", err)
	}
	pingCancel()

	// ── Dependency wiring ─────────────────────────────────────────────────────
	execRepo     := repository.NewExecutionRepo(db)
	strategyRepo := repository.NewStrategyRepo(db)
	indexerSvc   := service.NewIndexerService(execRepo, cfg.KeeperURL, cfg.KeeperAPISecret)
	statsSvc     := service.NewStatsService(execRepo, strategyRepo, redisClient, cfg.KeeperURL)

	// ── Ethereum client (shared between indexer and monitor) ──────────────────
	var ethClient *ethclient.Client
	if cfg.RPCURL != "" {
		ethClient, err = ethclient.Dial(cfg.RPCURL)
		if err != nil {
			log.Printf("[main] eth client dial failed: %v — monitor Chainlink disabled", err)
			ethClient = nil
		}
	}

	// ── Monitor service ───────────────────────────────────────────────────────
	monitorSvc := service.NewMonitorService(strategyRepo, ethClient, cfg.CommitmentRegistryAddress, cfg.KeeperURL, cfg.KeeperAPISecret)
	indexerSvc.Monitor = monitorSvc

	// ── Root context ──────────────────────────────────────────────────────────
	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	// Rehydrate pending strategies on startup; reset orphaned EXECUTING rows.
	monitorSvc.RehydrateFromDB(rootCtx)
	monitorSvc.StartStuckSweeper(rootCtx)

	// ── Chain indexer (background goroutine) ──────────────────────────────────
	if cfg.RPCURL != "" && cfg.CommitmentRegistryAddress != "" {
		ci, err := indexer.New(cfg.RPCURL, cfg.CommitmentRegistryAddress, cfg.ChainID, indexerSvc)
		if err != nil {
			log.Printf("[main] indexer init failed: %v — chain indexer disabled", err)
		} else {
			go ci.Run(rootCtx)
			log.Printf("[main] chain indexer started (chain=%d)", cfg.ChainID)
		}
	} else {
		log.Println("[main] RPC_URL or COMMITMENT_REGISTRY_ADDRESS not set — chain indexer disabled")
	}

	// ── HTTP server ───────────────────────────────────────────────────────────
	h := handler.NewHandler(statsSvc, indexerSvc, strategyRepo, monitorSvc, cfg.KeeperURL, cfg.KeeperAPISecret)
	router := handler.NewRouter(h, cfg.MetricsEnabled)

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      router,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("[main] server listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server: %v", err)
		}
	}()

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("[main] shutting down...")
	rootCancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[main] shutdown error: %v", err)
	}
	log.Println("[main] stopped")
}
