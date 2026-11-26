/**
 * A charge on a settled bill the desk asks the FOM to correct (2026-11-26). The server decides who may
 * ask, what the charge reads now and what the correction becomes; approving posts it.
 * back_end/src/services/domain/charge-correction-request-service.ts.
 */
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import type { SettledCorrectionOutcome } from "./in-stay";

export type ChargeCorrectionAsk = {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  originalLineId: string;
  charge: { description: string; chargeDate: string; where: string | null; netNow: number } | null;
  mode: "ADJUST" | "SET_NET";
  value: number;
  netBefore: number;
  netAfter: number;
  reason: string;
  requestedAt: string;
  requestedByName: string;
  decisionNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  outcome: SettledCorrectionOutcome | null;
};

export type ChargeCorrectionStanding = {
  open: ChargeCorrectionAsk[];
  latest: ChargeCorrectionAsk | null;
  requests: ChargeCorrectionAsk[];
  mayAsk: boolean;
};

export function getChargeCorrections(session: Session, entryId: string) {
  return apiRequest<ChargeCorrectionStanding>(`/api/entries/${entryId}/charge-corrections`, { session });
}

export function askChargeCorrection(
  session: Session,
  entryId: string,
  body: { originalLineId: string; mode: "ADJUST" | "SET_NET"; value: number; reason: string },
) {
  return apiRequest<ChargeCorrectionStanding>(`/api/entries/${entryId}/charge-corrections`, { session, method: "POST", body });
}

export function decideChargeCorrection(session: Session, entryId: string, requestId: string, body: { decision: "APPROVE" | "REJECT"; note?: string | null }) {
  return apiRequest<{ standing: ChargeCorrectionStanding; outcome: SettledCorrectionOutcome | null }>(
    `/api/entries/${entryId}/charge-corrections/${requestId}/decide`,
    { session, method: "POST", body },
  );
}

export function withdrawChargeCorrection(session: Session, entryId: string, requestId: string) {
  return apiRequest<ChargeCorrectionStanding>(`/api/entries/${entryId}/charge-corrections/${requestId}/withdraw`, { session, method: "POST", body: {} });
}

/** What waits for the FOM right now — the bell asks every few seconds (2026-11-26). */
export function getWaitingForFom(session: Session) {
  return apiRequest<{ items: Array<{ kind: string; id: string; entryId: string; requestedAt: string }>; key: string }>(`/api/desk/waiting-for-fom`, { session });
}
