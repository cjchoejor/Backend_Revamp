import { paperNumber, printedProformaNumber, printedQuotationNumber, proformaNumberOf } from "./document-numbers.js";
import { InvoiceType, PaymentDirection, Prisma, type PrismaClient, type Stage } from "@prisma/client";
import { PolicyGateBlockedError } from "./errors.js";
import { maxZeroSub, sumMoney, toDecimal, ZERO } from "./money.js";
import { allocateReadableId } from "./readable-id.js";

/**
 * Money that has to go back to a guest (2026-11-05, operator: "there was an advance paid before,
 * should we incorporate it to this new proforma or refund the previous one").
 *
 * The rule every reader keeps: WAITING money is really still on the bill, so the ledger and the
 * balance are left alone until a person records it going out, but it no longer counts towards this
 * booking. So what a booking holds for itself is IN − OUT − WAITING. A refund waits only from Set up
 * to Check-in, or on a booking that has ended: the guest cannot be checked in with one standing, so
 * the in-house readers, which read the ledger, never meet one.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Row = { id: string; amount: Prisma.Decimal | number | string; receivedAt: Date | null; createdAt: Date };

/** The refunds still waiting on this bill. */
export async function waitingRefundTotal(db: Db, folioId: string): Promise<Prisma.Decimal> {
  const r = await db.refundRequest.aggregate({ where: { folioId, status: "WAITING" }, _sum: { amountAsked: true } });
  return toDecimal(r._sum.amountAsked);
}

/** The money on the bill: received, less what has gone back. */
export async function netMoneyOnFolio(db: Db, folioId: string): Promise<Prisma.Decimal> {
  const [paidIn, paidOut] = await Promise.all([
    db.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.IN }, _sum: { amount: true } }),
    db.paymentRecord.aggregate({ where: { folioId, paymentDirection: PaymentDirection.OUT }, _sum: { amount: true } }),
  ]);
  return maxZeroSub(toDecimal(paidIn._sum.amount), toDecimal(paidOut._sum.amount));
}

/**
 * The payments still counting, oldest money going back first. `whole` says none of the row has gone
 * back. A refund answers for the earliest money, so a part-refunded row keeps only its remainder.
 */
export function paymentsStillHeld<T extends Row>(rows: readonly T[], gone: Prisma.Decimal): Array<{ row: T; remaining: Prisma.Decimal; whole: boolean }> {
  const sorted = [...rows].sort((a, b) => (a.receivedAt ?? a.createdAt).getTime() - (b.receivedAt ?? b.createdAt).getTime());
  let left = toDecimal(gone);
  const out: Array<{ row: T; remaining: Prisma.Decimal; whole: boolean }> = [];
  for (const row of sorted) {
    const amount = toDecimal(row.amount);
    const taken = left.gt(amount) ? amount : left;
    left = left.sub(taken);
    const remaining = amount.sub(taken);
    if (remaining.gt(0)) out.push({ row, remaining, whole: taken.eq(0) });
  }
  return out;
}

/** The proforma the money was paid against: the one out when it came in, else the one in hand then. */
export async function proformaMoneyWasPaidOn(db: Db, folioId: string, paidAt: Date) {
  const select = { id: true, invoiceNumber: true, documentNumber: true, versionNumber: true, dispatchedAt: true, pdfStorageKey: true, state: true } as const;
  const sent = await db.invoice.findFirst({
    where: { folioId, invoiceType: InvoiceType.PROFORMA, dispatchedAt: { not: null, lte: paidAt } },
    orderBy: { dispatchedAt: "desc" },
    select,
  });
  if (sent) return sent;
  return db.invoice.findFirst({
    where: { folioId, invoiceType: InvoiceType.PROFORMA, createdAt: { lte: paidAt } },
    orderBy: { createdAt: "desc" },
    select,
  });
}

/** What the booking said about an earlier pass's money, when it was for the pass named. */
function answerOfPass(raw: unknown, segmentId: string) {
  const a = (raw ?? null) as { segmentId?: unknown; answer?: unknown; answeredAt?: unknown } | null;
  if (!a || a.segmentId !== segmentId || (a.answer !== "CARRY" && a.answer !== "REFUND")) return null;
  return { answer: a.answer as "CARRY" | "REFUND", answeredAt: typeof a.answeredAt === "string" ? a.answeredAt : null };
}

/**
 * Money paid in an earlier pass, and whether the desk still has to say what happens to it. Asked
 * only at Set up, on a booking that has been sent back: that is where a new proforma is made.
 */
export async function describeEarlierAdvance(db: Db, input: { entryId: string; folioId: string }) {
  const [entry, folio, refunds] = await Promise.all([
    db.entry.findUnique({
      where: { id: input.entryId },
      select: { status: true, currentStage: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true, startedAt: true, segmentNumber: true } } },
    }),
    db.folio.findUnique({
      where: { id: input.folioId },
      select: { earlierAdvanceAnswer: true, payments: true },
    }),
    db.refundRequest.findMany({ where: { folioId: input.folioId }, orderBy: { raisedAt: "desc" }, take: 1 }),
  ]);
  const pass = entry?.segments[0] ?? null;
  const refundRow = refunds[0] ?? null;
  const refund = refundRow
    ? {
        id: refundRow.id,
        status: refundRow.status,
        cause: refundRow.cause,
        amountAsked: Number(toDecimal(refundRow.amountAsked).toFixed(2)),
        refundedAmount: refundRow.refundedAmount == null ? null : Number(toDecimal(refundRow.refundedAmount).toFixed(2)),
        refundMethod: refundRow.refundMethod,
        raisedAt: refundRow.raisedAt.toISOString(),
        closedAt: refundRow.closedAt?.toISOString() ?? null,
        closeNote: refundRow.closeNote,
      }
    : null;
  const nothing = { asked: false, amount: 0, payments: [], paidOn: null, answer: null, refund };
  if (!entry || !folio || !pass) return nothing;

  const inRows = folio.payments.filter((p) => p.paymentDirection === PaymentDirection.IN);
  const outTotal = sumMoney(folio.payments.filter((p) => p.paymentDirection === PaymentDirection.OUT).map((p) => p.amount));
  const before = inRows.filter((p) => (p.receivedAt ?? p.createdAt).getTime() < pass.startedAt.getTime());
  const gone = outTotal.add(await waitingRefundTotal(db, input.folioId));
  const held = paymentsStillHeld(before, gone);
  const amount = sumMoney(held.map((h) => h.remaining));
  const answer = answerOfPass(folio.earlierAdvanceAnswer, pass.id);
  const asked = entry.status === "ACTIVE" && entry.currentStage === "S3" && pass.segmentNumber > 1 && amount.gt(0) && !answer;
  const lastPaidAt = held.length ? (held[held.length - 1]!.row.receivedAt ?? held[held.length - 1]!.row.createdAt) : null;
  const paid = lastPaidAt ? await proformaMoneyWasPaidOn(db, input.folioId, lastPaidAt) : null;
  return {
    asked,
    amount: Number(amount.toFixed(2)),
    payments: held.map((h) => ({
      id: h.row.id,
      amount: Number(h.remaining.toFixed(2)),
      method: h.row.paymentMethod ?? null,
      notes: h.row.notes ?? null,
      receivedAt: (h.row.receivedAt ?? h.row.createdAt).toISOString(),
    })),
    paidOn: paid
      ? { id: paid.id, number: proformaNumberOf(paid), version: paid.versionNumber ?? 1, sentAt: paid.dispatchedAt?.toISOString() ?? null, stored: !!paid.pdfStorageKey }
      : null,
    answer,
    refund,
  };
}

/** The proforma prints this money and Reserve signs it, so neither goes ahead before the answer. */
export async function enforceEarlierAdvanceAnswered(db: Db, entryId: string, folioId: string) {
  const state = await describeEarlierAdvance(db, { entryId, folioId });
  if (state.asked) {
    throw new PolicyGateBlockedError(
      "EARLIER_ADVANCE_NOT_ANSWERED",
      `Nu ${Number(state.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} was paid before this booking was sent back. Say first whether it goes on the new proforma or is refunded.`,
    );
  }
}

/** The bill goes live at check-in, and every figure on it must then be real money. */
export async function enforceNoRefundWaiting(db: Db, folioId: string) {
  const waiting = await db.refundRequest.findFirst({ where: { folioId, status: "WAITING" }, select: { id: true, amountAsked: true } });
  if (waiting) {
    throw new PolicyGateBlockedError(
      "REFUND_WAITING",
      `Nu ${Number(toDecimal(waiting.amountAsked)).toLocaleString("en-US", { minimumFractionDigits: 2 })} is waiting to be refunded (${waiting.id}). The FOM or GM records it on Notifications › Refunds, or keeps it on the booking, before the guest is checked in.`,
    );
  }
}

/** A refund asked for: the money stops counting, and the FOM, GM and admin are told. */
export async function raiseRefundRequestTx(
  tx: Prisma.TransactionClient,
  input: {
    entryId: string;
    folioId: string;
    inquiryId: string | null;
    amount: Prisma.Decimal;
    cause: "RENEGOTIATED" | "LAPSED";
    stage: Stage | null;
    note?: string | null;
    actor: { actorId: string; actorLevel: string };
    now: Date;
    paidOnInvoiceId?: string | null;
  },
) {
  // One waits per bill: more money going back joins it, since two would count one bill twice. A later
  // answer or a lapse can find one standing when money came in after the refund was asked for.
  const open = await tx.refundRequest.findFirst({ where: { folioId: input.folioId, status: "WAITING" } });
  const id = open?.id ?? (await allocateReadableId(tx, "REFUND" as const, input.now));
  const row = open
    ? await tx.refundRequest.update({
        where: { id },
        data: {
          amountAsked: toDecimal(open.amountAsked).add(input.amount),
          note: [open.note, input.note?.trim()].filter(Boolean).join(" · ") || null,
        },
      })
    : await tx.refundRequest.create({
        data: {
          id,
          entryId: input.entryId,
          folioId: input.folioId,
          cause: input.cause,
          amountAsked: input.amount,
          note: input.note?.trim() || null,
          stage: input.stage,
          raisedBy: input.actor.actorId,
          raisedAt: input.now,
          paidOnInvoiceId: input.paidOnInvoiceId ?? null,
        },
      });
  const amount = Number(input.amount.toFixed(2));
  for (const eventType of ["REFUND.ASKED", "NOTIFICATION.REFUND_DUE"]) {
    await tx.traceEvent.create({
      data: {
        eventType,
        actorId: input.actor.actorId,
        actorLevel: input.actor.actorLevel as never,
        entityType: "RefundRequest",
        entityId: id,
        operation: "CREATE",
        timestamp: input.now,
        stageContext: input.stage,
        inquiryId: input.inquiryId,
        entryId: input.entryId,
        payload: {
          entryId: input.entryId,
          refundRequestId: id,
          amount,
          addedToWaiting: !!open,
          totalWaiting: Number(toDecimal(row.amountAsked).toFixed(2)),
          cause: input.cause,
          note: row.note,
          paidOnInvoiceId: row.paidOnInvoiceId,
          ...(eventType.startsWith("NOTIFICATION.") ? { targets: ["FOM", "GM"], severity: "CRITICAL", stage: input.stage } : {}),
        } as Prisma.InputJsonValue,
        createdBy: input.actor.actorId,
      },
    });
  }
  return row;
}

/**
 * A booking that lapses holding money (2026-11-05, operator: "if something like this happens, prompt
 * someone"). Nothing refunded it or told anyone. The money stays on the bill until a person answers.
 */
export async function raiseRefundForLapsedBookingTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; inquiryId: string | null; stage: Stage | null; now: Date },
) {
  const folio = await tx.folio.findUnique({ where: { entryId: input.entryId }, select: { id: true } });
  if (!folio) return null;
  const held = maxZeroSub(await netMoneyOnFolio(tx, folio.id), await waitingRefundTotal(tx, folio.id));
  if (!held.gt(ZERO)) return null;
  const paid = await proformaMoneyWasPaidOn(tx, folio.id, input.now);
  return raiseRefundRequestTx(tx, {
    entryId: input.entryId,
    folioId: folio.id,
    inquiryId: input.inquiryId,
    amount: held,
    cause: "LAPSED",
    stage: input.stage,
    actor: { actorId: "SYSTEM", actorLevel: "SYSTEM" },
    now: input.now,
    paidOnInvoiceId: paid?.id ?? null,
  });
}

/** The booking's cancellation refunds the money itself, so a refund still waiting closes with it. */
export async function closeWaitingRefundsOnCancellationTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; actorId: string; actorLevel: string; now: Date; why: string },
) {
  const waiting = await tx.refundRequest.findMany({ where: { entryId: input.entryId, status: "WAITING" }, select: { id: true, amountAsked: true } });
  for (const r of waiting) {
    await tx.refundRequest.update({
      where: { id: r.id },
      data: { status: "CANCELLED", closeNote: input.why, closedBy: input.actorId, closedAt: input.now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "REFUND.CLOSED_BY_CANCELLATION",
        actorId: input.actorId,
        actorLevel: input.actorLevel as never,
        entityType: "RefundRequest",
        entityId: r.id,
        operation: "UPDATE",
        timestamp: input.now,
        entryId: input.entryId,
        payload: { entryId: input.entryId, refundRequestId: r.id, amount: Number(toDecimal(r.amountAsked).toFixed(2)), why: input.why } as Prisma.InputJsonValue,
        createdBy: input.actorId,
      },
    });
  }
  return waiting.length;
}
