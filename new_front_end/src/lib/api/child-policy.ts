import type { Session } from "@/types/session";
import { apiRequest } from "./client";

export type ChildPolicyBundle = {
  ageBands: { enabled: boolean; youngChildMaxAge: number; childMaxAge: number };
  mealPricing: { enabled: boolean; youngChildPercent: number; childPercent: number; adultPercent: number };
  separateBedCharge: { enabled: boolean; basis: "FLAT" | "PERCENT_OF_ROOM"; amount: number; currency: string };
  unaccompaniedMinor: { enabled: boolean; minimumAge: number };
  adultToChildRatio: { enabled: boolean; maxChildrenPerAdult: number };
};

/** L1-accessible read of the live child-policy bundle. Used by the booking flow to keep the
 *  child-age input's UI cap in sync with the configured `unaccompaniedMinor.minimumAge`. */
export function getChildPolicy(session: Session) {
  return apiRequest<ChildPolicyBundle>("/api/lookups/child-policy", { session });
}

export type AllowedRoomCountsResponse = {
  chargeableOccupants: number;
  /** min = rooms the party needs at least; max is clamped to the hotel's registered room count. */
  allowedRoomCounts: { min: number; max: number };
  bandBreakdown: { young: number; child: number; adult: number };
  maxCapacityUsed: number;
  /** Live room-registry counts (Room / RoomType tables, never config). */
  hotelRoomCount: number;
  hotelMaxOccupants: number;
  /** True when the party can't fit in the hotel at all — create-entry rejects it server-side too. */
  exceedsHotelCapacity: boolean;
};

/**
 * Backend-authoritative capacity math. Given a proposed composition + max-capacity ceiling,
 * returns the chargeable-occupants count + the allowed number-of-rooms envelope. Replaces
 * the frontend-only mirror in `lib/chargeable-occupants.ts` — the backend now owns the
 * calculation so ANY frontend (main testing UI + the friend's real UI) can consume the same
 * answer without duplicating business logic.
 */
export function getAllowedRoomCounts(
  session: Session,
  body: { adults: number; childAges: number[]; maxCapacity?: number },
) {
  return apiRequest<AllowedRoomCountsResponse>("/api/lookups/allowed-room-counts", {
    method: "POST",
    session,
    body,
  });
}
