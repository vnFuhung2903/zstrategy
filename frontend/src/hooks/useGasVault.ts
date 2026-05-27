"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useChainId } from "wagmi";
import { parseEther } from "viem";
import { ADDRESSES, GAS_VAULT_ABI } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";
import { FEE_OVERRIDES } from "@/lib/wagmi";
import { useTxToast } from "@/hooks/useTxToast";

function useGasVaultAddress() {
  const chainId = useChainId();
  return ADDRESSES[chainId as keyof typeof ADDRESSES]?.gasVault
    ?? ADDRESSES[arbitrumSepolia.id].gasVault;
}

/** Live ETH balance held in the gas tank for the connected wallet. */
export function useGasBalance() {
  const { address } = useAccount();
  const gasVault = useGasVaultAddress();

  return useReadContract({
    address: gasVault,
    abi: GAS_VAULT_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });
}

/** Top up the caller's gas tank. `amountEth` is a decimal string in ETH, e.g. "0.01". */
export function useDepositGas() {
  const gasVault = useGasVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Gas tank top-up" });

  const depositGas = (amountEth: string) =>
    writeContract({
      address: gasVault,
      abi: GAS_VAULT_ABI,
      functionName: "deposit",
      args: [],
      value: parseEther(amountEth),
      ...FEE_OVERRIDES,
    });

  return { depositGas, hash, isPending, isConfirming, isSuccess, error };
}

/** Withdraw `amountEth` ETH from the gas tank back to the caller. */
export function useWithdrawGas() {
  const gasVault = useGasVaultAddress();
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  useTxToast({ hash, isConfirming, isSuccess, error: error as Error | null, label: "Gas tank withdrawal" });

  const withdrawGas = (amountEth: string) =>
    writeContract({
      address: gasVault,
      abi: GAS_VAULT_ABI,
      functionName: "withdraw",
      args: [parseEther(amountEth)],
      ...FEE_OVERRIDES,
    });

  return { withdrawGas, hash, isPending, isConfirming, isSuccess, error };
}

// Per-execution cost estimate used to gate strategy submission in the UI.
// The registry debits `GAS_ESTIMATE * tx.gasprice * 120%`.
// Recent MARKET execution telemetry on Arbitrum Sepolia used 5,784,119 gas.
// The exact billable amount would be 5,814,119 after adding the registry's
// fixed 30,000 overhead, but the UI gate should not depend on one exact tx.
// Round the billable gas up to 6,000,000 for a small operational buffer.
//
// At 1 gwei:
//   6,000,000 * 1e9 * 1.2 = 7,200,000,000,000,000 wei
//   = 0.0072 ETH per fill
//
// If the keeper submits with a 10 gwei buffered gas price, the same execution
// needs 0.072 ETH. Keep PER_EXECUTION_GAS_PRICE_WEI aligned with the
// keeper's effective tx.gasprice policy.
export const PER_EXECUTION_GAS_ESTIMATE     = 6_000_000n;
export const PER_EXECUTION_GAS_PRICE_WEI    = 1_000_000_000n;       // 1 gwei
export const PER_EXECUTION_PREMIUM_BPS      = 12000n;               // 120%
export const PER_EXECUTION_ETH_ESTIMATE =
  PER_EXECUTION_GAS_ESTIMATE * PER_EXECUTION_GAS_PRICE_WEI * PER_EXECUTION_PREMIUM_BPS / 10000n;
// = 7_200_000_000_000_000 wei = 0.0072 ETH per fill at 1 gwei
