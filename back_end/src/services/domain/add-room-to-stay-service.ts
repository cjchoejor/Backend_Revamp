import type { PrismaClient } from "@prisma/client";
import { FolioState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceMayApprove, readApprovalRoles } from "../../lib/approval-roles.js";
import { effectiveCheckOutDate, hotelTodayUtc, listNightYmdsUtc, ymdUtc } from "../../lib/stay-dates.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
import { describeRoomHolders } from "./room-holders-service.js";
import { changeRoomToNewSegment, listRoomStandingForNights } from "./room-change-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

/**
 * Rooms added to a stay on its check-in day (2026-11-26, operator: "add rooms can only be done during
 * the first check in date so that user can add rooms from check in date to check out like the other
 * rooms in the booking, or else it'll be another different booking").
 *
 * On the check-in day nothing is slept yet, so the new rooms join THE BOOKING ITSELF for every night of
 * the stay: the party grows, the rooms are priced on the negotiation table the desk filled in, and the
 * booking walks the governed room-change journey with the rooms added — a new pass, the quotation made
 * again (the old one replaced), the proforma and the voucher made again and held for the desk, the
 * reservation frozen again, back to Stay with the new rooms occupied, a row each, and the departments
 * told. Tonight is charged for them at once (it was posted at check-in for the others).
 *
 * On any later day a room with new guests is a booking of its own (the nights before were not theirs).
 * Who may add is the admin console's (approvals.roomAdd.roles; the GM and admins as built).
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const fmtDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

async function loadStay(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      reservation: true,
      folio: { select: { id: true, state: true } },
      roomAssignments: { select: { roomId: true, startDate: true, endDate: true } },
      earlyDeparture: { select: { id: true } },
      roomDepartures: { select: { id: true, roomNumber: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

function refusalOf(entry: Awaited<ReturnType<typeof loadStay>>, today: Date): string | null {
  if (entry.status !== "ACTIVE") return `This booking is ${entry.status.toLowerCase()} — a room is added to a live stay`;
  if (entry.currentStage !== Stage.S7) return "A room is added while the guests are in house (at Stay) — before that, change the booking's rooms with Change booking";
  if (!entry.folio || entry.folio.state !== FolioState.LIVE) return "The bill is not open";
  if (!entry.checkInDate) return "This booking has no check-in date";
  const ci = ymdUtc(entry.checkInDate);
  if (ymdUtc(today) !== ci) {
    return `A room joins this booking only on its check-in day (${fmtDay(ci)}), holding the same nights as the other rooms — today it would be a booking of its own: start a new booking for the new guests`;
  }
  if (entry.earlyDeparture) return "This booking is recorded to leave early — a room is not added to it";
  return null;
}

/** The rooms of the house over the stay's nights, which can be added, and the party as it stands. */
export async function previewAddRoom(prisma: PrismaClient, entryId: string, actorLevel: string) {
  const entry = await loadStay(prisma, entryId);
  const today = hotelTodayUtc();
  const refusal = refusalOf(entry, today);
  const roles = await readApprovalRoles(prisma, "ROOM_ADD");
  const end = effectiveCheckOutDate(entry);
  const checkIn = entry.checkInDate ? ymdUtc(entry.checkInDate) : null;
  const checkOut = end ? ymdUtc(end) : null;
  const nights = entry.checkInDate && end ? listNightYmdsUtc(entry.checkInDate, end) : [];
  const base = {
    checkIn,
    checkOut,
    nights,
    refusal,
    approvers: { may: roles.levels.includes(actorLevel as never), words: roles.words },
    party: { adults: entry.adultCount ?? 0, childAges: entry.childAges ?? [] },
  };
  if (refusal || !nights.length || !entry.checkInDate || !end) return { ...base, rooms: [], serviceChargeRate: null, gstRate: null };

  const mine = new Set(entry.roomAssignments.map((a) => a.roomId));
  const standing = (await listRoomStandingForNights(prisma, { entryId, nights })).filter((r) => !mine.has(r.roomId));
  const all = await prisma.room.findMany({
    where: { id: { in: standing.map((r) => r.roomId) } },
    select: { id: true, physicalState: true, currentClaimState: true, roomType: { select: { maxCapacity: true, maxExtraBeds: true, maxChildren: true } } },
  });
  const physical = new Map(all.map((r) => [r.id, r]));
  const takenIds = standing.filter((r) => r.availability === "RESERVED" || r.availability === "HELD").map((r) => r.roomId);
  const holders = await describeRoomHolders(prisma, {
    roomIds: takenIds,
    checkIn: entry.checkInDate,
    checkOut: end,
    excludeEntryId: entryId,
    avoidRoomIds: mine,
  }).catch(() => new Map());
  const oneOfEach = new Map<string, string>();
  for (const r of standing) if (!oneOfEach.has(r.roomTypeId)) oneOfEach.set(r.roomTypeId, r.roomId);
  const ref = await buildEntryRateReference(prisma, entryId, { planRoomIds: [...oneOfEach.values()] }).catch(() => null);
  const rateOf = (typeId: string) => ref?.roomTypes.find((t) => t.roomTypeId === typeId)?.roomRate ?? null;

  const rooms = standing
    .map((r) => {
      const p = physical.get(r.roomId);
      const dirty = !!p && (p.physicalState !== "AVAILABLE_CLEAN" || String(p.currentClaimState).startsWith("DEPARTED"));
      const free = r.availability === "FREE";
      const why = !free
        ? r.availability === "BLOCKED"
          ? `Out of service${r.blockedReason ? ` — ${r.blockedReason}` : ""}`
          : r.availability === "MAINTENANCE"
            ? "Under maintenance on these nights"
            : null
        : dirty
          ? "Not cleaned since the last guest — mark it clean on Housekeeping first"
          : null;
      return {
        roomId: r.roomId,
        roomNumber: r.roomNumber,
        roomTypeId: r.roomTypeId,
        roomTypeName: r.roomTypeName,
        bedType: r.bedType,
        maxCapacity: p?.roomType?.maxCapacity ?? null,
        maxExtraBeds: p?.roomType?.maxExtraBeds ?? null,
        maxChildren: p?.roomType?.maxChildren ?? null,
        availability: r.availability,
        perNight: r.perNight.map((n) => ({ date: n.date, status: n.status, guest: n.claimedBy?.guestName ?? null, bookingRef: n.claimedBy?.bookingRef ?? null })),
        selectable: free && !dirty,
        why,
        needsCleaning: dirty,
        // Only a booking whose guest has not arrived can be moved out of the way (2026-11-26, operator:
        // "if those rooms are just reserved and the guest hasn't arrived yet").
        holders: ((holders.get(r.roomId) ?? []) as Array<{ stage: string; swappable: boolean; why: string | null }>).map((h) =>
          ["S6", "S7", "S8", "S9"].includes(h.stage) ? { ...h, swappable: false, why: "The guest is in the room" } : h,
        ) as Array<{
          entryId: string;
          bookingRef: string | null;
          guestName: string | null;
          partyName: string | null;
          stage: string;
          status: string;
          checkIn: string | null;
          checkOut: string | null;
          nightsInRoom: string[];
          swappable: boolean;
          why: string | null;
          rooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; sameType: boolean }>;
        }>,
        roomRate: rateOf(r.roomTypeId),
      };
    })
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  return { ...base, rooms, serviceChargeRate: ref?.serviceChargeRate ?? null, gstRate: ref?.gstRate ?? null };
}

export type AddRoomsInput = {
  roomIds: string[];
  /** The new guests: adults, and each child's age. */
  adults: number;
  childAges: number[];
  /** The negotiation table's rows for the NEW rooms only — the booking's own rooms carry as they are. */
  roomCompositions: RoomCompositionServiceInput[];
  reason?: string | null;
};

/** The rooms join the booking for the whole stay, priced on the desk's table. */
export async function addRoomsToStay(prisma: PrismaClient, actor: Actor, entryId: string, input: AddRoomsInput) {
  await enforceMayApprove(prisma, "ROOM_ADD", actor.actorLevel);
  const entry = await loadStay(prisma, entryId);
  const today = hotelTodayUtc();
  const refusal = refusalOf(entry, today);
  if (refusal) throw new ValidationError(refusal);
  const roomIds = Array.from(new Set((input.roomIds ?? []).map((x) => x.trim()).filter(Boolean)));
  if (!roomIds.length) throw new ValidationError("Pick the room to add");
  const adults = Math.trunc(Number(input.adults ?? 0));
  const childAges = (input.childAges ?? []).map((a) => Math.trunc(Number(a)));
  if (!Number.isFinite(adults) || adults < 0) throw new ValidationError("The adults are a number");
  if (childAges.some((a) => !Number.isFinite(a) || a < 0 || a > 17)) throw new ValidationError("A child's age is 0 to 17");
  if (adults + childAges.length < roomIds.length) throw new ValidationError("Each room added needs a guest in it — add the guests who will sleep there");

  // The table's rows: exactly the rooms added, each with somebody in it, and adding up to the new guests.
  const rows = input.roomCompositions ?? [];
  const rowIds = rows.map((r) => r.roomId);
  if (rowIds.length !== roomIds.length || roomIds.some((id) => !rowIds.includes(id))) {
    throw new ValidationError("The table must have a row for each room added, and only those");
  }
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const youngMax = bundle?.ageBands.youngChildMaxAge ?? 5;
  const childMax = bundle?.ageBands.childMaxAge ?? 10;
  const want = {
    adults: adults + childAges.filter((a) => a > childMax).length,
    c6to10: childAges.filter((a) => a > youngMax && a <= childMax).length,
    under6: childAges.filter((a) => a <= youngMax).length,
  };
  const got = {
    adults: rows.reduce((s, r) => s + (r.adultCount ?? 0), 0),
    c6to10: rows.reduce((s, r) => s + (r.cnb6To10Count ?? 0), 0),
    under6: rows.reduce((s, r) => s + (r.cnbUnder6Count ?? 0), 0),
  };
  if (got.adults !== want.adults || got.c6to10 !== want.c6to10 || got.under6 !== want.under6) {
    throw new ValidationError(
      `The table seats ${got.adults} adult(s), ${got.c6to10} child(ren) 6–10 and ${got.under6} under 6, but the new guests are ${want.adults}, ${want.c6to10} and ${want.under6} — seat every new guest in the new rooms`,
    );
  }
  const addedRooms = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, roomNumber: true, roomType: { select: { maxCapacity: true, maxExtraBeds: true, maxChildren: true } } },
  });
  const numberOf = new Map(addedRooms.map((r) => [r.id, r.roomNumber]));
  // What the rooms sleep (2026-11-26, operator: "it shouldn't allow more than the max occupant"): guests
  // aged 11 and over count against each room's beds and its extra beds, children under 11 against its
  // children. The whole and each room alike.
  const sleeps = (t: { maxCapacity: number; maxExtraBeds: number } | null) => (t ? t.maxCapacity + t.maxExtraBeds : 0);
  const sleepsAll = addedRooms.reduce((n, r) => n + sleeps(r.roomType), 0);
  const kidsAll = addedRooms.reduce((n, r) => n + (r.roomType?.maxChildren ?? 0), 0);
  const word = addedRooms.length === 1 ? `Room ${addedRooms[0].roomNumber}` : `Rooms ${addedRooms.map((r) => r.roomNumber).join(", ")}`;
  if (want.adults > sleepsAll) {
    throw new ValidationError(
      `${word} sleep${addedRooms.length === 1 ? "s" : ""} at most ${sleepsAll} guest${sleepsAll === 1 ? "" : "s"} aged 11 and over (extra beds included) — ${want.adults} were asked for`,
    );
  }
  if (want.c6to10 + want.under6 > kidsAll) {
    throw new ValidationError(`${word} take${addedRooms.length === 1 ? "s" : ""} at most ${kidsAll} child${kidsAll === 1 ? "" : "ren"} under 11 — ${want.c6to10 + want.under6} were asked for`);
  }
  for (const r of rows) {
    if ((r.adultCount ?? 0) + (r.cnb6To10Count ?? 0) + (r.cnbUnder6Count ?? 0) < 1) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId) ?? "?"} has nobody in it — seat a guest there, or take the room off`);
    }
    const t = addedRooms.find((x) => x.id === r.roomId)?.roomType ?? null;
    if (t && (r.adultCount ?? 0) > sleeps(t)) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId)} sleeps at most ${sleeps(t)} guests aged 11 and over (extra beds included)`);
    }
    if (t && (r.cnb6To10Count ?? 0) + (r.cnbUnder6Count ?? 0) > t.maxChildren) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId)} takes at most ${t.maxChildren} child${t.maxChildren === 1 ? "" : "ren"} under 11`);
    }
  }

  // The whole party must still be a party the hotel takes (unaccompanied minors, the hotel's beds).
  const party = {
    adultCount: (entry.adultCount ?? 0) + adults,
    childCount: (entry.childAges ?? []).length + childAges.length,
    childAges: [...(entry.childAges ?? []), ...childAges],
    guestCount: (entry.adultCount ?? 0) + adults + (entry.childAges ?? []).length + childAges.length,
  };
  const inUse = new Set(entry.roomAssignments.filter((a) => !a.endDate || a.endDate.getTime() > today.getTime()).map((a) => a.roomId));
  const cap = await validateCapacity(prisma, { adults: party.adultCount, childAges: party.childAges, numberOfRooms: inUse.size + roomIds.length } as never);
  const blocking = cap.issues.filter((i) => i.severity === "BLOCK");
  if (blocking.length) throw new ValidationError(blocking.map((i) => i.message).join(" · "));

  const anchor = [...inUse][0];
  if (!anchor) throw new ValidationError("This booking has no room in use to add to");
  const reason = input.reason?.trim() || null;
  const out = await changeRoomToNewSegment(prisma, actor, {
    entryId,
    fromRoomId: anchor,
    reason: reason ?? undefined,
    roomCompositions: rows,
    addRooms: { roomIds, party },
  });
  const added = [...numberOf.values()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  await prisma.traceEvent.create({
    data: {
      eventType: "ENTRY.ROOMS_ADDED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: Stage.S7,
      inquiryId: entry.inquiryId,
      entryId,
      payload: {
        roomIds,
        roomNumbers: added,
        guestsAdded: { adults, childAges },
        partyNow: party,
        quotationId: out.quotationId,
        pricing: out.pricing,
        reachedStage: out.walk.reachedStage,
        blocked: out.walk.blocked,
        heldPapers: out.heldDocuments,
        reason,
      },
      createdBy: actor.actorId,
    },
  });
  return { roomNumbers: added, party, outcome: out, entry: await loadEntryDetail(prisma, entryId) };
}

/** A guest's row the add-room flow wrote before the room was added, taken back when the flow is left (2026-11-26). */
export async function discardPendingGuestRows(prisma: PrismaClient, actor: Actor, entryId: string, subjectKeys: string[]) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { adultCount: true, childAges: true, guestCount: true } });
  if (!entry) throw new NotFoundError("Entry");
  const adults = Math.max(0, entry.adultCount ?? 0);
  const kids = (entry.childAges ?? []).length;
  // Only keys beyond the party as it stands — a guest of the booking is never touched here.
  const pending = subjectKeys.filter((k) => {
    const m = /^([AK])(\d+)$/.exec(k.trim());
    if (!m) return false;
    const i = Number(m[2]);
    return m[1] === "A" ? i >= adults : i >= kids;
  });
  if (!pending.length) return { discarded: 0 };
  const now = new Date();
  const details = await prisma.guestIdentityDocument.deleteMany({ where: { entryId, subjectKey: { in: pending }, storageKey: null } });
  const photos = await prisma.guestIdentityDocument.updateMany({
    where: { entryId, subjectKey: { in: pending }, storageKey: { not: null }, clearedAt: null },
    data: { clearedAt: now, clearedBy: actor.actorId },
  });
  return { discarded: details.count + photos.count };
}

