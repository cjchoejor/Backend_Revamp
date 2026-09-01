import type { EntryDetail, EntryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
import type { TraceEvent } from "@/lib/trace/humanize";
import type { RoomCompositionInput } from "./quotations";
import { apiRequest } from "./client";

export type ListEntriesParams = {
  limit?: number;
  inquiryId?: string;
  status?: string;
  currentStage?: string;
};

export async function listEntries(session: Session, params?: ListEntriesParams) {
  const q = new URLSearchParams();
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.inquiryId) q.set("inquiryId", params.inquiryId);
  if (params?.status) q.set("status", params.status);
  if (params?.currentStage) q.set("currentStage", params.currentStage);
  const qs = q.toString();
  return apiRequest<ListResponse<EntryListItem>>(`/api/entries${qs ? `?${qs}` : ""}`, { session });
}

export async function getEntry(session: Session, entryId: string) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}`, { session });
}

export async function getEntryTrace(session: Session, entryId: string, limit = 100) {
  return apiRequest<{ items: TraceEvent[]; count: number }>(
    `/api/entries/${entryId}/trace?limit=${limit}`,
    { session },
  );
}

/**
 * The four governed guest-facing communications and their acknowledgement state — quotation (S2),
 * proforma invoice (S3), confirmation voucher (S4), pre-arrival reminder (S5).
 *
 * `canAcknowledge` / `isOverdue` are computed by the backend, not here: an acknowledgement is only
 * recordable against something actually dispatched, and that rule belongs on the server so both
 * frontends obey it.
 */
export type EntryCommunicationType =
  | "QUOTATION"
  | "PROFORMA_INVOICE"
  | "CONFIRMATION_VOUCHER"
  | "PRE_ARRIVAL_REMINDER"
  // Final bill (2026-08-17): guest's answer captured as evidence beside the OUTSTANDING follow-up.
  | "FINAL_INVOICE"
  // Interim bill mid-stay (2026-08-21): the answer GATES the interim payment (Policy 80).
  | "INTERIM_INVOICE";

export type EntryCommunication = {
  id: string;
  commType: EntryCommunicationType;
  channel: string;
  stageContext: string | null;
  direction: string | null;
  sendStatus: string | null;
  acknowledgementStatus: string | null;
  acknowledgementReceivedAt: string | null;
  acknowledgementTimeoutAt: string | null;
  contentSummary: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string;
  canAcknowledge: boolean;
  isOverdue: boolean;
};

export async function listEntryCommunications(session: Session, entryId: string) {
  return apiRequest<{ entryId: string; items: EntryCommunication[] }>(
    `/api/entries/${entryId}/communications`,
    { session },
  );
}

/**
 * Record that the guest accepted / acknowledged a sent communication (L1+). Closes the W22
 * acknowledgement window and writes the evidence to the trace. A VERBAL acknowledgement requires
 * `verbatimNote` — what the guest actually said is the evidence.
 *
 * Mostly evidence: the one gate it feeds is the S3→S4 freeze, which requires a DISPATCHED
 * proforma's answer to be recorded (backend p40, 2026-07-31). Other types never gate progression.
 */
export async function acknowledgeCommunication(
  session: Session,
  communicationId: string,
  body: { method: "WRITTEN" | "VERBAL"; verbatimNote?: string; receivedAt?: string },
) {
  return apiRequest<EntryCommunication>(`/api/communications/${communicationId}/acknowledge`, {
    method: "POST",
    session,
    body,
  });
}

export async function createEntry(
  session: Session,
  body: {
    inquiryId: string;
    useType: string;
    guestProfileId?: string;
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    numberOfRooms?: number;
    /** Bed-setup breakdown ("5 King + 2 Twin"), map bedType → count (2026-08-13). */
    bedTypeRequest?: Record<string, number>;
    contactPersonName?: string;
    contactPersonPhone?: string;
    otaSource?: boolean;
  },
) {
  return apiRequest<EntryDetail>("/api/entries", {
    method: "POST",
    session,
    body,
  });
}

export type TimerRecordSummary = {
  id: string;
  timerType: string;
  timerCode: string;
  stageContext: string | null;
  firesAt: string;
  warningAt: string | null;
  criticalAt: string | null;
  status: string;
  createdAt: string;
};

export async function getEntryTimers(session: Session, entryId: string) {
  return apiRequest<{ items: TimerRecordSummary[]; count: number }>(`/api/entries/${entryId}/timers`, { session });
}

/** Narrow update for the booking flow's "Edit step 1" affordance. S1-only on the server side. */
export async function updateEntryIntake(
  session: Session,
  entryId: string,
  body: {
    checkInDate?: string;
    checkOutDate?: string;
    guestCount?: number;
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    numberOfRooms?: number;
    /** Bed-setup breakdown ("5 King + 2 Twin"). Explicit null clears the stored request. */
    bedTypeRequest?: Record<string, number> | null;
    contactPersonName?: string;
    contactPersonPhone?: string;
    useType?: string;
    expectedVersion?: number;
  },
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}`, {
    method: "PATCH",
    session,
    body,
  });
}

/**
 * L3+ manual override of Policy 64's auto-classification. Pass `mode = null` to clear, or
 * `clearManualOverride: true` to re-enable auto-reclassify on subsequent intake edits.
 */
export async function setGroupBillingMode(
  session: Session,
  entryId: string,
  body: {
    mode: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null;
    reason: string;
    clearManualOverride?: boolean;
  },
) {
  return apiRequest<EntryDetail>(`/api/entries/${entryId}/group-billing-mode`, {
    method: "PATCH",
    session,
    body,
  });
}

/** S3→S4 confirm historically returned `{ reservation, entry }`; normalize to EntryDetail. */
export function normalizeEntryResponse(data: unknown): EntryDetail {
  if (data && typeof data === "object" && "entry" in data && (data as { entry?: EntryDetail }).entry) {
    return (data as { entry: EntryDetail }).entry;
  }
  return data as EntryDetail;
}

/**
 * Park an entry — a governed temporary hold on any ACTIVE entry at any live stage
 * (DEV-SPEC-001 Part 3 §3.2.8; restated per-stage in SIG-S1 §3.3, SIG-S2 §3.3, SIG-S3 §3,
 * SIG-S4 §3.1, SIG-S5 §3.1), L1+. Pauses the booking without losing its place: the short
 * stage-expiry timer is cancelled and a long park-expiry one armed. Stage-specific clocks
 * (quotation validity, no-show cutoff) deliberately keep running. While PARKED the entry
 * cannot be progressed — resume it first. `reason` is REQUIRED (max 500 chars), recorded
 * on the trace.
 */
/**
 * Per-room key lifecycle (2026-08-14): issue THIS room's key (S6–S7). The backend hard-gates
 * a sequential room change — the new room's key is refused (409 PRIOR_ROOM_KEY_OUTSTANDING)
 * while the vacated room's key is still with the guest.
 */
export async function issueRoomKey(session: Session, entryId: string, roomId: string) {
  return apiRequest<{ roomNumber: string; reissue: boolean }>(
    `/api/entries/${entryId}/rooms/${roomId}/key-issued`,
    { method: "POST", session },
  );
}

/**
 * Every key the guest can hold right now, in one act (2026-08-19). The SET is decided server-side
 * (rooms in use today; the sequential-swap gate holds inside the batch), so the desk shows the
 * answer and never derives it — `skipped[]` names each room left out and why.
 */
export type BulkKeyIssueOutcome = {
  entryId: string;
  stage: string;
  issued: Array<{ roomId: string; roomNumber: string; reissue: boolean }>;
  skipped: Array<{
    roomId: string;
    roomNumber: string;
    reason: "ALREADY_OUT" | "PRIOR_ROOM_KEY_OUTSTANDING" | "NOT_YET_OCCUPIED";
    blockedBy: Array<{ roomId: string; roomNumber: string }>;
    movesInOn: string | null;
  }>;
};

export async function issueAllRoomKeys(session: Session, entryId: string, roomIds?: string[]) {
  return apiRequest<BulkKeyIssueOutcome>(`/api/entries/${entryId}/rooms/keys/issue-all`, {
    method: "POST",
    session,
    body: roomIds?.length ? { roomIds } : {},
  });
}

/** Record THIS room's key back at the desk mid-stay — the vacated half of a key swap (S6–S8). */
export async function returnRoomKey(session: Session, entryId: string, roomId: string) {
  return apiRequest<{ roomNumber: string }>(
    `/api/entries/${entryId}/rooms/${roomId}/key-returned`,
    { method: "POST", session },
  );
}

export async function parkEntry(session: Session, entryId: string, reason: string) {
  const data = await apiRequest<unknown>(`/api/entries/${entryId}/park`, {
    method: "POST",
    session,
    body: { reason },
  });
  return normalizeEntryResponse(data);
}

/** Unpark a parked entry — returns it to ACTIVE at its current stage (SIG-S1 §3.4). */
export async function unparkEntry(session: Session, entryId: string) {
  const data = await apiRequest<unknown>(`/api/entries/${entryId}/unpark`, {
    method: "POST",
    session,
    body: {},
  });
  return normalizeEntryResponse(data);
}

// --- Booking journey summary (the "S1–S4 handoff summary") --------------------------------
// Read-only staff-facing recap of everything the customer chose/did S1→S4, aggregated backend-
// side from the records that back each stage. Shape mirrors the backend
// `BookingJourneySummary` in booking-journey-summary-service.ts.

export type JourneySectionStatus = "COMPLETE" | "READY" | "IN_PROGRESS" | "NOT_STARTED";
export type JourneyRoomRef = {
  roomId: string;
  roomNumber: string | null;
  roomTypeCode: string | null;
  roomTypeName: string | null;
};
export type JourneySectionTimeline = { enteredAt: string | null; exitedAt: string | null };

export type BookingJourneySummary = {
  entryId: string;
  inquiryReference: string | null;
  generatedAt: string;
  currentStage: string;
  status: string;
  segmentNumber: number;
  useType: string;
  groupBillingMode: string | null;
  guest: {
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    email: string | null;
    nationality: string | null;
    vipTier: string | null;
    clientTier: string | null;
  };
  s1Inquiry: {
    status: JourneySectionStatus;
    timeline: JourneySectionTimeline;
    receivedAt: string | null;
    takenBy: string | null;
    availabilitySearches: number;
    selectionSealedAt: string | null;
    selectionSealedBy: string | null;
    sourceChannel: string | null;
    party: {
      adults: number | null;
      children: number | null;
      childAges: number[];
      totalGuests: number | null;
      roomsRequested: number | null;
    };
    dates: { checkIn: string | null; checkOut: string | null; nights: number | null };
    contactPerson: { name: string | null; phone: string | null };
    commercialContext: {
      type: "TRAVEL_AGENT" | "CORPORATE" | "NONE";
      partyName: string | null;
      coordinator: string | null;
      contractRef: string | null;
      gstNumber: string | null;
    };
    roomSelection: {
      shape: "single" | "whole-stay-multi" | "per-night" | "none";
      rooms: JourneyRoomRef[];
      perNight: Array<{ date: string; rooms: JourneyRoomRef[] }> | null;
      distinctRoomCount: number;
      anyDeficient: boolean;
    };
    notes: string | null;
  };
  s2Quote: {
    status: JourneySectionStatus;
    timeline: JourneySectionTimeline;
    hasAcceptedQuotation: boolean;
    versionsIssued: number;
    reference: string | null;
    versionNumber: number | null;
    state: string | null;
    draftedAt: string | null;
    draftedBy: string | null;
    sentAt: string | null;
    sentTo: string | null;
    discount: { percent: number; basis: string | null } | null;
    agentRateDetail: { partyType: string | null; roomRate: number | null; cnbPercent: number | null; source: string | null } | null;
    speculativeHold: { state: string; roomNumber: string | null; placedAt: string | null; expiresAt: string | null } | null;
    acceptedByName: string | null;
    currency: string | null;
    nightlyRate: number | null;
    roomCount: number | null;
    nights: number | null;
    total: number | null;
    inclusions: string[];
    mealPlan: string | null;
    discountRequested: unknown | null;
    belowMsr: boolean | null;
    agentRate: unknown | null;
    standardPricing: unknown | null;
    focRoomsRequested: number | null;
    validUntil: string | null;
    acceptedAt: string | null;
    acceptedBy: string | null;
    lines: Array<{
      date: string | null;
      occupants: string | null;
      mealPlan: string | null;
      extraBeds: string | null;
      amount: number | null;
    }>;
  };
  s3Setup: {
    status: JourneySectionStatus;
    timeline: JourneySectionTimeline;
    billingModel: string | null;
    folioState: string | null;
    committedHold: {
      state: string | null;
      rooms: JourneyRoomRef[];
      expiresAt: string | null;
      placedAt: string | null;
      placedBy: string | null;
      justification: string | null;
    } | null;
    advancePayment: {
      satisfied: boolean;
      requiredAmount: number | null;
      totalReceived: number | null;
      shortfall: number | null;
      creditExtensionActive: boolean;
      ceilingAmount: number | null;
      requirementSource: "OPERATOR" | "CONFIG" | null;
      requirementBasis: unknown | null;
      creditExtensionExpiresAt: string | null;
      creditExtensionExpired: boolean;
      groupBoostApplied: { multiplierPercent: number; baseAmount: number } | null;
      advanceWindow: { opensAt: string | null; deadline: string | null; active: boolean; overdue: boolean } | null;
    } | null;
    payments: Array<{
      id: string;
      amount: number | null;
      method: string | null;
      receivedAt: string | null;
      recordedBy: string | null;
      notes: string | null;
    }>;
    cancellation: { disclosed: boolean; noShowTreatment: string | null; disclosedAt: string | null; disclosedBy: string | null } | null;
    proformaInvoiceRef: string | null;
    proforma: {
      id: string;
      invoiceNumber: string | null;
      versionNumber: number;
      state: string;
      totalAmount: number | null;
      createdAt: string | null;
      dispatchedAt: string | null;
      dispatchedTo: string | null;
      priorVersions: number;
    } | null;
    coordinator: string | null;
  };
  s4Confirmation: {
    status: JourneySectionStatus;
    timeline: JourneySectionTimeline;
    confirmed: boolean;
    reservationId: string | null;
    frozenRate: number | null;
    frozenRatePlanId: string | null;
    frozenBillingModel: string | null;
    frozenCheckIn: string | null;
    frozenCheckOut: string | null;
    frozenNights: number | null;
    frozenGuestCount: number | null;
    creditCeilingIfExtended: number | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
    confirmedByName: string | null;
    voucherSent: boolean;
    voucherRenderedAt: string | null;
  };
};

export async function getJourneySummary(session: Session, entryId: string) {
  return apiRequest<BookingJourneySummary>(`/api/entries/${entryId}/journey-summary`, { session });
}

// --- Billing summary (2026-08-13) -----------------------------------------------------------
// The booking's money position in one read — drives the workspace header's live total and its
// click-through breakdown. All figures are computed server-side (Decimal); the desk only renders.

export type EntryBillingSummary = {
  entryId: string;
  generatedAt: string;
  currency: string | null;
  headline: { amount: number | null; kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null; frozen: boolean };
  stayTotal: {
    amount: number | null;
    basis: "COMPOSITION_STAY_TOTAL" | "PER_NIGHT_TIMES_NIGHTS" | null;
    frozen: boolean;
    quotationId: string | null;
    quotationState: string | null;
    segmentNumber: number | null;
    nights: number | null;
    perNightAmount: number | null;
    /** Early departure (2026-08-22): `amount` is already the shortened stay total; this says by how much. */
    earlyDeparture?: {
      departureDate: string;
      originalCheckOutDate: string;
      sleptNights: number;
      unstayedNights: number;
      forgoneRoomTotal: number;
      bookedStayTotal: number | null;
      feeAmount: number;
      feeWaived: boolean;
    } | null;
  };
  /** Per-room price breakdown from the stored composition (null on flat-path quotes). */
  rooms: Array<{
    roomId: string | null;
    roomNumber: string | null;
    roomTypeName: string | null;
    nights: number | null;
    isFoc: boolean;
    occupants: { adults: number; children6To10: number; childrenUnder6: number } | null;
    extraBedCount: number;
    mealCounts: { cp: number; mapl: number; mapd: number; ap: number; others: number } | null;
    mealsVaryByNight: boolean;
    /** NET components: roomRate × nights / bedRate × beds × nights / stored child-banded meals. */
    roomSubtotal: number | null;
    extraBedSubtotal: number | null;
    mealsSubtotal: number | null;
    serviceCharge: number | null;
    gst: number | null;
    /** Tax-inclusive room total (post-discount when a booking discount applies). */
    total: number | null;
    componentsPreDiscount: boolean;
  }> | null;
  folio: {
    state: string;
    billedSoFar: number | null;
    lineCount: number;
    paymentsReceived: number | null;
    refunded: number | null;
    writtenOff: number | null;
    outstandingBalance: number | null;
    /** Per-room charge subtotals (2026-08-14) — server-summed; null when no line carries a room.
     *  `base` / `serviceCharge` / `gst` (2026-08-21) split the bucket for the per-room tabs;
     *  base + serviceCharge + gst = charges. */
    perRoomCharges: Array<{
      roomId: string;
      roomNumber: string | null;
      charges: number;
      lineCount: number;
      base: number;
      serviceCharge: number;
      gst: number;
    }> | null;
    /** Net sum + count of booking-wide (roomless) lines, with the same tax split. Null when none. */
    unassignedCharges: { charges: number; lineCount: number; base: number; serviceCharge: number; gst: number } | null;
    /** Whole-ledger tax split — base + serviceCharge + gst = billedSoFar. Null when no lines. */
    chargeBreakdown: { base: number; serviceCharge: number; gst: number; total: number } | null;
  } | null;
};

export async function getBillingSummary(session: Session, entryId: string) {
  return apiRequest<EntryBillingSummary>(`/api/entries/${entryId}/billing-summary`, { session });
}

// --- Segment history (per-pass record, Implementation Reference §1.2 / §6.2) ----------------
// One Segment per pass through the stages; re-entry seals the current one and opens the next.
// Shape mirrors the backend `SegmentHistory` in segment-history-service.ts.

export type SegmentHistoryItem = {
  id: string;
  segmentNumber: number;
  openedAtStage: string;
  startedAt: string;
  sealedAt: string | null;
  sealedBy: string | null;
  sealedByName: string | null;
  createdBy: string;
  createdByName: string | null;
  isActive: boolean;
  openReason: string | null;
  openedBy: { modeKey: string | null; fromStage: string | null; toStage: string | null } | null;
  sealCause: string | null;
  stagePath: string[];
  /** The S1 searches + room selections made inside this segment, oldest first. */
  availabilityConfigs: Array<{
    id: string;
    checkInDate: string | null;
    checkOutDate: string | null;
    guestCount: number | null;
    roomTypeId: string | null;
    selectionShape: "single" | "whole-stay-multi" | "per-night" | "none";
    rooms: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null }>;
    perNight: Array<{ date: string; rooms: Array<{ roomId: string; roomNumber: string | null }> }> | null;
    sealedAt: string | null;
    isStale: boolean;
    createdAt: string;
    recalledFromSegmentNumber: number | null;
  }>;
  reservation: {
    id: string;
    frozenRate: number | null;
    frozenCheckIn: string | null;
    frozenCheckOut: string | null;
    frozenGuestCount: number | null;
    frozenBillingModel: string | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
    confirmedByName: string | null;
  } | null;
  quotations: Array<{
    id: string;
    referenceNumber: string | null;
    versionNumber: number;
    state: string;
    totalAmount: number | null;
    currency: string | null;
    acceptedAt: string | null;
  }>;
  amendments: Array<{
    id: string;
    amendmentPath: string;
    amendmentType: string;
    reason: string;
    stageAtAmendment: string;
    createdAt: string;
  }>;
  billingModelTransitions: Array<{
    fromModel: string | null;
    toModel: string;
    changeSource: string | null;
    createdAt: string;
  }>;
  speculativeHoldCount: number;
};

export type SegmentHistory = {
  entryId: string;
  generatedAt: string;
  currentStage: string;
  status: string;
  currentSegmentNumber: number;
  segments: SegmentHistoryItem[];
};

export async function getSegmentHistory(session: Session, entryId: string) {
  return apiRequest<SegmentHistory>(`/api/entries/${entryId}/segments`, { session });
}

// --- Cross-segment configuration recall ("reuse a prior segment") ------------------------------
// Canon Block 10 §59: recall-plus-revalidate, never a blind copy. The prior segment's sealed
// configuration is never modified; the engine re-runs against present state and a NEW
// configuration derived from it lands on the current segment. Any material change requires
// L2/FOM authority to apply (backend returns PolicyGateBlockedError `AUTH_REQUIRED_L2`).

export type RecallViabilityDelta = {
  availabilityChanged: boolean;
  deficientStatusChanged: boolean;
  pricingChanged: boolean;
  availabilityDelta: Array<{ roomId: string; roomNumber: string | null; was: string; now: string }> | null;
  deficientDelta: Array<{
    roomId: string;
    roomNumber: string | null;
    wasDeficient: boolean;
    nowDeficient: boolean;
    category: string | null;
  }> | null;
  pricingDelta: Array<{
    roomId: string;
    roomNumber: string | null;
    wasRate: number | null;
    nowRate: number | null;
    currency: string | null;
  }> | null;
};

export type SegmentRecallOutcome = {
  entryId: string;
  fromSegmentNumber: number;
  toSegmentNumber: number;
  sourceConfigurationId: string;
  recalledSelection: {
    shape: "single" | "whole-stay-multi" | "per-night" | "none";
    rooms: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null }>;
    distinctRoomCount: number;
  };
  searchCriteria: Record<string, unknown>;
  delta: RecallViabilityDelta;
  requiresFomDecision: boolean;
  materialChanges: string[];
  droppedRooms: Array<{ roomId: string; roomNumber: string | null; reason: string }>;
  applied: boolean;
  newConfigurationId: string | null;
  result: unknown;
};

/**
 * Revalidate a prior segment's configuration. `apply: false` (default) previews — runs every
 * viability check and returns the delta without writing. `apply: true` commits the derived
 * configuration onto the current segment.
 */
export async function recallSegment(
  session: Session,
  entryId: string,
  fromSegmentNumber: number,
  body?: { apply?: boolean; reason?: string },
) {
  return apiRequest<SegmentRecallOutcome>(`/api/entries/${entryId}/segments/${fromSegmentNumber}/recall`, {
    method: "POST",
    session,
    body: body ?? {},
  });
}

/**
 * Duplicate a segment: open a NEW segment (via a governed re-entry) and carry the source
 * segment's basis into it (via recall-plus-revalidate). `prefilled: false` + `recallBlocked`
 * means the new segment WAS created but the basis needs FOM approval before it carries over.
 */
export type SegmentDuplicateOutcome = {
  entryId: string;
  fromSegmentNumber: number;
  newSegmentNumber: number;
  fromStage: string;
  toStage: string;
  duplicated: true;
  prefilled: boolean;
  recall: SegmentRecallOutcome | null;
  recallBlocked: { code: string | null; message: string; materialChanges: string[] } | null;
};

/** Legal stages a duplicate can open at, keyed by the entry's current stage (mirrors backend). */
export const DUPLICATE_ROUTES: Record<string, string[]> = {
  S2: ["S1"],
  S3: ["S1", "S2"],
  S4: ["S1", "S2", "S3"],
  S5: ["S1"],
  S7: ["S2", "S3"],
};

export async function duplicateSegment(
  session: Session,
  entryId: string,
  fromSegmentNumber: number,
  body: { toStage: string; reason: string },
) {
  return apiRequest<SegmentDuplicateOutcome>(`/api/entries/${entryId}/segments/${fromSegmentNumber}/duplicate`, {
    method: "POST",
    session,
    body,
  });
}

export async function progressStage(
  session: Session,
  entryId: string,
  body: {
    targetStage: string;
    version: number;
    guestPhysicallyPresent?: boolean;
    transitionData?: Record<string, unknown>;
  },
) {
  const data = await apiRequest<unknown>(`/api/entries/${entryId}/progress-stage`, {
    method: "POST",
    session,
    body,
  });
  return normalizeEntryResponse(data);
}

/**
 * Rate reference for the S2 composition editors (2026-08-01). One item per sealed room type:
 * the per-night room rate the backend will price with when no negotiated rate is typed
 * (agent/corporate card incl. per-type override, else standard rate plan), the card's
 * extra-bed/meal add-on rates, and the standard rate + MSR as the negotiation floor.
 * Backend-authoritative — displayed verbatim, never re-computed here.
 */
export type RoomTypeRateReference = {
  roomTypeId: string;
  code: string | null;
  name: string;
  roomNumbers: string[];
  roomRate: number | null;
  roomRateSource: "AGENT_RATE_PACKAGE" | "STANDARD_RATE_PLAN" | null;
  /** Which named package supplied the rate — "Season", "Premium". Null when standard. */
  packageName?: string | null;
  standardRate: number | null;
  msrValue: number | null;
  extraBedRate: number | null;
  breakfastRate: number | null;
  lunchRate: number | null;
  dinnerRate: number | null;
};

export type EntryRateReference = {
  entryId: string;
  currency: string;
  nights: number | null;
  gstRate: number;
  serviceChargeRate: number;
  party: { type: "TRAVEL_AGENT" | "CORPORATE"; id: string; name: string } | null;
  roomTypes: RoomTypeRateReference[];
};

export async function getRateReference(session: Session, entryId: string) {
  return apiRequest<EntryRateReference>(`/api/entries/${entryId}/rate-reference`, { session });
}

/**
 * Competing claims (2026-08-06): other live bookings holding a quotation / proforma / hold /
 * reservation over any of the same (room, night) pairs as this booking's sealed selection.
 * Advisory — the first committed hold wins the room; Policy 26 enforces the outcome.
 */
export type CompetingClaimItem = {
  entryId: string;
  reference: string | null;
  guestName: string | null;
  currentStage: string;
  kind: "RESERVED" | "COMMITTED_HOLD" | "SPECULATIVE_HOLD" | "PROFORMA_INVOICE" | "QUOTATION";
  documentId: string | null;
  documentState: string | null;
  dispatched: boolean;
  roomNumbers: string[];
};

export type CompetingClaims = {
  checkIn: string | null;
  checkOut: string | null;
  roomNumbers: string[];
  items: CompetingClaimItem[];
};

export async function getCompetingClaims(session: Session, entryId: string) {
  return apiRequest<CompetingClaims>(`/api/entries/${entryId}/competing-claims`, { session });
}

/**
 * In-place room change (2026-08-12) — swap ONE room of the plan from S5/S6/S7 without leaving
 * the page. The backend runs the full governed journey: new segment, substituted basis
 * revalidated with the S1 availability predicates, silent re-quote (nothing sent to the guest;
 * the PI is not re-issued; the advance already paid stands), then the walk back to the origin
 * stage server-side.
 */
export type RoomChangeCandidate = {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName: string | null;
  bedType: string | null;
  sameType: boolean;
  physicalState: string;
  isDeficient: boolean;
  nights: number;
  /** S1-style standing over the substitution nights (2026-08-13) — only FREE is pickable. */
  availability: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE";
  selectable: boolean;
  /** Authority the pick needs (p58): same-type L1, cross-type (upgrade/downgrade) L2. */
  requiredLevel: "L1" | "L2";
  claimedBy: {
    guestName: string | null;
    bookingRef: string | null;
    startDate: string;
    endDate: string;
    holdKind: "COMMITTED" | "SPECULATIVE" | null;
  } | null;
  blockedReason: string | null;
  /** Night-by-night standing over the substitution nights (2026-08-14) — every stay night with
   *  its date, so a multi-night stay sees the whole picture, not just check-in night. */
  perNight: Array<{
    date: string;
    status: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE";
    claimedBy: { guestName: string | null; bookingRef: string | null; holdKind: "COMMITTED" | "SPECULATIVE" | null } | null;
  }>;
  freeNightCount: number;
};

export type RoomChangeCandidates = {
  entryId: string;
  originStage: string;
  fromRoom: { roomId: string; roomNumber: string; roomTypeId: string; roomTypeName: string | null };
  substitutionNights: string[];
  candidates: RoomChangeCandidate[];
};

export type RoomChangeOutcome = {
  entryId: string;
  originStage: string;
  newSegmentNumber: number;
  fromRoom: { roomId: string; roomNumber: string; roomTypeName: string | null };
  /** The primary replacement (the new room covering the most nights). */
  toRoom: { roomId: string; roomNumber: string; roomTypeName: string | null };
  /** Every NEW room with the nights it covers (per-night form; simple swap = one entry). */
  toRooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; nights: string[] }>;
  /** Nights the guest keeps the from-room for (per-night form; empty on a full swap). */
  keptNights: string[];
  /** True when nothing moved — a SETUP-ONLY change (extra beds / meals / a full re-price) on
   *  the from-room itself (2026-08-19): `toRoom` === `fromRoom`, `toRooms` empty. */
  setupOnly: boolean;
  /** True when a FULL composition table was the basis, not a field patch (2026-08-19). */
  repriced: boolean;
  /** True when the change moved a negotiated rate, an FOC / SC waiver, or the discount. */
  commercialTermsChanged: boolean;
  sameType: boolean;
  substitutionNights: string[];
  pricing: { priorTotal: number | null; newTotal: number | null; delta: number | null; currency: string | null };
  quotationId: string | null;
  /** The primary new room's bed setup after the change, when one was asked for (2026-08-14). */
  appliedBedType?: string | null;
  appliedBedTypes?: Array<{ roomId: string; roomNumber: string; bedType: string }>;
  /**
   * Party seating after the change (2026-08-21): the backend guarantees every guest has a room
   * on every night and no plan room is empty. `repaired` = the compositions did NOT satisfy that
   * on their own and were auto-seated; `lines` say exactly what moved (toast them); `unresolved`
   * what could not be seated. Null on bookings with no composition at all.
   */
  seating?: { repaired: boolean; lines: string[]; actions: unknown[]; unresolved: string[] } | null;
  /** Set when the walk was a stay extension (2026-08-21). */
  extension?: { requestId: string; priorCheckOutDate: string; newCheckOutDate: string; extraNights: Array<{ date: string; roomId: string }> } | null;
  walk: {
    returnedToOrigin: boolean;
    reachedStage: string;
    blocked: { atStep: string; code: string | null; message: string } | null;
  };
};

/** Server-computed seating truth — `GET /api/entries/:id/party-seating` (2026-08-21). */
export type PartySeatingStatus = {
  entryId: string;
  currentStage: string;
  hasComposition: boolean;
  source: string;
  ok: boolean;
  party: Array<{ key: string; label: string; band: string; rooms: Array<{ roomId: string; roomNumber: string | null }> }>;
  unseated: Array<{ key: string; label: string }>;
  emptyRooms: Array<{ roomId: string; roomNumber: string | null; hasRow: boolean }>;
  strayRooms: Array<{ roomId: string; roomNumber: string | null }>;
  perNight: Array<{ date: string; shortfall: Record<string, number>; overflow: Record<string, number> }>;
  repairable: boolean;
  repairBlockedReason: string | null;
  suggestedFromRoomId: string | null;
};

export async function getPartySeating(session: Session, entryId: string) {
  return apiRequest<PartySeatingStatus>(`/api/entries/${entryId}/party-seating`, { session });
}

/**
 * Seat every guest and fill every empty room — the governed room-change journey in its
 * setup-only form (new segment, silent re-quote with everyone seated, re-freeze, back to this
 * stage; nobody moves rooms, nothing goes to the guest). Refused when there's nothing to repair.
 */
export async function repairPartySeating(session: Session, entryId: string, reason?: string) {
  return apiRequest<RoomChangeOutcome>(`/api/entries/${entryId}/party-seating/repair`, {
    method: "POST",
    session,
    body: reason ? { reason } : {},
  });
}

/** Optional setup for one NEW room, priced by the silent quote (2026-08-14). Omitted = carried. */
export type RoomChangeAdjustments = {
  bedType?: string;
  extraBedCount?: number;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
};

export async function listRoomChangeCandidates(session: Session, entryId: string, fromRoomId: string) {
  return apiRequest<RoomChangeCandidates>(
    `/api/entries/${entryId}/room-change/candidates?fromRoomId=${encodeURIComponent(fromRoomId)}`,
    { session },
  );
}

export async function changeBookingRoom(
  session: Session,
  entryId: string,
  input: {
    fromRoomId: string;
    /** One room for every night of the change… */
    toRoomId?: string;
    /** …or a room per night, S1-table style (may name the from-room on kept nights)… */
    perNight?: Array<{ date: string; roomId: string }>;
    reason: string;
    /** …or NEITHER, with `adjustments` alone: a setup-only change on the from-room itself
     *  (2026-08-19 — extra beds / meals re-priced on the same room, same governed journey). */
    adjustments?: RoomChangeAdjustments;
    roomSetups?: Array<RoomChangeAdjustments & { roomId: string }>;
    /**
     * FULL re-price basis (2026-08-19): the S2 negotiation table's own emission, one row per
     * room of the resulting plan — replaces the carried compositions outright rather than
     * patching them. Sent ALONE (never with adjustments / roomSetups).
     */
    roomCompositions?: RoomCompositionInput[];
    /** Omitted carries the prior quote's discount; explicit null clears it. */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  },
) {
  return apiRequest<RoomChangeOutcome>(`/api/entries/${entryId}/room-change`, {
    method: "POST",
    session,
    body: input,
  });
}

/**
 * Room-plan history (2026-08-13) — what was INITIALLY selected, per room of the current plan:
 * the first sealed selection followed through the room-change chain, plus each initial room's
 * bed setup as it stood at selection time. Drives the "Initially" column on the S5–S7 room
 * tables, which stays on screen after every room/bed change.
 */
export type RoomPlanHistoryItem = {
  currentRoomId: string;
  currentRoomNumber: string | null;
  currentRoomTypeName: string | null;
  currentBedType: string | null;
  initialRoomId: string | null;
  initialRoomNumber: string | null;
  initialRoomTypeName: string | null;
  initialBedType: string | null;
  roomChanged: boolean;
  bedTypeChanged: boolean;
  changes: Array<{ fromRoomNumber: string | null; toRoomNumber: string | null; at: string; reason: string | null }>;
};

export type RoomPlanHistory = {
  entryId: string;
  initialSelectedAt: string | null;
  rooms: RoomPlanHistoryItem[];
};

export async function getRoomPlanHistory(session: Session, entryId: string) {
  return apiRequest<RoomPlanHistory>(`/api/entries/${entryId}/room-plan-history`, { session });
}

/* ───────── Early departure (2026-08-22, SIG-S8 §1.2 / Policy 36) ───────── */

export type EarlyDeparturePenaltyRule = {
  basis: "NONE" | "FLAT_AMOUNT" | "UNSTAYED_NIGHTS" | "PERCENT_OF_UNSTAYED";
  amount: number;
  nights: number;
  percent: number;
  ratePlanId: string | null;
  ratePlanOverride: boolean;
};

export type EarlyDepartureRoomFigure = {
  assignmentId: string;
  roomId: string;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  totalNights: number;
  sleptNights: number;
  unstayedNights: number;
  perNightSubtotal: number;
  forgoneSubtotal: number;
  forgoneTotal: number;
  newFrozenSubtotal: number | null;
  newFrozenTotal: number | null;
  legacyFlatRate: boolean;
  shortened: boolean;
};

/** Server-computed figures of a departure ahead of the booked checkout — nothing on the desk adds money up. */
export type EarlyDepartureFigures = {
  entryId: string;
  hotelToday: string;
  checkIn: string | null;
  bookedCheckOut: string | null;
  departureDate: string;
  bookedNights: number;
  sleptNights: number;
  unstayedNights: number;
  rooms: EarlyDepartureRoomFigure[];
  forgoneRoomSubtotal: number;
  forgoneRoomTotal: number;
  fee: {
    rule: EarlyDeparturePenaltyRule;
    amount: number;
    gross: number;
    serviceChargeRate: number;
    gstRate: number;
    description: string;
    explanation: string;
  };
  sleptNightAudits: Array<{ date: string; status: string }>;
  missingNightYmds: string[];
  blockers: Array<{ code: string; message: string }>;
  requiredLevel: "L3";
  openStayExtensionRequestId: string | null;
  alreadyRecorded: { id: string; departureDate: string; recordedAt: string } | null;
};

export type EarlyDepartureOutcome = {
  record: {
    id: string;
    entryId: string;
    departureDate: string;
    originalCheckOutDate: string;
    sleptNights: number;
    unstayedNights: number;
    feeAmount: number;
    feeWaived: boolean;
  };
  figures: EarlyDepartureFigures;
  feePosted: boolean;
  feeLineId: string | null;
  feeError: string | null;
  movedToCheckout: boolean;
  checkoutBlocked: { code: string; message: string } | null;
  entry: EntryDetail;
};

export async function previewEarlyDeparture(session: Session, entryId: string, body?: { departureDate?: string }) {
  return apiRequest<EarlyDepartureFigures>(`/api/entries/${entryId}/early-departure/preview`, { method: "POST", session, body: body ?? {} });
}

/** GM (L3+): shortens the stay, posts or waives the fee, frees the unstayed nights, moves to Check-out. */
export async function recordEarlyDeparture(
  session: Session,
  entryId: string,
  body: { departureDate?: string; reason: string; waiveFee?: boolean; waiveReason?: string },
) {
  return apiRequest<EarlyDepartureOutcome>(`/api/entries/${entryId}/early-departure`, { method: "POST", session, body });
}

