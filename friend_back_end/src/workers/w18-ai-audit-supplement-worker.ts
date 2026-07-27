import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W18 — AI audit supplement generation after night audit completion.
 *
 * Not fully implemented in this repo slice; the worker is wired so it can be scheduled safely.
 */
export async function runAiAuditSupplementWorker(prisma: PrismaClient, input: { nightAuditRecordId?: string }) {
  await prisma.traceEvent.create({
    data: {
      eventType: "AI_AUDIT_SUPPLEMENT.W18_NOOP",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "NightAuditRecord",
      entityId: typeof input.nightAuditRecordId === "string" ? input.nightAuditRecordId : "UNKNOWN",
      operation: "GENERATE",
      timestamp: new Date(),
      stageContext: Stage.S7,
      inquiryId: null,
      entryId: null,
      payload: { nightAuditRecordId: typeof input.nightAuditRecordId === "string" ? input.nightAuditRecordId : null },
      createdBy: "SYSTEM",
    },
  });
  return { ok: true } as const;
}

