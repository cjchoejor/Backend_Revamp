import type { EntryDetail, FolioLineSummary, InvoiceSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import { closeDispute } from "./checkout";
import { dispatchInvoice, issueProformaInvoice } from "./reservation-setup";
import { fulfilHandoff } from "./in-stay";
import { postCreditNote } from "./in-stay";

export { closeDispute, dispatchInvoice, fulfilHandoff, postCreditNote };

export type WriteOffRecordSummary = {
  id: string;
  folioId: string;
  entryId: string;
  writtenOffAmount: string | number;
  currency: string;
  reason: string;
  createdAt: string;
};

export type CommissionDueSummary = {
  id: string;
  entryId: string;
  agentProfileId: string;
  commissionRate: string | number | null;
  commissionBasis: string | null;
  calculatedAmount: string | number | null;
  currency: string;
  status: string;
  createdAt: string;
};

export type FollowUpTaskSummary = {
  id: string;
  entryId: string;
  dueAt: string;
  completedAt?: string | null;
  notes?: string | null;
  createdAt: string;
};

export async function expirePostCheckoutInspectionWindow(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/post-checkout-inspection/expire-window`, {
    method: "POST",
    session,
    body: {},
  });
}

/**
 * What still stands between the booking and "Close & seal" — the backend's own seal checks,
 * read without sealing, and where the room inspection stands.
 */
export type ClosureReadiness = {
  entryId: string;
  currentStage: string;
  status: string;
  canClose: boolean;
  notReadyReason: string | null;
  closeRequiresLevel: "L2";
  checks: Array<{ code: string; label: string; met: boolean; detail?: string }>;
  inspection: {
    state: "NOT_RECORDED" | "DONE" | "PUT_OFF" | "LAPSED";
    inspectionId: string | null;
    roomId: string | null;
    roomNumber: string | null;
    inspectedAt: string | null;
    deficientFlagStatus: string | null;
    damageFound: boolean;
    damageNotes: string | null;
    windowEndsAt: string | null;
    windowCanBeClosed: boolean;
    lapsedAt: string | null;
    openFault: { id: string; category: string; description: string } | null;
  };
};

export async function getClosureReadiness(session: Session, entryId: string) {
  return apiRequest<ClosureReadiness>(`/api/entries/${entryId}/closure-readiness`, { session });
}

export async function closeEntryAtS9(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/close`, {
    method: "POST",
    session,
    body: {},
  });
}

/** What a post-stay charge booked, as the backend reports it (2026-09-18). */
export type PostStayChargeResult = FolioLineSummary & {
  serviceCharge?: string;
  gst?: string;
  /** The charge with its service charge and GST. */
  total?: string;
  /** What the bill owes after it. */
  balanceNow?: string;
  folioState?: string;
  /** Whether the notice was emailed, and where — or why not. */
  notice?: { sent: boolean; to: string | null; reason: string | null };
};

export async function postStayCharge(
  session: Session,
  folioId: string,
  body: {
    entryId: string;
    lineType: string;
    description: string;
    amount: number;
    currency?: string;
    postedAt: string;
    isPostStay: true;
  },
) {
  return apiRequest<PostStayChargeResult>(`/api/folios/${folioId}/post-stay-charges`, {
    method: "POST",
    session,
    body,
  });
}

export async function writeOffOutstanding(
  session: Session,
  folioId: string,
  body: { amount: number; reason: string },
) {
  return apiRequest<WriteOffRecordSummary>(`/api/folios/${folioId}/write-off`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordInvoicePaymentEvent(
  session: Session,
  invoiceId: string,
  body: {
    nextState: "PAYMENT_TRACKED" | "RECONCILED";
    paymentRef?: string;
    amount?: number;
    paymentMethod?: string;
    receivedAt?: string;
    referenceNumber?: string;
  },
) {
  return apiRequest<InvoiceSummary>(`/api/invoices/${invoiceId}/record-payment-event`, {
    method: "POST",
    session,
    body,
  });
}

export { issueProformaInvoice as issueFolioInvoice };
