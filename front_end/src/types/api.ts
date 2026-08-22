export type Stage = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "TERMINAL";

export type EntryStatus = "ACTIVE" | "PARKED" | "CANCELLED" | "CLOSED" | "EXPIRED";

export type ApiErrorBody = {
  error: string;
  message: string;
  blockingCondition?: string;
  details?: Record<string, unknown>;
};

export type AuthenticateResponse = {
  sessionId: string;
  userId: string;
  username: string;
  fullName?: string;
  actorLevel: string;
  terminalId: string;
  authenticatedAt: string;
  jwtToken: string;
};

export type EntryListItem = {
  id: string;
  inquiryId: string;
  currentStage: Stage;
  status: EntryStatus;
  version: number;
  checkInDate?: string | null;
  checkOutDate?: string | null;
  guestCount?: number | null;
  adultCount?: number | null;
  childCount?: number | null;
  childAges?: number[] | null;
  /** Number of rooms requested. May be null on legacy entries pre-Phase-D. */
  numberOfRooms?: number | null;
  /** Bed-setup breakdown of the room request ("5 King + 2 Twin"), map bedType → count (2026-08-13). */
  bedTypeRequest?: Record<string, number> | null;
  /** Set at S1 by Policy 64. GROUP_MASTER = auto-classified as group; NULL = individual. */
  groupBillingMode?: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null;
  useType?: string | null;
  segmentNumber?: number;
  createdAt: string;
  updatedAt: string;
  guestProfile?: GuestProfileName | null;
  inquiry?: { guestProfile?: GuestProfileName | null } | null;
  /** Open mid-stay bills (2026-08-22) — the Today list surfaces a due / overdue interim payment. */
  interimPaymentRequests?: Array<{
    id: string;
    kind: "LONG_STAY" | "EXTENSION";
    state: string;
    dueBy: string | null;
    dueNow: string | number | null;
    remindersSent: number;
    lastReminderAt: string | null;
    promiseKind?: "NOW" | "BY_DATE" | null;
    promisedBy?: string | null;
  }> | null;
};

export type GuestProfileName = {
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  vipTier?: string | null;
  nationality?: string | null;
  identityVerifiedAt?: string | null;
  identityVerifiedBy?: string | null;
  identityVerificationPath?: string | null;
};

export type InquiryListItem = {
  id: string;
  guestProfileId: string;
  sourceChannel: string;
  /** Derived on the client — not a DB column on Inquiry. */
  status?: string;
  parkedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  guestProfile?: GuestProfileName | null;
  entries?: {
    id: string;
    status?: string;
    currentStage?: string;
  }[];
};

export type QuotationState = "DRAFT" | "SENT" | "ACCEPTED" | "SUPERSEDED" | "EXPIRED";

export type QuotationSummary = {
  id: string;
  entryId: string;
  segmentId: string;
  versionNumber: number;
  referenceNumber: string;
  state: QuotationState;
  /** Set once the PDF artifact was rendered — the frozen document that went out. */
  pdfStorageKey?: string | null;
  commercialTerms?: Record<string, unknown> | null;
  totalAmount: string | number;
  currency: string;
  validUntil?: string | null;
  sentAt?: string | null;
  sentTo?: string | null;
  acceptedAt?: string | null;
  sealedAt?: string | null;
  createdAt: string;
};

export type SpeculativeHoldSummary = {
  id: string;
  entryId: string;
  segmentId: string;
  roomId?: string | null;
  spaceId?: string | null;
  /** Sealed per-night snapshot (2026-08-06) — when present the hold covers EVERY room it
   *  names, each over its own nights; `roomId` is just the anchor. */
  perNightBreakdown?: Array<{ date: string; roomIds: Array<{ roomId: string }> }> | null;
  state: string;
  placedAt: string;
  expiresAt: string;
  ttlSeconds: number;
  releasedAt?: string | null;
  room?: { id: string; roomNumber: string } | null;
};

export type SegmentSummary = {
  id: string;
  segmentNumber: number;
  startedAt?: string;
  sealedAt?: string | null;
};

export type AvailabilityOptionSelected =
  /** Legacy single-room seal. */
  | { roomId: string; isDeficient?: boolean }
  /** Multi-room, whole-stay seal. Same rooms all nights. */
  | { roomIds: Array<{ roomId: string; isDeficient: boolean }>; isDeficient?: boolean }
  /** Per-night seal — different rooms allowed on different nights. */
  | {
      perNight: Array<{ date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> }>;
      isDeficient?: boolean;
    };

export type AvailabilityConfigSummary = {
  id: string;
  optionSelected: AvailabilityOptionSelected | null;
  isStale: boolean;
  sealedAt: string | null;
  resultSet?: unknown;
  /**
   * The inputs this search ran with — `{ checkInDate, checkOutDate, guestCount, useType, … }`.
   * Persisted server-side on every search, so the desk can restore the search form to what was
   * last actually run instead of snapping back to the entry's intake dates.
   */
  searchCriteria?: unknown;
  createdAt?: string;
};

/**
 * Normalise the three shapes to a distinct flat list of room ids. Handy for display
 * (sticky breadcrumb "N rooms sealed") where the specific per-night assignment is not
 * important. Callers that DO care about per-night should read `optionSelected.perNight`
 * directly.
 */
export function optionSelectedRoomIds(opt: AvailabilityOptionSelected | null | undefined): string[] {
  if (!opt) return [];
  if ("perNight" in opt && Array.isArray(opt.perNight)) {
    const set = new Set<string>();
    for (const n of opt.perNight) for (const r of n.roomIds) set.add(r.roomId);
    return Array.from(set);
  }
  if ("roomIds" in opt && Array.isArray(opt.roomIds)) return opt.roomIds.map((r) => r.roomId);
  if ("roomId" in opt && typeof opt.roomId === "string") return [opt.roomId];
  return [];
}

/**
 * The room a single-room hold (S2 speculative / S3 primary) should target (2026-08-06).
 *
 * `optionSelectedRoomIds(...)[0]` picked whichever room the FIRST night happened to list first —
 * on a per-night seal that can be a room used one night only (chosen precisely because someone
 * else holds it the other nights), so the hold went at the most contested room instead of the
 * booking's anchor. Prefer a room claimed on EVERY night; else the one claimed on the most
 * nights; whole-stay seals are unchanged (every room covers every night).
 */
export function preferredHoldRoomId(opt: AvailabilityOptionSelected | null | undefined): string | null {
  const ids = optionSelectedRoomIds(opt);
  if (ids.length === 0) return null;
  if (!opt || !("perNight" in opt) || !Array.isArray(opt.perNight) || opt.perNight.length === 0) return ids[0];
  const counts = new Map<string, number>();
  for (const n of opt.perNight) for (const r of n.roomIds) counts.set(r.roomId, (counts.get(r.roomId) ?? 0) + 1);
  const everyNight = ids.find((id) => (counts.get(id) ?? 0) === opt.perNight.length);
  if (everyNight) return everyNight;
  let best: string | null = null;
  let bestCount = -1;
  for (const id of ids) {
    const c = counts.get(id) ?? 0;
    if (c > bestCount) {
      best = id;
      bestCount = c;
    }
  }
  return best;
}

export type InvoiceSummary = {
  id: string;
  entryId: string;
  folioId: string;
  invoiceType: string;
  state: string;
  invoiceNumber?: string | null;
  versionNumber?: number;
  supersededById?: string | null;
  /** Set once the PDF artifact was rendered — the frozen document that went out. */
  pdfStorageKey?: string | null;
  templateKey?: string | null;
  dispatchedAt?: string | null;
  dispatchedTo?: string | null;
  createdAt: string;
  /** JSON metadata blob. Group invoices set `{ groupBooking: true, roomCount, guestCount, groupLeader }`. */
  metadata?: Record<string, unknown> | null;
};

export type PaymentRecordSummary = {
  id: string;
  amount: string | number;
  paymentDirection: string;
  currency: string;
  receivedAt: string;
  notes?: string | null;
};

export type WriteOffRecordSummary = {
  id: string;
  writtenOffAmount: string | number;
  currency: string;
  reason: string;
  createdAt: string;
};

export type FolioLineSummary = {
  id: string;
  folioId: string;
  lineType: string;
  description: string;
  amount: string | number;
  currency: string;
  chargeDate: string;
  stage: string;
  postedAt: string;
  nightAuditRecordId?: string | null;
  /** Which room this charge belongs to (2026-08-14, per-room folio breakdown). Null = booking-wide. */
  roomId?: string | null;
};

export type FolioDetail = {
  id: string;
  entryId: string;
  state: string;
  billingModel?: string | null;
  outstandingBalance?: string | number;
  advancePaymentReconciliationComplete?: boolean;
  convertedToLiveAt?: string | null;
  convertedBy?: string | null;
  closedAt?: string | null;
  closedBy?: string | null;
  lines?: FolioLineSummary[];
  invoices?: InvoiceSummary[];
  payments?: PaymentRecordSummary[];
  writeOffRecords?: WriteOffRecordSummary[];
  billingModelTransitions?: Array<{
    id: string;
    segmentId: string;
    fromModel?: string | null;
    toModel: string;
    createdAt: string;
  }>;
};

/** What the guest SAID about paying the advance (2026-08-07) — segment-scoped, advisory. */
export type AdvancePaymentPlanSummary = {
  plan: "FULL" | "PARTIAL" | "INSTALLMENTS";
  balanceDueAt: "BEFORE_CHECKIN" | "AT_CHECKIN" | "AT_CHECKOUT" | null;
  /** ISO deadline of a before-check-in promise (drives the W38 timer + countdown chip). */
  promisedBy: string | null;
  note: string | null;
  setBy: string;
  setAt: string;
  /** Read-time fact: the promised date passed with the money still short. */
  promiseOverdue: boolean;
};

export type PaymentStatusSummary = {
  satisfied: boolean;
  totalReceived: number;
  requiredAmount: number;
  shortfall: number;
  /** Money alone — true only when received >= required (a credit extension doesn't count). */
  paidInFull?: boolean;
  /** The guest's stated payment plan for this segment, or null when none recorded. */
  paymentPlan?: AdvancePaymentPlanSummary | null;
  /** Every payment so far, oldest first — the installment history. */
  installments?: Array<{ id: string; amount: number; receivedAt: string; stage: string | null; notes?: string | null }>;
  creditExtensionActive: boolean;
  ceilingAmount: number | null;
  /** ISO expiry of the credit extension, when the FOM set a time limit (2026-08-01). */
  creditExtensionExpiresAt?: string | null;
  /** True when an extension exists but its clock ran out — it no longer satisfies the condition. */
  creditExtensionExpired?: boolean;
  /** Where requiredAmount came from: the desk's per-booking requirement or the config thresholds. */
  requirementSource?: "OPERATOR" | "CONFIG";
  /** Present for OPERATOR requirements: { mode: "AMOUNT" } or { mode: "PERCENT", percent, baseTotal, quotationId }. */
  requirementBasis?: { mode?: string; percent?: number; baseTotal?: number; quotationId?: string } | null;
  /**
   * What the CONFIG thresholds demand (incl. group boost), independent of any per-booking pin
   * (2026-08-03). Lets the desk show "hotel minimum unchanged at X" next to a pinned figure.
   */
  configuredBaseAmount?: number;
  /** Present only when the group-boost policy raised the requiredAmount above the base. */
  groupBoostApplied?: { multiplierPercent: number; baseAmount: number };
  /**
   * The advance-payment window (2026-08-01): due between proforma dispatch (`opensAt`) and the
   * check-in date (`deadline`). `active` = clock running; `overdue` = check-in passed unpaid.
   */
  advanceWindow?: { opensAt: string | null; deadline: string | null; active: boolean; overdue: boolean } | null;
};

export type CancellationDisclosureSummary = {
  id: string;
  entryId: string;
  noShowTreatmentStatement: string;
  disclosedAt: string;
};

export type CommittedHoldSummary = {
  id: string;
  entryId: string;
  roomId?: string | null;
  state: string;
  placedAt: string;
  expiresAt: string;
  commercialJustification?: string;
};

export type ReservationSummary = {
  id: string;
  entryId: string;
  frozenRate: string | number;
  frozenRatePlanId: string;
  frozenBillingModel: string;
  frozenCheckInDate: string;
  frozenCheckOutDate: string;
  frozenGuestCount: number;
  frozenInclusions?: unknown;
  frozenCancellationTerms?: unknown;
  /** The S4 snapshot of the commercial terms — carries `roomCompositions` on composition
   *  bookings; the desk's seating falls back to it when the current segment's quote has none. */
  frozenCommercialTerms?: Record<string, unknown> | null;
  creditCeilingIfExtended?: string | number | null;
  confirmedAt: string;
  confirmedBy: string;
  confirmationVoucherSent: boolean;
  // Confirmation-voucher PDF artifact (write-once, checksum-signed). Returned by the entry-detail
  // endpoint (reservation scalars); null until the PDF has been rendered at least once.
  confirmationVoucherStorageKey?: string | null;
  confirmationVoucherChecksum?: string | null;
  confirmationVoucherChecksumAlgo?: string | null;
  confirmationVoucherRenderedAt?: string | null;
  confirmationVoucherRenderedBy?: string | null;
};

export type HandoffSummary = {
  id: string;
  entryId: string;
  handoffType: string;
  state: string;
  stageContext?: string | null;
  fromRole: string;
  toRole: string;
  assignedAt?: string | null;
  acceptedAt?: string | null;
  fulfilledAt?: string | null;
  closedAt?: string | null;
  slaDeadlineAt?: string | null;
  deficientConditionStatus?: string | null;
  isAutoFulfilled?: boolean;
  rejectedAt?: string | null;
};

export type VipArrivalNotificationSummary = {
  id: string;
  entryId: string;
  guestProfileId: string;
  vipTier: string;
  roomNumber: string;
  checkInInitiatedAt: string;
  createdAt: string;
};

export type PreArrivalTaskSummary = {
  id: string;
  entryId: string;
  taskType: string;
  status: string;
  targetDate?: string | null;
  waivedReason?: string | null;
  completedAt?: string | null;
};

export type DeficientConditionSummary = {
  id: string;
  roomId: string;
  category: string;
  description: string;
  status: string;
  detectedAt: string;
  resolutionDeadline: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  resolutionNotes?: string | null;
};

export type DisputeSummary = {
  id: string;
  entryId: string;
  folioId: string;
  title: string;
  description?: string | null;
  status: string;
  openedAt: string;
  updatedAt?: string;
};

export type RoomAssignmentSummary = {
  id: string;
  entryId: string;
  roomId: string;
  /** Date-scoped assignment window (multi-room / per-night bookings). Null for whole-stay. */
  startDate?: string | null;
  endDate?: string | null;
  deficientAtAssignment?: boolean;
  acknowledgementActorId?: string | null;
  acknowledgementAt?: string | null;
  /** Per-room key lifecycle (2026-08-14): issued on the day the guest enters THIS room;
   *  a mid-stay room change swaps keys (return old → issue new, backend hard gate). */
  keyIssuedAt?: string | null;
  keyIssuedBy?: string | null;
  keyReturnedAt?: string | null;
  keyReturnedBy?: string | null;
  room?: {
    id: string;
    roomNumber: string;
    physicalState?: string;
    currentClaimState?: string;
    expectedReadyAt?: string | null;
    deficientConditionRecords?: DeficientConditionSummary[];
  };
  // Per-room composition (Phase A of per-room track, 2026-07-27). Populated when the
  // quotation was built via per-room composition; null on legacy bookings.
  occupantCount?: number | null;
  adultCount?: number | null;
  cnb6To10Count?: number | null;
  cnbUnder6Count?: number | null;
  extraBedCount?: number | null;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
  mealPlanOthersCount?: number;
  othersBreakfastPax?: number | null;
  othersLunchPax?: number | null;
  othersDinnerPax?: number | null;
  negotiatedRoomRate?: string | number | null;
  negotiatedExtraBedRate?: string | number | null;
  negotiatedBreakfastRate?: string | number | null;
  negotiatedLunchRate?: string | number | null;
  negotiatedDinnerRate?: string | number | null;
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  isFoc?: boolean;
  frozenSubtotal?: string | number | null;
  frozenTotal?: string | number | null;
};

export type KeyReturnSummary = {
  id: string;
  entryId: string;
  roomId: string;
  keyCountIssued: number;
  keyCountReturned: number;
  countReconciled: boolean;
  reconciliationNote?: string | null;
  returnedAt: string;
};

export type RoomInspectionSummary = {
  id: string;
  entryId: string;
  roomId: string;
  inspectedAt: string;
  isDeferred: boolean;
  deficientFlagStatus: string;
  damageFound: boolean;
  damageNotes?: string | null;
};

export type AgentProfileSummary = {
  id: string;
  displayName?: string | null;
  commissionRate?: string | number | null;
  commissionBasis?: string | null;
};

export type CommissionDueSummary = {
  id: string;
  entryId: string;
  agentProfileId: string;
  commissionRate?: string | number | null;
  commissionBasis?: string | null;
  calculatedAmount?: string | number | null;
  currency: string;
  status: string;
  createdAt: string;
};

export type FollowUpTaskSummary = {
  id: string;
  entryId: string;
  dueAt: string;
  completedAt?: string | null;
  notes?: string | null;
  createdAt: string;
};

export type NoShowDeterminationSummary = {
  id: string;
  entryId: string;
  determinationPath: string;
  decisionReason?: string | null;
  createdAt: string;
};

export type EntryDetail = EntryListItem & {
  reservation?: ReservationSummary | null;
  folio?: FolioDetail | null;
  cancellationDisclosure?: CancellationDisclosureSummary | null;
  committedHold?: CommittedHoldSummary | null;
  creditCeilingTier2AcknowledgedAt?: string | null;
  handoffs?: HandoffSummary[];
  preArrivalTasks?: PreArrivalTaskSummary[];
  roomAssignments?: RoomAssignmentSummary[];
  availabilityConfigs?: AvailabilityConfigSummary[];
  segments?: SegmentSummary[];
  quotations?: QuotationSummary[];
  speculativeHolds?: SpeculativeHoldSummary[];
  vipArrivalNotifications?: VipArrivalNotificationSummary[];
  disputes?: DisputeSummary[];
  keyReturnRecords?: KeyReturnSummary[];
  roomInspectionRecords?: RoomInspectionSummary[];
  commissionDueRecords?: CommissionDueSummary[];
  followUpTasks?: FollowUpTaskSummary[];
  noShowDetermination?: NoShowDeterminationSummary | null;
  inquiry?: {
    notes?: string | null;
    /** Full Inquiry scalars come through the entry include; declared as needed. */
    sourceChannel?: string | null;
    travelAgentId?: string | null;
    corporateAccountId?: string | null;
    agentProfile?: AgentProfileSummary | null;
  } | null;
  closedAt?: string | null;
  closedBy?: string | null;
  walkInCompressed?: boolean;
  keysIssuedCount?: number | null;
  keysIssuedAt?: string | null;
  registrationCompletedAt?: string | null;
};

export type ListResponse<T> = {
  items: T[];
  count: number;
};
