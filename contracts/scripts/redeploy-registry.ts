/**
 * Redeploy CommitmentRegistry and optionally redeploy its vault dependencies.
 *
 * Run with:
 *   npx hardhat run scripts/redeploy-registry.ts --network arbitrumSepolia
 *
 * Default behavior:
 *   - reuse OrderFillVerifier, DCAVerifier, and DEX adapter
 *   - deploy a fresh CollateralVault
 *   - deploy a fresh GasVault
 *   - deploy a fresh CommitmentRegistry
 *   - point both vaults at the new registry
 *   - set verifiers and price feeds on the new registry
 *
 * Selectively skip vault redeploys with:
 *   SKIP_COLLATERAL_VAULT=1  reuse COLLATERAL_VAULT_ADDRESS / artifact collateralVault
 *   SKIP_GAS_VAULT=1         reuse GAS_VAULT_ADDRESS / artifact gasVault
 *
 * Reused vaults must have owner-rewireable setRegistry(). Older one-time
 * vault bytecode cannot be reused with a newly deployed registry.
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

interface Deployment {
  network: string;
  chainId: number;
  deployer: string;
  guardian: string;
  orderFillVerifier: string;
  dcaVerifier: string;
  collateralVault: string;
  commitmentRegistry: string;
  gasVault: string;
  dexAdapter: string;
  deployedAt: string;
  priceFeeds?: Record<string, { token: string; feed: string }>;
}

type PriceFeedSpec = {
  symbol: string;
  tokenEnv: string;
  feedEnv: string;
  required: boolean;
};

type PriceFeedConfig = {
  symbol: string;
  token: string;
  feed: string;
};

const PRICE_FEEDS: PriceFeedSpec[] = [
  {
    symbol: "WETH",
    tokenEnv: "WETH_ADDRESS",
    feedEnv: "CHAINLINK_PRICE_FEED_WETH_USD",
    required: true,
  },
  {
    symbol: "USDC",
    tokenEnv: "USDC_ADDRESS",
    feedEnv: "CHAINLINK_PRICE_FEED_USDC_USD",
    required: true,
  },
  {
    symbol: "USDT",
    tokenEnv: "USDT_ADDRESS",
    feedEnv: "CHAINLINK_PRICE_FEED_USDT_USD",
    required: false,
  },
  {
    symbol: "WBTC",
    tokenEnv: "WBTC_ADDRESS",
    feedEnv: "CHAINLINK_PRICE_FEED_WBTC_USD",
    required: false,
  },
];

const REGISTRY_OWNED_ABI = [
  "function registry() view returns (address)",
  "function setRegistry(address)",
];

function deploymentFile() {
  return path.join(__dirname, "..", "deployments", `${network.name}.json`);
}

function requireAddress(label: string, value: string | undefined): string {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${label} is required and must be a valid address`);
  }
  return value;
}

function addressFromEnvOrDeployment(
  envName: string,
  deploymentKey: keyof Deployment,
  previous: Deployment,
): string {
  return requireAddress(
    `${envName} or deployments.${String(deploymentKey)}`,
    process.env[envName] ?? (previous[deploymentKey] as string | undefined),
  );
}

function collectPriceFeeds(previous: Deployment): PriceFeedConfig[] {
  const configs: PriceFeedConfig[] = [];
  const previousFeeds = previous.priceFeeds ?? {};

  for (const spec of PRICE_FEEDS) {
    const previousFeed = previousFeeds[spec.symbol] ?? {};
    const token = process.env[spec.tokenEnv] ?? previousFeed.token;
    const feed = process.env[spec.feedEnv] ?? previousFeed.feed;

    if (!token && !feed && !spec.required) continue;
    if (!token || !feed) {
      throw new Error(`${spec.symbol} requires both ${spec.tokenEnv} and ${spec.feedEnv}`);
    }

    configs.push({
      symbol: spec.symbol,
      token: requireAddress(spec.tokenEnv, token),
      feed: requireAddress(spec.feedEnv, feed),
    });
  }

  return configs;
}

function deploymentPriceFeedMap(configs: PriceFeedConfig[]) {
  return configs.reduce<Record<string, { token: string; feed: string }>>((acc, config) => {
    acc[config.symbol] = { token: config.token, feed: config.feed };
    return acc;
  }, {});
}

async function deployVault(label: "CollateralVault" | "GasVault"): Promise<string> {
  const Factory = await ethers.getContractFactory(label);
  const vault = await Factory.deploy();
  await vault.waitForDeployment();
  return vault.getAddress();
}

async function setVaultRegistry(label: string, address: string, newRegistry: string) {
  const [deployer] = await ethers.getSigners();
  const contract = new ethers.Contract(address, REGISTRY_OWNED_ABI, deployer);
  const current = await contract.registry();

  if (current.toLowerCase() === newRegistry.toLowerCase()) {
    console.log(`  ${label.padEnd(22)} already points to registry`);
    return;
  }

  await (await contract.setRegistry(newRegistry)).wait();
  console.log(`  ${label.padEnd(22)} setRegistry ${current} -> ${newRegistry}`);
}

async function setVerifierIfNeeded(registry: any, kind: number, verifier: string, label: string) {
  const current = await registry.verifiers(kind);
  if (current.toLowerCase() === verifier.toLowerCase()) {
    console.log(`  ${label.padEnd(22)} already configured`);
    return;
  }

  await (await registry.setVerifier(kind, verifier)).wait();
  console.log(`  ${label.padEnd(22)} ${verifier}`);
}

async function setPriceFeedIfNeeded(registry: any, config: PriceFeedConfig) {
  const current = await registry.priceFeeds(config.token);
  if (current.toLowerCase() === config.feed.toLowerCase()) {
    console.log(`  ${`${config.symbol} price feed`.padEnd(22)} already configured`);
    return;
  }

  await (await registry.setPriceFeed(config.token, config.feed)).wait();
  console.log(`  ${`${config.symbol} price feed`.padEnd(22)} ${config.feed}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const file = deploymentFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at ${file}. ` +
        "Run scripts/deploy.ts first, or copy an existing artifact into deployments/.",
    );
  }

  const previous = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  if (previous.chainId !== chainId) {
    throw new Error(
      `Network mismatch: artifact chainId=${previous.chainId}, connected chainId=${chainId}`,
    );
  }

  const guardian = requireAddress(
    "GUARDIAN_ADDRESS",
    process.env.GUARDIAN_ADDRESS ?? previous.guardian ?? deployer.address,
  );
  if (guardian.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer (${deployer.address}) is not the registry guardian (${guardian}). ` +
        "Switch signers or rotate the guardian first.",
    );
  }

  const skipCollateralVault = process.env.SKIP_COLLATERAL_VAULT === "1";
  const skipGasVault = process.env.SKIP_GAS_VAULT === "1";

  const orderFillVerifier = addressFromEnvOrDeployment(
    "ORDER_FILL_VERIFIER_ADDRESS",
    "orderFillVerifier",
    previous,
  );
  const dcaVerifier = addressFromEnvOrDeployment("DCA_VERIFIER_ADDRESS", "dcaVerifier", previous);
  const dexAdapter = addressFromEnvOrDeployment("DEX_ADAPTER_ADDRESS", "dexAdapter", previous);
  const priceFeeds = collectPriceFeeds(previous);

  console.log(`\nzstrategy registry redeploy -> ${network.name} (chainId=${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Guardian: ${guardian}\n`);
  console.log(`Existing registry:        ${previous.commitmentRegistry}`);
  console.log(`Existing CollateralVault: ${previous.collateralVault}`);
  console.log(`Existing GasVault:        ${previous.gasVault}`);
  console.log(`Existing DEX adapter:     ${previous.dexAdapter}`);
  console.log(`OrderFillVerifier:        ${orderFillVerifier}`);
  console.log(`DCAVerifier:              ${dcaVerifier}\n`);

  let collateralVault = previous.collateralVault;
  if (skipCollateralVault) {
    collateralVault = addressFromEnvOrDeployment(
      "COLLATERAL_VAULT_ADDRESS",
      "collateralVault",
      previous,
    );
    console.log(`Reusing CollateralVault:  ${collateralVault}`);
  } else {
    console.log("Deploying new CollateralVault...");
    collateralVault = await deployVault("CollateralVault");
    console.log(`  -> ${collateralVault}`);
  }

  let gasVault = previous.gasVault;
  if (skipGasVault) {
    gasVault = addressFromEnvOrDeployment("GAS_VAULT_ADDRESS", "gasVault", previous);
    console.log(`Reusing GasVault:         ${gasVault}`);
  } else {
    console.log("Deploying new GasVault...");
    gasVault = await deployVault("GasVault");
    console.log(`  -> ${gasVault}`);
  }

  console.log("Deploying new CommitmentRegistry...");
  const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
  const registry = await RegistryF.deploy(gasVault, collateralVault, dexAdapter, guardian);
  await registry.waitForDeployment();
  const commitmentRegistry = await registry.getAddress();
  console.log(`  -> ${commitmentRegistry}\n`);

  await setVaultRegistry("CollateralVault", collateralVault, commitmentRegistry);
  await setVaultRegistry("GasVault", gasVault, commitmentRegistry);

  await setVerifierIfNeeded(registry, 0, orderFillVerifier, "Verifier ORDER_FILL");
  await setVerifierIfNeeded(registry, 1, dcaVerifier, "Verifier DCA");

  for (const config of priceFeeds) {
    await setPriceFeedIfNeeded(registry, config);
  }

  const next: Deployment = {
    ...previous,
    network: network.name,
    chainId,
    deployer: deployer.address,
    guardian,
    orderFillVerifier,
    dcaVerifier,
    commitmentRegistry,
    collateralVault,
    gasVault,
    dexAdapter,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(file, JSON.stringify(next, null, 2));

  console.log(`\nUpdated ${path.relative(process.cwd(), file)}`);
  console.log("\nFrontend env:");
  console.log(`  NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS=${commitmentRegistry}`);
  console.log(`  NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=${collateralVault}`);
  console.log(`  NEXT_PUBLIC_GAS_VAULT_ADDRESS=${gasVault}`);
  console.log("\nKeeper env:");
  console.log(`  COMMITMENT_REGISTRY_ADDRESS=${commitmentRegistry}`);
  console.log(`  COLLATERAL_VAULT_ADDRESS=${collateralVault}`);
  console.log(`  GAS_VAULT_ADDRESS=${gasVault}`);
  console.log(`  CHAIN_ID=${chainId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
