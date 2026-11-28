/**
 * A room that leaves the stay leaves the booking's plan from that day (2026-11-28, operator on
 * TEST-ED-LE4-ENT: "it has 4 rooms in 25, 28, 29, 30, but then 2 rooms in 26, 27 — data doesn't
 * match, this is real money").
 *
 * What went wrong: removing a room, or letting one room of a booking leave early, end-dated that
 * room's assignment row (so the night audit stopped billing it) but left the booking's PLAN as it
 * was — the sealed pick of the pass and the committed hold's night-by-night snapshot still named
 * the room on every later night. Every act that builds a new plan from the old one copied it: the
 * stay extension read Rooms 201 and 303 as still the guests' on the last night, called them
 * "taken" on the extra nights, and moved their guests — who had left two days before — into 304
 * and 701, priced for three more nights.
 *
 * So the plan follows the room out: from the day it leaves, the room is off the pick and the hold.
 * Both are rewritten in place, as the quiet moves already do (`relabelEntryRoomsTx`); the nights
 * before stay as they were. The record of the departure itself (`RoomDepartureRecord`) is what
 * tells the seating that the room's guests left with it (`roomsLeftOf`).
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { RoomLeft } from "./party-seating.js";

type Db = PrismaClient | Prisma.TransactionClient;

type NightRow = { date: string; roomIds: unknown[] };

const roomIdOf = (r: unknown): string | null =>
  typeof r === "string" ? r : typeof (r as { roomId?: unknown } | null)?.roomId === "string" ? (r as { roomId: string }).roomId : null;

function stayNights(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  const end = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  for (let t = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate()), i = 0; t < end && i < 400; t += 86_400_000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** A pick's nights, spelled out night by night (a whole-stay pick becomes the same rooms every night). */
function nightsOfPick(opt: Record<string, unknown>, nights: string[]): NightRow[] | null {
  if (Array.isArray(opt.perNight)) {
    return (opt.perNight as Array<{ date?: unknown; roomIds?: unknown }>)
      .filter((n) => typeof n?.date === "string" && Array.isArray(n.roomIds))
      .map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...(n.roomIds as unknown[])] }));
  }
  const rooms: unknown[] = Array.isArray(opt.roomIds)
    ? [...(opt.roomIds as unknown[])]
    : typeof opt.roomId === "string"
      ? [{ roomId: opt.roomId, isDeficient: opt.isDeficient === true }]
      : [];
  if (!rooms.length || !nights.length) return null;
  return nights.map((date) => ({ date, roomIds: rooms.map((r) => (typeof r === "string" ? { roomId: r, isDeficient: false } : r)) }));
}

/** The nights with the room taken off from `fromDate` on; null when the room is on none of them. */
function withoutRoomFrom(rows: NightRow[], roomId: string, fromDate: string): NightRow[] | null {
  let hit = false;
  const out = rows.map((n) => {
    if (n.date < fromDate) return n;
    const kept = n.roomIds.filter((r) => roomIdOf(r) !== roomId);
    if (kept.length !== n.roomIds.length) hit = true;
    return { ...n, roomIds: kept };
  });
  return hit ? out : null;
}

/**
 * Take the room off the booking's plan from `fromDate` (the first night it is not slept) on: the
 * newest sealed pick — the one every reader takes — and the committed hold's snapshot. Run inside
 * the transaction that end-dates the room's row. Returns what it rewrote.
 */
export async function takeRoomOffPlanTx(
  tx: Prisma.TransactionClient,
  entryId: string,
  roomId: string,
  fromDate: string,
): Promise<{ pick: boolean; hold: boolean }> {
  const entry = await tx.entry.findUnique({
    where: { id: entryId },
    select: { checkInDate: true, checkOutDate: true, reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } } },
  });
  const checkIn = entry?.reservation?.frozenCheckInDate ?? entry?.checkInDate ?? null;
  const checkOut = entry?.reservation?.frozenCheckOutDate ?? entry?.checkOutDate ?? null;
  const nights = checkIn && checkOut ? stayNights(checkIn, checkOut) : [];
  const done = { pick: false, hold: false };

  const seal = await tx.availabilityConfiguration.findFirst({
    where: { entryId, sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
    orderBy: { sealedAt: "desc" },
    select: { id: true, optionSelected: true },
  });
  const opt = seal?.optionSelected;
  if (seal && opt && typeof opt === "object" && !Array.isArray(opt)) {
    const o = opt as Record<string, unknown>;
    const rows = nightsOfPick(o, nights);
    const trimmed = rows ? withoutRoomFrom(rows, roomId, fromDate) : null;
    if (trimmed) {
      const next: Record<string, unknown> = { ...o, perNight: trimmed };
      delete next.roomIds;
      delete next.roomId;
      await tx.availabilityConfiguration.update({ where: { id: seal.id }, data: { optionSelected: next as Prisma.InputJsonValue } });
      done.pick = true;
    }
  }

  const hold = await tx.committedHold.findUnique({ where: { entryId }, select: { id: true, perNightBreakdown: true } });
  if (hold && Array.isArray(hold.perNightBreakdown)) {
    const rows = (hold.perNightBreakdown as Array<{ date?: unknown; roomIds?: unknown }>)
      .filter((n) => typeof n?.date === "string" && Array.isArray(n.roomIds))
      .map((n) => ({ ...(n as object), date: String(n.date).slice(0, 10), roomIds: [...(n.roomIds as unknown[])] })) as NightRow[];
    const trimmed = withoutRoomFrom(rows, roomId, fromDate);
    if (trimmed) {
      await tx.committedHold.update({ where: { id: hold.id }, data: { perNightBreakdown: trimmed as unknown as Prisma.InputJsonValue } });
      done.hold = true;
    }
  }
  return done;
}

/**
 * Whether a departure took guests of its own with it. A room brought back by mistake held the
 * guests of a room that had already left (2026-11-28) — taking it off takes nobody, or the same
 * guests would be counted out twice. Its record says so (`feeBasis.guestsOfItsOwn: false`).
 */
export function departureTookGuests(feeBasis: unknown): boolean {
  return (feeBasis as { guestsOfItsOwn?: unknown } | null)?.guestsOfItsOwn !== false;
}

/** The rooms that left the stay with their guests, and the first night each was not slept. */
export async function roomsLeftOf(db: Db, entryId: string): Promise<RoomLeft[]> {
  const records = await db.roomDepartureRecord.findMany({
    where: { entryId, state: { in: ["LEFT", "SCHEDULED"] } },
    select: { roomId: true, departureDate: true, feeBasis: true },
  });
  return records
    .filter((r) => departureTookGuests(r.feeBasis))
    .map((r) => ({ roomId: r.roomId, fromDate: r.departureDate.toISOString().slice(0, 10) }));
}
