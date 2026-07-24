import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

export interface PackageInput {
  name: string;
  description?: string | null;
  inclusions: Prisma.InputJsonValue;
  priceAdjustment?: number | null;
  currency?: string;
}

export async function listPackages(prisma: PrismaClient, includeInactive = false) {
  return prisma.packageRegistry.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function getPackage(prisma: PrismaClient, id: string) {
  const row = await prisma.packageRegistry.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("PackageRegistry");
  return row;
}

export async function createPackage(prisma: PrismaClient, input: PackageInput, actorId: string) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("name is required");

  return prisma.$transaction(async (tx) => {
    const created = await tx.packageRegistry.create({
      data: {
        name,
        description: input.description?.trim() || null,
        inclusions: input.inclusions,
        priceAdjustment: input.priceAdjustment == null ? null : (input.priceAdjustment as unknown as Prisma.Decimal),
        currency: input.currency?.trim() || "BTN",
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.PACKAGE_CREATED",
      entityType: "PackageRegistry",
      entityId: created.id,
      operation: "CREATE",
      payload: { name },
    });
    return created;
  });
}

export async function updatePackage(prisma: PrismaClient, id: string, input: Partial<PackageInput>, actorId: string) {
  const existing = await prisma.packageRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("PackageRegistry");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "PackageRegistry", entityId: id, actorId });
    const updated = await tx.packageRegistry.update({
      where: { id },
      data: {
        name: input.name === undefined ? undefined : input.name.trim(),
        description: input.description === undefined ? undefined : input.description?.trim() || null,
        inclusions: input.inclusions === undefined ? undefined : input.inclusions,
        priceAdjustment:
          input.priceAdjustment === undefined
            ? undefined
            : input.priceAdjustment == null
              ? null
              : (input.priceAdjustment as unknown as Prisma.Decimal),
        currency: input.currency === undefined ? undefined : input.currency?.trim() || "BTN",
        version: { increment: 1 },
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.PACKAGE_UPDATED",
      entityType: "PackageRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function deactivatePackage(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.packageRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("PackageRegistry");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "PackageRegistry", entityId: id, actorId });
    const updated = await tx.packageRegistry.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.PACKAGE_DEACTIVATED",
      entityType: "PackageRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function reactivatePackage(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.packageRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("PackageRegistry");
  if (existing.isActive) throw new ValidationError("Package is already active");
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "PackageRegistry", entityId: id, actorId });
    const updated = await tx.packageRegistry.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.PACKAGE_REACTIVATED",
      entityType: "PackageRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}
