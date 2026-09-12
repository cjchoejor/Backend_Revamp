import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { stillHoldsInventory } from "../../lib/entry-inventory-claim.js";

/**
 * Atlas Cat 06 group 04 (§5.2.4) — P13 multi-booking acknowledgement.
 *
 * The question it asks at the S4 freeze: does this guest ALREADY hold a booking over the same
 * nights — i.e. is this a deliberate second room, or a duplicate someone entered twice? Only an
 * FOM can say, so the freeze waits for `MULTI_BOOKING.ACKNOWLEDGED`.
 *
 * Two rules make it ask honestly (2026-09-12, operator report — ENT-20260912-0001 was blocked
 * against a CANCELLED booking that also merely abutted it):
 *
 *  1. **Half-open nights.** Checkout is EXCLUSIVE everywhere in this system — see
 *     `findRoomBookingConflicts`, whose whole point is that back-to-back stays don't collide.
 *     The closed `lte`/`gte` comparison here flagged every CONSECUTIVE stay: a guest leaving on
 *     the 12th and booking again from the 12th read as an overlap, which is the ordinary way a
 *     guest extends by making a second booking.
 *  2. **A finished booking overlaps nothing.** There was no status filter at all, so a
 *     CANCELLED or EXPIRED booking blocked the guest's next one for ever. `stillHoldsInventory`
 *     is the repo's single definition of "this booking is over" — reused here rather than
 *     restated, so the two cannot drift. PARKED deliberately still counts: a park is a pause,
 *     and the guest really does hold that booking.
 */
export async function enforceMultiBookingAcknowledgedIfOverlappingReservationExists(
  prisma: PrismaClient,
  input: {
    entryId: string;
    guestProfileId: string | null | undefined;
    checkInDate: Date;
    checkOutDate: Date;
  },
) {
  if (!input.guestProfileId) return;

  const overlapping = await prisma.reservation.findFirst({
    where: {
      entryId: { not: input.entryId },
      frozenCheckInDate: { lt: input.checkOutDate },
      frozenCheckOutDate: { gt: input.checkInDate },
      entry: { guestProfileId: input.guestProfileId, ...stillHoldsInventory },
    } as any,
    orderBy: { confirmedAt: "desc" },
  });

  if (!overlapping) return;

  const ack = await prisma.traceEvent.findFirst({
    where: { entryId: input.entryId, eventType: "MULTI_BOOKING.ACKNOWLEDGED" },
    orderBy: { timestamp: "desc" },
  });
  if (!ack) throw new PolicyGateBlockedError("MULTI_BOOKING_ACK_REQUIRED", "Multi-booking overlap detected; FOM acknowledgement required");
}
