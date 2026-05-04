import type { PrismaClient } from "@prisma/client";
import { EntryUseType, QuotationState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { resolveIndicativePricing } from "../engines/pricing-pipeline-engine.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";

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
  if (entry.currentStage !== Stage.S2) throw new StageGateBlockedError("Entry must be at S2 to create quotation", "NOT_AT_S2");
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Prefer the sealed preferred availability configuration as the only source of roomTypeId.
  const preferred = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  if (!preferred) throw new StageGateBlockedError("Sealed preferred AvailabilityConfiguration required", "NO_PREFERRED_CONFIGURATION");
  let roomTypeId: string | undefined = (preferred.searchCriteria as any)?.roomTypeId;
  if (!roomTypeId || typeof roomTypeId !== "string") {
    const selectedRoomId = (preferred.optionSelected as any)?.roomId;
    if (typeof selectedRoomId === "string" && selectedRoomId.length > 0) {
      const selectedRoom = await prisma.room.findUnique({ where: { id: selectedRoomId }, select: { roomTypeId: true } });
      roomTypeId = selectedRoom?.roomTypeId;
    }
  }
  if (!roomTypeId || typeof roomTypeId !== "string") throw new StageGateBlockedError("Preferred configuration missing roomTypeId", "MISSING_ROOM_TYPE");

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
    if (!Number.isFinite(requested.discountPercent) || requested.discountPercent <= 0 || requested.discountPercent > 100) {
      throw new ValidationError("requestedDiscount.discountPercent must be in (0, 100]");
    }
    if (!requested.discountBasis?.trim()) throw new ValidationError("requestedDiscount.discountBasis is required");

    const maxFom = await requireActiveConfigValue<number>(prisma, "discount.fom.maxPercentage");
    const maxGm = await requireActiveConfigValue<number>(prisma, "discount.gm.maxPercentage");
    if (requested.discountPercent > maxGm) {
      throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_GM", "Discount exceeds GM authority band");
    }
    if (requested.discountPercent > maxFom) {
      // At S2 creation time we treat this as a hard block unless the actor is L2+; actor levels are enforced at route layer,
      // and the approval TraceEvent is created by applyDiscount. This is just the "request" pre-check.
      throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_FOM", "Discount exceeds front desk authority band");
    }
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
  if (discount) {
    const approvals = await prisma.traceEvent.findMany({
      where: {
        eventType: "S2.DISCOUNT.APPROVED",
        entityType: "Quotation",
        entityId: quotationId,
      },
      orderBy: { timestamp: "desc" },
      take: 5,
    });
    if (!approvals.length) {
      throw new PolicyGateBlockedError("DISCOUNT_UNAPPROVED", "Quotation has a discount without recorded approval");
    }
  }

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

    const commAckJobId = await engine.schedule(
      "ACKNOWLEDGEMENT_WINDOW_W22",
      { communicationRecordId: `quotation:${quotationId}` },
      { startAfter: ackFireAt },
    );

    const comm = await tx.communicationRecord.create({
      data: {
        entryId: q.entryId,
        channel: input.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
        commType: "CONFIRMATION_VOUCHER", // placeholder type for this slice; S2 uses quotation docs (expanded in later pass).
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

