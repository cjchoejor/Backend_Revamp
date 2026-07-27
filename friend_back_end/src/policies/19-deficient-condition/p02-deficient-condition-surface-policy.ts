/**
 * Policy 2 — DEFICIENT Condition Surface Policy (DEV-SPEC Part 5).
 *
 * Canon intent: DEFICIENT rooms must be surfaced (flagged) in availability results;
 * assignability is governed elsewhere (Policy 48).
 *
 * This policy is a pure evaluator/annotator: it does not filter out rooms.
 */
export function annotateDeficientRoomSurface<T extends { isDeficient?: boolean; deficientConditionCategory?: string | null }>(
  rooms: T[],
): Array<T & { isDeficient: boolean; deficientConditionCategory: string | null }> {
  return rooms.map((r) => ({
    ...r,
    isDeficient: r.isDeficient === true,
    deficientConditionCategory: (r.deficientConditionCategory ?? null) as string | null,
  }));
}

