import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioLineType, NightAuditAnomalyType, NightAuditRunStatus, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { randomUUID } from "node:crypto";
import { recalculateNextDayTimers } from "./next-day-timer-service.js";

function operatingDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function runNightAudit(prisma: PrismaClient, actorId: string, input: { operatingDate: string }) {
  if (!input.operatingDate?.trim()) throw new ValidationError("operatingDate is required");
  const d = new Date(input.operatingDate);
  if (Number.isNaN(d.getTime())) throw new ValidationError("operatingDate must be a valid ISO date");
  const operatingDate = operatingDateUtc(d);

  const existing = await prisma.nightAuditRecord.findUnique({ where: { operatingDate } });
  if (existing) {
    // idempotent rerun: do not create additional folio lines
    return existing;
  }

  const expected = (await requireActiveConfigValue<{ amount?: number; currency?: string } | undefined>(prisma, "nightAudit.expectedDailyFAndBCharge")) ?? {};
  const expectedAmount = typeof expected.amount === "number" ? expected.amount : 0;

  const entries = await prisma.entry.findMany({
    where: { currentStage: Stage.S7, status: "ACTIVE" },
    include: { reservation: true, folio: true },
  });

  // Pre-compute processing decisions outside transaction so the NightAuditRecord can be created in its final (immutable) form.
  const notProcessed: string[] = [];
  const plan: Array<{
    entryId: string;
    folioId: string;
    shouldPostRoomCharge: boolean;
    roomChargeAmount: number;
    shouldWriteFnbMissingAnomaly: boolean;
  }> = [];

  for (const entry of entries) {
    try {
      if (!entry.folio) throw new NotFoundError("Folio");
      if (entry.folio.state !== "LIVE") throw new StateTransitionError("Folio must be LIVE for night audit processing");

      const alreadyRoom = await prisma.folioLine.findFirst({
        where: { folioId: entry.folio.id, lineType: FolioLineType.ROOM_CHARGE, chargeDate: operatingDate },
      });
      const shouldPostRoomCharge = !alreadyRoom;
      const roomChargeAmount = num(entry.reservation?.frozenRate ?? null);

      const expectsFnb = expectedAmount > 0 && (entry.reservation?.frozenInclusions as Record<string, unknown> | null | undefined)?.dailyFAndBExpected === true;
      const hasFnb = expectsFnb
        ? await prisma.folioLine.findFirst({ where: { folioId: entry.folio.id, lineType: FolioLineType.F_AND_B, chargeDate: operatingDate } })
        : null;
      const shouldWriteFnbMissingAnomaly = expectsFnb && !hasFnb;

      plan.push({ entryId: entry.id, folioId: entry.folio.id, shouldPostRoomCharge, roomChargeAmount, shouldWriteFnbMissingAnomaly });
    } catch {
      notProcessed.push(entry.id);
    }
  }

  const processedCount = plan.length;
  const recordId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.nightAuditRecord.create({
      data: {
        id: recordId,
        operatingDate,
        runStatus: notProcessed.length === 0 ? NightAuditRunStatus.COMPLETE : NightAuditRunStatus.PARTIAL,
        entriesProcessedCount: processedCount,
        entriesNotProcessed: notProcessed,
        createdBy: actorId,
      },
    });

    for (const p of plan) {
      if (p.shouldPostRoomCharge) {
        await tx.folioLine.create({
          data: {
            folioId: p.folioId,
            lineType: FolioLineType.ROOM_CHARGE,
            description: "Night audit room charge",
            amount: p.roomChargeAmount,
            currency: "BTN",
            chargeDate: operatingDate,
            stage: Stage.S7,
            postedBy: actorId,
            nightAuditRecordId: recordId,
          },
        });
        await tx.folio.update({ where: { id: p.folioId }, data: { outstandingBalance: { increment: p.roomChargeAmount } } });
      }
      if (p.shouldWriteFnbMissingAnomaly) {
        await tx.nightAuditAnomaly.create({
          data: {
            nightAuditRecordId: recordId,
            entryId: p.entryId,
            anomalyType: NightAuditAnomalyType.MISSING_EXPECTED_CHARGE,
            description: "Expected daily F&B charge missing for operating date",
          },
        });
      }
    }

    // AC-S7-06: PARTIAL run escalates to FOM (modelled as an immutable TraceEvent).
    if (notProcessed.length > 0) {
      await (tx as any).traceEvent.create({
        data: {
          eventType: "NIGHT_AUDIT.PARTIAL_FOM_ESCALATED",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "NightAuditRecord",
          entityId: recordId,
          operation: "ALERT",
          timestamp: new Date(),
          stageContext: Stage.S7,
          inquiryId: null,
          entryId: null,
          payload: { operatingDate: operatingDate.toISOString(), entriesNotProcessed: notProcessed },
          createdBy: "SYSTEM",
        },
      });
    }
  });

  // AC-S7-07: after COMPLETE run, next-day timers are recalculated.
  if (notProcessed.length === 0) {
    await recalculateNextDayTimers(prisma, "SYSTEM", { operatingDate });
  }

  return prisma.nightAuditRecord.findUniqueOrThrow({ where: { operatingDate } });
}

