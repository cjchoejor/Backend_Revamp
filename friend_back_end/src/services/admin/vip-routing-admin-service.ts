import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

export async function listVipRoutings(prisma: PrismaClient) {
  return prisma.vipNotificationRoutingConfig.findMany({
    orderBy: { vipTier: "asc" },
  });
}

export async function saveVipRouting(
  prisma: PrismaClient,
  input: {
    vipTier: string;
    notifyRoles: Prisma.InputJsonValue;
    notifyActorIds: Prisma.InputJsonValue;
    isActive?: boolean;
  },
  actorId: string,
) {
  const vipTier = input.vipTier.trim();
  if (!vipTier) throw new ValidationError("vipTier is required");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vipNotificationRoutingConfig.findFirst({
      where: { vipTier, isActive: true },
    });

    if (existing) {
      await captureSnapshotTx(tx, { entityType: "VipNotificationRoutingConfig", entityId: existing.id, actorId });
      await tx.vipNotificationRoutingConfig.update({
        where: { id: existing.id },
        data: { isActive: false },
      });
    }

    const created = await tx.vipNotificationRoutingConfig.create({
      data: {
        vipTier,
        notifyRoles: input.notifyRoles,
        notifyActorIds: input.notifyActorIds,
        isActive: input.isActive ?? true,
        createdBy: actorId,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.VIP_ROUTING_SAVED",
      entityType: "VipNotificationRoutingConfig",
      entityId: created.id,
      operation: "CREATE",
      payload: { vipTier },
    });

    return created;
  });
}

export async function deactivateVipRouting(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.vipNotificationRoutingConfig.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("VipNotificationRoutingConfig");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "VipNotificationRoutingConfig", entityId: id, actorId });
    const updated = await tx.vipNotificationRoutingConfig.update({
      where: { id },
      data: { isActive: false, createdBy: actorId },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.VIP_ROUTING_DEACTIVATED",
      entityType: "VipNotificationRoutingConfig",
      entityId: id,
      operation: "UPDATE",
      payload: { vipTier: updated.vipTier },
    });
    return updated;
  });
}

export async function reactivateVipRouting(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.vipNotificationRoutingConfig.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("VipNotificationRoutingConfig");
  if (existing.isActive) throw new ValidationError("Routing is already active");
  // Active routings are unique per tier; deactivate any conflict before reactivating this one.
  const conflict = await prisma.vipNotificationRoutingConfig.findFirst({
    where: { vipTier: existing.vipTier, isActive: true, id: { not: id } },
  });
  return prisma.$transaction(async (tx) => {
    if (conflict) {
      await captureSnapshotTx(tx, { entityType: "VipNotificationRoutingConfig", entityId: conflict.id, actorId });
      await tx.vipNotificationRoutingConfig.update({ where: { id: conflict.id }, data: { isActive: false } });
    }
    await captureSnapshotTx(tx, { entityType: "VipNotificationRoutingConfig", entityId: id, actorId });
    const updated = await tx.vipNotificationRoutingConfig.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.VIP_ROUTING_REACTIVATED",
      entityType: "VipNotificationRoutingConfig",
      entityId: id,
      operation: "UPDATE",
      payload: { vipTier: updated.vipTier, supersededRoutingId: conflict?.id ?? null },
    });
    return updated;
  });
}
