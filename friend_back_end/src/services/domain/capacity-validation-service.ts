/**
 * Validates a proposed guest composition (adults + child ages) against a RoomType's per-type
 * capacity caps (standardCapacity / maxCapacity / maxChildren / requiredAccompanyingAdults /
 * maxExtraBeds) plus the global child-policy rules (unaccompanied minor age, adult-to-child
 * ratio). Also validates the requested `numberOfRooms` against the chargeable-occupants
 * envelope.
 *
 * Returns an array of issues rather than throwing — the caller (S1 createEntry / quotation
 * builder / admin tooling) decides whether each issue is a hard block or a soft warning that
 * the operator can override.
 */
import type { PrismaClient } from "@prisma/client";
import { loadChildPolicyBundle, classifyAge, type ChildPolicyBundle } from "./child-policy-service.js";

export type CapacityIssueCode =
  | "OVER_MAX_OCCUPANCY"
  | "OVER_MAX_CHILDREN"
  | "TOO_FEW_ADULTS"
  | "ADULT_CHILD_RATIO_EXCEEDED"
  | "UNACCOMPANIED_MINOR"
  | "CHILD_AGE_ABOVE_LEGAL_MINOR"
  | "NO_ROOM_TYPE"
  | "INVALID_NUMBER_OF_ROOMS";

export type CapacityIssue = {
  code: CapacityIssueCode;
  severity: "BLOCK" | "WARN";
  message: string;
  detail?: Record<string, unknown>;
};

export type CapacityValidationInput = {
  /** Optional — when given, per-type limits are enforced. Skip to validate composition only. */
  roomTypeId?: string | null;
  adults: number;
  childAges: number[];
  /**
   * Optional — number of rooms the guest is requesting. When set together with a roomTypeId,
   * validated against the ceil(chargeableOccupants / maxCapacity) .. chargeableOccupants
   * envelope. When set alone (no roomTypeId), a fallback maxCapacity (`fallbackMaxCapacity`)
   * is used — the S1 form typically passes the largest maxCapacity across all room types the
   * hotel offers.
   */
  numberOfRooms?: number | null;
  /** Fallback maxCapacity for number-of-rooms validation when no roomTypeId is provided. */
  fallbackMaxCapacity?: number;
};

/**
 * Chargeable occupants — the count that drives bed / room requirements.
 * Adults + children aged >= minAdultAge (typically 11+ per the policy's ADULT band). This
 * matches the user's operational rule: "a child 11+ takes a bed like an adult".
 *
 * Note this is NOT the same as legal responsibility (unaccompaniedMinor.minimumAge, typically
 * 18) — a 12-year-old is chargeable but still a legal minor.
 */
export function computeChargeableOccupants(input: { adults: number; childAges: number[] }, bundle: ChildPolicyBundle): number {
  let count = input.adults;
  for (const age of input.childAges) {
    const band = classifyAge(age, bundle);
    if (band === "ADULT") count++;
  }
  return count;
}

/**
 * Given chargeable occupants + a room type's maxCapacity, return the inclusive range of
 * valid room counts. Example (maxCapacity = 3):
 *   1 CO → { min: 1, max: 1 }
 *   2 CO → { min: 1, max: 2 }
 *   3 CO → { min: 1, max: 3 }   ← 1 room via extra bed, 2 rooms as 1+2, 3 rooms as 1+1+1
 *   4 CO → { min: 2, max: 4 }   ← 1 room impossible, must have >=2
 *   5 CO → { min: 2, max: 5 }
 *   6 CO → { min: 2, max: 6 }
 *   7 CO → { min: 3, max: 7 }
 */
export function computeAllowedRoomCounts(chargeableOccupants: number, maxCapacity: number): { min: number; max: number } {
  if (chargeableOccupants <= 0) return { min: 0, max: 0 };
  const safeMax = maxCapacity > 0 ? maxCapacity : 1;
  return { min: Math.ceil(chargeableOccupants / safeMax), max: chargeableOccupants };
}

export async function validateCapacity(
  prisma: PrismaClient,
  input: CapacityValidationInput,
  preloadedBundle?: ChildPolicyBundle,
): Promise<{
  issues: CapacityIssue[];
  classifiedAdults: number;
  classifiedChildren: number;
  classifiedYoungChildren: number;
  /** Number of guests under the legal minimum age — i.e. anyone who cannot book unaccompanied. */
  legalMinorCount: number;
  /** Adults responsible at-law: declared adults plus any "child" entered with age ≥ legal min. */
  responsibleAdultCount: number;
  /** Adults + children who count toward room capacity (age >= ADULT band). */
  chargeableOccupants: number;
}> {
  const bundle = preloadedBundle ?? (await loadChildPolicyBundle(prisma));
  const issues: CapacityIssue[] = [];
  const minAdultAge = bundle.unaccompaniedMinor.minimumAge;

  // The "children" field accepts ages of legal minors. Adults (age >= minAdultAge) belong in
  // the adultCount field — entering a 21yo as a child is a UI/operator mistake. Reject so the
  // operator fixes it rather than silently treating them as a responsible adult. The cap is
  // POLICY-DRIVEN: when minimumAge moves from 18 to 21, this cap follows automatically.
  const overAgeChildren = input.childAges.filter((a) => a >= minAdultAge);
  if (overAgeChildren.length > 0) {
    issues.push({
      code: "CHILD_AGE_ABOVE_LEGAL_MINOR",
      severity: "BLOCK",
      message: `Children must be under ${minAdultAge}. Move guests aged ${minAdultAge}+ to the Adults field.`,
      detail: { minimumAge: minAdultAge, overAgeAges: overAgeChildren },
    });
  }

  // Two independent age cuts apply here. The pricing bands (young child / child / pricing-adult)
  // come from registry.child.ageBands and govern bed sharing + meal rates. The legal cut comes
  // from registry.child.unaccompaniedMinorMinAge and governs supervision / responsibility.
  // A 17-year-old is a pricing-adult (own bed, full meals) but still a legal minor — they
  // cannot book without an accompanying responsible adult. Treat the two classifications
  // independently so cases like that one don't slip through.
  let classifiedAdults = input.adults; // pricing-adult bodies (incl. teens classified as such)
  let classifiedChildren = 0;
  let classifiedYoungChildren = 0;
  let legalMinorCount = 0;
  let childrenWhoAreLegalAdults = 0; // age ≥ 18 entered into the children field
  for (const age of input.childAges) {
    const band = classifyAge(age, bundle);
    if (band === "ADULT") classifiedAdults++;
    else if (band === "CHILD") classifiedChildren++;
    else classifiedYoungChildren++;
    if (age < minAdultAge) legalMinorCount++;
    else childrenWhoAreLegalAdults++;
  }
  const responsibleAdultCount = input.adults + childrenWhoAreLegalAdults;

  // Unaccompanied minor — legal check. Uses the responsible-adult count (NOT the pricing
  // count) so a 17yo entered as a child still flags as a minor even though pricing-wise
  // they'd be in the adult band.
  if (bundle.unaccompaniedMinor.enabled && responsibleAdultCount === 0 && legalMinorCount > 0) {
    issues.push({
      code: "UNACCOMPANIED_MINOR",
      severity: "BLOCK",
      message: `Guests under ${minAdultAge} cannot book a room without a responsible adult (age ${minAdultAge}+).`,
      detail: { minimumAge: minAdultAge, legalMinorCount },
    });
  }

  // Adult-to-child ratio — uses pricing-children (under 11 — the ones who still share bedding
  // and meaningfully require supervision in the room). Adults here = responsible adults.
  const pricingChildrenAndYoung = classifiedChildren + classifiedYoungChildren;
  if (
    bundle.adultToChildRatio.enabled &&
    responsibleAdultCount > 0 &&
    pricingChildrenAndYoung > responsibleAdultCount * bundle.adultToChildRatio.maxChildrenPerAdult
  ) {
    issues.push({
      code: "ADULT_CHILD_RATIO_EXCEEDED",
      severity: "WARN",
      message: `Adult-to-child ratio exceeded: max ${bundle.adultToChildRatio.maxChildrenPerAdult} children per adult.`,
      detail: { adults: responsibleAdultCount, children: pricingChildrenAndYoung },
    });
  }

  // Per-room-type caps — only checked if roomTypeId is given.
  const chargeableOccupants = computeChargeableOccupants({ adults: input.adults, childAges: input.childAges }, bundle);
  if (input.roomTypeId) {
    const roomType = await prisma.roomType.findUnique({
      where: { id: input.roomTypeId },
      select: {
        id: true,
        name: true,
        standardCapacity: true,
        maxCapacity: true,
        maxChildren: true,
        requiredAccompanyingAdults: true,
        maxExtraBeds: true,
      },
    });
    if (!roomType) {
      issues.push({
        code: "NO_ROOM_TYPE",
        severity: "BLOCK",
        message: `Unknown room type ${input.roomTypeId}`,
      });
      return { issues, classifiedAdults, classifiedChildren, classifiedYoungChildren, legalMinorCount, responsibleAdultCount, chargeableOccupants };
    }

    // OVER_MAX_OCCUPANCY now checks chargeable occupants against the room type's absolute
    // ceiling (maxCapacity — the extra-bed configuration). Young children are already
    // excluded from chargeable — they share bedding and don't count toward capacity.
    if (chargeableOccupants > roomType.maxCapacity) {
      issues.push({
        code: "OVER_MAX_OCCUPANCY",
        severity: "BLOCK",
        message: `${chargeableOccupants} chargeable guests exceeds the ${roomType.name} max of ${roomType.maxCapacity}.`,
        detail: {
          chargeableOccupants,
          maxCapacity: roomType.maxCapacity,
          standardCapacity: roomType.standardCapacity,
          roomTypeName: roomType.name,
        },
      });
    }
    if (pricingChildrenAndYoung > roomType.maxChildren) {
      issues.push({
        code: "OVER_MAX_CHILDREN",
        severity: "BLOCK",
        message: `${pricingChildrenAndYoung} children exceeds the ${roomType.name} max of ${roomType.maxChildren}.`,
        detail: { children: pricingChildrenAndYoung, maxChildren: roomType.maxChildren, roomTypeName: roomType.name },
      });
    }
    // TOO_FEW_ADULTS = supervising bodies in the room when pricing-children are present.
    // Uses responsibleAdultCount (legal adults) — a teen in the children field doesn't
    // count as a supervising adult even if they're a pricing-adult.
    if (pricingChildrenAndYoung > 0 && responsibleAdultCount < roomType.requiredAccompanyingAdults) {
      issues.push({
        code: "TOO_FEW_ADULTS",
        severity: "BLOCK",
        message: `${roomType.name} requires at least ${roomType.requiredAccompanyingAdults} accompanying adult(s) when children are present.`,
        detail: {
          adults: responsibleAdultCount,
          requiredAdults: roomType.requiredAccompanyingAdults,
          roomTypeName: roomType.name,
        },
      });
    }

    // Number-of-rooms envelope — enforced against the SELECTED room type's maxCapacity.
    if (input.numberOfRooms != null && input.numberOfRooms > 0) {
      const { min, max } = computeAllowedRoomCounts(chargeableOccupants, roomType.maxCapacity);
      if (input.numberOfRooms < min || input.numberOfRooms > max) {
        issues.push({
          code: "INVALID_NUMBER_OF_ROOMS",
          severity: "BLOCK",
          message: `Number of rooms must be between ${min} and ${max} for ${chargeableOccupants} chargeable guests at ${roomType.name} (max ${roomType.maxCapacity} per room).`,
          detail: { requested: input.numberOfRooms, min, max, chargeableOccupants, maxCapacity: roomType.maxCapacity },
        });
      }
    }
  } else if (input.numberOfRooms != null && input.numberOfRooms > 0) {
    // No specific room type yet — use the fallback maxCapacity the caller passed. This is
    // the typical S1 intake path where the operator commits to a count before picking a
    // specific type; the type-specific validation runs again at seal time.
    const fallback = input.fallbackMaxCapacity && input.fallbackMaxCapacity > 0 ? input.fallbackMaxCapacity : 3;
    const { min, max } = computeAllowedRoomCounts(chargeableOccupants, fallback);
    if (input.numberOfRooms < min || input.numberOfRooms > max) {
      issues.push({
        code: "INVALID_NUMBER_OF_ROOMS",
        severity: "BLOCK",
        message: `Number of rooms must be between ${min} and ${max} for ${chargeableOccupants} chargeable guests (assuming max ${fallback} per room).`,
        detail: { requested: input.numberOfRooms, min, max, chargeableOccupants, fallbackMaxCapacity: fallback },
      });
    }
  }

  return { issues, classifiedAdults, classifiedChildren, classifiedYoungChildren, legalMinorCount, responsibleAdultCount, chargeableOccupants };
}
