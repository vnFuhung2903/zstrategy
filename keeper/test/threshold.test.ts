/**
 * Round-trip test for the Path B1 threshold-keeper flow.
 *
 * Exercises the same sequence the frontend + Go backend + keeper drive in
 * production:
 *   1. Frontend generates user_secret + Shamir shares + ECIES-encrypts each
 *      to a keeper pubkey from /api/keepers.
 *   2. Go backend forwards the encrypted shares to the keeper, which inserts
 *      one row per (commitmentHash, keeperId) into its shares table.
 *   3. At fill time the keeper's /api/execute calls reconstructUserSecret(),
 *      which reads the rows, decrypts k of N with local privkeys, and
 *      Lagrange-interpolates back to the original 32-byte secret.
 *
 * Asserts: the reconstructed bytes equal the original secret.
 *
 * Run:  npm run test
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// ── Test env: set BEFORE importing src/ modules so config.ts validates ─────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zstrategy-keeper-test-"));

process.env.RPC_URL                     = "http://127.0.0.1:0";
process.env.CHAIN_ID                    = "31337";
process.env.KEEPER_PRIVATE_KEY          = "0x" + "11".repeat(32);
process.env.COMMITMENT_REGISTRY_ADDRESS = "0x" + "22".repeat(20);
process.env.COLLATERAL_VAULT_ADDRESS    = "0x" + "33".repeat(20);
process.env.CHAINLINK_ETH_USD           = "0x" + "44".repeat(20);
process.env.API_SECRET                  = "test-only-secret";
process.env.DB_PATH                     = path.join(TMP, "keeper.db");
process.env.THRESHOLD_KEYS_FILE         = path.join(TMP, "keeper-keys.json");
process.env.THRESHOLD_N                 = "5";
process.env.THRESHOLD_K                 = "3";

// ── Lazy imports (need env above) ──────────────────────────────────────────
import { encrypt as eciesEncrypt } from "eciesjs";
import { split as shamirSplit } from "shamir-secret-sharing";
import { loadOrCreateKeypairs, publicKeyset } from "../src/threshold/keys";
import { reconstructUserSecret } from "../src/threshold/reconstruct";
import { insertShares } from "../src/store/shares";

after(() => {
  // Clean up the temp dir; ignore errors so a failed test still tears down.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

before(() => {
  // Force keypair generation up-front so the publicKeyset is stable.
  loadOrCreateKeypairs();
});

test("threshold: split + encrypt + reconstruct round-trip", async () => {
  const keepers = publicKeyset();
  assert.equal(keepers.length, 5, "expected N=5 keepers");

  // 1. Generate a random 32-byte user_secret (matches deriveUserSecret output).
  const userSecret = crypto.randomBytes(32);

  // 2. Shamir-split into N=5 shares, threshold k=3.
  const shares = await shamirSplit(new Uint8Array(userSecret), 5, 3);
  assert.equal(shares.length, 5);

  // 3. ECIES-encrypt each share to its keeper's pubkey.
  const encryptedShares = shares.map((share, i) => {
    const pubkey = Buffer.from(keepers[i].pubkey.slice(2), "hex");
    const ciphertext = eciesEncrypt(pubkey, Buffer.from(share));
    return {
      keeperId:   keepers[i].id,
      ciphertext: "0x" + Buffer.from(ciphertext).toString("hex"),
    };
  });

  // 4. Persist the encrypted shares keyed by commitmentHash.
  const commitmentHash = "0x" + crypto.randomBytes(32).toString("hex");
  insertShares([commitmentHash], encryptedShares);

  // 5. Reconstruct from the DB and assert byte-equality with the original.
  const recovered = await reconstructUserSecret(commitmentHash);
  assert.equal(recovered, "0x" + userSecret.toString("hex"));
});

test("threshold: reconstruction fails when fewer than k shares are stored", async () => {
  const keepers = publicKeyset();
  const userSecret = crypto.randomBytes(32);
  const shares = await shamirSplit(new Uint8Array(userSecret), 5, 3);

  // Only insert 2 of 5 shares — below the k=3 threshold.
  const partial = shares.slice(0, 2).map((share, i) => {
    const pubkey = Buffer.from(keepers[i].pubkey.slice(2), "hex");
    const ciphertext = eciesEncrypt(pubkey, Buffer.from(share));
    return {
      keeperId:   keepers[i].id,
      ciphertext: "0x" + Buffer.from(ciphertext).toString("hex"),
    };
  });

  const commitmentHash = "0x" + crypto.randomBytes(32).toString("hex");
  insertShares([commitmentHash], partial);

  await assert.rejects(() => reconstructUserSecret(commitmentHash), /not enough shares/);
});

test("threshold: DCA-style fan-out — one share set, multiple round hashes", async () => {
  const keepers = publicKeyset();
  const userSecret = crypto.randomBytes(32);
  const shares = await shamirSplit(new Uint8Array(userSecret), 5, 3);

  const encryptedShares = shares.map((share, i) => {
    const pubkey = Buffer.from(keepers[i].pubkey.slice(2), "hex");
    const ciphertext = eciesEncrypt(pubkey, Buffer.from(share));
    return {
      keeperId:   keepers[i].id,
      ciphertext: "0x" + Buffer.from(ciphertext).toString("hex"),
    };
  });

  // Three rounds of a DCA group, all sharing the same user_secret.
  const roundHashes = [
    "0x" + crypto.randomBytes(32).toString("hex"),
    "0x" + crypto.randomBytes(32).toString("hex"),
    "0x" + crypto.randomBytes(32).toString("hex"),
  ];
  insertShares(roundHashes, encryptedShares);

  // Each round must independently reconstruct the same secret.
  for (const h of roundHashes) {
    const recovered = await reconstructUserSecret(h);
    assert.equal(recovered, "0x" + userSecret.toString("hex"));
  }
});
