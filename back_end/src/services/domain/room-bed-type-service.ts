/**
 * Set a room's physical bed setup from the operational surface (2026-08-10, operator
 * request — the S5 room-assignment block shows each room's beds, and the desk is where a
 * reconfiguration is actually decided: two singles pushed together become a King, a King
 * split becomes a Twin, with a guest standing there).
 *
 * L1-callable on purpose: the bed setup is a physical/housekeeping fact, not a commercial
 * field — the admin console's full room editor (number, type, capacity, blocking) stays L4.
 * Every change is traced with the prior value.
 */
import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";

/** The bed vocabulary the WRITE endpoint accepts — backend-owned so no UI hardcodes it. */
export const ROOM_BED_TYPES = ["KING", "QUEEN", "TWIN", "SINGLE"] as const;
export type RoomBedType = (typeof ROOM_BED_TYPES)[number];

/**
 * Which setups one room's PHYSICAL BED STOCK can be arranged into (2026-08-12, operator
 * ruling — "show all the bed types available for that room", but never a Queen on a room
 * that has no queen bed): KING and TWIN are the same stock arranged differently — two
 * singles pushed together make a King, a King splits back to a Twin (the exact
 * reconfiguration this service exists to record). QUEEN and SINGLE frames convert into
 * nothing else, so they stand alone — 301's Queen is offered only on 301.
 *
 * This is the one place the convertibility fact lives; `GET /api/rooms` derives each room's
 * `allowedBedTypes` from it, so a newly added room or a changed bed moves every desk
 * dropdown automatically — nothing hardcoded UI-side, no config key.
 */
const CONVERTIBLE_BED_GROUPS: readonly (readonly RoomBedType[])[] = [["KING", "TWIN"]];

/** All setups reachable from a room's current bed type (always includes itself). */
export function bedTypeConversionGroup(bedType: string | null | undefined): string[] {
  if (!bedType) return [];
  const group = CONVERTIBLE_BED_GROUPS.find((g) => (g as readonly string[]).includes(bedType));
  return group ? [...group] : [bedType];
}

/**
 * Trim + uppercase a caller's bed type and check it against the vocabulary. Shared with the
 * L4 admin room editor (2026-09-07) so the registry cannot take a typo from either surface —
 * an unknown value would give the room an `allowedBedTypes` of just itself and quietly break
 * every desk dropdown. `null`/blank means "no bed setup recorded" and is allowed.
 */
export function normaliseBedType(value: string | null | undefined): RoomBedType | null {
  const bedType = value?.trim().toUpperCase();
  if (!bedType) return null;
  if (!ROOM_BED_TYPES.includes(bedType as RoomBedType)) {
    throw new ValidationError(`bedType must be one of: ${ROOM_BED_TYPES.join(", ")}`);
  }
  return bedType as RoomBedType;
}

/** TWIN means two single beds; every other setup is one bed — unless the caller says otherwise. */
export function defaultBedCountForBedType(bedType: RoomBedType): number {
  return bedType === "TWIN" ? 2 : 1;
}

/** Guard for an explicitly supplied count, shared by the desk and admin write paths. */
export function assertValidBedCount(bedCount: number): void {
  if (!Number.isInteger(bedCount) || bedCount < 1 || bedCount > 6) {
    throw new ValidationError("bedCount must be a whole number between 1 and 6");
  }
}

export async function setRoomBedType(
  prisma: PrismaClient,
  roomId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { bedType: string; bedCount?: number | null },
) {
  const bedType = normaliseBedType(input.bedType);
  if (!bedType) throw new ValidationError(`bedType must be one of: ${ROOM_BED_TYPES.join(", ")}`);
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, roomNumber: true, bedType: true, bedCount: true },
  });
  if (!room) throw new NotFoundError("Room");

  const bedCount = input.bedCount ?? defaultBedCountForBedType(bedType);
  assertValidBedCount(bedCount);

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.room.update({
      where: { id: roomId },
      data: { bedType, bedCount, updatedAt: now },
      select: { id: true, roomNumber: true, bedType: true, bedCount: true },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ROOM.BED_TYPE_CHANGED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Room",
        entityId: roomId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S5,
        payload: {
          roomId,
          roomNumber: updated.roomNumber,
          from: room.bedType,
          fromCount: room.bedCount,
          to: bedType,
          toCount: bedCount,
        },
        createdBy: actor.actorId,
      },
    });
    return updated;
  });
}
