import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * ACTIVE = green (in progress)
 * CLOSED / CANCELLED / EXPIRED = red (finished or stopped)
 * OPEN / PARKED = amber (not started yet or paused)
 */
export function statusBadgeClass(status?: string | null): string {
  const s = (status ?? "").toUpperCase();
  switch (s) {
    case "ACTIVE":
      return "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-400";
    case "CLOSED":
    case "CANCELLED":
    case "EXPIRED":
      return "border-transparent bg-red-500/15 text-red-800 dark:text-red-400";
    case "OPEN":
    case "PARKED":
      return "border-transparent bg-amber-500/15 text-amber-900 dark:text-amber-400";
    default:
      return "border-transparent bg-muted text-muted-foreground";
  }
}

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  const label = status?.trim() || "—";
  return (
    <Badge variant="outline" className={cn("font-medium", statusBadgeClass(status), className)}>
      {label}
    </Badge>
  );
}
