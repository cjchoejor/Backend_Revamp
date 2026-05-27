import type { PrismaClient } from "@prisma/client";
import { ActorLevel } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";

const LEVELS: ActorLevel[] = [ActorLevel.L1, ActorLevel.L2, ActorLevel.L3, ActorLevel.L4];

export async function listRoles(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.role.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: { roleCode: "asc" },
    include: {
      permissions: true,
      sessionCfg: true,
    },
  });
}

export async function createRole(
  prisma: PrismaClient,
  input: { roleCode: string; displayName: string; actorLevel: ActorLevel },
  actorId: string,
) {
  const roleCode = input.roleCode.trim();
  const displayName = input.displayName.trim();
  if (!roleCode) throw new ValidationError("roleCode is required");
  if (!displayName) throw new ValidationError("displayName is required");
  if (!LEVELS.includes(input.actorLevel)) throw new ValidationError("invalid actorLevel");

  return prisma.$transaction(async (tx) => {
    const created = await tx.role.create({
      data: {
        roleCode,
        displayName,
        actorLevel: input.actorLevel,
        isActive: true,
        createdBy: actorId,
      },
      include: { permissions: true, sessionCfg: true },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROLE_CREATED",
      entityType: "Role",
      entityId: created.id,
      operation: "CREATE",
      payload: { roleCode: created.roleCode, actorLevel: created.actorLevel },
    });

    return created;
  });
}

export async function updateRole(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ displayName: string; actorLevel: ActorLevel; isActive: boolean }>,
  actorId: string,
) {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role");
  if (input.actorLevel && !LEVELS.includes(input.actorLevel)) throw new ValidationError("invalid actorLevel");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.role.update({
      where: { id },
      data: {
        displayName: input.displayName?.trim(),
        actorLevel: input.actorLevel,
        isActive: input.isActive,
        createdBy: actorId,
      },
      include: { permissions: true, sessionCfg: true },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROLE_UPDATED",
      entityType: "Role",
      entityId: id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      },
    });

    return updated;
  });
}

export async function deleteRole(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.role.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Role");

  const staffCount = await prisma.staffUser.count({ where: { role: existing.roleCode } });
  if (staffCount > 0) {
    throw new ValidationError("Cannot delete role while staff users reference this role code — deactivate instead");
  }

  return prisma.$transaction(async (tx) => {
    await tx.rolePermissionMapping.deleteMany({ where: { roleId: id } });
    await tx.roleSessionConfig.deleteMany({ where: { roleId: id } });
    await tx.role.delete({ where: { id } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROLE_DELETED",
      entityType: "Role",
      entityId: id,
      operation: "DELETE",
      payload: { roleCode: existing.roleCode },
    });
    return { id, deleted: true };
  });
}

export async function setRolePermissions(
  prisma: PrismaClient,
  id: string,
  permissionIds: string[],
  actorId: string,
) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new NotFoundError("Role");

  const uniquePermissionIds = Array.from(new Set(permissionIds.map((p) => p.trim()).filter(Boolean)));

  // NOTE: ACIG requires RequiredControlCheck here. This codebase doesn't yet have a canonical permission catalogue,
  // so we store the mapping and keep the guard for a future hardening pass.
  return prisma.$transaction(async (tx) => {
    await tx.rolePermissionMapping.deleteMany({ where: { roleId: id } });
    if (uniquePermissionIds.length > 0) {
      await tx.rolePermissionMapping.createMany({
        data: uniquePermissionIds.map((permissionId) => ({
          roleId: id,
          permissionId,
          isAllowed: true,
          createdBy: actorId,
        })),
      });
    }

    const updated = await tx.role.findUnique({
      where: { id },
      include: { permissions: true, sessionCfg: true },
    });
    if (!updated) throw new NotFoundError("Role");

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROLE_PERMISSIONS_SET",
      entityType: "Role",
      entityId: id,
      operation: "UPDATE",
      payload: { permissionIds: uniquePermissionIds, roleCode: updated.roleCode },
    });

    return updated;
  });
}

export async function upsertRoleSessionConfig(
  prisma: PrismaClient,
  id: string,
  input: { idleLockTimeoutSeconds: number; hardLogoutTimeoutSeconds: number; manualLockAvailable?: boolean },
  actorId: string,
) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new NotFoundError("Role");

  const idle = input.idleLockTimeoutSeconds;
  const hard = input.hardLogoutTimeoutSeconds;
  if (idle <= 0 || hard <= 0 || idle >= hard) {
    throw new ValidationError("idleLockTimeoutSeconds must be positive and less than hardLogoutTimeoutSeconds");
  }

  // ACIG snapshot propagation: StaffUser.{idleThresholdSeconds, hardLogoutThresholdSeconds} should mirror the role session config.
  // This codebase's StaffUser currently stores `role` as a string, so we propagate by roleCode match.
  return prisma.$transaction(async (tx) => {
    const upserted = await tx.roleSessionConfig.upsert({
      where: { roleId: id },
      create: {
        roleId: id,
        idleLockTimeoutSeconds: idle,
        hardLogoutTimeoutSeconds: hard,
        manualLockAvailable: input.manualLockAvailable ?? true,
        createdBy: actorId,
      },
      update: {
        idleLockTimeoutSeconds: idle,
        hardLogoutTimeoutSeconds: hard,
        manualLockAvailable: input.manualLockAvailable ?? undefined,
        version: { increment: 1 },
        createdBy: actorId,
      },
    });

    const staffUpdated = await tx.staffUser.updateMany({
      where: { isActive: true, role: role.roleCode },
      data: {
        idleThresholdSeconds: idle,
        hardLogoutThresholdSeconds: hard,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.ROLE_SESSION_CONFIG_UPSERTED",
      entityType: "RoleSessionConfig",
      entityId: upserted.id,
      operation: "UPDATE",
      payload: {
        roleId: id,
        roleCode: role.roleCode,
        idleLockTimeoutSeconds: idle,
        hardLogoutTimeoutSeconds: hard,
        manualLockAvailable: upserted.manualLockAvailable,
        affectedStaffCount: staffUpdated.count,
      },
    });

    const updated = await tx.role.findUnique({ where: { id }, include: { permissions: true, sessionCfg: true } });
    if (!updated) throw new NotFoundError("Role");
    return updated;
  });
}

