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

  const next = {
    ...prev,
    dexAdapter:         newAdapterAddr,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(`\nUpdated ${path.relative(process.cwd(), file)}.`);
  console.log(`Previous adapter preserved as previousDexAdapter for rollback.`);
}

main().catch(err => { console.error(err); process.exit(1); });
