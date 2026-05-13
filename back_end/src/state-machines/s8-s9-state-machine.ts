import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, StageGatesBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { collectS8ToS9ReadOnlyFailures } from "../lib/collect-s8-to-s9-read-failures.js";
import { enforceFolioStateAllowsS8ToS9Progression } from "../policies/13-billing-model/p33-folio-state-allows-s8-to-s9-progression.js";
import { enforceH5PresentForS8ToS9 } from "../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceEntryAtS8ForS8ToS9Progression } from "../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { schedulePaymentFollowUpW8IfOutstanding } from "../lib/schedule-payment-followup-w8.js";
import { buildOrAutoFulfilH5 } from "../services/domain/s8-checkout-service.js";

export async function progressStageS8ToS9(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null) throw new ValidationError("version is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS8ForS8ToS9Progression({ currentStage: entry.currentStage });
  if (entry.version !== clientVersion) {
    throw new StateTransitionError("Entry version mismatch — refresh and retry", "OPTIMISTIC_LOCK_VERSION_MISMATCH");
  }

  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");
  enforceFolioStateAllowsS8ToS9Progression({ folioState: folio.state });

  const failures = await collectS8ToS9ReadOnlyFailures(prisma, { entryId, entry });
  if (failures.length) {
    throw new StageGatesBlockedError(failures);
  }

  const h5 = await buildOrAutoFulfilH5(prisma, entryId, actorId);
  enforceH5PresentForS8ToS9({ h5 });

  const now = new Date();
  const s8Dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId, stage: Stage.S8, exitedAt: null }, orderBy: { enteredAt: "desc" } });
  await prisma.$transaction(async (tx) => {
    if (s8Dwell) await tx.stageDwellRecord.update({ where: { id: s8Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S9, enteredAt: now } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S9, version: { increment: 1 }, updatedAt: now } });
    await schedulePaymentFollowUpW8IfOutstanding(tx, {
      entryId,
      folioId: folio.id,
      folioState: folio.state,
      outstandingBalance: folio.outstandingBalance,
    });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}
