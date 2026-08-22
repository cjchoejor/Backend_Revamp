/**
 * Family C — the operational statements over the one folio (2026-08-22):
 *
 *   C1 · Master Bill — Informational (steel). "Statement — not a tax invoice". The ROLLUP: one
 *        row per component (Room · Food & beverage · Services & other), one ladder from the
 *        rollup, the settlement position, the four standard notes, a signature row. Printed at
 *        checkout for signature; in-stay it is the same rollup rendered "as at" now.
 *   C5 · Interim Folio Statement — Informational. "Position to date — not a bill for settlement".
 *        The as-at timestamp is its defining datum; component-summarised charges, position after
 *        money received. Its job is to prevent checkout surprise (DFG-001 §10A.7). Every print
 *        is a new snapshot, superseded by time itself.
 *
 * Both composed row-for-row from `docs/bills/legphel-document-formats-complete-30 (1).html`.
 * Neither carries a series number yet — the reference's LH/MB and LH/IF series need the
 * allocator + issuance register (handbook §08, a separate build item); until then the booking
 * ref + the as-at stamp identify a print, and the footline says so.
 */
import {
  footer,
  miniTable,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  section,
  signatureRow,
  subheading,
  type DocumentMasthead,
  type DocumentWatermark,
} from "./legphel-document-shell.js";

export type LegphelMasterBillInput = {
  masthead: DocumentMasthead;
  /** Series number when one exists; null prints the booking ref + as-at as the identity. */
  billNo: string | null;
  bookingRef: string;
  /** Muted strip: "Statement — not a tax invoice" (+ " · indicative, charges still posting"). */
  strip: string;
  /** "Pelden Enterprise · conference · 13–15 Oct 2026" */
  account: string;
  forGuest?: string | null;
  stay?: string | null;
  rooms?: string | null;
  /** "As at" (live) or "Content frozen at folio seal" (sealed) → "15 Oct 2026 · 09:40". */
  asAtLabel: string;
  asAt: string;
  rows: Array<{ component: string; contents: string; amount: string }>;
  total: string;
  /** "Net 88,190.47 · Service 8,819.05 · Taxable 97,009.52 · GST 4,850.48" */
  ladderLine: string;
  position: Array<{ label: string; value: string; bold?: boolean }>;
  note: string;
  signatures: string[] | null;
  tariffVersion: string;
  issuanceRef?: string | null;
  /** "Page 1 of 1 · reprint 0" / "Page 1 of 1 · indicative". */
  pageLabel: string;
  watermark?: DocumentWatermark;
  currencyLabel?: string;
};

export function renderLegphelMasterBillHtml(input: LegphelMasterBillInput): string {
  const currency = input.currencyLabel ?? "Nu.";
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Master Bill", input.strip, true),
    input.billNo ? row("Master Bill No", input.billNo, { boldValue: true }) : "",
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Account", input.account, { boldValue: true }),
    input.forGuest ? row("For guest", input.forGuest) : "",
    input.stay ? row("Stay", input.stay) : "",
    input.rooms ? row("Rooms", input.rooms) : "",
    row(input.asAtLabel, input.asAt, { boldKey: true, boldValue: true }),
    miniTable(
      [{ header: "Component" }, { header: "Contents" }, { header: "Amount", align: "r" }],
      input.rows.map((r) => [r.component, r.contents, r.amount]),
    ),
    row(`Total · ${currency}`, input.total, { total: true }),
    row(input.ladderLine, ""),
    section,
    subheading("Settlement position"),
    ...input.position.map((p) => row(p.label, p.value, { boldValue: !!p.bold })),
    note(input.note, "grey"),
    input.signatures ? signatureRow(input.signatures) : "",
    footer([input.billNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion], input.pageLabel),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: input.billNo ? `Master Bill ${input.billNo}` : `Master Bill ${input.bookingRef}`,
    family: "informational",
    watermark: input.watermark ?? null,
    body,
  });
}

export type LegphelInterimStatementInput = {
  masthead: DocumentMasthead;
  statementNo: string | null;
  bookingRef: string;
  /** "Position to date — not a bill for settlement" (muted strip). */
  strip: string;
  /** "22 Aug 2026 · 14:05" — the defining datum. */
  asAt: string;
  account: string;
  forGuest?: string | null;
  stay?: string | null;
  /** "3 slept · 4 to come" */
  nightsLine?: string | null;
  rooms?: string | null;
  /** "Room charges to date" → "20,700.00" … one per component with anything posted. */
  rows: Array<{ label: string; value: string }>;
  chargesToDate: string;
  /** "Advance held" → "−40,000.00"; refunds/write-offs as further lines. */
  moneyLines: Array<{ label: string; value: string }>;
  position: string;
  note: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  pageLabel: string;
  watermark?: DocumentWatermark;
  currencyLabel?: string;
};

export function renderLegphelInterimStatementHtml(input: LegphelInterimStatementInput): string {
  const currency = input.currencyLabel ?? "Nu.";
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Interim Folio Statement", input.strip, true),
    input.statementNo ? row("Statement No", input.statementNo, { boldValue: true }) : "",
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("As at", input.asAt, { boldValue: true }),
    section,
    row("Account", input.account, { boldValue: true }),
    input.forGuest ? row("For guest", input.forGuest) : "",
    input.stay ? row("Stay", input.stay) : "",
    input.nightsLine ? row("Nights", input.nightsLine) : "",
    input.rooms ? row("Rooms", input.rooms) : "",
    section,
    ...input.rows.map((r) => row(r.label, r.value)),
    row(`Charges to date · ${currency}`, input.chargesToDate, { total: true }),
    ...input.moneyLines.map((l) => row(l.label, l.value)),
    row("Position to date", input.position, { boldValue: true }),
    note(input.note, "grey"),
    footer([input.statementNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion], input.pageLabel),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Interim Folio Statement ${input.bookingRef}`,
    family: "informational",
    watermark: input.watermark ?? null,
    body,
  });
}
