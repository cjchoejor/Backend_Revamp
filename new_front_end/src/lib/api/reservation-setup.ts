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

/** What cancelling now would charge and refund — the backend's own figures, nothing written. */
export type CancellationPreview = {
  stage: "S3" | "S5";
  advanceReceived: number;
  charge: number;
  refund: number;
  chargeBeforeCap: number;
  chargeCapped: number;
  hoursUntilCheckIn: number;
  waived: boolean;
};

export async function previewCancellation(session: Session, entryId: string, waive = false) {
  return apiRequest<CancellationPreview>(`/api/entries/${entryId}/cancellation-preview${waive ? "?waive=true" : ""}`, { session });
}

/** SIG-S3 §6.5 — pre-confirmation cancellation. Releases hold, cancels timers, supersedes invoices,
 *  posts penalty, terminates entry. */
export async function cancelEntryAtS3(
  session: Session,
  entryId: string,
  body: { reason?: string; penaltyWaiverRequested?: boolean; refundMethod?: string; refundReference?: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/cancel-at-s3`, {
    method: "POST",
    session,
    body,
  });
}

/** SIG-S5 §1.7 / Policy 35 — pre-arrival cancellation (L2; GM required to waive the penalty).
 *  Releases the held room, cancels the no-show timer, posts the disclosed penalty, terminates the entry. */
export async function cancelEntryAtS5(
  session: Session,
  entryId: string,
  body?: { penaltyWaiverRequested?: boolean; reason?: string; refundMethod?: string; refundReference?: string },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/cancel`, { method: "POST", session, body: body ?? {} });
}

/** SIG-S6/S7 Policy 35/36 — early-departure / post-check-in cancellation (L2; GM required to waive).
 *  Posts the penalty on the LIVE folio, releases the room(s), terminates the entry. */
export async function cancelEntryEarlyDeparture(
  session: Session,
  entryId: string,
  body?: { penaltyWaiverRequested?: boolean },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/cancel-early-departure`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function getPaymentStatus(session: Session, entryId: string) {
  return apiRequest<PaymentStatusSummary>(`/api/entries/${entryId}/payment-status`, { session });
}

/**
 * Outcome of the backend's automatic committed-hold placement on an S3 advance payment
 * (2026-08-10: money received — full or partial — holds the rooms; the PI dispatch no longer
 * does). `placed: false` carries a desk-readable `message` — the operator is told to hold
 * manually. Null / absent when the payment was taken past S3 (the hold is already confirmed).
 */
export type AdvanceAutoHold =
  | { placed: true; holdId: string; roomId: string; expiresAt: string }
  | { placed: false; reason: string; message: string; holdId?: string };

/**
 * How advance money came in, and the code the ledger stores for it (2026-09-18) — the same codes
 * check-out and the post-stay payments use, so a cash count reads one vocabulary.
 */
export const ADVANCE_PAYMENT_MODES = [
  ["CASH", "Cash — Nu."],
  ["CASH_INR", "Cash — INR at par"],
  ["CARD", "Card (POS terminal)"],
  ["MOBILE_PAYMENT", "QR (BoB merchant)"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["INWARD_REMITTANCE", "Inward remittance"],
] as const;
export type AdvancePaymentMode = (typeof ADVANCE_PAYMENT_MODES)[number][0];

export async function recordFolioPayment(
  session: Session,
  folioId: string,
  body: { entryId: string; amount: number; notes?: string; paymentMethod?: string },
) {
  return apiRequest<{ id: string; autoHold?: AdvanceAutoHold | null }>(`/api/folios/${folioId}/payments`, {
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
  body: {
    ceilingAmount: number;
    reason: string;
    validForHours?: number | null;
    /** Absolute expiry (ISO) — aligns the extension with the guest's promise / check-in / check-out. */
    validUntil?: string | null;
  },
) {
  return apiRequest<unknown>(`/api/entries/${entryId}/credit-extension`, {
    method: "POST",
    session,
    body,
  });
}

/**
 * Record what the guest said about paying the advance (2026-08-07): full / partial /
 * installments + when the remainder is coming. BEFORE_CHECKIN carries the promised date and
 * arms a real deadline timer server-side. CLEAR wipes the plan. Returns fresh payment-status.
 * AT_CHECKOUT was removed 2026-08-08 (the advance settles before or at check-in); the proforma
 * prints the plan, so at S3 a plan CHANGE re-issues it — `reissuedProforma` says so.
 */
export async function setAdvancePaymentPlan(
  session: Session,
  entryId: string,
  body: {
    plan: "FULL" | "PARTIAL" | "INSTALLMENTS" | "CLEAR";
    balanceDueAt?: "BEFORE_CHECKIN" | "AT_CHECKIN" | null;
    promisedBy?: string | null;
    note?: string | null;
  },
) {
  return apiRequest<
    PaymentStatusSummary & {
      /** Set when the plan change superseded the live proforma and minted a fresh DRAFT. */
      reissuedProforma?: { newInvoiceId: string; supersededIds: string[]; versionNumber: number } | null;
    }
  >(`/api/entries/${entryId}/advance-payment-plan`, {
    method: "POST",
    session,
    body,
  });
}

/**
 * Operator-set advance requirement (2026-08-01): how much the guest must pay before the
 * booking confirms — a flat amount, or a percentage of the operative quotation's total
 * (converted server-side; no money math here). CLEAR reverts to the hotel's configured
 * thresholds. Returns the fresh payment-status.
 */
export async function setAdvanceRequirement(
  session: Session,
  entryId: string,
  body: { mode: "AMOUNT"; amount: number } | { mode: "PERCENT"; percent: number } | { mode: "CLEAR" },
) {
  return apiRequest<
    PaymentStatusSummary & {
      /** Set when the change superseded a frozen proforma and minted a fresh DRAFT (2026-08-01). */
      reissuedProforma?: { newInvoiceId: string; supersededIds: string[]; versionNumber: number } | null;
    }
  >(`/api/entries/${entryId}/advance-requirement`, {
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

/**
 * Release another booking's committed hold, freeing its rooms. GM (L3) and above.
 *
 * The reason is required and is recorded against the booking that loses the room. The backend
 * refuses once that booking is confirmed — at that point the rooms are bound to its reservation
 * and the correct routes are cancellation or a room change.
 */
export async function releaseCommittedHold(
  session: Session,
  entryId: string,
  body: { releaseReason: string },
) {
  return apiRequest<CommittedHoldSummary>(`/api/entries/${entryId}/holds/committed/release`, {
    method: "POST",
    session,
    body,
  });
}

/** The house's hold window — what a committed hold runs for when nobody has said otherwise. */
export async function getHoldWindow(session: Session) {
  return apiRequest<{ minutes: number; seconds: number; source: "POLICY" | "CONFIG" }>("/api/lookups/hold-window", { session });
}

/**
 * Set — or clear — how long THIS booking's committed hold runs (2026-09-25): "they will confirm
 * by six". The day and time are the HOTEL's wall clock, sent as typed; the server reads them in
 * the hotel's timezone. The moment is remembered on the booking, so a hold placed again later
 * runs to it rather than to the house window. `clear` hands it back to the house.
 */
export async function setCommittedHoldExpiry(
  session: Session,
  entryId: string,
  body: { date?: string; time?: string; clear?: boolean; reason?: string },
) {
  return apiRequest<{
    heldUntil: string | null;
    source: "BOOKING" | "HOUSE";
    holdUpdated: boolean;
    houseWindowMinutes: number;
    note?: string;
  }>(`/api/entries/${entryId}/holds/committed/expiry`, { method: "POST", session, body });
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

/** The payment-milestone templates the hotel has configured — empty until an admin sets them. */
export type PaymentMilestoneTemplate = { key: string; label: string; milestones: Array<{ code: string; offsetDays: number }> };
export async function listPaymentMilestoneTemplates(session: Session) {
  return apiRequest<{ templates: PaymentMilestoneTemplate[]; configKey: string }>("/api/lookups/payment-milestone-templates", { session });
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
