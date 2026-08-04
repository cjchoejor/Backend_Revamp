import type { Prisma, PrismaClient } from "@prisma/client";
import {
  reservedEntryRoomsSelect,
  roomsClaimedByReservedEntry,
  stillHoldsInventory,
} from "./entry-inventory-claim.js";

/**
 * A booking that already owns a room across some date range.
 *
 * `endDate` is the EXCLUSIVE checkout — the night before it is occupied, the day itself is
 * free. Same convention as `Reservation.frozenCheckOutDate` and the availability engine's
 * `RoomBlockage`, so back-to-back turnover (guest A out on the 5th, guest B in on the 5th)
 * is correctly NOT a conflict.
 */
export type RoomBookingConflict = {
  roomId: string;
  source: "RESERVED" | "HOLD";
  entryId: string;
  entryReferenceNumber: string | null;
  guestName: string | null;
  startDate: Date;
  endDate: Date;
};

/** "First Last", or null when the profile carries neither. */
function guestNameOf(g: { firstName?: string | null; lastName?: string | null } | null | undefined) {
  if (!g) return null;
  const combined = [g.firstName, g.lastName]
    .filter((v): v is string => !!v?.trim())
    .join(" ")
    .trim();
  return combined || null;
}

/**
 * Find every reservation / committed hold that overlaps `[checkIn, checkOut)` on any of
 * `roomIds`, excluding the booking doing the asking.
 *
 * WHY THIS EXISTS (2026-07-29)
 * ---------------------------
 * `Room.currentClaimState` is a single "right now" flag with no date dimension. Using it to
 * decide whether a room can be booked answers "is this room busy at this instant?", but the
 * question at S3 is "is this room busy on the guest's dates?" Those diverge constantly in
 * normal hotel operation — a room occupied tonight is perfectly bookable next month, and a
 * room already holding an August booking is perfectly bookable in October.
 *
 * The S1 availability engine has been date-aware since 2026-07-24 (see the long comment in
 * `availability-engine.ts` about non-FREE rooms staying in the candidate pool). The committed
 * hold gate was not, so S1 would legitimately offer a room that S3 then refused.
 *
 * The overlap predicates below deliberately MIRROR the sibling query in
 * `s1-availability-service.ts` (reservations by frozen dates, holds by entry dates + PLACED /
 * CONFIRMED + unexpired, both excluding self). Keep the two in step: if S1 offers a room, S3
 * must accept it, and vice versa. Any divergence reintroduces exactly the bug this closes.
 */
export async function findRoomBookingConflicts(
  db: PrismaClient | Prisma.TransactionClient,
  input: { roomIds: string[]; checkIn: Date; checkOut: Date; excludeEntryId: string },
): Promise<RoomBookingConflict[]> {
  if (input.roomIds.length === 0) return [];

  const roomIdSet = new Set(input.roomIds);

  const [reservations, holds] = await Promise.all([
    db.reservation.findMany({
      where: {
        frozenCheckInDate: { lt: input.checkOut },
        frozenCheckOutDate: { gt: input.checkIn },
        NOT: { entryId: input.excludeEntryId },
        // Not narrowed to entries with a matching RoomAssignment any more: a reservation made at
        // S4 has none until pre-arrival, and its rooms live on the committed hold until then.
        // `roomsClaimedByReservedEntry` resolves both, and the room filter happens below.
        entry: { ...stillHoldsInventory },
      },
      select: {
        entryId: true,
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entry: {
          select: {
            inquiryId: true,
            guestProfile: { select: { firstName: true, lastName: true } },
            ...reservedEntryRoomsSelect,
          },
        },
      },
    }),
    db.committedHold.findMany({
      where: {
        state: { in: ["PLACED", "CONFIRMED"] },
        roomId: { in: input.roomIds },
        NOT: { entryId: input.excludeEntryId },
        expiresAt: { gt: new Date() },
        entry: {
          ...stillHoldsInventory,
          checkInDate: { lt: input.checkOut },
          checkOutDate: { gt: input.checkIn },
        },
      },
      select: {
        entryId: true,
        roomId: true,
        entry: {
          select: {
            inquiryId: true,
            checkInDate: true,
            checkOutDate: true,
            guestProfile: { select: { firstName: true, lastName: true } },
          },
        },
      },
    }),
  ]);

  const conflicts: RoomBookingConflict[] = [];

  // A reservation blocks every room its entry claims — but only the ones we asked about.
  const reservedKeys = new Set<string>();
  for (const r of reservations) {
    for (const roomId of roomsClaimedByReservedEntry(r.entry)) {
      if (!roomIdSet.has(roomId)) continue;
      reservedKeys.add(`${r.entryId}:${roomId}`);
      conflicts.push({
        roomId,
        source: "RESERVED",
        entryId: r.entryId,
        entryReferenceNumber: r.entry?.inquiryId ?? null,
        guestName: guestNameOf(r.entry?.guestProfile),
        startDate: r.frozenCheckInDate,
        endDate: r.frozenCheckOutDate,
      });
    }
  }

  for (const h of holds) {
    if (!h.roomId || !h.entry?.checkInDate || !h.entry?.checkOutDate) continue;
    // A confirmed booking keeps its hold row, so the same (entry, room) can appear twice. It is
    // one conflict, and the reservation is the stronger claim — don't report it as held too.
    if (reservedKeys.has(`${h.entryId}:${h.roomId}`)) continue;
    conflicts.push({
      roomId: h.roomId,
      source: "HOLD",
      entryId: h.entryId,
      entryReferenceNumber: h.entry.inquiryId ?? null,
      guestName: guestNameOf(h.entry.guestProfile),
      startDate: h.entry.checkInDate,
      endDate: h.entry.checkOutDate,
    });
  }

  return conflicts;
}
