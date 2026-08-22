import { FolioState, Stage } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 80 — interim payments and stay extensions at S7 (2026-08-21, operator ruling).
 *
 * Mid-stay money follows the S3 order exactly: the bill (INTERIM invoice) goes out, the guest's
 * answer is recorded, then the money is taken — and a stay extension commits only AFTER that
 * money is in. These gates are the teeth; the desk mirrors them as locks with hints.
 */

/** An interim payment is in-stay money: the folio must be LIVE and the booking in-house (S7). */
export function enforceInterimPaymentStage(input: { currentStage: Stage; folioState: FolioState }) {
  if (input.currentStage !== Stage.S7) {
    throw new PolicyGateBlockedError(
      "INTERIM_PAYMENT_OUTSIDE_STAY",
      "Interim payments are taken during the stay (S7) — before check-in use the advance, at check-out use settlement",
    );
  }
  if (input.folioState !== FolioState.LIVE) {
    throw new PolicyGateBlockedError("FOLIO_NOT_LIVE", "Interim payments need a live folio");
  }
}

/** The interim invoice must have been DISPATCHED before money is recorded against it. */
export function enforceInterimInvoiceDispatchedBeforePayment(input: {
  invoice: { state: string; dispatchedAt: Date | string | null } | null;
}) {
  if (input.invoice && input.invoice.state !== "SUPERSEDED" && input.invoice.dispatchedAt != null) return;
  throw new PolicyGateBlockedError(
    "INTERIM_INVOICE_NOT_DISPATCHED",
    "Send the interim invoice to the guest before recording the payment — money is taken against the bill they received",
  );
}

/** …and the guest's answer to it must be on record (p52 capture — verbal or written; a late answer counts). */
export function enforceInterimGuestAnswerRecordedBeforePayment(input: {
  latestDispatchedInterimComm: { acknowledgementStatus: string | null } | null;
}) {
  const comm = input.latestDispatchedInterimComm;
  if (!comm) return;
  if (comm.acknowledgementStatus === "RECEIVED") return;
  throw new PolicyGateBlockedError(
    "INTERIM_GUEST_ANSWER_REQUIRED",
    "Note down the guest's response to the interim invoice first — record their answer (verbal or written), then log the money received",
  );
}

/** A stay extension commits only once its interim payment is in (operator ruling 2026-08-21). */
export function enforceExtensionPaidBeforeCommit(input: {
  extensionState: string;
  interimState: string | null;
}) {
  if (input.extensionState === "COMMITTED") {
    throw new ValidationError("This extension has already been committed");
  }
  if (input.extensionState === "LAPSED" || input.extensionState === "WITHDRAWN") {
    throw new ValidationError(`This extension was ${input.extensionState.toLowerCase()} — request it again`);
  }
  if (input.extensionState !== "PAID" || input.interimState !== "PAID") {
    throw new PolicyGateBlockedError(
      "EXTENSION_PAYMENT_PENDING",
      "The extension's payment has not been recorded yet — take the interim payment first, then commit the extension",
    );
  }
}
