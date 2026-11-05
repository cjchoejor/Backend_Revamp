import { ValidationError } from "../errors.js";

/**
 * Shared bound for the standing-party lookups (TravelAgent / CorporateAccount).
 *
 * Both pickers open as a browsable dropdown — an empty query means "list them all" — so the cap
 * has to clear the real roster rather than trim it: the legacy import brought in 127 travel
 * agents and 9 corporate accounts. It lives here, not in either service, so the two lookups
 * can't drift into showing different amounts of the same kind of list.
 *
 * A caller that receives exactly this many rows has hit the cap and should say the list was cut
 * ("first N — keep typing to narrow") rather than present it as the complete roster.
 */
export const PARTY_LOOKUP_LIMIT = 500;

/**
 * A travel agent's or company's advance, as a percentage of the stay (2026-11-05). Undefined leaves
 * it as it is; empty or 0 is not set, which asks nothing; anything else must be up to 100.
 */
export function cleanAdvancePercent(v: number | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 0) return null;
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new ValidationError("The advance must be a percentage between 0 and 100");
  return Number(v.toFixed(2));
}
