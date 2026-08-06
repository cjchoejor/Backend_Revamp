import { QuotationState } from "@prisma/client";
import { PolicyGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 7 — Quotation lifecycle (StateTransitionError envelope preserved).
 */

/**
 * Once a proforma invoice exists on the current segment, the quotation is FINAL (2026-08-06,
 * operator ruling): the proforma is the billing document built on the quote's terms, so
 * renegotiating the quote in place would leave the guest billed on figures the quote no longer
 * says. From that point the formal path is the S3→S2 re-entry — a new segment with a fresh
 * quote and a fresh proforma. The caller resolves the live proforma (DB read); this guard only
 * rules on it. Stable code so frontends can pattern-match.
 */
export function enforceQuotationNotLockedByProforma(input: { liveProformaId: string | null }) {
  if (!input.liveProformaId) return;
  throw new PolicyGateBlockedError(
    "QUOTATION_LOCKED_BY_PROFORMA",
    `Proforma invoice ${input.liveProformaId} has been issued on this booking — the quotation is final from that point. To change the price, re-enter the booking to Quote (new segment with a fresh quote and proforma).`,
  );
}

export function enforceQuotationSupersedeAllowedState(input: { state: QuotationState }) {
  if (input.state === QuotationState.ACCEPTED) {
    throw new StateTransitionError("Cannot supersede an ACCEPTED quotation");
  }
  if (input.state === QuotationState.EXPIRED) {
    throw new StateTransitionError("Cannot supersede an EXPIRED quotation");
  }
  if (input.state === QuotationState.SUPERSEDED) {
    throw new StateTransitionError("Quotation already SUPERSEDED");
  }
}

export function enforceQuotationInDraftToSend(input: { state: QuotationState }) {
  if (input.state === QuotationState.DRAFT) return;
  throw new StateTransitionError("Only DRAFT quotations can be sent");
}

export function enforceQuotationSentToAccept(input: { state: QuotationState }) {
  if (input.state === QuotationState.SENT) return;
  throw new StateTransitionError("Only SENT quotations can be accepted");
}
