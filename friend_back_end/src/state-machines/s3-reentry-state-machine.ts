import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { scheduleS2StageDwellWarningMonitor } from "../lib/schedule-s2-dwell-warning-monitor.js";
import * as s3HoldService from "../services/domain/s3-hold-service.js";
import { supersedePendingInvoicesTx } from "../services/domain/s3-folio-service.js";
import { computeReEntryConsequences } from "../engines/re-entry-consequence-engine.js";
import { enforceS3ReEntryAuthority } from "../policies/01-availability/p01-reentry-authority.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";

export async function initiateS3ToS2Backflow(prisma: PrismaClient, entryId: string, actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" }, input?: { reason?: string }) {
  enforceS3ReEntryAuthority({ actorLevel: actor.actorLevel });
  const existingEntry = await prisma.entry.findUnique({ where: { id: entryId }, include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, committedHold: true } as any });
  if (!existingEntry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: existingEntry.currentStage });
  const currentSeg = existingEntry.segments[0];
  if (!currentSeg) throw new ValidationError("Entry has no segment");
  const now = new Date();
  const nextSegmentNumber = Number(existingEntry.segmentNumber ?? 1) + 1;

  const updatedEntry = await prisma.$transaction(async (tx) => {
    await computeReEntryConsequences(tx as any, { entryId, fromStage: Stage.S3, toStage: Stage.S2, reason: input?.reason ?? "S3_TO_S2", actorId: actor.actorId });
    await tx.segment.update({ where: { id: currentSeg.id }, data: { sealedAt: now, sealedBy: actor.actorId, notes: "REENTRY_S3_TO_S2" } });
    await tx.segment.create({ data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S2, startedAt: now, createdBy: actor.actorId, notes: input?.reason ?? "REENTRY_S3_TO_S2" } });

    const s3Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S3, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s3Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s3Dwell.id },
        data: {
          exitedAt: now,
          dwellSeconds: Math.max(0, Math.floor((now.getTime() - s3Dwell.enteredAt.getTime()) / 1000)),
        },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S2, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any,
    });

    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S2, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now } });
    await tx.traceEvent.create({
      data: { eventType: "ENTRY.REENTRY_S3_TO_S2", actorId: actor.actorId, actorLevel: actor.actorLevel, entityType: "Entry", entityId: entryId, operation: "TRANSITION", timestamp: now, stageContext: Stage.S3, entryId, payload: { entryId, toStage: "S2", segmentNumber: nextSegmentNumber, holdRetained: true }, createdBy: actor.actorId },
    });
    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });

  await scheduleS2StageDwellWarningMonitor(prisma, entryId, actor.actorId);

  const hold = await prisma.committedHold.findUnique({
    where: { entryId },
    select: { id: true, expiresAt: true, state: true, segmentId: true },
  });
  const folio = await prisma.folio.findUnique({ where: { entryId }, select: { id: true, outstandingBalance: true } });
  const paySum =
    folio != null
      ? await prisma.paymentRecord.aggregate({
          where: { folioId: folio.id },
          _sum: { amount: true },
        })
      : { _sum: { amount: null as null } };

  return {
    entry: updatedEntry,
    renegotiationContext: {
      committedHold: hold
        ? {
            id: hold.id,
            expiresAt: hold.expiresAt.toISOString(),
            state: hold.state,
            segmentId: hold.segmentId,
          }
        : null,
      folioOutstandingBalance: folio != null ? String(folio.outstandingBalance) : null,
      recordedPaymentsTotal: paySum._sum.amount != null ? String(paySum._sum.amount) : null,
    },
  };
}

export async function initiateS3ToS1Backflow(prisma: PrismaClient, entryId: string, actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" }, input?: { reason?: string }) {
  enforceS3ReEntryAuthority({ actorLevel: actor.actorLevel });
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } as any });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const currentSeg = entry.segments[0];
  if (!currentSeg) throw new ValidationError("Entry has no segment");
  const now = new Date();
  const nextSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;

  return prisma.$transaction(async (tx) => {
    await computeReEntryConsequences(tx as any, { entryId, fromStage: Stage.S3, toStage: Stage.S1, reason: input?.reason ?? "S3_TO_S1", actorId: actor.actorId });
    await tx.segment.update({ where: { id: currentSeg.id }, data: { sealedAt: now, sealedBy: actor.actorId, notes: "REENTRY_S3_TO_S1" } });

    // Consequences (must be same tx): release hold + supersede invoices + cancel timers.
    await s3HoldService.releaseOnReEntry(tx as any, entryId, actor as any);
    await supersedePendingInvoicesTx(tx as any, entryId, actor.actorId);

    await tx.segment.create({ data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S1, startedAt: now, createdBy: actor.actorId, notes: input?.reason ?? "REENTRY_S3_TO_S1" } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S1, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now } });
    await tx.traceEvent.create({
      data: { eventType: "ENTRY.REENTRY_S3_TO_S1", actorId: actor.actorId, actorLevel: actor.actorLevel, entityType: "Entry", entityId: entryId, operation: "TRANSITION", timestamp: now, stageContext: Stage.S3, entryId, payload: { entryId, toStage: "S1", segmentNumber: nextSegmentNumber, holdReleased: true, invoicesSuperseded: true }, createdBy: actor.actorId },
    });
    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });
}
