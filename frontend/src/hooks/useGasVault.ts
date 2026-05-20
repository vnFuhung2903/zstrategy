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

/** Top up the caller's gas tank. `amountEth` is a decimal string in ETH (e.g. "0.01"). */
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
// The contract debits `gasUsed × tx.gasprice × KEEPER_PREMIUM_BPS / 10000`,
// so the estimate must be the WORST plausible value of that product, not the
// average — under-estimating leaves users with strategies that pass our UI
// gate, trigger, and then revert on the actual debit.
//
// Worst-case envelope (Arbitrum Sepolia under congestion):
//   gas:       1,200,000  (UltraHonk verifier ~800k + swap + debit + events)
//   gasPrice:  1 gwei     (= 1e9 wei; pessimistic vs ~0.01–0.1 gwei typical)
//   premium:   1.2        (KEEPER_PREMIUM_BPS = 12000 / 10000 in the contract)
//
//   1_200_000 × 1e9 × 1.2 = 1,440,000,000,000,000 wei = 0.00144 ETH per fill
//
// A small DCA (10 rounds) needs ~0.0144 ETH prepaid — under $50 at current
// ETH prices, low-friction for a user already moving collateral. Refine
// downward once we have real fill telemetry from Arbitrum Sepolia.
export const PER_EXECUTION_GAS_ESTIMATE     = 1_200_000n;
export const PER_EXECUTION_GAS_PRICE_WEI    = 1_000_000_000n;       // 1 gwei
export const PER_EXECUTION_PREMIUM_BPS      = 12000n;               // 120%
export const PER_EXECUTION_ETH_ESTIMATE =
  PER_EXECUTION_GAS_ESTIMATE * PER_EXECUTION_GAS_PRICE_WEI * PER_EXECUTION_PREMIUM_BPS / 10000n;
// = 1_440_000_000_000_000 wei = 0.00144 ETH per fill
