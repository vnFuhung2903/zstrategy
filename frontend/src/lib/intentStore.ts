const DB_NAME = "zstrategy";
const DB_VERSION = 2;
const STORE = "intents";
const DCA_STORE = "dca_rounds";

export type IntentDirection = 0 | 1; // 0 = BUY, 1 = SELL

export type IntentKind = "LIMIT" | "MARKET";

export interface IntentRecord {
  commitmentHash: `0x${string}`;
  owner: `0x${string}`;
  intentId: `0x${string}`;
  nonce: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: string;
  minOut: string;
  expiry: number;
  price: string;
  direction: IntentDirection;
  kind: IntentKind;
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

export interface DcaRoundRecord {
  commitmentHash: `0x${string}`;
  owner: `0x${string}`;
  intentId: `0x${string}`;
  nonce: `0x${string}`;
  nullifier: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  size: string;
  minOut: string;
  expiry: number;
  scheduledLo: number;
  scheduledHi: number;
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
