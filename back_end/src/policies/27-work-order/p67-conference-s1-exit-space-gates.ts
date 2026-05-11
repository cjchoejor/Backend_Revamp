import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 67 — attendee count must not exceed resolved space capacity when capacity is known (> 0). */
export function enforceConferenceSpaceAttendeeCapacity(input: { attendeeCount: number; capacity: number }) {
  const cap = input.capacity;
  if (!(cap > 0) || input.attendeeCount <= cap) return;
  throw new StageGateBlockedError("Attendee count exceeds space capacity", "ATTENDEE_EXCEEDS_CAPACITY");
}

/**
 * Policy 67 — Conference / space use (SIG-S1 exit slice).
 */
export function enforceConferenceSpaceAllocationForS1Exit(input: {
  useType: string;
  spaceAllocations: Array<{
    eventBlock?: { attendeeCount?: number; seatingConfig?: unknown } | null;
    space?: { capacity?: number; defaultCapacity?: number } | null;
  }> | null | undefined;
}) {
  if (input.useType !== "CONFERENCE") return;
  const allocs = input.spaceAllocations ?? [];
  if (allocs.length === 0) {
    throw new StageGateBlockedError("Conference entries require space allocation at S1", "MISSING_SPACE_ALLOCATION");
  }
  const alloc = allocs[0];
  const attendeeCount = Number((alloc?.eventBlock as { attendeeCount?: number } | null | undefined)?.attendeeCount);
  const seatingConfig = (alloc?.eventBlock as { seatingConfig?: unknown } | null | undefined)?.seatingConfig;
  if (!Number.isFinite(attendeeCount) || attendeeCount < 1) {
    throw new StageGateBlockedError("Conference attendeeCount required in eventBlock", "MISSING_ATTENDEE_COUNT");
  }
  if (!seatingConfig) {
    throw new StageGateBlockedError("Conference seatingConfig required in eventBlock", "MISSING_SEATING_CONFIG");
  }
  const cap = Number(alloc?.space?.capacity ?? (alloc?.space as { defaultCapacity?: number } | null | undefined)?.defaultCapacity ?? 0);
  enforceConferenceSpaceAttendeeCapacity({ attendeeCount, capacity: cap });
}
