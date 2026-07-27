import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/** Atlas Cat 06 group 04 (§5.2.4) — P13 multi-booking acknowledgement. */
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
      frozenCheckInDate: { lte: input.checkOutDate },
      frozenCheckOutDate: { gte: input.checkInDate },
      entry: { guestProfileId: input.guestProfileId },
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
