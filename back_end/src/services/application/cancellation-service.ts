import { closeWaitingRefundsOnCancellationTx } from "../../lib/refund-money.js";
import { hotelLocalTimeOn } from "../../lib/stay-dates.js";
import { resolveStandardCheckInTime } from "../../lib/expected-arrival.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { heldAfterTripCover, planTripCancelMoves, simulateTripCancels, type TripCancelCharge, type TripMove } from "../../lib/trip-advance-cover.js";
import { cancellationChargeOn, type CancellationRule } from "../../lib/cancellation-policy.js";
import { applyAdvanceStandingTx } from "../domain/s3-folio-service.js";
import { readTripAdvanceRows } from "../domain/s3-payment-service.js";
import { releaseRoomClaimIfOwnedTx } from "../../lib/room-claim-state.js";
import { ActorLevel, EntryStatus, FolioLineType, FolioState, HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceEntryAtS3ForS3CancellationRoute, enforceEntryAtS5ForS5CancellationRoute,
  enforceEntryBeforeSetupForDecline,
  enforceEntryConfirmedForPreArrivalCancellation, enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { lapseNegotiationRecordsTx } from "../../lib/negotiation-expiry.js";
import { ENTRY_ENDINGS } from "../../lib/entry-ending.js";
import { releaseEntryRoomsToFree } from "../../lib/room-claim-state.js";
import * as auditService from "../infrastructure/audit-service.js";
import {
  capCancellationPenaltyAtAdvancePayment,
  computePostCheckInEarlyDeparturePenalty,
  computeS5PreArrivalCancellationPenalty,
  enforceFolioPresentForS5CancellationPolicy35,
  enforceReservationPresentForS5CancellationPolicy35,
  sumAdvancePaymentInTotalForFolio,
  type CancellationPolicyTiersConfig,
} from "../../policies/14-cancellation/p35-cancellation-penalty-from-commitment.js";
import { enforceGmAuthorityForCancellationPenaltyWaiver } from "../../policies/14-cancellation/p35-penalty-waiver-requires-gm-authority.js";
import { generateCancellationConfirmationPdf } from "../domain/cancellation-confirmation-pdf-service.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import type { ActorLevel as RequestActorLevel } from "../../types/actor.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId, allocateFolioLineId } from "../../lib/readable-id.js";
import { transitionRoomClaimState } from "../../lib/room-claim-state.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { toDecimal } from "../../lib/money.js";
import { resolveRefundMethod } from "../../lib/refund-method.js";

/**
 * The guest said no — ending a lead at Inquiry or Negotiation (2026-10-01, operator request:
 * "we can have that in one of the tabs beside 'this step'").
 *
 * **It is not the cancellation route one stage down.** `cancelEntryAtS3` exists because by Set
 * up there is a folio, a disclosed cancellation term and usually an advance: it prices a
 * penalty, refunds the balance, supersedes the paperwork. None of that is true here — nothing
 * has been committed, so nothing is priced and nothing is refunded. What this records is the
 * ANSWER, which the house had no way to write down: until now a lead that said no could only
 * be parked (a pause — it comes back) or left to the clock, which lapses it as **Expired**,
 * indistinguishable from an enquiry nobody ever answered.
 *
 * **Authority is L1**, by the same doctrine as everything else on the desk: authority follows
 * what moved. Nothing has. The front desk is the one on the phone when the guest says no.
 *
 * A **parked** lead may be turned down — the guest ringing back to decline is precisely the
 * case a park is waiting for. A booking carrying a folio or a reservation is refused even at
 * S2 (a re-entered booking keeps its folio across passes): that money is Set up's to end.
 */
export async function declineEntryBeforeSetup(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts: {
    reason: string;
    actorLevel?: RequestActorLevel;
    /**
     * INTERNAL ONLY — never on the HTTP route (2026-10-19). Set by the combine act: this booking's
     * guests and rooms were just added to the same guest's other booking, so it ends COMBINED, not
     * turned down — the guest said no to nothing. Everything else is the decline's own release.
     */
    combinedInto?: string;
  },
) {
  const reason = opts.reason?.trim();
  if (!reason) throw new ValidationError("Say why the booking is being turned down — it is the whole point of recording it.");

  const now = new Date();
  const engine = await getTimerEngine();

  return prisma.$transaction(async (tx) => {
    const entry = await tx.entry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        inquiryId: true,
        currentStage: true,
        status: true,
        version: true,
        folio: { select: { id: true } },
        reservations: { select: { id: true }, take: 1 },
      },
    });
    if (!entry) throw new NotFoundError("Entry");

    enforceEntryBeforeSetupForDecline({ currentStage: entry.currentStage });

    if (entry.status !== EntryStatus.ACTIVE && entry.status !== EntryStatus.PARKED) {
      throw new StateTransitionError(
        `This booking is already ${entry.status === EntryStatus.CANCELLED ? "cancelled" : entry.status.toLowerCase()} — a sealed record is read-only.`,
      );
    }
    if (entry.folio || entry.reservations.length > 0) {
      throw new StateTransitionError(
        "This booking already carries a folio or a confirmed reservation from an earlier pass — end it through the cancellation route, which settles what was taken.",
      );
    }

    // The stage is deliberately NOT moved to TERMINAL the way the cancellation routes move
    // it: the step the lead died at is worth keeping on screen, and since 2026-10-01 it is
    // `closedAs` the desk reads its words from, not the stage.
    await tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        closedAt: now,
        closedBy: actorId,
        closedAs: opts.combinedInto ? ENTRY_ENDINGS.COMBINED : ENTRY_ENDINGS.DECLINED,
        closedReason: reason,
        version: { increment: 1 },
      },
    });

    // Everything the lead was still holding goes back, exactly as a lapse releases it: the room
    // claim flags, the marked rooms' hold rows, the live offers, every clock on the booking.
    const rooms = await releaseEntryRoomsToFree(tx, { entryId, actorId, reason: "ENTRY_DECLINED", now });
    const lapsed = await lapseNegotiationRecordsTx(tx, engine, { entryId, now, cause: "DECLINED" });

    await auditService.emit(tx as any, { actorId, actorLevel: (opts.actorLevel ?? "L1") as any }, {
      eventType: opts.combinedInto ? "ENTRY.COMBINED_INTO" : "ENTRY.DECLINED",
      entityType: "Entry",
      entityId: entryId,
      operation: "TRANSITION",
      timestamp: now,
      stageContext: entry.currentStage as any,
      payload: {
        entryId,
        fromStatus: entry.status,
        toStatus: "CANCELLED",
        declinedAt: entry.currentStage,
        reason,
        ...(opts.combinedInto ? { combinedInto: opts.combinedInto } : {}),
        roomsReleased: rooms.transitioned,
        ...lapsed,
      },
      inquiryId: entry.inquiryId,
      entryId,
      createdBy: actorId,
    });

    return {
      entryId,
      status: EntryStatus.CANCELLED,
      declinedAt: entry.currentStage,
      reason,
      roomsReleased: rooms.transitioned,
      ...lapsed,
    };
  });
}

export type CancellationFigures = {
  tripMoves: Array<{ fromEntryId: string; toEntryId: string; fromStayNo: number; toStayNo: number; amount: number }>;
  /** The step the booking is cancelled at — Set up (S3) or Arrival (S5). */
  stage: "S3" | "S5";
  /** Money received against the booking (the advance). */
  advanceReceived: number;
  /** The charge the disclosed terms put on this cancellation, capped at what was received. */
  charge: number;
  /** What goes back to the guest: received − charge. */
  refund: number;
  /** The terms' charge before the cap, for the desk to say when the cap applied. */
  chargeBeforeCap: number;
  /** The charge after the cap, before any waiver. */
  chargeCapped: number;
  hoursUntilCheckIn: number;
  /** Whole days from the hotel's today to the arrival day (2026-11-10). */
  daysBeforeArrival: number;
  /** The line of the policy that applied, with its words ("30 to 44 days before arrival · 50% of the advance paid"). */
  rule: { basis: CancellationRule["basis"]; value: number; label: string; from: CancellationRule["from"] };
  waived: boolean;
};

/**
 * The money a cancellation would move, computed and nothing written (2026-09-18) — shared by the
 * Set-up and Arrival cancellations and the preview the desk shows before the irreversible click
 * (the dialog promised "the disclosed charge, if any, is posted and the rest refunded" without a
 * figure). One computation, so the preview can never disagree with the act.
 *   - Set up (S3): the terms DISCLOSED to the guest; no reservation is frozen yet.
 *   - Arrival (S5): the terms FROZEN on the reservation; the configured tiers fill any gap.
 */
async function cancellationFigures(
  prisma: PrismaClient,
  input: {
    entryId: string;
    stage: "S3" | "S5";
    folioId: string;
    checkInDate: Date;
    terms: Record<string, unknown>;
    waiver: boolean;
    now: Date;
  },
): Promise<CancellationFigures> {
  // A bill with charges on it is a stay, not a booking to cancel (2026-10-26, found on
  // ENT-20260912-0001: sent back from Stay to Set up, its cancel screen offered to refund the
  // advance to a guest who still owed Nu 3,753.75 for what they had eaten — only the "no SETTLED
  // with a balance" guard stopped it, with a message nobody could act on). Nothing posts charges
  // before Stay, so any line here came from a stay; refuse before a figure is shown.
  const charged = await prisma.folioLine.aggregate({ where: { folioId: input.folioId }, _sum: { amount: true }, _count: true });
  if (charged._count > 0) {
    const sum = toDecimal(charged._sum.amount ?? 0).toFixed(2);
    throw new ValidationError(
      `This bill already has charges from the stay on it (Nu ${Number(sum).toLocaleString("en-US", { minimumFractionDigits: 2 })}), so the booking can't be cancelled — cancelling would hand back money the guest owes. The bill has to be settled instead.`,
    );
  }
  const ownHeld = await sumAdvancePaymentInTotalForFolio(prisma, input.folioId);
  const { rule, hoursUntilCheckIn, daysBeforeArrival } = await rawCancellationCharge(prisma, input);
  // Money paid for the trip is one pot (2026-11-09): this stay's bill first gets, or gives up, what
  // the other stays' advances mean it should hold. Then the ordinary cancellation runs on that.
  // A share of the advance paid (2026-11-10) is taken of what the stay holds once its cover from
  // the trip's money is home, as if it had paid its own advance.
  const withCharge = await tripCancelPlan(prisma, input.entryId, toDecimal(ownHeld), (paid) => toDecimal(cancellationChargeOn(rule, paid ?? ownHeld)));
  const rawPenalty = Number(withCharge.charge.toFixed(2));
  const plan = input.waiver ? await tripCancelPlan(prisma, input.entryId, toDecimal(ownHeld), toDecimal(0)) : withCharge;
  const netIn = plan.moves.reduce((sum, m) => (m.to === input.entryId ? sum.add(m.amount) : m.from === input.entryId ? sum.sub(m.amount) : sum), toDecimal(0));
  const advanceReceived = Number(toDecimal(ownHeld).add(netIn).toFixed(2));
  const capped = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceReceived);
  const charge = input.waiver ? 0 : capped;
  // Decimal-safe: the refund is the received total less the charge, to the cent.
  const refund = Number(toDecimal(advanceReceived).sub(toDecimal(charge)).toFixed(2));
  return {
    stage: input.stage,
    advanceReceived,
    charge,
    refund,
    chargeBeforeCap: rawPenalty,
    chargeCapped: capped,
    hoursUntilCheckIn,
    daysBeforeArrival,
    rule: { basis: rule.basis, value: rule.value, label: rule.label, from: rule.from },
    waived: input.waiver,
    tripMoves: moveWords(plan.moves, plan.rows),
  };
}

async function rawCancellationCharge(
  prisma: PrismaClient,
  input: { stage: "S3" | "S5"; checkInDate: Date; terms: Record<string, unknown>; now: Date },
) {
  // Arrival bubbles a config-store failure (never a silent zero charge); Set up falls back to the
  // disclosed terms alone, as it always has.
  const policyTiers =
    input.stage === "S5"
      ? await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers")
      : await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers").catch(
          () => null as CancellationPolicyTiersConfig | null,
        );
  // Time left is counted to the hotel's check-in time on the arrival day (2026-11-10).
  const checkInAt = hotelLocalTimeOn(input.checkInDate, await resolveStandardCheckInTime(prisma));
  return computeS5PreArrivalCancellationPenalty({
    now: input.now,
    checkInDate: input.checkInDate,
    checkInAt,
    frozenCancellationTerms: input.terms,
    policyTiers,
  });
}

type TripRows = Awaited<ReturnType<typeof readTripAdvanceRows>>;

const moveWords = (moves: TripMove[], rows: TripRows) =>
  moves.map((m) => {
    const from = rows.find((r) => r.entryId === m.from);
    const to = rows.find((r) => r.entryId === m.to);
    return { fromEntryId: m.from, toEntryId: m.to, fromStayNo: from?.stayNo ?? 0, toStayNo: to?.stayNo ?? 0, amount: Number(m.amount.toFixed(2)) };
  });

/** The bills that can still give or take money, this stay's holding what the cancellation reads. */
async function tripCancelPlan(db: PrismaClient | Prisma.TransactionClient, entryId: string, ownHeld: Prisma.Decimal, charge: TripCancelCharge) {
  const me = await db.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  const at = (rows: TripRows) => (typeof charge === "function" ? charge(heldAfterTripCover(rows, entryId) ?? ownHeld) : charge);
  if (!me) return { inquiryId: null as string | null, rows: [] as TripRows, moves: [] as TripMove[], charge: at([]) };
  const rows = (await readTripAdvanceRows(db, me.inquiryId))
    .filter((r) => r.entryId === entryId || r.folioOpen)
    .map((r) => (r.entryId === entryId ? { ...r, held: ownHeld } : r));
  const c = at(rows);
  return { inquiryId: me.inquiryId, rows, moves: planTripCancelMoves(rows, entryId, c), charge: c };
}

/**
 * Put the trip's money where it belongs before this stay is cancelled: one money-out row and one
 * money-in row per move, sharing a reference, so the two bills change and the hotel's money does not.
 * Worked out again under the trip's lock, and refused if it no longer matches what the desk was shown.
 */
async function applyTripMovesTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: { entryId: string; folioId: string; charge: number; shown: Array<{ fromEntryId: string; toEntryId: string; amount: number }>; actorId: string; actorLevel: ActorLevel; now: Date },
) {
  if (!input.shown.length) return;
  const own = await sumAdvancePaymentInTotalForFolio(prisma, input.folioId);
  const first = await tx.entry.findUnique({ where: { id: input.entryId }, select: { inquiryId: true } });
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", `trip-payment:${first!.inquiryId}`);
  const plan = await tripCancelPlan(tx, input.entryId, toDecimal(own), toDecimal(input.charge));
  const same =
    plan.moves.length === input.shown.length &&
    plan.moves.every((m, i) => m.from === input.shown[i].fromEntryId && m.to === input.shown[i].toEntryId && m.amount.equals(toDecimal(input.shown[i].amount)));
  if (!same) throw new ValidationError("The trip's money has just changed. Look at the figures again.");
  for (const [i, m] of plan.moves.entries()) {
    const from = plan.rows.find((r) => r.entryId === m.from)!;
    const to = plan.rows.find((r) => r.entryId === m.to)!;
    const ref = `cancel:${input.entryId}:${i + 1}`;
    const method = await resolveRefundMethod(tx, from.folioId);
    const words = `Trip's money moved from stay ${from.stayNo} to stay ${to.stayNo} when ${input.entryId} was cancelled`;
    for (const side of [
      { row: from, direction: "OUT" as const },
      { row: to, direction: "IN" as const },
    ]) {
      await tx.paymentRecord.create({
        data: {
          id: await allocateReadableId(tx, "PAYMENT" as const, input.now),
          folioId: side.row.folioId,
          entryId: side.row.entryId,
          amount: m.amount,
          paymentDirection: side.direction,
          paymentMethod: method,
          receivedAt: input.now,
          recordedBy: input.actorId,
          stage: side.row.stage,
          notes: words,
          paidForTrip: side.direction === "IN",
          tripTransferRef: ref,
        },
      });
      await recomputeFolioOutstandingBalance(tx, side.row.folioId);
      await tx.traceEvent.create({
        data: {
          eventType: "FOLIO.TRIP_MONEY_MOVED",
          actorId: input.actorId,
          actorLevel: input.actorLevel,
          entityType: "Folio",
          entityId: side.row.folioId,
          operation: "UPDATE",
          timestamp: input.now,
          stageContext: side.row.stage,
          inquiryId: first!.inquiryId,
          entryId: side.row.entryId,
          payload: { reference: ref, direction: side.direction, amount: m.amount.toFixed(2), fromEntryId: m.from, toEntryId: m.to, cancelledEntryId: input.entryId },
          createdBy: input.actorId,
        },
      });
    }
  }
  for (const r of plan.rows) {
    if (r.entryId !== input.entryId) await applyAdvanceStandingTx(prisma, tx, { entryId: r.entryId, folioId: r.folioId, actorId: input.actorId });
  }
}

/**
 * What cancelling several stays of a trip would charge and refund, one after another in stay order,
 * with the money that moves between them. Nothing written.
 */
export async function previewTripCancellation(prisma: PrismaClient, entryId: string, input: { stayIds: string[]; waive?: boolean }) {
  const me = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  if (!me) throw new NotFoundError("Entry");
  const stays = await prisma.entry.findMany({
    where: { inquiryId: me.inquiryId, id: { in: input.stayIds } },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    include: { folio: true, reservation: true, cancellationDisclosure: true },
  });
  if (stays.length !== new Set(input.stayIds).size) throw new ValidationError("One of those is not a stay of this trip.");
  const now = new Date();
  const waive = input.waive === true;
  const picks: Array<{ entryId: string; own: number; rule: CancellationRule }> = [];
  for (const st of stays) {
    if (!st.folio) throw new ValidationError(`${st.id} has no bill yet — nothing to charge or refund.`);
    const atSetUp = st.currentStage === Stage.S3;
    const { rule } = await rawCancellationCharge(prisma, {
      stage: atSetUp ? "S3" : "S5",
      checkInDate: atSetUp ? (st.checkInDate ?? new Date(now.getTime() + 86400_000)) : st.reservation!.frozenCheckInDate,
      terms: ((atSetUp ? st.cancellationDisclosure?.disclosedTerms : st.reservation?.frozenCancellationTerms) as Record<string, unknown>) ?? {},
      now,
    });
    picks.push({ entryId: st.id, own: await sumAdvancePaymentInTotalForFolio(prisma, st.folio.id), rule });
  }
  const all = await readTripAdvanceRows(prisma, me.inquiryId);
  const rows = all
    .filter((r) => r.folioOpen || picks.some((p) => p.entryId === r.entryId))
    .map((r) => {
      const p = picks.find((x) => x.entryId === r.entryId);
      return p ? { ...r, held: toDecimal(p.own) } : r;
    });
  // Each stay's charge as the policy puts it (a share of the advance is taken of what it holds once
  // its cover is home); a waiver then runs the same stays with no charge.
  // With no money paid for the trip there are no trip rows: a stay's share is of its own money.
  const charged = simulateTripCancels(rows, picks.map((p) => ({ entryId: p.entryId, charge: (paid: Prisma.Decimal | null) => toDecimal(cancellationChargeOn(p.rule, paid ?? p.own)) })));
  const out = waive ? simulateTripCancels(rows, picks.map((p) => ({ entryId: p.entryId, charge: toDecimal(0) }))) : charged;
  const lines = await Promise.all(
    picks.map(async (p, i) => {
      const raw = Number(charged[i].charge.toFixed(2));
      const heldCharged = charged[i].held != null ? Number(charged[i].held!.toFixed(2)) : p.own;
      const held = out[i].held != null ? Number(out[i].held!.toFixed(2)) : p.own;
      const capped = capCancellationPenaltyAtAdvancePayment(raw, heldCharged);
      const charge = waive ? 0 : capped;
      return { entryId: p.entryId, advanceReceived: held, charge, chargeBeforeCap: raw, chargeCapped: capped, rule: p.rule.label, refund: Number(toDecimal(held).sub(toDecimal(charge)).toFixed(2)) };
    }),
  );
  const sum = (k: "charge" | "refund") => Number(lines.reduce((t, l) => t.add(toDecimal(l[k])), toDecimal(0)).toFixed(2));
  return { stays: lines, moves: moveWords(out.flatMap((x) => x.moves), rows), totalCharge: sum("charge"), totalRefund: sum("refund"), waived: waive };
}

/**
 * What cancelling this booking now would charge and refund — nothing written (2026-09-18).
 * Valid at Set up (S3) and Arrival (S5), the two steps a booking is cancelled at.
 */
export async function previewCancellation(prisma: PrismaClient, entryId: string, opts?: { penaltyWaiverRequested?: boolean }) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, cancellationDisclosure: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (
    entry.currentStage !== Stage.S3 &&
    entry.currentStage !== Stage.S4 &&
    entry.currentStage !== Stage.S5 &&
    entry.currentStage !== Stage.S6
  ) {
    throw new ValidationError("A booking is cancelled at Set up, Reserve, Arrival or Check-in — this one is at none of them");
  }
  if (!entry.folio) throw new ValidationError("No folio on the booking — nothing to charge or refund");
  const now = new Date();
  if (entry.currentStage === Stage.S3) {
    return cancellationFigures(prisma, {
      entryId: entry.id,
      stage: "S3",
      folioId: entry.folio.id,
      checkInDate: entry.checkInDate ?? new Date(now.getTime() + 86400_000),
      terms: (entry.cancellationDisclosure?.disclosedTerms as Record<string, unknown>) ?? {},
      waiver: opts?.penaltyWaiverRequested === true,
      now,
    });
  }
  if (!entry.reservation) throw new ValidationError("No reservation on the booking");
  return cancellationFigures(prisma, {
    entryId: entry.id,
    stage: "S5",
    folioId: entry.folio.id,
    checkInDate: entry.reservation.frozenCheckInDate,
    terms: (entry.reservation.frozenCancellationTerms as Record<string, unknown>) ?? {},
    waiver: opts?.penaltyWaiverRequested === true,
    now,
  });
}

/**
 * SIG-S3 §6.5 — pre-confirmation cancellation at S3: release the committed hold, cancel timers,
 * supersede any in-flight proforma invoices, compute a penalty per the *disclosed* terms (no
 * frozen reservation exists yet at S3), refund the net advance, and transition entry to terminal.
 *
 * Authority: L1 (FRONT_DESK) minimum per SIG-S3 line 129. GM authority required only when the
 * caller asks to waive the penalty.
 */
/**
 * Emit the A5 Cancellation Confirmation after a cancellation commits.
 *
 * Best-effort by design, matching how stage emails and the S4 voucher are dispatched: the
 * cancellation is already committed and irreversible by this point, so a Puppeteer or disk failure
 * must not surface as a failed cancellation. The document can always be produced later on demand
 * via `GET /api/entries/:id/cancellation-confirmation-pdf`, which reads the same trace payload.
 */
async function emitCancellationConfirmationBestEffort(
  prisma: PrismaClient,
  entryId: string,
  figures: { advanceHeld: number; retained: number; refundIssued: number; penaltyWaived: boolean; bandLabel?: string | null },
): Promise<void> {
  try {
    await generateCancellationConfirmationPdf(prisma, entryId, {
      advanceHeld: figures.advanceHeld,
      retained: figures.retained,
      refundIssued: figures.refundIssued,
      penaltyWaived: figures.penaltyWaived,
      bandLabel: figures.bandLabel ?? null,
    });
  } catch (e) {
    console.error(`[cancellation] confirmation PDF failed for ${entryId}:`, e);
  }
}

export async function cancelEntryAtS3(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: {
    reason?: string;
    penaltyWaiverRequested?: boolean;
    actorLevel?: RequestActorLevel;
    /** How the money owed back leaves the hotel — defaults to the way it came (2026-09-19). */
    refundMethod?: string | null;
    refundReference?: string | null;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: { include: { invoices: true } },
      committedHold: true,
      cancellationDisclosure: true,
      inquiry: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryAtS3ForS3CancellationRoute({ currentStage: entry.currentStage });

  const folio = entry.folio;
  if (!folio) throw new ValidationError("No folio on the entry — S3 cancellation requires a folio");

  const now = new Date();
  const checkInDate = entry.checkInDate ?? new Date(now.getTime() + 86400_000);

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }
  const traceActorLevel = (opts?.actorLevel ?? "L1") as ActorLevel;

  // S3 source of truth for cancellation terms: the disclosure record signed before the hold was
  // placed (per §6.5 — disclosure is a precondition for hold placement). Falls back to the
  // configured policy tiers when no disclosure terms are available (defensive). Computed by the
  // same helper the desk's preview reads, so the two never disagree.
  const disclosedTerms =
    (entry.cancellationDisclosure?.disclosedTerms as Record<string, unknown>) ?? {};
  const fig = await cancellationFigures(prisma, {
    entryId,
    stage: "S3",
    folioId: folio.id,
    checkInDate,
    terms: disclosedTerms,
    waiver,
    now,
  });
  const advanceTotal = fig.advanceReceived;
  const rawPenalty = fig.chargeBeforeCap;
  const cappedPenalty = fig.chargeCapped;
  const hoursUntilCheckIn = fig.hoursUntilCheckIn;
  const penalty = fig.charge;
  const netRefund = fig.refund;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    // The trip's money goes where it belongs first (2026-11-09).
    await applyTripMovesTx(prisma, tx, { entryId, folioId: folio.id, charge: waiver ? 0 : rawPenalty, shown: fig.tripMoves, actorId, actorLevel: traceActorLevel, now });

    // 1. Penalty line (only if non-zero).
    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          // Read on the guest's cancellation papers — no stage code (2026-09-18).
          description: "Cancellation charge — cancelled before the booking was confirmed",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S3,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
        },
      });
    }

    // Its own refund, just below, covers money that was waiting to go back (2026-11-05).
    await closeWaitingRefundsOnCancellationTx(tx, { entryId, actorId, actorLevel: traceActorLevel, now, why: "The booking was cancelled, and the cancellation deals with this money." });

    // 2. Refund obligation (only if net refund > 0).
    if (netRefund > 0) {
      const refundId = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id: refundId,
          folioId: folio.id,
          entryId,
          amount: netRefund,
          paymentDirection: "OUT",
          paymentMethod: await resolveRefundMethod(tx, folio.id, opts?.refundMethod),
          recordedBy: actorId,
          stage: Stage.S3,
          notes: `Refund obligation after S3 cancellation${opts?.refundReference?.trim() ? ` · ${opts.refundReference.trim()}` : ""}`,
        },
      });
    }

    // 3. Supersede any non-terminal PI invoices on this folio (SIG-S3 §3.3 — terminal events
    //    supersede in-flight invoices). Invoice has no supersededAt timestamp field; the
    //    state change + TraceEvent below carry the timestamp.
    const nonTerminalInvoiceIds = folio.invoices
      .filter((i) => i.state === "DRAFT" || i.state === "DISPATCHED")
      .map((i) => i.id);
    if (nonTerminalInvoiceIds.length > 0) {
      await tx.invoice.updateMany({
        where: { id: { in: nonTerminalInvoiceIds } },
        data: { state: "SUPERSEDED" },
      });
    }

    // 4. Release the committed hold, return inventory to FREE. Multi-room support: read the
    // hold's perNightBreakdown (populated by s3-hold-service from the sealed AvailabilityConfiguration)
    // so every room the booking held is released, not just hold.roomId. Falls back to
    // hold.roomId for pre-Phase-D holds that don't carry the breakdown.
    const hold = entry.committedHold;
    if (hold && hold.state !== HoldState.RELEASED && hold.state !== HoldState.EXPIRED) {
      const heldRoomIds = new Set<string>();
      if (hold.roomId) heldRoomIds.add(hold.roomId);
      const breakdown = (hold.perNightBreakdown ?? null) as
        | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
        | null;
      if (Array.isArray(breakdown)) {
        for (const n of breakdown) {
          for (const r of n.roomIds ?? []) {
            if (typeof r?.roomId === "string") heldRoomIds.add(r.roomId);
          }
        }
      }
      for (const roomId of heldRoomIds) {
        // Only the flags this booking owns (2026-09-18): cancelling an October booking set a room
        // FREE while another guest slept in it tonight. See releaseRoomClaimIfOwnedTx.
        await releaseRoomClaimIfOwnedTx(tx, { roomId, entryId, actorId, reason: "S3_PRE_CONFIRMATION_CANCELLATION", now });
      }
      await tx.committedHold.update({
        where: { id: hold.id },
        data: {
          state: HoldState.RELEASED,
          releasedAt: now,
          releasedBy: actorId,
          releaseReason: "S3_PRE_CONFIRMATION_CANCELLATION",
        },
      });
    }

    // 5. Cancel all scheduled timers tied to this entry (W3, W22, W34, dwell monitors, etc.).
    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledBy: actorId,
          cancelledReason: "S3 entry cancelled",
        } as any,
      });
    }

    // 6. Folio close-out: PROVISIONAL → SETTLED so it stops accepting new charges (no CANCELLED
    //    state in the FolioState enum). The Entry being CANCELLED is the terminal marker;
    //    SETTLED on the folio just means "no further activity expected".
    await tx.folio.update({
      where: { id: folio.id },
      data: { state: FolioState.SETTLED, closedAt: now, closedBy: actorId } as any,
    });

    // 7. Audit trace.
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.S3.CANCELLED",
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          reason: opts?.reason ?? null,
          penalty,
          cappedPenalty,
          rawPenalty,
          advanceTotal,
          netRefund,
          hoursUntilCheckIn,
          daysBeforeArrival: fig.daysBeforeArrival,
          // The line of the policy that applied (2026-11-10) — the cancellation paper states it.
          rule: fig.rule,
          penaltyWaiverRequested: waiver,
        },
        createdBy: actorId,
      },
    });

    await recomputeFolioOutstandingBalance(tx, folio.id);

    // 8. Terminal entry state.
    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        closedAs: ENTRY_ENDINGS.CANCELLED,
        closedReason: opts?.reason?.trim() || null,
        version: { increment: 1 },
      },
    });
  });

  // Fire-and-forget pg-boss job cancellation (best-effort; timer records are already CANCELLED in
  // the DB so a missed pg-boss cancel just means the job runs and the worker sees the dead record).
  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  await emitCancellationConfirmationBestEffort(prisma, entryId, {
    advanceHeld: advanceTotal,
    retained: penalty,
    refundIssued: Math.max(0, netRefund),
    penaltyWaived: waiver && penalty === 0,
    bandLabel: waiver ? null : fig.rule.label,
  });

  return updated;
}

/** SIG-S5 Policy 35 — pre-arrival cancellation at S5: penalty from snapshot/config (unless GM waives), cap at advance, post to folio, release hold. */
export async function cancelEntryAtS5(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: {
    penaltyWaiverRequested?: boolean;
    actorLevel?: RequestActorLevel;
    reason?: string;
    /** How the money owed back leaves the hotel — defaults to the way it came (2026-09-19). */
    refundMethod?: string | null;
    refundReference?: string | null;
  },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, committedHold: true, inquiry: true, roomAssignments: { select: { roomId: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryConfirmedForPreArrivalCancellation({ currentStage: entry.currentStage });
  enforceReservationPresentForS5CancellationPolicy35({ reservation: entry.reservation });
  // Reserve (S4), Arrival (S5) or Check-in (S6, 2026-10-26) — the step the booking is cancelled
  // at, for its lines, its release reason and its trace.
  const cancelStage = entry.currentStage === Stage.S4 ? Stage.S4 : entry.currentStage === Stage.S6 ? Stage.S6 : Stage.S5;
  const atCheckIn = cancelStage === Stage.S6;
  const releaseReason = atCheckIn ? "S6_CHECK_IN_CANCELLATION" : `${cancelStage}_PRE_ARRIVAL_CANCELLATION`;
  enforceFolioPresentForS5CancellationPolicy35({ folio: entry.folio });

  const folio = entry.folio!;
  const reservation = entry.reservation!;
  const now = new Date();

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }

  const traceActorLevel = (opts?.actorLevel ?? "L2") as ActorLevel;

  // S5 pre-arrival penalty: never let a config-store hiccup silently null out the penalty policy.
  // Frozen cancellation terms on the reservation are the primary source; the live policyTiers is a
  // fallback for anything not frozen. Bubble errors so the operator sees them instead of processing
  // a zero-penalty cancellation. The same helper the desk's preview reads.
  const fig = await cancellationFigures(prisma, {
    entryId,
    stage: "S5",
    folioId: folio.id,
    checkInDate: reservation.frozenCheckInDate,
    terms: (reservation.frozenCancellationTerms as Record<string, unknown>) ?? {},
    waiver,
    now,
  });
  const advanceTotal = fig.advanceReceived;
  const rawPenalty = fig.chargeBeforeCap;
  const cappedPenalty = fig.chargeCapped;
  const hoursUntilCheckIn = fig.hoursUntilCheckIn;
  const penalty = fig.charge;
  const netRefund = fig.refund;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    await applyTripMovesTx(prisma, tx, { entryId, folioId: folio.id, charge: waiver ? 0 : rawPenalty, shown: fig.tripMoves, actorId, actorLevel: traceActorLevel, now });

    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: atCheckIn ? "Cancellation penalty — at check-in" : "Pre-arrival cancellation penalty",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: cancelStage,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
        },
      });
    }

    // Its own refund, just below, covers money that was waiting to go back (2026-11-05).
    await closeWaitingRefundsOnCancellationTx(tx, { entryId, actorId, actorLevel: traceActorLevel, now, why: "The booking was cancelled, and the cancellation deals with this money." });

    if (netRefund > 0) {
      const refundId = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id: refundId,
          folioId: folio.id,
          entryId,
          amount: netRefund,
          paymentDirection: "OUT",
          paymentMethod: await resolveRefundMethod(tx, folio.id, opts?.refundMethod),
          recordedBy: actorId,
          stage: cancelStage,
          notes: `Refund obligation after ${atCheckIn ? "a cancellation at check-in" : "pre-arrival cancellation"}${opts?.refundReference?.trim() ? ` · ${opts.refundReference.trim()}` : ""}`,
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: `ENTRY.${cancelStage}.CANCELLED`,
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: cancelStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          // Why it was cancelled, as the S3 cancellation records it (2026-09-18).
          reason: opts?.reason?.trim() || null,
          penalty,
          cappedPenalty,
          advanceTotal,
          netRefund,
          rawPenalty,
          hoursUntilCheckIn,
          daysBeforeArrival: fig.daysBeforeArrival,
          // The line of the policy that applied (2026-11-10) — the cancellation paper states it.
          rule: fig.rule,
          penaltyWaiverRequested: waiver,
        },
        createdBy: actorId,
      },
    });

    // From Arrival the rooms are assigned too, and a room change at Arrival or Check-in can leave an
    // assigned room the hold does not name — every one is released (only the flags this booking
    // owns, as below).
    const assignedRoomIds = new Set(entry.roomAssignments.map((a) => a.roomId));
    const hold = entry.committedHold;
    if (hold && hold.state !== HoldState.RELEASED && hold.state !== HoldState.EXPIRED) {
      const heldRoomIds = new Set<string>(assignedRoomIds);
      if (hold.roomId) heldRoomIds.add(hold.roomId);
      const breakdown = (hold.perNightBreakdown ?? null) as
        | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
        | null;
      if (Array.isArray(breakdown)) {
        for (const n of breakdown) {
          for (const r of n.roomIds ?? []) {
            if (typeof r?.roomId === "string") heldRoomIds.add(r.roomId);
          }
        }
      }
      for (const roomId of heldRoomIds) {
        // Only the flags this booking owns (2026-09-18): cancelling an October booking set a room
        // FREE while another guest slept in it tonight. See releaseRoomClaimIfOwnedTx.
        await releaseRoomClaimIfOwnedTx(tx, { roomId, entryId, actorId, reason: releaseReason, now });
      }
      await tx.committedHold.update({
        where: { id: hold.id },
        data: {
          state: HoldState.RELEASED,
          releasedAt: now,
          releasedBy: actorId,
          releaseReason,
        },
      });
    } else {
      for (const roomId of assignedRoomIds) {
        await releaseRoomClaimIfOwnedTx(tx, { roomId, entryId, actorId, reason: releaseReason, now });
      }
    }

    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: `${cancelStage} entry cancelled` } as any,
      });
    }

    await recomputeFolioOutstandingBalance(tx, folio.id);
    const recomputed = await tx.folio.findUnique({ where: { id: folio.id }, select: { outstandingBalance: true } });

    // Part 13 "folio financial residue governed" (2026-08-22): the folio used to stay LIVE forever
    // behind a CANCELLED booking - nothing could ever settle it. Seal it the way checkout does:
    // OUTSTANDING while money is owed (the S9 follow-up machinery can chase it), SETTLED at zero.
    const residual = Number((recomputed as { outstandingBalance?: unknown } | null)?.outstandingBalance ?? 0);
    await tx.folio.update({
      where: { id: folio.id },
      data: {
        state: Number.isFinite(residual) && residual > 0 ? FolioState.OUTSTANDING : FolioState.SETTLED,
        closedAt: now,
        closedBy: actorId,
      },
    });

    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        closedAs: ENTRY_ENDINGS.CANCELLED,
        closedReason: opts?.reason?.trim() || null,
        version: { increment: 1 },
      },
    });
  });

  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  await emitCancellationConfirmationBestEffort(prisma, entryId, {
    advanceHeld: advanceTotal,
    retained: penalty,
    refundIssued: Math.max(0, netRefund),
    penaltyWaived: waiver && penalty === 0,
    bandLabel: waiver ? null : fig.rule.label,
  });

  return updated;
}

/** SIG-S6 Policy 35 — post-check-in early departure (entry at S7, folio LIVE): penalty to folio, room released, entry cancelled. */
export async function cancelEntryEarlyDepartureAfterCheckIn(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: { penaltyWaiverRequested?: boolean; actorLevel?: RequestActorLevel },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      reservation: true,
      inquiry: true,
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation({ currentStage: entry.currentStage });
  enforceFolioPresentForS5CancellationPolicy35({ folio: entry.folio });
  const folio = entry.folio!;
  if (folio.state !== FolioState.LIVE) {
    throw new ValidationError("Early departure cancellation requires a LIVE folio");
  }

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }

  const traceActorLevel = (opts?.actorLevel ?? "L2") as ActorLevel;
  const now = new Date();

  const advanceTotal = await sumAdvancePaymentInTotalForFolio(prisma, folio.id);
  // S7 post-check-in penalty: bubble config errors — silent null zeroed the penalty and let the
  // guest walk out free.
  const policyTiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers");
  const rawPenalty = computePostCheckInEarlyDeparturePenalty({ policyTiers });
  const cappedPenalty = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceTotal);
  const penalty = waiver ? 0 : cappedPenalty;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  // Multi-room bookings need every room's state released back to FREE — not just the first
  // one. Dedup by roomId so a room-change history doesn't double-process the same room.
  const distinctRoomsToRelease = (() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; currentClaimState: InventoryClaimState }> = [];
    for (const a of entry.roomAssignments) {
      if (seen.has(a.roomId)) continue;
      seen.add(a.roomId);
      list.push({ id: a.room.id, currentClaimState: a.room.currentClaimState });
    }
    return list;
  })();

  const updated = await prisma.$transaction(async (tx) => {
    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "Early departure cancellation penalty (post check-in)",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S7,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.S7.EARLY_DEPARTURE_CANCELLED",
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { penalty, rawPenalty, cappedPenalty, advanceTotal, penaltyWaiverRequested: waiver },
        createdBy: actorId,
      },
    });

    // Release EVERY assigned room, whatever state it's in — not just OCCUPIED. Prior guard
    // (only-if-OCCUPIED) silently skipped rooms already flipped to DEPARTED_DIRTY by a
    // concurrent S8 attempt or partial retry, leaving the audit trail incomplete and the
    // room stuck. The helper reads the real fromState and is idempotent (returns without
    // doing anything if the room is already FREE), so it's safe on races.
    for (const r of distinctRoomsToRelease) {
      await transitionRoomClaimState(tx, {
        roomId: r.id,
        toState: InventoryClaimState.FREE,
        actorId,
        entryId,
        reason: "S7_EARLY_DEPARTURE_CANCELLATION",
        now,
      });
    }

    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "S7 early departure cancellation" } as any,
      });
    }

    await recomputeFolioOutstandingBalance(tx, folio.id);

    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        // This route takes no reason of its own (its body is the penalty waiver), so there
        // is nothing to record beyond what happened.
        closedAs: ENTRY_ENDINGS.WALKED_OUT,
        version: { increment: 1 },
      },
    });
  });

  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  return updated;
}
