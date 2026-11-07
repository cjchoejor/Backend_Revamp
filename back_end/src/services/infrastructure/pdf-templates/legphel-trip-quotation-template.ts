/**
 * A TRIP'S QUOTATION (2026-11-07, operator: each stay keeps its own quotation and the trip has a
 * combined one of its own, "QUO-0003 v2"). The house quotation, with each stay set out as its own
 * quotation sets it out — its number and version, its check-in and check-out, its rooms and its
 * totals — then the trip: each stay's total and the trip's, which is only their sum.
 */
import { type StayLines } from "./legphel-document-format.js";
import {
  footer,
  miniTable,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  section,
  stayRows,
  subheading,
  type DocumentMasthead,
} from "./legphel-document-shell.js";
import { renderPriceBlock, type LegphelPriceBlock } from "./legphel-quotation-template.js";

export type TripStaySection = {
  /** "Stay 1 · QUO-20261107-0001 · v2" */
  heading: string;
  stay: StayLines | null;
  block: LegphelPriceBlock;
};

export type TripSummaryRow = { stay: string; ownNumber: string; checkIn: string; checkOut: string; total: string };

export type LegphelTripQuotationInput = {
  masthead: DocumentMasthead;
  quotationNo: string;
  bookingRef: string;
  date: string;
  validityStrip: string;
  to: string;
  stays: TripStaySection[];
  summary: TripSummaryRow[];
  tripTotal: string;
  currencyLabel?: string;
  closingNote: string;
  hidePrices?: boolean;
};

export function renderLegphelTripQuotationHtml(input: LegphelTripQuotationInput): string {
  const currency = input.currencyLabel ?? "Nu.";
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Quotation", input.validityStrip, true),
    row("Quotation No", input.quotationNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("To", input.to, { boldValue: true }),
    ...input.stays.flatMap((s) => [
      section,
      subheading(s.heading),
      stayRows(s.stay),
      ...renderPriceBlock({ ...s.block, hidePrices: input.hidePrices }),
    ]),
    section,
    subheading(`The trip · ${input.stays.length} stays`),
    miniTable(
      [
        { header: "Stay" },
        { header: "Its own quotation" },
        { header: "Check-in" },
        { header: "Check-out" },
        ...(input.hidePrices ? [] : [{ header: "Total", align: "r" as const }]),
      ],
      input.summary.map((r) => [r.stay, r.ownNumber, r.checkIn, r.checkOut, ...(input.hidePrices ? [] : [r.total])]),
    ),
    input.hidePrices ? "" : row(`Trip total · ${currency}`, input.tripTotal, { total: true }),
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
