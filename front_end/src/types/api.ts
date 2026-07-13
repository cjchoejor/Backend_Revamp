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
  /** Set at S1 by Policy 64. GROUP_MASTER = auto-classified as group; NULL = individual. */
  groupBillingMode?: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null;
  useType?: string | null;
  segmentNumber?: number;
  createdAt: string;
  updatedAt: string;
  guestProfile?: GuestProfileName | null;
  inquiry?: { guestProfile?: GuestProfileName | null } | null;
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

export type InvoiceSummary = {
  id: string;
  entryId: string;
  folioId: string;
  invoiceType: string;
  state: string;
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

export type PaymentStatusSummary = {
  satisfied: boolean;
  totalReceived: number;
  requiredAmount: number;
  shortfall: number;
  creditExtensionActive: boolean;
  ceilingAmount: number | null;
  /** Present only when the group-boost policy raised the requiredAmount above the base. */
  groupBoostApplied?: { multiplierPercent: number; baseAmount: number };
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
  creditCeilingIfExtended?: string | number | null;
  confirmedAt: string;
  confirmedBy: string;
  confirmationVoucherSent: boolean;
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
  deficientAtAssignment?: boolean;
  acknowledgementActorId?: string | null;
  acknowledgementAt?: string | null;
  room?: {
    id: string;
    roomNumber: string;
    physicalState?: string;
    currentClaimState?: string;
    expectedReadyAt?: string | null;
    deficientConditionRecords?: DeficientConditionSummary[];
  };
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
  inquiry?: { agentProfile?: AgentProfileSummary | null } | null;
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
