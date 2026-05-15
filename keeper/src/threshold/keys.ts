/**
 * Keeper-network keypair management (Path B1, in-process simulation).
 *
 * In the single-process simulation this module owns N secp256k1 keypairs —
 * one per simulated keeper node. Frontend ECIES-encrypts each Shamir share
 * to one of these public keys; reconstruction at fill time uses the matching
 * private key to decrypt.
 *
 * When the network goes multi-process, each keeper process owns ONE keypair
 * and reaches peers over the network for the rest. The function signatures
 * here are designed to ease that migration: `getKeypairById` returns the
 * local secret only when this process is responsible for that id; otherwise
 * it returns null and the coordination layer is expected to fetch via RPC.
 */

import fs from "fs";
import path from "path";
import { PrivateKey } from "eciesjs";
import { config } from "../config";

export interface KeeperKeypair {
  id: string;       // "keeper-0", "keeper-1", ...
  pubkey: string;   // 0x-prefixed compressed (33 bytes) or uncompressed (65 bytes) hex
  privateKey: PrivateKey;
}

export interface KeeperPubkey {
  id: string;
  pubkey: string;
}

let _keys: KeeperKeypair[] | null = null;

/**
 * Load existing keypairs from disk or generate a fresh set.
 *
 * SECURITY: keys-on-disk is acceptable for the prototype but not for a real
 * deployment. Production should load from a HSM/KMS or per-process env var
 * and never persist private material to disk in plaintext.
 */
export function loadOrCreateKeypairs(): KeeperKeypair[] {
  if (_keys) return _keys;

  const file = config.thresholdKeysFile;
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, "utf-8")) as { id: string; privateKey: string }[];
    if (stored.length !== config.thresholdN) {
      throw new Error(
        `Threshold key file has ${stored.length} keys but THRESHOLD_N=${config.thresholdN}. ` +
        `Delete ${file} to regenerate.`,
      );
    }
    _keys = stored.map(s => {
      const pk = new PrivateKey(Buffer.from(s.privateKey.slice(2), "hex"));
      return {
        id:         s.id,
        pubkey:     "0x" + Buffer.from(pk.publicKey.toBytes(false)).toString("hex"),
        privateKey: pk,
      };
    });
    console.log(`[Threshold] Loaded ${_keys.length} keeper keypairs from ${file}`);
    return _keys;
  }

  // Generate fresh keys.
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _keys = [];
  for (let i = 0; i < config.thresholdN; i++) {
    const pk = new PrivateKey();
    _keys.push({
      id:         `keeper-${i}`,
      pubkey:     "0x" + Buffer.from(pk.publicKey.toBytes(false)).toString("hex"),
      privateKey: pk,
    });
  }

  const onDisk = _keys.map(k => ({
    id:         k.id,
    privateKey: "0x" + Buffer.from(k.privateKey.secret).toString("hex"),
  }));
  fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  console.log(`[Threshold] Generated ${_keys.length} keeper keypairs and saved to ${file}`);

  return _keys;
}

/** Public-facing keyset for `GET /api/keepers`. Strips private material. */
export function publicKeyset(): KeeperPubkey[] {
  return loadOrCreateKeypairs().map(k => ({ id: k.id, pubkey: k.pubkey }));
}

/** Lookup the local privkey by id. Returns null if this process doesn't own it. */
export function getKeypairById(id: string): KeeperKeypair | null {
  return loadOrCreateKeypairs().find(k => k.id === id) ?? null;
}
