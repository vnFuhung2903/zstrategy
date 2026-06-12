"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  BadgeCheck,
  Clock3,
  Loader2,
  RadioTower,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Terminal,
  WifiOff,
  Zap,
} from "lucide-react";
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { useExecutorTickets } from "@/hooks/api/useExecutorApi";
import { useTxToast } from "@/hooks/useTxToast";
import { api, type ExecutorTicketEnvelope } from "@/lib/api";
import { COMMITMENT_REGISTRY_ABI } from "@/lib/contracts";
import { FEE_OVERRIDES } from "@/lib/wagmi";
import { cn, truncateAddress } from "@/lib/utils";

const UINT64_MAX = (1n << 64n) - 1n;

function parseUint64(raw: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be a uint64 decimal string`);
  }
  const value = BigInt(raw);
  if (value > UINT64_MAX) {
    throw new Error(`${name} exceeds uint64`);
  }
  return value;
}

function assertBytes32(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be bytes32 hex`);
  }
}

function assertHexData(value: string, name: string) {
  if (!/^0x[0-9a-fA-F]+$/.test(value) || value === "0x") {
    throw new Error(`${name} must be non-empty hex data`);
  }
}

function validateTicket(envelope: ExecutorTicketEnvelope, expectedChainId: number, executorAddress: `0x${string}`) {
  const { ticket } = envelope;
  const now = Math.floor(Date.now() / 1000);

  if (ticket.version !== 1) throw new Error(`unsupported ticket version ${ticket.version}`);
  if (ticket.ticketExpiresAt <= now) throw new Error("claimed ticket is expired");
  if (envelope.chainId !== expectedChainId || ticket.chainId !== expectedChainId) {
    throw new Error(`ticket chain does not match wallet network ${expectedChainId}`);
  }
  if (ticket.commitmentHash.toLowerCase() !== envelope.commitmentHash.toLowerCase()) {
    throw new Error("ticket commitmentHash does not match claim envelope");
  }
  if (ticket.registry.toLowerCase() !== envelope.registry.toLowerCase()) {
    throw new Error("ticket registry does not match claim envelope");
  }
  if (ticket.kind !== "ORDER_FILL" && ticket.kind !== "DCA") {
    throw new Error("ticket kind must be ORDER_FILL or DCA");
  }
  if (ticket.kind === "ORDER_FILL" && ticket.fillRef !== "0") {
    throw new Error("ORDER_FILL ticket must use fillRef 0");
  }
  if (ticket.executor && ticket.executor.toLowerCase() !== executorAddress.toLowerCase()) {
    throw new Error("ticket is bound to a different executor");
  }

  assertBytes32(ticket.commitmentHash, "ticket.commitmentHash");
  assertBytes32(ticket.nullifier, "ticket.nullifier");
  assertBytes32(ticket.packageHash, "ticket.packageHash");
  assertBytes32(ticket.proverId, "ticket.proverId");
  assertBytes32(ticket.proverReceipt.proverId, "ticket.proverReceipt.proverId");
  assertHexData(ticket.proof, "ticket.proof");
  assertHexData(ticket.proverReceipt.signature, "ticket.proverReceipt.signature");
  parseUint64(ticket.fillRef, "ticket.fillRef");
  if (ticket.proverReceipt.proverId.toLowerCase() !== ticket.proverId.toLowerCase()) {
    throw new Error("ticket proverReceipt does not match proverId");
  }
  if (ticket.proverReceipt.ticketExpiresAt !== ticket.ticketExpiresAt) {
    throw new Error("ticket proverReceipt expiry does not match ticket expiry");
  }
}

function formatExpires(expiresAt: number, now: number) {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "expired";
  if (remaining < 60) return `${remaining}s`;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function queueStatus(expiresAt: number, now: number) {
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired";
  if (remaining < 20) return "Hot";
  return "Claimable";
}

function TicketRow({
  ticket,
  selected,
  now,
  onSelect,
}: {
  ticket: ExecutorTicketEnvelope;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const status = queueStatus(ticket.ticketExpiresAt, now);
  const isDca = ticket.circuitKind === "DCA";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left p-4 rounded-sm transition-colors relative group",
        "bg-surface-container hover:bg-surface-container-high",
        isDca && "trust-zone-violet",
        selected && "outline outline-1 outline-primary-container/40 glow-primary",
      )}
    >
      <div className={cn("absolute left-0 top-0 bottom-0 w-1 bg-primary-container scale-y-0 group-hover:scale-y-100 transition-transform origin-top", selected && "scale-y-100")} />
      <div className="flex justify-between items-start gap-3 mb-3">
        <div className="min-w-0 flex items-center gap-2">
          <span
            className={cn(
              "shrink-0 bg-surface-container-highest px-2 py-0.5 rounded-sm text-[10px] font-bold tracking-wider uppercase border",
              status === "Hot"
                ? "text-tertiary-container border-tertiary-container/30"
                : "text-primary-container border-primary-container/20",
            )}
          >
            {status}
          </span>
          <span className="font-tabular text-xs text-on-surface-variant truncate">
            {truncateAddress(ticket.commitmentHash, 8)}
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider mb-0.5">
            Circuit
          </div>
          <div className={cn("text-sm font-bold font-tabular", isDca ? "text-secondary" : "text-tertiary-container")}>
            {ticket.circuitKind}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-on-surface-variant">
        <span className="flex items-center gap-1">
          <RadioTower size={13} />
          Chain {ticket.chainId}
        </span>
        <span className="flex items-center gap-1">
          <Clock3 size={13} />
          Expires in {formatExpires(ticket.ticketExpiresAt, now)}
        </span>
        <span className="flex items-center gap-1">
          <ShieldCheck size={13} />
          {ticket.intentKind}
        </span>
      </div>
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[10px] uppercase tracking-widest text-outline shrink-0">{label}</span>
      <span className="text-xs font-bold text-on-surface font-tabular truncate">{value}</span>
    </div>
  );
}

export default function ExecutorPage() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const queryClient = useQueryClient();
  const ticketsQuery = useExecutorTickets(20);
  const tickets = useMemo(() => ticketsQuery.data?.data ?? [], [ticketsQuery.data?.data]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [claimedTicket, setClaimedTicket] = useState<ExecutorTicketEnvelope | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { writeContractAsync, data: txHash, isPending: txPending, error: txError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useTxToast({
    hash: txHash,
    isConfirming,
    isSuccess,
    error: txError as Error | null,
    label: "Execute ticket",
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: ["executor-tickets"] });
  }, [isSuccess, queryClient]);

  const selectedReadyTicket = tickets.find(ticket => ticket.commitmentHash === selectedHash) ?? tickets[0] ?? null;
  const selected = selectedReadyTicket ?? claimedTicket;
  const hasFreshTickets = tickets.some(ticket => ticket.ticketExpiresAt > now);

  const claimAndExecute = useMutation({
    mutationFn: async () => {
      if (!isConnected || !address) {
        throw new Error("connect an executor wallet first");
      }
      const claimed = await api.claimExecutorTicket(chainId, address, selectedReadyTicket?.commitmentHash);
      if (!claimed) {
        return null;
      }
      validateTicket(claimed, chainId, address);
      setClaimedTicket(claimed);
      setSelectedHash(claimed.commitmentHash);

      const fillRef = parseUint64(claimed.ticket.fillRef, "fillRef");
      const args = [
        claimed.ticket.commitmentHash,
        claimed.ticket.nullifier,
        claimed.ticket.proof,
        fillRef,
        {
          proverId: claimed.ticket.proverReceipt.proverId,
          ticketExpiresAt: BigInt(claimed.ticket.proverReceipt.ticketExpiresAt),
          signature: claimed.ticket.proverReceipt.signature,
        },
      ] as const;

      await writeContractAsync({
        address: claimed.ticket.registry,
        abi: COMMITMENT_REGISTRY_ABI,
        functionName: "executeCommitment",
        args,
        ...FEE_OVERRIDES,
      });
      return claimed;
    },
    onSuccess: (claimed) => {
      if (!claimed) {
        toast.message("No claimable tickets", {
          description: "The executor queue is empty for this chain.",
        });
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Execution failed";
      toast.error("Executor action failed", { description: message.slice(0, 200) });
    },
  });

  const actionBusy = claimAndExecute.isPending || txPending || isConfirming;

  return (
    <>
      <Topbar title="Executor Node" />
      <div className="p-4 md:p-6 lg:p-8 space-y-6 max-w-[1500px]">
        <section className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b border-outline-variant/10 pb-6">
          <div>
            <h1 className="font-display text-4xl md:text-5xl font-bold text-on-surface mb-2">
              Executor Alpha
            </h1>
            <p className="text-on-surface-variant text-sm max-w-2xl">
              Claim execution tickets and submit their ZK proof bundles without receiving private witness data.
            </p>
          </div>
          <div className="flex items-center gap-3 bg-surface-container-highest px-4 py-2 rounded-sm border border-outline-variant/20">
            <span className={cn(
              "w-2 h-2 rounded-full",
              ticketsQuery.isError ? "bg-error" : "bg-primary-container animate-pulse shadow-[0_0_8px_rgba(0,240,255,0.8)]",
            )} />
            <span className="text-xs uppercase tracking-widest font-bold text-primary-container font-tabular">
              {ticketsQuery.isError ? "Backend Unavailable" : "Ticket Relay Online"}
            </span>
          </div>
        </section>

        {ticketsQuery.isError && (
          <div className="flex items-center gap-2 text-xs text-error p-3 rounded-sm bg-error-container/20 border border-error/20">
            <WifiOff size={14} />
            Backend ticket endpoint is unavailable.
          </div>
        )}

        <section className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          <div className="xl:col-span-7 flex flex-col bg-surface-container-low rounded-sm border border-outline-variant/10 min-h-[560px]">
            <div className="p-5 border-b border-outline-variant/10 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <div>
                <h2 className="font-display text-lg font-bold text-on-surface">Backend-Ready Ticket Queue</h2>
                <p className="text-xs text-on-surface-variant mt-1">
                  Registry checks still run at submission time.
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => ticketsQuery.refetch()}
                disabled={ticketsQuery.isFetching}
              >
                {ticketsQuery.isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </Button>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              {ticketsQuery.isLoading && (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-28 rounded-sm bg-surface-container animate-pulse" />
                ))
              )}

              {!ticketsQuery.isLoading && tickets.length === 0 && (
                <div className="h-full min-h-[320px] flex flex-col items-center justify-center text-center text-on-surface-variant">
                  <Terminal size={28} className="mb-3 opacity-70" />
                  <p className="text-sm font-medium text-on-surface">No tickets</p>
                  <p className="text-xs mt-1 max-w-sm">
                    The prover scheduler has not published an executable ticket for this chain.
                  </p>
                </div>
              )}

              {tickets.map(ticket => (
                <TicketRow
                  key={ticket.commitmentHash}
                  ticket={ticket}
                  selected={selected?.commitmentHash === ticket.commitmentHash}
                  now={now}
                  onSelect={() => setSelectedHash(ticket.commitmentHash)}
                />
              ))}
            </div>
          </div>

          <div className="xl:col-span-5">
            <div className="bg-surface-container-lowest rounded-sm border border-outline-variant/20 min-h-[560px] flex flex-col overflow-hidden relative shadow-[inset_0_0_40px_rgba(0,0,0,0.55)] trust-zone">
              <div className="bg-surface-container-low/80 p-5 border-b border-outline-variant/20 flex justify-between items-center backdrop-blur-md">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Zap size={17} className="text-primary-container" />
                    <h2 className="font-display text-sm uppercase tracking-[0.2em] font-black text-on-surface">
                      Execution Console
                    </h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("w-1.5 h-1.5 rounded-full", hasFreshTickets ? "bg-primary-container animate-pulse" : "bg-outline")} />
                    <span className="text-[10px] uppercase tracking-widest font-bold text-primary-container/80">
                      {hasFreshTickets ? "Ticket available" : "Queue idle"}
                    </span>
                  </div>
                </div>
                {claimedTicket && (
                  <span className="text-[10px] uppercase tracking-widest text-secondary border border-secondary/30 px-2 py-1 rounded-sm bg-surface-container-highest/50">
                    Claimed
                  </span>
                )}
              </div>

              <div className="flex-1 p-5 md:p-6 flex flex-col gap-6">
                <div className="space-y-3">
                  <Button
                    variant="primary"
                    size="lg"
                    className="w-full py-5 text-sm font-black tracking-[0.08em]"
                    disabled={!isConnected || actionBusy || !hasFreshTickets}
                    onClick={() => claimAndExecute.mutate()}
                  >
                    {actionBusy ? <Loader2 size={18} className="animate-spin" /> : <Rocket size={18} />}
                    {selectedReadyTicket ? "Claim Selected Ticket" : "Claim Next Ticket"}
                  </Button>
                </div>

                <div className="rounded-sm bg-tertiary-container/10 border border-tertiary-container/20 p-3 flex items-start gap-2">
                  <AlertTriangle size={15} className="text-tertiary-container mt-0.5 shrink-0" />
                  <p className="text-xs text-on-surface-variant">
                    Claimable tickets can still revert if chain state, oracle price, expiry, or nullifier state changes before settlement.
                  </p>
                </div>

                <div className="mt-auto">
                  <div className="text-[10px] uppercase tracking-widest text-on-surface-variant mb-4 font-bold flex items-center gap-2">
                    <div className="h-px flex-1 bg-outline-variant/20" />
                    Selected Ticket Details
                    <div className="h-px flex-1 bg-outline-variant/20" />
                  </div>

                  <div className="bg-surface-container/30 border border-outline-variant/10 rounded-sm p-4 space-y-4">
                    {selected ? (
                      <>
                        <DetailRow label="Commitment" value={truncateAddress(selected.commitmentHash, 10)} />
                        <DetailRow label="Intent" value={`${selected.intentKind}`} />
                        <DetailRow label="Expires" value={formatExpires(selected.ticketExpiresAt, now)} />
                      </>
                    ) : (
                      <p className="text-xs text-on-surface-variant">No ticket selected.</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="p-3 border-t border-outline-variant/10 bg-surface-container-low/30">
                <div className="flex justify-between items-center gap-3">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-primary-container/60 font-black">
                    <BadgeCheck size={12} />
                    Public executor wallet required
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
