/**
 * Inquiry has no DB status column — derive from park state and linked entries.
 *
 * - OPEN (amber): inquiry exists but no Entry has been created yet — still at intake.
 * - ACTIVE (green): one or more entries exist and at least one is still in progress (ACTIVE/PARKED).
 * - CLOSED / CANCELLED (red): all linked entries are terminal.
 * - PARKED (amber): inquiry itself was parked (paused intake).
 */
export function deriveInquiryStatus(inquiry: {
  parkedAt?: string | null;
  entries?: { status?: string }[] | null;
}): string {
  if (inquiry.parkedAt) return "PARKED";

  const entries = inquiry.entries ?? [];
  if (entries.length === 0) return "OPEN";

  const statuses = entries.map((e) => (e.status ?? "").toUpperCase());
  if (statuses.every((s) => s === "CLOSED")) return "CLOSED";
  if (statuses.every((s) => s === "CANCELLED" || s === "EXPIRED")) return "CANCELLED";
  if (statuses.some((s) => s === "ACTIVE" || s === "PARKED")) return "ACTIVE";

  return statuses[0] || "OPEN";
}
