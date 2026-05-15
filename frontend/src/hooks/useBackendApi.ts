"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";
import { api } from "@/lib/api";

export function useStats() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["stats", chainId],
    queryFn:  () => api.stats(chainId),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useExecutions(limit = 20, offset = 0) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["executions", chainId, limit, offset],
    queryFn:  () => api.executions(chainId, limit, offset),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useKeeperHealth() {
  return useQuery({
    queryKey: ["keeper-health"],
    queryFn:  api.keeperHealth,
    refetchInterval: 15_000,
    retry: false,
  });
}
