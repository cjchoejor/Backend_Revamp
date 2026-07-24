import type { PrismaClient } from "@prisma/client";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../../lib/errors.js";

export async function createLostAndFoundRecord(
  prisma: PrismaClient,
  actorId: string,
  input: { entryId?: string; guestProfileId?: string; description: string },
) {
  const periodDays = Number(await requireActiveConfigValue<number>(prisma as any, "lostFound.retention.periodDays"));
  if (!Number.isFinite(periodDays) || periodDays < 1) throw new ValidationError("lostFound.retention.periodDays must be >= 1");
  const retentionExpiresAt = new Date(Date.now() + periodDays * 86400_000);

  const timerRecordId = randomUUID();
  const engine = await getTimerEngine();
  const jobId = await engine.schedule("LOST_FOUND_RETENTION_W30", { lostAndFoundId: timerRecordId }, { startAfter: retentionExpiresAt });

  return prisma.$transaction(async (tx) => {
    const rec = await (tx as any).lostAndFoundRecord.create({
      data: {
        entryId: input.entryId ?? null,
        guestProfileId: input.guestProfileId ?? null,
        description: input.description,
        retentionExpiresAt,
        createdBy: actorId,
      },
    });

    await tx.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId: input.entryId ?? null,
        entityType: "LostAndFoundRecord",
        entityId: rec.id,
        timerType: "LOST_FOUND_RETENTION_W30",
        timerCode: "LOST_FOUND_RETENTION_W30",
        stageContext: "S9",
        dueAt: retentionExpiresAt,
        firesAt: retentionExpiresAt,
        status: "SCHEDULED",
        createdBy: actorId,
        pgBossJobId: jobId,
        payload: { lostAndFoundId: rec.id, timerRecordId },
      } as any,
    });

    return rec;
  });
}

