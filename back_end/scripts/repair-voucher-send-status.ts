/**
 * Put the voucher records and Reserve's clocks in line with the 2026-10-29 rules.
 *
 *   1. A voucher held for the desk was recorded as DISPATCHED although nothing went out, so
 *      Arrival waited for an answer to a paper the guest never had. Since 2026-10-29 a held
 *      voucher is HELD until it goes out (WhatsApp → DISPATCHED; email sends a fresh record) or
 *      the desk says not to (NOT_SENT). Held records already on file are relabelled by their
 *      HeldDocument: undecided or replaced → HELD, not sent → NOT_SENT, sent on WhatsApp → left
 *      DISPATCHED (channel WHATSAPP), sent by email → HELD (the email went out as its own record).
 *   2. A countdown to Arrival armed at Reserve when Arrival's window was already open fired at
 *      once, could not move on, and was left SCHEDULED — read "overdue" on the desk. Such a
 *      countdown, past due on a booking still at Reserve, is closed (FIRED) and traced; the desk
 *      moves the booking on with Move to Arrival. The booking itself is not moved.
 *   3. A reserved booking's quotation clocks (validity, reply) kept running after Reserve; since
 *      2026-10-29 Reserve stops them. Those still running on bookings at Reserve or later are
 *      cancelled.
 *
 *   npx tsx scripts/repair-voucher-send-status.ts            dry run
 *   npx tsx scripts/repair-voucher-send-status.ts --commit   apply
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");
const ACTOR = "SYSTEM";
// Reserve writes "made — held …", a walk "re-issued — held …".
const HELD_SUFFIX = "held for the desk to send or not";

async function main() {
  const now = new Date();

  // ---- 1. held voucher records
  const heldComms = await prisma.communicationRecord.findMany({
    where: { commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", sendStatus: "DISPATCHED", contentSummary: { endsWith: HELD_SUFFIX } },
    select: { id: true, entryId: true, payload: true, acknowledgementStatus: true, channel: true },
    orderBy: { createdAt: "asc" },
  });
  const relabel: Array<{ id: string; entryId: string; to: "HELD" | "NOT_SENT" | "WHATSAPP"; why: string }> = [];
  for (const c of heldComms) {
    const reservationId = String((c.payload as { reservationId?: string } | null)?.reservationId ?? "");
    const doc = reservationId
      ? await prisma.heldDocument.findFirst({
          where: { kind: "CONFIRMATION_VOUCHER", documentId: reservationId },
          orderBy: { heldAt: "desc" },
          select: { decision: true },
        })
      : null;
    const decision = doc?.decision ?? null;
    if (decision === "SENT_WHATSAPP") {
      if (c.channel !== "WHATSAPP") relabel.push({ id: c.id, entryId: c.entryId, to: "WHATSAPP", why: "sent on WhatsApp — channel recorded" });
      continue;
    }
    relabel.push({
      id: c.id,
      entryId: c.entryId,
      to: decision === "NOT_SENT" ? "NOT_SENT" : "HELD",
      why:
        decision === "NOT_SENT"
          ? "the desk said not to send it"
          : decision === "SENT_EMAIL"
            ? "sent by email as its own record — this one never went out"
            : decision === "SUPERSEDED"
              ? "replaced before it was sent"
              : doc
                ? "held, not sent yet"
                : "held, no held paper on record",
    });
  }

  // ---- 2. Reserve's countdowns past due on bookings still at Reserve
  const lateCountdowns = await prisma.timerRecord.findMany({
    where: { timerCode: "PRE_ARRIVAL_COUNTDOWN_W4", status: "SCHEDULED", firesAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
    select: { id: true, entryId: true, firesAt: true, pgBossJobId: true },
  });
  const atReserve = new Set(
    (
      await prisma.entry.findMany({
        where: { id: { in: lateCountdowns.map((t) => t.entryId).filter((x): x is string => !!x) }, currentStage: "S4" },
        select: { id: true },
      })
    ).map((e) => e.id),
  );
  const closeCountdowns = lateCountdowns.filter((t) => t.entryId && atReserve.has(t.entryId));

  // ---- 3. quotation clocks on reserved bookings
  const reserved = await prisma.entry.findMany({
    where: { currentStage: { in: ["S4", "S5", "S6", "S7", "S8", "S9"] } },
    select: { id: true, quotations: { select: { id: true, communicationRecordId: true } } },
  });
  const quoteIds = reserved.flatMap((e) => e.quotations.map((q) => q.id));
  const quoteComms = reserved.flatMap((e) => e.quotations.map((q) => q.communicationRecordId).filter((x): x is string => !!x));
  const quoteClocks = await prisma.timerRecord.findMany({
    where: {
      status: "SCHEDULED",
      OR: [
        { entityType: "Quotation", entityId: { in: quoteIds } },
        { entityType: "CommunicationRecord", entityId: { in: quoteComms }, timerType: "ACKNOWLEDGEMENT_WINDOW_W22" },
      ],
    },
    select: { id: true, entryId: true, timerCode: true, entityId: true, firesAt: true, pgBossJobId: true },
  });

  console.log(`1. Held voucher records to relabel: ${relabel.length}`);
  for (const r of relabel) console.log(`   ${r.entryId}  ${r.id}  → ${r.to}  (${r.why})`);
  console.log(`2. Countdowns to Arrival past due at Reserve: ${closeCountdowns.length}`);
  for (const t of closeCountdowns) console.log(`   ${t.entryId}  due ${t.firesAt.toISOString()}`);
  console.log(`3. Quotation clocks still running on reserved bookings: ${quoteClocks.length}`);
  for (const t of quoteClocks) console.log(`   ${t.entryId}  ${t.timerCode}  ${t.entityId}  due ${t.firesAt.toISOString()}`);

  if (!commit) {
    console.log("\n(dry run — pass --commit to apply)");
    return;
  }

  for (const r of relabel) {
    await prisma.communicationRecord.update({
      where: { id: r.id },
      data:
        r.to === "WHATSAPP"
          ? { channel: "WHATSAPP", contentSummary: "Confirmation voucher sent on WhatsApp" }
          : r.to === "NOT_SENT"
            ? { sendStatus: "NOT_SENT", contentSummary: "Confirmation voucher not sent to the guest" }
            : { sendStatus: "HELD" },
    });
  }

  const { getTimerEngine } = await import("../src/services/infrastructure/timer-management-service.js");
  const engine = await getTimerEngine();
  for (const t of closeCountdowns) {
    await prisma.timerRecord.update({ where: { id: t.id }, data: { status: "FIRED", firedAt: now } });
    await prisma.traceEvent.create({
      data: {
        eventType: "PRE_ARRIVAL.WINDOW_OPEN_WAITING",
        actorId: ACTOR,
        actorLevel: "SYSTEM" as never,
        entityType: "Entry",
        entityId: t.entryId!,
        operation: "UPDATE",
        timestamp: now,
        stageContext: "S4",
        entryId: t.entryId,
        payload: { entryId: t.entryId, reason: "COUNTDOWN_CLOSED_BY_REPAIR", dueAt: t.firesAt.toISOString(), via: "repair-voucher-send-status" },
        createdBy: ACTOR,
      },
    });
  }
  await Promise.all(quoteClocks.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId).catch(() => {}) : Promise.resolve())));
  if (quoteClocks.length) {
    await prisma.timerRecord.updateMany({
      where: { id: { in: quoteClocks.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: ACTOR, cancelledReason: "RESERVED — the reservation holds the terms" },
    });
  }
  console.log(`\nRelabelled ${relabel.length}, closed ${closeCountdowns.length} countdown(s), cancelled ${quoteClocks.length} quotation clock(s).`);
}

await main();
await prisma.$disconnect();
// The timer engine keeps a pg-boss connection open; without this the script never exits.
process.exit(0);
