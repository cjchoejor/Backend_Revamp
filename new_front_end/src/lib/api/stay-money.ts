import type { Session } from "@/types/session";
import type { RoomCompositionInput } from "./quotations";
import type { RoomChangeCandidate, RoomChangeOutcome } from "./entries";
import { apiRequest } from "./client";

/**
 * Mid-stay money (2026-08-21, operator ruling): interim payments on long stays and the
 * payment-before-commit stay extension. Every figure here is SERVER-computed — the desk
 * renders, never adds.
 */

export type InterimAsk = { mode: "PERCENT" | "AMOUNT"; value: number };

/** Config `interimPayment.reminder` (2026-08-22) — the mid-stay payment reminder clock (W41). */
export type InterimReminderPolicy = {
  enabled: boolean;
  dueAfterHours: number;
  extensionLeadHours: number;
  repeatEveryHours: number;
  maxReminders: number;
};

/** Server-computed reminder facts for one interim bill. */
export type InterimReminder = {
  dueBy: string | null;
  nextReminderAt: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  overdue: boolean;
};

export type InterimFigures = {
  currency: string;
  checkIn: string | null;
  checkOut: string | null;
  nightsTotal: number;
  nightsSlept: number;
  nightsToCome: number;
  projectedRoomTotal: number;
  otherChargesSoFar: number;
  projectedTotal: number;
  roomChargesPostedSoFar: number;
  billedSoFar: number;
  receivedSoFar: number;
  outstandingNow: number;
  ask: InterimAsk | null;
  askAmount: number | null;
  dueNow: number | null;
  balanceAtCheckout: number | null;
  askLabel: string | null;
  projectionSource: "QUOTE" | "EXTENSION_PREVIEW" | "LEDGER_RUN_RATE";
};

export type InterimPaymentRow = {
  id: string;
  entryId: string;
  kind: "LONG_STAY" | "EXTENSION";
  state: "SUGGESTED" | "REQUESTED" | "BILLED" | "PAID" | "WITHDRAWN" | "LAPSED";
  promptedBy: "MANUAL" | "NIGHT_AUDIT";
  askMode: "PERCENT" | "AMOUNT" | null;
  askValue: number | null;
  projectedTotal: number | null;
  receivedAtRequest: number | null;
  dueNow: number | null;
  figures: InterimFigures | null;
  invoiceId: string | null;
  stayExtensionRequestId: string | null;
  nightsSleptAtPrompt: number | null;
  note: string | null;
  requestedAt: string;
  billedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  receivedAgainstAsk: number;
  /** Mid-stay payment reminder (2026-08-22): when the money is expected + the W41 clock's state. */
  dueBy?: string | null;
  remindersSent?: number;
  lastReminderAt?: string | null;
  /** Present on the interim-payments list; an extension row's embedded bill carries the raw columns only. */
  reminder?: InterimReminder | null;
  /** The guest's promise (2026-08-22): NOW = paying at the desk; BY_DATE = `promisedBy` (= the due-by). */
  promiseKind?: "NOW" | "BY_DATE" | null;
  promisedBy?: string | null;
  promiseNote?: string | null;
  promiseRecordedAt?: string | null;
  invoice: { id: string; state: string; dispatchedAt: string | null; dispatchedTo?: string | null; totalAmount: number | null; pdfStorageKey?: string | null } | null;
  payments: Array<{ id: string; amount: number; receivedAt: string | null; paymentMethod: string | null }>;
};

export async function listInterimPayments(session: Session, entryId: string) {
  return apiRequest<{ entryId: string; figures: InterimFigures | null; reminderPolicy: InterimReminderPolicy; requests: InterimPaymentRow[] }>(
    `/api/entries/${entryId}/interim-payments`,
    { session },
  );
}

export async function createInterimPayment(
  session: Session,
  entryId: string,
  body: { askMode: "PERCENT" | "AMOUNT"; askValue: number; note?: string; dueBy?: string },
) {
  return apiRequest<{ request: InterimPaymentRow; invoice: { id: string } }>(`/api/entries/${entryId}/interim-payments`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordInterimPayment(
  session: Session,
  requestId: string,
  body: { amount: number; paymentMethod?: string; notes?: string },
) {
  return apiRequest<{ payment: { id: string; amount: number }; request: InterimPaymentRow; paidInFull: boolean; receivedAgainstAsk: number; remaining: number }>(
    `/api/interim-payments/${requestId}/record-payment`,
    { method: "POST", session, body },
  );
}

/** Record the guest's promise on an interim bill (2026-08-22) — a dated one becomes the due-by and moves the reminder clock. */
export async function recordInterimPromise(
  session: Session,
  requestId: string,
  body: { kind: "NOW" | "BY_DATE"; promisedBy?: string; note?: string },
) {
  return apiRequest<InterimPaymentRow>(`/api/interim-payments/${requestId}/promise`, { method: "POST", session, body });
}

/** Move an interim bill's due-by — re-arms the W41 reminder clock (2026-08-22). */
export async function setInterimDueBy(session: Session, requestId: string, dueBy: string) {
  return apiRequest<InterimPaymentRow>(`/api/interim-payments/${requestId}/due-by`, { method: "POST", session, body: { dueBy } });
}

export async function withdrawInterimPayment(session: Session, requestId: string, reason?: string) {
  return apiRequest<InterimPaymentRow>(`/api/interim-payments/${requestId}/withdraw`, {
    method: "POST",
    session,
    body: reason ? { reason } : {},
  });
}

// ── Stay extension ─────────────────────────────────────────────────────────────────────────

export type RoomStanding = RoomChangeCandidate;

export type StayExtensionPreview = {
  entryId: string;
  currentStage: string;
  currency: string;
  currentCheckOut: string;
  newCheckOut: string;
  extraNights: string[];
  currentRooms: Array<RoomStanding & { extendableInPlace: boolean }>;
  candidates: RoomStanding[];
  plan: Array<{ date: string; roomId: string; roomNumber: string | null }>;
  moves: Array<{ fromRoomId: string; fromRoomNumber: string | null; toRoomId: string; toRoomNumber: string | null; crossType: boolean }>;
  compositions: RoomCompositionInput[];
  pricing: {
    priorStayTotal: number | null;
    projectedStayTotal: number;
    delta: number | null;
    discount: { effectivePercent: number; amountOffTotal: number } | null;
  };
  figures: InterimFigures;
  holdTtlSeconds: number;
  /** The reminder policy + the due-by a request would default to (before the held nights lapse). */
  reminder: { policy: InterimReminderPolicy; defaultDueBy: string | null };
  blockedReason: string | null;
};

export type StayExtensionInput = {
  newCheckOutDate: string;
  perNight?: Array<{ date: string; roomId: string }>;
  /** Which current room `perNight` replaces (multi-room bookings) — the desk always names it. */
  replaceRoomId?: string;
  roomCompositions?: RoomCompositionInput[];
  requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  askMode?: "PERCENT" | "AMOUNT";
  askValue?: number;
};

export type StayExtensionRow = {
  id: string;
  entryId: string;
  state: "REQUESTED" | "BILLED" | "PAID" | "COMMITTED" | "LAPSED" | "WITHDRAWN";
  priorCheckOutDate: string;
  newCheckOutDate: string;
  extraNights: Array<{ date: string; roomId: string }>;
  roomCompositions: RoomCompositionInput[] | null;
  pricingPreview: { pricing?: StayExtensionPreview["pricing"]; figures?: InterimFigures; moves?: StayExtensionPreview["moves"] } | null;
  reason: string;
  holdExpiresAt: string;
  requestedAt: string;
  committedAt: string | null;
  outcome: RoomChangeOutcome | null;
  closedAt: string | null;
  closedReason: string | null;
  interimPayment: (Omit<InterimPaymentRow, "payments"> & { payments?: undefined }) | null;
};

export async function previewStayExtension(session: Session, entryId: string, body: StayExtensionInput) {
  return apiRequest<StayExtensionPreview>(`/api/entries/${entryId}/stay-extension/preview`, { method: "POST", session, body });
}

export async function requestStayExtension(
  session: Session,
  entryId: string,
  body: StayExtensionInput & { reason: string; askMode: "PERCENT" | "AMOUNT"; askValue: number; note?: string; dueBy?: string },
) {
  return apiRequest<{ request: StayExtensionRow; interim: InterimPaymentRow; invoice: { id: string }; preview: StayExtensionPreview }>(
    `/api/entries/${entryId}/stay-extension`,
    { method: "POST", session, body },
  );
}

export async function listStayExtensions(session: Session, entryId: string) {
  return apiRequest<{ entryId: string; requests: StayExtensionRow[] }>(`/api/entries/${entryId}/stay-extensions`, { session });
}

export async function commitStayExtension(session: Session, entryId: string, requestId: string, reason?: string) {
  return apiRequest<{ request: StayExtensionRow; outcome: RoomChangeOutcome }>(`/api/entries/${entryId}/stay-extensions/${requestId}/commit`, {
    method: "POST",
    session,
    body: reason ? { reason } : {},
  });
}

export async function withdrawStayExtension(session: Session, entryId: string, requestId: string, reason?: string) {
  return apiRequest<StayExtensionRow>(`/api/entries/${entryId}/stay-extensions/${requestId}/withdraw`, {
    method: "POST",
    session,
    body: reason ? { reason } : {},
  });
}
