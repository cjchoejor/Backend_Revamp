import type { EntryDetail, EntryListItem, ListResponse } from "@/types/api";
import type { Session } from "@/types/session";
import type { TraceEvent } from "@/lib/trace/humanize";
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
  | "PRE_ARRIVAL_REMINDER";

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
 * Evidence only: this never gates stage progression.
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
    hasAcceptedQuotation: boolean;
    reference: string | null;
    versionNumber: number | null;
    state: string | null;
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
    billingModel: string | null;
    folioState: string | null;
    committedHold: { state: string | null; rooms: JourneyRoomRef[]; expiresAt: string | null } | null;
    advancePayment: {
      satisfied: boolean;
      requiredAmount: number | null;
      totalReceived: number | null;
      shortfall: number | null;
      creditExtensionActive: boolean;
      ceilingAmount: number | null;
    } | null;
    cancellation: { disclosed: boolean; noShowTreatment: string | null; disclosedAt: string | null } | null;
    proformaInvoiceRef: string | null;
    coordinator: string | null;
  };
  s4Confirmation: {
    status: JourneySectionStatus;
    confirmed: boolean;
    reservationId: string | null;
    frozenRate: number | null;
    frozenRatePlanId: string | null;
    frozenBillingModel: string | null;
    frozenCheckIn: string | null;
    frozenCheckOut: string | null;
    frozenGuestCount: number | null;
    creditCeilingIfExtended: number | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
    voucherSent: boolean;
  };
};

export async function getJourneySummary(session: Session, entryId: string) {
  return apiRequest<BookingJourneySummary>(`/api/entries/${entryId}/journey-summary`, { session });
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
