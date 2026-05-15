import { cn } from "@/lib/utils";

// Matches the backend `domain.ExecutionStatus` enum (registered / executed /
// cancelled / expired). The UI label for "registered" is "Pending" since
// that's the conventional user-facing term for "on-chain but not filled".
type Status = "registered" | "executed" | "cancelled" | "expired";

const statusConfig: Record<Status, { label: string; dotClass: string }> = {
  registered: { label: "Pending",   dotClass: "bg-primary-container" },
  executed:   { label: "Executed",  dotClass: "bg-primary-container" },
  cancelled:  { label: "Cancelled", dotClass: "bg-on-surface-variant" },
  expired:    { label: "Expired",   dotClass: "bg-error" },
};

interface StatusChipProps {
  status: Status;
  className?: string;
}

function StatusChip({ status, className }: StatusChipProps) {
  const config = statusConfig[status] ?? { label: status, dotClass: "bg-on-surface-variant" };
  const { label, dotClass } = config;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm",
        "bg-surface-container-highest text-xs font-medium text-on-surface-variant uppercase tracking-widest",
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dotClass)} />
      {label}
    </span>
  );
}

export { StatusChip, type Status };
