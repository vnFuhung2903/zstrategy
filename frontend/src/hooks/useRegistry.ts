"use client";

import { useWriteContract, useWaitForTransactionReceipt, useReadContract, useChainId } from "wagmi";
import { ADDRESSES, COMMITMENT_REGISTRY_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";

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

export function useRegisterCommitment() {
  const registry = useRegistryAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const register = (
    commitmentHash: `0x${string}`,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    size: bigint,
    minOut: bigint,
    expiry: number,
    kind: number = 0,
  ) =>
    writeContract({
      address: registry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "registerCommitment",
      args: [commitmentHash, tokenIn, tokenOut, size, minOut, BigInt(expiry), kind],
    });

  return { register, hash, isPending, isConfirming, isSuccess, error };
}

export function useCancelCommitment() {
  const registry = useRegistryAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const cancel = (commitmentHash: `0x${string}`, nullifier: `0x${string}`) =>
    writeContract({
      address: registry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "cancelCommitment",
      args: [commitmentHash, nullifier],
    });

  return { cancel, hash, isPending, isConfirming, isSuccess, error };
}

/**
 * Self-execute fallback. Used when the keeper network is unreachable or the
 * user wants to take direct action. The contract reads Chainlink at fill time
 * and uses that value as a public input, so the proof must be generated
 * against the same live value — see `MyStrategies.tsx` for the read+prove
 * sequence and `lib/orderFillProof.ts` for the bb.js (UltraHonk) integration.
 */
export function useExecuteCommitment() {
  const registry = useRegistryAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const execute = (
    commitmentHash: `0x${string}`,
    nullifier: `0x${string}`,
    proof: `0x${string}`,
  ) =>
    writeContract({
      address: registry,
      abi: COMMITMENT_REGISTRY_ABI,
      functionName: "executeCommitment",
      args: [commitmentHash, nullifier, proof],
    });

  return { execute, hash, isPending, isConfirming, isSuccess, error };
}

export function useRegisterCommitmentBatch() {
  const registry = useRegistryAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

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
    });

  return { registerBatch, hash, isPending, isConfirming, isSuccess, error };
}

export function useGetCommitment(commitmentHash: `0x${string}` | undefined) {
  const registry = useRegistryAddress();
  return useReadContract({
    address: registry,
    abi: COMMITMENT_REGISTRY_ABI,
    functionName: "getCommitment",
    args: commitmentHash ? [commitmentHash] : undefined,
    query: { enabled: !!commitmentHash },
  });
}
