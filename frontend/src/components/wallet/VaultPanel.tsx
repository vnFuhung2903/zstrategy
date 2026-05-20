"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { useFreeBalance, useTokenBalance, useTokenAllowance, useApproveToken, useDeposit, useWithdraw } from "@/hooks/useVault";
import { TOKENS } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const TOKEN_OPTIONS = [
  { label: "WETH", address: TOKENS.WETH, decimals: 18 },
  { label: "USDC", address: TOKENS.USDC, decimals: 6  },
  { label: "USDT", address: TOKENS.USDT, decimals: 6  },
  { label: "WBTC", address: TOKENS.WBTC, decimals: 8  },
] as const;

type Mode = "deposit" | "withdraw";

export function VaultPanel() {
  const { isConnected } = useAccount();
  const [mode, setMode] = useState<Mode>("deposit");
  const [tokenIdx, setTokenIdx] = useState(0);
  const [amount, setAmount] = useState("");

  const token = TOKEN_OPTIONS[tokenIdx];

  const { data: vaultBalance, refetch: refetchVault } = useFreeBalance(token.address);
  const { data: walletBalance }                                  = useTokenBalance(token.address);
  const { data: allowance, refetch: refetchAllowance }           = useTokenAllowance(token.address);

  const { approve,  isPending: approvePending,  isConfirming: approveConfirming,  isSuccess: approveSuccess,  hash: approveHash } = useApproveToken();
  const { deposit,  isPending: depositPending,  isConfirming: depositConfirming }  = useDeposit();
  const { withdraw, isPending: withdrawPending, isConfirming: withdrawConfirming } = useWithdraw();

  const needsApproval =
    mode === "deposit" &&
    allowance !== undefined &&
    amount !== "" &&
    parseFloat(amount) > 0 &&
    allowance < BigInt(Math.floor(parseFloat(amount) * 10 ** token.decimals));

  // Tx button is "busy" only while a tx is in-flight. Success is communicated
  // via the global Sonner toast (wired by useTxToast inside each write hook),
  // so the button stays enabled and ready for the next interaction — the user
  // doesn't have to dismiss anything to deposit again.
  const busy = approvePending || approveConfirming || depositPending || depositConfirming || withdrawPending || withdrawConfirming;

  // After approve confirms, force an allowance refetch so the button switches
  // from "Approve" to "Deposit" without waiting up to 5s for the polling
  // interval. Tracked by tx hash so back-to-back approves each trigger
  // their own refetch.
  const lastApprovedHashRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!approveSuccess || !approveHash || approveHash === lastApprovedHashRef.current) return;
    lastApprovedHashRef.current = approveHash;
    void refetchAllowance();
  }, [approveSuccess, approveHash, refetchAllowance]);

  function fmt(raw: bigint | undefined) {
    if (raw === undefined) return "—";
    return parseFloat(formatUnits(raw, token.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 });
  }

  function handleAction() {
    if (!amount || parseFloat(amount) <= 0) return;
    if (mode === "deposit") {
      if (needsApproval) {
        approve(token.address);
      } else {
        deposit(token.address, amount, token.decimals);
        void refetchVault();
      }
    } else {
      withdraw(token.address, amount, token.decimals);
      void refetchVault();
    }
  }

  if (!isConnected) {
    return (
      <Card className="p-4">
        <p className="text-xs text-on-surface-variant text-center py-4">Connect wallet to manage vault balance</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">Manage Collateral</CardTitle>
      </CardHeader>
      <CardContent className="p-0 space-y-4">
        {/* Token selector */}
        <div className="flex gap-2">
          {TOKEN_OPTIONS.map((t, i) => (
            <button
              key={t.label}
              onClick={() => { setTokenIdx(i); setAmount(""); }}
              className={cn(
                "px-3 py-1.5 rounded-sm text-xs font-medium transition-colors border",
                tokenIdx === i
                  ? "bg-primary-container/10 border-primary-container/40 text-primary-container"
                  : "border-outline-variant/20 text-on-surface-variant hover:text-on-surface",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Balances */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 rounded-sm bg-surface-container-high">
            <p className="text-on-surface-variant mb-0.5">Wallet</p>
            <p className="font-tabular text-on-surface">{fmt(walletBalance)} {token.label}</p>
          </div>
          <div className="p-2 rounded-sm bg-surface-container-high">
            <p className="text-on-surface-variant mb-0.5">Vault (free)</p>
            <p className="font-tabular text-primary-container">{fmt(vaultBalance)} {token.label}</p>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex rounded-sm overflow-hidden border border-outline-variant/20">
          {(["deposit", "withdraw"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "flex-1 py-2 text-xs font-medium capitalize transition-colors",
                mode === m
                  ? "bg-primary-container/10 text-primary-container"
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
          label={`Amount (${token.label})`}
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          suffix={token.label}
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
          {needsApproval ? `Approve ${token.label}` : mode === "deposit" ? "Deposit" : "Withdraw"}
        </Button>
      </CardContent>
    </Card>
  );
}
