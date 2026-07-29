import type { QuotationSummary, SpeculativeHoldSummary } from "@/types/api";
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/**
 * Per-room composition captured at S2 quotation build (per-room track Phase B/E, 2026-07-27).
 * Mirrors the backend's `roomCompositionInputSchema` DTO. All fields optional so the operator
 * can progressively fill the form.
 */
export type RoomCompositionInput = {
  roomId: string;
  startDate?: string;
  endDate?: string;
  occupantCount?: number;
  adultCount?: number;
  cnb6To10Count?: number;
  cnbUnder6Count?: number;
  extraBedCount?: number;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
  mealPlanOthersCount?: number;
  othersBreakfastPax?: number;
  othersLunchPax?: number;
  othersDinnerPax?: number;
  negotiatedRoomRate?: number;
  negotiatedExtraBedRate?: number;
  negotiatedBreakfastRate?: number;
  negotiatedLunchRate?: number;
  negotiatedDinnerRate?: number;
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  isFoc?: boolean;
  /**
   * Per-night meal-plan overrides (2026-07-28). Each entry REPLACES the room-level meal
   * distribution for that one night; nights without an entry keep the room default. Dates are
   * ISO timestamps and must fall inside the stay — the backend rejects any that don't, since
   * a plan pinned outside the stay would silently never price.
   */
  nightMealOverrides?: RoomNightMealOverrideInput[];
};

export type RoomNightMealOverrideInput = {
  date: string;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
  mealPlanOthersCount?: number;
  othersBreakfastPax?: number;
  othersLunchPax?: number;
  othersDinnerPax?: number;
};

export async function createQuotation(
  session: Session,
  entryId: string,
  body?: {
    notes?: string;
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
    currency?: string;
    focRoomsRequested?: number;
    belowMsrGmWaiver?: { acknowledged: true; rationale: string };
    mealPlan?: "CP" | "MAP_LUNCH" | "MAP_DINNER" | "AP" | null;
    extraBedCount?: number;
    /** Per-room composition (Phase B/E). When supplied, backend uses per-room iteration. */
    roomCompositions?: RoomCompositionInput[];
  },
) {
  return apiRequest<QuotationSummary>(`/api/entries/${entryId}/quotations`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function supersedeQuotation(
  session: Session,
  quotationId: string,
  body?: {
    notes?: string;
    requestedDiscount?: { discountPercent: number; discountBasis: string } | null;
    /**
     * Renegotiated per-room compositions (2026-07-28). Send the editor's current state so
     * meal-plan / extra-bed / negotiated-rate changes re-price on the regenerated draft.
     * Omit to carry the prior version's compositions forward unchanged.
     */
    roomCompositions?: RoomCompositionInput[];
  },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/supersede`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

export async function applyQuotationDiscount(
  session: Session,
  quotationId: string,
  body: { discountPercent: number; discountBasis: string; belowMsrGmWaiver?: { acknowledged: true; rationale: string } },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/discount`, {
    method: "POST",
    session,
    body,
  });
}

export async function approveQuotationDiscount(session: Session, quotationId: string) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/discount/approve`, {
    method: "POST",
    session,
    body: {},
  });
}

export async function sendQuotation(
  session: Session,
  quotationId: string,
  body: {
    validDays?: number;
    sentTo?: string;
    channel?: string;
    recipientAddress?: string;
  },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/send`, {
    method: "POST",
    session,
    body,
  });
}

export async function acceptQuotation(
  session: Session,
  quotationId: string,
  body: { acceptanceMethod?: "WRITTEN" | "VERBAL"; verbatimNote?: string },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/accept`, {
    method: "POST",
    session,
    body,
  });
}

export async function resolveQuotationAckOpenLoop(
  session: Session,
  quotationId: string,
  body: {
    resolutionType?: "VERBAL_ACCEPTED" | "WRITTEN_ACCEPTED" | "CUSTODIAN_DECISION";
    note?: string;
    decisionReason?: string;
  },
) {
  return apiRequest<QuotationSummary>(`/api/quotations/${quotationId}/ack-open-loop/resolve`, {
    method: "POST",
    session,
    body,
  });
}

export async function autoFulfilS2ToS3(session: Session, entryId: string, version: number) {
  return apiRequest<{ id: string; currentStage: string; version: number }>(
    `/api/entries/${entryId}/s2/auto-fulfil-to-s3`,
    { method: "POST", session, body: { version } },
  );
}

export async function placeSpeculativeHold(
  session: Session,
  entryId: string,
  body: {
    roomId?: string;
    spaceId?: string;
    ttlSeconds?: number;
    commercialBasis: string;
    notes?: string;
  },
) {
  return apiRequest<SpeculativeHoldSummary>(`/api/entries/${entryId}/holds/speculative`, {
    method: "POST",
    session,
    body,
  });
}

export async function releaseSpeculativeHold(
  session: Session,
  entryId: string,
  holdId: string,
  body: { releaseReason: string },
) {
  return apiRequest<SpeculativeHoldSummary>(
    `/api/entries/${entryId}/holds/speculative/${holdId}/release`,
    { method: "POST", session, body },
  );
}
