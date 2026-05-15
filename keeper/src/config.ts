import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  rpcUrl:                   required("RPC_URL"),
  chainId:                  parseInt(required("CHAIN_ID")),
  keeperPrivateKey:         required("KEEPER_PRIVATE_KEY"),

  registryAddress:          required("COMMITMENT_REGISTRY_ADDRESS"),
  vaultAddress:             required("COLLATERAL_VAULT_ADDRESS"),

  chainlinkEthUsd:          required("CHAINLINK_ETH_USD"),

  maxRetries:               parseInt(optional("MAX_RETRIES", "5")),
  retryBaseDelayMs:         parseInt(optional("RETRY_BASE_DELAY_MS", "2000")),

  apiPort:                  parseInt(optional("API_PORT", "3001")),
  apiSecret:                required("API_SECRET"),
  // Cap on /api/shares + /api/execute body size. Generous default — encrypted
  // share arrays for a 10-round DCA with N=5 keepers fit well under 64kb.
  apiBodyLimit:             optional("API_BODY_LIMIT", "256kb"),

  // Backend URL for keeper→backend callbacks (e.g. marking a strategy DONE
  // after a definitive on-chain revert so the monitor goroutine stops retrying).
  // Empty means "no callbacks"; the periodic stuck-EXECUTING sweeper still recovers.
  backendUrl:               optional("BACKEND_URL", ""),

  dbPath:                   optional("DB_PATH", "./data/keeper.db"),

  // Path to the compiled Noir circuit JSON (`nargo compile` output). Loaded
  // once on first proof generation. Resolved relative to process.cwd() if not
  // absolute, with a default that works from a typical `keeper/` cwd.
  circuitJsonPath:          optional("CIRCUIT_JSON_PATH",     "../circuits/order_fill/target/order_fill.json"),
  dcaCircuitJsonPath:       optional("DCA_CIRCUIT_JSON_PATH", "../circuits/dca/target/dca.json"),

  // ── Threshold keeper (Path B1) ────────────────────────────────────────────
  // Number of keeper "nodes" simulated in this process (prototype). When the
  // network goes multi-process, this becomes 1 per process and the count is
  // taken from a shared registry. Threshold k must be ≤ N.
  thresholdN:               parseInt(optional("THRESHOLD_N", "5")),
  thresholdK:               parseInt(optional("THRESHOLD_K", "3")),

  // Comma-separated 32-byte hex private keys, one per simulated keeper. If
  // unset, fresh keys are generated on startup and stored at THRESHOLD_KEYS_FILE.
  // Production uses one private key per process loaded from a HSM/KMS.
  thresholdKeysFile:        optional("THRESHOLD_KEYS_FILE", "./data/keeper-keys.json"),
} as const;
