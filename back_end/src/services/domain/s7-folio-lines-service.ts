import { FolioLineType, FolioState, Prisma, Stage, type PrismaClient } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { calculateTax } from "../../engines/tax-engine.js";
import { enforceCreditCeilingChargePostingGate } from "../../policies/18-credit-extension-ceiling/p45-credit-ceiling-charge-posting-gate.js";
import { enforceChargeDateNotSealedByCompleteNightAudit } from "../../policies/24-night-audit/p61-charge-date-not-sealed-by-complete-night-audit.js";
import {
  enforceEntryAtS7ForChargePosting,
  enforceFolioLiveForS7ChargePosting,
} from "../../policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
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

function isSalesTaxLine(description: string): boolean {
  return description.trimStart().toLowerCase().startsWith("sales tax");
}

function isCorrectionLine(description: string): boolean {
  return description.trimStart().toLowerCase().startsWith("correction for");
}

function taxLineSuffixForCharge(chargeDescription: string): string {
  return `on: ${chargeDescription}`;
}

async function resolveSalesTaxRate(db: DbClient): Promise<number> {
  const taxRow = await getActiveConfigEntry(db as unknown as PrismaClient, "billing.salesTaxRate");
  const raw = taxRow?.configValue;
  const rate =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : 0;
  return typeof rate === "number" && rate > 0 ? rate : 0;
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
  enforceChargeDateNotSealedByCompleteNightAudit({
    nightAuditRecord: sealed ?? undefined,
    operatingDateIso: op.toISOString(),
  });
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
  enforceFolioLiveForS7ChargePosting({ folioState: folio.state });

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS7ForChargePosting({ currentStage: entry.currentStage });

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

    if (input.lineType !== FolioLineType.CREDIT_NOTE && input.amount > 0) {
      const taxRow = await getActiveConfigEntry(tx as unknown as PrismaClient, "billing.salesTaxRate");
      const raw = taxRow?.configValue;
      const rate =
        typeof raw === "number" && Number.isFinite(raw)
          ? raw
          : typeof raw === "string" && raw.trim()
            ? Number(raw)
            : 0;
      if (typeof rate === "number" && rate > 0) {
        const { taxAmount } = calculateTax({ taxableAmount: input.amount, rate });
        if (taxAmount > 0) {
          await tx.folioLine.create({
            data: {
              folioId,
              lineType: FolioLineType.OTHER,
              description: `Sales tax (${(rate * 100).toFixed(2)}%) on: ${input.description}`,
              amount: new Prisma.Decimal(taxAmount.toFixed(2)),
              currency: input.currency?.trim() ? input.currency.trim() : "BTN",
              chargeDate,
              stage: Stage.S7,
              postedBy: actorId,
            },
          });
        }
      }
    }

    await recomputeFolioOutstandingBalance(tx, folioId);
    const updatedFolio = await tx.folio.findUniqueOrThrow({ where: { id: folioId } });

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
  input: {
    entryId: string;
    originalFolioLineId: string;
    reason: string;
    correctionAmount?: number;
    correctToAmount?: number;
    correctionDate: string;
  },
) {
  if (!input.originalFolioLineId?.trim()) throw new ValidationError("originalFolioLineId is required");
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
  if (!input.correctionDate?.trim()) throw new ValidationError("correctionDate is required");

  const hasDelta =
    input.correctionAmount != null && Number.isFinite(input.correctionAmount) && input.correctionAmount !== 0;
  const hasTarget = input.correctToAmount != null && Number.isFinite(input.correctToAmount);
  if (hasDelta && hasTarget) {
    throw new ValidationError("Provide either correctionAmount or correctToAmount, not both");
  }
  if (!hasDelta && !hasTarget) {
    throw new ValidationError("Provide correctionAmount (signed delta) or correctToAmount (target net for the charge line)");
  }

  const correctionDate = new Date(input.correctionDate);
  if (Number.isNaN(correctionDate.getTime())) throw new ValidationError("correctionDate must be a valid ISO date");

  const original = await prisma.folioLine.findUnique({ where: { id: input.originalFolioLineId } });
  if (!original) throw new NotFoundError("FolioLine");
  if (original.folioId !== folioId) throw new ValidationError("originalFolioLineId does not belong to this folio");
  if (isSalesTaxLine(original.description)) {
    throw new ValidationError("Correct the underlying charge line, not the sales tax line");
  }
  if (isCorrectionLine(original.description)) {
    throw new ValidationError("Select the original charge line, not an earlier correction line");
  }

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");
  enforceFolioLiveForS7ChargePosting({ folioState: folio.state });

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS7ForChargePosting({ currentStage: entry.currentStage });

  const originalAmount = num(original.amount);
  if (hasTarget && input.correctToAmount! < 0 && originalAmount > 0) {
    throw new ValidationError(
      'A negative "correct to" amount is not a valid net charge. To reduce this line, send correctionAmount (e.g. −50 to lower a 200 charge by 50).',
    );
  }
  const delta = hasTarget ? input.correctToAmount! - originalAmount : input.correctionAmount!;
  if (!Number.isFinite(delta) || delta === 0) {
    throw new ValidationError("Correction would not change the charge amount");
  }

  await ensureChargeDateNotSealed(prisma, correctionDate);

  return prisma.$transaction(async (tx) => {
    await ensureChargeDateNotSealed(tx, correctionDate);

    const correctionLine = await tx.folioLine.create({
      data: {
        folioId,
        lineType: original.lineType,
        description: `Correction for ${original.id}: ${input.reason}`,
        amount: new Prisma.Decimal(delta.toFixed(2)),
        currency: original.currency,
        chargeDate: correctionDate,
        stage: Stage.S7,
        postedBy: actorId,
      },
    });

    if (original.lineType !== FolioLineType.CREDIT_NOTE) {
      const rate = await resolveSalesTaxRate(tx);
      if (rate > 0) {
        let taxDelta: number;
        if (hasTarget) {
          const { taxAmount: newTax } = calculateTax({ taxableAmount: input.correctToAmount!, rate });
          const taxLines = await tx.folioLine.findMany({
            where: {
              folioId,
              lineType: FolioLineType.OTHER,
              description: { contains: taxLineSuffixForCharge(original.description) },
            },
          });
          const oldTax = taxLines.reduce((sum, line) => sum + num(line.amount), 0);
          taxDelta = newTax - oldTax;
        } else {
          taxDelta = calculateTax({ taxableAmount: delta, rate }).taxAmount;
        }

        if (Math.abs(taxDelta) >= 0.005) {
          await tx.folioLine.create({
            data: {
              folioId,
              lineType: FolioLineType.OTHER,
              description: `Sales tax correction on: ${original.description}`,
              amount: new Prisma.Decimal(taxDelta.toFixed(2)),
              currency: original.currency,
              chargeDate: correctionDate,
              stage: Stage.S7,
              postedBy: actorId,
            },
          });
        }
      }
    }

    await recomputeFolioOutstandingBalance(tx, folioId);
    return correctionLine;
  });
}

