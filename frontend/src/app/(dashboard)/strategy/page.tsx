"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, useSignMessage, useChainId, usePublicClient } from "wagmi";
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
// swaps because the keeper executes against current oracle, not pool spot.
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

export default function StrategyPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const [pair,       setPair]       = useState<TradingPair>(DEFAULT_PAIR);
  const [kind,       setKind]       = useState<StrategyKind>("LIMIT");
  const [side,       setSide]       = useState<Side>("SELL");
  const [tif,        setTif]        = useState<keyof typeof TIME_IN_FORCE>("7D");
  const [amount,     setAmount]     = useState("");
  const [targetPrice,setTargetPrice]= useState("");
  const [slippage,   setSlippage]   = useState<SlippagePct>(1);
  // Live oracle price for MARKET orders — fetched on demand, used both for the
  // estimated-output display and to compute minOut against the user-selected
  // slippage. Null until first fetch completes (or if the registry has no feed
  // for the pair, in which case MARKET submission is blocked).
  const [marketOraclePrice, setMarketOraclePrice] = useState<bigint | null>(null);
  const [oracleError, setOracleError] = useState<string | null>(null);
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

  // Direction is just the user's side choice for both LIMIT and MARKET.
  //   BUY  → direction=0 → circuit requires oracle <= price
  //   SELL → direction=1 → circuit requires oracle >= price
  const tokenIn  = side === "SELL" ? pair.baseToken  : pair.quoteToken;
  const tokenOut = side === "SELL" ? pair.quoteToken : pair.baseToken;
  const direction = side === "SELL" ? DIRECTION_SELL : DIRECTION_BUY;

  const { data: tokenInBalance } = useFreeBalance(tokenIn.address);
  const { data: gasBalance }     = useGasBalance();
  const { register, isPending, isConfirming, isSuccess, error } = useRegisterCommitment();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const [formatted, setFormatted] = useState({
    estOutput: "",
    minOut: "",
    expiry: "",
  });

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

  // The price the order is *committed* to. For LIMIT, this is the user's
  // target. For MARKET, it's a sentinel that makes the circuit's fill check
  // trivially pass — the contract still verifies the proof, but the keeper's
  // re-verify against live oracle will pass for any reasonable oracle reading.
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

  const minOutBig = useMemo(() => {
    if (expectedOutFloat <= 0) return BigInt(0);
    try {
      const factor = (100 - slippage) / 100;
      return parseUnits((expectedOutFloat * factor).toFixed(tokenOut.decimals), tokenOut.decimals);
    } catch { return BigInt(0); }
  }, [expectedOutFloat, slippage, tokenOut.decimals]);

  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const expiry = useMemo(() => {
    if (!now) return null;
    // MARKET orders use a tight expiry — they're meant to fill within seconds.
    if (kind === "MARKET") return now + MARKET_EXPIRY_SECONDS;
    return now + TIME_IN_FORCE[tif];
  }, [now, tif, kind]);

  useEffect(() => {
  if (!expiry) return;
    setFormatted({
      estOutput: expectedOutFloat.toLocaleString(undefined, {
        maximumFractionDigits: tokenOut.decimals === 18 ? 6 : 2,
      }),
      minOut: parseFloat(formatUnits(minOutBig, tokenOut.decimals))
        .toLocaleString(undefined, { maximumFractionDigits: 6 }),
      expiry: new Date(expiry * 1000).toLocaleDateString(),
    });
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
    if (kind !== "MARKET" || !publicClient) {
      setMarketOraclePrice(null);
      setOracleError(null);
      return;
    }
    let cancelled = false;
    setOracleError(null);

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
        if (!cancelled) setMarketOraclePrice(quotePerBase);
      } catch (e) {
        if (!cancelled) {
          setMarketOraclePrice(null);
          setOracleError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [kind, publicClient, chainId, pair.baseToken.address, pair.baseToken.name, pair.quoteToken.address, pair.quoteToken.name]);

  async function handleSubmit() {
    if (!isConnected || !address || amountBig === BigInt(0) || priceBig === BigInt(0) || !expiry) return;
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
      //
      // For MARKET orders we tag the backend kind as "MARKET" so the monitor
      // service fires the keeper trigger immediately rather than polling
      // Chainlink. On-chain and from the keeper's perspective it is still
      // kind=0 (ORDER_FILL) — the sentinel price makes the fill check pass.
      setPostSynced(false);
      setPendingPost({
        commitmentHash,
        kind:       kind === "MARKET" ? "MARKET" : "ORDER_FILL",
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
                  {(["LIMIT", "MARKET"] as const).map(k => (
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
                      {k === "LIMIT" ? "Limit" : "Market"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Side */}
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
                          ? `${parseFloat(formatUnits(marketOraclePrice, ORACLE_DECIMALS)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${pair.quoteToken.name}`
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

              {/* Status */}
              {errorMessage && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  {errorMessage.slice(0, 160)}
                </div>
              )}
              {kind === "MARKET" && oracleError && !isSuccess && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  Oracle unavailable: {oracleError.slice(0, 140)}
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
                  disabled={
                    !isConnected
                    || busy
                    || amountBig === BigInt(0)
                    || isSuccess
                    || gasShortfall
                    || (kind === "LIMIT"  && priceBig === BigInt(0))
                    || (kind === "MARKET" && marketOraclePrice === null)
                  }
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
