/**
 * zstrategy Phase 2/4 deployment script.
 *
 * Run with:
 *   npx hardhat run scripts/deploy.ts --network <name>
 *
 * Behaviour:
 *   - Components default to mocks (MockZKVerifier, MockDEXAdapter,
 *     MockChainlinkAggregator, two MockERC20s for WETH/USDC).
 *   - Any component can be overridden by setting the matching env var to an
 *     existing address, in which case that component is reused as-is.
 *   - Wires `vault.setRegistry`, then registers the price feed for both
 *     (tokenIn → tokenOut) and (tokenOut → tokenIn) so SELL and BUY paths
 *     resolve to the same ETH/USD feed.
 *   - Deploys DCAVerifier and calls registry.setVerifier(1, dcaVerifier).
 *   - Writes the resulting addresses to `deployments/<network>.json` for the
 *     frontend (`NEXT_PUBLIC_*` vars) and keeper (`*_ADDRESS` vars) to consume.
 *
 * Env overrides (all optional):
 *   ORDER_FILL_VERIFIER_ADDRESS — reuse an existing ORDER_FILL verifier
 *   DCA_VERIFIER_ADDRESS    — reuse an existing DCA verifier
 *   DEX_ADAPTER_ADDRESS     — reuse an existing IDEXAdapter
 *   ETH_USD_FEED_ADDRESS    — reuse an existing Chainlink-compatible feed
 *   WETH_ADDRESS            — reuse an existing WETH-equivalent ERC-20
 *   USDC_ADDRESS            — reuse an existing USDC-equivalent ERC-20
 *   GUARDIAN_ADDRESS        — guardian for the registry; defaults to deployer
 *   MOCK_DEX_OUT            — fixed output amount for the mock DEX (default 1 USDC)
 *   MOCK_FEED_DECIMALS      — decimals for the mock Chainlink feed (default 8)
 *   MOCK_FEED_INITIAL       — initial answer for the mock feed (default 3000_00000000)
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

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
  priceFeed:          string;
  weth:               string;
  usdc:               string;
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

  // ── ERC-20s ─────────────────────────────────────────────────────────────
  const ERC20F = await ethers.getContractFactory("MockERC20");
  const weth = await deployIfMissing(process.env.WETH_ADDRESS, "WETH", async () => {
    const c = await ERC20F.deploy("Mock WETH", "WETH", 18);
    await c.waitForDeployment();
    return c.getAddress();
  });
  const usdc = await deployIfMissing(process.env.USDC_ADDRESS, "USDC", async () => {
    const c = await ERC20F.deploy("Mock USDC", "USDC", 6);
    await c.waitForDeployment();
    return c.getAddress();
  });

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

  // ── Price feed ──────────────────────────────────────────────────────────
  const priceFeed = await deployIfMissing(process.env.ETH_USD_FEED_ADDRESS, "ETH/USD feed", async () => {
    const decimals = parseInt(process.env.MOCK_FEED_DECIMALS ?? "8");
    const initial  = BigInt(process.env.MOCK_FEED_INITIAL ?? "300000000000"); // $3000 with 8 dec
    const FeedF = await ethers.getContractFactory("MockChainlinkAggregator");
    const c = await FeedF.deploy(decimals, initial);
    await c.waitForDeployment();
    return c.getAddress();
  });

  // ── DEX adapter ─────────────────────────────────────────────────────────
  // MockDEXAdapter is fine for testnets where Uniswap v3 isn't deployed
  // (e.g. Arbitrum Sepolia). Set DEX_ADAPTER_ADDRESS to a real adapter when
  // moving to a chain with real liquidity.
  const dexAdapter = await deployIfMissing(process.env.DEX_ADAPTER_ADDRESS, "DEX adapter", async () => {
    const mockOut = BigInt(process.env.MOCK_DEX_OUT ?? "1000000"); // 1 USDC default
    const DEXF = await ethers.getContractFactory("MockDEXAdapter");
    const c = await DEXF.deploy(mockOut);
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

  // Same ETH/USD feed for both directions: the circuit and frontend treat the
  // limit price as USD per ETH regardless of side, and the BUY/SELL direction
  // flips the inequality, not the unit.
  const registryAsGuardian =
    guardian === deployer.address
      ? registry
      : registry.connect(await ethers.getSigner(guardian));

  await (await (registryAsGuardian as any).setPriceFeed(weth, usdc, priceFeed)).wait();
  await (await (registryAsGuardian as any).setPriceFeed(usdc, weth, priceFeed)).wait();
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
    priceFeed,
    weth,
    usdc,
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
  console.log(`  CHAINLINK_ETH_USD=${priceFeed}`);
  console.log(`  CHAIN_ID=${chainId}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
