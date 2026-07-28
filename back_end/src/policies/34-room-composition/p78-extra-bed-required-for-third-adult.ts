import { ValidationError } from "../../lib/errors.js";

/**
 * Policy 78 — Extra bed required when a room has 3+ adults
 * (per-room composition track, Phase A, 2026-07-27; revised 2026-07-28).
 *
 * Business rule (revised by the user 2026-07-28):
 *   "if a room has 3+ adults, that room needs at least one extra bed"
 *
 * Anyone aged 11 or above counts as an adult per `registry.child.ageBands` (default
 * bands: YOUNG_CHILD 0–5, CHILD 6–10, ADULT 11+). So a room with "2 adults + a 12-year-old"
 * is 3 adults for composition purposes → mandatory extra bed. This replaces the earlier
 * `enforceExtraBedForCnb11Plus` policy, which treated 11+ children as a separate CNB
 * category — that category was retired 2026-07-28.
 *
 * Applied at:
 *   - S2 quotation composition save (block operator from saving a room where the rule fails)
 *   - S4 confirmation gate (belt-and-braces — refuse to freeze a composition that violates)
 *
 * Ignored when:
 *   - The room has 2 or fewer adults (the base 2 sleep on the default beds)
 *   - `isFoc === true` (waived rooms don't need to conform — the guest is on the house)
 */
export function enforceExtraBedForThirdAdult(input: {
  roomNumber?: string | null;
  adultCount?: number | null;
  extraBedCount?: number | null;
  isFoc?: boolean;
}): void {
  if (input.isFoc === true) return;
  const adults = input.adultCount ?? 0;
  const extraBeds = input.extraBedCount ?? 0;
  if (adults < 3) return;
  if (extraBeds > 0) return;
  throw new ValidationError(
    `Room ${input.roomNumber ?? ""} has ${adults} adults but no extra bed. An extra bed is required for 3+ adults — add at least 1 extra bed or reduce the adult count.`.trim(),
  );
}
