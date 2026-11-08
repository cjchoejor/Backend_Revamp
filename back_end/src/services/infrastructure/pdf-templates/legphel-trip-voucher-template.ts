/**
 * A TRIP'S CONFIRMATION VOUCHER (2026-11-09, operator: "do the same for proforma and reserve and
 * confirmation voucher"). The house voucher with each stay set out as its own voucher sets it out —
 * its number, its check-in and check-out, its rooms — then the stays together. No prices, like the
 * voucher it is made of.
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
import { renderPriceBlock, type LegphelPriceBlock, type LegphelQuotationLine } from "./legphel-quotation-template.js";

export type TripVoucherStaySection = {
  /** "Stay 1 · VOU-20261109-0001" */
  heading: string;
  stay: StayLines | null;
  lines?: LegphelQuotationLine[];
  datesShown?: boolean;
};

export type TripVoucherSummaryRow = { stay: string; ownNumber: string; checkIn: string; checkOut: string };

export type LegphelTripVoucherInput = {
  masthead: DocumentMasthead;
  voucherNo: string;
  bookingRef: string;
  date: string;
  guest: string;
  bookedBy?: string | null;
  stays: TripVoucherStaySection[];
  summary: TripVoucherSummaryRow[];
  closingNote: string;
};

export function renderLegphelTripVoucherHtml(input: LegphelTripVoucherInput): string {
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Confirmation Voucher", "Booking confirmed — present at check-in", true),
    row("Voucher No", input.voucherNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("Guest", input.guest, { boldValue: true }),
    input.bookedBy ? row("Booked by", input.bookedBy) : "",
    ...input.stays.flatMap((s) => [
      section,
      subheading(s.heading),
      stayRows(s.stay),
      ...(s.lines?.length ? renderPriceBlock({ lines: s.lines, datesShown: s.datesShown, hidePrices: true } as LegphelPriceBlock) : []),
    ]),
    section,
    subheading(`The trip · ${input.stays.length} stays`),
    miniTable(
      [{ header: "Stay" }, { header: "Its own voucher" }, { header: "Check-in" }, { header: "Check-out" }],
      input.summary.map((r) => [r.stay, r.ownNumber, r.checkIn, r.checkOut]),
    ),
    note(input.closingNote, "quiet"),
    footer([input.voucherNo, input.bookingRef, null, "E&OE", null]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Confirmation Voucher ${input.voucherNo}`,
    family: "commercial",
    watermark: null,
    body,
  });
}
