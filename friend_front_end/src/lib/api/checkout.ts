import type { EntryDetail } from "@/types/api";
import type { KeyReturnSummary, RoomInspectionSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { acceptHandoff, buildH4FulfilmentEvidence, fulfilHandoff } from "./in-stay";
import { progressStage } from "./entries";
import { recordFolioPayment } from "./reservation-setup";

export { acceptHandoff, fulfilHandoff, buildH4FulfilmentEvidence };
export { postFolioCharge, correctFolioCharge } from "./in-stay";

export async function recordKeyReturn(
  session: Session,
  entryId: string,
  body: { keyCountReturned: number; reconciliationNote?: string },
) {
  return apiRequest<KeyReturnSummary>(`/api/entries/${entryId}/key-return`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordRoomInspection(
  session: Session,
  entryId: string,
  body: {
    isDeferred: boolean;
    deficientFlagStatus: "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE";
    deficientConditionId?: string;
    inspectorAssessment?: string;
    damageFound: boolean;
    damageNotes?: string;
  },
) {
  return apiRequest<RoomInspectionSummary>(`/api/entries/${entryId}/room-inspection`, {
    method: "POST",
    session,
    body,
  });
}

export async function initiateSettlement(
  session: Session,
  folioId: string,
  body: {
    settlementMethod: string;
    billingModelConfirmation: string;
    paymentVerificationRef?: string;
    partialAmount?: number;
    fomAcknowledgementRef?: string;
    nightAuditFomAcknowledgementRef?: string;
    voucherAmount?: number;
  },
) {
  return apiRequest<unknown>(`/api/folios/${folioId}/settle`, {
    method: "POST",
    session,
    body,
  });
}

export async function issueFinalInvoice(
  session: Session,
  folioId: string,
  entryId: string,
  templateKey?: string,
) {
  return apiRequest<unknown>(`/api/folios/${folioId}/invoices`, {
    method: "POST",
    session,
    body: { entryId, templateKey },
  });
}

export async function closeDispute(session: Session, disputeId: string, closureReason: string) {
  return apiRequest<unknown>(`/api/disputes/${disputeId}/close`, {
    method: "POST",
    session,
    body: { closureReason },
  });
}

export async function reEnterS8ToS7(session: Session, entryId: string, version: number, reEntryReason: string) {
  return progressStage(session, entryId, {
    targetStage: "S7",
    version,
    transitionData: { reEntryReason },
  }) as Promise<EntryDetail>;
}

/**
 * S8 → S2 re-entry — re-open a checkout for a full rate renegotiation (rate dispute). Seals the
 * current segment and starts a fresh one at Quote; the LIVE folio persists. Backend requires L2+
 * and a reEntryReason (SIG-S8 §1.2 / §3.7).
 */
export async function reEnterS8ToS2(session: Session, entryId: string, version: number, reEntryReason: string) {
  return progressStage(session, entryId, {
    targetStage: "S2",
    version,
    transitionData: { reEntryReason },
  }) as Promise<EntryDetail>;
}

export { recordFolioPayment };
