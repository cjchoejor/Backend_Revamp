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
};

export function renderReservationConfirmationEmail(d: ReservationConfirmationEmailData): StageEmailContent {
  const nights = nightsBetween(d.checkInDate, d.checkOutDate);
  const guests = d.guestCount === 1 ? "1 guest" : `${d.guestCount} guests`;
  const subject = COMMON_SUBJECT;

  const text = [
    `Reservation confirmed`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    "Thank you for choosing Legphel Hotel. Your reservation is confirmed.",
    "",
    `Reservation: ${d.reservationReadableId}`,
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

  const html = htmlShell(`
${emailHeading("Reservation confirmed")}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>Thank you for choosing Legphel Hotel. Your reservation is confirmed.</p>
${detailsTable([
  tableRow("Reservation", d.reservationReadableId),
  tableRow("Check-in", formatDate(d.checkInDate), true),
  tableRow("Check-out", formatDate(d.checkOutDate)),
  tableRow("Stay", `${nights} ${nights === 1 ? "night" : "nights"} · ${guests}`, true),
  d.roomTypeName ? tableRow("Room type", d.roomTypeName) : "",
  d.ratePlanName ? tableRow("Rate plan", d.ratePlanName, true) : "",
  tableRow("Nightly rate", formatMoney(d.nightlyRate, d.currency)),
  ...breakdownRows(d.breakdown, d.currency),
])}
<p>If anything needs to change, just reply to this email and our front desk will take care of it.</p>
<p>We look forward to welcoming you.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

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
