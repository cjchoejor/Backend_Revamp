import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { requiredControlCheck } from "../../lib/admin/required-control-check.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";

const WALK_IN_CONFIG_KEY = "availability.walkIn.ratePlanId";

const ALLOWED_TYPES = ["INDIVIDUAL", "PROMOTIONAL", "TIER", "CHANNEL", "RACK"] as const;
type RatePlanTypeLiteral = (typeof ALLOWED_TYPES)[number];

export interface RatePlanInput {
  name: string;
  description?: string | null;
  roomTypeId?: string | null;
  type?: RatePlanTypeLiteral;
  baseRate: number;
  currency?: string;
  msr?: number | null;
  overrideMargin?: number | null;
}

export async function listRatePlans(prisma: PrismaClient, includeInactive = false) {
  return prisma.ratePlanRegistry.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: "asc" },
  });
}

export async function getRatePlan(prisma: PrismaClient, id: string) {
  const row = await prisma.ratePlanRegistry.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("RatePlanRegistry");
  return row;
}

export async function createRatePlan(prisma: PrismaClient, input: RatePlanInput, actorId: string) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("name is required");
  await requiredControlCheck({ surfaceName: "RatePlanRegistry", proposedChange: input, operationType: "CREATE", actorId });

  return prisma.$transaction(async (tx) => {
    const created = await tx.ratePlanRegistry.create({
      data: {
        name,
        description: input.description?.trim() || null,
        roomTypeId: input.roomTypeId || null,
        type: input.type ?? "INDIVIDUAL",
        baseRate: input.baseRate as unknown as Prisma.Decimal,
        currency: input.currency?.trim() || "BTN",
        msr: input.msr == null ? null : (input.msr as unknown as Prisma.Decimal),
        overrideMargin: input.overrideMargin == null ? null : (input.overrideMargin as unknown as Prisma.Decimal),
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.RATE_PLAN_CREATED",
      entityType: "RatePlanRegistry",
      entityId: created.id,
      operation: "CREATE",
      payload: { name },
    });
    return created;
  });
}

export async function updateRatePlan(
  prisma: PrismaClient,
  id: string,
  input: Partial<RatePlanInput>,
  actorId: string,
) {
  const existing = await prisma.ratePlanRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("RatePlanRegistry");
  await requiredControlCheck({
    surfaceName: "RatePlanRegistry",
    proposedChange: { ...existing, ...input },
    currentValue: existing,
    operationType: "UPDATE",
    actorId,
  });

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "RatePlanRegistry", entityId: id, actorId });
    const updated = await tx.ratePlanRegistry.update({
      where: { id },
      data: {
        description: input.description === undefined ? undefined : input.description?.trim() || null,
        roomTypeId: input.roomTypeId === undefined ? undefined : input.roomTypeId || null,
        type: input.type === undefined ? undefined : input.type,
        baseRate: input.baseRate === undefined ? undefined : (input.baseRate as unknown as Prisma.Decimal),
        currency: input.currency === undefined ? undefined : input.currency?.trim() || "BTN",
        msr:
          input.msr === undefined
            ? undefined
            : input.msr == null
              ? null
              : (input.msr as unknown as Prisma.Decimal),
        overrideMargin:
          input.overrideMargin === undefined
            ? undefined
            : input.overrideMargin == null
              ? null
              : (input.overrideMargin as unknown as Prisma.Decimal),
        version: { increment: 1 },
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.RATE_PLAN_UPDATED",
      entityType: "RatePlanRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function deactivateRatePlan(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.ratePlanRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("RatePlanRegistry");

  const walkIn = await getActiveConfigEntry(prisma, WALK_IN_CONFIG_KEY);
  if (walkIn && walkIn.configValue === id) {
    throw new ValidationError("Cannot deactivate the rate plan currently designated as walk-in");
  }

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "RatePlanRegistry", entityId: id, actorId });
    const updated = await tx.ratePlanRegistry.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.RATE_PLAN_DEACTIVATED",
      entityType: "RatePlanRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function reactivateRatePlan(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.ratePlanRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("RatePlanRegistry");
  if (existing.isActive) throw new ValidationError("Rate plan is already active");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "RatePlanRegistry", entityId: id, actorId });
    const updated = await tx.ratePlanRegistry.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.RATE_PLAN_REACTIVATED",
      entityType: "RatePlanRegistry",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function getWalkInRatePlan(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, WALK_IN_CONFIG_KEY);
  const ratePlanId = row?.configValue ? String(row.configValue) : null;
  if (!ratePlanId) return { ratePlanId: null, ratePlan: null };
  const ratePlan = await prisma.ratePlanRegistry.findUnique({ where: { id: ratePlanId } });
  return { ratePlanId, ratePlan };
}

export async function setWalkInRatePlan(prisma: PrismaClient, ratePlanId: string, actorId: string) {
  const ratePlan = await prisma.ratePlanRegistry.findUnique({ where: { id: ratePlanId } });
  if (!ratePlan) throw new NotFoundError("RatePlanRegistry");
  if (!ratePlan.isActive) throw new ValidationError("Cannot designate an inactive rate plan as walk-in");

  return prisma.$transaction((tx) =>
    supersedeConfigurationEntry(tx, {
      configKey: WALK_IN_CONFIG_KEY,
      configValue: ratePlanId,
      actorId,
      notes: `Walk-in rate plan set to ${ratePlan.name}`,
    }),
  );
}
