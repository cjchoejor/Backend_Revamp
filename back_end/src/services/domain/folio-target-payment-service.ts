import { PaymentDirection, Stage } from "@prisma/client";
import type { Prisma } from "@prisma/client";
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
import { departRoomEarly, type RoomDepartureOutcome } from "./room-early-departure-service.js";
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
  /**
   * Is this room's guest still here? (2026-09-09, operator ruling — "if someone pays for the
   * room, there can be an option like flag the room as guest is still staying, for cases when
   * the guest might pay for the whole stay in advance on day 2, or LEFT if he only paid for 2
   * nights"). Both answers are real and neither is the default:
   *
   *   STILL_STAYING — money now, the room keeps running. Nothing moves but the balance.
   *   LEFT          — the room empties: its assignment row ends today with the frozen figures
   *                   scaled to the nights slept, and the room goes DEPARTED_DIRTY. Giving up
   *                   unstayed nights needs the GM, the same as any early departure.
   *
   * Omitted means "don't touch the room" — a payment must never release a room by accident.
   */
  roomStatus?: "STILL_STAYING" | "LEFT";
  /** Why the room is being released. Recorded on the claim event and the trace. */
  departureReason?: string;
  /**
   * Put part of the ADVANCE against this slice (2026-09-11, operator request: "in case one
   * guest decides to return early, if there is advance paid, have an option where that guest
   * can choose to use all or a percentage or some of the advance paid amount — and note how
   * much was deducted from the advance and what is left").
   *
   * No money moves. The advance is already on the folio; this says WHICH SLICE it answers for,
   * so the room's outstanding falls, the unapplied pool falls with it, and the folio's balance
   * stays exactly where it was. See `folio-outstanding-per-target.ts`.
   *
   *   ALL     — as much of the advance as this slice can absorb
   *   PERCENT — `value`% OF THE ADVANCE (not of the bill), capped at what the slice owes
   *   AMOUNT  — exactly `value`, refused if it exceeds the advance or the slice's own bill
   *
   * Cash may be 0 alongside it: "the advance covers this room, the guest hands over nothing"
   * is the whole point of the early-departure case.
   */
  advanceApplication?: { mode: "ALL" | "PERCENT" | "AMOUNT"; value?: number | string; reason?: string };
};

/** What the requested advance application comes to, and why it isn't more. */
function resolveAdvanceToApply(
  ask: RecordTargetPaymentInput["advanceApplication"],
  unapplied: Prisma.Decimal,
  targetOutstanding: Prisma.Decimal,
): { amount: Prisma.Decimal; cappedBy: "ADVANCE_AVAILABLE" | "SLICE_OWES" | null } {
  if (!ask) return { amount: toDecimal(0), cappedBy: null };
  if (unapplied.lte(0)) {
    throw new ValidationError("There is no unapplied advance on this booking to draw from");
  }

  let wanted: Prisma.Decimal;
  if (ask.mode === "ALL") {
    wanted = unapplied;
  } else if (ask.mode === "PERCENT") {
    const pct = toDecimal(ask.value ?? 0);
    if (!pct.isFinite() || pct.lte(0) || pct.gt(100)) {
      throw new ValidationError("The percentage of the advance to use must be between 0 and 100");
    }
    wanted = round2(unapplied.mul(pct).div(100));
  } else {
    wanted = round2(toDecimal(ask.value ?? 0));
    if (!wanted.isFinite() || wanted.lte(0)) {
      throw new ValidationError("The amount of advance to use must be a positive number");
    }
    // An explicit figure is refused rather than silently trimmed — the operator typed it, so
    // being told why it cannot stand is more useful than a quiet different number.
    if (wanted.gt(unapplied)) {
      throw new ValidationError(
        `Only ${unapplied.toFixed(2)} of the advance is still unapplied — that is the most that can be used`,
      );
    }
    if (wanted.gt(targetOutstanding)) {
      throw new ValidationError(
        `This part of the bill only owes ${targetOutstanding.toFixed(2)} — using more of the advance against it would over-credit it`,
      );
    }
  }

  // ALL and PERCENT are asks about the advance, so they trim to fit the slice rather than refuse.
  if (wanted.gt(targetOutstanding)) return { amount: round2(targetOutstanding), cappedBy: "SLICE_OWES" };
  if (wanted.gt(unapplied)) return { amount: round2(unapplied), cappedBy: "ADVANCE_AVAILABLE" };
  return { amount: round2(wanted), cappedBy: null };
}

export async function recordTargetPayment(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: RecordTargetPaymentInput,
  /** Verified session level — never read from the body; the room-release gate needs the truth. */
  opts?: { actorLevel?: "L1" | "L2" | "L3" | "L4" },
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
  // A space has no guest to still be staying, so the flag is meaningless on one — refuse it
  // rather than accept a word that will be silently dropped.
  if (input.roomStatus && !roomId) {
    throw new ValidationError("Only a ROOM can be flagged as still staying or left — name the room");
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

  // Cash may legitimately be ZERO when the advance is covering this slice, so the positivity
  // check moved below — after we know whether any advance is being applied.
  const amountDec = round2(toDecimal(input.amount ?? 0));
  if (!amountDec.isFinite() || amountDec.lt(0)) throw new ValidationError("amount must be a positive number");

  const method = input.paymentMethod?.trim() || "CASH";
  if (amountDec.gt(0) && (method === "CASH" || method === "MOBILE_PAYMENT") && !input.paymentVerificationRef?.trim()) {
    throw new ValidationError("paymentVerificationRef is required for CASH and MOBILE_PAYMENT");
  }

  const target: SettlementTarget = roomId ? { roomId } : spaceId ? { spaceId } : "UNASSIGNED";
  if (input.advanceApplication && target === "UNASSIGNED") {
    throw new ValidationError(
      "Name the room or space the advance should be put against — applying it to the booking as a whole is where it already sits",
    );
  }

  const targetOutstanding = await computeOutstandingForTarget(prisma, folioId, target);
  const folioOutstanding = round2(toDecimal(folio.outstandingBalance));
  const before = await summariseSettlementTargets(prisma, folioId);
  const unappliedBefore = before.unappliedPayments;

  const advance = resolveAdvanceToApply(input.advanceApplication, unappliedBefore, targetOutstanding);
  const advanceDec = advance.amount;

  // What CASH can still be taken once the advance has done its part. The folio cap survives
  // untouched: applying the advance does not change the folio's balance, so cash can never
  // exceed it — that is what stops the same money being collected twice.
  const cashCap = collectableForTarget(round2(targetOutstanding.sub(advanceDec)), folioOutstanding);

  if (amountDec.lte(0) && advanceDec.lte(0)) {
    throw new ValidationError(
      targetOutstanding.lte(0)
        ? "This part of the bill is already paid — nothing to collect against it"
        : cashCap.lte(0)
          ? "The booking's balance is already covered by money received — apply the advance to this room instead of collecting again"
          : "Enter an amount to collect, or choose how much of the advance to use",
    );
  }
  if (amountDec.gt(cashCap)) {
    throw new ValidationError(
      `That is more than this part of the bill can take. It owes ${targetOutstanding.toFixed(2)}` +
        (advanceDec.gt(0) ? `, of which ${advanceDec.toFixed(2)} is being covered by the advance` : "") +
        (cashCap.lt(targetOutstanding)
          ? `, and only ${cashCap.toFixed(2)} is still uncovered — the rest is already paid for by money received against the booking.`
          : ` — collect at most ${cashCap.toFixed(2)}.`),
    );
  }

  const stage = entry.currentStage;
  const result = await prisma.$transaction(async (tx) => {
    // The advance application first: it is the cheaper write and, if the pool moved under us
    // between the read and here, we would rather fail before taking the guest's money.
    let applicationId: string | null = null;
    if (advanceDec.gt(0)) {
      const app = await tx.advanceApplication.create({
        data: {
          folioId,
          entryId: entry.id,
          roomId,
          spaceId,
          amount: advanceDec,
          stage,
          appliedBy: actorId,
          reason: input.advanceApplication?.reason?.trim() || input.notes?.trim() || null,
          basis: {
            mode: input.advanceApplication!.mode,
            value: input.advanceApplication?.value != null ? String(input.advanceApplication.value) : null,
            unappliedBefore: unappliedBefore.toFixed(2),
            targetOutstandingBefore: targetOutstanding.toFixed(2),
            cappedBy: advance.cappedBy,
          },
        },
      });
      applicationId = app.id;
    }

    // Only real money gets a PaymentRecord. An advance-only settlement writes none, because
    // nothing arrived — the folio's balance must not move for an attribution.
    let payment: { id: string } | null = null;
    if (amountDec.gt(0)) {
      const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
      payment = await tx.paymentRecord.create({
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
    }

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
          paymentId: payment?.id ?? null,
          roomId,
          spaceId,
          amount: amountDec.toFixed(2),
          paymentMethod: amountDec.gt(0) ? method : null,
          advanceApplicationId: applicationId,
          advanceApplied: advanceDec.toFixed(2),
          advanceMode: input.advanceApplication?.mode ?? null,
          unappliedAdvanceBefore: unappliedBefore.toFixed(2),
          targetOutstandingBefore: targetOutstanding.toFixed(2),
          targetOutstandingAfter: targetAfter.toFixed(2),
          folioOutstandingAfter: after.outstandingBalance.toString(),
        },
        createdBy: actorId,
      },
    });

    return { payment, applicationId, folioOutstandingAfter: after.outstandingBalance, targetAfter };
  });

  // The room release runs AFTER the money is durably recorded, and on its own. Order is the
  // point: if the release fails its authority gate, the payment must still stand — the guest
  // handed over money and "the amount paid and remainder are not lost" was the operator's
  // explicit requirement. The caller is told what happened either way.
  let departure: RoomDepartureOutcome | null = null;
  let departureRefused: string | null = null;
  if (input.roomStatus === "LEFT" && roomId) {
    try {
      departure = await departRoomEarly(prisma, {
        entryId: entry.id,
        roomId,
        actorId,
        actorLevel: opts?.actorLevel ?? "L1",
        reason: input.departureReason,
      });
    } catch (e) {
      departureRefused = e instanceof Error ? e.message : "The room could not be released";
    }
  }

  // The whole picture back, so the desk re-renders every slice without a second round trip.
  const summary = await summariseSettlementTargets(prisma, folioId);
  return {
    departure,
    departureRefused,
    roomStatus: input.roomStatus ?? null,
    paymentId: result.payment?.id ?? null,
    amount: Number(amountDec.toFixed(2)),
    /** What was taken out of the advance, and what is left of it — the operator's own question. */
    advanceApplied: Number(advanceDec.toFixed(2)),
    advanceApplicationId: result.applicationId,
    advanceRemaining: Number(summary.unappliedPayments.toFixed(2)),
    advanceCappedBy: advance.cappedBy,
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
