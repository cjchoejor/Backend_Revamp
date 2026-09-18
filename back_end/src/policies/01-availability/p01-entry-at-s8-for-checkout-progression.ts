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

/**
 * Policy 1 — where a room inspection may be recorded (2026-09-18).
 *
 * S8: any inspection, including putting it off to after departure (SIG-S8 §89).
 * S9: only the COMPLETION of an inspection put off at check-out that is still open. A put-off
 * inspection is done after the guest has gone, i.e. while the booking is at S9, and SIG-S9 §334 /
 * AC-S9-020 close S9 on "completed OR lapsed". Refusing it here left the lapse, which records
 * that nothing was found, as the only way to seal. A new deferral is never taken at S9, and
 * nothing is accepted once the inspection is done or its window has lapsed.
 */
export function enforceEntryStageForRoomInspection(input: {
  currentStage: Stage;
  isDeferred: boolean;
  deferredInspectionOpen: boolean;
}) {
  if (input.currentStage === Stage.S8) return;
  if (input.currentStage === Stage.S9) {
    if (input.isDeferred) {
      throw new StateTransitionError(
        "An inspection can only be put off at check-out — after departure, record what the inspection found",
        "INSPECTION_DEFER_ONLY_AT_S8",
      );
    }
    if (!input.deferredInspectionOpen) {
      throw new StateTransitionError(
        "No put-off inspection is waiting — the room was inspected at check-out, or its inspection window has already closed",
        "NO_DEFERRED_INSPECTION_OPEN",
      );
    }
    return;
  }
  throw new StateTransitionError(
    "A room inspection is recorded at check-out, or after departure to finish one put off at check-out",
    "NOT_AT_S8",
  );
}

/** Policy 1 — S8 physical checkout completion (same error envelope as prior checkout service). */
export function enforceEntryAtS8ForCheckoutCompletion(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Checkout completion is only valid at S8", "NOT_AT_S8");
}
