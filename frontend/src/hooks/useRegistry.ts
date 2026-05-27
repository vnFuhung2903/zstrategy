"use client";

import { useState } from "react";
import { useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId } from "wagmi";
import { ADDRESSES, COMMITMENT_REGISTRY_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";
import { FEE_OVERRIDES } from "@/lib/wagmi";
import { useTxToast } from "@/hooks/useTxToast";

function useRegistryAddress() {
  const chainId = useChainId();
  return ADDRESSES[chainId as keyof typeof ADDRESSES]?.commitmentRegistry
    ?? ADDRESSES[arbitrumSepolia.id].commitmentRegistry;
}

export function useRegistryPaused() {
  const registry = useRegistryAddress();
  return useReadContract({
    address: registry,
    abi: COMMITMENT_REGISTRY_ABI,
    functionName: "paused",
    query: { refetchInterval: 30_000 },
  });
}

interface RegisterCommitmentOptions {
  successToastEnabled?: boolean;
}

export function useRegisterCommitment() {
  const registry = useRegistryAddress();
  const [successToastEnabled, setSuccessToastEnabled] = useState(true);
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({
    hash,
    isConfirming,
    isSuccess,
    error: error as Error | null,
    label: "Register commitment",
    successToastEnabled,
  });

  const register = (
    commitmentHash: `0x${string}`,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    size: bigint,
    minOut: bigint,
    expiry: number,
    kind: number = 0,
    options: RegisterCommitmentOptions = {},
  ) => {
    setSuccessToastEnabled(options.successToastEnabled ?? true);
    writeContract({
      address: registry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "registerCommitment",
      args: [commitmentHash, tokenIn, tokenOut, size, minOut, BigInt(expiry), kind],
      ...FEE_OVERRIDES,
    });
  };

  return { register, hash, isPending, isConfirming, isSuccess, error };
}

export function useRegisterCommitmentBatch() {
  const registry = useRegistryAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Register DCA batch" });

  const registerBatch = (
    commitmentHashes: `0x${string}`[],
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    sizes: bigint[],
    minOuts: bigint[],
    expiries: bigint[],
    kind: number,
  ) =>
    writeContract({
      address: registry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "registerCommitmentBatch",
      args: [commitmentHashes, tokenIn, tokenOut, sizes, minOuts, expiries, kind],
      ...FEE_OVERRIDES,
    });

  return { registerBatch, hash, isPending, isConfirming, isSuccess, error };
}
