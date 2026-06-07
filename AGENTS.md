# AGENTS.md
Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# Project: zstrategy

Bachelor thesis (IT4995, HUST). Privacy-preserving DeFi trading automation using ZK proofs and encrypted transaction submission. Renamed from ShadowBot.

**Always read the docs before touching code.** Start with `docs/overview.md` (current architecture, tech stack, execution flow), then `docs/DESIGN_NOTES.md` (current design decisions, SRS issues, implementation order), then `docs/tee-intent-architecture.md` (v2 TEE/private intent upgrade). These establish context that is not derivable from the code alone.

## What it does

Users define private execution intents (limit orders, market orders, DCA, grid, and future copy-trading actions) locally in the browser. A cryptographic commitment hash is posted on-chain. In the current implementation, a keeper executes via ZK proof. In the v2 target, a simulated TEE prover generates execution tickets from encrypted intent witnesses, and public executors submit valid proofs without learning private witness data.

## v2 terminology and migration target

Use `intent` as the consistent term for new/refactored code, docs, APIs, and UI. Legacy `strategy` names should remain only in historical docs or temporary compatibility code.

Migration names:
- `StrategyKind` → `IntentKind`
- `PendingStrategy` → `PendingIntent`
- `StrategyRepository` → `IntentRepository`
- `pending_strategies` → `pending_intents`
- `POST /api/v1/strategies` → `POST /api/v1/intents/order`
- `POST /api/v1/dca-strategies` → `POST /api/v1/intents/dca`
- "My Strategies" → "My Intents"
- "Strategy Builder" → "Intent Builder"

Do not add automatic DB data migration unless explicitly requested. The current v2 decision is to update the schema/code and let demo data be manually migrated or reset.

## Architecture (4 layers)

- **Frontend** — Next.js 15 (App Router). Client-side only. Generates commitments + ZK proofs in WASM (bb.js). Calls contracts directly via wagmi v2 + viem. Posts intent registration to Go backend (`backendApi.ts`), not keeper directly.
- **Smart contracts** — Arbitrum Sepolia. `CommitmentRegistry.sol` (register/execute/cancel), `CollateralVault.sol` (ERC20 collateral), `GasVault.sol` (prepaid ETH for keeper reimbursement), `OrderFillVerifier.sol` (auto-generated from Noir circuit), `UniswapV3Adapter.sol`.
- **Enclave** — TypeScript package in `enclave/`. v2 simulated Nitro-style prover boundary. Exposes `IntentProverEnclave`, simulated attestation, X25519 + AES-256-GCM witness package encryption, and a Noir/Barretenberg proof generator adapter. This is the v2 path; do not refactor keeper code for v2 unless explicitly needed.
- **Keeper** — Node.js 20+. **Trigger-based only — no ticker polling.** Serves `POST /api/shares` (store encrypted shares forwarded by Go backend) and `POST /api/execute` (triggered by Go backend when fill condition is met). On trigger: re-verifies condition independently, reconstructs `user_secret` via Shamir, generates ZK proof (bb.js/WASM), submits tx. Also serves `GET /api/keepers` for pubkeys used by frontend to encrypt shares.
- **Backend** — Go (Gin + GORM). Indexes chain events into PostgreSQL. Current implementation is an intent lifecycle orchestrator. v2 target is an intent relay/scheduler: accept `POST /api/v1/intents/order` and `POST /api/v1/intents/dca`, store public metadata plus encrypted witness material in `pending_intents`, and delegate private condition checks/proof generation to the simulated TEE prover. Redis for 30s stats cache. Prometheus metrics.

### Intent lifecycle (v2 target)

```
Frontend  →  POST /api/v1/intents/order or /api/v1/intents/dca  →  Go backend
                                                                    ↓ stores PendingIntent public metadata + encrypted witness
                                                                    ↓ schedules proof evaluation
                                                              Simulated TEE prover
                                                                    ↓ decrypts witness inside enclave boundary
                                                                    ↓ verifies condition privately
                                                                    ↓ generates ZK proof + execution ticket
                                                              Public executor
                                                                    ↓ executeCommitment → on-chain tx
```

Chain events (register / cancel / execute / expire) are watched by Go backend's chain indexer. On execute/cancel/expire, pending intent scheduling must stop or prune the encrypted witness package.

## ZK circuits

Two circuits in `circuits/` (Noir / Barretenberg / UltraHonk — **not** Groth16):

- **`order_fill`** — limit orders + market orders (MARKET uses a sentinel commitment price; same circuit). Private: `price`, `size`, `direction`, `nonce`, `user_secret`. Public: `commitment_hash`, `oracle_price`, `nullifier`. Verifier contract: `OrderFillVerifier.sol`.
- **`dca`** (Phase 4) — time-based DCA. Private: `scheduled_lo`, `scheduled_hi`, `nonce`, `user_secret`. Public: `commitment_hash`, `block_timestamp`, `nullifier`, `token_in`, `token_out`, `size`, `min_out`, `expiry`. Verifier contract: `DCAVerifier.sol` (generated from WSL after compile).

Commitment preimage (185 bytes, unified across circuit + contract + frontend):
```
keccak256(tokenIn(20) ‖ tokenOut(20) ‖ size(32) ‖ minOut(32) ‖ expiry(8) ‖ price(8) ‖ direction(1) ‖ nonce(32) ‖ user_secret(32))
```
Nullifier: `keccak256(user_secret ‖ nonce)` — single-use, prevents replay.

**Public inputs layout** — this is a cross-system invariant; keeper, contract, and circuit must all agree:
```
[0] commitment_hash   (Field / bytes32)
[1] fill_ref          (u64) — oracle pair price (dOut decimals) for ORDER_FILL, block.timestamp for DCA
[2] nullifier         (Field / bytes32)
[3] token_in          (Field / uint160 padded to 32 bytes)
[4] token_out         (Field / uint160 padded to 32 bytes)
[5] size              (Field / uint256)
[6] min_out           (Field / uint256)
[7] expiry            (u64)
```
Oracle pair price formula (in `_readOraclePrice`, mirrored in keeper `fetchPairPrice` and backend `fetchPairPrice`): `answerIn * 10^dOut / answerOut` — result has `dOut` decimal places (8 for standard Chainlink feeds). Both feeds are looked up from `CommitmentRegistry.priceFeeds(token)`. Private circuit input `price: u64` must use the same unit. `CHAINLINK_ETH_USD` env var is no longer used — oracle reads are driven by the registry's `priceFeeds` mapping.

## Key design decisions

- `user_secret` is **per-intent**: `keccak256(sign(wallet, intentId))` — wallet signature is the only persistent secret; secret is re-derivable, never stored.
- Keeper compensated via **prepaid ETH gas tank** (`GasVault.sol`) — Gelato 1Balance-style. User deposits native ETH; registry debits `gasUsed × tx.gasprice × 1.2` to keeper EOA at `executeCommitment`. Insufficient balance → revert; keeper preflights via `eth_call`. Self-execution skips the debit. Supersedes FR-KN-04's earlier "post-swap token fee" resolution — gas tank avoids circuit changes and keeper FX risk.
- Collateral check in Solidity `require()`, not circuit (no privacy benefit in circuit).
- `CollateralVault` uses OpenZeppelin virtual shares offset (`_decimalsOffset() = 3`) to prevent EIP-4626 inflation attacks.
- Encrypted intent backup (AES-GCM-256 + PBKDF2 → `.zstrategy` file) because intent params are browser-local only.
- `CommitmentRegistry` reads Chainlink at fill time — proof must be generated at fill time, not registration. Keeper (or user via self-execute) holds `user_secret` only during proof gen.
- **Path B1 (threshold keeper):** `user_secret` is Shamir-split (N=5, k=3) and ECIES-encrypted per keeper. Leader reconstructs at fill time. No single keeper has standing access. Any k of N shares suffice (Shamir is position-independent).
- **Phase 4 verifier dispatch:** `CommitmentKind` enum in registry (0 = ORDER_FILL, 1 = DCA); `executeCommitment` dispatches to the correct verifier. Clean separation — no circuit flag pollution.
- **v2 private witness handling:** `limitPrice`, `direction`, `scheduledLo/Hi`, `nonce`, `nullifier`, and `user_secret` are intent witness data. Phase A may still use the current B1 plaintext fields while routes/names migrate to `pending_intents`; Phase C must remove plaintext witness storage, keep only public metadata plus encrypted witness material, and route decryption/proving through the simulated TEE interface.
- **Keeper re-verification:** Keeper independently re-verifies the fill condition on `POST /api/execute` before reconstructing secret or generating proof. This preserves the B1 security model even though Go triggers first.

## Common commands

| Layer | Build | Test | Run |
|---|---|---|---|
| contracts | `cd contracts && npx hardhat compile` | `npx hardhat test` | `npx hardhat node` |
| contracts | — | `npx hardhat test --grep "CommitmentRegistry"` | `npx hardhat run scripts/deploy.ts --network <name>` |
| circuits | `cd circuits/order_fill && nargo compile` | `nargo test` | — |
| enclave | `cd enclave && npm run build` | `npm test` | — |
| keeper | `cd keeper && npm run build` | `npm test` | `npm run dev` |
| frontend | `cd frontend && npm run build` | — | `npm run dev` |
| backend | `cd backend && go build ./...` | `go test ./...` | `go run cmd/server/main.go` |

**Circuit artifacts require WSL.** `nargo compile` and `bb write_vk / bb write_solidity` must be run in a Linux shell. After compiling `dca` circuit:
```
bb write_vk --oracle_hash keccak -b circuits/dca/target/dca.json -o contracts/contracts/core/
bb write_solidity --oracle_hash keccak -b circuits/dca/target/dca.json -o contracts/contracts/core/DCAVerifier.sol
```

**After `bb write_solidity` — manual rename required.** bb names the generated contract `HonkVerifier` in every file. Hardhat's artifact lookup is by contract name, so two files both declaring `HonkVerifier` produce ambiguous artifacts and the deploy script can't address them distinctly. Open the generated file and rename the *final* `contract HonkVerifier is BaseZKHonkVerifier(...)` declaration to match the file: `OrderFillVerifier` for the ORDER_FILL verifier, `DCAVerifier` for the DCA verifier. Leave `BaseZKHonkVerifier` and `HonkVerificationKey` (different identifiers, different scopes) untouched. The header comment in each file calls this out.

The bb output also externalises one library — `ZKTranscriptLib` — that must be deployed and linked per-verifier. `contracts/scripts/deploy.ts` already does this via `getContractFactory("contracts/core/<File>.sol:ZKTranscriptLib")` and the `libraries: { ZKTranscriptLib: ... }` option; if you add a third verifier, copy that pattern.

Frontend `predev`/`prebuild` runs `scripts/copy-circuit.mjs` which copies `circuits/order_fill/target/order_fill.json` → `frontend/public/circuits/order_fill.json`.

## Implementation status

| Phase | Scope | Status |
|---|---|---|
| 1 | Smart contracts + ZK circuit | ✅ Complete |
| 2 | Limit orders E2E (keeper + frontend + backend) | ✅ Complete (real UltraHonk; bb.js in keeper + browser; encrypted backup; Path B1 single-process simulation) |
| 3 | Market Order | ✅ Complete — frontend-only kind discriminator; reuses OrderFill circuit with sentinel limit price (supersedes earlier SL/TP work, which has been removed) |
| 4 | Private DCA | ✅ Complete — DCA circuit compiled, registry dispatch, DCA form, backend wall-clock monitor, keeper DCA proof gen |
| v2 | Private Intent + Simulated TEE refactor | 🔲 In progress — Phase A intent naming/routes/schema started; Phase B `/enclave` boundary started with simulated attestation, encrypted witness packages, and proof adapter; next phases wire backend relay/scheduler and ticket-based public execution |
| 5 | Grid Trading | 🔲 Planned |
| 6 | Multi-chain (Base Sepolia) | 🔲 Planned |

### Phase 3 — Market Order ✅

Frontend-only `kind` discriminator alongside `LIMIT`. **No circuit, no contract, no keeper changes.** Mechanics:

- Current code has `IntentKind = "LIMIT" | "MARKET"` in `frontend/src/lib/intentStore.ts` (SL/TP removed).
- Commitment uses a sentinel price that trivially satisfies the OrderFill fill check:
  - BUY  → `price = u64.max` → `oracle ≤ price` always true
  - SELL → `price = 0`       → `oracle ≥ price` always true
- On-chain the commitment is still registered as `kind = 0 (ORDER_FILL)`; the contract's `_readOraclePrice` and keeper's oracle re-verify both trivially pass.
- Current backend has `PendingIntent.Kind = "MARKET"` in `domain/entity.go`.
- User-controlled slippage selector (0.5% / 1% / 2% / 5%, default 1%) applies to both LIMIT and MARKET `minOut`. Live Chainlink "quote per base" price is fetched client-side for MARKET to compute the est-output + minOut.
- MARKET orders use a fixed 10-minute expiry so an unfilled market order doesn't linger.

### Transaction UX — Sonner toasts ✅

Every wagmi write hook in `frontend/src/hooks/` wires `useTxToast` (`hooks/useTxToast.ts`) which surfaces three toast states per tx: submitted → confirming → success/failure. Success toasts include a "View on Arbiscan/Basescan ↗" action that opens the explorer URL from `lib/explorerUrl.ts`. The `<Toaster />` is mounted once in `app/layout.tsx`.

### Observability — Prometheus + Grafana ✅

- Backend metrics module: `backend/internal/infrastructure/metrics/metrics.go` defines counters/histograms wired into `service/indexer.go` and `service/monitor.go` (executions, pending gauge, monitor eval duration, keeper trigger outcome). Exposed at `GET /metrics` via the existing `router.go` Prometheus handler.
- Keeper metrics module: `keeper/src/metrics.ts` defines counters/histograms for executions, proof-gen time per circuit, Shamir reconstruction time, and HTTP requests. Wired in `keeper/src/api/server.ts` (middleware + `/metrics` route) and `keeper/src/execution/submitter.ts` (proof timer).
- Prometheus scrape config: `infra/prometheus/prometheus.yml` (jobs: `zstrategy-backend`, `zstrategy-keeper`).
- Grafana provisioning + starter dashboard: `infra/grafana/provisioning/{datasources,dashboards}/` + `infra/grafana/dashboards/zstrategy.json`. 8 panels covering live pending count, register/execute counters, terminal-event rate by kind+status, keeper trigger outcomes, proof-gen p95 by circuit, monitor eval p95 by kind.
- Compose: `docker compose up prometheus grafana` brings the stack up at `localhost:9090` / `localhost:3000` (admin / admin).

### Phase 4 — Private DCA ✅

- **Circuit** (`circuits/dca/`): 192-byte preimage, time fill `scheduled_lo <= block_timestamp <= scheduled_hi`, 9 tests. Compiled artifact at `circuits/dca/target/dca.json`. Run `bb write_solidity` in WSL to regenerate `DCAVerifier.sol`.
- **Registry** (`CommitmentRegistry.sol`): `CommitmentKind` enum (ORDER_FILL=0, DCA=1), `mapping(uint8 => IVerifier) verifiers`, `setVerifier()`, `registerCommitmentBatch`, dispatch in `executeCommitment`.
- **Deploy** (`contracts/scripts/deploy.ts`): deploys `DCAVerifier`, calls `registry.setVerifier(1, dcaVerifier)`.
- **Frontend** (`frontend/src/app/(dashboard)/dca/page.tsx`): full DCA form — pair, side, size/round, interval, jitter preview, batch registration, IndexedDB save with `dcaGroupId`.
- **Keeper** (`keeper/src/zk/dca.ts`, `keeper/src/api/server.ts`): inline time-window re-verify in `/api/execute`, DCA proof generation in `submitter.ts` (dispatches on `order.kind`).
- **Backend**: current code has `ExecutionRecord.Kind` (`domain/entity.go`), indexer decodes `kind` from `CommitmentRegistered` event, `GetStatistics` returns per-kind breakdown, `List` accepts `?kind=DCA` filter, and `PendingIntent` + `pending_intents`. v2 intent routes are `POST /api/v1/intents/order` and `POST /api/v1/intents/dca`.

DCA jitter: `scheduled_lo = center − 0.15×interval`, `scheduled_hi = center + 0.15×interval`. Single wallet signature per DCA group; each round gets its own `nonce`.

## Phase 2 cosmetic gaps (deferred, non-blocking)

- Arbitrum Sepolia E2E run: explicitly deferred.

## Repo layout

```
frontend/    # Next.js 15 — app/, components/, hooks/, lib/, providers/
backend/     # Go — cmd/server/, internal/{domain,service,repository,indexer,handler}
contracts/   # Hardhat — core/, adapters/, interfaces/, scripts/deploy.ts
keeper/      # Node.js keeper service — api/, chain/, zk/, threshold/, store/, execution/
enclave/     # TypeScript simulated Nitro-style v2 prover boundary
circuits/    # Noir ZK circuits — order_fill/ (complete), dca/ (Phase 4)
docs/        # overview.md, DESIGN_NOTES.md
```
