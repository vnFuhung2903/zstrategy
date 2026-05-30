# zstrategy — Design Notes

> Renamed from ShadowBot. Bachelor thesis project — IT4995, HUST.
> Privacy-preserving DeFi trading automation using ZK proofs and encrypted mempools.

---

## Architecture Decisions

### Mental Model: Trust Zones (not Layers)
Don't think in layered architecture — think in **trust zones**:

```
Untrusted                     Trustless                  Settlement
(UI, Keeper, Oracle)  →  (ZK proof + on-chain verifier)  →  (DEX)
```

- The **smart contracts are the trust root**. Everything else must prove claims to them.
- The **client is sovereign for cancellation and self-execute** — wallet signature is the only persistent secret material; `user_secret` is re-derivable.
- Keeper, UI, and oracle are all untrusted actors from the contract's perspective.

### Trust Model: Path B1 — Threshold Keeper (chosen 2026-05-02)

The decision that shapes everything: **what holds the proving material at fill time, given the contract reads Chainlink itself?**

Once the on-chain verifier reads the live oracle price (P0-1 fix), the proof must be generated *at fill time*, not registration. *Someone* holding `user_secret` must be online and react to price events. Four coherent designs, with the rejected alternatives documented as Future Work / alternatives:

| Path | Who holds proving material | Privacy from keeper(s) | Status |
|---|---|---|---|
| **Self-execute** | User in browser | Total | Rejected — automation is the product |
| **Single trusted keeper** | One operator | None | Rejected — privacy theater |
| **B1. Threshold keeper (Shamir)** | k of N keepers cooperate | Strong (corrupt < k = zero leak) | **Current thesis path** |
| **B2. Collaborative SNARKs** | N keepers run MPC over proving | Total even at execution | Future Work |
| **B3. TEE-assisted** | Reconstruct inside attested enclave | Total within hardware vendor trust | Alternative architecture, not implemented |
| **D. Full FHE (Fhenix CoFHE)** | Encrypted operations on chain | Total within decryption committee trust | Future Work |

#### B1 specifics — what we're building

**Mechanism.** At registration, the frontend splits `user_secret` via **Shamir secret sharing** over `GF(256)` (byte-wise) into `N=5` shares with reconstruction threshold `k=3`. Each share is encrypted (ECIES on secp256k1) to one of N pre-published keeper public keys, then POSTed to the keeper coordinator. Each keeper stores only its own encrypted share at rest.

**Fill-time protocol (current thesis implementation — single-process simulation).**
1. Go backend's `MonitorService` runs one goroutine per pending strategy. Each goroutine holds the private params (`limitPrice`, `direction`, `scheduledLo/Hi`) stored in PostgreSQL's `pending_strategies` table.
2. Go backend evaluates the fill condition:
   - ORDER_FILL: derives pair price every 30s by calling `priceFeeds(tokenIn)` and `priceFeeds(tokenOut)` on the registry, then fetching `latestRoundData()` and `decimals()` from each Chainlink feed and computing `priceU = answerIn * 10^dOut / answerOut` — the same formula as `CommitmentRegistry._readOraclePrice`. Fill when `priceU ≤ limitPrice` (BUY) or `priceU ≥ limitPrice` (SELL).
   - DCA: checks `scheduledLo ≤ now ≤ scheduledHi` on each tick.
3. When condition is met, Go backend marks status `EXECUTING` and fires `POST /api/execute` to keeper with full context (commitment hash, kind, token params, limitPrice, direction, nonce, nullifier, scheduledLo/Hi).
4. Keeper **re-verifies the fill condition independently** (same two-feed pair price derivation for ORDER_FILL, or wall-clock for DCA). This preserves the B1 security model: a peer keeper releases its share only after confirming the condition is genuine.
5. Keeper reconstructs `user_secret` from its stored Shamir shares (Lagrange interpolation in GF(256) over N=5 shares, k=3 threshold).
6. Keeper generates the UltraHonk proof (bb.js WASM) using all preimage values, calls `executeCommitment(commitmentHash, nullifier, proof)` on-chain, immediately wipes reconstructed material from memory.

**Why fill-condition monitoring moved to Go.** The keeper's Node.js ticker loop was a polling concern, not a cryptographic one. Moving it to Go goroutines gives: better lifecycle management (start/stop per commitment), clean integration with the chain indexer (terminal events stop goroutines), and re-hydration on restart via `RehydrateFromDB()`. The keeper retains all cryptographic responsibilities: Shamir reconstruction, ZK proof generation, on-chain tx submission.

**Honest security claim.** *No single keeper has standing access to user secrets. Reconstruction is a k-of-N event, audit-logged, time-bounded to one execution. An attacker must corrupt k independent keeper operators within the execution window (typically < 1 minute) to extract one user's secret; even then, only that user's secret leaks, not the system.*

**What B1 does not claim.**
- Not keeper-blind during execution. The leader briefly holds plaintext `user_secret` to generate the proof. Mitigation: leader rotates per-commitment; reconstructions are public.
- Not Sybil-resistant by default. Need stake + slashing (Phase B1-C) or governance-vetted keeper set to prevent attackers from running ⌈k⌉ keepers themselves.
- Not protected against longitudinal correlation: if the same keeper set processes thousands of strategies for one wallet, they build a behavioural profile from public on-chain fields alone (sizes, timing, pairs). This is a separate problem from secret protection.

#### B2 — Collaborative SNARKs (Future Work)

Generalises B1 to never reconstruct the secret on any node. Keepers run a multi-party computation that produces the UltraPlonk proof directly from their shares. Reference: Ozdemir & Boneh, *Experimenting with Collaborative zk-SNARKs* (USENIX Security 2022).

Why deferred: ~100× proving slowdown vs single-prover; no production-ready library targeting Barretenberg/UltraPlonk; requires careful protocol design for malicious-secure MPC. Would extend the timeline by 6+ months and introduce primitives outside undergraduate scope.

#### B3 — TEE-assisted reconstruction (alternative architecture)

Each keeper holds a Shamir share as in B1, but reconstruction happens inside a remote-attested Trusted Execution Environment (Intel SGX, AWS Nitro Enclave, AMD SEV-SNP). The enclave proves it's running specific audited code; the secret never leaves enclave memory.

Why not chosen: shifts the trust assumption to chip vendors (Intel/AMD) and cloud operators (AWS) rather than eliminating it. Operationally heavier — attestation flow, enclave provisioning, vendor-specific code paths. Worth documenting because it gives B1-equivalent privacy with single-party simplicity if you accept hardware trust; can be added later as an opt-in for keepers that want stronger isolation.

#### Path D — Full FHE pivot (rejected for thesis)

Encrypt `(limit_price, direction)` to a Fhenix FHE pubkey at registration. Keeper triggers encrypted comparisons on-chain via Fhenix CoFHE (live on Arbitrum mainnet 2026). Threshold decryption committee returns the boolean; on-chain swap proceeds. Most of the ZK circuit is replaced.

Why rejected: this is a Phase 1 restart, not a Phase 2 enhancement. ~70% code rewrite. Fhenix tooling is live but ecosystem is thin. Realistic 4–6 month timeline conflicts with thesis defense. Genuinely the right design for a production system; documented as a Master's / publication continuation.

### Design Patterns Applied

| Pattern | Where | Why |
|---|---|---|
| **Strategy Pattern** | Go backend — `MonitorService` fill condition evaluation | `isFillConditionMet` dispatches on `kind`: Chainlink price check for ORDER_FILL, wall-clock check for DCA. Keeper no longer contains this logic. |
| **Adapter Pattern** | DEX integration in vault | `IDEXAdapter` interface → `UniswapV3Adapter`, `OneInchAdapter`. Core contracts never change when swapping DEXes. |
| **Observer Pattern** | Go backend — chain indexer | Subscribes to `CommitmentRegistered/Executed/Cancelled/Expired` events. `MonitorService.StopMonitoring` called on terminal events — no race with goroutines. |
| **Emergency Pause** | `CommitmentRegistry.sol` | Manual `paused` state controlled by the guardian. The earlier volume-baseline breaker was removed as unused implementation surface. |

---

## Technology Stack (Decided)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js** | SPA + SSR capable; Strategy Builder UI lives here |
| Wallet | MetaMask + WalletConnect v2 | — |
| ZK Language | **Noir** | Resolved: better DX, native Keccak gadget (~60% fewer constraints), universal setup via Barretenberg — see Resolved Decisions |
| ZK Proof System | **UltraPlonk** (Barretenberg) | Resolved: replaces Groth16; universal trusted setup, no per-circuit ceremony — see Resolved Decisions |
| Smart Contracts | Solidity 0.8.x | — |
| Contract Dev | **Hardhat** (not Foundry) | User preference; better plugin ecosystem |
| Backend | **Golang** | Observation & Analytics Server; Clean Architecture; event indexer + statistics + keeper health aggregator |
| Cache | **Redis** | Active commitment cache, oracle price cache (30s TTL), execution deduplication lock (`SETNX`), keeper→Go event pub/sub |
| Metrics | **Prometheus + Grafana** | Keeper uptime, execution latency, proof generation time, per-chain stats — exposed via Go `/metrics` endpoint |
| Containerization | **Docker + Docker Compose** | All services (keeper, Go server, Redis, Prometheus, Grafana, PostgreSQL) orchestrated in one `docker-compose.yml` |
| Database | **PostgreSQL** + `golang-migrate` | Anonymized event storage; execution history; keeper uptime records |
| Target Chains | **Arbitrum Sepolia** (primary) + **Base Sepolia** (secondary) | Both L2, both have Chainlink + Uniswap v3, one-line Hardhat config change |
| Oracle | Chainlink (primary) + Uniswap v3 TWAP (fallback) | — |
| Private Mempool | Flashbots Protect | Sufficient for thesis; skip Shutter Network for now |
| Keeper Node | Node.js 20+, Docker | Single trusted keeper acceptable for prototype (FR-KN-08) |
| DEX | Uniswap v3 (primary) | — |

---

## Trading Strategies

### All 4 Strategies — In Scope

#### 1. Private Limit Orders
- User defines: token pair, direction (buy/sell), limit price, size, expiry
- Commitment: `keccak256(price || size || direction || nonce || user_secret)`
- Fill condition: oracle price crosses the limit price (`oracle_price <= price` for buy, `>= price` for sell)
- Keeper checks: Chainlink price every 30s
- Privacy: price, size, direction never revealed — only ZK proof at execution
- Circuit: `OrderFill` circuit (see §9.2 of SRS)

#### 2. Private Market Orders
- Reuses the `OrderFill` circuit and the limit-order commitment scheme. The only difference is a sentinel `price` baked into the commitment:
  - BUY  → `price = u64.max` → `oracle ≤ price` always true → fills immediately
  - SELL → `price = 0`       → `oracle ≥ price` always true → fills immediately
- User defines: token pair, side (BUY/SELL), size, slippage % (default 1%). No target price.
- Frontend reads the live Chainlink pair price (quote-per-base) to compute the est. output and `minOut = est × (1 − slippage)`.
- On-chain the commitment is `kind = 0 (ORDER_FILL)`; from the contract's perspective a market order is structurally identical to a limit order that happens to fill on the next tick.
- Backend `MonitorService` recognises `Kind = "MARKET"` (constant in `domain/entity.go`) and short-circuits the fill check (`isFillConditionMet` returns `true` for MARKET). The first goroutine tick fires `POST /api/execute`; no Chainlink polling. When the trigger is forwarded to the keeper, the kind is rewritten to `"ORDER_FILL"` on the wire.
- Keeper: no code changes. Its standard oracle re-verify against the sentinel `limitPrice` trivially passes.
- Expiry: hard-capped at 10 minutes so an unfilled market order doesn't linger.
- Privacy: `size`, `direction`, `tokenIn`, `tokenOut` are revealed as for LIMIT. The sentinel `price` is in the commitment but is structurally `0` or `u64.max` — it leaks no strategy parameter (the trader is asking for "current market" regardless of value).

The earlier stop-loss / take-profit kinds were removed during this phase. If needed later they can be reintroduced as another frontend-only discriminator on the same OrderFill circuit, with `direction` driving the inequality (BUY for downside stop, SELL for upside target).

#### 3. Private DCA (Dollar-Cost Averaging)
- User defines: token pair, direction, amount per interval, interval duration, total rounds
- At creation: a **batch** of time-locked commitments is generated — one per DCA round
- Each commitment encodes a scheduled execution time window (with ±15% jitter to obscure frequency)
- Fill condition: elapsed time falls within the scheduled window
- Keeper checks: time condition instead of oracle price
- Batch registration: all round commitments posted in one tx (saves gas, FR-CR-07)
- Privacy: amount, interval, frequency, total rounds never revealed
- Known limitation: timing side-channel — sophisticated analysis can infer interval even with jitter (acknowledged in SRS §11.1)

#### 4. Private Grid Trading (Simplified — Decomposed Commitments)
- Full sMPC/TEE approach is out of scope; instead: **decompose grid into N independent limit order commitments**
- User defines: token pair, lower bound, upper bound, number of grid levels, size per level
- System generates N buy commitments (below mid-price) + N sell commitments (above mid-price)
- Each commitment is a standard limit order — reuses `OrderFill` circuit entirely
- Grid structure is never posted on-chain — observer sees N executions, not a grid pattern
- Batch registration: all grid commitments posted in one tx
- Keeper monitors all N commitments simultaneously; each fills independently as price hits its level
- Known limitation: post-execution, evenly-spaced execution prices may hint at a grid — acknowledged limitation, pre-execution privacy is fully preserved

---

## Implementation Order

The guiding principle: **get one full E2E flow working before expanding**. Each phase builds directly on the previous — no throwaway work.

---

### Phase 1 — Foundation (Smart Contracts + ZK Circuit)
> Goal: Core cryptographic infrastructure working on local Hardhat node.

1. **ZK Circuit (`OrderFill`) in Noir**
   - Private inputs: `price`, `size`, `direction`, `nonce`, `user_secret`
   - Public inputs: `commitment_hash`, `oracle_price`, `nullifier`
   - Constraints: commitment preimage check, fill condition check, nullifier derivation
   - Compile to WASM with Barretenberg; verify proof generates and verifies locally

2. **`OrderFillVerifier.sol`**
   - Auto-generated from the `OrderFill` Noir circuit (UltraHonk) via `bb write_solidity --oracle_hash keccak`
   - Deploy to local Hardhat node; write unit tests for valid/invalid proofs

3. **`CommitmentRegistry.sol`**
   - State: `commitments` mapping, `nullifiers` mapping
   - Functions: `registerCommitment`, `executeCommitment`, `cancelCommitment`, `sweepExpired`, `getCommitmentStatus`
   - Events: `CommitmentRegistered`, `CommitmentExecuted`, `CommitmentCancelled`, `CommitmentExpired`
   - Emergency pause: `paused` flag + guardian
   - Unit tests: >90% coverage (Hardhat + ethers.js)

4. **`CollateralVault.sol`**
   - Functions: `deposit`, `lockCollateral`, `releaseForExecution`, `returnCollateral`
   - `onlyRegistry` modifier on all fund-movement functions
   - Unit tests: deposit, lock, release, return flows

5. **`IDEXAdapter` + `UniswapV3Adapter.sol`**
   - Interface: `swap(tokenIn, tokenOut, amount, minOut)`
   - Mock adapter for local testing; real Uniswap v3 adapter for testnet

**Milestone:** Full commitment lifecycle (register → execute → settle) working in Hardhat tests with real ZK proofs.

---

### Phase 2 — Private Limit Orders (E2E)
> Goal: First working strategy, end-to-end from UI to on-chain settlement.

1. **Keeper Node — Core**
   - Event listener: subscribe to `CommitmentRegistered` on `CommitmentRegistry`
   - Oracle poller: Chainlink price feed, every 30s
   - Fill condition engine: `PriceFillCondition` (checks `oracle_price` against committed limit)
   - Execution submitter: call `executeCommitment` via Flashbots Protect RPC
   - Retry logic: exponential backoff, max 5 retries
   - REST API: `GET /health`, `GET /commitments`, `GET /executions`

2. **Frontend — Strategy Builder (Limit Orders)**
   - Wallet connection: MetaMask + WalletConnect v2
   - Limit order form: token pair selector, direction toggle, price input, size input, expiry picker
   - Client-side commitment generation: `keccak256(price || size || direction || nonce || user_secret)`
   - WASM proof generation with step-by-step progress indicator
   - Gas estimate display before submission
   - Submit to `CommitmentRegistry` + lock collateral in vault

3. **Frontend — Dashboard**
   - List active commitments with status (Pending / Triggered / Executed / Cancelled / Expired)
   - Manual execute button (self-execution fallback if keeper is offline)
   - Cancel commitment button (submits nullifier)
   - Encrypted strategy backup export/import (`.zstrategy` file)
   - Keeper health indicator (pulls from `GET /health`)

4. **Backend — Statistics Service (Clean Architecture)**
   - Index `CommitmentRegistered`, `CommitmentExecuted`, `CommitmentCancelled` events
   - Store anonymized execution records (no strategy params — only commitment hash, timestamp, chain, status)
   - Expose REST API: total executions, success rate, average execution latency, keeper uptime
   - Used by frontend dashboard for system-level stats (not user strategy data)

**Milestone:** A limit order submitted from the UI executes on Arbitrum Sepolia via keeper → Uniswap v3, viewable in the dashboard.

---

### Phase 3 — Market Order ✅ Complete
> Goal: Add a market-order variant with zero circuit, contract, or keeper changes.

1. **Circuit + contract — No changes needed** ✅
   - Sentinel price (`u64.max` for BUY, `0` for SELL) makes the OrderFill fill check trivially pass; on-chain `kind = 0 (ORDER_FILL)` for both LIMIT and MARKET.

2. **Frontend** ✅
   - `StrategyKind = "LIMIT" | "MARKET"` in `strategyStore.ts` (SL/TP removed).
   - `strategy/page.tsx`: 2-button order-type picker; price input hidden when MARKET; user-controlled slippage selector (0.5% / 1% / 2% / 5%, default 1%) applies to both kinds.
   - Live oracle "quote per base" price read for MARKET via `priceFeeds(token)` + Chainlink `latestRoundData`+`decimals`. Drives the est-output display and `minOut = expectedOut × (1 − slippage)`.
   - MARKET orders use a hard-capped 10-minute expiry.
   - `MyStrategies.tsx` `KindBadge` updated; SL/TP labels removed.

3. **Backend** ✅
   - `domain.KindMarket = "MARKET"` constant added.
   - `MonitorService.isFillConditionMet` returns `true` immediately for MARKET (the first tick fires the trigger; no Chainlink polling).
   - `triggerKeeper` rewrites MARKET → ORDER_FILL on the wire so the keeper does its standard oracle re-verify (which trivially passes against the sentinel).
   - Handler `RegisterStrategy` accepts `"MARKET"` as a valid `kind` value alongside `"ORDER_FILL"` and `"DCA"`.

4. **Keeper — No changes needed** ✅
   - Existing ORDER_FILL re-verify path handles MARKET transparently because of the sentinel price.

**Milestone:** Market order submitted from the UI → registered on-chain → backend's monitor fires keeper trigger immediately → keeper proves and executes within seconds; dashboard reflects the fill.

---

### Phase 4 — Private DCA ✅ Complete
> Goal: Time-based strategy with batch commitment registration.

1. **Circuit** ✅ — `circuits/dca/` with 192-byte preimage: `keccak256(tokenIn ‖ tokenOut ‖ size ‖ minOut ‖ scheduledLo(8) ‖ scheduledHi(8) ‖ expiry(8) ‖ nonce(32) ‖ user_secret(32))`. Time fill constraint: `scheduledLo ≤ execution_timestamp ≤ scheduledHi`. 8 tests. Compiled artifact at `circuits/dca/target/dca.json`.

2. **Registry** ✅ — `CommitmentKind` enum (ORDER_FILL=0, DCA=1), `mapping(uint8 => IVerifier) verifiers`, `setVerifier()`, `registerCommitmentBatch`, dispatch in `executeCommitment` — ORDER_FILL reads Chainlink, DCA uses a keeper-proven execution timestamp and rejects it if it is in the future or older than the settlement freshness window.

3. **Frontend** ✅ — Full DCA form at `app/(dashboard)/dca/page.tsx`. Batch registration, jitter preview, IndexedDB save with `dcaGroupId`.

4. **Keeper** ✅ — `keeper/src/zk/dca.ts` for DCA proof generation; `submitter.ts` dispatches on `order.kind === "DCA"`. Triggered by Go backend `POST /api/execute`; the keeper re-verifies `scheduledLo ≤ now ≤ scheduledHi` inline before reconstructing the secret.

5. **Backend** ✅ — `MonitorService` handles DCA goroutines (wall-clock check). `RegisterDcaGroup` handler saves all rounds to `pending_strategies`. SQL migration `003_add_pending_strategies`.

**DCA jitter:** `scheduled_lo = center − 0.15×interval`, `scheduled_hi = center + 0.15×interval`. Single wallet signature per DCA group; each round gets its own nonce.

**Milestone:** A DCA strategy batch-registers N rounds; Go backend goroutines trigger each round within its jitter window; keeper generates DCA ZK proof and executes on-chain.

---

### Phase 5 — Private Grid Trading
> Goal: Multi-level grid decomposed into batch limit order commitments.

1. **Circuit — No changes needed** (reuses `OrderFill`)

2. **Frontend — Grid form**
   - Inputs: token pair, lower price bound, upper price bound, number of grid levels, size per level
   - Client computes N evenly-spaced buy levels (below mid) + N sell levels (above mid)
   - Generates 2N limit order commitments automatically
   - Batch submit all 2N commitments in one tx
   - Display: grid visualization showing price levels and fill status per level

3. **Keeper — Batch commitment monitoring**
   - Already handles multiple commitments; no structural change
   - Add grid-awareness: when a sell level fills, optionally re-register a new buy commitment at the lowest unfilled level (reinvestment logic — optional for thesis)

4. **Backend — Grid execution tracking**
   - Track which grid levels have executed, visualize fill progression

**Milestone:** A 5-level grid on ETH/USDC executes multiple levels as price moves on testnet, visible in the dashboard as a grid heatmap.

---

### Phase 6 — Multi-Chain Deployment + Polish
> Goal: Deploy to Base Sepolia as second chain; finalize thesis demo.

1. Deploy all contracts to Base Sepolia (one Hardhat config entry)
2. Frontend: chain switcher (Arbitrum Sepolia ↔ Base Sepolia)
3. Keeper: run two instances (one per chain) or add multi-chain support
4. Backend: index events from both chains, tag records by chain ID
5. End-to-end demo script: one of each strategy type executing on both chains
6. Security: run Slither on contracts, document findings

---

### Summary Timeline

| Phase | Focus | Key Output |
|---|---|---|
| 1 | ZK circuit + smart contracts | Hardhat tests passing with real ZK proofs |
| 2 | Limit orders E2E | Full flow on Arbitrum Sepolia testnet |
| 3 | Market Order | Frontend-only kind; backend triggers keeper immediately; zero circuit/contract changes |
| 4 | DCA | Time-based batch strategy working |
| 5 | Grid Trading | Decomposed grid commitments working |
| 6 | Multi-chain + polish | Demo-ready on two chains |

---

## Multi-Chain Decision: No Solana

**Decision: Stay EVM-only for thesis. Solana is future work.**

Reasons against Solana now:
- OrderFillVerifier is auto-generated Solidity — no direct port to Solana BPF/SBF
- Would require rewriting verifier in Rust with a different proof system
- Separate commitment registry, vault programs, keeper integration
- No Flashbots equivalent (Jito is different, less mature for this use case)
- Effectively a second thesis in scope

Multi-chain demo is satisfied by Arbitrum + Base — same contract code, one Hardhat config change.

Solana belongs in **Section 11.2 Future Work**: *"Extending to non-EVM chains requires porting the verifier to a different proof system (e.g., compatible with Solana's BPF runtime), which is an open research direction."*

---

## SRS Issues & Disagreements

### A. FR-ZK-03 — Remove collateral check from ZK circuit
**Issue:** Circuit verifying `size <= collateral_locked` requires collateral balance as private witness, but collateral balance is already visible on-chain in the vault.

**Fix:** Remove this constraint from the circuit. Push it to Solidity in `executeCommitment()`:
```solidity
require(vault.lockedBalance(commitmentHash) >= size, "Insufficient collateral");
```
No privacy benefit lost; circuit complexity reduced.

---

### B. Section 8.2 — Numbering bug
**Issue:** Data flow steps are numbered 11–21 instead of 1–11. Copy-paste artifact.

**Fix:** Renumber to 1–11 in the SRS.

---

### C. FR-KN-04 — Keeper fee creates commitment size mismatch
**Issue:** Fee deducted from collateral *before* swap means actual swap amount = `collateral - fee`, but ZK proof commits to original `size`. Circuit constraint breaks.

**Two options:**
- (a) Include `fee` as a separate field in the commitment: `commitment = keccak256(price || size || direction || fee || nonce || user_secret)`. Fee is verified in circuit.
- (b) Deduct keeper fee from *received tokens post-swap*, not from input collateral.

**Original recommendation:** Option (b) — simpler circuit, cleaner UX.

**Superseded (2026-05-11) by prepaid ETH gas tank.** Both (a) and (b) keep the keeper denominated in tokenOut, leaving the keeper with inventory/FX risk converting to ETH for gas. Instead, the user prepays native ETH into `GasVault.sol`; `CommitmentRegistry.executeCommitment` debits `gasUsed × tx.gasprice × KEEPER_PREMIUM_BPS / 10000` (currently 120% — flat 20% premium) and forwards to `msg.sender`. Insufficient balance reverts; keeper does `eth_call` preflight to avoid wasted gas. Self-execution (`msg.sender == owner`) skips the debit. This avoids circuit changes entirely and matches Gelato 1Balance / AA-paymaster patterns. See `contracts/contracts/core/GasVault.sol` and the `_debitGas` helper in `CommitmentRegistry.sol`.

---

### D. FR-SB-10 vs FR-SB-08 — Dashboard vs local-only storage tension
**Issue:** Strategy parameters are only in browser storage (FR-SB-10). If user clears storage or switches devices, the dashboard (FR-SB-08) shows nothing — commitment hashes are on-chain but undecodable without the secret.

**Fix:** Add **encrypted strategy backup export/import** feature:
- Export: AES-encrypt strategy params with a user password → download `.zstrategy` file
- Import: decrypt and restore to browser storage
- Explicit UX disclaimer: "Your strategy parameters are stored locally. Export your backup file."

---

### E. Section 9.1 — `user_secret` is shared across all strategies
**Issue:** `user_secret = keccak256(sign(wallet, "ShadowBot Strategy"))` is deterministic and identical for every order from the same wallet. If leaked, all historical nullifiers `keccak256(user_secret || nonce)` can be computed, linking all strategies to one user.

**Fix:** Make `user_secret` per-strategy:
```
user_secret = keccak256(sign(wallet, strategyId))
```
where `strategyId` is a unique identifier (e.g., `keccak256(wallet || nonce || block.timestamp)`). Compromise of one order's secret doesn't expose others.

---

## Features to Add (Beyond SRS)

### High Priority
| Feature | Why |
|---|---|
| **Slippage protection** | Add `maxSlippage` field (encrypted in commitment, revealed at execution). Without it, the keeper's DEX swap can still be sandwiched even if the commitment is private. |
| **Self-execution fallback** | If keeper is offline, user generates own proof in UI and calls `executeCommitment` directly. SRS mentions this in threat model (§6.2) but has no FR for it. Add "Manual Execute" button to dashboard. |
| **Encrypted strategy backup** | See issue D above. Essential for usability. |
| **`sweepExpired()` function** | Callable by anyone — detects expired commitments, returns collateral, sets status `Expired`. Required for NFR 5.3 but not in contract spec (§10). |

### UX Improvements
| Feature | Why |
|---|---|
| **Proof generation step labels** | 30-second WASM wait is a UX cliff. Show steps: "Generating witness → Computing proof → Verifying locally → Ready to submit" |
| **Gas cost estimate in USD** | Show gas × L2 gas price × ETH/USD from oracle. Critical for retail users on L2. |
| **Strategy simulation / dry run** | Simulate execution against current oracle price without submitting on-chain. Great for thesis demo. |
| **Keeper health indicator in UI** | Pull from `GET /health`, show last-seen and monitored count. Builds user trust. |

### Deprioritize / Skip
- Grid trading — future work (requires TEE/sMPC keeper, not just ZK proofs)
- Multi-keeper threshold — future work (single keeper is thesis prototype)
- ERC-4626 yield-bearing collateral — nice-to-have, skip for now
- Shutter Network — Flashbots Protect is sufficient for thesis
- Recursive ZKPs — future work (reduces gas 10x but adds circuit complexity)

---

## Future Architecture Directions

### ZK + FHE Combined Architecture

**The keeper private-input problem:**
The current ZK approach has a structural tension: to generate an execution proof at fill time, someone must hold the private inputs (price, size, direction, nonce, user_secret). In the thesis prototype the keeper holds these — which means the keeper knows the full strategy parameters, creating an information surface even though nothing is revealed on-chain.

**Why FHE minimizes this:**
Fully Homomorphic Encryption (FHE) allows the keeper to evaluate fill conditions directly on encrypted strategy data, without ever learning the plaintext values. The keeper computes `oracle_price <= encrypted_limit_price` on the ciphertext and gets an encrypted boolean — it learns only whether to execute, not the actual limit price, size, or direction.

**Trust model comparison:**

| | ZK-only (thesis) | ZK + FHE (future) |
|---|---|---|
| Keeper sees | Full strategy params | Encrypted boolean only |
| On-chain reveals | Commitment hash | Ciphertext |
| Trust assumption | Keeper won't leak params | Decryption threshold won't collude |
| Information surface | High (keeper knows everything) | Minimal (keeper knows execute/skip) |

Both approaches require trusting one off-chain party — the trust model is structurally the same. The difference is what that party can do with what they know: a ZK keeper can frontrun or copy strategies; an FHE keeper cannot reconstruct any strategy parameter.

**Combined architecture:**
```
User encrypts strategy params (FHE pubkey) → stored on-chain as ciphertext
         ↓
Keeper evaluates fill condition on ciphertext (FHE compute) → encrypted boolean
         ↓
Threshold decryption (Fhenix key network) → execution trigger
         ↓
ZK proof generated and submitted on-chain
         ↓
CommitmentRegistry verifies ZK proof → executes via DEX
```

ZK remains essential for on-chain verifiability — FHE alone cannot prove to the smart contract that execution conditions were legitimately met.

**Concrete implementation path:**
- **Fhenix CoFHE** is live on Arbitrum mainnet (as of 2026) with Offchain Labs backing — a direct match for the thesis deployment target
- Fhenix SDK integrates with existing Solidity contracts; the keeper would use Fhenix's FHE compute layer for condition evaluation
- Gas premium: ~$3-5 over standard tx, acceptable for the privacy guarantee gained

**Why this is deferred:**
Adding Fhenix CoFHE integration requires redesigning the keeper's condition evaluation layer, learning a new SDK, and handling FHE key management — significant scope on top of an already ambitious thesis. The ZK-only prototype fully demonstrates the core cryptographic architecture; FHE is a concrete, production-ready improvement path rather than vague future work.

---

## CollateralVault Security Notes

### EIP-4626 Inflation Attack Mitigation
The standard EIP-4626 first-depositor vulnerability allows an attacker to deposit a small amount, then donate a large amount directly to the vault to manipulate the share price, making subsequent depositors receive near-zero shares.

**Fix:** Use OpenZeppelin's virtual shares offset pattern:
```solidity
// In CollateralVault constructor, mint dead shares to address(0)
// OZ ERC4626 exposes _decimalsOffset() — override to set offset
function _decimalsOffset() internal pure override returns (uint8) {
    return 3; // 10^3 offset makes inflation attacks ~1000x more expensive
}
```
This must be applied before any user can deposit. Verify OZ's `ERC4626` base contract is used (not a custom implementation) so the offset pattern is inherited correctly.

---

## Resolved Decisions

### ✅ ZK Circuit Language: Noir + Barretenberg (UltraPlonk)

**Decision:** Use Noir with Barretenberg as the proving backend (UltraPlonk proof system). Circom + snarkjs (Groth16) is rejected.

**Reasons:**

**1. Keccak256 constraint cost — the decisive factor**
The commitment scheme `keccak256(price || size || direction || nonce || user_secret)` and nullifier `keccak256(user_secret || nonce)` both require Keccak256 inside the circuit. Keccak256 is notoriously ZK-unfriendly:
- Circom + Groth16: ~151,000 constraints per Keccak256 hash — fixed overhead, no amortization
- Noir + Barretenberg: ~55,000 base constraints with Barretenberg's native Keccak gadget, amortized across multiple hashes in the same circuit

With two Keccak256 calls per `OrderFill` circuit (commitment + nullifier), Circom pays ~302k constraints vs Noir's ~110k — a ~60% reduction that directly translates to faster proof generation in the browser.

**2. Universal trusted setup — no per-circuit ceremony**
- Circom + Groth16 requires a Phase 2 trusted setup ceremony per circuit. The thesis has at minimum two distinct circuits (`OrderFill` for limit orders, `DCA` for time-based strategies). Each circuit iteration during development would require a new ceremony — impractical.
- Noir + Barretenberg uses UltraPlonk's universal setup: one setup covers all circuits regardless of size or structure. Iterating on circuit design during development has zero ceremony overhead.

**3. Developer experience**
- Noir has Rust-inspired syntax, native `#[test]` decorators with fuzzing support, a VS Code debugger with breakpoints and call stack inspection, and a REPL debugger via Nargo CLI.
- Circom requires manual R1CS constraint thinking, has no native IDE integration, and relies on `log()` statements for debugging.
- For a thesis prototype under time pressure, Noir's tooling materially reduces circuit development time.

**4. WASM/browser proof generation**
Both support WASM compilation. Noir uses `bb.js` (Barretenberg WASM wrapper) + `noir_js`. Circom uses `snarkjs`. Performance is comparable; both are production-viable for browser-side proof generation.

**5. Proof system and Solidity verifier**
- Noir + Barretenberg generates a Solidity verifier via `bb write_vk` + `bb write_solidity`. Use `--oracle_hash keccak` flag for EVM-optimized output.
- UltraPlonk verification costs ~10% more gas than Groth16 on-chain. At L2 gas prices on Arbitrum Sepolia this is negligible — well within the 500k gas budget from NFR 5.1.
- The generated verifier is suitable for production with auditing (Nethermind has published security analysis of Barretenberg-generated contracts; OpenZeppelin has published safe Noir circuit guidelines).

**6. No per-circuit trusted setup risk**
Groth16's per-circuit Phase 2 setup introduces a trust assumption that someone in the ceremony was honest. While universal setups (Powers of Tau) are shared, Phase 2 is circuit-specific and must be re-run for every circuit change. UltraPlonk eliminates this entirely — the universal setup ceremony has already been completed by the Barretenberg team and can be reused freely.

**Trade-off acknowledged:**
Circom is more battle-tested (Tornado Cash, Semaphore, Polygon Hermez — 5+ years in production). Noir is approaching 1.0 (beta in 2025) and has not yet accumulated the same audit history. Mitigation: use OpenZeppelin's Noir circuit safety guidelines, follow Nethermind's audit findings, and write comprehensive circuit tests with fuzzing via `nargo test`.

---

## Open Questions

- [ ] Confirm Flashbots Protect availability on Arbitrum Sepolia
- [x] Finalize keeper fee mechanism — **resolved (2026-05-11):** prepaid ETH gas tank (`GasVault.sol`), 20% flat premium, supersedes option (b). See issue C above.
- [x] Decide `strategyId` generation scheme — **resolved:** `keccak256(sign(wallet, strategyId))` where `strategyId = keccak256(wallet ‖ nonce)`; implemented in `frontend/src/lib/commitment.ts`
