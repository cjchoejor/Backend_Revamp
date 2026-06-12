import type { PrismaClient } from "@prisma/client";
import { ActorLevel } from "@prisma/client";
import bcrypt from "bcryptjs";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

const LEVELS: ActorLevel[] = [ActorLevel.L1, ActorLevel.L2, ActorLevel.L3, ActorLevel.L4];

export async function listStaff(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.staffUser.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: { fullName: "asc" },
    select: {
      id: true,
      fullName: true,
      email: true,
      actorLevel: true,
      role: true,
      idleThresholdSeconds: true,
      hardLogoutThresholdSeconds: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getStaff(prisma: PrismaClient, id: string) {
  const row = await prisma.staffUser.findUnique({
    where: { id },
    select: {
      id: true,
      fullName: true,
      email: true,
      actorLevel: true,
      role: true,
      idleThresholdSeconds: true,
      hardLogoutThresholdSeconds: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new NotFoundError("StaffUser");
  return row;
}

export async function createStaff(
  prisma: PrismaClient,
  input: {
    fullName: string;
    email?: string | null;
    actorLevel: ActorLevel;
    role: string;
    pin: string;
    idleThresholdSeconds?: number;
    hardLogoutThresholdSeconds?: number;
  },
  actorId: string,
) {
  if (!input.fullName.trim()) throw new ValidationError("fullName is required");
  if (!input.role.trim()) throw new ValidationError("role is required");
  if (!input.pin || input.pin.length < 4) throw new ValidationError("pin must be at least 4 characters");
  if (!LEVELS.includes(input.actorLevel)) throw new ValidationError("invalid actorLevel");

  const idle = input.idleThresholdSeconds ?? 600;
  const hard = input.hardLogoutThresholdSeconds ?? 28800;
  if (idle <= 0 || hard <= 0 || idle >= hard) {
    throw new ValidationError("idleThresholdSeconds must be positive and less than hardLogoutThresholdSeconds");
  }

  const pinHash = await bcrypt.hash(input.pin, 10);

  return prisma.$transaction(async (tx) => {
    const created = await tx.staffUser.create({
      data: {
        fullName: input.fullName.trim(),
        email: input.email?.trim() || null,
        actorLevel: input.actorLevel,
        role: input.role.trim(),
        pinHash,
        idleThresholdSeconds: idle,
        hardLogoutThresholdSeconds: hard,
        isActive: true,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        actorLevel: true,
        role: true,
        idleThresholdSeconds: true,
        hardLogoutThresholdSeconds: true,
        isActive: true,
        createdAt: true,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_CREATED",
      entityType: "StaffUser",
      entityId: created.id,
      operation: "CREATE",
      payload: { staffId: created.id, actorLevel: created.actorLevel, role: created.role },
    });

    return created;
  });
}

export async function updateStaff(
  prisma: PrismaClient,
  id: string,
  input: {
    fullName?: string;
    email?: string | null;
    actorLevel?: ActorLevel;
    role?: string;
    idleThresholdSeconds?: number;
    hardLogoutThresholdSeconds?: number;
  },
  actorId: string,
) {
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("StaffUser");

  const idle = input.idleThresholdSeconds ?? existing.idleThresholdSeconds;
  const hard = input.hardLogoutThresholdSeconds ?? existing.hardLogoutThresholdSeconds;
  if (idle <= 0 || hard <= 0 || idle >= hard) {
    throw new ValidationError("idleThresholdSeconds must be positive and less than hardLogoutThresholdSeconds");
  }

  if (input.actorLevel && !LEVELS.includes(input.actorLevel)) {
    throw new ValidationError("invalid actorLevel");
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "StaffUser", entityId: id, actorId });
    const updated = await tx.staffUser.update({
      where: { id },
      data: {
        fullName: input.fullName?.trim() ?? undefined,
        email: input.email === undefined ? undefined : input.email?.trim() || null,
        actorLevel: input.actorLevel,
        role: input.role?.trim(),
        idleThresholdSeconds: input.idleThresholdSeconds,
        hardLogoutThresholdSeconds: input.hardLogoutThresholdSeconds,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        actorLevel: true,
        role: true,
        idleThresholdSeconds: true,
        hardLogoutThresholdSeconds: true,
        isActive: true,
        updatedAt: true,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_UPDATED",
      entityType: "StaffUser",
      entityId: id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      },
    });

    return updated;
  });
}

export async function resetStaffPin(prisma: PrismaClient, id: string, newPin: string, actorId: string) {
  if (!newPin || newPin.length < 4) throw new ValidationError("pin must be at least 4 characters");
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("StaffUser");

  const pinHash = await bcrypt.hash(newPin, 10);

  return prisma.$transaction(async (tx) => {
    await tx.staffUser.update({ where: { id }, data: { pinHash } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_PIN_RESET",
      entityType: "StaffUser",
      entityId: id,
      operation: "UPDATE",
      payload: { staffId: id },
    });
    return { id, pinReset: true };
  });
}

export async function deactivateStaff(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("StaffUser");
  if (!existing.isActive) return existing;

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "StaffUser", entityId: id, actorId });
    const updated = await tx.staffUser.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true, fullName: true },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_DEACTIVATED",
      entityType: "StaffUser",
      entityId: id,
      operation: "UPDATE",
      payload: { staffId: id },
    });
    return updated;
  });
}
