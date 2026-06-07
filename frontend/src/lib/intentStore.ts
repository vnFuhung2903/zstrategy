/**
 * IndexedDB-backed store for local intent metadata.
 *
 * Intent witness data never goes on-chain — only the commitment hash does. This
 * store keeps the metadata that the user (and only the user) needs to:
 *   - re-derive `user_secret` from a wallet signature on `intentId`
 *   - re-compute the nullifier for cancel/self-execute
 *   - re-generate the ZK proof at fill time
 *
 * `userSecret` is intentionally NOT stored. It is derived deterministically
 * from `keccak256(sign(wallet, intentId))`, so the wallet itself is the only
 * persistent secret material.
 */

const DB_NAME = "zstrategy";
const DB_VERSION = 2;
const STORE = "intents";
const DCA_STORE = "dca_rounds";

export type IntentDirection = 0 | 1; // 0 = BUY, 1 = SELL

/**
 * Frontend-only discriminator for display and form UX.
 * Does NOT affect the ZK circuit or contract — both still see kind=0 (ORDER_FILL).
 *
 * - LIMIT:  user-selected BUY or SELL, fills at a target price (oracle-polled fill)
 * - MARKET: user-selected BUY or SELL, fills immediately at current oracle price.
 *           Encoded with a sentinel commitment price (u64.max for BUY, 0 for SELL)
 *           so the circuit's fill check trivially passes. Backend schedules
 *           enclave proving immediately.
 */
export type IntentKind = "LIMIT" | "MARKET";

export interface IntentRecord {
  /** Primary key — keccak256(preimage). */
  commitmentHash: `0x${string}`;
  /** Wallet that owns this intent (lowercased EIP-55 address as 0x string). */
  owner: `0x${string}`;
  /** Per-intent id signed by the wallet to derive `user_secret`. */
  intentId: `0x${string}`;
  /** Random 32-byte nonce, included in the preimage. */
  nonce: `0x${string}`;
  /** On-chain registration fields (kept here for offline display + proof gen). */
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: string; // bigint stringified
  minOut: string; // bigint stringified
  expiry: number;
  /** Private fields — these are the ones that justify the privacy story. */
  price: string; // bigint stringified, in oracle decimals (e.g. 8 for Chainlink ETH/USD)
  direction: IntentDirection;
  /** UI discriminator — frontend-only, not in the circuit or contract. */
  kind: IntentKind;
  /** Local lifecycle. */
  createdAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "commitmentHash" });
        store.createIndex("owner", "owner", { unique: false });
      }
      if (!db.objectStoreNames.contains(DCA_STORE)) {
        const dcaStore = db.createObjectStore(DCA_STORE, { keyPath: "commitmentHash" });
        dcaStore.createIndex("dcaGroupId", "dcaGroupId", { unique: false });
        dcaStore.createIndex("owner", "owner", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveIntent(record: IntentRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listIntentsForOwner(owner: `0x${string}`): Promise<IntentRecord[]> {
  const db = await openDb();
  const ownerKey = owner.toLowerCase() as `0x${string}`;
  const result = await new Promise<IntentRecord[]>((resolve, reject) => {
    const req = db
      .transaction(STORE, "readonly")
      .objectStore(STORE)
      .index("owner")
      .getAll(ownerKey);
    req.onsuccess = () => resolve((req.result as IntentRecord[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

// ── DCA round store ───────────────────────────────────────────────────────────

export interface DcaRoundRecord {
  /** Primary key — dcaCommitmentHash for this round. */
  commitmentHash: `0x${string}`;
  owner: `0x${string}`;
  /** Shared across all rounds in the group; the message signed by the wallet. */
  intentId: `0x${string}`;
  /** Per-round random nonce, included in the preimage. */
  nonce: `0x${string}`;
  nullifier: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: string;
  minOut: string;
  expiry: number;
  /** Private execution window — stored locally only. */
  scheduledLo: number;
  scheduledHi: number;
  /** 0-indexed position within the DCA group. */
  roundIndex: number;
  createdAt: number;
}

export async function saveDcaRounds(rounds: DcaRoundRecord[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DCA_STORE, "readwrite");
    const store = tx.objectStore(DCA_STORE);
    for (const r of rounds) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
