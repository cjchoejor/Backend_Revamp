import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../lib/errors.js";
import { getTimerEngine } from "./timer-management-service.js";

export async function openDispute(
  prisma: PrismaClient,
  actorId: string,
  input: { entryId: string; folioId: string; title: string; description?: string },
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.folioId?.trim()) throw new ValidationError("folioId is required");
  if (!input.title?.trim()) throw new ValidationError("title is required");

  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");

  return prisma.disputeRecord.create({
    data: {
      entryId: input.entryId,
      folioId: input.folioId,
      title: input.title,
      description: input.description,
      openedBy: actorId,
    },
  });
}

export async function closeDispute(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { closureReason: string },
) {
  if (!input.closureReason?.trim()) throw new ValidationError("closureReason is required");
  const now = new Date();
  return prisma.disputeRecord.update({
    where: { id: disputeId },
    data: { status: "CLOSED", closedAt: now, closedBy: actorId, closureReason: input.closureReason, updatedBy: actorId },
  });
}

export async function createGateOverride(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { targetStage: Stage; freeTextReason: string },
) {
  if (!input.freeTextReason?.trim()) throw new ValidationError("freeTextReason is required");
  if (input.targetStage === Stage.S9) {
    throw new PolicyGateBlockedError("DISPUTE_OVERRIDE_NOT_AVAILABLE", "Dispute gate override is not available for S8→S9");
  }
  const created = await prisma.disputeGateOverrideRecord.create({
    data: { disputeId, targetStage: input.targetStage, freeTextReason: input.freeTextReason, createdBy: actorId },
  });
  // Cross-stage escalation monitor (docs: W32; code: existing worker implementation).
  try {
    const engine = await getTimerEngine();
    await engine.schedule("FOM_OVERRIDE_FREQUENCY_W32", { now: new Date() }, { startAfter: new Date() });
  } catch {
    // Best-effort.
  }
  return created;
}

export async function canProgressToS8(prisma: PrismaClient, entryId: string): Promise<"CLEAR" | "BLOCKED_WITH_OVERRIDE_AVAILABLE" | "BLOCKED"> {
  const open = await prisma.disputeRecord.findFirst({
    where: { entryId, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } },
    orderBy: { openedAt: "desc" },
  });
  if (!open) return "CLEAR";

  const override = await prisma.disputeGateOverrideRecord.findFirst({
    where: { disputeId: open.id, targetStage: Stage.S8 },
    orderBy: { createdAt: "desc" },
  });
  if (override) return "CLEAR";
  return "BLOCKED_WITH_OVERRIDE_AVAILABLE";
}

