import type { PrismaClient } from "@prisma/client";
import { CommunicationType, InvoiceType, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { generateConfirmationVoucher } from "../infrastructure/document-generation-service.js";
import { scheduleS4StageDwellWarningMonitor } from "../../lib/schedule-s4-dwell-warning-monitor.js";
import { evaluateAdvancePaymentCondition } from "./s3-payment-service.js";
import { confirmCommittedHoldTx } from "./s3-hold-service.js";
import { enforceHighValueConfirmationAuthority } from "../../policies/16-confirmation-authority/p40-confirmation-authority.js";
import { enforceMultiBookingAcknowledgedIfOverlappingReservationExists } from "../../policies/04-duplicate-detection/p13-multi-booking-ack-required.js";
import { enforceFocReverificationBeforeConfirmation } from "../../policies/15-foc/p39-foc-reverify-before-confirmation.js";
import { enforceOverbookingRequiresGmMitigationBeforeConfirmation } from "../../policies/17-overbooking/p41-overbooking-requires-gm-mitigation.js";
import { enforceConferenceVerificationBeforeConfirmation } from "../../policies/27-work-order/p67-conference-verification-required.js";
import { enforceCancellationDisclosurePresent } from "../../policies/14-cancellation/p34-cancellation-terms-disclosure-required.js";
import {
  enforceQuotationPresentForS4Confirmation,
  enforceBillingModelFixatedForS4Confirmation,
  enforceCommittedHoldReadyForS4Confirmation,
  enforceEntryAtS3ForReservationConfirmation,
  enforceProformaInvoicePresentForS4Confirmation,
  enforceProformaDispatchedWhenAdvancePaid,
  enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation,
  enforceProvisionalFolioPresentForS4Confirmation,
} from "../../policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.js";
import { enforceEntryVersionMatchesClientForOptimisticLock } from "../../policies/01-availability/p01-entry-version-optimistic-lock-match.js";
import { enforceEntryActiveForStageTransition } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { enforceCommitmentRateFreezeAtS4 } from "../../policies/08-pricing-rate-plan/p20-commitment-rate-freeze-at-s4.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { dispatchConfirmationVoucherTx } from "./communication-service.js";
import { createH1AtS4ConfirmationTx } from "./handoff-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderReservationConfirmationEmail } from "../infrastructure/stage-email-templates.js";
import { generateOrLoadConfirmationVoucherPdf } from "./confirmation-voucher-pdf-service.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";
import { initialiseTasks as initialisePreArrivalTasks } from "./pre-arrival-service.js";

function commercialTermsHaveRateBasis(terms: unknown): boolean {
  if (!terms || typeof terms !== "object") return false;
  const t = terms as Record<string, unknown>;
  if (typeof t.ratePlanId === "string" && t.ratePlanId.length > 0) return true;
  if (typeof t.resolvedRatePlanId === "string" && t.resolvedRatePlanId.length > 0) return true;
  const numericKeys = ["nightlyRate", "rate", "effectiveRate", "resolvedNightlyRate", "resolvedRateAmount"] as const;
  return numericKeys.some((k) => typeof t[k] === "number" && Number.isFinite(t[k] as number));
}

function getNightlyRate(terms: any): number {
  if (typeof terms?.nightlyRate === "number") return terms.nightlyRate;
  if (typeof terms?.rate === "number") return terms.rate;
  if (typeof terms?.effectiveRate === "number") return terms.effectiveRate;
  if (typeof terms?.resolvedNightlyRate === "number") return terms.resolvedNightlyRate;
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
  enforceEntryActiveForStageTransition({ status: entry.status });
  if (input?.version == null) throw new ValidationError("version is required");
  enforceEntryVersionMatchesClientForOptimisticLock({ entryVersion: entry.version, clientVersion: input.version });

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Generate-vs-send: freeze from the operative quotation (ACCEPTED when there is one, otherwise
  // the newest live SENT/DRAFT). Requiring ACCEPTED here would have re-imposed "must send" one
  // stage later than the S2 gate we just relaxed. See p40 / p07 for the ruling and deviation.
  const acceptedCfg = resolveOperativeQuotation(entry.quotations, segmentId);
  enforceQuotationPresentForS4Confirmation({ hasQuotation: !!acceptedCfg });
  const accepted = acceptedCfg!;

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
  const proformas = folio.invoices.filter((i) => i.invoiceType === InvoiceType.PROFORMA);
  enforceProformaInvoicePresentForS4Confirmation({ hasProformaInvoice: proformas.length > 0 });

  // …and once the guest has actually paid an advance, that proforma must have gone OUT to
  // them — money changing hands has to be documented (2026-07-28). Keyed on the amount
  // RECEIVED, not the configured threshold: `advancePayment.thresholds` can be 0 while a
  // guest still chooses to pay something up front, and that voluntary payment needs an
  // invoice just the same.
  const advanceEvaluation = await evaluateAdvancePaymentCondition(prisma, { entryId, folioId: folio.id });
  enforceProformaDispatchedWhenAdvancePaid({
    proformaInvoices: proformas.map((i) => ({ state: i.state, dispatchedAt: i.dispatchedAt })),
    totalAdvanceReceived: advanceEvaluation.totalReceived,
  });

  // …and once the proforma actually went OUT, the guest's answer must be on record before the
  // freeze (2026-07-31 operator ruling — narrows the 2026-07-28 "evidence, never a gate" rule for
  // this one boundary). Latest dispatch decides: a re-issued proforma re-opens the question.
  // Segment-scoped (2026-08-02): only dispatches from the CURRENT segment count — a prior
  // segment's bill (and its answer, or lack of one) belongs to a sealed pass and must neither
  // satisfy nor block this segment's freeze. CommunicationRecord carries no segmentId, so the
  // scope is the segment's time window, same convention as segment-history.
  const currentSegmentForComms = await prisma.segment.findFirst({
    where: { entryId },
    orderBy: { segmentNumber: "desc" },
    select: { startedAt: true },
  });
  const latestProformaComm = await prisma.communicationRecord.findFirst({
    where: {
      entryId,
      commType: CommunicationType.PROFORMA_INVOICE,
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      ...(currentSegmentForComms?.startedAt ? { createdAt: { gte: currentSegmentForComms.startedAt } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { acknowledgementStatus: true },
  });
  enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation({
    latestDispatchedProformaComm: latestProformaComm,
  });

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
  const h1SameTeamAutoFulfil = await requireActiveConfigValue<boolean>(prisma, "ownership.s4.sameTeamAutoFulfilH1").catch(() => false);

  const ceiling = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } }).catch(() => null);

  // Reuses the evaluation resolved for the proforma-dispatch gate above — same folio, same
  // thresholds, nothing in between mutates payments.
  const advanceStatus = advanceEvaluation;
  if (!advanceStatus.satisfied) {
    throw new PolicyGateBlockedError(
      "ADVANCE_OR_CREDIT_REQUIRED",
      "Advance payment threshold or approved credit extension must be satisfied before confirmation (Policy 42 slice)",
    );
  }

  // Held-vs-Reserved by payment confidence (2026-08-07, operator ruling): the freeze happens
  // either way (Reservation row, frozen terms, no TTL), but the ROOMS only earn the "Reserved"
  // label when the money story is closed — advance paid in full, or the remainder is a
  // sanctioned at-check-out deferral. Anything else (partial/installments due before or at
  // check-in, or a credit-extension cover) keeps the rooms visibly "Held" until the money
  // lands; `confirmHeldRoomsAfterFullPaymentTx` flips them the moment it does. The claims
  // block other bookings identically in both states — this is confidence display + escalation,
  // never a weaker block.
  const reservationPaymentPending =
    !advanceEvaluation.paidInFull && advanceEvaluation.paymentPlan?.balanceDueAt !== "AT_CHECKOUT";

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();

    const s3Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S3, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s3Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s3Dwell.id },
        data: {
          exitedAt: now,
          dwellSeconds: Math.max(0, Math.floor((now.getTime() - s3Dwell.enteredAt.getTime()) / 1000)),
        },
      });
    }

    const frozenRate = getNightlyRate(accepted.commercialTerms as any);
    const hasCommercialRateBasis = commercialTermsHaveRateBasis(accepted.commercialTerms);
    enforceCommitmentRateFreezeAtS4({ frozenRate, hasCommercialRateBasis });
    const frozenRatePlanId = (accepted.commercialTerms as any)?.ratePlanId ?? (accepted.commercialTerms as any)?.resolvedRatePlanId ?? "rp-slice";
    const frozenInclusions = (accepted.commercialTerms as any)?.inclusions ?? {};

    // SIG-S4 §90/§197 + AC-S4-024/025/026: exactly one immutable Reservation per SEGMENT. A second
    // confirmation for the SAME segment is rejected; a re-entry mints a NEW segment which yields a
    // new Reservation, leaving the prior segment's Reservation as read-only history.
    const existingForSegment = await tx.reservation.findUnique({ where: { segmentId } });
    if (existingForSegment) {
      throw new PolicyGateBlockedError(
        "RESERVATION_ALREADY_CONFIRMED_FOR_SEGMENT",
        "A Reservation already exists for this segment; re-confirmation requires a new segment via re-entry",
      );
    }
    const isReconfirmation = (await tx.reservation.count({ where: { entryId } })) > 0;
    const reservationId = await allocateReadableId(tx, "RESERVATION" as const, now);
    const reservationData = {
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
      // Snapshot the FULL commercialTerms (including per-room `roomCompositions` if the S2
      // quote was built with them). Legal record + source of truth for downstream
      // hydration into RoomAssignment rows at S5 (Phase C, 2026-07-27).
      frozenCommercialTerms: (accepted.commercialTerms ?? null) as any,
    };
    const res = await tx.reservation.create({
      data: { id: reservationId, entryId, ...reservationData },
    });
    // Point the entry at the newly-confirmed reservation; prior reservations remain read-only history.
    await tx.entry.update({
      where: { id: entryId },
      data: { currentReservationId: res.id, reservationPaymentPending },
    });

    await confirmCommittedHoldTx(tx, {
      entryId,
      holdId: hold.id,
      actorId,
      inquiryId: entry.inquiryId,
      paymentPending: reservationPaymentPending,
    });

    if (reservationPaymentPending) {
      await tx.traceEvent.create({
        data: {
          eventType: "RESERVATION.ROOMS_HELD_PAYMENT_PENDING",
          actorId,
          actorLevel: "L1",
          entityType: "Reservation",
          entityId: res.id,
          operation: "CREATE",
          timestamp: now,
          stageContext: Stage.S4,
          inquiryId: entry.inquiryId,
          entryId,
          payload: {
            entryId,
            reservationId: res.id,
            shortfall: advanceEvaluation.shortfall,
            totalReceived: advanceEvaluation.totalReceived,
            requiredAmount: advanceEvaluation.requiredAmount,
            balanceDueAt: advanceEvaluation.paymentPlan?.balanceDueAt ?? null,
            promisedBy: advanceEvaluation.paymentPlan?.promisedBy ?? null,
            creditExtensionActive: advanceEvaluation.creditExtensionActive,
          },
          createdBy: actorId,
        },
      });
    }

    // AC-S4-005 test support: dev-only failpoint to assert atomic rollback (after hold confirm).
    const failpointEnabled = await requireActiveConfigValue<boolean>(tx as any, "dev.failpoints.enabled").catch(() => false);
    const failpoint = (input as any)?.failpoint;
    if (failpointEnabled && failpoint === "AFTER_HOLD_CONFIRMED") {
      throw new Error("FAILPOINT_AFTER_HOLD_CONFIRMED");
    }

    const voucher = await generateConfirmationVoucher(prisma, { reservationId: res.id, entryId });
    await dispatchConfirmationVoucherTx(tx, {
      entryId,
      actorId,
      reservationId: res.id,
      otaSource: entry.otaSource,
      voucherAckSeconds,
      voucherRef: voucher.storageReference,
      templateKey: voucher.templateKey,
    });

    const engine = await getTimerEngine();
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
    await createH1AtS4ConfirmationTx(tx, {
      entryId,
      actorId,
      checklistContent: h1Checklist ?? {},
      isAutoFulfilled: h1SameTeamAutoFulfil === true,
    });

    await tx.traceEvent.create({
      data: {
        eventType: "RESERVATION_CONFIRMED",
        actorId,
        actorLevel: "L1",
        entityType: "Reservation",
        entityId: res.id,
        operation: isReconfirmation ? "UPDATE" : "CREATE",
        timestamp: new Date(),
        inquiryId: entry.inquiryId,
        entryId,
        payload: { reservationId: res.id, reconfirmation: isReconfirmation },
        createdBy: actorId,
      },
    });

    const updated = await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S4, version: { increment: 1 } } });
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S4, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any,
    });

    return { reservation: res, entry: updated };
  });

  await scheduleS4StageDwellWarningMonitor(prisma, entryId, actorId);

  // Handoff-to-front-desk prep (2026-08-02, operator request): seed the pre-arrival task set
  // at confirmation so the S4 desk can already work the front-desk handoff items (payment
  // reconciliation, special-request fulfilment, late-arrival meal coordination, site visit)
  // before activating the arrival window. Idempotent (`@@unique(entryId, taskType)` +
  // skipDuplicates), so the S4→S5 activation's lazy init simply finds them present.
  // Best-effort: a seeding hiccup must not fail a committed confirmation — the S5 activation
  // path self-heals (task count 0 → initialise).
  try {
    await initialisePreArrivalTasks(prisma, entryId, actorId);
  } catch {
    /* S5 activation lazy init covers it */
  }

  // Phase 2 — outbound confirmation email. Runs AFTER the transaction commits so an SMTP
  // failure cannot roll back the reservation. The send is best-effort; a failure is logged
  // to TraceEvent and does not propagate to the caller.
  // Phase 3 — refactored to use the shared best-effort helper + bundled template.
  const ciDate = result.reservation.frozenCheckInDate;
  const coDate = result.reservation.frozenCheckOutDate;
  const frozenRate = Number(result.reservation.frozenRate?.toString?.() ?? result.reservation.frozenRate ?? 0);
  const ms = coDate.getTime() - ciDate.getTime();
  const nights = Math.max(1, Math.round(ms / 86400_000));
  const currency = (accepted.commercialTerms as any)?.currency ?? "BTN";
  const displayName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";
  // Room count is needed BEFORE computeStayCharges so the stay total reflects all rooms.
  // Read from the accepted quotation's commercialTerms.roomCount (single source of truth
  // set at quote creation), fall back to entry.numberOfRooms, fall back to 1.
  const acceptedTerms = accepted.commercialTerms as { roomCount?: number } | null;
  const bookingRoomCount = Math.max(1, Number(acceptedTerms?.roomCount) || entry.numberOfRooms || 1);
  const breakdown = await computeStayCharges(prisma, frozenRate, nights, bookingRoomCount);
  // Group-oriented content when the entry is GROUP_MASTER. Group leader defaults to the
  // on-site contact person (a group in operational terms) with fall-back to the guest
  // profile display name.
  const isGroup = entry.groupBillingMode === "GROUP_MASTER";
  const roomCount = isGroup ? bookingRoomCount : undefined;
  const groupLeaderName = isGroup ? entry.contactPersonName ?? displayName : undefined;
  const content = renderReservationConfirmationEmail({
    guestDisplayName: displayName,
    reservationReadableId: result.reservation.id,
    checkInDate: ciDate,
    checkOutDate: coDate,
    guestCount: result.reservation.frozenGuestCount ?? entry.guestCount ?? 1,
    nightlyRate: frozenRate,
    currency,
    breakdown,
    isGroup,
    roomCount,
    billingModel: entry.folio?.billingModel ?? null,
    groupLeaderName,
  });

  // Generate the confirmation-voucher PDF and attach it to the outbound email. Idempotent —
  // if a voucher was already rendered (retry / resend) we serve the stored file. Failure is
  // non-fatal: the text email still goes out, and ops sees a trace.
  try {
    const artifact = await generateOrLoadConfirmationVoucherPdf(prisma, result.reservation.id, actorId);
    content.attachments = [
      {
        filename: artifact.filename,
        content: artifact.bytes,
        contentType: "application/pdf",
      },
    ];
  } catch (e) {
    await prisma.traceEvent.create({
      data: {
        eventType: "RESERVATION.CONFIRMATION_VOUCHER_PDF_RENDER_FAILED",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Reservation",
        entityId: result.reservation.id,
        operation: "ALERT",
        timestamp: new Date(),
        entryId,
        payload: { reservationId: result.reservation.id, error: (e as Error)?.message ?? String(e) },
        createdBy: actorId,
      } as any,
    }).catch(() => {});
  }

  await dispatchStageEmailBestEffort(
    {
      prisma,
      entryId,
      actorId,
      inquiryId: entry.inquiryId,
      guestEmail: entry.guestProfile?.email ?? null,
      stage: Stage.S4,
      eventTypePrefix: "RESERVATION_CONFIRMATION_EMAIL",
    },
    content,
  );

  return result;
}

/**
 * Manual "Send to guest" for the confirmation voucher (2026-08-07, operator request).
 *
 * The voucher goes out automatically at confirmation — this covers the cases where that
 * wasn't enough: the guest email was missing/wrong at freeze time, the send failed, or the
 * guest simply asks for it again. Mirrors what confirmation does: a tracked
 * CONFIRMATION_VOUCHER communication (fresh W22 acknowledgement window; prior voucher windows
 * are cancelled so exactly one countdown is live), the same confirmation email body with the
 * voucher PDF attached, and the RESERVATION_CONFIRMATION_EMAIL trace family.
 */
export async function resendConfirmationVoucher(
  prisma: PrismaClient,
  reservationId: string,
  actorId: string,
  input: { dispatchedTo?: string | null },
) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      entry: {
        include: {
          guestProfile: true,
          folio: true,
          quotations: { orderBy: { createdAt: "desc" } },
          segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
        },
      },
    },
  });
  if (!reservation) throw new NotFoundError("Reservation");
  if (!reservation.confirmedAt) throw new ValidationError("This reservation was never confirmed — nothing to send");
  const entry = reservation.entry;

  const recipient = input.dispatchedTo?.trim() || entry.guestProfile?.email?.trim() || null;
  if (!recipient) {
    throw new ValidationError("No email address — enter one, or add it to the guest profile first");
  }

  // Same email body the confirmation sent, composed from the frozen snapshot.
  const ciDate = reservation.frozenCheckInDate;
  const coDate = reservation.frozenCheckOutDate;
  const frozenRate = Number(reservation.frozenRate?.toString?.() ?? reservation.frozenRate ?? 0);
  const nights = Math.max(1, Math.round((coDate.getTime() - ciDate.getTime()) / 86400_000));
  const segmentId = entry.segments[0]?.id ?? reservation.segmentId;
  const operative = resolveOperativeQuotation(entry.quotations, segmentId);
  const operativeTerms = (operative?.commercialTerms ?? null) as { currency?: string; roomCount?: number } | null;
  const currency = operativeTerms?.currency ?? "BTN";
  const displayName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";
  const bookingRoomCount = Math.max(1, Number(operativeTerms?.roomCount) || entry.numberOfRooms || 1);
  const breakdown = await computeStayCharges(prisma, frozenRate, nights, bookingRoomCount);
  const isGroup = entry.groupBillingMode === "GROUP_MASTER";
  const content = renderReservationConfirmationEmail({
    guestDisplayName: displayName,
    reservationReadableId: reservation.id,
    checkInDate: ciDate,
    checkOutDate: coDate,
    guestCount: reservation.frozenGuestCount ?? entry.guestCount ?? 1,
    nightlyRate: frozenRate,
    currency,
    breakdown,
    isGroup,
    roomCount: isGroup ? bookingRoomCount : undefined,
    billingModel: entry.folio?.billingModel ?? null,
    groupLeaderName: isGroup ? entry.contactPersonName ?? displayName : undefined,
  });

  const ackWindows = await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType").catch(
    () => null,
  );
  const voucherAckSeconds = Number((ackWindows as any)?.voucher ?? 172800);
  const now = new Date();

  const comm = await prisma.$transaction(async (tx) => {
    // One live reply window per artifact: the earlier voucher dispatch's W22 (if still
    // ticking) is superseded by this re-send.
    const priorComms = await tx.communicationRecord.findMany({
      where: { entryId: entry.id, commType: CommunicationType.CONFIRMATION_VOUCHER },
      select: { id: true },
    });
    if (priorComms.length > 0) {
      const timers = await tx.timerRecord.findMany({
        where: {
          entityType: "CommunicationRecord",
          entityId: { in: priorComms.map((c) => c.id) },
          timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
          status: "SCHEDULED",
        },
        select: { id: true, pgBossJobId: true },
      });
      if (timers.length > 0) {
        const engine = await getTimerEngine();
        await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
        await tx.timerRecord.updateMany({
          where: { id: { in: timers.map((t) => t.id) } },
          data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "VOUCHER_RESENT" },
        });
      }
    }

    const created = await dispatchConfirmationVoucherTx(tx, {
      entryId: entry.id,
      actorId,
      reservationId: reservation.id,
      otaSource: entry.otaSource,
      voucherAckSeconds,
      voucherRef: reservation.id,
      templateKey: "confirmation-voucher-resend",
      contentSummary: `Confirmation voucher re-sent to ${recipient}`,
    });

    await tx.traceEvent.create({
      data: {
        eventType: "RESERVATION.CONFIRMATION_VOUCHER_RESENT",
        actorId,
        actorLevel: "L1",
        entityType: "Reservation",
        entityId: reservation.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { reservationId: reservation.id, dispatchedTo: recipient, communicationRecordId: created.id },
        createdBy: actorId,
      },
    });

    return created;
  });

  // PDF attachment + email — post-tx, best-effort, same as confirmation.
  try {
    const artifact = await generateOrLoadConfirmationVoucherPdf(prisma, reservation.id, actorId);
    content.attachments = [{ filename: artifact.filename, content: artifact.bytes, contentType: "application/pdf" }];
  } catch (e) {
    await prisma.traceEvent
      .create({
        data: {
          eventType: "RESERVATION.CONFIRMATION_VOUCHER_PDF_RENDER_FAILED",
          actorId,
          actorLevel: "SYSTEM",
          entityType: "Reservation",
          entityId: reservation.id,
          operation: "ALERT",
          timestamp: new Date(),
          entryId: entry.id,
          payload: { reservationId: reservation.id, error: (e as Error)?.message ?? String(e) },
          createdBy: actorId,
        } as any,
      })
      .catch(() => {});
  }

  await dispatchStageEmailBestEffort(
    {
      prisma,
      entryId: entry.id,
      actorId,
      inquiryId: entry.inquiryId,
      guestEmail: recipient,
      stage: Stage.S4,
      eventTypePrefix: "RESERVATION_CONFIRMATION_EMAIL",
    },
    content,
  );

  return { communicationRecordId: comm.id, dispatchedTo: recipient };
}

