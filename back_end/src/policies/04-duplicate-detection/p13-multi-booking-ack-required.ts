import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { currentReservationOnly, stillHoldsInventory } from "../../lib/entry-inventory-claim.js";

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
type OverlapInput = {
  entryId: string;
  guestProfileId: string | null | undefined;
  checkInDate: Date;
  checkOutDate: Date;
};

/** The guest's other live booking over these nights, if any — the one question Policy 13 asks. */
export async function findOverlappingBookingOfSameGuest(
  prisma: PrismaClient,
  input: OverlapInput,
): Promise<{ entryId: string; frozenCheckInDate: Date; frozenCheckOutDate: Date } | null> {
  if (!input.guestProfileId) return null;
  return prisma.reservation.findFirst({
    where: {
      entryId: { not: input.entryId },
      frozenCheckInDate: { lt: input.checkOutDate },
      frozenCheckOutDate: { gt: input.checkInDate },
      entry: { guestProfileId: input.guestProfileId, ...stillHoldsInventory },
      // The guest's other booking as it stands, not a pass it replaced (2026-09-18).
      ...currentReservationOnly,
    } as any,
    orderBy: { confirmedAt: "desc" },
    select: { entryId: true, frozenCheckInDate: true, frozenCheckOutDate: true },
  });
}

/** Has an FOM acknowledged, on this booking, that the guest holds another over the same nights? */
export async function isMultiBookingAcknowledged(prisma: PrismaClient, entryId: string): Promise<boolean> {
  const ack = await prisma.traceEvent.findFirst({
    where: { entryId, eventType: "MULTI_BOOKING.ACKNOWLEDGED" },
    orderBy: { timestamp: "desc" },
    select: { id: true },
  });
  return !!ack;
}

const dayMonth = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "ENT-… (21–23 Sep)" — the other booking, as the desk names it. */
export function describeGuestOverlap(o: { entryId: string; frozenCheckInDate: Date; frozenCheckOutDate: Date }): string {
  return `${o.entryId} (${dayMonth(o.frozenCheckInDate)} – ${dayMonth(o.frozenCheckOutDate)})`;
}

export async function enforceMultiBookingAcknowledgedIfOverlappingReservationExists(prisma: PrismaClient, input: OverlapInput) {
  const overlapping = await findOverlappingBookingOfSameGuest(prisma, input);
  if (!overlapping) return;
  if (!(await isMultiBookingAcknowledged(prisma, input.entryId))) {
    throw new PolicyGateBlockedError("MULTI_BOOKING_ACK_REQUIRED", "Multi-booking overlap detected; FOM acknowledgement required");
  }
}

/**
 * The same question asked of an in-house stay whose DATES are about to change (2026-09-19) — a
 * stay extension. The re-freeze at the end of the walk asks it after an irreversible re-entry, so
 * it is asked here first (preview, request, and before the walk), in words that fit the Stay step.
 */
export async function enforceMultiBookingAcknowledgedForNewDates(prisma: PrismaClient, input: OverlapInput) {
  const overlapping = await findOverlappingBookingOfSameGuest(prisma, input);
  if (!overlapping) return;
  if (await isMultiBookingAcknowledged(prisma, input.entryId)) return;
  throw new PolicyGateBlockedError(
    "MULTI_BOOKING_ACK_REQUIRED",
    `This guest already holds ${describeGuestOverlap(overlapping)} over these nights — if both bookings are meant, the FOM acknowledges the overlap first. Nothing was changed.`,
  );
}
