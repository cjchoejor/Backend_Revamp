/**
 * A TRIP'S CONFIRMATION VOUCHER (2026-11-09, operator: one paper for the stays). The house voucher:
 * both stays' dates at the top, then one table of everything reserved. No prices, like the voucher
 * it is made of.
 */
import { footer, note, renderDocumentPage, renderMasthead, renderTitle, row, section, type DocumentMasthead } from "./legphel-document-shell.js";
import { renderPriceBlock, type LegphelPriceBlock, type LegphelQuotationLine } from "./legphel-quotation-template.js";
import { tripDatesRows, type TripDatesRow } from "./legphel-trip-quotation-template.js";

export type LegphelTripVoucherInput = {
  masthead: DocumentMasthead;
  voucherNo: string;
  bookingRef: string;
  date: string;
  guest: string;
  bookedBy?: string | null;
  stays: TripDatesRow[];
  lines: LegphelQuotationLine[];
  datesShown: boolean;
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
    section,
    ...tripDatesRows(input.stays),
    ...(input.lines.length ? renderPriceBlock({ lines: input.lines, datesShown: input.datesShown, hidePrices: true } as LegphelPriceBlock) : []),
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
