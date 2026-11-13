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

import { escapeHtml, formatDate, formatMoment, formatMoney, htmlShell, type StageEmailContent } from "./stage-email-helpers.js";
import type { StayChargeBreakdown } from "./compute-stay-charges.js";
import { emailContactFrom, logoImg, phoneOnEmail, type HotelEmailContact } from "./hotel-email-identity.js";

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

/**
 * A trip's stays, each with its own dates and nights (2026-11-13, operator: "night count should be
 * stay wise count and then combined stay nights"). The trip's emails took the first stay's check-in
 * and the last stay's check-out and called it one stay: "13 Nov to 1 Dec, 18 nights" for two stays
 * of 5 nights each.
 */
export type EmailStay = { label: string; checkIn: Date; checkOut: Date };

function tripStays(stays: readonly EmailStay[] | null | undefined): { rows: Array<{ label: string; value: string }>; nights: number } | null {
  if (!stays || stays.length < 2) return null;
  const rows = stays.map((st) => ({
    label: st.label,
    value: `Check-in ${formatDate(st.checkIn)} · Check-out ${formatDate(st.checkOut)} · ${nightsOf(nightsBetween(st.checkIn, st.checkOut))}`,
  }));
  return { rows, nights: stays.reduce((t, st) => t + nightsBetween(st.checkIn, st.checkOut), 0) };
}

function nightsOf(n: number): string {
  return `${n} ${n === 1 ? "night" : "nights"}`;
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
    tableRow("Net value", formatMoney(b.subTotal, currency)),
    tableRow(`Service charge (${percentLabel(b.serviceChargeRate)})`, formatMoney(b.serviceCharge, currency), true),
    tableRow(`GST (${percentLabel(b.gstRate)})`, formatMoney(b.gst, currency)),
    tableRow("Total", formatMoney(b.total, currency), true, true),
  ];
}

/** Plain-text equivalent of the breakdown for the text/plain part of the email. */
function breakdownLines(b: StayChargeBreakdown, currency: string): string[] {
  return [
    `Net value:              ${formatMoney(b.subTotal, currency)}`,
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
  /** Null when the rooms have rates of their own, so no one figure is the stay's rate. */
  nightlyRate: number | null;
  currency: string;
  breakdown: StayChargeBreakdown;
  validUntil: Date;
  ratePlanName?: string | null;
  /** A trip's stays, each with its own nights (2026-11-13); two or more replace the one check-in and check-out. */
  stays?: EmailStay[] | null;
};

export function renderQuotationEmail(d: QuotationEmailData): StageEmailContent {
  const trip = tripStays(d.stays);
  const nights = trip ? trip.nights : nightsBetween(d.checkInDate, d.checkOutDate);
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
    ...(trip
      ? [...trip.rows.map((r) => `${r.label}: ${r.value}`), `In all: ${nightsOf(nights)} · ${guests}`]
      : [`Check-in: ${formatDate(d.checkInDate)}`, `Check-out: ${formatDate(d.checkOutDate)}`, `Stay: ${nightsOf(nights)} · ${guests}`]),
    d.ratePlanName ? `Rate plan: ${d.ratePlanName}` : null,
    d.nightlyRate != null ? `Nightly rate: ${formatMoney(d.nightlyRate, d.currency)}` : null,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    "",
    `This quotation is valid until ${formatMoment(d.validUntil)}.`,
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
  ...(trip
    ? [...trip.rows.map((r, i) => tableRow(r.label, r.value, i % 2 === 0)), tableRow("In all", `${nightsOf(nights)} · ${guests}`, trip.rows.length % 2 === 0, true)]
    : [
        tableRow("Check-in", formatDate(d.checkInDate), true),
        tableRow("Check-out", formatDate(d.checkOutDate)),
        tableRow("Stay", `${nightsOf(nights)} · ${guests}`, true),
      ]),
  d.ratePlanName ? tableRow("Rate plan", d.ratePlanName) : "",
  d.nightlyRate != null ? tableRow("Nightly rate", formatMoney(d.nightlyRate, d.currency), !d.ratePlanName) : "",
  ...breakdownRows(d.breakdown, d.currency),
])}
<p style="font-size:13px;color:#555">This quotation is valid until <strong>${escapeHtml(formatMoment(d.validUntil))}</strong>.</p>
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
  /** The paper's own rows (2026-11-05, `proformaEmailFigures`). */
  advanceReceived: number;
  /** How many payments it arrived in — ">1" shows the installment count. */
  paymentCount: number;
  /** Whether an advance is asked of this guest. False: the email asks for none. */
  advanceAsked: boolean;
  advanceDueNow: number;
  /** "(50% of quote)", or null. */
  advanceDueQualifier: string | null;
  balanceAtCheckout: number;
  /** Advance-window deadline (= check-in date). Null when the entry has no real check-in date —
   *  the caller must NOT pass a today-fallback, or the email demands payment by a made-up date. */
  advanceDueBy?: Date | null;
  /** How long this proforma stands (2026-11-05): what the paper prints. */
  validUntil?: Date | null;
  /** The guest's recorded payment plan, already worded ("Part now — remainder by 12 Aug 2026").
   *  Null = no plan recorded, no line printed. */
  paymentPlan?: string | null;
  /** A trip's stays, each with its own nights (2026-11-13). */
  stays?: EmailStay[] | null;
};

export function renderProformaInvoiceEmail(d: ProformaInvoiceEmailData): StageEmailContent {
  const trip = tripStays(d.stays);
  const owing = d.advanceAsked && d.advanceDueNow > 0;
  const showDueBy = owing && d.advanceDueBy != null;
  const dueLabel = `Advance due now${d.advanceDueQualifier ? ` ${d.advanceDueQualifier}` : ""}`;
  const closing = owing
    ? "Settling this in advance helps us secure your room. Reply to this email if you need bank details or have any questions."
    : d.advanceAsked
      ? "The advance is received; the balance is settled at check-out. Reply to this email if you have any questions."
      : `${d.advanceReceived > 0 ? "No further advance is asked" : "No advance is asked"} for this booking; the balance is settled at check-out. Reply to this email if you have any questions.`;
  const paidLabel = `Already received${d.paymentCount > 1 ? ` (${d.paymentCount} payments)` : ""}`;
  const subject = COMMON_SUBJECT;

  const text = [
    `Proforma invoice`,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    "Please find your proforma invoice for the upcoming stay.",
    "",
    `Invoice: ${d.invoiceRef}`,
    ...(trip
      ? [...trip.rows.map((r) => `${r.label}: ${r.value}`), `In all: ${nightsOf(trip.nights)}`]
      : [`Check-in: ${formatDate(d.checkInDate)}`, `Check-out: ${formatDate(d.checkOutDate)}`]),
    `Guests: ${d.guestCount}`,
    "",
    ...breakdownLines(d.breakdown, d.currency),
    d.paymentPlan ? `Payment plan:           ${d.paymentPlan}` : null,
    d.advanceReceived > 0 ? `${paidLabel}:  ${formatMoney(d.advanceReceived, d.currency)}` : null,
    d.advanceAsked ? `${dueLabel}:  ${formatMoney(d.advanceDueNow, d.currency)}` : null,
    `Balance at check-out:   ${formatMoney(d.balanceAtCheckout, d.currency)}`,
    "",
    showDueBy ? `The advance is due by ${formatDate(d.advanceDueBy!)} — your check-in date.` : null,
    showDueBy ? "" : null,
    d.validUntil ? `This proforma is valid until ${formatMoment(d.validUntil)}.` : null,
    d.validUntil ? "" : null,
    closing,
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
  ...(trip
    ? [...trip.rows.map((r, i) => tableRow(r.label, r.value, i % 2 === 0)), tableRow("In all", nightsOf(trip.nights), trip.rows.length % 2 === 0, true)]
    : [tableRow("Check-in", formatDate(d.checkInDate), true), tableRow("Check-out", formatDate(d.checkOutDate))]),
  tableRow("Guests", String(d.guestCount), true),
  ...breakdownRows(d.breakdown, d.currency),
  d.paymentPlan ? tableRow("Payment plan", d.paymentPlan, false, true) : "",
  d.advanceReceived > 0 ? tableRow(paidLabel, formatMoney(d.advanceReceived, d.currency)) : "",
  d.advanceAsked ? tableRow(dueLabel, formatMoney(d.advanceDueNow, d.currency), true, true) : "",
  tableRow("Balance at check-out", formatMoney(d.balanceAtCheckout, d.currency), true, !d.advanceAsked),
])}
${showDueBy ? `<p style="font-size:13px;color:#555">The advance is due by <strong>${escapeHtml(formatDate(d.advanceDueBy!))}</strong> &mdash; your check-in date.</p>` : ""}
${d.validUntil ? `<p style="font-size:13px;color:#555">This proforma is valid until <strong>${escapeHtml(formatMoment(d.validUntil))}</strong>.</p>` : ""}
<p>${escapeHtml(closing)}</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S7 — Interim invoice (2026-08-21): long-stay part payment / stay-extension payment
// =============================================================================

export type InterimInvoiceEmailData = {
  guestDisplayName: string;
  invoiceRef: string;
  kind: "LONG_STAY" | "EXTENSION";
  checkInDate: Date;
  /** The projected checkout — the NEW date on an extension. */
  checkOutDate: Date;
  currency: string;
  nightsSlept: number;
  nightsToCome: number;
  /** Projected total of the whole stay (room nights slept + to come + other charges so far). */
  projectedTotal: number;
  otherChargesSoFar: number;
  receivedSoFar: number;
  /** "50% of the projected total" / "Nu 20,000.00" — how the ask was expressed. */
  askLabel: string;
  dueNow: number;
  balanceAtCheckout: number;
  /** When the extension's nights are released if unpaid (extension kind only). */
  holdExpiresAt?: Date | null;
  /** When the payment is expected (2026-08-22). */
  dueBy?: Date | null;
  /** The guest's promise, already worded ("by 25 Aug 2026 — “…”" / "at the desk"). */
  paymentPromise?: string | null;
};

export function renderInterimInvoiceEmail(d: InterimInvoiceEmailData): StageEmailContent {
  const subject = COMMON_SUBJECT;
  const heading = d.kind === "EXTENSION" ? "Interim invoice — stay extension" : "Interim invoice";
  const intro =
    d.kind === "EXTENSION"
      ? `Thank you for extending your stay with us to ${formatDate(d.checkOutDate)}. Please find the interim invoice for the extension below — the extra nights are reserved for you once this payment is received.`
      : `Thank you for staying with us. As your stay continues, please find an interim invoice for the nights so far and the nights to come.`;

  const text = [
    heading,
    "",
    `Dear ${d.guestDisplayName},`,
    "",
    intro,
    "",
    `Invoice: ${d.invoiceRef}`,
    `Check-in: ${formatDate(d.checkInDate)}`,
    `Check-out: ${formatDate(d.checkOutDate)}`,
    `Nights: ${d.nightsSlept} slept · ${d.nightsToCome} to come`,
    "",
    `Projected total for the stay: ${formatMoney(d.projectedTotal, d.currency)}`,
    d.otherChargesSoFar > 0 ? `  (includes other charges so far: ${formatMoney(d.otherChargesSoFar, d.currency)})` : null,
    `Already received:             ${formatMoney(d.receivedSoFar, d.currency)}`,
    `Asked now (${d.askLabel}):    ${formatMoney(d.dueNow, d.currency)}`,
    `Balance at checkout:          ${formatMoney(d.balanceAtCheckout, d.currency)}`,
    "",
    d.paymentPromise ? `Payment promised ${d.paymentPromise}.` : null,
    d.paymentPromise ? "" : null,
    d.dueBy ? `Please settle this by ${formatMoment(d.dueBy)}.` : null,
    d.dueBy ? "" : null,
    d.holdExpiresAt ? `The extra nights are held for you until ${formatMoment(d.holdExpiresAt)}.` : null,
    d.holdExpiresAt ? "" : null,
    "Reply to this email if you need bank details or have any questions.",
    "",
    "— The Legphel Hotel team",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const html = htmlShell(`
${emailHeading(heading)}
<p>Dear ${escapeHtml(d.guestDisplayName)},</p>
<p>${escapeHtml(intro)}</p>
${detailsTable([
  tableRow("Invoice", d.invoiceRef),
  tableRow("Check-in", formatDate(d.checkInDate), true),
  tableRow("Check-out", formatDate(d.checkOutDate)),
  tableRow("Nights", `${d.nightsSlept} slept · ${d.nightsToCome} to come`, true),
  tableRow("Projected total for the stay", formatMoney(d.projectedTotal, d.currency)),
  d.otherChargesSoFar > 0 ? tableRow("— includes other charges so far", formatMoney(d.otherChargesSoFar, d.currency), true) : "",
  tableRow("Already received", formatMoney(d.receivedSoFar, d.currency)),
  tableRow(`Asked now (${d.askLabel})`, formatMoney(d.dueNow, d.currency), true, true),
  tableRow("Balance at checkout", formatMoney(d.balanceAtCheckout, d.currency)),
  d.dueBy ? tableRow("Payment due by", formatMoment(d.dueBy), true) : "",
  d.paymentPromise ? tableRow("Payment promised", d.paymentPromise, true) : "",
])}
${d.dueBy ? `<p style="font-size:13px;color:#555">Please settle this by <strong>${escapeHtml(formatMoment(d.dueBy))}</strong>.</p>` : ""}
${d.holdExpiresAt ? `<p style="font-size:13px;color:#555">The extra nights are held for you until <strong>${escapeHtml(formatMoment(d.holdExpiresAt))}</strong>.</p>` : ""}
<p>Reply to this email if you need bank details or have any questions.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);

  return { subject, text, html };
}

// =============================================================================
// S4 — Reservation confirmation
// =============================================================================

/** No figures, like the voucher it carries (2026-11-09, operator): the price is the quotation's and the proforma's. */
export type ReservationConfirmationEmailData = {
  guestDisplayName: string;
  reservationReadableId: string;
  checkInDate: Date;
  checkOutDate: Date;
  guestCount: number;
  ratePlanName?: string | null;
  roomTypeName?: string | null;
  /** Group-specific fields — only used when isGroup === true. */
  isGroup?: boolean;
  roomCount?: number;
  billingModel?: string | null;
  groupLeaderName?: string | null;
  /** The booking's own cancellation policy in sentences (lib/cancellation-policy.ts, 2026-11-10). */
  cancellationPolicy: string[];
  /** The hotel's name, town, numbers and email (hotel-email-identity.ts); the reservation team's when left out. */
  contact?: HotelEmailContact;
  /** A trip's stays, each with its own nights (2026-11-13). */
  stays?: EmailStay[] | null;
};

export function renderReservationConfirmationEmail(d: ReservationConfirmationEmailData): StageEmailContent {
  const contact = d.contact ?? emailContactFrom(null);
  const phones = contact.phones.map(phoneOnEmail);
  const trip = tripStays(d.stays);
  const nights = trip ? trip.nights : nightsBetween(d.checkInDate, d.checkOutDate);
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
    ...(trip
      ? [...trip.rows.map((r) => `${r.label}: ${r.value}`), `In all: ${nightsOf(nights)} · ${guests}`]
      : [`Check-in: ${formatDate(d.checkInDate)}`, `Check-out: ${formatDate(d.checkOutDate)}`, `Stay: ${nightsOf(nights)} · ${guests}`]),
    d.roomTypeName ? `Room type: ${d.roomTypeName}` : null,
    d.ratePlanName ? `Rate plan: ${d.ratePlanName}` : null,
    "",
    "Cancellation:",
    ...d.cancellationPolicy.map((line) => `- ${line}`),
    "",
    "If anything needs to change, just reply to this email and our front desk will take care of it.",
    "",
    "We look forward to welcoming you.",
    "",
    "— The Legphel Hotel team",
    [contact.name, contact.place].filter(Boolean).join(" · "),
    phones.length ? `Reservation team: ${phones.join(" · ")}` : null,
    contact.email,
  ]
    .filter((l) => l !== null)
    .join("\n");

  // HTML body mirrors `images/email_template.png` — reservation-team header, reservation-details
  // card, cancellation / extra-guest / pet / child-age policy cards (colour-coded), footer with
  // hotel contact. The voucher PDF is separately attached to the email so guests can archive
  // the formal document; this HTML body is the human-readable summary.
  const nightsLabel = `${nights} ${nights === 1 ? "night" : "nights"}`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:640px;margin:0 auto;background:#fff;">
  <!-- Reservation team header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff;padding:20px 24px;border-bottom:1px solid #eee;">
    <tr>
      <td style="vertical-align:middle;">
        ${logoImg(56)}
      </td>
      <td style="text-align:right;vertical-align:middle;font-size:11px;color:#555;line-height:1.55;">
        <div style="font-weight:700;color:#222;">RESERVATION TEAM</div>
        ${phones.map((ph) => `<div>${escapeHtml(ph)}</div>`).join("\n        ")}
        <div><a href="mailto:${escapeHtml(contact.email)}" style="color:#b32d2d;text-decoration:none;">${escapeHtml(contact.email)}</a></div>
      </td>
    </tr>
  </table>
  <div style="height:6px;background:linear-gradient(90deg,#b32d2d,#7a1a1a);"></div>

  <div style="padding:24px 28px;">
    <h1 style="font-size:22px;margin:8px 0 12px;font-weight:700;">Reservation Confirmation</h1>
    <p style="margin:6px 0;">Dear ${escapeHtml(greetingName)},</p>
    <p style="margin:6px 0 22px;">${escapeHtml(openingLine)}</p>

    <!-- Reservation details card -->
    <div style="border:1px solid #dfe3ea;border-radius:8px;padding:16px 18px;margin:12px 0;">
      <div style="font-weight:700;background:#f2f7fd;padding:6px 10px;margin:-16px -18px 12px;border-radius:8px 8px 0 0;color:#1a4e8f;font-size:13px;">📋 Reservation Details</div>
      <div style="font-size:13px;line-height:1.7;">
        <div><strong>Reservation ID:</strong> ${escapeHtml(d.reservationReadableId)}</div>
        <div><strong>Primary Guest:</strong> ${escapeHtml(d.guestDisplayName)}</div>
        ${
          trip
            ? trip.rows.map((r) => `<div><strong>${escapeHtml(r.label)}:</strong> ${escapeHtml(r.value)}</div>`).join("")
            : `<div><strong>Check In:</strong> ${escapeHtml(formatDate(d.checkInDate))}</div>
        <div><strong>Check out:</strong> ${escapeHtml(formatDate(d.checkOutDate))}</div>
        <div><strong>Rooms:</strong> ${d.roomCount ?? 1}</div>`
        }
        <div><strong>${trip ? "In all" : "Stay"}:</strong> ${escapeHtml(nightsLabel)} · ${escapeHtml(guests)}</div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px dashed #e2e5ec;font-size:12px;color:#555;">
        📎 Kindly find the attachment below for detailed reservation information.
      </div>
    </div>

    <!-- Cancellation policy (red) -->
    <div style="border:1px solid #fbc9c9;background:#fdf2f2;border-radius:8px;padding:14px 16px;margin:12px 0;font-size:12.5px;line-height:1.55;">
      <div style="font-weight:700;color:#b03a2e;margin-bottom:6px;">⚠️ Cancellation Policy</div>
      ${d.cancellationPolicy.map((line) => `<div>• ${escapeHtml(line)}</div>`).join("")}
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
      <strong style="color:#222;">${escapeHtml(contact.name)}</strong><br/>
      ${contact.place ? `${escapeHtml(contact.place)}<br/>` : ""}
      ${phones[0] ? `${escapeHtml(phones[0])} · ` : ""}<a href="mailto:${escapeHtml(contact.email)}" style="color:#b32d2d;text-decoration:none;">${escapeHtml(contact.email)}</a>
    </div>
  </div>

  <div style="background:#b32d2d;color:#fff;text-align:center;padding:10px;font-size:12px;font-weight:600;letter-spacing:0.5px;">
    Sewa Land Sue! · Contact our reservation team.
  </div>
</div>
</body>
</html>`;

  // Its own header and footer carry the hotel's name and numbers: no second signature under them.
  return { subject, text, html, signature: false };
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
// S5 — Recorded as a no-show (2026-09-18)
// =============================================================================

export type NoShowNoticeEmailData = {
  recipientName: string;
  /** The traveller, named when the notice goes to the agency or company that booked. */
  guestName: string | null;
  bookingRef: string;
  checkInDate: Date;
  checkOutDate: Date;
  currency: string;
  advanceReceived: number;
  kept: number;
  /** What the kept amount is, in words — "one night's room, taxes included". */
  keptWhat: string;
  owedBack: number;
};

/**
 * The no-show notice (SIG-S5 §6.5 step 5: "dispatch no-show notification to guest/agent"). It
 * was never sent — the booking closed as a no-show and the guest learnt of it, and of the money
 * kept from their advance, only if someone at the desk thought to write.
 */
export function renderNoShowNoticeEmail(d: NoShowNoticeEmailData): StageEmailContent {
  const subject = COMMON_SUBJECT;
  const stay = `${formatDate(d.checkInDate)} to ${formatDate(d.checkOutDate)}`;
  const forGuest = d.guestName ? ` for ${d.guestName}` : "";
  const keptLine =
    d.kept > 0
      ? `As set out in the terms given at booking, we keep ${formatMoney(d.kept, d.currency)} — ${d.keptWhat} — from the advance of ${formatMoney(d.advanceReceived, d.currency)}.`
      : "Nothing is kept from the advance.";
  const backLine =
    d.owedBack > 0
      ? `The rest, ${formatMoney(d.owedBack, d.currency)}, will be returned — reply to tell us how you would like it paid back.`
      : "";
  const text = [
    "Booking recorded as a no-show",
    "",
    `Dear ${d.recipientName},`,
    "",
    `We held the booking${forGuest} (${d.bookingRef}, ${stay}) for the arrival day, but no one arrived and we could not reach you, so it has been recorded as a no-show and the rooms released.`,
    "",
    keptLine,
    ...(backLine ? [backLine] : []),
    "",
    "If this is a mistake, please reply straight away.",
    "",
    "— The Legphel Hotel team",
  ].join("\n");
  const rows = [
    tableRow("Booking", d.bookingRef),
    tableRow("Stay booked", stay, true),
    ...(d.guestName ? [tableRow("Guest", d.guestName)] : []),
    tableRow("Advance received", formatMoney(d.advanceReceived, d.currency), true),
    tableRow("Kept", `${formatMoney(d.kept, d.currency)}${d.kept > 0 ? ` — ${d.keptWhat}` : ""}`),
    tableRow("To be returned", formatMoney(d.owedBack, d.currency), true, true),
  ];
  const html = htmlShell(`
${emailHeading("Booking recorded as a no-show")}
<p>Dear ${escapeHtml(d.recipientName)},</p>
<p>We held the booking${escapeHtml(forGuest)} for the arrival day, but no one arrived and we could not reach you, so it has been recorded as a no-show and the rooms released.</p>
${detailsTable(rows)}
<p>${escapeHtml(keptLine)}${backLine ? ` ${escapeHtml(backLine)}` : ""}</p>
<p>If this is a mistake, please reply straight away.</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);
  return { subject, text, html };
}

// =============================================================================
// S9 — A charge found after the stay (2026-09-18)
// =============================================================================

export type PostStayChargeEmailData = {
  recipientName: string;
  bookingRef: string;
  checkInDate: Date;
  checkOutDate: Date;
  description: string;
  currency: string;
  charge: number;
  serviceCharge: number;
  serviceChargeRate: number;
  gst: number;
  gstRate: number;
  total: number;
  /** What the bill owes now, after this charge. */
  balanceNow: number;
};

/**
 * The notice a post-stay charge sends (SIG-S9 §6: "guest notification is a mandatory consequence
 * of post-stay charge posting"). It used to be a record with nothing sent — the desk told the
 * operator "the guest is told" while no one was.
 */
export function renderPostStayChargeEmail(d: PostStayChargeEmailData): StageEmailContent {
  const subject = COMMON_SUBJECT;
  const stay = `${formatDate(d.checkInDate)} to ${formatDate(d.checkOutDate)}`;
  const text = [
    "A charge after your stay",
    "",
    `Dear ${d.recipientName},`,
    "",
    `After your stay with us (${stay}, booking ${d.bookingRef}) we found a charge that was not on your bill when you left:`,
    "",
    `  ${d.description}`,
    `  Charge:                 ${formatMoney(d.charge, d.currency)}`,
    ...(d.serviceCharge > 0 ? [`  Service charge (${percentLabel(d.serviceChargeRate)}):  ${formatMoney(d.serviceCharge, d.currency)}`] : []),
    ...(d.gst > 0 ? [`  GST (${percentLabel(d.gstRate)}):              ${formatMoney(d.gst, d.currency)}`] : []),
    `  Total:                  ${formatMoney(d.total, d.currency)}`,
    "",
    d.balanceNow > 0
      ? `Your bill now shows ${formatMoney(d.balanceNow, d.currency)} to pay. We will send the tax invoice for it; if anything here is not right, simply reply to this email.`
      : "Your bill is still settled — money already received covers it. If anything here is not right, simply reply to this email.",
    "",
    "— The Legphel Hotel team",
  ].join("\n");

  const rows = [
    tableRow("Booking", d.bookingRef),
    tableRow("What it was", d.description, true),
    tableRow("Charge", formatMoney(d.charge, d.currency)),
    ...(d.serviceCharge > 0 ? [tableRow(`Service charge (${percentLabel(d.serviceChargeRate)})`, formatMoney(d.serviceCharge, d.currency), true)] : []),
    ...(d.gst > 0 ? [tableRow(`GST (${percentLabel(d.gstRate)})`, formatMoney(d.gst, d.currency))] : []),
    tableRow("Total", formatMoney(d.total, d.currency), true, true),
    tableRow(d.balanceNow > 0 ? "Now to pay" : "To pay", formatMoney(Math.max(0, d.balanceNow), d.currency), false, true),
  ];
  const html = htmlShell(`
${emailHeading("A charge after your stay")}
<p>Dear ${escapeHtml(d.recipientName)},</p>
<p>After your stay with us (<strong>${escapeHtml(stay)}</strong>) we found a charge that was not on your bill when you left.</p>
${detailsTable(rows)}
<p>${
    d.balanceNow > 0
      ? "We will send the tax invoice for it. If anything here is not right, simply reply to this email."
      : "Your bill is still settled &mdash; money already received covers it. If anything here is not right, simply reply to this email."
  }</p>
<p style="margin-top:24px">&mdash; The Legphel Hotel team</p>
`);
  return { subject, text, html };
}

// =============================================================================
// S7 – S9 — the statement so far and the master bill, sent from the desk (2026-11-10)
// =============================================================================

export type FolioStatementEmailData = {
  recipientName: string;
  bookingRef: string;
  /** "Your bill" (the master bill) or "Your bill so far" (the statement during the stay). */
  paperName: string;
  checkInDate: Date | null;
  checkOutDate: Date | null;
  currency: string;
  /** The paper's own figures: everything charged, and what is still to pay. */
  total: number;
  balance: number;
  stillStaying: boolean;
};

/**
 * The covering note for a bill sent from the desk. It states the two figures its paper prints —
 * the total charged and what is still to pay — and nothing worked out here.
 */
export function renderFolioStatementEmail(d: FolioStatementEmailData): StageEmailContent {
  const subject = COMMON_SUBJECT;
  const stay = d.checkInDate && d.checkOutDate ? `${formatDate(d.checkInDate)} to ${formatDate(d.checkOutDate)}` : null;
  const owing = d.balance > 0;
  const closing = d.stillStaying
    ? "Charges continue until you check out, so the final bill may differ. If anything here is not right, simply reply to this email."
    : owing
      ? "If anything here is not right, simply reply to this email."
      : "Thank you — nothing is left to pay. If anything here is not right, simply reply to this email.";
  const text = [
    d.paperName,
    "",
    `Dear ${d.recipientName},`,
    "",
    `Please find your ${d.paperName.toLowerCase()} attached${stay ? ` for your stay ${stay}` : ""} (booking ${d.bookingRef}).`,
    "",
    `  Charged in all:         ${formatMoney(d.total, d.currency)}`,
    `  ${owing ? "Still to pay:" : "To pay:      "}           ${formatMoney(Math.max(0, d.balance), d.currency)}`,
    "",
    closing,
    "",
    "— The Legphel Hotel team",
  ].join("\n");
  const rows = [
    tableRow("Booking", d.bookingRef),
    ...(stay ? [tableRow("Stay", stay, true)] : []),
    tableRow("Charged in all", formatMoney(d.total, d.currency)),
    tableRow(owing ? "Still to pay" : "To pay", formatMoney(Math.max(0, d.balance), d.currency), true, true),
  ];
  const html = htmlShell(`
${emailHeading(d.paperName)}
<p>Dear ${escapeHtml(d.recipientName)},</p>
<p>Please find your ${escapeHtml(d.paperName.toLowerCase())} attached.</p>
${detailsTable(rows)}
<p>${escapeHtml(closing)}</p>
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
