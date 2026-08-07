/**
 * Every room a CommittedHold is actually holding.
 *
 * A booking has ONE CommittedHold row with ONE `roomId` column. On a multi-room booking the
 * extra rooms live in the `perNightBreakdown` JSON snapshot, so `roomId` alone under-reports
 * what the hold covers — it names the primary room and nothing else.
 *
 * WHY THIS IS A LIB (2026-08-04)
 * ------------------------------
 * Availability read `hold.roomId` directly and never opened the JSON, so a nine-room booking
 * blocked exactly one room. Observed on ENT-20260722-0001 (S6, in-house, hold CONFIRMED): room
 * 205 blocked, while 301/302/303/304/305/307/501/502 were offered as free for the same dates.
 *
 * The gap only shows before room assignment. Once S5 creates `RoomAssignment` rows the
 * reservation blocks each room properly, which is why it stayed hidden — but for a group
 * booking that window can be weeks.
 *
 * `s3-hold-service` already had this logic as a private function and `option-selected-reader`
 * has the sibling for sealed availability configs. Both stayed local, so the availability path
 * never got either. One exported helper now, used everywhere a hold's footprint matters.
 */

/** The per-night snapshot written at hold placement: one entry per night, each listing rooms. */
type PerNightBreakdown = Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }> | null | undefined;

/**
 * Distinct room ids covered by the hold: the primary `roomId` plus every room named in the
 * per-night snapshot. A mid-stay room change (201 for two nights, then 301) yields both.
 */
export function heldRoomIdsOf(hold: { roomId?: string | null; perNightBreakdown?: unknown }): string[] {
  const out = new Set<string>();
  if (hold.roomId) out.add(hold.roomId);
  const breakdown = hold.perNightBreakdown as PerNightBreakdown;
  if (Array.isArray(breakdown)) {
    for (const night of breakdown) {
      for (const r of night?.roomIds ?? []) {
        if (typeof r?.roomId === "string" && r.roomId.length > 0) out.add(r.roomId);
      }
    }
  }
  return [...out];
}
