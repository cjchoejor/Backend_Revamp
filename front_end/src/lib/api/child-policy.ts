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
