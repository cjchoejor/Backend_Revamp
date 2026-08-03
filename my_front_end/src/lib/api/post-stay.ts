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

export async function closeEntryAtS9(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/close`, {
    method: "POST",
    session,
    body: {},
  });
}

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
  return apiRequest<FolioLineSummary>(`/api/folios/${folioId}/post-stay-charges`, {
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
