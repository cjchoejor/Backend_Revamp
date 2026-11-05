import { InvoiceState, InvoiceType, Prisma, type PrismaClient, Stage } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { resolveStandsUntil } from "../../lib/quote-validity.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

/**
 * How long a proforma stands, and what its making stops (2026-11-05, operator: "when a proforma is
 * generated, the qoute validity should stop, also proforma validity to function same as quote where
 * its validity will be till the check in time and same way for other cases like quotation").
 *
 * The same rule as a quote (`lib/quote-validity.ts`): to the check-in date, in days; for a stay
 * starting today, in hours up to the rest of the hotel's day; shorter on request, never longer. Each
 * paper hands on to the next: the quote's clock stops when the proforma is made, and the proforma's
 * when the booking is reserved or the advance asked is paid in full, since then nothing is left for
 * the guest to answer. Its end never lapses the booking (Set up does not lapse): the desk makes it
 * again, and until then the proforma cannot go out and the booking cannot move on.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;
const CLOCK = "PROFORMA_VALIDITY_W43";

async function cancelClocksTx(tx: Tx, where: Prisma.TimerRecordWhereInput, actorId: string, reason: string, now: Date) {
  const timers = await tx.timerRecord.findMany({ where: { ...where, status: "SCHEDULED" }, select: { id: true, pgBossJobId: true } });
  if (timers.length === 0) return 0;
  const engine = await getTimerEngine();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId).catch(() => {}) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: reason },
  });
  return timers.length;
}

/** The quote has done its work once a proforma is made from it: it no longer runs out. */
export async function stopQuoteValidityTx(tx: Tx, input: { entryId: string; actorId: string; now: Date }) {
  const stopped = await cancelClocksTx(
    tx,
    { entryId: input.entryId, entityType: "Quotation", timerType: { in: ["QUOTATION_VALIDITY_W15", "QUOTATION_ACK_TRACKER"] } },
    input.actorId,
    "PROFORMA_GENERATED",
    input.now,
  );
  if (stopped > 0) {
    await tx.traceEvent.create({
      data: {
        eventType: "QUOTATION.VALIDITY_STOPPED",
        actorId: input.actorId,
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: input.entryId,
        operation: "UPDATE",
        timestamp: input.now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: { entryId: input.entryId, cause: "PROFORMA_GENERATED" },
        createdBy: input.actorId,
      },
    });
  }
  return stopped;
}

export async function stopProformaValidityTx(tx: Tx, input: { entryId: string; actorId: string; reason: string; now: Date }) {
  return cancelClocksTx(tx, { entryId: input.entryId, timerType: CLOCK }, input.actorId, input.reason, input.now);
}

/** This proforma runs to `validUntil`, and it is the only clock of its kind on the booking. */
export async function armProformaValidityTx(tx: Tx, input: { invoiceId: string; entryId: string; validUntil: Date; actorId: string; now: Date }) {
  await stopProformaValidityTx(tx, { entryId: input.entryId, actorId: input.actorId, reason: "REARMED", now: input.now });
  const engine = await getTimerEngine();
  const jobId = await engine.schedule(CLOCK, { invoiceId: input.invoiceId }, { startAfter: input.validUntil });
  await tx.timerRecord.create({
    data: {
      entryId: input.entryId,
      entityType: "Invoice",
      entityId: input.invoiceId,
      timerType: CLOCK,
      timerCode: CLOCK,
      stageContext: Stage.S3,
      dueAt: input.validUntil,
      firesAt: input.validUntil,
      status: "SCHEDULED",
      createdBy: input.actorId,
      pgBossJobId: jobId,
      payload: { invoiceId: input.invoiceId },
    },
  });
  await tx.invoice.update({ where: { id: input.invoiceId }, data: { validUntil: input.validUntil, lapsedAt: null } });
}

/** A proforma was just made: its own time starts, and the quote's stops. */
export async function afterProformaMadeTx(
  tx: Tx,
  input: { invoiceId: string; entryId: string; actorId: string; now: Date; ask?: { validDays?: number; validHours?: number } },
) {
  const { validUntil } = await resolveStandsUntil(tx, input.entryId, input.ask ?? {}, input.now, "proforma");
  await armProformaValidityTx(tx, { invoiceId: input.invoiceId, entryId: input.entryId, validUntil, actorId: input.actorId, now: input.now });
  await stopQuoteValidityTx(tx, { entryId: input.entryId, actorId: input.actorId, now: input.now });
  return validUntil;
}

/** A payment taken back leaves the guest something to answer again, so its clock comes back. */
export async function restartProformaValidityTx(tx: Tx, input: { entryId: string; actorId: string; now: Date }) {
  const live = await tx.invoice.findFirst({
    where: { entryId: input.entryId, invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, validUntil: { not: null }, lapsedAt: null },
    orderBy: { versionNumber: "desc" },
    select: { id: true, validUntil: true },
  });
  if (!live?.validUntil) return;
  if (live.validUntil.getTime() <= input.now.getTime()) {
    await tx.invoice.update({ where: { id: live.id }, data: { lapsedAt: input.now } });
    return;
  }
  const running = await tx.timerRecord.count({ where: { entryId: input.entryId, timerType: CLOCK, status: "SCHEDULED" } });
  if (running === 0) await armProformaValidityTx(tx, { invoiceId: live.id, entryId: input.entryId, validUntil: live.validUntil, actorId: input.actorId, now: input.now });
}

const LAPSED_WORDS = "This booking's proforma has run out. Make it again on its card, then it can go out and the booking can move on.";

export async function enforceProformaNotLapsed(db: Db, entryId: string) {
  const lapsed = await db.invoice.findFirst({
    where: { entryId, invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, lapsedAt: { not: null } },
    select: { id: true },
  });
  if (lapsed) throw new PolicyGateBlockedError("PROFORMA_LAPSED", LAPSED_WORDS);
}
