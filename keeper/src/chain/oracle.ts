import { ethers } from "ethers";
import { provider } from "./provider";
import { config } from "../config";

const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() external view returns (uint8)",
];

const REGISTRY_FEED_ABI = [
  "function priceFeeds(address token) external view returns (address)",
];

async function fetchFeed(feedAddress: string): Promise<{ answer: bigint; decimals: number }> {
  const feed = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
  const [[, answer], decimals] = await Promise.all([
    feed.latestRoundData(),
    feed.decimals(),
  ]);
  if (BigInt(answer) <= 0n) throw new Error(`Oracle: non-positive price from feed ${feedAddress}`);
  return { answer: BigInt(answer), decimals: Number(decimals) };
}

/**
 * Derive the tokenIn/tokenOut pair price from two Chainlink USD feeds registered
 * in CommitmentRegistry.priceFeeds. Mirrors _readOraclePrice:
 *   normIn  = answerIn  * 10^(18 - dIn)
 *   normOut = answerOut * 10^(18 - dOut)
 *   priceU  = normIn * 10^dOut / normOut   (dOut decimal places)
 */
export async function fetchPairPrice(tokenIn: string, tokenOut: string): Promise<bigint> {
  const registry = new ethers.Contract(config.registryAddress, REGISTRY_FEED_ABI, provider);

  const [feedInAddr, feedOutAddr] = await Promise.all([
    registry.priceFeeds(tokenIn),
    registry.priceFeeds(tokenOut),
  ]);

  if (feedInAddr === ethers.ZeroAddress)
    throw new Error(`Oracle: no USD feed configured for tokenIn ${tokenIn}`);
  if (feedOutAddr === ethers.ZeroAddress)
    throw new Error(`Oracle: no USD feed configured for tokenOut ${tokenOut}`);

  const [feedIn, feedOut] = await Promise.all([
    fetchFeed(feedInAddr),
    fetchFeed(feedOutAddr),
  ]);

  const normIn  = feedIn.answer  * 10n ** BigInt(18 - feedIn.decimals);
  const normOut = feedOut.answer * 10n ** BigInt(18 - feedOut.decimals);
  const priceU  = normIn * 10n ** BigInt(feedOut.decimals) / normOut;

  if (priceU <= 0n) throw new Error("Oracle: derived pair price is zero");
  if (priceU > 2n ** 64n - 1n) throw new Error("Oracle: pair price overflows uint64");

  return priceU;
}
