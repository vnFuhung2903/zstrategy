import { concat, hexToBytes, keccak256, toBytes, type Hex } from "viem";

export interface DcaScheduleWindow {
  scheduledLo: number;
  scheduledHi: number;
  expiry: number;
}

const DCA_GROUP_LOCK_DOMAIN = "zstrategy:dca-group-lock:v1";

export function deriveDcaGroupLockId(dcaGroupId: Hex, salt: Hex): Hex {
  return keccak256(concat([
    toBytes(DCA_GROUP_LOCK_DOMAIN),
    hexToBytes(dcaGroupId),
    hexToBytes(salt),
  ]));
}

export function buildDcaSchedule(
  roundCount: number,
  intervalSeconds: number,
  now: number,
  jitterFraction = 0.15,
): DcaScheduleWindow[] {
  return Array.from({ length: roundCount }, (_, i) => {
    const center = now + (i + 1) * intervalSeconds;
    const jitter = Math.floor(jitterFraction * intervalSeconds);
    const scheduledLo = center - jitter;
    const scheduledHi = center + jitter;
    const expiry = scheduledHi + intervalSeconds;
    return { scheduledLo, scheduledHi, expiry };
  });
}

export function assertNonOverlappingDcaWindows(windows: DcaScheduleWindow[]): void {
  const sorted = windows
    .map((window, index) => ({ ...window, index }))
    .sort((a, b) => a.scheduledLo - b.scheduledLo || a.scheduledHi - b.scheduledHi);

  for (const window of sorted) {
    if (window.scheduledLo > window.scheduledHi) {
      throw new Error(`DCA round ${window.index + 1} has an invalid execution window.`);
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    if (current.scheduledLo <= prev.scheduledHi) {
      throw new Error(`DCA rounds ${prev.index + 1} and ${current.index + 1} have overlapping execution windows.`);
    }
  }
}
