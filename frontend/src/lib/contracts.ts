import { arbitrumSepolia } from "wagmi/chains";

// ── Deployed addresses (override via env) ─────────────────────────────────────
export const ADDRESSES = {
  [arbitrumSepolia.id]: {
    commitmentRegistry: (process.env.NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
    collateralVault:    (process.env.NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS    ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
    gasVault:           (process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS           ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  },
} as const;

// ── Known tokens on Arbitrum Sepolia ─────────────────────────────────────────
export const TOKENS = {
  WETH:  (process.env.NEXT_PUBLIC_WETH_ADDRESS ?? "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73") as `0x${string}`,
  USDC:  (process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as `0x${string}`,
  USDT:  (process.env.NEXT_PUBLIC_USDT_ADDRESS  ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
  WBTC:  (process.env.NEXT_PUBLIC_WBTC_ADDRESS  ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
} as const;

// ── ABIs (minimal — only user-facing functions) ───────────────────────────────
export const COMMITMENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "registerCommitment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "tokenIn",        type: "address" },
      { name: "tokenOut",       type: "address" },
      { name: "size",           type: "uint256" },
      { name: "minOut",         type: "uint256" },
      { name: "expiry",         type: "uint64"  },
      { name: "kind",           type: "uint8"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "registerCommitmentBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHashes", type: "bytes32[]" },
      { name: "tokenIn",          type: "address"   },
      { name: "tokenOut",         type: "address"   },
      { name: "sizes",            type: "uint256[]" },
      { name: "minOuts",          type: "uint256[]" },
      { name: "expiries",         type: "uint64[]"  },
      { name: "kind",             type: "uint8"     },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelCommitment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "nullifier",      type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeCommitment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "nullifier",      type: "bytes32" },
      { name: "proof",          type: "bytes"   },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getCommitment",
    stateMutability: "view",
    inputs: [{ name: "commitmentHash", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "owner",   type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut",type: "address" },
          { name: "size",    type: "uint256" },
          { name: "minOut",  type: "uint256" },
          { name: "expiry",  type: "uint64"  },
          { name: "status",  type: "uint8"   },
          { name: "kind",    type: "uint8"   },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getCommitmentStatus",
    stateMutability: "view",
    inputs: [{ name: "commitmentHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "priceFeeds",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn",  type: "address" },
      { name: "tokenOut", type: "address" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "CommitmentRegistered",
    inputs: [
      { name: "commitmentHash", type: "bytes32", indexed: true },
      { name: "owner",          type: "address", indexed: true },
      { name: "tokenIn",        type: "address", indexed: false },
      { name: "tokenOut",       type: "address", indexed: false },
      { name: "size",           type: "uint256", indexed: false },
      { name: "expiry",         type: "uint64",  indexed: false },
      { name: "kind",           type: "uint8",   indexed: false },
    ],
  },
  {
    type: "event",
    name: "CommitmentExecuted",
    inputs: [
      { name: "commitmentHash", type: "bytes32", indexed: true },
      { name: "owner",          type: "address", indexed: true },
      { name: "executor",       type: "address", indexed: true },
      { name: "nullifier",      type: "bytes32", indexed: false },
      { name: "fillRef",        type: "uint64",  indexed: false },
      { name: "amountOut",      type: "uint256", indexed: false },
      { name: "kind",           type: "uint8",   indexed: false },
    ],
  },
  {
    type: "event",
    name: "CommitmentCancelled",
    inputs: [
      { name: "commitmentHash", type: "bytes32", indexed: true },
      { name: "owner",          type: "address", indexed: true },
    ],
  },
] as const;

export const COLLATERAL_VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token",  type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token",  type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "freeBalance",
    stateMutability: "view",
    inputs: [
      { name: "user",  type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lockedBalance",
    stateMutability: "view",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "token",          type: "address"  },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "user",   type: "address", indexed: true },
      { name: "token",  type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user",   type: "address", indexed: true },
      { name: "token",  type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// Minimal Chainlink AggregatorV3Interface — only the calls the self-execute
// flow needs (latestRoundData for proof gen, decimals for sanity).
export const PRICE_FEED_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId",         type: "uint80"  },
      { name: "answer",          type: "int256"  },
      { name: "startedAt",       type: "uint256" },
      { name: "updatedAt",       type: "uint256" },
      { name: "answeredInRound", type: "uint80"  },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

// Gas tank — prepaid keeper-gas reimbursement. User funds in native ETH; the
// registry debits this balance at executeCommitment time and forwards to the
// keeper EOA with a flat KEEPER_PREMIUM_BPS premium.
export const GAS_VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "user",   type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "user",   type: "address", indexed: true  },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Debited",
    inputs: [
      { name: "user",           type: "address", indexed: true  },
      { name: "keeper",         type: "address", indexed: true  },
      { name: "amount",         type: "uint256", indexed: false },
      { name: "commitmentHash", type: "bytes32", indexed: true  },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner",   type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
