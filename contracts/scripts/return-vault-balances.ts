import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

type Deployment = Record<string, any>;

type CancelEntry = {
  commitmentHash: string;
  nullifier: string;
};

const TOKEN_ENV_NAMES = [
  "WETH_ADDRESS",
  "USDC_ADDRESS",
  "USDT_ADDRESS",
  "WBTC_ADDRESS",
];

function deploymentFile() {
  return path.join(__dirname, "..", "deployments", `${network.name}.json`);
}

function loadDeployment(): Deployment {
  const file = deploymentFile();
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function requireAddress(label: string, value: string | undefined): string {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${label} is required and must be a valid address`);
  }
  return value;
}

function addressFromEnvOrDeployment(
  envName: string,
  deploymentKey: string,
  deployment: Deployment,
): string {
  return requireAddress(
    `${envName} or deployments.${deploymentKey}`,
    process.env[envName] ?? deployment[deploymentKey],
  );
}

function parseAddressList(label: string, value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => requireAddress(label, item));
}

function parseBytes32List(label: string, value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!ethers.isHexString(item, 32)) {
        throw new Error(`${label} contains an invalid bytes32 value: ${item}`);
      }
      return item;
    });
}

function collectTokenAddresses(deployment: Deployment): string[] {
  const tokens = new Set<string>();

  for (const token of parseAddressList("WITHDRAW_TOKENS", process.env.WITHDRAW_TOKENS)) {
    tokens.add(token.toLowerCase());
  }

  for (const envName of TOKEN_ENV_NAMES) {
    const token = process.env[envName];
    if (token && ethers.isAddress(token)) tokens.add(token.toLowerCase());
  }

  for (const feed of Object.values<Record<string, string>>(deployment.priceFeeds ?? {})) {
    const token = feed.token;
    if (token && ethers.isAddress(token)) tokens.add(token.toLowerCase());
  }

  return [...tokens];
}

function loadCancelEntries(): CancelEntry[] {
  const file = process.env.CANCEL_COMMITMENTS_FILE;
  if (!file) return [];

  const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("CANCEL_COMMITMENTS_FILE must contain a JSON array");
  }

  return parsed.map((entry, index) => {
    if (!ethers.isHexString(entry.commitmentHash, 32)) {
      throw new Error(`cancel entry ${index} has invalid commitmentHash`);
    }
    if (!ethers.isHexString(entry.nullifier, 32)) {
      throw new Error(`cancel entry ${index} has invalid nullifier`);
    }
    return {
      commitmentHash: entry.commitmentHash,
      nullifier: entry.nullifier,
    };
  });
}

async function main() {
  const [signer] = await ethers.getSigners();
  const deployment = loadDeployment();
  const user = signer.address;

  const commitmentRegistry = addressFromEnvOrDeployment(
    "COMMITMENT_REGISTRY_ADDRESS",
    "commitmentRegistry",
    deployment,
  );
  const collateralVault = addressFromEnvOrDeployment(
    "COLLATERAL_VAULT_ADDRESS",
    "collateralVault",
    deployment,
  );
  const tokens = collectTokenAddresses(deployment);

  const registry = await ethers.getContractAt("CommitmentRegistry", commitmentRegistry, signer);
  const collateral = await ethers.getContractAt("CollateralVault", collateralVault, signer);

  console.log(`\nReturning vault balances on ${network.name}`);
  console.log(`User:               ${user}`);
  console.log(`CommitmentRegistry: ${commitmentRegistry}`);
  console.log(`CollateralVault:    ${collateralVault}`);

  const expiredCommitments = parseBytes32List("EXPIRED_COMMITMENTS", process.env.EXPIRED_COMMITMENTS);
  if (expiredCommitments.length > 0) {
    console.log(`Sweeping ${expiredCommitments.length} expired commitment(s)...`);
    await (await registry.sweepExpired(expiredCommitments)).wait();
  }

  const cancelEntries = loadCancelEntries();
  for (const entry of cancelEntries) {
    console.log(`Cancelling ${entry.commitmentHash}...`);
    await (await registry.cancelCommitment(entry.commitmentHash, entry.nullifier)).wait();
  }

  if (tokens.length === 0) {
    console.log("No tokens configured. Set WITHDRAW_TOKENS or token env vars to withdraw collateral.");
  }

  for (const token of tokens) {
    const balance: bigint = await collateral.freeBalance(user, token);
    if (balance === 0n) {
      console.log(`Collateral ${token}: 0`);
      continue;
    }

    console.log(`Withdrawing collateral ${token}: ${balance.toString()}`);
    await (await collateral.withdraw(token, balance)).wait();
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
