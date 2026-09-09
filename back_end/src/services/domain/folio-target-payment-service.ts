import { PaymentDirection, Stage } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import {
  collectableForTarget,
  computeOutstandingForTarget,
  summariseSettlementTargets,
  type SettlementTarget,
} from "../../lib/folio-outstanding-per-target.js";
import { round2, toDecimal } from "../../lib/money.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import {
  enforceEntryStageForTargetPayment,
  enforceFolioOpenForTargetPayment,
} from "../../policies/13-billing-model/p31-folio-live-required-for-s8-settlement.js";

/**
 * Money taken against ONE slice of a folio — a room or a conference space (2026-09-09, PMS-237).
 *
 * The operator's case: "there are two rooms, different people from the respective rooms can
 * pay", and "in stay, they might pay — keep that option to pay in stay as well". So this is
 * deliberately NOT settlement. Settlement is the act that CLOSES a stay, and it drags the whole
 * S8 apparatus with it — every night audited, the frozen-rate basis reconciled, rooms released,
 * the folio sealed. None of that is true or wanted when a guest hands over money on day three.
 *
 * What this is instead: a payment that knows what it was for. It records money against a slice,
 * moves the folio's balance, and stops. It is valid at S7 (in-house), S8 (at check-out, before
 * or beside settlement) and S9 (post-stay collection) — the three places the operator named.
 *
 * The CAP is the load-bearing rule. A slice can never take more than the folio itself is owed,
 * because an advance already reduced that balance without naming a room — see
 * `folio-outstanding-per-target.ts`. Without the cap, a booking with a 5,000 advance and two
 * rooms owing 2,425 each would happily collect 4,850 more than it is due.
 */
export type RecordTargetPaymentInput = {
  entryId: string;
  /** Exactly one of these. Omit both and the payment belongs to the booking, not a slice. */
  roomId?: string;
  spaceId?: string;
  amount: number | string;
  paymentMethod?: string;
  /** Bank / wallet reference — required for CASH and MOBILE_PAYMENT, as at settlement. */
  paymentVerificationRef?: string;
  notes?: string;
};

export async function recordTargetPayment(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: RecordTargetPaymentInput,
) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId does not match this folio");
  enforceFolioOpenForTargetPayment({ folioState: folio.state });

  const entry = await prisma.entry.findUnique({
    where: { id: folio.entryId },
    select: { id: true, currentStage: true, inquiryId: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryStageForTargetPayment({ currentStage: entry.currentStage });

  const roomId = input.roomId?.trim() || null;
  const spaceId = input.spaceId?.trim() || null;
  if (roomId && spaceId) {
    throw new ValidationError("A payment settles a room OR a space, not both — omit one");
  }
  // Same ownership rule as a charge: any room the booking ever held, any space it was ever
  // allocated. A vacated room's bill is still that room's to pay.
  if (roomId) {
    const owned = await prisma.roomAssignment.findFirst({ where: { entryId: entry.id, roomId } });
    if (!owned) throw new ValidationError("roomId is not a room of this booking");
  }
  if (spaceId) {
    const allocated = await prisma.spaceAllocation.findFirst({ where: { entryId: entry.id, spaceId } });
    if (!allocated) throw new ValidationError("spaceId is not a space of this booking");
  }

  const amountDec = toDecimal(input.amount);
  if (!amountDec.isFinite() || amountDec.lte(0)) throw new ValidationError("amount must be a positive number");

  const method = input.paymentMethod?.trim() || "CASH";
  if ((method === "CASH" || method === "MOBILE_PAYMENT") && !input.paymentVerificationRef?.trim()) {
    throw new ValidationError("paymentVerificationRef is required for CASH and MOBILE_PAYMENT");
  }

  const target: SettlementTarget = roomId ? { roomId } : spaceId ? { spaceId } : "UNASSIGNED";
  const targetOutstanding = await computeOutstandingForTarget(prisma, folioId, target);
  const folioOutstanding = round2(toDecimal(folio.outstandingBalance));
  const collectable = collectableForTarget(targetOutstanding, folioOutstanding);

  if (collectable.lte(0)) {
    throw new ValidationError(
      targetOutstanding.lte(0)
        ? "This part of the bill is already paid — nothing to collect against it"
        : "The booking's balance is already covered by money received — nothing left to collect",
    );
  }
  if (amountDec.gt(collectable)) {
    throw new ValidationError(
      `That is more than this part of the bill can take. It owes ${targetOutstanding.toFixed(2)}` +
        (collectable.lt(targetOutstanding)
          ? `, but only ${collectable.toFixed(2)} of that is still uncovered — the rest is already paid for by money received against the booking.`
          : ` — collect at most ${collectable.toFixed(2)}.`),
    );
  }

  const stage = entry.currentStage;
  const result = await prisma.$transaction(async (tx) => {
    const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
    const payment = await tx.paymentRecord.create({
      data: {
        id: paymentId,
        folioId,
        entryId: entry.id,
        amount: amountDec,
        paymentDirection: PaymentDirection.IN,
        paymentMethod: method,
        receivedAt: new Date(),
        recordedBy: actorId,
        stage,
        roomId,
        spaceId,
        notes:
          input.notes?.trim() ||
          `${method}${input.paymentVerificationRef?.trim() ? `:${input.paymentVerificationRef.trim()}` : ""}`,
      },
    });

    await recomputeFolioOutstandingBalance(tx, folioId);
    const after = await tx.folio.findUniqueOrThrow({
      where: { id: folioId },
      select: { outstandingBalance: true, state: true },
    });
    const targetAfter = await computeOutstandingForTarget(tx, folioId, target);

    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.TARGET_PAYMENT_RECORDED",
        actorId,
        entityType: "Folio",
        entityId: folioId,
        operation: "CREATE",
        timestamp: new Date(),
        stageContext: stage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          paymentId,
          roomId,
          spaceId,
          amount: amountDec.toFixed(2),
          paymentMethod: method,
          targetOutstandingBefore: targetOutstanding.toFixed(2),
          targetOutstandingAfter: targetAfter.toFixed(2),
          folioOutstandingAfter: after.outstandingBalance.toString(),
        },
        createdBy: actorId,
      },
    });

    return { payment, folioOutstandingAfter: after.outstandingBalance, targetAfter };
  });

  // The whole picture back, so the desk re-renders every slice without a second round trip.
  const summary = await summariseSettlementTargets(prisma, folioId);
  return {
    paymentId: result.payment.id,
    amount: Number(amountDec.toFixed(2)),
    roomId,
    spaceId,
    stage,
    targetOutstandingAfter: Number(result.targetAfter.toFixed(2)),
    folioOutstandingAfter: Number(toDecimal(result.folioOutstandingAfter).toFixed(2)),
    targetSettledInFull: result.targetAfter.lte(0),
    folioSettledInFull: toDecimal(result.folioOutstandingAfter).lte(0),
    summary,
  };
}

/** Convenience for callers that hold no client (scripts, workers). */
export async function recordTargetPaymentDefault(
  folioId: string,
  actorId: string,
  input: RecordTargetPaymentInput,
) {
  return recordTargetPayment(defaultPrisma, folioId, actorId, input);
}
