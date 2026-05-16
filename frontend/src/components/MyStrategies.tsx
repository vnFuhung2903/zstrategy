"use client";

/**
 * My Strategies — reads strategy metadata from IndexedDB and lets the user
 * cancel or self-execute. Both paths re-derive `user_secret` from a fresh
 * wallet signature on the persisted `strategyId`, so nothing sensitive is
 * stored on disk and the user never has to "back up a key".
 *
 * Status is read on-chain via `getCommitment` so the row shows the
 * authoritative state (Pending / Executed / Cancelled / Expired) rather
 * than whatever IndexedDB last knew.
 */

import { useState, useEffect, useCallback } from "react";
import { useAccount, useSignMessage, useReadContract, useChainId, usePublicClient } from "wagmi";
import { formatUnits } from "viem";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Loader2, X, Zap, AlertCircle } from "lucide-react";
import { listStrategiesForOwner, deleteStrategy, type StrategyRecord, type StrategyKind } from "@/lib/strategyStore";
import {
  deriveUserSecret,
  nullifierHash as computeNullifier,
  strategyIdSigningMessage,
} from "@/lib/commitment";
import { useCancelCommitment, useExecuteCommitment } from "@/hooks/useRegistry";
import { ADDRESSES, COMMITMENT_REGISTRY_ABI, PRICE_FEED_ABI, TOKENS } from "@/lib/contracts";
import { generateOrderFillProof } from "@/lib/orderFillProof";
import { arbitrumSepolia } from "wagmi/chains";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Map a token address to its display symbol + decimals. Unknown tokens show
// the truncated address with a default of 18 decimals — accurate enough for
// the dashboard summary line; the on-chain record is authoritative.
function tokenInfo(addr: `0x${string}`): { symbol: string; decimals: number } {
  const a = addr.toLowerCase();
  if (a === TOKENS.WETH.toLowerCase()) return { symbol: "WETH", decimals: 18 };
  if (a === TOKENS.USDC.toLowerCase()) return { symbol: "USDC", decimals: 6 };
  return { symbol: `${addr.slice(0, 6)}…`, decimals: 18 };
}

const STATUS_LABEL = ["None", "Pending", "Executed", "Cancelled", "Expired"] as const;

const KIND_LABEL: Record<StrategyKind, string> = {
  LIMIT:       "Limit",
  STOP_LOSS:   "Stop-Loss",
  TAKE_PROFIT: "Take-Profit",
};

function KindBadge({ kind }: { kind: StrategyKind | undefined }) {
  const label = kind ? KIND_LABEL[kind] : "Limit";
  if (label === "Limit") return null;
  const cls =
    kind === "STOP_LOSS"
      ? "text-error bg-error/10"
      : "text-tertiary-container bg-tertiary-container/10";
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-sm ${cls}`}>{label}</span>;
}

function StatusBadge({ status }: { status: number }) {
  const label = STATUS_LABEL[status] ?? "Unknown";
  const cls =
    status === 1 ? "text-primary-container bg-primary-container/10" :
    status === 2 ? "text-tertiary-container bg-tertiary-container/10" :
    status === 3 ? "text-on-surface-variant bg-surface-container-high" :
    status === 4 ? "text-error bg-error/10" :
                   "text-on-surface-variant bg-surface-container-high";
  return <span className={`text-xs font-medium px-2 py-0.5 rounded-sm ${cls}`}>{label}</span>;
}

function StrategyRow({
  strategy,
  onCancelled,
}: {
  strategy: StrategyRecord;
  onCancelled: () => void;
}) {
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const { cancel, isPending: cancelPending, isConfirming: cancelConfirming } = useCancelCommitment();
  const { execute, isPending: execPending, isConfirming: execConfirming } = useExecuteCommitment();
  const [error, setError] = useState<string | null>(null);
  const [isProving, setIsProving] = useState(false);

  const publicClient = usePublicClient();
  const chainId = useChainId();
  const registryAddr =
    ADDRESSES[chainId as keyof typeof ADDRESSES]?.commitmentRegistry
    ?? ADDRESSES[arbitrumSepolia.id].commitmentRegistry;
  const { data: onChain } = useReadContract({
    address: registryAddr,
    abi: COMMITMENT_REGISTRY_ABI,
    functionName: "getCommitment",
    args: [strategy.commitmentHash],
    query: { refetchInterval: 15_000 },
  });
  const onChainStatus = (onChain?.status as number | undefined) ?? 0;

  const tokenInInfo  = tokenInfo(strategy.tokenIn);
  const tokenOutInfo = tokenInfo(strategy.tokenOut);
  const sizeBig = BigInt(strategy.size);
  const minOutBig = BigInt(strategy.minOut);
  const priceBig = BigInt(strategy.price);

  const recoverSecret = useCallback(async (): Promise<`0x${string}`> => {
    const signature = await signMessageAsync({
      message: strategyIdSigningMessage(strategy.strategyId),
    });
    return deriveUserSecret(signature);
  }, [signMessageAsync, strategy.strategyId]);

  async function handleCancel() {
    setError(null);
    try {
      const userSecret = await recoverSecret();
      const nullifier = computeNullifier(userSecret, strategy.nonce);
      cancel(strategy.commitmentHash, nullifier);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleExecute() {
    setError(null);
    if (!publicClient) {
      setError("Wallet provider not ready");
      return;
    }
    try {
      const userSecret = await recoverSecret();
      const nullifier = computeNullifier(userSecret, strategy.nonce);

      // Read per-token USD feeds from the registry, then derive the pair price
      // using the same formula as _readOraclePrice on-chain. The proof must be
      // generated with the exact same value the contract will compute at
      // execution time, or verification reverts.
      const [feedInAddr, feedOutAddr] = (await Promise.all([
        publicClient.readContract({
          address: registryAddr,
          abi: COMMITMENT_REGISTRY_ABI,
          functionName: "priceFeeds",
          args: [strategy.tokenIn],
        }),
        publicClient.readContract({
          address: registryAddr,
          abi: COMMITMENT_REGISTRY_ABI,
          functionName: "priceFeeds",
          args: [strategy.tokenOut],
        }),
      ])) as [`0x${string}`, `0x${string}`];

      if (feedInAddr.toLowerCase() === ZERO_ADDRESS)
        throw new Error("No USD price feed configured for tokenIn");
      if (feedOutAddr.toLowerCase() === ZERO_ADDRESS)
        throw new Error("No USD price feed configured for tokenOut");

      const [[roundIn, roundOut], [decimalsIn, decimalsOut]] = await Promise.all([
        Promise.all([
          publicClient.readContract({ address: feedInAddr,  abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
          publicClient.readContract({ address: feedOutAddr, abi: PRICE_FEED_ABI, functionName: "latestRoundData" }),
        ]),
        Promise.all([
          publicClient.readContract({ address: feedInAddr,  abi: PRICE_FEED_ABI, functionName: "decimals" }),
          publicClient.readContract({ address: feedOutAddr, abi: PRICE_FEED_ABI, functionName: "decimals" }),
        ]),
      ]) as [
        [readonly [bigint, bigint, bigint, bigint, bigint], readonly [bigint, bigint, bigint, bigint, bigint]],
        [number, number]
      ];

      const answerIn  = (roundIn  as readonly [bigint, bigint, bigint, bigint, bigint])[1];
      const answerOut = (roundOut as readonly [bigint, bigint, bigint, bigint, bigint])[1];
      if (answerIn  <= 0n) throw new Error("Oracle returned non-positive price for tokenIn");
      if (answerOut <= 0n) throw new Error("Oracle returned non-positive price for tokenOut");

      // Mirror _readOraclePrice: normalise to 1e18 then derive pair price with dOut decimal places.
      const normIn  = answerIn  * 10n ** BigInt(18 - decimalsIn);
      const normOut = answerOut * 10n ** BigInt(18 - decimalsOut);
      const answer  = normIn * 10n ** BigInt(decimalsOut) / normOut;

      setIsProving(true);
      const proof = await generateOrderFillProof({
        price:        BigInt(strategy.price),
        direction:    strategy.direction,
        nonce:        strategy.nonce,
        userSecret,
        commitmentHash: strategy.commitmentHash,
        oraclePrice:  answer,
        nullifier,
        tokenIn:      strategy.tokenIn,
        tokenOut:     strategy.tokenOut,
        size:         BigInt(strategy.size),
        minOut:       BigInt(strategy.minOut),
        expiry:       BigInt(strategy.expiry),
      });
      setIsProving(false);

      execute(strategy.commitmentHash, nullifier, proof);
    } catch (e) {
      setIsProving(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleForget() {
    await deleteStrategy(strategy.commitmentHash);
    onCancelled();
  }

  const busy = isSigning || cancelPending || cancelConfirming || execPending || execConfirming || isProving;
  const isPending = onChainStatus === 1;
  const directionLabel = strategy.direction === 0 ? "BUY" : "SELL";
  const sizeFmt = parseFloat(formatUnits(sizeBig, tokenInInfo.decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
  // Limit price is always 8-decimal (Chainlink ETH/USD feed convention).
  const priceFmt = parseFloat(formatUnits(priceBig, 8)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
  const minOutFmt = parseFloat(formatUnits(minOutBig, tokenOutInfo.decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });

  return (
    <div className="border-b border-outline-variant/10 last:border-b-0 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-tabular text-xs text-on-surface">
              {strategy.commitmentHash.slice(0, 10)}…{strategy.commitmentHash.slice(-6)}
            </p>
            <StatusBadge status={onChainStatus} />
            <KindBadge kind={strategy.kind} />
            <span className="text-xs font-medium text-secondary">{directionLabel}</span>
          </div>
          <p className="text-xs text-on-surface-variant mt-1">
            {sizeFmt} {tokenInInfo.symbol} → ≥ {minOutFmt} {tokenOutInfo.symbol} @ {priceFmt} · expires {new Date(strategy.expiry * 1000).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPending && (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={handleExecute}>
                {isProving || execPending || execConfirming
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Zap size={12} />}
                {isProving ? "Proving…" : "Self-Execute"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={handleCancel}>
                {cancelPending || cancelConfirming
                  ? <Loader2 size={12} className="animate-spin" />
                  : <X size={12} />}
                Cancel
              </Button>
            </>
          )}
          {!isPending && (
            <Button variant="ghost" size="sm" onClick={handleForget}>
              Forget
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-error">
          <AlertCircle size={12} /> {error.slice(0, 160)}
        </div>
      )}
    </div>
  );
}

export function MyStrategies() {
  const { address, isConnected } = useAccount();
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !address) {
      setStrategies([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    listStrategiesForOwner(address.toLowerCase() as `0x${string}`)
      .then(rows => {
        if (cancelled) return;
        // Newest first
        rows.sort((a, b) => b.createdAt - a.createdAt);
        setStrategies(rows);
      })
      .catch(err => {
        console.warn("[MyStrategies] failed to load:", err);
        if (!cancelled) setStrategies([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, isConnected, refreshTick]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Strategies</CardTitle>
        <CardDescription>Local-only — derived from your wallet, never sent to a server</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {!isConnected ? (
          <p className="text-xs text-on-surface-variant text-center py-6">Connect your wallet to see your strategies.</p>
        ) : loading ? (
          <div className="flex items-center justify-center py-6 text-on-surface-variant">
            <Loader2 size={14} className="animate-spin mr-2" /> Loading…
          </div>
        ) : strategies.length === 0 ? (
          <p className="text-xs text-on-surface-variant text-center py-6">No strategies yet — create one from the Strategy page.</p>
        ) : (
          strategies.map(s => (
            <StrategyRow
              key={s.commitmentHash}
              strategy={s}
              onCancelled={() => setRefreshTick(t => t + 1)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
