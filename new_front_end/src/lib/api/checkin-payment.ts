import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * The rest of the bill at check-in (2026-10-29): the guest's promise, the server's figures, the
 * desk's request to pay later and the FOM's decision. Every figure is the backend's.
 */
export type CheckInPayBy = "DURING_STAY" | "AT_CHECKOUT" | "AFTER_STAY";

export type CheckInPaymentDeferral = {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  stillToPay: number;
  reason: string;
  requestedBy: string;
  requestedLevel: string | null;
  requestedAt: string;
  payBy: CheckInPayBy | null;
  dueBy: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedLevel: string | null;
  decidedAt: string | null;
  creditExtensionId: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
};

export type CheckInPaymentStanding = {
  entryId: string;
  stage: string;
  plan: { plan: string; balanceDueAt: string | null; promisedBy: string | null; note: string | null; setAt: string } | null;
  promisedAtCheckIn: boolean;
  stayTotal: number | null;
  received: number;
  stillToPay: number | null;
  open: CheckInPaymentDeferral | null;
  approved: CheckInPaymentDeferral | null;
  /** The FOM's latest pay-later on this booking, any pass — for Stay and Check-out. */
  decision: CheckInPaymentDeferral | null;
  history: CheckInPaymentDeferral[];
  gateMet: boolean;
  waitsFor: string | null;
};

export function getCheckInPayment(session: Session, entryId: string) {
  return apiRequest<CheckInPaymentStanding>(`/api/entries/${entryId}/checkin-payment`, { session });
}

export function askToPayLater(session: Session, entryId: string, reason: string) {
  return apiRequest<{ standing: CheckInPaymentStanding }>(`/api/entries/${entryId}/checkin-payment/deferral`, {
    method: "POST",
    session,
    body: { reason },
  });
}

export function decidePayLater(
  session: Session,
  entryId: string,
  body: { requestId?: string | null; decision: "APPROVE" | "REJECT"; payBy?: CheckInPayBy | null; dueBy?: string | null; note?: string | null },
) {
  return apiRequest<CheckInPaymentStanding>(`/api/entries/${entryId}/checkin-payment/decide`, { method: "POST", session, body });
}

export function withdrawPayLater(session: Session, entryId: string, requestId: string) {
  return apiRequest<CheckInPaymentStanding>(`/api/entries/${entryId}/checkin-payment/deferral/${requestId}/withdraw`, {
    method: "POST",
    session,
    body: {},
  });
}

export const PAY_BY_WORDS: Record<CheckInPayBy, string> = {
  DURING_STAY: "during the stay",
  AT_CHECKOUT: "at check-out",
  AFTER_STAY: "after the stay",
};
