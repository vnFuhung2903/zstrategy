"use client";

import Link from "next/link";
import { Activity, ArrowRight, Clock, Database, DollarSign, Plus, Repeat2, Shield, TrendingUp, Wallet, WifiOff } from "lucide-react";
import { Topbar } from "@/components/layout/Topbar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useStats } from "@/hooks/useBackendApi";
import { useVaultTvl } from "@/hooks/useVaultTvl";
import { formatUSD } from "@/lib/utils";

function MetricSkeleton() {
  return <div className="h-24 rounded-sm bg-surface-container-high animate-pulse" />;
}

function metricValue(value: number | undefined, fallback = "0") {
  return value === undefined ? fallback : value.toLocaleString("en-US");
}

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading, isError: statsError } = useStats();
  const vaultTvl = useVaultTvl();

  const settled = stats
    ? stats.total_executions + stats.total_cancelled + stats.total_expired
    : 0;
  const limitCount = stats?.by_kind?.LIMIT?.total_registered ?? 0;
  const marketCount = stats?.by_kind?.MARKET?.total_registered ?? 0;
  const dcaCount = stats?.by_kind?.DCA?.total_registered ?? 0;

  const metrics = stats
    ? [
        { label: "Registered", value: metricValue(stats.total_registered), detail: "All commitments", icon: Database },
        { label: "Settled", value: metricValue(settled), detail: "Executed / cancelled / expired", icon: Shield },
        { label: "Success Rate", value: `${stats.success_rate.toFixed(1)}%`, detail: "Executed / settled", icon: TrendingUp },
        { label: "Avg. Latency", value: `${(stats.avg_latency_ms / 1000).toFixed(1)}s`, detail: "Registration to execution", icon: Clock },
      ]
    : [];

  return (
    <>
      <Topbar title="Command Center" />
      <div className="p-4 md:p-6 space-y-4 md:space-y-6 max-w-7xl">
        {(statsError || vaultTvl.isError) && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant p-3 rounded-sm bg-surface-container border border-outline-variant/10">
            <WifiOff size={13} />
            Some overview data is unavailable
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Link href="/vault" className="lg:col-span-2 group">
            <Card className="h-full p-4 md:p-5 transition-colors group-hover:border-primary-container/30">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">
                    Global Vault TVL
                  </p>
                  <p className="font-display text-3xl md:text-4xl font-semibold text-on-surface font-tabular">
                    {vaultTvl.isLoading ? "..." : formatUSD(vaultTvl.totalUsd)}
                  </p>
                  <p className="text-xs text-on-surface-variant mt-2">
                    Supported collateral held by the vault contract
                  </p>
                </div>
                <div className="w-10 h-10 rounded-sm bg-primary-container/10 text-primary-container flex items-center justify-center shrink-0">
                  <DollarSign size={18} />
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {vaultTvl.tokenValues.map((token) => (
                  <div key={token.symbol} className="p-2 rounded-sm bg-surface-container-high">
                    <p className="text-xs text-on-surface-variant">{token.symbol}</p>
                    <p className="text-sm text-on-surface font-tabular">
                      {token.valueUsd > 0 ? formatUSD(token.valueUsd) : "$0.00"}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          </Link>

          <Card className="p-4 md:p-5">
            <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-3">
              Quick Actions
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Link href="/orders">
                <Button variant="primary" size="sm" className="w-full">
                  <Plus size={14} />
                  Order
                </Button>
              </Link>
              <Link href="/dca">
                <Button variant="sovereign" size="sm" className="w-full">
                  <Repeat2 size={14} />
                  DCA
                </Button>
              </Link>
              <Link href="/vault">
                <Button variant="ghost" size="sm" className="w-full">
                  <Wallet size={14} />
                  Vault
                </Button>
              </Link>
              <Link href="/activity">
                <Button variant="ghost" size="sm" className="w-full">
                  <Activity size={14} />
                  Activity
                </Button>
              </Link>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statsLoading
            ? Array.from({ length: 4 }).map((_, i) => <MetricSkeleton key={i} />)
            : metrics.map(({ label, value, detail, icon: Icon }) => (
              <Card key={label} className="p-3 md:p-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <p className="text-xs text-on-surface-variant uppercase tracking-widest">{label}</p>
                  <Icon size={14} className="text-on-surface-variant" />
                </div>
                <p className="font-display text-xl md:text-2xl font-semibold text-on-surface font-tabular">
                  {value}
                </p>
                <p className="text-xs text-on-surface-variant mt-1">{detail}</p>
              </Card>
            ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Intent Mix</CardTitle>
              <CardDescription>Public commitment classes indexed by the backend</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Limit", value: limitCount },
                  { label: "Market", value: marketCount },
                  { label: "DCA", value: dcaCount },
                ].map((item) => (
                  <div key={item.label} className="p-3 rounded-sm bg-surface-container-high">
                    <p className="text-xs text-on-surface-variant">{item.label}</p>
                    <p className="text-lg font-semibold font-tabular text-on-surface">{item.value}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Link href="/activity" className="group">
            <Card className="h-full p-4 transition-colors group-hover:border-primary-container/30">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-on-surface">Open Activity</p>
                  <p className="text-xs text-on-surface-variant mt-1">
                    Search anonymized commitments and transactions
                  </p>
                </div>
                <ArrowRight size={16} className="text-on-surface-variant group-hover:text-primary-container" />
              </div>
            </Card>
          </Link>
        </div>
      </div>
    </>
  );
}
