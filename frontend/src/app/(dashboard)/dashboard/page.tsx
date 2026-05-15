"use client";

import { Topbar } from "@/components/layout/Topbar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { TrendingUp, Shield, Zap, Clock, Plus, Loader2, WifiOff } from "lucide-react";
import { useStats, useExecutions, useKeeperHealth } from "@/hooks/useBackendApi";
import { formatDistanceToNow } from "@/lib/timeUtils";
import { MyStrategies } from "@/components/MyStrategies";
import Link from "next/link";

function StatSkeleton() {
  return <div className="h-16 rounded-sm bg-surface-container-high animate-pulse" />;
}

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading, isError: statsError } = useStats();
  const { data: execData, isLoading: execLoading }                    = useExecutions(5, 0);
  const { data: keeper, isLoading: keeperLoading }                    = useKeeperHealth();

  const executions = execData?.data ?? [];

  const statCards = stats
    ? [
        { label: "Total Executions",  value: String(stats.total_executions), change: "All time",               up: null  },
        { label: "Success Rate",      value: `${stats.success_rate.toFixed(1)}%`, change: "Executed / total",  up: stats.success_rate >= 95 },
        { label: "Avg. Latency",      value: `${(stats.avg_latency_ms / 1000).toFixed(1)}s`, change: "Keeper → on-chain", up: null },
        { label: "Avg. Gas Used",     value: String(stats.avg_gas_used),     change: "Per execution",           up: null  },
      ]
    : null;

  return (
    <>
      <Topbar title="Command Center" />
      <div className="p-4 md:p-6 space-y-4 md:space-y-6">

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statsLoading
            ? Array.from({ length: 4 }).map((_, i) => <StatSkeleton key={i} />)
            : statsError
              ? (
                <div className="col-span-2 lg:col-span-4 flex items-center gap-2 text-xs text-on-surface-variant p-3 rounded-sm bg-surface-container border border-outline-variant/10">
                  <WifiOff size={13} />
                  Backend offline — showing cached data
                </div>
              )
              : statCards!.map((stat) => (
                <Card key={stat.label} className="p-3 md:p-4">
                  <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-1.5 md:mb-2">
                    {stat.label}
                  </p>
                  <p className="font-display text-xl md:text-2xl font-semibold text-on-surface font-tabular">
                    {stat.value}
                  </p>
                  <div className="flex items-center gap-1 mt-1">
                    {stat.up === true && <TrendingUp size={11} className="text-primary-container" />}
                    <span className={`text-xs ${stat.up === true ? "text-primary-container" : "text-on-surface-variant"}`}>
                      {stat.change}
                    </span>
                  </div>
                </Card>
              ))
          }
        </div>

        {/* My local strategies (IndexedDB-backed; cancel + self-execute live here) */}
        <MyStrategies />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Executions table */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <div className="flex items-start sm:items-center justify-between gap-3">
                  <div>
                    <CardTitle>Recent Commitments</CardTitle>
                    <CardDescription>On-chain execution records</CardDescription>
                  </div>
                  <Link href="/strategy">
                    <Button variant="primary" size="sm" className="shrink-0">
                      <Plus size={14} />
                      <span className="hidden sm:inline">New Strategy</span>
                      <span className="sm:hidden">New</span>
                    </Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {execLoading ? (
                  <div className="flex items-center justify-center py-10 text-on-surface-variant">
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Loading…
                  </div>
                ) : executions.length === 0 ? (
                  <p className="text-xs text-on-surface-variant text-center py-10">No executions yet</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs md:text-sm min-w-[500px]">
                      <thead>
                        <tr className="border-b border-outline-variant/10">
                          {["Commitment", "Chain", "Status", "Gas Used", "Time"].map((h) => (
                            <th key={h} className="text-left px-3 md:px-4 py-2 text-xs text-on-surface-variant uppercase tracking-widest font-medium whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {executions.map((e) => (
                          <tr key={e.id} className="border-b border-outline-variant/5 hover:bg-surface-container-high/50 transition-colors">
                            <td className="px-3 md:px-4 py-3 font-tabular text-on-surface-variant text-xs">
                              {e.commitment_hash.slice(0, 6)}…{e.commitment_hash.slice(-4)}
                            </td>
                            <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                              {e.chain_id === 421614 ? "Arb Sepolia" : `Chain ${e.chain_id}`}
                            </td>
                            <td className="px-3 md:px-4 py-3 whitespace-nowrap">
                              <StatusChip status={e.status} />
                            </td>
                            <td className="px-3 md:px-4 py-3 text-on-surface font-tabular whitespace-nowrap">
                              {e.gas_used > 0 ? e.gas_used.toLocaleString() : "—"}
                            </td>
                            <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                              {formatDistanceToNow(e.registered_at)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Side cards */}
          <div className="flex flex-col gap-4">
            {/* Keeper health */}
            <Card variant="trust">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Keeper Node</CardTitle>
                  {keeperLoading ? (
                    <Loader2 size={12} className="animate-spin text-on-surface-variant" />
                  ) : (
                    <Badge variant={keeper?.online ? "primary" : "error"} dot>
                      {keeper?.online ? "Online" : "Offline"}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {[
                    { label: "Monitoring", value: keeper ? `${keeper.monitored_count} commitments` : "—" },
                    { label: "Executed",   value: keeper ? String(keeper.executed_count) : "—" },
                    { label: "Failed",     value: keeper ? String(keeper.failed_count)   : "—" },
                    { label: "Last seen",  value: keeper?.last_seen_at ? formatDistanceToNow(keeper.last_seen_at) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-on-surface-variant">{label}</span>
                      <span className="text-on-surface font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* ZK Privacy */}
            <Card variant="trust-violet">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield size={14} className="text-secondary" />
                  ZK Privacy
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {[
                    { label: "Proofs generated",   value: stats ? String(stats.total_executions) : "—" },
                    { label: "Avg. proof latency", value: stats ? `${(stats.avg_latency_ms / 1000).toFixed(1)}s` : "—" },
                    { label: "Circuits",           value: "OrderFill + DCA (UltraHonk)" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-on-surface-variant">{label}</span>
                      <span className="text-on-surface font-medium">{value}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <Zap size={12} className="text-secondary" />
                  <span className="text-xs text-secondary uppercase tracking-widest">Flashbots Protected</span>
                </div>
              </CardContent>
            </Card>

            {/* Recent executions mini list */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock size={14} className="text-on-surface-variant" />
                  Recent Executions
                </CardTitle>
              </CardHeader>
              <CardContent>
                {execLoading ? (
                  <div className="space-y-3">
                    {[1,2,3].map(i => <div key={i} className="h-8 rounded-sm bg-surface-container-high animate-pulse" />)}
                  </div>
                ) : executions.length === 0 ? (
                  <p className="text-xs text-on-surface-variant text-center py-2">No executions yet</p>
                ) : (
                  <div className="space-y-3 text-sm">
                    {executions.slice(0, 3).map((e) => (
                      <div key={e.id} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-tabular text-on-surface text-xs truncate">
                            {e.commitment_hash.slice(0, 10)}…
                          </p>
                          <p className="text-xs text-on-surface-variant capitalize">{e.status}</p>
                        </div>
                        <span className="text-xs text-on-surface-variant shrink-0">
                          {formatDistanceToNow(e.registered_at)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

