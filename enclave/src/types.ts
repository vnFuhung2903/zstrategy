export type Hex = `0x${string}`;

export type IntentCircuitKind = "ORDER_FILL" | "DCA";

export type EncryptionScheme = "SIMULATED_NITRO_X25519_AES_256_GCM";

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

export interface OrderFillWitness {
  kind: "ORDER_FILL";
  price: string;
  direction: 0 | 1;
  nonce: Hex;
  userSecret: Hex;
  nullifier: Hex;
}

export interface DcaWitness {
  kind: "DCA";
  scheduledLo: number;
  scheduledHi: number;
  nonce: Hex;
  userSecret: Hex;
  nullifier: Hex;
  dcaGroupId: Hex;
  roundIndex: number;
  prevNullifier?: Hex;
}

export type IntentWitness = OrderFillWitness | DcaWitness;

export interface EncryptedWitnessPackage {
  version: 1;
  packageHash: Hex;
  commitmentHash: Hex;
  kind: IntentCircuitKind;
  committeeId: string;
  enclaveKeyId: Hex;
  encryptionScheme: EncryptionScheme;
  ciphertext: Hex;
  aad: PublicIntentMetadata;
}

export interface AttestationRequest {
  nonce: Hex;
  userData?: Hex;
}

export interface AttestationReport {
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

export interface FillContext {
  chainId: number;
  registry: Hex;
  blockNumber?: bigint;
  blockTimestamp: number;
  oraclePrice?: string;
}

export interface ExecutionTicket {
  version: 1;
  chainId: number;
  registry: Hex;
  commitmentHash: Hex;
  kind: IntentCircuitKind;
  nullifier: Hex;
  fillRef: string;
  proof: Hex;
  ticketExpiresAt: number;
  executor?: Hex;
  packageHash: Hex;
  proverId: Hex;
  proverReceipt: ProverReceipt;
}

export interface ProverReceipt {
  proverId: Hex;
  ticketExpiresAt: number;
  signature: Hex;
}

export interface IntentProverEnclave {
  attest(req: AttestationRequest): Promise<AttestationReport>;
  importPackage(pkg: EncryptedWitnessPackage): Promise<{ packageHash: Hex }>;
  evaluate(commitmentHash: Hex, ctx: FillContext): Promise<"NOT_READY" | ExecutionTicket>;
  prune(commitmentHash: Hex): Promise<void>;
}

export interface OrderFillProofInput {
  price: bigint;
  direction: 0 | 1;
  nonce: Hex;
  userSecret: Hex;
  commitmentHash: Hex;
  oraclePrice: bigint;
  nullifier: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  size: bigint;
  minOut: bigint;
  expiry: bigint;
}

export interface DcaProofInput {
  scheduledLo: number;
  scheduledHi: number;
  nonce: Hex;
  userSecret: Hex;
  commitmentHash: Hex;
  executionTimestamp: number;
  nullifier: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  size: bigint;
  minOut: bigint;
  expiry: number;
}

export interface ProofGenerator {
  generateOrderFillProof(input: OrderFillProofInput): Promise<Hex>;
  generateDcaProof(input: DcaProofInput): Promise<Hex>;
}
