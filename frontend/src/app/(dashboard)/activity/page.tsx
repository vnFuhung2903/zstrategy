"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, EyeOff, Loader2, Search, Shield, WifiOff } from "lucide-react";
import { Topbar } from "@/components/layout/Topbar";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { StatusChip } from "@/components/ui/StatusChip";
import { useExecutions } from "@/hooks/useBackendApi";
import { type ExecutionKind, type ExecutionStatus } from "@/lib/api";
import { formatDistanceToNow } from "@/lib/timeUtils";

const PAGE_SIZE = 20;

const STATUS_OPTIONS: Array<{ value: ExecutionStatus | ""; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "registered", label: "Registered" },
  { value: "executed", label: "Executed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const KIND_OPTIONS: Array<{ value: ExecutionKind | ""; label: string }> = [
  { value: "", label: "All kinds" },
  { value: "ORDER_FILL", label: "Order fill" },
  { value: "MARKET", label: "Market" },
  { value: "DCA", label: "DCA" },
];

const CHAIN_OPTIONS = [
  { value: 421614, label: "Arb Sepolia" },
] as const;

function kindLabel(kind: ExecutionKind) {
  if (kind === "ORDER_FILL") return "Order fill";
  if (kind === "MARKET") return "Market";
  return "DCA";
}

export default function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ExecutionStatus | "">("");
  const [kind, setKind] = useState<ExecutionKind | "">("");
  const [chainId, setChainId] = useState<number>(CHAIN_OPTIONS[0].value);

  const { data: execData, isLoading, isError } = useExecutions(PAGE_SIZE, offset, {
    q: query.trim(),
    status,
    kind,
    chainId,
  });

  const executions = execData?.data ?? [];
  const hasNext = executions.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  return (
    <>
      <Topbar title="Activity" />
      <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-7xl">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 px-4 py-3 rounded-sm trust-zone-violet border border-secondary/20">
          <EyeOff size={14} className="text-secondary shrink-0" />
          <p className="text-xs text-on-surface-variant flex-1">
            Activity is anonymized. Search uses commitment hashes and transaction hashes only.
          </p>
          <Badge variant="sovereign" dot className="shrink-0">Ownerless</Badge>
        </div>

        {isError && (
          <div className="flex items-center gap-2 text-xs text-on-surface-variant p-3 rounded-sm bg-surface-container border border-outline-variant/10">
            <WifiOff size={13} />
            Backend offline - start the Go server to see live activity
          </div>
        )}

        <Card className="p-3 md:p-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_150px_150px] gap-3">
            <Input
              label="Search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
              placeholder="Commitment hash or tx hash"
              suffix=""
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-on-surface-variant uppercase tracking-widest">Status</label>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as ExecutionStatus | "");
                  setOffset(0);
                }}
                className="w-full bg-surface-container-lowest text-on-surface text-sm px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container"
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-on-surface-variant uppercase tracking-widest">Kind</label>
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as ExecutionKind | "");
                  setOffset(0);
                }}
                className="w-full bg-surface-container-lowest text-on-surface text-sm px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-on-surface-variant uppercase tracking-widest">Chain</label>
              <select
                value={chainId}
                onChange={(e) => {
                  setChainId(Number(e.target.value));
                  setOffset(0);
                }}
                className="w-full bg-surface-container-lowest text-on-surface text-sm px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container"
              >
                {CHAIN_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
            <div className="flex items-center gap-2">
              <Shield size={14} className="text-on-surface-variant" />
              <p className="text-sm font-medium text-on-surface">Execution Log</p>
            </div>
            <span className="text-xs text-on-surface-variant">
              {executions.length > 0 ? `Showing ${offset + 1}-${offset + executions.length}` : "No rows"}
            </span>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-on-surface-variant gap-2">
              <Loader2 size={16} className="animate-spin" />
              Loading...
            </div>
          ) : executions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-2">
              <Search size={16} />
              <p className="text-xs">No activity found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs md:text-sm min-w-[760px]">
                <thead>
                  <tr className="border-b border-outline-variant/10">
                    {["Commitment", "Tx Hash", "Chain", "Kind", "Status", "Gas", "Registered", "Executed"].map((h) => (
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
                        {e.commitment_hash.slice(0, 8)}...{e.commitment_hash.slice(-6)}
                      </td>
                      <td className="px-3 md:px-4 py-3 font-tabular text-on-surface-variant text-xs whitespace-nowrap">
                        {e.tx_hash ? `${e.tx_hash.slice(0, 8)}...${e.tx_hash.slice(-6)}` : "-"}
                      </td>
                      <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                        {e.chain_id === 421614 ? "Arb Sepolia" : `Chain ${e.chain_id}`}
                      </td>
                      <td className="px-3 md:px-4 py-3 text-on-surface text-xs whitespace-nowrap">
                        {kindLabel(e.kind)}
                      </td>
                      <td className="px-3 md:px-4 py-3 whitespace-nowrap">
                        <StatusChip status={e.status} />
                      </td>
                      <td className="px-3 md:px-4 py-3 text-on-surface font-tabular whitespace-nowrap">
                        {e.gas_used > 0 ? e.gas_used.toLocaleString("en-US") : "-"}
                      </td>
                      <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                        {formatDistanceToNow(e.registered_at)}
                      </td>
                      <td className="px-3 md:px-4 py-3 text-on-surface-variant text-xs whitespace-nowrap">
                        {e.executed_at ? formatDistanceToNow(e.executed_at) : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

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
