import { encrypt } from "eciesjs";
import { verifyAttestationReport } from "./attestation";
import type {
  AttestationReport,
  EncryptedWitnessPackage,
  EncryptionScheme,
  IntentWitness,
  PublicIntentMetadata,
} from "./types";
import { fromHex, sha256Hex, stableStringify, toHex } from "./encoding";

export const WITNESS_ENCRYPTION_SCHEME: EncryptionScheme = "SIMULATED_NITRO_X25519_AES_256_GCM";

type EciesConfig = NonNullable<Parameters<typeof encrypt>[2]>;

export const WITNESS_ECIES_CONFIG: EciesConfig = {
  ellipticCurve: "x25519",
  isEphemeralKeyCompressed: false,
  isHkdfKeyCompressed: false,
  symmetricAlgorithm: "aes-256-gcm",
  symmetricNonceLength: 12,
  get ephemeralKeySize() {
    return 32;
  },
};

interface WitnessEnvelope {
  version: 1;
  aad: PublicIntentMetadata;
  witness: IntentWitness;
}

export interface WitnessAttestationExpectations {
  rootPublicKeyPem: string;
  nonce: `0x${string}`;
  imageDigest: `0x${string}`;
  pcrs: Record<string, string>;
}

type PackageWithoutHash = Omit<EncryptedWitnessPackage, "packageHash">;

export function createEncryptedWitnessPackage(
  metadata: PublicIntentMetadata,
  witness: IntentWitness,
  attestation: AttestationReport,
  expectedAttestation: WitnessAttestationExpectations,
  committeeId = "local-dev",
): EncryptedWitnessPackage {
  if (metadata.kind !== witness.kind) {
    throw new Error("metadata and witness kind mismatch");
  }
  if (!expectedAttestation.nonce || !expectedAttestation.imageDigest || !expectedAttestation.pcrs) {
    throw new Error("attestation nonce, imageDigest, and PCR allowlist are required");
  }
  if (!verifyAttestationReport(attestation, expectedAttestation)) {
    throw new Error("invalid enclave attestation report");
  }

  const envelope: WitnessEnvelope = {
    version: 1,
    aad: metadata,
    witness,
  };
  const plaintext = Buffer.from(stableStringify(envelope), "utf-8");
  const ciphertext = encrypt(fromHex(attestation.enclaveKey), plaintext, WITNESS_ECIES_CONFIG);

  const withoutHash: PackageWithoutHash = {
    version: 1,
    commitmentHash: metadata.commitmentHash,
    kind: metadata.kind,
    committeeId,
    enclaveKeyId: attestation.enclaveKeyId,
    encryptionScheme: WITNESS_ENCRYPTION_SCHEME,
    ciphertext: toHex(ciphertext),
    aad: metadata,
  };

  return {
    ...withoutHash,
    packageHash: packageHash(withoutHash),
  };
}

export function assertValidPackageHash(pkg: EncryptedWitnessPackage): void {
  const { packageHash: declared, ...withoutHash } = pkg;
  const actual = packageHash(withoutHash);
  if (actual !== declared) {
    throw new Error("witness package hash mismatch");
  }
}

export function packageHash(pkg: PackageWithoutHash): `0x${string}` {
  return sha256Hex(stableStringify(pkg));
}
