import type { PrismaClient } from "@prisma/client";
import { EntryStatus, FolioState, Stage } from "@prisma/client";
import {
  MissingConfigurationError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceNoShowDeterminationPrereqs, enforceNoShowDeterminationNotAlreadyRecorded } from "../../policies/22-no-show/p56-no-show-determination-prereqs.js";
import { enforceEntryAtS5ForNoShowActions } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { toDecimal } from "../../lib/money.js";
import {
  capCancellationPenaltyAtAdvancePayment,
  sumAdvancePaymentInTotalForFolio,
} from "../../policies/14-cancellation/p35-cancellation-penalty-from-commitment.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";

type ContactAttempt = { channel: string; attemptedAt: string; outcome: string; response?: string };

export async function determineNoShow(
  prisma: PrismaClient,
  entryId: string,
  fomActorId: string,
  body: {
    determinationPath: "SUB_PATH_1" | "DEFER" | "REACTIVATE";
    contactAttemptLog: ContactAttempt[];
    decisionReason: string;
    awaitingConfirmationWindowMinutes?: number;
  },
) {
  await requireActiveConfigValue<number>(prisma, "noShow.cutoffWindowMinutes");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, noShowDetermination: true },
  });

  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS5ForNoShowActions({ currentStage: entry.currentStage });

  enforceNoShowDeterminationNotAlreadyRecorded({ hasExistingDetermination: !!entry.noShowDetermination });

  enforceNoShowDeterminationPrereqs({
    hasCutoffReached: !!entry.noShowCutoffReachedAt,
    contactAttemptCount: body.contactAttemptLog?.length ?? 0,
  });

  if (body.determinationPath === "DEFER") {
    const now = new Date();
    const minutes =
      body.awaitingConfirmationWindowMinutes ??
      (await requireActiveConfigValue<number>(prisma, "noShow.awaitingConfirmationWindowMinutes", { now }));
    if (minutes < 1) throw new ValidationError("awaitingConfirmationWindowMinutes must be >= 1");

    const engine = await getTimerEngine();
    const firesAt = new Date(now.getTime() + minutes * 60_000);
    const jobId = await engine.schedule("AWAITING_WRITTEN_CONFIRMATION_W5", { entryId }, { startAfter: firesAt });

    await prisma.$transaction(async (tx) => {
      await tx.timerRecord.create({
        data: {
          entryId,
          entityType: "Entry",
          entityId: entryId,
          timerType: "AWAITING_WRITTEN_CONFIRMATION_W5",
          timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5",
          stageContext: Stage.S5,
          firesAt,
          dueAt: firesAt,
          status: "SCHEDULED",
          payload: { entryId, firesAt: firesAt.toISOString() },
          pgBossJobId: jobId,
          createdBy: fomActorId,
        },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "NO_SHOW.DEFERRAL_AWAITING_WRITTEN_CONFIRMATION",
          actorId: fomActorId,
          actorLevel: "L2",
          entityType: "Entry",
          entityId: entryId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S5,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, firesAt: firesAt.toISOString(), minutes },
          createdBy: fomActorId,
        },
      });
    });

    // SIG-S5 AC-S5-008: sub-state is not expressed via Entry field changes.
    return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  }

  if (body.determinationPath === "REACTIVATE") {
    const now = new Date();
    const timers = await prisma.timerRecord.findMany({
      where: { entryId, status: "SCHEDULED", timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    const engine = await getTimerEngine();
    for (const t of timers) {
      if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
    }

    await prisma.$transaction(async (tx) => {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: fomActorId, cancelledReason: "FOM reactivated S5" },
      });
      await tx.entry.update({
        where: { id: entryId },
        data: { awaitingWrittenConfirmationActive: false, noShowCutoffReachedAt: null, version: { increment: 1 } },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "NO_SHOW.REACTIVATED",
          actorId: fomActorId,
          actorLevel: "L2",
          entityType: "Entry",
          entityId: entryId,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S5,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId },
          createdBy: fomActorId,
        },
      });
    });

    return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  }

  // SUB_PATH_1
  if (!body.decisionReason?.trim()) {
    throw new ValidationError("decisionReason is required for SUB_PATH_1");
  }

  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const terms = (entry.reservation?.frozenCancellationTerms as { sameDayPenaltyAmount?: unknown } | null) ?? {};
  // Decimal-safe: parse penalty through Decimal so a config value like "1500.10" doesn't drift
  // to 1500.0999... via Number().
  const penaltyRawDec = toDecimal((terms.sameDayPenaltyAmount as string | number | null | undefined) ?? 0);
  const penaltyRaw = Number(penaltyRawDec.toFixed(2));
  const advanceTotal = await sumAdvancePaymentInTotalForFolio(prisma, folio.id);
  const penalty = capCancellationPenaltyAtAdvancePayment(Number.isFinite(penaltyRaw) ? penaltyRaw : 0, advanceTotal);

  const net = Number(toDecimal(advanceTotal).sub(toDecimal(penalty)).toFixed(2));

  const noShowId = await allocateReadableId(prisma, "NO_SHOW" as const);

  await prisma.$transaction([
    prisma.noShowDeterminationRecord.create({
      data: {
        id: noShowId,
        entryId,
        determinationPath: "SUB_PATH_1",
        fomActorId,
        contactAttemptLog: body.contactAttemptLog as object[],
        decisionReason: body.decisionReason.trim(),
        otaNotificationRequired: entry.otaSource,
        otaNotificationStatus: entry.otaSource ? "OPEN" : null,
        createdBy: fomActorId,
      },
    }),
    prisma.folio.update({
      where: { id: folio.id },
      data: {
        state: FolioState.NO_SHOW_CLOSED,
        noShowPenaltyAmount: penalty,
        noShowAdvancePaymentAmount: advanceTotal,
        noShowNetPosition: net,
        noShowFomDetermination: fomActorId,
        closedAt: new Date(),
        closedBy: fomActorId,
      },
    }),
    prisma.entry.update({
      where: { id: entryId },
      data: {
        currentStage: Stage.TERMINAL,
        status: EntryStatus.ACTIVE,
        closedAt: new Date(),
        closedBy: fomActorId,
        version: { increment: 1 },
      },
    }),
  ]);

  if (net > 0) {
    await prisma.$transaction(async (tx) => {
      const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
      await tx.paymentRecord.create({
        data: {
          id: paymentId,
          folioId: folio.id,
          amount: net,
          paymentDirection: "OUT",
          notes: "Refund obligation after no-show penalty (seed S5 slice)",
        },
      });
      await recomputeFolioOutstandingBalance(tx, folio.id);
    });
  }

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId }, include: { noShowDetermination: true, folio: true } });
}
