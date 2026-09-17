import { Users } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  /** `Entry.groupBillingMode` — the Policy 64 classification. Only renders when GROUP_MASTER. */
  groupBillingMode?: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null | undefined;
  /** Compact variant for dense rows (e.g. entry list table). */
  compact?: boolean;
  className?: string;
};

/**
 * Visible marker that an entry was auto-classified as a group booking at S1 (Policy 64,
 * driven by `registry.groupDetection.guestCountThreshold` + the include-flags for age
 * bands). Renders nothing for individual bookings so the badge is only noise-when-relevant.
 *
 * Placed on the entry list, entry detail header, and folio detail card so the operator sees
 * "this is a group" at every touchpoint. Does not itself change behavior — the S3 billing
 * model picker and the folio detail views pick up the same flag independently.
 */
export function GroupBadge({ groupBillingMode, compact, className }: Props) {
  if (groupBillingMode !== "GROUP_MASTER") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-semibold",
        "border-indigo-500/40 bg-indigo-500/10 text-indigo-800",
        "dark:border-indigo-400/40 dark:bg-indigo-400/10 dark:text-indigo-300",
        compact ? "px-1.5 py-0.5 text-[9px] uppercase tracking-wide" : "px-2 py-0.5 text-[11px] uppercase tracking-wide",
        className,
      )}
      title="Auto-classified as a group booking at S1 (Policy 64). Charges typically roll up to one folio and one payer."
    >
      <Users className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
      Group
    </span>
  );
}
