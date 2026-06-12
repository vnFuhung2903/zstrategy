"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";
import { api } from "@/lib/api";

export function useDashboardAnalytics() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["dashboard", chainId],
    queryFn:  () => api.dashboard(chainId),
    refetchInterval: 30_000,
    retry: false,
  });
}
