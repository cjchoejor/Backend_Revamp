import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { dispatchStageEmailBestEffort } from "../services/infrastructure/stage-email-helpers.js";
import { renderFeedbackSolicitationEmail } from "../services/infrastructure/stage-email-templates.js";

/**
 * W28 — Feedback solicitation dispatch (dual-channel).
 * Implements AC-S9-026..030.
 */
export async function runFeedbackSolicitationWorker(prisma: PrismaClient, input: { entryId: string }) {
  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    include: { folio: true, guestProfile: true, reservation: true },
  });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  if (entry.status === EntryStatus.CANCELLED || entry.status === EntryStatus.EXPIRED) return { skipped: true, reason: "STATUS_EXCLUDED" } as const;
  if (entry.status !== EntryStatus.CLOSED) return { skipped: true, reason: "NOT_CLOSED" } as const;
  if (entry.folio?.state === "NO_SHOW_CLOSED") return { skipped: true, reason: "NO_SHOW_EXCLUDED" } as const;

  const existingTrace = await prisma.traceEvent.findFirst({
    where: { entryId: entry.id, eventType: "FEEDBACK.SOLICITATION_SENT" },
    orderBy: { createdAt: "desc" },
  });
  if (existingTrace) return { skipped: true, reason: "IDEMPOTENT_TRACE_EXISTS" } as const;

  const timer = await prisma.timerRecord.findFirst({
    where: { entryId: entry.id, timerCode: "FEEDBACK_SOLICITATION_W28", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  if (!timer) return { skipped: true, reason: "NO_TIMER" } as const;

  const now = new Date();

  // fire timer
  await prisma.timerRecord.update({ where: { id: timer.id }, data: { status: "FIRED", firedAt: now } as any });

  await prisma.$transaction(async (tx) => {
    await tx.communicationRecord.createMany({
      data: [
        { entryId: entry.id, channel: "EMAIL", commType: "FEEDBACK_SOLICITATION", stageContext: Stage.S9, payload: { entryId: entry.id }, createdBy: "SYSTEM" } as any,
        { entryId: entry.id, channel: "WHATSAPP", commType: "FEEDBACK_SOLICITATION", stageContext: Stage.S9, payload: { entryId: entry.id }, createdBy: "SYSTEM" } as any,
      ],
    });
    await (tx as any).traceEvent.create({
      data: {
        eventType: "FEEDBACK.SOLICITATION_SENT",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entry.id,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, channelsDispatched: ["EMAIL", "WHATSAPP"] },
        createdBy: "SYSTEM",
      },
    });
  });

  // Phase 3 — outbound feedback solicitation email (best-effort, post-tx).
  const displayName =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";
  const ci = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? new Date();
  const co = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? new Date(ci.getTime() + 86400_000);
  const content = renderFeedbackSolicitationEmail({
    guestDisplayName: displayName,
    checkInDate: ci,
    checkOutDate: co,
  });
  await dispatchStageEmailBestEffort(
    {
      prisma,
      entryId: entry.id,
      actorId: "SYSTEM",
      inquiryId: entry.inquiryId,
      guestEmail: entry.guestProfile?.email ?? null,
      stage: Stage.S9,
      eventTypePrefix: "FEEDBACK_EMAIL",
    },
    content,
  );

  return { skipped: false, entryId: entry.id, timerId: timer.id } as const;
}

