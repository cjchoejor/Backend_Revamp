import type { PrismaClient } from "@prisma/client";
import { InvoiceState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as s3HoldService from "./s3-hold-service.js";
import { computeReEntryConsequences } from "../../engines/re-entry-consequence-engine.js";
import { enforceS3ReEntryAuthority } from "../../policies/01-availability/p01-reentry-authority.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";

async function supersedePendingInvoices(tx: any, entryId: string, actorId: string) {
  const now = new Date();
  const invoices = await tx.invoice.findMany({
    where: { entryId, invoiceType: "PROFORMA", state: { in: [InvoiceState.DRAFT, InvoiceState.DISPATCHED] } },
    orderBy: { createdAt: "desc" },
  });
  if (invoices.length === 0) return { superseded: 0 };

  await tx.invoice.updateMany({
    where: { id: { in: invoices.map((i: any) => i.id) } },
    data: { state: InvoiceState.SUPERSEDED } as any,
  });

  for (const inv of invoices) {
    await tx.traceEvent.create({
      data: {
        eventType: "INVOICE.SUPERSEDED",
        actorId,
        actorLevel: "L2",
        entityType: "Invoice",
        entityId: inv.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId,
        payload: { entryId, invoiceId: inv.id, reason: "REENTRY_S3_TO_S1" },
        createdBy: actorId,
      },
    });
  }

  const engine = await getTimerEngine();

  // Cancel W34 timers tied to invoices.
  const w34 = await tx.timerRecord.findMany({
    where: { entryId, entityType: "Invoice", entityId: { in: invoices.map((i: any) => i.id) }, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(w34.map((t: any) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: w34.map((t: any) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "INVOICE_SUPERSEDED" } as any,
  });

  // Cancel W22 timers for S3 comms (best-effort: cancel all S3 acknowledgement timers on this entry).
  const w22 = await tx.timerRecord.findMany({
    where: { entryId, timerType: "ACKNOWLEDGEMENT_WINDOW_W22", status: "SCHEDULED", stageContext: Stage.S3 },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(w22.map((t: any) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: w22.map((t: any) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S3_TO_S1" } as any,
  });

  return { superseded: invoices.length };
}

export async function initiateS3ToS2Backflow(prisma: PrismaClient, entryId: string, actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" }, input?: { reason?: string }) {
  enforceS3ReEntryAuthority({ actorLevel: actor.actorLevel });
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, committedHold: true } as any });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const currentSeg = entry.segments[0];
  if (!currentSeg) throw new ValidationError("Entry has no segment");
  const now = new Date();
  const nextSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;

  return prisma.$transaction(async (tx) => {
    await computeReEntryConsequences(tx as any, { entryId, fromStage: Stage.S3, toStage: Stage.S2, reason: input?.reason ?? "S3_TO_S2", actorId: actor.actorId });
    await tx.segment.update({ where: { id: currentSeg.id }, data: { sealedAt: now, sealedBy: actor.actorId, notes: "REENTRY_S3_TO_S2" } });
    await tx.segment.create({ data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S2, startedAt: now, createdBy: actor.actorId, notes: input?.reason ?? "REENTRY_S3_TO_S2" } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S2, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now } });
    await tx.traceEvent.create({
      data: { eventType: "ENTRY.REENTRY_S3_TO_S2", actorId: actor.actorId, actorLevel: actor.actorLevel, entityType: "Entry", entityId: entryId, operation: "TRANSITION", timestamp: now, stageContext: Stage.S3, entryId, payload: { entryId, toStage: "S2", segmentNumber: nextSegmentNumber, holdRetained: true }, createdBy: actor.actorId },
    });
    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });
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
    await supersedePendingInvoices(tx as any, entryId, actor.actorId);

    await tx.segment.create({ data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S1, startedAt: now, createdBy: actor.actorId, notes: input?.reason ?? "REENTRY_S3_TO_S1" } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S1, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now } });
    await tx.traceEvent.create({
      data: { eventType: "ENTRY.REENTRY_S3_TO_S1", actorId: actor.actorId, actorLevel: actor.actorLevel, entityType: "Entry", entityId: entryId, operation: "TRANSITION", timestamp: now, stageContext: Stage.S3, entryId, payload: { entryId, toStage: "S1", segmentNumber: nextSegmentNumber, holdReleased: true, invoicesSuperseded: true }, createdBy: actor.actorId },
    });
    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });
}

