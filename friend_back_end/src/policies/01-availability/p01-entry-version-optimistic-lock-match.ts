import { StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — optimistic concurrency on entry row (S4 confirmation and similar). */
export function enforceEntryVersionMatchesClientForOptimisticLock(input: { entryVersion: number; clientVersion: number }) {
  if (input.entryVersion === input.clientVersion) return;
  throw new StateTransitionError("Entry version mismatch", "OPTIMISTIC_LOCK");
}
