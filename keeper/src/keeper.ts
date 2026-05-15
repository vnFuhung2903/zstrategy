import { config } from "./config";
import { KeeperState } from "./types";

export const state: KeeperState = {
  startedAt:     Math.floor(Date.now() / 1000),
  executedCount: 0,
  failedCount:   0,
  blockNumber:   0,
};

// ── Main entry point ────────────────────────────────────────────────────────

export async function startKeeper(): Promise<void> {
  console.log("[Keeper] Starting zstrategy keeper node...");
  console.log(`[Keeper] Chain ID: ${config.chainId} | API port: ${config.apiPort}`);
  console.log("[Keeper] Fill-condition monitoring delegated to Go backend.");
  console.log("[Keeper] Waiting for execution triggers on POST /api/execute");
}
