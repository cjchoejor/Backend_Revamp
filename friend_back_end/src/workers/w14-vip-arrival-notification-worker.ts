import type { PrismaClient } from "@prisma/client";
import { CommunicationType, Stage } from "@prisma/client";
import * as auditService from "../services/infrastructure/audit-service.js";

/**
 * Atlas Cat 08 — W14 VIPArrivalNotificationWorker (SIG-S6 §7).
 * Idempotent follow-up after synchronous VIP issuance at S5→S6: audit trail for ops / future outbound channels.
 */
export async function runVipArrivalNotificationWorker(prisma: PrismaClient, input: Record<string, unknown> = {}) {
  const entryId = typeof input.entryId === "string" ? input.entryId : "";
  if (!entryId) {
    return { skipped: true, reason: "NO_ENTRY_ID" } as const;
  }

  const evt = await prisma.vIPArrivalNotificationEvent.findFirst({
    where: { entryId },
    orderBy: { createdAt: "desc" },
  });
  if (!evt) {
    return { skipped: true, reason: "NO_VIP_ARRIVAL_RECORD" } as const;
  }

  const commCount = await prisma.communicationRecord.count({
    where: { entryId, commType: CommunicationType.VIP_ARRIVAL_NOTIFICATION },
  });
  const roles = Array.isArray(evt.recipientRoles) ? (evt.recipientRoles as unknown[]).length : 0;

  await auditService.emit(prisma, auditService.systemActor(), {
    eventType: "NOTIFICATION.VIP_ARRIVAL_W14_PROCESSED",
    entityType: "VIPArrivalNotificationEvent",
    entityId: evt.id,
    operation: "NOTIFY",
    timestamp: new Date(),
    stageContext: Stage.S6,
    inquiryId: null,
    entryId,
    payload: {
      entryId,
      vipArrivalNotificationEventId: evt.id,
      communicationRecordsForVip: commCount,
      configuredRecipientRoles: roles,
    },
    createdBy: "SYSTEM",
  });

  return { ok: true, entryId, vipArrivalNotificationEventId: evt.id, communicationRecordsForVip: commCount } as const;
}
