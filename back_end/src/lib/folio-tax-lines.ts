import { FolioLineType } from "@prisma/client";

/**
 * Service-charge / GST companion lines on the folio (2026-08-18).
 *
 * The folio has no dedicated line type for tax: a service-charge companion is a `SERVICE`
 * line and a GST companion is an `OTHER` line, both recognised ONLY by their description.
 * Every writer of such a line (manual charge posting, corrections, the night audit) and every
 * reader that must tell tax apart from charges (the FINAL invoice) goes through this module,
 * so the convention has exactly one home and cannot drift.
 */

export const SERVICE_CHARGE_DESCRIPTION_PREFIX = "Service charge (";
export const GST_DESCRIPTION_PREFIX = "GST (";
/**
 * `Tax (imported — BST + service charge)` — the ONE combined tax line the legacy importer
 * writes per folio (`scripts/import-data/import-legacy-bookings.ts`). The old system stored
 * service charge and sales tax as a single figure, so it arrives here un-split.
 *
 * It is tax, not a charge, and recognising it matters twice over: counted as a charge it
 * inflated "Charges" and left the Service charge / GST cells reading 0.00 on 98 imported
 * folios, and — worse — `folio-ledger-view` then ALSO computed tax on the same room line at
 * render time, so every imported booking's tax invoice and master bill double-counted it
 * (ENT-20260607-0003: total 5,580.25 against a billed-and-settled 4,919.99, with a balance
 * due printed on a folio that owed nothing).
 */
export const LEGACY_IMPORTED_TAX_DESCRIPTION_PREFIX = "Tax (imported";
export const SALES_TAX_CORRECTION_DESCRIPTION_PREFIX = "Sales tax correction on:";
/** `Service charge correction on: <base description>` — the SC delta a charge correction posts (2026-08-21). */
export const SERVICE_CHARGE_CORRECTION_DESCRIPTION_PREFIX = "Service charge correction on:";

/** `Service charge (10.00%) on: <base description>` */
export function serviceChargeLineDescription(rate: number, baseDescription: string): string {
  return `${SERVICE_CHARGE_DESCRIPTION_PREFIX}${(rate * 100).toFixed(2)}%) on: ${baseDescription}`;
}

/** `GST (5.00%) on: <base description>` */
export function gstLineDescription(rate: number, baseDescription: string): string {
  return `${GST_DESCRIPTION_PREFIX}${(rate * 100).toFixed(2)}%) on: ${baseDescription}`;
}

/** `Sales tax correction on: <base description>` — the GST delta a charge correction posts. */
export function salesTaxCorrectionDescription(baseDescription: string): string {
  return `${SALES_TAX_CORRECTION_DESCRIPTION_PREFIX} ${baseDescription}`;
}

/** `Service charge correction on: <base description>` — the SC delta a charge correction posts. */
export function serviceChargeCorrectionDescription(baseDescription: string): string {
  return `${SERVICE_CHARGE_CORRECTION_DESCRIPTION_PREFIX} ${baseDescription}`;
}

/** The rate a companion line was posted at, read off its own description ("(10.00%)") — so a
 *  correction on an old charge moves its tax at the rate that charge was actually taxed, not
 *  today's. Null for correction companions and legacy lines that carry no rate. */
export function companionRateFromDescription(description: string): number | null {
  const m = /^(?:Service charge|GST) \((\d+(?:\.\d+)?)%\)/.exec(description ?? "");
  if (!m) return null;
  const pct = Number(m[1]);
  return Number.isFinite(pct) ? pct / 100 : null;
}

/** A charge correction's OWN line: `Correction for <lineId>: <reason>` (posted with the charge's lineType). */
export const CORRECTION_LINE_PREFIX = "Correction for ";

/**
 * The base-charge description a companion names ("… on: <base>"), or null when it names none
 * (legacy lines). The night audit, manual posting and corrections all write the parent's
 * description after " on: ", so a reader can find the charge a companion rides on without
 * relying on array position (the desk's folio fold uses the same rule — keep the two in step).
 */
export function companionBaseDescription(description: string): string | null {
  const d = description ?? "";
  const i = d.indexOf(" on: ");
  return i >= 0 ? d.slice(i + 5).trim() : null;
}

/** A companion posted BY A CORRECTION (its SC / GST delta) rather than by the charge itself. */
export function isCorrectionCompanionDescription(description: string): boolean {
  const d = description ?? "";
  return d.startsWith(SALES_TAX_CORRECTION_DESCRIPTION_PREFIX) || d.startsWith(SERVICE_CHARGE_CORRECTION_DESCRIPTION_PREFIX);
}

export type FolioLineKind = "CHARGE" | "SERVICE_CHARGE" | "GST" | "LEGACY_COMBINED_TAX";

/**
 * Split a legacy combined tax figure back into its service-charge and GST parts.
 *
 * The ratio needs only the RATES, not the amount it was charged on: SC = svc·n and
 * GST = gst·(n + svc·n), so SC : GST is fixed at svc : gst(1+svc) whatever n was. The two
 * parts are forced to sum to the stored figure exactly (one is rounded, the other is the
 * remainder), so nothing drifts from the ledger.
 *
 * This is recovery, not invention: checked against all 98 imported folios on
 * `legphel_pms_dev2`, the stored figure equals SC(10%) + compound GST(5%) on the imported
 * room net — 75 to the cent and 23 within the ±0.01 the old system's own rounding explains.
 * With both rates at 0 the composition is unknowable, so it is reported as GST, the
 * statutory part.
 */
export function splitCombinedTax(
  total: number,
  svcRate: number,
  gstRate: number,
): { serviceCharge: number; gst: number } {
  const scWeight = svcRate;
  const gstWeight = gstRate * (1 + svcRate);
  const denom = scWeight + gstWeight;
  if (!(denom > 0)) return { serviceCharge: 0, gst: total };
  const serviceCharge = Math.round(total * (scWeight / denom) * 100) / 100;
  return { serviceCharge, gst: Math.round((total - serviceCharge) * 100) / 100 };
}

/**
 * Tell a tax companion apart from a real charge. Anything not recognised as a companion is a
 * CHARGE — including legacy `SERVICE` lines such as "Laundry summary (imported)".
 */
export function classifyFolioLine(line: { lineType: FolioLineType | string; description: string }): FolioLineKind {
  const d = line.description ?? "";
  if (line.lineType === FolioLineType.OTHER && d.startsWith(LEGACY_IMPORTED_TAX_DESCRIPTION_PREFIX)) {
    return "LEGACY_COMBINED_TAX";
  }
  if (
    line.lineType === FolioLineType.SERVICE &&
    (d.startsWith(SERVICE_CHARGE_DESCRIPTION_PREFIX) || d.startsWith(SERVICE_CHARGE_CORRECTION_DESCRIPTION_PREFIX))
  ) {
    return "SERVICE_CHARGE";
  }
  if (
    line.lineType === FolioLineType.OTHER &&
    (d.startsWith(GST_DESCRIPTION_PREFIX) || d.startsWith(SALES_TAX_CORRECTION_DESCRIPTION_PREFIX))
  ) {
    return "GST";
  }
  return "CHARGE";
}
