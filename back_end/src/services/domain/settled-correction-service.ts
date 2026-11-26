/**
 * A charge corrected AFTER the bill was settled (2026-11-26, operator: "at checkout the user used the
 * agent's voucher and settled it, the guest had an extra Nu 1000 bill, and after the settle the user
 * found out one of the folio lines was typed Nu 1000 instead of Nu 100 — how do we do it").
 *
 * ⚠️ Money. The rulings (2026-11-26):
 *   1. The FOM and above, with a reason.
 *   2. Until the booking is sealed (Close & seal); a sealed record stays read-only.
 *   3. A tax invoice that went out (or whose PDF was made) is replaced by a new one; the old one is
 *      kept as it was, marked replaced and pointing at the new one.
 *   4. The agency already paid for its voucher → the hotel refunds the agency.
 *   5. Money paid over → the desk records the refund straight away.
 *
 * The posting itself is `correctCharge` (the wrong line is never edited; a correction line and its
 * service-charge and GST corrections are posted beside it, on the same payer). This module is what
 * follows it on a settled bill, inside the same transaction:
 *   - the bill's state: money owed again reopens it (SETTLED → OUTSTANDING), as a late charge does;
 *   - the agency's voucher, when the agency has not paid for it yet: it covers less — a money-out row
 *     of method VOUCHER pointing at the voucher (`voucherReducedId`); nothing is handed over;
 *   - what is still paid over on that payer's share: the refund to record, the payer named;
 *   - the tax invoices that cover the corrected share and already went out: replaced.
 */
import { FolioState, InvoiceState, InvoiceType, PaymentDirection, type Prisma, type PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { folioNetBalance, recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { computeNetForBillingModel, computeOutstandingForBillingModel } from "../../lib/folio-outstanding-per-billing-model.js";
import { round2, toDecimal } from "../../lib/money.js";
import { updateIssuedInvoice } from "../../policies/31-invoice-integrity/p68-invoice-immutability.js";

type Tx = Prisma.TransactionClient;

/** The bill states a correction after settlement works on. */
export const SETTLED_FOLIO_STATES: ReadonlySet<FolioState> = new Set([FolioState.SETTLED, FolioState.OUTSTANDING]);

const isFom = (level: string | null | undefined) => level === "L2" || level === "L3" || level === "L4";

/** Who may correct a settled bill, and when. Refusals in words. */
export function enforceSettledCorrectionAllowed(input: {
  folioState: FolioState;
  entryStatus: string;
  entryStage: string;
  actorLevel: string | null | undefined;
  /** Who may correct a settled bill, from the admin console (2026-11-26); absent = the FOM and above. */
  approvers?: { may: boolean; words: string } | null;
}) {
  if (input.folioState === FolioState.WRITTEN_OFF) {
    throw new ValidationError("This bill was written off — a charge on it is no longer corrected");
  }
  if (input.folioState === FolioState.NO_SHOW_CLOSED) {
    throw new ValidationError("This booking is a no-show — its bill closed with the no-show charge");
  }
  if (!SETTLED_FOLIO_STATES.has(input.folioState)) {
    throw new ValidationError("This bill is not settled yet — correct the charge on the Stay or Check-out step");
  }
  if (input.entryStatus !== "ACTIVE") {
    throw new PolicyGateBlockedError("ENTRY_SEALED_READ_ONLY", "This booking is closed and sealed — its bill is read-only");
  }
  if (input.entryStage !== "S8" && input.entryStage !== "S9") {
    throw new ValidationError("A settled bill is corrected at Check-out or on the Closed step");
  }
  if (input.approvers ? !input.approvers.may : !isFom(input.actorLevel)) {
    throw new PolicyGateBlockedError(
      "AUTH_REQUIRED_L2",
      `Correcting a charge after the bill is settled is for ${input.approvers?.words ?? "the FOM, the GM or an admin"} — ask them`,
    );
  }
}

/** Does a tax invoice of this scope cover a line on `bucket`? A whole-bill invoice covers every payer. */
function invoiceCovers(invoiceBucket: string | null, bucket: string) {
  return !invoiceBucket || invoiceBucket === bucket;
}

/** The tax invoices in force that a correction on `bucket` changes. */
export async function coveringTaxInvoices(db: PrismaClient | Tx, folioId: string, bucket: string) {
  const all = await db.invoice.findMany({
    where: { folioId, invoiceType: InvoiceType.FINAL, state: { not: InvoiceState.SUPERSEDED } },
    orderBy: { createdAt: "asc" },
  });
  return all.filter((i) => invoiceCovers(i.billingModel, bucket));
}

/** "the guest" · the agency's name · the company's name. */
async function payerOf(tx: Tx, entryId: string, bucket: string) {
  if (bucket === "GUEST_PAY") return { kind: "GUEST" as const, name: "the guest" };
  const entry = await tx.entry.findUnique({
    where: { id: entryId },
    select: { inquiry: { select: { travelAgent: { select: { displayName: true } }, corporateAccount: { select: { displayName: true } } } } },
  });
  const party = entry?.inquiry?.travelAgent?.displayName ?? entry?.inquiry?.corporateAccount?.displayName ?? null;
  if (bucket === "GOVERNMENT") return { kind: "PARTY" as const, name: party ?? "the government" };
  return { kind: "PARTY" as const, name: party ?? (bucket === "TOUR_OPERATOR_VOUCHER" ? "the travel agent" : "the account") };
}

/**
 * How a payer's money came in (2026-11-26) — the way a refund to them goes back by default: the
 * agency's own payment for its voucher; else the largest payment in on that share; else cash.
 */
export async function wayMoneyCame(db: PrismaClient | Tx, folioId: string, bucket: string, primary: string | null) {
  const ins = await db.paymentRecord.findMany({
    where: {
      folioId,
      paymentDirection: PaymentDirection.IN,
      tripTransferRef: null,
      ...(bucket === primary ? { OR: [{ billingModel: bucket }, { billingModel: null }] } : { billingModel: bucket }),
    },
    select: { paymentMethod: true, amount: true, voucherCollection: { select: { paymentMethod: true } } },
  });
  const ways = ins.map((p) => ({ method: p.paymentMethod === "VOUCHER" ? (p.voucherCollection?.paymentMethod ?? null) : p.paymentMethod, amount: Number(p.amount) }));
  return ways.filter((w) => w.method).sort((a, b) => b.amount - a.amount)[0]?.method ?? "CASH";
}

export type SettledCorrectionOutcome = {
  stateBefore: FolioState;
  stateAfter: FolioState;
  /** The payer whose share the correction moved. */
  billingModel: string;
  payer: { kind: "GUEST" | "PARTY"; name: string };
  /** What the whole bill owes now (0 when nothing). */
  owedNow: number;
  /** The agency's vouchers that now cover less, and by how much. Nothing is handed over. */
  voucherReduced: Array<{ voucherPaymentId: string; paymentId: string; amount: number }>;
  /** Money paid above that payer's share — the refund to record now. */
  refundDue: { amount: number; billingModel: string; payerKind: "GUEST" | "PARTY"; payerName: string; wayItCame: string } | null;
  /** Tax invoices replaced: the old one kept as it was, the new one issued and not sent. */
  invoicesReplaced: Array<{ oldId: string; oldRef: string; newId: string }>;
  /** A tax invoice issued but never sent or printed: it will print the corrected figures as it is. */
  invoicesCarry: string[];
};

/**
 * What follows a correction on a settled bill, in the correction's own transaction. The
 * correction's lines are already posted and the balance recomputed.
 */
export async function afterSettledCorrectionTx(
  tx: Tx,
  input: {
    folioId: string;
    entryId: string;
    inquiryId: string | null;
    stage: string;
    /** The payer the corrected line belongs to (the line's billing model, else the bill's own). */
    billingModel: string;
    originalLineId: string;
    correctionLineId: string;
    delta: number;
    reason: string;
    actor: { actorId: string; actorLevel: string };
  },
): Promise<SettledCorrectionOutcome> {
  const now = new Date();
  const folio = await tx.folio.findUniqueOrThrow({ where: { id: input.folioId }, select: { state: true, billingModel: true } });
  const primary = folio.billingModel ?? null;
  const bucket = input.billingModel;
  const stateBefore = folio.state;
  const payer = await payerOf(tx, input.entryId, bucket);

  // 1. The agency's voucher, not paid for yet: it covers less. Newest voucher first.
  let paidOver = (await computeNetForBillingModel(tx, input.folioId, bucket)).neg();
  const voucherReduced: SettledCorrectionOutcome["voucherReduced"] = [];
  if (paidOver.gt(0)) {
    const vouchers = await tx.paymentRecord.findMany({
      where: {
        folioId: input.folioId,
        paymentDirection: PaymentDirection.IN,
        paymentMethod: "VOUCHER",
        tripTransferRef: null,
        ...(bucket === primary ? { OR: [{ billingModel: bucket }, { billingModel: null }] } : { billingModel: bucket }),
      },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, amount: true, billingModel: true, voucherCollection: { select: { id: true } } },
    });
    for (const v of vouchers) {
      if (!paidOver.gt(0)) break;
      if (v.voucherCollection) continue; // the agency paid for it: that is a refund, below
      const reduced = await tx.paymentRecord.aggregate({ where: { voucherReducedId: v.id }, _sum: { amount: true } });
      const left = toDecimal(v.amount).sub(toDecimal(reduced._sum.amount));
      if (!left.gt(0)) continue;
      const take = round2(left.lt(paidOver) ? left : paidOver);
      const id = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id,
          folioId: input.folioId,
          entryId: input.entryId,
          amount: take,
          paymentDirection: PaymentDirection.OUT,
          paymentMethod: "VOUCHER",
          billingModel: v.billingModel ?? bucket,
          voucherReducedId: v.id,
          receivedAt: now,
          recordedBy: input.actor.actorId,
          stage: input.stage as never,
          notes: `VOUCHER_REDUCED:${input.reason}`,
        },
      });
      voucherReduced.push({ voucherPaymentId: v.id, paymentId: id, amount: Number(take.toFixed(2)) });
      paidOver = paidOver.sub(take);
    }
    if (voucherReduced.length) await recomputeFolioOutstandingBalance(tx, input.folioId);
  }

  // 2. The bill's state: money owed again reopens it, as a late charge does.
  const net = await folioNetBalance(tx, input.folioId);
  let stateAfter = stateBefore;
  if (net.gt(0) && stateBefore === FolioState.SETTLED) {
    await tx.folio.update({ where: { id: input.folioId }, data: { state: FolioState.OUTSTANDING } });
    stateAfter = FolioState.OUTSTANDING;
  }

  // 3. What is still paid over on that payer's share: theirs, whatever another payer still owes.
  const refundAmount = round2((await computeNetForBillingModel(tx, input.folioId, bucket)).neg());
  let refundDue: SettledCorrectionOutcome["refundDue"] = null;
  if (refundAmount.gt(0)) {
    refundDue = {
      amount: Number(refundAmount.toFixed(2)),
      billingModel: bucket,
      payerKind: payer.kind,
      payerName: payer.name,
      wayItCame: await wayMoneyCame(tx, input.folioId, bucket, primary),
    };
  }

  // 4. The tax invoices that cover this share and already went out (or were printed): replaced.
  const covering = await coveringTaxInvoices(tx, input.folioId, bucket);
  const invoicesReplaced: SettledCorrectionOutcome["invoicesReplaced"] = [];
  const invoicesCarry: string[] = [];
  for (const old of covering) {
    const oldRef = old.invoiceNumber ?? old.id;
    if (!old.dispatchedAt && !old.pdfStorageKey) {
      invoicesCarry.push(oldRef);
      continue;
    }
    const newId = await allocateReadableId(tx, "INVOICE" as const, now);
    const oldMeta = (old.metadata ?? {}) as Record<string, unknown>;
    const group = ["groupBooking", "roomCount", "guestCount", "groupLeader"].reduce<Record<string, unknown>>((acc, k) => {
      if (oldMeta[k] !== undefined) acc[k] = oldMeta[k];
      return acc;
    }, {});
    await tx.invoice.create({
      data: {
        id: newId,
        folioId: input.folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.FINAL,
        state: InvoiceState.DRAFT,
        templateKey: old.templateKey,
        billingModel: old.billingModel,
        totalAmount: old.billingModel ? await computeOutstandingForBillingModel(tx, input.folioId, old.billingModel) : undefined,
        issuedAt: now,
        issuedBy: input.actor.actorId,
        versionNumber: (old.versionNumber ?? 1) + 1,
        metadata: {
          ...group,
          basis: "REPLACES_AFTER_CORRECTION",
          stage: input.stage,
          replaces: oldRef,
          replacesId: old.id,
          correctionLineId: input.correctionLineId,
          reason: input.reason,
          ...(old.billingModel ? { billingModel: old.billingModel } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    await updateIssuedInvoice(tx, old.id, { state: InvoiceState.SUPERSEDED, supersededById: newId });
    await tx.traceEvent.create({
      data: {
        eventType: "INVOICE.REPLACED",
        actorId: input.actor.actorId,
        actorLevel: input.actor.actorLevel as never,
        entityType: "Invoice",
        entityId: old.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: input.stage as never,
        inquiryId: input.inquiryId,
        entryId: input.entryId,
        payload: { oldId: old.id, oldRef, newId, cause: "CHARGE_CORRECTED_AFTER_SETTLEMENT", correctionLineId: input.correctionLineId, reason: input.reason },
        createdBy: input.actor.actorId,
      },
    });
    invoicesReplaced.push({ oldId: old.id, oldRef, newId });
  }

  await tx.traceEvent.create({
    data: {
      eventType: "FOLIO.CHARGE_CORRECTED_AFTER_SETTLEMENT",
      actorId: input.actor.actorId,
      actorLevel: input.actor.actorLevel as never,
      entityType: "Folio",
      entityId: input.folioId,
      operation: "CREATE",
      timestamp: now,
      stageContext: input.stage as never,
      inquiryId: input.inquiryId,
      entryId: input.entryId,
      payload: {
        folioId: input.folioId,
        originalLineId: input.originalLineId,
        correctionLineId: input.correctionLineId,
        delta: input.delta.toFixed(2),
        reason: input.reason,
        billingModel: bucket,
        payer: payer.name,
        stateBefore,
        stateAfter,
        owedNow: net.gt(0) ? net.toFixed(2) : "0.00",
        voucherReduced,
        refundDue,
        invoicesReplaced,
        invoicesCarry,
      } as unknown as Prisma.InputJsonValue,
      createdBy: input.actor.actorId,
    },
  });

  return {
    stateBefore,
    stateAfter,
    billingModel: bucket,
    payer,
    owedNow: net.gt(0) ? Number(net.toFixed(2)) : 0,
    voucherReduced,
    refundDue,
    invoicesReplaced,
    invoicesCarry,
  };
}
