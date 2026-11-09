/**
 * A TRIP'S QUOTATION (2026-11-09, operator: "show it together on the top it can show both the stay 1
 * and stay 2 dates, and in side the table, it can show the what in it in one table"). The house
 * quotation: both stays' dates at the top, then one table and one set of totals for the trip.
 */
import {
  footer,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  section,
  type DocumentMasthead,
} from "./legphel-document-shell.js";
import { renderPriceBlock, type LegphelPriceBlock } from "./legphel-quotation-template.js";

export type TripDatesRow = { label: string; dates: string };

/** The stays' dates at the top of a trip's paper. */
export const tripDatesRows = (stays: TripDatesRow[]) => stays.map((s) => row(s.label, s.dates, { boldValue: true }));

export type LegphelTripQuotationInput = {
  masthead: DocumentMasthead;
  quotationNo: string;
  bookingRef: string;
  date: string;
  validityStrip: string;
  to: string;
  stays: TripDatesRow[];
  prices: LegphelPriceBlock;
  closingNote: string;
};

export function renderLegphelTripQuotationHtml(input: LegphelTripQuotationInput): string {
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Quotation", input.validityStrip, true),
    row("Quotation No", input.quotationNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("To", input.to, { boldValue: true }),
    section,
    ...tripDatesRows(input.stays),
    ...renderPriceBlock(input.prices),
    note(input.closingNote, "quiet"),
    footer([input.quotationNo, input.bookingRef, null, "E&OE", null]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Quotation ${input.quotationNo}`,
    family: "commercial",
    watermark: null,
    body,
  });
}
