/**
 * A TRIP'S PROFORMA (2026-11-09, operator: one paper, "do it for proforma and confirmation voucher
 * as well"). The house proforma: both stays' dates at the top, one table and one set of totals, then
 * the advance as the stays' own figures added up.
 */
import {
  bankStrip,
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
import { tripDatesRows, type TripDatesRow } from "./legphel-trip-quotation-template.js";

export type LegphelTripProformaInput = {
  masthead: DocumentMasthead;
  proformaNo: string;
  bookingRef: string;
  date: string;
  advanceDueBy: string | null;
  validUntil: string | null;
  to: string;
  stays: TripDatesRow[];
  prices: LegphelPriceBlock;
  planRows: Array<{ label: string; value: string }>;
  advanceReceived: string | null;
  advanceDueNowLabel: string;
  advanceDueNow: string | null;
  balanceAtCheckout: string;
  bank: { accountName: string | null; accountsPhone: string | null };
  sharingNote: string;
  closingNote: string;
};

export function renderLegphelTripProformaHtml(input: LegphelTripProformaInput): string {
  const bankPairs: Array<{ label: string; value: string }> = [];
  if (input.bank.accountName) bankPairs.push({ label: "A/C", value: input.bank.accountName });
  bankPairs.push({ label: "Ref", value: input.proformaNo });
  if (input.bank.accountsPhone) bankPairs.push({ label: "Accounts", value: input.bank.accountsPhone });

  const body = [
    renderMasthead(input.masthead),
    renderTitle("Proforma Invoice", "This is not a tax invoice — a tax invoice will be issued on supply", false),
    row("Proforma No", input.proformaNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    input.advanceDueBy ? row("Advance due by", input.advanceDueBy, { boldKey: true, redValue: true }) : "",
    input.validUntil ? row("Valid until", input.validUntil, { boldKey: true }) : "",
    section,
    row("To", input.to, { boldValue: true }),
    section,
    ...tripDatesRows(input.stays),
    ...renderPriceBlock(input.prices),
    ...input.planRows.map((r) => row(r.label, r.value)),
    input.advanceReceived ? row("Advance received", input.advanceReceived) : "",
    input.advanceDueNow != null ? row(input.advanceDueNowLabel, input.advanceDueNow, { total: true }) : "",
    row("Balance at checkout", input.balanceAtCheckout),
    bankStrip(bankPairs),
    note(input.sharingNote, "quiet"),
    note(input.closingNote, "quiet"),
    footer([input.proformaNo, input.bookingRef, null, "E&OE", null]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Proforma Invoice ${input.proformaNo}`,
    family: "commercial",
    watermark: null,
    body,
  });
}
