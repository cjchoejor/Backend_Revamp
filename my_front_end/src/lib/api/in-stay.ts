import type { EntryDetail, FolioLineSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { ApiError, apiRequest } from "./client";
import { acceptHandoff, fulfilHandoff } from "./pre-arrival";

export { acceptHandoff, fulfilHandoff };
export { getHandoffChecklist } from "./handoffs";

export type NightAuditRecord = {
  id: string;
  operatingDate: string;
  runStatus: string;
  entriesProcessed?: number;
};

export async function postFolioCharge(
  session: Session,
  folioId: string,
  body: {
    entryId: string;
    lineType: string;
    description: string;
    amount: number;
    currency?: string;
    chargeDate?: string;
  },
) {
  return apiRequest<FolioLineSummary>(`/api/folios/${folioId}/charges`, {
    method: "POST",
    session,
    body,
  });
}

export async function correctFolioCharge(
  session: Session,
  folioId: string,
  body: {
    entryId: string;
    originalFolioLineId: string;
    reason: string;
    correctionAmount?: number;
    correctToAmount?: number;
    correctionDate: string;
  },
) {
  return apiRequest<FolioLineSummary>(`/api/folios/${folioId}/corrections`, {
    method: "POST",
    session,
    body,
  });
}

export async function postCreditNote(
  session: Session,
  folioId: string,
  body: {
    entryId: string;
    description: string;
    amount: number;
    creditDate: string;
    currency?: string;
  },
) {
  return apiRequest<FolioLineSummary>(`/api/folios/${folioId}/credit-notes`, {
    method: "POST",
    session,
    body,
  });
}

export async function createH4Handoff(
  session: Session,
  entryId: string,
  body?: { autoFulfilForSameDayDeparture?: boolean; notes?: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/handoffs/h4`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export function buildH4FulfilmentEvidence(deficientFlagFinalStatus: string) {
  return {
    chargesPostedConfirmation: true,
    roomInspectionStatus: "RECORDED_OR_DEFERRED",
    damageAssessmentStatus: "COMPLETE_OR_DEFERRED",
    deficientFlagFinalStatus,
  };
}

export async function runNightAudit(session: Session, operatingDate: string) {
  return apiRequest<NightAuditRecord>("/api/night-audit/run", {
    method: "POST",
    session,
    body: { operatingDate },
  });
}

export async function getNightAuditRecord(session: Session, operatingDateYmd: string) {
  return apiRequest<NightAuditRecord | null>(
    `/api/night-audit/operating-date/${encodeURIComponent(operatingDateYmd)}`,
    { session },
  ).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
}

export async function openDispute(
  session: Session,
  body: { entryId: string; folioId: string; title: string; description?: string },
) {
  return apiRequest<unknown>("/api/disputes", { method: "POST", session, body });
}

export async function progressDispute(session: Session, disputeId: string, status: "IN_PROGRESS" | "RESOLVED") {
  return apiRequest<unknown>(`/api/disputes/${disputeId}`, {
    method: "PATCH",
    session,
    body: { status },
  });
}

export async function disputeGateOverride(
  session: Session,
  disputeId: string,
  body: { targetStage: "S8" | "S9"; freeTextReason: string },
) {
  return apiRequest<unknown>(`/api/disputes/${disputeId}/gate-override`, {
    method: "POST",
    session,
    body,
  });
}

export async function finalizeDeficientCondition(
  session: Session,
  deficientId: string,
  body: { status: "RESOLVED" | "UNRESOLVED"; resolutionNotes?: string },
) {
  return apiRequest<unknown>(`/api/deficient-conditions/${deficientId}/finalize`, {
    method: "PATCH",
    session,
    body,
  });
}

export async function amendEntry(
  session: Session,
  entryId: string,
  body: Record<string, unknown>,
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/amend`, {
    method: "POST",
    session,
    body,
  });
}

export async function roomChangeReEnterS1(
  session: Session,
  entryId: string,
  body: { newRoomId: string; reason: string },
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/s7-room-change/re-enter-s1`, {
    method: "POST",
    session,
    body,
  });
}
