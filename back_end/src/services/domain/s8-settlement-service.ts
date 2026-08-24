import type { Prisma, PrismaClient } from "@prisma/client";
import { effectiveCheckOutDate } from "../../lib/stay-dates.js";
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
import { computeOutstandingForBillingModel, listBillingModelBucketsForFolio } from "../../lib/folio-outstanding-per-billing-model.js";
import { evaluateAdvancePaymentCondition } from "./s3-payment-service.js";

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

/**
 * SIG-S8 — issue a DRAFT final invoice after settlement (cash/guest-pay paths that did not
 * auto-create one).
 *
 * Split-billing (Phase 3, 2026-07-25): when `input.billingModel` is provided, tag the
 * invoice with that bucket so the PDF renderer only includes matching lines and the
 * per-bucket outstanding is stamped as `totalAmount`. When omitted, produces a
 * whole-folio invoice (legacy behaviour).
 */
export async function issueInvoiceAtS8(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; templateKey?: string; billingModel?: string },
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

  const targetBucket = input.billingModel?.trim() || null;
  if (targetBucket) {
    // Sanity check: the requested bucket must actually exist on this folio (either an
    // explicit line.billingModel match or lines that roll up to the primary).
    const buckets = await listBillingModelBucketsForFolio(prisma, folioId);
    if (!buckets.includes(targetBucket)) {
      throw new ValidationError(
        `No folio lines assigned to billingModel "${targetBucket}". Present buckets: ${buckets.join(", ") || "(none)"}.`,
      );
    }
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const invoiceId = await allocateReadableId(tx, "INVOICE" as const, now);
    // Per-bucket totalAmount when a specific bucket was requested; whole-folio otherwise.
    const totalAmount = targetBucket
      ? await computeOutstandingForBillingModel(tx, folioId, targetBucket)
      : null;
    const { templateKey, metadata } = await resolveGroupInvoiceOverrides(
      tx,
      input.entryId,
      input.templateKey?.trim() || "final-v1",
      {
        basis: "S8 issueFinalInvoice",
        stage: Stage.S8,
        ...(targetBucket ? { billingModel: targetBucket } : {}),
      },
    );
    return tx.invoice.create({
      data: {
        id: invoiceId,
        folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.FINAL,
        state: InvoiceState.DRAFT,
        templateKey,
        billingModel: targetBucket,
        totalAmount: totalAmount ?? undefined,
        issuedAt: now,
        issuedBy: actorId,
        metadata,
      },
    });
  });
}

/**
 * S8 settlement.
 *
 * Split-billing (Phase 3, 2026-07-25): when `input.billingModel` is present, the settlement
 * scopes to that bucket only:
 *   - Outstanding = per-bucket sum (via `computeOutstandingForBillingModel`)
 *   - PaymentRecord created stamped with `billingModel = X`
 *   - Invoice created stamped with `billingModel = X`
 *   - Folio state transitions to SETTLED only when the WHOLE folio (all buckets combined)
 *     reaches zero; otherwise it becomes / stays OUTSTANDING
 * When `input.billingModel` is absent → legacy whole-folio behaviour.
 *
 * `billingModelConfirmation` must match the target bucket (either `input.billingModel` when
 * provided, else `folio.billingModel`). This is the operator's typo-protection acknowledgement.
 */
export async function initiateSettlement(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: {
    settlementMethod: string;
    billingModelConfirmation: string;
    /** Target bucket for split-billing settlement. Omit for whole-folio (legacy). */
    billingModel?: string;
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

  // Split-billing: resolve the TARGET bucket for this settlement call.
  //   - When `input.billingModel` is provided, it's the target (must exist on the folio).
  //   - Otherwise the folio's primary model is the target (legacy whole-folio).
  // The `billingModelConfirmation` typo-guard is verified against the target, not the
  // folio's primary — so an agent-bucket settlement expects operator to type "DIRECT_BILL".
  const targetBucket = input.billingModel?.trim() || folio.billingModel;
  if (input.billingModel?.trim()) {
    const buckets = await listBillingModelBucketsForFolio(prisma, folioId);
    if (!buckets.includes(targetBucket)) {
      throw new ValidationError(
        `No folio lines assigned to billingModel "${targetBucket}". Present buckets: ${buckets.join(", ") || "(none)"}.`,
      );
    }
  }
  enforceBillingModelConfirmationMatches({ billingModelConfirmation: input.billingModelConfirmation, billingModel: targetBucket });

  const entry = await prisma.entry.findUnique({ where: { id: folio.entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS8ForSettlementOperations({ currentStage: entry.currentStage });

  // Outstanding scope: whole-folio when settling everything, per-bucket when settling a
  // specific `input.billingModel`. Both paths must be Decimal-safe (never Number() drift).
  const isBucketScoped = !!input.billingModel?.trim();
  const outstandingDecScoped = isBucketScoped
    ? await computeOutstandingForBillingModel(prisma, folioId, targetBucket)
    : toDecimal(folio.outstandingBalance);
  const outstanding = Number(outstandingDecScoped.toFixed(2));
  if (outstanding < 0) throw new ValidationError("Folio outstandingBalance cannot be negative at settlement");

  // Early departure (2026-08-22): a shortened stay settles over the nights actually slept -
  // the effective checkout, never the frozen one (which would demand audits for, and room
  // charges on, nights the guest never spent here).
  const settlementCheckOut = entry.reservation ? effectiveCheckOutDate(entry) ?? entry.reservation.frozenCheckOutDate : null;
  let incompleteNightAuditDates: string[] = [];
  if (entry.reservation && settlementCheckOut) {
    incompleteNightAuditDates = await findIncompleteStayNightAuditDatesUtc(
      prisma,
      entry.reservation.frozenCheckInDate,
      settlementCheckOut,
    );
  }
  enforceNightAuditsCompleteForStayBeforeSettlement({
    incompleteOperatingDateIsoList: incompleteNightAuditDates,
    fomNightAuditAcknowledgementRef: input.nightAuditFomAcknowledgementRef,
  });

  // Ceiling discharge (2026-08-17, operator ruling — same rule as charge posting): the
  // ceiling was sanctioned to cover the unpaid ADVANCE; once the advance is fully PAID with
  // real money the FOM's credit is discharged and the final-balance check stands down.
  let settlementCeiling =
    entry.reservation?.creditCeilingIfExtended != null ? num(entry.reservation.creditCeilingIfExtended) : null;
  if (settlementCeiling != null) {
    try {
      const adv = await evaluateAdvancePaymentCondition(prisma, { entryId: folio.entryId, folioId });
      if (adv.paidInFull) settlementCeiling = null;
    } catch {
      // keep the ceiling when the advance evaluation can't run — fail closed
    }
  }
  enforceCreditCeilingFinalBalanceForSettlement({
    outstanding,
    ceilingAmount: settlementCeiling,
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
  if (entry.reservation && settlementCheckOut) {
    const stayNights = listStayNightOperatingDatesUtc(entry.reservation.frozenCheckInDate, settlementCheckOut);
    // Per-room composition basis (2026-08-17): when the assignments carry frozen composition
    // subtotals, the audit posts room+meals per room per night from exactly these figures —
    // so Σ frozenSubtotal is the correct expectation. `frozenRate × nights` (one room's
    // room-only rate) stays as the legacy-flat fallback.
    const compositionRows = await prisma.roomAssignment.findMany({
      where: { entryId: folio.entryId, frozenSubtotal: { not: null } },
      select: { frozenSubtotal: true },
    });
    const compositionExpectedTotal =
      compositionRows.length > 0
        ? compositionRows.reduce((s, r) => s + num(r.frozenSubtotal), 0)
        : null;
    enforceRoomChargeSumMatchesFrozenRateBasis({
      frozenRatePerNight: num(entry.reservation.frozenRate),
      stayNightCount: stayNights.length,
      totalRoomChargesInStayWindow: sumRoomChargesInStayWindowUtc(
        folioLines,
        entry.reservation.frozenCheckInDate,
        settlementCheckOut,
      ),
      skipNumericReconciliation: amendments.length > 0,
      relativeTolerance: 0.02,
      compositionExpectedTotal,
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

  // Settlement method compatibility — reads from the TARGET bucket, not the folio's primary,
  // so that in a split folio the agent-bucket settlement is checked for DIRECT_BILL and the
  // guest-bucket settlement is checked for GUEST_PAY separately.
  const method = input.settlementMethod.trim();
  const billing = targetBucket;
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

  // Bucket-scoped outstanding is authoritative for split settlements; whole-folio otherwise.
  const outstandingDec = outstandingDecScoped;
  const settleAmountDec =
    method === "VOUCHER"
      ? minMoney(voucherDec ?? 0, outstandingDec)
      : partialDec != null
        ? minMoney(partialDec, outstandingDec)
        : outstandingDec;
  const settleAmount = Number(settleAmountDec.toFixed(2));

  // Bucket tag stamped on every write below. `null` when running whole-folio (legacy),
  // otherwise the target bucket string — routes payments/invoices to their bucket-scoped
  // ledger.
  const bucketTag = isBucketScoped ? targetBucket : null;

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
            billingModel: bucketTag,
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
            billingModel: bucketTag,
          },
        });
      }
    }

    // Whole-folio ledger recompute (always — the aggregate `Folio.outstandingBalance` field
    // remains the master total across all buckets). Per-bucket sub-totals are computed
    // on-demand via `computeOutstandingForBillingModel`.
    await recomputeFolioOutstandingBalance(tx, folioId);
    const ledgerAtIssuance = await tx.folio.findUniqueOrThrow({ where: { id: folioId }, select: { outstandingBalance: true } });
    const wholeFolioBalanceClosed = toDecimal(ledgerAtIssuance.outstandingBalance).equals(0);
    const outstandingAtIssuance = num(ledgerAtIssuance.outstandingBalance);
    // For bucket-scoped settlements, also compute the target bucket's post-payment balance
    // so we can decide whether to mark this bucket's invoice as DISPATCHED (bucket cleared)
    // vs OUTSTANDING (bucket still owes something).
    const bucketAfterDec = isBucketScoped
      ? await computeOutstandingForBillingModel(tx, folioId, targetBucket)
      : outstandingDecScoped.sub(toDecimal(settleAmount));
    const bucketClosedAfter = bucketAfterDec.equals(0);
    const bucketAfter = Number(bucketAfterDec.toFixed(2));

    // Direct bill → always OUTSTANDING and issue invoice (bucket-tagged when split)
    if (billing === "DIRECT_BILL" || method === "DIRECT_BILL") {
      const { templateKey, metadata } = await resolveGroupInvoiceOverrides(tx, folio.entryId, "final-v1", {
        settlementMethod: method,
        billingModel: billing,
        outstandingBalance: ledgerAtIssuance.outstandingBalance.toString(),
        ...(isBucketScoped ? { bucketOutstanding: bucketAfter } : {}),
      });
      await tx.invoice.create({
        data: {
          folioId,
          entryId: folio.entryId,
          invoiceType: InvoiceType.FINAL,
          state: InvoiceState.DISPATCHED,
          templateKey,
          billingModel: bucketTag,
          totalAmount: isBucketScoped ? outstandingDecScoped : undefined,
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata,
        },
      });
    }

    if (method === "VOUCHER" && bucketAfter > 0) {
      const { templateKey: voucherTemplateKey, metadata: voucherMetadata } = await resolveGroupInvoiceOverrides(
        tx,
        folio.entryId,
        "agent-billing-v1",
        {
          settlementMethod: method,
          voucherCovered: settleAmount,
          remaining: bucketAfter,
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
          billingModel: bucketTag,
          totalAmount: bucketAfterDec,
          issuedAt: new Date(),
          issuedBy: actorId,
          dispatchedAt: new Date(),
          dispatchedBy: actorId,
          metadata: voucherMetadata,
        },
      });
    }

    // Folio state transitions:
    //   - Whole-folio balance closed → SETTLED (the folio is done regardless of scope).
    //   - Whole-folio balance > 0    → OUTSTANDING (something still owed on some bucket).
    // A bucket-scoped settlement that fully clears its bucket but leaves others unpaid
    // stays OUTSTANDING at the folio level — which is correct: the folio isn't done yet.
    const isDirectBillPath = billing === "DIRECT_BILL" || method === "DIRECT_BILL";
    const nextState = isDirectBillPath
      ? FolioState.OUTSTANDING
      : wholeFolioBalanceClosed
        ? FolioState.SETTLED
        : FolioState.OUTSTANDING;
    // Preserve original `balanceClosed` name for trace payload below.
    const balanceClosed = wholeFolioBalanceClosed;
    // Suppress unused-var complaint on bucketClosedAfter (kept for potential future use).
    void bucketClosedAfter;
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

    // Physical checkout: room becomes DEPARTED_DIRTY + W24 timer (AC-S8-01/03).
    //
    // Split-billing (Phase 3): a BUCKET-scoped settlement (e.g., just the agent side)
    // leaves the guest still in-house; the room stays OCCUPIED until every bucket is done.
    // A WHOLE-FOLIO settlement is the guest leaving — full OR partial (2026-08-17, found
    // live: a partial cash settlement left every room OCCUPIED and S9 unreachable; SIG-S9
    // §51 explicitly exits S8 with the folio OUTSTANDING and the rooms released — the
    // remainder is S9's payment follow-up, not a reason to keep the rooms).
    if (!isBucketScoped || wholeFolioBalanceClosed || isDirectBillPath) {
      await s8CheckoutService.completeCheckoutPhysicalDeparture(tx as unknown as PrismaClient, folio.entryId, actorId);
    }

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
          // Split-billing metadata: which bucket this call targeted + its post-payment balance.
          bucketScoped: isBucketScoped,
          bucketTargeted: bucketTag,
          bucketOutstandingAfter: bucketAfter,
        },
        createdBy: actorId,
      },
    });

    return updated;
  });

  return out;
}

