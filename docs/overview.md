# zstrategy — Privacy-Preserving DeFi Trading Automation

> Bachelor thesis project — IT4995, HUST.
> A decentralized, privacy-first trading automation platform using zero-knowledge proofs and encrypted transaction submission.

---

## Problem Statement

Automated on-chain trading is fundamentally broken from a privacy standpoint:

- **MEV and frontrunning**: Limit orders and DCA schedules posted on-chain are publicly visible, making them trivial to frontrun or sandwich attack.
- **Strategy leakage**: Any bot executing repeatable patterns (e.g., DCA every Monday, grid levels at round numbers) can be identified and exploited by sophisticated observers.
- **Copycat trading**: Successful on-chain strategies are immediately visible and cloned by other participants, eroding their alpha.
- **No privacy layer for automation**: Existing tools like Gelato, 1inch Fusion, or dYdX conditional orders offer automation but zero confidentiality.

---

## Solution

zstrategy combines **zero-knowledge proofs (ZKPs)**, **encrypted transaction submission via Flashbots Protect**, and a **commitment-based execution model** to allow users to define and run trading strategies that remain fully confidential until — and sometimes after — execution.

The core insight: instead of posting order parameters on-chain, the user posts a cryptographic commitment hash. A keeper monitors oracle prices and executes only when conditions are met, using a ZK proof to authorize the DEX swap — without ever knowing the strategy parameters.

---

## Core Strategy Types

Naming convention: `StrategyKind` is user-facing and uses `LIMIT`, `MARKET`,
and `DCA`. `ORDER_FILL` is not a strategy; it is the shared circuit/verifier
kind used on-chain and on the keeper wire for both LIMIT and MARKET.

### 1. Private Limit Orders

A standard limit order reveals price and size on submission. zstrategy uses a commitment scheme:

```
commitment = keccak256(tokenIn ‖ tokenOut ‖ size ‖ minOut ‖ expiry ‖ nonce ‖ user_secret)
nullifier  = keccak256(user_secret ‖ nonce)
```

The commitment hash is posted on-chain via `CommitmentRegistry.registerCommitment()`. At execution time, the keeper submits a ZK proof that certifies the fill condition was met — never the raw order parameters.

### 2. Private DCA (Dollar-Cost Averaging)

Users define a DCA schedule (amount, interval, token pair) locally. zstrategy generates a series of time-locked commitments:

- Each DCA round produces one independent commitment with a scheduled execution window
- ±15% random jitter is applied per round to obscure the DCA frequency
- All round commitments are batch-registered in a single transaction via `registerCommitmentBatch()`
- The Go backend's `MonitorService` checks wall-clock against each round's window and triggers the keeper when it opens

Only a ZK proof that the time condition was met is published at execution — not the amount, token, or schedule.

### 3. Private Grid Trading (Decomposed Commitments)

Grid orders are decomposed into N independent limit order commitments:

- User defines: lower/upper price bounds, number of grid levels, size per level
- System generates N buy commitments (below mid-price) + N sell commitments (above mid-price)
- Each is a standard limit order — the `OrderFill` circuit is reused entirely
- The grid structure is never posted on-chain; an observer sees N independent executions

### 4. Private Market Orders

Market orders use the same commitment + OrderFill circuit as limit orders, with a sentinel `price` that makes the fill check trivially pass:

- BUY  → `price = u64.max` → `oracle_price <= price` is always true
- SELL → `price = 0`       → `oracle_price >= price` is always true

The backend's `MonitorService` recognises `kind = "MARKET"` and fires the keeper trigger on the first goroutine tick (no Chainlink polling). The contract still sees `kind = 0 (ORDER_FILL)`; from on-chain observers' perspective a market order is indistinguishable from a fast-filling limit order. Privacy is identical to LIMIT — `size`, `tokenIn`, `tokenOut`, and `direction-from-token-flow` are revealed, the sentinel `price` lives in the commitment.

Note: stop-loss / take-profit variants were previously implemented as separate `StrategyKind`s but have been removed; if needed later they can be added back as another frontend-only kind without circuit changes.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         User's Browser                           │
│                                                                  │
│   Strategy Builder UI (Next.js 15)                               │
│   ├── Wallet connection (wagmi v2 + injected/WalletConnect)      │
│   ├── Commitment hash generation (viem keccak256, client-side)   │
│   ├── ZK proof generation (Barretenberg WASM — bb.js)            │
│   └── Contract calls (registerCommitment, deposit, withdraw)     │
└──────────────────────────┬───────────────────────────────────────┘
                           │  on-chain tx (Flashbots Protect RPC)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Arbitrum Sepolia (EVM)                        │
│                                                                  │
│   CommitmentRegistry.sol                                         │
│   ├── registerCommitment(hash, tokenIn, tokenOut, size, ...)     │
│   ├── executeCommitment(hash, nullifier, proof, fillRef) │
│   ├── cancelCommitment(hash, nullifier)                          │
│   ├── sweepExpired(hashes[])                                     │
│   └── Emergency pause (guardian-controlled)                      │
│                                                                  │
│   CollateralVault.sol                                            │
│   ├── deposit(token, amount)  / withdraw(token, amount)          │
│   ├── lockCollateral / releaseForExecution / returnCollateral     │
│   └── freeBalance / lockedBalance (view)                         │
│                                                                  │
│   GasVault.sol  (prepaid keeper-gas reimbursement)               │
│   ├── deposit / withdraw (native ETH; pooled per user)           │
│   └── debit (registry-only; called inside executeCommitment)     │
│                                                                  │
│   OrderFillVerifier.sol  (auto-generated from Noir circuit via bb)│
│   UniswapV3Adapter.sol                                           │
└──────────────────────────┬───────────────────────────────────────┘
                           │  event subscription (WebSocket / HTTP poll)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              Go Backend — Strategy Orchestrator + Analytics      │
│                                                                  │
│   ├── Chain indexer: subscribes to Registry events               │
│   │   └── Fallback: HTTP poll every 15s if WebSocket unavailable │
│   ├── Strategy lifecycle:                                        │
│   │   ├── POST /api/v1/strategies — stores PendingStrategy       │
│   │   ├── POST /api/v1/dca-strategies — stores DCA rounds        │
│   │   └── MonitorService — one goroutine per pending strategy    │
│   │       ├── ORDER_FILL: derives pair price from two Chainlink   │
│   │       │   USD feeds via registry.priceFeeds(), polls 30s     │
│   │       ├── DCA: checks wall-clock vs scheduledLo/Hi           │
│   │       └── On condition met → POST /api/execute → Keeper      │
│   ├── PostgreSQL: execution records + pending_strategies         │
│   ├── Redis: stats cache (30s TTL)                               │
│   └── REST API                                                   │
│       ├── GET /api/v1/stats?chain_id=421614                      │
│       ├── GET /api/v1/executions?chain_id=...&kind=...&limit=... │
│       ├── GET /api/v1/keeper/health                              │
│       └── GET /metrics  (Prometheus)                             │
└──────────────────────────┬───────────────────────────────────────┘
                           │  POST /api/execute  (trigger)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              Keeper — Trigger-Based Executor (Node.js)           │
│                                                                  │
│   No polling. No event watching. Trigger-only.                   │
│                                                                  │
│   POST /api/shares: stores encrypted Shamir share                │
│                                                                  │
│   POST /api/execute (triggered by Go backend when fill met):     │
│     1. Re-verify fill condition independently (Chainlink / clock) │
│     2. Reconstruct user_secret: collect k=3 Shamir shares,       │
│        Lagrange-interpolate in GF(256)                           │
│     3. Generate ZK proof at fill time (bb.js / WASM)             │
│     4. Call executeCommitment(hash, nullifier, proof, fillRef) on-chain │
│     5. Return 202 immediately; execution is async                │
│                                                                  │
│   GET /api/keepers: publish N secp256k1 pubkeys for ECIES        │
│                                                                  │
│   No single keeper has standing access to any user_secret.       │
│   Compromise < k keepers: zero leak.                             │
└──────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js 15** (App Router) | Client-side only — no server actions; all data from Go backend |
| Styling | **Tailwind CSS v4** | Sovereign Void design system (dark obsidian theme) |
| Wallet | **wagmi v2** + **viem** | Injected (MetaMask) + WalletConnect connectors |
| ZK Language | **Noir** | Native Keccak gadget — ~60% fewer constraints vs Circom |
| ZK Proof System | **UltraPlonk** (Barretenberg) | Universal trusted setup — no per-circuit ceremony |
| Smart Contracts | **Solidity 0.8.x** | OpenZeppelin base contracts |
| Contract Dev | **Hardhat** | TypeScript config, Arbitrum Sepolia deployment |
| Backend | **Go** (Gin + GORM) | Strategy lifecycle orchestrator: stores private params, runs per-commitment goroutines, triggers keeper. Also indexes events + statistics API. |
| Database | **PostgreSQL** + `golang-migrate` | `execution_records` + `pending_strategies` tables |
| Cache | **Redis** | Stats cache (30s TTL) |
| Metrics | **Prometheus** | Exposed via `/metrics` on the Go server |
| Keeper | **Node.js 20+** | Trigger-based only — no polling. Serves `POST /api/shares` + `POST /api/execute`. |
| Private Mempool | **Flashbots Protect** | MEV protection for execution transactions |
| DEX | **Uniswap v3** | `UniswapV3Adapter.sol` + mock adapter for local tests |
| Oracle | **Chainlink** | Go backend and keeper both read `priceFeeds[tokenIn]` and `priceFeeds[tokenOut]` from the registry, derive pair price as `answerIn * 10^dOut / answerOut` (same formula as `_readOraclePrice`). Backend polls every 30 s; keeper re-verifies on trigger before proof generation. |
| Target Chain | **Arbitrum Sepolia** | Primary testnet; Base Sepolia is planned (Phase 6) |
| Containerization | **Docker Compose** | postgres, redis, backend, keeper services |

---

## Gas Economics

Keepers are reimbursed via a **prepaid ETH gas tank** (`GasVault.sol`), not by deducting a fee from swap output. At registration time the user — separately from locking ERC-20 collateral — deposits native ETH into `GasVault`. The pool is per-user (not per-strategy), so one top-up funds any number of limit orders, DCA rounds, or future grid levels.

Inside `executeCommitment`, the registry measures `gasleft()` at entry, runs the verification + swap, then debits the owner's gas-tank balance by `gasUsed × tx.gasprice × KEEPER_PREMIUM_BPS / 10000` (currently 120% — a flat 20% margin above raw cost) and forwards the ETH to `msg.sender`. Insufficient balance reverts the whole call, leaving the commitment PENDING; the keeper does an `eth_call` preflight before paying real gas, so a depleted tank never burns keeper ETH. Self-execution (`msg.sender == owner`) skips the debit — refunding ETH to oneself is a no-op.

This design matches Gelato 1Balance / AA-paymaster patterns: the keeper is paid directly in the asset it spends, no FX risk, no circuit changes (the preimage has no `fee` field). It supersedes the earlier FR-KN-04 "post-swap token fee" resolution. See `docs/DESIGN_NOTES.md` §C for the full rationale.

## Privacy Guarantees

The privacy boundary is narrower than an idealised "everything private" reading. The thesis claim is that **the limit price (and direction-vs-mid) are private** — these are exactly the values an MEV searcher or copycat would exploit on a public-mempool order book.

| Truly private (sealed in commitment, never on-chain or in backend) | Public from registration alone | Revealed at settlement |
|---|---|---|
| `price` (limit / trigger price) | `owner` (registering wallet) | The fact a trade executed |
| `direction` (BUY/SELL relative to mid) | `tokenIn`, `tokenOut` | `nullifier` (one-shot) |
| `nonce` | `size` (collateral locked) | Live `oracle_price` at fill |
| `user_secret` | `minOut` (lower-bounds the limit) | `amountOut` |
| `strategyId` (wallet-derived) | `expiry` | Block timestamp |

**Caveat about `size` + `minOut`:** an analyst can compute an upper bound on the limit price from `minOut / size` (allowing for slippage). The limit price is private; a tight *bound* is not. For DCA and grid strategies, randomised sizing with the same overall outcome can widen this bound; this is FR work for Phase 4–5.

**Trust model for proving material.** `user_secret` is generated client-side from the user's wallet signature. At fill time, the keeper network needs *some* way to use it — see the threshold-keeper design below. **No single keeper has standing access to any user's secret**; reconstruction requires k of N keepers cooperating per-execution and is logged on-chain for audit.

---

## ZK Proof Design

**Circuit:** `OrderFill` (Noir), compiled with Barretenberg (UltraPlonk)

| Input type | Field | Description |
|---|---|---|
| Private | `price` | Limit / trigger price |
| Private | `size` | Order size |
| Private | `direction` | Buy or sell |
| Private | `nonce` | Per-strategy random nonce |
| Private | `user_secret` | Per-strategy secret |
| Public | `commitment_hash` | `keccak256(tokenIn ‖ tokenOut ‖ size ‖ minOut ‖ expiry ‖ nonce ‖ user_secret)` |
| Public | `oracle_price` | Chainlink price at execution time |
| Public | `nullifier` | `keccak256(user_secret ‖ nonce)` — prevents double-spend |

**Constraints:**
1. Commitment preimage check: `hash(inputs) == commitment_hash`
2. Fill condition: `oracle_price` satisfies the order direction + limit
3. Nullifier derivation: `keccak256(user_secret, nonce) == nullifier`

**Verifier:** `OrderFillVerifier.sol` — auto-generated via `bb write_vk` + `bb write_solidity --oracle_hash keccak`

---

## Execution Flow

```
1.  User enters strategy parameters in the browser (token pair, amount, target price, expiry)
2.  Browser generates random nonce; derives user_secret = keccak256(sign(wallet, strategyId))
3.  Browser computes commitment_hash = keccak256(tokenIn ‖ tokenOut ‖ size ‖ minOut ‖ expiry ‖ price ‖ direction ‖ nonce ‖ user_secret)
4.  Browser computes nullifier = keccak256(user_secret ‖ nonce)
5.  Browser Shamir-splits user_secret (N=5, k=3) + ECIES-encrypts each share to a keeper pubkey
6.  User calls CollateralVault.deposit() to lock collateral (ERC20 approve → deposit)
7.  User calls CommitmentRegistry.registerCommitment(hash, tokenIn, tokenOut, size, minOut, expiry, kind)
8.  Browser POSTs to Go backend (POST /api/v1/strategies) with private params + encrypted shares
9.  Go backend stores PendingStrategy (including limitPrice, direction, scheduledLo/Hi),
    forwards encrypted shares to keeper (POST /api/shares), spawns fill-condition goroutine
10. Go backend goroutine evaluates fill condition every 30s:
    - ORDER_FILL: reads priceFeeds[tokenIn] and priceFeeds[tokenOut] from the registry,
      derives pair price = answerIn * 10^dOut / answerOut; fills when condition satisfied
    - DCA: checks wall-clock — when now ∈ [scheduledLo, scheduledHi]
11. Fill condition met → Go backend marks EXECUTING, POSTs trigger to keeper (POST /api/execute)
12. Keeper re-verifies condition independently, reconstructs user_secret (Shamir k=3),
    generates ZK proof (bb.js/WASM), calls executeCommitment(hash, nullifier, proof, fillRef) via Flashbots Protect
13. CommitmentRegistry._readOraclePrice derives pair price from two Chainlink USD feeds
    (ORDER_FILL) or freshness-checks the keeper-proven execution timestamp (DCA), verifies ZK proof via OrderFillVerifier.sol / DCAVerifier.sol
14. Vault releases collateral → UniswapV3Adapter executes the swap
15. amountOut credited back to the user's vault free balance
16. Go backend indexer detects CommitmentExecuted event → updates execution record in PostgreSQL;
    MonitorService.StopMonitoring(hash) terminates the goroutine
17. Frontend dashboard reflects the new status via GET /api/v1/executions
```

---

## Repo Structure

```
zstrategy/
├── frontend/               # Next.js 15 frontend (Sovereign Void UI)
│   └── src/
│       ├── app/            # App Router pages (dashboard, strategy, vault, zk, dca, activity, settings)
│       ├── components/     # UI components + wallet (ConnectModal, VaultPanel)
│       ├── hooks/          # useVault, useRegistry, useBackendApi
│       ├── lib/            # wagmi config, contract ABIs/addresses, API client
│       └── providers/      # Web3Provider (WagmiProvider + QueryClientProvider)
├── backend/                # Go analytics server (Clean Architecture)
│   ├── cmd/server/         # Entry point + graceful shutdown
│   ├── config/             # Env-based config (godotenv)
│   └── internal/
│       ├── domain/         # Entities, interfaces, errors (zero external deps)
│       ├── service/        # IndexerService, StatsService (Redis-cached)
│       ├── repository/     # GORM PostgreSQL implementation
│       ├── infrastructure/ # DB init + embedded SQL migrations
│       ├── indexer/        # go-ethereum event watcher (WS + HTTP poll fallback)
│       └── handler/http/   # Gin router, handlers, CORS, Prometheus
├── contracts/              # Hardhat + Solidity
│   ├── core/               # CommitmentRegistry.sol, CollateralVault.sol
│   ├── adapters/           # UniswapV3Adapter.sol, MockDEXAdapter.sol
│   └── interfaces/         # IDEXAdapter.sol, IVerifier.sol
├── keeper/                 # Node.js keeper service
├── circuits/               # Noir ZK circuits (OrderFill)
├── docs/                   # Architecture docs and design notes
└── docker-compose.yml      # postgres, redis, backend, keeper
```

---

## Security Model

| Threat | Mitigation |
|---|---|
| Mempool observation / frontrunning | Flashbots Protect RPC for all execution transactions |
| Strategy inference from commitment | `keccak256` preimage is computationally infeasible to recover |
| Double-spend / replay | Nullifier mapping in `CommitmentRegistry` — each nullifier spent once |
| Unauthorized execution | ZK proof required — keeper cannot execute without valid proof |
| Keeper offline | User can self-execute directly from the browser UI |
| Emergency halt | Guardian-controlled pause / unpause on `CommitmentRegistry` |
| EIP-4626 inflation attack | Virtual shares offset pattern (OpenZeppelin) |

---

## Implementation Status

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | Smart contracts + ZK circuit | ✅ Complete |
| 2 — Limit Orders E2E | Keeper + Frontend + Go backend | ✅ Complete (real UltraHonk verifier; bb.js wired in keeper + browser self-execute; encrypted `.zstrategy` backup). Arb Sepolia E2E run still pending. See *Phase 2 cosmetic gaps* below. |
| **B1 — Threshold keeper (Path B)** | Shamir + ECIES + leader rotation; reconstruction audit | ✅ Single-process simulation complete; multi-process / Sybil-resistance is future hardening |
| 3 — Market Order | Frontend-only kind discriminator (sentinel price); backend MonitorService triggers keeper immediately for MARKET; no circuit/contract/keeper changes. Supersedes the earlier SL/TP work (now removed). | ✅ Complete |
| 4 — Private DCA | DCA circuit + registry dispatch + frontend form + backend goroutines | ✅ Complete |
| **Arch — Keeper refactor** | Fill-condition monitoring moved to Go goroutines; keeper is trigger-based | ✅ Complete (2026-05-08) |
| 5 — Grid Trading | Decomposed batch limit commitments | 🔲 Planned |
| 6 — Multi-Chain | Base Sepolia deployment + chain switcher | 🔲 Planned |
| Future Work | B2 collaborative SNARKs · B3 TEE · D Fhenix CoFHE | 📚 Documented in `DESIGN_NOTES.md` |

### Phase 2 cosmetic gaps (deferred — non-blocking)

- **Arbitrum Sepolia E2E.** Explicitly deferred by user; remaining functional verification gap.
