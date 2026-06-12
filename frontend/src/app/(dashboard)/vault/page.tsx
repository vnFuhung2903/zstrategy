"use client";

import { Topbar } from "@/components/layout/Topbar";
import { Card } from "@/components/ui/Card";
import { Lock } from "lucide-react";
import { VaultPanel } from "@/components/wallet/VaultPanel";

export default function VaultPage() {
  return (
    <>
      <Topbar title="Collateral Vault" />
      <div className="p-4 md:p-6 space-y-4 max-w-7xl">

        {/* Hero */}
        <Card className="relative overflow-hidden p-4 md:p-6">
          <div className="absolute top-0 right-0 w-64 h-64 bg-secondary-container/10 blur-3xl rounded-full -translate-y-1/2 translate-x-1/2 pointer-events-none" />
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Secure Collateral Layer</p>
              <h2 className="font-display text-2xl md:text-3xl font-semibold text-primary-container tracking-tight">
                Collateral Vault
              </h2>
              <p className="text-sm text-on-surface-variant mt-2">
                All collateral is locked in non-custodial smart contracts. Only proofs can authorize fund movement.
              </p>
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
        <div className="w-full max-w-3xl mx-auto">
          <VaultPanel />
        </div>
      </div>
    </>
  );
}
