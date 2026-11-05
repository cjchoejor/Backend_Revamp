import type { PrismaClient } from "@prisma/client";
import { FolioState, HoldState, InvoiceState, InvoiceType, PaymentDirection, PreArrivalTaskType, Stage, TaskStatus } from "@prisma/client";
import { AuthorizationError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { sumMoneyBy, toDecimal } from "../../lib/money.js";
import { retireSupersededReplyWaitsBestEffort } from "../../lib/reply-waits.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import {
  armAdvanceFollowUpTx,
  armAdvancePromiseDeadlineTx,
  evaluateAdvancePaymentConditionTx,
  reissueProformaTx,
} from "./s3-payment-service.js";
import { holdRoomsAgainAfterPaymentDeletedTx, releaseOnReEntry } from "./s3-hold-service.js";

/**
 * Deleting an advance payment recorded by mistake (2026-11-05, operator: "sometimes the user might
 * have accidentally recorded it or with the wrong note").
 *
 * The row is DELETED, not marked: 28 files read payments, and a reader that forgot a "not deleted"
 * filter would count money that was never taken. What was deleted, who deleted it and why stay on
 * the booking's history in full (`FOLIO.PAYMENT_DELETED`, the whole row on the trace).
 *
 * Only while the money is still an advance: from Set up to Check-in, on a provisional bill, against
 * the booking as a whole. Once the guest is checked in the bill is live and the money stays on it.
 * Everything a payment set going is put back in the same transaction: the balance, the sign-off, the
 * arrival checklist's tick, Reserved back to Held, the reminders, and a block this payment placed.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const ADVANCE_STAGES = new Set<string>([Stage.S3, Stage.S4, Stage.S5, Stage.S6]);
const ENDED = new Set<string>(["CANCELLED", "EXPIRED", "CLOSED"]);

function whyPaymentStays(
  p: { paymentDirection: PaymentDirection; roomId: string | null; spaceId: string | null; billingModel: string | null; interimPaymentRequestId: string | null; invoiceId: string | null },
  folio: { state: FolioState },
  entry: { status: string; currentStage: string },
): string | null {
  if (ENDED.has(entry.status)) return "The booking has ended, and its record is read-only.";
  if (!ADVANCE_STAGES.has(entry.currentStage) || folio.state !== FolioState.PROVISIONAL) {
    return "The guest is checked in, so this payment is on the live bill and stays there.";
  }
  if (p.paymentDirection !== PaymentDirection.IN) return "Only money received can be deleted.";
  if (p.roomId || p.spaceId || p.billingModel || p.interimPaymentRequestId || p.invoiceId) {
    return "This payment was taken against one part of the bill, so it stays.";
  }
  return null;
}

const NOT_YOURS = "Only the person who recorded it, or the FOM, can delete it.";
const mayDelete = (recordedBy: string | null, actor: Actor) => actor.actorLevel !== "L1" || recordedBy === actor.actorId;

/** The payments the desk lists, newest first, each saying whether this person may delete it. */
export async function describeRecordedPayments(
  prisma: PrismaClient,
  folioId: string,
  actor: Actor,
) {
  const folio = await prisma.folio.findUnique({
    where: { id: folioId },
    select: {
      state: true,
      entry: { select: { status: true, currentStage: true } },
      payments: { where: { paymentDirection: PaymentDirection.IN }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!folio?.entry) return [];
  const byIds = [...new Set(folio.payments.map((p) => p.recordedBy).filter((x): x is string => !!x))];
  const staff = byIds.length ? await prisma.staffUser.findMany({ where: { id: { in: byIds } }, select: { id: true, title: true, fullName: true } }) : [];
  const nameOf = new Map(staff.map((s) => [s.id, [s.title, s.fullName].filter(Boolean).join(" ")]));
  return folio.payments.map((p) => {
    const stays = whyPaymentStays(p, folio, folio.entry!);
    const shutWhy = stays ?? (mayDelete(p.recordedBy, actor) ? null : NOT_YOURS);
    return {
      id: p.id,
      amount: Number(toDecimal(p.amount).toFixed(2)),
      method: p.paymentMethod ?? null,
      notes: p.notes ?? null,
      receivedAt: (p.receivedAt ?? p.createdAt).toISOString(),
      stage: p.stage ?? null,
      recordedByName: p.recordedBy ? (nameOf.get(p.recordedBy) ?? null) : null,
      canDelete: !shutWhy,
      shutWhy,
    };
  });
}

export async function deleteAdvancePayment(
  prisma: PrismaClient,
  input: { folioId: string; paymentId: string; entryId: string; reason: string },
  actor: Actor,
) {
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("Say why the payment is being deleted.");

  const payment = await prisma.paymentRecord.findUnique({
    where: { id: input.paymentId },
    include: {
      folio: {
        include: {
          entry: { include: { guestProfile: true } },
          invoices: { where: { invoiceType: InvoiceType.PROFORMA } },
        },
      },
    },
  });
  if (!payment || payment.folioId !== input.folioId) throw new NotFoundError("Payment");
  const folio = payment.folio;
  const entry = folio.entry;
  if (!entry || folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const stays = whyPaymentStays(payment, folio, entry);
  if (stays) throw new PolicyGateBlockedError("PAYMENT_NOT_DELETABLE", stays);
  if (!mayDelete(payment.recordedBy, actor)) throw new AuthorizationError(NOT_YOURS);

  // A paper made after this money came in printed it as received. At Set up it is made again, as a
  // change of the advance does; once reserved, the desk is told which paper said so.
  const printedIt = folio.invoices.filter(
    (i) => i.state !== InvoiceState.SUPERSEDED && i.pdfRenderedAt && i.pdfRenderedAt.getTime() >= payment.createdAt.getTime(),
  );
  const remake = entry.currentStage === Stage.S3 && printedIt.length > 0;
  if (remake) {
    // A replaced version keeps the figures that were on the table (2026-08-02).
    const { freezeUnrenderedProformasForEntry } = await import("./invoice-pdf-service.js");
    await freezeUnrenderedProformasForEntry(prisma, entry.id, actor.actorId).catch(() => {});
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const held = await tx.paymentRecord.findUnique({ where: { id: payment.id }, select: { id: true } });
    if (!held) throw new NotFoundError("Payment");

    const others = await tx.paymentRecord.findMany({ where: { folioId: folio.id, NOT: { id: payment.id } } });
    const inLeft = sumMoneyBy(others.filter((p) => p.paymentDirection === PaymentDirection.IN), "amount");
    const outAll = sumMoneyBy(others.filter((p) => p.paymentDirection === PaymentDirection.OUT), "amount");
    if (inLeft.lt(outAll)) {
      throw new PolicyGateBlockedError("PAYMENT_NOT_DELETABLE", "A refund has already gone back against this money, so it stays.");
    }

    const balanceBefore = Number(toDecimal(folio.outstandingBalance).toFixed(2));
    const before = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId: entry.id, folioId: folio.id });
    await tx.paymentRecord.delete({ where: { id: payment.id } });
    await recomputeFolioOutstandingBalance(tx, folio.id);
    const after = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId: entry.id, folioId: folio.id });
    const fresh = await tx.folio.findUnique({ where: { id: folio.id }, select: { outstandingBalance: true } });
    const stage = entry.currentStage;

    // The sign-off was of a money position that has just changed.
    let signOffUndone = false;
    let taskReopened = false;
    if (!after.paidInFull) {
      if (folio.advancePaymentReconciliationComplete) {
        await tx.folio.update({ where: { id: folio.id }, data: { advancePaymentReconciliationComplete: false } });
        signOffUndone = true;
        await tx.traceEvent.create({
          data: {
            eventType: "ADVANCE_PAYMENT.RECONCILIATION_UNDONE",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: "Folio",
            entityId: folio.id,
            operation: "UPDATE",
            timestamp: now,
            stageContext: stage,
            inquiryId: entry.inquiryId,
            entryId: entry.id,
            payload: { cause: "PAYMENT_DELETED", paymentId: payment.id, folioId: folio.id },
            createdBy: actor.actorId,
          },
        });
      }
      const task = await tx.preArrivalTask.findFirst({
        where: { entryId: entry.id, taskType: PreArrivalTaskType.PAYMENT_RECONCILIATION, status: TaskStatus.COMPLETE },
        select: { id: true },
      });
      if (task) {
        await tx.preArrivalTask.update({ where: { id: task.id }, data: { status: TaskStatus.PENDING, completedAt: null, completedBy: null } });
        taskReopened = true;
        await tx.traceEvent.create({
          data: {
            eventType: "PRE_ARRIVAL_TASK.REOPENED",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: "PreArrivalTask",
            entityId: task.id,
            operation: "UPDATE",
            timestamp: now,
            stageContext: stage,
            inquiryId: entry.inquiryId,
            entryId: entry.id,
            payload: { taskType: "PAYMENT_RECONCILIATION", cause: "ADVANCE_PAYMENT_DELETED", paymentId: payment.id },
            createdBy: actor.actorId,
          },
        });
      }
    }

    // Reserved goes back to Held when the money that earned it has gone.
    const heldAgain =
      stage !== Stage.S3
        ? await holdRoomsAgainAfterPaymentDeletedTx(tx, {
            entryId: entry.id,
            actor,
            paidInFull: after.paidInFull,
            balanceDueAt: after.paymentPlan?.balanceDueAt ?? null,
          })
        : { held: 0, flagged: false };

    // The reminders that a payment stopped.
    const plan = after.paymentPlan;
    if (!after.paidInFull && plan?.balanceDueAt === "BEFORE_CHECKIN" && plan.promisedBy && new Date(plan.promisedBy).getTime() > now.getTime()) {
      const running = await tx.timerRecord.count({ where: { entryId: entry.id, timerType: "ADVANCE_PROMISE_DEADLINE_W38", status: "SCHEDULED" } });
      if (!running) await armAdvancePromiseDeadlineTx(tx, { entryId: entry.id, folioId: folio.id, promisedBy: plan.promisedBy, stage, actorId: actor.actorId });
    }
    const billInForce = folio.invoices
      .filter((i) => i.state !== InvoiceState.SUPERSEDED && i.dispatchedAt)
      .sort((a, b) => b.dispatchedAt!.getTime() - a.dispatchedAt!.getTime())[0];
    if (before.satisfied && !after.satisfied && billInForce && !remake) {
      const running = await tx.timerRecord.count({ where: { entryId: entry.id, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" } });
      if (!running) await armAdvanceFollowUpTx(tx, { entryId: entry.id, invoiceId: billInForce.id, stage, now, actorId: actor.actorId });
    }

    // A block this very payment placed, with nothing left behind it.
    let blockReleased = false;
    const hold = await tx.committedHold.findUnique({ where: { entryId: entry.id }, select: { state: true, commercialJustification: true } });
    if (
      stage === Stage.S3 &&
      hold?.state === HoldState.PLACED &&
      hold.commercialJustification === `Auto-held on advance payment (${payment.id})` &&
      after.totalReceived <= 0 &&
      !after.creditExtensionActive
    ) {
      await releaseOnReEntry(tx, entry.id, actor, "ADVANCE_PAYMENT_DELETED", { byTheSystem: true });
      blockReleased = true;
    }

    const reissued = remake
      ? await reissueProformaTx(tx, { entryId: entry.id, folioId: folio.id, changed: true, basisWhenChanged: "ADVANCE_PAYMENT_DELETED", now }, actor)
      : null;

    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.PAYMENT_DELETED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "PaymentRecord",
        entityId: payment.id,
        operation: "DELETE",
        timestamp: now,
        stageContext: stage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          paymentId: payment.id,
          reason,
          amount: Number(toDecimal(payment.amount).toFixed(2)),
          method: payment.paymentMethod,
          notes: payment.notes,
          recordedBy: payment.recordedBy,
          receivedAt: (payment.receivedAt ?? payment.createdAt).toISOString(),
          recordedAtStage: payment.stage,
          receivedBefore: before.totalReceived,
          receivedAfter: after.totalReceived,
          balanceBefore,
          balanceAfter: Number(toDecimal(fresh?.outstandingBalance ?? 0).toFixed(2)),
          signOffUndone,
          taskReopened,
          roomsBackToHeld: heldAgain.held,
          blockReleased,
          proformaMadeAgain: reissued?.newInvoiceId ?? null,
          row: JSON.parse(JSON.stringify(payment, (k, v) => (k === "folio" ? undefined : v))),
        },
        createdBy: actor.actorId,
      },
    });

    return {
      deleted: payment.id,
      amount: Number(toDecimal(payment.amount).toFixed(2)),
      receivedAfter: after.totalReceived,
      shortfallAfter: after.shortfall,
      signOffUndone,
      taskReopened,
      roomsBackToHeld: heldAgain.held,
      blockReleased,
      proformaMadeAgain: reissued?.newInvoiceId ?? null,
      // Once reserved no paper is made again: the desk is told which one printed this money.
      paperSaidReceived: remake ? [] : printedIt.filter((i) => i.dispatchedAt).map((i) => i.invoiceNumber ?? i.id),
    };
  });

  if (outcome.proformaMadeAgain) await retireSupersededReplyWaitsBestEffort(prisma, entry.id, actor.actorId);
  return { ...outcome, guest: entry.guestProfile ? guestDisplayName(entry.guestProfile) : null };
}
