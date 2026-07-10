/**
 * Named shape for `HandoffRecord.checklistContent` — replaces the ad-hoc `as any` casts
 * spread through the check-in / handoff services. Not every field applies to every handoff
 * type; the shape is a union of everything ever written. Keep additions strictly optional
 * so legacy rows keep parsing.
 */
export type HandoffChecklistContent = {
  roomNumber?: string;
  guestProfileId?: string | null;
  expectedStayNights?: number;
  guestCount?: number;
  mealPlan?: string;
  dietaryRequirements?: unknown;
  packageInclusions?: unknown;
  stayDuration?: {
    checkInDate?: string;
    checkOutDate?: string;
  };
  cuisinePreferences?: unknown;
};

/** Safely narrow a `handoff.checklistContent` value (JSON) to the named shape. */
export function readHandoffChecklistContent(value: unknown): HandoffChecklistContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as HandoffChecklistContent;
}
