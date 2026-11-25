/**
 * B1 · Tax Invoice — Family B (Fiscal), crimson.
 * Series `LH/TI/NNNNNN` in the reference; here the readable `INV-…` id until a series allocator
 * exists (DFG-001 §08 is a separate build item).
 *
 * From the reference card in `docs/bills/legphel-document-formats-complete-30 (1).html` (B1) and the
 * handbook's worked example (§03): "TAX INVOICE" prominent, crimson (r.185(1)); supplier + TPN in the
 * masthead (r.185(3)); billed to + customer TPN / your ref (r.185(9)–(10)); the ladder that derives the
 * figures (Net value of supply → Service charge → Taxable value → GST → Total); the GST SENTENCE,
 * stated not merely derivable (r.185(6)); payments applied with their receipts; balance; remittance
 * block while due; footline with "original" — no version number on the face (r.188).
 *
 * Laid out like a well-known hotel's invoice since 2026-11-25 (operator): the billed-to and invoice
 * blocks side by side, the rooms on their own line, every charge on its own row (a room's nights at
 * one figure on one row) — the category-level rows it printed before are now the "by kind" summary —
 * the amount in words, and the payments as a table. See legphel-bill-parts.ts.
 *
 * DRAFT (2026-08-22): the same composition rendered for an in-stay booking — no serial, a DRAFT
 * watermark and a loud "not issued" strip — so the desk can check the fiscal particulars BEFORE the
 * one original is issued at checkout. It is never handed to the guest as the invoice.
 */
import {
  bankStrip,
  footer,
  miniTable,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  subheading,
  type DocumentMasthead,
} from "./legphel-document-shell.js";
import {
  amountInWordsLine,
  balanceRow,
  billLinesTable,
  infoBlocks,
  paymentsTable,
  roomsLine,
  type InfoBlock,
  type PaperBillRow,
  type PaperPaymentRow,
} from "./legphel-bill-parts.js";

export type LegphelTaxInvoiceInput = {
  masthead: DocumentMasthead;
  /** The fiscal serial. Null on a DRAFT — the serial exists only from issue. */
  invoiceNo: string | null;
  draft: boolean;
  /** Loud strip under the title on a DRAFT: "Draft — not issued · indicative position as at …". */
  draftStrip?: string | null;
  bookingRef: string;
  billedTo: InfoBlock;
  invoice: InfoBlock;
  rooms: string | null;
  lines: PaperBillRow[];
  netValue: string;
  serviceChargeLabel: string;
  serviceCharge: string;
  taxableValue: string;
  gstLabel: string;
  gst: string;
  total: string;
  /** "Ngultrum Thirteen Thousand Eight Hundred Sixty Only". */
  totalInWords: string;
  /** Each kind's all-in figure — printed when the bill has more than one kind. */
  byKind: Array<{ label: string; amount: string }>;
  payments: PaperPaymentRow[];
  balanceLabel: string;
  balanceDue: string;
  owed: boolean;
  /** "GST of Nu. 3,219.05 is included in the total consideration of Nu. 67,600.00." */
  gstSentence: string;
  /** Remittance Block — shown while something is due. */
  bank: { bankName: string | null; accountName: string | null; reference: string; accountsPhone: string | null } | null;
  closingNote: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  /** "original" / "draft" / "COPY". */
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

  const body = [
    renderMasthead(input.masthead),
    // The strip is LOUD on a draft (it is the statement that this is not yet the invoice) and
    // absent on the issued original — the reference's B1 carries no strip.
    renderTitle("Tax Invoice", input.draft ? input.draftStrip ?? "Draft — not issued" : null, false),
    infoBlocks(input.billedTo, input.invoice),
    roomsLine("Rooms", input.rooms),
    subheading("Charges"),
    billLinesTable(input.lines),
    row("Net value of supply", input.netValue),
    row(input.serviceChargeLabel, input.serviceCharge),
    row("Taxable value", input.taxableValue),
    row(input.gstLabel, input.gst),
    row(`Total · ${currency}`, input.total, { total: true }),
    amountInWordsLine(input.totalInWords),
    note(input.gstSentence, "loud"),
    input.byKind.length > 1
      ? [subheading("By kind · service charge and GST included"), miniTable([{ header: "Kind" }, { header: "Amount", align: "r" }], input.byKind.map((k) => [k.label, k.amount]))].join(
          "\n",
        )
      : "",
    subheading("Payments applied"),
    paymentsTable(input.payments, "No payment received yet."),
    balanceRow(input.balanceLabel, input.balanceDue, input.owed),
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
