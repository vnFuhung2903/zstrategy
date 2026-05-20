/**
 * Block-explorer URL helpers per chain.
 *
 * Returns `null` for chains without a public explorer (e.g. local Hardhat),
 * so callers can omit the "View on explorer" action rather than render a
 * broken link.
 */

import { arbitrumSepolia, baseSepolia, hardhat } from "wagmi/chains";

const TX_PREFIX: Record<number, string | null> = {
  [arbitrumSepolia.id]: "https://sepolia.arbiscan.io/tx/",
  [baseSepolia.id]:     "https://sepolia.basescan.org/tx/",
  [hardhat.id]:         null,
};

export function getTxUrl(chainId: number, txHash: string): string | null {
  const prefix = TX_PREFIX[chainId];
  if (!prefix) return null;
  return `${prefix}${txHash}`;
}

export function explorerName(chainId: number): string {
  if (chainId === arbitrumSepolia.id) return "Arbiscan";
  if (chainId === baseSepolia.id)     return "Basescan";
  return "explorer";
}
