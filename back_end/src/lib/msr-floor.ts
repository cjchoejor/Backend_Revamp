import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "./errors.js";
import { toDecimal } from "./money.js";
import {
  belowMsrRefusalWords,
  mayPriceBelowMsr,
  type BelowFloorRoom,
  type MsrGmWaiverRecord,
} from "../policies/08-pricing-rate-plan/p19-msr-gm-waiver-below-msr-s2.js";

/**
 * Rates under the house's minimum sellable rate (2026-11-24, operator: "GM and admin can sell the
 * rooms below the msr"). One reading for the quotation draft and for the walks that re-price a
 * booking after it has gone back a step — the walks must refuse BEFORE they start, or a refusal at
 * the silent re-quote would strand the booking mid-walk.
 */

/**
 * A price already agreed on this booking (2026-11-24): every room now under its floor is priced at
 * or above the lowest rate an earlier quotation on this booking gave a room of that type — one a GM
 * or admin waived, or one that stood when it was quoted (the floor may have been raised since). Null
 * when any room goes lower than anything quoted before. A room swap or a change by the front desk
 * re-prices the same rates and passes; a new, lower rate does not.
 */
export async function carriedFloorWaiver(prisma: PrismaClient, entryId: string, rooms: BelowFloorRoom[]): Promise<MsrGmWaiverRecord | null> {
  if (!rooms.length) return null;
  const lowestByType = await agreedRatesByType(prisma, entryId);
  const covered = rooms.every((r) => {
    const w = lowestByType.get(r.roomTypeId);
    return !!w && r.rate >= w.rate;
  });
  if (!covered) return null;
  const from = lowestByType.get(rooms[0].roomTypeId)!.quotationId;
  return {
    rationale: `Carried from ${from}, waived there`,
    waivedAt: new Date().toISOString(),
    waivedBy: "CARRIED",
    rooms,
    carriedFrom: from,
  };
}

/**
 * The lowest room rate already agreed on this booking for each room type — from every earlier
 * quotation's typed rates and every waiver a GM or admin gave. A rate at or above it is a price
 * already agreed; the desk reads it off the rate reference so its table says what the server does.
 */
export async function agreedRatesByType(prisma: PrismaClient, entryId: string): Promise<Map<string, { rate: number; quotationId: string }>> {
  const earlier = await prisma.quotation.findMany({ where: { entryId }, select: { id: true, commercialTerms: true }, orderBy: { createdAt: "desc" } });
  type Terms = { msrGmWaiver?: MsrGmWaiverRecord; roomCompositions?: Array<{ roomId?: string; negotiatedRoomRate?: number | string | null; ratePackageId?: string | null }> };
  const roomIds = new Set<string>();
  for (const q of earlier) for (const c of (q.commercialTerms as Terms | null)?.roomCompositions ?? []) if (c.roomId) roomIds.add(c.roomId);
  const typeOfRoom = new Map(
    (await prisma.room.findMany({ where: { id: { in: [...roomIds] } }, select: { id: true, roomTypeId: true } })).map((r) => [r.id, r.roomTypeId]),
  );
  const lowestByType = new Map<string, { rate: number; quotationId: string }>();
  const note = (typeId: string | null | undefined, rate: number, quotationId: string) => {
    if (!typeId || !Number.isFinite(rate)) return;
    const seen = lowestByType.get(typeId);
    if (!seen || rate < seen.rate) lowestByType.set(typeId, { rate, quotationId });
  };
  for (const q of earlier) {
    const terms = q.commercialTerms as Terms | null;
    const w = terms?.msrGmWaiver;
    // A waiver given by someone who may give it, or itself carried from one.
    if (w?.rooms?.length && (w.level ? mayPriceBelowMsr(w.level) : !!w.carriedFrom)) {
      for (const r of w.rooms) note(r.roomTypeId, r.rate, q.id);
    }
    for (const c of terms?.roomCompositions ?? []) {
      if (c.negotiatedRoomRate == null || c.ratePackageId || !c.roomId) continue;
      note(typeOfRoom.get(c.roomId), Number(c.negotiatedRoomRate), q.id);
    }
  }
  return lowestByType;
}

/**
 * The rooms of a table whose typed rate is under their type's floor, read off the booking's rate
 * reference (the standard plan's MSR; a party's package has none). A room on a package of its own
 * or complimentary is left out, as the draft leaves it out.
 */
export async function belowFloorRoomsOf(
  prisma: PrismaClient,
  entryId: string,
  compositions: Array<{ roomId: string; negotiatedRoomRate?: number | null; ratePackageId?: string | null; isFoc?: boolean | null }>,
): Promise<BelowFloorRoom[]> {
  const typed = compositions.filter((c) => c.negotiatedRoomRate != null && !c.ratePackageId && c.isFoc !== true);
  if (!typed.length) return [];
  const { buildEntryRateReference } = await import("../services/domain/rate-reference-service.js");
  const ref = await buildEntryRateReference(prisma, entryId, { planRoomIds: typed.map((c) => c.roomId) });
  const rooms = await prisma.room.findMany({ where: { id: { in: typed.map((c) => c.roomId) } }, select: { id: true, roomNumber: true, roomTypeId: true } });
  const out: BelowFloorRoom[] = [];
  for (const c of typed) {
    const room = rooms.find((r) => r.id === c.roomId);
    const t = room?.roomTypeId ? ref.roomTypes.find((x) => x.roomTypeId === room.roomTypeId) : null;
    if (!room || !t || t.roomRateSource !== "STANDARD_RATE_PLAN" || t.msrValue == null || !(t.msrValue > 0)) continue;
    if (!toDecimal(c.negotiatedRoomRate!).lt(toDecimal(t.msrValue))) continue;
    out.push({ roomId: c.roomId, roomNumber: room.roomNumber, roomTypeId: room.roomTypeId!, rate: Number(c.negotiatedRoomRate), floor: t.msrValue });
  }
  return out;
}

/** Before a walk re-prices a booking: refused in words unless the GM or an admin, or a carried waiver. */
export async function enforceFloorBeforeWalk(
  prisma: PrismaClient,
  entryId: string,
  compositions: Parameters<typeof belowFloorRoomsOf>[2],
  actorLevel: string | null | undefined,
): Promise<void> {
  const below = await belowFloorRoomsOf(prisma, entryId, compositions);
  if (!below.length || mayPriceBelowMsr(actorLevel)) return;
  if (await carriedFloorWaiver(prisma, entryId, below)) return;
  throw new PolicyGateBlockedError("MSR_BREACH", belowMsrRefusalWords(below));
}
