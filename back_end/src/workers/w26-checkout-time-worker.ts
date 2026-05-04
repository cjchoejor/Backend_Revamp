import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W26 — Checkout time compliance prompts / late checkout escalation.
 *
 * Scheduling strategy (per SIG): next-day timers based on property.checkoutTime and lateCheckoutGraceWindow.
 * This repo slice wires the worker for pg-boss execution; full scheduling is handled elsewhere.
 */
export async function runCheckoutTimeWorker(prisma: PrismaClient, input: { entryId?: string; timerRecordId?: string; kind?: "PROMPT" | "ESCALATE" }) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "CHECKOUT_TIME.W26_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: typeof input.entryId === "string" ? input.entryId : "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: null,
        entryId: typeof input.entryId === "string" ? input.entryId : null,
        payload: { kind: input.kind ?? "PROMPT" },
        createdBy: "SYSTEM",
      },
    });
  });
  return { ok: true } as const;
}

