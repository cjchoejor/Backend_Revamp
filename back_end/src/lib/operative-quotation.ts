import { QuotationState } from "@prisma/client";

/**
 * Which quotation is the commercial basis for a segment.
 *
 * Background — generate vs send (operator ruling, 2026-07-28): **generating** a quotation is
 * mandatory to move a booking forward; **sending** it is not. A walk-in agreed at the desk, or a
 * booking the hotel prices internally, never needs an email to exist. Acceptance stays evidence
 * of what the guest said and so remains recordable only against something actually sent
 * (`enforceCommunicationDispatchedForAcknowledgement`) — which is exactly why acceptance cannot
 * also be the gate.
 *
 * Before this, S2→S3 and S4 confirmation both looked for `state === ACCEPTED` and nothing else,
 * so the only way forward was create → send → accept. This picks the operative quotation instead:
 *
 *   1. ACCEPTED — always wins. The guest agreed; that is the basis, whatever else exists.
 *   2. Otherwise the newest live quotation (SENT before DRAFT at equal version — a sent quote is
 *      the more committed artifact), by `versionNumber` then `createdAt`.
 *
 * SUPERSEDED and EXPIRED are never operative: a superseded quote has been explicitly replaced,
 * and an expired one failed its validity window. Returning either would freeze terms at S4 that
 * the hotel has already withdrawn.
 *
 * NOTE this is deliberately a *selector* over rows the caller already loaded — no DB access, no
 * money arithmetic. Callers keep their own validity/discount/approval guards; picking the
 * quotation and validating it are separate jobs.
 */

export type QuotationLike = {
  id: string;
  segmentId: string | null;
  state: QuotationState;
  versionNumber?: number | null;
  createdAt?: Date | null;
};

/** Quotation states that can still act as a commercial basis. */
const LIVE_STATES: readonly QuotationState[] = [QuotationState.ACCEPTED, QuotationState.SENT, QuotationState.DRAFT];

/** Higher wins. Keeps ACCEPTED strictly above SENT above DRAFT regardless of version ordering. */
function statePriority(state: QuotationState): number {
  switch (state) {
    case QuotationState.ACCEPTED:
      return 3;
    case QuotationState.SENT:
      return 2;
    case QuotationState.DRAFT:
      return 1;
    default:
      return 0;
  }
}

export function resolveOperativeQuotation<T extends QuotationLike>(
  quotations: readonly T[],
  segmentId: string,
): T | null {
  const candidates = quotations.filter((q) => q.segmentId === segmentId && LIVE_STATES.includes(q.state));
  if (candidates.length === 0) return null;

  return candidates.reduce((best, q) => {
    const bp = statePriority(best.state);
    const qp = statePriority(q.state);
    if (qp !== bp) return qp > bp ? q : best;
    const bv = best.versionNumber ?? 0;
    const qv = q.versionNumber ?? 0;
    if (qv !== bv) return qv > bv ? q : best;
    const bc = best.createdAt?.getTime() ?? 0;
    const qc = q.createdAt?.getTime() ?? 0;
    return qc > bc ? q : best;
  });
}

/** True when the operative quotation represents an acceptance the guest actually gave. */
export function isAcceptedQuotation(q: QuotationLike | null | undefined): boolean {
  return q?.state === QuotationState.ACCEPTED;
}
