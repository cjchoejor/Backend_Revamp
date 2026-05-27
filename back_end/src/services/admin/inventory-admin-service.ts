import type { PrismaClient } from "@prisma/client";
import { InventoryClaimState, RoomPhysicalState, SpaceAllocationState } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";

export async function listRoomTypes(prisma: PrismaClient) {
  return prisma.roomType.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { rooms: true } } },
  });
}

export async function createRoomType(
  prisma: PrismaClient,
  input: { code: string; name: string },
  actorId: string,
) {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || !name) throw new ValidationError("code and name are required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.roomType.create({ data: { code, name } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_TYPE_CREATED",
      entityType: "RoomType",
      entityId: created.id,
      operation: "CREATE",
      payload: { code, name },
    });
    return created;
  });
}

export async function deleteRoomType(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.roomType.findUnique({
    where: { id },
    include: { _count: { select: { rooms: true, committedHolds: true } } },
  });
  if (!existing) throw new NotFoundError("RoomType");
  if (existing._count.rooms > 0) {
    throw new ValidationError("Cannot delete room type while rooms are assigned to it");
  }
  if (existing._count.committedHolds > 0) {
    throw new ValidationError("Cannot delete room type while committed holds reference it");
  }

  return prisma.$transaction(async (tx) => {
    await tx.roomType.delete({ where: { id } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_TYPE_DELETED",
      entityType: "RoomType",
      entityId: id,
      operation: "DELETE",
      payload: { code: existing.code, name: existing.name },
    });
    return { id, deleted: true };
  });
}

export async function updateRoomType(
  prisma: PrismaClient,
  id: string,
  input: { name?: string },
  actorId: string,
) {
  const existing = await prisma.roomType.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("RoomType");
  const name = input.name?.trim();
  if (name !== undefined && !name) throw new ValidationError("name cannot be empty");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.roomType.update({
      where: { id },
      data: { name: name ?? undefined },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_TYPE_UPDATED",
      entityType: "RoomType",
      entityId: id,
      operation: "UPDATE",
      payload: { fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) },
    });
    return updated;
  });
}

export async function listRooms(prisma: PrismaClient) {
  return prisma.room.findMany({
    orderBy: [{ floorNumber: "asc" }, { roomNumber: "asc" }],
    include: { roomType: { select: { id: true, code: true, name: true } } },
  });
}

export async function getDeficientCategories(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, "deficientCondition.categories");
  return {
    configKey: "deficientCondition.categories",
    configValue: row?.configValue ?? [],
    isSystemDefault: row ? row.setBy === "actor-seed-system" : true,
    effectiveFrom: row?.effectiveFrom ?? null,
  };
}

export async function setDeficientCategories(
  prisma: PrismaClient,
  configValue: unknown,
  actorId: string,
  notes?: string | null,
) {
  return prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey: "deficientCondition.categories",
      configValue: configValue as never,
      actorId,
      notes,
    }),
  );
}

export async function getRoom(prisma: PrismaClient, id: string) {
  const room = await prisma.room.findUnique({
    where: { id },
    include: { roomType: true },
  });
  if (!room) throw new NotFoundError("Room");
  return room;
}

export async function createRoom(
  prisma: PrismaClient,
  input: {
    roomNumber: string;
    roomTypeId: string;
    floorNumber?: number | null;
    capacity?: number;
    isShadowInventory?: boolean;
  },
  actorId: string,
) {
  const roomNumber = input.roomNumber.trim();
  if (!roomNumber) throw new ValidationError("roomNumber is required");

  const roomType = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
  if (!roomType) throw new NotFoundError("RoomType");

  return prisma.$transaction(async (tx) => {
    const created = await tx.room.create({
      data: {
        roomNumber,
        roomTypeId: input.roomTypeId,
        floorNumber: input.floorNumber ?? null,
        capacity: input.capacity ?? 2,
        currentClaimState: InventoryClaimState.FREE,
        physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
        isShadowInventory: input.isShadowInventory ?? false,
        isDeficient: false,
        isUnderMaintenance: false,
        isBlocked: false,
      },
      include: { roomType: { select: { id: true, code: true, name: true } } },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_CREATED",
      entityType: "Room",
      entityId: created.id,
      operation: "CREATE",
      payload: { roomNumber, roomTypeId: input.roomTypeId },
    });
    return created;
  });
}

export async function deactivateRoom(prisma: PrismaClient, id: string, actorId: string, blockedReason?: string | null) {
  return updateRoom(prisma, id, { isBlocked: true, blockedReason: blockedReason ?? "Deactivated via admin console" }, actorId);
}

export async function deleteRoom(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.room.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          roomAssignments: true,
          speculativeHolds: true,
          deficientConditionRecords: true,
          claimStateEvents: true,
        },
      },
    },
  });
  if (!existing) throw new NotFoundError("Room");
  if (existing.currentClaimState !== InventoryClaimState.FREE) {
    throw new ValidationError("Cannot delete room while inventory claim is not FREE — deactivate instead");
  }
  if (existing._count.roomAssignments > 0) {
    throw new ValidationError("Cannot delete room with assignment history");
  }
  if (existing._count.speculativeHolds > 0) {
    throw new ValidationError("Cannot delete room with speculative holds");
  }
  if (existing._count.deficientConditionRecords > 0) {
    throw new ValidationError("Cannot delete room with deficient condition records");
  }

  return prisma.$transaction(async (tx) => {
    await tx.roomClaimStateEvent.deleteMany({ where: { roomId: id } });
    await tx.room.delete({ where: { id } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_DELETED",
      entityType: "Room",
      entityId: id,
      operation: "DELETE",
      payload: { roomNumber: existing.roomNumber },
    });
    return { id, deleted: true };
  });
}

export async function updateRoom(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ floorNumber: number | null; capacity: number; isShadowInventory: boolean; isBlocked: boolean; blockedReason: string | null }>,
  actorId: string,
) {
  const existing = await prisma.room.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Room");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.room.update({
      where: { id },
      data: {
        floorNumber: input.floorNumber,
        capacity: input.capacity,
        isShadowInventory: input.isShadowInventory,
        isBlocked: input.isBlocked,
        blockedReason: input.blockedReason === undefined ? undefined : input.blockedReason?.trim() || null,
      },
      include: { roomType: { select: { id: true, code: true, name: true } } },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_UPDATED",
      entityType: "Room",
      entityId: id,
      operation: "UPDATE",
      payload: { fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) },
    });
    return updated;
  });
}

export async function listSpaces(prisma: PrismaClient) {
  return prisma.space.findMany({ orderBy: { code: "asc" } });
}

export async function createSpace(
  prisma: PrismaClient,
  input: { code: string; name: string; spaceType?: string; capacity?: number; defaultCapacity?: number },
  actorId: string,
) {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || !name) throw new ValidationError("code and name are required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.space.create({
      data: {
        code,
        name,
        spaceType: input.spaceType?.trim() || "HALL",
        capacity: input.capacity ?? 0,
        defaultCapacity: input.defaultCapacity ?? input.capacity ?? 0,
        seatingConfigurations: [],
        isAvailable: true,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SPACE_CREATED",
      entityType: "Space",
      entityId: created.id,
      operation: "CREATE",
      payload: { code, name },
    });
    return created;
  });
}

export async function deleteSpace(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.space.findUnique({
    where: { id },
    include: {
      _count: { select: { speculativeHolds: true } },
      allocations: { where: { state: { not: SpaceAllocationState.RELEASED } }, select: { id: true } },
    },
  });
  if (!existing) throw new NotFoundError("Space");
  if (existing.allocations.length > 0) {
    throw new ValidationError("Cannot delete space with active conference or event allocations");
  }
  if (existing._count.speculativeHolds > 0) {
    throw new ValidationError("Cannot delete space with speculative holds");
  }

  return prisma.$transaction(async (tx) => {
    await tx.space.delete({ where: { id } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SPACE_DELETED",
      entityType: "Space",
      entityId: id,
      operation: "DELETE",
      payload: { code: existing.code, name: existing.name },
    });
    return { id, deleted: true };
  });
}

export async function updateSpace(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ name: string; spaceType: string; capacity: number; isAvailable: boolean }>,
  actorId: string,
) {
  const existing = await prisma.space.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Space");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.space.update({
      where: { id },
      data: {
        name: input.name?.trim(),
        spaceType: input.spaceType?.trim(),
        capacity: input.capacity,
        isAvailable: input.isAvailable,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SPACE_UPDATED",
      entityType: "Space",
      entityId: id,
      operation: "UPDATE",
      payload: { fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) },
    });
    return updated;
  });
}
