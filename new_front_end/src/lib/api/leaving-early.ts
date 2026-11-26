/**
 * Leaving early — the whole booking or some of its rooms, today or a later day — and a room added to
 * a stay in house (2026-11-26). Every figure is the server's.
 * back_end/src/services/domain/{early-departure,rooms-leaving-early,add-room-to-stay}-service.ts.
 */
import type { Session } from "@/types/session";
import { apiRequest } from "./client";
import type { RoomCompositionInput } from "./quotations";

export type LeavingRoom = {
  assignmentId: string;
  roomId: string;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  totalNights: number;
  sleptNights: number;
  unstayedNights: number;
  perNightRoomSubtotal: number;
  forgoneSubtotal: number;
  forgoneTotal: number;
  shortened: boolean;
  feeAmount: number | null;
};

export type LeavingFigures = {
  entryId: string;
  scope: "BOOKING" | "ROOMS";
  roomIds: string[];
  roomsInUse: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null; endDate: string; nightsLeft: number; apartment: boolean }>;
  later: boolean;
  hotelToday: string;
  checkIn: string | null;
  bookedCheckOut: string | null;
  departureDate: string;
  bookedNights: number;
  sleptNights: number;
  unstayedNights: number;
  rooms: LeavingRoom[];
  forgoneRoomSubtotal: number;
  forgoneRoomTotal: number;
  fee: { rule: { basis: string; amount: number; nights: number; percent: number }; amount: number; gross: number; serviceChargeRate: number; gstRate: number; description: string; explanation: string };
  sleptNightAudits: Array<{ date: string; status: string }>;
  missingNightYmds: string[];
  blockers: Array<{ code: string; message: string }>;
  requiredLevel: "L3";
  alreadyRecorded: { id: string; departureDate: string; recordedAt: string } | null;
};

export function previewLeaving(session: Session, entryId: string, body: { departureDate?: string; roomIds?: string[] }) {
  return apiRequest<LeavingFigures>(`/api/entries/${entryId}/early-departure/preview`, { session, method: "POST", body });
}

export type LeavingOutcome =
  | {
      scope: "BOOKING";
      record: { id: string; departureDate: string; unstayedNights: number; feeAmount: number; feeWaived: boolean };
      feePosted: boolean;
      feeError: string | null;
      movedToCheckout: boolean;
      checkoutBlocked: { code: string; message: string } | null;
      later: boolean;
    }
  | {
      scope: "ROOMS";
      departureDate: string;
      later: boolean;
      billing: "TOGETHER" | "OWN";
      records: Array<{ id: string; roomId: string; roomNumber: string; unstayedNights: number; forgoneTotal: number; feeAmount: number; feeWaived: boolean; feeLineId: string | null; feeError: string | null; state: "SCHEDULED" | "LEFT" }>;
    };

export function recordLeaving(
  session: Session,
  entryId: string,
  body: { departureDate?: string; roomIds?: string[]; billing?: "TOGETHER" | "OWN"; reason: string; waiveFee?: boolean; waiveReason?: string; kind?: "LEAVING" | "REMOVED" },
) {
  return apiRequest<LeavingOutcome>(`/api/entries/${entryId}/early-departure`, { session, method: "POST", body });
}

export type RoomDepartureRow = {
  id: string;
  roomId: string;
  roomNumber: string;
  departureDate: string;
  originalEndDate: string;
  sleptNights: number;
  unstayedNights: number;
  forgoneTotal: number;
  feeAmount: number;
  feeWaived: boolean;
  waiveReason: string | null;
  feeLineId: string | null;
  billing: "TOGETHER" | "OWN";
  /** LEAVING — the guest's choice, the fee applies; REMOVED — the hotel's mistake, no fee. */
  kind: "LEAVING" | "REMOVED";
  state: "SCHEDULED" | "LEFT";
  dueToday: boolean;
  leftAt: string | null;
  reason: string;
  recordedAt: string;
};

export function listRoomDepartures(session: Session, entryId: string) {
  return apiRequest<{ items: RoomDepartureRow[] }>(`/api/entries/${entryId}/room-departures`, { session });
}

export function releaseRoomDeparture(session: Session, entryId: string, recordId: string, body: { keyReturned?: boolean }) {
  return apiRequest<{ released: boolean; keyError: string | null; departures: RoomDepartureRow[] }>(`/api/entries/${entryId}/room-departures/${recordId}/release`, {
    session,
    method: "POST",
    body,
  });
}

/* ---------------------------------------------------------------- removing a room booked by mistake */

export type RoomRemovalAsk = {
  id: string;
  roomIds: string[];
  roomNumbers: string[];
  departureDate: string;
  reason: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  requestedBy: string;
  requestedByName?: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName?: string | null;
  decidedLevel: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  recordIds: string[];
};

export function getRoomRemovals(session: Session, entryId: string) {
  return apiRequest<{ items: RoomRemovalAsk[]; waiting: RoomRemovalAsk | null; mayDecide: boolean; approvers: string }>(`/api/entries/${entryId}/room-removals`, { session });
}
export function askToRemoveRoom(session: Session, entryId: string, body: { roomIds: string[]; departureDate?: string; reason: string }) {
  return apiRequest<{ request: RoomRemovalAsk; approvers: string }>(`/api/entries/${entryId}/room-removals`, { session, method: "POST", body });
}
export function decideRoomRemoval(session: Session, entryId: string, requestId: string, body: { decision: "APPROVE" | "REJECT"; note?: string | null }) {
  return apiRequest<{ decision: "APPROVE" | "REJECT"; removal: { records: Array<{ roomNumber: string }> } | null }>(`/api/entries/${entryId}/room-removals/${requestId}/decide`, {
    session,
    method: "POST",
    body,
  });
}
export function withdrawRoomRemoval(session: Session, entryId: string, requestId: string) {
  return apiRequest<{ withdrawn: boolean }>(`/api/entries/${entryId}/room-removals/${requestId}/withdraw`, { session, method: "POST", body: {} });
}

/* ---------------------------------------------------------------- rooms added on the check-in day */

export type AddRoomHolder = {
  entryId: string;
  bookingRef: string | null;
  guestName: string | null;
  partyName: string | null;
  stage: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  nightsInRoom: string[];
  swappable: boolean;
  why: string | null;
  rooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; sameType: boolean }>;
};

export type AddRoomRow = {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName: string | null;
  bedType: string | null;
  maxCapacity: number | null;
  maxExtraBeds: number | null;
  maxChildren: number | null;
  availability: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE";
  perNight: Array<{ date: string; status: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE"; guest: string | null; bookingRef: string | null }>;
  selectable: boolean;
  why: string | null;
  needsCleaning: boolean;
  holders: AddRoomHolder[];
  roomRate: number | null;
};

export type AddRoomPreview = {
  checkIn: string | null;
  checkOut: string | null;
  nights: string[];
  refusal: string | null;
  approvers: { may: boolean; words: string };
  party: { adults: number; childAges: number[] };
  rooms: AddRoomRow[];
  serviceChargeRate: number | null;
  gstRate: number | null;
};

export function previewAddRoom(session: Session, entryId: string) {
  return apiRequest<AddRoomPreview>(`/api/entries/${entryId}/add-room/preview`, { session, method: "POST", body: {} });
}

export type AddRoomsOutcome = {
  roomNumbers: string[];
  party: { adultCount: number; childCount: number; childAges: number[]; guestCount: number };
  outcome: {
    quotationId: string | null;
    pricing: { priorTotal: number | null; newTotal: number | null; delta: number | null; currency: string | null };
    walk: { returnedToOrigin: boolean; reachedStage: string; blocked: { atStep: string; code: string | null; message: string } | null };
    heldDocuments: Array<{ id: string; kind: string; documentId: string }>;
  };
};

export function addRooms(
  session: Session,
  entryId: string,
  body: { roomIds: string[]; adults: number; childAges: number[]; roomCompositions: RoomCompositionInput[]; reason?: string | null },
) {
  return apiRequest<AddRoomsOutcome>(`/api/entries/${entryId}/add-room`, { session, method: "POST", body });
}

export function discardPendingGuests(session: Session, entryId: string, subjectKeys: string[]) {
  return apiRequest<{ discarded: number }>(`/api/entries/${entryId}/add-room/discard-guests`, { session, method: "POST", body: { subjectKeys } });
}
