import { GroupBillingMode } from "@prisma/client";

/**
 * Policy 64 — Group detection at entry creation (SIG-S1 §6.2 `EntryService.create`).
 *
 * When the *effective* guest count meets the configured threshold, classify the entry for
 * group billing. "Effective" here reflects the hotel's operational meaning of "group": a
 * family of 2 adults + 8 toddlers is 10 bodies but not operationally a group. Which age
 * bands count toward the threshold is configurable via the include flags below — set on
 * the `registry.groupDetection.guestCountThreshold` policy row.
 *
 * Age bands come from the child-policy service — see child-policy-service.ts for how a
 * raw age becomes YOUNG_CHILD (0–5) / CHILD (6–10) / ADULT (11+).
 */
export function resolveGroupBillingModeFromGuestCount(input: {
  /** Legacy raw count — used when the granular breakdown is not available. */
  guestCount: number | null | undefined;
  /** Number of guests entered as adults (already pricing-adult by definition). */
  adultCount?: number;
  /** Number of guests in the CHILD band (6–10 with default policy). */
  childCount?: number;
  /** Number of guests in the YOUNG_CHILD band (0–5 with default policy). */
  youngChildCount?: number;
  threshold: number;
  /** Default true — adults always count toward the threshold. */
  includeAdults?: boolean;
  /** Default true — pricing-children (6–10) count toward the threshold. */
  includeChildren?: boolean;
  /** Default false — young children (0–5) do NOT count toward the threshold. */
  includeYoungChildren?: boolean;
}): GroupBillingMode | undefined {
  const includeAdults = input.includeAdults !== false;
  const includeChildren = input.includeChildren !== false;
  const includeYoungChildren = input.includeYoungChildren === true;

  // If any breakdown is present, sum only the enabled bands. Otherwise fall back to the
  // legacy raw guestCount (old inquiries pre-Phase-D-child-policy don't have a breakdown).
  const hasBreakdown =
    input.adultCount !== undefined ||
    input.childCount !== undefined ||
    input.youngChildCount !== undefined;

  let effective: number;
  if (hasBreakdown) {
    effective =
      (includeAdults ? input.adultCount ?? 0 : 0) +
      (includeChildren ? input.childCount ?? 0 : 0) +
      (includeYoungChildren ? input.youngChildCount ?? 0 : 0);
  } else {
    const n = input.guestCount;
    if (n == null || !Number.isFinite(n)) return undefined;
    effective = n;
  }

  if (effective < input.threshold) return undefined;
  return GroupBillingMode.GROUP_MASTER;
}
