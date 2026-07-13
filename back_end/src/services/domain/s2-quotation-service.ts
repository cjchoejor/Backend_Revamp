import type { PrismaClient } from "@prisma/client";
import { ActorLevel, QuotationState, Stage } from "@prisma/client";
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

/**
 * Phase C — look up the inquiry's linked TravelAgent or CorporateAccount (if any), then call
 * the rate-resolution helper. Returns null if no party is linked OR the linked party has no
 * active rate card. Callers use this to optionally override the standard rate plan resolution.
 */
async function resolveAgentRateForEntryQuotation(
  prisma: PrismaClient,
  args: { inquiryId: string; roomTypeId: string; asOf?: Date },
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
    });
  }
  if (inq.corporateAccountId) {
    return resolveAgentRate(prisma, {
      partyType: "CORPORATE",
      partyId: inq.corporateAccountId,
      roomTypeId: args.roomTypeId,
      asOf: args.asOf,
    });
  }
  return null;
}

export async function createQuotation(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
    notes?: string;
    currency?: string;
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
  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, { isDeficientGuestTier, roomTypeId, stay });

  // Phase C — if the inquiry is linked to a travel agent or corporate account with an active
  // rate card, override the standard pricing with the negotiated room rate (including per-room-type
  // override if present). Standard pricing stays as a reference inside commercialTerms.standardPricing
  // so the operator can see what the hotel's rate plan would have charged.
  const agentRate = entry.inquiryId
    ? await resolveAgentRateForEntryQuotation(prisma, { inquiryId: entry.inquiryId, roomTypeId: roomTypeId! })
    : null;
  const effectiveRate = agentRate ? agentRate.roomRate : pricing.effectiveRate;
  const resolvedNightlyRate = agentRate ? agentRate.roomRate : pricing.resolvedNightlyRate;
  const currency = agentRate ? agentRate.currency : pricing.currency;
  const resolutionPath = agentRate ? `${pricing.resolutionPath ?? ""} → AGENT_RATE_CARD` : pricing.resolutionPath;

  const msrWaiver = await resolveBelowMsrGmWaiverForS2(prisma, {
    // Agent rates are negotiated and not subject to MSR — only flag below-MSR when standard pricing applies.
    belowMsr: agentRate ? false : pricing.belowMsr,
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
    const bundle = await loadChildPolicyBundle(prisma);
    const breakdown = computeGroupMealCharge(
      {
        adultCount: entry.adultCount ?? 0,
        childAges: entry.childAges ?? [],
        adultMealRate,
        nights: nightsForMeals,
      },
      bundle,
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
  const pricingBreakdown = {
    nightlyRate: effectiveRate,
    nights: nightsForPricing,
    roomCount,
    subTotal: effectiveRate * nightsForPricing * roomCount,
  };

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
    inclusions: [],
    notes: input.notes?.trim() ? input.notes.trim() : undefined,
    requestedDiscount: requested ? { ...requested } : undefined,
    // Multi-room-aware pricing breakdown — always present so downstream can rely on it.
    roomCount,
    pricingBreakdown,
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
    ...(perGuestMealBreakdown ? { perGuestMealBreakdown } : {}),
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

  return prisma.$transaction(async (tx) => {
    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const);
    const created = await tx.quotation.create({
      data: {
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        commercialTerms: commercialTerms as any,
        // totalAmount now reflects the whole booking's per-night value (per-room rate ×
        // roomCount). Downstream × nights gives the true stay total; historical single-room
        // quotations had roomCount = 1 so this is backwards-compatible for them.
        totalAmount: effectiveRate * roomCount,
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
    pricingBreakdown: {
      nightlyRate: pricing.effectiveRate,
      nights: stay && stay.checkIn && stay.checkOut
        ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
        : 1,
      roomCount: roomsRequested,
      subTotal: pricing.effectiveRate * (stay && stay.checkIn && stay.checkOut
        ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
        : 1) * roomsRequested,
    },
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const, now);
    const created = await tx.quotation.create({
      data: {
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        commercialTerms: commercialTerms as any,
        // Group quotations: same shape as single-party — totalAmount = per-room rate × roomCount.
        totalAmount: pricing.effectiveRate * roomsRequested,
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

export async function supersedeQuotationWithNewDraft(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
  input: { notes?: string; requestedDiscount?: { discountPercent: number; discountBasis: string } | null },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  enforceQuotationSupersedeAllowedState({ state: q.state });

  const last = await prisma.quotation.findFirst({ where: { entryId: q.entryId, segmentId: q.segmentId }, orderBy: { versionNumber: "desc" } });
  const nextVersion = (last?.versionNumber ?? q.versionNumber ?? 0) + 1;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Cancel timers for the prior version if any exist.
    const engine = await getTimerEngine();
    const timers = await tx.timerRecord.findMany({
      where: { entityType: "Quotation", entityId: quotationId, status: "SCHEDULED" },
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

    const terms = { ...(prior.commercialTerms as any), notes: input.notes?.trim() ? input.notes.trim() : (prior.commercialTerms as any)?.notes };
    if (input.requestedDiscount) terms.requestedDiscount = input.requestedDiscount;

    const referenceNumber = await allocateReadableId(tx, "QUOTATION" as const, now);
    const created = await tx.quotation.create({
      data: {
        entryId: prior.entryId,
        segmentId: prior.segmentId,
        versionNumber: nextVersion,
        referenceNumber,
        state: QuotationState.DRAFT,
        commercialTerms: terms as any,
        totalAmount: prior.totalAmount,
        currency: prior.currency,
        supersededById: null,
        createdBy: actorId,
      },
    });

    await tx.quotation.update({ where: { id: prior.id }, data: { supersededById: created.id } });
    await tx.traceEvent.create({
      data: {
        eventType: "S2.QUOTATION.SUPERSEDED",
        actorId,
        actorLevel: "L1",
        entityType: "Quotation",
        entityId: prior.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S2,
        entryId: prior.entryId,
        payload: { priorQuotationId: prior.id, newQuotationId: created.id },
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

/** SIG-S2 §6.1 — Policy 23: apply discount to a DRAFT quotation (re-prices total from basis rate). */
export async function applyDiscount(
  prisma: PrismaClient,
  quotationId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { discountPercent: number; discountBasis: string; belowMsrGmWaiver?: { acknowledged: true; rationale: string } | null },
) {
  const q = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { entry: { include: { guestProfile: true } } },
  });
  if (!q) throw new NotFoundError("Quotation");
  if (q.state !== QuotationState.DRAFT) {
    throw new StateTransitionError("Discounts may only be applied to DRAFT quotations");
  }
  await validateDiscountRequestAgainstAuthorityBands(prisma, {
    discountPercent: input.discountPercent,
    discountBasis: input.discountBasis,
  });
  await enforceDiscountApprovalAuthority(prisma, { actorLevel: actor.actorLevel, discountPercent: input.discountPercent });

  const terms = (q.commercialTerms as any) ?? {};
  const priorTotal = Number(q.totalAmount);
  if (!Number.isFinite(priorTotal) || priorTotal <= 0) {
    throw new ValidationError("Quotation has no resolved base amount for discount application");
  }

  const ceilings = await resolveActorDiscountCeilings(prisma);
  const actorMaxDiscountPercent =
    actor.actorLevel === "L1"
      ? ceilings.l1MaxPercent
      : actor.actorLevel === "L2"
        ? ceilings.l2MaxPercent
        : ceilings.l3MaxPercent;

  const groupSize = typeof terms.groupSize === "number" && Number.isFinite(terms.groupSize) ? terms.groupSize : undefined;
  const tier = q.entry?.guestProfile?.clientTier;
  const isDeficientGuestTier = tier === "CAUTION" || tier === "RESTRICTED";

  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, {
    groupSize,
    discountPercentOffRequested: input.discountPercent,
    actorMaxDiscountPercent,
    isDeficientGuestTier,
  });
  if (!pricing.discountWithinAuthorityBounds) {
    throw new PolicyGateBlockedError(
      "DISCOUNT_AUTHORITY",
      "Requested discount exceeds the acting user's maximum discount authority",
    );
  }
  const msrWaiver = await resolveBelowMsrGmWaiverForS2(prisma, {
    belowMsr: pricing.belowMsr,
    actorId: actor.actorId,
    actorLevel: actor.actorLevel,
    waiver: input.belowMsrGmWaiver ?? null,
  });

  const commercialTerms = {
    ...terms,
    requestedDiscount: { discountPercent: input.discountPercent, discountBasis: input.discountBasis },
    discountAppliedPercent: input.discountPercent,
    resolvedRatePlanId: pricing.resolvedRatePlanId,
    resolvedRatePlanType: pricing.resolvedRatePlanType,
    resolvedNightlyRate: pricing.resolvedNightlyRate,
    effectiveRate: pricing.effectiveRate,
    msrValue: pricing.msrValue,
    belowMsr: pricing.belowMsr,
    resolutionPath: pricing.resolutionPath,
    currency: pricing.currency,
    appliedGroupBand: pricing.appliedGroupBand,
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
  };

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: {
        totalAmount: pricing.effectiveRate,
        currency: typeof pricing.currency === "string" && pricing.currency.trim() ? pricing.currency : q.currency,
        commercialTerms: commercialTerms as any,
      },
    });
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
          newTotal: pricing.effectiveRate,
          resolvedNightlyRate: pricing.resolvedNightlyRate,
          msrValue: pricing.msrValue,
          msrGmWaiver: Boolean(msrWaiver),
        },
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
  const breakdown = await computeStayCharges(prisma, nightly, nights);
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

    const timers = await tx.timerRecord.findMany({
      where: { entityType: "Quotation", entityId: quotationId, status: "SCHEDULED" },
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

