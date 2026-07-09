# zstrategy Current System

This document is the primary current documentation guide for the zstrategy system. Active code, runtime configuration, and tests are the strongest evidence for what is implemented. If documentation conflicts with active code, prefer the code and update the documentation conservatively.

## Status Convention

- Current: implemented and demo-relevant now.
- Future work: planned but not implemented.
- Legacy: old implementation or historical design.

Use `intent` for current product, code, API, UI, and thesis language. Older terms such as `strategy` and `keeper` may still appear in active identifiers, comments, tests, or generated artifacts; treat them as legacy wording unless referring to exact code.

## Project Vision

zstrategy is a privacy-preserving DeFi automation prototype for private trading intents. Users create commitments for actions such as limit orders, market orders, and DCA rounds without publishing the private witness data that determines when those intents should execute.

The current demo goal is to show that:

- users can create encrypted private intents in the browser;
- the backend stores public metadata plus encrypted witness packages, not plaintext witnesses;
- a simulated Nitro-style prover boundary evaluates and proves intents;
- public executors can submit execution tickets without seeing private witness data;
- the smart contract remains the settlement trust root.

This is a thesis/demo system, not a production system. The simulated Nitro-style prover boundary does not provide hardware isolation.

## Problem Statement

On-chain automation often leaks actionable information before execution:

- Limit orders reveal target prices that can be attacked or copied.
- DCA schedules reveal repeated timing patterns.
- Conditional automation services often require an off-chain operator to know the user's trigger condition.
- Public mempools expose execution transactions to MEV risks.

zstrategy reduces this leakage by committing to private witness data and proving execution validity later.

## Goals And Scope

Current scope:

- Private limit orders.
- Private buy-side and sell-side market orders using the same order-fill circuit with sentinel prices.
- Private DCA rounds with non-overlap checks and off-chain same-group proof locking.
- Encrypted witness packages.
- Simulated Nitro-style prover boundary: a local software boundary that imitates the data flow and interface of an AWS Nitro Enclave design, but is not a deployed AWS Nitro Enclave and does not provide hardware isolation.
- Public execution ticket queue, claim endpoint, frontend executor route, and standalone CLI executor.
- On-chain settlement through `CommitmentRegistry`, `CollateralVault`, verifier contracts, and a DEX adapter.
- Output-token executor/prover fees from gross swap output.
- Backend chain indexing, stats, and Prometheus metrics.

Out of current scope:

- Real AWS Nitro Enclave deployment.
- Production hardware isolation.
- Private-mempool or Flashbots Protect transaction routing.
- Cryptographic executor-specific ticket binding.
- Multi-backend shared DCA locks.
- Strict on-chain DCA round ordering.
- Grid trading, copy trading, and multi-chain production support.
- Fully production-grade UX, recovery, rate limiting, and abuse controls.

## Current Architecture

```text
Browser
  - builds private intent witness locally
  - derives order user_secret from the order nonce and wallet signature
  - derives one DCA-batch user_secret from a separate shared nonce and reuses it with round-specific nonces
  - computes commitment and nullifier
  - verifies simulated enclave attestation
  - encrypts witness package to the enclave key
  - registers commitment on-chain
  - posts public metadata plus encrypted package to backend

Backend
  - accepts intent registration routes
  - stores pending_intents with public metadata and encrypted witness package
  - indexes registry events
  - schedules enclave evaluation
  - stores execution tickets when proofs are ready
  - exposes public ticket list and claim endpoints
  - runs claim-time eth_call simulation before returning a claimed ticket

Simulated Nitro-style prover
  - owns the witness decryption key
  - returns simulated attestation reports
  - imports encrypted witness packages
  - decrypts only inside the prover boundary
  - checks private fill conditions
  - generates Noir/Barretenberg proofs
  - signs prover receipts for execution tickets

Public executor
  - fetches or claims public tickets
  - receives no witness plaintext and no witness package
  - submits executeCommitment(commitmentHash, nullifier, proof, fillRef, receipt)

Smart contracts
  - store commitments
  - verify prover receipts and ZK proofs
  - read Chainlink-compatible price feeds for order fills
  - freshness-check DCA fillRef
  - swap collateral through the DEX adapter
  - distribute output-token fees and user proceeds
```

## Main Components

### Frontend

Location: `frontend/`

Current responsibilities:

- Next.js app for dashboard analytics, order creation, DCA creation, vault operations, activity, settings, and public executor UI.
- Wallet integration through wagmi and viem.
- Client-side commitment generation.
- Local encrypted witness package creation.
- Simulated enclave attestation verification through the backend attestation route; independent root-key pinning is used when `NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM` is configured.
- Local IndexedDB metadata for user-owned intents.
- Encrypted local backup/import UI for locally stored order-intent metadata.
- Backend registration calls after on-chain commitment confirmation.
- User-visible retry for backend sync failures after successful wallet transactions.

Important frontend routes:

- `/dashboard` - dashboard analytics and recent activity.
- `/orders` - limit and market order creation.
- `/dca` - DCA batch creation.
- `/executor` - public executor ticket claim and submission UI.
- `/vault` - collateral/vault UI.
- `/activity` - indexed execution/activity view.
- `/settings` - local encrypted backup/import and user settings.

### Backend

Location: `backend/`

Current responsibilities:

- HTTP API using Gin.
- PostgreSQL persistence through GORM.
- Chain indexing and execution stats.
- Intent relay and scheduler.
- Enclave package import/evaluation orchestration.
- Ticket publication, leasing, claim simulation, stale-ticket reset, and terminal-state cleanup.
- Prometheus metrics.

Current HTTP routes:

| Method | Path | Status | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Current | Liveness. |
| `GET` | `/metrics` | Current | Prometheus metrics when enabled. |
| `GET` | `/api/v1/dashboard` | Current | Dashboard analytics and recent activity summary. |
| `GET` | `/api/v1/stats` | Current | Aggregate indexed stats. |
| `GET` | `/api/v1/executions` | Current | Paginated execution records. |
| `POST` | `/api/v1/enclave/attest` | Current | Proxy simulated enclave attestation metadata/report to the frontend. |
| `POST` | `/api/v1/intents/order` | Current | Register LIMIT or MARKET encrypted witness package. |
| `POST` | `/api/v1/intents/dca` | Current | Register encrypted DCA rounds with an opaque `dcaGroupLockId`. |
| `GET` | `/api/v1/executor/tickets` | Current | List backend-ready, non-expired public execution tickets. |
| `POST` | `/api/v1/executor/tickets/claim` | Current | Claim a ticket, lease it briefly, and run claim-time `eth_call` simulation. |

The claim endpoint accepts:

```json
{
  "executor": "0x...",
  "commitmentHash": "0x..."
}
```

`commitmentHash` is optional. If it is supplied, the backend targets that specific ready ticket regardless of generic queue position. If omitted, the endpoint keeps the next-available queue behavior.

### Enclave

Location: `enclave/`

Current status: simulated Nitro-style prover boundary.

The enclave package exposes:

- simulated attestation;
- X25519 plus AES-256-GCM witness package encryption/decryption flow;
- package import;
- private evaluation;
- Noir/Barretenberg proof generation;
- prover receipt signing.

The local process is not a hardware security boundary. It is an interface-compatible demo target for a future AWS Nitro Enclave adapter.

### Executor

Locations:

- Frontend executor route: `frontend/src/app/(dashboard)/executor/page.tsx`
- CLI executor package: `executor/`

Current behavior:

- Public executors claim tickets from the backend.
- The frontend executor can claim the selected commitment hash.
- The CLI executor claims one backend-selected ticket for the connected chain.
- Executors validate ticket shape before submitting.
- Executors do not receive witness packages or plaintext witness fields.

### Smart Contracts

Location: `contracts/`

Current contract responsibilities:

- `CommitmentRegistry.sol`
  - registers commitments;
  - dispatches proof verification by commitment kind;
  - verifies EIP-712 prover receipts;
  - checks pending status, expiry, and nullifier reuse;
  - reads Chainlink feeds for ORDER_FILL;
  - freshness-checks DCA timestamps;
  - executes settlement and fee distribution.
- `CollateralVault.sol`
  - stores user ERC-20 collateral;
  - locks collateral per commitment;
  - releases collateral for execution.
- `OrderFillVerifier.sol`
  - generated UltraHonk verifier for limit and market orders.
- `DCAVerifier.sol`
  - generated UltraHonk verifier for DCA rounds.
- DEX adapter contracts
  - execute swaps for settlement.

## Intent Lifecycle

1. The user builds an intent in the browser.
2. For an order, the browser derives `user_secret` from a wallet signature over an `intentId` built with the order nonce. For a DCA batch, it derives one `user_secret` using a separate shared nonce and reuses that secret with distinct round nonces.
3. The browser computes the commitment hash and nullifier.
4. The browser verifies simulated enclave attestation.
5. The browser encrypts the witness package to the attested enclave public key.
6. The user registers the commitment on-chain.
7. After the wallet transaction confirms, the frontend posts public metadata plus encrypted package to the backend.
8. The backend stores the pending intent and imports the encrypted package into the simulated enclave.
9. The backend scheduler supplies public context to the enclave.
10. The enclave decrypts privately, checks the condition, and returns `NOT_READY` or an execution ticket.
11. When a ticket is ready, the backend stores it as `TICKET_READY`.
12. A public executor lists or claims a ticket.
13. The backend claim endpoint leases the ticket and simulates `executeCommitment` with `eth_call`.
14. The executor submits the transaction.
15. The registry verifies receipt and proof, executes settlement, spends the nullifier, and emits events.
16. The backend indexer observes terminal events and stops or prunes scheduling state.

## Supported Flows

### Limit Order

Status: Current.

A limit order hides the limit price, direction, nonce, nullifier, and `user_secret` inside the encrypted witness package. Public registration still includes token addresses, size, `minOut`, expiry, owner, and commitment hash.

Execution condition:

- BUY: oracle pair price must be less than or equal to the private price.
- SELL: oracle pair price must be greater than or equal to the private price.

ORDER_FILL tickets use `fillRef = "0"` because the registry reads the configured Chainlink-compatible feeds at execution time.

### Market Order

Status: Current.

Market orders reuse the ORDER_FILL circuit and on-chain commitment kind. The frontend stores a user-facing `kind = "MARKET"` but the contract still sees `ORDER_FILL`.

Sentinel private prices:

- BUY market order: `price = u64.max`.
- SELL market order: `price = 0`.

These sentinels make the order-fill condition trivially satisfiable while preserving the same proof and settlement path. Market orders use a short expiry so unfilled demo orders do not linger indefinitely.

Buy-side and sell-side market creation are usable through the current frontend. Submission validation rejects a zero price for limit orders but permits the intentional zero-price sentinel used by sell-side market orders.

### DCA

Status: Current.

DCA creates multiple independent DCA commitments, one per round. Each round has its own nonce, nullifier, scheduled window, expiry, and encrypted witness package.

The browser derives one `user_secret` for the DCA batch from a separate shared nonce. That secret is reused with each round's distinct nonce when computing the round commitment and nullifier.

Current DCA protections:

- frontend rejects overlapping windows for a group before signing and registration;
- enclave rejects overlapping same-group windows before proof generation;
- backend stores only an opaque `dcaGroupLockId`, not raw `dcaGroupId`;
- scheduler prevents concurrent proof jobs for the same `dcaGroupLockId` within one running backend instance;
- public executor ticket responses do not expose raw group IDs, lock IDs, private windows, round nonces, `user_secret`, or witness packages; the execution nullifier is included in a ready ticket because the registry requires it.

The backend DCA coordination is off-chain and limited to one running backend/prover instance. Strict on-chain round ordering is future work.

## ZK Proof Model

Current proof system:

- Circuits: Noir.
- Proving backend: Barretenberg / UltraHonk.
- Solidity verifiers generated by Barretenberg.

Current circuits:

- `circuits/order_fill`
- `circuits/dca`

Public input layout shared by current tickets:

```text
[0] commitment_hash
[1] fill_ref
[2] nullifier
[3] token_in
[4] token_out
[5] size
[6] min_out
[7] expiry
```

For ORDER_FILL, the submitted ticket uses `fillRef = 0`, and the registry replaces it with the latest reported Chainlink-compatible pair price before proof verification. The current testnet-oriented contract does not enforce its configured oracle-staleness limit.

For DCA, `fillRef` is the proven execution timestamp. The registry requires it to be not in the future and recent enough relative to the block timestamp.

The nullifier is single-use and prevents replay.

Circuit artifact notes:

- The enclave proof service loads compiled circuit JSON from `ORDER_FILL_CIRCUIT_JSON` and `DCA_CIRCUIT_JSON`; build or provide `circuits/*/target/*.json` before real proof generation.
- The frontend loads circuit-aligned commitment and witness helpers that must stay byte-identical to the Noir circuits and Solidity public-input layout.
- Regenerating Solidity verifiers from Barretenberg output may require manually renaming the final generated verifier contract to match the file (`OrderFillVerifier` or `DCAVerifier`) and linking `ZKTranscriptLib`.
- Circuit compilation and Barretenberg verifier generation are easiest from a Linux or WSL shell.

## Simulated Nitro-Style Prover Model

Status: Current as a local simulation.

The simulated enclave imitates the Nitro-style boundary:

- the enclave owns a recipient key;
- attestation binds nonce, image digest, PCR-like values, and enclave public key;
- the browser verifies the report before encrypting the witness package;
- only the simulated prover service decrypts witness ciphertext;
- the backend validates public package metadata and AAD while treating ciphertext as opaque;
- public executors do not receive witness packages or plaintext witness fields.

This does not claim real hardware isolation. Real AWS Nitro Enclave integration is future work.

## Public Executor Ticket Flow

Status: Current.

Ticket shape includes public metadata and proof material:

- `commitmentHash`
- `chainId`
- `registry`
- `kind`
- `nullifier`
- `fillRef`
- `proof`
- `ticketExpiresAt`
- `packageHash`
- `proverId`
- `proverReceipt`

Ticket privacy rule:

Public ticket APIs must not expose:

- plaintext witness fields;
- witness packages;
- limit price;
- direction;
- nonce;
- `user_secret`;
- raw `dcaGroupId`;
- `dcaGroupLockId`;
- DCA scheduled windows.

Claim behavior:

- `GET /api/v1/executor/tickets` is a lightweight backend-ready list.
- `POST /api/v1/executor/tickets/claim` requires an executor address.
- The backend records a short lease bounded by ticket expiry.
- The backend runs `eth_call` simulation of the registry execution before returning a claimed ticket.
- If claim simulation fails while the commitment remains pending, the backend clears the stale ticket and resets the intent for re-evaluation.
- If the commitment is already finalized, the backend marks the row done.

Leases coordinate honest executors. They are not cryptographic executor binding.

## Smart Contract Settlement Flow

Current execution calldata:

```solidity
executeCommitment(
    bytes32 commitmentHash,
    bytes32 nullifier,
    bytes proof,
    uint64 fillRef,
    ProverReceipt receipt
)
```

Settlement steps:

1. Require commitment is pending, not expired, and nullifier unspent.
2. Verify prover receipt:
   - known prover;
   - active prover;
   - unexpired ticket;
   - EIP-712 signature over commitment hash, nullifier, proof hash, submitted fillRef, ticket expiry, commitment kind, and prover ID.
3. Build verifier public inputs.
4. For ORDER_FILL, require submitted `fillRef == 0` and read the latest reported Chainlink-compatible pair price; oracle-staleness enforcement is currently disabled in the testnet-oriented contract.
5. For DCA, validate submitted `fillRef` freshness.
6. Verify the UltraHonk proof.
7. Mark nullifier spent and commitment executed before external calls.
8. Release collateral to the DEX adapter and swap to the registry.
9. Require gross output is at least `minOut`.
10. Pay executor and prover fees from gross `tokenOut`.
11. Transfer remaining `tokenOut` to the commitment owner.

Fee model:

- Public executors pay gas upfront.
- Executor and prover are paid from gross output tokens.
- Fee bps are registry settings with caps.
- No active gas-reimbursement vault is used by the current public execution flow.

## Privacy And Security Model

Current privacy claims:

- Backend does not store plaintext witness fields. It validates public package metadata and AAD while storing ciphertext without decrypting it.
- Public executors do not receive witness packages or private witness fields.
- Chain observers do not see private limit price, DCA windows, nonce, or `user_secret`.
- The contract verifies settlement validity independently of the backend, executor, and enclave host.

Public or revealed information:

- commitment hash;
- owner address;
- token addresses;
- size;
- `minOut`;
- expiry;
- commitment kind;
- execution fact and settlement outputs;
- nullifier at execution;
- DCA grouping may be partially visible to the backend through opaque lock IDs.

Security boundaries:

- Smart contracts are the settlement trust root.
- The simulated Nitro-style prover boundary is trusted for demo privacy but is not hardware-isolated.
- Backend is trusted for availability and scheduling, not for settlement correctness.
- Executors are untrusted transaction submitters.
- Oracle data is read by the registry at fill time for ORDER_FILL.

Known security limitations:

- No real TEE hardware isolation yet.
- No private-mempool or Flashbots Protect transaction path is implemented.
- No cryptographic executor-specific ticket binding.
- Claim simulation can race the next block or another executor transaction.
- Backend ticket list is eventually consistent with chain indexing.
- ORDER_FILL tickets can become stale if oracle prices move between proof generation, claim simulation, and mined execution.
- DCA same-group coordination is not shared across multiple backend/prover instances.
- Registration endpoints need production-grade anti-spam and ownership hardening before public production use.
- Browser-local metadata recovery after a post-confirmation backend sync failure is not fully productized.

## Technical Stack

| Area | Current stack |
| --- | --- |
| Frontend | Next.js, React, TypeScript, wagmi, viem, Tailwind CSS |
| Backend | Go, Gin, GORM, PostgreSQL, Redis |
| Enclave | TypeScript, Node.js, simulated Nitro-style API |
| Executor CLI | TypeScript, Node.js, ethers |
| Contracts | Solidity, Hardhat, OpenZeppelin |
| Circuits | Noir, Barretenberg, UltraHonk |
| Oracle | Chainlink-compatible feeds configured through `CommitmentRegistry.priceFeeds` |
| DEX | Adapter interface with Uniswap adapters |
| Metrics | Prometheus and Grafana |
| Demo chain | Arbitrum Sepolia |

## Common Commands

Backend:

```powershell
cd backend
go build ./...
go test ./...
go run ./cmd/server
```

If the Go cache is unavailable on Windows:

```powershell
cd backend
$env:GOCACHE = Join-Path $env:TEMP 'zstrategy-go-cache'
go test ./...
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
npm run lint
npm run test:dca
npm run build
```

Frontend dev URL:

```text
http://localhost:5173
```

`next/font` fetches Google font assets during build. Restricted network environments may need network access or local fonts.

Enclave:

```powershell
cd enclave
npm install
npm run generate-demo-env
npm run dev
npm test
npm run build
```

Executor CLI:

```powershell
cd executor
npm install
$env:BACKEND_URL = "http://localhost:8080"
$env:RPC_URL = "https://..."
$env:EXECUTOR_PRIVATE_KEY = "0x..."
npm run execute
```

Contracts:

```powershell
cd contracts
npx hardhat compile
npx hardhat test
```

Docker Compose local stack from repo root:

```powershell
docker compose up postgres redis backend prometheus grafana
```

This starts PostgreSQL, Redis, the backend API, Prometheus, and Grafana. The backend container enables `METRICS_ENABLED=true` and exposes `GET /metrics` on port `8080`; Prometheus scrapes `backend:8080/metrics`.

Prometheus: `http://localhost:9090`

Grafana: `http://localhost:3000`

For database/cache only, run `docker compose up postgres redis`.

The compose file does not run the simulated enclave service. Start `enclave` separately for attestation and proof-evaluation flows; override `ENCLAVE_URL` if the default `http://host.docker.internal:3002` is not correct for your Docker environment.

## Setup Notes

Component-specific setup remains in the local READMEs:

- `backend/README.md`
- `frontend/README.md`
- `enclave/README.md`
- `executor/README.md`

Those files are secondary setup references. For current architecture and thesis wording, use this document as the starting point and verify implementation claims against active code.

## Current Limitations

- The simulated enclave is not real hardware isolation.
- Real AWS Nitro Enclave deployment is not implemented.
- Independent frontend trust in the simulated attestation root requires `NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM`; without it, the expected root key is supplied through the backend response.
- Frontend order and DCA registration currently use `minOut = 0`; the order page's displayed slippage selection does not currently affect the committed minimum output.
- The registry reads the latest reported Chainlink-compatible answers, but its configured oracle-staleness checks are currently disabled for the testnet-oriented flow.
- Public executor tickets are not cryptographically bound to one executor.
- Backend leases are short coordination hints, not settlement authority.
- `GET /api/v1/executor/tickets` is backend-ready only; claim performs fresher simulation.
- Ticket execution can still fail after claim due to oracle movement, chain state changes, gas issues, or competing executors.
- DCA same-group coordination works only within one running backend/prover instance and is not shared across multiple replicas.
- DCA strict on-chain ordering is not implemented.
- Private-mempool or Flashbots Protect routing is not implemented; any UI label should be treated as non-functional until a real transaction path exists.
- Backend sync retry exists for the active page session, but full recovery after reload requires more product work.
- The CLI executor claims the next backend-selected ticket; the frontend executor supports claiming a selected commitment hash.
- Production anti-spam, rate limits, monitoring, key management, and deployment hardening are incomplete.

## Future Work

Future work only; do not describe these as current behavior:

- Real AWS Nitro Enclave adapter and attestation verification.
- Executor-specific ticket binding.
- Shared scheduler locks for multi-backend deployments.
- DCA `prevNullifier` circuit and registry enforcement for strict ordering.
- Private-mempool or Flashbots Protect transaction routing.
- Grid trading.
- Copy trading.
- Multi-chain production deployment.
- Production recovery flows for encrypted order-intent metadata backup and backend sync retries.
- Stronger API abuse controls, rate limits, and ownership proofs.
- Formal audits and production security hardening.

## Legacy Material

The old keeper/Shamir design, historical gas-reimbursement flow, implementation handoffs, reviews, and long design histories are archived under `docs/archive/`. They are historical background only and should not be read by default for current coding or thesis writing.
