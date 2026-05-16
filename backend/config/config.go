package config

import (
	"fmt"
	"os"
	"strconv"

	"github.com/joho/godotenv"
)

// ArbitrumSepoliaChainID is the EVM chain id for Arbitrum Sepolia (the primary
// thesis testnet). Used as the system-wide fallback when neither the CHAIN_ID
// env var nor a `?chain_id=` query string provides one.
const ArbitrumSepoliaChainID int64 = 421614

// DefaultChainID is the chain id used as a fallback. Currently aliased to
// Arbitrum Sepolia; change here to retarget the default network.
const DefaultChainID = ArbitrumSepoliaChainID

type Config struct {
	Port                      string
	DatabaseURL               string
	RedisURL                  string
	RPCURL                    string
	ChainID                   int64
	CommitmentRegistryAddress string
	KeeperURL                 string
	KeeperAPISecret           string
	MetricsEnabled            bool
}

func Load() (*Config, error) {
	_ = godotenv.Load()

	chainID, err := strconv.ParseInt(getEnv("CHAIN_ID", strconv.FormatInt(DefaultChainID, 10)), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid CHAIN_ID: %w", err)
	}

	return &Config{
		Port:                      getEnv("PORT", "8080"),
		DatabaseURL:               getEnv("DATABASE_URL", "postgres://zstrategy:zstrategy@localhost:5432/zstrategy?sslmode=disable"),
		RedisURL:                  getEnv("REDIS_URL", "redis://localhost:6379/0"),
		RPCURL:                    getEnv("RPC_URL", ""),
		ChainID:                   chainID,
		CommitmentRegistryAddress: getEnv("COMMITMENT_REGISTRY_ADDRESS", ""),
		KeeperURL:                 getEnv("KEEPER_URL", "http://localhost:3001"),
		KeeperAPISecret:           getEnv("KEEPER_API_SECRET", ""),
		MetricsEnabled:            getEnv("METRICS_ENABLED", "true") == "true",
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
