/**
 * Leaving early — the whole booking or some of its rooms, today or a later day — and a room added to
 * a stay in house (2026-11-26). Every figure is the server's.
 * back_end/src/services/domain/{early-departure,rooms-leaving-early,add-room-to-stay}-service.ts.
 */
import type { Session } from "@/types/session";
import { apiRequest } from "./client";

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
  body: { departureDate?: string; roomIds?: string[]; billing?: "TOGETHER" | "OWN"; reason: string; waiveFee?: boolean; waiveReason?: string },
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

export type AddRoomPreview = {
  startDate: string;
  endDate: string | null;
  nights: number;
  requiredLevel: "L3";
  refusal: string | null;
  serviceChargeRate?: number | null;
  gstRate?: number | null;
  rooms: Array<{ roomId: string; roomNumber: string; roomTypeId: string | null; roomTypeName: string | null; bedType: string | null; needsCleaning: boolean }>;
  types: Array<{
    roomTypeId: string;
    name: string;
    freeCount: number;
    maxCapacity: number | null;
    roomRate: number | null;
    packageName: string | null;
    extraBedRate: number | null;
    breakfastRate: number | null;
    lunchRate: number | null;
    dinnerRate: number | null;
    cpRate: number | null;
    mapLunchRate: number | null;
    mapDinnerRate: number | null;
    apRate: number | null;
  }>;
};

export function previewAddRoom(session: Session, entryId: string, body: { startDate?: string }) {
  return apiRequest<AddRoomPreview>(`/api/entries/${entryId}/add-room/preview`, { session, method: "POST", body });
}

export type AddRoomOutcome = {
  newEntryId: string;
  roomNumber: string;
  checkInDate: string;
  checkOutDate: string;
  reachedStage: string;
  roomHandedOut: boolean;
  blocked: { atStep: string; message: string } | null;
  notes: string[];
  quotationId: string | null;
  quotationTotal: number | null;
};

export function addRoom(
  session: Session,
  entryId: string,
  body: { roomId: string; startDate?: string; adults: number; childAges: number[]; mealPlan: "EP" | "CP" | "MAPL" | "MAPD" | "AP"; reason: string },
) {
  return apiRequest<AddRoomOutcome>(`/api/entries/${entryId}/add-room`, { session, method: "POST", body });
}
