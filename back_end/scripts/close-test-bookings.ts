/**
 * Close the test bookings made from July 2026 onward, and free everything they hold.
 *
 * WHY
 * ---
 * Months of manual testing left 98 bookings sitting mid-journey — at Negotiation, Set up,
 * Reserve, Arrival, Check-in, Check-out. Between them they hold live committed holds, pinned
 * room claim flags, open folios and scheduled timers, so only 3 of the hotel's 27 rooms read
 * FREE and further testing keeps colliding with them.
 *
 * A booking at S3 cannot be walked to S9 through the real gates without inventing money,
 * guest details and night audits for it, so this is deliberate data surgery, recorded as such:
 * every entry gets an `ENTRY.ADMIN_BULK_CLOSED` trace naming the stage it was abandoned at.
 * It is NOT a settlement, and no money is claimed to have moved.
 *
 * WHAT IT DOES, per entry
 *   1. Cancels its SCHEDULED timers (they would fire against a closed booking).
 *   2. Releases live committed / speculative holds.
 *   3. Closes the folio — SETTLED when the balance is already zero, WRITTEN_OFF when it is not.
 *      An unpaid balance is never silently called "settled".
 *   4. Seals the open stage-dwell record and the open segment.
 *   5. Moves the entry to S9 / CLOSED with `closedAt`.
 *
 * Room claim flags are NOT set here. They are a derived "now" fact with no date dimension, and
 * a room may legitimately be claimed by a booking this script does not touch. Run
 * `repair-stuck-room-states.ts --commit` afterwards — it frees exactly the rooms that no longer
 * have a live reservation or hold covering now.
 *
 * Already-terminal bookings (CANCELLED / EXPIRED) are not re-closed, but their leftover holds
 * and timers ARE released — a cancelled booking holding a room is the same obstruction.
 *
 * Dry run by default; --commit to write. Idempotent: re-running finds nothing to do.
 */
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");
const SINCE = new Date(
  (process.argv.find((a) => a.startsWith("--since="))?.split("=")[1] ?? "2026-07-01") + "T00:00:00.000Z",
);
const ACTOR = "actor-admin-bulk-close";

const TERMINAL = ["CLOSED", "CANCELLED", "EXPIRED"] as const;

async function main() {
  if (Number.isNaN(SINCE.getTime())) throw new Error("--since must be YYYY-MM-DD");
  console.log(`Scope: bookings created on or after ${SINCE.toISOString().slice(0, 10)}`);
  console.log(COMMIT ? "MODE: COMMIT — writing\n" : "MODE: dry run — nothing will be written\n");

  const toClose = await prisma.entry.findMany({
    where: { createdAt: { gte: SINCE }, status: { notIn: [...TERMINAL] } },
    select: {
      id: true, currentStage: true, status: true, version: true, createdAt: true,
      folio: { select: { id: true, state: true, outstandingBalance: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Terminal bookings that still hold inventory or clocks.
  const terminalWithJunk = await prisma.entry.findMany({
    where: {
      createdAt: { gte: SINCE },
      status: { in: [...TERMINAL] },
      OR: [
        { committedHold: { state: { in: ["PLACED", "CONFIRMED"] } } },
        { timers: { some: { status: "SCHEDULED" } } },
        { folio: { state: { in: ["PROVISIONAL", "LIVE", "OUTSTANDING"] } } },
        { handoffs: { some: { state: { in: ["CREATED", "ACCEPTED"] } } } },
      ],
    },
    // The folio is selected here too: a cancelled booking can be left holding a LIVE folio
    // (the old cancel route did exactly that), and that is an open folio whether or not the
    // booking itself is terminal.
    select: {
      id: true, currentStage: true, status: true,
      folio: { select: { id: true, state: true, outstandingBalance: true } },
    },
  });

  console.log(`${toClose.length} in-flight booking(s) to close`);
  console.log(`${terminalWithJunk.length} already-terminal booking(s) still holding something\n`);

  const byStage: Record<string, number> = {};
  for (const e of toClose) byStage[e.currentStage] = (byStage[e.currentStage] ?? 0) + 1;
  console.log("abandoned at:", JSON.stringify(byStage));

  let settled = 0, writtenOff = 0, holds = 0, timers = 0, segments = 0, dwells = 0, handoffs = 0;
  const writeOffs: string[] = [];

  for (const e of [...toClose, ...terminalWithJunk]) {
    const closing = !(TERMINAL as readonly string[]).includes(e.status);
    const now = new Date();

    const liveTimers = await prisma.timerRecord.count({ where: { entryId: e.id, status: "SCHEDULED" } });
    const liveHold = await prisma.committedHold.findFirst({
      where: { entryId: e.id, state: { in: ["PLACED", "CONFIRMED"] } }, select: { id: true },
    });
    const specHolds = await prisma.speculativeHold.count({ where: { entryId: e.id, state: "PLACED" } });
    // A departmental task on a finished stay will never be worked; left CREATED it keeps
    // appearing on the housekeeping and F&B lists. Cancelled, not fulfilled — nobody did it.
    const openHandoffs = await prisma.handoffRecord.count({
      where: { entryId: e.id, state: { in: ["CREATED", "ACCEPTED"] } },
    });

    const folio = "folio" in e ? e.folio : null;
    const bal = folio ? Number(folio.outstandingBalance) : 0;
    const folioOpen = folio && ["PROVISIONAL", "LIVE", "OUTSTANDING"].includes(folio.state);
    const folioTarget = folioOpen ? (bal > 0 ? "WRITTEN_OFF" : "SETTLED") : null;
    if (folioTarget === "WRITTEN_OFF") writeOffs.push(`${e.id} (${bal.toFixed(2)})`);

    timers += liveTimers;
    holds += (liveHold ? 1 : 0) + specHolds;
    handoffs += openHandoffs;
    if (folioTarget === "SETTLED") settled++;
    if (folioTarget === "WRITTEN_OFF") writtenOff++;

    if (!COMMIT) continue;

    await prisma.$transaction(async (tx) => {
      if (liveTimers) {
        await tx.timerRecord.updateMany({
          where: { entryId: e.id, status: "SCHEDULED" },
          data: { status: "CANCELLED", cancelledAt: now, cancelledBy: ACTOR, cancelledReason: "ADMIN_BULK_CLOSE" },
        });
      }
      if (liveHold) {
        await tx.committedHold.update({
          where: { id: liveHold.id },
          data: { state: "RELEASED", releasedAt: now, releaseReason: "ADMIN_BULK_CLOSE" },
        });
      }
      if (specHolds) {
        await tx.speculativeHold.updateMany({
          where: { entryId: e.id, state: "PLACED" },
          data: { state: "RELEASED", releasedAt: now },
        });
      }
      if (openHandoffs) {
        await tx.handoffRecord.updateMany({
          where: { entryId: e.id, state: { in: ["CREATED", "ACCEPTED"] } },
          data: { state: "CANCELLED", cancelledAt: now },
        });
      }
      if (folioTarget && folio) {
        await tx.folio.update({
          where: { id: folio.id },
          data: { state: folioTarget as never, closedAt: now },
        });
      }
      if (closing) {
        const openDwell = await tx.stageDwellRecord.findFirst({
          where: { entryId: e.id, exitedAt: null }, orderBy: { enteredAt: "desc" }, select: { id: true, enteredAt: true },
        });
        if (openDwell) {
          await tx.stageDwellRecord.update({
            where: { id: openDwell.id },
            data: { exitedAt: now, dwellSeconds: Math.floor((now.getTime() - openDwell.enteredAt.getTime()) / 1000) },
          });
          dwells++;
        }
        const openSeg = await tx.segment.findFirst({
          where: { entryId: e.id, sealedAt: null }, orderBy: { segmentNumber: "desc" }, select: { id: true },
        });
        if (openSeg) {
          await tx.segment.update({
            where: { id: openSeg.id },
            data: { sealedAt: now, sealedBy: ACTOR, notes: "Sealed by the administrative bulk close of test bookings" },
          });
          segments++;
        }
        await tx.entry.update({
          where: { id: e.id },
          data: { currentStage: "S9", status: "CLOSED", closedAt: now, version: { increment: 1 } },
        });
      }
      await tx.traceEvent.create({
        data: {
          eventType: closing ? "ENTRY.ADMIN_BULK_CLOSED" : "ENTRY.ADMIN_BULK_RELEASED",
          actorId: ACTOR, actorLevel: "L4", entityType: "Entry", entityId: e.id,
          operation: "UPDATE", entryId: e.id, stageContext: closing ? "S9" : undefined,
          payload: {
            abandonedAtStage: e.currentStage, priorStatus: e.status,
            folio: folioTarget ? { to: folioTarget, outstandingBalance: bal } : null,
            holdsReleased: (liveHold ? 1 : 0) + specHolds, timersCancelled: liveTimers,
            reason: "Test booking from the July-September 2026 manual testing; closed administratively, not settled.",
          },
        },
      });
    });
  }

  console.log(`\nholds to release      : ${holds}`);
  console.log(`timers to cancel      : ${timers}`);
  console.log(`handoffs to cancel    : ${handoffs}`);
  console.log(`folios -> SETTLED     : ${settled}   (balance already zero)`);
  console.log(`folios -> WRITTEN_OFF : ${writtenOff}  (had an unpaid balance)`);
  if (writeOffs.length) console.log(`  ${writeOffs.slice(0, 8).join(", ")}${writeOffs.length > 8 ? ` … +${writeOffs.length - 8}` : ""}`);
  if (COMMIT) console.log(`\nsegments sealed: ${segments} · dwell records closed: ${dwells}`);
  console.log(COMMIT
    ? `\nDone. ${toClose.length} booking(s) closed at S9. Now run: npx tsx scripts/repair-stuck-room-states.ts --commit`
    : `\nDry run — nothing written. Re-run with --commit.`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
