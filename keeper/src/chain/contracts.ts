import { ethers } from "ethers";
import { signer } from "./provider";
import { config } from "../config";

// ── CommitmentRegistry — minimal write-only surface ─────────────────────────
//
// The trigger-based keeper only ever writes `executeCommitment`. It does NOT
// subscribe to chain events (that's the Go backend's chain indexer) and does
// NOT read commitment status or the paused flag from the contract (the Go
// backend pre-filters via the pending_strategies table). Keep the ABI surface
// minimal — adding read methods invites accidental coupling and divergence
// between the keeper and indexer views of chain state.

const REGISTRY_ABI = [
  "function executeCommitment(bytes32 commitmentHash, bytes32 nullifier, bytes calldata proof) external",
];

/** Signer-connected registry for submitting `executeCommitment` transactions. */
export const registryWriter = new ethers.Contract(
  config.registryAddress,
  REGISTRY_ABI,
  signer,
);
