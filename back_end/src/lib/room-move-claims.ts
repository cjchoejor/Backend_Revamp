import type { Prisma, PrismaClient } from "@prisma/client";
import { foldIsoNightsToRanges } from "./entry-inventory-claim.js";

/**
 * A ROOM MOVE AS A CLAIM (2026-10-12) — the one rule every "is this room taken?" reader applies
 * while a move from the house chart is running.
 *
 * A swap cannot happen in one transaction: each booking walks the governed room-change journey
 * (new pass, silent quote, hold, re-confirmation) in its own steps. Between the two walks one room
 * is briefly claimed by both bookings, and the other by neither. This module makes that window safe
 * without weakening any gate:
 *
 *   - **Claims.** While a move is IN_PROGRESS or PARTIAL, each live leg claims its TARGET room over
 *     its nights, for everyone except its own booking. A third booking can therefore never take
 *     either room mid-swap — not the room being vacated, not the room being entered.
 *   - **Tolerance.** For a leg's OWN booking, and only that booking, a conflict is passed over when
 *     it comes from another booking's leg of the same move on a room the two are trading:
 *       · the partner is LEAVING the room this leg enters (its from-room is this leg's target), or
 *       · the partner is ENTERING a room this booking is leaving (its target is one of this
 *         booking's from-rooms) — a booking moving several rooms re-holds the ones it still sits in
 *         at every walk, and the partner's claim on such a room must not refuse that.
 *     Nothing else is tolerated: not another room, not another booking, not a finished or cancelled
 *     move.
 *
 * Read by `findRoomBookingConflicts` (the walk's pre-check and Policy 26 inside the hold),
 * `detectOverbookingForSpans` (Policy 41 inside the re-confirmation), the S1 search and the house
 * chart — so no caller has to remember to pass anything.
 */

const ACTIVE_MOVE = ["IN_PROGRESS", "PARTIAL"] as const;
/** Legs whose claim stands: not yet run, run, stopped part-way, or refused and waiting for a retry. */
const CLAIMING_LEG = new Set(["PLANNED", "DONE", "STOPPED", "REFUSED"]);

export type RoomMoveClaim = {
  moveId: string;
  legId: string;
  entryId: string;
  roomId: string;
  startDate: Date;
  endDate: Date;
  entry: { inquiryId: string | null; guestProfile: { firstName: string | null; lastName: string | null } | null };
};

export type ToleratedClaim = { entryId: string; roomId: string };

type Db = PrismaClient | Prisma.TransactionClient;

type ActiveLeg = {
  id: string;
  moveId: string;
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  nights: Prisma.JsonValue;
  status: string;
  entry: { inquiryId: string | null; guestProfile: { firstName: string | null; lastName: string | null } | null };
};

async function activeLegs(db: Db): Promise<ActiveLeg[]> {
  return db.roomMoveLeg.findMany({
    where: { move: { status: { in: [...ACTIVE_MOVE] } } },
    select: {
      id: true,
      moveId: true,
      entryId: true,
      fromRoomId: true,
      toRoomId: true,
      nights: true,
      status: true,
      entry: { select: { inquiryId: true, guestProfile: { select: { firstName: true, lastName: true } } } },
    },
  });
}

function legNights(nights: Prisma.JsonValue): string[] {
  return Array.isArray(nights) ? (nights as unknown[]).filter((n): n is string => typeof n === "string").map((n) => n.slice(0, 10)) : [];
}

/**
 * Every live leg's claim on its target room that overlaps `[checkIn, checkOut)`, except the asking
 * booking's own legs (it holds its target through its own walk).
 */
export async function roomMoveClaims(
  db: Db,
  input: { checkIn: Date; checkOut: Date; excludeEntryId?: string | null },
): Promise<RoomMoveClaim[]> {
  const out: RoomMoveClaim[] = [];
  for (const leg of await activeLegs(db)) {
    if (!CLAIMING_LEG.has(leg.status)) continue;
    if (input.excludeEntryId && leg.entryId === input.excludeEntryId) continue;
    for (const range of foldIsoNightsToRanges(legNights(leg.nights))) {
      if (range.startDate >= input.checkOut || range.endDate <= input.checkIn) continue;
      out.push({
        moveId: leg.moveId,
        legId: leg.id,
        entryId: leg.entryId,
        roomId: leg.toRoomId,
        startDate: range.startDate,
        endDate: range.endDate,
        entry: leg.entry,
      });
    }
  }
  return out;
}

/**
 * The partner claims the asking booking may pass over: for each live leg of the asking booking,
 * every OTHER booking's live leg of the same move that is leaving the room this leg enters, or is
 * entering the room this leg leaves.
 */
export async function roomMoveTolerance(db: Db, askingEntryId: string | null | undefined): Promise<ToleratedClaim[]> {
  if (!askingEntryId) return [];
  const legs = await activeLegs(db);
  const mine = legs.filter((l) => l.entryId === askingEntryId && CLAIMING_LEG.has(l.status));
  if (mine.length === 0) return [];
  const out: ToleratedClaim[] = [];
  for (const leg of mine) {
    for (const partner of legs) {
      if (partner.moveId !== leg.moveId || partner.id === leg.id) continue;
      if (partner.entryId === askingEntryId) continue;
      if (!CLAIMING_LEG.has(partner.status)) continue;
      if (partner.fromRoomId === leg.toRoomId) out.push({ entryId: partner.entryId, roomId: leg.toRoomId });
      if (partner.toRoomId === leg.fromRoomId) out.push({ entryId: partner.entryId, roomId: leg.fromRoomId });
    }
  }
  return out;
}

/** True when `{entryId, roomId}` is on the tolerated list. */
export function isTolerated(list: ToleratedClaim[], c: { entryId: string; roomId: string }): boolean {
  return list.some((t) => t.entryId === c.entryId && t.roomId === c.roomId);
}
