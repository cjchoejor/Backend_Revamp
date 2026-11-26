import type { PrismaClient } from "@prisma/client";
import { FolioState, InventoryClaimState, Stage } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { effectiveCheckOutDate, hotelTodayUtc, listNightYmdsUtc, nightsBetweenUtc, utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
import { assignRoomsFromSealedPerNight } from "./room-assignment-service.js";
import { createPieceEntry, loadSource, walkPiece, type Piece } from "./room-split-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

/**
 * A room added to a stay in house (2026-11-26, operator: "adding and removing room to be under change
 * booking itself", by the admin and GM).
 *
 * The room becomes a STAY OF ITS OWN on the same enquiry, from the day named to the booking's
 * check-out — not a row inside the booking. Why: a booking's price, seating and frozen terms say the
 * same guests sleep in its rooms every night; guests who arrive mid-stay are not on its earlier
 * nights, and writing them in would re-price and re-seat nights already slept and billed. As a stay of
 * its own the room is priced on the enquiry's package, held, reserved with its voucher held for the
 * desk, and opened at Arrival with the room handed out — the desk then checks the new guests in as any
 * arrival (their ID, the key). The trip's bill on Billing reads both stays as one; each settles its own.
 *
 * Removing a room is a room leaving early (`rooms-leaving-early-service`).
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
type MealPlan = "EP" | "CP" | "MAPL" | "MAPD" | "AP";

const fmtDay = (ymd: string) =>
  new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

async function loadStay(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      reservation: true,
      folio: { select: { id: true, state: true } },
      roomAssignments: { select: { roomId: true } },
      earlyDeparture: { select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

function stayWindow(entry: Awaited<ReturnType<typeof loadStay>>, startDate?: string | null) {
  const today = hotelTodayUtc();
  const end = effectiveCheckOutDate(entry);
  const parsed = startDate ? new Date(startDate) : null;
  if (parsed && Number.isNaN(parsed.getTime())) throw new ValidationError("The first night must be a date");
  const start = parsed ? utcDateOnly(parsed) : today;
  return { today, start, end };
}

function refusalOf(entry: Awaited<ReturnType<typeof loadStay>>, start: Date, end: Date | null, today: Date): string | null {
  if (entry.status !== "ACTIVE") return `This booking is ${entry.status.toLowerCase()} — a room is added to a live stay`;
  if (entry.currentStage !== Stage.S7) return "A room is added while the guests are in house (at Stay) — before that, change the booking's rooms with Change booking";
  if (!entry.folio || entry.folio.state !== FolioState.LIVE) return "The bill is not open";
  if (!end) return "This booking has no check-out date";
  if (start.getTime() < today.getTime()) return "The first night can't be before today";
  if (start.getTime() >= end.getTime()) return `The first night must be before the booking's check-out (${fmtDay(ymdUtc(end))})`;
  return null;
}

/** The rooms free from the first night to the booking's check-out, by type, with the rates they'd be priced at. */
export async function previewAddRoom(prisma: PrismaClient, entryId: string, input: { startDate?: string | null }) {
  const entry = await loadStay(prisma, entryId);
  const { today, start, end } = stayWindow(entry, input.startDate);
  const refusal = refusalOf(entry, start, end, today);
  const base = {
    startDate: ymdUtc(start),
    endDate: end ? ymdUtc(end) : null,
    nights: end ? Math.max(0, nightsBetweenUtc(start, end)) : 0,
    requiredLevel: "L3" as const,
  };
  if (refusal || !end) return { ...base, refusal, rooms: [], types: [] };
  const mine = new Set(entry.roomAssignments.map((a) => a.roomId));
  const all = await prisma.room.findMany({
    where: { isShadowInventory: false },
    select: {
      id: true,
      roomNumber: true,
      bedType: true,
      currentClaimState: true,
      physicalState: true,
      isBlocked: true,
      isUnderMaintenance: true,
      maintenanceDeadline: true,
      roomType: { select: { id: true, name: true, maxCapacity: true, maxExtraBeds: true } },
    },
  });
  const candidates = all.filter(
    (r) =>
      !mine.has(r.id) &&
      !r.isBlocked &&
      !(r.isUnderMaintenance && r.maintenanceDeadline && r.maintenanceDeadline.getTime() >= start.getTime() && r.maintenanceDeadline.getTime() <= end.getTime()) &&
      // A guest still in it tonight (an overstay) — never offered for tonight.
      !(start.getTime() === today.getTime() && r.currentClaimState === InventoryClaimState.OCCUPIED),
  );
  const conflicts = await findRoomBookingConflicts(prisma, { roomIds: candidates.map((r) => r.id), checkIn: start, checkOut: end, excludeEntryId: entryId });
  const taken = new Set(conflicts.map((c) => c.roomId));
  const free = candidates.filter((r) => !taken.has(r.id)).sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  const oneOfEach = new Map<string, string>();
  for (const r of free) if (r.roomType && !oneOfEach.has(r.roomType.id)) oneOfEach.set(r.roomType.id, r.id);
  const ref = await buildEntryRateReference(prisma, entryId, { planRoomIds: [...oneOfEach.values()], stay: { checkIn: start, checkOut: end } }).catch(() => null);
  const types = [...oneOfEach.keys()].map((typeId) => {
    const t = ref?.roomTypes.find((x) => x.roomTypeId === typeId) ?? null;
    const any = free.find((r) => r.roomType?.id === typeId)!;
    return {
      roomTypeId: typeId,
      name: any.roomType?.name ?? "",
      freeCount: free.filter((r) => r.roomType?.id === typeId).length,
      maxCapacity: any.roomType?.maxCapacity ?? null,
      roomRate: t?.roomRate ?? null,
      packageName: t?.packageName ?? null,
      extraBedRate: t?.extraBedRate ?? null,
      breakfastRate: t?.breakfastRate ?? null,
      lunchRate: t?.lunchRate ?? null,
      dinnerRate: t?.dinnerRate ?? null,
      cpRate: t?.cpRate ?? null,
      mapLunchRate: t?.mapLunchRate ?? null,
      mapDinnerRate: t?.mapDinnerRate ?? null,
      apRate: t?.apRate ?? null,
    };
  });
  return {
    ...base,
    refusal: null,
    serviceChargeRate: ref?.serviceChargeRate ?? null,
    gstRate: ref?.gstRate ?? null,
    rooms: free.map((r) => ({
      roomId: r.id,
      roomNumber: r.roomNumber,
      roomTypeId: r.roomType?.id ?? null,
      roomTypeName: r.roomType?.name ?? null,
      bedType: r.bedType,
      /** Not cleaned since the last guest — it can be added, and is cleaned before the guests go in. */
      needsCleaning: r.physicalState !== "AVAILABLE_CLEAN" || String(r.currentClaimState).startsWith("DEPARTED"),
    })),
    types,
  };
}

export type AddRoomOutcome = {
  newEntryId: string;
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string;
  reachedStage: string;
  roomHandedOut: boolean;
  blocked: { atStep: string; message: string } | null;
  notes: string[];
  quotationId: string | null;
  quotationTotal: number | null;
  heldDocuments: Array<{ id: string; kind: string; documentId: string }>;
};

/** The room added as a stay of its own, walked to Arrival with the room handed out. GM or admin. */
export async function addRoomToStay(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { roomId: string; startDate?: string | null; adults: number; childAges: number[]; mealPlan: MealPlan; reason: string },
): Promise<AddRoomOutcome> {
  if (actor.actorLevel !== "L3" && actor.actorLevel !== "L4") throw new AuthorizationError("Adding a room to a stay in house is the GM's or an admin's");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the room is added");
  const adults = Math.trunc(Number(input.adults));
  const childAges = (input.childAges ?? []).map((a) => Math.trunc(Number(a)));
  if (!Number.isFinite(adults) || adults < 1) throw new ValidationError("At least one adult sleeps in the room");
  if (childAges.some((a) => !Number.isFinite(a) || a < 0 || a > 17)) throw new ValidationError("A child's age is 0 to 17");
  if (!["EP", "CP", "MAPL", "MAPD", "AP"].includes(input.mealPlan)) throw new ValidationError("Pick the meal plan");

  const entry = await loadStay(prisma, entryId);
  const { today, start, end } = stayWindow(entry, input.startDate);
  const refusal = refusalOf(entry, start, end, today);
  if (refusal || !end) throw new ValidationError(refusal ?? "This booking has no check-out date");
  if (entry.roomAssignments.some((a) => a.roomId === input.roomId)) throw new ValidationError("That room is already one of this booking's rooms");

  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    select: { id: true, roomNumber: true, isShadowInventory: true, isBlocked: true, currentClaimState: true, roomType: { select: { id: true, name: true } } },
  });
  if (!room || room.isShadowInventory) throw new NotFoundError("Room");
  if (room.isBlocked) throw new ValidationError(`Room ${room.roomNumber} is out of service`);
  if (start.getTime() === today.getTime() && room.currentClaimState === InventoryClaimState.OCCUPIED) {
    throw new ValidationError(`Room ${room.roomNumber} has a guest in it tonight`);
  }
  const clash = await findRoomBookingConflicts(prisma, { roomIds: [room.id], checkIn: start, checkOut: end, excludeEntryId: entryId });
  if (clash.length) {
    const c = clash[0];
    throw new ValidationError(`Room ${room.roomNumber} is taken on those nights (${c.entryId}${c.guestName ? `, ${c.guestName}` : ""}) — pick another`);
  }

  // The party must fit the room's type, the hotel's own rules (unaccompanied minors, beds).
  const cap = await validateCapacity(prisma, { roomTypeId: room.roomType?.id ?? null, adults, childAges, numberOfRooms: 1 });
  const blocking = cap.issues.filter((i) => i.severity === "BLOCK");
  if (blocking.length) throw new ValidationError(blocking.map((i) => i.message).join(" · "));

  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const youngMax = bundle?.ageBands.youngChildMaxAge ?? 5;
  const childMax = bundle?.ageBands.childMaxAge ?? 10;
  const under6 = childAges.filter((a) => a <= youngMax).length;
  const c6to10 = childAges.filter((a) => a > youngMax && a <= childMax).length;
  const adultRow = adults + childAges.filter((a) => a > childMax).length;
  const occupants = adults + childAges.length;
  const plan = (k: MealPlan) => (input.mealPlan === k ? occupants : 0);
  const composition: RoomCompositionServiceInput = {
    roomId: room.id,
    occupantCount: occupants,
    adultCount: adultRow,
    cnb6To10Count: c6to10,
    cnbUnder6Count: under6,
    extraBedCount: 0,
    mealPlanCpCount: plan("CP"),
    mealPlanMaplCount: plan("MAPL"),
    mealPlanMapdCount: plan("MAPD"),
    mealPlanApCount: plan("AP"),
  };
  const checkIn = ymdUtc(start);
  const checkOut = ymdUtc(end);
  const piece: Piece = {
    picture: listNightYmdsUtc(start, end).map((date) => ({ date, roomIds: [room.id] })),
    checkIn,
    checkOut,
    party: { adultCount: adults, childCount: childAges.length, childAges, guestCount: occupants },
    compositions: [composition],
    rooms: [{ fromRoomId: room.id, fromRoomNumber: room.roomNumber, roomId: room.id, roomNumber: room.roomNumber, priceMode: "NEW_DATES" }],
    words: `Room ${room.roomNumber}`,
    allKept: false,
    guestAgreedNote: null,
  };

  const src = await loadSource(prisma, entryId);
  const newId = await createPieceEntry(prisma, actor, src, src.inquiryId, piece);
  // The guest holds this booking over the same nights on purpose — the GM's act says so, so the
  // reservation's same-guest question (Policy 13) is answered here.
  await prisma.traceEvent.create({
    data: {
      eventType: "MULTI_BOOKING.ACKNOWLEDGED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: newId,
      operation: "ACK",
      timestamp: new Date(),
      stageContext: Stage.S1,
      inquiryId: src.inquiryId,
      entryId: newId,
      payload: { entryId: newId, note: `Room ${room.roomNumber} added to ${entryId} as a stay of its own: ${reason}`, via: "ROOM_ADDED" },
      createdBy: actor.actorId,
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "ENTRY.ROOM_ADDED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: Stage.S7,
      inquiryId: src.inquiryId,
      entryId,
      payload: { newEntryId: newId, roomId: room.id, roomNumber: room.roomNumber, checkIn, checkOut, adults, childAges, mealPlan: input.mealPlan, reason },
      createdBy: actor.actorId,
    },
  });

  const walk = await walkPiece(prisma, actor, {
    entry: src,
    stage: Stage.S5,
    target: "SAME_ENQUIRY",
    newId,
    inquiryId: src.inquiryId,
    piece,
    carriedDiscount: null,
    priorTerms: null,
    reason,
    purpose: "ADD_ROOM",
  });

  // At Arrival the room is handed out at once — it was picked by number.
  let roomHandedOut = false;
  if (walk.reachedStage === "S5") {
    try {
      await assignRoomsFromSealedPerNight(prisma, newId, actor.actorId);
      roomHandedOut = true;
    } catch (e) {
      walk.notes.push(`The room was not handed out yet: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await prisma.traceEvent.create({
    data: {
      eventType: "ENTRY.CREATED_AS_ADDED_ROOM",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: newId,
      operation: "CREATE",
      timestamp: new Date(),
      stageContext: Stage.S1,
      inquiryId: src.inquiryId,
      entryId: newId,
      payload: { addedTo: entryId, roomNumber: room.roomNumber, checkIn, checkOut, reachedStage: walk.reachedStage, blocked: walk.blocked, reason },
      createdBy: actor.actorId,
    },
  });
  const quotation = walk.quotationId ? await prisma.quotation.findUnique({ where: { id: walk.quotationId }, select: { totalAmount: true } }) : null;
  return {
    newEntryId: newId,
    roomNumber: room.roomNumber,
    checkInDate: checkIn,
    checkOutDate: checkOut,
    reachedStage: walk.reachedStage,
    roomHandedOut,
    blocked: walk.blocked,
    notes: walk.notes,
    quotationId: walk.quotationId,
    quotationTotal: quotation?.totalAmount != null ? Number(quotation.totalAmount) : null,
    heldDocuments: walk.heldDocuments,
  };
}
