import type { Prisma, PrismaClient } from "@prisma/client";
import { CommissionDueStatus, EntryStatus, FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { allocateReadableId, READABLE_ID_PREFIXES, allocateFolioLineId } from "../../lib/readable-id.js";
import { AppError, MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { readRoomInspectionStanding } from "../../lib/room-inspection-standing.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { randomUUID } from "node:crypto";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { schedulePaymentFollowUpW8IfOutstanding } from "../../lib/schedule-payment-followup-w8.js";
import { enforceWriteOffConstraints } from "../../policies/13-billing-model/write-off-policy-constraints.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderFinalInvoiceEmail, renderInterimInvoiceEmail, renderProformaInvoiceEmail } from "../infrastructure/stage-email-templates.js";
import { describeInterimPromise, markInterimInvoiceDispatchedTx, type InterimFigures } from "./interim-payment-service.js";
import { computeStayCharges, resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { mulMoney, round2, sumMoneyBy, toDecimal } from "../../lib/money.js";
import { describeAdvancePaymentPlan, resolveAdvancePaymentPlan } from "./s3-payment-service.js";
import { formatDate as formatEmailDate } from "../infrastructure/stage-email-helpers.js";
import { buildFinalInvoiceFigures, generateOrLoadInvoicePdf, loadInvoiceForRender } from "./invoice-pdf-service.js";
import { releaseEntryRoomsToFree } from "../../lib/room-claim-state.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { computeOutstandingForBillingModel, listBillingModelBucketsForFolio } from "../../lib/folio-outstanding-per-billing-model.js";
import {
  enforceApartmentSecurityDepositResolvedForS9Closure,
  enforceDirectBillPaymentsMatchedForS9Closure,
  enforceEntryAtS9ForPostStayCharge,
  enforceGovernmentInvoicePaymentTrackedForS9Closure,
  enforceInvoicesDispatchedForS9Closure,
  enforceOutstandingFolioHasW8OrWriteOffForS9Closure,
  enforcePostStayChargeNotWithinStayWindow,
} from "../../policies/13-billing-model/p33-s9-closure-invoice-payment-and-poststay-gates.js";
import { enforceEquipmentReturnResolvedForS9Closure } from "../../policies/01-availability/p01-equipment-return-resolved-for-s9-closure.js";
import { enforceInspectionResolvedForS9Closure } from "../../policies/19-deficient-condition/p51-s9-closure-inspection-resolution.js";
import { enforceNoOpenDisputesForS9Closure } from "../../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";
import { enforceH5NotBlockingS9Closure } from "../../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceNoShowDeterminationPresentForS9Closure } from "../../policies/22-no-show/p56-no-show-determination-required-for-s9-closure.js";
import { enforceEntryAtS9ForS9Closure, enforceEntryNotAlreadyClosed } from "../../policies/01-availability/p01-entry-at-s9-for-closure.js";
import {
  enforceInvoiceStateForPaymentTracked,
  enforceInvoiceStateForReconciled,
} from "../../policies/13-billing-model/p33-invoice-payment-state-transitions.js";
import { enforceFolioOutstandingForWriteOff } from "../../policies/13-billing-model/p33-folio-outstanding-for-write-off.js";
import { shouldCreateCommissionDueRecord } from "../../policies/28-commission-production/p68-commission-due-record-creation.js";
import { computeGuestDataRetentionDueAt } from "../../policies/07-guest-data-governance/p18-guest-data-retention.js";
import { enforceNoShowFinancialAmountsNonNegative } from "../../policies/22-no-show/p57-no-show-folio-financial.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

async function resolveGuestDataRetentionPeriodDays(db: DbClient): Promise<number> {
  try {
    const v = await requireActiveConfigValue<number>(db as any, "identity.document.retentionPeriodDays");
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* use fallbacks below */
  }
  try {
    const map = await requireActiveConfigValue<Record<string, number>>(db as any, "identity.retentionPeriodDays");
    const n = Number(map?.DEFAULT);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  return 365;
}

export async function listInvoices(prisma: PrismaClient, folioId: string) {
  return prisma.invoice.findMany({ where: { folioId }, orderBy: { createdAt: "desc" } });
}

/** SIG-S9 §8.4 — create a DRAFT final invoice when none was issued at S8 (post-stay / government paths). */
export async function issueInvoiceAtS9(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; templateKey?: string; billingModel?: string },
) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId }, include: { entry: true } });
  if (!folio?.entry) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
  enforceEntryAtS9ForS9Closure({ currentStage: folio.entry.currentStage });
  if (folio.state === FolioState.PROVISIONAL) {
    throw new ValidationError("Cannot issue S9 invoice on a provisional folio");
  }

  const targetBucket = input.billingModel?.trim() || null;
  if (targetBucket) {
    const buckets = await listBillingModelBucketsForFolio(prisma, folioId);
    if (!buckets.includes(targetBucket)) {
      throw new ValidationError(
        `No folio lines assigned to billingModel "${targetBucket}". Present buckets: ${buckets.join(", ") || "(none)"}.`,
      );
    }
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const invoiceId = await allocateReadableId(tx, "INVOICE" as const, now);
    const totalAmount = targetBucket
      ? await computeOutstandingForBillingModel(tx, folioId, targetBucket)
      : null;
    return tx.invoice.create({
      data: {
        id: invoiceId,
        folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.FINAL,
        state: InvoiceState.DRAFT,
        templateKey: input.templateKey?.trim() || "final-v1",
        billingModel: targetBucket,
        totalAmount: totalAmount ?? undefined,
        issuedAt: now,
        issuedBy: actorId,
        metadata: {
          basis: "S9 issueInvoice",
          stage: Stage.S9,
          ...(targetBucket ? { billingModel: targetBucket } : {}),
        },
      },
    });
  });
}

export type InvoiceRecipient = {
  /** The address the email goes to — null when there is none to use (nothing is emailed). */
  to: string | null;
  /** Who the document is made out to, for the email's greeting. */
  greetName: string;
  /** Why nothing is emailed, when `to` is null. */
  skipReason: string | null;
};

/**
 * Where a governed invoice email goes (2026-09-18). Every invoice document — the proforma, the
 * interim bill and the tax invoice — is addressed to the agency or company whenever one booked
 * ("To: <party> · For guest: <name>"), so its email follows the addressee:
 *   1. the address the desk typed;
 *   2. else that party's email on file;
 *   3. else the guest's email — only when no party is linked.
 * A party-addressed invoice is never mailed to the traveller by default: it carries the party's
 * own negotiated rates, and almost no party has an email on file, so a guest fallback would send
 * nearly every agency's rates to its guests. With no address the invoice is still dispatched
 * (the desk hands it over) and the skipped email is traced with its reason. The address it went
 * to is recorded on the invoice, so the desk can say where the bill went.
 */
export async function resolveInvoiceRecipient(
  db: DbClient,
  entryId: string,
  typed?: string | null,
): Promise<InvoiceRecipient> {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      contactPersonName: true,
      guestProfile: { select: { firstName: true, lastName: true, email: true } },
      inquiry: {
        select: {
          travelAgent: { select: { displayName: true, contactEmail: true } },
          corporateAccount: { select: { displayName: true, contactEmail: true } },
        },
      },
    },
  });
  const guestName =
    [entry?.guestProfile?.firstName, entry?.guestProfile?.lastName].filter(Boolean).join(" ").trim() ||
    entry?.contactPersonName?.trim() ||
    "Guest";
  const party = entry?.inquiry?.travelAgent ?? entry?.inquiry?.corporateAccount ?? null;
  const greetName = party?.displayName ?? guestName;
  const typedTo = typed?.trim();
  if (typedTo) return { to: typedTo, greetName, skipReason: null };
  if (party) {
    const partyTo = party.contactEmail?.trim();
    return partyTo
      ? { to: partyTo, greetName, skipReason: null }
      : { to: null, greetName, skipReason: "BILLED_PARTY_HAS_NO_EMAIL" };
  }
  const guestTo = entry?.guestProfile?.email?.trim();
  return guestTo ? { to: guestTo, greetName, skipReason: null } : { to: null, greetName, skipReason: "GUEST_HAS_NO_EMAIL" };
}

export async function dispatchInvoice(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
  input?: { dispatchedTo?: string },
) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");
  if (invoice.state !== InvoiceState.DRAFT) return invoice;
  const now = new Date();
  const recipient = await resolveInvoiceRecipient(prisma, invoice.entryId, input?.dispatchedTo ?? invoice.dispatchedTo);
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        state: InvoiceState.DISPATCHED,
        dispatchedAt: now,
        dispatchedBy: actorId,
        dispatchedTo: recipient.to,
        metadata: { ...(invoice.metadata as object | null), dispatchedBy: actorId, dispatchedAt: now.toISOString() } as object,
      },
    });

    // S3 policy: governed PI dispatch must open an acknowledgement loop (W22),
    // and start W34 payment follow-up timers when advance payment is not yet satisfied.
    if (updated.invoiceType === "PROFORMA") {
      const entry = await tx.entry.findUnique({ where: { id: updated.entryId }, include: { folio: { include: { payments: true } } } });
      if (entry?.folio) {
        const ackWindow = await requireActiveConfigValue<Record<string, number>>(tx as any, "acknowledgement.windowPerType");
        const piSeconds = Number((ackWindow as any)?.pi ?? 86400);
        const ackFireAt = new Date(now.getTime() + piSeconds * 1000);

        const engine = await getTimerEngine();
        const commId = await allocateReadableId(tx, "COMMUNICATION" as const, now);
        const comm = await tx.communicationRecord.create({
          data: {
            id: commId,
            entryId: updated.entryId,
            channel: "EMAIL",
            // `PROFORMA_INVOICE` has been in the CommunicationType enum all along; this used to
            // write INVOICE_SUPERSEDED_NOTICE as a temporary dodge around a Windows Prisma-generate
            // issue, which mislabelled every PI dispatch and made the ack loop unfindable by type.
            commType: "PROFORMA_INVOICE",
            stageContext: Stage.S3,
            direction: "OUTBOUND",
            sendStatus: "DISPATCHED",
            acknowledgementStatus: "PENDING",
            acknowledgementTimeoutAt: ackFireAt,
            acknowledgementReceivedAt: null,
            actorId,
            contentSummary: "Proforma invoice dispatched",
            payload: { invoiceId: updated.id, dispatchedTo: updated.dispatchedTo ?? null },
            createdBy: actorId,
          },
        });

        const w22JobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
        await tx.timerRecord.create({
          data: {
            entryId: updated.entryId,
            entityType: "CommunicationRecord",
            entityId: comm.id,
            timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
            timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
            stageContext: Stage.S3,
            dueAt: ackFireAt,
            firesAt: ackFireAt,
            status: "SCHEDULED",
            createdBy: actorId,
            pgBossJobId: w22JobId,
            payload: { communicationRecordId: comm.id },
          },
        });

        // Do NOT swallow — silently defaulting requiredAmount to 0 would let the follow-up gate
        // pass unconditionally and skip scheduling W34 tier-1/tier-2 timers. Let PI dispatch fail
        // loudly so the operator sees a real error instead of guests silently missing follow-ups.
        const thresholds = await requireActiveConfigValue<any>(tx as any, "advancePayment.thresholds");
        const requiredAmount = Number(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);
        // Decimal-safe sum — float reduce compares wrong at boundary sums (0.1+0.2 pattern).
        const inRows = (entry.folio.payments ?? []).filter((p) => p.paymentDirection === "IN");
        const totalInDec = sumMoneyBy(inRows, "amount");
        const totalIn = Number(totalInDec.toFixed(2));
        const credit = await tx.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio.id } });
        // Decimal compare — never `>=` on raw JS numbers derived from money aggregates.
        const requiredAmountDec = toDecimal(Number.isFinite(requiredAmount) ? requiredAmount : 0);
        const satisfied = !!credit || (Number.isFinite(requiredAmount) ? totalInDec.gte(requiredAmountDec) : totalInDec.gt(0));
        if (!satisfied) {
          // Policy registry override: `registry.advancePaymentFollowUp.windowSeconds` (when
          // enabled) replaces the legacy `advancePayment.followUpWindowSeconds`. Escalation
          // window remains ConfigurationEntry-driven.
          const advancePolicy = await getRegistryPolicy(tx as any, "registry.advancePaymentFollowUp.windowSeconds");
          const registryFollowUp =
            advancePolicy && advancePolicy.enabled !== false && typeof advancePolicy.seconds === "number"
              ? (advancePolicy.seconds as number)
              : null;
          const followUpSeconds =
            registryFollowUp ?? Number(await requireActiveConfigValue<number>(tx as any, "advancePayment.followUpWindowSeconds"));
          const escalationSeconds = Number(await requireActiveConfigValue<number>(tx as any, "advancePayment.escalationWindowSeconds"));
          const t1At = new Date(now.getTime() + followUpSeconds * 1000);
          const t2At = new Date(now.getTime() + escalationSeconds * 1000);

          const t1Id = randomUUID();
          const t2Id = randomUUID();
          const j1 = await engine.schedule("ADVANCE_PAYMENT_FOLLOW_UP_W34", { entryId: updated.entryId, invoiceId: updated.id, tier: 1, timerRecordId: t1Id }, { startAfter: t1At });
          const j2 = await engine.schedule("ADVANCE_PAYMENT_FOLLOW_UP_W34", { entryId: updated.entryId, invoiceId: updated.id, tier: 2, timerRecordId: t2Id }, { startAfter: t2At });

          await tx.timerRecord.createMany({
            data: [
              {
                id: t1Id,
                entryId: updated.entryId,
                entityType: "Invoice",
                entityId: updated.id,
                timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                stageContext: Stage.S3,
                dueAt: t1At,
                firesAt: t1At,
                status: "SCHEDULED",
                createdBy: actorId,
                pgBossJobId: j1,
                payload: { entryId: updated.entryId, invoiceId: updated.id, tier: 1, timerRecordId: t1Id } as any,
              },
              {
                id: t2Id,
                entryId: updated.entryId,
                entityType: "Invoice",
                entityId: updated.id,
                timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
                stageContext: Stage.S3,
                dueAt: t2At,
                firesAt: t2At,
                status: "SCHEDULED",
                createdBy: actorId,
                pgBossJobId: j2,
                payload: { entryId: updated.entryId, invoiceId: updated.id, tier: 2, timerRecordId: t2Id } as any,
              },
            ] as any,
          });
        }
      }
    }

    // INTERIM invoice (2026-08-21): the mid-stay bill opens the SAME answer loop as the
    // proforma, and here the answer IS a gate — Policy 80 refuses the interim payment until the
    // guest's response is on record. The request behind it flips REQUESTED → BILLED.
    if (updated.invoiceType === "INTERIM") {
      const ackWindow = await requireActiveConfigValue<Record<string, number>>(tx as any, "acknowledgement.windowPerType");
      const seconds = Number((ackWindow as any)?.interimInvoice ?? (ackWindow as any)?.pi ?? 86400);
      const ackFireAt = new Date(now.getTime() + seconds * 1000);
      const engine = await getTimerEngine();
      const commId = await allocateReadableId(tx, "COMMUNICATION" as const, now);
      const comm = await tx.communicationRecord.create({
        data: {
          id: commId,
          entryId: updated.entryId,
          channel: "EMAIL",
          commType: "INTERIM_INVOICE",
          stageContext: Stage.S7,
          direction: "OUTBOUND",
          sendStatus: "DISPATCHED",
          acknowledgementStatus: "PENDING",
          acknowledgementTimeoutAt: ackFireAt,
          acknowledgementReceivedAt: null,
          actorId,
          contentSummary: "Interim invoice dispatched",
          payload: { invoiceId: updated.id, dispatchedTo: updated.dispatchedTo ?? null },
          createdBy: actorId,
        },
      });
      const w22JobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
      await tx.timerRecord.create({
        data: {
          entryId: updated.entryId,
          entityType: "CommunicationRecord",
          entityId: comm.id,
          timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
          timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
          stageContext: Stage.S7,
          dueAt: ackFireAt,
          firesAt: ackFireAt,
          status: "SCHEDULED",
          createdBy: actorId,
          pgBossJobId: w22JobId,
          payload: { communicationRecordId: comm.id },
        },
      });
      await markInterimInvoiceDispatchedTx(tx, updated.id, now);
    }

    // FINAL/receipt invoice (2026-08-17, operator request): open the same guest-answer loop
    // as the proforma — a CommunicationRecord + W22 acknowledgement window — so the response
    // to the final bill (especially "I'll pay by X" on an OUTSTANDING balance) is recorded
    // evidence the desk can capture. Evidence only, never a gate: W8 payment follow-up stays
    // the enforcement mechanism for the money itself.
    if (updated.invoiceType === "FINAL") {
      const entryRow = await tx.entry.findUnique({
        where: { id: updated.entryId },
        select: { currentStage: true },
      });
      const ackWindow = await requireActiveConfigValue<Record<string, number>>(tx as any, "acknowledgement.windowPerType");
      const finalSeconds = Number((ackWindow as any)?.finalInvoice ?? (ackWindow as any)?.pi ?? 86400);
      const ackFireAt = new Date(now.getTime() + finalSeconds * 1000);
      const engine = await getTimerEngine();
      const commId = await allocateReadableId(tx, "COMMUNICATION" as const, now);
      const comm = await tx.communicationRecord.create({
        data: {
          id: commId,
          entryId: updated.entryId,
          channel: "EMAIL",
          commType: "FINAL_INVOICE",
          stageContext: entryRow?.currentStage ?? Stage.S9,
          direction: "OUTBOUND",
          sendStatus: "DISPATCHED",
          acknowledgementStatus: "PENDING",
          acknowledgementTimeoutAt: ackFireAt,
          acknowledgementReceivedAt: null,
          actorId,
          contentSummary: "Final invoice dispatched",
          payload: { invoiceId: updated.id, dispatchedTo: updated.dispatchedTo ?? null },
          createdBy: actorId,
        },
      });
      const w22JobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackFireAt });
      await tx.timerRecord.create({
        data: {
          entryId: updated.entryId,
          entityType: "CommunicationRecord",
          entityId: comm.id,
          timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
          timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
          stageContext: entryRow?.currentStage ?? Stage.S9,
          dueAt: ackFireAt,
          firesAt: ackFireAt,
          status: "SCHEDULED",
          createdBy: actorId,
          pgBossJobId: w22JobId,
          payload: { communicationRecordId: comm.id },
        },
      });
    }

    return updated;
  });

  // NOTE (2026-08-10 operator ruling): dispatching the PI no longer auto-places the committed
  // hold — that moved to `recordPayment` (s3-folio-service), firing when the advance actually
  // arrives (partial counts). The dispatched-but-unpaid bill holds nothing.

  // Phase 3 — outbound invoice email (best-effort, post-tx).
  // PROFORMA → S3 PI email; final invoices (RECEIPT_BASED / FOLIO / etc.) → S8/S9 final invoice email.
  await sendInvoiceEmailBestEffort(prisma, actorId, result.id, recipient);

  return result;
}

async function sendInvoiceEmailBestEffort(prisma: PrismaClient, actorId: string, invoiceId: string, recipient: InvoiceRecipient) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      entry: {
        include: {
          guestProfile: true,
          reservation: true,
          // At S3 (PI dispatch) the reservation doesn't exist yet — the accepted quotation
          // carries the nightly rate in commercialTerms. Pull it in as a fallback.
          quotations: { where: { state: "ACCEPTED" }, orderBy: { createdAt: "desc" }, take: 1 },
          // Current segment start — scopes the payment plan the PI email states (2026-08-08).
          segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { startedAt: true } },
        },
      },
      folio: { include: { payments: { where: { paymentDirection: "IN" } } } },
    },
  });
  if (!inv?.entry) return;
  const entry = inv.entry;
  // The greeting follows the document's addressee — the agency or company when one booked.
  const displayName = recipient.greetName;
  // Decimal-safe sum; guest-facing summary; number at boundary for template consumers.
  const paid = Number(sumMoneyBy(inv.folio?.payments ?? [], "amount").toFixed(2));
  // Prefer the frozen reservation dates + rate (authoritative from S4); fall back to the accepted
  // quotation (S3 PI scenario — no reservation yet); final fallback is the entry / invoice totals.
  const ci = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? new Date();
  const co = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? new Date(ci.getTime() + 86400_000);
  const nights = Math.max(1, Math.round((co.getTime() - ci.getTime()) / 86400_000));

  const quotationTerms = (entry.quotations[0]?.commercialTerms as any) ?? null;
  const quotationNightly = Number(
    quotationTerms?.nightlyRate ?? quotationTerms?.rate ?? quotationTerms?.effectiveRate ?? 0,
  );
  // Decimal-safe divide: `totalAmount / nights`. `nights >= 1` from Math.max above so no div-by-zero.
  const invoiceImpliedNightly = Number(toDecimal(inv.totalAmount).div(nights).toFixed(2));
  const nightlyRate = entry.reservation?.frozenRate
    ? Number(entry.reservation.frozenRate.toString())
    : quotationNightly > 0
      ? quotationNightly
      : invoiceImpliedNightly > 0
        ? invoiceImpliedNightly
        : 0;
  const currency = quotationTerms?.currency ?? "BTN";
  // Multi-room: get roomCount from the quotation's commercialTerms (single source of truth),
  // fall back to entry.numberOfRooms, then to 1. S9 needs this so the final invoice /
  // reconciliation reflects the total for all rooms, not just one.
  const s9RoomCount = Math.max(1, Number((quotationTerms as any)?.roomCount) || entry.numberOfRooms || 1);
  const isPI = inv.invoiceType === InvoiceType.PROFORMA;
  const isInterim = inv.invoiceType === InvoiceType.INTERIM;
  // The FINAL invoice email prints the LEDGER figures — the same pure builder the PDF renders
  // from (2026-08-18). It used to re-derive frozenRate × nights × rooms + tax, a third figure
  // that matched neither the PDF nor the desk's bill.
  let breakdown = isPI ? await computeStayCharges(prisma, nightlyRate, nights, s9RoomCount) : null;
  let amountPaid = paid;
  if (!isPI && !isInterim) {
    const loaded = await loadInvoiceForRender(prisma, invoiceId);
    const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);
    const fig = buildFinalInvoiceFigures(loaded, { gstRate, svcRate: serviceChargeRate, nights, nightlyRate });
    breakdown = {
      subTotal: fig.subtotal,
      serviceChargeRate,
      serviceCharge: fig.serviceCharge,
      gstRate,
      gst: fig.gstAmount,
      total: fig.totalBeforeAdvance,
    };
    amountPaid = fig.advanceAmount;
  }

  // INTERIM (2026-08-21): the email prints the figures frozen on the interim request — the
  // same ones the PDF prints — never a re-derivation.
  const interimReq = isInterim
    ? await prisma.interimPaymentRequest.findUnique({ where: { invoiceId: inv.id }, include: { stayExtensionRequest: { select: { holdExpiresAt: true, state: true } } } })
    : null;
  const interimFigures = (interimReq?.figures ?? null) as InterimFigures | null;
  const interimPromise = interimReq ? describeInterimPromise(interimReq, formatEmailDate) : null;
  const content = isInterim
    ? renderInterimInvoiceEmail({
        guestDisplayName: displayName,
        invoiceRef: inv.id,
        kind: interimReq?.kind ?? "LONG_STAY",
        checkInDate: interimFigures?.checkIn ? new Date(`${interimFigures.checkIn}T00:00:00.000Z`) : ci,
        checkOutDate: interimFigures?.checkOut ? new Date(`${interimFigures.checkOut}T00:00:00.000Z`) : co,
        currency,
        nightsSlept: interimFigures?.nightsSlept ?? 0,
        nightsToCome: interimFigures?.nightsToCome ?? 0,
        projectedTotal: interimFigures?.projectedTotal ?? Number(toDecimal(inv.totalAmount).toFixed(2)),
        otherChargesSoFar: interimFigures?.otherChargesSoFar ?? 0,
        receivedSoFar: interimFigures?.receivedSoFar ?? paid,
        askLabel: interimFigures?.askLabel ?? "interim payment",
        dueNow: interimFigures?.dueNow ?? Number(toDecimal(inv.totalAmount).toFixed(2)),
        balanceAtCheckout: interimFigures?.balanceAtCheckout ?? 0,
        dueBy: interimPromise ? null : (interimReq?.dueBy ?? null),
        paymentPromise: interimPromise,
        holdExpiresAt:
          interimReq?.stayExtensionRequest && (interimReq.stayExtensionRequest.state === "REQUESTED" || interimReq.stayExtensionRequest.state === "BILLED")
            ? interimReq.stayExtensionRequest.holdExpiresAt
            : null,
      })
    : isPI
    ? renderProformaInvoiceEmail({
        guestDisplayName: displayName,
        invoiceRef: inv.id,
        checkInDate: ci,
        checkOutDate: co,
        guestCount: entry.reservation?.frozenGuestCount ?? entry.guestCount ?? 1,
        currency,
        breakdown: breakdown!,
        amountPaid: paid,
        paymentCount: inv.folio?.payments?.length ?? 0,
        // Real columns only — `ci` is today-defaulted above, and the template must not print a
        // fabricated pay-by date for a dateless entry.
        advanceDueBy: entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null,
        // The guest's recorded plan, worded the same way the PDF prints it (2026-08-08).
        paymentPlan: inv.folio
          ? describeAdvancePaymentPlan(
              resolveAdvancePaymentPlan(inv.folio, entry.segments?.[0]?.startedAt ?? null),
              formatEmailDate,
            )
          : null,
      })
    : renderFinalInvoiceEmail({
        guestDisplayName: displayName,
        invoiceRef: inv.id,
        checkInDate: ci,
        checkOutDate: co,
        currency,
        breakdown: breakdown!,
        amountPaid,
      });

  // Generate the invoice PDF and attach it. Idempotent — subsequent dispatches serve the
  // stored file. Failure is non-fatal: the text email still goes out.
  try {
    const artifact = await generateOrLoadInvoicePdf(prisma, inv.id, actorId);
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
        eventType: "INVOICE.PDF_RENDER_FAILED",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Invoice",
        entityId: inv.id,
        operation: "ALERT",
        timestamp: new Date(),
        entryId: entry.id,
        payload: { invoiceId: inv.id, invoiceType: inv.invoiceType, error: (e as Error)?.message ?? String(e) },
        createdBy: actorId,
      } as any,
    }).catch(() => {});
  }

  await dispatchStageEmailBestEffort(
    {
      prisma,
      entryId: entry.id,
      actorId,
      inquiryId: entry.inquiryId,
      guestEmail: recipient.to,
      skipReason: recipient.skipReason,
      stage: isPI ? Stage.S3 : isInterim ? Stage.S7 : Stage.S9,
      eventTypePrefix: isPI ? "PROFORMA_INVOICE_EMAIL" : isInterim ? "INTERIM_INVOICE_EMAIL" : "FINAL_INVOICE_EMAIL",
    },
    content,
  );
}

export async function recordInvoicePaymentEvent(
  prisma: PrismaClient,
  invoiceId: string,
  actorId: string,
  input: {
    nextState: "PAYMENT_TRACKED" | "RECONCILED";
    paymentRef?: string;
    amount?: number;
    paymentMethod?: string;
    receivedAt?: string;
    referenceNumber?: string;
    proofAttachmentId?: string;
  },
) {
  if (input.nextState !== "PAYMENT_TRACKED" && input.nextState !== "RECONCILED") throw new ValidationError("nextState must be PAYMENT_TRACKED or RECONCILED");
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice");

  if (input.nextState === "PAYMENT_TRACKED") {
    enforceInvoiceStateForPaymentTracked({ currentState: invoice.state });
    // Answer-before-money at S9 (2026-08-17, operator ruling — the S3 proforma rule one
    // stage later): once the FINAL invoice's answer loop exists, the guest's response must
    // be RECORDED before its payment is logged. Bookings whose invoice was dispatched
    // before the loop existed have no FINAL_INVOICE communication and pass — a gate can't
    // demand an answer to a question that was never opened.
    const latestFinalComm = await prisma.communicationRecord.findFirst({
      where: {
        entryId: invoice.entryId,
        commType: "FINAL_INVOICE" as any,
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
      },
      orderBy: { createdAt: "desc" },
    });
    if (latestFinalComm && latestFinalComm.acknowledgementStatus !== "RECEIVED") {
      throw new ValidationError(
        "Record the guest's answer to the final invoice before logging its payment",
      );
    }
  }
  if (input.nextState === "RECONCILED") {
    enforceInvoiceStateForReconciled({ currentState: invoice.state });
  }

  const now = new Date();
  const receivedAt = input.receivedAt?.trim() ? new Date(input.receivedAt) : null;
  if (receivedAt && Number.isNaN(receivedAt.getTime())) throw new ValidationError("receivedAt must be a valid ISO date");
  // Decimal-safe: parse the incoming amount (number or string) into a Decimal so a string like
  // "1099.75" doesn't drift to 1099.7499999... via Number(). Validate on the numeric shape.
  const amountNumeric = input.amount == null ? null : Number(input.amount);
  if (amountNumeric != null && (!Number.isFinite(amountNumeric) || amountNumeric <= 0)) {
    throw new ValidationError("amount must be a positive number when provided");
  }
  const amount = amountNumeric == null ? null : toDecimal(input.amount);
  // Never more than is owed (2026-09-18). The balance floors at zero, so an overpayment was
  // recorded as received while the excess vanished from every balance — money the hotel holds
  // for the payer with nothing on the record to say so. The excess is a refund or a credit,
  // handled on its own.
  if (amount != null && input.nextState === "PAYMENT_TRACKED") {
    const folioNow = await prisma.folio.findUnique({ where: { id: invoice.folioId }, select: { outstandingBalance: true } });
    const owed = toDecimal(folioNow?.outstandingBalance ?? 0);
    if (owed.lte(0)) {
      throw new ValidationError("Nothing is owed on this bill — a payment cannot be recorded against it");
    }
    if (amount.gt(owed)) {
      throw new ValidationError(
        `That is more than the ${owed.toFixed(2)} still owed — record ${owed.toFixed(2)}, and handle the rest as a refund or a credit`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    // SIG-S9 §8.6: record a payment event (optional in this repo for backwards compatibility).
    if (amount != null) {
      const paymentId = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id: paymentId,
          folioId: invoice.folioId,
          invoiceId: invoice.id,
          entryId: invoice.entryId,
          amount,
          paymentDirection: "IN",
          paymentMethod: input.paymentMethod?.trim() ? input.paymentMethod.trim() : "CASH",
          receivedAt: receivedAt ?? now,
          recordedBy: actorId,
          stage: Stage.S9,
          notes: input.referenceNumber?.trim()
            ? `POST_STAY_PAYMENT:${input.referenceNumber.trim()}`
            : input.paymentRef?.trim()
              ? `POST_STAY_PAYMENT:${input.paymentRef.trim()}`
              : "POST_STAY_PAYMENT",
        } as any,
      });
      await recomputeFolioOutstandingBalance(tx, invoice.folioId);
      const folio = await tx.folio.findUniqueOrThrow({ where: { id: invoice.folioId } });
      // Decimal equals — the folio-outstanding recompute writes a 2dp Decimal, so `.equals(0)` is
      // authoritative; using `Number(...) === 0` risked a boundary miss when the balance was 0.005.
      if (toDecimal(folio.outstandingBalance).equals(0) && folio.state === FolioState.OUTSTANDING) {
        await tx.folio.update({
          where: { id: folio.id },
          data: { state: FolioState.SETTLED, outstandingBalance: 0 } as any,
        });
      }
    }

    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        state: input.nextState,
        metadata: {
          ...(invoice.metadata as object | null),
          paymentRef: input.paymentRef ?? null,
          referenceNumber: input.referenceNumber ?? null,
          proofAttachmentId: input.proofAttachmentId ?? null,
          updatedBy: actorId,
          updatedAt: now.toISOString(),
        } as object,
      },
    });
  });
}

export async function writeOffOutstandingBalance(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { amount: number; reason: string },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount must be a positive number");
  await enforceWriteOffConstraints(prisma, { amount: input.amount, reason: input.reason });

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  enforceFolioOutstandingForWriteOff({ folioState: folio.state });

  return prisma.$transaction(async (tx) => {
    const rec = await tx.writeOffRecord.create({
      data: {
        folioId,
        entryId: folio.entryId,
        writtenOffAmount: input.amount,
        reason: input.reason.trim(),
        createdBy: actorId,
      },
    });
    await recomputeFolioOutstandingBalance(tx, folioId);
    await tx.folio.update({ where: { id: folioId }, data: { state: FolioState.WRITTEN_OFF } });
    return rec;
  });
}

async function ensureNoOpenDisputes(db: DbClient, entryId: string) {
  const open = await db.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  enforceNoOpenDisputesForS9Closure({ openDispute: open });
}

async function ensureInvoicesDispatched(db: DbClient, entryId: string, folioId: string) {
  // Only the FINAL invoices — the fiscal documents — must have gone out (2026-09-18). A proforma
  // is generated to move the booking forward and SENDING it is optional (operator ruling
  // 2026-07-28), so one that was only generated left the stay unsealable unless the desk emailed
  // the guest a pre-arrival bill after they had gone; an interim bill never sent was a mid-stay
  // ask the settlement has overtaken. Neither is owed to anyone at closure.
  const bad = await db.invoice.findFirst({ where: { folioId, entryId, state: InvoiceState.DRAFT, invoiceType: InvoiceType.FINAL } });
  enforceInvoicesDispatchedForS9Closure({ draftInvoice: bad });
}

async function ensurePaymentsMatched(db: DbClient, entryId: string, folioId: string) {
  const folio = await db.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.billingModel === "GOVERNMENT") {
    const inv = await db.invoice.findFirst({ where: { folioId, entryId }, orderBy: { createdAt: "desc" } });
    enforceGovernmentInvoicePaymentTrackedForS9Closure({ billingModel: folio.billingModel, latestInvoice: inv ?? undefined });
    return;
  }
  if (folio.billingModel === "DIRECT_BILL") {
    const unmatched = await db.paymentRecord.findFirst({
      where: { folioId, paymentDirection: "IN", invoiceId: null },
      orderBy: { createdAt: "desc" },
    });
    enforceDirectBillPaymentsMatchedForS9Closure({ billingModel: folio.billingModel, unmatchedInPayment: unmatched });
  }
}

async function ensureOutstandingHasW8OrWrittenOff(db: DbClient, entryId: string, folio: { state: FolioState; outstandingBalance: Prisma.Decimal }) {
  const hasW8 = await db.timerRecord.findFirst({ where: { entryId, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" } });
  const hasWriteOff = await db.writeOffRecord.findFirst({ where: { entryId } });
  enforceOutstandingFolioHasW8OrWriteOffForS9Closure({
    folioState: folio.state,
    outstandingBalance: num(folio.outstandingBalance),
    hasScheduledW8: !!hasW8,
    hasWriteOff: !!hasWriteOff,
  });
}

async function ensureInspectionResolved(db: DbClient, entryId: string) {
  const insp = await db.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  let hasNonDeferredCompleted = false;
  if (insp?.isDeferred) {
    const hasCompleted = await db.roomInspectionRecord.findFirst({
      where: { entryId, isDeferred: false },
      orderBy: { createdAt: "desc" },
    });
    hasNonDeferredCompleted = !!hasCompleted;
  }
  const lapsed = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED" },
    orderBy: { createdAt: "desc" },
  });
  enforceInspectionResolvedForS9Closure({
    latestInspection: insp ?? undefined,
    hasNonDeferredCompletedInspection: hasNonDeferredCompleted,
    hasPostCheckoutInspectionWindowExpiredTrace: !!lapsed,
  });
}

async function ensureH5NotOpen(db: DbClient, entryId: string) {
  const h5 = await db.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  enforceH5NotBlockingS9Closure({ h5 });
}

async function ensureEquipmentReturnResolved(db: DbClient, entryId: string) {
  const alloc = await db.equipmentAllocation.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  const breached = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED" },
    orderBy: { createdAt: "desc" },
  });
  const resolved = await (db as any).traceEvent.findFirst({
    where: { entryId, eventType: "EQUIPMENT_RETURN.RESOLVED" },
    orderBy: { createdAt: "desc" },
  });
  enforceEquipmentReturnResolvedForS9Closure({
    allocation: alloc ?? undefined,
    hasDeadlineBreachedTrace: !!breached,
    hasResolvedTrace: !!resolved,
  });
}

async function ensureApartmentDepositResolved(db: DbClient, entry: { id: string; useType: string }, folioId: string) {
  const held = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "IN", notes: { contains: "SECURITY_DEPOSIT_HELD" } },
    orderBy: { createdAt: "desc" },
  });
  const returned = await db.paymentRecord.findFirst({
    where: { folioId, paymentDirection: "OUT", notes: { contains: "SECURITY_DEPOSIT_RETURN" } },
    orderBy: { createdAt: "desc" },
  });
  const zero = await (db as any).traceEvent.findFirst({
    where: { entryId: entry.id, eventType: "SECURITY_DEPOSIT.ZERO_BALANCE_RECORDED" },
    orderBy: { createdAt: "desc" },
  });
  enforceApartmentSecurityDepositResolvedForS9Closure({
    useType: entry.useType,
    hasHeldDeposit: !!held,
    hasReturnOrZeroBalanceEvidence: !!(returned || zero),
  });
}

async function registerW28FeedbackTimer(db: DbClient, entryId: string, actorId: string) {
  const delay = Number(await requireActiveConfigValue<number>(db as any, "feedback.solicitation.delaySeconds"));
  if (!Number.isFinite(delay) || delay < 1) throw new MissingConfigurationError("feedback.solicitation.delaySeconds");
  const dueAt = new Date(Date.now() + delay * 1000);
  const timerRecordId = randomUUID();
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("FEEDBACK_SOLICITATION_W28", { entryId, timerRecordId }, { startAfter: dueAt });
  await db.timerRecord.create({
    data: {
      id: timerRecordId,
      entryId,
      entityType: "Entry",
      entityId: entryId,
      timerType: "FEEDBACK_SOLICITATION_W28",
      timerCode: "FEEDBACK_SOLICITATION_W28",
      dueAt,
      firesAt: dueAt,
      status: "SCHEDULED",
      pgBossJobId,
      createdBy: actorId,
      payload: { entryId, timerRecordId } as any,
    },
  });
}

async function maybeCreateFollowUpTask(db: DbClient, entry: { id: string; useType: string }, actorId: string) {
  if (entry.useType !== "CONFERENCE" && entry.useType !== "GROUP") return;
  const days = Number(await requireActiveConfigValue<number>(db as any, "followUp.deadlineDays"));
  if (!Number.isFinite(days) || days < 1) throw new MissingConfigurationError("followUp.deadlineDays");
  await db.followUpTaskRecord.create({
    data: { entryId: entry.id, dueAt: new Date(Date.now() + days * 86400_000), createdBy: actorId },
  });
}

async function maybeCreateCommissionDue(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { inquiry: { include: { agentProfile: true } }, folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  const agent = entry.inquiry.agentProfile;
  const commissionRateNum = agent?.commissionRate != null ? Number(agent.commissionRate) : null;
  if (!shouldCreateCommissionDueRecord({ hasAgentProfile: !!agent, commissionRate: commissionRateNum })) {
    return { created: false as const };
  }

  const profile = agent!;

  const existing = await db.commissionDueRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (existing) return { created: false as const, existing };

  // If commission basis not configured, create RATE_MISSING and schedule W11.
  const now = new Date();
  const isBasisMissing = profile.commissionBasis == null;
  const commissionDueId = await allocateReadableId(db, "COMMISSION_DUE" as const, now);
  const created = await db.commissionDueRecord.create({
    data: {
      id: commissionDueId,
      entryId,
      agentProfileId: profile.id,
      commissionRate: profile.commissionRate!,
      commissionBasis: profile.commissionBasis ?? null,
      calculatedAmount: isBasisMissing ? null : (entry.folio ? entry.folio.outstandingBalance : null),
      currency: "BTN",
      status: isBasisMissing ? CommissionDueStatus.RATE_MISSING : CommissionDueStatus.PENDING,
      createdBy: "SYSTEM",
    },
  });

  if (created.status === CommissionDueStatus.RATE_MISSING) {
    const resolutionSeconds = Number((await requireActiveConfigValue<number>(db as any, "commission.rateMissing.resolutionSeconds").catch(() => 3600)) ?? 3600);
    const dueAt = new Date(now.getTime() + resolutionSeconds * 1000);
    const timerRecordId = randomUUID();
    const engine = await getTimerEngine();
    const pgBossJobId = await engine.schedule("COMMISSION_RATE_MISSING_W11", { commissionDueId: created.id, timerRecordId }, { startAfter: dueAt });
    await db.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId,
        entityType: "CommissionDueRecord",
        entityId: created.id,
        timerType: "COMMISSION_RATE_MISSING_W11",
        timerCode: "COMMISSION_RATE_MISSING_W11",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        createdBy: "SYSTEM",
        pgBossJobId,
        payload: { commissionDueId: created.id, entryId, timerRecordId },
      },
    });
  }

  return { created: true as const, record: created };
}

async function processNoShowS9IfNeeded(db: DbClient, entryId: string, actorId: string) {
  const entry = await db.entry.findUnique({ where: { id: entryId }, include: { folio: true, noShowDetermination: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");
  if (entry.folio.state !== FolioState.NO_SHOW_CLOSED) return { handled: false as const };
  enforceNoShowDeterminationPresentForS9Closure({
    folioState: entry.folio.state,
    noShowDetermination: entry.noShowDetermination,
  });
  const noShowDetermination = entry.noShowDetermination!;

  // AC-S9-033/034/035: create penalty invoice if retained, ensure refund record if owed, and anchor metadata.
  const determinationId = noShowDetermination.id;
  const penalty = num(entry.folio.noShowPenaltyAmount);
  const net = num(entry.folio.noShowNetPosition);
  enforceNoShowFinancialAmountsNonNegative({ penalty, net });

  if (penalty > 0) {
    const existing = await db.invoice.findFirst({
      where: { entryId, folioId: entry.folio.id, invoiceType: "FINAL", state: "DISPATCHED" },
      orderBy: { createdAt: "desc" },
    });
    if (!existing) {
      await db.invoice.create({
        data: {
          // Readable INV id like every other invoice (2026-09-18) — the schema's uuid default
          // is only a backstop.
          id: await allocateReadableId(db, "INVOICE" as const),
          folioId: entry.folio.id,
          entryId,
          invoiceType: "FINAL",
          state: "DISPATCHED",
          templateKey: "final-v1",
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: { noShowDeterminationId: determinationId, penaltyAmount: penalty } as any,
        },
      });
    }
  }

  if (net > 0) {
    const existingRefund = await db.paymentRecord.findFirst({
      where: { folioId: entry.folio.id, paymentDirection: "OUT", notes: { contains: "NO_SHOW_REFUND" } },
      orderBy: { createdAt: "desc" },
    });
    if (!existingRefund) {
      await db.paymentRecord.create({
        data: {
          // PaymentRecord ids have no default — without one this write threw, so a no-show with a
          // refund owed could never be closed (2026-09-18).
          id: await allocateReadableId(db, "PAYMENT" as const),
          folioId: entry.folio.id,
          entryId,
          amount: net as any,
          paymentDirection: "OUT",
          notes: `NO_SHOW_REFUND:${determinationId}`,
          stage: Stage.S9,
          recordedBy: actorId,
        } as any,
      });
      await recomputeFolioOutstandingBalance(db, entry.folio.id);
    }
  }

  return { handled: true as const, noShowDeterminationId: determinationId, penalty, net };
}

export async function closeEntryAtS9(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotAlreadyClosed({ status: entry.status });
  enforceEntryAtS9ForS9Closure({ currentStage: entry.currentStage });
  if (!entry.folio) throw new NotFoundError("Folio");

  await ensureNoOpenDisputes(prisma, entryId);
  await ensureInvoicesDispatched(prisma, entryId, entry.folio.id);
  await ensurePaymentsMatched(prisma, entryId, entry.folio.id);
  await ensureInspectionResolved(prisma, entryId);
  await ensureH5NotOpen(prisma, entryId);
  await ensureEquipmentReturnResolved(prisma, entryId);
  await ensureApartmentDepositResolved(prisma, { id: entryId, useType: entry.useType }, entry.folio.id);

  // Register retention + feedback timers (stubs), and close the entry + release room claim.
  return prisma.$transaction(async (tx) => {
    await processNoShowS9IfNeeded(tx, entryId, actorId);

    // AC-S8-07: OUTSTANDING folios schedule payment follow-up W8 at S9 closure (may already exist from S8→S9).
    if (entry.folio) {
      await schedulePaymentFollowUpW8IfOutstanding(tx, {
        entryId,
        folioId: entry.folio.id,
        folioState: entry.folio.state,
        outstandingBalance: entry.folio.outstandingBalance,
      });
    }

    if (entry.folio) {
      await ensureOutstandingHasW8OrWrittenOff(tx, entryId, entry.folio);
    }

    // AC-S9-029: exclude no-show closed folios from W28 solicitation.
    if (entry.folio?.state !== FolioState.NO_SHOW_CLOSED) {
      await registerW28FeedbackTimer(tx, entryId, actorId);
    }
    await maybeCreateFollowUpTask(tx, { id: entryId, useType: entry.useType }, "system");
    await maybeCreateCommissionDue(tx, entryId, "SYSTEM");

    // AC-S9-016: release the room inventory claim at closure. Previously only released the
    // latest single RoomAssignment and skipped the audit event entirely. For multi-room
    // bookings or entries that went through a room-change (multiple assignments), extra
    // rooms leaked. Since no housekeeping DEPARTED_DIRTY → DEPARTED_CLEAN → FREE service
    // exists yet, S9 closure is also the only place that unsticks DEPARTED_DIRTY rooms.
    await releaseEntryRoomsToFree(tx, {
      entryId,
      actorId,
      reason: "S9_ENTRY_CLOSED",
    });

    const retentionPeriodDays = await resolveGuestDataRetentionPeriodDays(tx);
    const closedAtInstant = new Date();
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: { status: EntryStatus.CLOSED, closedAt: closedAtInstant, closedBy: actorId, version: { increment: 1 } },
    });

    const retentionDueAt = computeGuestDataRetentionDueAt({ closedAt: closedAtInstant, retentionPeriodDays });
    const retentionTimerId = randomUUID();
    const retentionEngine = await getTimerEngine();
    const retentionPgBossJobId = await retentionEngine.schedule(
      "GUEST_DATA_RETENTION_P18",
      { entryId, timerRecordId: retentionTimerId },
      { startAfter: retentionDueAt },
    );
    await tx.timerRecord.create({
      data: {
        id: retentionTimerId,
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "GUEST_DATA_RETENTION_P18",
        timerCode: "GUEST_DATA_RETENTION_P18",
        dueAt: retentionDueAt,
        firesAt: retentionDueAt,
        status: "SCHEDULED",
        pgBossJobId: retentionPgBossJobId,
        createdBy: "system",
        payload: { entryId, timerRecordId: retentionTimerId },
      },
    });

    const now = closedAtInstant;
    await (tx as any).traceEvent.create({
      data: {
        eventType: "ENTRY_CLOSED",
        actorId,
        actorLevel: "L2",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, closedAt: closedAtInstant.toISOString() },
        createdBy: actorId,
      },
    });
    await (tx as any).traceEvent.create({
      data: {
        eventType: "FOLIO_SEALED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Folio",
        entityId: entry.folio!.id,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { folioId: entry.folio!.id, entryId },
        createdBy: "SYSTEM",
      },
    });
    return updated;
  });
}

export type S9ClosureCheck = { code: string; label: string; met: boolean; detail?: string };

/**
 * What still stands between a booking and "Close & seal" (2026-09-18) — the SAME checks
 * `closeEntryAtS9` runs, each run on its own and caught instead of thrown, so the desk's
 * checklist cannot say "ready" while the close refuses (it had: a lapsed inspection window read
 * as blocked forever, a missing inspection read as ready). Nothing is written.
 *
 * Checks that only apply to some bookings (the payment match for account billing, lent equipment,
 * an apartment deposit, a no-show decision) appear only when they apply. `inspection` carries
 * where the room inspection stands, so the desk can offer to complete a put-off one.
 */
export async function buildS9ClosureReadiness(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, noShowDetermination: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const folio = entry.folio;
  const checks: S9ClosureCheck[] = [];
  const run = async (code: string, label: string, check: () => Promise<unknown> | unknown) => {
    try {
      await check();
      checks.push({ code, label, met: true });
    } catch (e) {
      if (e instanceof AppError && e.status === 409) {
        checks.push({ code, label, met: false, detail: e.body.message });
        return;
      }
      throw e;
    }
  };

  await run("DISPUTES", "No dispute left open", () => ensureNoOpenDisputes(prisma, entryId));
  if (folio) {
    await run("INVOICES", "Every invoice sent — none left as a draft", () => ensureInvoicesDispatched(prisma, entryId, folio.id));
    if (folio.billingModel === "GOVERNMENT" || folio.billingModel === "DIRECT_BILL") {
      await run(
        "PAYMENTS",
        folio.billingModel === "GOVERNMENT" ? "The government invoice's payment tracked" : "Every payment matched to an invoice",
        () => ensurePaymentsMatched(prisma, entryId, folio.id),
      );
    }
    // The close schedules the payment follow-up itself, so an owing folio only fails here when it
    // reads owing with nothing owed.
    await run("BILL", "The bill settled, or left owing for follow-up", () =>
      enforceOutstandingFolioHasW8OrWriteOffForS9Closure({
        folioState: folio.state,
        outstandingBalance: num(folio.outstandingBalance),
        hasScheduledW8: true,
        hasWriteOff: true,
      }),
    );
    if (folio.state === FolioState.NO_SHOW_CLOSED) {
      await run("NO_SHOW", "The no-show decision on record", () =>
        enforceNoShowDeterminationPresentForS9Closure({ folioState: folio.state, noShowDetermination: entry.noShowDetermination }),
      );
    }
  } else {
    checks.push({ code: "FOLIO", label: "A folio for the booking", met: false });
  }
  await run("INSPECTION", "The room inspected, or its inspection window closed", () => ensureInspectionResolved(prisma, entryId));
  await run("H5", "The after-stay handoff done", () => ensureH5NotOpen(prisma, entryId));
  if (await prisma.equipmentAllocation.findFirst({ where: { entryId }, select: { id: true } })) {
    await run("EQUIPMENT", "Lent equipment back", () => ensureEquipmentReturnResolved(prisma, entryId));
  }
  if (entry.useType === "APARTMENT" && folio) {
    await run("DEPOSIT", "The apartment's security deposit returned", () =>
      ensureApartmentDepositResolved(prisma, { id: entryId, useType: entry.useType }, folio.id),
    );
  }

  const standing = await readRoomInspectionStanding(prisma, entryId);
  const insp = standing.inspection;
  const room = insp ? await prisma.room.findUnique({ where: { id: insp.roomId }, select: { roomNumber: true } }) : null;
  const fault =
    standing.state === "PUT_OFF" && insp
      ? await prisma.deficientConditionRecord.findFirst({
          where: { roomId: insp.roomId, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as any },
          orderBy: { detectedAt: "desc" },
          select: { id: true, category: true, description: true },
        })
      : null;

  const atS9 = entry.currentStage === Stage.S9;
  const closed = entry.status === EntryStatus.CLOSED;
  return {
    entryId,
    currentStage: entry.currentStage,
    status: entry.status,
    canClose: atS9 && !closed && checks.every((c) => c.met),
    notReadyReason: closed ? "The booking is already closed" : atS9 ? null : "A booking is closed from the Closed step",
    closeRequiresLevel: "L2" as const,
    checks,
    inspection: {
      state: standing.state,
      inspectionId: insp?.id ?? null,
      roomId: insp?.roomId ?? null,
      roomNumber: room?.roomNumber ?? null,
      inspectedAt: insp?.inspectedAt ?? null,
      deficientFlagStatus: insp?.deficientFlagStatus ?? null,
      damageFound: insp?.damageFound ?? false,
      damageNotes: insp?.damageNotes ?? null,
      windowEndsAt: standing.state === "PUT_OFF" ? standing.windowEndsAt : null,
      windowCanBeClosed: standing.state === "PUT_OFF" && standing.windowTimerScheduled,
      lapsedAt: standing.state === "LAPSED" ? standing.lapsedAt : null,
      openFault: fault,
    },
  };
}

export async function postStayCharge(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; lineType: string; description: string; amount: number; currency?: string; postedAt: string; isPostStay: boolean },
) {
  if (input.isPostStay !== true) throw new ValidationError("isPostStay must be true for S9 post-stay charge");
  const postedAt = new Date(input.postedAt);
  if (Number.isNaN(postedAt.getTime())) throw new ValidationError("postedAt must be a valid ISO date");

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS9ForPostStayCharge({ currentStage: entry.currentStage });
  enforcePostStayChargeNotWithinStayWindow({
    checkInDate: entry.checkInDate,
    checkOutDate: entry.checkOutDate,
    postedAt,
  });

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");

  const created = await prisma.$transaction(async (tx) => {
    const billingModel = await resolveBillingModelForNewLine(tx, folioId, input.lineType as any);
    const line = await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, folioId),
        folioId,
        lineType: input.lineType as any,
        description: input.description,
        amount: input.amount,
        currency: input.currency?.trim() ? input.currency.trim() : "BTN",
        // The posting INSTANT stays on postedAt; the day it belongs to is the hotel's (a
        // 3am post-stay charge is today's, though its UTC date is still yesterday).
        chargeDate: hotelTodayUtc(postedAt),
        stage: Stage.S9,
        postedBy: actorId,
        isPostStay: true,
        postedAt,
        billingModel,
      },
    });
    const noticeCommId = await allocateReadableId(tx, "COMMUNICATION" as const, postedAt);
    await tx.communicationRecord.create({
      data: {
        id: noticeCommId,
        entryId: input.entryId,
        channel: "EMAIL",
        commType: "POST_STAY_CHARGE_NOTICE",
        payload: { folioId, folioLineId: line.id, amount: input.amount, currency: input.currency ?? "BTN" },
        createdBy: actorId,
      },
    });
    await recomputeFolioOutstandingBalance(tx, folioId);
    return line;
  });
  return created;
}

