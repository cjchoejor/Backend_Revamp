/**
 * Take off a booking the rooms a change brought back by mistake (2026-11-28, TEST-ED-LE4-ENT).
 *
 * Before 2026-11-28 a room taken off a stay stayed on the booking's plan (lib/plan-room-left.ts).
 * A stay extension then read it as still the guests' and, the room being someone else's on the
 * extra nights, moved its guests — who had left — into a new room for every extra night. Those rows
 * carry guests who are not there. Audit check A22_GUESTS_CAME_BACK finds the booking.
 *
 * The desk's own route (Remove a room) takes off only a room a guest is in, and nobody is in these.
 * This does what it does, for rooms nobody has slept in yet: the row ends on its first night (no
 * night slept, its frozen figures to nothing), a departure record of kind REMOVED keeps what was
 * priced on it (no fee — the hotel's mistake), the room leaves the plan, and its flag is put back to
 * what the bookings still holding it say. Refused for a room with a night already charged.
 *
 *   npx tsx scripts/remove-rooms-brought-back.ts --only ENT-… --rooms 304,701             # dry run
 *   npx tsx scripts/remove-rooms-brought-back.ts --only ENT-… --rooms 304,701 --commit
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { allocateReadableId } from "../src/lib/readable-id.js";
import { takeRoomOffPlanTx } from "../src/lib/plan-room-left.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../src/lib/room-flag-repair.js";

const prisma = new PrismaClient();
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const COMMIT = process.argv.includes("--commit");
const ENTRY = arg("--only");
const ROOMS = (arg("--rooms") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function main() {
  if (!ENTRY || !ROOMS.length) throw new Error("Name the booking (--only ENT-…) and the rooms (--rooms 304,701)");
  const entry = await prisma.entry.findUnique({
    where: { id: ENTRY },
    select: {
      id: true,
      inquiryId: true,
      currentStage: true,
      status: true,
      folio: { select: { id: true } },
      roomAssignments: { select: { id: true, roomId: true, startDate: true, endDate: true, frozenSubtotal: true, frozenTotal: true, room: { select: { roomNumber: true } } } },
    },
  });
  if (!entry) throw new Error(`${ENTRY} not found`);
  if (entry.status !== "ACTIVE" || entry.currentStage !== "S7") throw new Error(`${ENTRY} is not in house (${entry.status} ${entry.currentStage})`);

  const plan: Array<{ row: (typeof entry.roomAssignments)[number]; nights: number }> = [];
  for (const no of ROOMS) {
    const rows = entry.roomAssignments.filter((a) => a.room.roomNumber === no);
    if (rows.length !== 1) throw new Error(`Room ${no}: ${rows.length} rows on ${ENTRY} — expected one`);
    const row = rows[0];
    if (!row.startDate || !row.endDate || row.endDate <= row.startDate) throw new Error(`Room ${no}: its row has no nights to take off`);
    const charged = entry.folio
      ? await prisma.folioLine.count({ where: { folioId: entry.folio.id, roomId: row.roomId, chargeDate: { gte: row.startDate, lt: row.endDate } } })
      : 0;
    if (charged) throw new Error(`Room ${no}: ${charged} line(s) already on the bill for its nights — not taken off here`);
    const nights = Math.round((row.endDate.getTime() - row.startDate.getTime()) / 86_400_000);
    plan.push({ row, nights });
    console.log(`Room ${no}: ${ymd(row.startDate)} → ${ymd(row.endDate)} · ${nights} night(s) · Nu ${row.frozenTotal} priced on it — ${COMMIT ? "taking off" : "would take off"}`);
  }
  if (!COMMIT) {
    console.log("\nDry run — run with --commit to write.");
    return;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const records: Array<{ id: string; roomNumber: string; forgoneTotal: string; unstayedNights: number }> = [];
    for (const { row, nights } of plan) {
      const id = await allocateReadableId(tx, "EARLY_DEPARTURE" as const, now);
      await tx.roomAssignment.update({
        where: { id: row.id },
        data: { endDate: row.startDate!, frozenSubtotal: new Prisma.Decimal(0), frozenTotal: new Prisma.Decimal(0) },
      });
      await tx.roomDepartureRecord.create({
        data: {
          id,
          entryId: entry.id,
          roomId: row.roomId,
          roomNumber: row.room.roomNumber,
          assignmentId: row.id,
          departureDate: row.startDate!,
          originalEndDate: row.endDate!,
          sleptNights: 0,
          unstayedNights: nights,
          forgoneSubtotal: row.frozenSubtotal ?? new Prisma.Decimal(0),
          forgoneTotal: row.frozenTotal ?? new Prisma.Decimal(0),
          frozenSubtotalBefore: row.frozenSubtotal,
          frozenTotalBefore: row.frozenTotal,
          // The room held the guests of a room that had already left: taking it off takes nobody.
          feeBasis: {
            removed: true,
            guestsOfItsOwn: false,
            note: "Brought back by mistake by a change made while the room was still on the plan — no fee; its guests had already left with another room",
          } as Prisma.InputJsonValue,
          kind: "REMOVED",
          feeAmount: new Prisma.Decimal(0),
          feeWaived: false,
          billing: "TOGETHER",
          state: "LEFT",
          leftAt: now,
          leftBy: "SYSTEM",
          reason: "The guests of this room had left; a stay extension brought the room back by mistake",
          recordedAt: now,
          recordedBy: "SYSTEM",
          recordedByLevel: "L4",
        },
      });
      await takeRoomOffPlanTx(tx, entry.id, row.roomId, ymd(row.startDate!));
      records.push({ id, roomNumber: row.room.roomNumber, forgoneTotal: String(row.frozenTotal ?? 0), unstayedNights: nights });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.ROOMS_REMOVED",
        actorId: "SYSTEM",
        actorLevel: "L4",
        entityType: "Entry",
        entityId: entry.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          kind: "REMOVED",
          repair: true,
          script: "remove-rooms-brought-back",
          reason: "The guests of these rooms had left; a stay extension brought the rooms back by mistake",
          rooms: records,
        },
        createdBy: "SYSTEM",
      },
    });
  });
  const flags = await planRoomFlagRepairs(prisma, { roomIds: plan.map((p) => p.row.roomId) });
  await applyRoomFlagRepairs(prisma, flags.plan, flags.today);
  for (const f of flags.plan) console.log(`  Room ${f.roomNumber}: ${f.from} → ${f.to} (${f.why})`);
  console.log("written");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
