import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type RoomListItem = {
  id: string;
  roomNumber: string;
  physicalState?: string;
  roomTypeId?: string;
  floorNumber?: number | null;
  /** How the room is made up NOW — "KING" / "TWIN" / "QUEEN" / "SINGLE". The desk changes it. */
  bedType?: string | null;
  bedCount?: number | null;
  /** The setups THIS room can be made up in — its own list, else its type's, else all of them
   *  (2026-09-19; set in the admin console). The edit dropdowns read this, never a fixed list. */
  allowedBedTypes?: string[];
  /** Where that list comes from: the room's own, its type's, or no limit set. */
  allowedBedTypesSource?: "ROOM" | "ROOM_TYPE" | "ALL";
  /** The room's usual setup — its own, else its type's (Standard: Twin, Suite: King). The room
   *  goes back to it when the guest leaves. Null when none is stated. */
  defaultBedType?: string | null;
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

/**
 * Put a blocked room back in service — GM (L3) and above. The reason is recorded on a trace
 * against the room. Blocks have no expiry, so unlike a hold this only ever clears by decision.
 */
export async function releaseRoomBlock(session: Session, roomId: string, body: { releaseReason: string }) {
  return apiRequest<{ id: string; roomNumber: string }>(`/api/rooms/${roomId}/release-block`, {
    method: "POST",
    session,
    body,
  });
}

export async function listRooms(session: Session) {
  // `bedTypes` = the backend's allowed bed vocabulary (KING/QUEEN/TWIN/SINGLE) — the source
  // for any bed-type dropdown, never hardcoded client-side.
  return apiRequest<{ items: RoomListItem[]; count: number; bedTypes?: string[] }>("/api/rooms", { session });
}

export type BedRequestCheck = {
  /** Every asked setup can have its own room at once. */
  satisfiable: boolean;
  perType: { bedType: string; asked: number; roomsThatCanTake: number; covered: number }[];
  /** How many rooms can take each setup — the "up to N" ceilings. */
  stock: Record<string, number>;
  /** Why it cannot be met, in desk words. */
  message: string | null;
};

/**
 * Can this bed request be met? The server's own check (the one intake applies on save).
 * Without `roomIds` it is judged against every room; with them, against those rooms only.
 */
export async function checkBedRequest(session: Session, request: Record<string, number>, roomIds?: string[]) {
  return apiRequest<BedRequestCheck>("/api/lookups/bed-request-check", {
    method: "POST",
    session,
    body: { request, ...(roomIds ? { roomIds } : {}) },
  });
}

/**
 * Change how a room is made up (L1 — a housekeeping fact; traced with the prior value). Pass the
 * booking the change is for: when that guest leaves, the room goes back to its usual setup.
 */
export async function setRoomBedType(session: Session, roomId: string, bedType: string, entryId?: string) {
  return apiRequest<{ id: string; roomNumber: string; bedType: string | null; bedCount: number | null }>(
    `/api/rooms/${roomId}/bed-type`,
    { method: "POST", session, body: { bedType, ...(entryId ? { entryId } : {}) } },
  );
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
/** The fault categories a report accepts — the admin's active list (2026-09-18). */
export async function listDeficientCategories(session: Session) {
  return apiRequest<{ items: Array<{ code: string; label: string }> }>("/api/lookups/deficient-categories", { session });
}

export async function resolveDeficiency(session: Session, recordId: string, resolutionNotes?: string) {
  return apiRequest<DeficientConditionRecord>(`/api/deficient-conditions/${recordId}/finalize`, {
    method: "PATCH",
    session,
    body: { status: "RESOLVED", resolutionNotes },
  });
}
