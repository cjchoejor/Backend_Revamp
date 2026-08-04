import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type RoomListItem = {
  id: string;
  roomNumber: string;
  physicalState?: string;
  roomTypeId?: string;
  floorNumber?: number | null;
  currentClaimState?: string;
  isBlocked?: boolean;
  blockedReason?: string | null;
  isDeficient?: boolean;
  isUnderMaintenance?: boolean;
  roomType?: {
    id: string;
    code: string;
    name: string;
    standardCapacity?: number;
    maxCapacity?: number;
    maxChildren?: number;
    requiredAccompanyingAdults?: number;
    maxExtraBeds?: number;
  } | null;
};

export async function listRooms(session: Session) {
  return apiRequest<{ items: RoomListItem[]; count: number }>("/api/rooms", { session });
}

// --- Spaces (operational read, L1+) -------------------------------------
// `/api/admin/spaces` is L4-only, which is right for editing the inventory but leaves the desk
// unable to even see spaces. This read-only list lets front desk report faults against them.

export type SpaceListItem = {
  id: string;
  code: string;
  name: string;
  spaceType: string;
  capacity: number;
  defaultCapacity: number;
  isAvailable: boolean;
  isEventInProgress: boolean;
  isDeficient: boolean;
};

export async function listSpaces(session: Session) {
  return apiRequest<{ items: SpaceListItem[]; count: number }>("/api/spaces", { session });
}

// --- Deficiency reporting (operational, 2026-08-04) ----------------------
// Reporting a fault used to be L4-only on the admin console, so a broken room stayed sellable
// until an admin was around. Front desk (L1) now reports directly and the target leaves service
// immediately; a supervisor (L2+) then confirms or rejects. Reports raised BY an L2+ arrive
// already verified.

export type DeficientVerificationStatus = "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED";

export type DeficientConditionRecord = {
  id: string;
  roomId: string | null;
  spaceId: string | null;
  category: string;
  description: string;
  detectedAt: string;
  detectedBy: string;
  resolutionDeadline: string;
  status: string;
  verificationStatus: DeficientVerificationStatus;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNotes: string | null;
  room?: { id: string; roomNumber: string } | null;
  space?: { id: string; code: string; name: string } | null;
};

export type ReportDeficiencyInput = {
  category: string;
  description: string;
  resolutionDeadline?: string | null;
};

export async function reportRoomDeficiency(session: Session, roomId: string, body: ReportDeficiencyInput) {
  return apiRequest<DeficientConditionRecord>(`/api/rooms/${roomId}/deficient-conditions`, { method: "POST", session, body });
}

export async function reportSpaceDeficiency(session: Session, spaceId: string, body: ReportDeficiencyInput) {
  return apiRequest<DeficientConditionRecord>(`/api/spaces/${spaceId}/deficient-conditions`, { method: "POST", session, body });
}

/** L2+ only. Rejecting requires a reason and returns the target to service. */
export async function verifyDeficiency(session: Session, recordId: string, body: { accept: boolean; notes?: string | null }) {
  return apiRequest<DeficientConditionRecord>(`/api/deficient-conditions/${recordId}/verify`, { method: "POST", session, body });
}

export async function listPendingVerifications(session: Session) {
  return apiRequest<{ items: DeficientConditionRecord[]; count: number }>("/api/deficient-conditions/pending-verification", { session });
}

export async function listRoomDeficiencies(session: Session, roomId: string) {
  return apiRequest<{ items: DeficientConditionRecord[] }>(`/api/rooms/${roomId}/deficient-conditions`, { session });
}

export async function listSpaceDeficiencies(session: Session, spaceId: string) {
  return apiRequest<{ items: DeficientConditionRecord[] }>(`/api/spaces/${spaceId}/deficient-conditions`, { session });
}

/** Mark a fault fixed. L1+ — front desk both find and clear these. */
export async function resolveDeficiency(session: Session, recordId: string, resolutionNotes?: string) {
  return apiRequest<DeficientConditionRecord>(`/api/deficient-conditions/${recordId}/finalize`, {
    method: "PATCH",
    session,
    body: { status: "RESOLVED", resolutionNotes },
  });
}
