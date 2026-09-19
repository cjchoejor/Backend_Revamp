/**
 * Bed setups — what a room is made up as, what it CAN be made up as, and what it usually is.
 *
 * The hotel's rule (2026-09-19, operator ruling — replaces the 2026-08-12 "King and Twin are one
 * convertible stock, Queen stands alone" model): **any room can be made up in any bed setup**,
 * unless the admin console narrows it. A guest who asks for a King gets a King set up in the
 * room; afterwards the room is usually returned to its type's normal setup.
 *
 * Three facts, three places:
 *  - `RoomType.defaultBedType` — the usual setup for rooms of that type (Standard: Twin,
 *    Suite: King). Set in the admin console.
 *  - `RoomType.allowedBedTypes` / `Room.allowedBedTypes` — which setups a room can take. The
 *    room's own list wins, else its type's, else every setup (empty = all).
 *  - `Room.bedType` — how the room is made up NOW. The desk changes it (L1) — a bed setup is a
 *    housekeeping fact decided with a guest standing there; the room's other fields stay L4.
 *
 * Every consumer — `GET /api/rooms`, the S1 bed request, the room change, both write paths —
 * reads these through the functions below, so the desk and the console cannot disagree.
 */
import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";

/** The bed vocabulary — backend-owned so no UI hardcodes it. */
export const ROOM_BED_TYPES = ["KING", "QUEEN", "TWIN", "SINGLE"] as const;
export type RoomBedType = (typeof ROOM_BED_TYPES)[number];

const BED_WORD: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };
export function bedWord(t: string): string {
  return BED_WORD[t] ?? t.charAt(0) + t.slice(1).toLowerCase();
}

/**
 * Trim + uppercase a caller's bed type and check it against the vocabulary. Shared by the
 * desk endpoint and the L4 admin editors so the registry cannot take a typo from either
 * surface. `null`/blank means "no bed setup recorded" and is allowed.
 */
export function normaliseBedType(value: string | null | undefined): RoomBedType | null {
  const bedType = value?.trim().toUpperCase();
  if (!bedType) return null;
  if (!ROOM_BED_TYPES.includes(bedType as RoomBedType)) {
    throw new ValidationError(`bedType must be one of: ${ROOM_BED_TYPES.join(", ")}`);
  }
  return bedType as RoomBedType;
}

/**
 * A list of setups, validated, de-duplicated and put in vocabulary order. `null`/empty is the
 * empty list, which means "every setup" wherever an allowed list is read.
 */
export function normaliseBedTypeList(values: readonly string[] | null | undefined): RoomBedType[] {
  const set = new Set<RoomBedType>();
  for (const v of values ?? []) {
    const t = normaliseBedType(v);
    if (t) set.add(t);
  }
  return ROOM_BED_TYPES.filter((t) => set.has(t));
}

/** The setups a room can be made up in: its own list, else its type's, else all of them. */
export function effectiveAllowedBedTypes(
  roomAllowed: readonly string[] | null | undefined,
  typeAllowed: readonly string[] | null | undefined,
): RoomBedType[] {
  const own = normaliseBedTypeList(roomAllowed);
  if (own.length > 0) return own;
  const fromType = normaliseBedTypeList(typeAllowed);
  if (fromType.length > 0) return fromType;
  return [...ROOM_BED_TYPES];
}

/** Where the effective list came from — so a screen can say "follows its type" honestly. */
export function allowedBedTypesSource(
  roomAllowed: readonly string[] | null | undefined,
  typeAllowed: readonly string[] | null | undefined,
): "ROOM" | "ROOM_TYPE" | "ALL" {
  if (normaliseBedTypeList(roomAllowed).length > 0) return "ROOM";
  if (normaliseBedTypeList(typeAllowed).length > 0) return "ROOM_TYPE";
  return "ALL";
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

/** Refuses a setup the room cannot take, naming the setups it can. */
export function assertBedTypeAllowedForRoom(
  roomNumber: string,
  bedType: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(bedType)) {
    throw new ValidationError(
      `Room ${roomNumber} can be made up as ${allowed.map(bedWord).join(" or ")} — not ${bedWord(bedType)}. Which setups a room can take is set in the admin console.`,
    );
  }
}

/* ------------------------------------------------------------------ bed requests */

export interface BedOptionRoom {
  id: string;
  roomNumber: string;
  allowed: readonly string[];
}

/** Every non-shadow room (or the given ones) with the setups it can take. */
export async function loadRoomBedOptions(
  prisma: PrismaClient,
  roomIds?: readonly string[],
): Promise<BedOptionRoom[]> {
  const rooms = await prisma.room.findMany({
    where: roomIds ? { id: { in: [...roomIds] } } : { isShadowInventory: false },
    select: { id: true, roomNumber: true, allowedBedTypes: true, roomType: { select: { allowedBedTypes: true } } },
    orderBy: { roomNumber: "asc" },
  });
  return rooms.map((r) => ({
    id: r.id,
    roomNumber: r.roomNumber,
    allowed: effectiveAllowedBedTypes(r.allowedBedTypes, r.roomType.allowedBedTypes),
  }));
}

export interface BedRequestCheck {
  /** Every requested setup can be given its own room at the same time. */
  satisfiable: boolean;
  /** Per requested setup: how many asked, how many rooms could take it, how many are covered. */
  perType: { bedType: string; asked: number; roomsThatCanTake: number; covered: number }[];
  /** Rooms that can take each setup, for every setup in the vocabulary (the "up to N" ceilings). */
  stock: Record<string, number>;
  /** Why it cannot be met, in desk words — null when it can. */
  message: string | null;
}

/**
 * Can this request — e.g. 3 King + 2 Twin — be met from these rooms, one setup per room?
 *
 * A room takes one setup at a time and each room has its own allowed list, so this is a
 * matching, not a sum: 5 rooms that each allow King OR Twin can serve 3 King + 2 Twin, but
 * 2 rooms that allow only King cannot serve 2 King + 1 Twin. `covered` comes from a maximum
 * matching (small: ≤ a few hundred asks against the hotel's rooms), and the refusal names
 * the smallest group of setups that cannot be served (Hall's condition), so the desk can say
 * exactly what to trim.
 */
export function checkBedRequestAgainstRooms(
  request: Record<string, number>,
  rooms: readonly BedOptionRoom[],
): BedRequestCheck {
  const stock: Record<string, number> = {};
  for (const t of ROOM_BED_TYPES) stock[t] = rooms.filter((r) => r.allowed.includes(t)).length;

  const asks = Object.entries(request).filter(([, n]) => n > 0);
  // Expand each ask into slots, then match slots to rooms (augmenting paths).
  const slots: string[] = [];
  for (const [t, n] of asks) for (let i = 0; i < n; i++) slots.push(t);
  const roomOfSlot = new Array<number>(slots.length).fill(-1);
  const slotOfRoom = new Array<number>(rooms.length).fill(-1);
  const tryAssign = (slot: number, seen: boolean[]): boolean => {
    for (let r = 0; r < rooms.length; r++) {
      if (seen[r] || !rooms[r].allowed.includes(slots[slot])) continue;
      seen[r] = true;
      if (slotOfRoom[r] === -1 || tryAssign(slotOfRoom[r], seen)) {
        slotOfRoom[r] = slot;
        roomOfSlot[slot] = r;
        return true;
      }
    }
    return false;
  };
  for (let s = 0; s < slots.length; s++) tryAssign(s, new Array<boolean>(rooms.length).fill(false));

  const perType = asks.map(([bedType, asked]) => ({
    bedType,
    asked,
    roomsThatCanTake: stock[bedType] ?? 0,
    covered: slots.filter((t, i) => t === bedType && roomOfSlot[i] !== -1).length,
  }));
  const satisfiable = roomOfSlot.every((r) => r !== -1);

  let message: string | null = null;
  if (!satisfiable) {
    // The smallest set of setups whose asks exceed the rooms that can take any of them.
    const types = asks.map(([t]) => t);
    let worst: { set: string[]; asked: number; supply: number } | null = null;
    for (let mask = 1; mask < 1 << types.length; mask++) {
      const set = types.filter((_, i) => mask & (1 << i));
      const asked = set.reduce((a, t) => a + (request[t] ?? 0), 0);
      const supply = rooms.filter((r) => set.some((t) => r.allowed.includes(t))).length;
      if (asked > supply && (!worst || set.length < worst.set.length)) worst = { set, asked, supply };
    }
    const setWords = worst ? worst.set.map(bedWord).join(" or ") : "these setups";
    message = worst
      ? `only ${worst.supply} room${worst.supply === 1 ? "" : "s"} can be made up as ${setWords}, but ${worst.asked} ${worst.asked === 1 ? "is" : "are"} asked for`
      : "the bed setup asked for cannot be met from these rooms";
  }
  return { satisfiable, perType, stock, message };
}

/* ------------------------------------------------------------------ desk write */

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
    select: {
      id: true,
      roomNumber: true,
      bedType: true,
      bedCount: true,
      allowedBedTypes: true,
      roomType: { select: { allowedBedTypes: true } },
    },
  });
  if (!room) throw new NotFoundError("Room");
  assertBedTypeAllowedForRoom(
    room.roomNumber,
    bedType,
    effectiveAllowedBedTypes(room.allowedBedTypes, room.roomType.allowedBedTypes),
  );

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
