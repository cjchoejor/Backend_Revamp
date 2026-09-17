/**
 * One line, in the desk's words, for a recorded event (SS03 §3, "Recent" and History).
 *
 * The trace is the system's own record and its event names are codes. The common ones read as the
 * desk would say them; anything else falls back to its name made readable, with stage codes and
 * system words translated. Nothing here decides anything.
 */
import type { TraceEvent } from "@/lib/trace/humanize";
import { STEP_NAMES } from "./steps";
import { translateMessage } from "./words";

const WORDS: Record<string, string> = {
  "ENTRY.CREATED": "Booking recorded",
  "INQUIRY.CREATED": "Inquiry recorded",
  "ENTRY.PARKED": "Parked",
  "ENTRY.UNPARKED": "Resumed",
  "ENTRY.EXPIRED": "Expired",
  "ENTRY.CANCELLED": "Cancelled",
  "ENTRY.CLOSED": "Closed and sealed",
  "QUOTATION.CREATED": "Quotation generated",
  "QUOTATION.SENT": "Quotation sent",
  "QUOTATION.ACCEPTED": "Quotation accepted",
  "QUOTATION.SUPERSEDED": "Quotation replaced by a new one",
  "QUOTATION.EXPIRED": "Quotation ran out",
  "QUOTATION.ACKNOWLEDGEMENT_RECORDED": "The guest's answer to the quotation recorded",
  "PROFORMA_INVOICE.ACKNOWLEDGEMENT_RECORDED": "The guest's answer to the proforma recorded",
  "CONFIRMATION_VOUCHER.ACKNOWLEDGEMENT_RECORDED": "The guest's answer to the voucher recorded",
  "PRE_ARRIVAL_REMINDER.ACKNOWLEDGEMENT_RECORDED": "The guest's answer to the pre-arrival message recorded",
  "SPECULATIVE_HOLD.PLACED": "Provisional block placed",
  "SPECULATIVE_HOLD.RELEASED": "Provisional block released",
  "SPECULATIVE_HOLD.EXPIRED": "Provisional block ran out",
  "COMMITTED_HOLD.PLACED": "Rooms blocked",
  "COMMITTED_HOLD.RELEASED": "Block released",
  "COMMITTED_HOLD.EXPIRED": "Block ran out",
  "COMMITTED_HOLD.CONFIRMED": "Block confirmed on reserving",
  "RESERVATION.CONFIRMED": "Reserved",
  "RESERVATION.CONFIRMATION_VOUCHER_RESENT": "Confirmation voucher sent again",
  "RESERVATION_CONFIRMATION_EMAIL.SENT": "Confirmation voucher emailed",
  "QUOTATION_EMAIL.SENT": "Quotation emailed",
  "PROFORMA_INVOICE_EMAIL.SENT": "Proforma emailed",
  "FINAL_INVOICE_EMAIL.SENT": "Tax invoice emailed",
  "PRE_ARRIVAL_EMAIL.SENT": "Pre-arrival message emailed",
  "ADVANCE_PAYMENT.RECORDED": "Advance received",
  "ADVANCE_PAYMENT.REQUIREMENT_SET": "Advance asked for",
  "ADVANCE_PAYMENT.PLAN_RECORDED": "Payment plan recorded",
  "ADVANCE_PAYMENT.PROMISE_LAPSED": "Promised advance did not arrive",
  "FOLIO.PAYMENT_RECORDED": "Payment received",
  "FOLIO.CHARGE_POSTED": "Charge posted",
  "FOLIO.CORRECTION_POSTED": "Charge corrected",
  "CHECK_IN.COMPLETED": "Checked in",
  "CHECK_IN.KEYS_ISSUED": "Keys handed over",
  "ROOM_KEY.ISSUED": "Key handed over",
  "ROOM_KEY.RETURNED": "Key returned",
  "NIGHT_AUDIT.COMPLETED": "Night audit run",
  "SETTLEMENT.COMPLETED": "Bill settled",
  "GUEST.IDENTITY_PROOF_CAPTURED": "ID photo stored",
  "GUEST.IDENTITY_DETAIL_RECORDED": "Guest details recorded",
  "GUEST.IDENTITY_DETAILS_CONFIRMED": "Guest details confirmed",
  "INQUIRY.SPECIAL_PREFERENCE_UPDATED": "Preference changed",
  "PRE_ARRIVAL_TASK.COMPLETED": "Arrival task done",
  "EARLY_DEPARTURE.RECORDED": "Left early",
};

const LEVEL_WORD: Record<string, string> = { L1: "desk", L2: "FOM", L3: "GM", L4: "administrator" };

function readable(code: string): string {
  const words = code.replace(/\./g, " · ").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function traceWords(ev: TraceEvent): string {
  const known = WORDS[ev.eventType];
  if (known) return known;
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  // A move between steps reads as the move.
  const from = typeof p.fromStage === "string" ? /^S([1-9])$/.exec(p.fromStage) : null;
  const to = typeof p.toStage === "string" ? /^S([1-9])$/.exec(p.toStage) : null;
  if (to && (ev.eventType.includes("TRANSITION") || ev.eventType.includes("PROGRESS") || ev.eventType.includes("BACKFLOW"))) {
    const back = ev.eventType.includes("BACKFLOW") ? "Re-entered" : "Moved";
    return `${back}${from ? ` from ${STEP_NAMES[Number(from[1]) - 1]}` : ""} to ${STEP_NAMES[Number(to[1]) - 1]}`;
  }
  let line = translateMessage(readable(ev.eventType));
  line = line.replace(/\b(l[1-4])\b/gi, (m) => LEVEL_WORD[m.toUpperCase()] ?? m);
  return line;
}
