import type { PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, Prisma, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { computeReEntryConsequences } from "../../engines/re-entry-consequence-engine.js";
import { cancelEntryTimersByCode } from "../../lib/cancel-entry-timers-by-code.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";

/**
 * SIG-S8 §3.7 — S8→S7 re-entry (additional charge path).
 * Requires **folio LIVE** (settlement not completed in this slice).
 */
export async function reEnterS8ToS7(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  clientVersion: number | undefined,
  reason: string,
) {
  if (clientVersion == null) throw new ValidationError("version is required");
  if (!reason?.trim()) throw new ValidationError("reason is required");

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S8) throw new ValidationError("Entry must be at S8 for S8→S7 re-entry");
  if (entry.version !== clientVersion) {
    throw new StateTransitionError("Entry version mismatch — refresh and retry", "OPTIMISTIC_LOCK_VERSION_MISMATCH");
  }
  if (!entry.folio || entry.folio.state !== FolioState.LIVE) {
    throw new ValidationError("S8→S7 re-entry requires folio in LIVE state (settlement not yet completed)");
  }

  await cancelEntryTimersByCode(prisma, {
    entryId,
    timerCodes: ["CHECKOUT_TIME_W26"],
    cancelledBy: actorId,
    cancelledReason: "REENTRY_S8_TO_S7",
  });

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await computeReEntryConsequences(tx as any, {
      entryId,
      fromStage: Stage.S8,
      toStage: Stage.S7,
      reason: reason.trim(),
      actorId,
    });

    const h4 = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H4 },
      orderBy: { createdAt: "desc" },
    });
    if (h4?.state === HandoffState.FULFILLED) {
      await tx.handoffRecord.update({
        where: { id: h4.id },
        data: {
          state: HandoffState.ACCEPTED,
          fulfilledAt: null,
          fulfilledBy: null,
          fulfilmentEvidence: Prisma.JsonNull,
        },
      });
    }

    const s8Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S8, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s8Dwell) await tx.stageDwellRecord.update({ where: { id: s8Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S7, enteredAt: now } });
    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S7, version: { increment: 1 }, updatedAt: now },
    });
  });

  return loadEntryDetail(prisma, entryId);
}

/**
 * SIG-S8 §3.7 — S8→S2 re-entry (rate dispute / full renegotiation).
 * **FOM+** authority is enforced at the router. Requires **folio LIVE**.
 */
export async function reEnterS8ToS2(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined, reason: string) {
  if (clientVersion == null) throw new ValidationError("version is required");
  if (!reason?.trim()) throw new ValidationError("reason is required");

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S8) throw new ValidationError("Entry must be at S8 for S8→S2 re-entry");
  if (entry.version !== clientVersion) {
    throw new StateTransitionError("Entry version mismatch — refresh and retry", "OPTIMISTIC_LOCK_VERSION_MISMATCH");
  }
  if (!entry.folio || entry.folio.state !== FolioState.LIVE) {
    throw new ValidationError("S8→S2 re-entry requires folio in LIVE state (settlement not yet completed)");
  }

  await cancelEntryTimersByCode(prisma, {
    entryId,
    timerCodes: ["CHECKOUT_TIME_W26"],
    cancelledBy: actorId,
    cancelledReason: "REENTRY_S8_TO_S2",
  });

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await computeReEntryConsequences(tx as any, {
      entryId,
      fromStage: Stage.S8,
      toStage: Stage.S2,
      reason: reason.trim(),
      actorId,
    });

    const latestSeg = await tx.segment.findFirst({
      where: { entryId },
      orderBy: { segmentNumber: "desc" },
    });
    if (!latestSeg) throw new NotFoundError("Segment");

    if (!latestSeg.sealedAt) {
      await tx.segment.update({ where: { id: latestSeg.id }, data: { sealedAt: now, sealedBy: actorId } });
    }

    const nextNum = latestSeg.segmentNumber + 1;
    const newSeg = await tx.segment.create({
      data: { entryId, segmentNumber: nextNum, stage: Stage.S2, createdBy: actorId },
    });

    // SIG-S4 §197 / AC-S4-026: the prior Reservation stays attached to its (now-sealed) segment as
    // read-only history; re-confirmation at S4 mints a new Reservation for the new segment. Do NOT
    // mutate the existing reservation.

    const h4 = await tx.handoffRecord.findFirst({
      where: { entryId, handoffType: HandoffType.H4 },
      orderBy: { createdAt: "desc" },
    });
    if (h4?.state === HandoffState.FULFILLED) {
      await tx.handoffRecord.update({
        where: { id: h4.id },
        data: {
          state: HandoffState.ACCEPTED,
          fulfilledAt: null,
          fulfilledBy: null,
          fulfilmentEvidence: Prisma.JsonNull,
        },
      });
    }

    const s8Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S8, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s8Dwell) await tx.stageDwellRecord.update({ where: { id: s8Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S2, enteredAt: now } });

    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S2, segmentNumber: nextNum, version: { increment: 1 }, updatedAt: now },
    });
  });

  return loadEntryDetail(prisma, entryId);
}
