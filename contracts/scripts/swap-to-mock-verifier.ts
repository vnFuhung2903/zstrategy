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
  dexAdapter:         string;
  deployedAt:         string;
  [k: string]: unknown;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found at ${file}. Run scripts/deploy.ts first.`);
  }
  const prev = JSON.parse(fs.readFileSync(file, "utf-8")) as Deployment;
  if (prev.chainId !== chainId) {
    throw new Error(`Network mismatch: artifact chainId=${prev.chainId}, connected chainId=${chainId}`);
  }

  console.log(`\nzstrategy: swap to MockVerifier → ${network.name} (chainId=${chainId})`);
  console.log(`Deployer:        ${deployer.address}`);
  console.log(`Guardian:        ${prev.guardian}`);
  console.log(`Registry:        ${prev.commitmentRegistry}`);

  if (deployer.address.toLowerCase() !== prev.guardian.toLowerCase()) {
    throw new Error(
      `Deployer (${deployer.address}) is not the registry guardian (${prev.guardian}). ` +
      `setVerifier is onlyGuardian — switch signers or rotate guardian first.`,
    );
  }

  const MockF = await ethers.getContractFactory("MockVerifier");
  const mock = await MockF.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log(`Deployed MockVerifier @ ${mockAddr}`);

  const registry = await ethers.getContractAt("CommitmentRegistry", prev.commitmentRegistry);

  const skipOrderFill = process.env.SKIP_ORDER_FILL === "1";
  const skipDca       = process.env.SKIP_DCA === "1";
  if (skipOrderFill && skipDca) {
    throw new Error("Both SKIP_ORDER_FILL and SKIP_DCA are set — nothing to do.");
  }

  if (!skipOrderFill) {
    console.log("registry.setVerifier(0, mock)  // ORDER_FILL");
    await (await registry.setVerifier(0, mockAddr)).wait();
    console.log("  ✓");
  } else {
    console.log("Skipping ORDER_FILL (SKIP_ORDER_FILL=1)");
  }

  if (!skipDca) {
    console.log("registry.setVerifier(1, mock)  // DCA");
    await (await registry.setVerifier(1, mockAddr)).wait();
    console.log("  ✓");
  } else {
    console.log("Skipping DCA (SKIP_DCA=1)");
  }

  const next = {
    ...prev,
    mockVerifier:    mockAddr,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(`\nUpdated ${path.relative(process.cwd(), file)} (added mockVerifier; real verifier addresses preserved).`);
  console.log(`\nDemo mode active. To revert when bb upstream is fixed:`);
  console.log(`  registry.setVerifier(0, ${prev.orderFillVerifier})`);
  console.log(`  registry.setVerifier(1, ${prev.dcaVerifier})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
