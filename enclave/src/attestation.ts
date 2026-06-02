import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { AttestationReport, Hex } from "./types";
import { constantTimeEqualHex, fromHex, stableStringify, toHex } from "./encoding";

export interface DevRootKeypair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface AttestationExpectations {
  rootPublicKeyPem: string;
  nonce?: Hex;
  imageDigest?: Hex;
  pcrs?: Record<string, string>;
}

type UnsignedReport = Omit<AttestationReport, "signature">;

export function createDevRootKeypair(): DevRootKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export function signAttestationReport(
  report: UnsignedReport,
  rootPrivateKeyPem: string | KeyObject,
): AttestationReport {
  return {
    ...report,
    signature: signStablePayload(report, rootPrivateKeyPem),
  };
}

export function signStablePayload(payloadValue: unknown, rootPrivateKeyPem: string | KeyObject): Hex {
  const key = typeof rootPrivateKeyPem === "string"
    ? createPrivateKey(rootPrivateKeyPem)
    : rootPrivateKeyPem;
  const payload = Buffer.from(stableStringify(payloadValue), "utf-8");
  return toHex(sign(null, payload, key));
}

export function verifyAttestationReport(
  report: AttestationReport,
  expected: AttestationExpectations,
): boolean {
  const { signature, ...unsigned } = report;
  const key = createPublicKey(expected.rootPublicKeyPem);
  const payload = Buffer.from(stableStringify(unsigned), "utf-8");
  const signatureOk = verify(null, payload, key, fromHex(signature));
  if (!signatureOk) return false;

  if (report.mode !== "SIMULATED_NITRO") return false;
  if (expected.nonce && !constantTimeEqualHex(report.nonce, expected.nonce)) return false;
  if (expected.imageDigest && !constantTimeEqualHex(report.imageDigest, expected.imageDigest)) return false;

  if (expected.pcrs) {
    for (const [name, value] of Object.entries(expected.pcrs)) {
      if (report.pcrs[name] !== value) return false;
    }
  }

  return true;
}
