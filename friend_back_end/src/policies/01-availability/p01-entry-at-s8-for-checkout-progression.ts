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

/** Policy 1 — S8 key return (same error envelope as prior checkout service). */
export function enforceEntryAtS8ForKeyReturn(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Key return is only valid at S8", "NOT_AT_S8");
}

/** Policy 1 — S8 room inspection record (same error envelope as prior checkout service). */
export function enforceEntryAtS8ForRoomInspection(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Room inspection is only valid at S8", "NOT_AT_S8");
}

/** Policy 1 — S8 physical checkout completion (same error envelope as prior checkout service). */
export function enforceEntryAtS8ForCheckoutCompletion(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Checkout completion is only valid at S8", "NOT_AT_S8");
}
