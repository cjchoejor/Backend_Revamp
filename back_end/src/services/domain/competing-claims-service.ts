import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType } from "@prisma/client";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { readBookingRooms, type BookingRoom } from "../../lib/booking-rooms.js";
import { utcDateOnly } from "../../lib/stay-dates.js";
import { buildWorld, currentPassSeal, sealSelect } from "./room-placement-service.js";

/**
 * Competing claims on THIS booking's rooms and dates (2026-08-06, operator request).
 *
 * Two operators can work the same rooms for the same nights at the same moment: nothing stops
 * both from sealing a selection, generating a quotation, even reaching S3 and minting a
 * proforma — the first HARD claim (committed hold, then reservation) is what actually takes the
 * inventory, and Policy 26 enforces that race's outcome. Everything before it is paper. This
 * service surfaces the paper: which OTHER live bookings hold a quotation or a proforma invoice
 * (or already a hold/reservation) over any of the same (room, night) pairs, so the desk can say
 * "someone else is selling this room too — first committed hold wins" at the S2→S3 boundary and
 * on the Set up step, instead of the loser finding out at the hold refusal.
 *
 * Pure read — nothing persisted, no trace. Advisory only: the hard gate stays Policy 26.
 *
 * ROOMS BY TYPE (2026-10-29, operator: "three different bookings chose Standard rooms … if all of the
 * Standard rooms were just blocked by different bookings and a new booking also wants a Standard
 * room, then it can show that another booking is working on this room type and first to hold
 * wins"). A room the system chose for a booking picked by type is not that booking's room yet — it
 * moves within its type until Arrival — so two bookings' paper on the same room number is only a
 * race when BOTH chose that room by number. Otherwise the question is the TYPE: on a night of this
 * stay, do the rooms of the type nobody holds cover this booking and every other booking working
 * the type on paper? When they do, the system gives each its own room at its hold; when they do not,
 * whoever holds first takes them. And a booking that already holds its rooms is in nobody's race.
 */

export type CompetingClaimItem = {
  entryId: string;
  /** The booking's readable reference (inquiry id) for the operator. */
  reference: string | null;
  guestName: string | null;
  currentStage: string;
  /** What the competitor holds, strongest first: hard claims outrank paper. */
  kind: "RESERVED" | "COMMITTED_HOLD" | "SPECULATIVE_HOLD" | "PROFORMA_INVOICE" | "QUOTATION";
  /** QUO- / INV- id when the claim is paper; null on hard claims. */
  documentId: string | null;
  documentState: string | null;
  /** True when the paper was actually sent to a guest (dispatched PI / sent quote). */
  dispatched: boolean;
  /** The contested rooms, as room numbers — both bookings chose them by number (or hold them). */
  roomNumbers: string[];
  /** Room types the two bookings both want where there are not rooms enough for all (2026-10-29). */
  roomTypeNames: string[];
};

/** A room type short on some nights of this stay: the rooms nobody holds, and how many are wanted. */
export type CompetingTypeShort = {
  roomTypeName: string;
  /** The nights it is short, "YYYY-MM-DD". */
  nights: string[];
  /** On the tightest of them: rooms of the type nobody holds … */
  free: number;
  /** … and rooms of the type this booking and the others working it on paper want. */
  wanted: number;
};

export type CompetingClaims = {
  checkIn: string | null;
  checkOut: string | null;
  /** This booking's own sealed rooms (numbers) — the set being contested. */
  roomNumbers: string[];
  items: CompetingClaimItem[];
  /** Room types too few for everyone working them (2026-10-29). */
  typeShort: CompetingTypeShort[];
  /** This booking holds its rooms (a live committed hold or provisional block): paper cannot take them. */
  holdsItsRooms: boolean;
};

/** Enumerate stay nights [checkIn, checkOut) as ISO days, capped at a year. */
function nights(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  const cur = new Date(checkIn.getTime());
  let safety = 0;
  while (cur < checkOut && safety++ < 365) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** roomId → the nights it is claimed for, from a sealed optionSelected (per-night when present). */
function roomNightMap(opt: unknown, checkIn: Date | null, checkOut: Date | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const sealed = readOptionSelected(opt);
  if (sealed.perNight && sealed.perNight.length > 0) {
    for (const n of sealed.perNight) {
      const day = String(n.date).slice(0, 10);
      for (const id of n.roomIds) {
        const set = map.get(id) ?? new Set<string>();
        set.add(day);
        map.set(id, set);
      }
    }
    return map;
  }
  const range = checkIn && checkOut ? nights(checkIn, checkOut) : [];
  for (const id of sealed.distinctRoomIds) map.set(id, new Set(range));
  return map;
}

/** room → the nights the booking chose that room itself (by number — never moved by the system). */
function fixedNights(rooms: BookingRoom[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rooms)
    for (const n of r.nights) {
      if (!n.roomId || !n.fixed) continue;
      const set = out.get(n.roomId) ?? new Set<string>();
      set.add(n.date);
      out.set(n.roomId, set);
    }
  return out;
}

/**
 * What the placement check settles by moving rooms the system chose: this booking's own rooms it
 * would put elsewhere, and other bookings' rooms it would move (`entryId|roomId`). Null when the
 * booking does not fit, or the check cannot be asked — then nothing is left out.
 */
async function settledByQuietMoves(prisma: PrismaClient, entryId: string): Promise<{ mine: Set<string>; theirs: Set<string> } | null> {
  try {
    const { answerHouseByType } = await import("./room-placement-service.js");
    const b = (await answerHouseByType(prisma, entryId)).booking;
    if (!b || !b.fits) return null;
    const mine = new Set<string>();
    for (const r of b.rooms)
      for (const run of r.runs) if (!run.fixed && run.roomId && run.placedRoomId && run.placedRoomId !== run.roomId) mine.add(run.roomId);
    return { mine, theirs: new Set(b.moves.map((m) => `${m.entryId}|${m.fromRoomId}`)) };
  } catch {
    return null;
  }
}

export async function buildCompetingClaims(prisma: PrismaClient, entryId: string): Promise<CompetingClaims> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      checkInDate: true,
      checkOutDate: true,
      ...sealSelect,
      committedHold: { select: { state: true, expiresAt: true } },
      speculativeHolds: { where: { state: "PLACED" }, select: { expiresAt: true } },
    },
  });
  const empty: CompetingClaims = { checkIn: null, checkOut: null, roomNumbers: [], items: [], typeShort: [], holdsItsRooms: false };
  if (!entry) return empty;

  const mySeal = currentPassSeal(entry);
  const myMap = roomNightMap(mySeal, entry.checkInDate, entry.checkOutDate);
  const myRoomIds = [...myMap.keys()];
  if (myRoomIds.length === 0 || !entry.checkInDate || !entry.checkOutDate) {
    return { ...empty, checkIn: entry.checkInDate?.toISOString() ?? null, checkOut: entry.checkOutDate?.toISOString() ?? null };
  }
  const now = new Date();
  const hold = entry.committedHold;
  const holdsItsRooms =
    (!!hold && (hold.state === "CONFIRMED" || (hold.state === "PLACED" && hold.expiresAt > now))) ||
    entry.speculativeHolds.some((h) => h.expiresAt > now);

  // Rooms, their types and names — to read every booking's rooms by type.
  const roomRows = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } } });
  const typeOfRoom = new Map(roomRows.map((r) => [r.id, r.roomTypeId] as const));
  const typeNameOf = new Map(roomRows.map((r) => [r.roomTypeId, r.roomType?.name ?? "room"] as const));
  const myRooms = readBookingRooms(mySeal, { checkIn: entry.checkInDate, checkOut: entry.checkOutDate }, (id) => typeOfRoom.get(id));
  const myFixed = fixedNights(myRooms);

  // ---- Hard claims: reservations + committed/speculative holds (the real inventory) --------
  const hard = await findRoomBookingConflicts(prisma, {
    roomIds: myRoomIds,
    checkIn: entry.checkInDate,
    checkOut: entry.checkOutDate,
    excludeEntryId: entryId,
  });
  const hardByEntry = new Map<string, { kind: CompetingClaimItem["kind"]; rooms: Set<string>; ref: string | null; guest: string | null }>();
  for (const c of hard) {
    /**
     * The helper answers "overlaps the whole stay range" — too coarse for a per-night seal.
     * A hold on 205 for the 6th does NOT compete with a booking that claims 205 only on the
     * 7th (S1 showed the hold and the operator sealed around it). Keep a conflict only when
     * its span covers a night THIS booking actually claims for that room — the same
     * per-(room,night) rule selectOption and placeCommittedHold got on 2026-08-06; without it
     * the banner re-flagged exactly the rooms the partial-availability flow legitimately took.
     */
    const mine = myMap.get(c.roomId);
    if (!mine) continue;
    const touchesClaimedNight = [...mine].some((night) => {
      const t = new Date(`${night}T00:00:00.000Z`).getTime();
      return Number.isFinite(t) && t >= c.startDate.getTime() && t < c.endDate.getTime();
    });
    if (!touchesClaimedNight) continue;
    const kind: CompetingClaimItem["kind"] =
      c.source === "RESERVED" ? "RESERVED" : c.holdKind === "SPECULATIVE" ? "SPECULATIVE_HOLD" : "COMMITTED_HOLD";
    const cur = hardByEntry.get(c.entryId);
    if (cur) {
      cur.rooms.add(c.roomId);
      // Reservation outranks a hold for the same entry.
      if (kind === "RESERVED") cur.kind = "RESERVED";
    } else {
      hardByEntry.set(c.entryId, { kind, rooms: new Set([c.roomId]), ref: c.entryReferenceNumber, guest: c.guestName });
    }
  }

  // ---- Paper claims: other live bookings, still working their rooms, that hold nothing and have
  // a live quotation or proforma. A booking that holds its rooms is in nobody's race: paper cannot
  // take them, so none is listed (2026-10-29). Hard-claim entries are excluded too — the
  // hold/reservation is the stronger statement about the same booking. --------------------------
  const others = holdsItsRooms
    ? []
    : await prisma.entry.findMany({
        where: {
          id: { not: entryId, notIn: [...hardByEntry.keys()] },
          status: "ACTIVE",
          // Paper counts only while a booking is still being worked: Inquiry, Negotiation, Set up.
          // From Reserve on, its rooms stand on its hold or reservation (the hard claims above) or on
          // nothing — a no-show at Closed kept its old proforma and read as working these rooms
          // (2026-10-13).
          currentStage: { in: ["S1", "S2", "S3"] },
          checkInDate: { lt: entry.checkOutDate },
          checkOutDate: { gt: entry.checkInDate },
        },
        select: {
          id: true,
          inquiryId: true,
          currentStage: true,
          checkInDate: true,
          checkOutDate: true,
          guestProfile: { select: { firstName: true, lastName: true } },
          ...sealSelect,
          quotations: {
            where: { state: { in: ["DRAFT", "SENT", "ACCEPTED"] } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, state: true, sentAt: true },
          },
          invoices: {
            where: { invoiceType: InvoiceType.PROFORMA, state: { not: InvoiceState.SUPERSEDED }, supersededById: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, state: true, dispatchedAt: true },
          },
        },
      });

  type PaperRow = {
    entryId: string;
    ref: string | null;
    guest: string | null;
    stage: string;
    rooms: Set<string>;
    types: Set<string>;
    quote: { id: string; state: string; sentAt: Date | null } | null;
    proforma: { id: string; state: string; dispatchedAt: Date | null } | null;
  };
  const myNights = [...new Set([...myMap.values()].flatMap((set) => [...set]))].sort();
  const paper: PaperRow[] = [];
  const typeShort: CompetingTypeShort[] = [];
  if (others.length > 0) {
    // The house as it stands — who holds what — read as the holds read it.
    const world = await buildWorld(prisma, { from: utcDateOnly(entry.checkInDate), to: utcDateOnly(entry.checkOutDate), excludeEntryId: entryId });
    const holders = new Set(world.items.map((it) => it.entryId));
    // type|night → the other bookings working it on paper, and how many rooms each wants
    const wantedBy = new Map<string, Map<string, number>>();
    const rows = new Map<string, PaperRow>();
    for (const o of others) {
      const quote = o.quotations[0] ?? null;
      const proforma = o.invoices[0] ?? null;
      if (!quote && !proforma) continue; // a bare selection isn't a claim on anything yet
      if (holders.has(o.id)) continue; // its rooms stand on its own hold, counted with the house
      const theirRooms = readBookingRooms(currentPassSeal(o), { checkIn: o.checkInDate, checkOut: o.checkOutDate }, (id) => typeOfRoom.get(id));
      const theirFixed = fixedNights(theirRooms);
      // The same room, both by number, on a night of this stay: a race for that room.
      const contested = new Set<string>();
      for (const [roomId, mine] of myFixed) {
        const theirs = theirFixed.get(roomId);
        if (theirs && [...mine].some((n) => theirs.has(n))) contested.add(roomId);
      }
      for (const r of theirRooms)
        for (const n of r.nights) {
          if (!myNights.includes(n.date)) continue;
          const key = `${n.roomTypeId}|${n.date}`;
          const m = wantedBy.get(key) ?? new Map<string, number>();
          m.set(o.id, (m.get(o.id) ?? 0) + 1);
          wantedBy.set(key, m);
        }
      const guest = [o.guestProfile?.firstName, o.guestProfile?.lastName].filter(Boolean).join(" ").trim() || null;
      rows.set(o.id, { entryId: o.id, ref: o.inquiryId, guest, stage: o.currentStage, rooms: contested, types: new Set(), quote, proforma });
    }

    // The type, night by night: rooms nobody holds against everyone working it.
    const myWant = new Map<string, number>(); // type|night → this booking's rooms
    for (const r of myRooms) for (const n of r.nights) myWant.set(`${n.roomTypeId}|${n.date}`, (myWant.get(`${n.roomTypeId}|${n.date}`) ?? 0) + 1);
    const shortOf = new Map<string, CompetingTypeShort>();
    for (const [key, mine] of myWant) {
      const theirs = wantedBy.get(key);
      if (!theirs || theirs.size === 0) continue;
      const [typeId, date] = key.split("|");
      const i = world.index.get(date);
      const type = world.chart.roomTypes.find((t) => t.id === typeId);
      if (i === undefined || !type) continue;
      const usable = type.roomIds.filter((r) => !world.unusable.get(r)?.has(i)).length;
      const taken = world.items.filter((it) => it.roomTypeId === typeId && it.nights.includes(i)).length;
      const free = Math.max(0, usable - taken);
      const wanted = mine + [...theirs.values()].reduce((x, y) => x + y, 0);
      if (wanted <= free) continue;
      const name = typeNameOf.get(typeId) ?? "room";
      for (const id of theirs.keys()) rows.get(id)?.types.add(name);
      const cur = shortOf.get(typeId) ?? { roomTypeName: name, nights: [], free, wanted };
      cur.nights.push(date);
      // The tightest night speaks for the type.
      if (wanted - free > cur.wanted - cur.free) {
        cur.free = free;
        cur.wanted = wanted;
      }
      shortOf.set(typeId, cur);
    }
    for (const t of shortOf.values()) t.nights.sort();
    typeShort.push(...shortOf.values());
    for (const row of rows.values()) if (row.rooms.size > 0 || row.types.size > 0) paper.push(row);
  }

  // ---- Rooms by type (2026-10-28): a claim the system settles itself is not in the way ------
  // A room the system chose — another booking's, or this booking's own — moves within its type
  // when this booking is held, so a clash on it is no competition. Asked of the same check the
  // holds run; when this booking does not fit, every claim stays (docs/room-types-until-arrival.md).
  const settled = await settledByQuietMoves(prisma, entryId);
  if (settled) {
    const clear = (otherId: string, rooms: Set<string>) => {
      for (const r of [...rooms]) if (settled.mine.has(r) || settled.theirs.has(`${otherId}|${r}`)) rooms.delete(r);
    };
    for (const [id, h] of [...hardByEntry]) {
      clear(id, h.rooms);
      if (h.rooms.size === 0) hardByEntry.delete(id);
    }
    for (let i = paper.length - 1; i >= 0; i--) {
      clear(paper[i].entryId, paper[i].rooms);
      if (paper[i].rooms.size === 0 && paper[i].types.size === 0) paper.splice(i, 1);
    }
  }

  // ---- Resolve room numbers + assemble, strongest claims first ------------------------------
  const allRoomIds = new Set<string>(myRoomIds);
  for (const h of hardByEntry.values()) h.rooms.forEach((r) => allRoomIds.add(r));
  for (const p of paper) p.rooms.forEach((r) => allRoomIds.add(r));
  const rooms = await prisma.room.findMany({ where: { id: { in: [...allRoomIds] } }, select: { id: true, roomNumber: true } });
  const numberOf = new Map(rooms.map((r) => [r.id, r.roomNumber]));
  const toNumbers = (ids: Iterable<string>) =>
    [...ids].map((id) => numberOf.get(id) ?? id).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // Hard-claim entries were excluded from the paper query, so their stage is fetched here.
  const hardEntries = hardByEntry.size
    ? await prisma.entry.findMany({
        where: { id: { in: [...hardByEntry.keys()] } },
        select: { id: true, currentStage: true },
      })
    : [];
  const stageOf = new Map<string, string>([
    ...hardEntries.map((e) => [e.id, e.currentStage] as const),
    ...others.map((o) => [o.id, o.currentStage] as const),
  ]);
  const items: CompetingClaimItem[] = [];
  for (const [id, h] of hardByEntry) {
    items.push({
      entryId: id,
      reference: h.ref,
      guestName: h.guest,
      currentStage: stageOf.get(id) ?? "",
      kind: h.kind,
      documentId: null,
      documentState: null,
      dispatched: false,
      roomNumbers: toNumbers(h.rooms),
      roomTypeNames: [],
    });
  }
  for (const p of paper) {
    // One item per booking, its strongest paper: a proforma outranks a quotation.
    if (p.proforma) {
      items.push({
        entryId: p.entryId,
        reference: p.ref,
        guestName: p.guest,
        currentStage: p.stage,
        kind: "PROFORMA_INVOICE",
        documentId: p.proforma.id,
        documentState: p.proforma.state,
        dispatched: p.proforma.dispatchedAt != null,
        roomNumbers: toNumbers(p.rooms),
        roomTypeNames: [...p.types].sort(),
      });
    } else if (p.quote) {
      items.push({
        entryId: p.entryId,
        reference: p.ref,
        guestName: p.guest,
        currentStage: p.stage,
        kind: "QUOTATION",
        documentId: p.quote.id,
        documentState: p.quote.state,
        dispatched: p.quote.sentAt != null,
        roomNumbers: toNumbers(p.rooms),
        roomTypeNames: [...p.types].sort(),
      });
    }
  }
  const rank: Record<CompetingClaimItem["kind"], number> = {
    RESERVED: 0,
    COMMITTED_HOLD: 1,
    SPECULATIVE_HOLD: 2,
    PROFORMA_INVOICE: 3,
    QUOTATION: 4,
  };
  items.sort((a, b) => rank[a.kind] - rank[b.kind]);

  return {
    checkIn: entry.checkInDate.toISOString(),
    checkOut: entry.checkOutDate.toISOString(),
    roomNumbers: toNumbers(myRoomIds),
    items,
    typeShort,
    holdsItsRooms,
  };
}
