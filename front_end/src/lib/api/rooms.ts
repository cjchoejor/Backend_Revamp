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
