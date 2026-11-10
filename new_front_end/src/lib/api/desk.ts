import type { Session } from "@/types/session";
import type { EntryStatus, Stage } from "@/types/api";
import { apiRequest } from "./client";

/** One booking as the redesigned list screens read it — `GET /api/desk/bookings`. No money. */
export type DeskListRow = {
  id: string;
  inquiryId: string;
  segmentNumber: number;
  status: EntryStatus;
  currentStage: Stage;
  useType: string | null;
  guestCount: number | null;
  adultCount: number | null;
  childCount: number | null;
  numberOfRooms: number | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  actualCheckOutDate: string | null;
  walkInCompressed: boolean;
  groupBillingMode: "GROUP_MASTER" | "INDIVIDUAL_FOLIO" | null;
  reservationPaymentPending: boolean;
  parkedAt: string | null;
  contactPersonName: string | null;
  contactPersonPhone: string | null;
  closedAt: string | null;
  /** How it ended, and what was said — so a lapse, a decline and a cancellation read apart. */
  closedAs?: string | null;
  closedReason?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  guestProfile: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    vipTier: string | null;
    nationality: string | null;
  } | null;
  inquiry: {
    id: string;
    referenceNumber: string;
    sourceChannel: string;
    cameInAs: string | null;
    defaultCustodianId: string;
    notes: string | null;
    callerTitle?: string | null;
    callerFirstName?: string | null;
    callerLastName?: string | null;
    callerPhone?: string | null;
    callerEmail?: string | null;
    travelAgent: { id: string; displayName: string } | null;
    corporateAccount: { id: string; displayName: string } | null;
  } | null;
  reservation: { id: string; confirmedAt: string; confirmationVoucherSent: boolean } | null;
  folio: {
    id: string;
    state: string;
    billingModel: string | null;
    /** The proforma in force (2026-11-05). */
    invoices?: Array<{ validUntil: string | null; lapsedAt: string | null; dispatchedAt: string | null }>;
  } | null;
  committedHold: { state: string; expiresAt: string } | null;
  speculativeHolds: Array<{ expiresAt: string }>;
  quotations: Array<{ referenceNumber: string; state: string; validUntil: string | null; sentAt: string | null }>;
  roomAssignments: Array<{ roomId: string; startDate: string | null; endDate: string | null; room: { roomNumber: string } | null }>;
  earlyDeparture: { departureDate: string } | null;
  noShowDetermination: { id: string; createdAt: string } | null;
  interimPaymentRequests: Array<{
    id: string;
    kind: "LONG_STAY" | "EXTENSION";
    state: string;
    dueBy: string | null;
    remindersSent: number;
    promiseKind: "NOW" | "BY_DATE" | null;
    promisedBy: string | null;
  }>;
  /** The rest of the bill at check-in (2026-10-29): a request the FOM must answer, or the FOM's later date. */
  checkInPaymentDeferrals?: Array<{
    id: string;
    status: "REQUESTED" | "APPROVED";
    payBy: "DURING_STAY" | "AT_CHECKOUT" | "AFTER_STAY" | null;
    dueBy: string | null;
    stillToPay: string | number;
    requestedAt: string;
  }>;
  timers: Array<{ timerCode: string; timerType: string; firesAt: string }>;
  custodianName: string | null;
  parkReason: string | null;
  parkFollowUpAt: string | null;
  roomNumbers: string[];
  /** Which stay of its enquiry this booking is, when there are several (2026-11-10). */
  stay: { no: number; of: number } | null;
};

export async function listDeskBookings(session: Session, q: { status?: EntryStatus; stage?: Stage; guestProfileId?: string; limit?: number } = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.stage) p.set("stage", q.stage);
  if (q.guestProfileId) p.set("guestProfileId", q.guestProfileId);
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return apiRequest<{ items: DeskListRow[]; count: number; repliesOff?: string[] }>(`/api/desk/bookings${qs ? `?${qs}` : ""}`, { session });
}

/** The money line for a page of bookings — the booking header's own billing summary, trimmed. */
export type DeskMoneyRow = {
  entryId: string;
  currency: string | null;
  headline: { amount: number | null; kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null; frozen: boolean };
  /** `refunded` and `writtenOff` (2026-11-10) say where money paid went on a closed bill. */
  folio: {
    state: string;
    billedSoFar: number | null;
    paymentsReceived: number | null;
    outstandingBalance: number | null;
    refunded: number | null;
    writtenOff: number | null;
  } | null;
  /** The stay as priced plus what was added to it; null with no priced stay total (2026-11-10). */
  totalAmount: number | null;
  shortened: boolean;
  /** The whole trip when the booking is one stay of several — the stays' own figures added up by the server. */
  trip: {
    inquiryId: string;
    stays: Array<{ entryId: string; stayNo: number; checkIn: string | null; checkOut: string | null; stage: string; status: string }>;
    totalAmount: number | null;
    billedSoFar: number;
    paymentsReceived: number;
    outstandingBalance: number;
    paidAhead: number;
    refunded: number;
    writtenOff: number;
  } | null;
};

export async function deskMoneyFor(session: Session, entryIds: string[]) {
  return apiRequest<{ items: DeskMoneyRow[]; count: number }>("/api/desk/bookings/money", {
    method: "POST",
    session,
    body: { entryIds: entryIds.slice(0, 100) },
  });
}

/** The clocks running on a booking, for the list — `POST /api/desk/bookings/timers` (L1). */
export type DeskTimerRow = {
  entryId: string;
  running: number;
  /** `showsFrom` — the clock is shown from then, not before (the no-show cut-off, from its grace; 2026-10-29). */
  next: Array<{ timerCode: string; timerType: string; stageContext: string | null; firesAt: string; showsFrom?: string | null; handoffType?: string | null }>;
};

export async function deskTimersFor(session: Session, entryIds: string[]) {
  return apiRequest<{ items: DeskTimerRow[]; count: number }>("/api/desk/bookings/timers", {
    method: "POST",
    session,
    body: { entryIds: entryIds.slice(0, 100) },
  });
}

export type StaffName = { id: string; fullName: string; actorLevel: "L1" | "L2" | "L3" | "L4"; role: string; isActive: boolean };

export async function listStaffNames(session: Session) {
  return apiRequest<{ items: StaffName[]; count: number }>("/api/desk/staff", { session });
}

/** One recorded act, as the desk's Audit reads it — `GET /api/desk/activity` (FOM and above). */
export type DeskActivityRow = {
  id: string;
  eventType: string;
  actorId: string;
  actorLevel: string;
  actorName: string | null;
  entityType: string;
  entityId: string;
  payload: unknown;
  timestamp: string;
  stageContext: string | null;
  entryId: string | null;
};

export async function listDeskActivity(session: Session, q: { date: string; actorId?: string; entryId?: string; limit?: number }) {
  const p = new URLSearchParams({ date: q.date });
  if (q.actorId) p.set("actorId", q.actorId);
  if (q.entryId) p.set("entryId", q.entryId);
  if (q.limit) p.set("limit", String(q.limit));
  return apiRequest<{ items: DeskActivityRow[]; count: number; from: string; to: string }>(`/api/desk/activity?${p}`, { session });
}

/* ---------- the alerts the system sent (2026-10-23) ---------- */

export type DeskAlertKind = "STAGE_DWELL" | "EXPIRED" | "PAYMENT_REMINDER" | "PAY_LATER_ASKED" | "VIP_ARRIVAL" | "BLOCK_ENDED" | "REFUND_DUE" | "OTHER";
export type DeskAlertTarget = "OPERATOR" | "FOM" | "GM";

export type DeskAlert = {
  id: string;
  at: string;
  kind: DeskAlertKind;
  eventType: string;
  entryId: string | null;
  /** The step the booking was at when the alert was sent ("S6"). */
  stage: string | null;
  severity: "WARNING" | "CRITICAL" | "ESCALATION" | null;
  /** Who it was routed to. */
  targets: DeskAlertTarget[];
  secondsInStage: number | null;
  reason: string | null;
  payment: { kind: string | null; remaining: number | null; remindersSent: number | null; dueBy: string | null; billed: boolean } | null;
  /** The booking as it stands NOW. */
  booking: {
    id: string;
    currentStage: string;
    status: string;
    closedAs: string | null;
    checkInDate: string | null;
    checkOutDate: string | null;
    guestProfile: { firstName: string | null; lastName: string | null } | null;
    inquiry: { callerTitle: string | null; callerFirstName: string | null; callerLastName: string | null; callerPhone: string | null; callerEmail: string | null } | null;
  } | null;
};

export type BillFigures = {
  net: number;
  serviceCharge: number;
  gst: number;
  total: number;
  received: number;
  refunded: number;
  writtenOff: number;
  settledBefore: number;
  balance: number;
  paidAhead: number;
};

export type BillStay = {
  entryId: string;
  stayNo: number;
  status: string;
  stage: string;
  folioId: string | null;
  folioState: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  rooms: string[];
  roomCount: number;
  guest: string | null;
  rows: Array<{ key: string; when: string; place: string | null; description: string; qty: number; rate: number; amount: number }>;
  figures: BillFigures;
  taxInvoices: Array<{ id: string; number: string }>;
};

/** A booking's bill, with every other stay of its trip that has one — `GET /api/desk/bills/:id`. */
export type BillView = {
  entryId: string;
  inquiryId: string;
  currency: string;
  asAt: string;
  hotel: { name: string; address: string; phone: string | null; email: string; tpn: string | null; gstTpn: string | null; logo: string | null };
  billedTo: string;
  forGuest: string | null;
  customerTpn: string | null;
  stays: BillStay[];
  payments: Array<{ id: string; stayNo: number; at: string; method: string | null; direction: "IN" | "OUT"; amount: number; note: string | null }>;
  figures: BillFigures;
};

export async function getBillView(session: Session, entryId: string) {
  return apiRequest<BillView>(`/api/desk/bills/${encodeURIComponent(entryId)}`, { session });
}

/** The alerts sent over the last `days` hotel days, today included — newest first. */
export async function listDeskAlerts(session: Session, q: { days: number }) {
  return apiRequest<{ items: DeskAlert[]; count: number; from: string; to: string; limit: number }>(`/api/desk/alerts?days=${q.days}`, { session });
}
