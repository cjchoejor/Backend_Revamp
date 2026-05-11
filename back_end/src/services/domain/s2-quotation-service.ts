import type { PrismaClient } from "@prisma/client";
import { EntryUseType, QuotationState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { resolveIndicativePricing } from "../../engines/pricing-pipeline-engine.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceDiscountApprovalBeforeSend } from "../../policies/09-discount/p23-discount-send-requires-approval.js";
import { enforceDiscountApprovalAuthority } from "../../policies/09-discount/p23-discount-approval-authority.js";
import { validateDiscountRequestAgainstAuthorityBands } from "../../policies/09-discount/p23-discount-request-constraints.js";
import { enforceAckOpenLoopResolutionRequiresFom } from "../../policies/20-communication-acknowledgement-tracking/p52-ack-open-loop-resolution-requires-fom.js";
import {
  enforceEntryAtS2ForQuotationCreation,
  enforceRoomTypeResolvedForS2Quotation,
  enforceSealedPreferredAvailabilityConfigurationForS2Quotation,
} from "../../policies/01-availability/p01-s2-create-quotation-configuration-gates.js";

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
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS2ForQuotationCreation({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Prefer the sealed preferred availability configuration as the only source of roomTypeId.
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

  // Rate plan resolution (Policy 19) — configuration-driven for this backend slice.
  const ratePlans = await requireActiveConfigValue<Array<{ id: string; type: any; rateAmount: number; currency: string }>>(
    prisma,
    "pricing.ratePlans",
  ).catch(() => {
    throw new MissingConfigurationError("pricing.ratePlans");
  });
  if (!Array.isArray(ratePlans) || ratePlans.length === 0) throw new MissingConfigurationError("pricing.ratePlans");

  const pricing = resolveIndicativePricing({ eligibleRatePlans: ratePlans });

  // Discount authority check (Policy 23) — validates request before record is written.
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
    resolvedRatePlanId: pricing.selectedRatePlanId,
    resolvedRateAmount: pricing.rateAmount,
    currency: pricing.currency,
    inclusions: [],
    notes: input.notes?.trim() ? input.notes.trim() : undefined,
    requestedDiscount: requested ? { ...requested } : undefined,
  };

  return prisma.quotation.create({
    data: {
      entryId,
      segmentId,
      versionNumber: nextVersion,
      referenceNumber: ref(nextVersion),
      state: QuotationState.DRAFT,
      commercialTerms: commercialTerms as any,
      totalAmount: pricing.rateAmount,
      currency: input.currency?.trim() ? input.currency.trim() : pricing.currency?.trim() ? pricing.currency : "BTN",
      createdBy: actorId,
    },
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
  if (q.state === QuotationState.ACCEPTED) throw new StateTransitionError("Cannot supersede an ACCEPTED quotation");
  if (q.state === QuotationState.EXPIRED) throw new StateTransitionError("Cannot supersede an EXPIRED quotation");
  if (q.state === QuotationState.SUPERSEDED) throw new StateTransitionError("Quotation already SUPERSEDED");

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

export async function sendQuotation(
  prisma: PrismaClient,
  quotationId: string,
  actorId: string,
  input: { validDays?: number; sentTo?: string; channel?: string; recipientAddress?: string },
) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) throw new NotFoundError("Quotation");
  if (q.state !== QuotationState.DRAFT) throw new StateTransitionError("Only DRAFT quotations can be sent");

  // Unapproved discount blocks send (Policy 23) — if a discount is present in terms, it must have an approval TraceEvent.
  const discount = (q.commercialTerms as any)?.requestedDiscount;
  await enforceDiscountApprovalBeforeSend(prisma, { quotationId, hasDiscount: Boolean(discount) });

  const validDays = input.validDays ?? 2;
  if (!Number.isFinite(validDays) || validDays < 1) throw new ValidationError("validDays must be >= 1");
  const now = new Date();
  const validUntil = new Date(now.getTime() + validDays * 86400_000);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.SENT, sentAt: now, validUntil, sentTo: input.sentTo ?? input.recipientAddress ?? null },
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

    const commAckJobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: "PENDING" }, { startAfter: ackFireAt });

    const comm = await tx.communicationRecord.create({
      data: {
        entryId: q.entryId,
        channel: input.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
        commType: "QUOTATION",
        stageContext: Stage.S2,
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
        acknowledgementStatus: "PENDING",
        acknowledgementTimeoutAt: ackFireAt,
        contentSummary: "Quotation document dispatched",
        actorId,
        payload: { quotationId, recipient: input.sentTo ?? input.recipientAddress ?? null, channel: input.channel ?? null, pgBossJobId: commAckJobId },
        createdBy: actorId,
      },
    });

    // Now that we have the CommunicationRecord id, schedule the W22 ack window timer against the real id.
    // Also store a TimerRecord so auditability matches the service's intent.
    const commAckJobId2 = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
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
        pgBossJobId: commAckJobId2,
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

    // (TimerRecord already created with commAckJobId2 above.)
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
  if (q.state !== QuotationState.SENT) throw new StateTransitionError("Only SENT quotations can be accepted");
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

