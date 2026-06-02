import { PrivateKey, decrypt } from "eciesjs";
import type { EncryptedWitnessPackage, IntentWitness, PublicIntentMetadata } from "../types";
import { fromHex, stableStringify } from "../encoding";
import {
  WITNESS_ECIES_CONFIG,
  WITNESS_ENCRYPTION_SCHEME,
  assertValidPackageHash,
} from "../witnessPackage";

interface WitnessEnvelope {
  version: 1;
  aad: PublicIntentMetadata;
  witness: IntentWitness;
}

export function decryptWitnessPackage(
  pkg: EncryptedWitnessPackage,
  enclavePrivateKey: PrivateKey,
): IntentWitness {
  assertValidPackageHash(pkg);
  if (pkg.encryptionScheme !== WITNESS_ENCRYPTION_SCHEME) {
    throw new Error(`unsupported witness encryption scheme: ${pkg.encryptionScheme}`);
  }

  const plaintext = decrypt(enclavePrivateKey.secret, fromHex(pkg.ciphertext), WITNESS_ECIES_CONFIG);
  const envelope = JSON.parse(Buffer.from(plaintext).toString("utf-8")) as WitnessEnvelope;

  if (envelope.version !== 1) {
    throw new Error("unsupported witness envelope version");
  }
  if (stableStringify(envelope.aad) !== stableStringify(pkg.aad)) {
    throw new Error("witness package AAD mismatch");
  }
  if (envelope.witness.kind !== pkg.kind || pkg.kind !== pkg.aad.kind) {
    throw new Error("witness kind mismatch");
  }

  return envelope.witness;
}
