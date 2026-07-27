import type { PrismaClient } from "@prisma/client";
import * as auditService from "../services/infrastructure/audit-service.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

/**
 * W7 — OTA Email Parser poller.
 *
 * The SIG docs describe an IMAP polling + AI drafting pipeline. This repo slice doesn't include
 * the IMAP integration yet, but we still wire the pg-boss worker so the job type exists and can
 * be scheduled safely.
 */
export async function runOtaEmailParserPollWorker(prisma: PrismaClient, input: { pollId?: string } = {}) {
  const now = new Date();
  const pollId = typeof input.pollId === "string" ? input.pollId : null;

  // Placeholder: until IMAP integration exists, we emulate a single “message” per poll when pollId is provided.
  const externalMessageId = pollId ? `IMAP:${pollId}` : null;

  if (externalMessageId) {
    const existing = await prisma.communicationRecord.findFirst({ where: { messageId: externalMessageId } });
    if (existing) {
      await auditService.emit(prisma, auditService.systemActor(), {
        eventType: "OTA_EMAIL.RECEIVED.SKIPPED_DUPLICATE",
        entityType: "CommunicationRecord",
        entityId: existing.id,
        operation: "SKIP",
        timestamp: now,
        stageContext: "S1",
        payload: { messageId: externalMessageId, pollId },
        createdBy: "SYSTEM",
      });
      return { ok: true, skipped: true, reason: "DUPLICATE_MESSAGE_ID" } as const;
    }

    const comm = await prisma.communicationRecord.create({
      data: {
        entryId: null,
        channel: "EMAIL" as any,
        commType: "QUOTATION" as any,
        stageContext: "S1" as any,
        direction: "INBOUND",
        messageId: externalMessageId,
        sendStatus: "RECEIVED",
        acknowledgementStatus: "PENDING",
        contentSummary: "W7 placeholder ingestion (no IMAP yet)",
        actorId: "SYSTEM",
        payload: { pollId, messageId: externalMessageId },
        createdBy: "SYSTEM",
      } as any,
    });

    await auditService.emit(prisma, auditService.systemActor(), {
      eventType: "OTA_EMAIL.RECEIVED",
      entityType: "CommunicationRecord",
      entityId: comm.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: "S1",
      payload: { messageId: externalMessageId, communicationId: comm.id, pollId },
      createdBy: "SYSTEM",
    });

    const thresholds = await requireActiveConfigValue<Record<string, number>>(prisma, "ai.confidence.thresholds.perIntent").catch(() => ({ DEFAULT: 0.7 }));
    const threshold = typeof thresholds.DEFAULT === "number" ? thresholds.DEFAULT : 0.7;

    // Placeholder classifier: if pollId ends with an even digit, treat as high-confidence.
    const confidenceScore = pollId && /\d$/.test(pollId) ? (Number(pollId[pollId.length - 1]) % 2 === 0 ? 0.9 : 0.5) : 0.5;
    const intentCategory = "INQUIRY_CREATE";

    if (confidenceScore >= threshold) {
      const draft = await (prisma as any).aiDraftRecord.create({
        data: {
          communicationId: comm.id,
          intentCategory,
          confidenceScore,
          draftContent: "Placeholder draft: create inquiry from parsed OTA email (IMAP integration pending).",
          status: "PENDING_REVIEW",
          reviewTtlExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          createdBy: "SYSTEM",
        },
      });
      await auditService.emit(prisma, auditService.systemActor(), {
        eventType: "OTA_EMAIL.AI_DRAFT_CREATED",
        entityType: "AiDraftRecord",
        entityId: draft.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: "S1",
        payload: { communicationId: comm.id, draftId: draft.id, intentCategory, confidenceScore, threshold },
        createdBy: "SYSTEM",
      });
    } else {
      await auditService.emit(prisma, auditService.systemActor(), {
        eventType: "OTA_EMAIL.ESCALATED_TO_HUMAN",
        entityType: "CommunicationRecord",
        entityId: comm.id,
        operation: "ESCALATE",
        timestamp: now,
        stageContext: "S1",
        payload: { communicationId: comm.id, intentCategory, confidenceScore, threshold },
        createdBy: "SYSTEM",
      });
    }
  }

  await auditService.emit(prisma, auditService.systemActor(), {
    eventType: "OTA_EMAIL_PARSER_POLL.NOOP",
    entityType: "System",
    entityId: "W7",
    operation: "POLL",
    timestamp: now,
    stageContext: "S1",
    inquiryId: null,
    entryId: null,
    payload: { pollId, messageId: externalMessageId },
    createdBy: "SYSTEM",
  });
  return { ok: true } as const;
}

