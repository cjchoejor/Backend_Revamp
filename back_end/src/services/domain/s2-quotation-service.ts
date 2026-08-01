import type { PrismaClient } from "@prisma/client";
import { ActorLevel, MealPlanType, QuotationState, Stage } from "@prisma/client";
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
import { resolveAgentRate, type AgentRateBreakdown } from "../../lib/agent-rate-resolution.js";
import { loadChildPolicyBundle, computeGroupMealCharge } from "./child-policy-service.js";
import { readOptionSelected, firstRoomId } from "../../lib/option-selected-reader.js";
import { mulMoney, round2, sumMoney, toDecimal } from "../../lib/money.js";
import { generateOrLoadQuotationPdf } from "./quotation-pdf-service.js";
import {
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
): Promise<AgentRateBreakdown | null> {
  const inq = await prisma.inquiry.findUnique({
    where: { id: args.inquiryId },
    select: { travelAgentId: true, corporateAccountId: true },
  });
  if (!inq) return null;
  if (inq.travelAgentId) {
    return resolveAgentRate(prisma, {
      partyType: "TRAVEL_AGENT",
      partyId: inq.travelAgentId,
      roomTypeId: args.roomTypeId,
      asOf: args.asOf,
      mealPlan: args.mealPlan,
    });
  }
  if (inq.corporateAccountId) {
    return resolveAgentRate(prisma, {
      partyType: "CORPORATE",
      partyId: inq.corporateAccountId,
      roomTypeId: args.roomTypeId,
      asOf: args.asOf,
      mealPlan: args.mealPlan,
    });
  }
  return null;
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
  }>;
};

/** Input shape shared by `createQuotation` and `supersedeQuotationWithNewDraft`. */
export type QuotationDraftInput = {
  requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
  notes?: string;
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
  if (requested) {
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
    discountPercentOffRequested: requested?.discountPercent,
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
  const resolutionPath = agentRate ? `${pricing.resolutionPath ?? ""} → AGENT_RATE_CARD` : pricing.resolutionPath;

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
  if (Array.isArray(input.roomCompositions) && input.roomCompositions.length > 0) {
    // Fetch charge rates + hydrate room numbers for the perRoom breakdown.
    const { serviceChargeRate, gstRate } = await resolveChargeRates(prisma);
    const roomIds = input.roomCompositions.map((c) => c.roomId);
    const roomRows = await prisma.room.findMany({
      where: { id: { in: roomIds } },
      select: { id: true, roomNumber: true },
    });
    const numberByRoomId = new Map(roomRows.map((r) => [r.id, r.roomNumber]));

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

    // Validate each room's composition BEFORE pricing so we reject early with a friendly
    // error (rather than persisting bad data). Both policies are no-ops when key fields
    // are null so partially-filled draft submissions can still succeed.
    for (const c of input.roomCompositions) {
      const roomNumber = numberByRoomId.get(c.roomId) ?? null;
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
          startDate: c.startDate ? new Date(c.startDate) : stay?.checkIn ?? null,
          endDate: c.endDate ? new Date(c.endDate) : stay?.checkOut ?? null,
        },
        nightsForPricing,
      );
    }

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
      const ctx: RoomCompositionRateContext = {
        defaultRoomRate,
        defaultExtraBedRate: defaultExtraBed,
        defaultBreakfastRate: defaultBreakfast,
        defaultLunchRate: defaultLunch,
        defaultDinnerRate: defaultDinner,
        serviceChargeRate,
        gstRate,
        nights: nightsForPricing,
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
    const preRateDec = toDecimal(resolvedNightlyRate ?? 0);
    const postRateDec = toDecimal(effectiveRate ?? 0);
    if (requested && preRateDec.gt(postRateDec)) {
      const roomsPre = rooms.map((r) => ({ ...r, ctx: { ...r.ctx, defaultRoomRate: preRateDec } }));
      compositionTotalsPreDiscount = computeQuotationCompositionTotals(roomsPre);
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
                  perNightMealBreakdown: r.perNightMealBreakdown.map((n) => ({
                    date: n.date,
                    meals: Number(n.meals.toFixed(2)),
                    overridden: n.overridden,
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
    compositionTotals,
    effectiveRate,
    roomCount,
    currency,
    mealTotal,
    extraBedTotal,
  } = await prepareQuotationDraft(prisma, entryId, actorId, input);

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
        payload: { quotationId: created.id, entryId, segmentId, versionNumber: nextVersion, msrGmWaiver: Boolean(msrWaiver) },
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
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
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
  if (requested) {
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
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
    currency?: string;
    belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null;
    roomCompositions?: RoomCompositionServiceInput[];
    /** Legacy booking-wide model. Omit to carry the prior version's forward. */
    mealPlan?: MealPlanType | null;
    extraBedCount?: number;
  },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  enforceQuotationSupersedeAllowedState({ state: q.state });

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
  const pct = Number(discount.discountPercent);
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
      payload: { quotationId, discountPercent: pct, discountBasis: discount.discountBasis ?? null },
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
  if (q.state !== QuotationState.SENT) return { skipped: true, reason: "NOT_SENT" } as const;
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

  // Policy registry override: `registry.quotationValidity.days` (when enabled) replaces the
  // legacy `expiry.s2.quotationValidityDays` ConfigurationEntry. Per-quotation `input.validDays`
  // still wins over both — operator may always set a specific validity at send time.
  const quotationValidityPolicy = await getRegistryPolicy(prisma, "registry.quotationValidity.days");
  const registryDefaultValidity =
    quotationValidityPolicy && quotationValidityPolicy.enabled !== false && typeof quotationValidityPolicy.days === "number"
      ? (quotationValidityPolicy.days as number)
      : null;
  const defaultValidityDays =
    registryDefaultValidity ?? (await requireActiveConfigValue<number>(prisma, "expiry.s2.quotationValidityDays"));
  const validDays = input.validDays ?? defaultValidityDays;
  if (!Number.isFinite(validDays) || validDays < 1) throw new ValidationError("validDays must be >= 1");
  const now = new Date();
  const validUntil = new Date(now.getTime() + validDays * 86400_000);

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

