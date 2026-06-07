import { encrypt } from "eciesjs";
import { bytesToHex, hexToBytes } from "viem";
import { randomBytes32 } from "./commitment";

const BACKEND_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080";

export type Hex = `0x${string}`;
export type IntentCircuitKind = "ORDER_FILL" | "DCA";

export interface PublicIntentMetadata {
  version: 1;
  chainId: number;
  registry: Hex;
  commitmentHash: Hex;
  kind: IntentCircuitKind;
  dcaGroupLockId?: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  size: string;
  minOut: string;
  expiry: number;
}

export type OrderFillWitness = {
  kind: "ORDER_FILL";
  price: string;
  direction: 0 | 1;
  nonce: Hex;
  userSecret: Hex;
  nullifier: Hex;
};

export type DcaWitness = {
  kind: "DCA";
  scheduledLo: number;
  scheduledHi: number;
  nonce: Hex;
  userSecret: Hex;
  nullifier: Hex;
  dcaGroupId: Hex;
  roundIndex: number;
  prevNullifier?: Hex;
};

export type IntentWitness = OrderFillWitness | DcaWitness;

export interface EncryptedWitnessPackage {
  version: 1;
  packageHash: Hex;
  commitmentHash: Hex;
  kind: IntentCircuitKind;
  committeeId: string;
  enclaveKeyId: Hex;
  encryptionScheme: "SIMULATED_NITRO_X25519_AES_256_GCM";
  ciphertext: Hex;
  aad: PublicIntentMetadata;
}

interface AttestationReport {
  version: 1;
  mode: "SIMULATED_NITRO" | "AWS_NITRO";
  enclaveKey: Hex;
  enclaveKeyId: Hex;
  imageDigest: Hex;
  pcrs: Record<string, string>;
  nonce: Hex;
  userData?: Hex;
  issuedAt: number;
  signature: Hex;
}

interface AttestationExpected {
  rootPublicKeyPem: string;
  imageDigest: Hex;
  pcrs: Record<string, string>;
}

export interface VerifiedEnclaveAttestation {
  report: AttestationReport;
  expected: AttestationExpected;
}

const WITNESS_ECIES_CONFIG = {
  ellipticCurve: "x25519",
  isEphemeralKeyCompressed: false,
  isHkdfKeyCompressed: false,
  symmetricAlgorithm: "aes-256-gcm",
  symmetricNonceLength: 12,
  get ephemeralKeySize() {
    return 32;
  },
} as const;

export async function getVerifiedEnclaveAttestation(): Promise<VerifiedEnclaveAttestation> {
  const nonce = randomBytes32();
  const res = await fetch(`${BACKEND_BASE}/api/v1/enclave/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Enclave attestation failed: ${res.status} ${text}`);
  }
  const result = await res.json() as { report: AttestationReport; expected: AttestationExpected };
  await assertAttestationValid(result.report, result.expected, nonce);
  return result;
}

export async function createEncryptedWitnessPackage(
  metadata: PublicIntentMetadata,
  witness: IntentWitness,
  attestation?: VerifiedEnclaveAttestation,
  committeeId = "local-dev",
): Promise<EncryptedWitnessPackage> {
  if (metadata.kind !== witness.kind) {
    throw new Error("metadata and witness kind mismatch");
  }
  const verified = attestation ?? await getVerifiedEnclaveAttestation();
  const envelope = {
    version: 1 as const,
    aad: metadata,
    witness,
  };
  const plaintext = new TextEncoder().encode(stableStringify(envelope));
  const ciphertext = encrypt(hexToBytes(verified.report.enclaveKey), plaintext, WITNESS_ECIES_CONFIG);

  const withoutHash = {
    version: 1 as const,
    commitmentHash: metadata.commitmentHash,
    kind: metadata.kind,
    committeeId,
    enclaveKeyId: verified.report.enclaveKeyId,
    encryptionScheme: "SIMULATED_NITRO_X25519_AES_256_GCM" as const,
    ciphertext: bytesToHex(ciphertext),
    aad: metadata,
  };
  return {
    ...withoutHash,
    packageHash: await sha256Hex(stableStringify(withoutHash)),
  };
}

async function assertAttestationValid(report: AttestationReport, expected: AttestationExpected, nonce: Hex): Promise<void> {
  const pinnedRoot = process.env.NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n");
  if (pinnedRoot && pinnedRoot !== expected.rootPublicKeyPem) {
    throw new Error("enclave root public key does not match pinned frontend config");
  }
  if (report.mode !== "SIMULATED_NITRO") throw new Error("unsupported enclave attestation mode");
  if (report.nonce.toLowerCase() !== nonce.toLowerCase()) throw new Error("enclave attestation nonce mismatch");
  if (report.imageDigest.toLowerCase() !== expected.imageDigest.toLowerCase()) throw new Error("enclave image digest mismatch");
  for (const [name, value] of Object.entries(expected.pcrs)) {
    if (report.pcrs[name] !== value) throw new Error(`enclave PCR mismatch: ${name}`);
  }

  const { signature, ...unsigned } = report;
  const key = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(expected.rootPublicKeyPem),
    { name: "Ed25519" } as Algorithm,
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" } as Algorithm,
    key,
    toArrayBuffer(hexToBytes(signature)),
    toArrayBuffer(new TextEncoder().encode(stableStringify(unsigned))),
  );
  if (!ok) throw new Error("invalid enclave attestation signature");
}

async function sha256Hex(value: string): Promise<Hex> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortValue(child);
    }
    return out;
  }
  return value;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
