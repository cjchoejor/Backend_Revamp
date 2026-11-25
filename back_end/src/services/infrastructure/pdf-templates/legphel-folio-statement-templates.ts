/**
 * Family C — the operational statements over the one folio (2026-08-22):
 *
 *   C1 · Master Bill — Informational (steel). "Statement — not a tax invoice". Printed at checkout
 *        for signature; in-stay it is the same bill rendered "as at" now.
 *   C5 · Interim Folio Statement (the desk's "Tentative invoice") — Informational. "Position to
 *        date — not a bill for settlement". The as-at moment is its defining datum.
 *
 * Laid out like a well-known hotel's folio since 2026-11-25 (operator, see legphel-bill-parts.ts):
 * the guest and stay blocks side by side, the rooms on their own line, every charge on its own row
 * (a room's nights at one figure on one row) with service charge and GST added beneath, the payments
 * as a table, the balance on its own ruled line. The house look — card, masthead, steel accent,
 * fonts, footline — is unchanged.
 *
 * Neither carries a series number yet — the reference's LH/MB and LH/IF series need the allocator +
 * issuance register (handbook §08, a separate build item); until then the booking ref + the as-at
 * stamp identify a print, and the footline says so.
 */
import {
  footer,
  note,
  renderDocumentPage,
  renderMasthead,
  renderTitle,
  row,
  signatureRow,
  subheading,
  type DocumentMasthead,
  type DocumentWatermark,
} from "./legphel-document-shell.js";
import {
  balanceRow,
  billLinesTable,
  infoBlocks,
  liabilityStatement,
  paymentsTable,
  roomsLine,
  type InfoBlock,
  type PaperBillRow,
  type PaperPaymentRow,
} from "./legphel-bill-parts.js";
import { miniTable } from "./legphel-document-shell.js";

/** What the three folio bills share at the top and in the middle. */
export type FolioBillBody = {
  /** Who the bill is to — "Bill to" / "Billed to". */
  billTo: InfoBlock;
  /** The stay — booking, folio, check-in, check-out, when made. */
  stay: InfoBlock;
  /** "202, 307, 503 · 3 rooms" — wraps. */
  rooms: string | null;
  lines: PaperBillRow[];
  /** Net value · Service charge · GST · Total (the quotation's ladder), each `{label, value}`. */
  ladder: Array<{ label: string; value: string }>;
  totalLabel: string;
  total: string;
  /** Each kind's all-in figure — printed only when the bill has more than one kind. */
  byKind: Array<{ label: string; amount: string }>;
  payments: PaperPaymentRow[];
  balanceLabel: string;
  balance: string;
  owed: boolean;
};

function renderBillBody(b: FolioBillBody, opts: { paymentsHeading: string; noPayments: string }): string[] {
  return [
    infoBlocks(b.billTo, b.stay),
    roomsLine("Rooms", b.rooms),
    subheading("Charges"),
    billLinesTable(b.lines),
    ...b.ladder.map((l) => row(l.label, l.value)),
    row(b.totalLabel, b.total, { total: true }),
    b.byKind.length > 1
      ? [subheading("By kind · service charge and GST included"), miniTable([{ header: "Kind" }, { header: "Amount", align: "r" }], b.byKind.map((k) => [k.label, k.amount]))].join(
          "\n",
        )
      : "",
    subheading(opts.paymentsHeading),
    paymentsTable(b.payments, opts.noPayments),
    balanceRow(b.balanceLabel, b.balance, b.owed),
  ];
}

export type LegphelMasterBillInput = FolioBillBody & {
  masthead: DocumentMasthead;
  /** Series number when one exists; null prints the booking ref + as-at as the identity. */
  billNo: string | null;
  bookingRef: string;
  /** Muted strip: "Statement — not a tax invoice" (+ " · indicative, charges still posting"). */
  strip: string;
  note: string;
  /** The guest's agreement above the signatures, at check-out. */
  liability: string | null;
  signatures: string[] | null;
  tariffVersion: string;
  issuanceRef?: string | null;
  /** "reprint 0" / "indicative". */
  pageLabel: string;
  watermark?: DocumentWatermark;
};

export function renderLegphelMasterBillHtml(input: LegphelMasterBillInput): string {
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Master Bill", input.strip, true),
    ...renderBillBody(input, { paymentsHeading: "Payments", noPayments: "No payment received yet." }),
    note(input.note, "grey"),
    input.liability ? liabilityStatement(input.liability) : "",
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

export type LegphelInterimStatementInput = FolioBillBody & {
  masthead: DocumentMasthead;
  statementNo: string | null;
  bookingRef: string;
  /** "Position to date — not a bill for settlement" (muted strip). */
  strip: string;
  note: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  pageLabel: string;
  watermark?: DocumentWatermark;
};

export function renderLegphelInterimStatementHtml(input: LegphelInterimStatementInput): string {
  const body = [
    renderMasthead(input.masthead),
    renderTitle("Interim Folio Statement", input.strip, true),
    ...renderBillBody(input, { paymentsHeading: "Payments so far", noPayments: "No payment received yet." }),
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
