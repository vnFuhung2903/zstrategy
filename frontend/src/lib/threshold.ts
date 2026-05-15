/**
 * Threshold-keeper share distribution.
 *
 * `user_secret` (32 random bytes derived from the wallet signature) is split
 * into N Shamir shares with reconstruction threshold k. Each share is
 * encrypted with ECIES (secp256k1) to a different keeper's public key. No
 * keeper can read its share without its own private key, and no fewer than
 * k keepers can reconstruct the secret.
 *
 * SECURITY NOTE: this module assumes the keeper public-key set is authentic.
 * In the prototype, keys are fetched from `GET /api/keepers` (single-process
 * simulation) or from a hardcoded keeper-registry contract once the network
 * is real. A man-in-the-middle on key fetch would let an attacker substitute
 * their own pubkeys and trivially recover the secret — production deployment
 * should pin keys via on-chain registry + signed delivery.
 */

import { encrypt as eciesEncrypt } from "eciesjs";
import { split as shamirSplit } from "shamir-secret-sharing";
import { hexToBytes, bytesToHex } from "viem";

export const SHAMIR_THRESHOLD_K = parseInt(process.env.NEXT_PUBLIC_SHAMIR_K ?? "2");
export const SHAMIR_NODES_N     = parseInt(process.env.NEXT_PUBLIC_SHAMIR_N ?? "3");

export interface KeeperPubkey {
  /** Stable identifier for the keeper, e.g. "keeper-0" or its operator address. */
  id: string;
  /** secp256k1 public key, uncompressed 65-byte hex (`0x04` || x || y) or compressed 33-byte. */
  pubkey: `0x${string}`;
}

export interface EncryptedShare {
  keeperId: string;
  /** ECIES ciphertext of the raw Shamir share, hex-encoded. */
  ciphertext: `0x${string}`;
}

/**
 * Split `user_secret` into N shares (k-of-N threshold) and ECIES-encrypt each
 * to its destination keeper's pubkey.
 *
 * The order of `keepers` matters — share `i` is bound to `keepers[i]`. Keeper
 * `i` is expected to know its own index from the coordinator's response, or
 * from looking itself up in the published key set.
 */
export async function splitAndEncryptSecret(
  userSecret: `0x${string}`,
  keepers: KeeperPubkey[],
): Promise<EncryptedShare[]> {
  if (keepers.length !== SHAMIR_NODES_N) {
    throw new Error(`expected ${SHAMIR_NODES_N} keepers, got ${keepers.length}`);
  }

  const secretBytes = hexToBytes(userSecret);
  if (secretBytes.length !== 32) {
    throw new Error(`user_secret must be 32 bytes, got ${secretBytes.length}`);
  }

  const shares = await shamirSplit(secretBytes, SHAMIR_NODES_N, SHAMIR_THRESHOLD_K);
  if (shares.length !== SHAMIR_NODES_N) {
    throw new Error("shamir-secret-sharing returned wrong share count");
  }

  return shares.map((share, i) => {
    const pubkeyBytes = hexToBytes(keepers[i].pubkey);
    const ciphertextBytes = eciesEncrypt(pubkeyBytes, share);
    return {
      keeperId:   keepers[i].id,
      ciphertext: bytesToHex(ciphertextBytes),
    };
  });
}
