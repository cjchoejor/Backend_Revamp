import type { PrismaClient } from "@prisma/client";
import { EntryStatus, FolioState, Stage } from "@prisma/client";
import {
  MissingConfigurationError,
  NotFoundError,
  PolicyGateBlockedError,
  StateTransitionError,
  ValidationError,
} from "../lib/errors.js";

type ContactAttempt = { channel: string; attemptedAt: string; outcome: string; response?: string };

function sumAdvancePayments(prisma: PrismaClient, folioId: string) {
  return prisma.paymentRecord.aggregate({
    where: { folioId, paymentDirection: "IN" },
    _sum: { amount: true },
  });
}

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
  const cutoffCfg = await prisma.configurationEntry.findUnique({ where: { configKey: "noShow.cutoffWindowMinutes" } });
  if (!cutoffCfg) {
    throw new MissingConfigurationError("noShow.cutoffWindowMinutes");
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, noShowDetermination: true },
  });

  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S5) {
    throw new StateTransitionError("No-show actions are only valid at S5");
  }

  if (entry.noShowDetermination) {
    throw new StateTransitionError("No-show determination already recorded for this entry");
  }

  if (!body.contactAttemptLog?.length) {
    throw new PolicyGateBlockedError("CONTACT_ATTEMPTS_REQUIRED", "At least one contact attempt is required");
  }

  if (!entry.noShowCutoffReachedAt) {
    throw new PolicyGateBlockedError("CUTOFF_NOT_REACHED", "No-show cutoff has not been recorded for this entry");
  }

  if (body.determinationPath === "DEFER") {
    if (body.awaitingConfirmationWindowMinutes == null || body.awaitingConfirmationWindowMinutes < 1) {
      throw new ValidationError("awaitingConfirmationWindowMinutes is required when determinationPath is DEFER");
    }
    return prisma.entry.update({
      where: { id: entryId },
      data: {
        awaitingWrittenConfirmationActive: true,
        version: { increment: 1 },
      },
    });
  }

  if (body.determinationPath === "REACTIVATE") {
    return prisma.entry.update({
      where: { id: entryId },
      data: {
        awaitingWrittenConfirmationActive: false,
        noShowCutoffReachedAt: null,
        version: { increment: 1 },
      },
    });
  }

  // SUB_PATH_1
  if (!body.decisionReason?.trim()) {
    throw new ValidationError("decisionReason is required for SUB_PATH_1");
  }

  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const terms = (entry.reservation?.frozenCancellationTerms as { sameDayPenaltyAmount?: number } | null) ?? {};
  const penaltyRaw = terms.sameDayPenaltyAmount ?? 0;

  const paid = await sumAdvancePayments(prisma, folio.id);
  const advanceTotal = Number(paid._sum.amount?.toString() ?? "0");
  const penalty = Math.min(penaltyRaw, advanceTotal);

  const net = advanceTotal - penalty;

  await prisma.$transaction([
    prisma.noShowDeterminationRecord.create({
      data: {
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
    await prisma.paymentRecord.create({
      data: {
        folioId: folio.id,
        amount: net,
        paymentDirection: "OUT",
        notes: "Refund obligation after no-show penalty (seed S5 slice)",
      },
    });
  }

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId }, include: { noShowDetermination: true, folio: true } });
}
