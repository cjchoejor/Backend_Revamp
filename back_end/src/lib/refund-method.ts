import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection } from "@prisma/client";

/**
 * How money owed back to a guest leaves the hotel (2026-09-19).
 *
 * A cancellation or a no-show writes its refund as money OUT, and wrote it with no method — so the
 * column default, CASH, recorded a bank-transfer advance as going back over the counter in cash: a
 * day's takings would read the cash drawer short by the whole refund. The rule now:
 *
 *   1. what the desk says (the dialog's "How the money goes back"), when it says;
 *   2. otherwise the way the money came — the one method the booking's payments used, or, when
 *      they used several, the method of the largest;
 *   3. CASH only when nothing was ever received with a method (it cannot happen for a refund, which
 *      needs money received; kept as the column's own default).
 */
export async function resolveRefundMethod(
  db: PrismaClient | Prisma.TransactionClient,
  folioId: string,
  asked?: string | null,
): Promise<string> {
  const said = asked?.trim();
  if (said) return said;
  const received = await db.paymentRecord.findMany({
    where: { folioId, paymentDirection: PaymentDirection.IN, paymentMethod: { not: null } },
    select: { paymentMethod: true, amount: true },
  });
  if (received.length === 0) return "CASH";
  const methods = new Set(received.map((p) => p.paymentMethod!));
  if (methods.size === 1) return [...methods][0];
  const largest = received.reduce((a, b) => (Number(b.amount) > Number(a.amount) ? b : a));
  return largest.paymentMethod ?? "CASH";
}
