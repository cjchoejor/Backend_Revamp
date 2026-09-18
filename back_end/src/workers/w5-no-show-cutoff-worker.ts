import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import { NotFoundError } from "../lib/errors.js";
import { cancelTimerJobsBestEffort, computeNoShowFigures, finaliseNoShowTx, sendNoShowNoticeBestEffort } from "../services/application/no-show-service.js";

export async function runNoShowCutoffWorker(
  prisma: PrismaClient,
  engine: TimerEngine,
  input: { entryId?: string; timerRecordId?: string; timerType: "NO_SHOW_CUTOFF_W5" | "AWAITING_WRITTEN_CONFIRMATION_W5" },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, noShowDetermination: true, committedHold: true },
  });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  if (entry.currentStage !== Stage.S5) return { skipped: true, reason: "NOT_AT_S5" } as const;
  if (entry.noShowDetermination) return { skipped: true, reason: "ALREADY_DETERMINED" } as const;

  if (input.timerType === "NO_SHOW_CUTOFF_W5") {
    await prisma.$transaction(async (tx) => {
      await tx.entry.update({
        where: { id: entryId },
        data: { noShowCutoffReachedAt: now, version: { increment: 1 } },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "NO_SHOW_CUTOFF.FIRED",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "Entry",
          entityId: entryId,
          operation: "ALERT",
          timestamp: now,
          stageContext: Stage.S5,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, cutoffReachedAt: now.toISOString() },
          createdBy: "SYSTEM",
        },
      });
      // The clock firing is marked FIRED even when the job carries no record id — jobs armed
      // before 2026-09-18 never did, so the record stayed SCHEDULED and read as overdue.
      await tx.timerRecord.updateMany({
        where:
          typeof input.timerRecordId === "string"
            ? { id: input.timerRecordId, status: "SCHEDULED" }
            : { entryId, timerCode: input.timerType, status: "SCHEDULED", dueAt: { lte: new Date(now.getTime() + 60_000) } },
        data: { status: "FIRED", firedAt: now },
      });
    });

    return { skipped: false, entryId, phase: "CUTOFF_REACHED" } as const;
  }

  // AWAITING_WRITTEN_CONFIRMATION expiry (Sub-path 2b auto-finalisation). This is governed by prior
  // FOM deferral. Booked by the SAME finalisation as the FOM's determination (2026-09-18) — the
  // two used to close a no-show differently, and neither posted the charge or reached the Closed
  // step.
  if (!entry.folio) throw new NotFoundError("Folio");
  if (!entry.reservation) return { skipped: true, reason: "NO_RESERVATION" } as const;
  const figures = await computeNoShowFigures(prisma, entryId);

  const { timerJobIds } = await prisma.$transaction(async (tx) => {
    // The clock firing is marked FIRED first — the finalisation cancels whatever is still
    // SCHEDULED, and this one did fire.
    await tx.timerRecord.updateMany({
      where:
        typeof input.timerRecordId === "string"
          ? { id: input.timerRecordId, status: "SCHEDULED" }
          : { entryId, timerCode: input.timerType, status: "SCHEDULED", dueAt: { lte: new Date(now.getTime() + 60_000) } },
      data: { status: "FIRED", firedAt: now },
    });
    return finaliseNoShowTx(tx, {
      entryId,
      actorId: "SYSTEM",
      path: "SUB_PATH_2B_AUTO",
      contactAttemptLog: [],
      decisionReason: "The wait for written confirmation ran out — no-show finalised automatically",
      figures,
      now,
    });
  });
  await cancelTimerJobsBestEffort(timerJobIds);
  await sendNoShowNoticeBestEffort(prisma, entryId, "SYSTEM", figures);

  return { skipped: false, entryId, phase: "AUTO_FINALISED" } as const;
}

