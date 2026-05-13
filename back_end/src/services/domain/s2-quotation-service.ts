import type { PrismaClient } from "@prisma/client";
import { ActorLevel, QuotationState, Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as documentGenerationService from "../infrastructure/document-generation-service.js";
import { enforceDiscountApprovalBeforeSend } from "../../policies/09-discount/p23-discount-send-requires-approval.js";
import { enforceDiscountApprovalAuthority } from "../../policies/09-discount/p23-discount-approval-authority.js";
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
import { enforceGroupRateContextForS2Quotation } from "../../policies/08-pricing-rate-plan/p65-group-rate-context-for-s2-quotation.js";
import { resolveBelowMsrGmWaiverForS2 } from "../../policies/08-pricing-rate-plan/p19-msr-gm-waiver-below-msr-s2.js";
import { enforceFocEntitlementForS2GroupQuotation } from "../../policies/15-foc/p37-foc-entitlement-for-s2-group-quotation.js";
import * as communicationService from "./communication-service.js";

function ref(versionNumber: number) {
  return `Q-${String(versionNumber).padStart(3, "0")}`;
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
  let roomTypeId: string | undefined = (preferred.searchCriteria as any)?.roomTypeId;
  if (!roomTypeId || typeof roomTypeId !== "string") {
    const selectedRoomId = (preferred.optionSelected as any)?.roomId;
    if (typeof selectedRoomId === "string" && selectedRoomId.length > 0) {
      const selectedRoom = await prisma.room.findUnique({ where: { id: selectedRoomId }, select: { roomTypeId: true } });
      roomTypeId = selectedRoom?.roomTypeId;
    }
  }
  enforceRoomTypeResolvedForS2Quotation({ roomTypeId });

  const tier = entry.guestProfile?.clientTier;
  const isDeficientGuestTier = tier === "CAUTION" || tier === "RESTRICTED";
  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, { isDeficientGuestTier });
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
  const now = new Date();

  const commercialTerms = {
    roomTypeId,
    useType: entry.useType,
    resolvedRatePlanId: pricing.resolvedRatePlanId,
    resolvedRatePlanType: pricing.resolvedRatePlanType,
    resolvedNightlyRate: pricing.resolvedNightlyRate,
    effectiveRate: pricing.effectiveRate,
    msrValue: pricing.msrValue,
    belowMsr: pricing.belowMsr,
    isDeterrentRateApplied: pricing.isDeterrentRateApplied,
    resolutionPath: pricing.resolutionPath,
    currency: pricing.currency,
    inclusions: [],
    notes: input.notes?.trim() ? input.notes.trim() : undefined,
    requestedDiscount: requested ? { ...requested } : undefined,
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const created = await tx.quotation.create({
      data: {
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber: ref(nextVersion),
        state: QuotationState.DRAFT,
        commercialTerms: commercialTerms as any,
        totalAmount: pricing.effectiveRate,
        currency: input.currency?.trim() ? input.currency.trim() : pricing.currency?.trim() ? pricing.currency : "BTN",
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
  let roomTypeId: string | undefined = (preferred.searchCriteria as any)?.roomTypeId;
  if (!roomTypeId || typeof roomTypeId !== "string") {
    const selectedRoomId = (preferred.optionSelected as any)?.roomId;
    if (typeof selectedRoomId === "string" && selectedRoomId.length > 0) {
      const selectedRoom = await prisma.room.findUnique({ where: { id: selectedRoomId }, select: { roomTypeId: true } });
      roomTypeId = selectedRoom?.roomTypeId;
    }
  }
  enforceRoomTypeResolvedForS2Quotation({ roomTypeId });

  const roomsRequested = Math.max(1, Number(entry.guestCount ?? 1));
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
  const pricing = await resolveRatePlanPricingForS2Quotation(prisma, { groupSize: roomsRequested, isDeficientGuestTier });
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
    ...(msrWaiver ? { msrGmWaiver: msrWaiver } : {}),
  };

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const created = await tx.quotation.create({
      data: {
        entryId,
        segmentId,
        versionNumber: nextVersion,
        referenceNumber: ref(nextVersion),
        state: QuotationState.DRAFT,
        commercialTerms: commercialTerms as any,
        totalAmount: pricing.effectiveRate,
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

    const created = await tx.quotation.create({
      data: {
        entryId: prior.entryId,
        segmentId: prior.segmentId,
        versionNumber: nextVersion,
        referenceNumber: ref(nextVersion),
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

  const maxFom = await requireActiveConfigValue<number>(prisma, "discount.fom.maxPercentage");
  const maxGm = await requireActiveConfigValue<number>(prisma, "discount.gm.maxPercentage");
  const actorMaxDiscountPercent =
    actor.actorLevel === "L1" ? maxFom : actor.actorLevel === "L2" ? maxGm : 100;

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

  const defaultValidityDays = await requireActiveConfigValue<number>(prisma, "expiry.s2.quotationValidityDays");
  const validDays = input.validDays ?? defaultValidityDays;
  if (!Number.isFinite(validDays) || validDays < 1) throw new ValidationError("validDays must be >= 1");
  const now = new Date();
  const validUntil = new Date(now.getTime() + validDays * 86400_000);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
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

    return updated;
  });
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

