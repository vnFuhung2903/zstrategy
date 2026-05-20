"use client";

/**
 * Wagmi tx → Sonner toast bridge.
 *
 * Mounts once per write hook. Tracks the `hash` produced by wagmi's
 * `useWriteContract` and emits a single sticky toast through its lifecycle:
 *
 *   submit  →  loading toast  (anchored by toast id)
 *   confirm →  success toast with "View on <explorer>" action
 *   revert  →  error toast with shortMessage
 *
 * Errors thrown before the wallet returns a hash (user-rejection, RPC
 * unavailable, simulation revert) are surfaced too — they arrive on `error`
 * with no `hash`, so we still show a transient error toast.
 *
 * Multiple consumers can call this hook with the same `label` safely: each
 * hook instance gets its own toast id so two simultaneous deposits show two
 * separate toasts.
 */

import { useEffect, useRef } from "react";
import { useChainId } from "wagmi";
import { toast } from "sonner";
import { getTxUrl, explorerName } from "@/lib/explorerUrl";

interface UseTxToastArgs {
  hash:          `0x${string}` | undefined;
  isConfirming:  boolean;
  isSuccess:     boolean;
  error:         Error | null;
  label:         string;
}

export function useTxToast({ hash, isConfirming, isSuccess, error, label }: UseTxToastArgs): void {
  const chainId       = useChainId();
  const toastIdRef    = useRef<string | number | null>(null);
  const handledHashRef = useRef<string | undefined>(undefined);

  // Tx hash assigned: wallet accepted, broadcasting → loading toast.
  useEffect(() => {
    if (!hash || hash === handledHashRef.current) return;
    handledHashRef.current = hash;
    toastIdRef.current = toast.loading(`${label}: submitted`, {
      description: "Waiting for on-chain confirmation…",
    });
  }, [hash, label]);

  // Confirming on-chain — keep the toast open, refine wording.
  useEffect(() => {
    if (!isConfirming || !toastIdRef.current) return;
    toast.loading(`${label}: confirming`, {
      id: toastIdRef.current,
      description: "Waiting for on-chain confirmation…",
    });
  }, [isConfirming, label]);

  // Confirmed — flip to success with explorer link.
  useEffect(() => {
    if (!isSuccess || !hash) return;
    const url = getTxUrl(chainId, hash);
    toast.success(`${label} confirmed`, {
      id: toastIdRef.current ?? undefined,
      description: `Tx ${hash.slice(0, 10)}…${hash.slice(-6)}`,
      duration: 8000,
      action: url
        ? { label: `View on ${explorerName(chainId)} ↗`, onClick: () => window.open(url, "_blank", "noopener,noreferrer") }
        : undefined,
    });
    toastIdRef.current = null;
  }, [isSuccess, hash, chainId, label]);

  // Failure — wagmi exposes `shortMessage` on viem-thrown errors which is
  // much more user-friendly than the full stack-trace message.
  useEffect(() => {
    if (!error) return;
    const short = (error as { shortMessage?: string }).shortMessage ?? error.message ?? "Transaction failed";
    toast.error(`${label} failed`, {
      id: toastIdRef.current ?? undefined,
      description: short.slice(0, 200),
      duration: 10000,
    });
    toastIdRef.current = null;
  }, [error, label]);
}
