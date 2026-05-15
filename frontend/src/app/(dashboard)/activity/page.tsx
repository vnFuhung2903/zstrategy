"use client";

import { useState } from "react";
import { Topbar } from "@/components/layout/Topbar";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusChip } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import { EyeOff, Shield, Loader2, WifiOff, ChevronLeft, ChevronRight } from "lucide-react";
import { useStats, useExecutions } from "@/hooks/useBackendApi";
import { formatDistanceToNow } from "@/lib/timeUtils";

const PAGE_SIZE = 20;

export default function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const { data: stats, isError: statsError } = useStats();
  const { data: execData, isLoading, isError: execError } = useExecutions(PAGE_SIZE, offset);

  const executions = execData?.data ?? [];
  const hasNext = executions.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  const statCards = [
    { label: "Total Executions", value: stats ? String(stats.total_executions) : "—" },
    { label: "Success Rate",     value: stats ? `${stats.success_rate.toFixed(1)}%` : "—" },
    { label: "Avg. Gas Used",    value: stats ? stats.avg_gas_used.toLocaleString() : "—" },
    { label: "Avg. Latency",     value: stats ? `${(stats.avg_latency_ms / 1000).toFixed(1)}s` : "—" },
  ];

  return (
    <>
      <Topbar title="Activity" />
      <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-7xl">

        {/* Privacy notice */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 px-4 py-3 rounded-sm trust-zone-violet border border-secondary/20">
          <EyeOff size={14} className="text-secondary shrink-0" />
          <p className="text-xs text-on-surface-variant flex-1">
            Only commitment hashes and execution timestamps are stored. Strategy parameters are never logged.
          </p>
          <Badge variant="sovereign" dot className="shrink-0">Anonymized</Badge>
        </div>

        {(statsError || execError) && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant p-3 rounded-sm bg-surface-container border border-outline-variant/10">
            <WifiOff size={13} />
            Backend offline — start the Go server to see live data
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {statCards.map((s) => (
            <Card key={s.label} className="p-3 md:p-4">
              <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-1.5 md:mb-2">{s.label}</p>
              <p className="font-display text-xl md:text-2xl font-semibold text-on-surface font-tabular">{s.value}</p>
            </Card>
          ))}
        </div>

        {/* Execution log */}
        <Card>
          <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-on-surface-variant" />
              <p className="text-sm font-medium text-on-surface">Execution Log</p>
            </div>
            <span className="text-xs text-on-surface-variant">
              Showing {offset + 1}–{offset + executions.length}
            </span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-on-surface-variant gap-2">
              <Loader2 size={16} className="animate-spin" />
              Loading…
            </div>
          ) : executions.length === 0 ? (
            <p className="text-xs text-on-surface-variant text-center py-16">No executions found</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs md:text-sm min-w-[560px]">
                <thead>
                  <tr className="border-b border-outline-variant/10">
                    {["Commitment", "Tx Hash", "Chain", "Status", "Gas", "Registered", "Executed"].map((h) => (
                      <th key={h} className="text-left px-3 md:px-4 py-2 text-xs text-on-surface-variant uppercase tracking-widest font-medium whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {executions.map((e) => (
                    <tr key={e.id} className="border-b border-outline-variant/5 hover:bg-surface-container-high/50 transition-colors">
                      <td className="px-3 md:px-4 py-3 font-tabular text-on-surface-variant text-xs whitespace-nowrap">
                        {e.commitment_hash.slice(0, 6)}…{e.commitment_hash.slice(-4)}
                      </td>
                      <td className="px-3 md:px-4 py-3 font-tabular text-on-surface-variant text-xs whitespace-nowrap">
                        {e.tx_hash ? `${e.tx_hash.slice(0, 6)}…${e.tx_hash.slice(-4)}` : "—"}
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
                      <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                        {e.executed_at ? formatDistanceToNow(e.executed_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-outline-variant/10">
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasPrev}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              <ChevronLeft size={14} />
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasNext}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
              <ChevronRight size={14} />
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
