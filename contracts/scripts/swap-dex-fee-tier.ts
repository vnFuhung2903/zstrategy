/**
 * Redeploy UniswapV3Adapter pointed at a different fee tier and swap it in via
 * registry.setDEXAdapter. Use when the originally-configured tier turns out to
 * have insufficient pool liquidity (run diagnose-uniswap.ts to confirm).
 *
 * On Arbitrum Sepolia for USDC/WETH, the tier-500 pool is dead (~88k L) while
 * the tier-3000 pool has well over 30T L — switching tiers fixes the empty-
 * data revert from executeCommitment without touching anything else.
 *
 *   FEE_TIER=3000 npx hardhat run scripts/swap-dex-fee-tier.ts --network arbitrumSepolia
 *
 * Env (all optional except FEE_TIER):
 *   FEE_TIER                Required. Uniswap V3 fee tier — 100, 500, 3000, 10000.
 *   SWAP_DEADLINE_BUFFER    Seconds after block.timestamp for the swap deadline.
 *                           Defaults to the same 300 used by the main deploy script.
 *   UNISWAP_ROUTER_ADDRESS  Override the router. Defaults to whatever the
 *                           currently-deployed adapter reports via .router().
 */

import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

interface Deployment {
  network:            string;
  chainId:            number;
  guardian:           string;
  commitmentRegistry: string;
  dexAdapter:         string;
  [k: string]: unknown;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}`);
  const prev = JSON.parse(fs.readFileSync(file, "utf-8")) as Deployment;
  if (prev.chainId !== chainId) {
    throw new Error(`Network mismatch: artifact chainId=${prev.chainId}, connected chainId=${chainId}`);
  }

  const feeTierStr = process.env.FEE_TIER || "3000";
  if (!feeTierStr) throw new Error("FEE_TIER env var required (e.g. 3000).");
  const feeTier = parseInt(feeTierStr, 10);
  if (![100, 500, 3000, 10000].includes(feeTier)) {
    throw new Error(`FEE_TIER must be one of {100, 500, 3000, 10000}, got ${feeTier}.`);
  }

  // Pull the router from the existing adapter unless overridden. Keeps the
  // V3 deployment address stable across this swap — only the fee tier moves.
  const adapterAbi = ["function router() external view returns (address)"];
  const oldAdapter = new Contract(prev.dexAdapter, adapterAbi, ethers.provider);
  let routerAddr: string;
  if (process.env.UNISWAP_ROUTER_ADDRESS && ethers.isAddress(process.env.UNISWAP_ROUTER_ADDRESS)) {
    routerAddr = process.env.UNISWAP_ROUTER_ADDRESS;
  } else {
    routerAddr = await oldAdapter.router();
  }

  console.log(`\nzstrategy: swap UniswapV3Adapter fee tier → ${network.name} (chainId=${chainId})`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Guardian:           ${prev.guardian}`);
  console.log(`Registry:           ${prev.commitmentRegistry}`);
  console.log(`Old adapter:        ${prev.dexAdapter}`);
  console.log(`Router (reused):    ${routerAddr}`);
  console.log(`New feeTier:        ${feeTier}`);

  if (deployer.address.toLowerCase() !== prev.guardian.toLowerCase()) {
    throw new Error(
      `Deployer (${deployer.address}) is not the registry guardian (${prev.guardian}). ` +
      `setDEXAdapter is onlyGuardian — switch signers or rotate guardian first.`,
    );
  }

  const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
  const adapter  = await AdapterF.deploy(routerAddr, feeTier);
  await adapter.waitForDeployment();
  const newAdapterAddr = await adapter.getAddress();
  console.log(`Deployed UniswapV3Adapter @ ${newAdapterAddr}`);

  const registry = await ethers.getContractAt("CommitmentRegistry", prev.commitmentRegistry);
  console.log(`registry.setDEXAdapter(${newAdapterAddr})`);
  await (await registry.setDEXAdapter(newAdapterAddr)).wait();
  console.log(`  ✓`);

  // Preserve the old adapter address under a versioned key so we can revert if
  // the new tier also turns out to be problematic (less likely, but cheap to
  // keep around).
  const next = {
    ...prev,
    dexAdapter:         newAdapterAddr,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(`\nUpdated ${path.relative(process.cwd(), file)}.`);
  console.log(`Previous adapter preserved as previousDexAdapter for rollback.`);
}

main().catch(err => { console.error(err); process.exit(1); });
