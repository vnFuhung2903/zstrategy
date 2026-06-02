import { PrivateKey } from "eciesjs";
import type {
  AttestationReport,
  AttestationRequest,
  DcaWitness,
  EncryptedWitnessPackage,
  ExecutionTicket,
  FillContext,
  Hex,
  IntentProverEnclave,
  OrderFillWitness,
  ProofGenerator,
} from "./types";
import { createDevRootKeypair, signAttestationReport, signStablePayload, type DevRootKeypair } from "./attestation";
import { decryptWitnessPackage } from "./internal/decryptWitnessPackage";
import { assertValidPackageHash } from "./witnessPackage";
import { sha256Hex, toHex } from "./encoding";

const DEFAULT_IMAGE_DIGEST = "0x6b8b8f3d5d5c4f3a7f9e22a9df7f6156ad43db2f61aa78f40b85d5ea7f3c0b61" as const;

export interface SimulatedNitroEnclaveOptions {
  devRoot?: DevRootKeypair;
  enclavePrivateKeyHex?: Hex;
  imageDigest?: Hex;
  pcrs?: Record<string, string>;
  proofGenerator: ProofGenerator;
  ticketTtlSeconds?: number;
  proverId?: string;
}

export class SimulatedNitroIntentProverEnclave implements IntentProverEnclave {
  readonly rootPublicKeyPem: string;
  readonly imageDigest: Hex;
  readonly pcrs: Record<string, string>;

  private readonly rootPrivateKeyPem: string;
  private readonly enclavePrivateKey: PrivateKey;
  private readonly proofGenerator: ProofGenerator;
  private readonly ticketTtlSeconds: number;
  private readonly proverId: string;
  private readonly packages = new Map<Hex, EncryptedWitnessPackage>();
  private readonly dcaWindows = new Map<Hex, Array<{ commitmentHash: Hex; lo: number; hi: number }>>();
  private readonly activeDcaGroups = new Set<Hex>();

  constructor(options: SimulatedNitroEnclaveOptions) {
    const devRoot = options.devRoot ?? createDevRootKeypair();
    this.rootPrivateKeyPem = devRoot.privateKeyPem;
    this.rootPublicKeyPem = devRoot.publicKeyPem;
    this.imageDigest = options.imageDigest ?? DEFAULT_IMAGE_DIGEST;
    this.pcrs = options.pcrs ?? {
      PCR0: sha256Hex("zstrategy-enclave:image"),
      PCR1: sha256Hex("zstrategy-enclave:kernel"),
      PCR2: sha256Hex("zstrategy-enclave:app"),
    };
    this.enclavePrivateKey = options.enclavePrivateKeyHex
      ? PrivateKey.fromHex(options.enclavePrivateKeyHex.slice(2), "x25519")
      : new PrivateKey(undefined, "x25519");
    this.proofGenerator = options.proofGenerator;
    this.ticketTtlSeconds = options.ticketTtlSeconds ?? 60;
    this.proverId = options.proverId ?? "simulated-nitro-local";
  }

  async attest(req: AttestationRequest): Promise<AttestationReport> {
    const unsigned = {
      version: 1 as const,
      mode: "SIMULATED_NITRO" as const,
      enclaveKey: this.enclavePublicKey(),
      enclaveKeyId: this.enclaveKeyId(),
      imageDigest: this.imageDigest,
      pcrs: this.pcrs,
      nonce: req.nonce,
      userData: req.userData,
      issuedAt: Math.floor(Date.now() / 1000),
    };
    return signAttestationReport(unsigned, this.rootPrivateKeyPem);
  }

  async importPackage(pkg: EncryptedWitnessPackage): Promise<{ packageHash: Hex }> {
    assertValidPackageHash(pkg);
    this.assertPackageForThisEnclave(pkg);
    const witness = decryptWitnessPackage(pkg, this.enclavePrivateKey);
    if (witness.kind === "DCA") {
      this.registerDcaWindow(pkg.commitmentHash, witness);
    }
    this.packages.set(pkg.commitmentHash, pkg);
    return { packageHash: pkg.packageHash };
  }

  async evaluate(commitmentHash: Hex, ctx: FillContext): Promise<"NOT_READY" | ExecutionTicket> {
    const pkg = this.packages.get(commitmentHash);
    if (!pkg) {
      throw new Error(`unknown witness package: ${commitmentHash}`);
    }

    this.assertContextMatchesPackage(pkg, ctx);
    const witness = decryptWitnessPackage(pkg, this.enclavePrivateKey);

    if (witness.kind === "ORDER_FILL") {
      return this.evaluateOrder(pkg, witness, ctx);
    }
    return this.evaluateDca(pkg, witness, ctx);
  }

  async prune(commitmentHash: Hex): Promise<void> {
    this.removeDcaWindow(commitmentHash);
    this.packages.delete(commitmentHash);
  }

  private async evaluateOrder(
    pkg: EncryptedWitnessPackage,
    witness: OrderFillWitness,
    ctx: FillContext,
  ): Promise<"NOT_READY" | ExecutionTicket> {
    if (ctx.oraclePrice === undefined) {
      throw new Error("ORDER_FILL evaluation requires oraclePrice");
    }

    const oraclePrice = BigInt(ctx.oraclePrice);
    const price = BigInt(witness.price);
    const ready = witness.direction === 0
      ? oraclePrice <= price
      : oraclePrice >= price;
    if (!ready) return "NOT_READY";

    const proof = await this.proofGenerator.generateOrderFillProof({
      price,
      direction: witness.direction,
      nonce: witness.nonce,
      userSecret: witness.userSecret,
      commitmentHash: pkg.commitmentHash,
      oraclePrice,
      nullifier: witness.nullifier,
      tokenIn: pkg.aad.tokenIn,
      tokenOut: pkg.aad.tokenOut,
      size: BigInt(pkg.aad.size),
      minOut: BigInt(pkg.aad.minOut),
      expiry: BigInt(pkg.aad.expiry),
    });

    return this.ticket(pkg, witness.nullifier, "0", proof);
  }

  private async evaluateDca(
    pkg: EncryptedWitnessPackage,
    witness: DcaWitness,
    ctx: FillContext,
  ): Promise<"NOT_READY" | ExecutionTicket> {
    const executionTimestamp = ctx.blockTimestamp;
    if (executionTimestamp < witness.scheduledLo || executionTimestamp > witness.scheduledHi) {
      return "NOT_READY";
    }

    if (this.activeDcaGroups.has(witness.dcaGroupId)) {
      return "NOT_READY";
    }
    this.activeDcaGroups.add(witness.dcaGroupId);

    let proof: Hex;
    try {
      proof = await this.proofGenerator.generateDcaProof({
        scheduledLo: witness.scheduledLo,
        scheduledHi: witness.scheduledHi,
        nonce: witness.nonce,
        userSecret: witness.userSecret,
        commitmentHash: pkg.commitmentHash,
        executionTimestamp,
        nullifier: witness.nullifier,
        tokenIn: pkg.aad.tokenIn,
        tokenOut: pkg.aad.tokenOut,
        size: BigInt(pkg.aad.size),
        minOut: BigInt(pkg.aad.minOut),
        expiry: pkg.aad.expiry,
      });
    } finally {
      this.activeDcaGroups.delete(witness.dcaGroupId);
    }

    return this.ticket(pkg, witness.nullifier, executionTimestamp.toString(), proof);
  }

  private ticket(
    pkg: EncryptedWitnessPackage,
    nullifier: Hex,
    fillRef: string,
    proof: Hex,
  ): ExecutionTicket {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = {
      version: 1 as const,
      chainId: pkg.aad.chainId,
      registry: pkg.aad.registry,
      commitmentHash: pkg.commitmentHash,
      kind: pkg.kind,
      nullifier,
      fillRef,
      proof,
      ticketExpiresAt: now + this.ticketTtlSeconds,
      packageHash: pkg.packageHash,
      proverIds: [this.proverId],
    };
    return {
      ...unsigned,
      proverSignature: signStablePayload(unsigned, this.rootPrivateKeyPem),
    };
  }

  private enclavePublicKey(): Hex {
    return toHex(this.enclavePrivateKey.publicKey.toBytes());
  }

  private enclaveKeyId(): Hex {
    return sha256Hex(this.enclavePrivateKey.publicKey.toBytes());
  }

  private assertPackageForThisEnclave(pkg: EncryptedWitnessPackage): void {
    if (pkg.enclaveKeyId !== this.enclaveKeyId()) {
      throw new Error("witness package was not encrypted for this enclave key");
    }
  }

  private assertContextMatchesPackage(pkg: EncryptedWitnessPackage, ctx: FillContext): void {
    if (ctx.chainId !== pkg.aad.chainId) {
      throw new Error("fill context chainId mismatch");
    }
    if (ctx.registry.toLowerCase() !== pkg.aad.registry.toLowerCase()) {
      throw new Error("fill context registry mismatch");
    }
  }

  private registerDcaWindow(commitmentHash: Hex, witness: DcaWitness): void {
    const windows = this.dcaWindows.get(witness.dcaGroupId) ?? [];
    for (const existing of windows) {
      if (existing.commitmentHash === commitmentHash) continue;
      const overlaps = witness.scheduledLo <= existing.hi && existing.lo <= witness.scheduledHi;
      if (overlaps) {
        throw new Error("DCA group contains overlapping execution windows");
      }
    }
    const next = windows.filter(window => window.commitmentHash !== commitmentHash);
    next.push({ commitmentHash, lo: witness.scheduledLo, hi: witness.scheduledHi });
    this.dcaWindows.set(witness.dcaGroupId, next);
  }

  private removeDcaWindow(commitmentHash: Hex): void {
    for (const [groupId, windows] of this.dcaWindows) {
      const next = windows.filter(window => window.commitmentHash !== commitmentHash);
      if (next.length === 0) {
        this.dcaWindows.delete(groupId);
      } else if (next.length !== windows.length) {
        this.dcaWindows.set(groupId, next);
      }
    }
  }
}
