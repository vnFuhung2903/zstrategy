import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulatedNitroIntentProverEnclave,
  WITNESS_ENCRYPTION_SCHEME,
  createDevRootKeypair,
  createEncryptedWitnessPackage,
  verifyAttestationReport,
  type DcaProofInput,
  type Hex,
  type OrderFillProofInput,
  type ProofGenerator,
  type PublicIntentMetadata,
} from "../src";

class StubProofGenerator implements ProofGenerator {
  orderFillInputs: OrderFillProofInput[] = [];
  dcaInputs: DcaProofInput[] = [];
  dcaDelay?: Promise<void>;

  async generateOrderFillProof(input: OrderFillProofInput): Promise<Hex> {
    this.orderFillInputs.push(input);
    return `0x${"aa".repeat(64)}`;
  }

  async generateDcaProof(input: DcaProofInput): Promise<Hex> {
    if (this.dcaDelay) await this.dcaDelay;
    this.dcaInputs.push(input);
    return `0x${"bb".repeat(64)}`;
  }
}

test("simulated Nitro attestation binds nonce, PCRs, image digest, and enclave key", async () => {
  const root = createDevRootKeypair();
  const enclave = new SimulatedNitroIntentProverEnclave({
    devRoot: root,
    proofGenerator: new StubProofGenerator(),
  });
  const nonce = bytes32("11");

  const report = await enclave.attest({ nonce });

  assert.equal(report.mode, "SIMULATED_NITRO");
  assert.equal(report.enclaveKey.length, 66, "x25519 public key should be 32 bytes");
  assert.equal(
    verifyAttestationReport(report, {
      rootPublicKeyPem: root.publicKeyPem,
      nonce,
      imageDigest: enclave.imageDigest,
      pcrs: enclave.pcrs,
    }),
    true,
  );
  assert.equal(
    verifyAttestationReport(report, {
      rootPublicKeyPem: root.publicKeyPem,
      nonce: bytes32("22"),
      imageDigest: enclave.imageDigest,
      pcrs: enclave.pcrs,
    }),
    false,
  );
});

test("ORDER_FILL witness decrypts only inside enclave and returns a ticket when ready", async () => {
  const root = createDevRootKeypair();
  const proofGenerator = new StubProofGenerator();
  const enclave = new SimulatedNitroIntentProverEnclave({ devRoot: root, proofGenerator });
  const nonce = bytes32("33");
  const report = await enclave.attest({ nonce });
  const metadata = orderMetadata();
  const witness = {
    kind: "ORDER_FILL" as const,
    price: "100",
    direction: 0 as const,
    nonce: bytes32("44"),
    userSecret: bytes32("55"),
    nullifier: bytes32("66"),
  };

  const pkg = createEncryptedWitnessPackage(metadata, witness, report, {
    rootPublicKeyPem: root.publicKeyPem,
    nonce,
    imageDigest: enclave.imageDigest,
    pcrs: enclave.pcrs,
  });

  assert.equal(pkg.encryptionScheme, WITNESS_ENCRYPTION_SCHEME);
  assert.doesNotMatch(JSON.stringify(pkg), /5555555555555555/);

  await enclave.importPackage(pkg);
  assert.equal(
    await enclave.evaluate(metadata.commitmentHash, {
      chainId: metadata.chainId,
      registry: metadata.registry,
      blockTimestamp: 1700000000,
      oraclePrice: "101",
    }),
    "NOT_READY",
  );
  assert.equal(proofGenerator.orderFillInputs.length, 0);

  const ticket = await enclave.evaluate(metadata.commitmentHash, {
    chainId: metadata.chainId,
    registry: metadata.registry,
    blockTimestamp: 1700000001,
    oraclePrice: "99",
  });

  assert.notEqual(ticket, "NOT_READY");
  if (ticket !== "NOT_READY") {
    assert.equal(ticket.commitmentHash, metadata.commitmentHash);
    assert.equal(ticket.nullifier, witness.nullifier);
    assert.equal(ticket.fillRef, "0");
    assert.equal(ticket.proof, `0x${"aa".repeat(64)}`);
  }
  assert.equal(proofGenerator.orderFillInputs.length, 1);
  assert.equal(proofGenerator.orderFillInputs[0].oraclePrice, 99n);
});

test("DCA witness only produces a ticket inside its private window", async () => {
  const root = createDevRootKeypair();
  const proofGenerator = new StubProofGenerator();
  const enclave = new SimulatedNitroIntentProverEnclave({ devRoot: root, proofGenerator });
  const nonce = bytes32("77");
  const report = await enclave.attest({ nonce });
  const metadata = dcaMetadata();
  const witness = {
    kind: "DCA" as const,
    scheduledLo: 1700000100,
    scheduledHi: 1700000200,
    nonce: bytes32("88"),
    userSecret: bytes32("99"),
    nullifier: bytes32("aa"),
    dcaGroupId: bytes32("bb"),
    roundIndex: 0,
  };
  const pkg = createEncryptedWitnessPackage(metadata, witness, report, {
    rootPublicKeyPem: root.publicKeyPem,
    nonce,
    imageDigest: enclave.imageDigest,
    pcrs: enclave.pcrs,
  });

  await enclave.importPackage(pkg);
  assert.equal(
    await enclave.evaluate(metadata.commitmentHash, {
      chainId: metadata.chainId,
      registry: metadata.registry,
      blockTimestamp: 1700000201,
    }),
    "NOT_READY",
  );

  const ticket = await enclave.evaluate(metadata.commitmentHash, {
    chainId: metadata.chainId,
    registry: metadata.registry,
    blockTimestamp: 1700000150,
  });

  assert.notEqual(ticket, "NOT_READY");
  if (ticket !== "NOT_READY") {
    assert.equal(ticket.fillRef, "1700000150");
    assert.equal(ticket.proof, `0x${"bb".repeat(64)}`);
  }
  assert.equal(proofGenerator.dcaInputs.length, 1);
});

test("DCA import rejects overlapping same-group windows inside enclave boundary", async () => {
  const root = createDevRootKeypair();
  const proofGenerator = new StubProofGenerator();
  const enclave = new SimulatedNitroIntentProverEnclave({ devRoot: root, proofGenerator });
  const report = await enclave.attest({ nonce: bytes32("31") });
  const groupId = bytes32("32");

  await enclave.importPackage(createDcaPackage({
    root,
    enclave,
    report,
    metadata: { ...dcaMetadata(), commitmentHash: bytes32("33") },
    groupId,
    scheduledLo: 1700000100,
    scheduledHi: 1700000200,
    nonceValue: bytes32("34"),
    nullifier: bytes32("35"),
  }));

  await assert.rejects(
    () => enclave.importPackage(createDcaPackage({
      root,
      enclave,
      report,
      metadata: { ...dcaMetadata(), commitmentHash: bytes32("36") },
      groupId,
      scheduledLo: 1700000150,
      scheduledHi: 1700000250,
      nonceValue: bytes32("37"),
      nullifier: bytes32("38"),
    })),
    /overlapping execution windows/,
  );
});

test("DCA evaluation holds a private per-group proof lock", async () => {
  const root = createDevRootKeypair();
  const proofGenerator = new StubProofGenerator();
  let release!: () => void;
  proofGenerator.dcaDelay = new Promise<void>(resolve => { release = resolve; });
  const enclave = new SimulatedNitroIntentProverEnclave({ devRoot: root, proofGenerator });
  const report = await enclave.attest({ nonce: bytes32("41") });
  const groupId = bytes32("42");
  const first = createDcaPackage({
    root,
    enclave,
    report,
    metadata: { ...dcaMetadata(), commitmentHash: bytes32("43") },
    groupId,
    scheduledLo: 1700000100,
    scheduledHi: 1700000200,
    nonceValue: bytes32("44"),
    nullifier: bytes32("45"),
  });
  const second = createDcaPackage({
    root,
    enclave,
    report,
    metadata: { ...dcaMetadata(), commitmentHash: bytes32("46") },
    groupId,
    scheduledLo: 1700000300,
    scheduledHi: 1700000400,
    nonceValue: bytes32("47"),
    nullifier: bytes32("48"),
  });

  await enclave.importPackage(first);
  await enclave.importPackage(second);

  const firstEval = enclave.evaluate(first.commitmentHash, {
    chainId: first.aad.chainId,
    registry: first.aad.registry,
    blockTimestamp: 1700000150,
  });

  assert.equal(
    await enclave.evaluate(second.commitmentHash, {
      chainId: second.aad.chainId,
      registry: second.aad.registry,
      blockTimestamp: 1700000350,
    }),
    "NOT_READY",
  );

  release();
  assert.notEqual(await firstEval, "NOT_READY");
});

test("witness package rejects tampered public metadata before decryption", async () => {
  const root = createDevRootKeypair();
  const enclave = new SimulatedNitroIntentProverEnclave({
    devRoot: root,
    proofGenerator: new StubProofGenerator(),
  });
  const nonce = bytes32("cc");
  const report = await enclave.attest({ nonce });
  const metadata = orderMetadata();
  const pkg = createEncryptedWitnessPackage(
    metadata,
    {
      kind: "ORDER_FILL",
      price: "100",
      direction: 0,
      nonce: bytes32("dd"),
      userSecret: bytes32("ee"),
      nullifier: bytes32("ff"),
    },
    report,
    {
      rootPublicKeyPem: root.publicKeyPem,
      nonce,
      imageDigest: enclave.imageDigest,
      pcrs: enclave.pcrs,
    },
  );

  const tampered = {
    ...pkg,
    aad: {
      ...pkg.aad,
      minOut: "2",
    },
  };

  await assert.rejects(() => enclave.importPackage(tampered), /package hash mismatch/);
});

test("public enclave API does not export witness decryption", async () => {
  const api = await import("../src");
  assert.equal("decryptWitnessPackage" in api, false);
});

test("witness encryption requires nonce, image digest, and PCR allowlist checks", async () => {
  const root = createDevRootKeypair();
  const enclave = new SimulatedNitroIntentProverEnclave({
    devRoot: root,
    proofGenerator: new StubProofGenerator(),
  });
  const nonce = bytes32("10");
  const report = await enclave.attest({ nonce });

  assert.throws(
    () => createEncryptedWitnessPackage(
      orderMetadata(),
      {
        kind: "ORDER_FILL",
        price: "100",
        direction: 0,
        nonce: bytes32("20"),
        userSecret: bytes32("30"),
        nullifier: bytes32("40"),
      },
      report,
      {
        rootPublicKeyPem: root.publicKeyPem,
        nonce,
      } as never,
    ),
    /nonce, imageDigest, and PCR allowlist/,
  );
});

function orderMetadata(): PublicIntentMetadata {
  return {
    version: 1,
    chainId: 421614,
    registry: address("12"),
    commitmentHash: bytes32("01"),
    kind: "ORDER_FILL",
    tokenIn: address("23"),
    tokenOut: address("34"),
    size: "1000000000000000000",
    minOut: "990000000",
    expiry: 1700000300,
  };
}

function dcaMetadata(): PublicIntentMetadata {
  return {
    ...orderMetadata(),
    commitmentHash: bytes32("02"),
    kind: "DCA",
  };
}

function createDcaPackage(args: {
  root: ReturnType<typeof createDevRootKeypair>;
  enclave: SimulatedNitroIntentProverEnclave;
  report: Awaited<ReturnType<SimulatedNitroIntentProverEnclave["attest"]>>;
  metadata: PublicIntentMetadata;
  groupId: Hex;
  scheduledLo: number;
  scheduledHi: number;
  nonceValue: Hex;
  nullifier: Hex;
}) {
  return createEncryptedWitnessPackage(
    args.metadata,
    {
      kind: "DCA",
      scheduledLo: args.scheduledLo,
      scheduledHi: args.scheduledHi,
      nonce: args.nonceValue,
      userSecret: bytes32("49"),
      nullifier: args.nullifier,
      dcaGroupId: args.groupId,
      roundIndex: 0,
    },
    args.report,
    {
      rootPublicKeyPem: args.root.publicKeyPem,
      nonce: args.report.nonce,
      imageDigest: args.enclave.imageDigest,
      pcrs: args.enclave.pcrs,
    },
  );
}

function bytes32(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}

function address(byte: string): Hex {
  return `0x${byte.repeat(20)}`;
}
