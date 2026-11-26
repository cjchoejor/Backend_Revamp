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
 * Options: --tag X (a second fixture beside the first) · --slept N (nights already slept, default 2) · --ahead N (nights still booked, default 4;
 *            0 = the guest checks out today, once at least one night was slept — 2026-10-30, for the Check-out and Closed steps)
 *          · --guest "First Last" (the guest's name, default Early Leaver)
 *          · --rate R (frozen NET per-night room figure, default 2000) · --room NNN (room number)
 *          · --rooms N (how many rooms, default 1 — a MULTI-room booking, added 2026-09-09 for
 *            PMS-237's one-room-leaves-early path, which by definition cannot be exercised on a
 *            single-room stay).
 *          · --stage S7|S5|S4 (2026-11-24, default S7): S5 is a booking at Arrival (its rooms handed
 *            out, no keys), S4 one at Reserve (its rooms on its pick and hold only); both start
 *            `--arrive-in D` days from the hotel's today (default 0) for `--nights N` (default 1).
 *          · --room-list 202,302 (the rooms by number, in place of picking free ones)
 *          · --agent "Bhutan INC" (booked through that travel agent).
 *          · --meal-plan CP|MAPL|MAPD|AP (2026-11-26): every guest on that plan, priced at the agency's
 *            default package (else the room rate given and no meal charge), with the meals frozen
 *            apart from the room, so the night audit posts its meal-plan line as a real booking's.
 *          · --payer package (2026-11-26, with --agent): "Package to travel agent · extras to guest" —
 *            the stay and its meals on the agency's voucher, anything posted later to the guest.
 *          Every room sleeps two adults, so the party is two a room.
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
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../src/lib/room-flag-repair.js";
import { computeQuotationCompositionTotals } from "../src/lib/room-composition.js";
import { rentForBookingRooms } from "../src/services/domain/apartment-booking-service.js";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const CLEAN = argv.includes("--clean");
const arg = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SLEPT = Math.max(0, Number(arg("--slept", "2")));
// Checking out today needs a night slept: a stay is at least one night.
const AHEAD = Math.max(SLEPT > 0 ? 0 : 1, Number(arg("--ahead", "4")));
const GUEST = arg("--guest", "Early Leaver").trim().split(/\s+/);
// The house name rule: the last word is the last name, the rest the first (lib/person-name.ts).
const GUEST_FIRST = (GUEST.length > 1 ? GUEST.slice(0, -1).join(" ") : GUEST[0]) || "Early";
const GUEST_LAST = (GUEST.length > 1 ? GUEST[GUEST.length - 1] : "") || "Leaver";
const RATE = Number(arg("--rate", "2000"));
const ROOM = arg("--room", "");
const ROOM_LIST = arg("--room-list", "").split(",").map((x) => x.trim()).filter(Boolean);
const ROOM_COUNT = ROOM_LIST.length || Math.max(1, Number(arg("--rooms", "1")));
const STAGE = (["S7", "S5", "S4"].includes(arg("--stage", "S7")) ? arg("--stage", "S7") : "S7") as "S7" | "S5" | "S4";
const IN_HOUSE = STAGE === "S7";
const ARRIVE_IN = Math.max(0, Number(arg("--arrive-in", "0")));
const NIGHTS_AHEAD = Math.max(1, Number(arg("--nights", "1")));
const AGENT = arg("--agent", "").trim();
const MEAL_PLAN = ["CP", "MAPL", "MAPD", "AP"].includes(arg("--meal-plan", "").toUpperCase()) ? arg("--meal-plan", "").toUpperCase() : "";
const PAYER_MODEL = arg("--payer", "guest") === "package" ? "TOUR_OPERATOR_VOUCHER" : "GUEST_PAY";
// --by-type seals the rooms as the system's choice by room type, as the Inquiry step does when the desk picks
// by type (2026-11-25): its papers to an agency read "Room 1", not the numbers. Without it, by number.
const BY_TYPE = argv.includes("--by-type");
// --apartment WEEKLY|MONTHLY (2026-11-25): an apartment stay let by the week or the month, its rooms
// priced by their rent through the real rent rule (lib/apartment-rent.ts), and the terms frozen on
// the reservation as Reserve freezes them, so the night audit reads what a real booking carries.
const APT_PLAN = ["WEEKLY", "MONTHLY"].includes(arg("--apartment", "").toUpperCase()) ? (arg("--apartment", "").toUpperCase() as "WEEKLY" | "MONTHLY") : null;
// --tag X seeds a SECOND fixture beside the first (ids `TEST-ED-X-…`), e.g. two in-house guests
// for a room switch (2026-10-12). Without a tag the script seeds / cleans every `TEST-ED-` row.
const TAG = arg("--tag", "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const P = TAG ? `TEST-ED-${TAG}-` : "TEST-ED-";

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
  // Every room the fixture touched — its own rows, and every room a room change or a release
  // moved its flag on (2026-10-12: freeing only the rows' rooms left 202 "needs cleaning" and 203
  // "occupied" behind after a room change, with nobody in either).
  const touched = new Set([
    ...(await prisma.roomAssignment.findMany({ where: { entryId: { in: ids } }, select: { roomId: true } })).map((r) => r.roomId),
    ...(await prisma.roomClaimStateEvent.findMany({ where: { entryId: { in: ids } }, select: { roomId: true } })).map((r) => r.roomId),
  ]);
  console.log(`removing ${ids.length} test entries and their rows`);
  if (!COMMIT) return;
  await prisma.voucherCollection.deleteMany({ where: { folioId: { in: folioIds } } });
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
  // The Set-up records the fixture now seeds, and the ones a walk adds (2026-10-06): both hold the
  // folio and the segment by FK, so the deletes below fail without them.
  await prisma.billingModelTransitionRecord.deleteMany({ where: { folioId: { in: folioIds } } });
  await prisma.cancellationDisclosureRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.folio.deleteMany({ where: { id: { in: folioIds } } });
  await prisma.committedHold.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.roomAssignment.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.stageDwellRecord.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.traceEvent.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.entry.updateMany({ where: { id: { in: ids } }, data: { currentReservationId: null } });
  await prisma.reservation.deleteMany({ where: { entryId: { in: ids } } });
  // A room change or an extension leaves a quotation and a sealed configuration on each new
  // segment; both hold the segment by FK, so clearing them has to come first (2026-10-06).
  await prisma.quotationLine.deleteMany({ where: { quotation: { entryId: { in: ids } } } });
  await prisma.quotation.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.availabilityConfiguration.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.speculativeHold.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.segment.deleteMany({ where: { entryId: { in: ids } } });
  // A walk back through Set up and Reserve seeds the pre-arrival task set (2026-10-06).
  await prisma.preArrivalTask.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.handoffRecord.deleteMany({ where: { entryId: { in: ids } } });
  // A room move records a leg per booking, and every walk files the papers it held (2026-10-12).
  // A move left with no legs is removed; one that still names another booking stays as its history.
  await prisma.heldDocument.deleteMany({ where: { entryId: { in: ids } } });
  const moveIds = [...new Set((await prisma.roomMoveLeg.findMany({ where: { entryId: { in: ids } }, select: { moveId: true } })).map((l) => l.moveId))];
  await prisma.roomMoveLeg.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.roomMove.deleteMany({ where: { id: { in: moveIds }, legs: { none: {} } } });
  // Notes, to-dos and requests typed on the fixture (2026-11-26).
  await prisma.bookingNote.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.guestRequest.deleteMany({ where: { entryId: { in: ids } } });
  await prisma.entry.deleteMany({ where: { id: { in: ids } } });
  await prisma.inquiry.deleteMany({ where: { id: { startsWith: P } } });
  // An identity check or a guest row typed on the fixture outlives the booking (its entry is set to
  // null), so the guest's own rows go before the guest (2026-11-25).
  await prisma.guestIdentityDocument.deleteMany({ where: { guestProfileId: { startsWith: P } } });
  await prisma.guestProfile.deleteMany({ where: { id: { startsWith: P } } });
  // Each touched room's flag back to what the remaining bookings say (`room-flag-repair`).
  const { today, plan } = await planRoomFlagRepairs(prisma, { roomIds: [...touched] });
  await applyRoomFlagRepairs(prisma, plan, today);
  console.log(`clean complete (${plan.map((p) => `${p.roomNumber} ${p.from}→${p.to}`).join(", ") || "no room flag to correct"})`);
}

async function main() {
  if (CLEAN) return clean();
  if (COMMIT) await clean();

  const staff = await prisma.staffUser.findFirst({ where: { actorLevel: "L4" }, select: { id: true } });
  const ratePlan = await prisma.ratePlanRegistry.findFirst({ select: { id: true } });
  if (!staff) throw new Error("no L4 staff user to own the test data");

  // In house: slept nights behind, nights ahead. Before Arrival: from the day it arrives.
  const checkIn = IN_HOUSE ? dayStart(-SLEPT) : dayStart(ARRIVE_IN);
  const checkOut = IN_HOUSE ? dayStart(AHEAD) : dayStart(ARRIVE_IN + NIGHTS_AHEAD);
  const nights = IN_HOUSE ? SLEPT + AHEAD : NIGHTS_AHEAD;
  const nightDates = Array.from({ length: nights }, (_, i) => iso(new Date(checkIn.getTime() + i * 86_400_000)));
  const party = 2 * ROOM_COUNT;
  const agent = AGENT ? await prisma.travelAgent.findFirst({ where: { displayName: AGENT, isActive: true }, select: { id: true, displayName: true } }) : null;
  if (AGENT && !agent) throw new Error(`no active travel agent named ${AGENT}`);

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
  const picked = ROOM_LIST.length
    ? (await prisma.room.findMany({ where: { roomNumber: { in: ROOM_LIST } }, select: { id: true, roomNumber: true, roomTypeId: true, currentClaimState: true } })).sort(
        (a, b) => ROOM_LIST.indexOf(a.roomNumber) - ROOM_LIST.indexOf(b.roomNumber),
      )
    : ROOM
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
  let subtotal = new Prisma.Decimal(RATE).mul(nights);
  let total = subtotal.mul(1 + sc).mul(1 + gst).toDecimalPlaces(2);
  let scAmount = subtotal.mul(sc).toDecimalPlaces(2);
  let gstAmount = total.sub(subtotal).sub(scAmount);
  // An apartment: each room priced by its rent, as the quotation prices it.
  const aptRent = APT_PLAN
    ? await rentForBookingRooms(prisma, { useType: "APARTMENT", apartmentPlan: APT_PLAN, checkInDate: checkIn, checkOutDate: checkOut }, rooms.map((r) => r.id))
    : null;
  if (APT_PLAN && aptRent && aptRent.size !== rooms.length) throw new Error("--apartment needs every room to be in an apartment (and an apartment's rooms together)");
  const aptTotals = aptRent
    ? computeQuotationCompositionTotals(
        rooms.map((r) => ({
          roomId: r.id,
          roomNumber: r.roomNumber,
          input: { rent: aptRent.get(r.id) ?? null, occupantCount: 2, adultCount: 2, extraBedCount: 0, startDate: checkIn, endDate: checkOut },
          ctx: {
            defaultRoomRate: new Prisma.Decimal(RATE),
            defaultExtraBedRate: new Prisma.Decimal(0),
            defaultBreakfastRate: new Prisma.Decimal(0),
            defaultLunchRate: new Prisma.Decimal(0),
            defaultDinnerRate: new Prisma.Decimal(0),
            serviceChargeRate: sc,
            gstRate: gst,
            nights,
          },
        })),
      )
    : null;
  // A meal plan (2026-11-26): priced at the agency's default package as the quotation prices it.
  const pkg = MEAL_PLAN && agent
    ? await prisma.ratePackage.findFirst({ where: { travelAgentId: agent.id, effectiveTo: null }, orderBy: [{ isDefault: "desc" }, { effectiveFrom: "desc" }] })
    : null;
  const mealCounts = (n: number) => ({
    mealPlanCpCount: MEAL_PLAN === "CP" ? n : 0,
    mealPlanMaplCount: MEAL_PLAN === "MAPL" ? n : 0,
    mealPlanMapdCount: MEAL_PLAN === "MAPD" ? n : 0,
    mealPlanApCount: MEAL_PLAN === "AP" ? n : 0,
  });
  const dec = (v: Prisma.Decimal | null | undefined) => (v == null ? new Prisma.Decimal(0) : new Prisma.Decimal(v));
  const roomRate = pkg ? new Prisma.Decimal(pkg.roomBaseRate) : new Prisma.Decimal(RATE);
  const mealTotals = MEAL_PLAN && !aptTotals
    ? computeQuotationCompositionTotals(
        rooms.map((r) => ({
          roomId: r.id,
          roomNumber: r.roomNumber,
          input: { occupantCount: 2, adultCount: 2, extraBedCount: 0, ...mealCounts(2), startDate: checkIn, endDate: checkOut },
          ctx: {
            defaultRoomRate: roomRate,
            defaultExtraBedRate: dec(pkg?.extraBedRate),
            defaultBreakfastRate: dec(pkg?.breakfastRate),
            defaultLunchRate: dec(pkg?.lunchRate),
            defaultDinnerRate: dec(pkg?.dinnerRate),
            defaultCpRate: pkg?.cpRate ?? null,
            defaultMapLunchRate: pkg?.mapLunchRate ?? null,
            defaultMapDinnerRate: pkg?.mapDinnerRate ?? null,
            defaultApRate: pkg?.apRate ?? null,
            serviceChargeRate: sc,
            gstRate: gst,
            nights,
          },
        })),
      )
    : null;
  const compTotals = aptTotals ?? mealTotals;
  const perRoomOf = (roomId: string) => compTotals?.perRoom.find((x) => x.roomId === roomId) ?? null;

  console.log(
    `${STAGE} test booking${agent ? ` through ${agent.displayName}` : ""}: room${rooms.length > 1 ? "s" : ""} ${rooms.map((r) => r.roomNumber).join(", ")} · stay ${iso(checkIn)} → ${iso(checkOut)} (${nights} nights${IN_HOUSE ? `, ${SLEPT} slept` : ""}) · rate ${RATE}/night net · frozen subtotal ${subtotal} / total ${total} PER ROOM`,
  );
  if (!COMMIT) return console.log("(dry run — pass --commit to write)");

  const aptTerms = () =>
    ({
      roomCompositions: rooms.map((r) => ({ roomId: r.id, occupantCount: 2, adultCount: 2, extraBedCount: 0, ...(MEAL_PLAN ? mealCounts(2) : {}) })),
      ...(pkg ? { ratePackage: { id: pkg.id, name: pkg.name } } : {}),
      compositionTotals: {
        subtotal: Number(compTotals!.subtotal.toFixed(2)),
        serviceCharge: Number(compTotals!.serviceCharge.toFixed(2)),
        gst: Number(compTotals!.gst.toFixed(2)),
        total: Number(compTotals!.total.toFixed(2)),
        perRoom: compTotals!.perRoom.map((x) => ({
          roomId: x.roomId,
          roomNumber: x.roomNumber,
          nights: x.nights,
          roomRate: Number(x.roomRate.toFixed(2)),
          subtotal: Number(x.subtotal.toFixed(2)),
          accommodationNet: Number(x.accommodationNet.toFixed(2)),
          mealsNet: Number(x.mealsNet.toFixed(2)),
          serviceCharge: Number(x.serviceCharge.toFixed(2)),
          gst: Number(x.gst.toFixed(2)),
          total: Number(x.total.toFixed(2)),
          ...(x.rent ? { rent: x.rent } : {}),
        })),
      },
    }) as Prisma.InputJsonValue;
  const gp = await prisma.guestProfile.create({ data: { id: `${P}GP`, firstName: GUEST_FIRST, lastName: GUEST_LAST, phone: "+97517000099", email: null } });
  const inq = await prisma.inquiry.create({
    data: {
      id: `${P}INQ`,
      referenceNumber: `${P}INQ`,
      guestProfileId: gp.id,
      defaultCustodianId: staff.id,
      sourceChannel: agent ? "AGENT" : "DIRECT",
      ...(agent ? { travelAgentId: agent.id, cameInAs: "TRAVEL_AGENT" } : {}),
      ...(pkg ? { ratePackageId: pkg.id, ratePackageIds: [pkg.id] } : {}),
      notes: "Seeded test booking",
    } as Prisma.InquiryUncheckedCreateInput,
  });
  const entry = await prisma.entry.create({
    data: {
      id: `${P}ENT`,
      inquiryId: inq.id,
      guestProfileId: gp.id,
      useType: APT_PLAN ? "APARTMENT" : "LEISURE",
      ...(APT_PLAN ? { apartmentPlan: APT_PLAN } : {}),
      status: "ACTIVE",
      currentStage: STAGE,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestCount: party,
      adultCount: party,
      numberOfRooms: rooms.length,
      contactPersonName: `${GUEST_FIRST} ${GUEST_LAST}`,
      contactPersonPhone: "+97517000099",
      createdBy: staff.id,
      ...(IN_HOUSE
        ? { keysIssuedAt: checkIn, keysIssuedCount: rooms.length, keysIssuedBy: staff.id, registrationCompletedAt: checkIn, registrationCompletedBy: staff.id }
        : {}),
    },
  });
  const seg = await prisma.segment.create({ data: { id: `${P}SEG`, entryId: entry.id, segmentNumber: 1, stage: STAGE, createdBy: staff.id } });
  // The rooms picked, sealed — the pick every booking carries from Inquiry (by number, the older shape;
  // with --by-type, booking rooms the system chose).
  await prisma.availabilityConfiguration.create({
    data: {
      entryId: entry.id,
      segmentId: seg.id,
      searchCriteria: { checkInDate: iso(checkIn), checkOutDate: iso(checkOut), numberOfRooms: rooms.length } as Prisma.InputJsonValue,
      resultSet: {} as Prisma.InputJsonValue,
      optionSelected: {
        perNight: nightDates.map((date) => ({ date, roomIds: rooms.map((r) => ({ roomId: r.id, isDeficient: false })) })),
        isDeficient: false,
        ...(BY_TYPE
          ? { bookingRooms: rooms.map((r, i) => ({ key: `R${i + 1}`, nights: nightDates.map((date) => ({ date, roomTypeId: r.roomTypeId, roomId: r.id, fixed: false })) })) }
          : {}),
      } as Prisma.InputJsonValue,
      sealedAt: checkIn < new Date() ? checkIn : new Date(),
      createdBy: staff.id,
    },
  });
  await prisma.committedHold.create({
    data: {
      id: `${P}CH`, entryId: entry.id, segmentId: seg.id, roomId: room.id, roomTypeId: room.roomTypeId, state: "CONFIRMED",
      placedBy: staff.id, ttlSeconds: 86_400, expiresAt: checkOut,
      perNightBreakdown: nightDates.map((date) => ({ date, roomIds: rooms.map((r) => ({ roomId: r.id })) })) as Prisma.InputJsonValue,
    },
  });
  await prisma.reservation.create({
    data: {
      id: `${P}RES`, entryId: entry.id, segmentId: seg.id,
      frozenRate: new Prisma.Decimal(RATE), frozenRatePlanId: ratePlan?.id ?? `${P}PLAN`,
      frozenBillingModel: PAYER_MODEL, frozenCheckInDate: checkIn, frozenCheckOutDate: checkOut,
      frozenGuestCount: party, confirmedAt: IN_HOUSE ? checkIn : new Date(), confirmedBy: staff.id,
      ...(compTotals ? { frozenCommercialTerms: aptTerms() } : {}),
    },
  });
  await prisma.entry.update({ where: { id: entry.id }, data: { currentReservationId: `${P}RES` } });
  // Who pays which charge — the map Set up writes (the package to the agency, extras to the guest).
  const payerMap = (PAYER_MODEL === "GUEST_PAY"
    ? { ROOM_CHARGE: "GUEST_PAY", F_AND_B: "GUEST_PAY", SERVICE: "GUEST_PAY", OTHER: "GUEST_PAY", CREDIT_NOTE: "GUEST_PAY" }
    : { ROOM_CHARGE: PAYER_MODEL, F_AND_B: "GUEST_PAY", SERVICE: "GUEST_PAY", OTHER: "GUEST_PAY", CREDIT_NOTE: "GUEST_PAY" }) as Prisma.InputJsonValue;
  await prisma.folio.create({
    data: IN_HOUSE
      ? { id: `${P}FOL`, entryId: entry.id, state: "LIVE", billingModel: PAYER_MODEL, billingModelDefaults: payerMap, createdBy: staff.id, convertedToLiveAt: checkIn, convertedBy: staff.id, outstandingBalance: new Prisma.Decimal(0) }
      : { id: `${P}FOL`, entryId: entry.id, state: "PROVISIONAL", billingModel: PAYER_MODEL, billingModelDefaults: payerMap, createdBy: staff.id, outstandingBalance: new Prisma.Decimal(0) },
  });
  // The FIXATION record, not just the folio column (2026-10-06). The S4 re-freeze reads the latest
  // BillingModelTransitionRecord — `folio.billingModel` is not what Policy 33 consults — so without
  // this a room change or an extension on the fixture walked as far as RECONFIRMATION and stopped
  // with MISSING_BILLING_MODEL, leaving the booking at Set up with the new room's figures unfrozen.
  // Every real in-house booking has one, from `ensureProvisionalFolioAndBillingModel` at Set up.
  await prisma.billingModelTransitionRecord.create({
    data: { folioId: `${P}FOL`, segmentId: `${P}SEG`, toModel: PAYER_MODEL, createdBy: staff.id, changeSource: "INITIAL_FIXATION" },
  });
  // The other two Set-up records the S4 re-freeze insists on, for the same reason: a room change
  // or an extension on this fixture re-confirms the reservation, and Policy 33/34 refuse without
  // them. A real in-house booking carries both from its own pass through Set up.
  await prisma.cancellationDisclosureRecord.create({
    data: {
      entryId: entry.id,
      segmentId: `${P}SEG`,
      noShowTreatmentStatement: "Seeded fixture — a no-show is charged the first night.",
      disclosedBy: staff.id,
    },
  });
  await prisma.invoice.create({
    data: { id: `${P}INV`, folioId: `${P}FOL`, entryId: entry.id, invoiceType: "PROFORMA", state: "DRAFT", totalAmount: compTotals ? compTotals.total : total } as Prisma.InvoiceUncheckedCreateInput,
  });
  // The PRICED BASIS (2026-10-06). Without a quotation carrying `roomCompositions`, a room change
  // or an extension re-quotes from nothing: the silent quote comes out FLAT, so the new room's
  // assignment row has nothing to freeze from and is left null — the night audit would then post
  // the ROOM rate for it, and settlement's p22 check would read a frozen basis that no longer
  // matches what was billed. Every real booking reaches Stay with one of these from Negotiation.
  await prisma.quotation.create({
    data: {
      id: `${P}QUO`,
      entryId: entry.id,
      segmentId: seg.id,
      referenceNumber: `${P}QUO`,
      createdBy: staff.id,
      state: "ACCEPTED",
      acceptedAt: IN_HOUSE ? checkIn : new Date(),
      totalAmount: compTotals ? compTotals.total : total.mul(rooms.length),
      commercialTerms: compTotals ? aptTerms() : {
        roomCompositions: rooms.map((r) => ({ roomId: r.id, occupantCount: 2, adultCount: 2, extraBedCount: 0, negotiatedRoomRate: RATE })),
        // The figures a real quotation stores (2026-10-30): net, service charge and GST beside the
        // total, and each room by its number — the booking file's price prints them.
        compositionTotals: {
          subtotal: Number(subtotal.mul(rooms.length)),
          serviceCharge: Number(scAmount.mul(rooms.length)),
          gst: Number(gstAmount.mul(rooms.length)),
          total: Number(total.mul(rooms.length)),
          perRoom: rooms.map((r) => ({
            roomId: r.id,
            roomNumber: r.roomNumber,
            roomRate: RATE,
            nights,
            subtotal: Number(subtotal),
            serviceCharge: Number(scAmount),
            gst: Number(gstAmount),
            total: Number(total),
          })),
        },
      },
    } as Prisma.QuotationUncheckedCreateInput,
  });
  for (const [i, r] of rooms.entries()) {
    // At Reserve the rooms are on the pick and the hold only; from Arrival they are handed out.
    if (STAGE !== "S4") {
      await prisma.roomAssignment.create({
        data: {
          id: `${P}RA${i === 0 ? "" : i + 1}`, entryId: entry.id, roomId: r.id, assignedBy: staff.id, startDate: checkIn, endDate: checkOut,
          occupantCount: 2, adultCount: 2,
          frozenSubtotal: perRoomOf(r.id)?.subtotal ?? subtotal,
          frozenTotal: perRoomOf(r.id)?.total ?? total,
          ...(IN_HOUSE ? { keyIssuedAt: checkIn, keyIssuedBy: staff.id } : {}),
        } as Prisma.RoomAssignmentUncheckedCreateInput,
      });
    }
    // In house the room is occupied; before that it reads confirmed — but never over another guest.
    if (IN_HOUSE) await prisma.room.update({ where: { id: r.id }, data: { currentClaimState: "OCCUPIED" } });
    else if (r.currentClaimState === "FREE") await prisma.room.update({ where: { id: r.id }, data: { currentClaimState: "CONFIRMED" } });
  }
  // In-house from NOW as far as the hotel's audits know (2026-09-18): the fixture did not exist
  // when any earlier night was audited, so those nights are exactly a late check-in's — running
  // the night again catches them up. Stamped with the check-in date, an already-audited night
  // could never be charged and settlement refused the stay.
  await prisma.stageDwellRecord.create({ data: { entryId: entry.id, stage: STAGE, enteredAt: new Date() } });
  console.log(`created ${entry.id} in room${rooms.length > 1 ? "s" : ""} ${rooms.map((r) => r.roomNumber).join(", ")} — now run the night audit for ${SLEPT > 0 ? `${iso(checkIn)} … ${iso(dayStart(-1))}` : "(no slept nights)"}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
