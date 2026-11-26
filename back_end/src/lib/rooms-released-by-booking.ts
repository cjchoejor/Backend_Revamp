import type { Prisma, PrismaClient } from "@prisma/client";
import { InventoryClaimState } from "@prisma/client";
import { rowsAtCheckout } from "./rooms-in-use.js";
import { effectiveCheckOutDate } from "./stay-dates.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A claim state that means the guest is out of the room. */
const OUT_OF_ROOM: ReadonlySet<InventoryClaimState> = new Set([
  InventoryClaimState.DEPARTED_DIRTY,
  InventoryClaimState.DEPARTED_CLEAN,
  InventoryClaimState.FREE,
]);

export type RoomReleasedStanding = {
  roomId: string;
  roomNumber: string;
  released: boolean;
  /** BOOKING: this booking's own last claim event on the room; FLAG: no event, so the room's flag now. */
  readFrom: "BOOKING" | "FLAG";
  releasedAt: string | null;
};

export type RoomsReleasedByBooking = {
  rooms: RoomReleasedStanding[];
  allReleased: boolean;
};

/**
 * Has this booking's guest left every room it held? (2026-11-24, found on the hotel's server:
 * ENT-20261117-0005 settled on 19 Nov and released 6031 and 6032 to housekeeping, the rooms were
 * cleaned four minutes later and five other bookings have stayed in them since; the move to Closed
 * read the room's flag AS IT IS NOW, so it asked for "needs cleaning" on rooms another guest was in,
 * and the booking could never close.)
 *
 * The answer is this booking's OWN record: each room's last claim event made for this booking.
 * Settlement's physical departure, a mid-stay room change and one room leaving early all write
 * one moving the room out of OCCUPIED with this booking's id; housekeeping's clean and the next
 * guest's check-in write events of their own, so nothing another booking does can undo it. A
 * room with no event for this booking (an import, or data from before claim events) falls back
 * to the room's flag, read as the old check read it — out of the room once it reads departed.
 */
export async function readRoomsReleasedByBooking(db: Db, entryId: string): Promise<RoomsReleasedByBooking> {
  // Only events written since this booking was made: a claim event keeps its booking's number with
  // no link, so one left by an earlier booking of the same number (a test fixture reusing its id)
  // must never stand in for this stay.
  const made = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      createdAt: true,
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
    },
  });
  if (!made) return { rooms: [], allReleased: false };
  const assignments = await db.roomAssignment.findMany({
    where: { entryId },
    select: { roomId: true, startDate: true, endDate: true, room: { select: { roomNumber: true, currentClaimState: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Only the rooms the guest leaves at check-out (2026-11-26, lib/rooms-in-use.ts): a room left
  // mid-stay, or one never slept in, was left by definition — and its flag now belongs to whoever
  // came after, so reading it could only get the answer wrong.
  const byRoom = new Map<string, { roomNumber: string; flag: InventoryClaimState }>();
  for (const a of rowsAtCheckout(assignments, effectiveCheckOutDate(made))) {
    if (!a.room || byRoom.has(a.roomId)) continue;
    byRoom.set(a.roomId, { roomNumber: a.room.roomNumber, flag: a.room.currentClaimState });
  }
  const roomIds = [...byRoom.keys()];
  const events = roomIds.length
    ? await db.roomClaimStateEvent.findMany({
        where: { entryId, roomId: { in: roomIds }, createdAt: { gte: made.createdAt } },
        select: { roomId: true, toState: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const lastEvent = new Map<string, { toState: InventoryClaimState; createdAt: Date }>();
  for (const e of events) if (!lastEvent.has(e.roomId)) lastEvent.set(e.roomId, e);

  const rooms: RoomReleasedStanding[] = roomIds.map((roomId) => {
    const room = byRoom.get(roomId)!;
    const last = lastEvent.get(roomId);
    if (last) {
      const released = OUT_OF_ROOM.has(last.toState);
      return { roomId, roomNumber: room.roomNumber, released, readFrom: "BOOKING", releasedAt: released ? last.createdAt.toISOString() : null };
    }
    const released = room.flag === InventoryClaimState.DEPARTED_DIRTY || room.flag === InventoryClaimState.DEPARTED_CLEAN;
    return { roomId, roomNumber: room.roomNumber, released, readFrom: "FLAG", releasedAt: null };
  });
  rooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  return { rooms, allReleased: rooms.length > 0 && rooms.every((r) => r.released) };
}
