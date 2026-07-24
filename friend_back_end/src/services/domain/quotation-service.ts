/**
 * SIG-S2 QuotationService — negotiation & quotation lifecycle at S2.
 * Implementation lives in `s2-quotation-service` (stage-scoped module naming).
 */
export {
  acceptQuotation,
  applyDiscount,
  approveDiscount,
  createGroupQuotation,
  createQuotation,
  expireQuotation,
  resolveAckOpenLoop,
  sendQuotation,
  supersedeQuotationWithNewDraft,
} from "./s2-quotation-service.js";
