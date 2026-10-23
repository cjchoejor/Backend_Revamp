import type { PrismaClient } from "@prisma/client";

/**
 * SIG-S5 Policy 59 — per stay-night countdown registration (informational trace).
 * Does not post folio lines (night audit posting remains **W6** at S7 LIVE folio).
 */
export async function runNightAuditStayNightWorker(prisma: PrismaClient, input: { entryId?: string; operatingDateIso?: string }) {
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  const operatingDateIso = typeof input.operatingDateIso === "string" ? input.operatingDateIso : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const now = new Date();
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  // A reminder about a stay night means something only from Arrival to Check-out. A booking that
  // went back to an earlier step, or has ended, writes nothing — its clock is closed off instead
  // (2026-10-13).
  const atStay = ["S5", "S6", "S7", "S8"].includes(String(entry.currentStage));
  const ended = entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.status === "CLOSED";
  if (!atStay || ended) {
    await prisma.timerRecord.updateMany({
      where: {
        entryId,
        timerCode: "NIGHT_AUDIT_STAY_NIGHT_W37",
        status: "SCHEDULED",
        ...(operatingDateIso ? { payload: { equals: { entryId, operatingDateIso } } } : {}),
      },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: ended ? "BOOKING_ENDED" : "NOT_AT_STAY_STEP" },
    });
    return { skipped: true, reason: ended ? "BOOKING_ENDED" : "NOT_AT_STAY_STEP" } as const;
  }

  const timer =
    operatingDateIso != null
      ? await prisma.timerRecord.findFirst({
          where: {
            entryId,
            timerCode: "NIGHT_AUDIT_STAY_NIGHT_W37",
            status: "SCHEDULED",
            payload: { equals: { entryId, operatingDateIso } },
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.traceEvent.create({
      data: {
        eventType: "NIGHT_AUDIT_STAY_NIGHT.W37_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          entryId,
          operatingDateIso: operatingDateIso ?? null,
          currentStage: entry.currentStage,
        },
        createdBy: "SYSTEM",
      },
    });
    if (timer?.id) {
      await tx.timerRecord.updateMany({
        where: { id: timer.id, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }
  });

  return { skipped: false, entryId } as const;
}
