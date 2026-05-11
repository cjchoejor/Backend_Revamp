import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { runNightAudit } from "../services/application/s7-night-audit-service.js";

export async function runNightAuditWorker(prisma: PrismaClient, input: { operatingDate?: string; actorId?: string }) {
  const actorId = typeof input.actorId === "string" ? input.actorId : "SYSTEM";
  const operatingDate = typeof input.operatingDate === "string" ? input.operatingDate : new Date().toISOString();

  const record = await runNightAudit(prisma, actorId, { operatingDate });

  await prisma.traceEvent.create({
    data: {
      eventType: "NIGHT_AUDIT.W6_FIRED",
      actorId,
      actorLevel: "SYSTEM",
      entityType: "NightAuditRecord",
      entityId: record.id,
      operation: "RUN",
      timestamp: new Date(),
      stageContext: Stage.S7,
      inquiryId: null,
      entryId: null,
      payload: { operatingDate: record.operatingDate.toISOString(), runStatus: record.runStatus },
      createdBy: actorId,
    },
  });

  return record;
}

