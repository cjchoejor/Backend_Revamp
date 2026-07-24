import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W29 — Equipment return deadline monitor.
 * Implements AC-S9-050 (breach trace).
 */
export async function runEquipmentReturnWorker(prisma: PrismaClient, input: { entryId: string }) {
  const alloc = await prisma.equipmentAllocation.findFirst({ where: { entryId: input.entryId }, orderBy: { createdAt: "desc" } });
  if (!alloc) return { skipped: true, reason: "NO_ALLOCATION" } as const;
  if (alloc.returnConfirmedAt) return { skipped: true, reason: "ALREADY_RETURNED" } as const;

  const now = new Date();
  if (now < alloc.returnDeadlineAt) return { skipped: true, reason: "NOT_DUE" } as const;

  const existing = await prisma.traceEvent.findFirst({
    where: { entryId: input.entryId, eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { skipped: true, reason: "IDEMPOTENT_TRACE_EXISTS" } as const;

  await prisma.traceEvent.create({
    data: {
      eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "EquipmentAllocation",
      entityId: alloc.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S9,
      inquiryId: null,
      entryId: input.entryId,
      payload: { equipmentAllocationId: alloc.id, entryId: input.entryId, equipmentCode: alloc.equipmentCode },
      createdBy: "SYSTEM",
    },
  });
  // Best-effort: mark timer fired if one exists for this entry.
  await prisma.timerRecord.updateMany({
    where: { entryId: input.entryId, timerCode: "EQUIPMENT_RETURN_W29", status: "SCHEDULED" },
    data: { status: "FIRED", firedAt: now } as any,
  });
  return { skipped: false, equipmentAllocationId: alloc.id } as const;
}

