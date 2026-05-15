import { TOKENS } from "./contracts";

export type TokenMeta = {
  name:     string;
  address:  `0x${string}`;
  decimals: number;
  logoSrc:  string;
};

export type TradingPair = {
  label:      string;
  baseToken:  TokenMeta;
  quoteToken: TokenMeta;
};

const WETH: TokenMeta = {
  name: "WETH", address: TOKENS.WETH, decimals: 18, logoSrc: "/tokens/weth.svg",
};
const USDC: TokenMeta = {
  name: "USDC", address: TOKENS.USDC, decimals: 6,  logoSrc: "/tokens/usdc.svg",
};
const USDT: TokenMeta = {
  name: "USDT", address: TOKENS.USDT, decimals: 6,  logoSrc: "/tokens/usdt.svg",
};
const WBTC: TokenMeta = {
  name: "WBTC", address: TOKENS.WBTC, decimals: 8,  logoSrc: "/tokens/wbtc.svg",
};

export const TRADING_PAIRS: TradingPair[] = [
  { label: "WETH/USDC", baseToken: WETH, quoteToken: USDC },
  { label: "WETH/USDT", baseToken: WETH, quoteToken: USDT },
  { label: "WBTC/USDC", baseToken: WBTC, quoteToken: USDC },
  { label: "WBTC/USDT", baseToken: WBTC, quoteToken: USDT },
];

export const DEFAULT_PAIR = TRADING_PAIRS[0];
