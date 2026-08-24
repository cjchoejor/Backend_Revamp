import type { Prisma, PrismaClient } from "@prisma/client";
import {
  committedHoldSpans,
  pendingStayExtensionClaims,
  reservedEntryRoomsSelect,
  roomsClaimedByReservedEntry,
  stillHoldsInventory,
  reservedClaimEndDate,
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
  /**
   * Which kind of hold, when `source` is HOLD. A SPECULATIVE hold (S2) is a weaker, shorter-lived
   * claim than a COMMITTED one (S3) — both block, but the operator should be able to tell them
   * apart when deciding whether it is worth asking a GM to release it.
   */
  holdKind?: "COMMITTED" | "SPECULATIVE";
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

  const [reservations, holds, speculative] = await Promise.all([
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
        // NOT narrowed by roomId: a multi-room hold pins every sealed room but names only one
        // here, so filtering on it missed rooms 2..N entirely. The room filter happens below,
        // against the spans `committedHoldSpans` resolves.
        state: { in: ["PLACED", "CONFIRMED"] },
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
    // Speculative holds (S2) are a weaker claim than a committed one, but still a claim — two
    // operators quoting different guests at the same moment must not both be able to commit the
    // same room. Mirrors the sibling query in s1-availability-service.ts. NOT narrowed by
    // roomId (2026-08-06): a multi-room hold names only its anchor there and carries the rest
    // in `perNightBreakdown` — the room filter happens below, against the resolved spans.
    db.speculativeHold.findMany({
      where: {
        state: "PLACED",
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

  // A reservation blocks every room its entry claims — but only the ones we asked about.
  const reservedKeys = new Set<string>();
  const heldKeys = new Set<string>();
  for (const r of reservations) {
    // Early departure (2026-08-22): the claim ends the day the guest actually left, so a shortened
    // stay frees its unstayed nights at once. A claim that ends before the asked window is no
    // conflict at all (the where-clause above still selects it by the frozen dates).
    const claimEnd = reservedClaimEndDate(r.frozenCheckOutDate, r.entry);
    if (claimEnd.getTime() <= input.checkIn.getTime()) continue;
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
        endDate: claimEnd,
      });
    }
  }

  for (const h of holds) {
    if (!h.entry?.checkInDate || !h.entry?.checkOutDate) continue;
    for (const span of committedHoldSpans(h, { checkIn: h.entry.checkInDate, checkOut: h.entry.checkOutDate })) {
      if (!roomIdSet.has(span.roomId)) continue;
      // Only the nights this hold actually covers overlap the requested range.
      if (span.startDate >= input.checkOut || span.endDate <= input.checkIn) continue;
      // A confirmed booking keeps its hold row, so the same (entry, room) can appear twice. It
      // is one conflict, and the reservation is the stronger claim — don't report it as held too.
      const key = `${h.entryId}:${span.roomId}`;
      if (reservedKeys.has(key) || heldKeys.has(key)) continue;
      heldKeys.add(key);
      conflicts.push({
        roomId: span.roomId,
        source: "HOLD",
        holdKind: "COMMITTED",
        entryId: h.entryId,
        entryReferenceNumber: h.entry.inquiryId ?? null,
        guestName: guestNameOf(h.entry.guestProfile),
        startDate: span.startDate,
        endDate: span.endDate,
      });
    }
  }

  for (const s of speculative) {
    if (!s.entry?.checkInDate || !s.entry?.checkOutDate) continue;
    // Same span resolution as committed holds (2026-08-06): the per-night snapshot when present
    // — one span per (room, contiguous nights) — else the primary room across the entry's stay.
    for (const span of committedHoldSpans(s, { checkIn: s.entry.checkInDate, checkOut: s.entry.checkOutDate })) {
      if (!roomIdSet.has(span.roomId)) continue;
      if (span.startDate >= input.checkOut || span.endDate <= input.checkIn) continue;
      const key = `${s.entryId}:${span.roomId}`;
      // Already reported under a stronger claim by the same booking.
      if (reservedKeys.has(key) || heldKeys.has(key)) continue;
      heldKeys.add(key);
      conflicts.push({
        roomId: span.roomId,
        source: "HOLD",
        holdKind: "SPECULATIVE",
        entryId: s.entryId,
        entryReferenceNumber: s.entry.inquiryId ?? null,
        guestName: guestNameOf(s.entry.guestProfile),
        startDate: span.startDate,
        endDate: span.endDate,
      });
    }
  }

  // Pending stay extensions (2026-08-21): the extra nights a guest is paying for are claimed
  // until the commit or the hold lapses. NOT deduped per (entry, room) like the holds above —
  // the same booking legitimately holds the room for its reserved nights AND claims the nights
  // after its checkout; those are different spans, both real.
  for (const x of await pendingStayExtensionClaims(db, { checkIn: input.checkIn, checkOut: input.checkOut, excludeEntryId: input.excludeEntryId })) {
    if (!roomIdSet.has(x.roomId)) continue;
    conflicts.push({
      roomId: x.roomId,
      source: "HOLD",
      holdKind: "COMMITTED",
      entryId: x.entryId,
      entryReferenceNumber: x.entry.inquiryId ?? null,
      guestName: guestNameOf(x.entry.guestProfile),
      startDate: x.startDate,
      endDate: x.endDate,
    });
  }

  return conflicts;
}
