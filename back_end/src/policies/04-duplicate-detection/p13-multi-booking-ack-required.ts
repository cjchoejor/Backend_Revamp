import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { currentReservationOnly, stillHoldsInventory } from "../../lib/entry-inventory-claim.js";
import { guestNameKey, partyWhere, type SameGuestWhy } from "../../lib/same-guest-stays.js";

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

export type GuestOverlap = {
  entryId: string;
  frozenCheckInDate: Date;
  frozenCheckOutDate: Date;
  /** SAME_GUEST — the same guest record; SAME_NAME — the same name through the same agency or company. */
  why: SameGuestWhy;
  partyName: string | null;
};

/**
 * The guest's other live booking over these nights, if any — the one question Policy 13 asks.
 * "The guest" is the same guest record, or (2026-11-24) the same name booked through the same
 * travel agent or company: an agency's guest typed in twice makes two records with one name.
 */
export async function findOverlappingBookingOfSameGuest(prisma: PrismaClient, input: OverlapInput): Promise<GuestOverlap | null> {
  if (!input.guestProfileId) return null;
  const overlap = {
    entryId: { not: input.entryId },
    frozenCheckInDate: { lt: input.checkOutDate },
    frozenCheckOutDate: { gt: input.checkInDate },
    // The guest's other booking as it stands, not a pass it replaced (2026-09-18).
    ...currentReservationOnly,
  };
  const same = await prisma.reservation.findFirst({
    where: { ...overlap, entry: { guestProfileId: input.guestProfileId, ...stillHoldsInventory } } as any,
    orderBy: { confirmedAt: "desc" },
    select: { entryId: true, frozenCheckInDate: true, frozenCheckOutDate: true },
  });
  if (same) return { ...same, why: "SAME_GUEST", partyName: null };

  const me = await prisma.entry.findUnique({
    where: { id: input.entryId },
    select: {
      inquiryId: true,
      inquiry: {
        select: {
          travelAgentId: true,
          corporateAccountId: true,
          travelAgent: { select: { displayName: true } },
          corporateAccount: { select: { displayName: true } },
        },
      },
    },
  });
  const party = partyWhere(me?.inquiry);
  const guest = await prisma.guestProfile.findUnique({ where: { id: input.guestProfileId }, select: { firstName: true, lastName: true } });
  const name = guestNameKey(guest);
  if (!me || !party || !name) return null;
  const rows = await prisma.reservation.findMany({
    where: {
      ...overlap,
      entry: { ...stillHoldsInventory, inquiryId: { not: me.inquiryId }, guestProfileId: { not: input.guestProfileId }, inquiry: party },
    } as any,
    orderBy: { confirmedAt: "desc" },
    select: { entryId: true, frozenCheckInDate: true, frozenCheckOutDate: true, entry: { select: { guestProfile: { select: { firstName: true, lastName: true } } } } },
  });
  const hit = rows.find((r) => guestNameKey(r.entry?.guestProfile) === name);
  if (!hit) return null;
  return {
    entryId: hit.entryId,
    frozenCheckInDate: hit.frozenCheckInDate,
    frozenCheckOutDate: hit.frozenCheckOutDate,
    why: "SAME_NAME",
    partyName: me.inquiry?.travelAgent?.displayName ?? me.inquiry?.corporateAccount?.displayName ?? null,
  };
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

/** What the other booking is, in a sentence: the guest's own, or the same name through the same agency. */
export function overlapWords(o: GuestOverlap): string {
  return o.why === "SAME_NAME" && o.partyName
    ? `${o.partyName} already has ${describeGuestOverlap(o)} for a guest of the same name over these nights`
    : `This guest already holds ${describeGuestOverlap(o)} over these nights`;
}

/** "ENT-… (21–23 Sep)" — the other booking, as the desk names it. */
export function describeGuestOverlap(o: { entryId: string; frozenCheckInDate: Date; frozenCheckOutDate: Date }): string {
  return `${o.entryId} (${dayMonth(o.frozenCheckInDate)} – ${dayMonth(o.frozenCheckOutDate)})`;
}

export async function enforceMultiBookingAcknowledgedIfOverlappingReservationExists(prisma: PrismaClient, input: OverlapInput) {
  const overlapping = await findOverlappingBookingOfSameGuest(prisma, input);
  if (!overlapping) return;
  if (!(await isMultiBookingAcknowledged(prisma, input.entryId))) {
    throw new PolicyGateBlockedError(
      "MULTI_BOOKING_ACK_REQUIRED",
      `${overlapWords(overlapping)} — if both bookings are meant, the FOM acknowledges the overlap first.`,
    );
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
    `${overlapWords(overlapping)} — if both bookings are meant, the FOM acknowledges the overlap first. Nothing was changed.`,
  );
}
