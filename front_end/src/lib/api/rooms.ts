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
  return apiRequest<{ items: RoomListItem[]; count: number }>("/api/rooms", { session });
}
