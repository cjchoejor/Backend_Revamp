import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { requiredControlCheck } from "../../lib/admin/required-control-check.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

const MIRROR_KEY = "cancellation.policyTiers";

export interface CancellationPolicyInput {
  name: string;
  penaltyTiers: Prisma.InputJsonValue;
  noShowTreatment: string;
}

export async function listPolicies(prisma: PrismaClient, includeInactive = false) {
  return prisma.cancellationPolicyRegistry.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function getPolicy(prisma: PrismaClient, id: string) {
  const row = await prisma.cancellationPolicyRegistry.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("CancellationPolicyRegistry");
  return row;
}

export async function createPolicy(prisma: PrismaClient, input: CancellationPolicyInput, actorId: string) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("name is required");
  await requiredControlCheck({ surfaceName: "CancellationPolicyRegistry", proposedChange: input, operationType: "CREATE", actorId });

  return prisma.$transaction(async (tx) => {
    const created = await tx.cancellationPolicyRegistry.create({
      data: {
        name,
        penaltyTiers: input.penaltyTiers,
        noShowTreatment: input.noShowTreatment.trim(),
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CANCELLATION_POLICY_CREATED",
      entityType: "CancellationPolicyRegistry",
      entityId: created.id,
      operation: "CREATE",
      payload: { name },
    });
    await supersedeConfigurationEntry(tx, {
      configKey: MIRROR_KEY,
      configValue: input.penaltyTiers,
      actorId,
      notes: `Mirror of cancellation policy "${name}"`,
    });
    return created;
  });
}

export async function updatePolicy(
  prisma: PrismaClient,
  id: string,
  input: Partial<CancellationPolicyInput>,
  actorId: string,
) {
  const existing = await prisma.cancellationPolicyRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CancellationPolicyRegistry");
  const merged = { ...existing, ...input };
  await requiredControlCheck({ surfaceName: "CancellationPolicyRegistry", proposedChange: merged, currentValue: existing, operationType: "UPDATE", actorId });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.cancellationPolicyRegistry.update({
      where: { id },
      data: {
        name: input.name === undefined ? undefined : input.name.trim(),
        penaltyTiers: input.penaltyTiers === undefined ? undefined : input.penaltyTiers,
        noShowTreatment: input.noShowTreatment === undefined ? undefined : input.noShowTreatment.trim(),
        version: { increment: 1 },
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CANCELLATION_POLICY_UPDATED",
      entityType: "CancellationPolicyRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    if (input.penaltyTiers !== undefined && updated.isActive) {
      await supersedeConfigurationEntry(tx, {
        configKey: MIRROR_KEY,
        configValue: input.penaltyTiers,
        actorId,
        notes: `Mirror of cancellation policy "${updated.name}"`,
      });
    }
    return updated;
  });
}

export async function deactivatePolicy(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.cancellationPolicyRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CancellationPolicyRegistry");

  return prisma.$transaction(async (tx) => {
    const updated = await tx.cancellationPolicyRegistry.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CANCELLATION_POLICY_DEACTIVATED",
      entityType: "CancellationPolicyRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function reactivatePolicy(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.cancellationPolicyRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CancellationPolicyRegistry");
  if (existing.isActive) throw new ValidationError("Cancellation policy is already active");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.cancellationPolicyRegistry.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CANCELLATION_POLICY_REACTIVATED",
      entityType: "CancellationPolicyRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}
