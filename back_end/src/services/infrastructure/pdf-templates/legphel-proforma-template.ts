/**
 * A2 · Proforma Invoice — Family A (Pre-stay), Commercial.
 * Series `LH/PI/26/NNNNNN`.
 *
 * Row-for-row from the reference card in
 * `docs/bills/legphel-document-formats-complete-30 (1).html` (lines 213–236).
 *
 * Two things in the reference are deliberate and reproduced exactly:
 *   - The title strip is the LOUD (crimson) variant carrying the statutory disclaimer
 *     "This is not a tax invoice — a tax invoice will be issued on supply". The quotation and
 *     voucher use the muted strip; this one must not.
 *   - The Net / Service / GST decomposition is a SINGLE `.dl` row whose key holds all three
 *     figures and whose value is empty — not three separate rows as on the quotation.
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
  type DocumentWatermark,
} from "./legphel-document-shell.js";

export type LegphelProformaInput = {
  masthead: DocumentMasthead;
  /** "LH/PI/26/000231" */
  proformaNo: string;
  /** "LH/26/E/04236" — crimson. */
  bookingRef: string;
  /** "28 Jul 2026" */
  date: string;
  /** "05 Aug 2026" — bold key, crimson value. Omitted when no advance is due. */
  advanceDueBy?: string | null;
  /** "Bhutan Online Booking Travel" — the billed party. */
  to: string;
  /** "Dr Lakshmi Menon" — the reference's "For guest" line. */
  forGuest?: string | null;
  /**
   * Stay label + its value. The reference shows a split stay
   * ("Split stay" / "08–09 Sep · Re 12–13 Sep 2026 · 2 nights"), so the label is a parameter
   * rather than hardcoded "Stay".
   */
  stayLabel: string;
  stay: string;
  /** "Deluxe · 3 adults · MAP · per night" → "3,450.00" */
  rateLabel: string;
  rateValue: string;
  /** "Total (incl. service & GST)" value. */
  totalInclusive: string;
  /** The one-line decomposition, e.g. "Net 5,974.03 · Service 597.40 · GST 328.57". */
  decompositionNet: string;
  decompositionService: string;
  decompositionGst: string;
  /** The ruled total row — what must be paid now. */
  advanceDueNow: string;
  /**
   * Optional qualifier appended to the "Advance due now" key, e.g. "(30% of quote)" when the
   * desk pinned the requirement as a percentage (2026-08-01). Null = plain key.
   */
  advanceDueQualifier?: string | null;
  /** "Full amount at once" / "Part now — remainder by 12 Aug 2026" — the guest's payment plan
   *  (2026-08-08). Omitted when no plan is recorded. */
  advancePlanLabel?: string | null;
  /** Optional "Advance received" row — shown when the guest has already paid something in. */
  advanceReceived?: string | null;
  /** "(2 payments)" appended to the Advance-received key once installments are in. */
  advanceReceivedQualifier?: string | null;
  balanceAtCheckout: string;
  currencyLabel?: string;
  bank: { bankName: string | null; accountName: string | null; accountsPhone: string | null };
  /** Cancellation ladder + surcharge statement. */
  closingNote: string;
  tariffVersion: string;
  issuanceRef?: string | null;
  watermark?: DocumentWatermark;
};

export function renderLegphelProformaHtml(input: LegphelProformaInput): string {
  const currency = input.currencyLabel ?? "Nu.";

  const bankPairs: Array<{ label: string; value: string }> = [];
  if (input.bank.bankName) bankPairs.push({ label: "Bank", value: input.bank.bankName });
  if (input.bank.accountName) bankPairs.push({ label: "A/C", value: input.bank.accountName });
  bankPairs.push({ label: "Ref", value: input.proformaNo });
  if (input.bank.accountsPhone) bankPairs.push({ label: "Accounts", value: input.bank.accountsPhone });

  const body = [
    renderMasthead(input.masthead),
    // LOUD strip — this is the statutory "not a tax invoice" notice, not a muted hint.
    renderTitle("Proforma Invoice", "This is not a tax invoice — a tax invoice will be issued on supply", false),
    row("Proforma No", input.proformaNo, { boldValue: true }),
    row("Booking Ref", input.bookingRef, { redValue: true }),
    row("Date", input.date),
    input.advanceDueBy ? row("Advance due by", input.advanceDueBy, { boldKey: true, redValue: true }) : "",
    section,
    row("To", input.to, { boldValue: true }),
    input.forGuest ? row("For guest", input.forGuest) : "",
    section,
    row(input.stayLabel, input.stay),
    row(input.rateLabel, input.rateValue),
    section,
    row(`Total (incl. service & GST)`, input.totalInclusive),
    // Single row, empty value — matches the reference exactly.
    row(
      `Net ${htmlEscape(input.decompositionNet)} · Service ${htmlEscape(
        input.decompositionService,
      )} · GST <i style="font-style:normal;color:var(--mute)">(expected)</i> ${htmlEscape(input.decompositionGst)}`,
      "",
      { rawKey: true },
    ),
    input.advancePlanLabel ? row("Payment plan", input.advancePlanLabel) : "",
    input.advanceReceived
      ? row(
          `Advance received${input.advanceReceivedQualifier ? ` ${input.advanceReceivedQualifier}` : ""}`,
          input.advanceReceived,
        )
      : "",
    row(
      `Advance due now${input.advanceDueQualifier ? ` ${input.advanceDueQualifier}` : ""} · ${currency}`,
      input.advanceDueNow,
      { total: true },
    ),
    row("Balance at checkout", input.balanceAtCheckout),
    bankStrip(bankPairs),
    note(input.closingNote, "quiet"),
    footer([input.proformaNo, input.bookingRef, input.issuanceRef ?? null, "E&OE", input.tariffVersion]),
  ]
    .filter(Boolean)
    .join("\n");

  return renderDocumentPage({
    documentTitle: `Proforma Invoice ${input.proformaNo}`,
    family: "commercial",
    watermark: input.watermark ?? null,
    body,
  });
}
