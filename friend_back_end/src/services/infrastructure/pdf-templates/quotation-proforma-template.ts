/**
 * Single template used by both S2 Quotation and S3 Proforma Invoice.
 *
 * The two documents share EXACTLY the same layout (per the reference PDFs); only the
 * document title swaps between "QUOTATION" and "PROFORMA INVOICE". Both render:
 *   - LEGPHEL HOTEL header with logo + red hairline
 *   - Document title centred, underlined
 *   - To / From block (left) + Invoice No / Date block (right)
 *   - In/Out summary panel (Check-In, Check-Out, Number of Nights, Primary Guest)
 *   - BOOKING DETAILS table (Date | Occupants | Meal Plan | Extra Beds | Amount (Nu.))
 *     - Quotation may render an empty body if `lines` is empty
 *     - Proforma always renders at least one row
 *   - Right-aligned totals block (Total Amount / Advance / FOC / Total Payable)
 *   - Italic "Legphel Hotel" footer
 *
 * Rows carry a TAX-INCLUSIVE amount (per boss's confirmation for the quotation flow).
 */
import { formatDate, formatMoney, htmlEscape, type HotelProfileForRender } from "../../../lib/pdf-render-context.js";

export type QuotationProformaLine = {
  date: Date;
  occupants: string;
  mealPlan: string | null;
  extraBeds: string | null;
  amount: string | number;
};

export type QuotationProformaTemplateInput = {
  documentTitle: "QUOTATION" | "PROFORMA INVOICE";
  hotel: HotelProfileForRender;
  /** Guest / agent recipient. */
  toEmail: string;
  fromName: string;
  invoiceNumber: string;
  documentDate: Date;
  checkIn: Date;
  checkOut: Date;
  numberOfNights: number;
  primaryGuestName: string;
  lines: QuotationProformaLine[];
  totalAmount: string | number;
  advanceAmount: string | number;
  focAmount: string | number;
  totalPayable: string | number;
  currency: string; // "Nu." — kept as a param so a future USD rate card can override
};

export function renderQuotationProformaHtml(input: QuotationProformaTemplateInput): string {
  const {
    documentTitle,
    hotel,
    toEmail,
    fromName,
    invoiceNumber,
    documentDate,
    checkIn,
    checkOut,
    numberOfNights,
    primaryGuestName,
    lines,
    totalAmount,
    advanceAmount,
    focAmount,
    totalPayable,
  } = input;

  const logoHtml = hotel.logoDataUri
    ? `<img src="${hotel.logoDataUri}" alt="Legphel Hotel" style="width:90px;height:auto;" />`
    : "";

  const linesHtml = lines
    .map(
      (l, i) => `
    <tr class="data-row">
      <td>${htmlEscape(formatDate(l.date))}</td>
      <td>${htmlEscape(l.occupants)}</td>
      <td>${htmlEscape(l.mealPlan ?? "None")}</td>
      <td>${htmlEscape(l.extraBeds ?? "None")}</td>
      <td class="num">${htmlEscape(formatMoney(l.amount))}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${htmlEscape(documentTitle)} · ${htmlEscape(invoiceNumber)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 11pt; background: #f7f8fa; }
  .page { padding: 4mm 6mm; }
  .header { text-align: center; padding-bottom: 6px; }
  .header .logo { display: inline-block; }
  .header h1 { font-size: 22pt; font-weight: 800; margin: 6px 0 4px; letter-spacing: 0.5px; }
  .hairline { border-top: 1.5px solid #b32d2d; margin-top: 2px; }
  .doc-title { text-align: center; font-weight: 700; font-size: 12pt; margin: 14px 0 6px; letter-spacing: 0.5px; }
  .doc-title-underline { display: inline-block; border-bottom: 1px solid #333; padding-bottom: 2px; }
  .to-from { display: flex; justify-content: space-between; align-items: flex-start; margin: 12px 0 6px; padding: 0 6px; }
  .to-from .kv { display: flex; gap: 8px; font-size: 10.5pt; }
  .to-from .kv .k { font-weight: 700; min-width: 62px; }
  .to-from .right { text-align: left; }
  .panel { background: #fff; border: 1px solid #e2e5ec; border-radius: 6px; padding: 12px 14px; margin: 8px 0; }
  .panel h3 { margin: 0 0 6px; font-size: 10.5pt; font-weight: 700; }
  .panel .row { font-size: 10.5pt; margin: 3px 0; }
  .panel .row .k { font-weight: 400; margin-right: 6px; }
  .panel .row .v { font-weight: 700; }
  .booking-title { font-weight: 700; margin: 12px 4px 6px; font-size: 10.5pt; letter-spacing: 0.5px; }
  table.booking { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #c9d0d9; border-radius: 4px; overflow: hidden; }
  table.booking th, table.booking td { padding: 8px 10px; border-right: 1px solid #d9dde3; text-align: center; font-size: 10.5pt; }
  table.booking th:last-child, table.booking td:last-child { border-right: none; }
  table.booking th { background: #fff; font-weight: 700; border-bottom: 1px solid #c9d0d9; }
  table.booking td.num { text-align: center; }
  .totals { margin-top: 16px; padding-right: 12px; }
  .totals .row { display: flex; justify-content: flex-end; gap: 12px; font-size: 10.5pt; margin: 4px 0; }
  .totals .row .k { min-width: 160px; text-align: right; }
  .totals .row .v { min-width: 90px; text-align: left; font-weight: 700; }
  .footer { text-align: right; margin-top: 60px; padding-right: 6px; font-style: italic; font-size: 10.5pt; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">${logoHtml}</div>
    <h1>${htmlEscape(hotel.hotelName)}</h1>
    <div class="hairline"></div>
  </div>

  <div class="doc-title"><span class="doc-title-underline">${htmlEscape(documentTitle)}</span></div>

  <div class="to-from">
    <div>
      <div class="kv"><span class="k">To :</span><span class="v">${htmlEscape(toEmail)}</span></div>
      <div class="kv" style="margin-top: 4px;"><span class="k">From :</span><span class="v">${htmlEscape(fromName)}</span></div>
    </div>
    <div class="right">
      <div class="kv"><span class="k">INVOICE NO :</span><span class="v">${htmlEscape(invoiceNumber)}</span></div>
      <div class="kv" style="margin-top: 4px;"><span class="k">DATE :</span><span class="v">${htmlEscape(formatDate(documentDate))}</span></div>
    </div>
  </div>

  <div class="panel">
    <h3>In/Out</h3>
    <div class="row"><span class="k">Check-In :</span><span class="v">${htmlEscape(formatDate(checkIn))}</span> &nbsp;&nbsp; <span class="k">Check-Out :</span><span class="v">${htmlEscape(formatDate(checkOut))}</span></div>
    <div class="row"><span class="k">Number of Nights :</span><span class="v">${numberOfNights || ""}</span></div>
    <div class="row"><span class="k">Primary Guest :</span><span class="v">${htmlEscape(primaryGuestName)}</span></div>
  </div>

  <div class="booking-title">BOOKING DETAILS :</div>
  <table class="booking">
    <thead>
      <tr>
        <th>Date</th>
        <th>Occupants</th>
        <th>Meal Plan</th>
        <th>Extra Beds</th>
        <th>Amount (Nu.)</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span class="k">Total Amount (Nu.) :</span><span class="v">${htmlEscape(formatMoney(totalAmount))}</span></div>
    <div class="row"><span class="k">Advance (Nu.) :</span><span class="v">${htmlEscape(formatMoney(advanceAmount))}</span></div>
    <div class="row"><span class="k">FOC (Nu.) :</span><span class="v">${htmlEscape(formatMoney(focAmount))}</span></div>
    <div class="row"><span class="k">Total Payable (Nu.) :</span><span class="v">${htmlEscape(formatMoney(totalPayable))}</span></div>
  </div>

  <div class="footer">${htmlEscape(hotel.hotelName)}</div>
</div>
</body>
</html>`;
}
