# zstrategy Backend

Go service for v2 intent relay/scheduling, chain indexing, stats, and public
execution tickets. It stores public intent metadata plus encrypted witness
packages only; plaintext witness fields must not be accepted by v2 routes.

## Prerequisites

- Go 1.22+
- PostgreSQL 16+
- Redis 7+ for stats caching
- An EVM RPC endpoint for the target chain
- The simulated enclave service running for v2 proof scheduling

## Install Dependencies

```powershell
cd backend
go mod download
```

## Environment

File: `backend/.env` when running commands from `backend/`.

```env
PORT=8080
DATABASE_URL=postgres://zstrategy:zstrategy@localhost:5432/zstrategy?sslmode=disable
REDIS_URL=redis://localhost:6379/0
RPC_URL=https://YOUR_ARBITRUM_SEPOLIA_RPC
CHAIN_ID=421614
COMMITMENT_REGISTRY_ADDRESS=0xYOUR_COMMITMENT_REGISTRY
ENCLAVE_URL=http://localhost:3002
ENCLAVE_API_SECRET=
METRICS_ENABLED=true
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTP listen port; defaults to `8080`. |
| `DATABASE_URL` | Yes | PostgreSQL connection string for migrations, execution records, pending intents, and tickets. |
| `REDIS_URL` | No | Redis connection string for stats cache. |
| `RPC_URL` | Yes for scheduler/executor claims | EVM RPC used by the chain indexer, on-chain pending checks, oracle reads, and claim-time `eth_call`. |
| `CHAIN_ID` | Yes | Target chain ID; Arbitrum Sepolia is `421614`. |
| `COMMITMENT_REGISTRY_ADDRESS` | Yes for scheduler/executor claims | Deployed `CommitmentRegistry` address. |
| `ENCLAVE_URL` | Yes for v2 scheduling | Simulated enclave HTTP base URL. |
| `ENCLAVE_API_SECRET` | Only if enclave requires it | Bearer token shared with the enclave service. Leave empty for local unsecured demo. |
| `METRICS_ENABLED` | No | Enables `/metrics` when `true`. |

## Run In Development

Start dependencies from the repo root if needed:

```powershell
docker compose up postgres redis
```

Then run:

```powershell
cd backend
go run ./cmd/server
```

SQL migrations in `internal/infrastructure/migrations/` run automatically at
startup.

## Build

```powershell
cd backend
go build ./...
```

Docker build:

```powershell
cd backend
docker build -t zstrategy-backend .
```

## Test

```powershell
cd backend
go test ./...
```

If the default Go cache is unavailable on Windows, use a local temp cache:

```powershell
cd backend
$env:GOCACHE = Join-Path $env:TEMP 'zstrategy-go-cache'
go test ./...
```

## Main Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness. |
| `GET` | `/metrics` | Prometheus metrics when enabled. |
| `GET` | `/api/v1/stats` | Aggregate chain stats. |
| `GET` | `/api/v1/executions` | Paginated execution log. |
| `POST` | `/api/v1/enclave/attest` | Proxy simulated enclave attestation to the frontend. |
| `POST` | `/api/v1/intents/order` | Register LIMIT/MARKET encrypted intent package. |
| `POST` | `/api/v1/intents/dca` | Register encrypted DCA rounds with an opaque `dcaGroupLockId`. |
| `GET` | `/api/v1/executor/tickets` | List backend-ready public execution tickets. |
| `POST` | `/api/v1/executor/tickets/claim` | Lease and claim one ticket after `eth_call` simulation. |

## Troubleshooting

- If `RPC_URL` or `COMMITMENT_REGISTRY_ADDRESS` is empty, the server can start,
  but chain indexing, scheduler on-chain checks, and claim simulation are
  unavailable.
- If DCA registration fails with an AAD mismatch, confirm the frontend sends
  `dcaGroupLockId` at the top level and in every witness package AAD. Raw
  `dcaGroupId` is intentionally rejected by the backend.
- If pending intents stay `PENDING`, check enclave availability, RPC access,
  registry address, and backend logs for import/evaluation errors.
- If migrations fail, verify the PostgreSQL user can create tables and indexes.
