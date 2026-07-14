import { Prisma } from "@prisma/client";

/**
 * Centralised money math for the PMS. Every money-typed column in Prisma is Decimal —
 * converting to JS `number` loses precision and produces float drift that compounds through
 * quotation → invoice → payment reconciliation. Route all money math through this module.
 *
 * Conventions:
 * - Rounding: half-away-from-zero at 2 decimal places (matches invoice / receipt convention).
 *   Prisma's Decimal implementation exposes `.toDecimalPlaces(dp, rounding)` for this; we wrap it
 *   as `round2` so call sites stay short.
 * - Comparisons: use `.equals` / `.gte` / `.lte` / `.gt` / `.lt` on Decimals; NEVER compare via `>=`
 *   after `Number(...)`.
 * - Summation: `sumAmounts(rows, key)` returns a Decimal — do not accumulate via `+`.
 */

export type MoneyLike = Prisma.Decimal | number | string | null | undefined;

/** Zero as a Decimal — reuse to avoid needless allocations. */
export const ZERO = new Prisma.Decimal(0);

/** Coerce to a Decimal. `null`/`undefined` become 0 so aggregate patterns are safe. */
export function toDecimal(v: MoneyLike): Prisma.Decimal {
  if (v == null) return ZERO;
  if (v instanceof Prisma.Decimal) return v;
  return new Prisma.Decimal(v);
}

/** Round to 2 decimal places, half-away-from-zero. Returns a Decimal. */
export function round2(v: MoneyLike): Prisma.Decimal {
  return toDecimal(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Sum a list of MoneyLike values in Decimal-safe arithmetic. */
export function sumMoney(values: Iterable<MoneyLike>): Prisma.Decimal {
  let total = ZERO;
  for (const v of values) total = total.add(toDecimal(v));
  return total;
}

/**
 * Sum `key` across `rows` in Decimal-safe arithmetic. Use for
 * `sumMoneyBy(payments, "amount")` — replaces `payments.reduce((s,p) => s + Number(p.amount), 0)`.
 */
export function sumMoneyBy<T>(rows: readonly T[], key: keyof T): Prisma.Decimal {
  let total = ZERO;
  for (const r of rows) total = total.add(toDecimal(r[key] as unknown as MoneyLike));
  return total;
}

/** Decimal `a * b`, no float rounding. */
export function mulMoney(a: MoneyLike, b: MoneyLike): Prisma.Decimal {
  return toDecimal(a).mul(toDecimal(b));
}

/** Percent math: `base * (pct / 100)` in Decimal. */
export function pctOf(base: MoneyLike, pct: MoneyLike): Prisma.Decimal {
  return toDecimal(base).mul(toDecimal(pct)).div(100);
}

/** `a - b`, floored at 0 (useful for outstanding balance). */
export function maxZeroSub(a: MoneyLike, b: MoneyLike): Prisma.Decimal {
  const r = toDecimal(a).sub(toDecimal(b));
  return r.isNegative() ? ZERO : r;
}

/** `min(a, b)` for Decimals. */
export function minMoney(a: MoneyLike, b: MoneyLike): Prisma.Decimal {
  const da = toDecimal(a);
  const db = toDecimal(b);
  return da.lte(db) ? da : db;
}
