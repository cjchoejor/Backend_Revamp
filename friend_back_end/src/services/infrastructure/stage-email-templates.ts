/**
 * Email renderers for the S1..S9 lifecycle. One render function per outbound message.
 *
 * Each render function takes plain data (no DB types) and returns `{ subject, text, html }`.
 * Callers in the stage services resolve the data from entry/reservation/folio rows then invoke
 * `dispatchStageEmailBestEffort` from stage-email-helpers.
 *
 * Phase 3 ships hardcoded layouts. Phase 4 may switch to the CommunicationTemplate registry so
 * marketing can edit copy without a deploy — same render signatures, just the body source changes.
 */

import { escapeHtml, formatDate, formatMoney, htmlShell, type StageEmailContent } from "./stage-email-helpers.js";
import type { StayChargeBreakdown } from "./compute-stay-charges.js";

/**
 * Every email for one guest journey uses an identical subject so Gmail's personal-account
 * threading clusters them (subject is Gmail's dominant signal — In-Reply-To/References alone
 * are not enough on personal accounts). The email-service then prepends `[INQ-XXXX]` per the
 * caller's `threadReadableId`, so the full subject is e.g. `[INQ-XXX] Your Legphel Hotel booking`
 * — identical for every message in the journey. The body's first heading tells the guest which
 * kind of email this is.
 */
const COMMON_SUBJECT = "Your Legphel Hotel booking";

function emailHeading(text: string): string {
  return `<h2 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#222">${escapeHtml(text)}</h2>`;
}

// =============================================================================
// Helpers shared across templates
// =============================================================================

function nightsBetween(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(1, Math.round(ms / 86400_000));
}

function tableRow(label: string, value: string, bg = false, strong = false): string {
  const bgStyle = bg ? "background:#fafafa;" : "";
  const v = strong ? `<strong>${escapeHtml(value)}</strong>` : escapeHtml(value);
  return `<tr style="${bgStyle}"><td style="padding:6px 8px;color:#666;width:140px">${escapeHtml(label)}</td><td style="padding:6px 8px">${v}</td></tr>`;
}

function detailsTable(rows: string[]): string {
  return `<table style="border-collapse:collapse;width:100%;margin:18px 0;font-size:14px"><tbody>${rows.join("")}</tbody></table>`;
}

/** Format a decimal rate as a percentage label, e.g. 0.10 -> "10%". */
function percentLabel(rate: number): string {
  return `${(rate * 100).toFixed(rate * 100 % 1 === 0 ? 0 : 2)}%`;
}

/** Generate the four breakdown rows shared by Quotation / PI / Confirmation / Final-invoice templates. */
function breakdownRows(b: StayChargeBreakdown, currency: string): string[] {
  return [
    tableRow("Sub-total (room)", formatMoney(b.subTotal, currency)),
    tableRow(`Service charge (${percentLabel(b.serviceChargeRate)})`, formatMoney(b.serviceCharge, currency), true),
    tableRow(`GST (${percentLabel(b.gstRate)})`, formatMoney(b.gst, currency)),
    tableRow("Total", formatMoney(b.total, currency), true, true),
  ];
}

/** Plain-text equivalent of the breakdown for the text/plain part of the email. */
function breakdownLines(b: StayChargeBreakdown, currency: string): string[] {
  return [
    `Sub-total (room):       ${formatMoney(b.subTotal, currency)}`,
    `Service charge (${percentLabel(b.serviceChargeRate)}):  ${formatMoney(b.serviceCharge, currency)}`,
    `GST (${percentLabel(b.gstRate)}):              ${formatMoney(b.gst, currency)}`,
    `Total:                  ${formatMoney(b.total, currency)}`,
  ];
}

// =============================================================================
// S2 — Quotation
// =============================================================================

export type QuotationEmailData = {
  guestDisplayName: string;
  inquiryReadableId: string;
  quotationRef: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestCount: number;
  nightlyRate: number;
  currency: string;
  breakdown: StayChargeBreakdown;
  validUntil: Date;
  ratePlanName?: string | null;
};

export function renderQuotationEmail(d: QuotationEmailData): StageEmailContent {
  const nights = nightsBetween(d.checkInDate, d.checkOutDate);
  const guests = d.guestCount === 1 ? "1 guest" : `${d.guestCount} guests`;
  const subject = COMMON_SUBJECT;

  const text = [
    `Quotation`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    "Thank you for considering Legphel Hotel. Please find your quotation below.",
    "",
    `Quotation: ${d.quotationRef}`,
    `Check-in: ${formatDate(d.checkInDate)}`,
    `Check-out: ${formatDate(d.checkOutDate)}`,
    `Stay: ${nights} ${nights === 1 ? "night" : "nights"} · ${guests}`,
    d.ratePlanName ? `Rate plan: ${d.ratePlanName}` : null,
    `Nightly rate: ${formatMoney(d.nightlyRate, d.currency)}`,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    "",
    `This quotation is valid until ${formatDate(d.validUntil)}.`,
    "",
    "To confirm or ask any questions, just reply to this email and our front desk will assist.",
    "",
    "— The Legphel Hotel team",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = htmlShell(`
${emailHeading("Quotation")}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>Thank you for considering Legphel Hotel. Please find your quotation below.</p>
${detailsTable([
  tableRow("Quotation", d.quotationRef),
  tableRow("Check-in", formatDate(d.checkInDate), true),
  tableRow("Check-out", formatDate(d.checkOutDate)),
  tableRow("Stay", `${nights} ${nights === 1 ? "night" : "nights"} · ${guests}`, true),
  d.ratePlanName ? tableRow("Rate plan", d.ratePlanName) : "",
  tableRow("Nightly rate", formatMoney(d.nightlyRate, d.currency), !d.ratePlanName),
  ...breakdownRows(d.breakdown, d.currency),
])}
<p style="font-size:13px;color:#555">This quotation is valid until <strong>${escapeHtml(formatDate(d.validUntil))}</strong>.</p>
<p>To confirm or ask any questions, just reply to this email and our front desk will assist.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S3 — Proforma invoice
// =============================================================================

export type ProformaInvoiceEmailData = {
  guestDisplayName: string;
  invoiceRef: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestCount: number;
  currency: string;
  breakdown: StayChargeBreakdown;
  amountPaid?: number | null;
};

export function renderProformaInvoiceEmail(d: ProformaInvoiceEmailData): StageEmailContent {
  const due = Math.max(0, d.breakdown.total - (d.amountPaid ?? 0));
  const subject = COMMON_SUBJECT;

  const text = [
    `Proforma invoice`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    "Please find your proforma invoice for the upcoming stay.",
    "",
    `Invoice: ${d.invoiceRef}`,
    `Check-in: ${formatDate(d.checkInDate)}`,
    `Check-out: ${formatDate(d.checkOutDate)}`,
    `Guests: ${d.guestCount}`,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    d.amountPaid != null ? `Already received:       ${formatMoney(d.amountPaid, d.currency)}` : null,
    `Balance due:            ${formatMoney(due, d.currency)}`,
    "",
    "Settling this in advance helps us secure your room. Reply to this email if you need bank details or have any questions.",
    "",
    "— The Legphel Hotel team",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = htmlShell(`
${emailHeading("Proforma invoice")}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>Please find your proforma invoice for the upcoming stay.</p>
${detailsTable([
  tableRow("Invoice", d.invoiceRef),
  tableRow("Check-in", formatDate(d.checkInDate), true),
  tableRow("Check-out", formatDate(d.checkOutDate)),
  tableRow("Guests", String(d.guestCount), true),
  ...breakdownRows(d.breakdown, d.currency),
  d.amountPaid != null ? tableRow("Already received", formatMoney(d.amountPaid, d.currency)) : "",
  tableRow("Balance due", formatMoney(due, d.currency), true, true),
])}
<p>Settling this in advance helps us secure your room. Reply to this email if you need bank details or have any questions.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S4 — Reservation confirmation
// =============================================================================

export type ReservationConfirmationEmailData = {
  guestDisplayName: string;
  reservationReadableId: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestCount: number;
  nightlyRate: number;
  currency: string;
  breakdown: StayChargeBreakdown;
  ratePlanName?: string | null;
  roomTypeName?: string | null;
  /** Group-specific fields — only used when isGroup === true. */
  isGroup?: boolean;
  roomCount?: number;
  billingModel?: string | null;
  groupLeaderName?: string | null;
};

export function renderReservationConfirmationEmail(d: ReservationConfirmationEmailData): StageEmailContent {
  const nights = nightsBetween(d.checkInDate, d.checkOutDate);
  const guests = d.guestCount === 1 ? "1 guest" : `${d.guestCount} guests`;
  const subject = COMMON_SUBJECT;

  // Group booking confirmation reads differently — the recipient is likely a tour operator
  // or corporate contact rather than the guest, and the important facts are room count,
  // billing arrangement, and who the group leader is. Fall back to the standard template
  // when isGroup is not set.
  const greetingName = d.isGroup && d.groupLeaderName ? d.groupLeaderName : d.guestDisplayName;
  const openingLine = d.isGroup
    ? "Thank you for choosing Legphel Hotel for your group booking. All rooms are confirmed."
    : "Thank you for choosing Legphel Hotel. Your reservation is confirmed.";
  const groupLines = d.isGroup
    ? [
        `Group booking · ${d.roomCount ?? "?"} room${(d.roomCount ?? 0) === 1 ? "" : "s"}`,
        d.billingModel ? `Billing: ${d.billingModel} (charges roll up to one folio)` : null,
        d.groupLeaderName ? `Group leader: ${d.groupLeaderName}` : null,
      ]
    : [];

  const text = [
    d.isGroup ? `Group reservation confirmed` : `Reservation confirmed`,
    "",
    `Dear ${greetingName},`,
    "",
    openingLine,
    "",
    `Reservation: ${d.reservationReadableId}`,
    ...groupLines,
    `Check-in: ${formatDate(d.checkInDate)}`,
    `Check-out: ${formatDate(d.checkOutDate)}`,
    `Stay: ${nights} ${nights === 1 ? "night" : "nights"} · ${guests}`,
    d.roomTypeName ? `Room type: ${d.roomTypeName}` : null,
    d.ratePlanName ? `Rate plan: ${d.ratePlanName}` : null,
    `Nightly rate: ${formatMoney(d.nightlyRate, d.currency)}`,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    "",
    "If anything needs to change, just reply to this email and our front desk will take care of it.",
    "",
    "We look forward to welcoming you.",
    "",
    "— The Legphel Hotel team",
  ]
    .filter((l) => l !== null)
    .join("\n");

  // HTML body mirrors `images/email_template.png` — reservation-team header, reservation-details
  // card, cancellation / extra-guest / pet / child-age policy cards (colour-coded), footer with
  // hotel contact. The voucher PDF is separately attached to the email so guests can archive
  // the formal document; this HTML body is the human-readable summary.
  const total = formatMoney(d.breakdown.total, d.currency);
  const nightsLabel = `${nights} ${nights === 1 ? "night" : "nights"}`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:640px;margin:0 auto;background:#fff;">
  <!-- Reservation team header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;padding:20px 24px;border-bottom:1px solid #eee;">
    <tr>
      <td style="vertical-align:middle;">
        <div style="font-size:20px;font-weight:800;color:#b32d2d;">LEGPHEL</div>
        <div style="font-size:9px;letter-spacing:2px;color:#666;">H O T E L</div>
      </td>
      <td style="text-align:right;vertical-align:middle;font-size:11px;color:#555;line-height:1.55;">
        <div style="font-weight:700;color:#222;">RESERVATION TEAM</div>
        <div>(+975) 17772393</div>
        <div>(+975) 77772393</div>
        <div><a href="mailto:legphel.hotel@gmail.com" style="color:#b32d2d;text-decoration:none;">legphel.hotel@gmail.com</a></div>
      </td>
    </tr>
  </table>
  <div style="height:6px;background:linear-gradient(90deg,#b32d2d,#7a1a1a);"></div>

  <div style="padding:24px 28px;">
    <h1 style="font-size:22px;margin:8px 0 12px;font-weight:700;">Reservation Confirmation</h1>
    <p style="margin:6px 0;">Dear ${escapeHtml(greetingName)},</p>
    <p style="margin:6px 0 22px;">${escapeHtml(openingLine)} Your reservation is confirmed.</p>

    <!-- Reservation details card -->
    <div style="border:1px solid #dfe3ea;border-radius:8px;padding:16px 18px;margin:12px 0;">
      <div style="font-weight:700;background:#f2f7fd;padding:6px 10px;margin:-16px -18px 12px;border-radius:8px 8px 0 0;color:#1a4e8f;font-size:13px;">📋 Reservation Details</div>
      <div style="font-size:13px;line-height:1.7;">
        <div><strong>Reservation ID:</strong> ${escapeHtml(d.reservationReadableId)}</div>
        <div><strong>Primary Guest:</strong> ${escapeHtml(d.guestDisplayName)}</div>
        <div><strong>Check In:</strong> ${escapeHtml(formatDate(d.checkInDate))}</div>
        <div><strong>Check out:</strong> ${escapeHtml(formatDate(d.checkOutDate))}</div>
        <div><strong>Rooms:</strong> ${d.roomCount ?? 1}</div>
        <div><strong>Stay:</strong> ${escapeHtml(nightsLabel)} · ${escapeHtml(guests)}</div>
        <div><strong>Total Payable Amount:</strong> ${escapeHtml(total)}</div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px dashed #e2e5ec;font-size:12px;color:#555;">
        📎 Kindly find the attachment below for detailed reservation information.
      </div>
    </div>

    <!-- Cancellation policy (red) -->
    <div style="border:1px solid #fbc9c9;background:#fdf2f2;border-radius:8px;padding:14px 16px;margin:12px 0;font-size:12.5px;line-height:1.55;">
      <div style="font-weight:700;color:#b03a2e;margin-bottom:6px;">⚠️ Cancellation Policy</div>
      <div>• 100% refund if cancelled 45 days or more before scheduled date.</div>
      <div>• 50% refund if cancelled between 30 and 44 days before scheduled date.</div>
      <div>• No refund for cancellations less than 30 days before scheduled date.</div>
    </div>

    <!-- Extra guest policy (green) -->
    <div style="border:1px solid #c5eecd;background:#f0fbf4;border-radius:8px;padding:14px 16px;margin:12px 0;font-size:12.5px;line-height:1.55;">
      <div style="font-weight:700;color:#0a7a5a;margin-bottom:6px;">👥 Extra Guest Policy</div>
      <div>• Double occupancy basis per room, max 3 guests.</div>
      <div>• Guests over 12 require an extra bed (additional charge).</div>
      <div>• Applies to Deluxe, Executive, and Suite Rooms.</div>
    </div>

    <!-- Pet policy (blue) -->
    <div style="border:1px solid #cddfef;background:#f2f7fd;border-radius:8px;padding:14px 16px;margin:12px 0;font-size:12.5px;line-height:1.55;">
      <div style="font-weight:700;color:#1a4e8f;margin-bottom:6px;">🐾 Pet Policy</div>
      <div>No pets are allowed.</div>
    </div>

    <!-- Child age policy (purple) -->
    <div style="border:1px solid #ddc9f0;background:#f7f2fd;border-radius:8px;padding:14px 16px;margin:12px 0;font-size:12.5px;line-height:1.55;">
      <div style="font-weight:700;color:#7b3aa2;margin-bottom:6px;">👶 Child Age Policy</div>
      <div>• Below 6 years: Complimentary accommodation and food.</div>
      <div>• 6–10 years: Charged for meals only; accommodation complimentary if sharing with guardians.</div>
      <div>• 11+ years: Considered adults (separate bed + adult charges for food and accommodation).</div>
    </div>

    <div style="text-align:center;margin-top:24px;font-size:12.5px;color:#555;">
      We look forward to welcoming you.<br/>
      <strong style="color:#222;">Legphel Hotel</strong><br/>
      Phuentsholing, Bhutan<br/>
      (+975) 17772393 · <a href="mailto:legphel.hotel@gmail.com" style="color:#b32d2d;text-decoration:none;">legphel.hotel@gmail.com</a>
    </div>
  </div>

  <div style="background:#b32d2d;color:#fff;text-align:center;padding:10px;font-size:12px;font-weight:600;letter-spacing:0.5px;">
    Sewa Land Sue! · Contact our reservation team.
  </div>
</div>
</body>
</html>`;

  return { subject, text, html };
}

// =============================================================================
// S5 — Pre-arrival reminder
// =============================================================================

export type PreArrivalEmailData = {
  guestDisplayName: string;
  reservationReadableId: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestCount: number;
};

export function renderPreArrivalEmail(d: PreArrivalEmailData): StageEmailContent {
  const guests = d.guestCount === 1 ? "1 guest" : `${d.guestCount} guests`;
  const subject = COMMON_SUBJECT;

  const text = [
    `Pre-arrival reminder`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    `This is a friendly reminder that your stay with us begins on ${formatDate(d.checkInDate)}.`,
    "",
    `Reservation: ${d.reservationReadableId}`,
    `Check-in: ${formatDate(d.checkInDate)}`,
    `Check-out: ${formatDate(d.checkOutDate)}`,
    `Booked for: ${guests}`,
    "",
    "Our standard check-in time is 2:00 PM. If you'd like to arrange an early arrival, request a particular room, or let us know about any special needs, simply reply to this email.",
    "",
    "Safe travels — we'll see you soon.",
    "",
    "— The Legphel Hotel team",
  ].join("\n");

  const html = htmlShell(`
${emailHeading("Pre-arrival reminder")}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>This is a friendly reminder that your stay with us begins on <strong>${escapeHtml(formatDate(d.checkInDate))}</strong>.</p>
${detailsTable([
  tableRow("Reservation", d.reservationReadableId),
  tableRow("Check-in", formatDate(d.checkInDate), true),
  tableRow("Check-out", formatDate(d.checkOutDate)),
  tableRow("Booked for", guests, true),
])}
<p>Our standard check-in time is 2:00 PM. If you'd like to arrange an early arrival, request a particular room, or let us know about any special needs, simply reply to this email.</p>
<p>Safe travels &mdash; we'll see you soon.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S8 / S9 — Final invoice (post-checkout)
// =============================================================================

export type FinalInvoiceEmailData = {
  guestDisplayName: string;
  invoiceRef: string;
  checkInDate: Date;
  checkOutDate: Date;
  currency: string;
  breakdown: StayChargeBreakdown;
  amountPaid?: number | null;
};

export function renderFinalInvoiceEmail(d: FinalInvoiceEmailData): StageEmailContent {
  const balance = d.breakdown.total - (d.amountPaid ?? 0);
  const isSettled = balance <= 0;
  const subject = COMMON_SUBJECT;
  const headingText = isSettled ? "Thank you — final invoice" : "Final invoice";

  const text = [
    headingText,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    `Thank you for staying at Legphel Hotel from ${formatDate(d.checkInDate)} to ${formatDate(d.checkOutDate)}. Please find your final invoice below.`,
    "",
    `Invoice: ${d.invoiceRef}`,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    d.amountPaid != null ? `Received:               ${formatMoney(d.amountPaid, d.currency)}` : null,
    `Balance:                ${formatMoney(balance, d.currency)}`,
    "",
    isSettled
      ? "Your folio is fully settled. We hope you enjoyed your stay and look forward to welcoming you back."
      : "Kindly settle the outstanding balance at your earliest convenience. Reply to this email if you need our bank details.",
    "",
    "— The Legphel Hotel team",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = htmlShell(`
${emailHeading(headingText)}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>Thank you for staying at Legphel Hotel from <strong>${escapeHtml(formatDate(d.checkInDate))}</strong> to <strong>${escapeHtml(formatDate(d.checkOutDate))}</strong>. Please find your final invoice below.</p>
${detailsTable([
  tableRow("Invoice", d.invoiceRef),
  ...breakdownRows(d.breakdown, d.currency),
  d.amountPaid != null ? tableRow("Received", formatMoney(d.amountPaid, d.currency)) : "",
  tableRow("Balance", formatMoney(balance, d.currency), true, true),
])}
<p>${
    isSettled
      ? "Your folio is fully settled. We hope you enjoyed your stay and look forward to welcoming you back."
      : "Kindly settle the outstanding balance at your earliest convenience. Reply to this email if you need our bank details."
  }</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S9 — Feedback solicitation
// =============================================================================

export type FeedbackSolicitationEmailData = {
  guestDisplayName: string;
  checkInDate: Date;
  checkOutDate: Date;
};

export function renderFeedbackSolicitationEmail(d: FeedbackSolicitationEmailData): StageEmailContent {
  const subject = COMMON_SUBJECT;

  const text = [
    `How was your stay?`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    `We hope you enjoyed your recent stay with us from ${formatDate(d.checkInDate)} to ${formatDate(d.checkOutDate)}.`,
    "",
    "Your honest feedback helps us improve, and it only takes a minute. Just reply to this email with a few words about what we did well and where we can do better.",
    "",
    "Thank you for choosing Legphel Hotel — we hope to welcome you back soon.",
    "",
    "— The Legphel Hotel team",
  ].join("\n");

  const html = htmlShell(`
${emailHeading("How was your stay?")}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>We hope you enjoyed your recent stay with us from <strong>${escapeHtml(formatDate(d.checkInDate))}</strong> to <strong>${escapeHtml(formatDate(d.checkOutDate))}</strong>.</p>
<p>Your honest feedback helps us improve, and it only takes a minute. Just reply to this email with a few words about what we did well and where we can do better.</p>
<p>Thank you for choosing Legphel Hotel &mdash; we hope to welcome you back soon.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}
