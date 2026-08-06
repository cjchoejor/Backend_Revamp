/**
 * Which bookings still hold inventory, and which rooms they hold.
 *
 * Shared by the two places that answer "is this room taken on these dates" — the S1 availability
 * search ([s1-availability-service.ts]) and the S3 committed-hold gate
 * ([room-booking-conflicts.ts]). Those two must never drift: if S1 offers a room, S3 has to
 * accept it. Both previously derived a reservation's rooms from `RoomAssignment` rows alone and
 * neither filtered on entry status, which produced two opposite faults (both observed on live
 * data 2026-08-04):
 *
 *  - **A confirmed booking could block nothing.** Room assignments are not created at
 *    confirmation — they arrive at pre-arrival or check-in — so a reserved entry with none
 *    contributed no blockage. Its committed hold covered the gap only until the hold's TTL
 *    lapsed; after that the rooms of a live, confirmed, in-progress booking were offered as
 *    free. ENT-20260727-0009 (S5, ACTIVE, reserved, 0 assignments, hold expired) was exactly
 *    this: invisible to search.
 *
 *  - **Finished bookings blocked forever.** With no status filter, every CLOSED / EXPIRED /
 *    CANCELLED entry kept blocking its rooms for its old dates.
 */
import { EntryStatus, type Prisma } from "@prisma/client";

/**
 * Statuses whose bookings have let go of their rooms.
 *
 * PARKED is deliberately absent: a park is a pause, not a release — the operator intends to
 * resume, and any committed hold placed before the park still stands.
 */
export const INVENTORY_RELEASED_STATUSES: EntryStatus[] = [
  EntryStatus.CANCELLED,
  EntryStatus.EXPIRED,
  EntryStatus.CLOSED,
];

/** Prisma `where` fragment restricting to entries that still hold their rooms. */
export const stillHoldsInventory = {
  status: { notIn: INVENTORY_RELEASED_STATUSES },
} satisfies Prisma.EntryWhereInput;

/** The select needed by `roomsClaimedByReservedEntry`. */
export const reservedEntryRoomsSelect = {
  roomAssignments: { select: { roomId: true } },
  committedHold: { select: { roomId: true, perNightBreakdown: true } },
} as const;

type ReservedEntryRooms = {
  roomAssignments?: Array<{ roomId: string }> | null;
  committedHold?: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null } | null;
};

/** One room's claim over one span of nights. `endDate` is the EXCLUSIVE checkout. */
export type ClaimSpan = { roomId: string; startDate: Date; endDate: Date };

/** `[{ date, roomIds: [{ roomId }] }]` → date → room ids, read defensively. */
function perNightMap(breakdown: Prisma.JsonValue | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(breakdown)) return out;
  for (const night of breakdown) {
    const date = (night as { date?: unknown })?.date;
    const rooms = (night as { roomIds?: unknown })?.roomIds;
    if (typeof date !== "string" || !Array.isArray(rooms)) continue;
    const ids: string[] = [];
    for (const r of rooms) {
      const id = typeof r === "string" ? r : (r as { roomId?: unknown })?.roomId;
      if (typeof id === "string" && id) ids.push(id);
    }
    if (ids.length > 0) out.set(date.slice(0, 10), ids);
  }
  return out;
}

/**
 * The (room, night) spans a committed hold actually covers.
 *
 * Both consumers used to emit ONE blockage — the hold's primary `roomId`, spanning the entry's
 * whole stay. That was wrong twice over (found 2026-08-06):
 *
 *  - **Wrong nights.** A hold pinning a room on two nights of a three-night stay blocked all
 *    three, so the third night was reported taken when it was free to sell.
 *  - **Wrong rooms.** A multi-room hold pins every sealed room, but only `roomId` was blocked;
 *    rooms 2..N of the hold blocked nothing at all until a reservation and its assignments
 *    existed. That is an overbooking hole on every multi-room booking sitting at S3.
 *
 * `perNightBreakdown` is the sealed per-night selection and is authoritative when present: one
 * span per (room, night). A hold without one — legacy, or a single-room hold placed before the
 * breakdown existed — falls back to the primary room across the entry's stay, which is the old
 * behaviour and the best that data supports.
 */
export function committedHoldSpans(
  hold: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null },
  stay: { checkIn: Date; checkOut: Date },
): ClaimSpan[] {
  const nights = perNightMap(hold.perNightBreakdown);
  if (nights.size > 0) {
    const spans: ClaimSpan[] = [];
    for (const [date, roomIds] of nights) {
      const start = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(start.getTime())) continue;
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      for (const roomId of roomIds) spans.push({ roomId, startDate: start, endDate: end });
    }
    if (spans.length > 0) return spans;
  }
  return hold.roomId ? [{ roomId: hold.roomId, startDate: stay.checkIn, endDate: stay.checkOut }] : [];
}

/** Distinct room ids inside a `CommittedHold.perNightBreakdown` snapshot, read defensively. */
function roomIdsFromPerNight(breakdown: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(breakdown)) return [];
  const out = new Set<string>();
  for (const night of breakdown) {
    const rooms = (night as { roomIds?: unknown })?.roomIds;
    if (!Array.isArray(rooms)) continue;
    for (const r of rooms) {
      const id = typeof r === "string" ? r : (r as { roomId?: unknown })?.roomId;
      if (typeof id === "string" && id) out.add(id);
    }
  }
  return [...out];
}

/**
 * The rooms a RESERVED entry occupies.
 *
 * Assignments are authoritative once they exist. Before that — the window between the S4 freeze
 * and pre-arrival — the committed hold is the only record of which rooms were committed, so it
 * is the fallback. Its expiry is deliberately ignored here: once a reservation exists the rooms
 * are committed by the reservation, and a lapsed hold TTL must not un-block them.
 */
export function roomsClaimedByReservedEntry(entry: ReservedEntryRooms | null | undefined): string[] {
  const assigned = (entry?.roomAssignments ?? []).map((a) => a.roomId).filter(Boolean);
  if (assigned.length > 0) return [...new Set(assigned)];
  const hold = entry?.committedHold;
  if (!hold) return [];
  const ids = new Set(roomIdsFromPerNight(hold.perNightBreakdown));
  if (hold.roomId) ids.add(hold.roomId);
  return [...ids];
}
