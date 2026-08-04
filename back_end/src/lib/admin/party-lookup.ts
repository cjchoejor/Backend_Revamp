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
