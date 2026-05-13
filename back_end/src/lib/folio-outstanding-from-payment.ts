import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Single source for **`Folio.outstandingBalance`**: net of posted folio lines and payment rows.
 *
 * `max(0, sum(FolioLine.amount) - sum(Payment IN) + sum(Payment OUT) - sum(WriteOffRecord.writtenOffAmount))`
 *
 * - **IN** reduces guest obligation (prepayment / settlement cash).
 * - **OUT** increases obligation (refund reverses part of that prepayment in this model).
 *
 * Call after any write to **`folio_lines`**, **`payment_records`**, or **`write_off_records`** for the folio (same transaction preferred).
 *
 * **OUT** rows alone therefore move the balance without a separate ad‑hoc increment path.
 *
 * **`Invoice` totals are intentionally excluded** — invoices are dispatch/AR documents; obligation
 * comes from **folio lines** and **payments** (plus write-offs above). Adding invoice amounts here would double-count.
 */
export async function recomputeFolioOutstandingBalance(tx: Tx, folioId: string): Promise<void> {
  const [lineAgg, inAgg, outAgg, writeOffAgg] = await Promise.all([
    tx.folioLine.aggregate({
      where: { folioId },
      _sum: { amount: true },
    }),
    tx.paymentRecord.aggregate({
      where: { folioId, paymentDirection: PaymentDirection.IN },
      _sum: { amount: true },
    }),
    tx.paymentRecord.aggregate({
      where: { folioId, paymentDirection: PaymentDirection.OUT },
      _sum: { amount: true },
    }),
    tx.writeOffRecord.aggregate({
      where: { folioId },
      _sum: { writtenOffAmount: true },
    }),
  ]);

  const lineTotal = Number(lineAgg._sum.amount?.toString() ?? "0");
  const inTotal = Number(inAgg._sum.amount?.toString() ?? "0");
  const outTotal = Number(outAgg._sum.amount?.toString() ?? "0");
  const writeOffTotal = Number(writeOffAgg._sum.writtenOffAmount?.toString() ?? "0");
  const next = Math.max(0, lineTotal - inTotal + outTotal - writeOffTotal);

  await tx.folio.update({
    where: { id: folioId },
    data: { outstandingBalance: next },
  });
}

/**
 * @deprecated Prefer **`recomputeFolioOutstandingBalance`** after any folio line or payment change.
 * Retained for call-site stability; **`paymentAmount` is ignored** — the ledger is always fully recomputed.
 */
export async function applyInboundPaymentToFolioOutstanding(tx: Tx, folioId: string, _paymentAmount: number): Promise<void> {
  await recomputeFolioOutstandingBalance(tx, folioId);
}
