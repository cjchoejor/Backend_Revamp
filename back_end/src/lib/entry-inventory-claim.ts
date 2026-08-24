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
import { EntryStatus, type Prisma, type PrismaClient } from "@prisma/client";

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
  // Early departure (2026-08-22): the day the guest actually left, when earlier than booked -
  // the Reservation row is immutable, so the entry carries the real end of the claim.
  actualCheckOutDate: true,
} as const;

type ReservedEntryRooms = {
  roomAssignments?: Array<{ roomId: string }> | null;
  committedHold?: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null } | null;
  actualCheckOutDate?: Date | null;
};

/**
 * The night a RESERVED claim really ends (exclusive): the frozen checkout, or the earlier day the
 * guest actually left (Policy 36 early departure). A shortened stay frees its unstayed nights the
 * moment the departure is recorded - not when the booking finally closes - so the S1 search and
 * the hold/conflict gates must read the claim end from here, never from the reservation alone.
 */
export function reservedClaimEndDate(
  frozenCheckOutDate: Date,
  entry: { actualCheckOutDate?: Date | null } | null | undefined,
): Date {
  const actual = entry?.actualCheckOutDate ?? null;
  return actual && actual.getTime() < frozenCheckOutDate.getTime() ? actual : frozenCheckOutDate;
}

/** One room's claim over one span of nights. `endDate` is the EXCLUSIVE checkout. */
export type ClaimSpan = { roomId: string; startDate: Date; endDate: Date };

/**
 * Fold ISO nights into contiguous `[start, exclusive-end)` ranges — a room used on nights 1
 * and 3 but not 2 must not be checked (or blocked) for night 2. Shared by every consumer that
 * turns a per-night seal into date ranges (S3 committed-hold gate, S2 speculative-hold gate),
 * so the folding rule cannot drift between them.
 */
export function foldIsoNightsToRanges(nights: Iterable<string>): Array<{ startDate: Date; endDate: Date }> {
  const ranges: Array<{ startDate: Date; endDate: Date }> = [];
  for (const iso of [...new Set(nights)].sort()) {
    const startDate = new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(startDate.getTime())) continue;
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const last = ranges[ranges.length - 1];
    if (last && last.endDate.getTime() === startDate.getTime()) last.endDate = endDate;
    else ranges.push({ startDate, endDate });
  }
  return ranges;
}

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

/**
 * Every room a hold covers: the per-night snapshot's rooms plus the primary `roomId`. Works for
 * both hold kinds — CommittedHold and (since 2026-08-06) SpeculativeHold share the breakdown
 * shape, and both must release/inspect ALL their rooms, not just the primary.
 */
export function heldRoomIds(hold: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null }): string[] {
  const ids = new Set(roomIdsFromPerNight(hold.perNightBreakdown));
  if (hold.roomId) ids.add(hold.roomId);
  return [...ids];
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

/**
 * Pending stay extensions CLAIM their extra nights (2026-08-21): a guest who asked for N more
 * nights has those nights held while the interim invoice goes out and the payment comes in
 * (`StayExtensionRequest` in REQUESTED / BILLED with a live `holdExpiresAt`, or PAID — money
 * was taken, so the claim stands until the commit). Reported as committed-hold spans by both
 * the S1 search and `findRoomBookingConflicts`, so another booking cannot take the room out
 * from under a guest who is paying for it. The requesting entry itself is excluded — its own
 * commit re-validates against everyone else.
 */
export async function pendingStayExtensionClaims(
  db: PrismaClient | Prisma.TransactionClient,
  input: { checkIn: Date; checkOut: Date; excludeEntryId?: string | null },
): Promise<
  Array<
    ClaimSpan & {
      entryId: string;
      requestId: string;
      holdExpiresAt: Date;
      entry: { inquiryId: string | null; guestProfile: { firstName: string | null; lastName: string | null } | null };
    }
  >
> {
  const now = new Date();
  const rows = await db.stayExtensionRequest.findMany({
    where: {
      ...(input.excludeEntryId ? { NOT: { entryId: input.excludeEntryId } } : {}),
      OR: [{ state: { in: ["REQUESTED", "BILLED"] }, holdExpiresAt: { gt: now } }, { state: "PAID" }],
      priorCheckOutDate: { lt: input.checkOut },
      newCheckOutDate: { gt: input.checkIn },
      entry: { ...stillHoldsInventory },
    },
    select: {
      id: true,
      entryId: true,
      extraNights: true,
      holdExpiresAt: true,
      entry: { select: { inquiryId: true, guestProfile: { select: { firstName: true, lastName: true } } } },
    },
  });
  const out: Array<
    ClaimSpan & {
      entryId: string;
      requestId: string;
      holdExpiresAt: Date;
      entry: { inquiryId: string | null; guestProfile: { firstName: string | null; lastName: string | null } | null };
    }
  > = [];
  for (const r of rows) {
    const nights = Array.isArray(r.extraNights) ? (r.extraNights as Array<{ date?: unknown; roomId?: unknown }>) : [];
    const byRoom = new Map<string, string[]>();
    for (const n of nights) {
      if (typeof n?.date !== "string" || typeof n?.roomId !== "string") continue;
      byRoom.set(n.roomId, [...(byRoom.get(n.roomId) ?? []), n.date.slice(0, 10)]);
    }
    for (const [roomId, dates] of byRoom) {
      for (const range of foldIsoNightsToRanges(dates)) {
        if (range.startDate >= input.checkOut || range.endDate <= input.checkIn) continue;
        out.push({ roomId, startDate: range.startDate, endDate: range.endDate, entryId: r.entryId, requestId: r.id, holdExpiresAt: r.holdExpiresAt, entry: r.entry });
      }
    }
  }
  return out;
}
