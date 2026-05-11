import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { randomUUID } from "node:crypto";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceFocGmApprovalAuthority } from "../../policies/15-foc/p38-foc-gm-approval-authority.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";

export async function approveFocGm(prisma: PrismaClient, entryId: string, actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" }, input?: { note?: string }) {
  enforceFocGmApprovalAuthority({ actorLevel: actor.actorLevel });
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const now = new Date();
  await prisma.traceEvent.create({
    data: {
      eventType: "FOC.GM_APPROVED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "APPROVE",
      timestamp: now,
      stageContext: Stage.S3,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { entryId, note: input?.note?.trim() ? input.note.trim() : null },
      createdBy: actor.actorId,
    },
  });
  return { ok: true, entryId };
}

export async function confirmCoordinator(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { coordinatorName: string; authorityScope: string; notes?: string },
) {
  if (!input.coordinatorName?.trim()) throw new ValidationError("coordinatorName is required");
  if (!input.authorityScope?.trim()) throw new ValidationError("authorityScope is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });

  const now = new Date();
  // Persist via WorkOrder amendment event for operational continuity.
  const wo = await prisma.workOrder.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  const workOrder =
    wo ??
    (await prisma.workOrder.create({
      data: { entryId, createdBy: actor.actorId },
    }));
  await prisma.workOrderAmendmentEvent.create({
    data: {
      workOrderId: workOrder.id,
      amendmentType: "COORDINATOR_CONFIRMED",
      reason: "S3 coordinator confirmation",
      payload: { coordinatorName: input.coordinatorName.trim(), authorityScope: input.authorityScope.trim(), notes: input.notes ?? null } as any,
      createdBy: actor.actorId,
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "COORDINATOR.CONFIRMED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S3,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { entryId, coordinatorName: input.coordinatorName.trim(), authorityScope: input.authorityScope.trim() },
      createdBy: actor.actorId,
    },
  });
  return { ok: true, entryId, workOrderId: workOrder.id };
}

export async function schedulePaymentMilestones(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: { templateKey: string; dueAt?: string },
) {
  if (!input.templateKey?.trim()) throw new ValidationError("templateKey is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });

  const templates = await requireActiveConfigValue<any>(prisma, "paymentMilestone.scheduleTemplates").catch(() => {
    throw new MissingConfigurationError("paymentMilestone.scheduleTemplates");
  });
  const tmpl = templates?.[input.templateKey.trim()];
  if (!tmpl || !Array.isArray(tmpl.milestones)) {
    throw new ValidationError("Unknown templateKey or invalid template");
  }

  const baseDueAt = input.dueAt ? new Date(input.dueAt) : null;
  const now = new Date();
  const engine = await getTimerEngine();
  const created: Array<{ milestone: string; timerRecordId: string; dueAt: string }> = [];

  await prisma.$transaction(async (tx) => {
    for (const m of tmpl.milestones) {
      const milestone = String(m.code ?? m.milestone ?? "").trim();
      if (!milestone) continue;
      const offsetDays = Number(m.offsetDays ?? 0);
      const dueAt = baseDueAt ? new Date(baseDueAt.getTime() + offsetDays * 86400_000) : new Date(now.getTime() + Math.max(0, offsetDays) * 86400_000);
      const timerRecordId = randomUUID();
      const jobId = await engine.schedule("PAYMENT_MILESTONE_W21", { entryId, milestone, timerRecordId }, { startAfter: dueAt });
      await (tx as any).timerRecord.create({
        data: {
          id: timerRecordId,
          entryId,
          entityType: "Entry",
          entityId: entryId,
          timerType: "PAYMENT_MILESTONE_W21",
          timerCode: "PAYMENT_MILESTONE_W21",
          stageContext: Stage.S3,
          dueAt,
          firesAt: dueAt,
          status: "SCHEDULED",
          createdBy: actor.actorId,
          pgBossJobId: jobId,
          payload: { entryId, milestone, timerRecordId } as any,
        },
      });
      created.push({ milestone, timerRecordId, dueAt: dueAt.toISOString() });
    }
    await (tx as any).traceEvent.create({
      data: {
        eventType: "PAYMENT_MILESTONE.SCHEDULED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, templateKey: input.templateKey.trim(), milestones: created },
        createdBy: actor.actorId,
      },
    });
  });

  return { ok: true, entryId, scheduled: created };
}

