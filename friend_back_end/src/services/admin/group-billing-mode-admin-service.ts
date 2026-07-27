/**
 * L3+ admin action to manually override Policy 64's group classification on an entry.
 *
 * Used when Policy 64 mis-classifies a booking (e.g., a large family arriving on one folio
 * that shouldn't be treated as an operational group) or when the operator learns after the
 * fact that a small booking is actually part of a larger group operation.
 *
 * Sets `Entry.groupBillingMode` to the requested value AND flips the
 * `groupBillingModeManualOverride` flag to `true`, which prevents subsequent intake edits
 * from re-running Policy 64 (that logic is in `updateEntryIntakeFields`).
 *
 * Audited via a trace event so future sessions can see who decided what and when.
 */
import type { GroupBillingMode, PrismaClient } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { ActorLevel } from "../../types/actor.js";
import * as auditService from "../infrastructure/audit-service.js";

export async function setGroupBillingModeManually(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: { mode: GroupBillingMode | null; reason: string; clearManualOverride?: boolean },
) {
  if (actorLevel !== "L3" && actorLevel !== "L4") {
    throw new AuthorizationError("Manually toggling group billing mode requires L3+ authority.");
  }
  if (!input.reason?.trim()) {
    throw new ValidationError("A reason is required for the audit trail.");
  }
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");

  const priorMode = entry.groupBillingMode ?? null;
  const priorOverride = entry.groupBillingModeManualOverride;
  const nextMode = input.mode ?? null;
  const nextOverride = input.clearManualOverride ? false : true;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.entry.update({
      where: { id: entryId },
      data: {
        groupBillingMode: nextMode,
        groupBillingModeManualOverride: nextOverride,
        version: { increment: 1 },
      },
    });
    await auditService.emit(tx as any, { actorId, actorLevel }, {
      eventType: "ENTRY.GROUP_BILLING_MODE_MANUALLY_SET",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: updated.currentStage as any,
      inquiryId: updated.inquiryId,
      entryId,
      payload: {
        priorMode,
        nextMode,
        priorOverride,
        nextOverride,
        reason: input.reason.trim(),
      },
      createdBy: actorId,
    });
    return updated;
  });
}
