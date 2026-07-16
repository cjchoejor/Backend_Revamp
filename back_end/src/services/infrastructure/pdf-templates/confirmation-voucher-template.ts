/**
 * CONFIRMATION VOUCHER template — matches `images/Reservation_Confirmation_for email.pdf`.
 *
 * Layout notes (compare to reference):
 *   1. LEGPHEL HOTEL logo + name header + red hairline.
 *   2. "CONFIRMATION VOUCHER" title (centred, underlined).
 *   3. To / From / Confirmation by lines.
 *   4. Two-column panel:
 *        left  — In/Out (Check-In, Check-Out, Re Check-In, Re Check-Out (deferred: see
 *                pdf-bill-generation-todo.md #1), Number of Nights, Guest Name, Confirmation/
 *                Booking Number)
 *        right — Hotel Information (Phone, Check-In time, Check-Out time)
 *   5. BOOKING DETAILS table (Date | Room No. | Occupants | Meal Plan | Extra Beds).
 *   6. "Please Note" strip (numbered items).
 *   7. OUR AMENITIES — 6 items with inline SVG icons in a two-column grid.
 *   8. HOTEL POLICIES — 4 coloured cards (Cancellation red · Extra Guest green · Pet blue ·
 *      Child Age purple).
 *   9. Reservation and Front Office block (address + contact).
 *  10. "WALK THE EXTRA MILE!" footer.
 *
 * Re Check-In / Re Check-Out: currently rendered as blank rows. Design conversation held over
 * to a follow-up (see docs/pdf-bill-generation-todo.md "Discuss later #1"). When the
 * double-entry / multi-entry model is finalised, populate `reCheckIn` and `reCheckOut`.
 */
import {
  formatDate,
  htmlEscape,
  type HotelProfileForRender,
} from "../../../lib/pdf-render-context.js";

export type ConfirmationVoucherLine = {
  date: Date;
  roomNo: string;
  occupants: string;
  mealPlan: string;
  extraBeds: string;
};

export type ConfirmationVoucherTemplateInput = {
  hotel: HotelProfileForRender;
  hotelPhone: string;
  guestName: string;
  fromName: string;
  confirmationByName: string; // Travel agent name, or "Walk-In"
  bookingReference: string;
  checkIn: Date;
  checkOut: Date;
  reCheckIn: Date | null; // deferred — see "Discuss later #1"
  reCheckOut: Date | null;
  numberOfNights: number;
  guestNameOnBookingRow: string; // Contact person's name (see boss's clarification)
  hotelCheckInTime: string; // e.g. "02:00 PM"
  hotelCheckOutTime: string; // e.g. "12:00 PM"
  bookingRows: ConfirmationVoucherLine[];
  cancellationPolicyText: string;
  extraGuestPolicyText: string;
  petPolicyText: string;
  childAgePolicyText: string;
  addressLine1: string; // e.g. "3 kilo, Phuentsholing"
  addressLine2: string; // e.g. "Bhutan"
  phoneLine: string; // e.g. "(+975) 17772393 / (+975) 77772393"
};

/** Lucide-style inline SVG icons — small, monochrome, embedded so no external fetch. */
const ICONS = {
  wifi: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2c4c8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`,
  car: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0a7a5a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1L2 11v5h3"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>`,
  cutlery: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b03a2e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h1v11h2V2M13 2v11c0 2 2 3 4 3v6h2V2"/></svg>`,
  desk: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2c4c8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  laundry: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4a7c2a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="13" r="4"/></svg>`,
  presentation: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b03a2e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="12" rx="1"/><line x1="12" y1="15" x2="12" y2="21"/><polyline points="8 21 12 17 16 21"/></svg>`,
};

export function renderConfirmationVoucherHtml(input: ConfirmationVoucherTemplateInput): string {
  const {
    hotel,
    hotelPhone,
    guestName,
    fromName,
    confirmationByName,
    bookingReference,
    checkIn,
    checkOut,
    reCheckIn,
    reCheckOut,
    numberOfNights,
    guestNameOnBookingRow,
    hotelCheckInTime,
    hotelCheckOutTime,
    bookingRows,
    cancellationPolicyText,
    extraGuestPolicyText,
    petPolicyText,
    childAgePolicyText,
    addressLine1,
    addressLine2,
    phoneLine,
  } = input;

  const logoHtml = hotel.logoDataUri
    ? `<img src="${hotel.logoDataUri}" alt="Legphel Hotel" style="width:80px;height:auto;" />`
    : "";

  const bookingRowsHtml = bookingRows
    .map(
      (b) => `
    <tr>
      <td>${htmlEscape(formatDate(b.date))}</td>
      <td>${htmlEscape(b.roomNo)}</td>
      <td>${htmlEscape(b.occupants)}</td>
      <td>${htmlEscape(b.mealPlan)}</td>
      <td>${htmlEscape(b.extraBeds)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>CONFIRMATION VOUCHER · ${htmlEscape(bookingReference)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; font-size: 10.5pt; background: #fff; }
  .page { padding: 4mm 6mm; }
  .header { text-align: center; padding-bottom: 4px; }
  .header h1 { font-size: 20pt; font-weight: 800; margin: 4px 0 4px; letter-spacing: 0.5px; }
  .hairline { border-top: 1.4px solid #b32d2d; margin-top: 2px; }
  .doc-title { text-align: center; font-weight: 700; font-size: 11.5pt; margin: 12px 0 6px; letter-spacing: 0.5px; }
  .doc-title-underline { display: inline-block; border-bottom: 1px solid #333; padding-bottom: 2px; }
  .to-from { padding: 4px 6px; font-size: 10.5pt; }
  .to-from .row { margin: 3px 0; }
  .to-from .k { font-weight: 700; display: inline-block; min-width: 100px; }
  .panel { display: flex; gap: 12px; margin: 10px 0; }
  .panel .col { flex: 1; border: 1px solid #dfe3ea; border-radius: 6px; padding: 12px 14px; background: #fbfcfd; }
  .panel .col h3 { margin: 0 0 6px; font-size: 10.5pt; font-weight: 700; }
  .panel .row { margin: 4px 0; font-size: 10.5pt; }
  .panel .row .k { color: #444; }
  .panel .row .v { font-weight: 700; margin-left: 4px; }
  .booking-title { font-weight: 700; margin: 12px 4px 6px; font-size: 10.5pt; }
  table.booking { width: 100%; border-collapse: collapse; border: 1px solid #c9d0d9; border-radius: 4px; overflow: hidden; }
  table.booking th, table.booking td { padding: 8px 8px; border-right: 1px solid #d9dde3; border-bottom: 1px solid #eaedf2; text-align: center; font-size: 10pt; }
  table.booking th:last-child, table.booking td:last-child { border-right: none; }
  table.booking th { background: #fff; font-weight: 700; border-bottom: 1px solid #c9d0d9; }
  .please-note { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; margin: 10px 0; font-size: 10pt; }
  .amenities { border: 1px solid #dfe3ea; border-radius: 6px; padding: 12px 14px; margin: 10px 0; }
  .amenities h3 { margin: 0 0 8px; font-size: 10.5pt; font-weight: 700; }
  .amenities .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px; font-size: 10pt; }
  .amenities .item { display: flex; align-items: center; gap: 8px; }
  .policies h3 { margin: 12px 4px 4px; font-size: 11pt; font-weight: 700; }
  .policy { padding: 10px 14px; border-radius: 6px; margin: 6px 0; font-size: 10pt; }
  .policy.cancel { background: #fdf2f2; border: 1px solid #fbc9c9; }
  .policy.cancel .title { color: #b03a2e; font-weight: 700; margin-bottom: 4px; }
  .policy.guest { background: #f0fbf4; border: 1px solid #c5eecd; }
  .policy.guest .title { color: #0a7a5a; font-weight: 700; margin-bottom: 4px; }
  .policy.pet { background: #f2f7fd; border: 1px solid #cddfef; }
  .policy.pet .title { color: #1a4e8f; font-weight: 700; margin-bottom: 4px; }
  .policy.child { background: #f7f2fd; border: 1px solid #ddc9f0; }
  .policy.child .title { color: #7b3aa2; font-weight: 700; margin-bottom: 4px; }
  .front-office { border-top: 1px solid #dfe3ea; margin-top: 14px; padding-top: 10px; font-size: 10pt; }
  .front-office .title { color: #1a4e8f; font-weight: 700; margin-bottom: 4px; }
  .footer { text-align: center; margin-top: 14px; color: #2c4c8f; font-weight: 700; font-size: 11pt; letter-spacing: 1px; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>${logoHtml}</div>
    <h1>${htmlEscape(hotel.hotelName)}</h1>
    <div class="hairline"></div>
  </div>

  <div class="doc-title"><span class="doc-title-underline">CONFIRMATION VOUCHER</span></div>

  <div class="to-from">
    <div class="row"><span class="k">To :</span> <strong>${htmlEscape(guestName)}</strong></div>
    <div class="row"><span class="k">From :</span> <strong>${htmlEscape(fromName)}</strong></div>
    <div class="row"><span class="k">Confirmation by :</span> <strong>${htmlEscape(confirmationByName)}</strong></div>
  </div>

  <div class="panel">
    <div class="col">
      <h3>In/Out</h3>
      <div class="row"><span class="k">Check-In :</span><span class="v">${htmlEscape(formatDate(checkIn))}</span> &nbsp; <span class="k">Check-Out :</span><span class="v">${htmlEscape(formatDate(checkOut))}</span></div>
      <div class="row"><span class="k">Re Check-In :</span><span class="v">${reCheckIn ? htmlEscape(formatDate(reCheckIn)) : "—"}</span> &nbsp; <span class="k">Re Check-Out :</span><span class="v">${reCheckOut ? htmlEscape(formatDate(reCheckOut)) : "—"}</span></div>
      <div class="row"><span class="k">Number of Nights :</span><span class="v">${numberOfNights}</span></div>
      <div class="row"><span class="k">Guest Name :</span><span class="v">${htmlEscape(guestNameOnBookingRow)}</span></div>
      <div class="row"><span class="k">Confirmation/ Booking Number :</span><span class="v">${htmlEscape(bookingReference)}</span></div>
    </div>
    <div class="col">
      <h3>Hotel Information</h3>
      <div class="row"><span class="k">Hotel Phone :</span><span class="v">${htmlEscape(hotelPhone)}</span></div>
      <div class="row"><span class="k">Check-In :</span><span class="v">${htmlEscape(hotelCheckInTime)}</span></div>
      <div class="row"><span class="k">Check-Out :</span><span class="v">${htmlEscape(hotelCheckOutTime)}</span></div>
    </div>
  </div>

  <div class="booking-title">BOOKING DETAILS :</div>
  <table class="booking">
    <thead>
      <tr>
        <th>Date</th>
        <th>Room No.</th>
        <th>Occupants</th>
        <th>Meal Plan</th>
        <th>Extra Beds</th>
      </tr>
    </thead>
    <tbody>${bookingRowsHtml}</tbody>
  </table>

  <div class="please-note">
    <div>Please Note:</div>
    <div>1. You must present this confirmation voucher together with photo id (Aadhaar card/Voter Card/ Citizenship id card/Passport id) to the hotel receptionist upon check-in.</div>
    <div>2. If you have any questions regarding your booking, or you require to amend the booking, you can contact us through email or phone.</div>
  </div>

  <div class="amenities">
    <h3>OUR AMENITIES :</h3>
    <div class="grid">
      <div class="item">${ICONS.wifi}<span>Free Wifi</span></div>
      <div class="item">${ICONS.car}<span>Ample Complimentary on-site Parking Space</span></div>
      <div class="item">${ICONS.cutlery}<span>Spacious Restaurant Delight</span></div>
      <div class="item">${ICONS.desk}<span>24-hour Front Desk Service</span></div>
      <div class="item">${ICONS.laundry}<span>Full-Service Laundry</span></div>
      <div class="item">${ICONS.presentation}<span>Spacious Conference Room</span></div>
    </div>
  </div>

  <div class="policies">
    <h3>HOTEL POLICIES</h3>
    <div class="policy cancel">
      <div class="title">Cancellation Policy :</div>
      <div>${htmlEscape(cancellationPolicyText)}</div>
    </div>
    <div class="policy guest">
      <div class="title">Extra Guest policy :</div>
      <div>${htmlEscape(extraGuestPolicyText)}</div>
    </div>
    <div class="policy pet">
      <div class="title">Pet Policy :</div>
      <div>${htmlEscape(petPolicyText)}</div>
    </div>
    <div class="policy child">
      <div class="title">Child Age policy :</div>
      <div>${htmlEscape(childAgePolicyText).replace(/\n/g, "<br/>")}</div>
    </div>
  </div>

  <div class="front-office">
    <div class="title">Reservation and Front Office</div>
    <div>${htmlEscape(hotel.hotelName)}</div>
    <div>${htmlEscape(addressLine1)}</div>
    <div>${htmlEscape(addressLine2)}</div>
    <div>Phone: ${htmlEscape(phoneLine)}</div>
    <div>Email: ${htmlEscape(hotel.primaryEmail)}</div>
  </div>

  <div class="footer">WALK THE EXTRA MILE!</div>
</div>
</body>
</html>`;
}
