import type { PrismaClient } from "@prisma/client";
import { InventoryClaimState, RoomPhysicalState, SpaceAllocationState } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";

export async function listRoomTypes(prisma: PrismaClient) {
  return prisma.roomType.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { rooms: true } } },
  });
}

/**
 * Generates a human-readable RoomType id of the form `<CODE>-<padded-global-seq>` (e.g. DLX-0001,
 * STD-0002). The sequence is the count of existing room-type rows + 1 — global, not per-code —
 * matching the user-facing illustration "STD-0001 / DXL-0002".
 */
export async function generateRoomTypeId(
  tx: Pick<PrismaClient, "roomType">,
  code: string,
): Promise<string> {
  const total = await tx.roomType.count();
  const seq = String(total + 1).padStart(4, "0");
  return `${code.toUpperCase()}-${seq}`;
}

export async function createRoomType(
  prisma: PrismaClient,
  input: {
    code: string;
    name: string;
    standardCapacity?: number;
    maxCapacity?: number;
    maxChildren?: number;
    requiredAccompanyingAdults?: number;
    maxExtraBeds?: number;
  },
  actorId: string,
) {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code || !name) throw new ValidationError("code and name are required");
  if (input.standardCapacity != null && input.maxCapacity != null && input.maxCapacity < input.standardCapacity) {
    throw new ValidationError("maxCapacity must be >= standardCapacity");
  }

  return prisma.$transaction(async (tx) => {
    const id = await generateRoomTypeId(tx, code);
    const created = await tx.roomType.create({
      data: {
        id,
        code,
        name,
        ...(input.standardCapacity != null ? { standardCapacity: input.standardCapacity } : {}),
        ...(input.maxCapacity != null ? { maxCapacity: input.maxCapacity } : {}),
        ...(input.maxChildren != null ? { maxChildren: input.maxChildren } : {}),
        ...(input.requiredAccompanyingAdults != null ? { requiredAccompanyingAdults: input.requiredAccompanyingAdults } : {}),
        ...(input.maxExtraBeds != null ? { maxExtraBeds: input.maxExtraBeds } : {}),
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROOM_TYPE_CREATED",
      entityType: "RoomType",
      entityId: created.id,
      operation: "CREATE",
      payload: {
        code,
        name,
        capacity: {
          standardCapacity: created.standardCapacity,
          maxCapacity: created.maxCapacity,
          maxChildren: created.maxChildren,
          requiredAccompanyingAdults: created.requiredAccompanyingAdults,
          maxExtraBeds: created.maxExtraBeds,
        },
      },
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
  input: {
    name?: string;
    standardCapacity?: number;
    maxCapacity?: number;
    maxChildren?: number;
    requiredAccompanyingAdults?: number;
    maxExtraBeds?: number;
  },
  actorId: string,
) {
  const existing = await prisma.roomType.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("RoomType");
  const name = input.name?.trim();
  if (name !== undefined && !name) throw new ValidationError("name cannot be empty");
  // Enforce standard <= max even when only one of the two is being changed.
  const effectiveStandard = input.standardCapacity ?? existing.standardCapacity;
  const effectiveMax = input.maxCapacity ?? existing.maxCapacity;
  if (effectiveMax < effectiveStandard) {
    throw new ValidationError("maxCapacity must be >= standardCapacity");
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.roomType.update({
      where: { id },
      data: {
        ...(name != null ? { name } : {}),
        ...(input.standardCapacity != null ? { standardCapacity: input.standardCapacity } : {}),
        ...(input.maxCapacity != null ? { maxCapacity: input.maxCapacity } : {}),
        ...(input.maxChildren != null ? { maxChildren: input.maxChildren } : {}),
        ...(input.requiredAccompanyingAdults != null ? { requiredAccompanyingAdults: input.requiredAccompanyingAdults } : {}),
        ...(input.maxExtraBeds != null ? { maxExtraBeds: input.maxExtraBeds } : {}),
      },
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

  // Friendly pre-check so the operator sees "Room 201 already exists" instead of a
  // Prisma P2002 unique-constraint violation surfacing as "Internal server error".
  const conflict = await prisma.room.findUnique({ where: { roomNumber } });
  if (conflict) {
    throw new ValidationError(
      `Room number "${roomNumber}" already exists. Pick a different number or edit the existing room.`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
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
  } catch (e) {
    // Race-condition fallback: pre-check passed but another concurrent create won.
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
      throw new ValidationError(
        `Room number "${roomNumber}" already exists. Pick a different number or edit the existing room.`,
      );
    }
    throw e;
  }
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
          // Only OPEN (UNRESOLVED) deficient records should block deletion. Resolved historical
          // records are bookkeeping; the lifecycle is preserved in trace_events.
          deficientConditionRecords: { where: { status: { not: "RESOLVED" } } },
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
    throw new ValidationError("Cannot delete room with unresolved deficient condition records — resolve first");
  }

  return prisma.$transaction(async (tx) => {
    // Cascade-delete the now-empty bookkeeping rows (all resolved, by the guard above).
    await tx.deficientConditionRecord.deleteMany({ where: { roomId: id } });
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
  input: Partial<{ roomNumber: string; roomTypeId: string; floorNumber: number | null; capacity: number; isShadowInventory: boolean; isBlocked: boolean; blockedReason: string | null }>,
  actorId: string,
) {
  const existing = await prisma.room.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Room");

  // Validate roomNumber change — must be non-empty and not collide with another room.
  let newRoomNumber: string | undefined;
  if (input.roomNumber !== undefined) {
    newRoomNumber = input.roomNumber.trim();
    if (!newRoomNumber) throw new ValidationError("roomNumber is required");
    if (newRoomNumber !== existing.roomNumber) {
      const conflict = await prisma.room.findUnique({ where: { roomNumber: newRoomNumber } });
      if (conflict) {
        throw new ValidationError(
          `Room number "${newRoomNumber}" already exists. Pick a different number.`,
        );
      }
    }
  }

  // Validate roomTypeId change.
  if (input.roomTypeId !== undefined && input.roomTypeId !== existing.roomTypeId) {
    const roomType = await prisma.roomType.findUnique({ where: { id: input.roomTypeId } });
    if (!roomType) throw new NotFoundError("RoomType");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.room.update({
        where: { id },
        data: {
          roomNumber: newRoomNumber,
          roomTypeId: input.roomTypeId,
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
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
      throw new ValidationError(
        `Room number "${newRoomNumber ?? input.roomNumber}" already exists. Pick a different number.`,
      );
    }
    throw e;
  }
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

/** Mark a room as deficient. Category must be one of the active `deficientCondition.categories`. */
export async function markRoomDeficient(
  prisma: PrismaClient,
  roomId: string,
  input: { category: string; description: string; resolutionDeadline?: string | Date },
  actorId: string,
) {
  const description = input.description?.trim();
  if (!description) throw new ValidationError("description is required");

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new NotFoundError("Room");
  if (room.isDeficient) throw new ValidationError("Room is already deficient");
  if (room.isBlocked) throw new ValidationError("Room is blocked");

  // Validate the category against the admin-managed categories config.
  const catsRow = await getActiveConfigEntry(prisma, "deficientCondition.categories");
  const allowed = Array.isArray(catsRow?.configValue)
    ? (catsRow!.configValue as Array<{ code: string; isActive?: boolean }>).filter((c) => c.isActive !== false).map((c) => c.code)
    : [];
  if (allowed.length && !allowed.includes(input.category)) {
    throw new ValidationError(`Category "${input.category}" is not in the active deficient categories list`);
  }

  // Policy registry override: `registry.deficientResolution.deadlineHours` takes precedence over
  // the legacy `deficientResolution.deadlineHours` ConfigurationEntry. Defaults to 48h if neither.
  const deficientPolicy = await getRegistryPolicy(prisma, "registry.deficientResolution.deadlineHours");
  const registryHours =
    deficientPolicy && deficientPolicy.enabled !== false && typeof deficientPolicy.hours === "number"
      ? (deficientPolicy.hours as number)
      : null;
  const deadlineRow = registryHours === null ? await getActiveConfigEntry(prisma, "deficientResolution.deadlineHours") : null;
  const defaultHours = registryHours ?? Number(deadlineRow?.configValue ?? 48);
  const now = new Date();
  const deadline = input.resolutionDeadline ? new Date(input.resolutionDeadline) : new Date(now.getTime() + defaultHours * 3600 * 1000);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) {
    throw new ValidationError("resolutionDeadline must be a future timestamp");
  }

  return prisma.$transaction(async (tx) => {
    const record = await tx.deficientConditionRecord.create({
      data: {
        roomId,
        category: input.category as any,
        description,
        detectedAt: now,
        detectedBy: actorId,
        resolutionDeadline: deadline,
        status: "UNRESOLVED",
      },
    });
    const updatedRoom = await tx.room.update({
      where: { id: roomId },
      data: {
        isDeficient: true,
        deficientConditionCategory: input.category as any,
        deficientSince: now,
        deficientDeadline: deadline,
        updatedAt: now,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ROOM.MARKED_DEFICIENT",
      entityType: "Room",
      entityId: roomId,
      operation: "UPDATE",
      payload: {
        roomNumber: updatedRoom.roomNumber,
        category: input.category,
        description,
        resolutionDeadline: deadline.toISOString(),
        deficientConditionRecordId: record.id,
      },
    });
    return { room: updatedRoom, record };
  });
}

/** Resolve the latest unresolved deficient record on a room and clear its deficient state. */
export async function resolveRoomDeficient(
  prisma: PrismaClient,
  roomId: string,
  actorId: string,
  resolutionNotes?: string,
) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new NotFoundError("Room");
  if (!room.isDeficient) throw new ValidationError("Room is not deficient");

  const open = await prisma.deficientConditionRecord.findFirst({
    where: { roomId, status: "UNRESOLVED" },
    orderBy: { detectedAt: "desc" },
  });
  if (!open) throw new NotFoundError("DeficientConditionRecord");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const record = await tx.deficientConditionRecord.update({
      where: { id: open.id },
      data: { status: "RESOLVED", resolvedAt: now, resolvedBy: actorId, resolutionNotes: resolutionNotes?.trim() || null },
    });
    const updatedRoom = await tx.room.update({
      where: { id: roomId },
      data: { isDeficient: false, deficientConditionCategory: null, deficientSince: null, deficientDeadline: null, updatedAt: now },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ROOM.DEFICIENT_RESOLVED",
      entityType: "Room",
      entityId: roomId,
      operation: "UPDATE",
      payload: { roomNumber: updatedRoom.roomNumber, deficientConditionRecordId: record.id, resolutionNotes: resolutionNotes?.trim() ?? null },
    });
    return { room: updatedRoom, record };
  });
}

/** Reactivate a previously deactivated (blocked) room. Clears the block. */
export async function reactivateRoom(prisma: PrismaClient, roomId: string, actorId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw new NotFoundError("Room");
  if (!room.isBlocked) throw new ValidationError("Room is not blocked");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.room.update({
      where: { id: roomId },
      data: { isBlocked: false, blockedReason: null, updatedAt: new Date() },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ROOM.REACTIVATED",
      entityType: "Room",
      entityId: roomId,
      operation: "UPDATE",
      payload: { roomNumber: updated.roomNumber },
    });
    return updated;
  });
}
