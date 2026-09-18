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
import { money as fmtMoney } from "./format";

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
  "DISPUTE.OPENED": "A charge was queried",
  "DISPUTE.REVIEW_STARTED": "The query went under review",
  "DISPUTE.RESOLVED": "The query was resolved",
  "DISPUTE.CLOSED": "The query was answered and closed",
  "SETTLEMENT.PARTIAL": "Settled in part — the rest is owed",
  "SETTLEMENT.OUTSTANDING": "Settled on account — the balance is invoiced",
  "FINAL_INVOICE_EMAIL.SKIPPED": "Tax invoice not emailed",
  "INVOICE.SETTLEMENT_DISPATCH_FAILED": "The invoice did not go out",
  "GUEST.IDENTITY_PROOF_CAPTURED": "ID photo stored",
  "GUEST.IDENTITY_DETAIL_RECORDED": "Guest details recorded",
  "GUEST.IDENTITY_DETAILS_CONFIRMED": "Guest details confirmed",
  "INQUIRY.SPECIAL_PREFERENCE_UPDATED": "Preference changed",
  "PRE_ARRIVAL_TASK.COMPLETED": "Arrival task done",
  "EARLY_DEPARTURE.RECORDED": "Left early",
  CONFIGURATION_SELECTED: "Rooms chosen",
  OWNERSHIP_ASSIGNED: "Custodian assigned",
  RESERVATION_CONFIRMED: "Reserved",
  CHECK_IN_COMPLETE: "Checked in",
  FOLIO_CONVERTED_TO_LIVE: "The bill opened",
  "FOLIO.CREATED": "Bill started",
  "FOLIO.REENTRY_CONTINUATION": "The bill carried into the new pass",
  "INVOICE.CREATED": "Invoice generated",
  "INVOICE.SUPERSEDED": "Invoice replaced by a new version",
  "INVOICE.PDF_GENERATED": "Invoice printed to PDF",
  "QUOTATION.PDF_GENERATED": "Quotation printed to PDF",
  "RESERVATION.CONFIRMATION_VOUCHER_PDF_GENERATED": "Voucher printed to PDF",
  "CANCELLATION_CONFIRMATION.RENDERED": "Cancellation confirmation printed",
  "CANCELLATION_DISCLOSURE.RECORDED": "Cancellation terms disclosed",
  "GUEST_PROFILE.CREATED": "Guest record created",
  "GUEST.IDENTITY_DETAILS_UNLOCKED": "Guest details opened for changes",
  "GUEST.IDENTITY_VERIFIED": "Identity verified",
  "ADVANCE_PAYMENT.PLAN_CLEARED": "Payment plan cleared",
  "ADVANCE_PAYMENT.S5_RECONCILIATION_AUTO": "Advance reconciled by the system",
  "PRE_ARRIVAL_TASK.RESET_FOR_ARRIVAL_VERIFICATION": "Arrival tasks reopened for checking",
  "PRE_ARRIVAL.ACTIVATION_FIRED": "Arrival opened",
  "NO_SHOW_CUTOFF.FIRED": "No-show time passed",
  "HANDOFF.H1_ACCEPTED": "Front-desk handoff accepted",
  "HANDOFF.H1_FULFILLED": "Front-desk handoff done",
  "HANDOFF.H1_CLOSED": "Front-desk handoff closed",
  "HANDOFF.ACCEPTANCE_WINDOW_EXPIRED": "A handoff was not accepted in time",
  "HANDOFF.FOM_ALERTED": "The FOM was alerted about a handoff",
  "CHECK_IN.ESCORT_COMPLETE": "Guest escorted to the room",
  "STAGE_DWELL.WARNING_FIRED": "Sitting too long at this step",
  "STAGE_DWELL.CRITICAL_FIRED": "Sitting far too long at this step",
  "STAGE_DWELL.FOM_ESCALATED": "Raised with the FOM for sitting too long",
  "COMMITTED_HOLD.EXPIRY_TRIGGERED": "Block ran out",
  "ENTRY.S3.CANCELLED": "Cancelled",
  "ROOM.DEFICIENCY_REPORTED": "Room fault reported",
  "SPACE.DEFICIENCY_REPORTED": "Hall fault reported",
  "DEFICIENCY.VERIFIED": "Fault confirmed",
  "DEFICIENCY.REJECTED": "Fault report rejected",
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
  const fromCode = typeof p.fromStage === "string" ? p.fromStage : typeof p.from === "string" ? p.from : null;
  const toCode = typeof p.toStage === "string" ? p.toStage : typeof p.to === "string" ? p.to : null;
  const from = fromCode ? /^S([1-9])$/.exec(fromCode) : null;
  const to = toCode ? /^S([1-9])$/.exec(toCode) : null;
  if (to && (ev.eventType.includes("TRANSITION") || ev.eventType.includes("PROGRESS") || ev.eventType.includes("BACKFLOW") || ev.eventType.includes("ACTIVATION"))) {
    const back = ev.eventType.includes("BACKFLOW") ? "Re-entered" : "Moved";
    return `${back}${from ? ` from ${STEP_NAMES[Number(from[1]) - 1]}` : ""} to ${STEP_NAMES[Number(to[1]) - 1]}`;
  }
  let line = translateMessage(readable(ev.eventType));
  line = line.replace(/\b(l[1-4])\b/gi, (m) => LEVEL_WORD[m.toUpperCase()] ?? m);
  return line;
}

/** System bookkeeping that says nothing to the desk — kept in History, left out of "Recent". */
const HOUSEKEEPING = [
  /^TIMER_MANAGEMENT\./,
  /^NIGHT_AUDIT_TIMERS\./,
  /^NOTIFICATION\./,
  /^MODE\./,
  /^REENTRY\.CONSEQUENCES_COMPUTED$/,
  /\.PDF_GENERATED$/,
  /_PDF_GENERATED$/,
  /^ADMIN\./,
  /\.W\d+_FIRED$/,
];

export function isHousekeeping(eventType: string): boolean {
  return HOUSEKEEPING.some((r) => r.test(eventType));
}

const DETAIL_WORD: Record<string, string> = {
  WRITTEN: "they wrote",
  VERBAL: "they said",
  PROFORMA: "proforma",
  FINAL: "tax invoice",
  INTERIM: "interim bill",
  FULL: "the full amount",
  PARTIAL: "part now, the rest later",
  INSTALLMENTS: "in instalments",
  ADVANCE_PAYMENT: "held when the advance came in",
  MANUAL: "placed by hand",
};

/** The backend's figure, formatted — never computed here. */
function money(v: unknown): string | null {
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return null;
  const out = fmtMoney(v as number | string);
  return out === "—" ? null : out;
}

function readableCode(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (DETAIL_WORD[v]) return DETAIL_WORD[v];
  const w = v.replace(/_/g, " ").toLowerCase();
  return w;
}

/**
 * The second line of an act — the readable part of what the record carries: the reason, the
 * guest's own words, the amount, who it went to. Ids, checksums and storage keys never show.
 */
export function traceDetail(ev: TraceEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  const str = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string).trim() : null);
  const amount = money(p.amount) ?? money(p.requiredAmount);
  if (amount) bits.push(amount);
  if (typeof p.penalty === "number") bits.push(`charge ${money(p.penalty)}`);
  if (typeof p.netRefund === "number" && p.netRefund > 0) bits.push(`refund ${money(p.netRefund)}`);
  const how = readableCode(p.acknowledgementMethod ?? p.acceptanceMethod);
  if (how) bits.push(how);
  const said = str("verbatimNote");
  if (said) bits.push(`“${said}”`);
  const reason = str("reason") ?? str("decisionReason");
  if (reason && !/^[A-Z_]+$/.test(reason)) bits.push(reason);
  else if (reason) bits.push(readableCode(reason) ?? reason);
  const note = str("note");
  if (note && note !== said) bits.push(note);
  const plan = readableCode(p.plan);
  if (plan && ev.eventType.includes("PLAN")) bits.push(plan);
  const task = readableCode(p.taskType);
  if (task) bits.push(task);
  const who = str("subjectLabel");
  if (who) bits.push(who);
  const room = str("roomNumber");
  if (room) bits.push(`room ${room}`);
  if (typeof p.keyCount === "number") bits.push(`${p.keyCount} key${p.keyCount === 1 ? "" : "s"}`);
  const to = str("intendedRecipient") ?? str("dispatchedTo");
  if (to) bits.push(`to ${to}`);
  const trigger = readableCode(p.trigger);
  if (trigger && ev.eventType.includes("HOLD")) bits.push(trigger);
  const kind = readableCode(p.invoiceType);
  if (kind && ev.eventType.startsWith("INVOICE")) bits.push(kind);
  return bits.length ? translateMessage(bits.join(" · ")) : null;
}
