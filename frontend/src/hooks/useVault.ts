"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useChainId } from "wagmi";
import { parseUnits, formatUnits, maxUint256 } from "viem";
import { ADDRESSES, COLLATERAL_VAULT_ABI, ERC20_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";

function useVaultAddress() {
  const chainId = useChainId();
  return ADDRESSES[chainId as keyof typeof ADDRESSES]?.collateralVault
    ?? ADDRESSES[arbitrumSepolia.id].collateralVault;
}

export function useFreeBalance(token: `0x${string}`) {
  const { address } = useAccount();
  const vault = useVaultAddress();

  return useReadContract({
    address: vault,
    abi: COLLATERAL_VAULT_ABI,
    functionName: "freeBalance",
    args: address ? [address, token] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });
}

export function useTokenBalance(token: `0x${string}`) {
  const { address } = useAccount();

  return useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });
}

export function useTokenAllowance(token: `0x${string}`) {
  const { address } = useAccount();
  const vault = useVaultAddress();

  return useReadContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, vault] : undefined,
    query: { enabled: !!address, refetchInterval: 5_000 },
  });
}

export function useDeposit() {
  const vault = useVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const approve = (token: `0x${string}`) =>
    writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [vault, maxUint256] });

  const deposit = (token: `0x${string}`, amount: string, decimals = 18) =>
    writeContract({
      address: vault,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "deposit",
      args: [token, parseUnits(amount, decimals)],
    });

  return { approve, deposit, hash, isPending, isConfirming, isSuccess, error };
}

export function useWithdraw() {
  const vault = useVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const withdraw = (token: `0x${string}`, amount: string, decimals = 18) =>
    writeContract({
      address: vault,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "withdraw",
      args: [token, parseUnits(amount, decimals)],
    });

  return { withdraw, hash, isPending, isConfirming, isSuccess, error };
}

export { formatUnits };
