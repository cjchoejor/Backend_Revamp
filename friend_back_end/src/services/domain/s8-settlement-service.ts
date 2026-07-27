import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, PaymentDirection, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s8CheckoutService from "./s8-checkout-service.js";
import { enforceBillingModelConfirmationMatches } from "../../policies/13-billing-model/p33-billing-model-confirmation-match.js";
import { enforceSettlementMethodCompatibility } from "../../policies/13-billing-model/p33-billing-model-settlement-method-compatibility.js";
import { enforceFolioLiveForS8Settlement } from "../../policies/13-billing-model/p31-folio-live-required-for-s8-settlement.js";
import { enforceEntryAtS8ForSettlementOperations } from "../../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { enforceCreditCeilingFinalBalanceForSettlement } from "../../policies/18-credit-extension-ceiling/p46-credit-ceiling-final-settlement.js";
import {
  enforceNightAuditsCompleteForStayBeforeSettlement,
  findIncompleteStayNightAuditDatesUtc,
  listStayNightOperatingDatesUtc,
} from "../../policies/24-night-audit/p61-night-audits-complete-for-stay-before-settlement.js";
import {
  enforceApprovedAmendmentChainForSettlement,
  enforceRoomChargeSumMatchesFrozenRateBasis,
  sumRoomChargesInStayWindowUtc,
} from "../../policies/08-pricing-rate-plan/p22-settlement-rate-basis.js";
import { minMoney, toDecimal } from "../../lib/money.js";

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function getFolio(prisma: PrismaClient, folioId: string) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  return folio;
}

/**
 * Group-aware overrides for final-invoice creation.
 *
 * Returns fields to merge into `tx.invoice.create({ data })` so the invoice becomes
 * unambiguously "group" — its `templateKey` gains a `group-` prefix (invoice renderer can
 * key off this to switch layouts / add a GROUP header / group line items by room), and its
 * `metadata` gains `{ groupBooking: true, roomCount, guestCount, groupLeader }` describing
 * the whole group at issue time. Non-group entries get their existing template unchanged.
 *
 * Kept in one place so all three FINAL invoice call sites in this file (DIRECT_BILL,
 * VOUCHER outstanding, and the general issueInvoiceAtS8 façade) apply the same rules.
 */
async function resolveGroupInvoiceOverrides(
  db: PrismaClient | Prisma.TransactionClient,
  entryId: string,
  baseTemplateKey: string,
  baseMetadata: Record<string, unknown>,
): Promise<{ templateKey: string; metadata: Prisma.InputJsonValue }> {
  const entry = await db.entry.findUnique({ where: { id: entryId } });
  if (!entry || entry.groupBillingMode !== "GROUP_MASTER") {
    return { templateKey: baseTemplateKey, metadata: baseMetadata as Prisma.InputJsonValue };
  }
  const [profile, roomCount] = await Promise.all([
    entry.guestProfileId
      ? db.guestProfile.findUnique({
          where: { id: entry.guestProfileId },
          select: { firstName: true, lastName: true },
        })
      : Promise.resolve(null),
    db.roomAssignment.count({ where: { entryId } }),
  ]);
  const groupLeader =
    [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") || null;
  return {
    templateKey: baseTemplateKey.startsWith("group-") ? baseTemplateKey : `group-${baseTemplateKey}`,
    metadata: {
      ...baseMetadata,
      groupBooking: true,
      roomCount,
      guestCount: entry.guestCount ?? null,
      groupLeader,
    } as Prisma.InputJsonValue,
  };
}

/** SIG-S8 — issue a DRAFT final invoice after settlement (cash/guest-pay paths that did not auto-create one). */
export async function issueInvoiceAtS8(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; templateKey?: string },
) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId }, include: { entry: true } });
  if (!folio?.entry) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
  enforceEntryAtS8ForSettlementOperations({ currentStage: folio.entry.currentStage });
  if (folio.state === FolioState.PROVISIONAL) {
    throw new ValidationError("Cannot issue final invoice on a provisional folio");
  }
  if (folio.state !== FolioState.LIVE && folio.state !== FolioState.SETTLED && folio.state !== FolioState.OUTSTANDING) {
    throw new ValidationError(`Cannot issue final invoice when folio is ${folio.state}`);
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const invoiceId = await allocateReadableId(tx, "INVOICE" as const, now);
    const { templateKey, metadata } = await resolveGroupInvoiceOverrides(
      tx,
      input.entryId,
      input.templateKey?.trim() || "final-v1",
      { basis: "S8 issueFinalInvoice", stage: Stage.S8 },
    );
    return tx.invoice.create({
      data: {
        id: invoiceId,
        folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.FINAL,
        state: InvoiceState.DRAFT,
        templateKey,
        issuedAt: now,
        issuedBy: actorId,
        metadata,
      },
    });
  });
}

export async function initiateSettlement(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: {
    settlementMethod: string;
    billingModelConfirmation: string;
    paymentVerificationRef?: string;
    partialAmount?: number;
    fomAcknowledgementRef?: string;
    nightAuditFomAcknowledgementRef?: string;
    voucherAmount?: number;
  },
) {
  if (!input.settlementMethod?.trim()) throw new ValidationError("settlementMethod is required");
  if (!input.billingModelConfirmation?.trim()) throw new ValidationError("billingModelConfirmation is required");

  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  enforceFolioLiveForS8Settlement({ folioState: folio.state });
  if (!folio.billingModel?.trim()) throw new MissingConfigurationError("Folio.billingModel");
  enforceBillingModelConfirmationMatches({ billingModelConfirmation: input.billingModelConfirmation, billingModel: folio.billingModel });

  const entry = await prisma.entry.findUnique({ where: { id: folio.entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS8ForSettlementOperations({ currentStage: entry.currentStage });

  const outstanding = num(folio.outstandingBalance);
  if (outstanding < 0) throw new ValidationError("Folio outstandingBalance cannot be negative at settlement");

  let incompleteNightAuditDates: string[] = [];
  if (entry.reservation) {
    incompleteNightAuditDates = await findIncompleteStayNightAuditDatesUtc(
      prisma,
      entry.reservation.frozenCheckInDate,
      entry.reservation.frozenCheckOutDate,
    );
  }
  enforceNightAuditsCompleteForStayBeforeSettlement({
    incompleteOperatingDateIsoList: incompleteNightAuditDates,
    fomNightAuditAcknowledgementRef: input.nightAuditFomAcknowledgementRef,
  });

  enforceCreditCeilingFinalBalanceForSettlement({
    outstanding,
    ceilingAmount: entry.reservation?.creditCeilingIfExtended != null ? num(entry.reservation.creditCeilingIfExtended) : null,
    fomAcknowledgementRef: input.fomAcknowledgementRef,
    creditCeilingTier2AcknowledgedAt: entry.creditCeilingTier2AcknowledgedAt,
  });

  const amendments = await prisma.amendmentEventRecord.findMany({
    where: { entryId: folio.entryId },
    orderBy: { createdAt: "asc" },
  });
  enforceApprovedAmendmentChainForSettlement(amendments);

  const folioLines = await prisma.folioLine.findMany({
    where: { folioId },
    select: { chargeDate: true, lineType: true, amount: true },
  });
  if (entry.reservation) {
    const stayNights = listStayNightOperatingDatesUtc(entry.reservation.frozenCheckInDate, entry.reservation.frozenCheckOutDate);
    enforceRoomChargeSumMatchesFrozenRateBasis({
      frozenRatePerNight: num(entry.reservation.frozenRate),
      stayNightCount: stayNights.length,
      totalRoomChargesInStayWindow: sumRoomChargesInStayWindowUtc(
        folioLines,
        entry.reservation.frozenCheckInDate,
        entry.reservation.frozenCheckOutDate,
      ),
      skipNumericReconciliation: amendments.length > 0,
      relativeTolerance: 0.02,
    });
  }

  if (input.nightAuditFomAcknowledgementRef?.trim() && incompleteNightAuditDates.length) {
    const now = new Date();
    await prisma.traceEvent.create({
      data: {
        eventType: "SETTLEMENT.NIGHT_AUDIT_FOM_ACK_USED",
        actorId,
        actorLevel: "L1",
        entityType: "Folio",
        entityId: folioId,
        operation: "ACK",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: {
          folioId,
          incompleteOperatingDates: incompleteNightAuditDates,
          nightAuditFomAcknowledgementRef: input.nightAuditFomAcknowledgementRef.trim(),
        },
        createdBy: actorId,
      },
    });
  }

  // Settlement method compatibility (minimal policy gate)
  const method = input.settlementMethod.trim();
  const billing = folio.billingModel;
  enforceSettlementMethodCompatibility({ billingModel: billing, settlementMethod: method });

  if ((method === "CASH" || method === "MOBILE_PAYMENT") && !input.paymentVerificationRef?.trim()) {
    throw new ValidationError("paymentVerificationRef is required for CASH and MOBILE_PAYMENT");
  }

  // Decimal-safe amount parsing so string inputs like "1099.75" don't drift via Number(). We keep
  // number-typed validation locals for the guardrails (isFinite / <=0), but the amount that lands
  // in the paymentRecord is a Decimal.
  const partialNumeric = input.partialAmount == null ? undefined : Number(input.partialAmount);
  if (partialNumeric != null && (!Number.isFinite(partialNumeric) || partialNumeric <= 0)) throw new ValidationError("partialAmount must be a positive number");
  const partialDec = input.partialAmount == null ? undefined : toDecimal(input.partialAmount);

  const voucherNumeric = input.voucherAmount == null ? undefined : Number(input.voucherAmount);
  if (method === "VOUCHER" && (voucherNumeric == null || !Number.isFinite(voucherNumeric) || voucherNumeric < 0)) {
    throw new ValidationError("voucherAmount is required for VOUCHER and must be non-negative");
  }
  const voucherDec = input.voucherAmount == null ? undefined : toDecimal(input.voucherAmount);

  // outstanding here is already a number derived from the Decimal ledger. Convert both sides
  // to Decimal for the min/settle so partial settlements never lock in float drift.
  const outstandingDec = toDecimal(outstanding);
  const settleAmountDec =
    method === "VOUCHER"
      ? minMoney(voucherDec ?? 0, outstandingDec)
      : partialDec != null
        ? minMoney(partialDec, outstandingDec)
        : outstandingDec;
  const settleAmount = Number(settleAmountDec.toFixed(2));

  const out = await prisma.$transaction(async (tx) => {
    // Voucher settlement IN (mutually exclusive with generic GUEST_PAY below — same settleAmount must not post twice).
    if (method === "VOUCHER") {
      if (settleAmount > 0) {
        const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
        await tx.paymentRecord.create({
          data: {
            id: paymentId,
            folioId,
            amount: settleAmount,
            paymentDirection: PaymentDirection.IN,
            notes: `VOUCHER:${settleAmount}`,
          },
        });
      }
    } else if (billing === "GUEST_PAY") {
      if (settleAmount > 0) {
        const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
        await tx.paymentRecord.create({
          data: {
            id: paymentId,
            folioId,
            amount: settleAmount,
            paymentDirection: PaymentDirection.IN,
            notes: `${method}${input.paymentVerificationRef ? `:${input.paymentVerificationRef}` : ""}`,
          },
        });
      }
    }

    // Ledger at issuance: standard pattern — invoice metadata snapshots **after** payments, **without** invoice rows in recompute.
    await recomputeFolioOutstandingBalance(tx, folioId);
    const ledgerAtIssuance = await tx.folio.findUniqueOrThrow({ where: { id: folioId }, select: { outstandingBalance: true } });
    // Decimal `.equals(0)` — a plain `=== 0` on `Number(decimal)` would mis-close a folio whose
    // balance is 0.005 (post-round it'd read 0.00 but the underlying Decimal is non-zero, and
    // vice-versa). `.equals` on the Decimal itself is authoritative.
    const balanceClosed = toDecimal(ledgerAtIssuance.outstandingBalance).equals(0);
    const outstandingAtIssuance = num(ledgerAtIssuance.outstandingBalance);

    // Direct bill → always OUTSTANDING and issue invoice
    if (billing === "DIRECT_BILL" || method === "DIRECT_BILL") {
      const { templateKey, metadata } = await resolveGroupInvoiceOverrides(tx, folio.entryId, "final-v1", {
        settlementMethod: method,
        billingModel: billing,
        outstandingBalance: ledgerAtIssuance.outstandingBalance.toString(),
      });
      await tx.invoice.create({
        data: {
          folioId,
          entryId: folio.entryId,
          invoiceType: InvoiceType.FINAL,
          state: InvoiceState.DISPATCHED,
          templateKey,
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata,
        },
      });
    }

    if (method === "VOUCHER" && outstandingAtIssuance > 0) {
      const { templateKey: voucherTemplateKey, metadata: voucherMetadata } = await resolveGroupInvoiceOverrides(
        tx,
        folio.entryId,
        "agent-billing-v1",
        {
          settlementMethod: method,
          voucherCovered: settleAmount,
          remaining: outstandingAtIssuance,
          billingModel: billing,
        },
      );
      await tx.invoice.create({
        data: {
          folioId,
          entryId: folio.entryId,
          invoiceType: InvoiceType.FINAL,
          state: InvoiceState.DISPATCHED,
          templateKey: voucherTemplateKey,
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: voucherMetadata,
        },
      });
    }

    const isDirectBillPath = billing === "DIRECT_BILL" || method === "DIRECT_BILL";
    const nextState = isDirectBillPath
      ? FolioState.OUTSTANDING
      : balanceClosed
        ? FolioState.SETTLED
        : FolioState.OUTSTANDING;
    // Prisma extension `enforceFolioSettledOutstandingGuard` reads `_base` (non-interactive client),
    // so it does not see `recomputeFolioOutstandingBalance` writes on `tx`. Passing explicit zero
    // lets the guard use `data.outstandingBalance` when closing to SETTLED.
    const updated = await tx.folio.update({
      where: { id: folioId },
      data: {
        state: nextState,
        ...(nextState === FolioState.SETTLED ? { outstandingBalance: 0 } : {}),
        closedAt: new Date(),
        closedBy: actorId,
      },
    });

    // Physical checkout: room becomes DEPARTED_DIRTY + W24 timer (AC-S8-01/03)
    await s8CheckoutService.completeCheckoutPhysicalDeparture(tx as unknown as PrismaClient, folio.entryId, actorId);

    // Trace settlement outcome so the audit + entry timeline show what happened.
    const isPartial = !balanceClosed && (partialDec != null || (method === "VOUCHER" && (voucherDec ?? toDecimal(0)).lt(outstandingDec)));
    const finalState = updated.state;
    await tx.traceEvent.create({
      data: {
        eventType: isPartial
          ? "SETTLEMENT.PARTIAL"
          : finalState === FolioState.SETTLED
            ? "SETTLEMENT.COMPLETED"
            : "SETTLEMENT.OUTSTANDING",
        actorId,
        actorLevel: "L1",
        entityType: "Folio",
        entityId: folioId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: Stage.S8,
        inquiryId: entry.inquiryId,
        entryId: folio.entryId,
        payload: {
          folioId,
          settlementMethod: method,
          billingModel: billing,
          settledAmount: settleAmount,
          outstandingBefore: outstanding,
          outstandingAfter: outstandingAtIssuance,
          folioState: finalState,
        },
        createdBy: actorId,
      },
    });

    return updated;
  });

  return out;
}

