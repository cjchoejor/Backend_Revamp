import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Who else has a claim on a room over a given date range (2026-07-29).
 *
 * WHY THIS EXISTS — `Room.currentClaimState` is a single global flag describing the room
 * *right now*. The availability engine says so in its own comments: "a non-FREE claim state
 * means the room has an active commercial claim TODAY — but the claim ends at some point, and
 * the room becomes bookable again for future dates. `currentClaimState` is a snapshot, not a
 * per-date view."
 *
 * The engine was made date-aware on 2026-07-24, but Policy 26 (committed-hold placement) was
 * not, so the two disagreed: S1 correctly offered a room for a future stay, the operator sealed
 * it, and S3 then refused with "Room is not available for committed hold" because some *other*
 * booking's claim was still on the snapshot flag. With no room in the hotel sitting at FREE,
 * that blocked every committed hold in the system.
 *
 * This helper is the single definition of "is the room taken on these dates", so the search and
 * the guard cannot drift apart again. The query mirrors `s1-availability-service`'s blockage
 * query exactly — same two sources, same overlap test, same exclusions:
 *
 *   - **Reservation** — a confirmed stay whose frozen dates overlap the range, mapped to rooms
 *     through its entry's room assignments.
 *   - **CommittedHold** in PLACED/CONFIRMED that has not expired, whose entry's dates overlap.
 *
 * Half-open interval `[checkIn, checkOut)`: a stay ending on the 5th does not conflict with one
 * starting on the 5th, because the departing guest is gone before the arriving one checks in.
 */

export type RoomDateConflict = {
  roomId: string;
  source: "RESERVED" | "COMMITTED_HELD";
  entryId: string;
  startDate: Date | null;
  endDate: Date | null;
};

export async function findRoomDateConflicts(
  db: Db,
  input: {
    roomIds: string[];
    checkIn: Date;
    checkOut: Date;
    /** The entry asking — its own claims never conflict with itself. */
    excludeEntryId?: string;
    now?: Date;
  },
): Promise<RoomDateConflict[]> {
  const { roomIds, checkIn, checkOut } = input;
  if (roomIds.length === 0) return [];
  const now = input.now ?? new Date();
  const notSelf = input.excludeEntryId ? { NOT: { entryId: input.excludeEntryId } } : {};

  const [reservations, holds] = await Promise.all([
    db.reservation.findMany({
      where: {
        frozenCheckInDate: { lt: checkOut },
        frozenCheckOutDate: { gt: checkIn },
        ...notSelf,
      },
      select: {
        entryId: true,
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entry: { select: { roomAssignments: { select: { roomId: true } } } },
      },
    }),
    db.committedHold.findMany({
      where: {
        state: { in: ["PLACED", "CONFIRMED"] },
        roomId: { in: roomIds },
        expiresAt: { gt: now },
        ...notSelf,
        entry: { checkInDate: { lt: checkOut }, checkOutDate: { gt: checkIn } },
      },
      select: {
        roomId: true,
        entryId: true,
        entry: { select: { checkInDate: true, checkOutDate: true } },
      },
    }),
  ]);

  const wanted = new Set(roomIds);
  const out: RoomDateConflict[] = [];

  for (const r of reservations) {
    for (const a of r.entry?.roomAssignments ?? []) {
      if (!wanted.has(a.roomId)) continue;
      out.push({
        roomId: a.roomId,
        source: "RESERVED",
        entryId: r.entryId,
        startDate: r.frozenCheckInDate,
        endDate: r.frozenCheckOutDate,
      });
    }
  }
  for (const h of holds) {
    if (!h.roomId || !wanted.has(h.roomId)) continue;
    out.push({
      roomId: h.roomId,
      source: "COMMITTED_HELD",
      entryId: h.entryId,
      startDate: h.entry?.checkInDate ?? null,
      endDate: h.entry?.checkOutDate ?? null,
    });
  }
  return out;
}

/** Group conflicts by room for per-room guard messages. */
export function conflictsByRoom(conflicts: RoomDateConflict[]): Map<string, RoomDateConflict[]> {
  const map = new Map<string, RoomDateConflict[]>();
  for (const c of conflicts) {
    const list = map.get(c.roomId) ?? [];
    list.push(c);
    map.set(c.roomId, list);
  }
  return map;
}
