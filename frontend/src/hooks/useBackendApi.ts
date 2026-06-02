"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";
import { api, type IntentKind, type ExecutionStatus } from "@/lib/api";

export function useStats() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["stats", chainId],
    queryFn:  () => api.stats(chainId),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useExecutions(
  limit = 20,
  offset = 0,
  filters: { q?: string; status?: ExecutionStatus | ""; kind?: IntentKind | ""; chainId?: number } = {},
) {
  const chainId = useChainId();
  const selectedChainId = filters.chainId ?? chainId;
  return useQuery({
    queryKey: ["executions", selectedChainId, limit, offset, filters.q ?? "", filters.status ?? "", filters.kind ?? ""],
    queryFn:  () => api.executions(selectedChainId, limit, offset, filters),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useExecutorTickets(limit = 20) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["executor-tickets", chainId, limit],
    queryFn:  () => api.executorTickets(chainId, limit),
    refetchInterval: 10_000,
    retry: false,
  });
}
