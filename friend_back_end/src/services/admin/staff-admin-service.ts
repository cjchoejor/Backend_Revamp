import type { PrismaClient } from "@prisma/client";
import { ActorLevel } from "@prisma/client";
import bcrypt from "bcryptjs";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { allocateReadableId } from "../../lib/readable-id.js";

const LEVELS: ActorLevel[] = [ActorLevel.L1, ActorLevel.L2, ActorLevel.L3, ActorLevel.L4];

const STAFF_SELECT = {
  id: true,
  fullName: true,
  username: true,
  email: true,
  actorLevel: true,
  role: true,
  roleId: true,
  roleRef: { select: { id: true, roleCode: true, displayName: true, actorLevel: true } },
  idleThresholdSeconds: true,
  hardLogoutThresholdSeconds: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function listStaff(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.staffUser.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: { fullName: "asc" },
    select: STAFF_SELECT,
  });
}

export async function getStaff(prisma: PrismaClient, id: string) {
  const row = await prisma.staffUser.findUnique({ where: { id }, select: STAFF_SELECT });
  if (!row) throw new NotFoundError("StaffUser");
  return row;
}

export async function createStaff(
  prisma: PrismaClient,
  input: {
    fullName: string;
    username: string;
    email?: string | null;
    actorLevel: ActorLevel;
    role: string;
    roleId?: string;
    pin: string;
    idleThresholdSeconds?: number;
    hardLogoutThresholdSeconds?: number;
  },
  actorId: string,
) {
  if (!input.fullName.trim()) throw new ValidationError("fullName is required");
  if (!input.username?.trim()) throw new ValidationError("username is required");
  if (!input.role.trim()) throw new ValidationError("role is required");
  // Zod already enforces "^\d{4}$" at the route boundary; belt-and-suspenders here for direct callers.
  if (!/^\d{4}$/.test(input.pin)) throw new ValidationError("pin must be exactly 4 digits");
  if (!LEVELS.includes(input.actorLevel)) throw new ValidationError("invalid actorLevel");

  const username = input.username.trim().toLowerCase();
  const idle = input.idleThresholdSeconds ?? 600;
  const hard = input.hardLogoutThresholdSeconds ?? 28800;
  if (idle <= 0 || hard <= 0 || idle >= hard) {
    throw new ValidationError("idleThresholdSeconds must be positive and less than hardLogoutThresholdSeconds");
  }

  // Reject username collision up-front with a specific error so the admin UI can highlight the field.
  const dupe = await prisma.staffUser.findUnique({ where: { username } });
  if (dupe) throw new ValidationError(`username '${username}' is already taken`);

  // If roleId is supplied, verify it exists and matches actorLevel. Prevents silent mismatch.
  if (input.roleId) {
    const roleRow = await prisma.role.findUnique({ where: { id: input.roleId } });
    if (!roleRow) throw new ValidationError("roleId not found");
    if (roleRow.actorLevel !== input.actorLevel) {
      throw new ValidationError(`role '${roleRow.roleCode}' expects actorLevel ${roleRow.actorLevel}, got ${input.actorLevel}`);
    }
  }

  const pinHash = await bcrypt.hash(input.pin, 10);

  return prisma.$transaction(async (tx) => {
    const staffId = await allocateReadableId(tx, "STAFF_USER" as const);
    const created = await tx.staffUser.create({
      data: {
        id: staffId,
        fullName: input.fullName.trim(),
        username,
        email: input.email?.trim() || null,
        actorLevel: input.actorLevel,
        role: input.role.trim(),
        roleId: input.roleId ?? null,
        pinHash,
        idleThresholdSeconds: idle,
        hardLogoutThresholdSeconds: hard,
        isActive: true,
      },
      select: STAFF_SELECT,
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_CREATED",
      entityType: "StaffUser",
      entityId: created.id,
      operation: "CREATE",
      payload: { staffId: created.id, username, actorLevel: created.actorLevel, role: created.role, roleId: created.roleId ?? null },
    });

    return created;
  });
}

export async function updateStaff(
  prisma: PrismaClient,
  id: string,
  input: {
    fullName?: string;
    username?: string;
    email?: string | null;
    actorLevel?: ActorLevel;
    role?: string;
    roleId?: string | null;
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

  // Username uniqueness check (folded to lowercase) so we can return a nice error rather than
  // letting the DB throw a P2002.
  let usernameOut: string | undefined;
  if (input.username !== undefined) {
    usernameOut = input.username.trim().toLowerCase();
    if (usernameOut !== existing.username) {
      const dupe = await prisma.staffUser.findUnique({ where: { username: usernameOut } });
      if (dupe) throw new ValidationError(`username '${usernameOut}' is already taken`);
    }
  }

  // If roleId changes, validate and ensure actorLevel matches (or use the role's level).
  const effectiveLevel = input.actorLevel ?? existing.actorLevel;
  if (input.roleId) {
    const roleRow = await prisma.role.findUnique({ where: { id: input.roleId } });
    if (!roleRow) throw new ValidationError("roleId not found");
    if (roleRow.actorLevel !== effectiveLevel) {
      throw new ValidationError(`role '${roleRow.roleCode}' expects actorLevel ${roleRow.actorLevel}, got ${effectiveLevel}`);
    }
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "StaffUser", entityId: id, actorId });
    const updated = await tx.staffUser.update({
      where: { id },
      data: {
        fullName: input.fullName?.trim() ?? undefined,
        username: usernameOut,
        email: input.email === undefined ? undefined : input.email?.trim() || null,
        actorLevel: input.actorLevel,
        role: input.role?.trim(),
        roleId: input.roleId === undefined ? undefined : input.roleId,
        idleThresholdSeconds: input.idleThresholdSeconds,
        hardLogoutThresholdSeconds: input.hardLogoutThresholdSeconds,
      },
      select: STAFF_SELECT,
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

/**
 * Safeguard: reject any action that would leave zero ACTIVE L4 admins standing. Applies to
 * deactivate / purge / demote flows so the console can never lock itself out.
 */
async function assertNotLastActiveL4(
  prisma: PrismaClient,
  targetId: string,
  targetLevel: ActorLevel,
) {
  if (targetLevel !== ActorLevel.L4) return;
  const otherActiveL4 = await prisma.staffUser.count({
    where: { id: { not: targetId }, isActive: true, actorLevel: ActorLevel.L4 },
  });
  if (otherActiveL4 === 0) {
    throw new ValidationError("Refusing to disable/delete the last active L4 admin. Create another L4 first.");
  }
}

export async function deactivateStaff(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("StaffUser");
  if (!existing.isActive) return existing;
  await assertNotLastActiveL4(prisma, id, existing.actorLevel);

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "StaffUser", entityId: id, actorId });
    const updated = await tx.staffUser.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true, fullName: true },
    });
    // Terminate any ACTIVE sessions the deactivated user still holds so they lose access on
    // their next request. Was previously left dangling — a deactivated user with a still-valid
    // JWT could keep using the app until the token expired.
    await tx.sessionRecord.updateMany({
      where: { userId: id, status: "ACTIVE" },
      data: { status: "HARD_LOGGED_OUT", hardLoggedOutAt: new Date() },
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

/**
 * Hard delete a StaffUser. This is destructive: SessionRecord + SessionEventRecord referencing
 * the user go with them (cascaded via `deleteMany` in the same tx so the FK survives). Existing
 * TraceEvent / audit rows that reference the actorId as a plain string are NOT touched — they
 * keep the ID for historical lookup even though the row no longer exists.
 *
 * Prefer `deactivateStaff` for retirements. Only use purge for typos / never-used seed rows.
 */
export async function purgeStaff(prisma: PrismaClient, id: string, actorId: string) {
  if (id === actorId) throw new ValidationError("Refusing to purge yourself. Deactivate first, then purge from another L4 account.");
  const existing = await prisma.staffUser.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("StaffUser");
  await assertNotLastActiveL4(prisma, id, existing.actorLevel);

  return prisma.$transaction(async (tx) => {
    // Session rows are FK-constrained to staff, so delete them first.
    const sessions = await tx.sessionRecord.findMany({ where: { userId: id }, select: { id: true } });
    if (sessions.length > 0) {
      const sessionIds = sessions.map((s) => s.id);
      await tx.sessionEventRecord.deleteMany({ where: { sessionId: { in: sessionIds } } });
      await tx.sessionRecord.deleteMany({ where: { id: { in: sessionIds } } });
    }
    await tx.staffUser.delete({ where: { id } });
    // Audit trace is written under the ACTOR performing the purge — the target is captured in
    // the payload so the trail survives after the row is gone.
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.STAFF_PURGED",
      entityType: "StaffUser",
      entityId: id,
      operation: "DELETE",
      payload: {
        purgedStaffId: id,
        purgedFullName: existing.fullName,
        purgedUsername: existing.username,
        purgedActorLevel: existing.actorLevel,
        purgedRole: existing.role,
      },
    });
    return { id, purged: true };
  });
}
