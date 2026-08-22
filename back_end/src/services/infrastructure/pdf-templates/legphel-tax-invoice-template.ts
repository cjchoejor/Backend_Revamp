/**
 * B1 · Tax Invoice — Family B (Fiscal), crimson.
 * Series `LH/TI/NNNNNN` in the reference; here the readable `INV-…` id until a series allocator
 * exists (DFG-001 §08 is a separate build item).
 *
 * Row-for-row from the reference card in `docs/bills/legphel-document-formats-complete-30 (1).html`
 * (B1) and the annotated worked example in `DFG-001-Developer-Handbook-v0_2.html` §03:
 *   - "TAX INVOICE" prominent, crimson (r.185(1)); supplier + TPN in the masthead (r.185(3));
 *   - Billed to + Customer TPN / Your ref — the corporate preset (r.185(9)–(10), D-13);
 *   - category-level rows, GST-INCLUSIVE, then the ladder that derives the figures
 *     (Net value of supply → Service charge → Taxable value → GST → Total);
 *   - the GST SENTENCE, stated not merely derivable (r.185(6));
 *   - advance applied with its receipt reference; balance due; Remittance Block; 7-day query line;
 *   - footline with "original" — no version number on the face (r.188).
 *
 * DRAFT (2026-08-22): the same composition rendered for an in-stay booking — no serial, a DRAFT
 * watermark and a loud "not issued" strip — so the desk can check the fiscal particulars BEFORE
 * the one original is issued at checkout. The handbook's lifecycle sanctions exactly this render
 * ("DRAFT renders a watermark and no serial"); what it must never be is handed to the guest as
 * the invoice — the Interim Folio Statement is the in-stay handout.
 */
import { htmlEscape } from "../../../lib/pdf-render-context.js";
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

export type LegphelTaxInvoiceInput = {
  masthead: DocumentMasthead;
  /** The fiscal serial. Null on a DRAFT — the serial exists only from issue. */
  invoiceNo: string | null;
  draft: boolean;
  /** Loud strip under the title on a DRAFT: "Draft — not issued · indicative position as at …". */
  draftStrip?: string | null;
  /** "LH/26/E/04211" — crimson. */
  bookingRef: string;
  /** "15 Oct 2026" (issue date) — or the as-at on a draft. */
  issued: string;
  issuedLabel?: string;
  billedTo: string;
  forGuest?: string | null;
  customerTpn?: string | null;
  yourRef?: string | null;
  /** "13–15 Oct 2026 · 2 nights" */
  stay?: string | null;
  /** "Rooms 201, 202" */
  rooms?: string | null;
  /** Category-level rows, GST-inclusive amounts: "Accommodation · 12 room-nights" → "41,400.00". */
  lines: Array<{ description: string; amount: string }>;
  /** "Itemised detail on the Master Bill, attached" — the progressive-disclosure pointer. */
  detailNote?: string | null;
  netValue: string;
  serviceChargeLabel: string;
  serviceCharge: string;
  taxableValue: string;
  gstLabel: string;
  gst: string;
  total: string;
  /** "Advance applied · PMT-20260812-0001" → "−40,000.00"; refunds as positive lines. */
  settlementLines: Array<{ label: string; value: string }>;
  balanceLabel: string;
  balanceDue: string;
  /** "GST of Nu. 3,219.05 is included in the total consideration of Nu. 67,600.00." */
  gstSentence: string;
  /** Remittance Block — shown while something is due. */
  bank: { bankName: string | null; accountName: string | null; reference: string; accountsPhone: string | null } | null;
  closingNote: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  /** "Page 1 of 1 · original" / "… · draft" / "… · COPY". */
  pageLabel: string;
  copy?: boolean;
  currencyLabel?: string;
};

export function renderLegphelTaxInvoiceHtml(input: LegphelTaxInvoiceInput): string {
  const currency = input.currencyLabel ?? "Nu.";
  const bankPairs: Array<{ label: string; value: string }> = [];
  if (input.bank) {
    if (input.bank.bankName) bankPairs.push({ label: "Bank", value: input.bank.bankName });
    if (input.bank.accountName) bankPairs.push({ label: "A/C", value: input.bank.accountName });
    bankPairs.push({ label: "Ref", value: input.bank.reference });
    if (input.bank.accountsPhone) bankPairs.push({ label: "Accounts", value: input.bank.accountsPhone });
  }
  const identity = [
    input.customerTpn ? `Customer TPN ${input.customerTpn}` : null,
    input.yourRef ? `Your ref ${input.yourRef}` : null,
  ].filter(Boolean);

  const body = [
    renderMasthead(input.masthead),
    // The strip is LOUD on a draft (it is the statement that this is not yet the invoice) and
    // absent on the issued original — the reference's B1 carries no strip.
    renderTitle("Tax Invoice", input.draft ? input.draftStrip ?? "Draft — not issued" : null, false),
    row("Invoice No", input.invoiceNo ?? "Allocated at issue", { boldValue: !!input.invoiceNo }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row(input.issuedLabel ?? (input.draft ? "Position as at" : "Issued"), input.issued, { boldValue: input.draft }),
    section,
    row("Billed to", input.billedTo, { boldValue: true }),
    input.forGuest ? row("For guest", input.forGuest) : "",
    identity.length > 0 ? row(identity.join(" · "), "") : "",
    input.stay ? row("Stay", input.stay) : "",
    input.rooms ? row("Rooms", input.rooms) : "",
    section,
    ...input.lines.map((l) => row(l.description, l.amount)),
    input.detailNote
      ? row(`<i style="font-style:normal;color:var(--mute)">${htmlEscape(input.detailNote)}</i>`, "", { rawKey: true })
      : "",
    section,
    row("Net value of supply", input.netValue),
    row(input.serviceChargeLabel, input.serviceCharge),
    row("Taxable value", input.taxableValue),
    row(input.gstLabel, input.gst),
    row(`Total · ${currency}`, input.total, { total: true }),
    ...input.settlementLines.map((l) => row(l.label, l.value)),
    row(input.balanceLabel, input.balanceDue, { boldValue: true }),
    note(input.gstSentence, "loud"),
    bankPairs.length > 0 ? bankStrip(bankPairs) : "",
    note(input.closingNote, "quiet"),
    footer([input.invoiceNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion], input.pageLabel),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: input.invoiceNo ? `Tax Invoice ${input.invoiceNo}` : `Tax Invoice (draft) ${input.bookingRef}`,
    family: "fiscal",
    watermark: input.draft ? "draft" : input.copy ? "copy" : null,
    body,
  });
}
