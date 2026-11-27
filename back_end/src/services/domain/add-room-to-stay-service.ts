import type { PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceMayApprove, readApprovalRoles } from "../../lib/approval-roles.js";
import { addUtcDays, effectiveCheckOutDate, hotelTodayUtc, listNightYmdsUtc, utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";
import { guestDisplayName } from "../../lib/guest-display-name.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { cleanPhone } from "../../lib/phone-numbers.js";
import { personFromName } from "../../lib/person-name.js";
import { resolveCompositionBasis } from "../../lib/party-seating.js";
import { progressStageS5ToS6 } from "../../state-machines/entry-lifecycle-state-machine.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { buildEntryRateReference } from "./rate-reference-service.js";
import { describeRoomHolders } from "./room-holders-service.js";
import { changeRoomToNewSegment, listRoomStandingForNights } from "./room-change-service.js";
import { abandonPieces, loadSource, walkPiece, type Piece } from "./room-split-service.js";
import { assignRoomsFromSealedPerNight } from "./room-assignment-service.js";
import { findGuestsOnFile, sameGuestName } from "./guest-profile-service.js";
import { setEntryGuest } from "./inquiry-caller-service.js";
import { createEntry } from "./s1-entry-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

/**
 * Rooms added to a stay in house (2026-11-26 / 2026-11-27).
 *
 * On the check-in day, a room with the group's own dates JOINS THE BOOKING ITSELF (operator, 2026-11-26:
 * "add rooms can only be done during the first check in date so that user can add rooms from check in
 * date to check out like the other rooms in the booking, or else it'll be another different booking").
 * Nothing is slept yet, so the party grows for every night: the rooms are priced on the desk's table and
 * the booking walks the governed room-change journey with the rooms added — a new pass, the quotation,
 * the proforma and the voucher made again and held for the desk, back to Stay with the new rooms
 * occupied and tonight charged for them.
 *
 * Any other room is A BOOKING OF ITS OWN ON THE SAME ENQUIRY (operator, 2026-11-27, after reading how
 * Opera, Mews and Cloudbeds do it: friends who arrive on day 2, today, tomorrow or later; one room or
 * several; leaving with the group or on another day). Rooms leaving on the same day share one booking;
 * rooms leaving on different days each get their own. Each new booking is named for the friend, takes
 * the group's agency, package, payer and cancellation terms (they are the enquiry's, or copied), is
 * priced on the desk's table (a percentage off carries), held, reserved with its voucher held for the
 * desk, and taken to Arrival when its day is near — to Check-in when the guests are at the desk now. The
 * desk takes their ID, registration card and key there. The trip's bill reads the stays as one.
 *
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

type Stay = Awaited<ReturnType<typeof loadStay>>;

const STILL_IN_WHY = "The guest is still in the room past their check-out day — they leave before anyone goes in";
const LEAVING_TODAY_WHY = "The guest checks out today — the room is free once they leave and it is cleaned";
/** How a booking holding a night stands, in the desk's words. */
function nightState(status: string, stage: string | null): string {
  if (status === "FREE") return "Free";
  if (status === "BLOCKED") return "Out of service";
  if (status === "MAINTENANCE") return "Maintenance";
  const byStage: Record<string, string> = { S1: "Picked", S2: "Held", S3: "Held", S4: "Reserved", S5: "Arriving", S6: "Checking in", S7: "In house", S8: "Checking out" };
  return (stage && byStage[stage]) || (status === "HELD" ? "Held" : "Reserved");
}

function refusalOf(entry: Stay): string | null {
  if (entry.status !== "ACTIVE") return `This booking is ${entry.status.toLowerCase()} — a room is added to a live stay`;
  if (entry.currentStage !== Stage.S7) return "A room is added while the guests are in house (at Stay) — before that, change the booking's rooms with Change booking";
  if (!entry.folio || entry.folio.state !== FolioState.LIVE) return "The bill is not open";
  if (!entry.checkInDate) return "This booking has no check-in date";
  if (entry.earlyDeparture) return "This booking is recorded to leave early — a room is not added to it";
  return null;
}

/** The longest a booking of its own may run from the day the new guests arrive. */
const MAX_NIGHTS = 90;
/** How far ahead friends of the group may be booked (2026-11-27: "tomorrow or later as well"). */
const MAX_DAYS_AHEAD = 365;

const parseDay = (v: string | null | undefined, label: string): Date | null => {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new ValidationError(`${label} must be a date`);
  const d = new Date(`${v.trim()}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} must be a date`);
  return utcDateOnly(d);
};

/**
 * When the new guests come and go. They arrive today or on any later day (2026-11-27, operator: "we
 * can't make a new entry with different check in date than today" — the first cut kept them inside the
 * group's stay), and leave the day after at the earliest — with the group, before it, or after it.
 */
function windowOf(entry: Stay, today: Date, arriveRaw?: string | null, leaveRaw?: string | null) {
  const groupIn = utcDateOnly(entry.checkInDate!);
  const groupOut = effectiveCheckOutDate(entry);
  const lastNight = addUtcDays(today, MAX_DAYS_AHEAD);
  const arrive = parseDay(arriveRaw, "The day they arrive") ?? today;
  // With the group when the group is still here after they come; else the night after they come.
  const leave = parseDay(leaveRaw, "The day they leave") ?? (groupOut && groupOut.getTime() > arrive.getTime() ? groupOut : addUtcDays(arrive, 1));
  let refusal: string | null = null;
  if (!groupOut) refusal = "This booking has no check-out date";
  else if (arrive.getTime() < today.getTime()) refusal = "They can't arrive before today";
  else if (arrive.getTime() > lastNight.getTime()) refusal = `A room is added up to ${MAX_DAYS_AHEAD} days ahead — they arrive by ${fmtDay(ymdUtc(lastNight))}`;
  else if (leave.getTime() <= arrive.getTime()) refusal = "They leave the day after they arrive at the earliest";
  else if (leave.getTime() > addUtcDays(arrive, MAX_NIGHTS).getTime()) refusal = `A room is added for ${MAX_NIGHTS} nights at most`;
  // On the check-in day a room with the group's own dates joins the booking itself.
  const joinsOn = ymdUtc(today) === ymdUtc(groupIn) && ymdUtc(arrive) === ymdUtc(groupIn);
  return { groupIn, groupOut, lastNight, arrive, leave, refusal, joinsOn };
}

/** The rooms the booking holds on any of these nights (a row with no dates holds the whole stay). */
function heldOn(entry: Stay, from: Date, to: Date): Set<string> {
  const out = new Set<string>();
  for (const a of entry.roomAssignments) {
    const s = a.startDate ? utcDateOnly(a.startDate).getTime() : -Infinity;
    const e = a.endDate ? utcDateOnly(a.endDate).getTime() : Infinity;
    if (s < to.getTime() && e > from.getTime()) out.add(a.roomId);
  }
  return out;
}

/**
 * The rooms of the house over the new guests' nights, which can be added, and the party as it stands.
 * `arrive` and `leave` default to today and the group's check-out.
 */
export async function previewAddRoom(prisma: PrismaClient, entryId: string, actorLevel: string, input: { arrive?: string | null; leave?: string | null } = {}) {
  const entry = await loadStay(prisma, entryId);
  const today = hotelTodayUtc();
  const roles = await readApprovalRoles(prisma, "ROOM_ADD");
  const own = refusalOf(entry);
  const w = own ? null : windowOf(entry, today, input.arrive, input.leave);
  const refusal = own;
  // Dates that cannot be are said where they are typed, not in place of the form.
  const datesWrong = w?.refusal ?? null;
  const end = effectiveCheckOutDate(entry);
  const arrive = w?.arrive ?? today;
  const leave = w?.leave ?? end ?? today;
  const nights = !refusal && !datesWrong ? listNightYmdsUtc(arrive, leave) : [];
  const windowDays = Number(await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1)) || 1;
  const base = {
    checkIn: entry.checkInDate ? ymdUtc(entry.checkInDate) : null,
    checkOut: end ? ymdUtc(end) : null,
    today: ymdUtc(today),
    arrive: ymdUtc(arrive),
    leave: ymdUtc(leave),
    /** The latest day they may arrive, and leave. */
    arriveLatest: w?.lastNight ? ymdUtc(w.lastNight) : null,
    leaveLatest: ymdUtc(addUtcDays(arrive, MAX_NIGHTS)),
    /** Rooms leaving on the group's check-out join the booking itself — only on its check-in day. */
    joinsBooking: !!w?.joinsOn,
    /** The day a booking of its own reaches Arrival (the arrival window); before that it waits at Reserve. */
    arrivalOpens: ymdUtc(addUtcDays(arrive, -windowDays)),
    nights,
    refusal,
    datesWrong,
    approvers: { may: roles.levels.includes(actorLevel as never), words: roles.words },
    party: { adults: entry.adultCount ?? 0, childAges: entry.childAges ?? [] },
  };
  if (refusal || datesWrong || !nights.length || !end) return { ...base, rooms: [], serviceChargeRate: null, gstRate: null };

  const mine = heldOn(entry, arrive, leave);
  const arrivesToday = ymdUtc(arrive) === ymdUtc(today);
  const standing = (await listRoomStandingForNights(prisma, { entryId, nights })).filter((r) => !mine.has(r.roomId));
  const all = await prisma.room.findMany({
    where: { id: { in: standing.map((r) => r.roomId) } },
    select: { id: true, physicalState: true, currentClaimState: true, roomType: { select: { maxCapacity: true, maxExtraBeds: true, maxChildren: true } } },
  });
  const physical = new Map(all.map((r) => [r.id, r]));
  const takenIds = standing.filter((r) => r.availability === "RESERVED" || r.availability === "HELD").map((r) => r.roomId);
  const holders = await describeRoomHolders(prisma, {
    roomIds: takenIds,
    checkIn: arrive,
    checkOut: leave,
    excludeEntryId: entryId,
    avoidRoomIds: mine,
  }).catch(() => new Map());
  // Who is still in a room tonight past their check-out day — the dates no longer show them (2026-11-27).
  const stillInIds = arrivesToday ? all.filter((r) => r.currentClaimState === "OCCUPIED").map((r) => r.id) : [];
  const inRoomRows = stillInIds.length
    ? await prisma.roomAssignment.findMany({
        where: { roomId: { in: stillInIds }, entry: { status: "ACTIVE", currentStage: { in: [Stage.S6, Stage.S7, Stage.S8] } } },
        orderBy: { createdAt: "desc" },
        select: {
          roomId: true,
          entry: {
            select: {
              id: true,
              currentStage: true,
              status: true,
              checkInDate: true,
              checkOutDate: true,
              guestProfile: { select: { title: true, firstName: true, lastName: true } },
              inquiry: { select: { travelAgent: { select: { displayName: true } }, corporateAccount: { select: { displayName: true } } } },
            },
          },
        },
      })
    : [];
  const stillInBy = new Map<string, (typeof inRoomRows)[number]["entry"]>();
  for (const row of inRoomRows) if (!stillInBy.has(row.roomId)) stillInBy.set(row.roomId, row.entry);
  const oneOfEach = new Map<string, string>();
  for (const r of standing) if (!oneOfEach.has(r.roomTypeId)) oneOfEach.set(r.roomTypeId, r.roomId);
  const ref = await buildEntryRateReference(prisma, entryId, { planRoomIds: [...oneOfEach.values()], stay: { checkIn: arrive, checkOut: leave } }).catch(() => null);
  /**
   * The bookings in a room's way: those holding it on these nights — only one whose guest has not
   * arrived can be moved (2026-11-26, operator: "if those rooms are just reserved and the guest hasn't
   * arrived yet") — and, for tonight, a guest still in it past their check-out day.
   */
  const holdersOf = (roomId: string) => {
    const list = ((holders.get(roomId) ?? []) as Array<Record<string, unknown> & { stage: string }>).map((h) =>
      ["S6", "S7", "S8", "S9"].includes(h.stage) ? { ...h, swappable: false, why: "The guest is in the room — their booking can't be moved" } : h,
    ) as unknown as Array<{
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
    }>;
    const e = stillInBy.get(roomId);
    if (e && !list.some((h) => h.entryId === e.id)) {
      list.unshift({
        entryId: e.id,
        bookingRef: e.id,
        guestName: e.guestProfile ? guestDisplayName(e.guestProfile) : null,
        partyName: e.inquiry?.travelAgent?.displayName ?? e.inquiry?.corporateAccount?.displayName ?? null,
        stage: e.currentStage,
        status: e.status,
        checkIn: e.checkInDate ? ymdUtc(e.checkInDate) : null,
        checkOut: e.checkOutDate ? ymdUtc(e.checkOutDate) : null,
        nightsInRoom: [ymdUtc(today)],
        swappable: false,
        why: e.checkOutDate && ymdUtc(e.checkOutDate) === ymdUtc(today) ? LEAVING_TODAY_WHY : STILL_IN_WHY,
        rooms: [],
      });
    }
    return list;
  };
  const rateOf = (typeId: string) => ref?.roomTypes.find((t) => t.roomTypeId === typeId)?.roomRate ?? null;

  type Holder = {
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
  };
  const rooms = standing
    .map((r) => {
      const p = physical.get(r.roomId);
      // A room to clean matters only to guests going in today; it is cleaned before a later arrival.
      const dirty = arrivesToday && !!p && (p.physicalState !== "AVAILABLE_CLEAN" || String(p.currentClaimState).startsWith("DEPARTED"));
      // A guest still in it tonight — one past their check-out day, whom the dates no longer show.
      const stillIn = arrivesToday && p?.currentClaimState === "OCCUPIED";
      // Free from the first night: the guests may stay until its next guest comes (2026-11-27), so a
      // room booked later in the window can still be added, leaving on that day.
      const firstTaken = r.perNight.find((n) => n.status !== "FREE")?.date ?? null;
      const freeUntil = firstTaken ?? ymdUtc(leave);
      const free = (r.availability === "FREE" || (!!firstTaken && firstTaken > ymdUtc(arrive))) && !stillIn;
      const why = stillIn
        ? "A guest is in it tonight"
        : !free
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
        // Each night says how its booking stands, and which booking it is (2026-11-27, operator: "we need a
        // tag … in the dates itself … show the status, when user clicks on the status then it can show
        // which guest booked it").
        perNight: r.perNight.map((n) => {
          const hs = holdersOf(r.roomId);
          const still = stillIn && n.date === ymdUtc(today) ? hs.find((h) => h.why === STILL_IN_WHY || h.why === LEAVING_TODAY_WHY) : null;
          const h = still ?? hs.find((x) => x.nightsInRoom.includes(n.date)) ?? null;
          return {
            date: n.date,
            status: n.status,
            guest: h?.guestName ?? n.claimedBy?.guestName ?? null,
            bookingRef: h?.bookingRef ?? n.claimedBy?.bookingRef ?? null,
            entryId: h?.entryId ?? null,
            stage: h?.stage ?? null,
            state: still ? (still.why === LEAVING_TODAY_WHY ? "Leaving today" : "Still in") : nightState(n.status, h?.stage ?? null),
          };
        }),
        selectable: free && !dirty,
        why: why ?? (free && firstTaken ? `Free until ${fmtDay(firstTaken)} — then it is another guest's` : null),
        needsCleaning: dirty,
        /** The last day these guests may leave it: the day its next guest comes, else the day asked. */
        freeUntil,
        holders: holdersOf(r.roomId),
        roomRate: rateOf(r.roomTypeId),
      };
    })
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  return { ...base, rooms, serviceChargeRate: ref?.serviceChargeRate ?? null, gstRate: ref?.gstRate ?? null };
}

/** One group of rooms the desk adds: the rooms leaving on one day, with their guests and their table. */
export type AddRoomsStayInput = {
  /** The day they leave ("YYYY-MM-DD"); the group's check-out when left out. */
  checkOut?: string | null;
  roomIds: string[];
  /** The new guests: adults, and each child's age. */
  adults: number;
  childAges: number[];
  /** The negotiation table's rows for these rooms only. */
  roomCompositions: RoomCompositionServiceInput[];
  /** Whom a booking of its own is for — the friend. Not asked of rooms that join the booking. */
  guest?: { title?: string | null; name: string; phone?: string | null } | null;
};

export type AddRoomsInput = {
  /** The day they arrive ("YYYY-MM-DD"); today when left out. */
  arrive?: string | null;
  /** They are at the desk now — their booking is taken to Check-in (arriving today only). */
  hereNow?: boolean;
  stays?: AddRoomsStayInput[];
  /** The older single form: the rooms with the group's dates. */
  roomIds?: string[];
  adults?: number;
  childAges?: number[];
  roomCompositions?: RoomCompositionServiceInput[];
  reason?: string | null;
};

type AddedRoom = { id: string; roomNumber: string; roomType: { maxCapacity: number; maxExtraBeds: number; maxChildren: number } | null };

/**
 * One group's guests against its rooms and its table: exactly those rooms, each with somebody in it,
 * adding up to the guests band by band, within what each room sleeps.
 */
function checkGuests(
  stay: { roomIds: string[]; adults: number; childAges: number[]; rows: RoomCompositionServiceInput[] },
  addedRooms: AddedRoom[],
  bands: { youngMax: number; childMax: number },
) {
  const { roomIds, adults, childAges, rows } = stay;
  if (!Number.isFinite(adults) || adults < 0) throw new ValidationError("The adults are a number");
  if (childAges.some((a) => !Number.isFinite(a) || a < 0 || a > 17)) throw new ValidationError("A child's age is 0 to 17");
  if (adults + childAges.length < roomIds.length) throw new ValidationError("Each room added needs a guest in it — add the guests who will sleep there");
  const rowIds = rows.map((r) => r.roomId);
  if (rowIds.length !== roomIds.length || roomIds.some((id) => !rowIds.includes(id))) {
    throw new ValidationError("The table must have a row for each room added, and only those");
  }
  const { youngMax, childMax } = bands;
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
  const mineRooms = addedRooms.filter((r) => roomIds.includes(r.id));
  const numberOf = new Map(mineRooms.map((r) => [r.id, r.roomNumber]));
  // What the rooms sleep (2026-11-26, operator: "it shouldn't allow more than the max occupant"; "max 3
  // adults can be accommodated"): a room type's maxCapacity is its ceiling with the extra bed already in it
  // (capacity-validation-service's OVER_MAX_OCCUPANCY), so guests aged 11 and over count against it alone;
  // children under 11 against maxChildren. The whole and each room alike.
  const sleeps = (t: { maxCapacity: number } | null) => (t ? t.maxCapacity : 0);
  const sleepsAll = mineRooms.reduce((n, r) => n + sleeps(r.roomType), 0);
  const kidsAll = mineRooms.reduce((n, r) => n + (r.roomType?.maxChildren ?? 0), 0);
  const word = mineRooms.length === 1 ? `Room ${mineRooms[0].roomNumber}` : `Rooms ${mineRooms.map((r) => r.roomNumber).join(", ")}`;
  if (want.adults > sleepsAll) {
    throw new ValidationError(
      `${word} sleep${mineRooms.length === 1 ? "s" : ""} at most ${sleepsAll} guest${sleepsAll === 1 ? "" : "s"} aged 11 and over — ${want.adults} were asked for`,
    );
  }
  if (want.c6to10 + want.under6 > kidsAll) {
    throw new ValidationError(`${word} take${mineRooms.length === 1 ? "s" : ""} at most ${kidsAll} child${kidsAll === 1 ? "" : "ren"} under 11 — ${want.c6to10 + want.under6} were asked for`);
  }
  for (const r of rows) {
    if ((r.adultCount ?? 0) + (r.cnb6To10Count ?? 0) + (r.cnbUnder6Count ?? 0) < 1) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId) ?? "?"} has nobody in it — seat a guest there, or take the room off`);
    }
    const t = mineRooms.find((x) => x.id === r.roomId)?.roomType ?? null;
    if (t && (r.adultCount ?? 0) > sleeps(t)) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId)} sleeps at most ${sleeps(t)} guests aged 11 and over`);
    }
    if (t && (r.cnb6To10Count ?? 0) + (r.cnbUnder6Count ?? 0) > t.maxChildren) {
      throw new ValidationError(`Room ${numberOf.get(r.roomId)} takes at most ${t.maxChildren} child${t.maxChildren === 1 ? "" : "ren"} under 11`);
    }
  }

  return { want, numberOf };
}

/** What the trip's other bookings were made of, for the friend's booking to start from. */
type Made = {
  entryId: string | null;
  roomNumbers: string[];
  checkIn: string;
  checkOut: string;
  guestName: string | null;
  reachedStage: string | null;
  /** At Check-in, ready for the desk to take their ID and hand over the key. */
  atCheckIn: boolean;
  blocked: { atStep: string; message: string } | null;
  notes: string[];
  heldDocuments: Array<{ id: string; kind: string; documentId: string }>;
  quotationTotal: number | null;
  failed: string | null;
};

/**
 * Rooms added to a stay in house: those with the group's own dates on its check-in day join the booking;
 * every other group of rooms (by the day they leave) is a booking of its own on the same enquiry.
 */
export async function addRoomsToStay(prisma: PrismaClient, actor: Actor, entryId: string, input: AddRoomsInput) {
  await enforceMayApprove(prisma, "ROOM_ADD", actor.actorLevel);
  const entry = await loadStay(prisma, entryId);
  const today = hotelTodayUtc();
  const own = refusalOf(entry);
  if (own) throw new ValidationError(own);
  const w = windowOf(entry, today, input.arrive);
  if (w.refusal) throw new ValidationError(w.refusal);
  const groupOutYmd = ymdUtc(w.groupOut!);
  const arriveYmd = ymdUtc(w.arrive);
  const hereNow = input.hereNow === true && arriveYmd === ymdUtc(today);
  const reason = input.reason?.trim() || null;

  // The stays asked for: the older single form is one stay with the group's dates.
  const raw: AddRoomsStayInput[] = input.stays?.length
    ? input.stays
    : [{ checkOut: null, roomIds: input.roomIds ?? [], adults: input.adults ?? 0, childAges: input.childAges ?? [], roomCompositions: input.roomCompositions ?? [] }];
  const stays = raw.map((st) => ({
    checkOut: st.checkOut?.trim() || groupOutYmd,
    roomIds: Array.from(new Set((st.roomIds ?? []).map((x) => x.trim()).filter(Boolean))),
    adults: Math.trunc(Number(st.adults ?? 0)),
    childAges: (st.childAges ?? []).map((a) => Math.trunc(Number(a))),
    rows: st.roomCompositions ?? [],
    guest: st.guest ?? null,
  }));
  if (!stays.some((st) => st.roomIds.length)) throw new ValidationError("Pick the room to add");
  const allRooms = stays.flatMap((st) => st.roomIds);
  if (new Set(allRooms).size !== allRooms.length) throw new ValidationError("A room is named twice — each room goes in one group");
  const days = stays.map((st) => st.checkOut);
  if (new Set(days).size !== days.length) throw new ValidationError("Two groups leave on the same day — rooms leaving on one day share a booking");
  for (const st of stays) {
    if (!st.roomIds.length) throw new ValidationError("A group has no room — take it off, or pick its rooms");
    const out = parseDay(st.checkOut, "The day they leave")!;
    if (out.getTime() <= w.arrive.getTime()) throw new ValidationError(`They leave the day after they arrive at the earliest — not ${fmtDay(st.checkOut)}`);
    if (out.getTime() > addUtcDays(w.arrive, MAX_NIGHTS).getTime()) throw new ValidationError(`A room is added for ${MAX_NIGHTS} nights at most`);
  }

  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const bands = { youngMax: bundle?.ageBands.youngChildMaxAge ?? 5, childMax: bundle?.ageBands.childMaxAge ?? 10 };
  const addedRooms = (await prisma.room.findMany({
    where: { id: { in: allRooms } },
    select: { id: true, roomNumber: true, roomType: { select: { maxCapacity: true, maxExtraBeds: true, maxChildren: true } } },
  })) as AddedRoom[];
  if (addedRooms.length !== allRooms.length) throw new NotFoundError("Room");
  const checked = stays.map((st) => ({ ...st, ...checkGuests(st, addedRooms, bands) }));

  // Which stay joins the booking: the group's own dates, on its check-in day.
  const joinStay = w.joinsOn ? checked.find((st) => st.checkOut === groupOutYmd) ?? null : null;
  const ownStays = checked.filter((st) => st !== joinStay);

  // ── Everything a booking of its own needs, checked before anything is made ──
  for (const st of ownStays) {
    const words = roomsWords(st.roomIds.map((id) => st.numberOf.get(id) ?? "?"));
    if (!st.guest?.name?.trim()) throw new ValidationError(`Say whom ${words} ${st.roomIds.length === 1 ? "is" : "are"} for — the booking is made in their name`);
    const person = personFromName({ title: st.guest.title ?? null, name: st.guest.name });
    if (!person.firstName) throw new ValidationError(`Say whom ${words} ${st.roomIds.length === 1 ? "is" : "are"} for`);
    const phone = cleanPhone(st.guest.phone ?? null, `${person.firstName}'s phone`);
    if (phone) {
      const onFile = await findGuestsOnFile(prisma, { phone, partial: false });
      const other = onFile.find((g) => !sameGuestName(g, person));
      if (other && !onFile.some((g) => sameGuestName(g, person))) {
        throw new ValidationError(
          `The phone ${phone} is on file for ${[other.title, other.firstName, other.lastName].filter(Boolean).join(" ")} — type that name for ${words}, or leave the phone empty`,
        );
      }
    }
    const cap = await validateCapacity(prisma, { adults: st.adults, childAges: st.childAges, numberOfRooms: st.roomIds.length } as never);
    const blocking = cap.issues.filter((i) => i.severity === "BLOCK");
    if (blocking.length) throw new ValidationError(`${words}: ${blocking.map((i) => i.message).join(" · ")}`);

    // Free on its own nights, not held by the group, and clean for guests going in today.
    const out = parseDay(st.checkOut, "The day they leave")!;
    const nights = listNightYmdsUtc(w.arrive, out);
    const held = heldOn(entry, w.arrive, out);
    const standing = await listRoomStandingForNights(prisma, { entryId, nights });
    const physical = arriveYmd === ymdUtc(today)
      ? new Map(
          (await prisma.room.findMany({ where: { id: { in: st.roomIds } }, select: { id: true, physicalState: true, currentClaimState: true } })).map((r) => [r.id, r]),
        )
      : null;
    for (const id of st.roomIds) {
      const no = st.numberOf.get(id) ?? "?";
      if (held.has(id)) throw new ValidationError(`Room ${no} is already one of this booking's rooms`);
      const r = standing.find((x) => x.roomId === id);
      if (!r || r.availability !== "FREE") {
        const taken = r?.perNight.find((n) => n.status !== "FREE");
        throw new ValidationError(
          `Room ${no} is not free on ${taken ? fmtDay(taken.date) : "those nights"}${taken?.claimedBy?.guestName ? ` (${taken.claimedBy.guestName})` : ""} — pick another, or move their booking`,
        );
      }
      const p = physical?.get(id);
      if (p?.currentClaimState === "OCCUPIED") throw new ValidationError(`Room ${no} still has a guest in it — pick another`);
      if (p && (p.physicalState !== "AVAILABLE_CLEAN" || String(p.currentClaimState).startsWith("DEPARTED"))) {
        throw new ValidationError(`Room ${no} has not been cleaned since the last guest — mark it clean on Housekeeping first`);
      }
    }
  }

  // ── 1. Rooms that join the booking ──
  let joined: { roomNumbers: string[]; party: { adultCount: number; childCount: number; childAges: number[]; guestCount: number }; outcome: Awaited<ReturnType<typeof changeRoomToNewSegment>> } | null =
    null;
  if (joinStay) {
    const { roomIds, adults, childAges, rows, numberOf } = joinStay;
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
    joined = { roomNumbers: added, party, outcome: out };
  }

  // ── 2. Bookings of their own, on the same enquiry ──
  const bookings: Made[] = [];
  if (ownStays.length) {
    const src = await loadSource(prisma, entryId);
    const basis = resolveCompositionBasis<RoomCompositionServiceInput>(src);
    const priorTerms = (basis.terms ?? null) as Record<string, unknown> | null;
    // A percentage off carries to the friends' booking; a flat amount was agreed on the group's stay.
    const priorDiscount = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountBasis?: string } | null;
    const carriedDiscount = priorDiscount?.discountPercent
      ? { discountPercent: priorDiscount.discountPercent, discountBasis: priorDiscount.discountBasis ?? "Carried from the group's booking" }
      : null;
    for (const st of ownStays) {
      bookings.push(await makeOwnBooking(prisma, actor, { entry, src, stay: st, arrive: arriveYmd, hereNow, reason, carriedDiscount, priorTerms }));
    }
    // Nothing made at all, and nothing joined: the refusal is the answer.
    if (!joined && bookings.every((b) => !b.entryId && b.failed)) throw new ValidationError(bookings[0].failed!);
    await prisma.traceEvent
      .create({
        data: {
          eventType: "ENTRY.ROOMS_ADDED_AS_BOOKINGS",
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
            arrive: arriveYmd,
            hereNow,
            bookings: bookings.map((b) => ({
              entryId: b.entryId,
              roomNumbers: b.roomNumbers,
              checkIn: b.checkIn,
              checkOut: b.checkOut,
              guestName: b.guestName,
              reachedStage: b.reachedStage,
              blocked: b.blocked,
              failed: b.failed,
            })),
            discountCarried: carriedDiscount?.discountPercent ?? null,
            reason,
          } as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        },
      })
      .catch(() => {});
  }

  return {
    // The older answer's fields, for the rooms that joined the booking.
    roomNumbers: joined?.roomNumbers ?? [],
    party: joined?.party ?? null,
    outcome: joined?.outcome ?? null,
    joined,
    bookings,
    entry: await loadEntryDetail(prisma, entryId),
  };
}

const roomsWords = (nos: string[]) => {
  const s = [...nos].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return s.length === 1 ? `Room ${s[0]}` : `Rooms ${s.join(", ")}`;
};

/**
 * One booking of its own: made on the group's enquiry in the friend's name, its rooms picked for its
 * nights, priced on the desk's table, set up with the group's payer and terms, held, reserved with its
 * voucher held, and taken to Arrival when its day is near — to Check-in when the guests are here now.
 * A step that refuses stops the walk and is named; the booking stays where it got to.
 */
async function makeOwnBooking(
  prisma: PrismaClient,
  actor: Actor,
  args: {
    entry: Stay;
    src: Awaited<ReturnType<typeof loadSource>>;
    stay: { checkOut: string; roomIds: string[]; adults: number; childAges: number[]; rows: RoomCompositionServiceInput[]; guest: AddRoomsStayInput["guest"]; numberOf: Map<string, string> };
    arrive: string;
    hereNow: boolean;
    reason: string | null;
    carriedDiscount: { discountPercent: number; discountBasis: string } | null;
    priorTerms: Record<string, unknown> | null;
  },
): Promise<Made> {
  const { entry, src, stay, arrive } = args;
  const nos = stay.roomIds.map((id) => stay.numberOf.get(id) ?? "?").sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const words = roomsWords(nos);
  const person = personFromName({ title: stay.guest?.title ?? null, name: stay.guest!.name });
  const guestName = [person.title, person.firstName, person.lastName].filter(Boolean).join(" ");
  const party = {
    adultCount: stay.adults,
    childCount: stay.childAges.length,
    childAges: stay.childAges,
    guestCount: stay.adults + stay.childAges.length,
  };
  const made: Made = {
    entryId: null,
    roomNumbers: nos,
    checkIn: arrive,
    checkOut: stay.checkOut,
    guestName,
    reachedStage: null,
    atCheckIn: false,
    blocked: null,
    notes: [],
    heldDocuments: [],
    quotationTotal: null,
    failed: null,
  };
  const nights = listNightYmdsUtc(new Date(`${arrive}T00:00:00.000Z`), new Date(`${stay.checkOut}T00:00:00.000Z`));
  const piece: Piece = {
    picture: nights.map((date) => ({ date, roomIds: stay.roomIds })),
    checkIn: arrive,
    checkOut: stay.checkOut,
    party,
    compositions: stay.rows,
    rooms: stay.roomIds.map((id) => ({ fromRoomId: id, fromRoomNumber: stay.numberOf.get(id) ?? "", roomId: id, roomNumber: stay.numberOf.get(id) ?? "", priceMode: "NEW_DATES" as const })),
    words,
    allKept: false,
    guestAgreedNote: null,
  };
  const why = args.reason ? `${words} for ${guestName}: ${args.reason}` : `${words} for ${guestName}, who joined the group`;

  // ── The booking, on the group's enquiry, in the friend's name ──
  try {
    const e = await createEntry(prisma, actor.actorId, actor.actorLevel, {
      inquiryId: src.inquiryId,
      useType: src.useType,
      checkInDate: arrive,
      checkOutDate: stay.checkOut,
      adultCount: party.adultCount,
      childCount: party.childCount,
      childAges: party.childAges,
      guestCount: party.guestCount,
      numberOfRooms: stay.roomIds.length,
      otaSource: src.otaSource ?? undefined,
    });
    made.entryId = e.id;
    if (src.ratePackageByRoomType) {
      await prisma.entry.update({ where: { id: e.id }, data: { ratePackageByRoomType: src.ratePackageByRoomType as never } });
    }
    // The friend is the guest staying and the one arriving; the group's guest and enquiry are untouched.
    await setEntryGuest(prisma, { actorId: actor.actorId, level: actor.actorLevel }, e.id, {
      mode: "NEW",
      title: person.title,
      name: stay.guest!.name,
      phone: cleanPhone(stay.guest?.phone ?? null, `${person.firstName}'s phone`),
      arrivingIsGuest: true,
      keepInquiryGuest: true,
    });
    // A friend with no number on file is reached through the group's contact.
    const now = await prisma.entry.findUniqueOrThrow({ where: { id: e.id }, select: { contactPersonPhone: true } });
    if (!now.contactPersonPhone && entry.contactPersonPhone) {
      await prisma.entry.update({ where: { id: e.id }, data: { contactPersonPhone: entry.contactPersonPhone } });
    }
  } catch (e) {
    made.failed = `${words} for ${guestName}: ${e instanceof Error ? e.message : String(e)}`;
    if (made.entryId) {
      await abandonPieces(prisma, actor, [made.entryId], made.failed);
      made.entryId = null;
    }
    return made;
  }
  const newId = made.entryId;

  // ── Walked to Arrival (Reserve when its day is further off) ──
  const walk = await walkPiece(prisma, actor, {
    entry: src,
    stage: Stage.S5,
    target: "SAME_ENQUIRY",
    newId,
    inquiryId: src.inquiryId,
    piece,
    carriedDiscount: args.carriedDiscount,
    priorTerms: args.priorTerms,
    reason: args.reason ?? `for ${guestName}, who joined the group`,
    purpose: "ADD_ROOM",
  });
  made.blocked = walk.blocked;
  made.notes = walk.notes;
  made.heldDocuments = walk.heldDocuments;
  made.reachedStage = walk.reachedStage;

  // At Arrival the rooms are handed out at once — they were picked by number.
  if (walk.reachedStage === "S5" && !walk.blocked) {
    try {
      await assignRoomsFromSealedPerNight(prisma, newId, actor.actorId);
    } catch (e) {
      made.notes.push(`The rooms were not handed out yet: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Here now: the front-desk handoff is the desk's own act, and the guests are at the desk.
    if (args.hereNow) {
      try {
        const h1 = await prisma.handoffRecord.findFirst({ where: { entryId: newId, handoffType: HandoffType.H1 }, orderBy: { createdAt: "desc" } });
        if (h1 && h1.state !== HandoffState.FULFILLED) {
          await prisma.handoffRecord.update({
            where: { id: h1.id },
            data: {
              state: HandoffState.FULFILLED,
              acceptedAt: h1.acceptedAt ?? new Date(),
              acceptedBy: h1.acceptedBy ?? actor.actorId,
              fulfilledAt: new Date(),
              fulfilledBy: actor.actorId,
              isAutoFulfilled: true,
              fulfilmentEvidence: { autoFulfilled: "ROOM_ADDED_IN_HOUSE", note: `${why}. The desk added the rooms with the guests at the desk.` } as Prisma.InputJsonValue,
            },
          });
        }
        const v = await prisma.entry.findUniqueOrThrow({ where: { id: newId }, select: { version: true } });
        await progressStageS5ToS6(prisma, newId, actor.actorId, v.version, true);
        made.atCheckIn = true;
      } catch (e) {
        made.blocked = { atStep: "ARRIVAL_TO_CHECK_IN", message: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  const after = await prisma.entry.findUniqueOrThrow({ where: { id: newId }, select: { currentStage: true } });
  made.reachedStage = String(after.currentStage);
  if (walk.quotationId) {
    const q = await prisma.quotation.findUnique({ where: { id: walk.quotationId }, select: { totalAmount: true } });
    made.quotationTotal = q?.totalAmount != null ? Number(q.totalAmount) : null;
  }
  await prisma.traceEvent
    .create({
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
        payload: {
          addedTo: entry.id,
          roomNumbers: nos,
          checkIn: arrive,
          checkOut: stay.checkOut,
          guestName,
          guests: { adults: party.adultCount, childAges: party.childAges },
          reachedStage: made.reachedStage,
          blocked: made.blocked,
          discountCarried: args.carriedDiscount?.discountPercent ?? null,
          reason: args.reason,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    })
    .catch(() => {});
  return made;
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

