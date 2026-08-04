/**
 * Test bookings that make every S1 availability state visible, starting today.
 *
 * Creates one booking per state so the room-status table shows Reserved / Held / Blocked side by
 * side over the next few nights:
 *
 *   RESERVED (assigned)  — S4 entry + Reservation + RoomAssignment. The ordinary confirmed case.
 *   RESERVED (no assign) — S4 entry + Reservation, rooms only on the committed hold, hold TTL
 *                          already lapsed. Before 2026-08-04 this booking was INVISIBLE to
 *                          search; it is the regression case worth keeping on screen.
 *   HELD committed       — S3 entry + CommittedHold (PLACED, live TTL).
 *   HELD speculative     — S2 entry + SpeculativeHold (PLACED, live TTL). Blocks since
 *                          2026-08-04; this is the two-operators-at-once case.
 *   BLOCKED              — rooms flagged out of service, no booking behind them.
 *
 * Everything it writes is prefixed `TEST-` so `--clean` can remove it exactly. Rooms it blocks
 * are recorded and restored by `--clean` too.
 *
 *   npx tsx scripts/seed-availability-test-data.ts            # dry run — prints the plan
 *   npx tsx scripts/seed-availability-test-data.ts --commit   # write it
 *   npx tsx scripts/seed-availability-test-data.ts --clean --commit   # remove it again
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");
const CLEAN = process.argv.includes("--clean");
const P = "TEST-";

const dayStart = (offsetDays: number): Date => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function clean() {
  // Children first, then the entries, then the scaffolding.
  const entries = await prisma.entry.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
  const ids = entries.map((e) => e.id);
  console.log(`removing ${ids.length} test entries and their rows`);
  if (!COMMIT) return;

  await prisma.speculativeHold.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.committedHold.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.roomAssignment.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.availabilityConfiguration.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.reservation.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.stageDwellRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.traceEvent.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.segment.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.entry.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.inquiry.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.guestProfile.deleteMany({ where: { id: { startsWith: P } } });

  const blocked = await prisma.room.findMany({
    where: { blockedReason: { startsWith: P } },
    select: { id: true, roomNumber: true },
  });
  await prisma.room.updateMany({
    where: { blockedReason: { startsWith: P } },
    data: { isBlocked: false, blockedReason: null, currentClaimState: "FREE" },
  });
  await prisma.room.updateMany({
    where: { id: { in: [] } },
    data: {},
  });
  console.log(`unblocked ${blocked.length} rooms: ${blocked.map((r) => r.roomNumber).join(", ")}`);
  console.log("clean complete");
}

async function main() {
  if (CLEAN) return clean();

  // Re-runnable: clear any earlier seed (or the debris of a failed one) before writing.
  if (COMMIT) await clean();

  const staff = await prisma.staffUser.findFirst({ where: { actorLevel: "L4" }, select: { id: true } });
  const ratePlan = await prisma.ratePlanRegistry.findFirst({ select: { id: true } });
  if (!staff) throw new Error("no L4 staff user to own the test data");

  const checkIn = dayStart(0);
  // Free rooms across the whole window, so the seed does not collide with real bookings.
  const windowEnd = dayStart(5);
  const busy = new Set<string>();
  for (const r of await prisma.reservation.findMany({
    where: { frozenCheckInDate: { lt: windowEnd }, frozenCheckOutDate: { gt: checkIn } },
    select: { entry: { select: { roomAssignments: { select: { roomId: true } }, committedHold: { select: { roomId: true } } } } },
  })) {
    for (const a of r.entry?.roomAssignments ?? []) busy.add(a.roomId);
    if (r.entry?.committedHold?.roomId) busy.add(r.entry.committedHold.roomId);
  }
  for (const h of await prisma.committedHold.findMany({ where: { roomId: { not: null } }, select: { roomId: true } }))
    if (h.roomId) busy.add(h.roomId);
  for (const h of await prisma.speculativeHold.findMany({ where: { roomId: { not: null } }, select: { roomId: true } }))
    if (h.roomId) busy.add(h.roomId);

  const rooms = await prisma.room.findMany({
    where: { id: { notIn: [...busy] }, isBlocked: false },
    select: { id: true, roomNumber: true, roomTypeId: true },
    orderBy: { roomNumber: "asc" },
    take: 8,
  });
  if (rooms.length < 6) throw new Error(`need 6 free rooms, found ${rooms.length}`);

  /** name, nights, stage, what it should read as in S1. */
  const plan = [
    { key: "res-assigned", nights: 3, stage: "S4" as const, room: rooms[0], reads: "RESERVED (with room assignment)" },
    { key: "res-holdonly", nights: 4, stage: "S4" as const, room: rooms[1], reads: "RESERVED (rooms only on a lapsed hold — the regression case)" },
    { key: "held-committed", nights: 2, stage: "S3" as const, room: rooms[2], reads: "HELD · committed" },
    { key: "held-speculative", nights: 3, stage: "S2" as const, room: rooms[3], reads: "HELD · speculative" },
  ];
  const blockedRooms = [rooms[4], rooms[5]];

  console.log(`window: ${iso(checkIn)} → ${iso(dayStart(4))}\n`);
  for (const p of plan) console.log(`  ${p.room.roomNumber.padEnd(6)} ${p.reads}  (${p.nights} nights)`);
  for (const r of blockedRooms) console.log(`  ${r.roomNumber.padEnd(6)} BLOCKED (out of service, no booking)`);
  if (!COMMIT) return console.log("\n(dry run — pass --commit to write)");

  for (const [i, p] of plan.entries()) {
    const n = i + 1;
    const gp = await prisma.guestProfile.create({
      data: { id: `${P}GP-${n}`, firstName: "Test", lastName: `Guest ${n}`, phone: `+9751700000${n}` },
    });
    const inq = await prisma.inquiry.create({
      data: {
        id: `${P}INQ-${n}`,
        referenceNumber: `${P}INQ-${n}`,
        guestProfileId: gp.id,
        defaultCustodianId: staff.id,
        sourceChannel: "DIRECT",
        notes: "Seeded availability test data",
      },
    });
    const checkOut = dayStart(p.nights);
    const entry = await prisma.entry.create({
      data: {
        id: `${P}ENT-${n}`,
        inquiryId: inq.id,
        guestProfileId: gp.id,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: p.stage,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guestCount: 2,
        adultCount: 2,
        numberOfRooms: 1,
        contactPersonName: `Test Guest ${n}`,
        contactPersonPhone: `+9751700000${n}`,
        createdBy: staff.id,
      },
    });
    const seg = await prisma.segment.create({
      data: { id: `${P}SEG-${n}`, entryId: entry.id, segmentNumber: 1, stage: p.stage, createdBy: staff.id },
    });

    if (p.key === "held-speculative") {
      await prisma.speculativeHold.create({
        data: {
          id: `${P}SPEC-${n}`, entryId: entry.id, segmentId: seg.id, roomId: p.room.id, state: "PLACED",
          placedBy: staff.id, ttlSeconds: 86_400, expiresAt: dayStart(2),
        },
      });
    } else {
      // Committed hold for the S3 case; for the two S4 cases it is the pre-confirmation hold.
      // "res-holdonly" gets an ALREADY-LAPSED TTL so only the reservation fallback can find it.
      const lapsed = p.key === "res-holdonly";
      await prisma.committedHold.create({
        data: {
          id: `${P}CH-${n}`, entryId: entry.id, segmentId: seg.id, roomId: p.room.id,
          roomTypeId: p.room.roomTypeId, state: p.stage === "S4" ? "CONFIRMED" : "PLACED",
          placedBy: staff.id, ttlSeconds: 86_400,
          expiresAt: lapsed ? dayStart(-1) : dayStart(3),
          perNightBreakdown: [{ date: iso(checkIn), roomIds: [{ roomId: p.room.id }] }] as Prisma.InputJsonValue,
        },
      });
    }

    if (p.stage === "S4") {
      await prisma.reservation.create({
        data: {
          id: `${P}RES-${n}`, entryId: entry.id, segmentId: seg.id,
          frozenRate: new Prisma.Decimal(2000), frozenRatePlanId: ratePlan?.id ?? `${P}PLAN`,
          frozenBillingModel: "DIRECT_BILL", frozenCheckInDate: checkIn, frozenCheckOutDate: checkOut,
          frozenGuestCount: 2, confirmedAt: new Date(), confirmedBy: staff.id,
        },
      });
      await prisma.entry.update({ where: { id: entry.id }, data: { currentReservationId: `${P}RES-${n}` } });
      // Only the first case gets a physical assignment — the second proves the hold fallback.
      if (p.key === "res-assigned") {
        await prisma.roomAssignment.create({
          data: { id: `${P}RA-${n}`, entryId: entry.id, roomId: p.room.id, assignedBy: staff.id, startDate: checkIn, endDate: checkOut },
        });
      }
    }

    await prisma.room.update({
      where: { id: p.room.id },
      data: { currentClaimState: p.stage === "S4" ? "CONFIRMED" : p.stage === "S3" ? "COMMITTED_HELD" : "SPECULATIVELY_HELD" },
    });
    console.log(`  created ${entry.id} on room ${p.room.roomNumber}`);
  }

  for (const r of blockedRooms) {
    await prisma.room.update({
      where: { id: r.id },
      data: { isBlocked: true, blockedReason: `${P}out of service (seeded test data)` },
    });
    console.log(`  blocked room ${r.roomNumber}`);
  }
  console.log("\ndone — search S1 over these dates to see Reserved / Held / Blocked together");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
