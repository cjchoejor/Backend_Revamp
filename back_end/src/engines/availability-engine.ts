import type { EntryUseType, InventoryClaimState } from "@prisma/client";

export type ShadowInventoryRule = {
  actorLevel?: string;
  visible: boolean;
};

export type RoomAvailabilityRecord = {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  capacity: number;
  currentClaimState: InventoryClaimState;
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

export type AvailabilityInput = {
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId?: string;
  spaceId?: string;
  guestCount: number;
  useType: EntryUseType;
  otaSource: boolean;
  guestTier: string;
  agentTier?: string;
  shadowInventoryRules: ShadowInventoryRule[];
  bookablePhysicalStates: InventoryClaimState[];
  rooms: RoomAvailabilityRecord[];
  spaces: SpaceAvailabilityRecord[];
  currentTimestamp: Date;
};

export type AvailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  claimState: InventoryClaimState;
  pricingIndicative?: unknown;
};

export type DeficientRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  claimState: InventoryClaimState;
  deficientCategory?: string | null;
  deficientDescription?: string | null;
};

export type UnavailableRoomEntry = {
  inventoryId: string;
  roomNumber: string;
  unavailabilityReason: "CLAIMED" | "MAINTENANCE_CONFLICT" | "BLOCKED" | "PHYSICAL_NOT_READY";
};

export type MaintenanceConflictEntry = {
  inventoryId: string;
  maintenanceDeadline: Date;
};

export type AvailabilityResult = {
  availableRooms: AvailableRoomEntry[];
  unavailableRooms: UnavailableRoomEntry[];
  deficientRooms: DeficientRoomEntry[];
  maintenanceConflicts: MaintenanceConflictEntry[];
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

  for (const room of rooms) {
    // Model 1 claim state
    if (room.currentClaimState !== "FREE") {
      unavailableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, unavailabilityReason: "CLAIMED" });
      continue;
    }

    // Hardcoded floor: blocked is always a conflict
    if (room.isBlocked) {
      unavailableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, unavailabilityReason: "BLOCKED" });
      continue;
    }

    // Hardcoded floor: maintenance with deadline within range is always conflict
    if (room.isUnderMaintenance && room.maintenanceDeadline && isDateInRangeInclusive(room.maintenanceDeadline, input.checkInDate, input.checkOutDate)) {
      unavailableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, unavailabilityReason: "MAINTENANCE_CONFLICT" });
      maintenanceConflicts.push({ inventoryId: room.id, maintenanceDeadline: room.maintenanceDeadline });
      continue;
    }

    // Policy 2 / AC-S1-012: deficient rooms never appear in availableRooms
    if (room.isDeficient) {
      deficientRooms.push({
        inventoryId: room.id,
        roomNumber: room.roomNumber,
        claimState: room.currentClaimState,
        deficientCategory: room.deficientConditionCategory ?? null,
        deficientDescription: null,
      });
      continue;
    }

    availableRooms.push({ inventoryId: room.id, roomNumber: room.roomNumber, claimState: room.currentClaimState });
  }

  return {
    availableRooms,
    unavailableRooms,
    deficientRooms,
    maintenanceConflicts,
    searchTimestamp: input.currentTimestamp,
    isRevalidationRequired: false,
  };
}

