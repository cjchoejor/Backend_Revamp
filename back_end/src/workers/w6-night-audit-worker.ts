import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { runNightAudit } from "../services/application/s7-night-audit-service.js";
import { addUtcDays, hotelTodayUtc } from "../lib/stay-dates.js";

/**
 * Which night a scheduled run audits: today on the HOTEL's calendar, shifted by the offset — so
 * `-1` is the night that has just ended, whatever hour the schedule fires (2026-09-25). It used
 * to shift the UTC date, which is a day behind Bhutan until 06:00: a run set for five in the
 * morning would have audited the night before last.
 */
export function operatingDateForRun(now: Date, offsetDays: number): Date {
  return addUtcDays(hotelTodayUtc(now), offsetDays);
}

export async function runNightAuditWorker(
  prisma: PrismaClient,
  input: { operatingDate?: string; operatingDateOffsetDays?: number; actorId?: string },
) {
  const actorId = typeof input.actorId === "string" ? input.actorId : "SYSTEM";
  // An explicit operatingDate (e.g. the manual POST /night-audit/run path) always wins. Otherwise
  // derive it from the hotel's day shifted by operatingDateOffsetDays: offset 0 = the run date;
  // the recurring schedule passes -1 so the nightly audit closes the night that just ended
  // (Convention B) rather than the freshly-started calendar day.
  let operatingDate: string;
  if (typeof input.operatingDate === "string") {
    operatingDate = input.operatingDate;
  } else {
    const offsetDays = typeof input.operatingDateOffsetDays === "number" ? input.operatingDateOffsetDays : 0;
    operatingDate = operatingDateForRun(new Date(), offsetDays).toISOString();
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

