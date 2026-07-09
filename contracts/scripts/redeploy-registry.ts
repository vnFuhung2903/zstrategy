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
  prover?: string;
  proverId?: string;
  proverPayout?: string;
  proverSigner?: string;
  executorFeeBps?: number;
  proverFeeBps?: number;
  orderFillVerifier: string;
  dcaVerifier: string;
  collateralVault: string;
  commitmentRegistry: string;
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

type ProverConfig = {
  proverId: string;
  payout: string;
  signer: string;
  executorFeeBps: number;
  proverFeeBps: number;
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

function optionalAddress(
  label: string,
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  if (!ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid address when set`);
  }
  return value;
}

function requireBytes32(label: string, value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      `${label} is required and must be a 0x-prefixed bytes32 hex value`
    );
  }
  return value;
}

function parseFeeBps(
  label: string,
  value: string | undefined,
  fallback: number
): number {
  const raw = value ?? String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer basis-point value`);
  }
  const parsed = Number(raw);
  if (parsed > 500) {
    throw new Error(`${label} must be <= 500 bps`);
  }
  return parsed;
}

function proverSignerAddress(previous?: Deployment): string {
  const explicit = optionalAddress(
    "PROVER_SIGNER_ADDRESS",
    process.env.PROVER_SIGNER_ADDRESS ?? previous?.proverSigner
  );
  if (explicit) return explicit;

  const privateKey = process.env.PROVER_SIGNING_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "PROVER_SIGNING_PRIVATE_KEY or PROVER_SIGNER_ADDRESS is required"
    );
  }
  return new ethers.Wallet(privateKey).address;
}

function loadProverConfig(
  previous: Deployment,
  defaultPayout: string
): ProverConfig {
  const executorFeeBps = parseFeeBps(
    "EXECUTOR_FEE_BPS",
    process.env.EXECUTOR_FEE_BPS,
    previous.executorFeeBps ?? 100
  );
  const proverFeeBps = parseFeeBps(
    "PROVER_FEE_BPS",
    process.env.PROVER_FEE_BPS,
    previous.proverFeeBps ?? 100
  );
  if (executorFeeBps + proverFeeBps > 1000) {
    throw new Error("EXECUTOR_FEE_BPS + PROVER_FEE_BPS must be <= 1000 bps");
  }

  return {
    proverId: requireBytes32(
      "PROVER_ID",
      process.env.PROVER_ID ?? previous.proverId
    ),
    payout: requireAddress(
      "PROVER_PAYOUT_ADDRESS, PROVER_ADDRESS, previous prover payout, or default deployer",
      process.env.PROVER_PAYOUT_ADDRESS ??
        process.env.PROVER_ADDRESS ??
        previous.proverPayout ??
        previous.prover ??
        defaultPayout
    ),
    signer: proverSignerAddress(previous),
    executorFeeBps,
    proverFeeBps,
  };
}

function addressFromEnvOrDeployment(
  envName: string,
  deploymentKey: keyof Deployment,
  previous: Deployment
): string {
  return requireAddress(
    `${envName} or deployments.${String(deploymentKey)}`,
    process.env[envName] ?? (previous[deploymentKey] as string | undefined)
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
      throw new Error(
        `${spec.symbol} requires both ${spec.tokenEnv} and ${spec.feedEnv}`
      );
    }

    configs.push({
      symbol: spec.symbol,
      token: requireAddress(spec.tokenEnv, token),
      feed: requireAddress(spec.feedEnv, feed),
    });
  }

  return configs;
}

async function deployVault(
  label: "CollateralVault"
): Promise<string> {
  const Factory = await ethers.getContractFactory(label);
  const vault = await Factory.deploy();
  await vault.waitForDeployment();
  return vault.getAddress();
}

async function setVaultRegistry(
  label: string,
  address: string,
  newRegistry: string
) {
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

async function setVerifierIfNeeded(
  registry: any,
  kind: number,
  verifier: string,
  label: string
) {
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
    console.log(
      `  ${`${config.symbol} price feed`.padEnd(22)} already configured`
    );
    return;
  }

  await (await registry.setPriceFeed(config.token, config.feed)).wait();
  console.log(`  ${`${config.symbol} price feed`.padEnd(22)} ${config.feed}`);
}

async function setProverIfNeeded(registry: any, config: ProverConfig) {
  const current = await registry.provers(config.proverId);
  if (
    current.payout.toLowerCase() === config.payout.toLowerCase() &&
    current.signer.toLowerCase() === config.signer.toLowerCase() &&
    current.active
  ) {
    console.log(`  ${"Prover".padEnd(22)} already configured`);
    return;
  }

  await (
    await registry.setProver(
      config.proverId,
      config.payout,
      config.signer,
      true
    )
  ).wait();
  console.log(
    `  ${"Prover".padEnd(22)} signer=${config.signer} payout=${config.payout}`
  );
}

async function setFeeRatesIfNeeded(
  registry: any,
  executorFeeBps: number,
  proverFeeBps: number
) {
  const currentExecutorFeeBps = Number(await registry.executorFeeBps());
  const currentProverFeeBps = Number(await registry.proverFeeBps());
  if (
    currentExecutorFeeBps === executorFeeBps &&
    currentProverFeeBps === proverFeeBps
  ) {
    console.log(`  ${"Fee rates".padEnd(22)} already configured`);
    return;
  }

  await (await registry.setFeeRates(executorFeeBps, proverFeeBps)).wait();
  console.log(
    `  ${"Fee rates".padEnd(
      22
    )} executor=${executorFeeBps}/10000 prover=${proverFeeBps}/10000`
  );
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const file = deploymentFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at ${file}. ` +
        "Run scripts/deploy.ts first, or copy an existing artifact into deployments/."
    );
  }

  const previous = JSON.parse(fs.readFileSync(file, "utf8")) as Deployment;
  if (previous.chainId !== chainId) {
    throw new Error(
      `Network mismatch: artifact chainId=${previous.chainId}, connected chainId=${chainId}`
    );
  }

  const guardian = requireAddress(
    "GUARDIAN_ADDRESS",
    process.env.GUARDIAN_ADDRESS ?? previous.guardian ?? deployer.address
  );
  if (guardian.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer (${deployer.address}) is not the registry guardian (${guardian}). ` +
        "Switch signers or rotate the guardian first."
    );
  }

  const skipCollateralVault = true;

  const orderFillVerifier = addressFromEnvOrDeployment(
    "ORDER_FILL_VERIFIER_ADDRESS",
    "orderFillVerifier",
    previous
  );
  const dcaVerifier = addressFromEnvOrDeployment(
    "DCA_VERIFIER_ADDRESS",
    "dcaVerifier",
    previous
  );
  const dexAdapter = addressFromEnvOrDeployment(
    "DEX_ADAPTER_ADDRESS",
    "dexAdapter",
    previous
  );
  const priceFeeds = collectPriceFeeds(previous);
  const prover = loadProverConfig(previous, deployer.address);

  console.log(
    `\nzstrategy registry redeploy -> ${network.name} (chainId=${chainId})`
  );
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Guardian: ${guardian}\n`);
  console.log(`Existing registry:        ${previous.commitmentRegistry}`);
  console.log(`Existing CollateralVault: ${previous.collateralVault}`);
  console.log(`Existing DEX adapter:     ${previous.dexAdapter}`);
  console.log(`OrderFillVerifier:        ${orderFillVerifier}`);
  console.log(`DCAVerifier:              ${dcaVerifier}\n`);

  let collateralVault = previous.collateralVault;
  if (skipCollateralVault) {
    collateralVault = addressFromEnvOrDeployment(
      "COLLATERAL_VAULT_ADDRESS",
      "collateralVault",
      previous
    );
    console.log(`Reusing CollateralVault:  ${collateralVault}`);
  } else {
    console.log("Deploying new CollateralVault...");
    collateralVault = await deployVault("CollateralVault");
    console.log(`  -> ${collateralVault}`);
  }

  console.log("Deploying new CommitmentRegistry...");
  const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
  const registry = await RegistryF.deploy(
    collateralVault,
    dexAdapter,
    guardian
  );
  await registry.waitForDeployment();
  const commitmentRegistry = await registry.getAddress();
  console.log(`  -> ${commitmentRegistry}\n`);

  await setVaultRegistry(
    "CollateralVault",
    collateralVault,
    commitmentRegistry
  );

  await setVerifierIfNeeded(
    registry,
    0,
    orderFillVerifier,
    "Verifier ORDER_FILL"
  );
  await setVerifierIfNeeded(registry, 1, dcaVerifier, "Verifier DCA");

  await setProverIfNeeded(registry, prover);
  await setFeeRatesIfNeeded(
    registry,
    prover.executorFeeBps,
    prover.proverFeeBps
  );

  for (const config of priceFeeds) {
    await setPriceFeedIfNeeded(registry, config);
  }

  const next: Deployment = {
    ...previous,
    network: network.name,
    chainId,
    deployer: deployer.address,
    guardian,
    proverId: prover.proverId,
    proverPayout: prover.payout,
    proverSigner: prover.signer,
    executorFeeBps: prover.executorFeeBps,
    proverFeeBps: prover.proverFeeBps,
    orderFillVerifier,
    dcaVerifier,
    commitmentRegistry,
    collateralVault,
    dexAdapter,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(file, JSON.stringify(next, null, 2));

  console.log(`\nUpdated ${path.relative(process.cwd(), file)}`);
  console.log("\nFrontend env:");
  console.log(
    `  NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS=${commitmentRegistry}`
  );
  console.log(`  NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=${collateralVault}`);
  console.log("\nKeeper env:");
  console.log(`  COMMITMENT_REGISTRY_ADDRESS=${commitmentRegistry}`);
  console.log(`  COLLATERAL_VAULT_ADDRESS=${collateralVault}`);
  console.log(`  CHAIN_ID=${chainId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
