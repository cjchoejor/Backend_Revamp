/**
 * Frontend mirror of `back_end/src/services/domain/capacity-validation-service.ts`
 * `computeChargeableOccupants` + `computeAllowedRoomCounts` — used by the S1 intake form to
 * render the Number-of-Rooms dropdown with only valid values BEFORE hitting the backend.
 *
 * Chargeable occupants = adults + children whose age >= `unaccompaniedMinorMinAge - 0` band's
 * ADULT cut. Concretely: adults + children aged >= (childMaxAge + 1). Under the default child
 * policy (young 0-5, child 6-10, adult 11+) that's "adults + children aged 11+". A young
 * child (0-5) or child (6-10) does NOT count — they share bedding per the child policy.
 *
 * Room-count envelope: min = ceil(CO / maxCapacity), max = CO.
 */
import type { ChildPolicyBundle } from "@/lib/api/child-policy";

export function classifyAge(age: number, bundle: ChildPolicyBundle | null | undefined): "YOUNG_CHILD" | "CHILD" | "ADULT" {
  const youngMax = bundle?.ageBands?.youngChildMaxAge ?? 5;
  const childMax = bundle?.ageBands?.childMaxAge ?? 10;
  if (age > childMax) return "ADULT";
  if (age > youngMax) return "CHILD";
  return "YOUNG_CHILD";
}

export function computeChargeableOccupants(
  input: { adults: number; childAges: number[] },
  bundle: ChildPolicyBundle | null | undefined,
): number {
  let count = input.adults;
  for (const age of input.childAges) {
    if (classifyAge(age, bundle) === "ADULT") count++;
  }
  return count;
}

export function computeAllowedRoomCounts(chargeableOccupants: number, maxCapacity: number): { min: number; max: number } {
  if (chargeableOccupants <= 0) return { min: 0, max: 0 };
  const safeMax = maxCapacity > 0 ? maxCapacity : 1;
  return { min: Math.ceil(chargeableOccupants / safeMax), max: chargeableOccupants };
}
