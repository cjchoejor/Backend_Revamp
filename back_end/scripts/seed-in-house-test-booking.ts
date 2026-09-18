/**
 * Seed ONE in-house (S7) test booking so the checkout paths can be exercised on a booking whose
 * checkout is still ahead — the early-departure route (2026-08-22) needs a guest who is in the
 * middle of a stay, and no fixture builder existed (every live S7 booking was past or ahead of its
 * dates). Everything it writes is `TEST-ED-` prefixed.
 *
 *   npx tsx scripts/seed-in-house-test-booking.ts                 # dry run — prints what it would create
 *   npx tsx scripts/seed-in-house-test-booking.ts --commit        # write (re-runnable: clears its own prior seed first)
 *   npx tsx scripts/seed-in-house-test-booking.ts --clean --commit  # remove it
 *
 * Options: --slept N (nights already slept, default 2) · --ahead N (nights still booked, default 4)
 *          · --rate R (frozen NET per-night room figure, default 2000) · --room NNN (room number)
 *          · --rooms N (how many rooms, default 1 — a MULTI-room booking, added 2026-09-09 for
 *            PMS-237's one-room-leaves-early path, which by definition cannot be exercised on a
 *            single-room stay).
 *
 * Shape (mirrors what the real S1→S7 walk leaves behind, minimally): guest profile, inquiry,
 * entry at S7/ACTIVE with check-in `slept` days ago and checkout `ahead` days ahead, one segment,
 * a CONFIRMED committed hold, an immutable Reservation (frozen dates + rate), a LIVE folio, one
 * dated RoomAssignment with frozen composition figures (subtotal = rate × nights, total = subtotal
 * × (1 + SC) × (1 + GST) at the live rates), the room OCCUPIED, and an open S7 dwell record.
 * The slept nights are NOT audited here — run the night audit for them (past nights only):
 *   POST /api/night-audit/run { operatingDate }   or the desk's Night audit block.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { hotelTodayUtc } from "../src/lib/stay-dates.js";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const CLEAN = argv.includes("--clean");
const arg = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SLEPT = Math.max(0, Number(arg("--slept", "2")));
const AHEAD = Math.max(1, Number(arg("--ahead", "4")));
const RATE = Number(arg("--rate", "2000"));
const ROOM = arg("--room", "");
const ROOM_COUNT = Math.max(1, Number(arg("--rooms", "1")));
const P = "TEST-ED-";

const dayStart = (offsetDays: number): Date => {
  // The HOTEL's day — the UTC date is still yesterday in Bhutan until 06:00.
  const d = hotelTodayUtc();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function clean() {
  const entries = await prisma.entry.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
  const ids = entries.map((e) => e.id);
  const folios = await prisma.folio.findMany({ where: { entryId: { in: ids } }, select: { id: true } });
  const folioIds = folios.map((f) => f.id);
  const occupied = await prisma.roomAssignment.findMany({ where: { entryId: { in: ids } }, select: { roomId: true } });
  console.log(`removing ${ids.length} test entries and their rows`);
  if (!COMMIT) return;
  await prisma.earlyDepartureRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.timerRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.handoffRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.keyReturnRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.roomInspectionRecord.deleteMany({ where: { entryId: { in: ids } } });
  // Money first, in foreign-key order: a payment can point at an interim request, an interim
  // request at its invoice and its extension, an advance application at the folio. A fixture that
  // went through a long stay's mid-stay payment or an extension left them (2026-09-19).
  await prisma.paymentRecord.deleteMany({ where: { folioId: { in: folioIds } } });
  await prisma.interimPaymentRequest.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.stayExtensionRequest.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.advanceApplication.deleteMany({ where: { folioId: { in: folioIds } } });
  // Invoice lines point at their invoice (FK) — a fixture that reached a tax invoice left them.
  await prisma.invoiceLine.deleteMany({ where: { invoice: { entryId: { in: ids } } } });
  await prisma.invoice.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.folioLine.deleteMany({ where: { folioId: { in: folioIds } } });
  await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
  await prisma.committedHold.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.roomAssignment.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.stageDwellRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.traceEvent.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.entry.updateMany({ where: { id: { in: ids } }, data: { currentReservationId: null } });
  await prisma.reservation.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.segment.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.entry.deleteMany({ where: { id: { in: ids } } });
  await prisma.inquiry.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.guestProfile.deleteMany({ where: { id: { startsWith: P } } });
  for (const r of occupied) {
    await prisma.room.update({ where: { id: r.roomId }, data: { currentClaimState: "FREE" } });
  }
  console.log(`clean complete (${occupied.length} room(s) back to FREE)`);
}

async function main() {
  if (CLEAN) return clean();
  if (COMMIT) await clean();

  const staff = await prisma.staffUser.findFirst({ where: { actorLevel: "L4" }, select: { id: true } });
  const ratePlan = await prisma.ratePlanRegistry.findFirst({ select: { id: true } });
  if (!staff) throw new Error("no L4 staff user to own the test data");

  const checkIn = dayStart(-SLEPT);
  const checkOut = dayStart(AHEAD);
  const nights = SLEPT + AHEAD;

  // A room free across the whole window (reservations + live holds), or the one asked for.
  const busy = new Set<string>();
  for (const r of await prisma.reservation.findMany({
    where: { frozenCheckInDate: { lt: checkOut }, frozenCheckOutDate: { gt: checkIn }, entry: { status: { notIn: ["CANCELLED", "EXPIRED", "CLOSED"] } } },
    select: { entry: { select: { roomAssignments: { select: { roomId: true } }, committedHold: { select: { roomId: true } } } } },
  })) {
    for (const a of r.entry?.roomAssignments ?? []) busy.add(a.roomId);
    if (r.entry?.committedHold?.roomId) busy.add(r.entry.committedHold.roomId);
  }
  for (const h of await prisma.committedHold.findMany({ where: { roomId: { not: null }, state: { in: ["PLACED", "CONFIRMED"] }, expiresAt: { gt: new Date() } }, select: { roomId: true } }))
    if (h.roomId) busy.add(h.roomId);
  const picked = ROOM
    ? await prisma.room.findMany({ where: { roomNumber: ROOM }, select: { id: true, roomNumber: true, roomTypeId: true, currentClaimState: true }, take: 1 })
    : await prisma.room.findMany({
        where: { id: { notIn: [...busy] }, isBlocked: false, currentClaimState: "FREE", isShadowInventory: false },
        select: { id: true, roomNumber: true, roomTypeId: true, currentClaimState: true },
        orderBy: { roomNumber: "asc" },
        take: ROOM_COUNT,
      });
  if (picked.length === 0) throw new Error("no free room for the test booking");
  if (picked.length < ROOM_COUNT) throw new Error(`only ${picked.length} free room(s) available, asked for ${ROOM_COUNT}`);
  const rooms = picked;
  const room = rooms[0];

  const scRow = await prisma.configurationEntry.findFirst({ where: { configKey: "billing.serviceChargeRate", effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
  const gstRow = await prisma.configurationEntry.findFirst({ where: { configKey: "billing.salesTaxRate", effectiveTo: null }, orderBy: { effectiveFrom: "desc" } });
  const sc = Number(scRow?.configValue ?? 0.1);
  const gst = Number(gstRow?.configValue ?? 0.05);
  const subtotal = new Prisma.Decimal(RATE).mul(nights);
  const total = subtotal.mul(1 + sc).mul(1 + gst).toDecimalPlaces(2);

  console.log(
    `in-house test booking: room${rooms.length > 1 ? "s" : ""} ${rooms.map((r) => r.roomNumber).join(", ")} · stay ${iso(checkIn)} → ${iso(checkOut)} (${nights} nights, ${SLEPT} slept) · rate ${RATE}/night net · frozen subtotal ${subtotal} / total ${total} PER ROOM`,
  );
  if (!COMMIT) return console.log("(dry run — pass --commit to write)");

  const gp = await prisma.guestProfile.create({ data: { id: `${P}GP`, firstName: "Early", lastName: "Leaver", phone: "+97517000099", email: null } });
  const inq = await prisma.inquiry.create({
    data: { id: `${P}INQ`, referenceNumber: `${P}INQ`, guestProfileId: gp.id, defaultCustodianId: staff.id, sourceChannel: "DIRECT", notes: "Seeded in-house test booking (early departure)" },
  });
  const entry = await prisma.entry.create({
    data: {
      id: `${P}ENT`,
      inquiryId: inq.id,
      guestProfileId: gp.id,
      useType: "LEISURE",
      status: "ACTIVE",
      currentStage: "S7",
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestCount: 2,
      adultCount: 2,
      numberOfRooms: rooms.length,
      contactPersonName: "Early Leaver",
      contactPersonPhone: "+97517000099",
      createdBy: staff.id,
      keysIssuedAt: checkIn,
      keysIssuedCount: rooms.length,
      keysIssuedBy: staff.id,
      registrationCompletedAt: checkIn,
      registrationCompletedBy: staff.id,
    },
  });
  const seg = await prisma.segment.create({ data: { id: `${P}SEG`, entryId: entry.id, segmentNumber: 1, stage: "S7", createdBy: staff.id } });
  await prisma.committedHold.create({
    data: {
      id: `${P}CH`, entryId: entry.id, segmentId: seg.id, roomId: room.id, roomTypeId: room.roomTypeId, state: "CONFIRMED",
      placedBy: staff.id, ttlSeconds: 86_400, expiresAt: checkOut,
      perNightBreakdown: [{ date: iso(checkIn), roomIds: rooms.map((r) => ({ roomId: r.id })) }] as Prisma.InputJsonValue,
    },
  });
  await prisma.reservation.create({
    data: {
      id: `${P}RES`, entryId: entry.id, segmentId: seg.id,
      frozenRate: new Prisma.Decimal(RATE), frozenRatePlanId: ratePlan?.id ?? `${P}PLAN`,
      frozenBillingModel: "GUEST_PAY", frozenCheckInDate: checkIn, frozenCheckOutDate: checkOut,
      frozenGuestCount: 2, confirmedAt: checkIn, confirmedBy: staff.id,
    },
  });
  await prisma.entry.update({ where: { id: entry.id }, data: { currentReservationId: `${P}RES` } });
  await prisma.folio.create({
    data: { id: `${P}FOL`, entryId: entry.id, state: "LIVE", billingModel: "GUEST_PAY", createdBy: staff.id, convertedToLiveAt: checkIn, convertedBy: staff.id, outstandingBalance: new Prisma.Decimal(0) },
  });
  for (const [i, r] of rooms.entries()) {
    await prisma.roomAssignment.create({
      data: {
        id: `${P}RA${i === 0 ? "" : i + 1}`, entryId: entry.id, roomId: r.id, assignedBy: staff.id, startDate: checkIn, endDate: checkOut,
        occupantCount: 2, adultCount: 2, frozenSubtotal: subtotal, frozenTotal: total, keyIssuedAt: checkIn, keyIssuedBy: staff.id,
      } as Prisma.RoomAssignmentUncheckedCreateInput,
    });
    await prisma.room.update({ where: { id: r.id }, data: { currentClaimState: "OCCUPIED" } });
  }
  // In-house from NOW as far as the hotel's audits know (2026-09-18): the fixture did not exist
  // when any earlier night was audited, so those nights are exactly a late check-in's — running
  // the night again catches them up. Stamped with the check-in date, an already-audited night
  // could never be charged and settlement refused the stay.
  await prisma.stageDwellRecord.create({ data: { entryId: entry.id, stage: "S7", enteredAt: new Date() } });
  console.log(`created ${entry.id} in room${rooms.length > 1 ? "s" : ""} ${rooms.map((r) => r.roomNumber).join(", ")} — now run the night audit for ${SLEPT > 0 ? `${iso(checkIn)} … ${iso(dayStart(-1))}` : "(no slept nights)"}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
