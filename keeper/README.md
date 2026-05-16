# zstrategy keeper

Node.js service that produces ZK proofs and submits `executeCommitment` on-chain when triggered by the Go backend. Path B1 (threshold keeper): `user_secret` is reconstructed at fill time from k-of-N Shamir shares stored as ECIES ciphertexts.

The keeper does **not** poll for fill conditions — that responsibility lives in the Go backend's `MonitorService` goroutines. The keeper is purely trigger-based.

## Layout

```
src/
  index.ts               # bootstrap: wires API + state init
  keeper.ts              # in-memory state + log banner (no tick loop)
  config.ts              # env loader (validates required vars)
  types.ts               # OrderKind, Direction, ExecuteRequest, OraclePrice, KeeperState
  api/server.ts          # express routes (see below)
  chain/
    contracts.ts         # ethers contract handles + event ABIs
    provider.ts          # JsonRpcProvider singleton
    oracle.ts            # Chainlink ETH/USD reader (used at re-verify time)
  execution/submitter.ts # generate ZK proof → executeCommitment → retry/backoff → backend done callback
  store/
    db.ts                # better-sqlite3 schema (shares table only)
    shares.ts            # encrypted-share rows: insert / get / delete
  threshold/
    keys.ts              # secp256k1 keypair set (in-process simulation of N keepers)
    reconstruct.ts       # Lagrange interpolation in GF(256) over decrypted shares
  zk/
    orderFill.ts         # bb.js UltraHonk proof for ORDER_FILL
    dca.ts               # bb.js UltraHonk proof for DCA
test/
  threshold.test.ts      # round-trip: split → ECIES-encrypt → DB → reconstruct
```

## API

| Method | Path                              | Auth     | Purpose                                                                              |
|--------|-----------------------------------|----------|--------------------------------------------------------------------------------------|
| GET    | `/api/health`                     | public   | Status, uptime seconds, executed/failed counts                                       |
| GET    | `/api/keepers`                    | public   | Threshold params + keeper public-key set (for ECIES)                                 |
| POST   | `/api/shares`                     | bearer   | Body: `{ commitmentHashes: string[], encryptedShares: [...] }` — store one row per pair filtered by this keeper's id |
| DELETE | `/api/shares/:commitmentHash`     | bearer   | Prune share rows after a terminal on-chain event (called by Go indexer)              |
| POST   | `/api/execute`                    | bearer   | Backend-triggered execution: re-verify → reconstruct → prove → submit. Returns 202 immediately, runs async |
| GET    | `/api/executions`                 | public   | Aggregate executed/failed counts                                                     |

**Auth.** Bearer token is `API_SECRET` (set both in keeper env and as `KEEPER_API_SECRET` on the Go backend). `/api/keepers` and `/api/health` are public because the frontend needs the keypair set pre-wallet to encrypt Shamir shares.

**Backend → keeper flow.** The Go backend forwards encrypted shares once at registration (one POST with all commitment hashes), then triggers `/api/execute` when the fill condition is met. On terminal chain events (executed / cancelled / expired), the indexer calls DELETE to prune shares.

**Keeper → backend flow.** On a definitive on-chain revert (e.g. nullifier already spent) or after the retry budget is exhausted, the submitter posts to `BACKEND_URL/api/v1/strategies/<hash>/done` so the monitor row leaves EXECUTING and the goroutine stops.

## Prerequisites

- **Node.js 22+** (for `better-sqlite3` 11.x prebuilt binaries; older Node versions need MSVC build tools on Windows).
- Reachable Ethereum-compatible RPC and `CommitmentRegistry` deployment (see `contracts/scripts/deploy.ts`).

## Install

```sh
cd keeper
npm install
```

## Environment

```
RPC_URL=https://...
CHAIN_ID=421614
KEEPER_PRIVATE_KEY=0x...                  # signs executeCommitment txs
COMMITMENT_REGISTRY_ADDRESS=0x...          # also used to look up priceFeeds for oracle re-verify
COLLATERAL_VAULT_ADDRESS=0x...

API_PORT=3001
API_SECRET=...                             # bearer for /api/shares, /api/execute, DELETE
BACKEND_URL=http://localhost:8080          # optional; enables keeper→backend done callbacks

DB_PATH=./data/keeper.db                   # default

THRESHOLD_N=5                              # simulated keepers in this process
THRESHOLD_K=3                              # reconstruction threshold
THRESHOLD_KEYS_FILE=./data/keeper-keys.json

CIRCUIT_JSON_PATH=../circuits/order_fill/target/order_fill.json
DCA_CIRCUIT_JSON_PATH=../circuits/dca/target/dca.json
```

The threshold keypairs are auto-generated on first start and persisted to `THRESHOLD_KEYS_FILE`. Delete that file to rotate.

## Run (dev)

```sh
npm run dev
```

## Build / Start

```sh
npm run build
npm run start
```

## Test

```sh
npm test
```

Runs `node --require ts-node/register --test test/threshold.test.ts` — the round-trip suite for the threshold module (split → ECIES-encrypt → DB → reconstruct, plus a below-threshold rejection check).
