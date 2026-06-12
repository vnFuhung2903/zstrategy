"use client";

import Link from "next/link";
import { Activity, BarChart3, Database, DollarSign, Loader2, Repeat2, Shield, WifiOff } from "lucide-react";
import { Topbar } from "@/components/layout/Topbar";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { StatusChip } from "@/components/ui/StatusChip";
import { useDashboardAnalytics } from "@/hooks/api/useDashboardApi";
import { useVaultTvl } from "@/hooks/useVaultTvl";
import { type DashboardDistributionItem, type IntentKind } from "@/lib/api";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { cn, formatUSD } from "@/lib/utils";

function formatCount(value: number | undefined) {
  return (value ?? 0).toLocaleString("en-US");
}

function kindLabel(kind: IntentKind) {
  if (kind === "LIMIT") return "Limit";
  if (kind === "MARKET") return "Market";
  return "DCA";
}

function MetricSkeleton() {
  return <div className="h-36 rounded-md bg-surface-container-high animate-pulse" />;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  variant = "default",
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof DollarSign;
  variant?: "default" | "trust" | "sovereign";
}) {
  return (
    <Card
      variant={variant === "trust" ? "trust" : "default"}
      className={cn(
        "h-36 p-4 md:p-5 flex flex-col justify-between overflow-hidden",
        variant === "sovereign" && "bg-surface-container-low hover:bg-surface-container-high",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-on-surface-variant uppercase tracking-widest">{label}</p>
        <Icon
          size={17}
          className={cn(
            "shrink-0",
            variant === "trust" ? "text-primary-container" : variant === "sovereign" ? "text-secondary" : "text-on-surface-variant",
          )}
        />
      </div>
      <div>
        <p className="font-display text-2xl md:text-3xl font-semibold text-on-surface font-tabular tracking-tight">
          {value}
        </p>
        <p className="mt-1 text-xs text-on-surface-variant">{detail}</p>
      </div>
    </Card>
  );
}

function distributionTotal(item: DashboardDistributionItem) {
  return item.total > 0 ? item.total : item.pending + item.executed + item.cancelled + item.expired;
}

export default function DashboardPage() {
  const dashboard = useDashboardAnalytics();
  const vaultTvl = useVaultTvl();
  const analytics = dashboard.data;
  const distribution = analytics?.intent_distribution ?? [];
  const distributionSum = distribution.reduce((sum, item) => sum + distributionTotal(item), 0);
  const recentActivity = analytics?.recent_activity ?? [];
  const hasOverviewError = dashboard.isError || vaultTvl.isError;

  return (
    <>
      <Topbar title="Global Analytics" />
      <div className="p-4 md:p-6 space-y-5 md:space-y-6 max-w-7xl">
        {hasOverviewError && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant p-3 rounded-sm bg-surface-container border border-outline-variant/10">
            <WifiOff size={13} />
            Some dashboard data is unavailable. Start the backend and connect to the configured chain for live values.
          </div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
          {dashboard.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => <MetricSkeleton key={i} />)
          ) : (
            <>
              <MetricCard
                label="Global Vault TVL"
                value={vaultTvl.isLoading ? "..." : vaultTvl.isError ? "Unavailable" : formatUSD(vaultTvl.totalUsd)}
                detail="Total collateral held by vault"
                icon={DollarSign}
                variant="trust"
              />
              <MetricCard
                label="Total Executions"
                value={formatCount(analytics?.total_executions)}
                detail="Indexed private intent settlements"
                icon={Database}
              />
              <MetricCard
                label="Pending Order Fill Commitments"
                value={formatCount(analytics?.pending_order_fill_commitments)}
                detail="Limit and market commitments awaiting fill"
                icon={Shield}
              />
              <MetricCard
                label="Pending DCA Commitments"
                value={formatCount(analytics?.pending_dca_commitments)}
                detail="Scheduled DCA rounds awaiting proof"
                icon={Repeat2}
                variant="sovereign"
              />
            </>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4">
          <Card className="p-4 md:p-5 bg-surface-container-low hover:bg-surface-container-low">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest">Intent Distribution</p>
                <p className="mt-1 text-sm text-on-surface-variant">
                  Indexed intent classes with pending backend commitments included.
                </p>
              </div>
              <Badge variant="primary" dot>Live</Badge>
            </div>

            {dashboard.isLoading ? (
              <div className="h-56 rounded-sm bg-surface-container-high animate-pulse" />
            ) : distributionSum === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center gap-2 text-on-surface-variant">
                <BarChart3 size={18} />
                <p className="text-xs">No intent distribution data yet</p>
              </div>
            ) : (
              <>
                <div className="h-56 flex items-end gap-3 md:gap-5">
                  {distribution.map((item) => {
                    const total = distributionTotal(item);
                    const pct = distributionSum > 0 ? Math.round((total / distributionSum) * 100) : 0;
                    return (
                      <div key={item.kind} className="flex-1 min-w-0 flex flex-col items-center gap-2">
                        <div className="w-full h-44 flex items-end">
                          <div
                            className={cn(
                              "w-full rounded-t-sm bg-surface-container-highest hover:bg-surface-bright transition-colors",
                              item.kind === "DCA" && "bg-secondary-container/35 hover:bg-secondary-container/50",
                              item.kind === "MARKET" && "bg-primary-container/25 hover:bg-primary-container/35",
                            )}
                            style={{ height: `${Math.max(pct, 8)}%` }}
                            title={`${kindLabel(item.kind)}: ${total}`}
                          />
                        </div>
                        <div className="text-center">
                          <p className="text-xs text-on-surface uppercase tracking-widest truncate">{kindLabel(item.kind)}</p>
                          <p className="text-xs text-on-surface-variant font-tabular">{pct}% / {formatCount(total)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {distribution.map((item) => (
                    <div key={item.kind} className="rounded-sm bg-surface p-3">
                      <p className="text-xs text-on-surface-variant uppercase tracking-widest">{kindLabel(item.kind)}</p>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                        <span className="text-on-surface-variant">Executed</span>
                        <span className="font-tabular text-on-surface">{formatCount(item.executed)}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                        <span className="text-on-surface-variant">Pending</span>
                        <span className="font-tabular text-secondary">{formatCount(item.pending)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </section>

        <section className="rounded-md bg-surface-container-low p-4 md:p-5">
          <div className="flex items-start sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Activity size={15} className="text-on-surface-variant" />
              <p className="text-xs text-on-surface-variant uppercase tracking-widest">
                Recent Executions
              </p>
            </div>
            <Link href="/activity" className="text-xs text-primary-container hover:text-primary uppercase tracking-widest font-semibold whitespace-nowrap">
              View full activity
            </Link>
          </div>

          {dashboard.isLoading ? (
            <div className="flex items-center justify-center py-14 text-on-surface-variant gap-2">
              <Loader2 size={16} className="animate-spin" />
              Loading activity...
            </div>
          ) : recentActivity.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-on-surface-variant gap-2">
              <Activity size={16} />
              <p className="text-xs">No recent activity found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead>
                  <tr className="border-b border-outline-variant/10">
                    {["Commitment", "Type", "Status", "Tx", "Time"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-xs text-on-surface-variant uppercase tracking-widest font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentActivity.map((item) => (
                    <tr key={item.id} className="border-b border-outline-variant/5 hover:bg-surface-container transition-colors">
                      <td className="px-3 py-3 font-tabular text-on-surface-variant whitespace-nowrap">
                        {item.commitment_ref}
                      </td>
                      <td className="px-3 py-3 text-on-surface whitespace-nowrap">
                        {kindLabel(item.kind)}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <StatusChip status={item.status} />
                      </td>
                      <td className="px-3 py-3 font-tabular text-on-surface-variant whitespace-nowrap">
                        {item.tx_ref || "-"}
                      </td>
                      <td className="px-3 py-3 text-on-surface-variant whitespace-nowrap">
                        {formatDistanceToNow(item.occurred_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
