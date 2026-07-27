import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import { dispatchStageEmailBestEffort } from "../services/infrastructure/stage-email-helpers.js";
import { renderFeedbackSolicitationEmail } from "../services/infrastructure/stage-email-templates.js";
import { allocateReadableId } from "../lib/readable-id.js";

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

  // Atomicity: mark the timer FIRED INSIDE the same transaction that writes the comm records
  // and the idempotency trace. Race the other way and a rollback leaves timer=FIRED with no
  // trace / no comm records — worker retry then sees NO_TIMER (no SCHEDULED row) and the guest
  // never gets the solicitation. The updateMany with `status: "SCHEDULED"` filter also protects
  // against a concurrent cancel: if the timer was cancelled between the findFirst and here,
  // updateMany returns 0 rows and the work is skipped.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.timerRecord.updateMany({
      where: { id: timer.id, status: "SCHEDULED" },
      data: { status: "FIRED", firedAt: now } as any,
    });
    if (claimed.count === 0) {
      // Cancelled between findFirst and the claim — abort silently. Nothing to undo.
      throw new Error("TIMER_ALREADY_CLAIMED_OR_CANCELLED");
    }
    const emailId = await allocateReadableId(tx, "COMMUNICATION" as const, now);
    const whatsappId = await allocateReadableId(tx, "COMMUNICATION" as const, now);
    await tx.communicationRecord.createMany({
      data: [
        { id: emailId, entryId: entry.id, channel: "EMAIL", commType: "FEEDBACK_SOLICITATION", stageContext: Stage.S9, payload: { entryId: entry.id }, createdBy: "SYSTEM" } as any,
        { id: whatsappId, entryId: entry.id, channel: "WHATSAPP", commType: "FEEDBACK_SOLICITATION", stageContext: Stage.S9, payload: { entryId: entry.id }, createdBy: "SYSTEM" } as any,
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
  }).catch((e) => {
    if (e instanceof Error && e.message === "TIMER_ALREADY_CLAIMED_OR_CANCELLED") return;
    throw e;
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

