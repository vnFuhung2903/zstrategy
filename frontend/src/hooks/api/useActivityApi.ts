"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";
import { api, type ExecutionStatus, type IntentKind } from "@/lib/api";

export interface ExecutionFilters {
  q?: string;
  status?: ExecutionStatus | "";
  kind?: IntentKind | "";
  chainId?: number;
}

export function useExecutions(
  limit = 20,
  offset = 0,
  filters: ExecutionFilters = {},
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
