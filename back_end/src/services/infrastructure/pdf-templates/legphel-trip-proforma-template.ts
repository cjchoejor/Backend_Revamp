/**
 * A TRIP'S PROFORMA (2026-11-07, operator: each stay keeps its own proforma and the trip has one of
 * its own; a part payment goes to the first stay's advance first). The house proforma, with each
 * stay set out as its own proforma sets it out — its number and version, its check-in and
 * check-out, its rooms and totals and its advance — then the trip: each stay's total and advance,
 * and the trip's, which are only their sums.
 */
import { type StayLines } from "./legphel-document-format.js";
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
  stayRows,
  subheading,
  type DocumentMasthead,
} from "./legphel-document-shell.js";
import { renderPriceBlock, type LegphelPriceBlock } from "./legphel-quotation-template.js";

export type TripProformaStay = {
  /** "Stay 1 · INV-20261107-0001 · v2" */
  heading: string;
  stay: StayLines | null;
  block: LegphelPriceBlock;
  /** That stay's own advance rows, as its own proforma prints them. */
  advanceRows: Array<{ label: string; value: string }>;
};

export type TripProformaSummaryRow = {
  stay: string;
  ownNumber: string;
  checkIn: string;
  checkOut: string;
  total: string;
  advanceDueNow: string;
};

export type LegphelTripProformaInput = {
  masthead: DocumentMasthead;
  proformaNo: string;
  bookingRef: string;
  date: string;
  advanceDueBy: string | null;
  validUntil: string | null;
  to: string;
  stays: TripProformaStay[];
  summary: TripProformaSummaryRow[];
  tripTotal: string;
  advanceReceived: string | null;
  advanceDueNow: string | null;
  balanceAtCheckout: string;
  bank: { accountName: string | null; accountsPhone: string | null };
  sharingNote: string;
  closingNote: string;
  currencyLabel?: string;
};

export function renderLegphelTripProformaHtml(input: LegphelTripProformaInput): string {
  const currency = input.currencyLabel ?? "Nu.";
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
    ...input.stays.flatMap((s) => [
      section,
      subheading(s.heading),
      stayRows(s.stay),
      ...renderPriceBlock(s.block),
      ...s.advanceRows.map((r) => row(r.label, r.value)),
    ]),
    section,
    subheading(`The trip · ${input.stays.length} stays`),
    miniTable(
      [
        { header: "Stay" },
        { header: "Its own proforma" },
        { header: "Check-in" },
        { header: "Check-out" },
        { header: "Total", align: "r" as const },
        { header: "Advance due now", align: "r" as const },
      ],
      input.summary.map((r) => [r.stay, r.ownNumber, r.checkIn, r.checkOut, r.total, r.advanceDueNow]),
    ),
    row(`Trip total · ${currency}`, input.tripTotal, { total: true }),
    input.advanceReceived ? row("Advance received", input.advanceReceived) : "",
    input.advanceDueNow != null ? row(`Advance due now · ${currency}`, input.advanceDueNow, { total: true }) : "",
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
