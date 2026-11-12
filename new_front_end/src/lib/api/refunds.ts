import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/** Money going back to a guest (2026-11-05): the Refunds tab, for the FOM, GM and admin. */
export type RefundRow = {
  id: string;
  status: "WAITING" | "REFUNDED" | "KEPT" | "CANCELLED";
  cause: "RENEGOTIATED" | "LAPSED";
  amountAsked: number;
  currency: string;
  note: string | null;
  raisedAt: string;
  raisedByName: string | null;
  guest: { name: string | null; phone: string | null; email: string | null; nationality: string | null };
  booking: {
    id: string;
    inquiryId: string | null;
    status: string;
    stage: string;
    closedAs: string | null;
    checkInDate: string | null;
    checkOutDate: string | null;
    rooms: number | null;
    adults: number | null;
    children: number | null;
    guests: number | null;
    party: string | null;
    sourceChannel: string | null;
  };
  payments: Array<{ id: string; amount: number; method: string | null; notes: string | null; receivedAt: string; recordedByName: string | null }>;
  paidOn: { id: string; number: string; version: number; sentAt: string | null; stored: boolean } | null;
  refundedAmount: number | null;
  refundMethod: string | null;
  bankName: string | null;
  accountNumber: string | null;
  journalNumber: string | null;
  closeNote: string | null;
  closedAt: string | null;
  closedByName: string | null;
};

/** Refunds made, booking by booking (2026-11-12). Every figure is the server's, summed there. */
export type RefundMade = {
  id: string;
  amount: number;
  currency: string;
  at: string;
  stage: string | null;
  method: string | null;
  by: string | null;
  kind: "CANCELLED" | "NO_SHOW" | "PAID_OVER" | "REQUEST" | "OTHER";
  why: string;
  reason: string | null;
  reference: string | null;
  bank: string | null;
  requestId: string | null;
};

export type BookingRefunds = {
  entryId: string;
  inquiryId: string | null;
  guestName: string | null;
  party: string | null;
  status: string | null;
  stage: string | null;
  closedAs: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  currency: string;
  total: number;
  count: number;
  lastAt: string;
  /** Moved to another stay of the trip — still the hotel's, not a refund. */
  movedToTrip: number | null;
  refunds: RefundMade[];
};

export type RefundsMade = {
  bookings: BookingRefunds[];
  totals: { bookings: number; refunds: number; amount: number; currency: string };
};

export async function listRefundsMade(session: Session) {
  return apiRequest<RefundsMade>("/api/refunds/made", { method: "GET", session });
}

export async function listRefunds(session: Session, view: "waiting" | "done") {
  return apiRequest<{ items: RefundRow[] }>(`/api/refunds?view=${view}`, { method: "GET", session });
}

export async function recordRefund(
  session: Session,
  id: string,
  body: { method: string; amount: number; bankName?: string; accountNumber?: string; journalNumber?: string; note?: string },
) {
  return apiRequest<{ id: string; refunded: number; stayedOnBill: number; paymentId: string }>(`/api/refunds/${encodeURIComponent(id)}/record`, { method: "POST", session, body });
}

export async function keepRefund(session: Session, id: string, body: { reason: string }) {
  return apiRequest<{ id: string; kept: number; bookingLive: boolean }>(`/api/refunds/${encodeURIComponent(id)}/keep`, { method: "POST", session, body });
}

export type EarlierAdvanceOutcome =
  | { answer: "CARRY"; amount: number; requiredAmount: number; shortfall: number; proformaRemade: boolean }
  | { answer: "REFUND"; amount: number; refundRequestId: string; proformaRemade: boolean };

/** The desk's answer about an advance from an earlier pass: on the new proforma, or refunded. */
export async function answerEarlierAdvance(session: Session, entryId: string, body: { answer: "CARRY" | "REFUND"; note?: string }) {
  return apiRequest<EarlierAdvanceOutcome>(`/api/entries/${encodeURIComponent(entryId)}/earlier-advance/answer`, { method: "POST", session, body });
}
