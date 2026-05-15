"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { TRADING_PAIRS, type TradingPair, type TokenMeta } from "@/lib/tradingPairs";

function TokenChip({ token }: { token: TokenMeta }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={token.logoSrc} alt={token.name} className="w-5 h-5 rounded-full shrink-0" />
      <span className="text-sm text-on-surface">{token.name}</span>
    </span>
  );
}

interface Props {
  value:      TradingPair;
  onChange:   (pair: TradingPair) => void;
  className?: string;
}

export function TokenPairSelect({ value, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-surface-container-lowest rounded-sm border-b border-outline-variant/30 hover:border-primary-container/50 transition-all"
      >
        <span className="flex items-center gap-2 min-w-0">
          <TokenChip token={value.baseToken} />
          <span className="text-on-surface-variant text-sm shrink-0">/</span>
          <TokenChip token={value.quoteToken} />
        </span>
        <ChevronDown
          size={13}
          className={cn("text-on-surface-variant shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-surface-container rounded-sm border border-outline-variant/20 shadow-lg overflow-hidden">
          {TRADING_PAIRS.map(pair => (
            <button
              key={pair.label}
              type="button"
              onClick={() => { onChange(pair); setOpen(false); }}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-container-highest transition-colors",
                pair.label === value.label && "bg-primary-container/10",
              )}
            >
              <TokenChip token={pair.baseToken} />
              <span className="text-on-surface-variant text-sm shrink-0">/</span>
              <TokenChip token={pair.quoteToken} />
              <span className="ml-auto text-xs text-on-surface-variant font-mono shrink-0">{pair.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
