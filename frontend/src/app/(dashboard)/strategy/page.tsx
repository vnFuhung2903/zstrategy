"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, useSignMessage, useChainId } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Lock, Info, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFreeBalance, formatUnits as fmtUnits } from "@/hooks/useVault";
import { useGasBalance, PER_EXECUTION_ETH_ESTIMATE } from "@/hooks/useGasVault";
import { DEFAULT_PAIR, type TradingPair } from "@/lib/tradingPairs";
import { TokenPairSelect } from "@/components/ui/TokenPairSelect";
import { useRegisterCommitment } from "@/hooks/useRegistry";
import {
  commitmentHash as computeCommitment,
  nullifierHash as computeNullifier,
  deriveStrategyId,
  deriveUserSecret,
  randomBytes32,
  strategyIdSigningMessage,
} from "@/lib/commitment";
import { saveStrategy, type StrategyKind } from "@/lib/strategyStore";
import { splitAndEncryptSecret } from "@/lib/threshold";
import { keeperApi } from "@/lib/keeperApi";
import { backendApi, type PostStrategyBody } from "@/lib/backendApi";

const TIME_IN_FORCE: Record<string, number> = {
  "1H":  3600,
  "24H": 86400,
  "7D":  604800,
  "GTC": 30 * 86400,
};

// Direction matches the Noir circuit:
//   0 = BUY  → require oracle_price <= price
//   1 = SELL → require oracle_price >= price
const DIRECTION_BUY  = 0 as const;
const DIRECTION_SELL = 1 as const;

type Side = "BUY" | "SELL";

// Chainlink ETH/USD feed reports 8 decimals. The user inputs target price in
// USD; we scale to oracle units inside the preimage so the circuit's
// `oracle_price <= price` (or >=) check is unit-coherent.
const ORACLE_DECIMALS = 8;

export default function StrategyPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [pair,       setPair]       = useState<TradingPair>(DEFAULT_PAIR);
  const [kind,       setKind]       = useState<StrategyKind>("LIMIT");
  const [side,       setSide]       = useState<Side>("SELL");
  const [tif,        setTif]        = useState<keyof typeof TIME_IN_FORCE>("7D");
  const [amount,     setAmount]     = useState("");
  const [targetPrice,setTargetPrice]= useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Held until the on-chain registration confirms; only then do we POST to the
  // Go backend, so the chain is the source of truth before any off-chain row
  // is created (the indexer would otherwise race the POST).
  const [pendingPost, setPendingPost] = useState<PostStrategyBody | null>(null);
  const [postSynced,  setPostSynced]  = useState(false);

  // Per-strategy nonce — generated once per page load. A fresh strategy gets a
  // fresh nonce; we persist it (alongside metadata) only when the user clicks
  // submit, so abandoned drafts don't pollute IndexedDB.
  const nonceRef = useRef<`0x${string}`>(randomBytes32());

  // For STOP_LOSS / TAKE_PROFIT, always sell the base token (WETH→USDC).
  // For LIMIT, follow the user's side selector.
  //
  // Direction maps to the circuit fill condition:
  //   STOP_LOSS   → direction=BUY  (oracle <= trigger — fills when price falls)
  //   TAKE_PROFIT → direction=SELL (oracle >= trigger — fills when price rises)
  //   LIMIT BUY   → direction=BUY
  //   LIMIT SELL  → direction=SELL
  const effectiveSide: Side = kind !== "LIMIT" ? "SELL" : side;
  const tokenIn  = effectiveSide === "SELL" ? pair.baseToken  : pair.quoteToken;
  const tokenOut = effectiveSide === "SELL" ? pair.quoteToken : pair.baseToken;
  const direction =
    kind === "STOP_LOSS"   ? DIRECTION_BUY  :
    kind === "TAKE_PROFIT" ? DIRECTION_SELL :
    effectiveSide === "SELL" ? DIRECTION_SELL : DIRECTION_BUY;

  const { data: tokenInBalance } = useFreeBalance(tokenIn.address);
  const { data: gasBalance }     = useGasBalance();
  const { register, isPending, isConfirming, isSuccess, error } = useRegisterCommitment();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  // Keeper-gas precondition. We require ≥ 1 estimated fill in the tank before
  // accepting a new strategy — otherwise the keeper trigger will revert on
  // executeCommitment and the strategy will sit PENDING until the user funds.
  // (One commitment ⇒ one fill ⇒ one PER_EXECUTION_ETH_ESTIMATE.)
  // Treat the pre-query "undefined" state as a shortfall so a fast clicker
  // can't submit before the balance read resolves.
  const gasShortfall =
    gasBalance === undefined || gasBalance < PER_EXECUTION_ETH_ESTIMATE;

  // Re-roll nonce on (re)mount so a new submission starts fresh.
  useEffect(() => {
    nonceRef.current = randomBytes32();
  }, []);

  const amountBig = useMemo(() => {
    try { return parseUnits(amount || "0", tokenIn.decimals); }
    catch { return BigInt(0); }
  }, [amount, tokenIn.decimals]);

  // Slippage-protected min out, denominated in tokenOut units.
  //   SELL: spend `size` base tokens → receive ~`size * price` quote → min = * 0.995
  //   BUY:  spend `size` quote tokens → receive ~`size / price` base  → min = * 0.995
  const expectedOutFloat = useMemo(() => {
    const price = parseFloat(targetPrice.replace(/,/g, "") || "0");
    const size  = parseFloat(amount || "0");
    if (price <= 0 || size <= 0) return 0;
    return effectiveSide === "SELL" ? size * price : size / price;
  }, [amount, targetPrice, effectiveSide]);

  const minOutBig = useMemo(() => {
    if (expectedOutFloat <= 0) return BigInt(0);
    try {
      return parseUnits((expectedOutFloat * 0.995).toFixed(tokenOut.decimals), tokenOut.decimals);
    } catch { return BigInt(0); }
  }, [expectedOutFloat, tokenOut.decimals]);

  const priceBig = useMemo(() => {
    try {
      const p = parseFloat(targetPrice.replace(/,/g, "") || "0");
      if (p <= 0) return BigInt(0);
      return parseUnits(p.toString(), ORACLE_DECIMALS);
    } catch { return BigInt(0); }
  }, [targetPrice]);

  const expiry = Math.floor(Date.now() / 1000) + TIME_IN_FORCE[tif];

  const estOutput = useMemo(
    () => expectedOutFloat.toLocaleString(undefined, { maximumFractionDigits: tokenOut.decimals === 18 ? 6 : 2 }),
    [expectedOutFloat, tokenOut.decimals],
  );

  async function handleSubmit() {
    if (!isConnected || !address || amountBig === BigInt(0) || priceBig === BigInt(0)) return;
    setSubmitError(null);

    try {
      const nonce = nonceRef.current;
      const strategyId = deriveStrategyId(address, nonce);

      // 1. Fetch keeper public-key set BEFORE asking the user to sign — if the
      //    keeper network is unreachable we want to fail fast and not waste a
      //    wallet prompt.
      const { keepers } = await keeperApi.listKeepers();

      // 2. Wallet signs strategyId — deterministic, recoverable secret bound
      //    to this wallet. Same prompt on cancel/self-execute regenerates it.
      const signature = await signMessageAsync({
        message: strategyIdSigningMessage(strategyId),
      });
      const userSecret = deriveUserSecret(signature);
      const nullifier = computeNullifier(userSecret, nonce);

      const commitmentHash = computeCommitment({
        tokenIn:    tokenIn.address,
        tokenOut:   tokenOut.address,
        size:       amountBig,
        minOut:     minOutBig,
        expiry:     BigInt(expiry),
        price:      priceBig,
        direction,
        nonce,
        userSecret,
      });

      // 3. Shamir-split user_secret into N encrypted shares — one per keeper.
      //    No single keeper sees the secret in storage; reconstruction
      //    requires k of N to cooperate at fill time.
      const encryptedShares = await splitAndEncryptSecret(userSecret, keepers);

      // 4. Persist strategy metadata locally BEFORE any network/on-chain side
      //    effect. If subsequent steps fail, the user can recover from
      //    IndexedDB and retry. user_secret is NOT persisted — it's recoverable
      //    from the wallet signature on strategyId.
      await saveStrategy({
        commitmentHash,
        owner:      address.toLowerCase() as `0x${string}`,
        strategyId,
        nonce,
        tokenIn:    tokenIn.address,
        tokenOut:   tokenOut.address,
        size:       amountBig.toString(),
        minOut:     minOutBig.toString(),
        expiry,
        price:      priceBig.toString(),
        direction,
        kind,
        createdAt:  Math.floor(Date.now() / 1000),
      });

      // 5. Stash the keeper-bound payload — we POST it only AFTER the on-chain
      //    tx confirms (see the useEffect below). Posting earlier races the
      //    keeper's on-chain status check and yields a 422.
      setPostSynced(false);
      setPendingPost({
        commitmentHash,
        kind:       "ORDER_FILL",
        chainId,
        tokenIn:    tokenIn.address,
        tokenOut:   tokenOut.address,
        size:       amountBig.toString(),
        minOut:     minOutBig.toString(),
        expiry,
        limitPrice: priceBig.toString(),
        direction,
        nonce,
        nullifier,
        encryptedShares,
      });

      // 6. On-chain registration. msg.sender = wallet, so cancel + self-execute
      //    paths work without keeper involvement.
      register(commitmentHash, tokenIn.address, tokenOut.address, amountBig, minOutBig, expiry, 0);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
    }
  }

  function setMax() {
    if (tokenInBalance !== undefined) {
      setAmount(parseFloat(formatUnits(tokenInBalance, tokenIn.decimals)).toFixed(Math.min(tokenIn.decimals, 6)));
    }
  }

  // Preview hash uses a derived placeholder secret so the user can see the
  // commitment hash shape before signing. The real on-submit hash is rebuilt
  // with the wallet-derived secret, so this preview is purely illustrative.
  const previewSecret = useMemo<`0x${string}`>(() => randomBytes32(), []);
  const previewHash = useMemo<`0x${string}`>(() => {
    if (!address || priceBig === BigInt(0) || amountBig === BigInt(0)) {
      return ("0x" + "0".repeat(64)) as `0x${string}`;
    }
    return computeCommitment({
      tokenIn:    tokenIn.address,
      tokenOut:   tokenOut.address,
      size:       amountBig,
      minOut:     minOutBig,
      expiry:     BigInt(expiry),
      price:      priceBig,
      direction,
      nonce:      nonceRef.current,
      userSecret: previewSecret,
    });
  }, [address, amountBig, minOutBig, expiry, priceBig, previewSecret, tokenIn.address, tokenOut.address, direction]);

  const previewNullifier = useMemo<`0x${string}`>(
    () => computeNullifier(previewSecret, nonceRef.current),
    [previewSecret],
  );

  // Once the on-chain tx confirms, hand the encrypted shares + metadata to the
  // keeper network. Failures here leave the on-chain commitment intact (the
  // user can retry sync later); funds are never stuck because the chain is the
  // authoritative source.
  useEffect(() => {
    if (!isSuccess || !pendingPost || postSynced) return;
    let cancelled = false;
    backendApi.postStrategy(pendingPost)
      .then(() => { if (!cancelled) setPostSynced(true); })
      .catch(err => {
        if (!cancelled) console.warn("[strategy] backend post failed (will need retry):", err);
      });
    return () => { cancelled = true; };
  }, [isSuccess, pendingPost, postSynced]);

  const busy = isPending || isConfirming || isSigning;
  const errorMessage = submitError ?? (error ? (error as Error).message : null);

  return (
    <>
      <Topbar title="Strategy Architect" />
      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 max-w-7xl">

          {/* Left — Order config */}
          <div className="lg:col-span-4">
            <Card className="p-4 md:p-5 space-y-4 md:space-y-5">
              <p className="text-xs font-medium text-primary-container uppercase tracking-widest">
                Order Parameters
              </p>

              {/* Order type */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Order Type</p>
                <div className="flex gap-1.5">
                  {(["LIMIT", "STOP_LOSS", "TAKE_PROFIT"] as const).map(k => (
                    <button
                      key={k}
                      onClick={() => setKind(k)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        kind === k
                          ? "border-primary-container text-primary-container bg-primary-container/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >
                      {k === "LIMIT" ? "Limit" : k === "STOP_LOSS" ? "Stop-Loss" : "Take-Profit"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side — only shown for Limit orders */}
              {kind === "LIMIT" && (
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Side</p>
                <div className="flex gap-1.5">
                  {(["BUY", "SELL"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSide(s)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        side === s
                          ? s === "BUY"
                            ? "border-primary-container text-primary-container bg-primary-container/10"
                            : "border-secondary text-secondary bg-secondary/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >
                      {s} {pair.baseToken.name}
                    </button>
                  ))}
                </div>
              </div>
              )}

              {/* Asset pair selector */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Asset Pair</p>
                <TokenPairSelect value={pair} onChange={p => { setPair(p); setSide("SELL"); }} />
              </div>

              {/* Amount */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className="text-xs text-on-surface-variant uppercase tracking-widest">Amount ({tokenIn.name})</label>
                  <span className="text-xs text-on-surface-variant">
                    Vault:{" "}
                    <span className="text-on-surface font-medium">
                      {tokenInBalance !== undefined ? parseFloat(fmtUnits(tokenInBalance, tokenIn.decimals)).toFixed(4) : "—"} {tokenIn.name}
                    </span>
                  </span>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-surface-container-lowest text-on-surface text-xl font-display font-semibold px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container transition-all pr-14"
                  />
                  <button onClick={setMax} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-primary-container font-medium hover:text-primary-fixed">
                    MAX
                  </button>
                </div>
              </div>

              {/* Target / trigger price — always denominated in QUOTE per BASE (USD per ETH) */}
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className="text-xs text-secondary uppercase tracking-widest">
                    {kind === "STOP_LOSS"
                      ? `Trigger Price — Downside Stop (${pair.quoteToken.name}/${pair.baseToken.name})`
                      : kind === "TAKE_PROFIT"
                      ? `Trigger Price — Upside Target (${pair.quoteToken.name}/${pair.baseToken.name})`
                      : `Target Price (${pair.quoteToken.name} per ${pair.baseToken.name})`}
                  </label>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={targetPrice}
                    onChange={e => setTargetPrice(e.target.value)}
                    className="w-full bg-surface-container-lowest text-on-surface text-xl font-display font-semibold px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-secondary transition-all pr-14 font-tabular"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant font-medium">{pair.quoteToken.name}</span>
                </div>
              </div>

              {/* Time in force */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Time in Force</p>
                <div className="flex gap-1.5">
                  {Object.keys(TIME_IN_FORCE).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTif(t)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        tif === t
                          ? "border-primary-container text-primary-container bg-primary-container/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Summary */}
              <div className="bg-surface-container-lowest rounded-sm p-3 space-y-2 text-sm">
                {[
                  { label: "Est. Output",        value: `${estOutput} ${tokenOut.name}`,         cls: "text-on-surface font-tabular font-medium" },
                  { label: "Min. Output (0.5%)",  value: `${parseFloat(formatUnits(minOutBig, tokenOut.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${tokenOut.name}`, cls: "text-on-surface font-tabular" },
                  { label: "Expiry",             value: new Date(expiry * 1000).toLocaleDateString(), cls: "text-on-surface font-tabular" },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="flex justify-between gap-2">
                    <span className="text-on-surface-variant truncate">{label}</span>
                    <span className={cls}>{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Right — ZK panel */}
          <div className="lg:col-span-8 space-y-4">
            <Card variant="trust-violet" className="p-4 md:p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-1">Cryptographic Commitment</p>
                  <h2 className="font-display text-xl md:text-2xl font-semibold text-on-surface">ZK Proof Enclave</h2>
                  <p className="text-sm text-on-surface-variant mt-1">
                    Your strategy parameters are encrypted locally. The keeper only sees a commitment hash.
                  </p>
                </div>
                <Badge variant="sovereign" dot className="shrink-0">ZKP Active</Badge>
              </div>

              {/* Terminal */}
              <div className="bg-surface-container-lowest rounded-sm p-3 md:p-4 font-mono text-xs space-y-1.5 border border-outline-variant/15 overflow-x-auto">
                <p className="text-on-surface-variant whitespace-nowrap">// Preview commitment (real one rebuilt on submit with wallet-derived secret)</p>
                <p className="text-on-surface whitespace-nowrap">{">"} Loading circuit: OrderFill (185-byte preimage)</p>
                <p className="text-primary-container whitespace-nowrap">{">"} [OK] Circuit loaded</p>
                <p className="text-on-surface whitespace-nowrap">
                  {">"} tokenIn={tokenIn.address.slice(0, 10)}… tokenOut={tokenOut.address.slice(0, 10)}…
                </p>
                <p className="text-on-surface whitespace-nowrap">
                  {">"} size={amount} {tokenIn.name} | minOut={parseFloat(formatUnits(minOutBig, tokenOut.decimals)).toFixed(4)} {tokenOut.name} | kind={kind} | direction={direction === 1 ? "SELL" : "BUY"}
                </p>
                <p className="text-on-surface-variant whitespace-nowrap">// commitment = keccak256(tokenIn ‖ tokenOut ‖ size ‖ minOut ‖ expiry ‖ price ‖ direction ‖ nonce ‖ secret)</p>
                <p className="text-primary-container break-all">{">"} preview: {previewHash}</p>
                <p className="text-secondary break-all">{">"} preview nullifier: {previewNullifier}</p>
                {isSigning && <p className="text-secondary animate-pulse">{">"} Awaiting wallet signature for user_secret derivation...</p>}
                {busy && !isSigning && <p className="text-primary-container animate-pulse">{">"} Submitting tx...</p>}
                {isSuccess && <p className="text-primary-container">{">"} [OK] Commitment registered on-chain ✓</p>}
                {isSuccess && pendingPost && !postSynced && (
                  <p className="text-secondary animate-pulse">{">"} Syncing encrypted shares to keeper network...</p>
                )}
                {postSynced && <p className="text-primary-container">{">"} [OK] Shares distributed to keeper network ✓</p>}
                {!busy && !isSuccess && <p className="text-primary-container animate-pulse">{">"} _</p>}
              </div>

              {/* Status */}
              {errorMessage && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  {errorMessage.slice(0, 160)}
                </div>
              )}
              {gasShortfall && !isSuccess && (
                <div className="mt-3 flex items-center gap-2 text-xs text-secondary">
                  <AlertCircle size={13} />
                  Gas tank too low for keeper reimbursement — top up on the Vault page before submitting.
                </div>
              )}

              {/* Action */}
              <div className="mt-4 md:mt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0", isSuccess ? "bg-primary-container/20" : "bg-secondary/10")}>
                    {isSuccess
                      ? <CheckCircle2 size={16} className="text-primary-container" />
                      : <Lock size={16} className="text-secondary" />
                    }
                  </div>
                  <div>
                    <p className="text-sm font-medium text-on-surface">
                      {isSuccess ? "Commitment registered" : isConnected ? "Ready to encrypt" : "Wallet not connected"}
                    </p>
                    <p className="text-xs text-on-surface-variant">UltraHonk · OrderFill (185-byte preimage)</p>
                  </div>
                </div>
                <Button
                  variant="sovereign"
                  size="md"
                  className="w-full sm:w-auto"
                  disabled={!isConnected || busy || amountBig === BigInt(0) || priceBig === BigInt(0) || isSuccess || gasShortfall}
                  onClick={handleSubmit}
                >
                  {busy
                    ? <><Loader2 size={14} className="animate-spin" />{isSigning ? "Signing…" : isConfirming ? "Confirming…" : "Submitting…"}</>
                    : isSuccess
                      ? <><CheckCircle2 size={14} />Committed</>
                      : gasShortfall
                        ? <><Lock size={14} />Top up gas tank</>
                        : <><Lock size={14} />Sign &amp; Submit Commitment</>
                  }
                </Button>
              </div>
            </Card>

            {/* Info */}
            <div className="flex gap-3 px-4 py-3 rounded-sm border-l-2 border-primary-container bg-primary-container/5">
              <Info size={14} className="text-primary-container mt-0.5 shrink-0" />
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Your wallet signs a per-strategy id to derive the secret. The signature stays in your browser;
                only the commitment hash is posted on-chain. Cancel and self-execute work after a page reload
                because the secret is recoverable from the wallet — no key management required.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
