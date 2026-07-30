/**
 * A3 · Confirmation Voucher — Family A (Pre-stay), Commercial.
 * Series `LH/CV/26/NNNNNN`.
 *
 * Row-for-row from the reference card in
 * `docs/bills/legphel-document-formats-complete-30 (1).html` (lines 250–272).
 *
 * NOTE ON RE CHECK-IN / RE CHECK-OUT — the reference renders these as first-class rows (bold key,
 * bold value) for a split stay, i.e. one booking with a gap in the middle. `docs/pdf-bill-generation
 * -todo.md` lists them as deferred on the old template because the multi-entry booking design
 * wasn't settled. They are real rows here and simply omitted when the caller passes null, so a
 * single-block stay renders exactly the reference's four-row shape without them.
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
  type DocumentWatermark,
} from "./legphel-document-shell.js";

export type LegphelConfirmationVoucherInput = {
  masthead: DocumentMasthead;
  /** "LH/CV/26/000198" */
  voucherNo: string;
  /** "LH/26/E/04236" — crimson. */
  bookingRef: string;
  /** "05 Aug 2026" */
  date: string;
  /** Muted strip: "Booking confirmed — present at check-in". */
  strip?: string;
  /** "Dr Lakshmi Menon · 3 adults" */
  guest: string;
  /** "Bhutan Online Booking Travel" — agent/corporate that placed it. Omitted for direct guests. */
  bookedBy?: string | null;
  /** "08 Sep 2026 · 14:00" */
  checkIn: string;
  /** "09 Sep 2026 · 12:00" */
  checkOut: string;
  /** Split-stay second block. Both omitted together when the stay is one continuous block. */
  reCheckIn?: string | null;
  reCheckOut?: string | null;
  /** "Deluxe · MAP · 2 nights total" */
  roomAndPlan: string;
  /**
   * The reference puts the money-receipt reference INTO the label:
   * "Advance held · LH/MR/26/002741". Pass the receipt ref to reproduce that; omit for
   * "Advance held" alone.
   */
  advanceReceiptRef?: string | null;
  advanceHeld: string;
  balanceAtCheckout: string;
  /** Inclusions + ID requirement. */
  closingNote: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  watermark?: DocumentWatermark;
};

export function renderLegphelConfirmationVoucherHtml(input: LegphelConfirmationVoucherInput): string {
  const advanceLabel = input.advanceReceiptRef ? `Advance held · ${input.advanceReceiptRef}` : "Advance held";
  const hasSplit = !!(input.reCheckIn || input.reCheckOut);

  const body = [
    renderMasthead(input.masthead),
    renderTitle("Confirmation Voucher", input.strip ?? "Booking confirmed — present at check-in", true),
    row("Voucher No", input.voucherNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("Guest", input.guest, { boldValue: true }),
    input.bookedBy ? row("Booked by", input.bookedBy) : "",
    section,
    row("Check-in", input.checkIn, { boldValue: true }),
    row("Check-out", input.checkOut),
    hasSplit ? row("Re check-in", input.reCheckIn ?? "", { boldKey: true, boldValue: true }) : "",
    hasSplit ? row("Re check-out", input.reCheckOut ?? "") : "",
    row("Room · plan", input.roomAndPlan),
    section,
    row(advanceLabel, input.advanceHeld),
    row("Balance at checkout", input.balanceAtCheckout, { boldValue: true }),
    note(input.closingNote, "quiet"),
    footer([input.voucherNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Confirmation Voucher ${input.voucherNo}`,
    family: "commercial",
    watermark: input.watermark ?? null,
    body,
  });
}
