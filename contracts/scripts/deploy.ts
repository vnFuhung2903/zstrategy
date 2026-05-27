/**
 * Full zstrategy deployment script.
 *
 * Run with:
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia
 *
 * Optional env overrides let you reuse already deployed components:
 *   ORDER_FILL_VERIFIER_ADDRESS
 *   DCA_VERIFIER_ADDRESS
 *   DEX_ADAPTER_ADDRESS
 *   COLLATERAL_VAULT_ADDRESS
 *   GAS_VAULT_ADDRESS
 *
 * Required env vars for a fresh deploy:
 *   UNISWAP_ROUTER_ADDRESS
 *   WETH_ADDRESS
 *   USDC_ADDRESS
 *   CHAINLINK_PRICE_FEED_WETH_USD
 *   CHAINLINK_PRICE_FEED_USDC_USD
 *
 * Optional token/feed pairs are configured when both env vars are present:
 *   USDT_ADDRESS + CHAINLINK_PRICE_FEED_USDT_USD
 *   WBTC_ADDRESS + CHAINLINK_PRICE_FEED_WBTC_USD
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

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
  priceFeeds: Record<string, { token: string; feed: string }>;
  deployedAt: string;
}

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

function requireAddress(label: string, value: string | undefined): string {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${label} is required and must be a valid address`);
  }
  return value;
}

function optionalAddress(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid address when set`);
  }
  return value;
}

async function deployIfMissing(
  envName: string,
  label: string,
  factory: () => Promise<string>,
): Promise<string> {
  const envAddress = optionalAddress(envName, process.env[envName]);
  if (envAddress) {
    console.log(`  ${label.padEnd(22)} ${envAddress}  (reused via ${envName})`);
    return envAddress;
  }

  const addr = await factory();
  console.log(`  ${label.padEnd(22)} ${addr}  (deployed)`);
  return addr;
}

function collectPriceFeeds(): PriceFeedConfig[] {
  const configs: PriceFeedConfig[] = [];

  for (const spec of PRICE_FEEDS) {
    const token = process.env[spec.tokenEnv];
    const feed = process.env[spec.feedEnv];

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

async function deployOrderFillVerifier(): Promise<string> {
  const LibF = await ethers.getContractFactory(
    "contracts/core/OrderFillVerifier.sol:ZKTranscriptLib",
  );
  const lib = await LibF.deploy();
  await lib.waitForDeployment();

  const VerifierF = await ethers.getContractFactory("OrderFillVerifier", {
    libraries: { ZKTranscriptLib: await lib.getAddress() },
  });
  const verifier = await VerifierF.deploy();
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function deployDcaVerifier(): Promise<string> {
  const LibF = await ethers.getContractFactory(
    "contracts/core/DCAVerifier.sol:ZKTranscriptLib",
  );
  const lib = await LibF.deploy();
  await lib.waitForDeployment();

  const VerifierF = await ethers.getContractFactory("DCAVerifier", {
    libraries: { ZKTranscriptLib: await lib.getAddress() },
  });
  const verifier = await VerifierF.deploy();
  await verifier.waitForDeployment();
  return verifier.getAddress();
}

async function setVaultRegistry(label: string, address: string, registry: string) {
  const [deployer] = await ethers.getSigners();
  const contract = new ethers.Contract(address, REGISTRY_OWNED_ABI, deployer);
  const current = await contract.registry();

  if (current.toLowerCase() === registry.toLowerCase()) {
    console.log(`  ${label.padEnd(22)} already points to registry`);
    return;
  }

  await (await contract.setRegistry(registry)).wait();
  console.log(`  ${label.padEnd(22)} setRegistry ${current} -> ${registry}`);
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

function deploymentPriceFeedMap(configs: PriceFeedConfig[]) {
  return configs.reduce<Record<string, { token: string; feed: string }>>((acc, config) => {
    acc[config.symbol] = { token: config.token, feed: config.feed };
    return acc;
  }, {});
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const guardian = requireAddress("GUARDIAN_ADDRESS", process.env.GUARDIAN_ADDRESS ?? deployer.address);

  if (guardian.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error("GUARDIAN_ADDRESS must be the deployer for this script to run setup transactions");
  }

  console.log(`\nzstrategy full deploy -> ${network.name} (chainId=${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Guardian: ${guardian}\n`);

  const priceFeeds = collectPriceFeeds();
  for (const config of priceFeeds) {
    console.log(`  ${config.symbol.padEnd(22)} ${config.token}`);
    console.log(`  ${`${config.symbol}/USD feed`.padEnd(22)} ${config.feed}`);
  }

  const orderFillVerifier = await deployIfMissing(
    "ORDER_FILL_VERIFIER_ADDRESS",
    "OrderFillVerifier",
    deployOrderFillVerifier,
  );
  const dcaVerifier = await deployIfMissing(
    "DCA_VERIFIER_ADDRESS",
    "DCAVerifier",
    deployDcaVerifier,
  );

  const dexAdapter = await deployIfMissing("DEX_ADAPTER_ADDRESS", "UniswapV3Adapter", async () => {
    const router = requireAddress("UNISWAP_ROUTER_ADDRESS", process.env.UNISWAP_ROUTER_ADDRESS);
    const feeTier = parseInt(process.env.UNISWAP_FEE_TIER ?? "500", 10);
    const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
    const adapter = await AdapterF.deploy(router, feeTier);
    await adapter.waitForDeployment();
    return adapter.getAddress();
  });

  const collateralVault = await deployIfMissing("COLLATERAL_VAULT_ADDRESS", "CollateralVault", async () => {
    const VaultF = await ethers.getContractFactory("CollateralVault");
    const vault = await VaultF.deploy();
    await vault.waitForDeployment();
    return vault.getAddress();
  });

  const gasVault = await deployIfMissing("GAS_VAULT_ADDRESS", "GasVault", async () => {
    const GasVaultF = await ethers.getContractFactory("GasVault");
    const vault = await GasVaultF.deploy();
    await vault.waitForDeployment();
    return vault.getAddress();
  });

  const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
  const registry = await RegistryF.deploy(gasVault, collateralVault, dexAdapter, guardian);
  await registry.waitForDeployment();
  const commitmentRegistry = await registry.getAddress();
  console.log(`  ${"CommitmentRegistry".padEnd(22)} ${commitmentRegistry}  (deployed)`);

  await setVaultRegistry("CollateralVault", collateralVault, commitmentRegistry);
  await setVaultRegistry("GasVault", gasVault, commitmentRegistry);

  await setVerifierIfNeeded(registry, 0, orderFillVerifier, "Verifier ORDER_FILL");
  await setVerifierIfNeeded(registry, 1, dcaVerifier, "Verifier DCA");

  for (const config of priceFeeds) {
    await setPriceFeedIfNeeded(registry, config);
  }

  const out: Deployment = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    guardian,
    orderFillVerifier,
    dcaVerifier,
    collateralVault,
    commitmentRegistry,
    gasVault,
    dexAdapter,
    priceFeeds: deploymentPriceFeedMap(priceFeeds),
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\nDeployment written to ${path.relative(process.cwd(), file)}`);
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
