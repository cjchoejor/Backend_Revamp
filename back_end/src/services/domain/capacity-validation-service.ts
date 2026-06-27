/**
 * Validates a proposed guest composition (adults + child ages) against a RoomType's per-type
 * capacity caps (maxOccupancy / maxChildren / requiredAccompanyingAdults / maxExtraBeds) plus
 * the global child-policy rules (unaccompanied minor age, adult-to-child ratio).
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
  | "NO_ROOM_TYPE";

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
};

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
  if (input.roomTypeId) {
    const roomType = await prisma.roomType.findUnique({
      where: { id: input.roomTypeId },
      select: { id: true, name: true, maxOccupancy: true, maxChildren: true, requiredAccompanyingAdults: true, maxExtraBeds: true },
    });
    if (!roomType) {
      issues.push({
        code: "NO_ROOM_TYPE",
        severity: "BLOCK",
        message: `Unknown room type ${input.roomTypeId}`,
      });
      return { issues, classifiedAdults, classifiedChildren, classifiedYoungChildren, legalMinorCount, responsibleAdultCount };
    }

    const totalGuests = classifiedAdults + classifiedChildren + classifiedYoungChildren;
    if (totalGuests > roomType.maxOccupancy) {
      issues.push({
        code: "OVER_MAX_OCCUPANCY",
        severity: "BLOCK",
        message: `${totalGuests} guests exceeds the ${roomType.name} max of ${roomType.maxOccupancy}.`,
        detail: { totalGuests, maxOccupancy: roomType.maxOccupancy, roomTypeName: roomType.name },
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
  }

  return { issues, classifiedAdults, classifiedChildren, classifiedYoungChildren, legalMinorCount, responsibleAdultCount };
}
