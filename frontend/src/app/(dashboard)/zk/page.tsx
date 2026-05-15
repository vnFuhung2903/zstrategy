"use client";

import { Topbar } from "@/components/layout/Topbar";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Radio, ShieldCheck, FileCode } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ZK Terminal — informational page describing the cryptographic stack.
 *
 * No fake dynamic values. Real proofs are generated inline at the moments
 * they are actually needed:
 *   - Browser self-execute path: `lib/orderFillProof.ts` invoked from
 *     `MyStrategies.tsx` (`Self-Execute` button).
 *   - DCA registration / limit submission: backend triggers the keeper, which
 *     generates the proof in `keeper/src/zk/{orderFill,dca}.ts`.
 *
 * The numbers below are circuit-level facts (preimage size, constraint shape,
 * public input layout) — not fabricated runtime metrics.
 */

type Field = { label: string; value: string };

const ORDER_FILL_PRIVATE: Field[] = [
  { label: "price",       value: "u64 (Chainlink 8-dec)" },
  { label: "direction",   value: "u8 (0 = BUY, 1 = SELL)" },
  { label: "nonce",       value: "Field (32 bytes)" },
  { label: "user_secret", value: "Field (32 bytes)" },
];

const ORDER_FILL_PUBLIC: Field[] = [
  { label: "commitment_hash", value: "Field" },
  { label: "oracle_price",    value: "u64 (live Chainlink read at fill)" },
  { label: "nullifier",       value: "Field (= keccak(secret ‖ nonce))" },
  { label: "token_in",        value: "address (20 bytes)" },
  { label: "token_out",       value: "address (20 bytes)" },
  { label: "size",            value: "Field (token_in units)" },
  { label: "min_out",         value: "Field (token_out units)" },
  { label: "expiry",          value: "u64 (unix seconds)" },
];

const DCA_PRIVATE: Field[] = [
  { label: "scheduled_lo", value: "u64 (window open, unix s)" },
  { label: "scheduled_hi", value: "u64 (window close, unix s)" },
  { label: "nonce",        value: "Field (32 bytes, per round)" },
  { label: "user_secret",  value: "Field (32 bytes, shared per group)" },
];

const DCA_PUBLIC: Field[] = [
  { label: "commitment_hash", value: "Field" },
  { label: "block_timestamp", value: "u64 (chain time at fill)" },
  { label: "nullifier",       value: "Field" },
  { label: "token_in",        value: "address" },
  { label: "token_out",       value: "address" },
  { label: "size",            value: "Field (per-round amount)" },
  { label: "min_out",         value: "Field" },
  { label: "expiry",          value: "u64" },
];

const STACK = [
  { label: "Language",          value: "Noir (1.0 beta)" },
  { label: "Proof system",      value: "UltraHonk (Barretenberg)" },
  { label: "Transcript hash",   value: "keccak (EVM-compatible)" },
  { label: "Browser runtime",   value: "@aztec/bb.js + @noir-lang/noir_js (WASM)" },
  { label: "Verifier contract", value: "Solidity, generated via `bb write_solidity`" },
  { label: "Trusted setup",     value: "Universal (no per-circuit ceremony)" },
];

function FieldList({ items }: { items: Field[] }) {
  return (
    <div className="space-y-1.5">
      {items.map(f => (
        <div key={f.label} className="flex justify-between gap-3 text-xs">
          <span className="font-mono text-on-surface">{f.label}</span>
          <span className="text-on-surface-variant text-right truncate">{f.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function ZKTerminalPage() {
  return (
    <>
      <Topbar title="ZK Terminal" />
      <div className="p-4 md:p-6 max-w-7xl">
        {/* Header */}
        <div className="mb-5 md:mb-6">
          <h2 className="font-display text-3xl md:text-4xl font-bold text-primary-container tracking-tight">
            TERMINAL.ZKP
          </h2>
          <div className="flex items-center gap-2 mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary-container animate-pulse" />
            <span className="text-xs text-on-surface-variant uppercase tracking-widest">UltraHonk · Noir</span>
          </div>
          <p className="text-sm text-on-surface-variant mt-3 max-w-2xl">
            Proofs are generated inline at the moment of use — the browser runs Barretenberg WASM for self-execute,
            the keeper runs the same code path for backend-triggered fills. This page documents the circuits
            themselves; live proof generation happens on the Strategy / DCA / dashboard pages.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left — circuits */}
          <div className="lg:col-span-8 space-y-4">
            <Card className="p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <FileCode size={14} className="text-primary-container" />
                  <p className="text-xs font-medium text-primary-container uppercase tracking-widest">OrderFill circuit</p>
                </div>
                <Badge variant="primary" dot>185-byte preimage</Badge>
              </div>
              <p className="text-xs text-on-surface-variant mb-4">
                Limit orders, stop-loss, and take-profit. The on-chain registry reads Chainlink at fill time
                and passes the live answer as <span className="font-mono">oracle_price</span> — proofs cannot be
                pre-computed against a stale price.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-2">Private witnesses</p>
                  <FieldList items={ORDER_FILL_PRIVATE} />
                </div>
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-2">Public inputs</p>
                  <FieldList items={ORDER_FILL_PUBLIC} />
                </div>
              </div>
              <p className="text-xs text-on-surface-variant mt-4 font-mono leading-relaxed break-all">
                preimage = keccak256(token_in ‖ token_out ‖ size ‖ min_out ‖ expiry ‖ price ‖ direction ‖ nonce ‖ user_secret)
              </p>
            </Card>

            <Card className="p-4 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <FileCode size={14} className="text-secondary" />
                  <p className="text-xs font-medium text-secondary uppercase tracking-widest">DCA circuit</p>
                </div>
                <Badge variant="sovereign" dot>192-byte preimage</Badge>
              </div>
              <p className="text-xs text-on-surface-variant mb-4">
                Time-based dollar-cost averaging. The verifier dispatches on{" "}
                <span className="font-mono">CommitmentKind = DCA</span> and uses{" "}
                <span className="font-mono">block.timestamp</span> as the public fill reference.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-2">Private witnesses</p>
                  <FieldList items={DCA_PRIVATE} />
                </div>
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-2">Public inputs</p>
                  <FieldList items={DCA_PUBLIC} />
                </div>
              </div>
              <p className="text-xs text-on-surface-variant mt-4 font-mono leading-relaxed break-all">
                preimage = keccak256(token_in ‖ token_out ‖ size ‖ min_out ‖ scheduled_lo ‖ scheduled_hi ‖ expiry ‖ nonce ‖ user_secret)
              </p>
            </Card>
          </div>

          {/* Right — stack + threshold */}
          <div className="lg:col-span-4 space-y-4">
            <Card variant="trust-violet" className="p-4 relative">
              <Badge variant="sovereign" dot className="absolute top-3 right-3">Stack</Badge>
              <p className="text-xs text-secondary uppercase tracking-widest mb-1">Cryptographic toolchain</p>
              <h3 className="font-display text-lg md:text-xl font-semibold text-secondary mb-4">PROOF SYSTEM</h3>
              <div className="space-y-3">
                {STACK.map(s => (
                  <div key={s.label} className="pl-3 border-l-2 border-secondary-container py-1">
                    <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-1">{s.label}</p>
                    <p className="font-mono text-xs text-on-surface break-all">{s.value}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={14} className="text-primary-container" />
                <p className="text-xs font-medium text-primary-container uppercase tracking-widest">
                  Path B1 — Threshold keeper
                </p>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                <span className="font-mono">user_secret</span> is Shamir-split into N=5 shares with reconstruction
                threshold k=3. Each share is ECIES-encrypted to a different keeper public key. At fill time the
                keeper coordinator gathers k shares, reconstructs the secret in memory, generates the proof, and
                submits the on-chain transaction. No single keeper has standing access.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <Radio size={12} className="text-on-surface-variant" />
                <span className={cn("text-xs text-on-surface-variant")}>
                  Reconstruction is per-fill, audit-logged, time-bounded.
                </span>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
