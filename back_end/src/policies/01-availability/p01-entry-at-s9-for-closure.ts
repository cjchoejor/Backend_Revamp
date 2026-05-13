import { EntryStatus, Stage } from "@prisma/client";
import { StageGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S9 entry closure requires entry at S9. */
export function enforceEntryAtS9ForS9Closure(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S9) return;
  throw new StageGateBlockedError("Entry must be at S9 to close", "NOT_AT_S9");
}

/** Policy 1 — S9 closure must not run on an already-CLOSED entry. */
export function enforceEntryNotAlreadyClosed(input: { status: EntryStatus }) {
  if (input.status !== EntryStatus.CLOSED) return;
  throw new StateTransitionError("Entry is already CLOSED");
}
