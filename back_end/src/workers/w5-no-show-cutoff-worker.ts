import type { PrismaClient } from "@prisma/client";
import { EntryStatus, FolioState, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import { NotFoundError } from "../lib/errors.js";
import { allocateReadableId } from "../lib/readable-id.js";
import { releaseRoomOnNoShowTerminalTx } from "../lib/release-room-on-no-show.js";

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
      if (typeof input.timerRecordId === "string") {
        await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
      }
    });

    return { skipped: false, entryId, phase: "CUTOFF_REACHED" } as const;
  }

  // AWAITING_WRITTEN_CONFIRMATION expiry (Sub-path 2b auto-finalisation). This is governed by prior FOM deferral.
  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const terms = (entry.reservation?.frozenCancellationTerms as { sameDayPenaltyAmount?: number } | null) ?? {};
  const penaltyRaw = terms.sameDayPenaltyAmount ?? 0;

  const agg = await prisma.paymentRecord.aggregate({
    where: { folioId: folio.id, paymentDirection: "IN" },
    _sum: { amount: true },
  });
  const advanceTotal = Number(agg._sum.amount?.toString() ?? "0");
  const penalty = Math.min(penaltyRaw, advanceTotal);
  const net = advanceTotal - penalty;

  await prisma.$transaction(async (tx) => {
    const noShowId = await allocateReadableId(tx, "NO_SHOW" as const);
    await tx.noShowDeterminationRecord.create({
      data: {
        id: noShowId,
        entryId,
        determinationPath: "SUB_PATH_2B_AUTO",
        fomActorId: "SYSTEM",
        contactAttemptLog: [],
        decisionReason: "AWAITING_WRITTEN_CONFIRMATION timer expired — auto-finalised",
        otaNotificationRequired: entry.otaSource,
        otaNotificationStatus: entry.otaSource ? "OPEN" : null,
        createdBy: "SYSTEM",
      },
    });
    await tx.folio.update({
      where: { id: folio.id },
      data: {
        state: FolioState.NO_SHOW_CLOSED,
        noShowPenaltyAmount: penalty,
        noShowAdvancePaymentAmount: advanceTotal,
        noShowNetPosition: net,
        noShowFomDetermination: "SYSTEM",
        closedAt: now,
        closedBy: "SYSTEM",
      },
    });
    await tx.entry.update({
      where: { id: entryId },
      data: {
        currentStage: Stage.TERMINAL,
        status: EntryStatus.ACTIVE,
        closedAt: now,
        closedBy: "SYSTEM",
        awaitingWrittenConfirmationActive: false,
        version: { increment: 1 },
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "NO_SHOW.AUTO_FINALISED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S5,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, penalty, advanceTotal, net },
        createdBy: "SYSTEM",
      },
    });

    // SIG-S5 §1.5 (no-show #5) — return the held room to available inventory.
    await releaseRoomOnNoShowTerminalTx(tx, { entryId, committedHold: entry.committedHold, actorId: "SYSTEM", now });

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }
  });

  // Best-effort cancel any scheduled no-show timers after closure.
  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED", timerCode: { in: ["NO_SHOW_CUTOFF_W5", "AWAITING_WRITTEN_CONFIRMATION_W5"] } },
  });
  for (const t of timers) {
    if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
  }
  await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "No-show finalised" },
  });

  return { skipped: false, entryId, phase: "AUTO_FINALISED" } as const;
}

