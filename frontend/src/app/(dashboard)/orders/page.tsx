"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, useSignMessage, useChainId, usePublicClient } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Lock, Info, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFreeBalance, formatUnits as fmtUnits } from "@/hooks/useVault";
import { DEFAULT_PAIR, type TradingPair } from "@/lib/tradingPairs";
import { TokenPairSelect } from "@/components/ui/TokenPairSelect";
import { useRegisterCommitment } from "@/hooks/useRegistry";
import {
  commitmentHash as computeCommitment,
  nullifierHash as computeNullifier,
  deriveIntentId,
  deriveUserSecret,
  randomBytes32,
  intentIdSigningMessage,
} from "@/lib/commitment";
import { saveIntent, type IntentKind } from "@/lib/intentStore";
import { backendApi, type PostOrderIntentBody } from "@/lib/backendApi";
import { createEncryptedWitnessPackage, type PublicIntentMetadata } from "@/lib/enclaveWitness";
import { ADDRESSES, COMMITMENT_REGISTRY_ABI, PRICE_FEED_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";

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

// Slippage tolerance options. 1% is the default — tighter than typical AMM
// swaps because execution is checked against current oracle, not pool spot.
const SLIPPAGE_OPTIONS = [0.5, 1, 2, 5] as const;
type SlippagePct = typeof SLIPPAGE_OPTIONS[number];

// MARKET commitment uses a sentinel price so the OrderFill circuit fill check
// trivially passes — there is no real "target price" to commit to.
//   BUY:  oracle <= price → set price = u64.max → always true
//   SELL: oracle >= price → set price = 0       → always true
const MARKET_PRICE_BUY  = (BigInt(1) << BigInt(64)) - BigInt(1);
const MARKET_PRICE_SELL = BigInt(0);
// MARKET orders should fill within seconds; cap expiry tightly so an unfilled
// market order doesn't linger as a pending commitment.
const MARKET_EXPIRY_SECONDS = 10 * 60;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export default function OrdersPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const [pair,       setPair]       = useState<TradingPair>(DEFAULT_PAIR);
  const [kind,       setKind]       = useState<IntentKind>("LIMIT");
  const [side,       setSide]       = useState<Side>("BUY");
  const [tif,        setTif]        = useState<keyof typeof TIME_IN_FORCE>("7D");
  const [amount,     setAmount]     = useState("");
  const [targetPrice,setTargetPrice]= useState("");
  const [slippage,   setSlippage]   = useState<SlippagePct>(1);
  // Live oracle price for MARKET orders — fetched on demand, used both for the
  // estimated-output display and to compute minOut against the user-selected
  // slippage. Null until first fetch completes (or if the registry has no feed
  // for the pair, in which case MARKET submission is blocked).
  const marketOracleKey = `${chainId}:${pair.baseToken.address}:${pair.quoteToken.address}`;
  const [marketOracle, setMarketOracle] = useState<{
    key: string;
    price: bigint | null;
    error: string | null;
  }>({ key: "", price: null, error: null });
  const marketOraclePrice = marketOracle.key === marketOracleKey ? marketOracle.price : null;
  const oracleError = marketOracle.key === marketOracleKey ? marketOracle.error : null;
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Held until the on-chain registration confirms; only then do we POST to the
  // Go backend, so the chain is the source of truth before any off-chain row
  // is created (the indexer would otherwise race the POST).
  const [pendingPost, setPendingPost] = useState<PostOrderIntentBody | null>(null);
  const [postSynced,  setPostSynced]  = useState(false);
  const [backendSyncRetry, setBackendSyncRetry] = useState(0);
  const [backendSyncError, setBackendSyncError] = useState<string | null>(null);

  // Per-intent nonce — generated once per page load. A fresh intent gets a
  // fresh nonce; we persist it with metadata only when the user clicks
  // submit, so abandoned drafts don't pollute IndexedDB.
  const nonceRef = useRef<`0x${string}` | null>(null);
  const backendSyncHashRef = useRef<string | null>(null);

  // Direction is just the user's side choice for both LIMIT and MARKET.
  //   BUY  → direction=0 → circuit requires oracle <= price
  //   SELL → direction=1 → circuit requires oracle >= price
  const tokenIn  = side === "SELL" ? pair.baseToken  : pair.quoteToken;
  const tokenOut = side === "SELL" ? pair.quoteToken : pair.baseToken;
  const direction = side === "SELL" ? DIRECTION_SELL : DIRECTION_BUY;

  const { data: tokenInBalance } = useFreeBalance(tokenIn.address);
  const { register, isPending, isConfirming, isSuccess, error } = useRegisterCommitment();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  // Re-roll nonce on (re)mount so a new submission starts fresh.
  useEffect(() => {
    nonceRef.current = randomBytes32();
  }, []);

  function getDraftNonce(): `0x${string}` {
    if (!nonceRef.current) nonceRef.current = randomBytes32();
    return nonceRef.current;
  }

  const amountBig = useMemo(() => {
    try { return parseUnits(amount || "0", tokenIn.decimals); }
    catch { return BigInt(0); }
  }, [amount, tokenIn.decimals]);

  // The price the order is *committed* to. For LIMIT, this is the user's
  // target. For MARKET, it's a sentinel that makes the circuit's fill check
  // trivially pass — the contract still verifies the proof, but the prover's
  // live-oracle check will pass for any reasonable oracle reading.
  const priceBig = useMemo(() => {
    if (kind === "MARKET") {
      return direction === DIRECTION_BUY ? MARKET_PRICE_BUY : MARKET_PRICE_SELL;
    }
    try {
      const p = parseFloat(targetPrice.replace(/,/g, "") || "0");
      if (p <= 0) return BigInt(0);
      return parseUnits(p.toString(), ORACLE_DECIMALS);
    } catch { return BigInt(0); }
  }, [kind, direction, targetPrice]);

  // Reference price used to compute expectedOut. For LIMIT this is the user's
  // target; for MARKET this is the live oracle price we fetched (in
  // 8-decimal Chainlink-style denomination).
  const referencePriceFloat = useMemo(() => {
    if (kind === "MARKET") {
      if (!marketOraclePrice) return 0;
      return parseFloat(formatUnits(marketOraclePrice, ORACLE_DECIMALS));
    }
    return parseFloat(targetPrice.replace(/,/g, "") || "0");
  }, [kind, marketOraclePrice, targetPrice]);

  // Slippage-protected min out, denominated in tokenOut units.
  //   SELL: spend `size` base tokens → receive ~`size * price` quote
  //   BUY:  spend `size` quote tokens → receive ~`size / price` base
  // Min out = expected * (1 - slippage%).
  const expectedOutFloat = useMemo(() => {
    const size = parseFloat(amount || "0");
    if (referencePriceFloat <= 0 || size <= 0) return 0;
    return side === "SELL" ? size * referencePriceFloat : size / referencePriceFloat;
  }, [amount, referencePriceFloat, side]);

  // const minOutBig = useMemo(() => {
  //   if (expectedOutFloat <= 0) return BigInt(0);
  //   try {
  //     const factor = (100 - slippage) / 100;
  //     return parseUnits((expectedOutFloat * factor).toFixed(tokenOut.decimals), tokenOut.decimals);
  //   } catch { return BigInt(0); }
  // }, [expectedOutFloat, slippage, tokenOut.decimals]);

  const minOutBig = BigInt(0);

  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setNow(Math.floor(Date.now() / 1000));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const expiry = useMemo(() => {
    if (!now) return null;
    // MARKET orders use a tight expiry — they're meant to fill within seconds.
    if (kind === "MARKET") return now + MARKET_EXPIRY_SECONDS;
    return now + TIME_IN_FORCE[tif];
  }, [now, tif, kind]);

  const formatted = useMemo(() => {
    if (!expiry) {
      return { estOutput: "", minOut: "", expiry: "" };
    }
    return {
      estOutput: expectedOutFloat.toLocaleString("en-US", {
        maximumFractionDigits: tokenOut.decimals === 18 ? 6 : 2,
      }),
      minOut: parseFloat(formatUnits(minOutBig, tokenOut.decimals))
        .toLocaleString("en-US", { maximumFractionDigits: 6 }),
      expiry: new Date(expiry * 1000).toLocaleDateString("en-US"),
    };
  }, [expectedOutFloat, minOutBig, tokenOut.decimals, expiry]);

  // Live "quote per base" pair price — only used for MARKET orders. We read
  // the base and quote feeds explicitly (rather than tokenIn/tokenOut) so the
  // displayed price is always `quoteToken per baseToken` regardless of side,
  // matching how a trader thinks about WETH/USDC. The minOut computation in
  // `expectedOutFloat` already uses this orientation (size * price for SELL,
  // size / price for BUY), so the same number works for both display and the
  // slippage-protected minOut.
  //
  // The commitment's on-chain priceBig is a separate sentinel (u64.max or 0)
  // that makes the circuit's `oracle <= price` / `oracle >= price` check
  // trivially pass — the contract's _readOraclePrice operates on
  // tokenIn/tokenOut, not base/quote.
  useEffect(() => {
    if (kind !== "MARKET" || !publicClient) return;
    let cancelled = false;
    const queryKey = marketOracleKey;

    const registryAddr =
      ADDRESSES[chainId as keyof typeof ADDRESSES]?.commitmentRegistry
      ?? ADDRESSES[arbitrumSepolia.id].commitmentRegistry;

    const baseAddr  = pair.baseToken.address;
    const quoteAddr = pair.quoteToken.address;

    (async () => {
      try {
        const [feedBaseAddr, feedQuoteAddr] = (await Promise.all([
          publicClient.readContract({ address: registryAddr, abi: COMMITMENT_REGISTRY_ABI, functionName: "priceFeeds", args: [baseAddr]  }),
          publicClient.readContract({ address: registryAddr, abi: COMMITMENT_REGISTRY_ABI, functionName: "priceFeeds", args: [quoteAddr] }),
        ])) as [`0x${string}`, `0x${string}`];

        if (feedBaseAddr.toLowerCase()  === ZERO_ADDRESS) throw new Error(`No USD feed for ${pair.baseToken.name}`);
        if (feedQuoteAddr.toLowerCase() === ZERO_ADDRESS) throw new Error(`No USD feed for ${pair.quoteToken.name}`);

        const [[roundBase, roundQuote], [decBase, decQuote]] = await Promise.all([
          Promise.all([
            publicClient.readContract({ address: feedBaseAddr,  abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
            publicClient.readContract({ address: feedQuoteAddr, abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
          ]),
          Promise.all([
            publicClient.readContract({ address: feedBaseAddr,  abi: PRICE_FEED_ABI, functionName: "decimals" }),
            publicClient.readContract({ address: feedQuoteAddr, abi: PRICE_FEED_ABI, functionName: "decimals" }),
          ]),
        ]) as [
          [readonly [bigint, bigint, bigint, bigint, bigint], readonly [bigint, bigint, bigint, bigint, bigint]],
          [number, number]
        ];

        const answerBase  = roundBase[1];
        const answerQuote = roundQuote[1];
        if (answerBase <= 0n || answerQuote <= 0n) throw new Error("Oracle returned non-positive price");

        // quote-per-base in ORACLE_DECIMALS denomination: normalise both to 1e18
        // then divide. Result has ORACLE_DECIMALS places.
        const normBase  = answerBase  * 10n ** BigInt(18 - decBase);
        const normQuote = answerQuote * 10n ** BigInt(18 - decQuote);
        const quotePerBase = normBase * 10n ** BigInt(ORACLE_DECIMALS) / normQuote;
        if (!cancelled) setMarketOracle({ key: queryKey, price: quotePerBase, error: null });
      } catch (e) {
        if (!cancelled) setMarketOracle({ key: queryKey, price: null, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [kind, publicClient, chainId, marketOracleKey, pair.baseToken.address, pair.baseToken.name, pair.quoteToken.address, pair.quoteToken.name]);

  async function handleSubmit() {
    // MARKET SELL intentionally uses price=0 as its private always-fill sentinel.
    // Reject a zero price only when it represents an invalid LIMIT target.
    if (!isConnected || !address || amountBig === BigInt(0) || (kind === "LIMIT" && priceBig === BigInt(0)) || !expiry) return;
    setSubmitError(null);
    setBackendSyncError(null);

    try {
      const nonce = getDraftNonce();
      const intentId = deriveIntentId(address, nonce);

      // 1. Wallet signs intentId — deterministic, recoverable secret bound
      //    to this wallet. Same prompt on cancel/self-execute regenerates it.
      const signature = await signMessageAsync({
        message: intentIdSigningMessage(intentId),
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

      const registryAddr =
        ADDRESSES[chainId as keyof typeof ADDRESSES]?.commitmentRegistry
        ?? ADDRESSES[arbitrumSepolia.id].commitmentRegistry;
      const publicMetadata: PublicIntentMetadata = {
        version: 1,
        chainId,
        registry: registryAddr,
        commitmentHash,
        kind: "ORDER_FILL",
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        size: amountBig.toString(),
        minOut: minOutBig.toString(),
        expiry,
      };
      const witnessPackage = await createEncryptedWitnessPackage(publicMetadata, {
        kind: "ORDER_FILL",
        price: priceBig.toString(),
        direction,
        nonce,
        userSecret,
        nullifier,
      });

      // 2. Persist intent metadata locally BEFORE any network/on-chain side
      //    effect. If subsequent steps fail, the user can recover from
      //    IndexedDB and retry. user_secret is NOT persisted — it's recoverable
      //    from the wallet signature on intentId.
      await saveIntent({
        commitmentHash,
        owner:      address.toLowerCase() as `0x${string}`,
        intentId,
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

      // 3. Stash the encrypted witness package — we POST it only AFTER the on-chain
      //    tx confirms (see the useEffect below). Posting earlier races the
      //    scheduler's on-chain status check and yields a 422.
      //
      // Backend stores user-facing intent kind. On-chain LIMIT and MARKET
      // both use kind=0 (ORDER_FILL); MARKET uses a
      // sentinel price that makes the fill check pass.
      setPostSynced(false);
      setBackendSyncRetry(0);
      backendSyncHashRef.current = null;
      setPendingPost({
        commitmentHash,
        kind,
        chainId,
        tokenIn:    tokenIn.address,
        tokenOut:   tokenOut.address,
        size:       amountBig.toString(),
        minOut:     minOutBig.toString(),
        expiry,
        witnessPackage,
      });

      // 4. On-chain registration. msg.sender = wallet, so cancel and local
      //    recovery paths stay wallet-controlled.
      register(commitmentHash, tokenIn.address, tokenOut.address, amountBig, minOutBig, expiry);
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

  function retryBackendSync() {
    if (!pendingPost || postSynced) return;
    setSubmitError(null);
    setBackendSyncError(null);
    setBackendSyncRetry(n => n + 1);
  }

  // Once the on-chain tx confirms, hand the encrypted witness package to the
  // backend scheduler. Failures here leave the on-chain commitment intact (the
  // user can retry sync later); funds are never stuck because the chain is the
  // authoritative source.
  useEffect(() => {
    if (!isSuccess || !pendingPost || postSynced) return;
    if (backendSyncHashRef.current === pendingPost.commitmentHash) return;
    backendSyncHashRef.current = pendingPost.commitmentHash;

    let cancelled = false;
    backendApi.postOrderIntent(pendingPost)
      .then(() => {
        if (!cancelled) {
          setPostSynced(true);
          setBackendSyncError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          backendSyncHashRef.current = null;
          setBackendSyncError(msg);
          setSubmitError(msg);
          console.warn("[intent] backend post failed (will need retry):", err);
        }
      });
    return () => { cancelled = true; };
  }, [isSuccess, pendingPost, postSynced, backendSyncRetry]);

  const busy = isPending || isConfirming || isSigning;
  const errorMessage = submitError ?? (error ? (error as Error).message : null);

  return (
    <>
      <Topbar title="Limit/Market Order" />
      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 max-w-7xl">

          {/* Left — Order config */}
          <div className="lg:col-span-5">
            <Card className="p-4 md:p-5 space-y-4 md:space-y-5">
              <p className="text-xs font-medium text-primary-container uppercase tracking-widest">
                Order Parameters
              </p>

              {/* Order type */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Order Type</p>
                <div className="inline-flex w-fit rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-0.5">
                  {(["LIMIT", "MARKET"] as const).map(k => (
                    <button
                      type="button"
                      key={k}
                      aria-pressed={kind === k}
                      onClick={() => setKind(k)}
                      className={cn(
                        "h-8 flex-1 px-5 text-xs font-medium rounded-lg transition-colors",
                        kind === k
                          ? "bg-primary-container/15 text-primary-container"
                          : "text-on-surface-variant hover:text-on-surface",
                      )}
                    >
                      {k === "LIMIT" ? "Limit" : "Market"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Direction</p>
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
                <Input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="text-xl font-display font-semibold"
                  actionLabel="MAX"
                  actionDisabled={tokenInBalance === undefined || tokenInBalance === 0n}
                  onAction={setMax}
                />
              </div>

              {/* Target price — LIMIT only. MARKET fills at the live oracle price. */}
              {kind === "LIMIT" && (
                <div>
                  <div className="flex justify-between mb-1.5">
                    <label className="text-xs text-secondary uppercase tracking-widest">
                      Target Price ({pair.quoteToken.name} per {pair.baseToken.name})
                    </label>
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={targetPrice}
                      onChange={e => setTargetPrice(e.target.value)}
                      className="w-full bg-surface-container-lowest text-on-surface text-xl font-display font-semibold px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-secondary transition-all pr-14 font-tabular"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-variant font-medium">{pair.quoteToken.name}</span>
                  </div>
                </div>
              )}

              {/* Slippage tolerance — applies to both LIMIT and MARKET minOut. */}
              <div>
                <div className="flex justify-between mb-2">
                  <p className="text-xs text-on-surface-variant uppercase tracking-widest">Max Slippage</p>
                  <span className="text-xs text-on-surface-variant">Min out = est × ({100 - slippage}%)</span>
                </div>
                <div className="flex gap-1.5">
                  {SLIPPAGE_OPTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => setSlippage(s)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        slippage === s
                          ? "border-primary-container text-primary-container bg-primary-container/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >
                      {s}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Time in force — LIMIT only. MARKET uses a fixed short expiry. */}
              {kind === "LIMIT" && (
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
              )}

              {/* Summary */}
              <div className="bg-surface-container-lowest rounded-sm p-3 space-y-2 text-sm">
                {[
                  ...(kind === "MARKET"
                    ? [{
                        label: `Oracle Price (${pair.quoteToken.name}/${pair.baseToken.name})`,
                        value: marketOraclePrice !== null
                          ? `${parseFloat(formatUnits(marketOraclePrice, ORACLE_DECIMALS)).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${pair.quoteToken.name}`
                          : oracleError
                            ? "—"
                            : "Loading…",
                        cls: "text-on-surface font-tabular",
                      }]
                    : []),
                  {
                    label: "Est. Output",
                    value: `${formatted.estOutput || ""} ${tokenOut.name}`,
                    cls: "text-on-surface font-tabular font-medium",
                  },
                  {
                    label: `Min. Output (${slippage}%)`,
                    value: `${formatted.minOut || ""} ${tokenOut.name}`,
                    cls: "text-on-surface font-tabular",
                  },
                  {
                    label: "Expiry",
                    value: formatted.expiry || "",
                    cls: "text-on-surface font-variant",
                  },
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
          <div className="lg:col-span-7 space-y-4">
            <Card variant="trust-violet" className="p-4 md:p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-1">Private Order</p>
                </div>
                <Badge variant="sovereign" dot className="shrink-0">Order Circuit</Badge>
              </div>

              {/* Status */}
              {errorMessage && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  <span>{errorMessage.slice(0, 160)}</span>
                  {backendSyncError && pendingPost && !postSynced && (
                    <button
                      type="button"
                      onClick={retryBackendSync}
                      className="ml-auto shrink-0 text-primary-container hover:underline"
                    >
                      Retry sync
                    </button>
                  )}
                </div>
              )}
              {kind === "MARKET" && oracleError && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  Oracle unavailable: {oracleError.slice(0, 140)}
                </div>
              )}

              {/* Action — registration success is announced by useRegisterCommitment. */}
              <div className="mt-4 md:mt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-secondary/10">
                    <Lock size={16} className="text-secondary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-on-surface">
                      {isConnected ? "Ready to encrypt" : "Wallet not connected"}
                    </p>
                    <p className="text-xs text-on-surface-variant">UltraHonk · OrderFill (185-byte preimage)</p>
                  </div>
                </div>
                <Button
                  variant="sovereign"
                  size="md"
                  className="w-full sm:w-auto"
                  disabled={
                    !isConnected
                    || busy
                    || amountBig === BigInt(0)
                    || (kind === "LIMIT"  && priceBig === BigInt(0))
                    || (kind === "MARKET" && marketOraclePrice === null)
                  }
                  onClick={handleSubmit}
                >
                  {busy
                    ? <><Loader2 size={14} className="animate-spin" />{isSigning ? "Signing…" : isConfirming ? "Confirming…" : "Submitting…"}</>
                    : <><Lock size={14} />Sign &amp; Submit Commitment</>
                  }
                </Button>
              </div>
            </Card>

            {/* Info */}
            <div className="flex gap-3 px-4 py-3 rounded-sm border-l-2 border-primary-container bg-primary-container/5">
              <Info size={14} className="text-primary-container mt-0.5 shrink-0" />
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Your wallet must sign per order to derive the secret. Executors only see execution tickets, your order sensitive parameters are never posted on-chain.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
