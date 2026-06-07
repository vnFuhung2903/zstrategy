import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { NoirProofGenerator } from "./noirProofGenerator";
import { SimulatedNitroIntentProverEnclave } from "./simulatedNitroEnclave";
import type { AttestationRequest, EncryptedWitnessPackage, FillContext, Hex } from "./types";
import { createDevRootKeypair, type DevRootKeypair } from "./attestation";
import * as dotenv from "dotenv";
dotenv.config();

const DEFAULT_PORT = 3002;

const devRoot = loadDevRoot() ?? createDevRootKeypair();
const proofGenerator = new NoirProofGenerator({
  orderFillCircuitJsonPath: env("ORDER_FILL_CIRCUIT_JSON", "../circuits/order_fill/target/order_fill.json"),
  dcaCircuitJsonPath: env("DCA_CIRCUIT_JSON", "../circuits/dca/target/dca.json"),
});

const enclave = new SimulatedNitroIntentProverEnclave({
  devRoot,
  enclavePrivateKeyHex: optionalHexEnv("ENCLAVE_PRIVATE_KEY_HEX"),
  proofGenerator,
  ticketTtlSeconds: Number.parseInt(env("TICKET_TTL_SECONDS", "60"), 10),
  proverId: requiredHexEnv("PROVER_ID"),
  proverSigningPrivateKey: requiredHexEnv("PROVER_SIGNING_PRIVATE_KEY"),
  imageDigest: requiredHexEnv("ENCLAVE_IMAGE_DIGEST"),
});

const port = Number.parseInt(env("ENCLAVE_PORT", String(DEFAULT_PORT)), 10);
const apiSecret = process.env.ENCLAVE_API_SECRET ?? "";

const server = createServer(async (req, res) => {
  try {
    setCommonHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok", mode: "SIMULATED_NITRO" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metadata") {
      json(res, 200, {
        mode: "SIMULATED_NITRO",
        rootPublicKeyPem: enclave.rootPublicKeyPem,
        imageDigest: enclave.imageDigest,
        pcrs: enclave.pcrs,
      });
      return;
    }

    if (!authorized(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/attest") {
      const body = await readJson<AttestationRequest>(req);
      json(res, 200, await enclave.attest(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/packages") {
      try {
        const body = await readJson<EncryptedWitnessPackage>(req);
        json(res, 201, await enclave.importPackage(body));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 400, { error: message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/evaluate") {
      const body = await readJson<{ commitmentHash: Hex; context: FillContext & { blockNumber?: string | bigint } }>(req);
      const context: FillContext = {
        ...body.context,
        blockNumber: typeof body.context.blockNumber === "string"
          ? BigInt(body.context.blockNumber)
          : body.context.blockNumber,
      };
      const result = await enclave.evaluate(body.commitmentHash, context);
      json(res, 200, result === "NOT_READY" ? { status: "NOT_READY" } : { status: "READY", ticket: result });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/packages/")) {
      const commitmentHash = decodeURIComponent(url.pathname.slice("/packages/".length)) as Hex;
      await enclave.prune(commitmentHash);
      json(res, 200, { status: "ok" });
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message });
  }
});

server.listen(port, () => {
  console.log(`[enclave] simulated Nitro HTTP service listening on :${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await proofGenerator.destroy();
    process.exit(0);
  });
}

function env(name: string, fallback: string): string {
  return process.env[name] && process.env[name] !== "" ? process.env[name]! : fallback;
}

function optionalHexEnv(name: string): Hex | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  return value.startsWith("0x") ? value as Hex : `0x${value}` as Hex;
}

function requiredHexEnv(name: string): Hex {
  const value = optionalHexEnv(name);
  if (!value) {
    throw new Error(`${name} is required; run npm run generate-demo-env for local demo values`);
  }
  return value;
}

function loadDevRoot(): DevRootKeypair | undefined {
  const privateKeyPem = process.env.ENCLAVE_DEV_ROOT_PRIVATE_KEY_PEM;
  const publicKeyPem = process.env.ENCLAVE_DEV_ROOT_PUBLIC_KEY_PEM;
  if (!privateKeyPem || !publicKeyPem) return undefined;
  return {
    privateKeyPem: normalizePem(privateKeyPem),
    publicKeyPem: normalizePem(publicKeyPem),
  };
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function authorized(req: IncomingMessage): boolean {
  if (apiSecret === "") return true;
  return req.headers.authorization === `Bearer ${apiSecret}`;
}

function setCommonHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}
