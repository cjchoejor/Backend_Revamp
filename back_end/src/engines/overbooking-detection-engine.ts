import type { PrismaClient } from "@prisma/client";
import { HoldState } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";

export type OverbookingResult = {
  overbookingDetected: boolean;
  triggerType: "DELIBERATE" | "OTA_CONFLICT";
  reason: string;
};

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * SIG-S4 §5.1 — physical room overcommit: other **PLACED** / **CONFIRMED** holds on the same `roomId`
 * with overlapping stay dates vs configured `overbooking.maxAllowedRooms` (extra simultaneous claims allowed).
 */
export async function detectOverbooking(prisma: PrismaClient, input: { entryId: string; otaSource: boolean }): Promise<OverbookingResult> {
  const maxAllowed = await requireActiveConfigValue<number>(prisma, "overbooking.maxAllowedRooms").catch(() => 0);
  const max = Number(maxAllowed ?? 0);
  const triggerType = input.otaSource ? "OTA_CONFLICT" : "DELIBERATE";

  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    include: { committedHold: true },
  });
  if (!entry?.committedHold?.roomId) {
    return { overbookingDetected: false, triggerType, reason: "NO_ROOM_BOUND_HOLD" };
  }

  const checkIn = entry.checkInDate ?? new Date();
  const checkOut = entry.checkOutDate ?? new Date(checkIn.getTime() + 86400_000);

  const peers = await prisma.committedHold.findMany({
    where: {
      roomId: entry.committedHold.roomId,
      state: { in: [HoldState.PLACED, HoldState.CONFIRMED] },
      entryId: { not: input.entryId },
    },
    include: { entry: { select: { checkInDate: true, checkOutDate: true } } },
  });

  let overlapping = 0;
  for (const p of peers) {
    const e = p.entry;
    if (!e?.checkInDate || !e?.checkOutDate) continue;
    if (rangesOverlap(checkIn, checkOut, e.checkInDate, e.checkOutDate)) overlapping += 1;
  }

  const overbookingDetected = overlapping > max;
  return {
    overbookingDetected,
    triggerType,
    reason: overbookingDetected ? `room=${entry.committedHold.roomId} overlappingPeers=${overlapping} maxAllowedOver=${max}` : "OK",
  };
}
