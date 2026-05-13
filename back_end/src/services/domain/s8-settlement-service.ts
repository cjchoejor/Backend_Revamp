import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, PaymentDirection, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s8CheckoutService from "./s8-checkout-service.js";
import { enforceBillingModelConfirmationMatches } from "../../policies/13-billing-model/p33-billing-model-confirmation-match.js";
import { enforceSettlementMethodCompatibility } from "../../policies/13-billing-model/p33-billing-model-settlement-method-compatibility.js";
import { enforceFolioLiveForS8Settlement } from "../../policies/13-billing-model/p31-folio-live-required-for-s8-settlement.js";
import { enforceEntryAtS8ForSettlementOperations } from "../../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
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

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

export async function getFolio(prisma: PrismaClient, folioId: string) {
  const folio = await prisma.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  return folio;
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

  const partial = input.partialAmount == null ? undefined : Number(input.partialAmount);
  if (partial != null && (!Number.isFinite(partial) || partial <= 0)) throw new ValidationError("partialAmount must be a positive number");

  const voucherAmount = input.voucherAmount == null ? undefined : Number(input.voucherAmount);
  if (method === "VOUCHER" && (voucherAmount == null || !Number.isFinite(voucherAmount) || voucherAmount < 0)) {
    throw new ValidationError("voucherAmount is required for VOUCHER and must be non-negative");
  }

  const settleAmount =
    method === "VOUCHER"
      ? Math.min(voucherAmount ?? 0, outstanding)
      : partial != null
        ? Math.min(partial, outstanding)
        : outstanding;

  const out = await prisma.$transaction(async (tx) => {
    // Voucher settlement IN (mutually exclusive with generic GUEST_PAY below — same settleAmount must not post twice).
    if (method === "VOUCHER") {
      if (settleAmount > 0) {
        await tx.paymentRecord.create({
          data: {
            folioId,
            amount: settleAmount,
            paymentDirection: PaymentDirection.IN,
            notes: `VOUCHER:${settleAmount}`,
          },
        });
      }
    } else if (billing === "GUEST_PAY") {
      if (settleAmount > 0) {
        await tx.paymentRecord.create({
          data: {
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
    const outstandingAtIssuance = num(ledgerAtIssuance.outstandingBalance);
    const balanceClosed = outstandingAtIssuance === 0;

    // Direct bill → always OUTSTANDING and issue invoice
    if (billing === "DIRECT_BILL" || method === "DIRECT_BILL") {
      await tx.invoice.create({
        data: {
          folioId,
          entryId: folio.entryId,
          invoiceType: InvoiceType.FINAL,
          state: InvoiceState.DISPATCHED,
          templateKey: "final-v1",
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: {
            settlementMethod: method,
            billingModel: billing,
            outstandingBalance: ledgerAtIssuance.outstandingBalance.toString(),
          },
        },
      });
    }

    if (method === "VOUCHER" && outstandingAtIssuance > 0) {
      await tx.invoice.create({
        data: {
          folioId,
          entryId: folio.entryId,
          invoiceType: InvoiceType.FINAL,
          state: InvoiceState.DISPATCHED,
          templateKey: "agent-billing-v1",
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: {
            settlementMethod: method,
            voucherCovered: settleAmount,
            remaining: outstandingAtIssuance,
            billingModel: billing,
          },
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

    return updated;
  });

  return out;
}

