import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, PaymentDirection, Prisma } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { maxZeroSub, minMoney, toDecimal } from "../../lib/money.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { describeEarlierAdvance, netMoneyOnFolio, proformaMoneyWasPaidOn, raiseRefundRequestTx } from "../../lib/refund-money.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { confirmHeldRoomsAfterFullPaymentTx } from "./s3-hold-service.js";
import { carryAdvancePinsAcrossNewPass, evaluateAdvancePaymentConditionTx, reissueProformaTx } from "./s3-payment-service.js";

/**
 * What happens to an advance paid in an earlier pass, and giving money back (2026-11-05, operator:
 * "it can prompt the user, there was an advance paid before, should be incorporate it to this new
 * proforma or refund the previous one"; "fom and gm should also be allowed to enter the account
 * number if refunded by bank or card or online payment with bank name field as well, and the amount
 * refunded, and the journal number, if cash no need").
 *
 * The rule every reader keeps is in lib/refund-money.ts. Nothing here goes out by itself: the desk
 * answers, the FOM, GM or admin record the money actually going back.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

export const REFUND_METHODS = ["CASH", "BANK_TRANSFER", "CARD", "MOBILE_PAYMENT"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** The account's last four, for History, which everyone at the desk can read. */
const accountEnding = (account: string | null) => (account ? account.slice(-4) : null);

/** The sign-off was of a money position that has just changed. */
async function undoSignOffTx(tx: Prisma.TransactionClient, input: { entryId: string; folioId: string; stage: string; actor: Actor; now: Date; cause: string }) {
  const folio = await tx.folio.findUnique({ where: { id: input.folioId }, select: { advancePaymentReconciliationComplete: true } });
  if (!folio?.advancePaymentReconciliationComplete) return false;
  await tx.folio.update({ where: { id: input.folioId }, data: { advancePaymentReconciliationComplete: false } });
  await tx.traceEvent.create({
    data: {
      eventType: "ADVANCE_PAYMENT.RECONCILIATION_UNDONE",
      actorId: input.actor.actorId,
      actorLevel: input.actor.actorLevel,
      entityType: "Folio",
      entityId: input.folioId,
      operation: "UPDATE",
      timestamp: input.now,
      stageContext: input.stage as never,
      entryId: input.entryId,
      payload: { entryId: input.entryId, folioId: input.folioId, cause: input.cause } as Prisma.InputJsonValue,
      createdBy: input.actor.actorId,
    },
  });
  return true;
}

/**
 * This pass's proforma, when a paper of it already exists: it printed the money as it stood, so it
 * is made again. One never opened or sent reads the answer when it is first drawn.
 */
async function remakeProformaIfPrintedTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; folioId: string; passStartedAt: Date; actor: Actor; now: Date; basis: string },
) {
  const printed = await tx.invoice.findFirst({
    where: {
      folioId: input.folioId,
      invoiceType: InvoiceType.PROFORMA,
      state: { not: InvoiceState.SUPERSEDED },
      createdAt: { gte: input.passStartedAt },
      OR: [{ pdfRenderedAt: { not: null } }, { dispatchedAt: { not: null } }],
    },
    select: { id: true },
  });
  if (!printed) return null;
  return reissueProformaTx(tx, { entryId: input.entryId, folioId: input.folioId, changed: true, basisWhenChanged: input.basis, now: input.now }, input.actor);
}

export async function answerEarlierAdvance(
  prisma: PrismaClient,
  entryId: string,
  input: { answer: "CARRY" | "REFUND"; note?: string | null },
  actor: Actor,
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      folio: { select: { id: true } },
      segments: { orderBy: { segmentNumber: "asc" }, select: { id: true, startedAt: true } },
    },
  });
  if (!entry?.folio) throw new NotFoundError("Entry/folio");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const folioId = entry.folio.id;
  const state = await describeEarlierAdvance(prisma, { entryId, folioId });
  if (!state.asked) {
    throw new PolicyGateBlockedError("NO_EARLIER_ADVANCE", "There is no earlier advance waiting for an answer on this booking.");
  }
  const pass = entry.segments[entry.segments.length - 1]!;
  const firstPass = entry.segments[0]!;
  const now = new Date();
  const amount = toDecimal(state.amount);

  // A replaced version keeps the figures that were on the table (2026-08-02).
  const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");

  if (input.answer === "CARRY") {
    // What was asked of the guest comes with the money, re-worked on the new price: "20%" is still
    // 20%. A pin from any earlier pass counts, since the booking may have gone back more than once.
    const carried = await carryAdvancePinsAcrossNewPass(prisma, {
      entryId,
      priorSegmentStartedAt: firstPass.startedAt,
      actor,
      cause: "EARLIER_ADVANCE_CARRIED",
    });
    const printedBefore = await prisma.invoice.count({
      where: { folioId, invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, createdAt: { gte: pass.startedAt }, pdfRenderedAt: { not: null } },
    });
    if (printedBefore > 0) await freezeUnrenderedProformasForEntry(prisma, entryId, actor.actorId).catch(() => {});
    const outcome = await prisma.$transaction(async (tx) => {
      const remade = await remakeProformaIfPrintedTx(tx, { entryId, folioId, passStartedAt: pass.startedAt, actor, now, basis: "EARLIER_ADVANCE_CARRIED" });
      const after = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId, folioId });
      const signOffUndone = !after.paidInFull
        ? await undoSignOffTx(tx, { entryId, folioId, stage: entry.currentStage, actor, now, cause: "EARLIER_ADVANCE_CARRIED_SHORT" })
        : false;
      await tx.traceEvent.create({
        data: {
          eventType: "ADVANCE_PAYMENT.EARLIER_CARRIED",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Folio",
          entityId: folioId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId,
          payload: {
            entryId,
            folioId,
            amount: Number(amount.toFixed(2)),
            payments: state.payments.map((p) => p.id),
            requirementCarried: carried.requirementCarried,
            planCarried: carried.planCarried,
            requiredAmount: after.requiredAmount,
            shortfall: after.shortfall,
            note: input.note?.trim() || null,
            signOffUndone,
          } as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        },
      });
      return { remade, after };
    });
    return {
      answer: "CARRY" as const,
      amount: Number(amount.toFixed(2)),
      requiredAmount: outcome.after.requiredAmount,
      shortfall: outcome.after.shortfall,
      proformaRemade: !!outcome.remade,
    };
  }

  await freezeUnrenderedProformasForEntry(prisma, entryId, actor.actorId).catch(() => {});
  const lastPaidAt = state.payments.length ? new Date(state.payments[state.payments.length - 1]!.receivedAt) : now;
  const paidOn = await proformaMoneyWasPaidOn(prisma, folioId, lastPaidAt);
  const outcome = await prisma.$transaction(async (tx) => {
    const request = await raiseRefundRequestTx(tx, {
      entryId,
      folioId,
      inquiryId: entry.inquiryId,
      amount,
      cause: "RENEGOTIATED",
      stage: entry.currentStage,
      note: input.note,
      actor,
      now,
      paidOnInvoiceId: paidOn?.id ?? null,
    });
    await tx.folio.update({
      where: { id: folioId },
      data: {
        earlierAdvanceAnswer: { segmentId: pass.id, answer: "REFUND", refundRequestId: request.id, answeredAt: now.toISOString(), answeredBy: actor.actorId },
      },
    });
    await undoSignOffTx(tx, { entryId, folioId, stage: entry.currentStage, actor, now, cause: "EARLIER_ADVANCE_REFUNDED" });
    const remade = await remakeProformaIfPrintedTx(tx, { entryId, folioId, passStartedAt: pass.startedAt, actor, now, basis: "EARLIER_ADVANCE_REFUNDED" });
    return { request, remade };
  });
  return { answer: "REFUND" as const, amount: Number(amount.toFixed(2)), refundRequestId: outcome.request.id, proformaRemade: !!outcome.remade };
}

/** The Refunds tab: waiting first, then what was done. For the FOM, GM and admin. */
export async function listRefunds(prisma: PrismaClient, view: "waiting" | "done") {
  const rows = await prisma.refundRequest.findMany({
    where: view === "waiting" ? { status: "WAITING" } : { status: { not: "WAITING" } },
    orderBy: view === "waiting" ? { raisedAt: "asc" } : { closedAt: "desc" },
    take: view === "waiting" ? 200 : 100,
    include: {
      entry: {
        select: {
          id: true,
          inquiryId: true,
          status: true,
          currentStage: true,
          closedAs: true,
          checkInDate: true,
          checkOutDate: true,
          numberOfRooms: true,
          adultCount: true,
          childCount: true,
          guestCount: true,
          contactPersonName: true,
          contactPersonPhone: true,
          guestProfile: { select: { title: true, firstName: true, lastName: true, phone: true, email: true, nationality: true } },
          inquiry: {
            select: {
              sourceChannel: true,
              callerTitle: true,
              callerFirstName: true,
              callerLastName: true,
              callerPhone: true,
              callerEmail: true,
              travelAgent: { select: { displayName: true } },
              corporateAccount: { select: { displayName: true } },
            },
          },
        },
      },
      folio: { select: { payments: { orderBy: { createdAt: "asc" } } } },
    },
  });
  const invoiceIds = [...new Set(rows.map((r) => r.paidOnInvoiceId).filter((x): x is string => !!x))];
  const invoices = invoiceIds.length
    ? await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true, versionNumber: true, dispatchedAt: true, pdfStorageKey: true } })
    : [];
  const invoiceOf = new Map(invoices.map((i) => [i.id, i]));
  const staffIds = [
    ...new Set(
      rows.flatMap((r) => [r.raisedBy, r.closedBy, ...r.folio.payments.map((p) => p.recordedBy)]).filter((x): x is string => !!x && x !== "SYSTEM"),
    ),
  ];
  const staff = staffIds.length ? await prisma.staffUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, title: true, fullName: true } }) : [];
  const nameOf = new Map(staff.map((s) => [s.id, [s.title, s.fullName].filter(Boolean).join(" ")]));
  const person = (id: string | null) => (!id ? null : id === "SYSTEM" ? "The system" : (nameOf.get(id) ?? null));

  return rows.map((r) => {
    const e = r.entry;
    const g = e.guestProfile;
    const inq = e.inquiry;
    const callerName = [inq?.callerTitle, inq?.callerFirstName, inq?.callerLastName].filter(Boolean).join(" ");
    const paper = r.paidOnInvoiceId ? invoiceOf.get(r.paidOnInvoiceId) : null;
    return {
      id: r.id,
      status: r.status,
      cause: r.cause,
      amountAsked: Number(toDecimal(r.amountAsked).toFixed(2)),
      currency: r.currency,
      note: r.note,
      raisedAt: r.raisedAt.toISOString(),
      raisedByName: person(r.raisedBy),
      guest: {
        name: guestDisplayName(g) || callerName || e.contactPersonName || null,
        phone: g?.phone ?? inq?.callerPhone ?? e.contactPersonPhone ?? null,
        email: g?.email ?? inq?.callerEmail ?? null,
        nationality: g?.nationality ?? null,
      },
      booking: {
        id: e.id,
        inquiryId: e.inquiryId,
        status: e.status,
        stage: e.currentStage,
        closedAs: e.closedAs,
        checkInDate: e.checkInDate?.toISOString() ?? null,
        checkOutDate: e.checkOutDate?.toISOString() ?? null,
        rooms: e.numberOfRooms ?? null,
        adults: e.adultCount ?? null,
        children: e.childCount ?? null,
        guests: e.guestCount ?? null,
        party: inq?.travelAgent?.displayName ?? inq?.corporateAccount?.displayName ?? null,
        sourceChannel: inq?.sourceChannel ?? null,
      },
      payments: r.folio.payments
        .filter((p) => p.paymentDirection === PaymentDirection.IN)
        .map((p) => ({
          id: p.id,
          amount: Number(toDecimal(p.amount).toFixed(2)),
          method: p.paymentMethod ?? null,
          notes: p.notes ?? null,
          receivedAt: (p.receivedAt ?? p.createdAt).toISOString(),
          recordedByName: person(p.recordedBy),
        })),
      paidOn: paper ? { id: paper.id, number: paper.invoiceNumber ?? paper.id, version: paper.versionNumber ?? 1, sentAt: paper.dispatchedAt?.toISOString() ?? null, stored: !!paper.pdfStorageKey } : null,
      refundedAmount: r.refundedAmount == null ? null : Number(toDecimal(r.refundedAmount).toFixed(2)),
      refundMethod: r.refundMethod,
      bankName: r.bankName,
      accountNumber: r.accountNumber,
      journalNumber: r.journalNumber,
      closeNote: r.closeNote,
      closedAt: r.closedAt?.toISOString() ?? null,
      closedByName: person(r.closedBy),
    };
  });
}

/** The rest of the money counts on a live booking again, so a Held booking may now be paid up. */
async function settleHeldRoomsTx(prisma: PrismaClient, tx: Prisma.TransactionClient, input: { entryId: string; folioId: string; actorId: string; live: boolean }) {
  if (!input.live) return;
  const after = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId: input.entryId, folioId: input.folioId });
  if (after.paidInFull) await confirmHeldRoomsAfterFullPaymentTx(tx, { entryId: input.entryId, actorId: input.actorId });
}

export async function recordRefund(
  prisma: PrismaClient,
  id: string,
  input: { method: string; amount: number; bankName?: string | null; accountNumber?: string | null; journalNumber?: string | null; note?: string | null },
  actor: Actor,
) {
  const method = input.method?.trim() as RefundMethod;
  if (!REFUND_METHODS.includes(method)) throw new ValidationError("Say how the money went back: cash, bank transfer, card or online payment.");
  const amount = toDecimal(input.amount);
  if (!amount.gt(0)) throw new ValidationError("The amount refunded must be more than nothing.");
  const bankName = input.bankName?.trim() || null;
  const accountNumber = input.accountNumber?.trim() || null;
  const journalNumber = input.journalNumber?.trim() || null;
  if (method !== "CASH") {
    const missing = [!bankName ? "the bank's name" : null, !accountNumber ? "the account number" : null, !journalNumber ? "the journal number" : null].filter(Boolean);
    if (missing.length) throw new ValidationError(`A refund that is not in cash needs ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`);
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const request = await tx.refundRequest.findUnique({
      where: { id },
      include: { entry: { select: { id: true, status: true, currentStage: true, inquiryId: true } } },
    });
    if (!request) throw new NotFoundError("Refund");
    if (request.status !== "WAITING") throw new PolicyGateBlockedError("REFUND_CLOSED", "This refund has already been answered.");
    const onBill = await netMoneyOnFolio(tx, request.folioId);
    const most = minMoney(toDecimal(request.amountAsked), onBill);
    if (amount.gt(most)) {
      throw new ValidationError(`That is more than can go back. The most that can be refunded here is Nu ${Number(most).toLocaleString("en-US", { minimumFractionDigits: 2 })}.`);
    }
    const paymentId = await allocateReadableId(tx, "PAYMENT" as const, now);
    await tx.paymentRecord.create({
      data: {
        id: paymentId,
        folioId: request.folioId,
        entryId: request.entryId,
        amount,
        paymentDirection: PaymentDirection.OUT,
        paymentMethod: method,
        receivedAt: now,
        recordedBy: actor.actorId,
        stage: request.entry.currentStage,
        notes: `REFUND:${request.id}${journalNumber ? `:${journalNumber}` : ""}`,
      },
    });
    await recomputeFolioOutstandingBalance(tx, request.folioId);
    const updated = await tx.refundRequest.update({
      where: { id },
      data: {
        status: "REFUNDED",
        refundedAmount: amount,
        refundMethod: method,
        bankName: method === "CASH" ? null : bankName,
        accountNumber: method === "CASH" ? null : accountNumber,
        journalNumber: method === "CASH" ? null : journalNumber,
        paymentRecordId: paymentId,
        closeNote: input.note?.trim() || null,
        closedBy: actor.actorId,
        closedAt: now,
      },
    });
    const live = request.entry.status === "ACTIVE" || request.entry.status === "PARKED";
    await settleHeldRoomsTx(prisma, tx, { entryId: request.entryId, folioId: request.folioId, actorId: actor.actorId, live });
    const left = maxZeroSub(toDecimal(request.amountAsked), amount);
    await tx.traceEvent.create({
      data: {
        eventType: "REFUND.RECORDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "RefundRequest",
        entityId: id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: request.entry.currentStage,
        inquiryId: request.entry.inquiryId,
        entryId: request.entryId,
        // The account's last four only: History is open to everyone at the desk.
        payload: {
          entryId: request.entryId,
          refundRequestId: id,
          paymentId,
          amount: Number(amount.toFixed(2)),
          stayedOnBill: Number(left.toFixed(2)),
          method,
          bankName: method === "CASH" ? null : bankName,
          accountEnding: method === "CASH" ? null : accountEnding(accountNumber),
          journalNumber: method === "CASH" ? null : journalNumber,
          note: input.note?.trim() || null,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return { id: updated.id, refunded: Number(amount.toFixed(2)), stayedOnBill: Number(left.toFixed(2)), paymentId };
  });
}

/**
 * No refund after all. On a booking still running the money counts again, and at Set up it goes on
 * this pass's proforma. On one that has ended, the hotel keeps it. Either way a person said why.
 */
export async function keepRefund(prisma: PrismaClient, id: string, input: { reason: string }, actor: Actor) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the money is not going back.");
  const request = await prisma.refundRequest.findUnique({
    where: { id },
    include: { entry: { select: { id: true, status: true, currentStage: true, inquiryId: true, segments: { orderBy: { segmentNumber: "asc" }, select: { id: true, startedAt: true } } } } },
  });
  if (!request) throw new NotFoundError("Refund");
  if (request.status !== "WAITING") throw new PolicyGateBlockedError("REFUND_CLOSED", "This refund has already been answered.");
  const entry = request.entry;
  const live = entry.status === "ACTIVE" || entry.status === "PARKED";
  const atSetUp = live && entry.currentStage === "S3";
  const now = new Date();
  const pass = entry.segments[entry.segments.length - 1]!;
  if (atSetUp) {
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, entry.id, actor.actorId).catch(() => {});
  }
  const out = await prisma.$transaction(async (tx) => {
    const fresh = await tx.refundRequest.updateMany({
      where: { id, status: "WAITING" },
      data: { status: "KEPT", closeNote: reason, closedBy: actor.actorId, closedAt: now },
    });
    if (fresh.count === 0) throw new PolicyGateBlockedError("REFUND_CLOSED", "This refund has already been answered.");
    if (atSetUp) {
      await tx.folio.update({
        where: { id: request.folioId },
        data: { earlierAdvanceAnswer: { segmentId: pass.id, answer: "CARRY", cause: "REFUND_KEPT", answeredAt: now.toISOString(), answeredBy: actor.actorId } },
      });
      await remakeProformaIfPrintedTx(tx, { entryId: entry.id, folioId: request.folioId, passStartedAt: pass.startedAt, actor, now, basis: "REFUND_KEPT" });
    }
    await settleHeldRoomsTx(prisma, tx, { entryId: entry.id, folioId: request.folioId, actorId: actor.actorId, live });
    await tx.traceEvent.create({
      data: {
        eventType: "REFUND.KEPT",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "RefundRequest",
        entityId: id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, refundRequestId: id, amount: Number(toDecimal(request.amountAsked).toFixed(2)), reason, bookingLive: live } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return { id, kept: Number(toDecimal(request.amountAsked).toFixed(2)), bookingLive: live };
  });
  return out;
}
