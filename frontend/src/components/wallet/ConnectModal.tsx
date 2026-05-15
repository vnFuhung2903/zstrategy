"use client";

import { useConnect, useDisconnect, useAccount } from "wagmi";
import { X, Wallet, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { truncateAddress } from "@/lib/utils";

interface ConnectModalProps {
  open: boolean;
  onClose: () => void;
}

export function ConnectModal({ open, onClose }: ConnectModalProps) {
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { address, isConnected, chain } = useAccount();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-sm rounded-sm bg-surface-container border border-outline-variant/20 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            <Wallet size={16} className="text-primary-container" />
            <span className="font-display font-semibold text-sm text-on-surface">
              {isConnected ? "Wallet Connected" : "Connect Wallet"}
            </span>
          </div>
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {isConnected ? (
            <>
              {/* Connected state */}
              <div className="p-4 rounded-sm bg-surface-container-high border border-outline-variant/10 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary-container shrink-0 shadow-[0_0_6px_rgba(0,240,255,0.6)]" />
                  <span className="font-tabular text-sm text-on-surface">{truncateAddress(address!)}</span>
                </div>
                {chain && (
                  <p className="text-xs text-on-surface-variant">
                    Network: <span className="text-primary-container">{chain.name}</span>
                  </p>
                )}
                <a
                  href={`https://sepolia.arbiscan.io/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary-container transition-colors"
                >
                  View on Arbiscan <ExternalLink size={10} />
                </a>
              </div>

              <Button
                variant="danger"
                size="sm"
                className="w-full"
                onClick={() => { disconnect(); onClose(); }}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <>
              {/* Connector list */}
              <p className="text-xs text-on-surface-variant mb-1">Select a wallet to connect to Arbitrum Sepolia</p>
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  disabled={isPending}
                  onClick={() => { connect({ connector }); }}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-sm bg-surface-container-high border border-outline-variant/10 hover:border-primary-container/30 hover:bg-surface-container transition-all text-left disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-sm bg-surface-container flex items-center justify-center shrink-0">
                    {connector.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={connector.icon} alt={connector.name} className="w-5 h-5 rounded-sm" />
                    ) : (
                      <Wallet size={16} className="text-on-surface-variant" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-on-surface">{connector.name}</span>
                  {isPending && <span className="ml-auto text-xs text-on-surface-variant">Connecting…</span>}
                </button>
              ))}

              <p className="text-[10px] text-on-surface-variant/60 text-center pt-1">
                By connecting, you accept that this is a testnet application.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
