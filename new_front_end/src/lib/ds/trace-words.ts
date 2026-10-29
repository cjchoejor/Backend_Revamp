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
import { fmtRange, money as fmtMoney } from "./format";
import type { HistoryNames } from "./history-walks";

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
  "COMMITTED_HOLD.EXPIRY_SET": "Hold time set for this booking",
  "COMMITTED_HOLD.EXPIRY_CLEARED": "Hold time back to the house window",
  "ENTRY.STAY_DATES_CHANGED": "Stay dates changed",
  // Rooms split off to other dates, as a booking of their own (2026-10-14).
  "ENTRY.ROOMS_SPLIT_OFF": "Rooms split off to a booking of their own",
  "ENTRY.NIGHTS_SPLIT_OFF": "A night moved — the stay cut apart into bookings of their own",
  "ENTRY.CREATED_FROM_SPLIT": "Made from rooms split off another booking",
  // One guest's two bookings (2026-10-19).
  "ENTRY.BOOKINGS_COMBINED": "The guest's other booking combined into this one",
  "ENTRY.COMBINED_INTO": "Combined into the guest's other booking",
  "MULTI_BOOKING.ACKNOWLEDGED": "Recorded that the guest means to keep both bookings over these nights",
  // Room moves from the house chart, and the papers a walk holds for the desk (2026-10-12).
  "ROOM_MOVE.STARTED": "Room move started",
  "ROOM_MOVE.LEG_COMPLETED": "Moved to the new room",
  "ROOM_MOVE.LEG_BLOCKED": "Room move stopped part-way",
  "ROOM_MOVE.LEG_REFUSED": "Room move refused",
  "ROOM_MOVE.LEG_RETRIED": "Room move tried again",
  "ROOM_MOVE.WALKED_BACK": "Room move walked back",
  "ROOM_MOVE.COMPLETED": "Room move done",
  "ROOM_MOVE.PARTIAL": "Room move part-done",
  "ROOM_MOVE.REVERTED": "Room move undone — nothing changed",
  "ROOM_MOVE.FAILED": "Room move refused — nothing changed",
  "ROOM_MOVE.RESOLVED": "Room move closed",
  "DOCUMENT.HELD": "Paper held for the desk to send or not",
  "COMMUNICATION.REPLY_NO_LONGER_AWAITED": "No answer needed any more — the paper was replaced",
  "COMMITTED_HOLD.RELEASED_ON_ROOM_CHANGE": "Rooms let go for the room change",
  "ROOM.BED_TYPE_RESET_TO_USUAL": "Room's beds back to its usual setup",
  "RESERVATION.CONFIRMATION_VOUCHER_REMADE": "Confirmation voucher made again",
  "DOCUMENT.SENT": "Held paper sent",
  "DOCUMENT.NOT_SENT": "Held paper not sent",
  "ADVANCE_PAYMENT.REQUIREMENT_CARRIED": "Advance asked carried to the new pass",
  "ADVANCE_PAYMENT.PLAN_CARRIED": "Payment plan carried to the new pass",
  "ENTRY.NEGOTIATION_CONFIGURATION_AMENDED": "Configuration changed",
  "ENTRY.NEGOTIATION_AMENDMENT_REQUESTED": "Configuration change sent to the FOM",
  "ENTRY.NEGOTIATION_AMENDMENT_APPROVED": "Configuration change approved",
  "ENTRY.NEGOTIATION_AMENDMENT_REJECTED": "Configuration change turned down",
  "ENTRY.NEGOTIATION_AMENDMENT_WITHDRAWN": "Configuration change taken back",
  "QUOTATION.RETIRED_BY_CONFIGURATION_CHANGE": "Quotation retired by a configuration change",
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
  "ADVANCE_PAYMENT.RECONCILED": "Money position signed off",
  "ADVANCE_PAYMENT.RECONCILIATION_UNDONE": "Money sign-off taken back — pressed by mistake",
  "ADVANCE_PAYMENT.PROMISE_LAPSED": "Promised advance did not arrive",
  "FOLIO.PAYMENT_RECORDED": "Payment received",
  "FOLIO.CHARGE_POSTED": "Charge posted",
  "FOLIO.CORRECTION_POSTED": "Charge corrected",
  "CHECK_IN.COMPLETED": "Checked in",
  "CHECK_IN.KEYS_ISSUED": "Keys handed over",
  "ROOM_KEY.ISSUED": "Key handed over",
  "ROOM_KEY.RETURNED": "Key returned",
  "NIGHT_AUDIT.COMPLETED": "Night audit run",
  "NIGHT_AUDIT.CAUGHT_UP": "Night audit posted the bookings it had missed",
  "NIGHT_AUDIT.MISSED_RUN_CAUGHT_UP": "Night audit run late — its scheduled time was missed",
  "NIGHT_AUDIT.CATCH_UP_FAILED": "A missed night audit could not be run",
  "TIMER.JOB_RESENT": "A reminder that failed was sent once more",
  "TIMER.JOB_GAVE_UP": "A reminder failed twice and was given up — see System health",
  "TIMER.JOB_LEFT": "A reminder that failed was left alone — nothing waits on it",
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
  "PRE_ARRIVAL.WINDOW_ALREADY_OPEN": "Reserved inside Arrival's window — move on to Arrival when ready",
  "PRE_ARRIVAL.WINDOW_OPEN_WAITING": "Arrival's window opened — waiting for the guest's answer to the voucher",
  "NO_SHOW_CUTOFF.FIRED": "No-show time passed",
  "NO_SHOW.DETERMINED": "Recorded as a no-show",
  "NO_SHOW.AUTO_FINALISED": "Recorded as a no-show — the wait for their written word ran out",
  "NO_SHOW.DEFERRAL_AWAITING_WRITTEN_CONFIRMATION": "No-show put off — waiting for their written word",
  "NO_SHOW.REACTIVATED": "No-show set aside — they are still coming",
  "HANDOFF.H1_ACCEPTED": "Front-desk handoff accepted",
  "HANDOFF.H2_ACCEPTED": "Housekeeping accepted the room",
  "HANDOFF.H3_ACCEPTED": "Kitchen and bar accepted the guest",
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
  "ENTRY.S4.CANCELLED": "Cancelled",
  "ENTRY.S5.CANCELLED": "Cancelled",
  "ENTRY.S6.CANCELLED": "Cancelled at check-in",
  "HOUSEKEEPING.ROOM_CLEANED": "Room cleaned",
  "ROOM_INSPECTION.DAMAGE_CHARGED": "Damage charged to the bill",
  "ROOM_INSPECTION.DAMAGE_WAIVED": "Damage waived",
  "ROOM_INSPECTION.DAMAGE_PUT_OFF": "Damage left to decide after departure",
  "HOUSEKEEPING.ROOM_NEEDS_CLEANING": "Room put back on the cleaning list",
  "HOUSEKEEPING_SLA.BREACHED": "Room not cleaned by its clean-by time",
  "ROOM.DEFICIENCY_REPORTED": "Room fault reported",
  "SPACE.DEFICIENCY_REPORTED": "Hall fault reported",
  "DEFICIENCY.VERIFIED": "Fault confirmed",
  "DEFICIENCY.REJECTED": "Fault report rejected",
  "BOOKING_NOTE.ADDED": "Note written",
  "BOOKING_NOTE.TODO_ADDED": "To-do set",
  "BOOKING_NOTE.EDITED": "Note changed",
  "BOOKING_NOTE.TODO_DONE": "To-do done",
  "BOOKING_NOTE.TODO_REOPENED": "To-do opened again",
  "GUEST_REQUEST.ADDED": "Request taken",
  "GUEST_REQUEST.ARRANGED": "Request arranged",
  "GUEST_REQUEST.WITHDRAWN": "Request taken back",
  "INQUIRY.CALLER_UPDATED": "Caller's details changed",
  "INQUIRY.SOURCE_CHANGED": "Who is asking changed",
  "ENTRY.GUEST_NAMED": "Guest staying named",
};

const LEVEL_WORD: Record<string, string> = { L1: "desk", L2: "FOM", L3: "GM", L4: "administrator" };

function readable(code: string): string {
  const words = code.replace(/\./g, " · ").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function traceWords(ev: TraceEvent): string {
  // A room change says which room became which (2026-10-13, operator: "changed room 201 to 302").
  if (ev.eventType === "ENTRY.ROOM_CHANGED") return roomChangeWords((ev.payload ?? {}) as RoomChangedPayload);
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

type RoomChangedPayload = {
  kind?: "ROOM" | "SETUP" | "EXTENSION" | "DATES" | "SPLIT";
  /** Rooms split off to their own booking (2026-10-14). */
  split?: { roomNumbers?: string[] | null; toLabel?: string | null } | null;
  /** A date move (2026-10-13): the stay before and after, the rooms that changed row, the price choice per room. */
  dates?: {
    priorCheckInDate?: string | null;
    priorCheckOutDate?: string | null;
    newCheckInDate?: string | null;
    newCheckOutDate?: string | null;
    rooms?: Array<{ fromRoomNumber?: string | null; toRoomNumber?: string | null }> | null;
    priceModes?: Record<string, string> | null;
    /** The stay was shortened to its own nights — a night moved out (2026-10-14). */
    trimmed?: boolean | null;
  } | null;
  /** Several rooms moved in one walk, or a head pieced together from an older walk's lines. */
  moves?: Array<{ from: string; to: string }> | null;
  fromRoom?: { roomNumber?: string | null } | null;
  toRooms?: Array<{ roomNumber?: string | null; nights?: string[] | null }> | null;
  keptNights?: string[] | null;
  newSegmentNumber?: number | null;
  quotationId?: string | null;
  voucherNumber?: string | null;
  heldPapers?: Array<{ kind?: string; number?: string | null }> | null;
  pricing?: { priorTotal?: number | null; newTotal?: number | null; delta?: number | null } | null;
  reachedStage?: string | null;
  returnedToOrigin?: boolean | null;
  blocked?: { message?: string | null } | null;
  moveId?: string | null;
};

function roomChangeWords(p: RoomChangedPayload): string {
  const from = p.fromRoom?.roomNumber ?? null;
  const tos = (p.toRooms ?? []).map((r) => r.roomNumber).filter((n): n is string => !!n);
  if (p.kind === "EXTENSION") return "Stay extended";
  if (p.kind === "SPLIT") {
    const nos = p.split?.roomNumbers ?? [];
    return nos.length ? `${nos.length > 1 ? "Rooms" : "Room"} ${nos.join(" + ")} split off to ${nos.length > 1 ? "their" : "its"} own booking` : "Rooms split off to their own booking";
  }
  if (p.kind === "DATES") {
    const d = p.dates ?? null;
    if (d?.trimmed) return d.newCheckInDate && d.newCheckOutDate ? `Stay shortened to ${fmtRange(d.newCheckInDate, d.newCheckOutDate)}` : "Stay shortened";
    return d?.newCheckInDate && d.newCheckOutDate ? `Stay moved to ${fmtRange(d.newCheckInDate, d.newCheckOutDate)}` : "Stay moved to other dates";
  }
  if (p.kind === "SETUP") return from ? `Room ${from} set up differently` : "Room set up differently";
  if (p.moves?.length) return `${p.moves.length > 1 ? "Rooms" : "Room"} changed — ${p.moves.map((m) => `${m.from} → ${m.to}`).join(" · ")}`;
  if (from && tos.length) return `Room changed — ${from} → ${tos.join(", ")}`;
  return "Room changed";
}

/** What the room change brought with it: the nights, the new pass, the papers, the price, where it ended. */
function roomChangeDetail(p: RoomChangedPayload): string[] {
  const bits: string[] = [];
  const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;
  const tos = p.toRooms ?? [];
  if (p.kind === "SPLIT") {
    if (p.split?.toLabel) bits.push(p.split.toLabel);
  } else if (p.kind === "DATES") {
    // A date move: where the stay was, the rooms that moved with it, the rooms priced afresh.
    const d = p.dates ?? null;
    if (d?.priorCheckInDate && d.priorCheckOutDate) bits.push(`from ${fmtRange(d.priorCheckInDate, d.priorCheckOutDate)}`);
    const moved = (d?.rooms ?? []).filter((r) => r.fromRoomNumber && r.toRoomNumber);
    if (moved.length) bits.push(`rooms ${moved.map((r) => `${r.fromRoomNumber} → ${r.toRoomNumber}`).join(" · ")}`);
    const fresh = Object.entries(d?.priceModes ?? {}).filter(([, m]) => m === "NEW_DATES").map(([no]) => no);
    if (fresh.length) bits.push(`priced at the new dates: Room ${fresh.join(", ")}`);
  } else if (tos.length > 1 || (p.keptNights?.length ?? 0) > 0) {
    for (const r of tos) if (r.roomNumber) bits.push(`Room ${r.roomNumber} for ${nightsWord(r.nights?.length ?? 0)}`);
    if (p.keptNights?.length && p.fromRoom?.roomNumber) bits.push(`kept Room ${p.fromRoom.roomNumber} for ${nightsWord(p.keptNights.length)}`);
  }
  if (p.moveId) bits.push(p.moveId);
  if (typeof p.newSegmentNumber === "number") bits.push(`pass ${p.newSegmentNumber}`);
  if (p.quotationId) bits.push(`re-priced on ${p.quotationId}`);
  if (p.voucherNumber) bits.push(`new voucher ${p.voucherNumber}`);
  const held = (p.heldPapers ?? []).map((h) => h.number).filter((n): n is string => !!n);
  if (held.length) bits.push(`held for the desk to send: ${held.join(", ")}`);
  const prior = money(p.pricing?.priorTotal);
  const next = money(p.pricing?.newTotal);
  if (prior && next) bits.push(p.pricing?.delta ? `price ${prior} → ${next}` : `price unchanged at ${next}`);
  const at = p.reachedStage ? /^S([1-9])$/.exec(p.reachedStage) : null;
  if (p.blocked?.message) bits.push(`stopped${at ? ` at ${STEP_NAMES[Number(at[1]) - 1]}` : ""}: ${p.blocked.message}`);
  else if (at) bits.push(`${p.returnedToOrigin ? "back at" : "now at"} ${STEP_NAMES[Number(at[1]) - 1]}`);
  return bits;
}

const PAPER_WORD: Record<string, string> = {
  QUOTATION: "quotation",
  PROFORMA_INVOICE: "proforma",
  CONFIRMATION_VOUCHER: "confirmation voucher",
  PRE_ARRIVAL_REMINDER: "pre-arrival reminder",
  INTERIM_INVOICE: "interim bill",
  FINAL_INVOICE: "tax invoice",
};

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
export function traceDetail(ev: TraceEvent, names?: Partial<HistoryNames>): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  const str = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string).trim() : null);
  // Older lines name rooms and reservations by id; History passes the names to read them by.
  const roomNo = (id: unknown) => (typeof id === "string" ? names?.roomNo?.(id) ?? null : null);
  const voucherNo = (id: unknown) => (typeof id === "string" ? names?.voucherNo?.(id) ?? null : null);
  // The steps of a room change name what they made or let go (2026-10-13).
  if (ev.eventType === "COMMITTED_HOLD.RELEASED_ON_ROOM_CHANGE" && Array.isArray(p.releasedRoomIds)) {
    const nos = (p.releasedRoomIds as unknown[]).map(roomNo).filter((x): x is string => !!x);
    if (nos.length) bits.push(`${nos.length > 1 ? "rooms" : "room"} ${nos.join(", ")}`);
  }
  if (ev.eventType === "COMMITTED_HOLD.PLACED" || ev.eventType === "COMMITTED_HOLD.CONFIRMED") {
    const no = roomNo(p.roomId);
    if (no) bits.push(`room ${no}`);
  }
  if (ev.eventType.startsWith("QUOTATION.") && str("quotationId")) bits.push(str("quotationId")!);
  if (ev.eventType === "RESERVATION_CONFIRMED") {
    const res = str("reservationId");
    if (res) bits.push(`${res}${voucherNo(res) ? ` · voucher ${voucherNo(res)}` : ""}`);
    if (p.reconfirmation === true) bits.push("confirmed again");
  }
  if (ev.eventType === "ENTRY.ROOM_CHANGED") bits.push(...roomChangeDetail(p as RoomChangedPayload));
  // A reply no longer awaited names the paper and what replaced it (2026-10-13).
  if (ev.eventType === "COMMUNICATION.REPLY_NO_LONGER_AWAITED") {
    const commType = str("commType") ?? "";
    const what = PAPER_WORD[commType] ?? "paper";
    // A pre-arrival message has no number of its own; a voucher is named by its VOU number.
    const paper = commType === "PRE_ARRIVAL_REMINDER" ? null : str("paperNumber") ?? str("paperId");
    const by = str("replacedByNumber") ?? str("replacedBy");
    bits.push(
      commType === "PRE_ARRIVAL_REMINDER"
        ? `${what} — the booking was confirmed again${by ? ` (${by})` : ""}`
        : `${what}${paper ? ` ${paper}` : ""}${by ? ` replaced by ${by}` : ""}`,
    );
  }
  if (ev.eventType === "RESERVATION.CONFIRMATION_VOUCHER_REMADE") {
    const no = str("voucherNumber");
    if (no) bits.push(no);
    if (p.emailedWithThatFile === true) bits.push("the guest had been emailed the earlier voucher's file");
  }
  // One guest's two bookings combined (2026-10-19): from which booking, and what it holds now.
  if (ev.eventType === "ENTRY.BOOKINGS_COMBINED") {
    if (typeof p.combinedFrom === "string") bits.push(`from ${p.combinedFrom}`);
    const after = (p.after ?? null) as { adults?: number; children?: number; numberOfRooms?: number; nights?: Array<{ rooms?: string[] }> } | null;
    if (after?.adults != null) bits.push(`${after.adults} adult${after.adults === 1 ? "" : "s"}${after.children ? ` · ${after.children} children` : ""}`);
    const rooms = [...new Set((after?.nights ?? []).flatMap((n) => n.rooms ?? []))];
    if (rooms.length) bits.push(`Room ${rooms.join(", ")}`);
    if (typeof p.reason === "string" && p.reason) bits.push(p.reason);
  }
  if (ev.eventType === "ENTRY.COMBINED_INTO" && typeof p.combinedInto === "string") bits.push(`into ${p.combinedInto}`);
  if (ev.eventType === "MULTI_BOOKING.ACKNOWLEDGED" && typeof p.note === "string" && p.note) bits.push(p.note);
  // Rooms split off to other dates (2026-10-14): which rooms, to which booking, its nights and guests.
  if (ev.eventType === "ENTRY.ROOMS_SPLIT_OFF" || ev.eventType === "ENTRY.CREATED_FROM_SPLIT") {
    const moved = Array.isArray(p.rooms) ? (p.rooms as Array<{ fromRoomNumber?: string; toRoomNumber?: string }>) : [];
    if (moved.length) {
      bits.push(moved.map((r) => (r.fromRoomNumber === r.toRoomNumber ? `Room ${r.fromRoomNumber}` : `Room ${r.fromRoomNumber} → ${r.toRoomNumber}`)).join(" · "));
    }
    if (ev.eventType === "ENTRY.ROOMS_SPLIT_OFF") {
      if (typeof p.toEntryId === "string") bits.push(`to ${p.toEntryId}${p.target === "NEW_ENQUIRY" && typeof p.newInquiryId === "string" ? ` on a new enquiry, ${p.newInquiryId}` : " on the same enquiry"}`);
    } else if (typeof p.fromEntryId === "string") {
      bits.push(`from ${p.fromEntryId}`);
    }
    const to = (p.to ?? null) as { checkInDate?: string; checkOutDate?: string } | null;
    if (to?.checkInDate && to.checkOutDate) bits.push(fmtRange(to.checkInDate, to.checkOutDate));
    if (typeof p.guests === "string" && p.guests) bits.push(p.guests);
    const modes = (p.priceModes ?? null) as Record<string, string> | null;
    const atNewDates = modes ? Object.entries(modes).filter(([, m]) => m === "NEW_DATES").map(([n]) => n) : [];
    if (atNewDates.length) bits.push(`priced at the new dates: Room ${atNewDates.join(", ")}`);
    if (p.nightMove === true) bits.push(p.kind === "MOVED" ? "the night moved" : "left at its own dates");
    const blocked = (p.blocked ?? null) as { message?: string } | null;
    if (blocked?.message) bits.push(`stopped: ${blocked.message}`);
  }
  // A night moved off the stay (2026-10-14): which nights went where, what the booking kept, the
  // bookings made for every other stay.
  if (ev.eventType === "ENTRY.NIGHTS_SPLIT_OFF") {
    const room = (p.room ?? null) as { roomNumber?: string; toRoomNumber?: string } | null;
    const nights = (p.nights ?? null) as { label?: string } | null;
    // Several rooms' nights moved together (2026-10-15): each room, its nights and where they went.
    const moves = Array.isArray(p.moves) ? (p.moves as Array<{ roomNumber?: string; toRoomNumber?: string; label?: string }>) : [];
    if (moves.length > 1) {
      for (const m of moves) bits.push(`Room ${m.roomNumber ?? "?"}${m.toRoomNumber && m.toRoomNumber !== m.roomNumber ? ` → ${m.toRoomNumber}` : ""} · ${m.label ?? ""}`);
    } else if (room?.roomNumber && nights?.label) {
      bits.push(`Room ${room.roomNumber}${room.toRoomNumber && room.toRoomNumber !== room.roomNumber ? ` → ${room.toRoomNumber}` : ""} · ${nights.label}`);
    }
    const kept = (p.kept ?? null) as { roomNumber?: string; nights?: string[] } | null;
    const roomsLeft = Array.isArray(p.roomsLeft) ? (p.roomsLeft as string[]) : [];
    if (kept?.nights?.length) {
      const last = kept.nights[kept.nights.length - 1];
      const end = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      bits.push(`kept ${String(kept.roomNumber ?? "?").includes("+") ? "Rooms" : "Room"} ${kept.roomNumber ?? "?"} for ${fmtRange(kept.nights[0], end)}`);
    } else if (roomsLeft.length > 1) {
      bits.push(`Rooms ${roomsLeft.join(" + ")} left this booking with their guests`);
    } else if (p.roomLeft === true && room?.roomNumber) {
      bits.push(`Room ${roomsLeft[0] ?? room.roomNumber} left this booking with its guests`);
    }
    const pieces = Array.isArray(p.pieces) ? (p.pieces as Array<{ entryId?: string; checkInDate?: string; checkOutDate?: string }>) : [];
    if (pieces.length) {
      bits.push(
        `${pieces.length === 1 ? "a booking" : `${pieces.length} bookings`} of their own: ${pieces
          .map((x) => `${x.entryId ?? "?"}${x.checkInDate && x.checkOutDate ? ` (${fmtRange(x.checkInDate, x.checkOutDate)})` : ""}`)
          .join(", ")}${p.target === "NEW_ENQUIRY" && typeof p.newInquiryId === "string" ? ` on a new enquiry, ${p.newInquiryId}` : ""}`,
      );
    }
    if (p.priceMode === "NEW_DATES") bits.push("the night priced at the new dates");
  }
  // A stay that moved says from what to what (2026-10-12).
  if (ev.eventType === "ENTRY.STAY_DATES_CHANGED") {
    const span = (v: unknown) => {
      const o = (v ?? {}) as { checkInDate?: string | null; checkOutDate?: string | null; nights?: number | null };
      return o.checkInDate && o.checkOutDate ? `${fmtRange(o.checkInDate, o.checkOutDate)}${typeof o.nights === "number" ? ` (${o.nights} night${o.nights === 1 ? "" : "s"})` : ""}` : null;
    };
    const from = span(p.from);
    const to = span(p.to);
    if (from && to) bits.push(`from ${from} to ${to}`);
    // The rooms that changed row with it — the block (2026-10-13).
    const moved = Array.isArray(p.rooms) ? (p.rooms as Array<{ fromRoomNumber?: string; toRoomNumber?: string }>) : [];
    if (moved.length) bits.push(`rooms ${moved.map((r) => `${r.fromRoomNumber ?? "?"} → ${r.toRoomNumber ?? "?"}`).join(" · ")}`);
    const modes = (p.priceModes ?? null) as Record<string, string> | null;
    const atNewDates = modes ? Object.entries(modes).filter(([, m]) => m === "NEW_DATES").map(([no]) => no) : [];
    if (atNewDates.length) bits.push(`priced at the new dates: Room ${atNewDates.join(", ")}`);
  }
  // A room move names the move, the partner and why a leg did not run (2026-10-12).
  if (ev.eventType.startsWith("ROOM_MOVE.")) {
    const moveId = str("moveId");
    if (moveId) bits.push(moveId);
    const fromNo = str("fromRoomNumber") ?? roomNo(p.fromRoomId);
    const toNo = str("toRoomNumber") ?? roomNo(p.toRoomId);
    if (fromNo && toNo) bits.push(`Room ${fromNo} → ${toNo}`);
    // The move's outcome lines list every room that moved.
    if (Array.isArray(p.legs)) {
      const moves = (p.legs as Array<{ fromRoomNumber?: string | null; toRoomNumber?: string | null; fromRoomId?: string; toRoomId?: string; entryId?: string }>)
        .map((l) => ({ ...l, from: l.fromRoomNumber ?? roomNo(l.fromRoomId), to: l.toRoomNumber ?? roomNo(l.toRoomId) }))
        .filter((l) => l.from && l.to)
        .map((l) => `${l.from} → ${l.to}${l.entryId && l.entryId !== ev.entryId ? ` (${l.entryId})` : ""}`);
      if (moves.length) bits.push(`rooms ${moves.join(", ")}`);
    }
    const partner = str("partnerEntryId");
    if (partner) bits.push(`switched with ${partner}`);
    // (the move's own reason is added below, with every other act's)
    const why = str("why") ?? str("because") ?? str("note");
    if (why) bits.push(why);
  }
  // A held paper says which paper and how it went.
  if (ev.eventType.startsWith("DOCUMENT.")) {
    const kind = str("kind");
    const doc = str("documentId");
    const number = kind === "CONFIRMATION_VOUCHER" ? voucherNo(doc) ?? doc : doc;
    if (kind) bits.push(`${kind === "PROFORMA" ? "proforma" : "confirmation voucher"}${number ? ` ${number}` : ""}`);
    const channel = str("channel");
    if (channel) bits.push(channel === "EMAIL" ? "by email" : "on WhatsApp");
    const to = str("sentTo");
    if (to) bits.push(to);
  }
  // A configuration change carries its own one-line summary.
  if (ev.eventType.startsWith("ENTRY.NEGOTIATION_")) {
    const summary = typeof p.summary === "string" ? p.summary.trim() : "";
    if (summary) bits.push(summary);
  }
  const amount = money(p.amount) ?? money(p.requiredAmount);
  if (amount) bits.push(amount);
  if (typeof p.penalty === "number") bits.push(`charge ${money(p.penalty)}`);
  if (typeof p.netRefund === "number" && p.netRefund > 0) bits.push(`refund ${money(p.netRefund)}`);
  if (typeof p.refund === "number" && p.refund > 0) bits.push(`owed back ${money(p.refund)}`);
  const how = readableCode(p.acknowledgementMethod ?? p.acceptanceMethod);
  if (how) bits.push(how);
  // A note, a to-do or a request carries its own words — they are the record (2026-10-12).
  if (ev.eventType.startsWith("BOOKING_NOTE.") || ev.eventType.startsWith("GUEST_REQUEST.")) {
    const kindWord = str("kind");
    const text = str("text") ?? str("what");
    const owner = readableCode(p.assignee);
    if (ev.eventType.startsWith("GUEST_REQUEST.") && kindWord) bits.push(kindWord);
    if (text) bits.push(`“${text}”`);
    if (owner && ev.eventType.startsWith("BOOKING_NOTE.")) bits.push(`for ${owner}`);
    const was = str("was");
    if (was) bits.push(`was “${was}”`);
  }
  const said = str("verbatimNote");
  if (said) bits.push(`“${said}”`);
  // A walk files its reason with the kind of walk in front ("ROOM_MOVE: …") — the act's own words
  // already say which walk it was.
  const reason = (str("reason") ?? str("decisionReason"))?.replace(
    /^(ROOM_MOVE|ROOM_CHANGE|STAY_EXTENSION|PARTY_SEATING_REPAIR|BOOKING_REPRICE|ROOM_SETUP_CHANGE): /,
    "",
  ) ?? null;
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
