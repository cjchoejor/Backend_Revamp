import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioLineType, FolioState, NightAuditRunStatus, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { enforceCreditCeilingChargePostingGate } from "../../policies/18-credit-extension-ceiling/p45-credit-ceiling-charge-posting-gate.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

function operatingDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function isMandatoryNightAuditLine(lineType: FolioLineType): boolean {
  return lineType === FolioLineType.ROOM_CHARGE;
}

async function writeCeilingTrace(db: DbClient, args: { entryId: string; actorId: string; eventType: string; payload: Record<string, unknown> }) {
  const now = new Date();
  await (db as any).traceEvent.create({
    data: {
      eventType: args.eventType,
      actorId: args.actorId,
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: args.entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: null,
      entryId: args.entryId,
      payload: args.payload,
      createdBy: args.actorId,
    },
  });
}

async function ensureChargeDateNotSealed(db: DbClient, chargeDate: Date) {
  const op = operatingDateUtc(chargeDate);
  const sealed = await db.nightAuditRecord.findUnique({ where: { operatingDate: op } });
  if (sealed?.runStatus === NightAuditRunStatus.COMPLETE) {
    throw new StateTransitionError("Charge date is sealed by completed night audit", "SEALED_AUDIT_DATE", { operatingDate: op.toISOString() });
  }
}

async function maybeWriteCreditCeilingEvents(db: DbClient, args: { entryId: string; folioId: string; ceilingAmount: Prisma.Decimal; outstandingBalance: Prisma.Decimal; actorId: string }) {
  const v = (await requireActiveConfigValue<{ tier1Percent?: number; tier2Percent?: number } | undefined>(db as any, "creditCeiling.proximityThresholds")) ?? {};
  const tier1 = typeof v.tier1Percent === "number" ? v.tier1Percent : 75;
  const tier2 = typeof v.tier2Percent === "number" ? v.tier2Percent : 90;

  const ceilingN = num(args.ceilingAmount);
  if (ceilingN <= 0) return;
  const outN = num(args.outstandingBalance);
  const ratio = outN / ceilingN;

  const now = new Date();
  const write = async (thresholdPercent: number) => {
    await db.creditCeilingThresholdEvent.create({
      data: {
        entryId: args.entryId,
        folioId: args.folioId,
        ceilingAmount: args.ceilingAmount,
        outstandingBalance: args.outstandingBalance,
        thresholdPercent,
        createdAt: now,
        createdBy: args.actorId,
      },
    });
    // SIG-S7: W12 dispatch for monitoring/notification on threshold crossing.
    try {
      const engine = await getTimerEngine();
      await engine.schedule("CREDIT_CEILING_MONITORING_W12", { entryId: args.entryId, folioId: args.folioId, thresholdPercent }, { startAfter: now });
    } catch {
      // Notification dispatch is best-effort; policy enforcement remains in-band.
    }
  };

  if (ratio >= tier1 / 100) await write(tier1);
  if (ratio >= tier2 / 100) await write(tier2);
  if (ratio >= 1) await write(100);
}

export async function postCharge(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: {
    entryId: string;
    lineType: FolioLineType;
    description: string;
    amount: number;
    currency?: string;
    chargeDate: string;
    allowSoftGateBypass?: boolean;
  },
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.description?.trim()) throw new ValidationError("description is required");
  if (!Number.isFinite(input.amount)) throw new ValidationError("amount must be a number");
  if (!input.chargeDate?.trim()) throw new ValidationError("chargeDate is required");

  const chargeDate = new Date(input.chargeDate);
  if (Number.isNaN(chargeDate.getTime())) throw new ValidationError("chargeDate must be a valid ISO date");

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");
  if (folio.state !== FolioState.LIVE) throw new StateTransitionError(`Folio must be LIVE at S7 (current: ${folio.state})`);

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S7) throw new StateTransitionError("Entry must be at S7 to post charges", "NOT_AT_S7");

  await ensureChargeDateNotSealed(prisma, chargeDate);

  const ceiling = entry.reservation?.creditCeilingIfExtended;
  const isMandatory = isMandatoryNightAuditLine(input.lineType);
  enforceCreditCeilingChargePostingGate({
    ceiling: ceiling != null ? num(ceiling) : undefined,
    outstandingBalance: num(folio.outstandingBalance),
    chargeAmount: input.amount,
    isMandatoryCharge: isMandatory,
    creditCeilingTier2AcknowledgedAt: entry.creditCeilingTier2AcknowledgedAt,
    allowSoftGateBypass: input.allowSoftGateBypass,
  });

  const created = await prisma.$transaction(async (tx) => {
    await ensureChargeDateNotSealed(tx, chargeDate);
    const line = await tx.folioLine.create({
      data: {
        folioId,
        lineType: input.lineType,
        description: input.description,
        amount: input.amount,
        currency: input.currency?.trim() ? input.currency.trim() : "BTN",
        chargeDate,
        stage: Stage.S7,
        postedBy: actorId,
      },
    });
    const updatedFolio = await tx.folio.update({
      where: { id: folioId },
      data: { outstandingBalance: { increment: input.amount } },
    });

    if (ceiling != null) {
      await maybeWriteCreditCeilingEvents(tx, {
        entryId: input.entryId,
        folioId,
        ceilingAmount: ceiling,
        outstandingBalance: updatedFolio.outstandingBalance,
        actorId,
      });

      const ceilingN = num(ceiling);
      if (ceilingN > 0) {
        const ratio = (num(updatedFolio.outstandingBalance) as number) / ceilingN;
        if (ratio >= 0.75) {
          await writeCeilingTrace(tx, {
            entryId: input.entryId,
            actorId,
            eventType: "CREDIT_CEILING.THRESHOLD_75_ADVISORY",
            payload: { entryId: input.entryId, ratio, threshold: 0.75 },
          });
        }
        if (ratio >= 0.9) {
          if (!entry.creditCeilingTier2AcknowledgedAt && input.allowSoftGateBypass === true) {
            await tx.entry.update({
              where: { id: input.entryId },
              data: { creditCeilingTier2AcknowledgedAt: new Date() },
            });
            await writeCeilingTrace(tx, {
              entryId: input.entryId,
              actorId,
              eventType: "CREDIT_CEILING.THRESHOLD_90_ACKNOWLEDGED",
              payload: { entryId: input.entryId, ratio, threshold: 0.9 },
            });
          }
        }
        if (ratio >= 1 && !isMandatory && input.allowSoftGateBypass === true) {
          await writeCeilingTrace(tx, {
            entryId: input.entryId,
            actorId,
            eventType: "CREDIT_CEILING.SOFT_GATE_ACKNOWLEDGED",
            payload: { entryId: input.entryId, ratio, threshold: 1 },
          });
        }
      }
    }
    return line;
  });

  return created;
}

export async function postCreditNote(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; description: string; amount: number; currency?: string; creditDate: string },
) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount must be a positive number");
  const creditDate = new Date(input.creditDate);
  if (Number.isNaN(creditDate.getTime())) throw new ValidationError("creditDate must be a valid ISO date");

  return postCharge(prisma, folioId, actorId, {
    entryId: input.entryId,
    lineType: FolioLineType.CREDIT_NOTE,
    description: input.description,
    amount: -Math.abs(input.amount),
    currency: input.currency,
    chargeDate: input.creditDate,
  });
}

export async function correctCharge(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; originalFolioLineId: string; reason: string; correctionAmount: number; correctionDate: string },
) {
  if (!input.originalFolioLineId?.trim()) throw new ValidationError("originalFolioLineId is required");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  if (!Number.isFinite(input.correctionAmount) || input.correctionAmount === 0) throw new ValidationError("correctionAmount must be a non-zero number");

  const original = await prisma.folioLine.findUnique({ where: { id: input.originalFolioLineId } });
  if (!original) throw new NotFoundError("FolioLine");
  if (original.folioId !== folioId) throw new ValidationError("originalFolioLineId does not belong to this folio");

  // Corrections are additive negative / positive lines. Original is immutable.
  return postCharge(prisma, folioId, actorId, {
    entryId: input.entryId,
    lineType: original.lineType,
    description: `Correction for ${original.id}: ${input.reason}`,
    amount: input.correctionAmount,
    currency: original.currency,
    chargeDate: input.correctionDate,
  });
}

