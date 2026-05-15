/**
 * Encrypted-share storage.
 *
 * Each row holds ONE keeper's ECIES-encrypted Shamir share for ONE
 * commitment. Reconstruction reads up to N rows and decrypts k of them
 * with the local keypairs.
 */

import { getDb } from "./db";

export interface ShareRow {
  commitmentHash: string;
  keeperId:       string;
  ciphertext:     string; // 0x-hex
  receivedAt:     number;
}

export function insertShares(commitmentHashes: string[], shares: { keeperId: string; ciphertext: string }[]): void {
  if (commitmentHashes.length === 0 || shares.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO shares (commitment_hash, keeper_id, ciphertext, received_at)
    VALUES (?, ?, ?, ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (const hash of commitmentHashes) {
      for (const r of shares) stmt.run(hash, r.keeperId, r.ciphertext, now);
    }
  });
  tx();
}

export function deleteSharesForCommitment(commitmentHash: string): number {
  const info = getDb()
    .prepare("DELETE FROM shares WHERE commitment_hash = ?")
    .run(commitmentHash);
  return Number(info.changes);
}

export function getSharesForCommitment(commitmentHash: string): ShareRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM shares WHERE commitment_hash = ?")
    .all(commitmentHash) as Record<string, unknown>[];
  return rows.map(r => ({
    commitmentHash: r.commitment_hash as string,
    keeperId:       r.keeper_id as string,
    ciphertext:     r.ciphertext as string,
    receivedAt:     r.received_at as number,
  }));
}

export function shareCountForCommitment(commitmentHash: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM shares WHERE commitment_hash = ?")
    .get(commitmentHash) as { cnt: number };
  return row.cnt;
}
