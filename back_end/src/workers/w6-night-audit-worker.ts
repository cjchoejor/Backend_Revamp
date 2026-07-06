import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { runNightAudit } from "../services/application/s7-night-audit-service.js";

export async function runNightAuditWorker(
  prisma: PrismaClient,
  input: { operatingDate?: string; operatingDateOffsetDays?: number; actorId?: string },
) {
  const actorId = typeof input.actorId === "string" ? input.actorId : "SYSTEM";
  // An explicit operatingDate (e.g. the manual POST /night-audit/run path) always wins. Otherwise
  // derive it from now shifted by operatingDateOffsetDays (UTC): offset 0 = the run date (bare
  // default, unchanged); the recurring 02:00 schedule passes -1 so the nightly audit closes the
  // day that just ended (Convention B) rather than the freshly-started calendar day.
  let operatingDate: string;
  if (typeof input.operatingDate === "string") {
    operatingDate = input.operatingDate;
  } else {
    const offsetDays = typeof input.operatingDateOffsetDays === "number" ? input.operatingDateOffsetDays : 0;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    operatingDate = d.toISOString();
  }

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

