import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend, Barretenberg } from "@aztec/bb.js";
import type { DcaProofInput, Hex, OrderFillProofInput, ProofGenerator } from "./types";

interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
}

type CircuitHandle = { noir: Noir; backend: UltraHonkBackend; api: Barretenberg };

export interface NoirProofGeneratorOptions {
  orderFillCircuitJsonPath: string;
  dcaCircuitJsonPath: string;
}

export class NoirProofGenerator implements ProofGenerator {
  private orderFillCircuit?: Promise<CircuitHandle>;
  private dcaCircuit?: Promise<CircuitHandle>;

  constructor(private readonly options: NoirProofGeneratorOptions) {}

  async generateOrderFillProof(input: OrderFillProofInput): Promise<Hex> {
    const { noir, backend } = await this.loadOrderFill();
    const witnessInputs = {
      price: input.price.toString(),
      direction: input.direction === 1,
      nonce: input.nonce,
      user_secret: input.userSecret,
      commitment_hash: input.commitmentHash,
      oracle_price: input.oraclePrice.toString(),
      nullifier: input.nullifier,
      token_in: input.tokenIn,
      token_out: input.tokenOut,
      size: input.size.toString(),
      min_out: input.minOut.toString(),
      expiry: input.expiry.toString(),
    };

    const { witness } = await noir.execute(witnessInputs);
    const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });
    await assertProofVerifies(backend, proofData);
    return bytesToHex(proofData.proof);
  }

  async generateDcaProof(input: DcaProofInput): Promise<Hex> {
    const { noir, backend } = await this.loadDca();
    const witnessInputs = {
      scheduled_lo: input.scheduledLo.toString(),
      scheduled_hi: input.scheduledHi.toString(),
      nonce: input.nonce,
      user_secret: input.userSecret,
      commitment_hash: input.commitmentHash,
      execution_timestamp: input.executionTimestamp.toString(),
      nullifier: input.nullifier,
      token_in: input.tokenIn,
      token_out: input.tokenOut,
      size: input.size.toString(),
      min_out: input.minOut.toString(),
      expiry: input.expiry.toString(),
    };

    const { witness } = await noir.execute(witnessInputs);
    const proofData = await backend.generateProof(witness, { verifierTarget: "evm" });
    await assertProofVerifies(backend, proofData);
    return bytesToHex(proofData.proof);
  }

  async destroy(): Promise<void> {
    const handles = await Promise.allSettled([
      this.orderFillCircuit,
      this.dcaCircuit,
    ].filter((h): h is Promise<CircuitHandle> => h !== undefined));

    this.orderFillCircuit = undefined;
    this.dcaCircuit = undefined;

    for (const result of handles) {
      if (result.status === "fulfilled") {
        await result.value.api.destroy();
      }
    }
  }

  private loadOrderFill(): Promise<CircuitHandle> {
    this.orderFillCircuit ??= loadCircuit(this.options.orderFillCircuitJsonPath);
    return this.orderFillCircuit;
  }

  private loadDca(): Promise<CircuitHandle> {
    this.dcaCircuit ??= loadCircuit(this.options.dcaCircuitJsonPath);
    return this.dcaCircuit;
  }
}

async function loadCircuit(circuitPath: string): Promise<CircuitHandle> {
  const abs = isAbsolute(circuitPath) ? circuitPath : resolve(process.cwd(), circuitPath);
  const circuit = JSON.parse(readFileSync(abs, "utf-8")) as CompiledCircuit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(circuit as any);
  const api = await Barretenberg.new();
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  return { noir, backend, api };
}

async function assertProofVerifies(backend: UltraHonkBackend, proofData: unknown): Promise<void> {
  let ok: boolean;
  try {
    ok = await backend.verifyProof(proofData as never, { verifierTarget: "evm" });
  } catch (err) {
    throw new Error(`off-chain verifyProof threw: ${err}`);
  }
  if (!ok) {
    throw new Error("off-chain verifyProof returned FAIL");
  }
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
