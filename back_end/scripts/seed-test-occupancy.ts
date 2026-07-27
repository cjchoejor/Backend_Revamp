/**
 * Test fixture: put bookings on rooms THIS WEEK so the S1 availability grid has something to
 * attribute.
 *
 * The imported Legphel data is all historical (newest reservation 2026-07-02), so a search over
 * the current week returns every room vacant and the "Booked by" column / name chips have
 * nothing to show. This creates a small, deliberately-staggered set of bookings across the
 * coming week — staggered so different rooms are taken on different nights, which is exactly
 * what the per-night availability fix and the in-cell names are meant to surface.
 *
 * Covers both occupancy sources the engine reads:
 *   - RESERVED — Reservation + RoomAssignment (the engine fans out reservation → assignments)
 *   - HOLD     — live CommittedHold pinned to a room
 * ...and both holder shapes: a plain guest, and a guest booked through a travel agent.
 *
 * Room claim states are deliberately NOT touched. The rooms stay FREE; only the reservation /
 * hold rows drive the display. That also proves the 2026-07-25 engine fix — before it, a room
 * was only shown as taken when its claim state was non-FREE.
 *
 * Every row is stamped `createdBy = TEST_OCCUPANCY_FIXTURE` so `--undo` can remove all of it.
 *
 *   npx tsx scripts/seed-test-occupancy.ts            # dry run — prints the plan
 *   npx tsx scripts/seed-test-occupancy.ts --commit   # apply
 *   npx tsx scripts/seed-test-occupancy.ts --undo     # remove everything it created
 */
import { prisma } from "../src/db.js";
import { allocateReadableId } from "../src/lib/readable-id.js";

const MARKER = "TEST_OCCUPANCY_FIXTURE";

type Plan = {
  roomNumber: string;
  first: string;
  last: string;
  phone: string;
  email: string;
  /** Offset in days from today for check-in / check-out. */
  from: number;
  to: number;
  kind: "RESERVED" | "HOLD";
  /** Link the inquiry to the first travel agent, to exercise the agent-name path. */
  viaAgent?: boolean;
};

// Staggered on purpose — no two rooms share the same window, so a week-long search shows a
// different occupancy pattern on each night rather than one uniform block.
const PLANS: Plan[] = [
  { roomNumber: "203", first: "Pema", last: "Choden", phone: "+975-17-100-201", email: "pema.choden@example.bt", from: 0, to: 3, kind: "RESERVED" },
  { roomNumber: "204", first: "Karma", last: "Dorji", phone: "+975-17-100-202", email: "karma.dorji@example.bt", from: 1, to: 4, kind: "RESERVED" },
  { roomNumber: "205", first: "Sonam", last: "Lhamo", phone: "+975-17-100-203", email: "sonam.lhamo@example.bt", from: 0, to: 2, kind: "RESERVED", viaAgent: true },
  { roomNumber: "302", first: "Ugyen", last: "Tshering", phone: "+975-17-100-204", email: "ugyen.tshering@example.bt", from: 3, to: 6, kind: "RESERVED" },
  { roomNumber: "303", first: "Deki", last: "Wangmo", phone: "+975-17-100-205", email: "deki.wangmo@example.bt", from: 0, to: 2, kind: "HOLD" },
  { roomNumber: "304", first: "Jigme", last: "Namgyal", phone: "+975-17-100-206", email: "jigme.namgyal@example.bt", from: 2, to: 5, kind: "HOLD" },
];

function midnightUtc(offsetDays: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function undo() {
  // FK-safe order. Entry.currentReservationId points at Reservation, so clear it first.
  const entries = await prisma.entry.findMany({ where: { createdBy: MARKER }, select: { id: true, inquiryId: true } });
  const entryIds = entries.map((e) => e.id);
  const inquiryIds = Array.from(new Set(entries.map((e) => e.inquiryId)));
  if (entryIds.length === 0) {
    console.log("Nothing to undo — no rows carry the fixture marker.");
    return;
  }
  await prisma.entry.updateMany({ where: { id: { in: entryIds } }, data: { currentReservationId: null } });
  const ra = await prisma.roomAssignment.deleteMany({ where: { entryId: { in: entryIds } } });
  const res = await prisma.reservation.deleteMany({ where: { entryId: { in: entryIds } } });
  const ch = await prisma.committedHold.deleteMany({ where: { entryId: { in: entryIds } } });
  const sg = await prisma.segment.deleteMany({ where: { entryId: { in: entryIds } } });
  const en = await prisma.entry.deleteMany({ where: { id: { in: entryIds } } });
  const inq = await prisma.inquiry.deleteMany({ where: { id: { in: inquiryIds } } });
  const gp = await prisma.guestProfile.deleteMany({ where: { createdBy: MARKER } });
  console.log(
    `Removed — assignments ${ra.count}, reservations ${res.count}, holds ${ch.count}, segments ${sg.count}, entries ${en.count}, inquiries ${inq.count}, guests ${gp.count}`,
  );
}

async function main() {
  const commit = process.argv.includes("--commit");
  if (process.argv.includes("--undo")) {
    await undo();
    await prisma.$disconnect();
    return;
  }

  const roomNumbers = PLANS.map((p) => p.roomNumber);
  const rooms = await prisma.room.findMany({ where: { roomNumber: { in: roomNumbers } } });
  const byNumber = new Map(rooms.map((r) => [r.roomNumber, r]));
  const missing = roomNumbers.filter((n) => !byNumber.has(n));
  if (missing.length) throw new Error(`Rooms not in catalogue: ${missing.join(", ")}`);

  const ratePlan = await prisma.ratePlanRegistry.findFirst();
  if (!ratePlan) throw new Error("No rate plan — cannot set Reservation.frozenRatePlanId");
  const custodian = await prisma.staffUser.findFirst();
  if (!custodian) throw new Error("No staff user — cannot set Inquiry.defaultCustodianId");
  const agent = await prisma.travelAgent.findFirst({ where: { isActive: true } });

  console.log(`Fixture plan (today = ${iso(midnightUtc(0))}):\n`);
  for (const p of PLANS) {
    const via = p.viaAgent ? (agent ? ` via ${agent.displayName}` : " via <no agent found>") : "";
    console.log(
      `  Room ${p.roomNumber.padEnd(5)} ${iso(midnightUtc(p.from))} → ${iso(midnightUtc(p.to))}  ${p.kind.padEnd(8)} ${p.first} ${p.last}${via}`,
    );
  }
  const already = await prisma.entry.count({ where: { createdBy: MARKER } });
  if (already > 0) console.log(`\n⚠  ${already} fixture entries already exist — run --undo first to avoid duplicates.`);

  if (!commit) {
    console.log("\n(dry run — pass --commit to apply, --undo to remove)");
    await prisma.$disconnect();
    return;
  }

  let made = 0;
  for (const p of PLANS) {
    const room = byNumber.get(p.roomNumber)!;
    const checkIn = midnightUtc(p.from);
    const checkOut = midnightUtc(p.to);

    await prisma.$transaction(async (tx) => {
      const guest = await tx.guestProfile.create({
        data: {
          firstName: p.first,
          lastName: p.last,
          email: p.email,
          phone: p.phone,
          nationality: "Bhutanese",
          createdBy: MARKER,
        },
      });

      const inquiryId = await allocateReadableId(tx, "INQUIRY" as const);
      const inquiry = await tx.inquiry.create({
        data: {
          id: inquiryId,
          referenceNumber: inquiryId,
          guestProfileId: guest.id,
          sourceChannel: "DIRECT",
          defaultCustodianId: custodian.id,
          notes: "Test occupancy fixture — safe to delete",
          travelAgentId: p.viaAgent && agent ? agent.id : null,
          createdBy: MARKER,
        },
      });

      const entryId = await allocateReadableId(tx, "ENTRY" as const);
      const entry = await tx.entry.create({
        data: {
          id: entryId,
          inquiryId: inquiry.id,
          guestProfileId: guest.id,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          numberOfRooms: 1,
          guestCount: 2,
          adultCount: 2,
          childCount: 0,
          currentStage: p.kind === "RESERVED" ? "S4" : "S3",
          createdBy: MARKER,
        },
      });

      const segment = await tx.segment.create({
        data: { entryId: entry.id, segmentNumber: 1, stage: entry.currentStage, createdBy: MARKER },
      });

      if (p.kind === "RESERVED") {
        const resId = await allocateReadableId(tx, "RESERVATION" as const);
        const reservation = await tx.reservation.create({
          data: {
            id: resId,
            entryId: entry.id,
            segmentId: segment.id,
            frozenRate: 3500,
            frozenRatePlanId: ratePlan.id,
            frozenBillingModel: "GUEST_PAY",
            frozenCheckInDate: checkIn,
            frozenCheckOutDate: checkOut,
            frozenGuestCount: 2,
            confirmedAt: new Date(),
            confirmedBy: MARKER,
          },
        });
        await tx.entry.update({ where: { id: entry.id }, data: { currentReservationId: reservation.id } });

        // The engine fans out reservation → entry.roomAssignments, so the assignment is what
        // actually pins this reservation to a room number.
        const raId = await allocateReadableId(tx, "ROOM_ASSIGNMENT" as const);
        await tx.roomAssignment.create({
          data: {
            id: raId,
            entryId: entry.id,
            roomId: room.id,
            startDate: checkIn,
            endDate: checkOut,
            assignedBy: MARKER,
            notes: "Test occupancy fixture",
          },
        });
      } else {
        await tx.committedHold.create({
          data: {
            entryId: entry.id,
            segmentId: segment.id,
            roomId: room.id,
            roomTypeId: room.roomTypeId,
            state: "PLACED",
            placedBy: MARKER,
            commercialJustification: "Test occupancy fixture",
            ttlSeconds: 7 * 86_400,
            expiresAt: new Date(Date.now() + 7 * 86_400_000),
          },
        });
      }
    });
    made += 1;
    console.log(`  ✓ ${p.kind} room ${p.roomNumber} — ${p.first} ${p.last}`);
  }

  console.log(`\n✓ Created ${made} bookings. Search ${iso(midnightUtc(0))} → ${iso(midnightUtc(7))} in S1 to see them.`);
  console.log("  Undo with: npx tsx scripts/seed-test-occupancy.ts --undo");
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
