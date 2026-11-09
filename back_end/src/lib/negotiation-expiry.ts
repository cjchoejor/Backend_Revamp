import type { Prisma, PrismaClient } from "@prisma/client";
import { QuotationState, Stage } from "@prisma/client";
import { quoteStandsUntil, quoteValidityWindow } from "./quote-validity.js";
import type { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

/**
 * The Negotiation clock (2026-09-29, operator ruling — SIG-S2 §7.6 / §3.1 §428).
 *
 * The spec keeps the entry-expiry worker (W20) alive past Inquiry: a booking that stalls at
 * Negotiation lapses to EXPIRED when its window runs out. The code had cancelled the entry clock
 * for good on S1→S2 (and the park fix of 2026-07-28 wrote that down as the rule) because the ONE
 * clock from intake ran on the 1-hour inquiry window — carrying it into Negotiation expired a
 * booking an hour after intake, mid-conversation. The answer is a window of Negotiation's own,
 * not no window:
 *
 *  - armed on the forward move to Negotiation, on the rule a quotation's validity follows
 *    (2026-11-05, operator: "we can set it as how the quotation validity is set, so this also
 *    becomes system driven"): to the check-in date, or to the end of the hotel's day when check-in
 *    is today (`quoteValidityWindow`). There is no setting; `expiry.s2.negotiationTtlSeconds` is gone;
 *  - a quote of this pass sets the moment, longer or shorter: a minute after its validity, so a
 *    booking is never lapsed while the guest holds a live offer, and lapses when the offer does;
 *  - a retired quote or a moved stay puts it back on the window (`amendNegotiationConfiguration`);
 *  - a booking that has been to Set up (it has a folio — it may hold money) never gets the
 *    clock: that booking is the desk's to end, not a clock's;
 *  - the park pauses it (the park cancels every ENTRY_EXPIRY row and arms its own 30-day
 *    follow-up); an unpark at Negotiation arms a fresh window.
 *
 * The row is an `ENTRY_EXPIRY` TimerRecord with `timerCode: NEGOTIATION_EXPIRY`, so the S1
 * inquiry clock (no code) and the park follow-up (`PARKING_FOLLOW_UP`) stay distinguishable and
 * the desk can name it "The negotiation lapses". The job payload carries `negotiation: true`,
 * which `expireEntry` requires before it will lapse a booking at S2.
 */
export const NEGOTIATION_EXPIRY_CODE = "NEGOTIATION_EXPIRY";
/** The entry lapses a minute AFTER the quote's own clock, so W15 has expired the offer first. */
export const NEGOTIATION_LAPSE_GRACE_MS = 60_000;

type Tx = Prisma.TransactionClient;
type Engine = Awaited<ReturnType<typeof getTimerEngine>>;

/**
 * When the negotiation lapses: a minute after the live quote of this pass, else as long as a quote
 * could stand from `now`. An earlier pass's quote says nothing about this one.
 */
export async function negotiationLapseAt(
  tx: Tx | PrismaClient,
  entryId: string,
  now = new Date(),
): Promise<{ firesAt: Date; basis: "QUOTE" | "WINDOW" }> {
  const pass = await tx.segment.findFirst({
    where: { entryId, sealedAt: null },
    orderBy: { segmentNumber: "desc" },
    select: { id: true },
  });
  const live = await tx.quotation.findFirst({
    where: {
      entryId,
      ...(pass ? { segmentId: pass.id } : {}),
      state: { in: [QuotationState.DRAFT, QuotationState.SENT, QuotationState.ACCEPTED] },
      validUntil: { gt: now },
    },
    orderBy: { createdAt: "desc" },
    select: { validUntil: true },
  });
  if (live?.validUntil) return { firesAt: new Date(live.validUntil.getTime() + NEGOTIATION_LAPSE_GRACE_MS), basis: "QUOTE" };
  const window = await quoteValidityWindow(tx, entryId, now);
  return { firesAt: quoteStandsUntil(window.mode, window.max, now), basis: "WINDOW" };
}

/** Cancel the live Negotiation clock, if any. Returns how many rows were cancelled. */
export async function cancelNegotiationExpiryTx(
  tx: Tx,
  engine: Engine,
  args: { entryId: string; actorId: string; reason: string; now?: Date },
): Promise<number> {
  const rows = await tx.timerRecord.findMany({
    where: { entryId: args.entryId, timerType: "ENTRY_EXPIRY", timerCode: NEGOTIATION_EXPIRY_CODE, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (rows.length === 0) return 0;
  await Promise.all(rows.map((r) => (r.pgBossJobId ? engine.cancel(r.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: "CANCELLED", cancelledAt: args.now ?? new Date(), cancelledBy: args.actorId, cancelledReason: args.reason },
  });
  return rows.length;
}

/**
 * Arm the Negotiation clock — exactly one live row. Returns null (arms nothing) for a booking
 * that already has a folio: it has been to Set up and may hold money, so a clock must not end it.
 */
export async function armNegotiationExpiryTx(
  tx: Tx,
  engine: Engine,
  args: { entryId: string; actorId: string; now?: Date },
): Promise<{ firesAt: Date; basis: "QUOTE" | "WINDOW" } | null> {
  const now = args.now ?? new Date();
  const folio = await tx.folio.findUnique({ where: { entryId: args.entryId }, select: { id: true } });
  if (folio) return null;
  await cancelNegotiationExpiryTx(tx, engine, { entryId: args.entryId, actorId: args.actorId, reason: "REARMED", now });
  const { firesAt, basis } = await negotiationLapseAt(tx, args.entryId, now);
  const jobId = await engine.schedule("ENTRY_EXPIRY", { entryId: args.entryId, negotiation: true }, { startAfter: firesAt });
  await tx.timerRecord.create({
    data: {
      entryId: args.entryId,
      entityType: "Entry",
      entityId: args.entryId,
      timerType: "ENTRY_EXPIRY",
      timerCode: NEGOTIATION_EXPIRY_CODE,
      stageContext: Stage.S2,
      firesAt,
      dueAt: firesAt,
      status: "SCHEDULED",
      payload: { entryId: args.entryId, negotiation: true, basis },
      pgBossJobId: jobId,
      createdBy: args.actorId,
    },
  });
  return { firesAt, basis };
}

/**
 * A generated or sent quote sets the clock: a minute after its validity, whether that is sooner or
 * later than it stood. Returns the new moment, or null when there is no clock or it is already there.
 */
export async function followQuoteValidityTx(
  tx: Tx,
  engine: Engine,
  args: { entryId: string; validUntil: Date; actorId: string },
): Promise<Date | null> {
  const row = await tx.timerRecord.findFirst({
    where: { entryId: args.entryId, timerType: "ENTRY_EXPIRY", timerCode: NEGOTIATION_EXPIRY_CODE, status: "SCHEDULED" },
    select: { id: true, firesAt: true, pgBossJobId: true, payload: true },
  });
  if (!row) return null;
  const target = new Date(args.validUntil.getTime() + NEGOTIATION_LAPSE_GRACE_MS);
  if (row.firesAt.getTime() === target.getTime()) return null;
  if (row.pgBossJobId) await engine.cancel(row.pgBossJobId);
  const jobId = await engine.schedule("ENTRY_EXPIRY", { entryId: args.entryId, negotiation: true }, { startAfter: target });
  const prior = (row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {}) as Record<string, unknown>;
  await tx.timerRecord.update({
    where: { id: row.id },
    data: { firesAt: target, dueAt: target, pgBossJobId: jobId, payload: { ...prior, basis: "QUOTE", followsQuoteUntil: args.validUntil.toISOString(), movedBy: args.actorId } },
  });
  return target;
}

/**
 * What a lapse at Negotiation leaves behind, beside the entry's own EXPIRED status and the room
 * flags (`releaseEntryRoomsToFree`): the marked rooms' hold rows released (silent expiry is a
 * forbidden pattern — SIG-S2 §242), the live quotations expired, and every clock still ticking
 * on the booking cancelled.
 */
export async function lapseNegotiationRecordsTx(
  tx: Tx,
  engine: Engine,
  args: {
    entryId: string;
    now: Date;
    /**
     * Why the booking stopped. The clock's own lapse is "EXPIRY"; the desk ending a lead the
     * guest turned down is "DECLINED" (2026-10-01). What is let go is identical either way --
     * the marked rooms, the live offers, every clock -- so the two share this one routine
     * rather than drifting into two readings of what a booking before Set up is still holding.
     */
    cause?: "EXPIRY" | "DECLINED";
  },
): Promise<{ holdsReleased: number; quotationsExpired: number; timersCancelled: number }> {
  const cause = args.cause ?? "EXPIRY";
  const holds = await tx.speculativeHold.updateMany({
    where: { entryId: args.entryId, state: "PLACED" },
    data: { state: "RELEASED", releasedAt: args.now, releaseReason: cause },
  });
  const quotes = await tx.quotation.updateMany({
    where: { entryId: args.entryId, state: { in: [QuotationState.DRAFT, QuotationState.SENT] } },
    data: { state: QuotationState.EXPIRED, expiredAt: args.now },
  });
  const timers = await tx.timerRecord.findMany({
    where: { entryId: args.entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  if (timers.length) {
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: {
        status: "CANCELLED",
        cancelledAt: args.now,
        cancelledBy: "SYSTEM",
        cancelledReason: cause === "DECLINED" ? "BOOKING_DECLINED" : "NEGOTIATION_LAPSED",
      },
    });
  }
  return { holdsReleased: holds.count, quotationsExpired: quotes.count, timersCancelled: timers.length };
}
