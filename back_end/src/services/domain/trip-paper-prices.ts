import { sumMoney } from "../../lib/money.js";
import { formatMoney } from "../../lib/pdf-render-context.js";
import type { LegphelPriceBlock } from "../infrastructure/pdf-templates/legphel-quotation-template.js";
import type { QuotationPriceFigures } from "./quotation-pdf-service.js";

/**
 * A TRIP'S PAPER IS ONE TABLE (2026-11-09, operator: "show it together on the top it can show both
 * the stay 1 and stay 2 dates, and in side the table, it can show the what in it in one table").
 *
 * ⚠️ Money. Every row is printed exactly as the stay's own paper prints it, and every figure under
 * the table is only the stays' own figures added up, in Decimal: nothing is priced here.
 */
export type TripPaperFigures = Pick<QuotationPriceFigures, "net" | "netAfterDiscount" | "serviceChargeLabel" | "serviceCharge" | "gstLabel" | "gst" | "discountLabel" | "discountAmount" | "total">;

export type TripPricePart = { stayNo: number; block: LegphelPriceBlock; figures: TripPaperFigures };

const same = (xs: Array<string | null>) => (new Set(xs).size === 1 ? xs[0] : null);

/** The stays' label when they share it, else the word with the rate they share ("Service charge 10%"). */
function taxLabel(labels: string[], word: string) {
  const whole = same(labels);
  if (whole) return whole;
  const rate = same(labels.map((l) => l.match(/\d+(?:\.\d+)?%/)?.[0] ?? null));
  return rate ? `${word} ${rate}` : word;
}

/** "Discount 10%" when every stay has it; "Discount 10% · Stay 2" when only one does. */
function discountWord(all: TripPricePart[], discounted: TripPricePart[]) {
  const label = same(discounted.map((p) => p.figures.discountLabel));
  if (discounted.length === 1) return `${discounted[0].figures.discountLabel ?? "Discount"} · Stay ${discounted[0].stayNo}`;
  return discounted.length === all.length && label ? label : "Discount";
}

export function combineTripPriceBlocks(parts: TripPricePart[], opts?: { hidePrices?: boolean }): LegphelPriceBlock {
  const add = (f: (p: TripPricePart) => number) => sumMoney(parts.map(f));
  const hasDiscount = (p: TripPricePart) => (p.figures.discountAmount ?? 0) > 0;
  const onNet = parts.filter((p) => hasDiscount(p) && p.figures.netAfterDiscount != null);
  // A quotation priced before 2026-11-05 took a flat amount off the total, and still prints that way.
  const offTotal = parts.filter((p) => hasDiscount(p) && p.figures.netAfterDiscount == null);
  const off = (list: TripPricePart[]) => `− ${formatMoney(sumMoney(list.map((p) => p.figures.discountAmount ?? 0)))}`;
  return {
    hidePrices: opts?.hidePrices,
    datesShown: parts.some((p) => p.block.datesShown),
    lines: parts.flatMap((p) => p.block.lines),
    netValue: formatMoney(add((p) => p.figures.net)),
    netAfterDiscount: onNet.length ? formatMoney(add((p) => p.figures.netAfterDiscount ?? p.figures.net)) : null,
    discountLabel: onNet.length ? discountWord(parts, onNet) : offTotal.length ? discountWord(parts, offTotal) : null,
    discountValue: onNet.length ? off(onNet) : offTotal.length ? off(offTotal) : null,
    alsoOffTotalLabel: onNet.length && offTotal.length ? discountWord(parts, offTotal) : null,
    alsoOffTotalValue: onNet.length && offTotal.length ? off(offTotal) : null,
    serviceChargeLabel: taxLabel(parts.map((p) => p.figures.serviceChargeLabel), "Service charge"),
    serviceCharge: formatMoney(add((p) => p.figures.serviceCharge)),
    gstLabel: taxLabel(parts.map((p) => p.figures.gstLabel), "GST"),
    gst: formatMoney(add((p) => p.figures.gst)),
    total: formatMoney(add((p) => p.figures.total)),
  };
}

/** The dates at the top of a trip's paper: a line for each stay. */
export type TripStayDates = { label: string; dates: string };

/** `rooms` — "3 rooms", on a paper that names no room type (2026-11-13). */
export function tripStayDates(stayNo: number, ci: Date | null, co: Date | null, words: (d: Date) => string, rooms?: string | null): TripStayDates {
  const nights = ci && co ? Math.round((co.getTime() - ci.getTime()) / 86_400_000) : null;
  return {
    label: `Stay ${stayNo}`,
    dates: `Check-in ${ci ? words(ci) : "—"} · Check-out ${co ? words(co) : "—"}${nights != null ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}${rooms ? ` · ${rooms}` : ""}`,
  };
}
