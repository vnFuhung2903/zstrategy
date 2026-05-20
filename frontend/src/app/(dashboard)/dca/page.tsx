"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useAccount, useSignMessage, useChainId } from "wagmi";
import { parseUnits } from "viem";
import { Topbar } from "@/components/layout/Topbar";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { TokenPairSelect } from "@/components/ui/TokenPairSelect";
import { Lock, Info, Loader2, AlertCircle, Repeat2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEFAULT_PAIR, type TradingPair } from "@/lib/tradingPairs";
import { useFreeBalance, formatUnits as fmtUnits } from "@/hooks/useVault";
import { useGasBalance, PER_EXECUTION_ETH_ESTIMATE } from "@/hooks/useGasVault";
import { useRegisterCommitmentBatch } from "@/hooks/useRegistry";
import { dcaCommitmentHash, dcaNullifierHash, type DcaPreimageFields } from "@/lib/dcaCommitment";
import {
  deriveStrategyId,
  deriveUserSecret,
  randomBytes32,
  strategyIdSigningMessage,
} from "@/lib/commitment";
import { saveDcaRounds, type DcaRoundRecord } from "@/lib/strategyStore";
import { splitAndEncryptSecret } from "@/lib/threshold";
import { keeperApi } from "@/lib/keeperApi";
import { backendApi, type PostDcaGroupBody } from "@/lib/backendApi";

// BUY:  spend quoteToken each round → accumulate baseToken  (classic DCA)
// SELL: spend baseToken each round  → accumulate quoteToken (reverse DCA / de-risking)
type Side = "BUY" | "SELL";

const INTERVALS: Record<string, number> = {
  "6H":  6 * 3600,
  "24H": 86400,
  "7D":  7 * 86400,
};

const JITTER  = 0.15; // ±15% of interval
const DCA_KIND = 1;   // CommitmentKind.DCA

function buildSchedule(roundCount: number, interval: number, now: number) {
  return Array.from({ length: roundCount }, (_, i) => {
    const center      = now + (i + 1) * interval;
    const jitter      = Math.floor(JITTER * interval);
    const scheduledLo = center - jitter;
    const scheduledHi = center + jitter;
    const expiry      = scheduledHi + interval;
    return { scheduledLo, scheduledHi, expiry };
  });
}

export default function DcaPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [pair,        setPair]        = useState<TradingPair>(DEFAULT_PAIR);
  const [side,        setSide]        = useState<Side>("BUY");
  const [sizeInput,   setSizeInput]   = useState("");
  const [roundCount,  setRoundCount]  = useState(5);
  const [intervalKey, setIntervalKey] = useState<keyof typeof INTERVALS>("24H");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingPost, setPendingPost] = useState<PostDcaGroupBody | null>(null);
  const [postSynced,  setPostSynced]  = useState(false);

  const tokenIn  = side === "BUY" ? pair.quoteToken : pair.baseToken;
  const tokenOut = side === "BUY" ? pair.baseToken  : pair.quoteToken;

  const sharedNonceRef = useRef<`0x${string}`>(randomBytes32());
  useEffect(() => { sharedNonceRef.current = randomBytes32(); }, []);

  // Reset minOut when pair or side changes — output token and decimals differ.
  // useEffect(() => { setMinOutInput(""); }, [pair, side]);

  const { data: tokenInBalance } = useFreeBalance(tokenIn.address);
  const { data: gasBalance }     = useGasBalance();
  const { registerBatch, isPending, isConfirming, isSuccess, error } = useRegisterCommitmentBatch();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();

  // DCA fires `roundCount` distinct executions over the schedule. Each one
  // debits one PER_EXECUTION_ETH_ESTIMATE from the gas tank; gate submission
  // until the user has at least that much prepaid. Treat the pre-query
  // "undefined" state as a shortfall so the button is disabled until the
  // balance read resolves (otherwise a fast clicker could submit early).
  const gasNeeded   = PER_EXECUTION_ETH_ESTIMATE * BigInt(roundCount);
  const gasShortfall =
    gasBalance === undefined || gasBalance < gasNeeded;

  const interval   = INTERVALS[intervalKey];
  const sizeBig    = useMemo(() => { try { return parseUnits(sizeInput || "0", tokenIn.decimals); } catch { return BigInt(0); } }, [sizeInput, tokenIn.decimals]);
  const totalSpend = useMemo(() => sizeBig * BigInt(roundCount), [sizeBig, roundCount]);

  const [now] = useState(() => Math.floor(Date.now() / 1000));
  const schedule = useMemo(() => buildSchedule(roundCount, interval, now), [roundCount, interval, now]);

  async function handleSubmit() {
    if (!isConnected || !address || sizeBig === BigInt(0)) return;
    setSubmitError(null);

    try {
      const sharedNonce = sharedNonceRef.current;
      const strategyId  = deriveStrategyId(address, sharedNonce);

      const { keepers } = await keeperApi.listKeepers();

      const signature  = await signMessageAsync({ message: strategyIdSigningMessage(strategyId) });
      const userSecret = deriveUserSecret(signature);

      const currentNow = Math.floor(Date.now() / 1000);
      const sched      = buildSchedule(roundCount, interval, currentNow);
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

      const encryptedShares = await splitAndEncryptSecret(userSecret, keepers);
      const dcaGroupId      = strategyId;

      const records: DcaRoundRecord[] = hashes.map((commitmentHash, i) => ({
        commitmentHash,
        dcaGroupId,
        owner:       address.toLowerCase() as `0x${string}`,
        strategyId,
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

      await saveDcaRounds(records);

      setPostSynced(false);
      setPendingPost({
        chainId,
        tokenIn:  tokenIn.address,
        tokenOut: tokenOut.address,
        encryptedShares,
        rounds: records.map(r => ({
          commitmentHash: r.commitmentHash,
          nonce:          r.nonce,
          nullifier:      r.nullifier,
          size:           r.size,
          minOut:        "0",
          scheduledLo:    r.scheduledLo,
          scheduledHi:    r.scheduledHi,
          expiry:         r.expiry,
          roundIndex:     r.roundIndex,
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

  useEffect(() => {
    if (!isSuccess || !pendingPost || postSynced) return;
    let cancelled = false;
    backendApi.postDcaGroup(pendingPost)
      .then(() => { if (!cancelled) setPostSynced(true); })
      .catch(err => { if (!cancelled) console.warn("[dca] backend post failed (retry later):", err); });
    return () => { cancelled = true; };
  }, [isSuccess, pendingPost, postSynced]);

  const busy = isPending || isConfirming || isSigning;
  const errorMessage = submitError ?? (error ? (error as Error).message : null);

  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <Topbar title="DCA Pulse" />
      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 max-w-7xl">

          {/* Left — config */}
          <div className="lg:col-span-4">
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
                <input
                  type="number" min="0" step="any" value={sizeInput}
                  onChange={e => setSizeInput(e.target.value)}
                  className="w-full bg-surface-container-lowest text-on-surface text-xl font-display font-semibold px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container transition-all"
                />
              </div>

              {/* Rounds */}
              <div>
                <p className="text-xs text-on-surface-variant uppercase tracking-widest mb-2">Number of Rounds (max 10)</p>
                <input
                  type="number" min="2" max="10" value={roundCount}
                  onChange={e => setRoundCount(Math.min(10, Math.max(2, parseInt(e.target.value) || 2)))}
                  className="w-full bg-surface-container-lowest text-on-surface text-xl font-display font-semibold px-3 py-2.5 rounded-sm border-b border-outline-variant/30 outline-none focus:border-primary-container transition-all"
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
                  { label: "Total Spend",   value: `${parseFloat(fmtUnits(totalSpend, tokenIn.decimals)).toLocaleString(undefined, { maximumFractionDigits: tokenIn.decimals === 18 ? 6 : 2 })} ${tokenIn.name}` },
                  { label: "First Round",   value: `${fmt(schedule[0].scheduledLo)} – ${fmt(schedule[0].scheduledHi)}` },
                  { label: "Last Round",    value: `${fmt(schedule[schedule.length - 1].scheduledLo)} – ${fmt(schedule[schedule.length - 1].scheduledHi)}` },
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
          <div className="lg:col-span-8 space-y-4">
            <Card variant="trust-violet" className="p-4 md:p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
                <div>
                  <p className="text-xs text-secondary uppercase tracking-widest mb-1">Private DCA</p>
                  <h2 className="font-display text-xl md:text-2xl font-semibold text-on-surface">ZK Proof Enclave</h2>
                  <p className="text-sm text-on-surface-variant mt-1">
                    Execution windows are private. Observers see only that a DCA round executed, not when it was scheduled.
                  </p>
                </div>
                <Badge variant="sovereign" dot className="shrink-0">DCA Circuit</Badge>
              </div>

              {errorMessage && (
                <div className="mt-3 flex items-center gap-2 text-xs text-error">
                  <AlertCircle size={13} />
                  {errorMessage.slice(0, 160)}
                </div>
              )}
              {gasShortfall && (
                <div className="mt-3 flex items-center gap-2 text-xs text-secondary">
                  <AlertCircle size={13} />
                  Gas tank too low for {roundCount} keeper fills — top up on the Vault page before submitting.
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
                  disabled={!isConnected || busy || sizeBig === BigInt(0) || gasShortfall}
                  onClick={handleSubmit}
                >
                  {busy
                    ? <><Loader2 size={14} className="animate-spin" />{isSigning ? "Signing…" : isConfirming ? "Confirming…" : "Submitting…"}</>
                    : gasShortfall
                      ? <><Lock size={14} />Top up gas tank</>
                      : <><Lock size={14} />Sign &amp; Schedule DCA</>
                  }
                </Button>
              </div>
            </Card>

            <div className="flex gap-3 px-4 py-3 rounded-sm border-l-2 border-primary-container bg-primary-container/5">
              <Info size={14} className="text-primary-container mt-0.5 shrink-0" />
              <p className="text-xs text-on-surface-variant leading-relaxed">
                One wallet signature covers all rounds. Each round gets a unique nonce and private execution window.
                The keeper cannot tell which window belongs to which round until it executes — your DCA schedule is never revealed on-chain.
              </p>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
