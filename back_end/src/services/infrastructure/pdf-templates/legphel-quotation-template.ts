/**
 * A1 · Quotation — Family A (Pre-stay), Commercial.
 * Series `LH/Q/26/NNNNNN`.
 *
 * Rendered row-for-row from the reference card in
 * `docs/bills/legphel-document-formats-complete-30 (1).html` (lines 176–199). Row order, labels,
 * the `(expected)` annotation on GST, and the closing note are reproduced as-is.
 *
 * Per the reference the table amounts are TAX-INCLUSIVE, and the Net / Service charge / GST rows
 * beneath decompose that same total — they are not additions to it.
 */
import { htmlEscape } from "../../../lib/pdf-render-context.js";
import {
  bankStrip,
  footer,
  miniTable,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  section,
  type DocumentMasthead,
  type DocumentWatermark,
} from "./legphel-document-shell.js";

export type LegphelQuotationLine = {
  /** "Deluxe · 1 room · 2 adults · MAP" */
  description: string;
  nights: string;
  ratePerNight: string;
  amount: string;
};

export type LegphelQuotationInput = {
  masthead: DocumentMasthead;
  /** "LH/Q/26/000512" */
  quotationNo: string;
  /** "LH/26/E/04198" — rendered crimson. */
  bookingRef: string;
  /** "28 Jul 2026" */
  date: string;
  /** Strip under the title: "Valid until 12 Aug 2026 · Not a booking confirmation" */
  validityStrip: string;
  /** "Nandi Travels & Tours, Jaigaon" */
  to: string;
  /** "Mr Rajesh Nandi" — the reference's Attn line. Omitted when absent. */
  attn?: string | null;
  /** "20 Oct — 22 Oct 2026 · 2 nights" */
  stay: string;
  lines: LegphelQuotationLine[];
  /**
   * Optional discount row (2026-08-02): the table shows ORIGINAL (pre-discount) prices and
   * this row carries the deduction — label "Discount 10%", value "− 340.00". (Legacy
   * discounted quotes without a stored pre-discount snapshot pass a rate-movement note
   * instead, e.g. "1,700.00 → 1,530.00 / room / night", with discounted rows.) Rendered
   * above Net value; omitted when no discount applied.
   */
  discountLabel?: string | null;
  discountValue?: string | null;
  netValue: string;
  /** Label carries the rate, e.g. "Service charge 10%". */
  serviceChargeLabel: string;
  serviceCharge: string;
  /** Label carries the rate, e.g. "GST @ 5%" — "(expected)" is appended by the template. */
  gstLabel: string;
  gst: string;
  /** Grand total, tax-inclusive. */
  total: string;
  /** Currency word for the total row — "Nu." in the reference. */
  currencyLabel?: string;
  closingNote: string;
  /** Tariff version for the footer, e.g. "T1.0". */
  tariffVersion: string;
  /** Optional issuance-register id for the footer's middle slot. */
  issuanceRef?: string | null;
  watermark?: DocumentWatermark;
};

export function renderLegphelQuotationHtml(input: LegphelQuotationInput): string {
  const currency = input.currencyLabel ?? "Nu.";
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Quotation", input.validityStrip, true),
    row("Quotation No", input.quotationNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("To", input.to, { boldValue: true }),
    input.attn ? row("Attn", input.attn) : "",
    section,
    row("Stay", input.stay),
    miniTable(
      [
        { header: "Description" },
        { header: "Nights", align: "r" },
        { header: "Rate / night", align: "r" },
        { header: "Amount", align: "r" },
      ],
      input.lines.map((l) => [l.description, l.nights, l.ratePerNight, l.amount]),
    ),
    input.discountLabel ? row(input.discountLabel, input.discountValue ?? "") : "",
    row("Net value", input.netValue),
    row(input.serviceChargeLabel, input.serviceCharge),
    // The reference annotates GST as "(expected)" on pre-stay documents — no supply has happened
    // yet, so the figure is an estimate until the tax invoice is issued.
    row(
      `${htmlEscape(input.gstLabel)} <i style="font-style:normal;color:var(--mute)">(expected)</i>`,
      input.gst,
      { rawKey: true },
    ),
    row(`Total · ${currency}`, input.total, { total: true }),
    note(input.closingNote, "quiet"),
    footer([input.quotationNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Quotation ${input.quotationNo}`,
    family: "commercial",
    watermark: input.watermark ?? null,
    body,
  });
}

// Re-exported so a caller composing an unusual variant can reach the primitives without also
// importing the shell module.
export { bankStrip };
