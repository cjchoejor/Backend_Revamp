/**
 * Deficient-condition reporting for rooms and spaces.
 *
 * Replaces the L4-only admin path as the operational surface: front desk (L1) reports a fault
 * directly, a supervisor (L2+) confirms or rejects it. Previously only an L4 admin could raise
 * one, which meant a broken room stayed sellable until someone with admin rights was around.
 *
 * Two rules drive everything here:
 *
 *   1. **The target leaves service on report, before verification.** A genuinely broken room
 *      must never remain sellable overnight waiting for a supervisor. Verification answers "is
 *      this fault real?", not "may it take effect?". Rejecting a report returns the target to
 *      service immediately.
 *
 *   2. **L2+ reports are self-verified.** They are the verifying authority, so requiring them
 *      to confirm their own report would be ceremony with no control value.
 *
 * `verificationStatus` is independent of `status` (UNRESOLVED/RESOLVED) — see the model comment.
 */
import {
  type DeficientConditionCategory,
  DeficientVerificationStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";

/**
 * Resolution window, resolved exactly as the L4 admin path does: policy registry
 * `registry.deficientResolution.deadlineHours` wins, else the `deficientResolution.deadlineHours`
 * ConfigurationEntry, else 48h. Operational reports must inherit the hotel's configured window
 * rather than a hardcoded one, or a fault raised at the desk would get a different SLA from the
 * identical fault raised in the admin console.
 */
export async function resolveDeficiencyDeadlineHours(prisma: PrismaClient): Promise<number> {
  const policy = await getRegistryPolicy(prisma, "registry.deficientResolution.deadlineHours");
  if (policy && policy.enabled !== false && typeof policy.hours === "number") return policy.hours as number;
  const row = await getActiveConfigEntry(prisma, "deficientResolution.deadlineHours");
  const hours = Number(row?.configValue ?? 48);
  return Number.isFinite(hours) && hours > 0 ? hours : 48;
}

/** Reject categories the admin has deactivated in `deficientCondition.categories`. */
export async function assertCategoryAllowed(prisma: PrismaClient, category: string): Promise<void> {
  const row = await getActiveConfigEntry(prisma, "deficientCondition.categories");
  const allowed = Array.isArray(row?.configValue)
    ? (row!.configValue as Array<{ code: string; isActive?: boolean }>)
        .filter((c) => c.isActive !== false)
        .map((c) => c.code)
    : [];
  if (allowed.length && !allowed.includes(category)) {
    throw new ValidationError(`Category "${category}" is not in the active deficient categories list`);
  }
}

export type DeficientActor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

/** L2 and above may verify, and their own reports arrive already verified. */
export function isVerifyingAuthority(actorLevel: string): boolean {
  return actorLevel === "L2" || actorLevel === "L3" || actorLevel === "L4";
}

export type DeficientTarget = { roomId: string; spaceId?: never } | { spaceId: string; roomId?: never };

/**
 * Does this target still have a fault that should keep it out of service?
 *
 * Only UNRESOLVED reports that have not been REJECTED count. A rejected report is a report that
 * turned out not to be real, so it must not hold the target down; a resolved one has been fixed.
 */
async function hasBlockingDeficiency(
  tx: Prisma.TransactionClient,
  target: { roomId?: string | null; spaceId?: string | null },
  excludeRecordId?: string,
): Promise<boolean> {
  const count = await tx.deficientConditionRecord.count({
    where: {
      ...(target.roomId ? { roomId: target.roomId } : { spaceId: target.spaceId }),
      status: "UNRESOLVED",
      verificationStatus: { not: DeficientVerificationStatus.REJECTED },
      ...(excludeRecordId ? { id: { not: excludeRecordId } } : {}),
    },
  });
  return count > 0;
}

/** Re-derive the target's `isDeficient` flag from its outstanding reports. */
async function syncTargetFlag(
  tx: Prisma.TransactionClient,
  target: { roomId?: string | null; spaceId?: string | null },
  now: Date,
  excludeRecordId?: string,
) {
  const flagged = await hasBlockingDeficiency(tx, target, excludeRecordId);
  if (target.roomId) {
    await tx.room.update({ where: { id: target.roomId }, data: { isDeficient: flagged, updatedAt: now } });
  } else if (target.spaceId) {
    await tx.space.update({ where: { id: target.spaceId }, data: { isDeficient: flagged, updatedAt: now } });
  }
}

/**
 * Report a fault. Any L1+ may report; the target goes out of service immediately.
 * Reports from L2+ are VERIFIED on arrival, L1 reports await confirmation.
 */
export async function reportDeficiency(
  prisma: PrismaClient,
  target: DeficientTarget,
  input: {
    category: DeficientConditionCategory;
    description: string;
    /** Defaults to the `deficientResolution.deadlineHours` window when omitted. */
    resolutionDeadline?: Date;
  },
  actor: DeficientActor,
) {
  if (!input.description?.trim()) throw new ValidationError("description is required");
  const roomId = "roomId" in target ? target.roomId : undefined;
  const spaceId = "spaceId" in target ? target.spaceId : undefined;
  if (!roomId && !spaceId) throw new ValidationError("Either roomId or spaceId is required");
  if (roomId && spaceId) throw new ValidationError("Provide exactly one of roomId or spaceId");

  if (roomId) {
    const room = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true } });
    if (!room) throw new NotFoundError("Room");
  } else {
    const space = await prisma.space.findUnique({ where: { id: spaceId! }, select: { id: true } });
    if (!space) throw new NotFoundError("Space");
  }

  await assertCategoryAllowed(prisma, String(input.category));

  const now = new Date();
  const hours = await resolveDeficiencyDeadlineHours(prisma);
  const deadline = input.resolutionDeadline ?? new Date(now.getTime() + hours * 3600 * 1000);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime()) {
    throw new ValidationError("resolutionDeadline must be a future timestamp");
  }
  const selfVerified = isVerifyingAuthority(actor.actorLevel);

  return prisma.$transaction(async (tx) => {
    const record = await tx.deficientConditionRecord.create({
      data: {
        roomId: roomId ?? null,
        spaceId: spaceId ?? null,
        category: input.category,
        description: input.description.trim(),
        detectedAt: now,
        detectedBy: actor.actorId,
        resolutionDeadline: deadline,
        status: "UNRESOLVED",
        verificationStatus: selfVerified
          ? DeficientVerificationStatus.VERIFIED
          : DeficientVerificationStatus.PENDING_VERIFICATION,
        verifiedAt: selfVerified ? now : null,
        verifiedBy: selfVerified ? actor.actorId : null,
      },
    });

    // Out of service NOW — before any verification.
    await syncTargetFlag(tx, { roomId, spaceId }, now);

    await tx.traceEvent.create({
      data: {
        eventType: roomId ? "ROOM.DEFICIENCY_REPORTED" : "SPACE.DEFICIENCY_REPORTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: roomId ? "Room" : "Space",
        entityId: (roomId ?? spaceId)!,
        operation: "CREATE",
        timestamp: now,
        payload: {
          deficientConditionRecordId: record.id,
          roomId: roomId ?? null,
          spaceId: spaceId ?? null,
          category: input.category,
          description: record.description,
          verificationStatus: record.verificationStatus,
          outOfServiceImmediately: true,
        },
        createdBy: actor.actorId,
      },
    });

    return record;
  });
}

/**
 * Confirm or reject a pending report. L2+ only — the caller's route enforces the level, and
 * this re-checks so the rule can't be lost by a mis-wired route.
 *
 * Rejecting returns the target to service straight away unless another live fault holds it.
 */
export async function verifyDeficiency(
  prisma: PrismaClient,
  recordId: string,
  input: { accept: boolean; notes?: string | null },
  actor: DeficientActor,
) {
  if (!isVerifyingAuthority(actor.actorLevel)) {
    throw new ValidationError("Verifying a deficiency requires L2 authority or above");
  }
  const record = await prisma.deficientConditionRecord.findUnique({ where: { id: recordId } });
  if (!record) throw new NotFoundError("DeficientConditionRecord");
  if (record.verificationStatus !== DeficientVerificationStatus.PENDING_VERIFICATION) {
    throw new ValidationError(`Report is already ${record.verificationStatus}`);
  }
  // A rejection overrules a reporter, so it owes them a reason.
  if (!input.accept && !input.notes?.trim()) {
    throw new ValidationError("A reason is required when rejecting a reported deficiency");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.deficientConditionRecord.update({
      where: { id: recordId },
      data: {
        verificationStatus: input.accept
          ? DeficientVerificationStatus.VERIFIED
          : DeficientVerificationStatus.REJECTED,
        verifiedAt: now,
        verifiedBy: actor.actorId,
        verificationNotes: input.notes?.trim() || null,
      },
    });

    // On reject the record no longer counts, so recompute WITHOUT excluding it (it is now
    // REJECTED and filtered out by hasBlockingDeficiency anyway). Another live fault on the
    // same target keeps it out of service.
    await syncTargetFlag(tx, { roomId: record.roomId, spaceId: record.spaceId }, now);

    await tx.traceEvent.create({
      data: {
        eventType: input.accept ? "DEFICIENCY.VERIFIED" : "DEFICIENCY.REJECTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: record.roomId ? "Room" : "Space",
        entityId: (record.roomId ?? record.spaceId)!,
        operation: "UPDATE",
        timestamp: now,
        payload: {
          deficientConditionRecordId: record.id,
          reportedBy: record.detectedBy,
          accepted: input.accept,
          notes: input.notes?.trim() || null,
        },
        createdBy: actor.actorId,
      },
    });

    return updated;
  });
}

/** Reports still awaiting a supervisor. Drives the desk's verification queue. */
export async function listPendingVerification(prisma: PrismaClient) {
  return prisma.deficientConditionRecord.findMany({
    where: {
      verificationStatus: DeficientVerificationStatus.PENDING_VERIFICATION,
      status: "UNRESOLVED",
    },
    orderBy: { detectedAt: "desc" },
    include: {
      room: { select: { id: true, roomNumber: true } },
      space: { select: { id: true, code: true, name: true } },
    },
  });
}

/** Open faults for one target, newest first. */
export async function listForTarget(prisma: PrismaClient, target: DeficientTarget) {
  const roomId = "roomId" in target ? target.roomId : undefined;
  const spaceId = "spaceId" in target ? target.spaceId : undefined;
  return prisma.deficientConditionRecord.findMany({
    where: roomId ? { roomId } : { spaceId },
    orderBy: { detectedAt: "desc" },
  });
}

/**
 * Mark a fault fixed. Any L1+ may resolve — front desk both finds and clears these, which is
 * why the pre-existing `/deficient-conditions/:id/finalize` route was already L1.
 */
export async function resolveDeficiency(
  prisma: PrismaClient,
  recordId: string,
  input: { resolutionNotes?: string | null },
  actor: DeficientActor,
) {
  const record = await prisma.deficientConditionRecord.findUnique({ where: { id: recordId } });
  if (!record) throw new NotFoundError("DeficientConditionRecord");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.deficientConditionRecord.update({
      where: { id: recordId },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedBy: actor.actorId,
        resolutionNotes: input.resolutionNotes?.trim() || null,
      },
    });
    await syncTargetFlag(tx, { roomId: record.roomId, spaceId: record.spaceId }, now);

    await tx.traceEvent.create({
      data: {
        eventType: record.roomId ? "ROOM.DEFICIENCY_RESOLVED" : "SPACE.DEFICIENCY_RESOLVED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: record.roomId ? "Room" : "Space",
        entityId: (record.roomId ?? record.spaceId)!,
        operation: "UPDATE",
        timestamp: now,
        payload: { deficientConditionRecordId: record.id, resolutionNotes: input.resolutionNotes?.trim() || null },
        createdBy: actor.actorId,
      },
    });
    return updated;
  });
}
