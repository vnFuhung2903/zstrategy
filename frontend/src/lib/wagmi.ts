import { createConfig, http } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

// EIP-1559 fee fields spread into every `useWriteContract` call.
//
// Why we set these explicitly: viem's wallet path
// (`sendTransaction` for `account.type === 'json-rpc'`) ships the request
// straight to the wallet via `eth_sendTransaction` and does NOT call
// `chain.fees.estimateFeesPerGas`. The wallet then estimates fees itself;
// on Arbitrum Sepolia, MetaMask/WalletConnect query
// `eth_maxPriorityFeePerGas` (returns ~0.02 gwei = 20_000_000 wei) and use
// that as `maxFeePerGas`, which can be below `block.baseFee` at inclusion
// time → "max fee per gas less than block base fee" revert.
//
// `maxFeePerGas` is just a ceiling under EIP-1559; the user pays
// `baseFee + min(tip, maxPriorityFeePerGas)`. Arbitrum Sepolia baseFee is
// consistently <0.01 gwei, so 1 gwei is 100×+ headroom at zero extra cost.
// `maxPriorityFeePerGas = 0n` is safe — Arbitrum's sequencer doesn't run a
// priority auction.
export const FEE_OVERRIDES = {
  maxFeePerGas:         1_000_000_000n, // 1 gwei ceiling
  maxPriorityFeePerGas: 0n,
} as const;

export const config = createConfig({
  chains: [arbitrumSepolia],
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
