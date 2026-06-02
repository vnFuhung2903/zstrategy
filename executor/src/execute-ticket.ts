/**
 * Claim one v2 execution ticket from the Go backend and submit it on-chain.
 *
 * The executor wallet never receives witness data. It only receives public
 * metadata plus an already-generated proof bundle, then calls
 * CommitmentRegistry.executeCommitment.
 */

import "dotenv/config";
import { ethers } from "ethers";

type TicketKind = "ORDER_FILL" | "DCA";

interface ExecutionTicket {
  version: number;
  chainId: number;
  registry: string;
  commitmentHash: string;
  kind: TicketKind;
  nullifier: string;
  fillRef: string;
  proof: string;
  ticketExpiresAt: number;
  executor?: string;
  packageHash: string;
  proverIds: string[];
  proverSignature: string;
}

interface ClaimedTicket {
  commitmentHash: string;
  chainId: number;
  registry: string;
  ticket: ExecutionTicket;
}

const REGISTRY_ABI = [
  "function executeCommitment(bytes32 commitmentHash, bytes32 nullifier, bytes calldata proof, uint64 fillRef) external",
];

export async function main() {
  const backendURL = (process.env.BACKEND_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  const rpcURL = requireEnv("RPC_URL");
  const privateKey = process.env.EXECUTOR_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("missing EXECUTOR_PRIVATE_KEY or PRIVATE_KEY");
  }

  const provider = new ethers.JsonRpcProvider(rpcURL);
  const wallet = new ethers.Wallet(privateKey, provider);
  const executorAddress = await wallet.getAddress();
  const network = await provider.getNetwork();
  const chainID = expectedChainID(network.chainId);

  const url = `${backendURL}/api/v1/executor/tickets/claim?chain_id=${chainID.toString()}`;
  const claimed = await claimTicket(url, executorAddress);
  if (!claimed) {
    console.log("No execution tickets ready.");
    return;
  }

  validateTicket(claimed, chainID, executorAddress);

  const ticket = claimed.ticket;
  const registry = new ethers.Contract(ticket.registry, REGISTRY_ABI, wallet);
  const executeCommitment = registry.getFunction("executeCommitment");
  const fillRef = parseUint64(ticket.fillRef, "fillRef");
  const estimatedGas = await executeCommitment.estimateGas(
    ticket.commitmentHash,
    ticket.nullifier,
    ticket.proof,
    fillRef,
  );
  const gasLimit = estimatedGas * 12n / 10n;

  console.log(`Executor: ${executorAddress}`);
  console.log(`Registry: ${ticket.registry}`);
  console.log(`Commitment: ${ticket.commitmentHash}`);
  console.log(`Kind: ${ticket.kind}`);
  console.log(`Gas estimate: ${estimatedGas.toString()} limit=${gasLimit.toString()}`);

  const tx = await executeCommitment(
    ticket.commitmentHash,
    ticket.nullifier,
    ticket.proof,
    fillRef,
    { gasLimit },
  );
  console.log(`Submitted: ${tx.hash}`);

  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`execution transaction failed: ${tx.hash}`);
  }
  console.log(`Executed in block ${receipt.blockNumber}`);
}

async function claimTicket(url: string, executor: string): Promise<ClaimedTicket | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ executor }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`claim ticket failed: ${res.status} ${text}`);
  }

  const body = await res.json();
  return parseClaimedTicket(body);
}

export function parseClaimedTicket(body: unknown): ClaimedTicket {
  const envelope = asRecord(asRecord(body, "response").data, "data");
  const ticket = asRecord(envelope.ticket, "data.ticket");
  const kind = requiredString(ticket.kind, "ticket.kind");
  if (kind !== "ORDER_FILL" && kind !== "DCA") {
    throw new Error("ticket.kind must be ORDER_FILL or DCA");
  }

  const claimed: ClaimedTicket = {
    commitmentHash: requiredBytes32(envelope.commitmentHash, "commitmentHash"),
    chainId: requiredSafeInteger(envelope.chainId, "chainId"),
    registry: requiredAddress(envelope.registry, "registry"),
    ticket: {
      version: requiredSafeInteger(ticket.version, "ticket.version"),
      chainId: requiredSafeInteger(ticket.chainId, "ticket.chainId"),
      registry: requiredAddress(ticket.registry, "ticket.registry"),
      commitmentHash: requiredBytes32(ticket.commitmentHash, "ticket.commitmentHash"),
      kind,
      nullifier: requiredBytes32(ticket.nullifier, "ticket.nullifier"),
      fillRef: requiredString(ticket.fillRef, "ticket.fillRef"),
      proof: requiredHexData(ticket.proof, "ticket.proof"),
      ticketExpiresAt: requiredSafeInteger(ticket.ticketExpiresAt, "ticket.ticketExpiresAt"),
      packageHash: requiredBytes32(ticket.packageHash, "ticket.packageHash"),
      proverIds: requiredStringArray(ticket.proverIds, "ticket.proverIds"),
      proverSignature: requiredHexData(ticket.proverSignature, "ticket.proverSignature"),
    },
  };

  if (ticket.executor !== undefined) {
    claimed.ticket.executor = requiredAddress(ticket.executor, "ticket.executor");
  }

  return claimed;
}

export function validateTicket(claimed: ClaimedTicket, expectedChainID: bigint, executorAddress: string) {
  const ticket = claimed.ticket;
  const now = Math.floor(Date.now() / 1000);
  if (ticket.version !== 1) {
    throw new Error(`unsupported ticket version ${ticket.version}`);
  }
  if (ticket.ticketExpiresAt <= now) {
    throw new Error(`claimed ticket is expired: ${ticket.ticketExpiresAt}`);
  }
  if (BigInt(claimed.chainId) !== expectedChainID || BigInt(ticket.chainId) !== expectedChainID) {
    throw new Error(`ticket chainId does not match network ${expectedChainID.toString()}`);
  }
  if (ticket.commitmentHash.toLowerCase() !== claimed.commitmentHash.toLowerCase()) {
    throw new Error("ticket commitmentHash does not match claim envelope");
  }
  if (ticket.registry.toLowerCase() !== claimed.registry.toLowerCase()) {
    throw new Error("ticket registry does not match claim envelope");
  }
  if (ticket.kind === "ORDER_FILL" && ticket.fillRef !== "0") {
    throw new Error("ORDER_FILL ticket must use fillRef 0");
  }
  parseUint64(ticket.fillRef, "fillRef");
  if (ticket.executor && ticket.executor.toLowerCase() !== executorAddress.toLowerCase()) {
    throw new Error("ticket executor is bound to a different address");
  }
}

function expectedChainID(networkChainID: bigint): bigint {
  if (!process.env.CHAIN_ID) return networkChainID;
  const configured = parseUint64(process.env.CHAIN_ID, "CHAIN_ID");
  if (configured !== networkChainID) {
    throw new Error(`CHAIN_ID ${configured.toString()} does not match RPC chain ${networkChainID.toString()}`);
  }
  return configured;
}

export function parseUint64(raw: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be a uint64 decimal string`);
  }
  const value = BigInt(raw);
  if (value > (1n << 64n) - 1n) {
    throw new Error(`${name} exceeds uint64`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requiredAddress(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  if (!ethers.isAddress(raw)) {
    throw new Error(`${name} must be an address`);
  }
  return raw;
}

function requiredBytes32(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  if (!ethers.isHexString(raw, 32)) {
    throw new Error(`${name} must be bytes32 hex`);
  }
  return raw;
}

function requiredHexData(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  if (!ethers.isHexString(raw) || raw === "0x") {
    throw new Error(`${name} must be non-empty hex data`);
  }
  return raw;
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
