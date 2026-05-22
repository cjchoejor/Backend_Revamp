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
  custodianId?: string | null;
  checkInDate?: string | null;
  checkOutDate?: string | null;
  guestCount?: number | null;
  useType?: string | null;
  segmentNumber?: number;
  createdAt: string;
  updatedAt: string;
  guestProfile?: {
    id: string;
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
};

export type InquiryListItem = {
  id: string;
  guestProfileId: string;
  sourceChannel: string;
  status: string;
  custodianId?: string | null;
  createdAt: string;
  updatedAt: string;
  guestProfile?: { id: string; displayName?: string | null } | null;
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

export type AvailabilityConfigSummary = {
  id: string;
  optionSelected: { roomId: string; isDeficient?: boolean } | null;
  isStale: boolean;
  sealedAt: string | null;
  resultSet?: unknown;
  createdAt?: string;
};

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
};

export type PaymentRecordSummary = {
  id: string;
  amount: string | number;
  paymentDirection: string;
  currency: string;
  receivedAt: string;
  notes?: string | null;
};

export type FolioDetail = {
  id: string;
  entryId: string;
  state: string;
  billingModel?: string | null;
  outstandingBalance?: string | number;
  advancePaymentReconciliationComplete?: boolean;
  invoices?: InvoiceSummary[];
  payments?: PaymentRecordSummary[];
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
  fromRole: string;
  toRole: string;
  assignedAt?: string | null;
  acceptedAt?: string | null;
  fulfilledAt?: string | null;
};

export type EntryDetail = EntryListItem & {
  reservation?: ReservationSummary | null;
  folio?: FolioDetail | null;
  cancellationDisclosure?: CancellationDisclosureSummary | null;
  committedHold?: CommittedHoldSummary | null;
  handoffs?: unknown[];
  preArrivalTasks?: unknown[];
  roomAssignments?: unknown[];
  availabilityConfigs?: AvailabilityConfigSummary[];
  segments?: SegmentSummary[];
  quotations?: QuotationSummary[];
  speculativeHolds?: SpeculativeHoldSummary[];
  committedHold?: unknown;
};

export type ListResponse<T> = {
  items: T[];
  count: number;
};
