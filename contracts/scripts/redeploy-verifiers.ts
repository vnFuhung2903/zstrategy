/**
 * Redeploy the bb-generated verifier contracts and rewire them on the existing
 * CommitmentRegistry — no other contracts touched.
 *
 * Use this when:
 *   - You ran `bb write_solidity` to regenerate OrderFillVerifier.sol /
 *     DCAVerifier.sol (e.g. because the prover-side bb.js was bumped and the
 *     on-chain VK no longer matches the new wire format).
 *   - You don't want to redeploy CommitmentRegistry, CollateralVault, GasVault,
 *     or the DEX adapter — preserving on-chain commitments / collateral / gas
 *     tank balances and avoiding any frontend address rotation.
 *
 * Run with:
 *   npx hardhat run scripts/redeploy-verifiers.ts --network arbitrumSepolia
 *
 * The deployer must be the registry guardian — `setVerifier` is gated by
 * `onlyGuardian`. If guardian ≠ deployer, set `GUARDIAN_ADDRESS` and ensure
 * that signer is unlocked by hardhat (impersonation on forked nets, etc.).
 *
 * Selectively skip with:
 *   SKIP_ORDER_FILL=1   only redeploy DCAVerifier
 *   SKIP_DCA=1          only redeploy OrderFillVerifier
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
  // Optional fields that may exist on older artifacts; preserved verbatim.
  [k: string]: unknown;
}

async function deployVerifier(
  label: "OrderFillVerifier" | "DCAVerifier",
): Promise<string> {
  // bb externalises ZKTranscriptLib per-file. Each verifier needs its own
  // library deployment + link — see deploy.ts and the OrderFillVerifier.sol
  // top-of-file comment for the same pattern.
  const fileName = label === "OrderFillVerifier" ? "OrderFillVerifier" : "DCAVerifier";
  const LibF = await ethers.getContractFactory(
    `contracts/core/${fileName}.sol:ZKTranscriptLib`
  );
  const lib = await LibF.deploy();
  await lib.waitForDeployment();
  const libAddr = await lib.getAddress();

  const VerifierF = await ethers.getContractFactory(label, {
    libraries: { ZKTranscriptLib: libAddr },
  });
  const c = await VerifierF.deploy();
  await c.waitForDeployment();
  return c.getAddress();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  // ── Load existing deployment artifact ─────────────────────────────────────
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at ${file}. ` +
      `Run scripts/deploy.ts first, or copy an existing artifact into deployments/`,
    );
  }
  const prev = JSON.parse(fs.readFileSync(file, "utf-8")) as Deployment;
  if (prev.chainId !== chainId) {
    throw new Error(
      `Network mismatch: artifact chainId=${prev.chainId}, connected chainId=${chainId}`,
    );
  }

  console.log(`\nzstrategy verifier-only redeploy → ${network.name} (chainId=${chainId})`);
  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Guardian:  ${prev.guardian}`);
  console.log(`Registry:  ${prev.commitmentRegistry}\n`);
  console.log(`Existing OrderFillVerifier: ${prev.orderFillVerifier}`);
  console.log(`Existing DCAVerifier:       ${prev.dcaVerifier}\n`);

  if (deployer.address.toLowerCase() !== prev.guardian.toLowerCase()) {
    // setVerifier is onlyGuardian; bail loudly rather than letting the tx revert
    // somewhere ambiguous after we've already burned gas on the verifier deploys.
    throw new Error(
      `Deployer (${deployer.address}) is not the registry guardian ` +
      `(${prev.guardian}). Either switch signers or rotate the guardian first.`,
    );
  }

  // ── Connect to the live registry ──────────────────────────────────────────
  const registry = await ethers.getContractAt("CommitmentRegistry", prev.commitmentRegistry);

  // ── Redeploy + rewire ─────────────────────────────────────────────────────
  const skipOrderFill = process.env.SKIP_ORDER_FILL === "1";
  const skipDca       = process.env.SKIP_DCA === "1";
  if (skipOrderFill && skipDca) {
    throw new Error("Both SKIP_ORDER_FILL and SKIP_DCA are set — nothing to do.");
  }

  let newOrderFill = prev.orderFillVerifier;
  if (!skipOrderFill) {
    console.log("Deploying new OrderFillVerifier...");
    newOrderFill = await deployVerifier("OrderFillVerifier");
    console.log(`  → ${newOrderFill}`);
    console.log("  registry.setVerifier(0, ...)");
    // CommitmentKind.ORDER_FILL == 0
    await (await registry.setVerifier(0, newOrderFill)).wait();
    console.log("  ✓\n");
  } else {
    console.log("Skipping OrderFillVerifier (SKIP_ORDER_FILL=1)\n");
  }

  let newDca = prev.dcaVerifier;
  if (!skipDca) {
    console.log("Deploying new DCAVerifier...");
    newDca = await deployVerifier("DCAVerifier");
    console.log(`  → ${newDca}`);
    console.log("  registry.setVerifier(1, ...)");
    // CommitmentKind.DCA == 1
    await (await registry.setVerifier(1, newDca)).wait();
    console.log("  ✓\n");
  } else {
    console.log("Skipping DCAVerifier (SKIP_DCA=1)\n");
  }

  // ── Persist updated artifact ──────────────────────────────────────────────
  const next: Deployment = {
    ...prev,
    orderFillVerifier: newOrderFill,
    dcaVerifier:       newDca,
    deployedAt:        new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  console.log(`Updated ${path.relative(process.cwd(), file)}`);
  console.log("\nNothing else changed — registry, vault, gas tank, DEX adapter, price feeds untouched.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
