import { Stage } from "@prisma/client";
import { StageGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S8→S9 progression requires entry at S8. */
export function enforceEntryAtS8ForS8ToS9Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StageGateBlockedError("Entry is not at S8", "NOT_AT_S8");
}

/** Policy 1 — S8 settlement operations (StateTransitionError envelope matches prior service behavior). */
export function enforceEntryAtS8ForSettlementOperations(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Settlement is only valid at S8", "NOT_AT_S8");
}
