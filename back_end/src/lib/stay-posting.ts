import { Prisma } from "@prisma/client";
import { round2, toDecimal, ZERO, type MoneyLike } from "./money.js";

/**
 * How a room's stay is billed, night by night — ONE rule, read by the night audit (which posts it)
 * and by the quotation (which prices it), so the two cannot come out a chhertum apart (2026-11-10,
 * operator: "fix it", after QUO-20261104-0002 on the hotel's server read Nu 9,459.99 against rooms
 * the night audit bills at Nu 9,460.00).
 *
 * The night audit posts each night of a room as two lines — the room (with its extra bed) and the
 * meal plan — and each line carries its own service charge and GST, rounded to Nu 0.01 as every
 * folio line is. A stay's tax is therefore the sum of those lines' rounded tax, not the tax on the
 * stay's net rounded once. The hotel's packages are typed with tax in them (a room Nu 1,920, the
 * dinner plan Nu 740 a person), and per line they come back to exactly those figures.
 *
 * A part's money is shared over its nights in whole chhertum, the last night taking what is left,
 * so the nights always add up to exactly the part — the stay's net — whatever the division leaves.
 */

export type PostingTaxRule = {
  serviceChargeApplies: boolean;
  gstApplies: boolean;
  /** e.g. 0.10 */
  serviceChargeRate: number;
  /** e.g. 0.05 — charged on the net plus the service charge. */
  gstRate: number;
};

/** One posted line's tax, as the folio posts it: service charge, then GST on net + service charge. */
export function lineTax(net: MoneyLike, rule: PostingTaxRule): { serviceCharge: Prisma.Decimal; gst: Prisma.Decimal } {
  const n = toDecimal(net);
  if (!n.gt(0)) return { serviceCharge: ZERO, gst: ZERO };
  const serviceCharge =
    rule.serviceChargeApplies && rule.serviceChargeRate > 0 ? round2(n.mul(rule.serviceChargeRate)) : ZERO;
  const gst = rule.gstApplies && rule.gstRate > 0 ? round2(n.add(serviceCharge).mul(rule.gstRate)) : ZERO;
  return { serviceCharge, gst };
}

/** A part's money shared over its nights: whole chhertum each, the last night taking what is left. */
export function nightShares(total: MoneyLike, nights: number): Prisma.Decimal[] {
  const n = Math.max(1, Math.floor(nights));
  const t = round2(total);
  const base = round2(t.div(n));
  const shares = Array.from({ length: n }, () => base);
  shares[n - 1] = t.sub(base.mul(n - 1));
  return shares;
}

/**
 * The share for one night, by its place in the stay (0 = the first night). A night outside the
 * count — a row whose dates no longer match the nights it was priced for — takes the ordinary
 * share, never the remainder.
 */
export function shareForNight(total: MoneyLike, nights: number, index: number): Prisma.Decimal {
  const shares = nightShares(total, nights);
  return Number.isInteger(index) && index >= 0 && index < shares.length ? shares[index] : shares[0];
}

/**
 * A room's tax for its stay, exactly as the night audit will post it: each night's room line and
 * meal line taxed on their own, summed.
 */
export function roomStayTax(input: {
  accommodation: MoneyLike;
  meals: MoneyLike;
  nights: number;
  rule: PostingTaxRule;
}): { serviceCharge: Prisma.Decimal; gst: Prisma.Decimal } {
  let serviceCharge = ZERO;
  let gst = ZERO;
  for (const part of [input.accommodation, input.meals]) {
    for (const share of nightShares(part, input.nights)) {
      const t = lineTax(share, input.rule);
      serviceCharge = serviceCharge.add(t.serviceCharge);
      gst = gst.add(t.gst);
    }
  }
  return { serviceCharge, gst };
}
