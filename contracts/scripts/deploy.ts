/**
 * zstrategy Phase 2/4 deployment script — Arbitrum Sepolia testnet.
 *
 * Run with:
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia
 *
 * Our contracts deployed: OrderFillVerifier, DCAVerifier, UniswapV3Adapter,
 *   CollateralVault, CommitmentRegistry, GasVault.
 *
 * Required env vars (real testnet addresses — not mocked):
 *   WETH_ADDRESS            — e.g. 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73 (Arb Sepolia WETH)
 *   USDC_ADDRESS            — e.g. 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d (Arb Sepolia USDC)
 *   UNISWAP_ROUTER_ADDRESS  — Uniswap v3 SwapRouter on this chain
 *
 * Optional env vars:
 *   ORDER_FILL_VERIFIER_ADDRESS — reuse an existing OrderFillVerifier
 *   DCA_VERIFIER_ADDRESS        — reuse an existing DCAVerifier
 *   DEX_ADAPTER_ADDRESS         — reuse an existing UniswapV3Adapter
 *   GAS_VAULT_ADDRESS           — reuse an existing GasVault (avoids orphaning balances)
 *   ETH_USD_FEED_ADDRESS        — reuse a real Chainlink feed; omit to deploy MockChainlinkAggregator
 *   UNISWAP_FEE_TIER            — pool fee tier in bps×100 (default 500 = 0.05%)
 *   SWAP_DEADLINE_BUFFER        — seconds added to block.timestamp for swap deadline (default 300)
 *   MOCK_FEED_DECIMALS          — decimals for the mock feed (default 8)
 *   MOCK_FEED_INITIAL           — initial answer for the mock feed (default 300000000000 = $3000)
 *   GUARDIAN_ADDRESS            — guardian for the registry; defaults to deployer
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

interface Deployment {
  network:            string;
  chainId:            number;
  deployer:           string;
  guardian:           string;
  orderFillVerifier:  string;
  dcaVerifier:        string;
  collateralVault:    string;
  commitmentRegistry: string;
  gasVault:           string;
  dexAdapter:         string;
  deployedAt:         string;
}

async function deployIfMissing(
  envAddress: string | undefined,
  label: string,
  factory: () => Promise<string>,
): Promise<string> {
  if (envAddress && ethers.isAddress(envAddress)) {
    console.log(`  ${label.padEnd(20)} ${envAddress}  (reused via env)`);
    return envAddress;
  }
  const addr = await factory();
  console.log(`  ${label.padEnd(20)} ${addr}  (deployed)`);
  return addr;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const guardian = process.env.GUARDIAN_ADDRESS ?? deployer.address;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`\nzstrategy deploy → ${network.name} (chainId=${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Guardian: ${guardian}\n`);

  // ── ERC-20s (real testnet addresses required — not mocked) ──────────────
  if (!process.env.WETH_ADDRESS || !ethers.isAddress(process.env.WETH_ADDRESS))
    throw new Error("WETH_ADDRESS is required");
  if (!process.env.USDC_ADDRESS || !ethers.isAddress(process.env.USDC_ADDRESS))
    throw new Error("USDC_ADDRESS is required");
  const weth = process.env.WETH_ADDRESS as string;
  const usdc = process.env.USDC_ADDRESS as string;
  console.log(`  WETH                 ${weth}  (from env)`);
  console.log(`  USDC                 ${usdc}  (from env)`);

  // ── Verifiers ───────────────────────────────────────────────────────────
  // The bb-generated verifier files each declare their own `ZKTranscriptLib`
  // (the only library Solidity decides to externalize — too large to inline).
  // Each must be deployed and linked at factory-construction time. The other
  // libraries (Honk, FrLib, RelationsLib, etc.) are all `internal` and
  // inlined by solc, so no linking is needed for them.
  //
  // If you regenerate the verifier files via `bb write_solidity`, re-apply
  // the contract rename (see OrderFillVerifier.sol top comment) and verify the
  // library name is still `ZKTranscriptLib`.
  const orderFillVerifier = await deployIfMissing(process.env.ORDER_FILL_VERIFIER_ADDRESS, "OrderFillVerifier", async () => {
    const LibF = await ethers.getContractFactory(
      "contracts/core/OrderFillVerifier.sol:ZKTranscriptLib"
    );
    const lib = await LibF.deploy();
    await lib.waitForDeployment();
    const VerifierF = await ethers.getContractFactory("OrderFillVerifier", {
      libraries: { ZKTranscriptLib: await lib.getAddress() },
    });
    const c = await VerifierF.deploy();
    await c.waitForDeployment();
    return c.getAddress();
  });
  const dcaVerifier = await deployIfMissing(process.env.DCA_VERIFIER_ADDRESS, "DCAVerifier", async () => {
    const LibF = await ethers.getContractFactory(
      "contracts/core/DCAVerifier.sol:ZKTranscriptLib"
    );
    const lib = await LibF.deploy();
    await lib.waitForDeployment();
    const VerifierF = await ethers.getContractFactory("DCAVerifier", {
      libraries: { ZKTranscriptLib: await lib.getAddress() },
    });
    const c = await VerifierF.deploy();
    await c.waitForDeployment();
    return c.getAddress();
  });

  // ── Price feeds (per-token USD feeds; pair price derived on-chain) ───────
  if (!process.env.CHAINLINK_PRICE_FEED_WETH_USD || !ethers.isAddress(process.env.CHAINLINK_PRICE_FEED_WETH_USD))
    throw new Error("CHAINLINK_PRICE_FEED_WETH_USD is required");
  if (!process.env.CHAINLINK_PRICE_FEED_USDC_USD || !ethers.isAddress(process.env.CHAINLINK_PRICE_FEED_USDC_USD))
    throw new Error("CHAINLINK_PRICE_FEED_USDC_USD is required");
  const wethUsdFeed = process.env.CHAINLINK_PRICE_FEED_WETH_USD as string;
  const usdcUsdFeed = process.env.CHAINLINK_PRICE_FEED_USDC_USD as string;
  console.log(`  WETH/USD feed        ${wethUsdFeed}  (from env)`);
  console.log(`  USDC/USD feed        ${usdcUsdFeed}  (from env)`);

  // ── DEX adapter ─────────────────────────────────────────────────────────
  const dexAdapter = await deployIfMissing(process.env.DEX_ADAPTER_ADDRESS, "UniswapV3Adapter", async () => {
    const routerAddr = process.env.UNISWAP_ROUTER_ADDRESS;
    if (!routerAddr || !ethers.isAddress(routerAddr)) throw new Error("UNISWAP_ROUTER_ADDRESS is required");
    const feeTier      = parseInt(process.env.UNISWAP_FEE_TIER ?? "500");
    const deadlineBuf  = parseInt(process.env.SWAP_DEADLINE_BUFFER ?? "300");
    const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
    const c = await AdapterF.deploy(routerAddr, feeTier, deadlineBuf);
    await c.waitForDeployment();
    return c.getAddress();
  });

  // ── Vault + Registry (circular dep broken by setRegistry) ───────────────
  const VaultF = await ethers.getContractFactory("CollateralVault");
  const vault = await VaultF.deploy();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`  CollateralVault      ${vaultAddr}  (deployed)`);

  const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
  const registry = await RegistryF.deploy(orderFillVerifier, vaultAddr, dexAdapter, guardian);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log(`  CommitmentRegistry   ${registryAddr}  (deployed)`);

  // ── Wiring ──────────────────────────────────────────────────────────────
  await (await vault.setRegistry(registryAddr)).wait();
  console.log("  vault.setRegistry    ✓");

  const registryAsGuardian =
    guardian === deployer.address
      ? registry
      : registry.connect(await ethers.getSigner(guardian));

  await (await (registryAsGuardian as any).setPriceFeed(weth, wethUsdFeed)).wait();
  await (await (registryAsGuardian as any).setPriceFeed(usdc, usdcUsdFeed)).wait();
  console.log("  setPriceFeed (×2)    ✓");

  await (await (registryAsGuardian as any).setVerifier(1, dcaVerifier)).wait();
  console.log("  setVerifier DCA      ✓");

  // ── GasVault (prepaid keeper-gas reimbursement) ─────────────────────────
  // Same circular-deploy dance as CollateralVault: deploy, then setRegistry.
  // Then wire into registry so executeCommitment debits the owner's ETH and
  // forwards it (with KEEPER_PREMIUM_BPS = 120%) to the keeper EOA.
  // Honours GAS_VAULT_ADDRESS env override so re-running the deploy reuses
  // the existing tank rather than orphaning user balances.
  const gasVaultAddr = await deployIfMissing(process.env.GAS_VAULT_ADDRESS, "GasVault", async () => {
    const GasVaultF = await ethers.getContractFactory("GasVault");
    const gv = await GasVaultF.deploy();
    await gv.waitForDeployment();
    const addr = await gv.getAddress();
    await (await gv.setRegistry(registryAddr)).wait();
    return addr;
  });

  await (await (registryAsGuardian as any).setGasVault(gasVaultAddr)).wait();
  console.log("  setGasVault          ✓");

  // ── Persist ─────────────────────────────────────────────────────────────
  const out: Deployment = {
    network:            network.name,
    chainId,
    deployer:           deployer.address,
    guardian,
    orderFillVerifier,
    dcaVerifier,
    collateralVault:    vaultAddr,
    commitmentRegistry: registryAddr,
    gasVault:           gasVaultAddr,
    dexAdapter,
    deployedAt:         new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nDeployment written to ${path.relative(process.cwd(), file)}`);
  console.log(`\nFrontend env (next .env.local):`);
  console.log(`  NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`  NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=${vaultAddr}`);
  console.log(`  NEXT_PUBLIC_GAS_VAULT_ADDRESS=${gasVaultAddr}`);
  console.log(`\nKeeper env (.env):`);
  console.log(`  COMMITMENT_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`  COLLATERAL_VAULT_ADDRESS=${vaultAddr}`);
  console.log(`  GAS_VAULT_ADDRESS=${gasVaultAddr}`);
  console.log(`  CHAINLINK_PRICE_FEED_WETH_USD=${wethUsdFeed}`);
  console.log(`  CHAINLINK_PRICE_FEED_USDC_USD=${usdcUsdFeed}`);
  console.log(`  CHAIN_ID=${chainId}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
