import type { PrismaClient } from "@prisma/client";
import { ActorLevel, InvoiceState, InvoiceType, MealPlanType, QuotationState, Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as documentGenerationService from "../infrastructure/document-generation-service.js";
import { enforceDiscountApprovalBeforeSend } from "../../policies/09-discount/p23-discount-send-requires-approval.js";
import { enforceDiscountApprovalAuthority, resolveActorDiscountCeilings } from "../../policies/09-discount/p23-discount-approval-authority.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderQuotationEmail } from "../infrastructure/stage-email-templates.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";
import { validateDiscountRequestAgainstAuthorityBands } from "../../policies/09-discount/p23-discount-request-constraints.js";
import { enforceAckOpenLoopResolutionRequiresFom } from "../../policies/20-communication-acknowledgement-tracking/p52-ack-open-loop-resolution-requires-fom.js";
import {
  enforceQuotationInDraftToSend,
  enforceQuotationNotLockedByProforma,
  enforceQuotationSentToAccept,
  enforceQuotationSupersedeAllowedState,
} from "../../policies/08-pricing-rate-plan/p07-quotation-lifecycle-state-guards.js";
import {
  enforceEntryAtS2ForQuotationCreation,
  enforceRoomTypeResolvedForS2Quotation,
  enforceSealedPreferredAvailabilityConfigurationForS2Quotation,
} from "../../policies/01-availability/p01-s2-create-quotation-configuration-gates.js";
import { resolveRatePlanPricingForS2Quotation } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.js";
import { enforceQuotationSendTimeGovernanceConfig } from "../../policies/08-pricing-rate-plan/p07-quotation-validity-and-ack-config-s2.js";
import { enforceGroupRateContextForS2Quotation } from "../../policies/26-group-foc-billing/p65-group-rate-context-for-s2-quotation.js";
import { resolveBelowMsrGmWaiverForS2 } from "../../policies/08-pricing-rate-plan/p19-msr-gm-waiver-below-msr-s2.js";
import { enforceFocEntitlementForS2GroupQuotation } from "../../policies/15-foc/p37-foc-entitlement-for-s2-group-quotation.js";
import * as communicationService from "./communication-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { resolveRatePackageForBooking, type AgentRateBreakdown } from "../../lib/rate-package-resolution.js";
import { loadChildPolicyBundle, computeGroupMealCharge } from "./child-policy-service.js";
import { readOptionSelected, firstRoomId } from "../../lib/option-selected-reader.js";
import { mulMoney, round2, sumMoney, toDecimal } from "../../lib/money.js";
import { generateOrLoadQuotationPdf } from "./quotation-pdf-service.js";
import {
  applyBookingDiscountToTotals,
  autoAddRequiredExtraBeds,
  computeQuotationCompositionTotals,
  type RoomCompositionInput,
  type RoomCompositionRateContext,
} from "../../lib/room-composition.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { Prisma } from "@prisma/client";
import { enforceExtraBedForThirdAdult } from "../../policies/34-room-composition/p78-extra-bed-required-for-third-adult.js";
import {
  enforceCompositionCountsConsistent,
  enforceNightOverridesWithinStay,
} from "../../policies/34-room-composition/p79-composition-counts-consistent.js";
import { invalidateQuotationPdfArtifact } from "../../lib/invalidate-quotation-pdf.js";

/**
 * Phase C — look up the inquiry's linked TravelAgent or CorporateAccount (if any), then call
 * the rate-resolution helper. Returns null if no party is linked OR the linked party has no
 * active rate card. Callers use this to optionally override the standard rate plan resolution.
 */
async function resolveAgentRateForEntryQuotation(
  prisma: PrismaClient,
  args: { inquiryId: string; roomTypeId: string; asOf?: Date; mealPlan?: MealPlanType | null },
): Promise<(AgentRateBreakdown & { ratePackageId: string; packageName: string; resolvedVia: string }) | null> {
  const inq = await prisma.inquiry.findUnique({
    where: { id: args.inquiryId },
    select: { travelAgentId: true, corporateAccountId: true, ratePackageId: true },
  });
  if (!inq) return null;

  const pkg = await resolveRatePackageForBooking(prisma, {
    ratePackageId: inq.ratePackageId,
    travelAgentId: inq.travelAgentId,
    corporateAccountId: inq.corporateAccountId,
    roomTypeId: args.roomTypeId,
    asOf: args.asOf,
  });
  if (!pkg) return null;

  // The package carries all four plan rates; the legacy flat path wants the ONE the caller asked
  // for. Selecting it here keeps `mealPlanRate` populated exactly as the RateCard resolver did —
  // leaving it null would silently switch off the booking-wide meal-plan pricing below.
  const mealPlanRate =
    args.mealPlan === MealPlanType.CP ? pkg.mealPlanRates.cp
    : args.mealPlan === MealPlanType.MAP_LUNCH ? pkg.mealPlanRates.mapLunch
    : args.mealPlan === MealPlanType.MAP_DINNER ? pkg.mealPlanRates.mapDinner
    : args.mealPlan === MealPlanType.AP ? pkg.mealPlanRates.ap
    : null;

  // Adapt to the breakdown shape the pricing path already consumes. `rateCardId` keeps its name
  // for the commercialTerms snapshot's sake but now carries the package id; `partyId`/`partyType`
  // still describe who the rate belongs to, with COMMON reported as such.
  return {
    rateCardId: pkg.ratePackageId,
    partyType: (pkg.scope === "CORPORATE" ? "CORPORATE" : "TRAVEL_AGENT") as AgentRateBreakdown["partyType"],
    partyId: pkg.travelAgentId ?? pkg.corporateAccountId ?? "COMMON",
    roomTypeId: pkg.roomTypeId,
    roomRate: pkg.roomRate,
    roomRateSource: pkg.roomRateSource,
    mealPlan: args.mealPlan ?? null,
    mealPlanRate,
    mealPlanRates: pkg.mealPlanRates,
    perNightTotal: pkg.roomRate + (mealPlanRate ?? 0),
    addOns: pkg.addOns,
    cnbPercent: pkg.cnbPercent,
    currency: pkg.currency,
    ratePackageId: pkg.ratePackageId,
    packageName: pkg.packageName,
    resolvedVia: pkg.resolvedVia,
  };
}

/** Shape mirrors the Zod `roomCompositionInputSchema` DTO. Kept as a local type so the
 *  service doesn't depend on the DTO layer. */
export type RoomCompositionServiceInput = {
  roomId: string;
  startDate?: string;
  endDate?: string;
  occupantCount?: number;
  adultCount?: number;
  cnb6To10Count?: number;
  cnbUnder6Count?: number;
  extraBedCount?: number;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
  mealPlanOthersCount?: number;
  othersBreakfastPax?: number;
  othersLunchPax?: number;
  othersDinnerPax?: number;
  negotiatedRoomRate?: number;
  negotiatedExtraBedRate?: number;
  negotiatedBreakfastRate?: number;
  negotiatedLunchRate?: number;
  negotiatedDinnerRate?: number;
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  isFoc?: boolean;
  /** Per-night meal-plan overrides — ISO dates inside this room's stay. */
  nightMealOverrides?: Array<{
    date: string;
    mealPlanCpCount?: number;
    mealPlanMaplCount?: number;
    mealPlanMapdCount?: number;
    mealPlanApCount?: number;
    mealPlanOthersCount?: number;
    othersBreakfastPax?: number;
    othersLunchPax?: number;
    othersDinnerPax?: number;
    /** Extra beds on this one night when they differ from the stay-wide count (2026-08-19). */
    extraBedCount?: number;
  }>;
};

/** Input shape shared by `createQuotation` and `supersedeQuotationWithNewDraft`. */
export type QuotationDraftInput = {
  requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  notes?: string;
  /** Validity window in days (1–30, ending before check-in) — see `resolveQuotationValidity`. */
  validDays?: number;
  currency?: string;
  belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null;
  /**
   * Legacy booking-wide flat model (still supported). Read at the top of
   * `prepareQuotationDraft`; applies when `roomCompositions` is omitted.
   */
  mealPlan?: MealPlanType | null;
  extraBedCount?: number;
  /**
   * Per-room compositions (Phase B, 2026-07-27). When supplied, pricing is computed via
   * per-room iteration (`computeQuotationCompositionTotals`) — including negotiated
   * per-room rates, meal-plan distribution, FOC waivers. When omitted, falls back to the
   * flat `effectiveRate × nights × roomCount` model for backward compat.
   */
  roomCompositions?: RoomCompositionServiceInput[];
  /**
   * When supplied, the requested discount is capped at this actor's ceiling and the call
   * throws `DISCOUNT_AUTHORITY` if it exceeds it. Omit on the plain create path, where the
   * discount is recorded and approved separately via `approveDiscount`.
   */
  actorLevel?: "L1" | "L2" | "L3" | "L4";
};

/**
 * The three composition guards every priced quote must pass, in one place (extracted
 * 2026-08-19). `prepareQuotationDraft` runs them just before pricing; the post-freeze re-price
 * (room-change service) runs the SAME function as a pre-flight, BEFORE its irreversible
 * re-entry — so a composition that would be refused inside the walk is refused while the
 * booking is still untouched, and the two can never disagree about what is priceable.
 *
 * All three are no-ops when their key fields are null, so partially-filled drafts still pass.
 */
export function enforceRoomCompositionsPriceable(
  compositions: RoomCompositionServiceInput[],
  ctx: {
    numberByRoomId: Map<string, string>;
    stayCheckIn: Date | null;
    stayCheckOut: Date | null;
    nights: number;
  },
): void {
  for (const c of compositions) {
    const roomNumber = ctx.numberByRoomId.get(c.roomId) ?? null;
    const nightOverrides = (c.nightMealOverrides ?? []).map((o) => ({ ...o, date: new Date(o.date) }));
    enforceExtraBedForThirdAdult({
      roomNumber,
      adultCount: c.adultCount,
      extraBedCount: c.extraBedCount,
      isFoc: c.isFoc,
    });
    enforceCompositionCountsConsistent({
      roomNumber,
      occupantCount: c.occupantCount,
      adultCount: c.adultCount,
      cnb6To10Count: c.cnb6To10Count,
      cnbUnder6Count: c.cnbUnder6Count,
      mealPlanCpCount: c.mealPlanCpCount,
      mealPlanMaplCount: c.mealPlanMaplCount,
      mealPlanMapdCount: c.mealPlanMapdCount,
      mealPlanApCount: c.mealPlanApCount,
      mealPlanOthersCount: c.mealPlanOthersCount,
      // Each overridden night has to satisfy the occupancy ceiling on its own.
      nightMealOverrides: nightOverrides,
    });
    // Reject a plan pinned to a night outside the stay — it would silently never price.
    enforceNightOverridesWithinStay(
      {
        roomNumber,
        nightMealOverrides: nightOverrides,
        startDate: c.startDate ? new Date(c.startDate) : ctx.stayCheckIn,
        endDate: c.endDate ? new Date(c.endDate) : ctx.stayCheckOut,
      },
      ctx.nights,
    );
  }
}

/**
 * Shared pricing pipeline for S2 quotation drafts (extracted 2026-07-28 so regeneration /
 * supersede re-runs the EXACT same pipeline as first-time creation — rate-plan resolution,
 * agent rate cards, MSR waiver, discount authority bands, per-room composition validation
 * and totals). Returns everything the create-transaction needs; performs NO writes itself
 * (the MSR-waiver resolution may write its own trace, as before).
 */
async function prepareQuotationDraft(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: QuotationDraftInput,
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
      guestProfile: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS2ForQuotationCreation({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const preferredCfg = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  enforceSealedPreferredAvailabilityConfigurationForS2Quotation({ preferred: preferredCfg });
  const preferred = preferredCfg!;
  // Multi-room-safe read: handles legacy single-roomId, whole-stay roomIds, and per-night
  // shapes uniformly. Was previously reading `optionSelected.roomId` directly which broke
  // for the two newer shapes (bug reported 2026-07-13).
  const sealed = readOptionSelected(preferred.optionSelected);
  let roomTypeId: string | undefined = (preferred.searchCriteria as any)?.roomTypeId;
  if (!roomTypeId || typeof roomTypeId !== "string") {
    const anyRoomId = firstRoomId(sealed);
    if (anyRoomId) {
      const selectedRoom = await prisma.room.findUnique({ where: { id: anyRoomId }, select: { roomTypeId: true } });
      roomTypeId = selectedRoom?.roomTypeId;
    }
  }
  enforceRoomTypeResolvedForS2Quotation({ roomTypeId });

  // Room count = number of distinct rooms in the seal. For per-night seals this is the total
  // distinct rooms across all nights, which matches the operator's intent (a room-change
  // mid-stay is still one committed room-night per room per night — the total room-nights =
  // distinctRooms × nights).
  const roomCount = Math.max(1, sealed.distinctRoomIds.length || (entry.numberOfRooms ?? 1));

  const tier = entry.guestProfile?.clientTier;
  const isDeficientGuestTier = tier === "CAUTION" || tier === "RESTRICTED";
  const stay = entry.checkInDate && entry.checkOutDate ? { checkIn: entry.checkInDate, checkOut: entry.checkOutDate } : undefined;

  // Discount is resolved BEFORE pricing so it actually reduces the resolved rate (fixed
  // 2026-07-28 — previously the requested discount was recorded on commercialTerms but never
  // passed to the pricing engine on the create path, so a quote created with a discount was
  // priced at full rate; only the separate applyDiscount endpoint re-priced, and it did so
  // with a different, room-type-blind rate resolution).
  const requested = input.requestedDiscount ?? null;
  /**
   * Where the discount lands depends on which pricing model runs.
   *
   * COMPOSITION model (what the desk uses): the discount is a deduction off the GRAND TOTAL —
   * meals and extra beds included — taken after the rooms are costed (operator ruling
   * 2026-08-04; see `applyBookingDiscountToTotals`). The rate resolution must therefore NOT
   * pre-apply it, or it would come off twice. This is also the only model that can accept a
   * flat amount, since an amount means nothing until there is a total to measure it against.
   *
   * LEGACY FLAT model (no compositions — API compat for the production frontend and direct API
   * callers): unchanged. The percent is still folded into the resolved room rate before pricing.
   */
  const usingCompositions = Array.isArray(input.roomCompositions) && input.roomCompositions.length > 0;
  // The DTO rejects both-at-once at the route; repeat it here so a direct service caller cannot
  // slip past with two conflicting figures and have one silently ignored.
  if (requested?.discountPercent != null && requested?.discountAmount != null) {
    throw new ValidationError("Give the discount either as a percentage or as an amount, not both");
  }
  if (requested?.discountAmount != null && !usingCompositions) {
    throw new ValidationError("A flat discount amount needs per-room compositions to measure against");
  }
  if (requested?.discountPercent != null) {
    await validateDiscountRequestAgainstAuthorityBands(prisma, {
      discountPercent: requested.discountPercent,
      discountBasis: requested.discountBasis,
    });
  }
  // Actor ceiling only applies when the caller identified an actor level (applyDiscount /
  // supersede-with-discount). The plain create path records the request and defers approval
  // to `approveDiscount`, so it passes no cap.
  let actorMaxDiscountPercent: number | undefined;
  if (requested && input.actorLevel) {
    const ceilings = await resolveActorDiscountCeilings(prisma);
    actorMaxDiscountPercent =
      input.actorLevel === "L1" ? ceilings.l1MaxPercent : input.actorLevel === "L2" ? ceilings.l2MaxPercent : ceilings.l3MaxPercent;
  }

  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, {
    isDeficientGuestTier,
    roomTypeId,
    stay,
    discountPercentOffRequested: usingCompositions ? undefined : requested?.discountPercent,
    actorMaxDiscountPercent,
  });
  if (requested && !pricing.discountWithinAuthorityBounds) {
    throw new PolicyGateBlockedError(
      "DISCOUNT_AUTHORITY",
      "Requested discount exceeds the acting user's maximum discount authority",
    );
  }

  // Phase C — if the inquiry is linked to a travel agent or corporate account with an active
  // rate card, override the standard pricing with the negotiated room rate (including per-room-type
  // override if present). Standard pricing stays as a reference inside commercialTerms.standardPricing
  // so the operator can see what the hotel's rate plan would have charged.
  const mealPlan = input.mealPlan ?? null;
  const extraBedCount = Math.max(0, Math.trunc(input.extraBedCount ?? 0));
  const agentRate = entry.inquiryId
    ? await resolveAgentRateForEntryQuotation(prisma, { inquiryId: entry.inquiryId, roomTypeId: roomTypeId!, mealPlan })
    : null;
  // effectiveRate stays the ROOM rate — MSR, discount and S4 freeze semantics depend on it.
  const effectiveRate = agentRate ? agentRate.roomRate : pricing.effectiveRate;
  const resolvedNightlyRate = agentRate ? agentRate.roomRate : pricing.resolvedNightlyRate;
  const currency = agentRate ? agentRate.currency : pricing.currency;
  const resolutionPath = agentRate ? `${pricing.resolutionPath ?? ""} → AGENT_RATE_PACKAGE` : pricing.resolutionPath;

  // Meal + extra-bed pricing (Phase-D, Track A). Only priced when the booking is linked to an
  // agent/corporate rate card (agentRate present). Extra beds are a manual per-night surcharge.
  // For non-contracted bookings these stay label-only.
  //
  // Meals are priced by `computeGroupMealCharge` — the age-band child policy from
  // `registry.child.*` (young child free / child 70% / adult 100% by default, admin-editable).
  // It previously used the rate card's `cnbPercent`, which is the child-NO-BED *room* discount,
  // not a meal rate: docs/Legphel-Child-Policy.md §4 states the child meal rate "applies to the
  // per-person meal component of the plan or package, not the room". That mismatch billed
  // 6–10-year-olds free on any contract with cnbPercent = 0. `cnbPercent` belongs to the
  // separate-bed charge (getSeparateBedCharge), which is still awaiting a confirmed rate.
  //
  // nights: 1 — this figure feeds `perNightTotal`; the stay multiplication happens downstream.
  const childPolicyBundle = await loadChildPolicyBundle(prisma);
  const mealPricing =
    agentRate && mealPlan && agentRate.mealPlanRate != null
      ? computeGroupMealCharge(
          {
            adultCount: entry.adultCount ?? entry.guestCount ?? 0,
            childAges: entry.childAges ?? [],
            adultMealRate: agentRate.mealPlanRate,
            nights: 1,
          },
          childPolicyBundle,
        )
      : null;
  const extraBedRate = agentRate?.addOns.extraBed ?? null;

  const extraBedTotal = extraBedRate != null && extraBedCount > 0 ? extraBedRate * extraBedCount : 0;
  const mealTotal = mealPricing?.total ?? 0;
  // Per-night total the guest is quoted = room + meal component + extra beds.
  const perNightTotal = effectiveRate + mealTotal + extraBedTotal;

  const msrWaiver = await resolveBelowMsrGmWaiverForS2(prisma, {
    // Agent rates are negotiated and not subject to MSR — only flag below-MSR when standard pricing applies.
    belowMsr: agentRate ? false : pricing.belowMsr,
    actorId,
    waiver: input.belowMsrGmWaiver ?? null,
  });

  const last = await prisma.quotation.findFirst({ where: { entryId, segmentId }, orderBy: { versionNumber: "desc" } });
  const nextVersion = (last?.versionNumber ?? 0) + 1;
  const now = new Date();

  // Per-guest meal breakdown. Uses the base adult meal rate available on the agent rate
  // card (or falls back to derived pricing) and applies child-policy multipliers so young
  // children eat free, kids at reduced rate, adults full. Advisory today — attached to
  // commercialTerms as a `perGuestMealBreakdown` block for reporting / audit. Pricing engines
  // that want to swap the total with this per-guest sum can call the helper directly.
  let perGuestMealBreakdown: unknown = undefined;
  const adultMealRate = agentRate?.addOns?.breakfast ?? null; // conservative default meal-per-person
  if (typeof adultMealRate === "number" && adultMealRate > 0 && (entry.adultCount ?? 0) + (entry.childAges ?? []).length > 0) {
    const nightsForMeals =
      stay && stay.checkIn && stay.checkOut
        ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
        : 1;
    const breakdown = computeGroupMealCharge(
      {
        adultCount: entry.adultCount ?? 0,
        childAges: entry.childAges ?? [],
        adultMealRate,
        nights: nightsForMeals,
      },
      childPolicyBundle,
    );
    perGuestMealBreakdown = {
      adultMealRate,
      nights: nightsForMeals,
      totalMealCharge: breakdown.total,
      perGuest: breakdown.perGuest,
      source: "registry.child.mealPricing",
    };
  }

  // Nights for pricing math. Fall back to 1 when dates aren't fixed yet so the multiplication
  // still produces a sensible value in draft-quote scenarios.
  const nightsForPricing =
    stay && stay.checkIn && stay.checkOut
      ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
      : 1;

  // Multi-room pricing block. Semantics:
  //   - `effectiveRate` and `resolvedNightlyRate` = PER-ROOM per-night rate (unchanged semantic)
  //   - `pricingBreakdown` = explicit total that reflects roomCount × nights so downstream
  //     services (S3 advance-payment threshold, S4 confirmation, S9 reconciliation) can
  //     multiply correctly without every consumer re-deriving room count on its own.
  // Decimal-safe: subTotal is a rounded Decimal converted to number at the boundary. Prevents
  // float drift when effectiveRate × nights × roomCount later flows into totalAmount / S3 gate.
  const subTotalDec = round2(mulMoney(mulMoney(effectiveRate, nightsForPricing), roomCount));
  const pricingBreakdown = {
    nightlyRate: effectiveRate,
    nights: nightsForPricing,
    roomCount,
    subTotal: Number(subTotalDec.toFixed(2)),
  };

  // ─── Per-room composition path (Phase B, 2026-07-27) ─────────────────────────
  // When compositions are provided, replace the flat-total pricing with per-room iteration.
  // Rate defaults come from the agent rate card (when linked) or the resolved rate plan;
  // per-room negotiated overrides on each composition take precedence over these defaults.
  // Backward-compat: when `roomCompositions` is empty/undefined, the flat model above is
  // authoritative and nothing here runs.
  let compositionTotals: ReturnType<typeof computeQuotationCompositionTotals> | null = null;
  // Undiscounted reference run — populated only when a discount actually moved the room rate,
  // so the document can print ORIGINAL prices with an explicit deduction (2026-08-02).
  let compositionTotalsPreDiscount: ReturnType<typeof computeQuotationCompositionTotals> | null = null;
  /** The booking discount as applied, once there was a grand total to measure it against. */
  let compositionDiscount: {
    requestedPercent: number | null;
    requestedAmount: number | null;
    amountOffTotal: number;
    effectivePercent: number;
    netReduction: number;
    basis: string;
  } | null = null;
  /** Rooms whose mandatory extra bed was added automatically (3+ adults, none supplied). */
  let extraBedsAutoAdded: { roomId: string; roomNumber: string | null; extraBedsAdded: number }[] | null = null;
  if (Array.isArray(input.roomCompositions) && input.roomCompositions.length > 0) {
    // Fetch charge rates + hydrate room numbers for the perRoom breakdown.
    const { serviceChargeRate, gstRate } = await resolveChargeRates(prisma);
    const roomIds = input.roomCompositions.map((c) => c.roomId);
    const roomRows = await prisma.room.findMany({
      where: { id: { in: roomIds } },
      select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { maxExtraBeds: true } } },
    });
    const numberByRoomId = new Map(roomRows.map((r) => [r.id, r.roomNumber]));
    const maxExtraBedsByRoomId = new Map(roomRows.map((r) => [r.id, r.roomType?.maxExtraBeds ?? null]));

    // Auto-add the mandatory extra bed (2026-08-12, operator ruling — add it instead of
    // refusing the quotation): a non-FOC room with 3+ adults and no extra bed gets one. The
    // corrected list REPLACES input.roomCompositions so validation (p78 below now passes —
    // it stays as belt-and-braces), pricing and the stored commercialTerms all see the same
    // counts, and a supersede carries the bed forward. The correction is recorded on
    // `commercialTerms.extraBedsAutoAdded` so the desk and the document trail can say so.
    const bedNorm = autoAddRequiredExtraBeds(input.roomCompositions, {
      maxExtraBedsForRoom: (c) => maxExtraBedsByRoomId.get(c.roomId),
    });
    input.roomCompositions = bedNorm.compositions;
    if (bedNorm.autoAddedIndexes.length > 0) {
      extraBedsAutoAdded = bedNorm.autoAddedIndexes.map((i) => ({
        roomId: bedNorm.compositions[i].roomId,
        roomNumber: numberByRoomId.get(bedNorm.compositions[i].roomId) ?? null,
        extraBedsAdded: 1,
      }));
    }

    // Default meal / extra-bed rates come from the agent rate card's add-ons when present;
    // otherwise 0. Operators can still enter per-room negotiatedBreakfast/Lunch/DinnerRate
    // to override in the composition payload.
    const defaultBreakfast = toDecimal(agentRate?.addOns?.breakfast ?? 0);
    const defaultLunch = toDecimal(agentRate?.addOns?.lunch ?? 0);
    const defaultDinner = toDecimal(agentRate?.addOns?.dinner ?? 0);
    const defaultExtraBed = toDecimal(agentRate?.addOns?.extraBed ?? 0);
    // Cost the composition from the EFFECTIVE (post-discount) rate, not the resolved base.
    // Fixed 2026-07-28: this previously read `resolvedNightlyRate`, which is the rate BEFORE
    // any discount is applied — so on a composition-priced quote the discount reached
    // `effectiveRate` in commercialTerms but never reached the rooms, and the total came out
    // identical to the undiscounted one (observed on ENT-20260728-0013: effectiveRate 1530,
    // roomRate 1700, total unchanged at 1963.50 across three rounds).
    // `effectiveRate` equals `resolvedNightlyRate` when no discount is in play, so this is a
    // no-op for undiscounted quotes.
    const defaultRoomRate = toDecimal(effectiveRate ?? resolvedNightlyRate ?? 0);
    const defaultRoomRatePreDiscount = toDecimal(resolvedNightlyRate ?? 0);

    /**
     * Rates PER ROOM TYPE (fixed 2026-08-04).
     *
     * Every room used to be costed at `defaultRoomRate` — one rate resolved from whichever room
     * sorted first in the seal (`roomTypeId` above). On a booking mixing types that charged a
     * Suite at the Standard rate, or a Standard at the Executive rate, decided by nothing more
     * than seal order: observed on QUO-20260803-0002, where an Executive (3,000) and four
     * Standards (1,800) were all billed at 2,100 because a Deluxe happened to be first.
     *
     * Each distinct type is now resolved on its own terms — its agent/corporate card if one
     * covers it (including the per-room-type override), else its own rate plan — and each room
     * is costed at its own type's rate. The booking-level `effectiveRate` / `resolvedNightlyRate`
     * are left alone: they are the headline rate for the preferred type and carry MSR, the S4
     * freeze and the legacy flat path, none of which are per room.
     *
     * A type whose rate cannot be resolved (no eligible plan) falls back to the booking rate
     * rather than throwing — resolving a second type must not fail a quote that used to succeed.
     */
    type TypeRates = {
      room: Prisma.Decimal;
      roomPreDiscount: Prisma.Decimal;
      extraBed: Prisma.Decimal;
      breakfast: Prisma.Decimal;
      lunch: Prisma.Decimal;
      dinner: Prisma.Decimal;
    };
    const bookingTypeRates: TypeRates = {
      room: defaultRoomRate,
      roomPreDiscount: defaultRoomRatePreDiscount,
      extraBed: defaultExtraBed,
      breakfast: defaultBreakfast,
      lunch: defaultLunch,
      dinner: defaultDinner,
    };
    const ratesByType = new Map<string, TypeRates>();
    for (const tid of new Set(roomRows.map((r) => r.roomTypeId).filter((t): t is string => !!t))) {
      // The preferred type is already resolved above — reuse it rather than querying twice.
      if (tid === roomTypeId) {
        ratesByType.set(tid, bookingTypeRates);
        continue;
      }
      try {
        const typeAgentRate = entry.inquiryId
          ? await resolveAgentRateForEntryQuotation(prisma, { inquiryId: entry.inquiryId, roomTypeId: tid, mealPlan })
          : null;
        if (typeAgentRate) {
          // Card rates are negotiated, so no discount is folded in — the same rule the
          // booking-level resolution applies (`effectiveRate = agentRate.roomRate`).
          const r = toDecimal(typeAgentRate.roomRate);
          ratesByType.set(tid, {
            room: r,
            roomPreDiscount: r,
            extraBed: toDecimal(typeAgentRate.addOns?.extraBed ?? 0),
            breakfast: toDecimal(typeAgentRate.addOns?.breakfast ?? 0),
            lunch: toDecimal(typeAgentRate.addOns?.lunch ?? 0),
            dinner: toDecimal(typeAgentRate.addOns?.dinner ?? 0),
          });
          continue;
        }
        // No discount here: under the composition model it comes off the grand total once the
        // rooms are costed, so folding it into the rate as well would take it twice.
        const typePricing = await resolveRatePlanPricingForS2Quotation(prisma, {
          isDeficientGuestTier,
          roomTypeId: tid,
          stay,
        });
        ratesByType.set(tid, {
          room: toDecimal(typePricing.effectiveRate ?? typePricing.resolvedNightlyRate ?? 0),
          roomPreDiscount: toDecimal(typePricing.resolvedNightlyRate ?? 0),
          // No card for this type — add-ons stay 0, exactly as they were for the whole booking
          // before. Per-room negotiated rates still override.
          extraBed: toDecimal(0),
          breakfast: toDecimal(0),
          lunch: toDecimal(0),
          dinner: toDecimal(0),
        });
      } catch (e) {
        if (e instanceof PolicyGateBlockedError) throw e;
        ratesByType.set(tid, bookingTypeRates);
      }
    }
    const ratesForRoom = (roomId: string): TypeRates => {
      const tid = roomRows.find((r) => r.id === roomId)?.roomTypeId;
      return (tid ? ratesByType.get(tid) : undefined) ?? bookingTypeRates;
    };

    /**
     * Nights PER ROOM (fixed 2026-08-12).
     *
     * A per-night seal claims each room only on ITS nights — room 502 for four nights, 307 for
     * the first three, 304 for the last. Every room used to be costed at the booking-wide
     * `nightsForPricing`, so a room covering 3 of 4 nights priced ×4 — overcharging every
     * partial-availability booking, and double-charging the mid-stay room-change split (old
     * room's slept nights + new room's remaining nights would BOTH price the whole stay).
     * Whole-stay and single-room seals have no per-night breakdown, so the map stays empty and
     * every room keeps the booking-wide figure — nothing moves for uniform bookings.
     */
    const perRoomNightCounts = new Map<string, number>();
    if (sealed.perNight) {
      for (const night of sealed.perNight) {
        for (const rid of night.roomIds) {
          perRoomNightCounts.set(rid, (perRoomNightCounts.get(rid) ?? 0) + 1);
        }
      }
    }

    // Validate each room's composition BEFORE pricing so we reject early with a friendly
    // error (rather than persisting bad data). Both policies are no-ops when key fields
    // are null so partially-filled draft submissions can still succeed.
    enforceRoomCompositionsPriceable(input.roomCompositions, {
      numberByRoomId,
      stayCheckIn: stay?.checkIn ?? null,
      stayCheckOut: stay?.checkOut ?? null,
      nights: nightsForPricing,
    });

    const rooms = input.roomCompositions.map((c) => {
      const compositionInput: RoomCompositionInput = {
        nightMealOverrides: (c.nightMealOverrides ?? []).map((o) => ({ ...o, date: new Date(o.date) })),
        occupantCount: c.occupantCount,
        adultCount: c.adultCount,
        cnb6To10Count: c.cnb6To10Count,
        cnbUnder6Count: c.cnbUnder6Count,
        extraBedCount: c.extraBedCount,
        mealPlanCpCount: c.mealPlanCpCount,
        mealPlanMaplCount: c.mealPlanMaplCount,
        mealPlanMapdCount: c.mealPlanMapdCount,
        mealPlanApCount: c.mealPlanApCount,
        mealPlanOthersCount: c.mealPlanOthersCount,
        othersBreakfastPax: c.othersBreakfastPax,
        othersLunchPax: c.othersLunchPax,
        othersDinnerPax: c.othersDinnerPax,
        negotiatedRoomRate: c.negotiatedRoomRate != null ? new Prisma.Decimal(c.negotiatedRoomRate) : null,
        negotiatedExtraBedRate: c.negotiatedExtraBedRate != null ? new Prisma.Decimal(c.negotiatedExtraBedRate) : null,
        negotiatedBreakfastRate: c.negotiatedBreakfastRate != null ? new Prisma.Decimal(c.negotiatedBreakfastRate) : null,
        negotiatedLunchRate: c.negotiatedLunchRate != null ? new Prisma.Decimal(c.negotiatedLunchRate) : null,
        negotiatedDinnerRate: c.negotiatedDinnerRate != null ? new Prisma.Decimal(c.negotiatedDinnerRate) : null,
        serviceChargeApplies: c.serviceChargeApplies,
        gstApplies: c.gstApplies,
        isFoc: c.isFoc,
        // Per-room date range: use explicit if supplied, else stay-wide dates.
        startDate: c.startDate ? new Date(c.startDate) : stay?.checkIn ?? null,
        endDate: c.endDate ? new Date(c.endDate) : stay?.checkOut ?? null,
      };
      const tr = ratesForRoom(c.roomId);
      const ctx: RoomCompositionRateContext = {
        defaultRoomRate: tr.room,
        defaultExtraBedRate: tr.extraBed,
        defaultBreakfastRate: tr.breakfast,
        defaultLunchRate: tr.lunch,
        defaultDinnerRate: tr.dinner,
        serviceChargeRate,
        gstRate,
        // Age-band meal shares (under-6 free, 6–10 at 70% of the adult rate) — the composition
        // path charged every cover the full adult rate until 2026-08-04.
        childMealPricing: childPolicyBundle.mealPricing,
        // Per-room claimed nights on a per-night seal; booking-wide nights otherwise.
        nights: perRoomNightCounts.get(c.roomId) ?? nightsForPricing,
      };
      return {
        input: compositionInput,
        ctx,
        roomId: c.roomId,
        roomNumber: numberByRoomId.get(c.roomId) ?? null,
      };
    });
    compositionTotals = computeQuotationCompositionTotals(rooms);

    // Pre-discount reference run (2026-08-02): when the requested discount moved the room
    // rate, cost the SAME compositions once more from the undiscounted base. The document
    // prints these as the original prices and shows the difference as a deduction. Rooms
    // with a per-room negotiatedRoomRate ignore defaultRoomRate, so they price identically
    // in both runs — accurate: a negotiated rate is not a discounted one.
    /**
     * The booking discount, taken off the GRAND TOTAL now that there is one.
     *
     * The undiscounted run becomes `compositionTotalsPreDiscount` — the ORIGINAL prices the
     * document prints, with the deduction shown as its own line (2026-08-02 ruling). Rates are
     * not touched: they are what the operator negotiated, so a room still shows the rate that
     * was agreed and the concession appears once, at booking level, where it was given.
     */
    if (requested) {
      const applied = applyBookingDiscountToTotals(compositionTotals, rooms, {
        percent: requested.discountPercent ?? null,
        amount: requested.discountAmount ?? null,
      });
      if (applied) {
        // The ceiling is written in percent, so an amount is measured as its share of the total
        // before being checked — otherwise a flat figure would slip past the L1/L2/L3 bands.
        const effectivePct = Number(round2(applied.effectivePercent));
        if (requested.discountAmount != null) {
          await validateDiscountRequestAgainstAuthorityBands(prisma, {
            discountPercent: effectivePct,
            discountBasis: requested.discountBasis,
          });
        }
        if (actorMaxDiscountPercent != null && effectivePct > actorMaxDiscountPercent) {
          throw new PolicyGateBlockedError(
            "DISCOUNT_AUTHORITY",
            "Requested discount exceeds the acting user's maximum discount authority",
          );
        }
        compositionTotalsPreDiscount = compositionTotals;
        compositionTotals = applied.totals;
        compositionDiscount = {
          requestedPercent: requested.discountPercent ?? null,
          requestedAmount: requested.discountAmount ?? null,
          amountOffTotal: Number(round2(applied.amountOffTotal)),
          effectivePercent: effectivePct,
          netReduction: Number(round2(applied.netReduction)),
          basis: requested.discountBasis,
        };
      }
    }
  }

  // ── Discount authority is settled at GENERATION (2026-08-07, operator ruling) ─────────────
  // "Approving after the quotation is generated doesn't make sense": when the caller
  // identified the acting user (the HTTP create/supersede routes now always inject the
  // verified session level), the discount's authority band is decided HERE — the generating
  // actor either holds the authority (the quote is born approved: stamped below, traced by
  // the create/supersede transaction) or generation is refused naming the level required.
  // The per-model ceiling checks above already ran; this last check covers the degenerate
  // paths (e.g. a discount that priced to nothing) so a stamp can never appear unchecked.
  // Bare service callers that omit actorLevel keep the legacy two-step (create unapproved →
  // `approveDiscount`) — the p23 send/S2-exit gate holds either way.
  let discountAuthority: {
    approvedBy: string;
    approvedLevel: "L1" | "L2" | "L3" | "L4";
    approvedAt: string;
    measuredPercent: number | null;
    autoAtGeneration: true;
  } | null = null;
  if (requested && input.actorLevel) {
    const measuredPercent = compositionDiscount?.effectivePercent ?? requested.discountPercent ?? null;
    if (measuredPercent != null) {
      const ceilings = await resolveActorDiscountCeilings(prisma);
      const cap =
        input.actorLevel === "L1"
          ? ceilings.l1MaxPercent
          : input.actorLevel === "L2"
            ? ceilings.l2MaxPercent
            : ceilings.l3MaxPercent;
      if (toDecimal(measuredPercent).gt(toDecimal(cap))) {
        throw new PolicyGateBlockedError(
          "DISCOUNT_AUTHORITY",
          `This discount (${measuredPercent}% of the total) is above your approval band — ${
            toDecimal(measuredPercent).gt(toDecimal(ceilings.l2MaxPercent)) ? "a GM" : "an FOM"
          } has to generate this quote`,
        );
      }
      discountAuthority = {
        approvedBy: actorId,
        approvedLevel: input.actorLevel,
        approvedAt: new Date().toISOString(),
        measuredPercent,
        autoAtGeneration: true,
      };
    }
  }

  const commercialTerms = {
    roomTypeId,
    useType: entry.useType,
    resolvedRatePlanId: pricing.resolvedRatePlanId,
    resolvedRatePlanType: pricing.resolvedRatePlanType,
    resolvedNightlyRate,
    effectiveRate,
    msrValue: pricing.msrValue,
    belowMsr: agentRate ? false : pricing.belowMsr,
    isDeterrentRateApplied: pricing.isDeterrentRateApplied,
    resolutionPath,
    currency,
    // Meal plan + extra bed (Track A). `inclusions` carries the human-readable label (works even
    // for non-contracted bookings); `mealPlanPricing` / `extraBed` / `perNightTotal` carry the
    // priced breakdown, populated only when an agent/corporate rate card supplied the rates.
    mealPlan,
    inclusions: mealPlan ? [`Meal plan: ${mealPlan}`] : [],
    ...(mealPricing
      ? {
          mealPlanPricing: {
            planRate: agentRate!.mealPlanRate,
            total: mealPricing.total,
            // Chargeable meal units = the age-band multipliers summed (2 adults + one 6–10 child
            // at 70% = 2.7). Kept for downstream consumers that read `units`.
            units: mealPricing.perGuest.reduce((sum, g) => sum + g.multiplier, 0),
            perGuest: mealPricing.perGuest,
            source: "registry.child.mealPricing",
          },
        }
      : {}),
    ...(extraBedCount > 0
      ? { extraBed: { count: extraBedCount, rate: extraBedRate, total: extraBedTotal, priced: extraBedRate != null } }
      : {}),
    roomRate: effectiveRate,
    mealTotal,
    extraBedTotal,
    perNightTotal,
    notes: input.notes?.trim() ? input.notes.trim() : undefined,
    requestedDiscount: requested ? { ...requested } : undefined,
    // The pipeline now genuinely folds the discount into the resolved rate on every path
    // (create / supersede / applyDiscount), so record what was actually applied here rather
    // than leaving it to whichever caller happened to set it — previously only applyDiscount
    // wrote this field, so a superseded round silently dropped it.
    ...(requested ? { discountAppliedPercent: requested.discountPercent } : {}),
    // The generation-time approval (2026-08-07): who held the authority when this quote was
    // generated. Its presence tells every consumer (incl. the desk) that no separate
    // "approve discount" step is pending; the matching S2.DISCOUNT.APPROVED trace is written
    // by the create/supersede transaction.
    ...(discountAuthority ? { discountAuthority } : {}),
    // Multi-room-aware pricing breakdown — always present so downstream can rely on it.
    roomCount,
    pricingBreakdown,
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
    ...(perGuestMealBreakdown ? { perGuestMealBreakdown } : {}),
    // Per-room composition track (Phase B, 2026-07-27). When populated, downstream services
    // (S4 confirmation freeze, S5 RoomAssignment hydration, S8 settlement, PDF renderers)
    // should prefer these numbers over the flat pricingBreakdown above.
    ...(input.roomCompositions && input.roomCompositions.length > 0
      ? {
          roomCompositions: input.roomCompositions,
          // Which rooms had their mandatory extra bed added automatically this round
          // (2026-08-12) — informational; the corrected count itself lives on the
          // composition rows above.
          ...(extraBedsAutoAdded ? { extraBedsAutoAdded } : {}),
          compositionTotals: compositionTotals
            ? {
                subtotal: Number(compositionTotals.subtotal.toFixed(2)),
                serviceCharge: Number(compositionTotals.serviceCharge.toFixed(2)),
                gst: Number(compositionTotals.gst.toFixed(2)),
                total: Number(compositionTotals.total.toFixed(2)),
                perRoom: compositionTotals.perRoom.map((r) => ({
                  roomId: r.roomId,
                  roomNumber: r.roomNumber,
                  nights: r.nights,
                  effectiveBreakfastPax: r.effectiveBreakfastPax,
                  effectiveLunchPax: r.effectiveLunchPax,
                  effectiveDinnerPax: r.effectiveDinnerPax,
                  roomRate: Number(r.roomRate.toFixed(2)),
                  extraBedRate: Number(r.extraBedRate.toFixed(2)),
                  breakfastRate: Number(r.breakfastRate.toFixed(2)),
                  lunchRate: Number(r.lunchRate.toFixed(2)),
                  dinnerRate: Number(r.dinnerRate.toFixed(2)),
                  subtotal: Number(r.subtotal.toFixed(2)),
                  serviceCharge: Number(r.serviceCharge.toFixed(2)),
                  gst: Number(r.gst.toFixed(2)),
                  total: Number(r.total.toFixed(2)),
                  // Meals across the stay + the night-by-night split. Only differs from
                  // `perNightMeals × nights` when the room has per-date plans; carried so the
                  // desk, the PDFs and the kitchen can show WHICH night differed and by how
                  // much, instead of just a total that doesn't reconcile to the nightly rate.
                  mealsSubtotal: Number(r.mealsSubtotal.toFixed(2)),
                  perNightMeals: Number(r.perNightMeals.toFixed(2)),
                  // Extra beds across the stay (2026-08-19) — `extraBedRate × count × nights`
                  // unless a night overrides the count (in-house setup change), in which case
                  // this is the only honest figure and `extraBedsVaryByNight` says so.
                  extraBedSubtotal: Number(r.extraBedSubtotal.toFixed(2)),
                  extraBedsVaryByNight: r.extraBedsVaryByNight,
                  perNightMealBreakdown: r.perNightMealBreakdown.map((n) => ({
                    date: n.date,
                    meals: Number(n.meals.toFixed(2)),
                    overridden: n.overridden,
                    extraBeds: n.extraBeds,
                  })),
                })),
              }
            : null,
          // Original (undiscounted) figures for the document's price display — present only
          // when a discount moved the rate. Slim shape: the document needs the per-room
          // originals and the totals, nothing else.
          ...(compositionTotalsPreDiscount
            ? {
                compositionTotalsPreDiscount: {
                  subtotal: Number(compositionTotalsPreDiscount.subtotal.toFixed(2)),
                  serviceCharge: Number(compositionTotalsPreDiscount.serviceCharge.toFixed(2)),
                  gst: Number(compositionTotalsPreDiscount.gst.toFixed(2)),
                  total: Number(compositionTotalsPreDiscount.total.toFixed(2)),
                  perRoom: compositionTotalsPreDiscount.perRoom.map((r) => ({
                    roomId: r.roomId,
                    total: Number(r.total.toFixed(2)),
                  })),
                },
              }
            : {}),
          // The booking discount as actually applied: what was asked for (percent OR flat
          // amount), the money it took off the grand total, and the same figure as a share of
          // that total — which is what the authority bands are written in and what any later
          // reader should quote. `netReduction` is where it was taken so tax follows it.
          ...(compositionDiscount ? { compositionDiscount } : {}),
        }
      : {}),
    // Phase C — agent / corporate negotiated rate, when applicable.
    ...(agentRate
      ? {
          agentRate: {
            rateCardId: agentRate.rateCardId,
            partyType: agentRate.partyType,
            partyId: agentRate.partyId,
            roomRate: agentRate.roomRate,
            roomRateSource: agentRate.roomRateSource,
            addOns: agentRate.addOns,
            cnbPercent: agentRate.cnbPercent,
            currency: agentRate.currency,
          },
          // Preserve the standard rate plan resolution as reference even when the agent rate is used.
          standardPricing: {
            resolvedRatePlanId: pricing.resolvedRatePlanId,
            effectiveRate: pricing.effectiveRate,
            msrValue: pricing.msrValue,
            belowMsr: pricing.belowMsr,
          },
        }
      : {}),
  };

  return {
    entry,
    segmentId,
    nextVersion,
    now,
    msrWaiver,
    commercialTerms,
    discountAuthority,
    compositionTotals,
    effectiveRate,
    roomCount,
    currency,
    // Legacy booking-wide add-ons. Only used when `compositionTotals` is null (the flat
    // per-night model); callers fold them into totalAmount once, not × roomCount.
    mealTotal,
    extraBedTotal,
  };
}

/**
 * Resolve a quotation's validity window (2026-08-06, operator ruling: validity is chosen when
 * the quote is GENERATED — under the generate-vs-send rule the generated quote IS the offer, so
 * its clock starts at creation and sending does not restart it).
 *
 * Rules:
 *  - An explicit ask is 1–30 whole days (hard cap 30). Omitted → `registry.quotationValidity.days`,
 *    else the `expiry.s2.quotationValidityDays` config.
 *  - The window must end BEFORE CHECK-IN — an offer for a stay cannot outlive the stay's start.
 *    An explicit over-ask is rejected naming the maximum; the admin DEFAULT is clamped silently
 *    (the operator didn't choose it, and erroring would make quotes uncreatable near arrival).
 *    Check-in within 24h clamps any window to check-in itself — no whole-day validity fits, so
 *    the largest expressible window is used.
 *  - Past or absent check-in → only the 1–30 rule applies.
 */
export async function resolveQuotationValidity(
  prisma: PrismaClient,
  entryId: string,
  requestedDays: number | undefined,
  now: Date,
): Promise<{ validUntil: Date; validDays: number }> {
  if (requestedDays != null && (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 30)) {
    throw new ValidationError("Quote validity must be between 1 and 30 days");
  }
  const policy = await getRegistryPolicy(prisma, "registry.quotationValidity.days");
  const registryDefault =
    policy && policy.enabled !== false && typeof policy.days === "number" ? (policy.days as number) : null;
  const days =
    requestedDays ?? registryDefault ?? (await requireActiveConfigValue<number>(prisma, "expiry.s2.quotationValidityDays"));
  if (!Number.isFinite(days) || days < 1) throw new ValidationError("validDays must be >= 1");

  let validUntil = new Date(now.getTime() + Number(days) * 86400_000);
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { checkInDate: true } });
  const checkIn = entry?.checkInDate ?? null;
  if (checkIn && checkIn > now && validUntil > checkIn) {
    const maxDays = Math.floor((checkIn.getTime() - now.getTime()) / 86400_000);
    if (requestedDays != null && maxDays >= 1) {
      throw new ValidationError(
        `Quote validity must end before check-in (${checkIn.toISOString().slice(0, 10)}) — at most ${maxDays} day${maxDays === 1 ? "" : "s"} from today`,
      );
    }
    validUntil = checkIn;
  }
  return { validUntil, validDays: Number(days) };
}

/** Arm the W15 validity clock on a freshly created DRAFT — same record shape `sendQuotation`
 *  writes, so the desk's timer feed labels and counts it identically ("Quote validity"). */
async function armDraftValidityTimerTx(
  tx: Prisma.TransactionClient,
  q: { id: string; entryId: string },
  validUntil: Date,
  actorId: string,
) {
  const engine = await getTimerEngine();
  const jobId = await engine.schedule("QUOTATION_VALIDITY_W15", { quotationId: q.id }, { startAfter: validUntil });
  await tx.timerRecord.create({
    data: {
      entryId: q.entryId,
      entityType: "Quotation",
      entityId: q.id,
      timerType: "QUOTATION_VALIDITY_W15",
      timerCode: "QUOTATION_VALIDITY_W15",
      stageContext: Stage.S2,
      dueAt: validUntil,
      firesAt: validUntil,
      status: "SCHEDULED",
      createdBy: actorId,
      pgBossJobId: jobId,
      payload: { quotationId: q.id },
    },
  });
}

export async function createQuotation(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: QuotationDraftInput,
) {
  const {
    segmentId,
    nextVersion,
    now,
    msrWaiver,
    commercialTerms,
    discountAuthority,
    compositionTotals,
    effectiveRate,
    roomCount,
    currency,
    mealTotal,
    extraBedTotal,
  } = await prepareQuotationDraft(prisma, entryId, actorId, input);

  // Validity starts NOW — at generation, not at send (2026-08-06 operator ruling).
  const validity = await resolveQuotationValidity(prisma, entryId, input.validDays, now);

  return prisma.$transaction(async (tx) => {
    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const);
    const created = await tx.quotation.create({
      data: {
        // Use the readable QUO-YYYYMMDD-NNNN as the primary key so downstream FKs
        // (QuotationLine.quotationId) hold the readable value, not a UUID. Matches the
        // Invoice pattern.
        id: referenceNumber,
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        validUntil: validity.validUntil,
        commercialTerms: commercialTerms as any,
        // totalAmount, two regimes:
        //   - Per-room compositions supplied → the composition STAY-TOTAL (tax-inclusive sum
        //     across rooms × nights) — what the guest actually pays for the whole stay.
        //   - Otherwise the legacy per-night figure: per-room rate × roomCount plus the
        //     booking-wide meal/extra-bed add-ons (added once, NOT × roomCount — they're
        //     already computed for all guests). Downstream × nights = the stay total.
        // Both Decimal-safe so 4999.99 × 3 rooms doesn't drift.
        totalAmount: compositionTotals
          ? round2(compositionTotals.total)
          : round2(sumMoney([mulMoney(effectiveRate, roomCount), mealTotal, extraBedTotal])),
        currency: input.currency?.trim() ? input.currency.trim() : currency?.trim() ? currency : "BTN",
        createdBy: actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.CREATED",
        actorId,
        actorLevel: msrWaiver ? ActorLevel.L3 : ActorLevel.L1,
        entityType: "Quotation",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId,
        payload: {
          quotationId: created.id,
          entryId,
          segmentId,
          versionNumber: nextVersion,
          validUntil: validity.validUntil.toISOString(),
          msrGmWaiver: Boolean(msrWaiver),
        },
        createdBy: actorId,
      },
    });
    // The countdown is real from this moment — W15 expires a lapsed DRAFT, and the desk's
    // timer feed shows "Quote validity" alongside the other clocks.
    await armDraftValidityTimerTx(tx, { id: created.id, entryId }, validity.validUntil, actorId);
    // Discount approved AT generation (2026-08-07): the generating actor held the authority
    // (checked in prepareQuotationDraft), so the approval trace lands with the creation and
    // the p23 send / S2-exit gate is satisfied from birth — no post-hoc approval step.
    if (discountAuthority) {
      await tx.traceEvent.create({
        data: {
          eventType: "S2.DISCOUNT.APPROVED",
          actorId,
          actorLevel: discountAuthority.approvedLevel,
          entityType: "Quotation",
          entityId: created.id,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          entryId,
          payload: {
            quotationId: created.id,
            discountPercent: discountAuthority.measuredPercent,
            autoAtGeneration: true,
          },
          createdBy: actorId,
        },
      });
    }
    if (msrWaiver) {
      await tx.traceEvent.create({
        data: {
          eventType: "QUOTATION.MSR_GM_WAIVED",
          actorId,
          actorLevel: ActorLevel.L3,
          entityType: "Quotation",
          entityId: created.id,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          inquiryId: null,
          entryId,
          payload: { quotationId: created.id, msrGmWaiver: msrWaiver },
          createdBy: actorId,
        },
      });
    }
    return created;
  });
}

/** SIG-S2 §6.1 — group quotation path (Policies 19, 37, 65). */
export async function createGroupQuotation(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    notes?: string;
    currency?: string;
    focRoomsRequested?: number;
    belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
      guestProfile: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS2ForQuotationCreation({ currentStage: entry.currentStage });
  enforceGroupRateContextForS2Quotation({ useType: entry.useType, guestCount: entry.guestCount });

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const preferredCfg = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  enforceSealedPreferredAvailabilityConfigurationForS2Quotation({ preferred: preferredCfg });
  const preferred = preferredCfg!;
  // Multi-room-safe: same helper as the single-party path.
  const sealed = readOptionSelected(preferred.optionSelected);
  let roomTypeId: string | undefined = (preferred.searchCriteria as any)?.roomTypeId;
  if (!roomTypeId || typeof roomTypeId !== "string") {
    const anyRoomId = firstRoomId(sealed);
    if (anyRoomId) {
      const selectedRoom = await prisma.room.findUnique({ where: { id: anyRoomId }, select: { roomTypeId: true } });
      roomTypeId = selectedRoom?.roomTypeId;
    }
  }
  enforceRoomTypeResolvedForS2Quotation({ roomTypeId });

  // For group quotations, roomsRequested was historically guestCount — but with the new
  // multi-room selection the operator can explicitly seal N rooms independent of guest
  // count. Prefer the sealed room count when >0, fall back to entry.numberOfRooms, fall
  // back to guestCount (legacy behavior).
  const roomsRequested = Math.max(
    1,
    sealed.distinctRoomIds.length > 0 ? sealed.distinctRoomIds.length : entry.numberOfRooms ?? Number(entry.guestCount ?? 1),
  );
  const focN = input.focRoomsRequested;
  if (focN != null && Number.isFinite(focN) && focN >= 1) {
    await enforceFocEntitlementForS2GroupQuotation(prisma, {
      entryId,
      roomsRequested,
      focRoomsRequested: Math.floor(focN),
    });
  }

  const tier = entry.guestProfile?.clientTier;
  const isDeficientGuestTier = tier === "CAUTION" || tier === "RESTRICTED";
  const stay = entry.checkInDate && entry.checkOutDate ? { checkIn: entry.checkInDate, checkOut: entry.checkOutDate } : undefined;
  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, { groupSize: roomsRequested, isDeficientGuestTier, roomTypeId, stay });
  const msrWaiver = await resolveBelowMsrGmWaiverForS2(prisma, {
    belowMsr: pricing.belowMsr,
    actorId,
    waiver: input.belowMsrGmWaiver ?? null,
  });

  const requested = input.requestedDiscount ?? null;
  // Group quotations price flat, with no composition table — so there is no grand total for a
  // flat amount to be measured against. Percent only here.
  if (requested?.discountAmount != null) {
    throw new ValidationError("A group quotation discount must be a percentage, not a flat amount");
  }
  if (requested?.discountPercent != null) {
    await validateDiscountRequestAgainstAuthorityBands(prisma, {
      discountPercent: requested.discountPercent,
      discountBasis: requested.discountBasis,
    });
  }

  const last = await prisma.quotation.findFirst({ where: { entryId, segmentId }, orderBy: { versionNumber: "desc" } });
  const nextVersion = (last?.versionNumber ?? 0) + 1;

  const commercialTerms = {
    roomTypeId,
    useType: entry.useType,
    groupSize: roomsRequested,
    path: "GROUP",
    resolvedRatePlanId: pricing.resolvedRatePlanId,
    resolvedRatePlanType: pricing.resolvedRatePlanType,
    resolvedNightlyRate: pricing.resolvedNightlyRate,
    effectiveRate: pricing.effectiveRate,
    msrValue: pricing.msrValue,
    appliedGroupBand: pricing.appliedGroupBand,
    resolutionPath: pricing.resolutionPath,
    currency: pricing.currency,
    belowMsr: pricing.belowMsr,
    isDeterrentRateApplied: pricing.isDeterrentRateApplied,
    inclusions: [],
    notes: input.notes?.trim() ? input.notes.trim() : undefined,
    requestedDiscount: requested ? { ...requested } : undefined,
    focRoomsRequested: focN != null && Number.isFinite(focN) ? Math.floor(focN) : undefined,
    // Same multi-room-aware pricing breakdown as the single-party path.
    roomCount: roomsRequested,
    pricingBreakdown: (() => {
      const nights = stay && stay.checkIn && stay.checkOut
        ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
        : 1;
      // Decimal-safe subtotal (rate × nights × rooms).
      const subTotalDec = round2(mulMoney(mulMoney(pricing.effectiveRate, nights), roomsRequested));
      return {
        nightlyRate: pricing.effectiveRate,
        nights,
        roomCount: roomsRequested,
        subTotal: Number(subTotalDec.toFixed(2)),
      };
    })(),
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const, now);
    const created = await tx.quotation.create({
      data: {
        // Readable ID as primary key — see comment in createQuotation above.
        id: referenceNumber,
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        commercialTerms: commercialTerms as any,
        // Group quotations: same shape as single-party — totalAmount = per-room rate × roomCount.
        // Decimal-safe.
        totalAmount: round2(mulMoney(pricing.effectiveRate, roomsRequested)),
        currency: input.currency?.trim() ? input.currency.trim() : pricing.currency?.trim() ? pricing.currency : "BTN",
        createdBy: actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.GROUP_CREATED",
        actorId,
        actorLevel: msrWaiver ? ActorLevel.L3 : ActorLevel.L1,
        entityType: "Quotation",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId,
        payload: { quotationId: created.id, entryId, segmentId, groupSize: roomsRequested, msrGmWaiver: Boolean(msrWaiver) },
        createdBy: actorId,
      },
    });
    if (msrWaiver) {
      await tx.traceEvent.create({
        data: {
          eventType: "QUOTATION.MSR_GM_WAIVED",
          actorId,
          actorLevel: ActorLevel.L3,
          entityType: "Quotation",
          entityId: created.id,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          inquiryId: null,
          entryId,
          payload: { quotationId: created.id, msrGmWaiver: msrWaiver, path: "GROUP" },
          createdBy: actorId,
        },
      });
    }
    return created;
  });
}

/**
 * Field-level diff between two commercialTerms blobs for the supersede audit trail
 * (2026-07-28). Shallow-compares every top-level key; when `roomCompositions` differs,
 * additionally produces a per-room breakdown of exactly which fields moved (keyed by
 * roomId) so an auditor can read "room 202: mealPlanCpCount 1→2" without JSON-diffing
 * the snapshots by hand.
 */
function diffQuotationTerms(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): {
  changedFields: string[];
  changes: Record<string, { before: unknown; after: unknown }>;
  roomCompositionChanges?: Record<string, Record<string, { before: unknown; after: unknown }>>;
} {
  const b = before ?? {};
  const a = after ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const changedFields: string[] = [];
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of keys) {
    if (JSON.stringify((b as any)[k]) !== JSON.stringify((a as any)[k])) {
      changedFields.push(k);
      // Snapshots of large sub-objects (roomCompositions, compositionTotals) are still
      // included — trace payloads are JSONB and these are the fields the auditor cares about.
      changes[k] = { before: (b as any)[k] ?? null, after: (a as any)[k] ?? null };
    }
  }

  let roomCompositionChanges: Record<string, Record<string, { before: unknown; after: unknown }>> | undefined;
  if (changedFields.includes("roomCompositions")) {
    const beforeRooms = new Map(
      (Array.isArray((b as any).roomCompositions) ? (b as any).roomCompositions : []).map((r: any) => [r.roomId, r]),
    );
    const afterRooms = new Map(
      (Array.isArray((a as any).roomCompositions) ? (a as any).roomCompositions : []).map((r: any) => [r.roomId, r]),
    );
    roomCompositionChanges = {};
    for (const roomId of new Set([...beforeRooms.keys(), ...afterRooms.keys()])) {
      const br = (beforeRooms.get(roomId) ?? {}) as Record<string, unknown>;
      const ar = (afterRooms.get(roomId) ?? {}) as Record<string, unknown>;
      const fieldKeys = new Set([...Object.keys(br), ...Object.keys(ar)]);
      const roomDiff: Record<string, { before: unknown; after: unknown }> = {};
      for (const fk of fieldKeys) {
        if (fk === "roomId") continue;
        if (JSON.stringify(br[fk]) !== JSON.stringify(ar[fk])) {
          roomDiff[fk] = { before: br[fk] ?? null, after: ar[fk] ?? null };
        }
      }
      if (Object.keys(roomDiff).length > 0) roomCompositionChanges[String(roomId)] = roomDiff;
    }
  }

  return { changedFields, changes, ...(roomCompositionChanges ? { roomCompositionChanges } : {}) };
}

/**
 * Regenerate the quotation as a fresh DRAFT version (SIG-S2 renegotiation round).
 *
 * 2026-07-28 rebuild: instead of copying the prior version's commercialTerms verbatim,
 * this now re-runs the FULL pricing pipeline (`prepareQuotationDraft` — the same one
 * `createQuotation` uses) with the renegotiated inputs, so discount changes AND per-room
 * composition changes (meal plans, extra beds, negotiated rates, FOC) re-price correctly.
 *
 * Merge semantics (regenerate = prior + deltas):
 *  - `roomCompositions` omitted → prior version's compositions carry forward unchanged.
 *  - `requestedDiscount` omitted → prior's carries forward; explicit `null` clears it.
 *  - `notes` omitted → prior's notes carry forward.
 *
 * The prior version: marked SUPERSEDED, linked to the successor via `supersededById`, all
 * its timers cancelled — INCLUDING the CommunicationRecord-anchored ACKNOWLEDGEMENT_WINDOW_W22
 * from its send (previously leaked as a ghost "Awaiting guest reply" chip, same class of bug
 * fixed in acceptQuotation).
 *
 * Audit: the `S2.QUOTATION.SUPERSEDED` trace carries a field-level diff (`changedFields`,
 * per-field before/after, and per-room composition changes) so the DB records exactly what
 * was renegotiated, by whom, and when.
 *
 * The new DRAFT then goes through the normal send flow — fresh QUO-… reference number, fresh
 * PDF render, fresh email + acknowledgement window.
 */
export async function supersedeQuotationWithNewDraft(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
  input: {
    notes?: string;
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    /** Validity of the regenerated draft — same rules as create; omitted → default, re-anchored to now. */
    validDays?: number;
    currency?: string;
    belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null;
    roomCompositions?: RoomCompositionServiceInput[];
    /** Legacy booking-wide model. Omit to carry the prior version's forward. */
    mealPlan?: MealPlanType | null;
    extraBedCount?: number;
    /** Verified session level (route-injected) — enables generation-time discount approval. */
    actorLevel?: "L1" | "L2" | "L3" | "L4";
  },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  enforceQuotationSupersedeAllowedState({ state: q.state });
  // Once this segment carries a live proforma (minted at S3 setup), the quote's terms are being
  // billed — renegotiation moves to the S3→S2 re-entry, never in-place (2026-08-06 ruling).
  enforceQuotationNotLockedByProforma({
    liveProformaId: (await findLiveProformaForCurrentSegment(prisma, q.entryId))?.id ?? null,
  });

  const priorTerms = (q.commercialTerms ?? {}) as Record<string, unknown>;

  // Regenerate = prior + deltas. Carry forward what the caller didn't touch so a
  // discount-only renegotiation doesn't silently drop the per-room composition (and vice versa).
  const mergedInput: QuotationDraftInput = {
    notes: input.notes?.trim() ? input.notes.trim() : ((priorTerms.notes as string | undefined) ?? undefined),
    requestedDiscount:
      input.requestedDiscount === undefined
        ? ((priorTerms.requestedDiscount as { discountPercent: number; discountBasis: string } | undefined) ?? null)
        : input.requestedDiscount,
    currency: input.currency,
    belowMsrGmWaiver: input.belowMsrGmWaiver ?? null,
    // Legacy booking-wide model must carry forward too — otherwise regenerating a quote that
    // was priced on `mealPlan` / `extraBedCount` silently drops those charges from the total.
    mealPlan: input.mealPlan !== undefined ? input.mealPlan : ((priorTerms.mealPlan as MealPlanType | null | undefined) ?? null),
    extraBedCount:
      input.extraBedCount !== undefined
        ? input.extraBedCount
        : ((priorTerms.extraBed as { count?: number } | undefined)?.count ?? 0),
    roomCompositions:
      input.roomCompositions !== undefined
        ? input.roomCompositions
        : ((priorTerms.roomCompositions as RoomCompositionServiceInput[] | undefined) ?? undefined),
    actorLevel: input.actorLevel,
  };

  // Full re-price with the same pipeline createQuotation uses (validations included).
  const prep = await prepareQuotationDraft(prisma, q.entryId, actorId, mergedInput);

  // Freeze the outgoing version's document before it is marked SUPERSEDED (2026-08-02,
  // operator ruling): a superseded version without a stored PDF can only recompose — and
  // while a quotation's own commercialTerms are immutable, the composition still reads live
  // context (entry dates, current tax config on the flat path). Rendering now pins the
  // document to exactly what this version said. Best-effort — a render failure degrades to
  // recomposition, never blocks the renegotiation.
  if (!q.pdfStorageKey) {
    try {
      await generateOrLoadQuotationPdf(prisma, q.id, actorId);
    } catch {
      /* recomposition fallback remains */
    }
  }

  const now = new Date();
  // A new round is a new offer: its validity re-anchors to now (explicit ask or default),
  // never inheriting the outgoing version's remaining clock.
  const validity = await resolveQuotationValidity(prisma, q.entryId, input.validDays, now);

  return prisma.$transaction(async (tx) => {
    // Cancel every timer belonging to the prior version — both the Quotation-anchored ones
    // (validity + ack tracker) and the CommunicationRecord-anchored acknowledgement window
    // from its send (the "Awaiting guest reply" chip).
    const engine = await getTimerEngine();
    const commClause = q.communicationRecordId
      ? [{ entityType: "CommunicationRecord", entityId: q.communicationRecordId, status: "SCHEDULED" as const }]
      : [];
    const timers = await tx.timerRecord.findMany({
      where: {
        OR: [{ entityType: "Quotation", entityId: quotationId, status: "SCHEDULED" }, ...commClause],
      },
      select: { id: true, pgBossJobId: true },
    });
    await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "QUOTATION_SUPERSEDED" },
    });

    const prior = await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.SUPERSEDED, supersededAt: now },
    });

    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const, now);
    const created = await tx.quotation.create({
      data: {
        // Readable ID as primary key — see comment in createQuotation above.
        id: referenceNumber,
        entryId: prior.entryId,
        segmentId: prior.segmentId,
        versionNumber: prep.nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        validUntil: validity.validUntil,
        commercialTerms: prep.commercialTerms as any,
        // Re-priced total (same rule as createQuotation): composition stay-total when
        // compositions present, else legacy per-night × roomCount PLUS the booking-wide
        // meal / extra-bed add-ons (added once, not × roomCount). Omitting the add-ons here
        // would silently under-price any legacy-model quote on regeneration.
        totalAmount: prep.compositionTotals
          ? round2(prep.compositionTotals.total)
          : round2(sumMoney([mulMoney(prep.effectiveRate, prep.roomCount), prep.mealTotal, prep.extraBedTotal])),
        currency: input.currency?.trim() ? input.currency.trim() : prep.currency?.trim() ? prep.currency : prior.currency,
        supersededById: null,
        createdBy: actorId,
      },
    });

    await tx.quotation.update({ where: { id: prior.id }, data: { supersededById: created.id } });

    // The new draft's validity clock, armed like create's — the prior version's was cancelled above.
    await armDraftValidityTimerTx(tx, { id: created.id, entryId: prior.entryId }, validity.validUntil, actorId);

    // Discount approved AT generation — same rule as createQuotation (2026-08-07): a
    // regenerated round with a discount is a fresh offer, approved by whoever generated it.
    if (prep.discountAuthority) {
      await tx.traceEvent.create({
        data: {
          eventType: "S2.DISCOUNT.APPROVED",
          actorId,
          actorLevel: prep.discountAuthority.approvedLevel,
          entityType: "Quotation",
          entityId: created.id,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          entryId: prior.entryId,
          payload: {
            quotationId: created.id,
            discountPercent: prep.discountAuthority.measuredPercent,
            autoAtGeneration: true,
          },
          createdBy: actorId,
        },
      });
    }

    // Field-level audit of exactly what the renegotiation changed.
    const diff = diffQuotationTerms(priorTerms, prep.commercialTerms as Record<string, unknown>);
    await tx.traceEvent.create({
      data: {
        eventType: "S2.QUOTATION.SUPERSEDED",
        actorId,
        actorLevel: prep.msrWaiver ? ActorLevel.L3 : ActorLevel.L1,
        entityType: "Quotation",
        entityId: prior.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S2,
        entryId: prior.entryId,
        payload: {
          priorQuotationId: prior.id,
          newQuotationId: created.id,
          priorVersion: prior.versionNumber,
          newVersion: prep.nextVersion,
          priorTotalAmount: prior.totalAmount?.toString?.() ?? null,
          newTotalAmount: created.totalAmount?.toString?.() ?? null,
          ...diff,
        } as any,
        createdBy: actorId,
      },
    });

    return created;
  });
}

export async function approveDiscount(prisma: PrismaClient, quotationId: string, actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  const discount = (q.commercialTerms as any)?.requestedDiscount;
  if (!discount) throw new ValidationError("No requestedDiscount present on quotation");
  // A flat-amount discount has no discountPercent — authority is measured by its share of the
  // grand total, which the pricing run stored as compositionDiscount.effectivePercent. Without
  // the fallback an amount-based request would be gated against NaN.
  const pct = Number(
    discount.discountPercent ?? (q.commercialTerms as any)?.compositionDiscount?.effectivePercent,
  );
  if (!Number.isFinite(pct)) throw new ValidationError("Quotation's discount carries no measurable percent");
  await enforceDiscountApprovalAuthority(prisma, { actorLevel: actor.actorLevel, discountPercent: pct });

  const now = new Date();
  await prisma.traceEvent.create({
    data: {
      eventType: "S2.DISCOUNT.APPROVED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Quotation",
      entityId: quotationId,
      operation: "APPROVE",
      timestamp: now,
      stageContext: Stage.S2,
      entryId: q.entryId,
      payload: {
        quotationId,
        discountPercent: pct,
        discountAmount: discount.discountAmount ?? null,
        discountBasis: discount.discountBasis ?? null,
      },
      createdBy: actor.actorId,
    },
  });
  return { ok: true } as const;
}

/**
 * SIG-S2 §6.1 — Policy 23: apply a discount to a DRAFT quotation, re-pricing in place.
 *
 * 2026-07-28 rebuild. The previous implementation had four defects that together produced a
 * quotation whose stored total, whose commercialTerms, and whose already-rendered PDF all
 * disagreed with each other:
 *
 *  1. It ignored per-room composition entirely — recomputing `totalAmount` as
 *     `effectiveRate × roomCount` (a PRE-TAX NIGHTLY figure) and overwriting a
 *     composition-derived stay total that was tax-INCLUSIVE. The two numbers weren't
 *     comparable quantities, so the "discount" could appear to raise or slash the price
 *     arbitrarily.
 *  2. It left `commercialTerms.compositionTotals` untouched, so the row carried a stale
 *     pre-discount breakdown alongside the new total.
 *  3. It re-resolved the rate plan WITHOUT `roomTypeId` / `stay`, silently selecting a
 *     different (room-type-blind, season-blind) plan than creation had used — the base rate
 *     could move on its own before the discount was even applied.
 *  4. It never invalidated the rendered PDF, so a quote previewed before the discount was
 *     emailed to the guest showing the old price.
 *
 * Now it re-runs `prepareQuotationDraft` — the same pipeline `createQuotation` and
 * `supersedeQuotationWithNewDraft` use — with the prior version's compositions plus the new
 * discount, then writes the result in place and detaches any stale PDF.
 */
/**
 * The live PROFORMA of the entry's CURRENT segment, if any. Once it exists the quotation is
 * FINAL (2026-08-06, operator ruling) — the proforma bills the quote's terms, so in-place
 * renegotiation (supersede / applyDiscount) is blocked and the formal path is the S3→S2
 * re-entry. Segment-windowed because a sealed segment's superseded paperwork must not lock
 * the fresh segment's negotiation.
 */
async function findLiveProformaForCurrentSegment(prisma: PrismaClient, entryId: string) {
  const seg = await prisma.segment.findFirst({
    where: { entryId },
    orderBy: { segmentNumber: "desc" },
    select: { startedAt: true },
  });
  return prisma.invoice.findFirst({
    where: {
      entryId,
      invoiceType: InvoiceType.PROFORMA,
      state: { not: InvoiceState.SUPERSEDED },
      supersededById: null,
      ...(seg?.startedAt ? { createdAt: { gte: seg.startedAt } } : {}),
    },
    select: { id: true },
  });
}

export async function applyDiscount(
  prisma: PrismaClient,
  quotationId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { discountPercent: number; discountBasis: string; belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  if (q.state !== QuotationState.DRAFT) {
    throw new StateTransitionError("Discounts may only be applied to DRAFT quotations");
  }
  // Same lock as supersede — a discount re-prices the quote in place, which the issued
  // proforma would no longer reflect.
  enforceQuotationNotLockedByProforma({
    liveProformaId: (await findLiveProformaForCurrentSegment(prisma, q.entryId))?.id ?? null,
  });
  await enforceDiscountApprovalAuthority(prisma, { actorLevel: actor.actorLevel, discountPercent: input.discountPercent });

  const priorTerms = (q.commercialTerms ?? {}) as Record<string, unknown>;
  const priorTotal = Number(q.totalAmount);

  // Re-price through the shared pipeline: correct rate plan (room type + season aware),
  // discount folded into the rate, per-room compositions carried forward and re-costed with
  // the discounted room rate, service charge and GST recomputed on the new base.
  const prep = await prepareQuotationDraft(prisma, q.entryId, actor.actorId, {
    notes: (priorTerms.notes as string | undefined) ?? undefined,
    requestedDiscount: { discountPercent: input.discountPercent, discountBasis: input.discountBasis },
    belowMsrGmWaiver: input.belowMsrGmWaiver ?? null,
    roomCompositions: (priorTerms.roomCompositions as RoomCompositionServiceInput[] | undefined) ?? undefined,
    actorLevel: actor.actorLevel,
  });

  const commercialTerms = {
    ...prep.commercialTerms,
    discountAppliedPercent: input.discountPercent,
  };
  // Same rule as createQuotation — the legacy branch must keep the booking-wide meal /
  // extra-bed add-ons, or re-pricing a discount silently drops them from the total.
  const newTotal = prep.compositionTotals
    ? round2(prep.compositionTotals.total)
    : round2(sumMoney([mulMoney(prep.effectiveRate, prep.roomCount), prep.mealTotal, prep.extraBedTotal]));

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: {
        totalAmount: newTotal,
        currency: prep.currency?.trim() ? prep.currency : q.currency,
        commercialTerms: commercialTerms as any,
      },
    });

    // The price moved — any PDF rendered from the old numbers (e.g. the desk's preview
    // button) must not be what the guest receives. Detaching bumps the render revision so
    // the next render writes a fresh artifact rather than colliding with write-once storage.
    await invalidateQuotationPdfArtifact(tx, quotationId);

    // The authority check passed above, so this application IS the approval (2026-08-07 —
    // same generation-time rule as create/supersede); the p23 send/S2-exit gate is satisfied.
    if (prep.discountAuthority) {
      await tx.traceEvent.create({
        data: {
          eventType: "S2.DISCOUNT.APPROVED",
          actorId: actor.actorId,
          actorLevel: prep.discountAuthority.approvedLevel,
          entityType: "Quotation",
          entityId: quotationId,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          entryId: q.entryId,
          payload: {
            quotationId,
            discountPercent: prep.discountAuthority.measuredPercent,
            autoAtGeneration: true,
          },
          createdBy: actor.actorId,
        },
      });
    }

    const msrWaiver = prep.msrWaiver;
    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.DISCOUNT_APPLIED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Quotation",
        entityId: quotationId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId: q.entryId,
        payload: {
          quotationId,
          discountPercent: input.discountPercent,
          discountBasis: input.discountBasis,
          priorTotal,
          newTotal: Number(newTotal.toFixed(2)),
          pricedFrom: prep.compositionTotals ? "PER_ROOM_COMPOSITION" : "FLAT_RATE",
          resolvedNightlyRate: (prep.commercialTerms as any).resolvedNightlyRate,
          effectiveRate: prep.effectiveRate,
          msrValue: (prep.commercialTerms as any).msrValue,
          msrGmWaiver: Boolean(msrWaiver),
          ...(prep.compositionTotals
            ? {
                compositionSubtotal: Number(prep.compositionTotals.subtotal.toFixed(2)),
                compositionServiceCharge: Number(prep.compositionTotals.serviceCharge.toFixed(2)),
                compositionGst: Number(prep.compositionTotals.gst.toFixed(2)),
              }
            : {}),
        } as any,
        createdBy: actor.actorId,
      },
    });
    if (msrWaiver) {
      await tx.traceEvent.create({
        data: {
          eventType: "QUOTATION.MSR_GM_WAIVED",
          actorId: actor.actorId,
          actorLevel: ActorLevel.L3,
          entityType: "Quotation",
          entityId: quotationId,
          operation: "APPROVE",
          timestamp: now,
          stageContext: Stage.S2,
          inquiryId: null,
          entryId: q.entryId,
          payload: { quotationId, context: "DISCOUNT_APPLIED", msrGmWaiver: msrWaiver },
          createdBy: actor.actorId,
        },
      });
    }
    return updated;
  });
}

/** SIG-S2 §6.1 — worker entrypoint for quotation expiry (Policy 7). */
export async function expireQuotation(
  prisma: PrismaClient,
  input: { quotationId?: string; timerRecordId?: string },
) {
  const now = new Date();
  const quotationId = typeof input.quotationId === "string" ? input.quotationId : undefined;
  if (!quotationId) return { skipped: true, reason: "MISSING_QUOTATION_ID" } as const;

  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return { skipped: true, reason: "QUOTATION_NOT_FOUND" } as const;
  // DRAFT expires too since validity starts at generation (2026-08-06) — the generated quote is
  // the offer whether or not it was emailed. ACCEPTED / SUPERSEDED / EXPIRED still skip.
  if (q.state !== QuotationState.SENT && q.state !== QuotationState.DRAFT) {
    return { skipped: true, reason: "NOT_EXPIRABLE_STATE" } as const;
  }
  if (q.validUntil && q.validUntil > now) return { skipped: true, reason: "NOT_DUE" } as const;

  const engine = await getTimerEngine();
  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.EXPIRED, expiredAt: now },
    });

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }

    const sched = await tx.timerRecord.findMany({
      where: {
        entityType: "Quotation",
        entityId: quotationId,
        status: "SCHEDULED",
        timerType: { in: ["QUOTATION_ACK_TRACKER", "QUOTATION_VALIDITY_W15"] },
      },
      select: { id: true, pgBossJobId: true },
    });
    await Promise.all(sched.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: sched.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "QUOTATION_EXPIRED" },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "S2.QUOTATION_EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Quotation",
        entityId: quotationId,
        operation: "EXPIRE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId: q.entryId,
        payload: { quotationId, entryId: q.entryId, validUntil: q.validUntil?.toISOString() ?? null },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, quotationId } as const;
}

export async function sendQuotation(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
  input: { validDays?: number; sentTo?: string; channel?: string; recipientAddress?: string },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  enforceQuotationInDraftToSend({ state: q.state });

  await enforceQuotationSendTimeGovernanceConfig(prisma);

  const discount = (q.commercialTerms as any)?.requestedDiscount;
  await enforceDiscountApprovalBeforeSend(prisma, { quotationId, hasDiscount: Boolean(discount) });

  // Validity is set at GENERATION since 2026-08-06 (operator ruling) — sending does not restart
  // the clock. A draft that carries a future `validUntil` keeps it; an explicit `validDays`
  // still wins (API compat — same 1–30 + before-check-in rules as create), and a legacy draft
  // with no window at all resolves the default, anchored to now.
  const now = new Date();
  const validUntil =
    input.validDays == null && q.validUntil && q.validUntil > now
      ? q.validUntil
      : (await resolveQuotationValidity(prisma, q.entryId, input.validDays, now)).validUntil;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.SENT, sentAt: now, validUntil, sentTo: input.sentTo ?? input.recipientAddress ?? null },
    });

    const doc = await documentGenerationService.generateQuotationDocument(tx as any, {
      quotationId,
      entryId: q.entryId,
      referenceNumber: q.referenceNumber,
    });

    const engine = await getTimerEngine();
    // The draft already carries a validity clock (armed at create) — cancel it before arming
    // the send-time one, so exactly ONE live "Quote validity" countdown ever exists.
    const staleValidity = await tx.timerRecord.findMany({
      where: { entityType: "Quotation", entityId: quotationId, timerType: "QUOTATION_VALIDITY_W15", status: "SCHEDULED" },
      select: { id: true, pgBossJobId: true },
    });
    await Promise.all(staleValidity.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: staleValidity.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REARMED_ON_SEND" },
    });
    const validityJobId = await engine.schedule(
      "QUOTATION_VALIDITY_W15",
      { quotationId },
      { startAfter: validUntil },
    );
    const ackWindow = await requireActiveConfigValue<Record<string, number>>(tx as any, "acknowledgement.windowPerType");
    const quotationAckSeconds = Number((ackWindow as any)?.quotation ?? 86400);
    const ackFireAt = new Date(now.getTime() + quotationAckSeconds * 1000);
    const ackJobId = await engine.schedule(
      "QUOTATION_ACK_TRACKER",
      { quotationId },
      { startAfter: ackFireAt },
    );

    const comm = await communicationService.sendOutboundQuotationCommunication(tx, {
      entryId: q.entryId,
      actorId,
      channel: input.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
      contentSummary: "Quotation document dispatched",
      acknowledgementTimeoutAt: ackFireAt,
      payload: {
        quotationId,
        recipient: input.sentTo ?? input.recipientAddress ?? null,
        channel: input.channel ?? null,
        documentStorageReference: doc.storageReference,
        documentTemplateKey: doc.templateKey,
      },
    });

    const commAckJobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
    await tx.communicationRecord.update({
      where: { id: comm.id },
      data: {
        payload: {
          quotationId,
          recipient: input.sentTo ?? input.recipientAddress ?? null,
          channel: input.channel ?? null,
          documentStorageReference: doc.storageReference,
          documentTemplateKey: doc.templateKey,
          pgBossJobId: commAckJobId,
        } as any,
      },
    });

    await tx.timerRecord.create({
      data: {
        entryId: q.entryId,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        // Which outbound message this window waits on — the desk labels the timer from it
        // ("Awaiting quotation guest reply"). S4/S5 senders already stamp theirs.
        stageContext: Stage.S2,
        dueAt: ackFireAt,
        firesAt: ackFireAt,
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: commAckJobId,
        payload: { communicationRecordId: comm.id },
      },
    });

    await tx.quotation.update({
      where: { id: quotationId },
      data: { communicationRecordId: comm.id },
    });

    await tx.timerRecord.create({
      data: {
        entryId: q.entryId,
        entityType: "Quotation",
        entityId: quotationId,
        timerType: "QUOTATION_VALIDITY_W15",
        timerCode: "QUOTATION_VALIDITY_W15",
        dueAt: validUntil,
        firesAt: validUntil,
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: validityJobId,
        payload: { quotationId },
      },
    });
    await tx.timerRecord.create({
      data: {
        entryId: q.entryId,
        entityType: "Quotation",
        entityId: quotationId,
        timerType: "QUOTATION_ACK_TRACKER",
        timerCode: "QUOTATION_ACK_TRACKER",
        dueAt: ackFireAt,
        firesAt: ackFireAt,
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: ackJobId,
        payload: { quotationId },
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.SENT",
        actorId,
        actorLevel: "L1",
        entityType: "Quotation",
        entityId: quotationId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId: q.entryId,
        payload: {
          quotationId,
          validUntil: validUntil.toISOString(),
          communicationRecordId: comm.id,
          documentStorageReference: doc.storageReference,
        },
        createdBy: actorId,
      },
    });

    return updatedRow;
  });

  // Phase 3 — outbound quotation email (best-effort, post-tx).
  await sendQuotationEmailBestEffort(prisma, quotationId);

  return updated;
}

async function sendQuotationEmailBestEffort(prisma: PrismaClient, quotationId: string) {
  const q = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { entry: { include: { guestProfile: true } } },
  });
  if (!q || !q.entry) return;
  const entry = q.entry;
  const terms = (q.commercialTerms as any) ?? {};
  const nightly = Number(terms.nightlyRate ?? terms.rate ?? terms.effectiveRate ?? 0);
  const currency = terms.currency ?? "BTN";
  const ci = entry.checkInDate ?? q.validUntil ?? new Date();
  const co = entry.checkOutDate ?? new Date(ci.getTime() + 86400_000);
  const nights = Math.max(1, Math.round((co.getTime() - ci.getTime()) / 86400_000));
  // Multi-room: read roomCount from commercialTerms (populated by createQuotation +
  // createGroupQuotation) or fall back to entry.numberOfRooms. Falls back to 1 for legacy
  // pre-multi-room quotations that don't have the field.
  const roomCount = Math.max(1, Number((terms as any).roomCount) || entry.numberOfRooms || 1);
  const breakdown = await computeStayCharges(prisma, nightly, nights, roomCount);
  const displayName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";

  const content = renderQuotationEmail({
    guestDisplayName: displayName,
    inquiryReadableId: entry.inquiryId,
    quotationRef: q.referenceNumber ?? q.id,
    checkInDate: ci,
    checkOutDate: co,
    guestCount: entry.guestCount ?? 1,
    nightlyRate: nightly,
    currency,
    breakdown,
    validUntil: q.validUntil ?? new Date(),
    ratePlanName: terms.ratePlanName ?? null,
  });

  // Generate the quotation PDF and attach it to the outbound email. Rendering is idempotent
  // — if the quotation was previously sent (retry / redispatch), the stored PDF is served
  // rather than re-rendered. Failure to render is non-fatal: the email still goes out with
  // the text body only, and the operator can retry via the manual endpoint.
  try {
    const artifact = await generateOrLoadQuotationPdf(prisma, q.id, q.createdBy ?? "SYSTEM");
    content.attachments = [
      {
        filename: `${artifact.invoiceNumber}-quotation.pdf`,
        content: artifact.bytes,
        contentType: "application/pdf",
      },
    ];
  } catch (e) {
    // Non-fatal: trace the render failure so ops sees it, then continue sending the text-only email.
    await prisma.traceEvent.create({
      data: {
        eventType: "QUOTATION.PDF_RENDER_FAILED",
        actorId: q.createdBy ?? "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Quotation",
        entityId: q.id,
        operation: "ALERT",
        timestamp: new Date(),
        entryId: entry.id,
        payload: { quotationId: q.id, error: (e as Error)?.message ?? String(e) },
        createdBy: q.createdBy ?? "SYSTEM",
      } as any,
    }).catch(() => {});
  }

  await dispatchStageEmailBestEffort(
    {
      prisma,
      entryId: entry.id,
      actorId: q.createdBy ?? "SYSTEM",
      inquiryId: entry.inquiryId,
      guestEmail: entry.guestProfile?.email ?? null,
      stage: Stage.S2,
      eventTypePrefix: "QUOTATION_EMAIL",
    },
    content,
  );
}

export async function acceptQuotation(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
  input: { acceptanceMethod?: "WRITTEN" | "VERBAL"; verbatimNote?: string } | undefined,
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  enforceQuotationSentToAccept({ state: q.state });
  const now = new Date();

  const method = input?.acceptanceMethod ?? "WRITTEN";
  if (method !== "WRITTEN" && method !== "VERBAL") throw new ValidationError("acceptanceMethod must be WRITTEN or VERBAL");
  if (method === "VERBAL" && !input?.verbatimNote?.trim()) throw new ValidationError("verbatimNote is required for VERBAL acceptance");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.ACCEPTED, acceptedAt: now, acceptedBy: actorId },
    });

    if (q.communicationRecordId) {
      await tx.communicationRecord.updateMany({
        where: { id: q.communicationRecordId },
        data: { acknowledgementStatus: "RECEIVED", acknowledgementReceivedAt: now },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.ACCEPTED",
        actorId,
        actorLevel: "L1",
        entityType: "Quotation",
        entityId: quotationId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId: q.entryId,
        payload: { quotationId, entryId: q.entryId, acceptanceMethod: method, verbatimNote: method === "VERBAL" ? input?.verbatimNote?.trim() : null },
        createdBy: actorId,
      },
    });

    // Cancel every timer this acceptance resolves:
    //   1. Timers anchored on the Quotation itself (QUOTATION_ACK_TRACKER, QUOTATION_VALIDITY_W15)
    //   2. The email-anchored ACKNOWLEDGEMENT_WINDOW_W22 pointing at the outbound quotation
    //      CommunicationRecord — previously left running, which the desk UI faithfully rendered
    //      as a ghost "Awaiting guest reply" row long after the quote was accepted (fixed 2026-07-28).
    const commClause = q.communicationRecordId
      ? [{ entityType: "CommunicationRecord", entityId: q.communicationRecordId, status: "SCHEDULED" as const }]
      : [];
    const timers = await tx.timerRecord.findMany({
      where: {
        OR: [
          { entityType: "Quotation", entityId: quotationId, status: "SCHEDULED" },
          ...commClause,
        ],
      },
      select: { id: true, pgBossJobId: true },
    });

    const engine = await getTimerEngine();
    await Promise.all(
      timers
        .map((t) => t.pgBossJobId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => engine.cancel(id)),
    );

    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "QUOTATION_ACCEPTED" },
    });
    return updated;
  });
}

export async function resolveAckOpenLoop(
  prisma: PrismaClient,
  quotationId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input:
    | { resolutionType?: "VERBAL_ACCEPTED" | "WRITTEN_ACCEPTED" | "CUSTODIAN_DECISION"; note?: string; decisionReason?: string }
    | undefined,
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");

  const resolutionType = input?.resolutionType ?? "CUSTODIAN_DECISION";
  if (!["VERBAL_ACCEPTED", "WRITTEN_ACCEPTED", "CUSTODIAN_DECISION"].includes(resolutionType)) {
    throw new ValidationError("resolutionType must be VERBAL_ACCEPTED | WRITTEN_ACCEPTED | CUSTODIAN_DECISION");
  }
  if (resolutionType === "CUSTODIAN_DECISION" && !input?.decisionReason?.trim()) {
    throw new ValidationError("decisionReason is required for CUSTODIAN_DECISION");
  }

  // Custodian resolution is an authority action (FOM+).
  enforceAckOpenLoopResolutionRequiresFom({ actorLevel: actor.actorLevel });

  const now = new Date();
  await prisma.traceEvent.create({
    data: {
      eventType: "S2.QUOTATION_ACK_OPEN_LOOP_RESOLVED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Quotation",
      entityId: quotationId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S2,
      inquiryId: null,
      entryId: q.entryId,
      payload: {
        quotationId,
        entryId: q.entryId,
        resolutionType,
        note: input?.note?.trim() ? input.note.trim() : null,
        decisionReason: resolutionType === "CUSTODIAN_DECISION" ? input?.decisionReason?.trim() : null,
      },
      createdBy: actor.actorId,
    },
  });

  return { ok: true, quotationId };
}

