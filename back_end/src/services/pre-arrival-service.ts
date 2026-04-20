import type { PrismaClient } from "@prisma/client";
import { TaskStatus } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";

export async function updatePreArrivalTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  action: "COMPLETE" | "WAIVE",
  waivedReason?: string,
) {
  const task = await prisma.preArrivalTask.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("PreArrivalTask");

  if (task.status !== TaskStatus.PENDING) {
    throw new StateTransitionError("Task is already in a terminal status");
  }

  if (action === "WAIVE") {
    if (!waivedReason?.trim()) {
      throw new PolicyGateBlockedError("WAIVED_REASON_REQUIRED", "waivedReason is required when action is WAIVE");
    }
    return prisma.preArrivalTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.WAIVED,
        waivedReason: waivedReason.trim(),
        waivedBy: actorId,
      },
    });
  }

  return prisma.preArrivalTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.COMPLETE,
      completedAt: new Date(),
      completedBy: actorId,
    },
  });
}

export async function acknowledgeCreditCeilingTier2(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.reservation?.creditCeilingIfExtended) {
    throw new ValidationError("Credit ceiling does not apply to this entry");
  }
  return prisma.entry.update({
    where: { id: entryId },
    data: {
      creditCeilingTier2AcknowledgedAt: new Date(),
      creditCeilingTier2AcknowledgedBy: actorId,
      version: { increment: 1 },
    },
  });
}
