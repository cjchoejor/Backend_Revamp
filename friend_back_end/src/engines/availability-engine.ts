import type { EntryUseType, InventoryClaimState } from "@prisma/client";

export type ShadowInventoryRule = {
  actorLevel?: string;
  visible: boolean;
};

export type RoomAvailabilityRecord = {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string | null;
  capacity: number;
  currentClaimState: InventoryClaimState;
  isShadowInventory?: boolean;
  isDeficient: boolean;
  deficientConditionCategory?: string | null;
  isUnderMaintenance: boolean;
  maintenanceDeadline?: Date | null;
  isBlocked: boolean;
  blockedReason?: string | null;
};

export type SpaceAvailabilityRecord = {
  id: string;
  spaceName?: string;
  defaultCapacity: number;
  isAvailable: boolean;
  isEventInProgress: boolean;
};

/**
 * A room's existing booking / hold in the calendar. Used by the per-date breakdown to mark
 * cells occupied. `endDate` is the EXCLUSIVE checkout — the night before it counts as
 * occupied; the day of endDate is available. Matches how the frozen dates are stored
 * (frozenCheckInDate inclusive, frozenCheckOutDate exclusive).
 */
export type RoomBlockage = {
  roomId: string;
  startDate: Date;
  endDate: Date;
  /** For debugging / operator display. RESERVED = confirmed booking; HOLD = committed hold. */
  source: "RESERVED" | "HOLD";
};

export type AvailabilityInput = {
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId?: string;
  spaceId?: string;
  guestCount: number;
  useType: EntryUseType;
  otaSource: boolean;
  guestTier: string;
  actorLevel?: string;
  agentTier?: string;
  shadowInventoryRules: ShadowInventoryRule[];
  bookablePhysicalStates: InventoryClaimState[];
  rooms: RoomAvailabilityRecord[];
  spaces: SpaceAvailabilityRecord[];
  /**
   * Optional existing room blockages (reservations + committed holds). When supplied, the
   * engine computes a per-date breakdown showing which (room, date) cells are occupied.
   * When omitted, the engine falls back to date-blind behavior (only currentClaimState).
   */
  roomBlockages?: RoomBlockage[];
  currentTimestamp: Date;
};

export type AvailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string | null;
  claimState: InventoryClaimState;
  pricingIndicative?: unknown;
};

export type DeficientRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string | null;
  claimState: InventoryClaimState;
  deficientCategory?: string | null;
  deficientDescription?: string | null;
};

export type UnavailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName?: string | null;
  unavailabilityReason: "CLAIMED" | "MAINTENANCE_CONFLICT" | "BLOCKED" | "PHYSICAL_NOT_READY";
  /** Present when reason is CLAIMED or PHYSICAL_NOT_READY — actual inventory claim on the room. */
  claimState?: InventoryClaimState;
  blockedReason?: string | null;
};

export type MaintenanceConflictEntry = {
  inventoryId: string;
  maintenanceDeadline: Date;
};

/** Per-date row in the availability breakdown. `date` is the ISO YYYY-MM-DD of the night. */
export type PerDateAvailability = {
  date: string;
  /** Room ids available on this specific night. */
  availableRoomIds: string[];
  /** Rooms with a blocking reservation / hold on this night. */
  occupiedRoomIds: Array<{ roomId: string; source: "RESERVED" | "HOLD" }>;
  /** Rooms flagged deficient — same set on every night since deficiency is room-scoped. */
  deficientRoomIds: string[];
};

export type AvailabilityResult = {
  availableRooms: AvailableRoomEntry[];
  unavailableRooms: UnavailableRoomEntry[];
  deficientRooms: DeficientRoomEntry[];
  maintenanceConflicts: MaintenanceConflictEntry[];
  /** Present when caller supplied `roomBlockages`. Absent → engine ran in legacy date-blind mode. */
  perDate?: PerDateAvailability[];
  searchTimestamp: Date;
  isRevalidationRequired: boolean;
};

function isDateInRangeInclusive(d: Date, start: Date, end: Date) {
  return d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
}

export function queryAvailability(input: AvailabilityInput): AvailabilityResult {
  const availableRooms: AvailableRoomEntry[] = [];
  const unavailableRooms: UnavailableRoomEntry[] = [];
  const deficientRooms: DeficientRoomEntry[] = [];
  const maintenanceConflicts: MaintenanceConflictEntry[] = [];

  const rooms = input.roomTypeId ? input.rooms.filter((r) => r.roomTypeId === input.roomTypeId) : input.rooms;

  // Policy 14 (Shadow inventory visibility): if room is shadow, visibility depends on rules for actor level.
  const actorLevel = input.actorLevel ?? "L1";
  const shadowRule = (input.shadowInventoryRules ?? []).find((r) => String(r.actorLevel ?? "").toUpperCase() === String(actorLevel).toUpperCase());
  const showShadow = shadowRule ? shadowRule.visible === true : true;

  for (const room of rooms) {
    if (room.isShadowInventory === true && !showShadow) {
      continue;
    }

    // Policy 1: only configured bookable physical states can be returned as available candidates.
    if (Array.isArray(input.bookablePhysicalStates) && input.bookablePhysicalStates.length > 0) {
      if (!input.bookablePhysicalStates.includes(room.currentClaimState)) {
        unavailableRooms.push({
          inventoryId: room.id,
          roomNumber: room.roomNumber,
          roomTypeId: room.roomTypeId,
          roomTypeName: room.roomTypeName ?? null,
          unavailabilityReason: "PHYSICAL_NOT_READY",
          claimState: room.currentClaimState,
        });
        continue;
      }
    }

    // Model 1 claim state
    if (room.currentClaimState !== "FREE") {
      unavailableRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        roomTypeId: room.roomTypeId,
        roomTypeName: room.roomTypeName ?? null,
        unavailabilityReason: "CLAIMED",
        claimState: room.currentClaimState,
      });
      continue;
    }

    // Hardcoded floor: blocked is always a conflict
    if (room.isBlocked) {
      unavailableRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        roomTypeId: room.roomTypeId,
        roomTypeName: room.roomTypeName ?? null,
        unavailabilityReason: "BLOCKED",
        blockedReason: room.blockedReason ?? null,
      });
      continue;
    }

    // Hardcoded floor: maintenance with deadline within range is always conflict
    if (room.isUnderMaintenance && room.maintenanceDeadline && isDateInRangeInclusive(room.maintenanceDeadline, input.checkInDate, input.checkOutDate)) {
      unavailableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, roomTypeId: room.roomTypeId, roomTypeName: room.roomTypeName ?? null, unavailabilityReason: "MAINTENANCE_CONFLICT" });
      maintenanceConflicts.push({ inventoryId: room.id, maintenanceDeadline: room.maintenanceDeadline });
      continue;
    }

    // Policy 2 / AC-S1-012: deficient rooms never appear in availableRooms
    if (room.isDeficient) {
      deficientRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        roomTypeId: room.roomTypeId,
        roomTypeName: room.roomTypeName ?? null,
        claimState: room.currentClaimState,
        deficientCategory: room.deficientConditionCategory ?? null,
        deficientDescription: null,
      });
      continue;
    }

    availableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, roomTypeId: room.roomTypeId, roomTypeName: room.roomTypeName ?? null, claimState: room.currentClaimState });
  }

  // ---- Per-date breakdown ------------------------------------------------
  // When the caller supplied roomBlockages, build a per-night breakdown of which rooms are
  // truly available on which specific night. The whole-range buckets above answer "usable
  // for the whole stay" — this breakdown answers "usable on each individual night" and
  // powers the calendar cell colours in the S1 UI.
  let perDate: PerDateAvailability[] | undefined = undefined;
  if (Array.isArray(input.roomBlockages)) {
    perDate = [];
    // Index blockages by roomId for fast lookup.
    const blockagesByRoomId = new Map<string, RoomBlockage[]>();
    for (const b of input.roomBlockages) {
      if (!blockagesByRoomId.has(b.roomId)) blockagesByRoomId.set(b.roomId, []);
      blockagesByRoomId.get(b.roomId)!.push(b);
    }
    const deficientRoomIdSet = new Set(deficientRooms.map((r) => r.inventoryId));
    // Include rooms in ALL buckets — the frontend renders every room and needs to know which
    // ones are occupied on which specific date.
    const candidateRoomIds = new Set<string>([
      ...availableRooms.map((r) => r.inventoryId),
      ...deficientRooms.map((r) => r.inventoryId),
    ]);

    const cur = new Date(input.checkInDate);
    const end = new Date(input.checkOutDate);
    let safety = 0;
    while (cur < end && safety++ < 365) {
      const iso = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
      const nightStart = new Date(cur.getTime());
      const nightEnd = new Date(cur.getTime() + 86_400_000);
      const availableIds: string[] = [];
      const occupied: Array<{ roomId: string; source: "RESERVED" | "HOLD" }> = [];
      const deficientIds: string[] = [];
      for (const roomId of candidateRoomIds) {
        const bs = blockagesByRoomId.get(roomId) ?? [];
        // A blockage intersects this night when its [startDate, endDate) overlaps with the
        // night's [nightStart, nightEnd). Standard half-open interval intersection test.
        const blocking = bs.find((b) => b.startDate < nightEnd && b.endDate > nightStart);
        if (blocking) {
          occupied.push({ roomId, source: blocking.source });
          continue;
        }
        if (deficientRoomIdSet.has(roomId)) {
          deficientIds.push(roomId);
          continue;
        }
        availableIds.push(roomId);
      }
      perDate.push({ date: iso, availableRoomIds: availableIds, occupiedRoomIds: occupied, deficientRoomIds: deficientIds });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  return {
    availableRooms,
    unavailableRooms,
    deficientRooms,
    maintenanceConflicts,
    ...(perDate ? { perDate } : {}),
    searchTimestamp: input.currentTimestamp,
    isRevalidationRequired: false,
  };
}

