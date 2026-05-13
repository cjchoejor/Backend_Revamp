/**
 * Policy 18 — Guest Data Retention and Deletion Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Pure calculation: returns dueAt for retention action.
 */
export function computeGuestDataRetentionDueAt(input: { closedAt: Date; retentionPeriodDays: number }): Date {
  const days = Number(input.retentionPeriodDays);
  if (!Number.isFinite(days) || days <= 0) return new Date(input.closedAt.getTime() + 365 * 86400_000);
  return new Date(input.closedAt.getTime() + days * 86400_000);
}

