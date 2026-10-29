/**
 * The room types a booking's room could change to (2026-10-29, operator: "the user can just double
 * click on the room and it can show option to change another room type, where the system can offer
 * free room types for that date").
 *
 * READ-ONLY. For one room of the booking, over the nights a change would take (the room's own
 * nights; in house, from tonight): every room type of the house with
 *   - how many of its rooms are free on every one of those nights (the same standing the room
 *     change reads — another booking's hold, a block, maintenance all count);
 *   - the room the system would give — the free room other bookings have picked least, so the
 *     system's choices spread over the type (the rule `placeStays` keeps for picks);
 *   - its room rate per night for this booking (its package's, or the published rate);
 *   - whose call the change is (another type: the FOM).
 * Before Arrival the booking's rooms are types, so its own type is not offered — the system already
 * moves the room within it. From Arrival on its own type is offered too: another room of it.
 */
import type { PrismaClient } from "@prisma/client";
import { addUtcDays, ymdUtc } from "../../lib/stay-dates.js";
import { buildWorld } from "./room-placement-service.js";
import { listRoomChangeCandidates } from "./room-change-service.js";
import { buildEntryRateReference } from "./rate-reference-service.js";

export type RoomTypeOption = {
  roomTypeId: string;
  name: string;
  /** The room's own type (offered from Arrival on). */
  sameType: boolean;
  /** Rooms of the type free on every night of the change. */
  free: number;
  /** The room the system would give, and every free room of the type (from Arrival on the desk may choose one). */
  roomId: string | null;
  roomNumber: string | null;
  rooms: Array<{ roomId: string; roomNumber: string }>;
  /** The room rate per night this booking would pay for the type, when known. */
  ratePerNight: number | null;
  /** Whose call: the same type is the desk's, another type the FOM's. */
  requiredLevel: "L1" | "L2";
};

export type RoomTypeOptions = {
  entryId: string;
  stage: string;
  /** Before Arrival the rooms are types — the room numbers are not shown. */
  beforeArrival: boolean;
  fromRoom: { roomId: string; roomNumber: string; roomTypeId: string; typeName: string | null };
  /** The nights the change takes ("YYYY-MM-DD"). */
  nights: string[];
  currency: string;
  /** The room's own rate per night now, for comparison. */
  currentRatePerNight: number | null;
  options: RoomTypeOption[];
};

export async function listRoomTypeOptions(prisma: PrismaClient, entryId: string, fromRoomId: string): Promise<RoomTypeOptions> {
  const c = await listRoomChangeCandidates(prisma, entryId, fromRoomId);
  const stage = c.originStage;
  const beforeArrival = stage === "S3" || stage === "S4";
  const nights = [...c.substitutionNights].sort();

  // Other bookings' picks — held by nothing — weigh a room down, so the system spreads its choices.
  const weight = new Map<string, number>();
  if (nights.length > 0) {
    const from = new Date(`${nights[0]}T00:00:00.000Z`);
    const to = addUtcDays(new Date(`${nights[nights.length - 1]}T00:00:00.000Z`), 1);
    const world = await buildWorld(prisma, { from, to, excludeEntryId: entryId });
    for (const [roomId, row] of world.soft) {
      let w = 0;
      for (const d of nights) w += row.get(world.index.get(d) ?? -1) ?? 0;
      if (w > 0) weight.set(roomId, w);
    }
  }

  const types = await prisma.roomType.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const byType = new Map<string, Array<{ roomId: string; roomNumber: string }>>();
  for (const r of c.candidates) {
    if (!r.selectable) continue;
    const list = byType.get(r.roomTypeId) ?? [];
    list.push({ roomId: r.roomId, roomNumber: r.roomNumber });
    byType.set(r.roomTypeId, list);
  }
  const num = (s: string) => Number(s.replace(/\D/g, "")) || 0;
  const picks: string[] = [];
  const draft = types
    .filter((t) => !(beforeArrival && t.id === c.fromRoom.roomTypeId))
    .map((t) => {
      const rooms = [...(byType.get(t.id) ?? [])].sort((a, b) => (weight.get(a.roomId) ?? 0) - (weight.get(b.roomId) ?? 0) || num(a.roomNumber) - num(b.roomNumber));
      const pick = rooms[0] ?? null;
      if (pick) picks.push(pick.roomId);
      return { t, rooms, pick };
    });

  // The rate per night each type would be priced at for this booking.
  const ref = await buildEntryRateReference(prisma, entryId, { planRoomIds: picks }).catch(() => null);
  const rateOf = (typeId: string) => ref?.roomTypes.find((x) => x.roomTypeId === typeId)?.roomRate ?? null;

  const options: RoomTypeOption[] = draft.map(({ t, rooms, pick }) => ({
    roomTypeId: t.id,
    name: t.name,
    sameType: t.id === c.fromRoom.roomTypeId,
    free: rooms.length,
    roomId: pick?.roomId ?? null,
    roomNumber: pick?.roomNumber ?? null,
    rooms: [...rooms].sort((a, b) => num(a.roomNumber) - num(b.roomNumber)),
    ratePerNight: rateOf(t.id),
    requiredLevel: t.id === c.fromRoom.roomTypeId ? "L1" : "L2",
  }));
  // Free types first (the own type first among them), then by name; none-free last.
  options.sort((a, b) => Number(b.free > 0) - Number(a.free > 0) || Number(b.sameType) - Number(a.sameType) || a.name.localeCompare(b.name));

  return {
    entryId,
    stage,
    beforeArrival,
    fromRoom: { roomId: c.fromRoom.roomId, roomNumber: c.fromRoom.roomNumber, roomTypeId: c.fromRoom.roomTypeId, typeName: c.fromRoom.roomTypeName },
    nights: nights.map((d) => ymdUtc(new Date(`${d}T00:00:00.000Z`))),
    currency: ref?.currency ?? "BTN",
    currentRatePerNight: rateOf(c.fromRoom.roomTypeId),
    options,
  };
}
