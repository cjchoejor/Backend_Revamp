/**
 * ROOM INVOICE template — matches `images/Commercial invoice.pdf`.
 *
 * Layout notes (compare to reference):
 *   1. Centred logo + hotel address block (5 lines: place / phone+email / Account No /
 *      TPN NO. & GST TPN NO.).
 *   2. "ROOM INVOICE" in blue, centred, with an underline.
 *   3. Date top-right.
 *   4. Two columns: left = Invoice No, Travel Agent, Guest Name, Contact No, Email.
 *      right = Total No. of Guest(s), Check In, Check Out.
 *   5. Table: PARTICULAR | ROOM NO. | NIGHT(S) | RATE (NU.) | AMOUNT (NU.).
 *      Room lines only — no F&B, no ancillary services.
 *   6. Right-aligned totals: Subtotal / Discount % / Service Charge 10% / G.S.T 5% / Total /
 *      Advance / FoC / **Total Payable** (in blue, bold).
 *   7. Signature block: "Guide / Guest Signature" left, "For Legphel Hotel / Prepared by:"
 *      right.
 *   8. "Thank you for choosing Legphel Hotel" tagline.
 *   9. QR intentionally omitted per boss's instruction.
 */
import {
  formatDate,
  formatMoney,
  htmlEscape,
  type HotelProfileForRender,
} from "../../../lib/pdf-render-context.js";

export type RoomInvoiceLine = {
  particular: string;
  roomNo: string;
  nights: number;
  rate: number | string;
  amount: number | string;
};

export type RoomInvoiceTemplateInput = {
  hotel: HotelProfileForRender;
  hotelPhone: string;
  invoiceNumber: string;
  documentDate: Date;
  travelAgentName: string;
  guestName: string;
  contactNo: string;
  guestEmail: string;
  totalGuestsAdult: number;
  totalGuestsChildren: number;
  checkIn: Date;
  checkOut: Date;
  lines: RoomInvoiceLine[];
  subtotal: number | string;
  discountAmount: number | string;
  discountRatePercent: number;
  serviceChargeRatePercent: number;
  serviceChargeAmount: number | string;
  gstRatePercent: number;
  gstAmount: number | string;
  totalBeforeAdvance: number | string;
  advanceAmount: number | string;
  focAmount: number | string;
  totalPayable: number | string;
  preparedByName: string;
};

export function renderRoomInvoiceHtml(input: RoomInvoiceTemplateInput): string {
  const {
    hotel,
    hotelPhone,
    invoiceNumber,
    documentDate,
    travelAgentName,
    guestName,
    contactNo,
    guestEmail,
    totalGuestsAdult,
    totalGuestsChildren,
    checkIn,
    checkOut,
    lines,
    subtotal,
    discountAmount,
    discountRatePercent,
    serviceChargeRatePercent,
    serviceChargeAmount,
    gstRatePercent,
    gstAmount,
    totalBeforeAdvance,
    advanceAmount,
    focAmount,
    totalPayable,
    preparedByName,
  } = input;

  const logoHtml = hotel.logoDataUri
    ? `<img src="${hotel.logoDataUri}" alt="Legphel Hotel" style="width:70px;height:auto;" />`
    : "";

  const linesHtml = lines
    .map(
      (l) => `
    <tr class="data-row">
      <td class="left-pad">${htmlEscape(l.particular)}</td>
      <td>${htmlEscape(l.roomNo)}</td>
      <td>${l.nights}</td>
      <td class="num">${htmlEscape(formatMoney(l.rate))}</td>
      <td class="num right-pad">${htmlEscape(formatMoney(l.amount))}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>ROOM INVOICE · ${htmlEscape(invoiceNumber)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: "Times New Roman", Georgia, serif; color: #222; font-size: 11pt; background: #fff; }
  .page { padding: 6mm 8mm; }
  .header { text-align: center; }
  .header .logo { display: inline-block; margin-bottom: 4px; }
  .hotel-address { text-align: center; font-size: 10.5pt; line-height: 1.4; margin-top: 4px; }
  .hotel-address .line { margin: 1px 0; }
  .divider { border-top: 1px solid #cfd3d9; margin: 14px 0 8px; }
  .doc-title { text-align: center; font-weight: 700; font-size: 13pt; color: #2c4c8f; margin: 8px 0 4px; letter-spacing: 0.5px; }
  .date-line { text-align: right; padding-right: 8px; font-size: 10.5pt; margin-top: 4px; }
  .two-col { display: flex; justify-content: space-between; margin-top: 10px; padding: 0 4px; }
  .two-col .col { font-size: 10.5pt; }
  .two-col .kv { margin: 4px 0; display: flex; gap: 10px; }
  .two-col .kv .k { font-weight: 400; }
  .two-col .kv .v { font-weight: 700; padding: 1px 6px; border: 1px solid #d5d9e0; border-radius: 2px; background: #fbfbfd; }
  .two-col .kv.plain .v { border: none; background: transparent; padding: 0; }
  table.bill { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 10.5pt; }
  table.bill thead th { border-bottom: 1.2px solid #666; padding: 8px 8px; font-weight: 700; letter-spacing: 0.3px; }
  table.bill tbody td { padding: 8px 8px; border-bottom: 1px solid #eee; text-align: center; }
  table.bill tbody td.left-pad { text-align: center; }
  table.bill tbody td.num { text-align: center; }
  .totals { margin-top: 12px; display: flex; justify-content: flex-end; }
  .totals table { border-collapse: collapse; font-size: 10.5pt; min-width: 340px; }
  .totals table td { padding: 4px 12px; }
  .totals table td.k { text-align: right; color: #333; }
  .totals table td.v { text-align: right; font-weight: 700; min-width: 100px; }
  .totals .sep { border-top: 1px solid #d5d9e0; }
  .grand td.k { font-weight: 700; }
  .grand td.v { color: #2c4c8f; font-weight: 700; font-size: 12pt; }
  .signatures { display: flex; justify-content: space-between; margin-top: 90px; padding: 0 8px; font-size: 10.5pt; }
  .signatures .left { text-align: left; }
  .signatures .right { text-align: right; }
  .thanks { text-align: center; margin-top: 24px; font-size: 10.5pt; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">${logoHtml}</div>
    <div class="hotel-address">
      <div class="line">${htmlEscape(hotel.registeredAddress)}</div>
      <div class="line">${htmlEscape(hotelPhone)}${hotelPhone && hotel.primaryEmail ? ", " : ""}${htmlEscape(hotel.primaryEmail)}</div>
      ${hotel.accountNumber ? `<div class="line">Account No. : ${htmlEscape(hotel.accountNumber)}</div>` : ""}
      ${hotel.tpnNumber || hotel.gstTpnNumber ? `<div class="line">TPN NO. : ${htmlEscape(hotel.tpnNumber ?? "")} &amp; GST TPN NO. : ${htmlEscape(hotel.gstTpnNumber ?? "")}</div>` : ""}
    </div>
  </div>

  <div class="divider"></div>

  <div class="doc-title">ROOM INVOICE</div>
  <div class="date-line">Date : <strong>${htmlEscape(formatDate(documentDate))}</strong></div>

  <div class="two-col">
    <div class="col">
      <div class="kv plain"><span class="k">Invoice No. :</span><span class="v">${htmlEscape(invoiceNumber)}</span></div>
      <div class="kv"><span class="k">Travel Agent:</span><span class="v">${htmlEscape(travelAgentName)}</span></div>
      <div class="kv"><span class="k">Guest Name:</span><span class="v">${htmlEscape(guestName)}</span></div>
      <div class="kv plain"><span class="k">Contact No.:</span><span class="v">${htmlEscape(contactNo)}</span></div>
      <div class="kv plain"><span class="k">Email Address:</span><span class="v">${htmlEscape(guestEmail)}</span></div>
    </div>
    <div class="col" style="text-align: left;">
      <div class="kv plain"><span class="k">Total No. of Guest(s):</span><span class="v">${totalGuestsAdult} (${totalGuestsAdult}A) (${totalGuestsChildren}C)</span></div>
      <div class="kv plain"><span class="k">Check In :</span><span class="v">${htmlEscape(formatDate(checkIn))}</span> &nbsp; Check Out: <span class="v">${htmlEscape(formatDate(checkOut))}</span></div>
    </div>
  </div>

  <table class="bill">
    <thead>
      <tr>
        <th>PARTICULAR</th>
        <th>ROOM NO.</th>
        <th>NIGHT(S)</th>
        <th>RATE (NU.)</th>
        <th>AMOUNT (NU.)</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml}
    </tbody>
  </table>

  <div class="totals">
    <table>
      <tr><td class="k">Subtotal</td><td class="v">${htmlEscape(formatMoney(subtotal))}</td></tr>
      <tr><td class="k">Discount ${discountRatePercent}%</td><td class="v">${htmlEscape(formatMoney(discountAmount))}</td></tr>
      <tr><td class="k">Service Charge ${serviceChargeRatePercent}%</td><td class="v">${htmlEscape(formatMoney(serviceChargeAmount))}</td></tr>
      <tr><td class="k">G.S.T ${gstRatePercent}%</td><td class="v">${htmlEscape(formatMoney(gstAmount))}</td></tr>
      <tr class="sep"><td class="k">Total</td><td class="v">${htmlEscape(formatMoney(totalBeforeAdvance))}</td></tr>
      <tr><td class="k">Advance</td><td class="v">${htmlEscape(formatMoney(advanceAmount))}</td></tr>
      <tr><td class="k">FoC</td><td class="v">${htmlEscape(formatMoney(focAmount))}</td></tr>
      <tr class="sep grand"><td class="k">Total Payable</td><td class="v">${htmlEscape(formatMoney(totalPayable))}/-</td></tr>
    </table>
  </div>

  <div class="signatures">
    <div class="left"><em>Guide / Guest Signature</em></div>
    <div class="right">
      <div><em>For ${htmlEscape(hotel.hotelName)}</em></div>
      <div style="margin-top: 6px;">Prepared by: <em>${htmlEscape(preparedByName)}</em></div>
    </div>
  </div>

  <div class="thanks">Thank you for choosing ${htmlEscape(hotel.hotelName)}. We hope to host you again.</div>
</div>
</body>
</html>`;
}
