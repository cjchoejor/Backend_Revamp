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

/** One room's line in the live pricing preview — every figure priced by the backend. */
export type QuotationLivePreviewRoom = {
  roomId: string;
  roomNumber: string | null;
  nights: number;
  /** Rates actually used — the negotiated one where set, else the resolved default. */
  roomRate: number;
  extraBedRate: number;
  breakfastRate: number;
  lunchRate: number;
  dinnerRate: number;
  extraBedCount: number;
  /** True when the mandatory extra bed (3+ adults, none supplied) was auto-added server-side
   *  (2026-08-12) — `extraBedCount` already includes it. The table derives the same bed
   *  client-side, so this mostly matters to other callers. */
  extraBedAutoAdded?: boolean;
  /** Meal covers per night (what `heads × rate` multiplies). */
  breakfastPax: number;
  lunchPax: number;
  dinnerPax: number;
  /** Whole-stay money per column, net of tax. */
  roomSubtotal: number;
  extraBedSubtotal: number;
  mealsSubtotal: number;
  breakfastSubtotal: number;
  lunchSubtotal: number;
  dinnerSubtotal: number;
  subtotal: number;
  serviceCharge: number;
  gst: number;
  /** Tax-inclusive total for this room, before any booking discount. */
  total: number;
  isFoc: boolean;
  /** True when per-date meal plans mean this room's meals are not one multiplication. */
  hasNightMealOverrides: boolean;
};

/** `POST /api/entries/:id/quotation-preview` — the quote's own arithmetic, nothing persisted. */
export type QuotationLivePreview = {
  entryId: string;
  currency: string;
  nights: number | null;
  gstRate: number;
  serviceChargeRate: number;
  rooms: QuotationLivePreviewRoom[];
  /** Per-column stay totals across every room (net of tax) — the Σ row under the rate columns. */
  columns: { room: number; extraBed: number; breakfast: number; lunch: number; dinner: number; meals: number };
  subtotal: number;
  serviceCharge: number;
  gst: number;
  grandTotal: number;
  discount: {
    requestedPercent: number | null;
    requestedAmount: number | null;
    amountOffTotal: number;
    effectivePercent: number;
    netReduction: number;
  } | null;
  payableSubtotal: number;
  payableServiceCharge: number;
  payableGst: number;
  /** What the guest pays. */
  payable: number;
};

/**
 * Live pricing for the composition table (2026-08-04 backend, first consumed 2026-08-07). The
 * desk may not compute money, so per-cell `heads × rate` figures, column totals and the running
 * grand total all come from here. POST because the compositions being priced are the editor's
 * unsaved state; the backend writes nothing.
 */
export async function previewQuotationPricing(
  session: Session,
  entryId: string,
  body: {
    roomCompositions: RoomCompositionInput[];
    /** Percent or flat amount off the grand total — at most one. */
    discount?: { percent?: number | null; amount?: number | null } | null;
  },
) {
  return apiRequest<QuotationLivePreview>(`/api/entries/${entryId}/quotation-preview`, {
    method: "POST",
    session,
    body,
  });
}

export async function createQuotation(
  session: Session,
  entryId: string,
  body?: {
    notes?: string;
    /** Percent or flat amount — exactly one; both are measured against the grand total. */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    /** Validity window in days, 1–30, ending before check-in — the clock starts at generation. */
    validDays?: number;
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
    /** Percent or flat amount — exactly one; both are measured against the grand total. */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    /** Validity of the regenerated draft — same rules as create, re-anchored to now. */
    validDays?: number;
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
