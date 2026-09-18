import type { PrismaClient } from "@prisma/client";
import { HoldState } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { committedHoldSpans, reservedClaimEndDate, stillHoldsInventory, type ClaimSpan } from "../lib/entry-inventory-claim.js";

export type OverbookingResult = {
  overbookingDetected: boolean;
  triggerType: "DELIBERATE" | "OTA_CONFLICT";
  reason: string;
  /** Each room over the limit, with the other bookings claiming it on the same nights. */
  conflicts: Array<{ roomId: string; peerEntryIds: string[] }>;
};

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * SIG-S4 §5.1 — physical room overcommit: other **PLACED** / **CONFIRMED** holds claiming the same
 * room on the same NIGHTS, vs configured `overbooking.maxAllowedRooms` (extra simultaneous claims
 * allowed per room).
 *
 * Judged night by night (2026-09-19). It used to compare the booking's WHOLE stay against every
 * other hold on the booking's FIRST room — so a stay extension that moves the guest out of room
 * 303 on the 21st, precisely because 303 is someone else's that night, was refused at the
 * re-freeze as a "deliberate overbooking" and left the in-house guest's booking at Set up. Holds
 * are now read through `committedHoldSpans` — the per-night snapshot when there is one, else the
 * primary room over the stay — the same reading the S1 search and the committed-hold gate use, so
 * a hold's other rooms count too, not only its primary. Bookings that no longer hold rooms
 * (cancelled, expired, closed, no-show) are not peers, and a peer that left early claims nothing
 * after its departure.
 */
export async function detectOverbookingForSpans(
  prisma: PrismaClient,
  input: { entryId: string; otaSource: boolean; spans: ClaimSpan[] },
): Promise<OverbookingResult> {
  const maxAllowed = await requireActiveConfigValue<number>(prisma, "overbooking.maxAllowedRooms").catch(() => 0);
  const max = Number(maxAllowed ?? 0);
  const triggerType = input.otaSource ? "OTA_CONFLICT" : "DELIBERATE";

  const spans = input.spans.filter((s) => s.endDate.getTime() > s.startDate.getTime());
  if (spans.length === 0) {
    return { overbookingDetected: false, triggerType, reason: "NO_ROOM_BOUND_HOLD", conflicts: [] };
  }
  const windowStart = new Date(Math.min(...spans.map((s) => s.startDate.getTime())));
  const windowEnd = new Date(Math.max(...spans.map((s) => s.endDate.getTime())));

  const peers = await prisma.committedHold.findMany({
    where: {
      state: { in: [HoldState.PLACED, HoldState.CONFIRMED] },
      entryId: { not: input.entryId },
      entry: { ...stillHoldsInventory, checkInDate: { lt: windowEnd }, checkOutDate: { gt: windowStart } },
    },
    select: {
      entryId: true,
      roomId: true,
      perNightBreakdown: true,
      entry: { select: { checkInDate: true, checkOutDate: true, actualCheckOutDate: true } },
    },
  });

  const peersByRoom = new Map<string, Set<string>>();
  for (const p of peers) {
    const e = p.entry;
    if (!e?.checkInDate || !e?.checkOutDate) continue;
    const claimEnd = reservedClaimEndDate(e.checkOutDate, e);
    for (const theirs of committedHoldSpans(p, { checkIn: e.checkInDate, checkOut: e.checkOutDate })) {
      const theirEnd = theirs.endDate.getTime() > claimEnd.getTime() ? claimEnd : theirs.endDate;
      if (theirEnd.getTime() <= theirs.startDate.getTime()) continue;
      for (const mine of spans) {
        if (mine.roomId !== theirs.roomId) continue;
        if (!rangesOverlap(mine.startDate, mine.endDate, theirs.startDate, theirEnd)) continue;
        const set = peersByRoom.get(mine.roomId) ?? new Set<string>();
        set.add(p.entryId);
        peersByRoom.set(mine.roomId, set);
      }
    }
  }

  const conflicts = [...peersByRoom]
    .filter(([, entryIds]) => entryIds.size > max)
    .map(([roomId, entryIds]) => ({ roomId, peerEntryIds: [...entryIds].sort() }));
  const overbookingDetected = conflicts.length > 0;
  return {
    overbookingDetected,
    triggerType,
    reason: overbookingDetected
      ? `${conflicts.map((c) => `room=${c.roomId} overlappingPeers=${c.peerEntryIds.length}`).join("; ")} maxAllowedOver=${max}`
      : "OK",
    conflicts,
  };
}

/** The booking's own committed hold, read night by night — see `detectOverbookingForSpans`. */
export async function detectOverbooking(prisma: PrismaClient, input: { entryId: string; otaSource: boolean }): Promise<OverbookingResult> {
  const triggerType = input.otaSource ? "OTA_CONFLICT" : "DELIBERATE";
  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    select: { checkInDate: true, checkOutDate: true, committedHold: { select: { roomId: true, perNightBreakdown: true } } },
  });
  if (!entry?.committedHold) {
    return { overbookingDetected: false, triggerType, reason: "NO_ROOM_BOUND_HOLD", conflicts: [] };
  }
  const checkIn = entry.checkInDate ?? new Date();
  const checkOut = entry.checkOutDate ?? new Date(checkIn.getTime() + 86400_000);
  return detectOverbookingForSpans(prisma, {
    entryId: input.entryId,
    otaSource: input.otaSource,
    spans: committedHoldSpans(entry.committedHold, { checkIn, checkOut }),
  });
}
