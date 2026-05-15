"use client";

import { useState, useRef, useEffect } from "react";
import { useAccount, useChains, useSwitchChain, useWalletClient } from "wagmi";
import { Button } from "@/components/ui/Button";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { truncateAddress } from "@/lib/utils";
import { Wallet, ChevronDown, Check, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface TopbarProps {
  title: string;
}

// ── Network dropdown ──────────────────────────────────────────────────────────

function NetworkDropdown({ onClose }: { onClose: () => void }) {
  const chains                    = useChains();
  const { chain: activeChain }    = useAccount();
  const { switchChain, isPending} = useSwitchChain();
  const { data: walletClient }    = useWalletClient();

  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName,     setCustomName]     = useState("");
  const [customChainId,  setCustomChainId]  = useState("");
  const [customRpc,      setCustomRpc]      = useState("");
  const [customSymbol,   setCustomSymbol]   = useState("");
  const [addError,       setAddError]       = useState<string | null>(null);
  const [adding,         setAdding]         = useState(false);

  async function handleAddCustom() {
    if (!walletClient || !customChainId || !customRpc || !customName) return;
    const id = parseInt(customChainId, 10);
    if (isNaN(id)) { setAddError("Invalid chain ID"); return; }
    setAdding(true);
    setAddError(null);
    try {
      await walletClient.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId:           `0x${id.toString(16)}`,
          chainName:         customName,
          nativeCurrency:    { name: customSymbol || "ETH", symbol: customSymbol || "ETH", decimals: 18 },
          rpcUrls:           [customRpc],
        }],
      });
      onClose();
    } catch (e) {
      setAddError(e instanceof Error ? e.message.slice(0, 80) : "Failed to add chain");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="absolute z-50 right-0 top-full mt-1 w-64 bg-surface-container rounded-sm border border-outline-variant/20 shadow-xl overflow-hidden">
      {/* Configured chains */}
      <div className="px-3 pt-3 pb-1">
        <p className="text-[10px] text-on-surface-variant uppercase tracking-widest mb-2">Networks</p>
        {chains.map(c => {
          const isActive = activeChain?.id === c.id;
          return (
            <button
              key={c.id}
              disabled={isActive || isPending}
              onClick={() => { switchChain({ chainId: c.id }); onClose(); }}
              className={cn(
                "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-sm text-sm transition-colors",
                isActive
                  ? "bg-primary-container/10 text-primary-container cursor-default"
                  : "text-on-surface hover:bg-surface-container-highest",
              )}
            >
              <span className={cn(
                "w-2 h-2 rounded-full shrink-0",
                isActive ? "bg-primary-container shadow-[0_0_4px_rgba(0,240,255,0.7)]" : "bg-outline-variant",
              )} />
              <span className="flex-1 text-left truncate">{c.name}</span>
              {isActive && <Check size={13} className="shrink-0" />}
            </button>
          );
        })}
      </div>

      <div className="border-t border-outline-variant/10 px-3 py-2">
        <button
          onClick={() => setShowCustomForm(v => !v)}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-sm text-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition-colors"
        >
          <Plus size={13} className="shrink-0" />
          <span>Add custom network</span>
          <ChevronDown size={12} className={cn("ml-auto transition-transform", showCustomForm && "rotate-180")} />
        </button>

        {showCustomForm && (
          <div className="mt-2 space-y-2 pb-1">
            {[
              { label: "Network name", value: customName,    set: setCustomName,    ph: "Arbitrum Sepolia" },
              { label: "Chain ID",     value: customChainId, set: setCustomChainId, ph: "421614" },
              { label: "RPC URL",      value: customRpc,     set: setCustomRpc,     ph: "https://..." },
              { label: "Symbol",       value: customSymbol,  set: setCustomSymbol,  ph: "ETH (optional)" },
            ].map(({ label, value, set, ph }) => (
              <div key={label}>
                <label className="text-[10px] text-on-surface-variant uppercase tracking-wide block mb-0.5">{label}</label>
                <input
                  value={value}
                  onChange={e => set(e.target.value)}
                  placeholder={ph}
                  className="w-full bg-surface-container-lowest text-on-surface text-xs px-2.5 py-1.5 rounded-sm border border-outline-variant/20 outline-none focus:border-primary-container/50 placeholder:text-on-surface-variant/40 transition-colors"
                />
              </div>
            ))}
            {addError && <p className="text-[10px] text-error">{addError}</p>}
            <Button
              variant="primary"
              size="sm"
              className="w-full mt-1"
              disabled={adding || !customChainId || !customRpc || !customName}
              onClick={handleAddCustom}
            >
              {adding ? "Adding…" : "Add Network"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────

export function Topbar({ title }: TopbarProps) {
  const { address, isConnected, chain } = useAccount();
  const [connectOpen,  setConnectOpen]  = useState(false);
  const [networkOpen,  setNetworkOpen]  = useState(false);
  const networkRef = useRef<HTMLDivElement>(null);

  // Close network dropdown on outside click.
  useEffect(() => {
    if (!networkOpen) return;
    function handle(e: MouseEvent) {
      if (networkRef.current && !networkRef.current.contains(e.target as Node)) {
        setNetworkOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [networkOpen]);

  return (
    <>
      <header className="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-b border-outline-variant/10 bg-surface-container-low/50 backdrop-blur-md sticky top-0 z-10">
        <h1 className="font-display font-semibold text-base md:text-lg tracking-tight text-on-surface ml-10 md:ml-0">
          {title}
        </h1>

        <div className="flex items-center gap-2">
          {isConnected ? (
            <>
              {/* Network selector */}
              <div className="relative" ref={networkRef}>
                <button
                  onClick={() => setNetworkOpen(o => !o)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm bg-surface-container border border-outline-variant/20 hover:border-primary-container/30 transition-colors text-xs text-on-surface-variant"
                >
                  <span className={cn(
                    "w-1.5 h-1.5 rounded-full shrink-0",
                    chain ? "bg-primary-container shadow-[0_0_4px_rgba(0,240,255,0.6)]" : "bg-error",
                  )} />
                  <span className="hidden sm:block max-w-[120px] truncate">
                    {chain?.name ?? "Wrong network"}
                  </span>
                  <ChevronDown size={11} className={cn("transition-transform", networkOpen && "rotate-180")} />
                </button>
                {networkOpen && (
                  <NetworkDropdown onClose={() => setNetworkOpen(false)} />
                )}
              </div>

              {/* Address / wallet button */}
              <button
                onClick={() => setConnectOpen(true)}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm bg-surface-container border border-outline-variant/20 hover:border-primary-container/30 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container shrink-0 shadow-[0_0_4px_rgba(0,240,255,0.7)]" />
                <span className="font-tabular text-xs text-on-surface-variant">
                  {truncateAddress(address!)}
                </span>
              </button>
            </>
          ) : (
            <Button variant="primary" size="sm" onClick={() => setConnectOpen(true)}>
              <Wallet size={14} />
              <span className="hidden sm:inline">Connect Wallet</span>
              <span className="sm:hidden">Connect</span>
            </Button>
          )}
        </div>
      </header>

      <ConnectModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </>
  );
}
