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
  enabled?: boolean;
  sameDayPenaltyAmount: number;
  preArrivalPenaltyAmount?: number | null;
  postCheckInEarlyDeparturePenaltyAmount?: number | null;
  tiers?: Array<{ minDaysBeforeArrival: number; basis: "PERCENT_OF_PAID" | "AMOUNT"; value: number }>;
};

export async function getCancellationCharges(prisma: PrismaClient) {
  const row = await getActiveConfigEntry(prisma, CHARGES_KEY);
  const stored = row?.configValue ?? null;
  // A list here is what a saved policy left behind: Policy 35 reads no charge from it.
  const overwritten = Array.isArray(stored);
  if (overwritten || !stored || typeof stored !== "object") return { value: overwritten ? null : stored, overwritten };
  // The form edits days, a basis and a figure (2026-11-10). A line saved before counted hours to the
  // check-in time and charged an amount: shown in whole days, it is saved that way the next time.
  const o = { ...(stored as Record<string, unknown>) };
  // A value saved before the switch existed is on.
  o.enabled = o.enabled !== false;
  if (Array.isArray(o.tiers)) {
    o.tiers = o.tiers.map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      if (r.minDaysBeforeArrival != null) return r;
      return { minDaysBeforeArrival: Math.floor(Number(r.minHoursBeforeCheckIn ?? 0) / 24), basis: "AMOUNT", value: Number(r.penaltyAmount ?? 0) };
    });
  }
  return { value: o, overwritten };
}

export async function setCancellationCharges(prisma: PrismaClient, input: CancellationChargesInput, actorId: string, notes?: string | null) {
  // Nothing typed means "use the usual charge", which is what a missing field does in Policy 35.
  const value: Record<string, unknown> = { enabled: input.enabled !== false, sameDayPenaltyAmount: input.sameDayPenaltyAmount };
  if (input.preArrivalPenaltyAmount != null) value.preArrivalPenaltyAmount = input.preArrivalPenaltyAmount;
  if (input.postCheckInEarlyDeparturePenaltyAmount != null) value.postCheckInEarlyDeparturePenaltyAmount = input.postCheckInEarlyDeparturePenaltyAmount;
  if (input.tiers?.length) {
    // The lines must make sense (ACIG §6.2.12, DEV-SPEC-001 Part 12 §73, 2026-11-10): one line for
    // each day count, and a cancellation nearer the arrival never costing less than one further out.
    // A share and an amount cannot be set against each other, except that nothing is less than either.
    const lines = [...input.tiers].sort((a, b) => b.minDaysBeforeArrival - a.minDaysBeforeArrival);
    const days = (d: number) => `${d} day${d === 1 ? "" : "s"}`;
    const what = (t: { basis: string; value: number }) => (t.basis === "PERCENT_OF_PAID" ? `${t.value}% of the advance paid` : `Nu ${t.value}`);
    for (const t of lines) {
      if (t.basis === "PERCENT_OF_PAID" && t.value > 100) throw new ValidationError("A share of the advance paid is at most 100%.");
    }
    for (let i = 1; i < lines.length; i++) {
      const farther = lines[i - 1]!;
      const nearer = lines[i]!;
      if (nearer.minDaysBeforeArrival === farther.minDaysBeforeArrival) {
        throw new ValidationError(`Two lines start at ${days(nearer.minDaysBeforeArrival)} before arrival — keep one.`);
      }
    }
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const farther = lines[i]!;
        const nearer = lines[j]!;
        const comparable = nearer.basis === farther.basis || nearer.value === 0 || farther.value === 0;
        if (comparable && nearer.value < farther.value) {
          throw new ValidationError(
            `A cancellation nearer the arrival can't cost less than one further out: from ${days(nearer.minDaysBeforeArrival)} before arrival it is ${what(nearer)}, from ${days(farther.minDaysBeforeArrival)} ${what(farther)}.`,
          );
        }
      }
    }
    value.tiers = lines.map((t) => ({ minDaysBeforeArrival: t.minDaysBeforeArrival, basis: t.basis, value: t.value }));
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
