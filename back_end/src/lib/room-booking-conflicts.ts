import type { Prisma, PrismaClient } from "@prisma/client";
import { heldRoomIdsOf } from "./committed-hold-rooms.js";

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
        entry: { roomAssignments: { some: { roomId: { in: input.roomIds } } } },
      },
      select: {
        entryId: true,
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entry: {
          select: {
            inquiryId: true,
            guestProfile: { select: { firstName: true, lastName: true } },
            roomAssignments: { select: { roomId: true } },
          },
        },
      },
    }),
    db.committedHold.findMany({
      where: {
        // Deliberately NOT filtered on `roomId`. A multi-room hold names only its primary room
        // there; the rest live in `perNightBreakdown`. Filtering here would miss a hold that
        // covers a requested room as one of its extras — the exact blind spot that left eight
        // rooms of ENT-20260722-0001 bookable. Narrowed by date, then fanned out below.
        NOT: { entryId: input.excludeEntryId },
        // Expiry applies to PLACED holds only — a CONFIRMED hold blocks regardless of its
        // original TTL, which is never extended on confirm. Kept identical to the sibling query
        // in `s1-availability-service.ts` (see the long note there); if S1 offers a room, S3
        // must accept it, and both must refuse a room already confirmed to someone else.
        OR: [
          { state: "CONFIRMED" },
          { state: "PLACED", expiresAt: { gt: new Date() } },
        ],
        entry: {
          checkInDate: { lt: input.checkOut },
          checkOutDate: { gt: input.checkIn },
        },
      },
      select: {
        entryId: true,
        roomId: true,
        perNightBreakdown: true,
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

  // A reservation blocks every room assigned to its entry — but only the ones we asked about.
  for (const r of reservations) {
    for (const a of r.entry?.roomAssignments ?? []) {
      if (!roomIdSet.has(a.roomId)) continue;
      conflicts.push({
        roomId: a.roomId,
        source: "RESERVED",
        entryId: r.entryId,
        entryReferenceNumber: r.entry?.inquiryId ?? null,
        guestName: guestNameOf(r.entry?.guestProfile),
        startDate: r.frozenCheckInDate,
        endDate: r.frozenCheckOutDate,
      });
    }
  }

  // A hold blocks EVERY room it covers, not just its primary one. Narrow to the rooms actually
  // asked about — the query is now date-scoped, so it returns holds on unrelated rooms too.
  for (const h of holds) {
    if (!h.entry?.checkInDate || !h.entry?.checkOutDate) continue;
    for (const roomId of heldRoomIdsOf(h)) {
      if (!roomIdSet.has(roomId)) continue;
      conflicts.push({
        roomId,
        source: "HOLD",
        entryId: h.entryId,
        entryReferenceNumber: h.entry.inquiryId ?? null,
        guestName: guestNameOf(h.entry.guestProfile),
        startDate: h.entry.checkInDate,
        endDate: h.entry.checkOutDate,
      });
    }
  }

  return conflicts;
}
