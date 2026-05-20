/**
 * Swap the on-chain verifier(s) to MockVerifier — for thesis-demo
 * bring-up only, while the upstream bb UltraKeccakZK Solidity-codegen bug is
 * open:
 *   https://forum.aztec.network/t/sumcheck-fail-in-ultrahonk/8112
 *
 * Symptom: bb.js's prover and bb.js's own verifier accept proofs, but the
 * `bb write_solidity`-emitted UltraKeccakZK verifier reverts them with
 * non-deterministic codes (ShpleminiFailed / SumcheckFailed / empty-data
 * revert from the EC precompile path). Confirmed at bb 5.0.0-nightly.20260324
 * paired with Noir 1.0.0-beta.20 — the Aztec-published pair.
 *
 * Workaround: replace the on-chain verifier with MockVerifier, which
 * returns true only when `tx.origin` is in its allowlist. The keeper's
 * `backend.verifyProof(...)` in zk/orderFill.ts and zk/dca.ts is the actual
 * integrity check; the keeper now throws (refusing to submit) if that returns
 * FAIL. The mock's allowlist substitutes for the cryptographic caller-binding
 * that the real verifier would provide, preventing griefers from collecting
 * the 1.2× keeper-gas premium by triggering victim strategies.
 *
 * SECURITY (demo mode): trustlessness is replaced by "trust the configured
 * keeper EOA(s) + trust the keeper's off-chain verifyProof check." Self-
 * execute via the frontend is disabled by this swap unless you also allowlist
 * the user EOA — leave it off for the demo, switch back to the real verifier
 * for any production rehearsal.
 *
 * Required env:
 *   KEEPER_ADDRESS    EOA(s) to allowlist as tx.origin for verify().
 *                     Comma-separated for multi-keeper setups. The keeper's
 *                     EOA is the one derived from KEEPER_PRIVATE_KEY in
 *                     keeper/.env — derive it via `cast wallet address` or
 *                     read the address from the keeper startup logs.
 *
 * Run with:
 *   KEEPER_ADDRESS=0x... npx hardhat run scripts/swap-to-mock-verifier.ts --network arbitrumSepolia
 *
 * Selectively skip a kind with:
 *   SKIP_ORDER_FILL=1   only swap DCA
 *   SKIP_DCA=1          only swap ORDER_FILL
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

  // One mock instance covers both kinds: verify() ignores its (bytes, bytes32[])
  // inputs and returns true iff tx.origin is in the allowlist.
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

  // Persist the mock address alongside the (untouched) real verifier addresses
  // so we can revert with one setVerifier call when bb upstream is fixed.
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
