import type { Session } from "@/types/session";
import { apiRequest } from "./client";

/** Housekeeping (2026-10-26) — which rooms need cleaning, and marking one clean. */

export type HousekeepingState = "TO_CLEAN" | "OCCUPIED" | "OUT_OF_ORDER" | "READY";

export type HousekeepingRoom = {
  roomId: string;
  roomNumber: string;
  floorNumber: number | null;
  roomTypeName: string | null;
  bedType: string | null;
  state: HousekeepingState;
  claimState: string;
  physicalState: string;
  openFault: { id: string; category: string; description: string } | null;
  toClean: null | {
    leftAt: string | null;
    leftBy: { entryId: string; guestName: string | null } | null;
    cleanBy: string | null;
    clockRunning: boolean;
    overdue: boolean;
    minutesOverdue: number | null;
  };
  nextGuest: null | {
    entryId: string;
    guestName: string | null;
    arrives: string;
    arrivesToday: boolean;
    expectedArrivalTime: string | null;
    holds: "RESERVED" | "HELD";
  };
};

export type CleanedToday = {
  roomId: string;
  roomNumber: string;
  cleanedAt: string;
  cleanedBy: string;
  cleanedByName: string | null;
  minutesTaken: number | null;
  inTime: boolean | null;
};

export type HousekeepingBoard = {
  now: string;
  windowMinutes: number;
  counts: { toClean: number; overdue: number; guestDueToday: number; occupied: number; ready: number; outOfOrder: number };
  rooms: HousekeepingRoom[];
  cleanedToday: CleanedToday[];
};

export function getHousekeepingBoard(session: Session) {
  return apiRequest<HousekeepingBoard>("/api/housekeeping/rooms", { session });
}

export function markRoomCleaned(session: Session, roomId: string, note?: string | null) {
  return apiRequest<{ roomId: string; roomNumber: string; toState: string; minutesTaken: number | null; inTime: boolean | null; clocksStopped: number }>(
    `/api/housekeeping/rooms/${encodeURIComponent(roomId)}/cleaned`,
    { session, method: "POST", body: { note: note ?? null } },
  );
}

export function markRoomNeedsCleaning(session: Session, roomId: string, reason: string) {
  return apiRequest<{ roomId: string; roomNumber: string; toState: string }>(
    `/api/housekeeping/rooms/${encodeURIComponent(roomId)}/needs-cleaning`,
    { session, method: "POST", body: { reason } },
  );
}
