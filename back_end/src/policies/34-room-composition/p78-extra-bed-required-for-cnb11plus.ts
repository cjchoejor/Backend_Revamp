import { ValidationError } from "../../lib/errors.js";

/**
 * Policy 78 — Extra bed required when a room has 2+ adults AND any CNB 11+ child
 * (per-room composition track, Phase A, 2026-07-27).
 *
 * Business rule from the user 2026-07-27:
 *   "if a room has 2 adults and a child 11+ then that room should have an extra bed
 *    installed mandatorily"
 *
 * Applied at:
 *   - S2 quotation composition save (block operator from saving a room where the rule fails)
 *   - S4 confirmation gate (belt-and-braces — refuse to freeze a composition that violates)
 *
 * Ignored when:
 *   - The room has fewer than 2 adults (single-adult + child is fine on one bed)
 *   - No CNB 11+ children in the room
 *   - `isFoc === true` (waived rooms don't need to conform — the guest is on the house)
 */
export function enforceExtraBedForCnb11Plus(input: {
  roomNumber?: string | null;
  adultCount?: number | null;
  cnb11PlusCount?: number | null;
  extraBedCount?: number | null;
  isFoc?: boolean;
}): void {
  if (input.isFoc === true) return;
  const adults = input.adultCount ?? 0;
  const cnb11 = input.cnb11PlusCount ?? 0;
  const extraBeds = input.extraBedCount ?? 0;
  if (adults < 2) return;
  if (cnb11 <= 0) return;
  if (extraBeds > 0) return;
  throw new ValidationError(
    `Room ${input.roomNumber ?? ""} has ${adults} adults and ${cnb11} child(ren) 11+. An extra bed is required — add at least 1 extra bed or lower the adult count.`.trim(),
  );
}
