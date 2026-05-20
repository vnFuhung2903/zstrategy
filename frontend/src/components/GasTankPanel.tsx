"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useBalance } from "wagmi";
import { formatEther } from "viem";
import { Fuel, ArrowDownToLine, ArrowUpFromLine, Loader2, Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { useGasBalance, useDepositGas, useWithdrawGas, PER_EXECUTION_ETH_ESTIMATE } from "@/hooks/useGasVault";
import { cn } from "@/lib/utils";

type Mode = "deposit" | "withdraw";

/**
 * Prepaid ETH balance the registry debits at executeCommitment time. Funds
 * are pooled per user (one deposit covers any number of strategies). Refill
 * any time; withdraw unused balance any time.
 */
export function GasTankPanel() {
  const { address, isConnected } = useAccount();
  const [mode, setMode]     = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const { data: gasBalance, refetch } = useGasBalance();
  const { data: walletEth }           = useBalance({ address });

  const { depositGas, hash: depositHash, isPending: depositPending, isConfirming: depositConfirming, isSuccess: depositSuccess } = useDepositGas();
  const { withdrawGas, hash: withdrawHash, isPending: withdrawPending, isConfirming: withdrawConfirming, isSuccess: withdrawSuccess } = useWithdrawGas();

  // Success is announced via the global Sonner toast (wired in useDepositGas /
  // useWithdrawGas through useTxToast). Keep the button enabled afterward so
  // the user can immediately top up again without dismissing anything.
  const busy = depositPending || depositConfirming || withdrawPending || withdrawConfirming;

  // wagmi caches `useReadContract` results by (address, abi, functionName, args),
  // so any component using `useGasBalance()` (this panel, the strategy page, the
  // DCA page) shares state. Refetch on confirmation so the disabled "Top up gas
  // tank" buttons on the form pages unstick as soon as the deposit lands — no
  // 10s polling lag.
  //
  // Track by tx hash, not by `isSuccess`, so rapid back-to-back deposits each
  // trigger their own refetch even if `isSuccess` doesn't fully cycle through
  // false between txs.
  const lastRefetchedHashRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const successHash =
      depositSuccess  ? depositHash  :
      withdrawSuccess ? withdrawHash :
      undefined;
    if (successHash && successHash !== lastRefetchedHashRef.current) {
      lastRefetchedHashRef.current = successHash;
      void refetch();
      setAmount("");
    }
  }, [depositSuccess, depositHash, withdrawSuccess, withdrawHash, refetch]);

  const fmt = (raw: bigint | undefined) =>
    raw === undefined ? "—" : parseFloat(formatEther(raw)).toLocaleString(undefined, { maximumFractionDigits: 6 });

  const estPerFill = parseFloat(formatEther(PER_EXECUTION_ETH_ESTIMATE));
  const estFillCount =
    gasBalance !== undefined && PER_EXECUTION_ETH_ESTIMATE > 0n
      ? Number(gasBalance / PER_EXECUTION_ETH_ESTIMATE)
      : 0;

  function handleAction() {
    if (!amount || parseFloat(amount) <= 0) return;
    if (mode === "deposit") depositGas(amount);
    else                    withdrawGas(amount);
    // Refetch is driven by the useEffect above (on tx confirmation), not here:
    // calling refetch before the tx lands would just re-read the pre-tx balance.
  }

  if (!isConnected) {
    return (
      <Card className="p-4">
        <p className="text-xs text-on-surface-variant text-center py-4">Connect wallet to manage gas tank</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <CardHeader className="p-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <Fuel size={14} className="text-secondary" />
          Gas Tank (Keeper Reimbursement)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 space-y-4">
        {/* Balances */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 rounded-sm bg-surface-container-high">
            <p className="text-on-surface-variant mb-0.5">Wallet</p>
            <p className="font-tabular text-on-surface">{fmt(walletEth?.value)} ETH</p>
          </div>
          <div className="p-2 rounded-sm bg-surface-container-high">
            <p className="text-on-surface-variant mb-0.5">Gas tank</p>
            <p className="font-tabular text-secondary">{fmt(gasBalance)} ETH</p>
          </div>
        </div>

        {/* Capacity estimate */}
        <div className="flex gap-2 px-3 py-2 rounded-sm border-l-2 border-secondary bg-secondary/5 text-xs">
          <Info size={12} className="text-secondary mt-0.5 shrink-0" />
          <p className="text-on-surface-variant leading-relaxed">
            ~{estPerFill.toFixed(5)} ETH/fill at current estimate
            {gasBalance !== undefined && gasBalance > 0n && (
              <> — covers ~<span className="font-tabular text-on-surface">{estFillCount}</span> fills</>
            )}
            .
          </p>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-sm overflow-hidden border border-outline-variant/20">
          {(["deposit", "withdraw"] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 py-2 text-xs font-medium capitalize transition-colors",
                mode === m
                  ? "bg-secondary/10 text-secondary"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              {m === "deposit" ? <ArrowDownToLine size={12} className="inline mr-1" /> : <ArrowUpFromLine size={12} className="inline mr-1" />}
              {m}
            </button>
          ))}
        </div>

        {/* Amount input */}
        <Input
          label={`Amount (ETH)`}
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="0.00"
          suffix="ETH"
        />

        {/* CTA */}
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          disabled={busy || !amount || parseFloat(amount) <= 0}
          onClick={handleAction}
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {mode === "deposit" ? "Top up gas tank" : "Withdraw"}
        </Button>
      </CardContent>
    </Card>
  );
}
