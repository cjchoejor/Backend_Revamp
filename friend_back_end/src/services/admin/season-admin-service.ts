import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { requiredControlCheck } from "../../lib/admin/required-control-check.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";

export interface SeasonInput {
  name: string;
  startDate: string | Date;
  endDate: string | Date;
  rateMultiplier?: number | null;
  priority?: number;
}

async function assertNoOverlap(
  prisma: PrismaClient,
  start: Date,
  end: Date,
  excludeId?: string,
) {
  const overlapping = await prisma.seasonCalendar.findFirst({
    where: {
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startDate: { lte: end },
      endDate: { gte: start },
    },
  });
  if (overlapping) {
    throw new ValidationError(`Season date range overlaps active season "${overlapping.name}"`);
  }
}

export async function listSeasons(prisma: PrismaClient, includeInactive = false) {
  return prisma.seasonCalendar.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { startDate: "asc" },
  });
}

export async function getSeason(prisma: PrismaClient, id: string) {
  const row = await prisma.seasonCalendar.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("SeasonCalendar");
  return row;
}

export async function createSeason(prisma: PrismaClient, input: SeasonInput, actorId: string) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("name is required");
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);
  await requiredControlCheck({ surfaceName: "season_calendar", proposedChange: { ...input, startDate: start, endDate: end }, operationType: "CREATE", actorId });
  await assertNoOverlap(prisma, start, end);

  return prisma.$transaction(async (tx) => {
    const created = await tx.seasonCalendar.create({
      data: {
        name,
        startDate: start,
        endDate: end,
        rateMultiplier: input.rateMultiplier == null ? null : (input.rateMultiplier as unknown as Prisma.Decimal),
        priority: input.priority ?? 0,
        createdBy: actorId,
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SEASON_CREATED",
      entityType: "SeasonCalendar",
      entityId: created.id,
      operation: "CREATE",
      payload: { name },
    });
    return created;
  });
}

export async function updateSeason(prisma: PrismaClient, id: string, input: Partial<SeasonInput>, actorId: string) {
  const existing = await prisma.seasonCalendar.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("SeasonCalendar");
  const start = input.startDate ? new Date(input.startDate) : existing.startDate;
  const end = input.endDate ? new Date(input.endDate) : existing.endDate;
  await requiredControlCheck({ surfaceName: "season_calendar", proposedChange: { ...existing, startDate: start, endDate: end }, currentValue: existing, operationType: "UPDATE", actorId });
  await assertNoOverlap(prisma, start, end, id);

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "SeasonCalendar", entityId: id, actorId });
    const updated = await tx.seasonCalendar.update({
      where: { id },
      data: {
        name: input.name === undefined ? undefined : input.name.trim(),
        startDate: input.startDate === undefined ? undefined : start,
        endDate: input.endDate === undefined ? undefined : end,
        rateMultiplier:
          input.rateMultiplier === undefined
            ? undefined
            : input.rateMultiplier == null
              ? null
              : (input.rateMultiplier as unknown as Prisma.Decimal),
        priority: input.priority === undefined ? undefined : input.priority,
        version: { increment: 1 },
      },
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SEASON_UPDATED",
      entityType: "SeasonCalendar",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function deactivateSeason(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.seasonCalendar.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("SeasonCalendar");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "SeasonCalendar", entityId: id, actorId });
    const updated = await tx.seasonCalendar.update({ where: { id }, data: { isActive: false } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SEASON_DEACTIVATED",
      entityType: "SeasonCalendar",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}

export async function reactivateSeason(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.seasonCalendar.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("SeasonCalendar");
  if (existing.isActive) throw new ValidationError("Season is already active");
  await assertNoOverlap(prisma, existing.startDate, existing.endDate, id);
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "SeasonCalendar", entityId: id, actorId });
    const updated = await tx.seasonCalendar.update({ where: { id }, data: { isActive: true } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.SEASON_REACTIVATED",
      entityType: "SeasonCalendar",
      entityId: id,
      operation: "UPDATE",
      payload: { name: updated.name },
    });
    return updated;
  });
}
