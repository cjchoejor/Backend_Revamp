import { FolioLineType, FolioState, Prisma, Stage, type PrismaClient } from "@prisma/client";
import { allocateFolioLineId } from "../../lib/readable-id.js";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { getActiveConfigEntry, requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { enforceCreditCeilingChargePostingGate } from "../../policies/18-credit-extension-ceiling/p45-credit-ceiling-charge-posting-gate.js";
import { enforceChargeDateNotSealedByCompleteNightAudit } from "../../policies/24-night-audit/p61-charge-date-not-sealed-by-complete-night-audit.js";
import {
  enforceEntryAtS7OrS8ForChargePosting,
  enforceFolioLiveForS7ChargePosting,
} from "../../policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { mulMoney, round2, toDecimal, ZERO } from "../../lib/money.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { evaluateAdvancePaymentCondition } from "./s3-payment-service.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";
import {
  classifyFolioLine,
  companionRateFromDescription,
  gstLineDescription,
  salesTaxCorrectionDescription,
  serviceChargeCorrectionDescription,
  serviceChargeLineDescription,
} from "../../lib/folio-tax-lines.js";

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

export async function maybeWriteCreditCeilingEvents(db: DbClient, args: { entryId: string; folioId: string; ceilingAmount: Prisma.Decimal; outstandingBalance: Prisma.Decimal; actorId: string }) {
  // Policy registry override: `registry.creditCeiling.advisoryThresholds` (when enabled)
  // replaces the legacy `creditCeiling.proximityThresholds` ConfigurationEntry.
  const advisoryPolicy = await getRegistryPolicy(db as any, "registry.creditCeiling.advisoryThresholds");
  const useRegistry =
    !!advisoryPolicy &&
    advisoryPolicy.enabled !== false &&
    typeof advisoryPolicy.tier1Percent === "number" &&
    typeof advisoryPolicy.tier2Percent === "number";
  const v = useRegistry
    ? { tier1Percent: advisoryPolicy!.tier1Percent as number, tier2Percent: advisoryPolicy!.tier2Percent as number }
    : ((await requireActiveConfigValue<{ tier1Percent?: number; tier2Percent?: number } | undefined>(db as any, "creditCeiling.proximityThresholds")) ?? {});
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

/**
 * The service charge and GST a charge carries, posted as its two companion lines (2026-09-18) —
 * shared by the in-stay charge and the post-stay charge, so a minibar found after departure is
 * taxed exactly as the same minibar during the stay. The post-stay one had carried no tax at all.
 *
 * Service charge first, THEN GST on (charge + service charge) — the hotel-wide compound rule in
 * compute-stay-charges.ts and on every guest-facing email (S2 quote, S3 PI, S4 confirmation, S8
 * final invoice). Both rates come from ConfigurationEntry (admin-editable on /admin/financial).
 * Decimal-safe: `Math.round(x*100)/100` on floats compounds through (subTotal + serviceCharge) ×
 * gstRate and mismatches guest-facing quotes vs the invoice.
 */
export async function postChargeTaxCompanionsTx(
  tx: Prisma.TransactionClient,
  input: {
    folioId: string;
    baseAmount: number;
    description: string;
    currency: string;
    chargeDate: Date;
    stage: Stage;
    actorId: string;
    billingModel: string;
    roomId?: string | null;
    spaceId?: string | null;
    /** A charge posted after the stay (S9): its companions carry the same flag and instant. */
    postStay?: { postedAt: Date };
  },
): Promise<{ serviceCharge: Prisma.Decimal; gst: Prisma.Decimal; serviceChargeRate: number; gstRate: number }> {
  const { gstRate, serviceChargeRate } = await resolveChargeRates(tx as unknown as PrismaClient);
  const subTotalDec = toDecimal(input.baseAmount);
  const common = {
    folioId: input.folioId,
    currency: input.currency,
    chargeDate: input.chargeDate,
    stage: input.stage,
    postedBy: input.actorId,
    billingModel: input.billingModel,
    roomId: input.roomId ?? null,
    spaceId: input.spaceId ?? null,
    ...(input.postStay ? { isPostStay: true, postedAt: input.postStay.postedAt } : {}),
  };

  const serviceCharge = serviceChargeRate > 0 ? round2(mulMoney(subTotalDec, serviceChargeRate)) : ZERO;
  // A credit note's base is negative, and so are its companions — the tax comes off with it.
  if (!serviceCharge.isZero()) {
    await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, input.folioId),
        ...common,
        lineType: FolioLineType.SERVICE,
        description: serviceChargeLineDescription(serviceChargeRate, input.description),
        amount: serviceCharge,
      },
    });
  }

  // GST is compound — applied to (subTotal + serviceCharge), kept in Decimal through the base.
  const gstBase = subTotalDec.add(serviceCharge);
  const gst = gstRate > 0 ? round2(mulMoney(gstBase, gstRate)) : ZERO;
  if (!gst.isZero()) {
    await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, input.folioId),
        ...common,
        lineType: FolioLineType.OTHER,
        description: gstLineDescription(gstRate, input.description),
        amount: gst,
      },
    });
  }
  return { serviceCharge, gst, serviceChargeRate, gstRate };
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
    /** Which room this charge belongs to (2026-08-14, per-room folio breakdown). Optional —
     *  omitted = booking-wide. Must be a room assigned to this entry; the auto tax/service
     *  companion lines inherit it. */
    roomId?: string;
    /** Which SPACE this charge belongs to (2026-09-09, PMS-237) — the conference hall's own
     *  charges. Must be a space allocated to this entry. Mutually exclusive with `roomId`;
     *  the companion lines inherit it exactly as they inherit the room. */
    spaceId?: string;
    /**
     * Internal only — never from a request body. The payer's share this charge belongs to, when
     * it is not the line type's default (2026-09-18): the early-departure fee is a term of the stay
     * as booked, so it follows the room's payer, not the SERVICE default (the guest's share on an
     * agency or company booking).
     */
    billingModelOverride?: string;
  },
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.description?.trim()) throw new ValidationError("description is required");
  if (!Number.isFinite(input.amount)) throw new ValidationError("amount must be a number");
  if (!input.chargeDate?.trim()) throw new ValidationError("chargeDate is required");

  const parsedChargeDate = new Date(input.chargeDate);
  if (Number.isNaN(parsedChargeDate.getTime())) throw new ValidationError("chargeDate must be a valid ISO date");
  // A charge is dated on the HOTEL's calendar (2026-09-17). A date-only value — the S7 form's
  // "2026-09-17", the S8 checkout day, the night audit's operating date — is stored at UTC
  // midnight and passes through unchanged. An instant ("now", which credit notes and S9 send)
  // becomes the hotel day it falls on: its UTC date is still yesterday in Bhutan until 06:00,
  // which dated a 3am posting — and seal-checked it — against the previous night.
  const chargeDate = hotelTodayUtc(parsedChargeDate);
  // Nothing is consumed tomorrow (2026-09-18). The check-out step dated its last charges on the
  // BOOKED check-out, so after an early departure they landed days after the guest had left;
  // any charge dated past the hotel's today is that kind of mistake.
  if (chargeDate.getTime() > hotelTodayUtc().getTime()) {
    throw new ValidationError(
      `A charge cannot be dated after today at the hotel (${hotelTodayUtc().toISOString().slice(0, 10)}) — date it the day it was consumed`,
    );
  }

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");
  enforceFolioLiveForS7ChargePosting({ folioState: folio.state });

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  // Charges post at S7 (in-house) and at S8 as final-morning charges before settlement (SIG-S8 §2.2).
  enforceEntryAtS7OrS8ForChargePosting({ currentStage: entry.currentStage });

  // Per-room attribution (2026-08-14): the named room must be one of this booking's rooms —
  // any room the entry ever held qualifies (a vacated room's minibar charge is still real).
  const chargeRoomId = input.roomId?.trim() || null;
  const chargeSpaceId = input.spaceId?.trim() || null;
  // A charge belongs to ONE place or to the booking as a whole (2026-09-09) — the DB check
  // `folio_line_target_xor` backs this up, but refuse here so the caller gets a clear message
  // instead of a constraint violation.
  if (chargeRoomId && chargeSpaceId) {
    throw new ValidationError("A charge belongs to a room OR a space, not both — omit one");
  }
  if (chargeRoomId) {
    const owned = await prisma.roomAssignment.findFirst({
      where: { entryId: input.entryId, roomId: chargeRoomId },
    });
    if (!owned) throw new ValidationError("roomId is not a room of this booking");
  }
  // Same rule for a space: any space this entry was ever allocated qualifies, whatever state
  // that allocation is in — a released hall's projector charge is still real, exactly as a
  // vacated room's minibar charge is.
  if (chargeSpaceId) {
    const allocated = await prisma.spaceAllocation.findFirst({
      where: { entryId: input.entryId, spaceId: chargeSpaceId },
    });
    if (!allocated) throw new ValidationError("spaceId is not a space of this booking");
  }

  await ensureChargeDateNotSealed(prisma, chargeDate);

  // Ceiling discharge (2026-08-17, operator ruling): `creditCeilingIfExtended` was sanctioned
  // at S3 to cover the unpaid ADVANCE — once the advance is fully PAID with real money, the
  // FOM's credit has been replaced and the in-stay monitoring stands down (p45 gate, advisory
  // events, W12). Mirrors the 2026-08-14 S5 p44 proportional fix one layer deeper: the frozen
  // figure on the immutable reservation must not police charges forever. A failed evaluation
  // keeps the ceiling — fail closed to the stricter behaviour.
  let ceiling = entry.reservation?.creditCeilingIfExtended ?? null;
  if (ceiling != null) {
    try {
      const adv = await evaluateAdvancePaymentCondition(prisma, { entryId: input.entryId, folioId });
      if (adv.paidInFull) ceiling = null;
    } catch {
      // keep the ceiling when the advance evaluation can't run
    }
  }
  const isMandatory = isMandatoryNightAuditLine(input.lineType);
  await enforceCreditCeilingChargePostingGate(prisma, {
    ceiling: ceiling != null ? num(ceiling) : undefined,
    outstandingBalance: num(folio.outstandingBalance),
    chargeAmount: input.amount,
    isMandatoryCharge: isMandatory,
    creditCeilingTier2AcknowledgedAt: entry.creditCeilingTier2AcknowledgedAt,
    allowSoftGateBypass: input.allowSoftGateBypass,
  });

  // Multi-currency safe: fall through the strongest signal available for this folio's currency
  // instead of unconditionally defaulting to "BTN". Prevents a USD quotation being reconciled
  // against BTN-stamped folio lines.
  //   1. Explicit caller-supplied currency wins.
  //   2. Reservation's frozen currency (S4 confirmation stamped it).
  //   3. Accepted quotation's commercialTerms.currency (S2 negotiated it — includes agent rate cards).
  //   4. Existing folio line currency (majority) — inherit from what's already posted.
  //   5. Fallback: BTN.
  const acceptedQ = await prisma.quotation.findFirst({
    where: { entryId: input.entryId, state: "ACCEPTED" as any },
    orderBy: { versionNumber: "desc" },
    select: { currency: true, commercialTerms: true },
  });
  const quotationCurrency =
    (acceptedQ?.commercialTerms as any)?.currency ??
    (acceptedQ?.currency ?? null);
  const existingLine = await prisma.folioLine.findFirst({
    where: { folioId },
    orderBy: { chargeDate: "asc" },
    select: { currency: true },
  });
  const resolvedLineCurrency =
    (input.currency?.trim() ? input.currency.trim() : null) ??
    (typeof quotationCurrency === "string" && quotationCurrency.trim() ? quotationCurrency.trim() : null) ??
    (existingLine?.currency?.trim() ? existingLine.currency.trim() : null) ??
    "BTN";

  const created = await prisma.$transaction(async (tx) => {
    await ensureChargeDateNotSealed(tx, chargeDate);
    // Resolve billing model for the primary line + any auto-generated tax/service lines.
    // Tax + service inherit the primary line's line-type mapping (they're derivative
    // charges on the same billable event).
    const primaryBillingModel =
      input.billingModelOverride?.trim() || (await resolveBillingModelForNewLine(tx, folioId, input.lineType));
    const line = await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, folioId),
        folioId,
        lineType: input.lineType,
        description: input.description,
        amount: input.amount,
        currency: resolvedLineCurrency,
        chargeDate,
        stage: Stage.S7,
        postedBy: actorId,
        billingModel: primaryBillingModel,
        roomId: chargeRoomId,

        spaceId: chargeSpaceId,
      },
    });

    // A charge carries its service charge and GST; so does a credit note, reversed (2026-09-18):
    // a credit gives back a taxable amount, so the tax on it comes off too. It used to post bare —
    // crediting a Nu 600 dinner left the guest paying its Nu 93 of service charge and GST, and the
    // folio's tax buckets overstated what the hotel collected. The desk has always said "service
    // charge and GST post beside it" under the credit-note button.
    if ((input.lineType !== FolioLineType.CREDIT_NOTE && input.amount > 0) || (input.lineType === FolioLineType.CREDIT_NOTE && input.amount < 0)) {
      await postChargeTaxCompanionsTx(tx, {
        folioId,
        baseAmount: input.amount,
        description: input.description,
        currency: resolvedLineCurrency,
        chargeDate,
        stage: Stage.S7,
        actorId,
        // Service charge and GST inherit the primary line's billing model — same guest event.
        billingModel: primaryBillingModel,
        roomId: chargeRoomId,
        spaceId: chargeSpaceId,
      });
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
  input: { entryId: string; description: string; amount: number; currency?: string; creditDate: string; roomId?: string; spaceId?: string },
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
    roomId: input.roomId,
    // A credit against a hall stays with the hall (2026-09-18) — the space was dropped here, so
    // it landed under "No room / space".
    spaceId: input.spaceId,
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

  const parsedCorrectionDate = new Date(input.correctionDate);
  if (Number.isNaN(parsedCorrectionDate.getTime())) throw new ValidationError("correctionDate must be a valid ISO date");
  // Same rule as a charge: the hotel day the correction falls on (see postCharge).
  const correctionDate = hotelTodayUtc(parsedCorrectionDate);

  const original = await prisma.folioLine.findUnique({ where: { id: input.originalFolioLineId } });
  if (!original) throw new NotFoundError("FolioLine");
  if (original.folioId !== folioId) throw new ValidationError("originalFolioLineId does not belong to this folio");
  if (isSalesTaxLine(original.description) || classifyFolioLine(original) !== "CHARGE") {
    throw new ValidationError("Correct the underlying charge line, not its service-charge / GST line");
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
  // Corrections follow the same stage envelope as posting (2026-08-03): the checkout review
  // is exactly when a wrong charge gets caught, so S8 pre-settlement must be able to fix it.
  // The folio-LIVE gate above still blocks corrections once the folio has settled.
  enforceEntryAtS7OrS8ForChargePosting({ currentStage: entry.currentStage });

  const originalAmount = num(original.amount);
  if (hasTarget && input.correctToAmount! < 0 && originalAmount > 0) {
    throw new ValidationError(
      'A negative "correct to" amount is not a valid net charge. To reduce this line, send correctionAmount (e.g. −50 to lower a 200 charge by 50).',
    );
  }
  // "Set net to" measures against what the charge stands at NOW — the original plus every
  // earlier correction of it (2026-08-21; it used to read the original alone, so a 200 charge
  // corrected −50 and then "set to 100" posted −100 and landed on 50).
  const priorCorrections = hasTarget
    ? await prisma.folioLine.findMany({
        where: { folioId, description: { startsWith: `Correction for ${original.id}:` } },
        select: { amount: true },
      })
    : [];
  const currentNet = originalAmount + priorCorrections.reduce((acc, l) => acc + num(l.amount), 0);
  const delta = hasTarget ? input.correctToAmount! - currentNet : input.correctionAmount!;
  if (!Number.isFinite(delta) || delta === 0) {
    throw new ValidationError("Correction would not change the charge amount");
  }

  await ensureChargeDateNotSealed(prisma, correctionDate);

  return prisma.$transaction(async (tx) => {
    await ensureChargeDateNotSealed(tx, correctionDate);

    // A correction inherits the ORIGINAL line's billing model — the correction adjusts a
    // charge that was already assigned to a specific payer, so the delta must go to the
    // same payer. Falls back to the resolver if the original had no billing model
    // (pre-Phase-1 line pre-dating the backfill).
    const correctionBillingModel =
      original.billingModel ?? (await resolveBillingModelForNewLine(tx, folioId, original.lineType));
    const correctionLine = await tx.folioLine.create({
      data: {
        id: await allocateFolioLineId(tx, folioId),
        folioId,
        lineType: original.lineType,
        description: `Correction for ${original.id}: ${input.reason}`,
        amount: new Prisma.Decimal(delta.toFixed(2)),
        currency: original.currency,
        chargeDate: correctionDate,
        stage: Stage.S7,
        postedBy: actorId,
        billingModel: correctionBillingModel,
        // A correction adjusts a charge already attributed to a room — the delta stays there.
        roomId: original.roomId,
        spaceId: original.spaceId,
      },
    });

    if (original.lineType !== FolioLineType.CREDIT_NOTE) {
      // ── The charge's service charge and GST move WITH it (2026-08-21, operator: "I applied −50,
      // what about service charge and GST — it should also change, no?") ─────────────────────
      // Before: only a GST delta was posted, computed on the bare delta. Now the correction
      // posts an SC correction and a GST correction exactly as the charge was taxed: SC on the
      // delta, GST compound on (delta + SC delta) — the hotel-wide rule every posting uses.
      // Which taxes apply, and at what rate, is read off the charge's OWN companion lines (a
      // charge posted SC-exempt gets no SC correction; an old charge taxed at an older rate moves
      // at THAT rate), falling back to today's config. A legacy line with no companions at all
      // keeps the previous GST-only behaviour so imported folios don't gain tax lines they never had.
      const suffix = taxLineSuffixForCharge(original.description);
      const related = await tx.folioLine.findMany({
        where: { folioId, description: { contains: suffix }, roomId: original.roomId ?? null, spaceId: original.spaceId ?? null },
        select: { lineType: true, description: true, amount: true },
      });
      const scLines = related.filter((l) => classifyFolioLine(l) === "SERVICE_CHARGE");
      const gstLines = related.filter((l) => classifyFolioLine(l) === "GST");
      const rateFrom = (ls: typeof related) =>
        ls.map((l) => companionRateFromDescription(l.description)).find((r): r is number => r != null && r > 0) ?? null;
      const { gstRate: cfgGst, serviceChargeRate: cfgSc } = await resolveChargeRates(tx as unknown as PrismaClient);
      const legacy = scLines.length === 0 && gstLines.length === 0;
      const scApplies = scLines.length > 0;
      const gstApplies = gstLines.length > 0 || legacy;
      const scRate = scApplies ? rateFrom(scLines) ?? cfgSc : 0;
      const gstRate = gstApplies ? rateFrom(gstLines) ?? (legacy ? await resolveSalesTaxRate(tx) : cfgGst) : 0;

      const deltaDec = toDecimal(delta.toFixed(2));
      let scDelta = ZERO;
      let gstDelta = ZERO;
      if (hasTarget) {
        // "Set net to": the charge's taxes become what the TARGET net would carry; the deltas
        // are measured against everything already on the ledger for this charge — its original
        // companions and any earlier corrections' — so repeated corrections never double-count.
        const targetDec = toDecimal(input.correctToAmount!.toFixed(2));
        const newSc = scApplies && scRate > 0 ? round2(mulMoney(targetDec, scRate)) : ZERO;
        const oldSc = scLines.reduce((acc, l) => acc.add(toDecimal(l.amount)), ZERO);
        scDelta = scApplies ? newSc.sub(oldSc) : ZERO;
        const newGst = gstApplies && gstRate > 0 ? round2(mulMoney(targetDec.add(newSc), gstRate)) : ZERO;
        const oldGst = gstLines.reduce((acc, l) => acc.add(toDecimal(l.amount)), ZERO);
        gstDelta = gstApplies ? newGst.sub(oldGst) : ZERO;
      } else {
        scDelta = scApplies && scRate > 0 ? round2(mulMoney(deltaDec, scRate)) : ZERO;
        gstDelta = gstApplies && gstRate > 0 ? round2(mulMoney(deltaDec.add(scDelta), gstRate)) : ZERO;
      }

      if (scDelta.abs().gte(toDecimal("0.005"))) {
        await tx.folioLine.create({
          data: {
            id: await allocateFolioLineId(tx, folioId),
            folioId,
            lineType: FolioLineType.SERVICE,
            description: serviceChargeCorrectionDescription(original.description),
            amount: round2(scDelta),
            currency: original.currency,
            chargeDate: correctionDate,
            stage: Stage.S7,
            postedBy: actorId,
            billingModel: correctionBillingModel,
            roomId: original.roomId,
            spaceId: original.spaceId,
          },
        });
      }
      if (gstDelta.abs().gte(toDecimal("0.005"))) {
        await tx.folioLine.create({
          data: {
            id: await allocateFolioLineId(tx, folioId),
            folioId,
            lineType: FolioLineType.OTHER,
            description: salesTaxCorrectionDescription(original.description),
            amount: round2(gstDelta),
            currency: original.currency,
            chargeDate: correctionDate,
            stage: Stage.S7,
            postedBy: actorId,
            billingModel: correctionBillingModel,
            roomId: original.roomId,
            spaceId: original.spaceId,
          },
        });
      }
    }

    await recomputeFolioOutstandingBalance(tx, folioId);
    return correctionLine;
  });
}

