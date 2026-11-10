import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { requiredControlCheck } from "../../lib/admin/required-control-check.js";
import { supersedeConfigurationEntry } from "../../lib/admin/supersede-configuration.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";

/**
 * What the desk really charges when a booking is cancelled, walks out or does not come (Policy 35).
 * The registry rows on this page are a different thing: nothing charges from them, and until
 * 2026-11-02 saving one overwrote this key with its day-and-percent list, which Policy 35 reads as a
 * charge of 0. Only setCancellationCharges writes the key now.
 */
const CHARGES_KEY = "cancellation.policyTiers";

export type CancellationChargesInput = {
  sameDayPenaltyAmount: number;
  preArrivalPenaltyAmount?: number | null;
  postCheckInEarlyDeparturePenaltyAmount?: number | null;
  tiers?: Array<{ minHoursBeforeCheckIn: number; penaltyAmount: number }>;
};

export async function getCancellationCharges(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, CHARGES_KEY);
  const stored = row?.configValue ?? null;
  // A list here is what a saved policy left behind: Policy 35 reads no charge from it.
  const overwritten = Array.isArray(stored);
  return { value: overwritten ? null : stored, overwritten };
}

export async function setCancellationCharges(prisma: PrismaClient, input: CancellationChargesInput, actorId: string, notes?: string | null) {
  // Nothing typed means "use the usual charge", which is what a missing field does in Policy 35.
  const value: Record<string, unknown> = { sameDayPenaltyAmount: input.sameDayPenaltyAmount };
  if (input.preArrivalPenaltyAmount != null) value.preArrivalPenaltyAmount = input.preArrivalPenaltyAmount;
  if (input.postCheckInEarlyDeparturePenaltyAmount != null) value.postCheckInEarlyDeparturePenaltyAmount = input.postCheckInEarlyDeparturePenaltyAmount;
  if (input.tiers?.length) {
    // The lines must make sense (ACIG §6.2.12, DEV-SPEC-001 Part 12 §73, 2026-11-10): one line for
    // each time left, and a cancellation nearer the arrival never costing less than one further out.
    const lines = [...input.tiers].sort((a, b) => b.minHoursBeforeCheckIn - a.minHoursBeforeCheckIn);
    const words = (h: number) => (h % 24 === 0 && h > 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hour${h === 1 ? "" : "s"}`);
    for (let i = 1; i < lines.length; i++) {
      const farther = lines[i - 1]!;
      const nearer = lines[i]!;
      if (nearer.minHoursBeforeCheckIn === farther.minHoursBeforeCheckIn) {
        throw new ValidationError(`Two lines say ${words(nearer.minHoursBeforeCheckIn)} left — keep one.`);
      }
      if (nearer.penaltyAmount < farther.penaltyAmount) {
        throw new ValidationError(
          `A cancellation nearer the arrival can't cost less than one further out: with ${words(nearer.minHoursBeforeCheckIn)} left it is Nu ${nearer.penaltyAmount}, with ${words(farther.minHoursBeforeCheckIn)} left Nu ${farther.penaltyAmount}.`,
        );
      }
    }
    value.tiers = lines;
  }

  return prisma.$transaction(async (tx) => {
    const before = await getActiveConfigEntry(tx as unknown as PrismaClient, CHARGES_KEY);
    const saved = await supersedeConfigurationEntry(tx, {
      configKey: CHARGES_KEY,
      configValue: value as Prisma.InputJsonValue,
      actorId,
      notes: notes ?? null,
    });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.CANCELLATION_CHARGES_CHANGED",
      entityType: "ConfigurationEntry",
      entityId: saved.entry.id,
      operation: "UPDATE",
      payload: { from: (before?.configValue ?? null) as Prisma.InputJsonValue, to: value as Prisma.InputJsonValue },
    });
    return { value, overwritten: false };
  });
}

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
    await captureSnapshotTx(tx, { entityType: "CancellationPolicyRegistry", entityId: id, actorId });
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
    return updated;
  });
}

export async function deactivatePolicy(prisma: PrismaClient, id: string, actorId: string) {
  const existing = await prisma.cancellationPolicyRegistry.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("CancellationPolicyRegistry");

  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, { entityType: "CancellationPolicyRegistry", entityId: id, actorId });
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
    await captureSnapshotTx(tx, { entityType: "CancellationPolicyRegistry", entityId: id, actorId });
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
