import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, PaymentDirection } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s8CheckoutService from "./s8-checkout-service.js";
import { enforceBillingModelConfirmationMatches } from "../../policies/13-billing-model/p33-billing-model-confirmation-match.js";
import { enforceSettlementMethodCompatibility } from "../../policies/13-billing-model/p33-billing-model-settlement-method-compatibility.js";
import { enforceFolioLiveForS8Settlement } from "../../policies/13-billing-model/p31-folio-live-required-for-s8-settlement.js";
import { enforceEntryAtS8ForSettlementOperations } from "../../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";

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
  const remaining = Math.max(0, outstanding - settleAmount);

  const nextState = remaining === 0 ? FolioState.SETTLED : FolioState.OUTSTANDING;

  const out = await prisma.$transaction(async (tx) => {
    // Guest pay → record payment
    if (billing === "GUEST_PAY") {
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
          metadata: { settlementMethod: method, billingModel: billing, outstandingBalance: folio.outstandingBalance.toString() },
        },
      });
    }

    // Voucher path: settle up to voucher coverage; if remainder exists, create agent billing invoice for difference.
    if (method === "VOUCHER") {
      await tx.paymentRecord.create({
        data: {
          folioId,
          amount: settleAmount,
          paymentDirection: PaymentDirection.IN,
          notes: `VOUCHER:${settleAmount}`,
        },
      });
      if (remaining > 0) {
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
            metadata: { settlementMethod: method, voucherCovered: settleAmount, remaining, billingModel: billing },
          },
        });
      }
    }

    const updated = await tx.folio.update({
      where: { id: folioId },
      data: {
        state:
          billing === "DIRECT_BILL" || method === "DIRECT_BILL"
            ? FolioState.OUTSTANDING
            : method === "VOUCHER"
              ? remaining === 0
                ? FolioState.SETTLED
                : FolioState.OUTSTANDING
              : nextState,
        closedAt: new Date(),
        closedBy: actorId,
        // Align outstandingBalance with settlement outcome so SETTLED invariants hold.
        outstandingBalance: billing === "DIRECT_BILL" || method === "DIRECT_BILL" ? folio.outstandingBalance : (remaining as any),
      },
    });

    // Physical checkout: room becomes DEPARTED_DIRTY + W24 timer (AC-S8-01/03)
    await s8CheckoutService.completeCheckoutPhysicalDeparture(tx as unknown as PrismaClient, folio.entryId, actorId);

    return updated;
  });

  return out;
}

