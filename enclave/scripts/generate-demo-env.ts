
import * as fs from "fs";
import * as path from "path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { PrivateKey } from "eciesjs";
import { Wallet } from "ethers";

const target = path.resolve(__dirname, "../.env");

const imageDigest = randomBytes(32).toString("hex");
const proverId = randomBytes(32).toString("hex");
const enclaveKey = new PrivateKey(undefined, "x25519");
const { privateKey: devRootPrivateKey, publicKey: devRootPublicKey } = generateKeyPairSync("ed25519");
const proverSigningPrivateKey = Wallet.createRandom().privateKey;

const devRootPrivatePem = devRootPrivateKey.export({ format: "pem", type: "pkcs8" }).toString();
const devRootPublicPem = devRootPublicKey.export({ format: "pem", type: "spki" }).toString();

const envText = [
  "ENCLAVE_PORT=3002",
  "ENCLAVE_API_SECRET=",
  "ORDER_FILL_CIRCUIT_JSON=../circuits/order_fill/target/order_fill.json",
  "DCA_CIRCUIT_JSON=../circuits/dca/target/dca.json",
  "TICKET_TTL_SECONDS=60",
  `PROVER_ID=0x${proverId}`,
  `PROVER_SIGNING_PRIVATE_KEY=${proverSigningPrivateKey}`,
  `ENCLAVE_IMAGE_DIGEST=0x${imageDigest}`,
  "# Random X25519 private key used by eciesjs to decrypt local witness packages.",
  `ENCLAVE_PRIVATE_KEY_HEX=0x${Buffer.from(enclaveKey.secret).toString("hex")}`,
  "# Matching Ed25519 simulated attestation root key pair, PEM with escaped newlines.",
  `ENCLAVE_DEV_ROOT_PRIVATE_KEY_PEM=${escapePem(devRootPrivatePem)}`,
  `ENCLAVE_DEV_ROOT_PUBLIC_KEY_PEM=${escapePem(devRootPublicPem)}`,
  "",
].join("\n");

fs.writeFileSync(target, envText, { encoding: "utf-8", mode: 0o600 });
console.log("Wrote enclave/.env with fresh demo-only secrets.");

function escapePem(pem: string): string {
  return pem.replace(/\r?\n/g, "\\n");
}
