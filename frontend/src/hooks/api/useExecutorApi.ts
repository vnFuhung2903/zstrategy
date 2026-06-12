"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";
import { api } from "@/lib/api";

export function useExecutorTickets(limit = 20) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["executor-tickets", chainId, limit],
    queryFn:  () => api.executorTickets(chainId, limit),
    refetchInterval: 10_000,
    retry: false,
  });
}
