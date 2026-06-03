import type { Prisma, PrismaClient } from "@prisma/client";
import { ModeLifecycleState } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { invalidatePolicyRegistryCache } from "../../lib/policy-registry-runtime.js";

export async function listModes(prisma: PrismaClient) {
  return prisma.modeConfiguration.findMany({ orderBy: [{ modeKey: "asc" }, { version: "desc" }] });
}

export async function getMode(prisma: PrismaClient, id: string) {
  const row = await prisma.modeConfiguration.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("ModeConfiguration");
  return row;
}

export async function saveMode(
  prisma: PrismaClient,
  input: {
    id?: string;
    modeKey: string;
    displayName: string;
    description?: string | null;
    isPredefined?: boolean;
    stageRoute: string[];
    autoFulfilmentConditions: { stage: string; condition: string }[];
    featureDependencies: string[];
  },
  actorId: string,
) {
  const modeKey = input.modeKey.trim();
  const displayName = input.displayName.trim();
  if (!modeKey || !displayName) throw new ValidationError("modeKey and displayName are required");

  return prisma.$transaction(async (tx) => {
    if (input.id) {
      const existing = await tx.modeConfiguration.findUnique({ where: { id: input.id } });
      if (!existing) throw new NotFoundError("ModeConfiguration");
      if (existing.isPredefined && existing.modeKey !== modeKey) {
        throw new ValidationError("Cannot change modeKey on a predefined mode");
      }
      if (existing.lifecycleState === ModeLifecycleState.SUPERSEDED) {
        throw new ValidationError("Cannot update a superseded mode");
      }

      const updated = await tx.modeConfiguration.update({
        where: { id: input.id },
        data: {
          displayName,
          description: input.description?.trim() || null,
          stageRoute: input.stageRoute as Prisma.InputJsonValue,
          autoFulfilmentConditions: input.autoFulfilmentConditions as unknown as Prisma.InputJsonValue,
          featureDependencies: input.featureDependencies as Prisma.InputJsonValue,
          lifecycleState: ModeLifecycleState.VALIDATED,
          version: { increment: 1 },
          createdBy: actorId,
        },
      });
      await writeAdminAuditEvent(tx, {
        actorId,
        eventType: "ADMIN.MODE_SAVED",
        entityType: "ModeConfiguration",
        entityId: updated.id,
        operation: "UPDATE",
        payload: { modeKey: updated.modeKey, lifecycleState: updated.lifecycleState },
      });
      return updated;
    }

    const created = await tx.modeConfiguration.create({
      data: {
        modeKey,
        displayName,
        description: input.description?.trim() || null,
        lifecycleState: ModeLifecycleState.VALIDATED,
        isActive: false,
        isPredefined: input.isPredefined ?? false,
        stageRoute: input.stageRoute as Prisma.InputJsonValue,
        autoFulfilmentConditions: input.autoFulfilmentConditions as unknown as Prisma.InputJsonValue,
        featureDependencies: input.featureDependencies as Prisma.InputJsonValue,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.MODE_SAVED",
      entityType: "ModeConfiguration",
      entityId: created.id,
      operation: "CREATE",
      payload: { modeKey: created.modeKey, lifecycleState: created.lifecycleState },
    });
    return created;
  });
}

export async function activateMode(prisma: PrismaClient, id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.modeConfiguration.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("ModeConfiguration");
    if (existing.lifecycleState !== ModeLifecycleState.VALIDATED && existing.lifecycleState !== ModeLifecycleState.ACTIVE) {
      throw new ValidationError("Mode must be VALIDATED before activation");
    }

    await tx.modeConfiguration.updateMany({
      where: { modeKey: existing.modeKey, isActive: true, id: { not: id } },
      data: { isActive: false, lifecycleState: ModeLifecycleState.SUPERSEDED },
    });

    const updated = await tx.modeConfiguration.update({
      where: { id },
      data: { isActive: true, lifecycleState: ModeLifecycleState.ACTIVE, createdBy: actorId },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.MODE_ACTIVATED",
      entityType: "ModeConfiguration",
      entityId: id,
      operation: "UPDATE",
      payload: { modeKey: updated.modeKey },
    });
    return updated;
  });
}

export async function deactivateMode(prisma: PrismaClient, id: string, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.modeConfiguration.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("ModeConfiguration");

    const updated = await tx.modeConfiguration.update({
      where: { id },
      data: {
        isActive: false,
        lifecycleState: existing.isPredefined ? ModeLifecycleState.ACTIVE : ModeLifecycleState.SUPERSEDED,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.MODE_DEACTIVATED",
      entityType: "ModeConfiguration",
      entityId: id,
      operation: "UPDATE",
      payload: { modeKey: updated.modeKey },
    });
    return updated;
  });
}

export async function listPolicies(prisma: PrismaClient, input?: { policyId?: string; activeOnly?: boolean }) {
  return prisma.policyRegistry.findMany({
    where: {
      policyId: input?.policyId,
      isActive: input?.activeOnly ? true : undefined,
    },
    orderBy: [{ policyId: "asc" }, { version: "desc" }],
  });
}

export async function savePolicy(
  prisma: PrismaClient,
  input: { policyId: string; policyClass: string; policyDefinition: Prisma.InputJsonValue },
  actorId: string,
) {
  const policyId = input.policyId.trim();
  const policyClass = input.policyClass.trim();
  if (!policyId || !policyClass) throw new ValidationError("policyId and policyClass are required");

  const created = await prisma.$transaction(async (tx) => {
    const latest = await tx.policyRegistry.findFirst({
      where: { policyId },
      orderBy: { version: "desc" },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    if (latest?.isActive) {
      await tx.policyRegistry.update({
        where: { id: latest.id },
        data: { isActive: false },
      });
    }

    const created = await tx.policyRegistry.create({
      data: {
        policyId,
        policyClass,
        policyDefinition: input.policyDefinition,
        version: nextVersion,
        isActive: true,
        createdBy: actorId,
      },
    });

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.POLICY_SAVED",
      entityType: "PolicyRegistry",
      entityId: created.id,
      operation: "CREATE",
      payload: { policyId, version: nextVersion },
    });

    return created;
  });

  invalidatePolicyRegistryCache(policyId);
  return created;
}

export async function deactivatePolicy(prisma: PrismaClient, policyId: string, actorId: string) {
  const updated = await prisma.$transaction(async (tx) => {
    const active = await tx.policyRegistry.findFirst({
      where: { policyId, isActive: true },
      orderBy: { version: "desc" },
    });
    if (!active) throw new NotFoundError("PolicyRegistry");

    const result = await tx.policyRegistry.update({
      where: { id: active.id },
      data: { isActive: false },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.POLICY_DEACTIVATED",
      entityType: "PolicyRegistry",
      entityId: active.id,
      operation: "UPDATE",
      payload: { policyId, version: active.version },
    });
    return result;
  });

  invalidatePolicyRegistryCache(policyId);
  return updated;
}
