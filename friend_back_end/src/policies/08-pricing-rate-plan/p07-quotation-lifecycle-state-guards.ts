import { QuotationState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 7 — Quotation lifecycle (StateTransitionError envelope preserved).
 */

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
