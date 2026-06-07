"use client";

import { Topbar } from "@/components/layout/Topbar";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Lock } from "lucide-react";
import { VaultPanel } from "@/components/wallet/VaultPanel";

export default function VaultPage() {
  return (
    <>
      <Topbar title="Vault Security" />
      <div className="p-4 md:p-6 space-y-4 max-w-7xl">

        {/* Hero */}
        <Card className="relative overflow-hidden p-4 md:p-6">
          <div className="absolute top-0 right-0 w-64 h-64 bg-secondary-container/10 blur-3xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Secure Collateral Layer</p>
              <h2 className="font-display text-2xl md:text-3xl font-semibold text-primary-container tracking-tight">
                Vault Security
              </h2>
              <p className="text-sm text-on-surface-variant mt-2 max-w-md">
                All collateral is locked in non-custodial smart contracts. Only ZK proofs can authorize fund movement.
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <Badge variant="primary" dot>System Optimal</Badge>
                <Badge variant="sovereign" dot>ZKP Active</Badge>
              </div>
            </div>
            {/* Animated lock */}
            <div className="relative w-20 h-20 md:w-28 md:h-28 hidden sm:flex items-center justify-center shrink-0">
              <div className="absolute inset-0 rounded-full border border-primary-container/20 animate-spin" style={{ animationDuration: "20s" }} />
              <div className="absolute inset-2 rounded-full border border-dashed border-secondary/20 animate-spin" style={{ animationDuration: "15s", animationDirection: "reverse" }} />
              <div className="absolute inset-5 rounded-full border border-dotted border-primary-container/10 animate-spin" style={{ animationDuration: "30s" }} />
              <Lock size={24} className="text-primary-container drop-shadow-[0_0_8px_rgba(0,240,255,0.5)]" />
            </div>
          </div>
        </Card>

        {/* Deposit / Withdraw panels */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <VaultPanel />
          <div className="hidden md:block" />
        </div>
      </div>
    </>
  );
}
