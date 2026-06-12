"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, useSignMessage, useChainId } from "wagmi";
import { parseUnits } from "viem";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { TokenPairSelect } from "@/components/ui/TokenPairSelect";
import { Lock, Info, Loader2, AlertCircle, Repeat2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_PAIR, type TradingPair } from "@/lib/tradingPairs";
import { useFreeBalance, formatUnits as fmtUnits } from "@/hooks/useVault";
import { useRegisterCommitmentBatch } from "@/hooks/useRegistry";
import { dcaCommitmentHash, dcaNullifierHash, type DcaPreimageFields } from "@/lib/dcaCommitment";
import { assertNonOverlappingDcaWindows, buildDcaSchedule, deriveDcaGroupLockId } from "@/lib/dcaSchedule";
import {
  deriveIntentId,
  deriveUserSecret,
  randomBytes32,
  intentIdSigningMessage,
} from "@/lib/commitment";
import { saveDcaRounds, type DcaRoundRecord } from "@/lib/intentStore";
import { backendApi, type PostDcaIntentBody } from "@/lib/backendApi";
import {
  createEncryptedWitnessPackage,
  getVerifiedEnclaveAttestation,
  type EncryptedWitnessPackage,
  type PublicIntentMetadata,
} from "@/lib/enclaveWitness";
import { ADDRESSES } from "@/lib/contracts";
import { arbitrumSepolia } from "wagmi/chains";

// BUY:  spend quoteToken each round → accumulate baseToken  (classic DCA)
// SELL: spend baseToken each round  → accumulate quoteToken (reverse DCA / de-risking)
type Side = "BUY" | "SELL";

const INTERVALS: Record<string, number> = {
  "3 MIN": 3 * 60,
  "6H":  6 * 3600,
  "24H": 86400,
  "7D":  7 * 86400,
};

const JITTER  = 0.15; // ±15% of interval
const DCA_KIND = 1;   // CommitmentKind.DCA

export default function DcaPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [pair,        setPair]        = useState<TradingPair>(DEFAULT_PAIR);
  const [side,        setSide]        = useState<Side>("BUY");
  const [sizeInput,   setSizeInput]   = useState("");
  const [roundCountInput, setRoundCountInput] = useState("2");
  const [intervalKey, setIntervalKey] = useState<keyof typeof INTERVALS>("24H");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingPost, setPendingPost] = useState<PostDcaIntentBody | null>(null);
  const [postSynced,  setPostSynced]  = useState(false);
  const [backendSyncRetry, setBackendSyncRetry] = useState(0);
  const [backendSyncError, setBackendSyncError] = useState<string | null>(null);

  const tokenIn  = side === "BUY" ? pair.quoteToken : pair.baseToken;
  const tokenOut = side === "BUY" ? pair.baseToken  : pair.quoteToken;

  const sharedNonceRef = useRef<`0x${string}` | null>(null);
  const backendSyncHashRef = useRef<string | null>(null);
  useEffect(() => { sharedNonceRef.current = randomBytes32(); }, []);

  function getSharedNonce(): `0x${string}` {
    if (!sharedNonceRef.current) sharedNonceRef.current = randomBytes32();
    return sharedNonceRef.current;
  }

  // Reset minOut when pair or side changes — output token and decimals differ.
  // useEffect(() => { setMinOutInput(""); }, [pair, side]);

  const { data: tokenInBalance } = useFreeBalance(tokenIn.address);
  const { registerBatch, isPending, isConfirming, isSuccess, error } = useRegisterCommitmentBatch();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  // DCA fires `roundCount` distinct executions over the schedule.
  const parsedRoundCount = Number.parseInt(roundCountInput, 10);
  const roundCount = Number.isInteger(parsedRoundCount) ? parsedRoundCount : 0;
  const roundCountValid = roundCount >= 2 && roundCount <= 10;

  const interval   = INTERVALS[intervalKey];
  const sizeBig    = useMemo(() => { try { return parseUnits(sizeInput || "0", tokenIn.decimals); } catch { return BigInt(0); } }, [sizeInput, tokenIn.decimals]);
  const totalSpend = useMemo(() => sizeBig * BigInt(roundCount), [sizeBig, roundCount]);

  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setNow(Math.floor(Date.now() / 1000));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const schedule = useMemo(
    () => now === null || !roundCountValid ? [] : buildDcaSchedule(roundCount, interval, now, JITTER),
    [roundCount, roundCountValid, interval, now],
  );
  const scheduleError = useMemo(() => {
    try {
      assertNonOverlappingDcaWindows(schedule);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [schedule]);

  async function handleSubmit() {
    if (!isConnected || !address || sizeBig === BigInt(0) || !roundCountValid || scheduleError) return;
    setSubmitError(null);
    setBackendSyncError(null);

    try {
      const sharedNonce = getSharedNonce();
      const intentId    = deriveIntentId(address, sharedNonce);

      const signature  = await signMessageAsync({ message: intentIdSigningMessage(intentId) });
      const userSecret = deriveUserSecret(signature);

      const currentNow = Math.floor(Date.now() / 1000);
      const sched      = buildDcaSchedule(roundCount, interval, currentNow, JITTER);
      assertNonOverlappingDcaWindows(sched);
      const roundNonces = Array.from({ length: roundCount }, () => randomBytes32());

      const hashes: `0x${string}`[]     = [];
      const nullifiers: `0x${string}`[] = [];

      for (let i = 0; i < roundCount; i++) {
        const fields: DcaPreimageFields = {
          tokenIn:     tokenIn.address,
          tokenOut:    tokenOut.address,
          size:        sizeBig,
          minOut:      0n,
          scheduledLo: BigInt(sched[i].scheduledLo),
          scheduledHi: BigInt(sched[i].scheduledHi),
          expiry:      BigInt(sched[i].expiry),
          nonce:       roundNonces[i],
          userSecret,
        };
        hashes.push(dcaCommitmentHash(fields));
        nullifiers.push(dcaNullifierHash(userSecret, roundNonces[i]));
      }

      const dcaGroupLockId = deriveDcaGroupLockId(intentId, randomBytes32());

      const records: DcaRoundRecord[] = hashes.map((commitmentHash, i) => ({
        commitmentHash,
        owner:       address.toLowerCase() as `0x${string}`,
        intentId,
        nonce:       roundNonces[i],
        nullifier:   nullifiers[i],
        tokenIn:     tokenIn.address,
        tokenOut:    tokenOut.address,
        size:        sizeBig.toString(),
        minOut:      "0",
        expiry:      sched[i].expiry,
        scheduledLo: sched[i].scheduledLo,
        scheduledHi: sched[i].scheduledHi,
        roundIndex:  i,
        createdAt:   currentNow,
      }));

      const registryAddr =
        ADDRESSES[chainId as keyof typeof ADDRESSES]?.commitmentRegistry
        ?? ADDRESSES[arbitrumSepolia.id].commitmentRegistry;
      const attestation = await getVerifiedEnclaveAttestation();
      const witnessPackages: EncryptedWitnessPackage[] = await Promise.all(records.map((record): Promise<EncryptedWitnessPackage> => {
        const metadata: PublicIntentMetadata = {
          version: 1,
          chainId,
          registry: registryAddr,
          commitmentHash: record.commitmentHash,
          kind: "DCA",
          dcaGroupLockId,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          size: record.size,
          minOut: record.minOut,
          expiry: record.expiry,
        };
        return createEncryptedWitnessPackage(metadata, {
          kind: "DCA",
          scheduledLo: record.scheduledLo,
          scheduledHi: record.scheduledHi,
          nonce: record.nonce,
          userSecret,
          nullifier: record.nullifier,
          dcaGroupId: intentId,
          roundIndex: record.roundIndex,
        }, attestation);
      }));

      await saveDcaRounds(records);

      setPostSynced(false);
      setBackendSyncRetry(0);
      backendSyncHashRef.current = null;
      setPendingPost({
        chainId,
        dcaGroupLockId,
        tokenIn:  tokenIn.address,
        tokenOut: tokenOut.address,
        rounds: records.map((r, i) => ({
          commitmentHash: r.commitmentHash,
          size:           r.size,
          minOut:        "0",
          expiry:         r.expiry,
          roundIndex:     r.roundIndex,
          witnessPackage: witnessPackages[i],
        })),
      });

      registerBatch(
        hashes,
        tokenIn.address,
        tokenOut.address,
        Array(roundCount).fill(sizeBig) as bigint[],
        Array(roundCount).fill(0n) as bigint[],
        sched.map(s => BigInt(s.expiry)),
        DCA_KIND,
      );
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  }

  function retryBackendSync() {
    if (!pendingPost || postSynced) return;
    setSubmitError(null);
    setBackendSyncError(null);
    setBackendSyncRetry(n => n + 1);
  }

  useEffect(() => {
    if (!isSuccess || !pendingPost || postSynced) return;
    if (backendSyncHashRef.current === pendingPost.dcaGroupLockId) return;
    backendSyncHashRef.current = pendingPost.dcaGroupLockId;

    let cancelled = false;
    backendApi.postDcaIntent(pendingPost)
      .then(() => {
        if (!cancelled) {
          setPostSynced(true);
          setBackendSyncError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          backendSyncHashRef.current = null;
          setBackendSyncError(msg);
          setSubmitError(msg);
          console.warn("[dca] backend post failed (retry later):", err);
        }
      });
    return () => { cancelled = true; };
  }, [isSuccess, pendingPost, postSynced, backendSyncRetry]);

  const busy = isPending || isConfirming || isSigning;
  const errorMessage = submitError ?? scheduleError ?? (error ? (error as Error).message : null);

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  function setMaxSpend() {
    if (tokenInBalance !== undefined) {
      setSizeInput(fmtUnits(tokenInBalance, tokenIn.decimals));
    }
  }

  return (
    <>
      <Topbar title="DCA Pulse" />
      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 max-w-7xl">

          {/* Left — config */}
          <div className="lg:col-span-5">
            <Card className="p-4 md:p-5 space-y-4 md:space-y-5">
              <p className="text-xs font-medium text-primary-container uppercase tracking-widest">DCA Parameters</p>

              {/* Pair selector */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Asset Pair</p>
                <TokenPairSelect value={pair} onChange={p => { setPair(p); setSide("BUY"); }} />
              </div>

              {/* Side */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Direction</p>
                <div className="flex gap-1.5">
                  {(["BUY", "SELL"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setSide(s)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        side === s
                          ? s === "BUY"
                            ? "border-primary-container text-primary-container bg-primary-container/10"
                            : "border-secondary text-secondary bg-secondary/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >
                      {s === "BUY" ? `Buy ${pair.baseToken.name}` : `Sell ${pair.baseToken.name}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Spend per round */}
              <div>
                <div className="flex justify-between gap-2 mb-1.5">
                  <label className="text-xs text-on-surface-variant uppercase tracking-widest min-w-0">
                    Spend per Round ({tokenIn.name})
                  </label>
                  <span className="text-xs text-on-surface-variant shrink-0">
                    Vault:{" "}
                    <span className="text-on-surface font-medium">
                      {tokenInBalance !== undefined ? parseFloat(fmtUnits(tokenInBalance, tokenIn.decimals)).toFixed(2) : "—"} {tokenIn.name}
                    </span>
                  </span>
                </div>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={sizeInput}
                  onChange={e => setSizeInput(e.target.value)}
                  className="text-xl font-display font-semibold"
                  actionLabel="MAX"
                  actionDisabled={tokenInBalance === undefined || tokenInBalance === 0n}
                  onAction={setMaxSpend}
                />
              </div>

              {/* Rounds */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Number of Rounds (max 10)</p>
                <Input
                  type="text"
                  inputMode="decimal"
                  value={roundCountInput}
                  onChange={e => setRoundCountInput(e.target.value)}
                  className="text-xl font-display font-semibold"
                  error={!roundCountValid ? "Round count must be between 2 and 10." : undefined}
                />
              </div>

              {/* Interval */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Interval</p>
                <div className="flex gap-1.5">
                  {Object.keys(INTERVALS).map(k => (
                    <button key={k} onClick={() => setIntervalKey(k)}
                      className={cn(
                        "flex-1 py-1.5 text-xs font-medium rounded-sm border transition-all",
                        intervalKey === k
                          ? "border-primary-container text-primary-container bg-primary-container/10"
                          : "border-outline-variant/20 text-on-surface-variant hover:border-outline-variant/50",
                      )}
                    >{k}</button>
                  ))}
                </div>
              </div>

              {/* Summary */}
              <div className="bg-surface-container-lowest rounded-sm p-3 space-y-2 text-sm">
                {[
                  { label: "Total Spend",   value: `${parseFloat(fmtUnits(totalSpend, tokenIn.decimals)).toLocaleString("en-US", { maximumFractionDigits: tokenIn.decimals === 18 ? 6 : 2 })} ${tokenIn.name}` },
                  { label: "First Round",   value: schedule.length ? `${fmt(schedule[0].scheduledLo)} – ${fmt(schedule[0].scheduledHi)}` : "—" },
                  { label: "Last Round",    value: schedule.length ? `${fmt(schedule[schedule.length - 1].scheduledLo)} – ${fmt(schedule[schedule.length - 1].scheduledHi)}` : "—" },
                  { label: "Window Jitter", value: "±15% of interval" },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between gap-2">
                    <span className="text-on-surface-variant shrink-0">{label}</span>
                    <span className="text-on-surface font-tabular text-right text-xs min-w-0 break-words">{value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Right — ZK panel */}
          <div className="lg:col-span-7 space-y-4">
            <Card variant="trust-violet" className="p-4 md:p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-1">Private DCA</p>
                </div>
                <Badge variant="sovereign" dot className="shrink-0">DCA Circuit</Badge>
              </div>

              {errorMessage && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  <span>{errorMessage.slice(0, 160)}</span>
                  {backendSyncError && pendingPost && !postSynced && (
                    <button
                      type="button"
                      onClick={retryBackendSync}
                      className="ml-auto shrink-0 text-primary-container hover:underline"
                    >
                      Retry sync
                    </button>
                  )}
                </div>
              )}

              {/* Action — button stays in its ready state across submissions.
                  Success is announced via the global toast (Sonner) from the
                  useRegisterCommitmentBatch hook's useTxToast wiring. */}
              <div className="mt-4 md:mt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-secondary/10">
                    <Repeat2 size={16} className="text-secondary" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-on-surface">
                      {isConnected ? "Ready to schedule" : "Wallet not connected"}
                    </p>
                    <p className="text-xs text-on-surface-variant">UltraHonk · DCA (192-byte preimage)</p>
                  </div>
                </div>
                <Button
                  variant="sovereign"
                  size="md"
                  className="w-full sm:w-auto"
                  disabled={!isConnected || busy || sizeBig === BigInt(0) || !roundCountValid || scheduleError !== null}
                  onClick={handleSubmit}
                >
                  {busy
                    ? <><Loader2 size={14} className="animate-spin" />{isSigning ? "Signing…" : isConfirming ? "Confirming…" : "Submitting…"}</>
                    : <><Lock size={14} />Sign &amp; Schedule DCA</>
                  }
                </Button>
              </div>
            </Card>

            <div className="flex gap-3 px-4 py-3 rounded-sm border-l-2 border-primary-container bg-primary-container/5">
              <Info size={14} className="text-primary-container mt-0.5 shrink-0" />
              <p className="text-xs text-on-surface-variant leading-relaxed">
                Only 1 wallet signature covers all rounds. Executors only see execution tickets, your DCA schedule is never revealed on-chain.
              </p>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
