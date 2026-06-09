import type { PrismaClient } from "@prisma/client";
import { InvoiceType, Stage } from "@prisma/client";
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
  enforceAcceptedQuotationPresentForS4Confirmation,
  enforceBillingModelFixatedForS4Confirmation,
  enforceCommittedHoldReadyForS4Confirmation,
  enforceEntryAtS3ForReservationConfirmation,
  enforceProformaInvoicePresentForS4Confirmation,
  enforceProvisionalFolioPresentForS4Confirmation,
} from "../../policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.js";
import { enforceEntryVersionMatchesClientForOptimisticLock } from "../../policies/01-availability/p01-entry-version-optimistic-lock-match.js";
import { enforceCommitmentRateFreezeAtS4 } from "../../policies/08-pricing-rate-plan/p20-commitment-rate-freeze-at-s4.js";
import { dispatchConfirmationVoucherTx } from "./communication-service.js";
import { createH1AtS4ConfirmationTx } from "./handoff-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderReservationConfirmationEmail } from "../infrastructure/stage-email-templates.js";
import { computeStayCharges } from "../infrastructure/compute-stay-charges.js";

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
  if (input?.version == null) throw new ValidationError("version is required");
  enforceEntryVersionMatchesClientForOptimisticLock({ entryVersion: entry.version, clientVersion: input.version });

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const acceptedCfg = entry.quotations.find((q) => q.segmentId === segmentId && q.state === "ACCEPTED");
  enforceAcceptedQuotationPresentForS4Confirmation({ hasAcceptedQuotation: !!acceptedCfg });
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
  const h1SameTeamAutoFulfil = await requireActiveConfigValue<boolean>(prisma, "ownership.s4.sameTeamAutoFulfilH1").catch(() => false);

  const ceiling = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } }).catch(() => null);

  const advanceStatus = await evaluateAdvancePaymentCondition(prisma, { entryId, folioId: folio.id });
  if (!advanceStatus.satisfied) {
    throw new PolicyGateBlockedError(
      "ADVANCE_OR_CREDIT_REQUIRED",
      "Advance payment threshold or approved credit extension must be satisfied before confirmation (Policy 42 slice)",
    );
  }

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

    // A Reservation is unique per entry. On re-confirmation after a re-entry (e.g. room change),
    // one already exists — update its frozen terms in place rather than creating a duplicate.
    const existingReservation = await tx.reservation.findUnique({ where: { entryId } });
    const reservationId = existingReservation?.id ?? (await allocateReadableId(tx, READABLE_ID_PREFIXES.RESERVATION, now));
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
    };
    const res = await tx.reservation.upsert({
      where: { entryId },
      create: { id: reservationId, entryId, ...reservationData },
      update: { ...reservationData, sealedAt: null },
    });

    await confirmCommittedHoldTx(tx, { entryId, holdId: hold.id, actorId, inquiryId: entry.inquiryId });

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
        operation: existingReservation ? "UPDATE" : "CREATE",
        timestamp: new Date(),
        inquiryId: entry.inquiryId,
        entryId,
        payload: { reservationId: res.id, reconfirmation: !!existingReservation },
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
  const breakdown = await computeStayCharges(prisma, frozenRate, nights);
  const displayName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";
  const content = renderReservationConfirmationEmail({
    guestDisplayName: displayName,
    reservationReadableId: result.reservation.id,
    checkInDate: ciDate,
    checkOutDate: coDate,
    guestCount: result.reservation.frozenGuestCount ?? entry.guestCount ?? 1,
    nightlyRate: frozenRate,
    currency,
    breakdown,
  });
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

