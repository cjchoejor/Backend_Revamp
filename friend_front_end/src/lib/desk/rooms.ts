/**
 * Front-desk rooms board derivations.
 *
 * The backend models room state across several fields (currentClaimState,
 * physicalState, and the isBlocked / isDeficient / isUnderMaintenance flags).
 * This collapses them into the single operator-facing status the floor grid
 * shows, in priority order, with no fabrication.
 */
import type { RoomListItem } from "@/lib/api/rooms";

export type RoomStatusKey =
  | "occupied"
  | "reserved"
  | "ready"
  | "dirty"
  | "inspect"
  | "deficient"
  | "ooo";

export type RoomStatusMeta = {
  label: string;
  /** CSS var used for the status dot/text. */
  color: string;
  /** Optional tile-background class (.room.<tile>). */
  tile?: "occ" | "ooo" | "def";
};

export const ROOM_STATUS: Record<RoomStatusKey, RoomStatusMeta> = {
  occupied: { label: "Occupied", color: "var(--green)", tile: "occ" },
  reserved: { label: "Reserved", color: "var(--terra)" },
  ready: { label: "Ready", color: "var(--ok)" },
  dirty: { label: "Needs cleaning", color: "var(--warn)" },
  inspect: { label: "Cleaned · to inspect", color: "var(--epi-system)" },
  deficient: { label: "Needs attention", color: "var(--stop)", tile: "def" },
  ooo: { label: "Out of order", color: "var(--stop)", tile: "ooo" },
};

/** Display order for legend + KPI rollups. */
export const ROOM_STATUS_ORDER: RoomStatusKey[] = [
  "occupied",
  "reserved",
  "ready",
  "dirty",
  "inspect",
  "deficient",
  "ooo",
];

export function deriveRoomStatus(r: RoomListItem): RoomStatusKey {
  if (r.isUnderMaintenance || r.isBlocked) return "ooo";
  if (r.currentClaimState?.toUpperCase() === "OCCUPIED") return "occupied";
  const ps = (r.physicalState ?? "").toUpperCase();
  if (/DIRTY|NEEDS_CLEAN|SOILED|STAYOVER/.test(ps)) return "dirty";
  if (/INSPECT/.test(ps)) return "inspect";
  if (r.isDeficient) return "deficient";
  if (r.currentClaimState?.toUpperCase() === "CONFIRMED") return "reserved";
  return "ready";
}

/** Floor label from a room number ("401" → "4", "1203" → "12"). */
export function floorOf(roomNumber: string): string {
  const digits = roomNumber.match(/^\d+/)?.[0];
  if (!digits) return "Other";
  return digits.length > 2 ? digits.slice(0, -2) : digits[0];
}

/** Short room-type label from a roomTypeId like "DLX-0001" → "DLX". */
export function roomTypeShort(roomTypeId?: string): string {
  if (!roomTypeId) return "Room";
  return roomTypeId.split(/[-_]/)[0].toUpperCase();
}
