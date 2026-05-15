/**
 * Threshold reconstruction at fill time (Path B1).
 *
 * Reads `k` encrypted shares from the keeper's local DB, decrypts each with
 * the matching private key (from the in-process keyset), and runs Shamir
 * Lagrange interpolation in GF(256) to recover `user_secret`.
 *
 * The reconstructed secret is returned as a hex string. CALLERS MUST WIPE
 * THEIR REFERENCE AS SOON AS POSSIBLE — node.js gives no real guarantee but
 * we minimise the lifetime by passing it directly into proof generation.
 *
 * In the in-process simulation, "k of N keepers cooperate" collapses to "the
 * single process iterates its own N keypairs and grabs the first k shares
 * that decrypt successfully." When the network goes multi-process, this
 * function changes to: gather k shares via peer RPC, decrypt only the
 * leader's own share locally, and combine.
 */

import { decrypt as eciesDecrypt } from "eciesjs";
import { combine } from "shamir-secret-sharing";
import { config } from "../config";
import { getKeypairById } from "./keys";
import { getSharesForCommitment } from "../store/shares";

export async function reconstructUserSecret(commitmentHash: string): Promise<string> {
  const shares = getSharesForCommitment(commitmentHash);
  if (shares.length < config.thresholdK) {
    throw new Error(
      `[Reconstruct] not enough shares for ${commitmentHash.slice(0, 10)}…: ` +
      `have ${shares.length}, need ${config.thresholdK}`,
    );
  }

  // Decrypt the first k shares we can. In multi-process mode, only the share
  // for this keeper's id is decrypted locally; others arrive pre-decrypted
  // from peers (via re-encryption to leader's pubkey).
  const decrypted: Uint8Array[] = [];
  for (const row of shares) {
    if (decrypted.length >= config.thresholdK) break;
    const kp = getKeypairById(row.keeperId);
    if (!kp) {
      console.warn(`[Reconstruct] no local key for ${row.keeperId} — skipping`);
      continue;
    }
    try {
      const ciphertext = Buffer.from(row.ciphertext.slice(2), "hex");
      const plain = eciesDecrypt(kp.privateKey.secret, ciphertext);
      decrypted.push(new Uint8Array(plain));
    } catch (err) {
      console.warn(`[Reconstruct] failed to decrypt share ${row.keeperId}: ${err}`);
    }
  }

  if (decrypted.length < config.thresholdK) {
    throw new Error(
      `[Reconstruct] insufficient decryptable shares for ${commitmentHash.slice(0, 10)}…: ` +
      `decrypted ${decrypted.length}, needed ${config.thresholdK}`,
    );
  }

  const secretBytes = await combine(decrypted);
  if (secretBytes.length !== 32) {
    throw new Error(`[Reconstruct] expected 32-byte secret, got ${secretBytes.length}`);
  }

  return "0x" + Buffer.from(secretBytes).toString("hex");
}
