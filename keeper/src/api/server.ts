import express, { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { config } from "../config";
import { state } from "../keeper";
import { insertShares, deleteSharesForCommitment } from "../store/shares";
import { publicKeyset } from "../threshold/keys";
import { reconstructUserSecret } from "../threshold/reconstruct";
import { fetchPairPrice } from "../chain/oracle";
import { submitExecution } from "../execution/submitter";
import { OrderKind, Direction } from "../types";

const app = express();
app.use(express.json({ limit: config.apiBodyLimit }));

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ── Auth middleware ─────────────────────────────────────────────────────────

function requireSecret(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  if (auth !== `Bearer ${config.apiSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── GET /api/health ─────────────────────────────────────────────────────────

app.get("/api/health", (_req: Request, res: Response) => {
  const now = Math.floor(Date.now() / 1000);
  res.json({
    status:        "ok",
    uptimeSeconds: now - state.startedAt,
    chainId:       config.chainId,
    blockNumber:   state.blockNumber,
    executedCount: state.executedCount,
    failedCount:   state.failedCount,
  });
});

// ── GET /api/keepers ────────────────────────────────────────────────────────
//
// Public so the frontend can fetch the keypair set pre-wallet. A simple
// per-source-IP token bucket prevents trivial enumeration / DoS — legitimate
// clients call this once per strategy registration.

const keepersBuckets = new Map<string, { tokens: number; updated: number }>();
const KEEPERS_RATE_PER_MIN = 30; // ~1 every 2s, plenty for legitimate use
const BUCKET_TTL_MS = 60 * 60 * 1000;       // forget IPs idle for 1h
const BUCKET_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // sweep every 10min

function keepersRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim()
    || req.socket.remoteAddress
    || "unknown";
  const now = Date.now();
  let b = keepersBuckets.get(ip);
  if (!b) {
    b = { tokens: KEEPERS_RATE_PER_MIN, updated: now };
    keepersBuckets.set(ip, b);
  }
  // Refill at a steady rate of KEEPERS_RATE_PER_MIN per minute.
  const elapsedMs = now - b.updated;
  b.tokens = Math.min(KEEPERS_RATE_PER_MIN, b.tokens + (elapsedMs * KEEPERS_RATE_PER_MIN) / 60_000);
  b.updated = now;
  if (b.tokens < 1) {
    res.status(429).json({ error: "rate limit" });
    return;
  }
  b.tokens -= 1;
  next();
}

// Periodic sweep so the bucket map doesn't grow unbounded with unique IPs over
// a long-running keeper. unref() so the timer doesn't keep the process alive.
setInterval(() => {
  const cutoff = Date.now() - BUCKET_TTL_MS;
  for (const [ip, b] of keepersBuckets) {
    if (b.updated < cutoff) keepersBuckets.delete(ip);
  }
}, BUCKET_SWEEP_INTERVAL_MS).unref();

app.get("/api/keepers", keepersRateLimit, (_req: Request, res: Response) => {
  res.json({
    threshold: config.thresholdK,
    total:     config.thresholdN,
    keepers:   publicKeyset(),
  });
});

// ── POST /api/shares ────────────────────────────────────────────────────────
//
// Go backend forwards encrypted shares here after receiving them from the
// frontend via POST /api/v1/strategies (single hash) or /api/v1/dca-strategies
// (N round hashes share one set of shares). This keeper filters for its own
// keeperId and stores one row per (commitmentHash, keeperId) pair.

app.post("/api/shares", requireSecret, (req: Request, res: Response) => {
  const { commitmentHashes, encryptedShares } = req.body;

  if (!Array.isArray(commitmentHashes) || commitmentHashes.length === 0) {
    res.status(400).json({ error: "commitmentHashes must be a non-empty array" });
    return;
  }
  for (const h of commitmentHashes) {
    if (typeof h !== "string" || !ethers.isHexString(h, 32)) {
      res.status(400).json({ error: `Invalid commitmentHash: ${h}` });
      return;
    }
  }
  if (!Array.isArray(encryptedShares) || encryptedShares.length === 0) {
    res.status(400).json({ error: "encryptedShares must be a non-empty array" });
    return;
  }

  const myIds = new Set(publicKeyset().map(k => k.id));
  const myShares = (encryptedShares as { keeperId: string; ciphertext: string }[])
    .filter(s => myIds.has(s.keeperId));

  if (myShares.length === 0) {
    // No shares for this keeper — not an error, just nothing to store.
    res.status(201).json({ status: "ok", stored: 0 });
    return;
  }

  insertShares(commitmentHashes, myShares);
  const totalRows = commitmentHashes.length * myShares.length;
  console.log(`[API] Stored ${totalRows} share row(s) across ${commitmentHashes.length} commitment(s)`);
  res.status(201).json({ status: "ok", stored: totalRows });
});

// ── DELETE /api/shares/:commitmentHash ──────────────────────────────────────
//
// Called by the Go backend's chain indexer on terminal events (executed,
// cancelled, expired). Removes the encrypted share rows for a commitment so
// the keeper's SQLite store does not grow unbounded. The shares are useless
// after the commitment is finalized — the on-chain nullifier prevents replay.

app.delete("/api/shares/:commitmentHash", requireSecret, (req: Request, res: Response) => {
  const { commitmentHash } = req.params;
  if (!commitmentHash || !ethers.isHexString(commitmentHash, 32)) {
    res.status(400).json({ error: "Invalid commitmentHash" });
    return;
  }
  const removed = deleteSharesForCommitment(commitmentHash);
  if (removed > 0) {
    console.log(`[API] Pruned ${removed} share row(s) for ${commitmentHash.slice(0, 10)}...`);
  }
  res.status(200).json({ status: "ok", removed });
});

// ── POST /api/execute ───────────────────────────────────────────────────────
//
// Go backend triggers execution when fill condition is met. Keeper re-verifies
// the condition independently, reconstructs user_secret, generates ZK proof,
// and submits the on-chain tx asynchronously.

app.post("/api/execute", requireSecret, async (req: Request, res: Response) => {
  const {
    commitmentHash,
    kind,
    tokenIn,
    tokenOut,
    size,
    minOut,
    expiry,
    limitPrice,
    direction,
    nonce,
    nullifier,
    scheduledLo,
    scheduledHi,
  } = req.body;

  // ── Basic validation ──────────────────────────────────────────────────────
  if (!commitmentHash || !ethers.isHexString(commitmentHash, 32)) {
    res.status(400).json({ error: "Invalid commitmentHash" });
    return;
  }
  if (!tokenIn || !ethers.isAddress(tokenIn)) {
    res.status(400).json({ error: "Invalid tokenIn" });
    return;
  }
  if (!tokenOut || !ethers.isAddress(tokenOut)) {
    res.status(400).json({ error: "Invalid tokenOut" });
    return;
  }
  if (!size || !minOut || !nonce || !nullifier) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  // ── Re-verify fill condition independently ────────────────────────────────
  if (kind === "DCA") {
    const now = Math.floor(Date.now() / 1000);
    if (typeof scheduledLo !== "number" || typeof scheduledHi !== "number") {
      res.status(400).json({ error: "scheduledLo and scheduledHi required for DCA" });
      return;
    }
    if (now < scheduledLo || now > scheduledHi) {
      res.status(422).json({ error: "Fill condition not met (re-verify)" });
      return;
    }
  } else {
    // ORDER_FILL: fetch live oracle price. Re-verification is part of the B1
    // security model — if we can't independently confirm the condition we MUST
    // refuse to reconstruct the secret, even if the Go backend already
    // approved. The Go backend will retry on its next 30s tick.
    try {
      const pairPrice = await fetchPairPrice(tokenIn, tokenOut);
      const lp  = BigInt(limitPrice ?? "0");
      const dir = direction === 1 ? "SELL" : "BUY";
      const condMet = dir === "SELL" ? pairPrice >= lp : pairPrice <= lp;
      if (!condMet) {
        res.status(422).json({ error: "Fill condition not met (re-verify)" });
        return;
      }
    } catch (err) {
      console.warn(`[API] oracle check failed for ${commitmentHash.slice(0, 10)}...: ${err}`);
      res.status(503).json({ error: "Oracle re-verification unavailable; refusing execution" });
      return;
    }
  }

  // ── Reconstruct user_secret ───────────────────────────────────────────────
  let userSecret: string;
  try {
    userSecret = await reconstructUserSecret(commitmentHash);
  } catch (err) {
    console.error(`[API] reconstruct failed for ${commitmentHash.slice(0, 10)}...: ${err}`);
    res.status(500).json({ error: `Reconstruction failed: ${err}` });
    return;
  }

  // Respond 202 immediately so Go backend's HTTP timeout doesn't fire during
  // the ~30s ZK proof generation.
  res.status(202).json({ status: "executing", commitmentHash });

  // ── Fire-and-forget execution ─────────────────────────────────────────────
  const orderKind: OrderKind = kind === "DCA" ? "DCA" : "ORDER_FILL";
  const dir: Direction = direction === 1 ? "SELL" : "BUY";

  submitExecution({
    commitmentHash,
    kind:       orderKind,
    tokenIn:    ethers.getAddress(tokenIn),
    tokenOut:   ethers.getAddress(tokenOut),
    size:       BigInt(size),
    minOut:     BigInt(minOut),
    expiry:     Number(expiry),
    limitPrice: BigInt(limitPrice ?? "0"),
    direction:  dir,
    nonce,
    nullifier,
    scheduledLo: typeof scheduledLo === "number" ? scheduledLo : undefined,
    scheduledHi: typeof scheduledHi === "number" ? scheduledHi : undefined,
    userSecret,
  })
    .then(() => { state.executedCount++; })
    .catch(err => {
      state.failedCount++;
      console.error(`[API] execute failed for ${commitmentHash.slice(0, 10)}...: ${err}`);
    });
});

// ── GET /api/executions ─────────────────────────────────────────────────────

app.get("/api/executions", (_req: Request, res: Response) => {
  res.json({
    executed: state.executedCount,
    failed:   state.failedCount,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

export function startApiServer(): void {
  app.listen(config.apiPort, () => {
    console.log(`[API] Keeper REST API listening on port ${config.apiPort}`);
  });
}
