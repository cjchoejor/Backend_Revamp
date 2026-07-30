/**
 * A5 · Cancellation Confirmation — Family A (Pre-stay), Commercial.
 * Series `LH/CX/26/NNNNNN`.
 *
 * Row-for-row from the reference card in
 * `docs/bills/legphel-document-formats-complete-30 (1).html` (lines 321–341).
 *
 * This document had NO generator before — the cancellation engine released inventory, posted the
 * penalty and refunded the net, but never produced the guest-facing artifact that states what was
 * retained and why. See `cancellation-confirmation-pdf-service.ts` for where it hooks in.
 *
 * The refund ladder rows are pass-through strings on purpose: the retained/refundable split is
 * decided by the cancellation policy engine (CancellationPolicyRegistry + the penalty computation
 * in `cancellation-service`), and this template must state that decision, never re-derive it.
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

export type LegphelCancellationConfirmationInput = {
  masthead: DocumentMasthead;
  /** "LH/CX/26/000031" */
  cancellationNo: string;
  /** "LH/26/E/04251" — crimson. */
  bookingRef: string;
  /** "02 Sep 2026" */
  date: string;
  /** Muted strip: "Booking cancelled at your request". */
  strip?: string;
  /** "Mr Karma Wangchuk" */
  guest: string;
  /** "10–12 Oct 2026 · Deluxe · 2 nights" */
  cancelledStay: string;
  /** "38 days before arrival" — drives which band of the ladder applied. */
  noticeGiven: string;
  /**
   * The reference embeds the money-receipt ref in the label:
   * "Advance held · LH/MR/26/002768".
   */
  advanceReceiptRef?: string | null;
  advanceHeld: string;
  /**
   * Label states the band that applied, e.g.
   * "Refundable per terms (30–44 days · 50%)".
   */
  refundableLabel: string;
  refundable: string;
  retained: string;
  /** The ruled total — what is actually being refunded. */
  refundIssued: string;
  currencyLabel?: string;
  /** "LH/RR/26/000112" — the refund receipt this cancellation produced. */
  refundReceiptNo?: string | null;
  /** Refund mechanics + which proforma stated the terms. */
  closingNote: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  watermark?: DocumentWatermark;
};

export function renderLegphelCancellationConfirmationHtml(
  input: LegphelCancellationConfirmationInput,
): string {
  const currency = input.currencyLabel ?? "Nu.";
  const advanceLabel = input.advanceReceiptRef ? `Advance held · ${input.advanceReceiptRef}` : "Advance held";

  const body = [
    renderMasthead(input.masthead),
    renderTitle("Cancellation Confirmation", input.strip ?? "Booking cancelled at your request", true),
    row("Cancellation No", input.cancellationNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    section,
    row("Guest", input.guest, { boldValue: true }),
    row("Cancelled stay", input.cancelledStay),
    row("Notice given", input.noticeGiven),
    section,
    row(advanceLabel, input.advanceHeld),
    row(input.refundableLabel, input.refundable),
    row("Retained per terms", input.retained),
    row(`Refund issued · ${currency}`, input.refundIssued, { total: true }),
    input.refundReceiptNo ? row("Refund Receipt", input.refundReceiptNo) : "",
    note(input.closingNote, "quiet"),
    footer([input.cancellationNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Cancellation Confirmation ${input.cancellationNo}`,
    family: "commercial",
    watermark: input.watermark ?? null,
    body,
  });
}
