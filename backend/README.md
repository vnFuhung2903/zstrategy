# zstrategy backend

Go service that indexes `CommitmentRegistry` events from chain into Postgres, exposes a stats REST API, and forwards keeper health to the frontend.

## Layout

```
cmd/server/        # main.go — entrypoint
config/            # env loader (config.Load)
internal/
  domain/          # entities (ExecutionRecord, etc.)
  repository/      # GORM-backed persistence (ExecutionRepo)
  service/         # business logic (IndexerService, StatsService)
  indexer/         # ethers-style event poller (chain.go subscribes to RegistryRegistered/Executed/Cancelled)
  handler/http/    # gin routes + DTOs
  infrastructure/  # DB connection + golang-migrate runner
```

`internal/handler/http/router.go` exposes:

| Method | Path                    | Purpose                             |
|--------|-------------------------|-------------------------------------|
| GET    | `/health`               | Liveness                            |
| GET    | `/metrics`              | Prometheus (when `METRICS_ENABLED`) |
| GET    | `/api/v1/stats`         | Aggregate stats (cached in Redis)   |
| GET    | `/api/v1/executions`    | Paginated execution log             |
| GET    | `/api/v1/keeper/health` | Proxy to keeper `/api/health`       |

## Prerequisites

- Go 1.22+
- Postgres 16 (any reachable instance)
- Redis 7 (optional — without it, stats caching is disabled and the server still runs)

For local dev, the easiest path is the root-level `docker-compose.yml`, which brings up Postgres + Redis + this backend + the keeper.

## Environment

Loaded from process env (or a `.env` in the working directory). Required vars:

```
PORT=8080
DATABASE_URL=postgres://zstrategy:zstrategy@localhost:5432/zstrategy?sslmode=disable
REDIS_URL=redis://localhost:6379/0
RPC_URL=https://...
CHAIN_ID=421614
COMMITMENT_REGISTRY_ADDRESS=0x...
KEEPER_URL=http://localhost:3001
METRICS_ENABLED=true
```

If `RPC_URL` or `COMMITMENT_REGISTRY_ADDRESS` is empty, the chain indexer goroutine is skipped and the API still serves whatever is already in the DB.

## Install

```sh
cd backend
go mod download
```

## Run

```sh
go run ./cmd/server
```

Migrations in `internal/infrastructure/migrations/*.sql` run automatically at startup.

## Build (Docker)

```sh
docker build -t zstrategy-backend .
```

## Test

No test files yet (`grep -r '_test.go'` is empty). When adding tests, run with:

```sh
go test ./...
```
