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
  /** Extra beds on this night when it differs from the room's own count (2026-08-19). */
  extraBedCount?: number;
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

/**
 * One row as the quotation prints it (2026-10-27): a room, or — indented — its extra beds and
 * meals. Built by the server's `buildRoomPriceLines`, the same code that writes the paper.
 */
export type QuotationPriceLine = {
  dates?: string | null;
  description: string;
  qty: string;
  rate: number | null;
  amount: number;
  indent?: boolean;
  /** Says something, charges nothing — "Room only · no meals" (2026-10-30). */
  muted?: boolean;
};

/** `GET /api/quotations/:id/price-lines` — the quotation's rows and the figures under them. */
export type QuotationPriceLines = {
  quotationId: string;
  referenceNumber: string;
  versionNumber: number;
  state: string;
  lines: QuotationPriceLine[];
  datesShown: boolean;
  rowsAreNet: boolean;
  net: number;
  /** The net after a discount taken off it; null with none, or on an older flat-rate quotation. */
  netAfterDiscount: number | null;
  serviceChargeLabel: string;
  serviceCharge: number;
  gstLabel: string;
  gst: number;
  discountLabel: string | null;
  discountAmount: number | null;
  discountNote: string | null;
  total: number;
};

export async function getQuotationPriceLines(session: Session, quotationId: string) {
  return apiRequest<QuotationPriceLines>(`/api/quotations/${quotationId}/price-lines`, { session });
}

/** `POST /api/entries/:id/quotation-preview` — the quote's own arithmetic, nothing persisted. */
export type QuotationLivePreview = {
  entryId: string;
  currency: string;
  nights: number | null;
  gstRate: number;
  serviceChargeRate: number;
  rooms: QuotationLivePreviewRoom[];
  /** The table as the quotation would print it — rooms, then their beds and meals (2026-10-27). */
  lines: QuotationPriceLine[];
  datesShown: boolean;
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
    /** Percent or flat amount off the net value — at most one. */
    discount?: { percent?: number | null; amount?: number | null } | null;
    /** The nights each room is priced for, when the table knows better than the booking (a room change). */
    roomNights?: Record<string, number>;
    /** And which nights those are (YYYY-MM-DD), so per-night meals and beds price on them. */
    roomNightDates?: Record<string, string[]>;
    /** A stay the booking does not hold yet — its rates resolve for those nights (2026-10-29). */
    stay?: { checkInDate: string; checkOutDate: string };
  },
) {
  return apiRequest<QuotationLivePreview>(`/api/entries/${entryId}/quotation-preview`, {
    method: "POST",
    session,
    body,
  });
}

/** One stay's table in the trip's live price. */
export type TripPreviewStayInput = {
  entryId: string;
  roomCompositions: RoomCompositionInput[];
  discount?: { percent?: number | null; amount?: number | null } | null;
  roomNights?: Record<string, number>;
  roomNightDates?: Record<string, string[]>;
  /** The quotation it is saved on: its own rows are read instead of the table's. */
  quotationId?: string | null;
  /** Past Negotiation: the quotation this stay's bill reads, found by the server. */
  billQuotation?: boolean;
};

/** One stay of the trip's price: as quoted, or as the table stands. */
export type TripPriceStay = {
  entryId: string;
  checkIn: string | null;
  checkOut: string | null;
  source: "QUOTE" | "TABLE";
  quote: QuotationPriceLines | null;
  preview: QuotationLivePreview | null;
  payable: number;
};

/** The stays worked in one table priced together: the trip's figures are added up on the server. */
export async function previewTripQuotations(session: Session, entryId: string, stays: TripPreviewStayInput[]) {
  return apiRequest<{
    inquiryId: string;
    currency: string;
    stays: TripPriceStay[];
    totals: { subtotal: number; netReduction: number; payableSubtotal: number; payableServiceCharge: number; payableGst: number; payable: number };
  }>(`/api/entries/${entryId}/quotation-preview/trip`, { method: "POST", session, body: { stays } });
}

export async function createQuotation(
  session: Session,
  entryId: string,
  body?: {
    notes?: string;
    /** Percent or flat amount — exactly one; both come off the net value. */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    /** How long the offer stands: days up to check-in, or hours when check-in is today. */
    validDays?: number;
    validHours?: number;
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
    /** Percent or flat amount — exactly one; both come off the net value. */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    /** Validity of the regenerated draft — same rules as create, re-anchored to now. */
    validDays?: number;
    validHours?: number;
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
    validHours?: number;
    sentTo?: string;
    channel?: string;
    recipientAddress?: string;
    /** Attach the copy with no money on it — the offer and the stored record are unchanged. */
    hidePrices?: boolean;
    /** Attach the copy with every night named (2026-10-30). */
    nightsEach?: boolean;
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

/** How long a quotation on this booking may stand: the hotel's rule, never a setting (2026-11-05). */
export type QuoteValidityWindow = { mode: "DAYS" | "HOURS"; max: number; checkIn: string | null };

export async function getQuoteValidityWindow(session: Session, entryId: string) {
  return apiRequest<QuoteValidityWindow>(`/api/entries/${entryId}/quote-validity`, { session });
}
