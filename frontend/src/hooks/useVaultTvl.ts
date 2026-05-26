"use client";

import { useMemo } from "react";
import { useChainId, useReadContracts } from "wagmi";
import { formatUnits } from "viem";
import { arbitrumSepolia } from "wagmi/chains";
import { ADDRESSES, COMMITMENT_REGISTRY_ABI, ERC20_ABI, PRICE_FEED_ABI, TOKENS } from "@/lib/contracts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const COLLATERAL_TOKENS = [
  { symbol: "WETH", address: TOKENS.WETH, decimals: 18 },
  { symbol: "USDC", address: TOKENS.USDC, decimals: 6 },
  { symbol: "USDT", address: TOKENS.USDT, decimals: 6 },
  { symbol: "WBTC", address: TOKENS.WBTC, decimals: 8 },
] as const;

export function useVaultTvl() {
  const chainId = useChainId();
  const addresses =
    ADDRESSES[chainId as keyof typeof ADDRESSES] ?? ADDRESSES[arbitrumSepolia.id];

  const balances = useReadContracts({
    contracts: COLLATERAL_TOKENS.map((token) => ({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [addresses.collateralVault],
    })),
    query: { refetchInterval: 15_000 },
  });

  const feedAddresses = useReadContracts({
    contracts: COLLATERAL_TOKENS.map((token) => ({
      address: addresses.commitmentRegistry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "priceFeeds",
      args: [token.address],
    })),
    query: { refetchInterval: 60_000 },
  });

  const validFeeds = useMemo(
    () => {
      const data = (feedAddresses.data ?? []) as Array<{ status: string; result?: unknown }>;
      return data.map((item) =>
        item.status === "success" &&
        typeof item.result === "string" &&
        item.result.toLowerCase() !== ZERO_ADDRESS
          ? item.result as `0x${string}`
          : undefined,
      );
    },
    [feedAddresses.data],
  );

  const priceReads = useReadContracts({
    contracts: validFeeds.flatMap((feed) =>
      feed
        ? [
            { address: feed, abi: PRICE_FEED_ABI, functionName: "latestRoundData" },
            { address: feed, abi: PRICE_FEED_ABI, functionName: "decimals" },
          ]
        : [],
    ),
    query: { enabled: validFeeds.some(Boolean), refetchInterval: 30_000 },
  });

  return useMemo(() => {
    const tokenValues = COLLATERAL_TOKENS.map((token, i) => {
      const balanceData = balances.data as Array<{ status: string; result?: unknown }> | undefined;
      const priceData = priceReads.data as Array<{ status: string; result?: unknown }> | undefined;
      const balanceResult = balanceData?.[i];
      const balance = balanceResult?.status === "success" && typeof balanceResult.result === "bigint"
        ? balanceResult.result
        : 0n;

      const feed = validFeeds[i];
      let priceUsd = 0;
      if (feed) {
        const readIndex = validFeeds.slice(0, i).filter(Boolean).length * 2;
        const round = priceData?.[readIndex];
        const decimals = priceData?.[readIndex + 1];
        if (
          round?.status === "success" &&
          decimals?.status === "success" &&
          Array.isArray(round.result) &&
          typeof round.result[1] === "bigint" &&
          typeof decimals.result === "number" &&
          round.result[1] > 0n
        ) {
          priceUsd = Number(formatUnits(round.result[1], decimals.result));
        }
      }

      const amount = Number(formatUnits(balance, token.decimals));
      const valueUsd = amount * priceUsd;
      return { ...token, balance, amount, priceUsd, valueUsd };
    });
    const totalUsd = tokenValues.reduce((sum, token) => sum + token.valueUsd, 0);

    return {
      totalUsd,
      tokenValues,
      isLoading: balances.isLoading || feedAddresses.isLoading || priceReads.isLoading,
      isError: balances.isError || feedAddresses.isError || priceReads.isError,
    };
  }, [balances.data, balances.isError, balances.isLoading, feedAddresses.isError, feedAddresses.isLoading, priceReads.data, priceReads.isError, priceReads.isLoading, validFeeds]);
}
