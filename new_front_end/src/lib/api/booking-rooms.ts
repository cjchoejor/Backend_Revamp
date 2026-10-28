/**
 * Rooms by type (2026-10-28, docs/room-types-until-arrival.md). Until Arrival a booking picked by
 * type holds room TYPES; the system keeps a real room behind each and may move it within the type.
 * Every rule lives on the server — the desk asks, shows and sends.
 */
import { apiRequest } from "@/lib/api/client";
import type { Session } from "@/types/session";

export type HouseTypeAnswer = {
  roomTypeId: string;
  code: string;
  name: string;
  rooms: number;
  perNight: Array<{ date: string; usable: number; taken: number; free: number }>;
  freeEveryNight: number;
  wholeStay: number;
  wholeStayUncertain: boolean;
  quietStays: number;
};

export type HouseByType = {
  entryId: string;
  checkInDate: string;
  checkOutDate: string;
  nights: string[];
  types: HouseTypeAnswer[];
};

export type BookingRoomNight = { date: string; roomTypeId: string; roomId: string | null; fixed: boolean };
export type BookingRoom = { key: string; nights: BookingRoomNight[] };

export type SealByTypeAnswer = {
  fits: boolean;
  refusals: string[];
  bookingRooms: BookingRoom[];
  perNight: Array<{ date: string; roomIds: string[] }>;
  saved: boolean;
  check: {
    moves: Array<{ entryId: string; booking: string; fromRoomNumber: string; toRoomNumber: string; span: string }>;
  } | null;
};

export type BookingRoomsView = {
  byType: boolean;
  movable: boolean;
  /** At Arrival the system's rooms are a proposal, named by number for the desk to confirm. */
  atArrival?: boolean;
  rooms: Array<{
    roomId: string;
    roomNumber: string | null;
    roomTypeId: string;
    typeName: string;
    nights: string[];
    quiet: boolean;
    /** The room's number within its type, for a room the system chose — "room 2". */
    ordinal: number | null;
    label: string;
  }>;
  bookingRooms?: BookingRoom[];
};

export function getHouseByType(session: Session, entryId: string) {
  return apiRequest<HouseByType>(`/api/entries/${entryId}/availability/by-type`, { method: "POST", session, body: {} });
}

export function sealRoomsByType(
  session: Session,
  entryId: string,
  body: {
    configurationId: string;
    perNight: Array<{ date: string; types: Array<{ roomTypeId: string; count: number }> }>;
    fixedRoomIds?: string[];
    preview?: boolean;
  },
) {
  return apiRequest<SealByTypeAnswer>(`/api/entries/${entryId}/availability/by-type/seal`, { method: "POST", session, body });
}

export function getBookingRooms(session: Session, entryId: string) {
  return apiRequest<BookingRoomsView>(`/api/entries/${entryId}/booking-rooms`, { session });
}

export function chooseBookingRoom(session: Session, entryId: string, body: { fromRoomId: string; toRoomId: string }) {
  return apiRequest<{ moved: boolean; othersMoved: number }>(`/api/entries/${entryId}/booking-rooms/choose`, { method: "POST", session, body });
}

/** Several of the booking's rooms given at once (the chart's drop of several rooms). */
export function chooseBookingRooms(session: Session, entryId: string, picks: Array<{ fromRoomId: string; toRoomId: string }>) {
  return apiRequest<{ moved: boolean; othersMoved: number; given: Array<{ fromRoomId: string; toRoomId: string; toRoomNumber: string | null }> }>(
    `/api/entries/${entryId}/booking-rooms/choose`,
    { method: "POST", session, body: { picks } },
  );
}

export type QuietRoomChoice = {
  roomId: string;
  roomNumber: string;
  /** It can be given — free, or held quietly by a booking the system moves out of the way. */
  available: boolean;
  fault: boolean;
  moves: Array<{ booking: string; fromRoomNumber: string; toRoomNumber: string }>;
  /** What giving it does, or why not: "free", "held as the system's choice — X moves to 207", "held for X on these nights". */
  words: string;
};

/** The other rooms of a room's type over its nights, and what giving each would do. Nothing written. */
export function getQuietRoomChoices(session: Session, entryId: string, fromRoomId: string) {
  return apiRequest<{ typeName: string | null; choices: QuietRoomChoice[] }>(
    `/api/entries/${entryId}/booking-rooms/choices?fromRoomId=${encodeURIComponent(fromRoomId)}`,
    { session },
  );
}

/**
 * "Deluxe Double · room 2" for each room the system chose, in the order of the booking rooms (key
 * order). Every room of a type takes its place in the count — a guest's own room too, though it is
 * named by its number — so a label stays put when another room is fixed. The server counts the same
 * way (`describeBookingRooms`).
 */
export function labelsForBookingRooms(rooms: BookingRoom[], typeName: (id: string) => string): Map<string, string> {
  const out = new Map<string, string>();
  const counted = new Set<string>();
  const perType = new Map<string, number>();
  for (const r of [...rooms].sort((a, b) => (Number(a.key.slice(1)) || 0) - (Number(b.key.slice(1)) || 0))) {
    for (const n of r.nights) {
      if (!n.roomId || counted.has(n.roomId)) continue;
      counted.add(n.roomId);
      const k = (perType.get(n.roomTypeId) ?? 0) + 1;
      perType.set(n.roomTypeId, k);
      if (!n.fixed) out.set(n.roomId, `${typeName(n.roomTypeId)} · room ${k}`);
    }
  }
  return out;
}
