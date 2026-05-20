"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useChainId } from "wagmi";
import { parseUnits, formatUnits, maxUint256 } from "viem";
import { ADDRESSES, COLLATERAL_VAULT_ABI, ERC20_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";
import { FEE_OVERRIDES } from "@/lib/wagmi";
import { useTxToast } from "@/hooks/useTxToast";

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

// Token approval is split from useDeposit so the two have independent tx
// state. Sharing one `useWriteContract` meant `isSuccess` flipped true after
// approve, which made VaultPanel's "Transaction confirmed!" block hide the
// follow-up Deposit button — the user got stuck with no way to actually
// deposit. With separate hooks the consumer can chain them explicitly:
// observe `useApproveToken().isSuccess`, refetch allowance, then let the
// user click Deposit.
//
// We approve `maxUint256` so the first approval covers any future deposit of
// the same token — `useTokenAllowance` then reports `needsApproval = false`
// on subsequent deposits and the consumer skips the approve step entirely.
export function useApproveToken() {
  const vault = useVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Token approval" });

  const approve = (token: `0x${string}`) =>
    writeContract({ address: token, abi: ERC20_ABI, functionName: "approve", args: [vault, maxUint256], ...FEE_OVERRIDES });

  return { approve, hash, isPending, isConfirming, isSuccess, error };
}

export function useDeposit() {
  const vault = useVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Vault deposit" });

  const deposit = (token: `0x${string}`, amount: string, decimals = 18) =>
    writeContract({
      address: vault,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "deposit",
      args: [token, parseUnits(amount, decimals)],
      ...FEE_OVERRIDES,
    });

  return { deposit, hash, isPending, isConfirming, isSuccess, error };
}

export function useWithdraw() {
  const vault = useVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Vault withdrawal" });

  const withdraw = (token: `0x${string}`, amount: string, decimals = 18) =>
    writeContract({
      address: vault,
      abi: COLLATERAL_VAULT_ABI,
      functionName: "withdraw",
      args: [token, parseUnits(amount, decimals)],
      ...FEE_OVERRIDES,
    });

  return { withdraw, hash, isPending, isConfirming, isSuccess, error };
}

export { formatUnits };
