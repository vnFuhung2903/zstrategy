// ── Shared type aliases ───────────────────────────────────────────────────────

export type Direction  = "BUY" | "SELL";
export type OrderKind  = "ORDER_FILL" | "DCA";

// ── ExecuteRequest ────────────────────────────────────────────────────────────
//
// Payload delivered to the keeper's POST /api/execute by the Go backend monitor
// when a fill condition is met. The keeper re-verifies the condition, reconstructs
// user_secret from stored shares, generates the ZK proof, and submits the tx.

export interface ExecuteRequest {
  commitmentHash: string;
  kind:           OrderKind;
  tokenIn:        string;
  tokenOut:       string;
  size:           bigint;
  minOut:         bigint;
  expiry:         number;
  limitPrice:     bigint;   // 8-dec Chainlink; 0n for DCA
  direction:      Direction;
  nonce:          string;   // "0x..." bytes32
  nullifier:      string;   // "0x..." bytes32
  scheduledLo?:   number;   // DCA only
  scheduledHi?:   number;   // DCA only
  userSecret:     string;   // reconstructed by /api/execute handler before calling submitter
}

// ── Keeper state (in-memory snapshot) ────────────────────────────────────────

export interface KeeperState {
  startedAt:     number;
  executedCount: number;
  failedCount:   number;
  blockNumber:   number;
}
