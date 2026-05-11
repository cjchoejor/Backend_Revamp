import type { PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, HoldState, InventoryClaimState, InvoiceType, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceHighValueConfirmationAuthority } from "../../policies/16-confirmation-authority/p40-confirmation-authority.js";
import { enforceMultiBookingAcknowledgedIfOverlappingReservationExists } from "../../policies/04-duplicate-detection/p13-multi-booking-ack-required.js";
import { enforceFocReverificationBeforeConfirmation } from "../../policies/15-foc/p39-foc-reverify-before-confirmation.js";
import { enforceOverbookingRequiresGmMitigationBeforeConfirmation } from "../../policies/17-overbooking/p41-overbooking-requires-gm-mitigation.js";
import { enforceConferenceVerificationBeforeConfirmation } from "../../policies/27-work-order/p67-conference-verification-required.js";
import { enforceCancellationDisclosurePresent } from "../../policies/14-cancellation/p34-cancellation-terms-disclosure-required.js";
import {
  enforceAcceptedQuotationPresentForS4Confirmation,
  enforceBillingModelFixatedForS4Confirmation,
  enforceCommittedHoldReadyForS4Confirmation,
  enforceEntryAtS3ForReservationConfirmation,
  enforceProformaInvoicePresentForS4Confirmation,
  enforceProvisionalFolioPresentForS4Confirmation,
} from "../../policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.js";

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
  enforceEntryAtS3ForReservationConfirmation({ currentStage: entry.currentStage });
  if (input?.version == null) throw new ValidationError("version is required");
  if (entry.version !== input.version) throw new StateTransitionError("Entry version mismatch", "OPTIMISTIC_LOCK");

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const acceptedCfg = entry.quotations.find((q) => q.segmentId === segmentId && q.state === "ACCEPTED");
  enforceAcceptedQuotationPresentForS4Confirmation({ hasAcceptedQuotation: !!acceptedCfg });
  const accepted = acceptedCfg!;

  // Policy 40 — confirmation authority (minimal: highValueAmount requires L2).
  const thresholds = await requireActiveConfigValue<any>(prisma, "confirmation.authorityThresholds").catch(() => ({}) as any);
  const rate = getNightlyRate(accepted.commercialTerms as any);
  await enforceHighValueConfirmationAuthority(prisma, { actorId, nightlyRate: rate, thresholds });

  enforceProvisionalFolioPresentForS4Confirmation({ folio: entry.folio });
  const folio = entry.folio!;
  // Authoritative: latest BillingModelTransitionRecord.toModel (SIG-S4 §2.1 sourcing table)
  const billingModel = folio.billingModelTransitions[0]?.toModel;
  enforceBillingModelFixatedForS4Confirmation({ billingModel });

  enforceCancellationDisclosurePresent({ hasCancellationDisclosure: !!entry.cancellationDisclosure });

  // Require at least one proforma invoice unless waived by config (not implemented in this slice).
  const hasProforma = folio.invoices.some((i) => i.invoiceType === InvoiceType.PROFORMA);
  enforceProformaInvoicePresentForS4Confirmation({ hasProformaInvoice: hasProforma });

  const holdCfg = entry.committedHold;
  enforceCommittedHoldReadyForS4Confirmation({ hold: holdCfg });
  const hold = holdCfg!;

  await enforceMultiBookingAcknowledgedIfOverlappingReservationExists(prisma, {
    entryId,
    guestProfileId: entry.guestProfileId,
    checkInDate: entry.checkInDate ?? new Date(),
    checkOutDate: entry.checkOutDate ?? new Date(Date.now() + 86400_000),
  });

  await enforceOverbookingRequiresGmMitigationBeforeConfirmation(prisma, { entryId, otaSource: entry.otaSource });

  if (entry.useType === "GROUP" || entry.useType === "CONFERENCE") {
    const roomsRequested = Number((accepted.commercialTerms as any)?.roomsRequested ?? 1);
    const focRoomsRequested = Number((accepted.commercialTerms as any)?.focRoomsRequested ?? 0);
    await enforceFocReverificationBeforeConfirmation(prisma, { entryId, useType: entry.useType, roomsRequested, focRoomsRequested });
  }

  await enforceConferenceVerificationBeforeConfirmation(prisma, { entryId, useType: entry.useType });

  // S4 readiness: H1 checklist must exist
  const h1Checklist = await requireActiveConfigValue<any>(prisma, "handoff.H1.checklist");
  const ackWindows = await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType");
  const voucherAckSeconds = Number((ackWindows as any)?.voucher ?? 172800);
  const preArrivalDays = await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1);

  const ceiling = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } }).catch(() => null);

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

    // AC-S4-005 test support: dev-only failpoint to assert atomic rollback.
    const failpointEnabled = await requireActiveConfigValue<boolean>(tx as any, "dev.failpoints.enabled").catch(() => false);
    const failpoint = (input as any)?.failpoint;
    if (failpointEnabled && failpoint === "AFTER_HOLD_CONFIRMED") {
      throw new Error("FAILPOINT_AFTER_HOLD_CONFIRMED");
    }

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
        acknowledgementStatus: entry.otaSource ? "RECEIVED" : "PENDING",
        acknowledgementTimeoutAt: entry.otaSource ? null : new Date(Date.now() + voucherAckSeconds * 1000),
        actorId,
        payload: { reservationId: res.id },
        createdBy: actorId,
      },
    });

    const engine = await getTimerEngine();
    if (!entry.otaSource) {
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
          stageContext: Stage.S4,
          dueAt: new Date(Date.now() + voucherAckSeconds * 1000),
          firesAt: new Date(Date.now() + voucherAckSeconds * 1000),
          status: "SCHEDULED",
          createdBy: actorId,
          pgBossJobId: ackJobId,
          payload: { communicationRecordId: comm.id },
        },
      });
    }

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

    // Cancel committed-hold-expiry timers (W3) now that inventory is CONFIRMED.
    const timers = await tx.timerRecord.findMany({
      where: { entryId, timerCode: "COMMITTED_HOLD_EXPIRY_W3", status: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, pgBossJobId: true },
    });
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actorId, cancelledReason: "S4 confirmation locks inventory" } as any,
    });
    // best-effort cancel jobs outside transaction (after commit)
    Promise.resolve().then(async () => {
      try {
        const eng = await getTimerEngine();
        await Promise.all(timers.map((t) => (t.pgBossJobId ? eng.cancel(t.pgBossJobId) : Promise.resolve())));
      } catch {
        // ignore
      }
    });

    return { reservation: res, entry: updated };
  });
}

