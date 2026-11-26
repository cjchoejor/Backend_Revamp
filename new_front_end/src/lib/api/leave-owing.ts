/**
 * Leaving owing at Check-out, asked of the FOM (2026-11-26). The server decides everything:
 * whether the desk may ask, what is owed, whether a credit extension already covers it.
 * back_end/src/services/domain/leave-owing-service.ts.
 */
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type LeaveOwingRequest = {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  amountOwed: number;
  guestWords: string;
  requestedAt: string;
  requestedByName: string;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  payBy: string | null;
};

export type LeaveOwingStanding = {
  balance: number;
  creditLive: boolean;
  creditCovers: boolean;
  open: LeaveOwingRequest | null;
  latest: LeaveOwingRequest | null;
  requests: LeaveOwingRequest[];
  mayAsk: boolean;
};

export function getLeaveOwing(session: Session, entryId: string) {
  return apiRequest<LeaveOwingStanding>(`/api/entries/${entryId}/leave-owing`, { session });
}

export function askToLeaveOwing(session: Session, entryId: string, guestWords: string) {
  return apiRequest<LeaveOwingStanding>(`/api/entries/${entryId}/leave-owing`, { session, method: "POST", body: { guestWords } });
}

export function decideLeaveOwing(
  session: Session,
  entryId: string,
  requestId: string,
  body: { decision: "APPROVE" | "REJECT"; note?: string | null; payWithinDays?: number | null },
) {
  return apiRequest<LeaveOwingStanding>(`/api/entries/${entryId}/leave-owing/${requestId}/decide`, { session, method: "POST", body });
}

export function withdrawLeaveOwing(session: Session, entryId: string, requestId: string) {
  return apiRequest<LeaveOwingStanding>(`/api/entries/${entryId}/leave-owing/${requestId}/withdraw`, { session, method: "POST", body: {} });
}
