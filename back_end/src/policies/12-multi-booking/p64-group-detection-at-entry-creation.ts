import { GroupBillingMode } from "@prisma/client";

/**
 * Policy 64 — Group detection at entry creation (SIG-S1 §6.2 `EntryService.create`).
 *
 * When guest count meets the configured threshold, classify the entry for group billing.
 */
export function resolveGroupBillingModeFromGuestCount(input: {
  guestCount: number | null | undefined;
  threshold: number;
}): GroupBillingMode | undefined {
  const n = input.guestCount;
  if (n == null || !Number.isFinite(n)) return undefined;
  if (n < input.threshold) return undefined;
  return GroupBillingMode.GROUP_MASTER;
}
