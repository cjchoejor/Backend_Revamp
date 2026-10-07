/**
 * The kinds of event the history can be narrowed to (the "lenses"), shared by the History view
 * and the second screen's Decisions list so the two never sort an event differently.
 */
import type { TraceEvent } from "@/lib/trace/humanize";

export type Lens = "all" | "money" | "papers" | "requests" | "changes" | "approvals" | "messages";

export const LENSES: ReadonlyArray<readonly [Lens, string]> = [
  ["all", "Everything"],
  ["money", "Money"],
  ["papers", "Papers"],
  ["requests", "Requests"],
  ["changes", "Changes"],
  ["approvals", "Approvals"],
  ["messages", "Messages"],
];

export const LENS_TEST: Record<Exclude<Lens, "all">, RegExp> = {
  money: /PAYMENT|CHARGE|CORRECTION|CREDIT_NOTE|WRITE_OFF|WRITEOFF|SETTLE|REFUND|INTERIM|ADVANCE|NIGHT_AUDIT\.|RECONCIL|PENALT/,
  papers: /QUOTATION\.(CREATED|SENT|SUPERSEDED|EXPIRED)|INVOICE\.|PROFORMA|VOUCHER|CONFIRMATION_CONFIRMATION|MASTER_BILL|STATEMENT|CANCELLATION_CONFIRMATION|RESERVATION\.CONFIRMATION/,
  requests: /PREFERENCE|REQUEST|SPECIAL/,
  changes: /TRANSITION|BACKFLOW|REENTRY|AMEND|ROOM_CHANGE|BED_TYPE|EXTENSION|EARLY_DEPARTURE|BILLING_MODEL|INTAKE|CONFIGURATION_SELECTED|HOLD|PARK|CANCELLED|EXPIRED|CLOSED|ROOM_KEY|CHECK_IN|ACTIVATION|ASSIGN/,
  approvals: /APPROV|OVERRIDE|AUTHORITY|WAIV|CREDIT_EXTENSION|VERIFIED|ESCALAT|ACCEPTED|CONFIRMED|DETERMIN/,
  messages: /EMAIL|ACKNOWLEDGEMENT|COMMUNICATION|REMINDER|MESSAGE/,
};

export const inLens = (ev: TraceEvent, lens: Lens) => lens === "all" || LENS_TEST[lens].test(ev.eventType);
