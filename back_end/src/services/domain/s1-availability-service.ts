import type { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { queryAvailability as availabilityEngineQuery } from "../../engines/availability-engine.js";

export async function queryAvailability(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: "L1" | "L2" | "L3" | "L4" | "SYSTEM",
  input: { roomTypeId?: string; checkInDate: string; checkOutDate: string; guestCount?: number; useType?: string },
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  if (!input.checkInDate || !input.checkOutDate) throw new ValidationError("checkInDate and checkOutDate are required");
  const checkIn = new Date(input.checkInDate);
  const checkOut = new Date(input.checkOutDate);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime())) throw new ValidationError("Invalid checkInDate/checkOutDate");

  const shadowRules = await requireActiveConfigValue<any[]>(prisma, "availability.shadowInventory.visibilityRules");
  const bookablePhysicalStates = await requireActiveConfigValue<any>(prisma, "availability.bookablePhysicalStates").catch(() => ["FREE"]);

  const rooms = await prisma.room.findMany({ orderBy: { roomNumber: "asc" } });
  const spaces = await prisma.space.findMany({ orderBy: { code: "asc" } });

  const engineOut = availabilityEngineQuery({
    checkInDate: checkIn,
    checkOutDate: checkOut,
    roomTypeId: input.roomTypeId,
    guestCount: input.guestCount ?? entry.guestCount ?? 1,
    useType: (input.useType as any) ?? entry.useType,
    otaSource: entry.otaSource,
    guestTier: "STANDARD",
    actorLevel,
    shadowInventoryRules: shadowRules ?? [],
    bookablePhysicalStates,
    rooms: rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomTypeId: r.roomTypeId,
      capacity: r.capacity,
      currentClaimState: r.currentClaimState,
      isShadowInventory: (r as any).isShadowInventory === true,
      isDeficient: r.isDeficient,
      deficientConditionCategory: r.deficientConditionCategory,
      isUnderMaintenance: r.isUnderMaintenance,
      maintenanceDeadline: r.maintenanceDeadline,
      isBlocked: r.isBlocked,
      blockedReason: r.blockedReason,
    })),
    spaces: spaces.map((s) => ({ id: s.id, spaceName: s.name, defaultCapacity: s.defaultCapacity, isAvailable: s.isAvailable, isEventInProgress: s.isEventInProgress })),
    currentTimestamp: new Date(),
  });

  const resultForApi = {
    ...engineOut,
    availableRooms: engineOut.availableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    unavailableRooms: engineOut.unavailableRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
    deficientRooms: engineOut.deficientRooms.map((r: any) => ({ ...r, roomId: r.inventoryId })),
  };

  const cfg = await prisma.availabilityConfiguration.create({
    data: {
      entryId,
      searchCriteria: { ...input },
      resultSet: engineOut as any,
      createdBy: actorId,
    },
  });

  return { configuration: cfg, result: resultForApi };
}

export async function selectOption(
  prisma: PrismaClient,
  configId: string,
  actorId: string,
  input: { roomId: string; deficientAcknowledgements?: unknown },
) {
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: configId } });
  if (!cfg) throw new NotFoundError("AvailabilityConfiguration");
  if (cfg.isStale) throw new ValidationError("configuration is stale");
  if (!input.roomId?.trim()) throw new ValidationError("roomId is required");

  // Guard: selection must be from the persisted resultSet for this configuration.
  const rs = (cfg.resultSet ?? {}) as any;
  const selectedRoomId = input.roomId.trim();
  const inAnyBucket =
    (rs.availableRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId) ||
    (rs.deficientRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId) ||
    (rs.unavailableRooms ?? []).some((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId);
  if (!inAnyBucket) {
    throw new ValidationError("roomId must be selected from the persisted AvailabilityConfiguration resultSet");
  }

  const unavailable = (rs.unavailableRooms ?? []).find((r: any) => r.inventoryId === selectedRoomId || r.roomId === selectedRoomId);
  if (unavailable) {
    throw new ValidationError(`roomId is not selectable (unavailableReason=${unavailable.unavailabilityReason ?? "UNKNOWN"})`);
  }

  const room = await prisma.room.findUnique({ where: { id: selectedRoomId }, include: { deficientConditionRecords: true } });
  if (!room) throw new NotFoundError("Room");
  const isDeficient = (room.deficientConditionRecords ?? []).some((d) => d.status !== "RESOLVED");

  if (isDeficient && !input.deficientAcknowledgements) {
    throw new ValidationError("deficientAcknowledgements is required when selecting a DEFICIENT room");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.availabilityConfiguration.update({
      where: { id: configId },
      data: {
        optionSelected: { roomId: selectedRoomId, isDeficient },
        deficientAcknowledgements: isDeficient ? (input.deficientAcknowledgements as any) : null,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "CONFIGURATION_SELECTED",
        actorId,
        actorLevel: "L1",
        entityType: "AvailabilityConfiguration",
        entityId: configId,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: cfg.entryId,
        payload: { configId, roomId: selectedRoomId },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

