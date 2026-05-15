"use client";

import { Topbar } from "@/components/layout/Topbar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Lock, AlertTriangle, MoreVertical } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { cn } from "@/lib/utils";
import { VaultPanel } from "@/components/wallet/VaultPanel";
import { GasTankPanel } from "@/components/GasTankPanel";
import { useFreeBalance } from "@/hooks/useVault";
import { TOKENS } from "@/lib/contracts";
import {
  listStrategiesForOwner,
  listDcaRoundsForOwner,
  type StrategyRecord,
  type DcaRoundRecord,
} from "@/lib/strategyStore";

type ActiveCommitment = {
  commitmentHash: `0x${string}`;
  label:          string;
  size:           string;     // bigint stringified
  tokenIn:        `0x${string}`;
  expiry:         number;
  kind:           "LIMIT" | "STOP_LOSS" | "TAKE_PROFIT" | "DCA";
  dcaGroupId?:    `0x${string}`;
  roundIndex?:    number;
};

const KIND_LABEL: Record<ActiveCommitment["kind"], string> = {
  LIMIT:       "Limit Order",
  STOP_LOSS:   "Stop-Loss",
  TAKE_PROFIT: "Take-Profit",
  DCA:         "DCA Round",
};

function tokenSymbol(addr: `0x${string}`): string {
  const a = addr.toLowerCase();
  if (a === TOKENS.WETH.toLowerCase()) return "WETH";
  if (a === TOKENS.USDC.toLowerCase()) return "USDC";
  if (a === TOKENS.USDT.toLowerCase()) return "USDT";
  if (a === TOKENS.WBTC.toLowerCase()) return "WBTC";
  return `${addr.slice(0, 6)}…`;
}

function tokenDecimals(addr: `0x${string}`): number {
  const a = addr.toLowerCase();
  if (a === TOKENS.WETH.toLowerCase()) return 18;
  if (a === TOKENS.USDC.toLowerCase()) return 6;
  if (a === TOKENS.USDT.toLowerCase()) return 6;
  if (a === TOKENS.WBTC.toLowerCase()) return 8;
  return 18;
}

function fmtAmount(sizeStr: string, decimals: number): string {
  try {
    return parseFloat(formatUnits(BigInt(sizeStr), decimals)).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
  } catch {
    return sizeStr;
  }
}

const tabs = ["Locked Collateral", "Available Balance"];

export default function VaultPage() {
  const [tab, setTab] = useState(0);
  const { address, isConnected } = useAccount();

  const [commitments, setCommitments] = useState<ActiveCommitment[]>([]);
  const [loadingCommitments, setLoadingCommitments] = useState(true);

  // Per-token free balances in the vault for the connected user.
  const { data: wethFree } = useFreeBalance(TOKENS.WETH);
  const { data: usdcFree } = useFreeBalance(TOKENS.USDC);
  const { data: usdtFree } = useFreeBalance(TOKENS.USDT);
  const { data: wbtcFree } = useFreeBalance(TOKENS.WBTC);

  useEffect(() => {
    let cancelled = false;
    if (!isConnected || !address) {
      setCommitments([]);
      setLoadingCommitments(false);
      return;
    }
    setLoadingCommitments(true);
    Promise.all([
      listStrategiesForOwner(address.toLowerCase() as `0x${string}`),
      listDcaRoundsForOwner(address.toLowerCase() as `0x${string}`),
    ])
      .then(([strategies, dcaRounds]) => {
        if (cancelled) return;
        const limitRows: ActiveCommitment[] = strategies.map((s: StrategyRecord) => ({
          commitmentHash: s.commitmentHash,
          label:          `${KIND_LABEL[s.kind]} · ${tokenSymbol(s.tokenIn)} → ${tokenSymbol(s.tokenOut)}`,
          size:           s.size,
          tokenIn:        s.tokenIn,
          expiry:         s.expiry,
          kind:           s.kind,
        }));
        const dcaRows: ActiveCommitment[] = dcaRounds.map((r: DcaRoundRecord) => ({
          commitmentHash: r.commitmentHash,
          label:          `DCA #${r.roundIndex + 1} · ${tokenSymbol(r.tokenIn)} → ${tokenSymbol(r.tokenOut)}`,
          size:           r.size,
          tokenIn:        r.tokenIn,
          expiry:         r.expiry,
          kind:           "DCA",
          dcaGroupId:     r.dcaGroupId,
          roundIndex:     r.roundIndex,
        }));
        // Newest first by expiry.
        const all = [...limitRows, ...dcaRows].sort((a, b) => b.expiry - a.expiry);
        setCommitments(all);
      })
      .catch(err => {
        console.warn("[Vault] failed to load commitments:", err);
        if (!cancelled) setCommitments([]);
      })
      .finally(() => { if (!cancelled) setLoadingCommitments(false); });
    return () => { cancelled = true; };
  }, [address, isConnected]);

  // Distinct strategy kinds across active commitments.
  const distinctKinds = new Set(commitments.map(c => c.kind)).size;

  // Per-token rollup of free balance — render as a list rather than fabricate
  // a USD TVL number (we have no oracle for USDC/USDT/WBTC pairs configured).
  const tokenBalances = [
    { symbol: "WETH", raw: wethFree, decimals: 18 },
    { symbol: "USDC", raw: usdcFree, decimals: 6  },
    { symbol: "USDT", raw: usdtFree, decimals: 6  },
    { symbol: "WBTC", raw: wbtcFree, decimals: 8  },
  ];

  return (
    <>
      <Topbar title="Vault Security" />
      <div className="p-4 md:p-6 space-y-4 max-w-7xl">

        {/* Hero */}
        <Card className="relative overflow-hidden p-4 md:p-6">
          <div className="absolute top-0 right-0 w-64 h-64 bg-secondary-container/10 blur-3xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Secure Collateral Layer</p>
              <h2 className="font-display text-2xl md:text-3xl font-semibold text-primary-container tracking-tight">
                Vault Security
              </h2>
              <p className="text-sm text-on-surface-variant mt-2 max-w-md">
                All collateral is locked in non-custodial smart contracts. Only ZK proofs can authorize fund movement.
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <Badge variant="primary" dot>System Optimal</Badge>
                <Badge variant="sovereign" dot>ZKP Active</Badge>
              </div>
            </div>
            {/* Animated lock */}
            <div className="relative w-20 h-20 md:w-28 md:h-28 hidden sm:flex items-center justify-center shrink-0">
              <div className="absolute inset-0 rounded-full border border-primary-container/20 animate-spin" style={{ animationDuration: "20s" }} />
              <div className="absolute inset-2 rounded-full border border-dashed border-secondary/20 animate-spin" style={{ animationDuration: "15s", animationDirection: "reverse" }} />
              <div className="absolute inset-5 rounded-full border border-dotted border-primary-container/10 animate-spin" style={{ animationDuration: "30s" }} />
              <Lock size={24} className="text-primary-container drop-shadow-[0_0_8px_rgba(0,240,255,0.5)]" />
            </div>
          </div>
        </Card>

        {/* Circuit breaker */}
        <div className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4 p-4 rounded-sm bg-surface-container border-l-4 border-error-container">
          <div className="w-8 h-8 rounded-full bg-error-container flex items-center justify-center shrink-0">
            <AlertTriangle size={14} className="text-error" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-on-surface">Global Circuit Breaker</p>
            <p className="text-xs text-on-surface-variant mt-0.5">
              Emergency protocol to halt all strategy execution and enable collateral withdrawal.
            </p>
          </div>
          <Button variant="danger" size="sm" className="shrink-0 w-full sm:w-auto">
            Initiate Halt
          </Button>
        </div>

        {/* Tabs */}
        <div className="border-b border-outline-variant/10 overflow-x-auto">
          <div className="flex gap-4 md:gap-6 min-w-max">
            {tabs.map((t, i) => (
              <button
                key={t}
                onClick={() => setTab(i)}
                className={cn(
                  "pb-3 text-sm font-medium transition-colors whitespace-nowrap",
                  tab === i
                    ? "text-primary-container border-b-2 border-primary-container"
                    : "text-on-surface-variant hover:text-on-surface",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Card className="p-4">
            <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Active Commitments</p>
            <p className="font-display text-2xl md:text-3xl font-semibold text-on-surface font-tabular">
              {loadingCommitments ? "—" : commitments.length}
            </p>
            <p className="text-xs text-on-surface-variant mt-1">
              {loadingCommitments
                ? "Loading…"
                : distinctKinds === 0
                  ? "No commitments yet"
                  : `Across ${distinctKinds} distinct kind${distinctKinds === 1 ? "" : "s"}`}
            </p>
          </Card>

          <Card className="p-4">
            <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Free Vault Balance</p>
            <div className="space-y-1 mt-1">
              {!isConnected ? (
                <p className="text-xs text-on-surface-variant">Connect wallet to view balances</p>
              ) : (
                tokenBalances.map(t => (
                  <div key={t.symbol} className="flex justify-between text-sm">
                    <span className="text-on-surface-variant">{t.symbol}</span>
                    <span className="text-on-surface font-tabular">
                      {t.raw === undefined
                        ? "—"
                        : parseFloat(formatUnits(t.raw, t.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Deposit / Withdraw panels — collateral (ERC-20) + gas tank (native ETH) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <VaultPanel />
          <GasTankPanel />
        </div>

        {/* Commitments */}
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant uppercase tracking-widest">Active Commitments</p>
          {!isConnected ? (
            <p className="text-xs text-on-surface-variant">Connect wallet to view your active commitments.</p>
          ) : loadingCommitments ? (
            <p className="text-xs text-on-surface-variant">Loading…</p>
          ) : commitments.length === 0 ? (
            <p className="text-xs text-on-surface-variant">No active commitments. Create one from the Strategy or DCA page.</p>
          ) : (
            commitments.map((c) => {
              const decimals = tokenDecimals(c.tokenIn);
              const symbol   = tokenSymbol(c.tokenIn);
              const shortHash = `${c.commitmentHash.slice(0, 8)}…${c.commitmentHash.slice(-4)}`;
              return (
                <div
                  key={c.commitmentHash}
                  className="flex items-center gap-3 md:gap-4 p-3 md:p-4 rounded-sm bg-surface-container hover:bg-surface-container-high transition-colors border-l-2 border-primary-container/40"
                >
                  <div className="w-8 h-8 md:w-9 md:h-9 rounded-sm bg-surface-container-highest flex items-center justify-center shrink-0">
                    <Lock size={15} className="text-primary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs md:text-sm font-medium text-on-surface truncate">{c.label}</p>
                    <p className="font-tabular text-xs mt-0.5 text-on-surface-variant">{shortHash}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs md:text-sm font-medium text-on-surface font-tabular">
                      {fmtAmount(c.size, decimals)} {symbol}
                    </p>
                    <p className="text-xs text-on-surface-variant">
                      Expires {new Date(c.expiry * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <button className="p-1 rounded-sm hover:bg-surface-container-highest text-on-surface-variant hidden sm:block">
                    <MoreVertical size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
