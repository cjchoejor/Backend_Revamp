import { QuotationState } from "@prisma/client";

/** SIG-S2 §3.4 — quotation version states governed at S2. */
export const S2_QUOTATION_STATES: QuotationState[] = [
  QuotationState.DRAFT,
  QuotationState.SENT,
  QuotationState.ACCEPTED,
  QuotationState.SUPERSEDED,
  QuotationState.EXPIRED,
];

export function isQuotationSealedOnS2Exit(state: QuotationState) {
  return state === QuotationState.ACCEPTED || state === QuotationState.SUPERSEDED || state === QuotationState.EXPIRED;
}
