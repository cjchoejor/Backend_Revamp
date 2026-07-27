import { EntryStatus, Stage } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S1 lifecycle: park / unpark / S1→S2 must not operate on EXPIRED entries. */
export function enforceEntryNotExpiredForS1Lifecycle(input: { status: EntryStatus }) {
  if (input.status !== EntryStatus.EXPIRED) return;
  throw new StateTransitionError("Entry is EXPIRED");
}

/** Policy 1 — park requires ACTIVE entry. */
export function enforceEntryActiveForPark(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.ACTIVE) return;
  throw new StateTransitionError("Entry must be ACTIVE to park");
}

/** Policy 1 — unpark requires PARKED entry. */
export function enforceEntryParkedForUnpark(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.PARKED) return;
  throw new StateTransitionError("Entry must be PARKED to unpark");
}

/** Policy 1 — S1→S2 progression requires non-expired entry at S1. */
export function enforceEntryAtS1ForS1ToS2Progression(input: { status: EntryStatus; currentStage: Stage }) {
  enforceEntryNotExpiredForS1Lifecycle(input);
  if (input.currentStage === Stage.S1) return;
  throw new StateTransitionError("Entry is not at S1");
}
