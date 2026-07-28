import { ValidationError } from "../../lib/errors.js";
import {
  totalMealPlanAssignments,
  totalPeopleFromComposition,
  type RoomCompositionInput,
} from "../../lib/room-composition.js";

/**
 * Policy 79 — Composition count consistency (Phase A, 2026-07-27; revised 2026-07-28).
 *
 * Enforces two invariants on a room's composition record:
 *
 *   (1) `adultCount + cnb6To10Count + cnbUnder6Count === occupantCount`
 *       — every physical guest is accounted for in exactly one bucket. Anyone aged 11+
 *       counts as an adult (per registry.child.ageBands), so there is no separate CNB 11+
 *       bucket in the composition.
 *
 *   (2) `sum(mealPlanCounts) ≤ occupantCount`
 *       — you can't have more meal-plan pax than physical people. A room with 2 guests
 *       can't have 3 people on CP.
 *
 * The `occupantCount` field is the source of truth for "how many people are in this room";
 * everything else has to add up.
 *
 * Skipped entirely when `occupantCount` is null — pre-Phase-A rows have nothing to validate.
 * The service layer decides when to require the field (typically at S4 confirmation).
 */
export function enforceCompositionCountsConsistent(input: RoomCompositionInput & {
  roomNumber?: string | null;
}): void {
  const occupants = input.occupantCount;
  if (occupants == null) return; // legacy row — nothing to check

  const peopleAssigned = totalPeopleFromComposition(input);
  if (peopleAssigned !== occupants) {
    throw new ValidationError(
      `Room ${input.roomNumber ?? ""}: guest breakdown (${peopleAssigned}) does not equal occupant count (${occupants}). ` +
        `Adults + CNB 6-10 + CNB under 6 must sum to occupantCount.`.trim(),
    );
  }

  const mealPlanTotal = totalMealPlanAssignments(input);
  if (mealPlanTotal > occupants) {
    throw new ValidationError(
      `Room ${input.roomNumber ?? ""}: meal-plan assignments (${mealPlanTotal}) exceed occupant count (${occupants}). ` +
        `A room with N guests can have at most N meal-plan slots (CP + MAPL + MAPD + AP + OTHERS combined).`.trim(),
    );
  }
}
