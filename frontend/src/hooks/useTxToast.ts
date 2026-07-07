"use client";

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
  successToastEnabled?: boolean;
}

export function useTxToast({ hash, isConfirming, isSuccess, error, label, successToastEnabled = true }: UseTxToastArgs): void {
  const chainId       = useChainId();
  const toastIdRef    = useRef<string | number | null>(null);
  const handledHashRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!hash || hash === handledHashRef.current) return;
    handledHashRef.current = hash;
    toastIdRef.current = toast.loading(`${label}: submitted`, {
      description: "Waiting for on-chain confirmation…",
    });
  }, [hash, label]);

  useEffect(() => {
    if (!isConfirming || !toastIdRef.current) return;
    toast.loading(`${label}: confirming`, {
      id: toastIdRef.current,
      description: "Waiting for on-chain confirmation…",
    });
  }, [isConfirming, label]);

  useEffect(() => {
    if (!isSuccess || !hash) return;
    if (!successToastEnabled) {
      if (toastIdRef.current) toast.dismiss(toastIdRef.current);
      toastIdRef.current = null;
      return;
    }
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
  }, [isSuccess, hash, chainId, label, successToastEnabled]);

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
