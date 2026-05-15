import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config";

// ── Schema ─────────────────────────────────────────────────────────────────
//
// Shares table holds per-keeper ECIES-encrypted Shamir shares of user_secret.
// Reconstruction reads these at fill time when /api/execute is triggered.

const SCHEMA = `
-- Threshold keeper: one row per (commitment, keeper) pair. Reconstruction
-- requires k of N to decrypt. keeper_id matches the id published in
-- /api/keepers; the same id maps to a private key in threshold/keys.ts.
CREATE TABLE IF NOT EXISTS shares (
  commitment_hash TEXT NOT NULL,
  keeper_id       TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,  -- ECIES ciphertext, 0x-hex
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (commitment_hash, keeper_id)
);

CREATE INDEX IF NOT EXISTS idx_shares_commitment ON shares(commitment_hash);
`;

// ── DB singleton ────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(config.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(SCHEMA);
  return _db;
}
