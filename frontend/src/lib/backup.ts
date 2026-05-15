/**
 * Encrypted strategy backup (`.zstrategy` file format).
 *
 * Strategy parameters live in IndexedDB only — clear the browser and they're
 * gone. This lets the user export an AES-GCM encrypted bundle protected by a
 * password they choose, and restore it on another device.
 *
 * Crypto: PBKDF2-SHA256 (250 000 iterations) → 256-bit AES-GCM key.
 *         Salt and IV are random per export and stored alongside the ciphertext.
 *
 * No external deps — uses the browser's built-in Web Crypto API.
 */

import {
  listStrategiesForOwner,
  saveStrategy,
  type StrategyRecord,
} from "./strategyStore";

const FORMAT_TAG = "zstrategy-backup";
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface BackupFile {
  format:     typeof FORMAT_TAG;
  version:    number;
  kdf:        "PBKDF2-SHA256";
  iterations: number;
  salt:       string;       // base64
  iv:         string;       // base64
  ciphertext: string;       // base64
  /** Owner address recorded on export — surfaced for safety on import. */
  owner:      `0x${string}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const buffer = u8.buffer;
  if (buffer instanceof SharedArrayBuffer) {
    throw new Error("SharedArrayBuffer cannot be converted to a standard ArrayBuffer without copying.");
  }
  return buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Read all strategies for `owner` from IndexedDB, encrypt with `password`,
 * and trigger a browser download of the resulting `.zstrategy` file.
 */
export async function exportStrategies(
  owner: `0x${string}`,
  password: string,
): Promise<{ count: number; filename: string }> {
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  const strategies = await listStrategiesForOwner(owner);
  if (strategies.length === 0) throw new Error("No strategies to export");

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv   = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key  = await deriveKey(password, salt);

  const plaintext = new TextEncoder().encode(JSON.stringify(strategies));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  const file: BackupFile = {
    format:     FORMAT_TAG,
    version:    FORMAT_VERSION,
    kdf:        "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt:       bytesToBase64(salt),
    iv:         bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    owner:      owner.toLowerCase() as `0x${string}`,
  };

  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const ts   = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `zstrategy-${owner.slice(2, 8)}-${ts}.zstrategy`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return { count: strategies.length, filename };
}

/**
 * Decrypt a `.zstrategy` file with `password` and merge its strategies into
 * IndexedDB. Returns counts. Existing rows with the same `commitmentHash` are
 * overwritten — IndexedDB `put` semantics.
 */
export async function importStrategies(
  fileText: string,
  password: string,
): Promise<{ count: number; owner: `0x${string}` }> {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(fileText) as BackupFile;
  } catch {
    throw new Error("File is not valid JSON");
  }
  if (parsed.format !== FORMAT_TAG) {
    throw new Error("File is not a zstrategy backup");
  }
  if (parsed.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported backup version ${parsed.version}`);
  }

  const salt = base64ToBytes(parsed.salt);
  const iv   = base64ToBytes(parsed.iv);
  const ct   = base64ToBytes(parsed.ciphertext);
  const key  = await deriveKey(password, salt);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
  } catch {
    throw new Error("Wrong password or corrupted file");
  }

  const json = new TextDecoder().decode(plaintext);
  const records = JSON.parse(json) as StrategyRecord[];
  if (!Array.isArray(records)) throw new Error("Backup payload is malformed");

  for (const r of records) {
    await saveStrategy(r);
  }
  return { count: records.length, owner: parsed.owner };
}
