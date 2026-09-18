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
    travelAgent: { id: string; displayName: string } | null;
    corporateAccount: { id: string; displayName: string } | null;
  } | null;
  reservation: { id: string; confirmedAt: string; confirmationVoucherSent: boolean } | null;
  folio: { id: string; state: string; billingModel: string | null } | null;
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
  timers: Array<{ timerCode: string; timerType: string; firesAt: string }>;
  custodianName: string | null;
  parkReason: string | null;
  parkFollowUpAt: string | null;
  roomNumbers: string[];
};

export async function listDeskBookings(session: Session, q: { status?: EntryStatus; stage?: Stage; guestProfileId?: string; limit?: number } = {}) {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.stage) p.set("stage", q.stage);
  if (q.guestProfileId) p.set("guestProfileId", q.guestProfileId);
  if (q.limit) p.set("limit", String(q.limit));
  const qs = p.toString();
  return apiRequest<{ items: DeskListRow[]; count: number }>(`/api/desk/bookings${qs ? `?${qs}` : ""}`, { session });
}

/** The money line for a page of bookings — the booking header's own billing summary, trimmed. */
export type DeskMoneyRow = {
  entryId: string;
  currency: string | null;
  headline: { amount: number | null; kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null; frozen: boolean };
  folio: { state: string; billedSoFar: number | null; paymentsReceived: number | null; outstandingBalance: number | null } | null;
  shortened: boolean;
};

export async function deskMoneyFor(session: Session, entryIds: string[]) {
  return apiRequest<{ items: DeskMoneyRow[]; count: number }>("/api/desk/bookings/money", {
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
