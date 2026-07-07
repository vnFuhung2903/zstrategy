import { createConfig, http } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export const FEE_OVERRIDES = {
  gas:                  200_000_000n,
  maxFeePerGas:         1_000_000_000n,
  maxPriorityFeePerGas: 0n,
} as const;

export const config = createConfig({
  chains: [arbitrumSepolia],
  ssr: true,
  connectors: [
    injected(),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [arbitrumSepolia.id]: http(
      process.env.NEXT_PUBLIC_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc"
    ),
  },
});
