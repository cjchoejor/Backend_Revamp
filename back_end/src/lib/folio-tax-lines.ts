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
export const SALES_TAX_CORRECTION_DESCRIPTION_PREFIX = "Sales tax correction on:";

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

export type FolioLineKind = "CHARGE" | "SERVICE_CHARGE" | "GST";

/**
 * Tell a tax companion apart from a real charge. Anything not recognised as a companion is a
 * CHARGE — including legacy `SERVICE` lines such as "Laundry summary (imported)".
 */
export function classifyFolioLine(line: { lineType: FolioLineType | string; description: string }): FolioLineKind {
  const d = line.description ?? "";
  if (line.lineType === FolioLineType.SERVICE && d.startsWith(SERVICE_CHARGE_DESCRIPTION_PREFIX)) return "SERVICE_CHARGE";
  if (
    line.lineType === FolioLineType.OTHER &&
    (d.startsWith(GST_DESCRIPTION_PREFIX) || d.startsWith(SALES_TAX_CORRECTION_DESCRIPTION_PREFIX))
  ) {
    return "GST";
  }
  return "CHARGE";
}
