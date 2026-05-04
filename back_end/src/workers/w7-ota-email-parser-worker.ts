import type { PrismaClient } from "@prisma/client";

/**
 * W7 — OTA Email Parser poller.
 *
 * The SIG docs describe an IMAP polling + AI drafting pipeline. This repo slice doesn't include
 * the IMAP integration yet, but we still wire the pg-boss worker so the job type exists and can
 * be scheduled safely.
 */
export async function runOtaEmailParserPollWorker(prisma: PrismaClient, input: { pollId?: string } = {}) {
  await prisma.traceEvent.create({
    data: {
      eventType: "OTA_EMAIL_PARSER_POLL.NOOP",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "System",
      entityId: "W7",
      operation: "POLL",
      timestamp: new Date(),
      stageContext: "S1",
      inquiryId: null,
      entryId: null,
      payload: { pollId: typeof input.pollId === "string" ? input.pollId : null },
      createdBy: "SYSTEM",
    },
  });
  return { ok: true } as const;
}

