import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";
import { maxZeroSub, round2, toDecimal } from "./money.js";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Per-bucket outstanding balance (Phase 3 of split-billing, 2026-07-25).
 *
 * Companion to `recomputeFolioOutstandingBalance` — that helper produces the WHOLE-folio
 * outstanding balance (single number persisted on `Folio.outstandingBalance`). This helper
 * produces the outstanding for ONE `billingModel` bucket:
 *
 *   `max(0, sum(FolioLine.amount WHERE billingModel = X) - sum(Payment IN WHERE billingModel = X) + sum(Payment OUT WHERE billingModel = X))`
 *
 * Used by `initiateSettlement` when the operator settles a specific bucket:
 *   - Total to charge/collect for this bucket
 *   - Invoice totalAmount to stamp on the FINAL invoice for this bucket
 *   - Whether this bucket is fully paid (bucket-level SETTLED transition)
 *
 * ## Bucket resolution rules
 *
 * - Lines / payments with `billingModel = X` count toward bucket X (obvious case).
 * - Lines / payments with `billingModel = NULL` are treated as belonging to the folio's
 *   PRIMARY bucket (`folio.billingModel`). This preserves legacy behaviour for pre-Phase-1
 *   lines that were never backfilled — they roll up into whatever the primary model is.
 *
 * ## Write-offs
 *
 * Deliberately NOT split across buckets in this helper. Write-offs are a folio-level event
 * (bad debt on the whole engagement) and are subtracted once at the folio level, not per
 * bucket. If a bucket needs a per-bucket write-off later, extend `WriteOffRecord` with a
 * `billingModel` column and update this helper.
 */
export async function computeOutstandingForBillingModel(
  tx: Tx,
  folioId: string,
  billingModel: string,
): Promise<Prisma.Decimal> {
  // Resolve the folio's primary model so we can also count NULL-model lines as belonging to it.
  const folio = await tx.folio.findUnique({
    where: { id: folioId },
    select: { billingModel: true },
  });
  const primary = folio?.billingModel?.trim() ?? null;
  const bucketIsPrimary = primary != null && primary === billingModel;

  // Two SQL "where" clauses per aggregate: exact match on billingModel, OR NULL when this
  // bucket is the primary. Prisma OR clauses handle it cleanly.
  const lineWhere = bucketIsPrimary
    ? { folioId, OR: [{ billingModel }, { billingModel: null }] }
    : { folioId, billingModel };
  const paymentInWhere = bucketIsPrimary
    ? { folioId, paymentDirection: PaymentDirection.IN, OR: [{ billingModel }, { billingModel: null }] }
    : { folioId, paymentDirection: PaymentDirection.IN, billingModel };
  const paymentOutWhere = bucketIsPrimary
    ? { folioId, paymentDirection: PaymentDirection.OUT, OR: [{ billingModel }, { billingModel: null }] }
    : { folioId, paymentDirection: PaymentDirection.OUT, billingModel };

  const [lineAgg, inAgg, outAgg] = await Promise.all([
    tx.folioLine.aggregate({ where: lineWhere, _sum: { amount: true } }),
    tx.paymentRecord.aggregate({ where: paymentInWhere, _sum: { amount: true } }),
    tx.paymentRecord.aggregate({ where: paymentOutWhere, _sum: { amount: true } }),
  ]);

  const lineTotal = toDecimal(lineAgg._sum.amount);
  const inTotal = toDecimal(inAgg._sum.amount);
  const outTotal = toDecimal(outAgg._sum.amount);
  // Decimal.max(0, x - y + z) — mirrors the whole-folio helper but scoped per bucket.
  return round2(maxZeroSub(lineTotal.add(outTotal), inTotal));
}

/**
 * Return the SET of distinct billing-model buckets present on a folio's lines.
 *
 * Used by:
 *   - Settlement UI to render one "Settle" button per bucket
 *   - `issueInvoicesAtS8` when the caller wants to issue all at once
 *   - Validation ("the target bucket you specified doesn't exist on this folio")
 *
 * NULL-model lines are attributed to the folio's primary model (same rule as
 * `computeOutstandingForBillingModel`). Empty folios return the primary alone (if set).
 */
export async function listBillingModelBucketsForFolio(
  tx: Tx,
  folioId: string,
): Promise<string[]> {
  const [folio, lineTypes] = await Promise.all([
    tx.folio.findUnique({ where: { id: folioId }, select: { billingModel: true } }),
    tx.folioLine.findMany({
      where: { folioId },
      select: { billingModel: true },
      distinct: ["billingModel"],
    }),
  ]);
  const buckets = new Set<string>();
  const primary = folio?.billingModel?.trim() ?? null;
  for (const l of lineTypes) {
    if (l.billingModel?.trim()) buckets.add(l.billingModel.trim());
    else if (primary) buckets.add(primary); // NULL lines roll up to primary
  }
  if (buckets.size === 0 && primary) buckets.add(primary);
  return Array.from(buckets);
}
