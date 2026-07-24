import type { PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { allocateReadableId } from "../../lib/readable-id.js";

export async function listDepartments(prisma: PrismaClient, input?: { includeInactive?: boolean }) {
  return prisma.department.findMany({
    where: input?.includeInactive ? undefined : { isActive: true },
    orderBy: { departmentName: "asc" },
  });
}

export async function createDepartment(
  prisma: PrismaClient,
  input: { departmentCode: string; departmentName: string },
  actorId: string,
) {
  const departmentCode = input.departmentCode.trim();
  const departmentName = input.departmentName.trim();
  if (!departmentCode) throw new ValidationError("departmentCode is required");
  if (!departmentName) throw new ValidationError("departmentName is required");

  // Reject a duplicate code with a clear message rather than letting the unique
  // constraint surface as a raw 500 (the DB constraint remains the backstop).
  const existingWithCode = await prisma.department.findFirst({ where: { departmentCode } });
  if (existingWithCode) throw new ValidationError(`Department code "${departmentCode}" already exists`);

  return prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "DEPARTMENT" as const);
    const created = await tx.department.create({
      data: {
        id,
        departmentCode,
        departmentName,
        isActive: true,
        createdBy: actorId,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.DEPARTMENT_CREATED",
      entityType: "Department",
      entityId: created.id,
      operation: "CREATE",
      payload: { departmentCode, departmentName },
    });

    return created;
  });
}

export async function updateDepartment(
  prisma: PrismaClient,
  id: string,
  input: Partial<{ expectedVersion: number; departmentName: string; isActive: boolean }>,
  actorId: string,
) {
  const existing = await prisma.department.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Department");

  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw new ValidationError("Department was updated concurrently — refresh and retry");
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "Department", entityId: id, actorId });
    const updated = await tx.department.update({
      where: { id },
      data: {
        departmentName: input.departmentName?.trim(),
        isActive: input.isActive,
        version: { increment: 1 },
        createdBy: actorId,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.DEPARTMENT_UPDATED",
      entityType: "Department",
      entityId: id,
      operation: "UPDATE",
      payload: {
        fieldsChanged: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
        newVersion: updated.version,
      },
    });

    return updated;
  });
}

