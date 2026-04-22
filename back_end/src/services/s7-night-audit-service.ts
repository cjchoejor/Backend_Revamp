import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioLineType, NightAuditAnomalyType, NightAuditRunStatus, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../lib/errors.js";

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

  const cfg = await prisma.configurationEntry.findUnique({ where: { configKey: "nightAudit.expectedDailyFAndBCharge" } });
  if (!cfg) throw new MissingConfigurationError("nightAudit.expectedDailyFAndBCharge");
  const expected = (cfg.value as { amount?: number; currency?: string } | undefined) ?? {};
  const expectedAmount = typeof expected.amount === "number" ? expected.amount : 0;

  const entries = await prisma.entry.findMany({
    where: { currentStage: Stage.S7, status: "ACTIVE" },
    include: { reservation: true, folio: true },
  });

  const notProcessed: string[] = [];
  let processedCount = 0;

  await prisma.$transaction(async (tx) => {
    // Create record up-front, then update counts at end (PARTIAL/COMPLETE).
    const record = await tx.nightAuditRecord.create({
      data: {
        operatingDate,
        runStatus: NightAuditRunStatus.PARTIAL,
        entriesProcessedCount: 0,
        entriesNotProcessed: [],
        createdBy: actorId,
      },
    });

    for (const entry of entries) {
      try {
        if (!entry.folio) throw new NotFoundError("Folio");
        if (entry.folio.state !== "LIVE") throw new StateTransitionError("Folio must be LIVE for night audit processing");

        // Idempotency per-entry: if a ROOM_CHARGE exists for this operating date, treat as already processed.
        const already = await tx.folioLine.findFirst({
          where: { folioId: entry.folio.id, lineType: FolioLineType.ROOM_CHARGE, chargeDate: operatingDate },
        });
        if (!already) {
          const rate = num(entry.reservation?.frozenRate ?? null);
          await tx.folioLine.create({
            data: {
              folioId: entry.folio.id,
              lineType: FolioLineType.ROOM_CHARGE,
              description: "Night audit room charge",
              amount: rate,
              currency: "BTN",
              chargeDate: operatingDate,
              stage: Stage.S7,
              postedBy: actorId,
              nightAuditRecordId: record.id,
            },
          });
          await tx.folio.update({ where: { id: entry.folio.id }, data: { outstandingBalance: { increment: rate } } });
        }

        // Expected daily F&B charge anomaly (do not auto-post)
        if (expectedAmount > 0 && (entry.reservation?.frozenInclusions as Record<string, unknown> | null | undefined)?.dailyFAndBExpected === true) {
          const hasFnb = await tx.folioLine.findFirst({
            where: { folioId: entry.folio.id, lineType: FolioLineType.F_AND_B, chargeDate: operatingDate },
          });
          if (!hasFnb) {
            await tx.nightAuditAnomaly.create({
              data: {
                nightAuditRecordId: record.id,
                entryId: entry.id,
                anomalyType: NightAuditAnomalyType.MISSING_EXPECTED_CHARGE,
                description: "Expected daily F&B charge missing for operating date",
              },
            });
          }
        }

        processedCount += 1;
      } catch (_e) {
        notProcessed.push(entry.id);
      }
    }

    await tx.nightAuditRecord.update({
      where: { id: record.id },
      data: {
        runStatus: notProcessed.length === 0 ? NightAuditRunStatus.COMPLETE : NightAuditRunStatus.PARTIAL,
        entriesProcessedCount: processedCount,
        entriesNotProcessed: notProcessed,
      },
    });
  });

  return prisma.nightAuditRecord.findUniqueOrThrow({ where: { operatingDate } });
}

