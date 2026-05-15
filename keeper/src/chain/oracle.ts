import { ethers } from "ethers";
import { provider } from "./provider";
import { config } from "../config";
import { OraclePrice } from "../types";

// Chainlink AggregatorV3Interface — minimal ABI
const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() external view returns (uint8)",
];

// Maps feed address → pair label for display
const FEED_LABELS: Record<string, string> = {
  [config.chainlinkEthUsd.toLowerCase()]: "ETH/USD",
};

export class ChainlinkOracle {
  private readonly contract: ethers.Contract;
  private readonly feedAddress: string;
  private decimals: number | null = null;

  constructor(feedAddress: string) {
    this.feedAddress = feedAddress.toLowerCase();
    this.contract = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
  }

  async fetchPrice(): Promise<OraclePrice> {
    if (this.decimals === null) {
      this.decimals = Number(await this.contract.decimals());
    }

    const [, answer, , updatedAt] = await this.contract.latestRoundData();

    if (answer <= 0n) throw new Error(`Oracle: non-positive price from ${this.feedAddress}`);

    return {
      pair:      FEED_LABELS[this.feedAddress] ?? this.feedAddress,
      price:     BigInt(answer),          // raw, decimals in this.decimals
      updatedAt: Number(updatedAt),
    };
  }

  getDecimals(): number {
    if (this.decimals === null) throw new Error("Oracle: decimals not fetched yet");
    return this.decimals;
  }
}

// Singleton for ETH/USD feed
export const ethUsdOracle = new ChainlinkOracle(config.chainlinkEthUsd);
