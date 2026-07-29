import { ValidationError } from "../../lib/errors.js";
import {
  dayKey,
  nightKeys,
  resolveNights,
  totalMealPlanAssignments,
  totalPeopleFromComposition,
  type RoomCompositionInput,
} from "../../lib/room-composition.js";

/**
 * Policy 79 (2026-07-28) — a per-night meal override must land on a night the guest is
 * actually staying.
 *
 * Checked server-side rather than trusting the picker: the desk limits the date input to the
 * stay, but the endpoint is the contract, and an override on a night outside the stay would
 * silently never price (the night loop only walks real stay-nights) — the operator would
 * think they'd recorded a plan that quietly did nothing.
 *
 * Skipped when the composition has no start date: without one there is no way to say which
 * night is which, and `computeRoomComposition` ignores the overrides for the same reason.
 */
export function enforceNightOverridesWithinStay(
  input: RoomCompositionInput & { roomNumber?: string | null },
  nights: number,
): void {
  const overrides = input.nightMealOverrides ?? [];
  if (overrides.length === 0) return;
  if (!input.startDate) {
    throw new ValidationError(
      `Room ${input.roomNumber ?? ""}: per-night meal plans need the room's stay dates before they can be applied.`.trim(),
    );
  }
  const valid = new Set(nightKeys(input, nights));
  for (const o of overrides) {
    if (!o?.date || Number.isNaN(o.date.getTime())) {
      throw new ValidationError(`Room ${input.roomNumber ?? ""}: a per-night meal plan has no valid date.`.trim());
    }
    const key = dayKey(o.date);
    if (!valid.has(key)) {
      const first = [...valid][0];
      const last = [...valid][valid.size - 1];
      throw new ValidationError(
        `Room ${input.roomNumber ?? ""}: ${key} is outside this stay — nights run ${first} to ${last}.`.trim(),
      );
    }
  }
  // Two overrides for the same night would make pricing depend on array order.
  const seen = new Set<string>();
  for (const o of overrides) {
    const key = dayKey(o.date);
    if (seen.has(key)) {
      throw new ValidationError(`Room ${input.roomNumber ?? ""}: ${key} has more than one meal plan set.`.trim());
    }
    seen.add(key);
  }
}

/** Convenience for callers that don't already know the night count. */
export function enforceNightOverridesWithinStayUsingContext(
  input: RoomCompositionInput & { roomNumber?: string | null },
  ctx: Parameters<typeof resolveNights>[1],
): void {
  enforceNightOverridesWithinStay(input, resolveNights(input, ctx));
}

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

  // Rule (2) again, per overridden night (2026-07-28). An override REPLACES the room-level
  // distribution for that night, so it has to satisfy the same ceiling on its own — otherwise
  // a room for 2 could be given 3 AP covers on the 14th and price for a guest who isn't there.
  for (const night of input.nightMealOverrides ?? []) {
    const nightTotal = totalMealPlanAssignments({
      mealPlanCpCount: night.mealPlanCpCount,
      mealPlanMaplCount: night.mealPlanMaplCount,
      mealPlanMapdCount: night.mealPlanMapdCount,
      mealPlanApCount: night.mealPlanApCount,
      mealPlanOthersCount: night.mealPlanOthersCount,
    });
    if (nightTotal > occupants) {
      const when = night.date instanceof Date && !Number.isNaN(night.date.getTime())
        ? night.date.toISOString().slice(0, 10)
        : "that night";
      throw new ValidationError(
        `Room ${input.roomNumber ?? ""}: meal-plan assignments on ${when} (${nightTotal}) exceed occupant count (${occupants}).`.trim(),
      );
    }
  }
}
