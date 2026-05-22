import type {
  CancellationDisclosureSummary,
  CommittedHoldSummary,
  FolioDetail,
  InvoiceSummary,
  PaymentStatusSummary,
} from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export async function ensureProvisionalFolio(
  session: Session,
  entryId: string,
  body: { billingModel: string },
) {
  return apiRequest<FolioDetail>(`/api/entries/${entryId}/folio/provisional`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordCancellationDisclosure(
  session: Session,
  entryId: string,
  body: { noShowTreatmentStatement: string; disclosedTerms?: unknown },
) {
  return apiRequest<CancellationDisclosureSummary>(`/api/entries/${entryId}/disclosures/cancellation`, {
    method: "POST",
    session,
    body,
  });
}

export async function getPaymentStatus(session: Session, entryId: string) {
  return apiRequest<PaymentStatusSummary>(`/api/entries/${entryId}/payment-status`, { session });
}

export async function recordFolioPayment(
  session: Session,
  folioId: string,
  body: { entryId: string; amount: number; notes?: string },
) {
  return apiRequest<unknown>(`/api/folios/${folioId}/payments`, {
    method: "POST",
    session,
    body,
  });
}

export async function reconcileAdvancePayment(
  session: Session,
  folioId: string,
  body: { entryId: string; note?: string },
) {
  return apiRequest<FolioDetail>(`/api/folios/${folioId}/advance-payment/reconcile`, {
    method: "POST",
    session,
    body,
  });
}

export async function recordCreditExtension(
  session: Session,
  entryId: string,
  body: { ceilingAmount: number; reason: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/credit-extension`, {
    method: "POST",
    session,
    body,
  });
}

export async function placeCommittedHold(
  session: Session,
  entryId: string,
  body: {
    roomId: string;
    commercialJustification: string;
    isFoc?: boolean;
    roomsRequested?: number;
    focRoomsRequested?: number;
  },
) {
  return apiRequest<CommittedHoldSummary>(`/api/entries/${entryId}/holds/committed`, {
    method: "POST",
    session,
    body,
  });
}

export async function issueProformaInvoice(
  session: Session,
  folioId: string,
  body: { entryId: string; templateKey?: string },
) {
  return apiRequest<InvoiceSummary>(`/api/folios/${folioId}/invoices`, {
    method: "POST",
    session,
    body,
  });
}

export async function dispatchInvoice(session: Session, invoiceId: string, body?: { dispatchedTo?: string }) {
  return apiRequest<InvoiceSummary>(`/api/invoices/${invoiceId}/dispatch`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function initiateS3ReEntryToS2(session: Session, entryId: string, body?: { reason?: string }) {
  return apiRequest<unknown>(`/api/entries/${entryId}/re-entry/s2`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function initiateS3ReEntryToS1(session: Session, entryId: string, body?: { reason?: string }) {
  return apiRequest<unknown>(`/api/entries/${entryId}/re-entry/s1`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function confirmCoordinator(
  session: Session,
  entryId: string,
  body: { coordinatorName: string; authorityScope: string; notes?: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/coordinator/confirm`, {
    method: "POST",
    session,
    body,
  });
}

export async function schedulePaymentMilestones(
  session: Session,
  entryId: string,
  body: { templateKey: string; dueAt?: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/payment-milestones/schedule`, {
    method: "POST",
    session,
    body,
  });
}

export async function approveFocGm(session: Session, entryId: string, body?: { note?: string }) {
  return apiRequest<unknown>(`/api/entries/${entryId}/foc/gm-approve`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}
