import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type RoomListItem = {
  id: string;
  roomNumber: string;
  physicalState?: string;
  roomTypeId?: string;
  floorNumber?: number | null;
  /** Physical bed setup — "KING" / "TWIN" / "QUEEN" / "SINGLE" (from the room registry). */
  bedType?: string | null;
  bedCount?: number | null;
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

/** Change a room's physical bed setup (L1 — a housekeeping fact; traced with the prior value). */
export async function setRoomBedType(session: Session, roomId: string, bedType: string) {
  return apiRequest<{ id: string; roomNumber: string; bedType: string | null; bedCount: number | null }>(
    `/api/rooms/${roomId}/bed-type`,
    { method: "POST", session, body: { bedType } },
  );
}
