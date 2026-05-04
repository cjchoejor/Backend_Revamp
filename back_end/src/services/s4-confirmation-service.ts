import type { PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, HoldState, InventoryClaimState, InvoiceType, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";

function getNightlyRate(terms: any): number {
  if (typeof terms?.nightlyRate === "number") return terms.nightlyRate;
  if (typeof terms?.rate === "number") return terms.rate;
  if (typeof terms?.resolvedRateAmount === "number") return terms.resolvedRateAmount;
  return 0;
}

export async function confirmReservation(prisma: PrismaClient, entryId: string, actorId: string, input?: { version?: number }) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      quotations: { orderBy: { createdAt: "desc" } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      folio: { include: { invoices: true, billingModelTransitions: { orderBy: { createdAt: "desc" }, take: 1 } } },
      committedHold: true,
      cancellationDisclosure: true,
      guestProfile: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S3) throw new StageGateBlockedError("Entry must be at S3 to confirm", "NOT_AT_S3");
  if (input?.version == null) throw new ValidationError("version is required");
  if (entry.version !== input.version) throw new StateTransitionError("Entry version mismatch", "OPTIMISTIC_LOCK");

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const accepted = entry.quotations.find((q) => q.segmentId === segmentId && q.state === "ACCEPTED");
  if (!accepted) throw new StageGateBlockedError("Accepted quotation required", "NO_ACCEPTED_QUOTATION");

  if (!entry.folio) throw new StageGateBlockedError("Provisional folio required", "MISSING_FOLIO");
  // Authoritative: latest BillingModelTransitionRecord.toModel (SIG-S4 §2.1 sourcing table)
  const billingModel = entry.folio.billingModelTransitions[0]?.toModel;
  if (!billingModel) throw new StageGateBlockedError("Billing model fixation required", "MISSING_BILLING_MODEL");

  // Require cancellation disclosure record (simplified: use existing model).
  if (!entry.cancellationDisclosure) throw new PolicyGateBlockedError("CANCELLATION_DISCLOSURE_REQUIRED", "Cancellation disclosure record is required before confirmation");

  // Require at least one proforma invoice unless waived by config (not implemented in this slice).
  const hasProforma = entry.folio.invoices.some((i) => i.invoiceType === InvoiceType.PROFORMA);
  if (!hasProforma) throw new StageGateBlockedError("Proforma invoice required", "MISSING_PROFORMA_INVOICE");

  // Ensure hold exists; in this slice we create one if missing to keep flow unblocked.
  const hold = entry.committedHold;
  if (!hold) throw new StageGateBlockedError("CommittedHold required before confirmation", "MISSING_COMMITTED_HOLD");
  if (hold.state !== HoldState.PLACED) throw new StageGateBlockedError("CommittedHold must be PLACED to confirm", "HOLD_NOT_PLACED");
  if (!hold.roomId) throw new StageGateBlockedError("CommittedHold.roomId is required in this slice", "HOLD_MISSING_ROOM");

  // S4 readiness: H1 checklist must exist
  const h1Checklist = await requireActiveConfigValue<any>(prisma, "handoff.H1.checklist");
  const ackWindows = await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType");
  const voucherAckSeconds = Number((ackWindows as any)?.voucher ?? 172800);
  const preArrivalDays = await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1);

  const ceiling = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio.id } }).catch(() => null);

  return prisma.$transaction(async (tx) => {
    // Confirm hold
    await tx.committedHold.update({
      where: { id: hold.id },
      data: { state: HoldState.CONFIRMED, confirmedAt: new Date(), confirmedBy: actorId },
    });
    await tx.room.update({ where: { id: hold.roomId! }, data: { currentClaimState: InventoryClaimState.CONFIRMED } });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: hold.roomId!,
        entryId,
        fromState: InventoryClaimState.COMMITTED_HELD,
        toState: InventoryClaimState.CONFIRMED,
        actorId,
        reason: "S4_CONFIRMATION",
        effectiveFrom: new Date(),
      },
    });

    const frozenRate = getNightlyRate(accepted.commercialTerms as any);
    const frozenRatePlanId = (accepted.commercialTerms as any)?.ratePlanId ?? (accepted.commercialTerms as any)?.resolvedRatePlanId ?? "rp-slice";
    const frozenInclusions = (accepted.commercialTerms as any)?.inclusions ?? {};

    const res = await tx.reservation.create({
      data: {
        entryId,
        segmentId,
        frozenRate: frozenRate || 0,
        frozenRatePlanId,
        frozenInclusions,
        frozenCancellationTerms: entry.cancellationDisclosure?.disclosedTerms ?? {},
        frozenBillingModel: billingModel,
        frozenCheckInDate: entry.checkInDate ?? new Date(),
        frozenCheckOutDate: entry.checkOutDate ?? new Date(Date.now() + 86400_000),
        frozenGuestCount: entry.guestCount ?? 1,
        creditCeilingIfExtended: ceiling ? (ceiling.ceilingAmount as any) : null,
        confirmedAt: new Date(),
        confirmedBy: actorId,
        confirmationVoucherSent: true,
      },
    });

    // Voucher communication + acknowledgement window timer (simplified).
    const comm = await tx.communicationRecord.create({
      data: {
        entryId,
        channel: "EMAIL",
        commType: "CONFIRMATION_VOUCHER",
        stageContext: Stage.S4,
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
        acknowledgementStatus: "PENDING",
        acknowledgementTimeoutAt: new Date(Date.now() + voucherAckSeconds * 1000),
        actorId,
        payload: { reservationId: res.id },
        createdBy: actorId,
      },
    });

    const engine = await getTimerEngine();
    const ackJobId = await engine.schedule(
      "ACKNOWLEDGEMENT_WINDOW_W22",
      { communicationRecordId: comm.id },
      { startAfter: new Date(Date.now() + voucherAckSeconds * 1000) },
    );
    await tx.timerRecord.create({
      data: {
        entryId,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        dueAt: new Date(Date.now() + voucherAckSeconds * 1000),
        firesAt: new Date(Date.now() + voucherAckSeconds * 1000),
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: ackJobId,
        payload: { communicationRecordId: comm.id },
      },
    });

    // Register pre-arrival countdown (W4) relative to arrival date.
    const arrival = entry.checkInDate ?? new Date(Date.now() + 86400_000);
    const preArrivalAt = new Date(arrival.getTime() - Number(preArrivalDays) * 86400_000);
    const firesAt = preArrivalAt <= new Date() ? new Date() : preArrivalAt;
    const preArrJob = await engine.schedule("PRE_ARRIVAL_COUNTDOWN_W4", { entryId }, { startAfter: firesAt });
    await tx.timerRecord.create({
      data: {
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "PRE_ARRIVAL_COUNTDOWN_W4",
        timerCode: "PRE_ARRIVAL_COUNTDOWN_W4",
        stageContext: Stage.S4,
        dueAt: firesAt,
        firesAt,
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: preArrJob,
        payload: { entryId },
      },
    });

    // Ownership assignment + H1 creation (minimal)
    await tx.traceEvent.create({
      data: {
        eventType: "OWNERSHIP_ASSIGNED",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        inquiryId: entry.inquiryId,
        entryId,
        payload: { ownerActorId: actorId },
        createdBy: actorId,
      },
    });
    await tx.handoffRecord.create({
      data: {
        entryId,
        handoffType: HandoffType.H1,
        state: HandoffState.CREATED,
        fromRole: "RESERVATIONS",
        fromActorId: actorId,
        toRole: "FRONT_DESK",
        checklistContent: h1Checklist ?? {},
        createdBy: actorId,
        stageContext: Stage.S4,
        isAutoFulfilled: false,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "RESERVATION_CONFIRMED",
        actorId,
        actorLevel: "L1",
        entityType: "Reservation",
        entityId: res.id,
        operation: "CREATE",
        timestamp: new Date(),
        inquiryId: entry.inquiryId,
        entryId,
        payload: { reservationId: res.id },
        createdBy: actorId,
      },
    });

    const updated = await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S4, version: { increment: 1 } } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S4, enteredAt: new Date() } });
    return { reservation: res, entry: updated };
  });
}

