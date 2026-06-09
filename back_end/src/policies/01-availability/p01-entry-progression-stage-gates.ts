import { EntryStatus, Stage } from "@prisma/client";
import { StageGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S5→S6 progression requires entry at S5. */
export function enforceEntryAtS5ForS5ToS6Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StageGateBlockedError("Entry is not at S5", "NOT_AT_S5");
}

/** Policy 1 — S6→S1 re-entry (room change) requires entry at S6. */
export function enforceEntryAtS6ForS6ToS1ReEntry(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S6) return;
  throw new StageGateBlockedError("Entry must be at S6 for re-entry", "NOT_AT_S6");
}

/** Policy 1 — check-in completion (S6→S7) requires entry at S6. */
export function enforceEntryAtS6ForCheckInCompletionToS7(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S6) return;
  throw new StageGateBlockedError("Entry must be at S6 to complete check-in", "NOT_AT_S6");
}

/** Policy 1 — S7→S8 progression requires entry at S7. */
export function enforceEntryAtS7ForS7ToS8Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StageGateBlockedError("Entry is not at S7", "NOT_AT_S7");
}

/** Policy 1 — S5-only cancellation route (`CancellationService.cancelEntryAtS5`). */
export function enforceEntryAtS5ForS5CancellationRoute(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StageGateBlockedError(
    "Cancellation at this route is only supported for entries at S5",
    "NOT_AT_S5",
  );
}

/** Policy 1 — SIG-S3 §6.5 — pre-confirmation cancellation while at S3 (`CancellationService.cancelEntryAtS3`). */
export function enforceEntryAtS3ForS3CancellationRoute(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S3) return;
  throw new StageGateBlockedError(
    "S3 cancellation is only supported for entries currently at S3",
    "NOT_AT_S3",
  );
}

/** Policy 1 — SIG-S6 Policy 35 — post-check-in early departure (`CancellationService.cancelEntryEarlyDepartureAfterCheckIn`). */
export function enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StageGateBlockedError(
    "Early departure cancellation is only supported for checked-in entries at S7",
    "NOT_AT_S7",
  );
}

/** Policy 1 — no-show determination flow requires entry at S5. */
export function enforceEntryAtS5ForNoShowActions(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S5) return;
  throw new StateTransitionError("No-show actions are only valid at S5");
}

/** Policy 1 — H4 initiation requires entry at S7. */
export function enforceEntryAtS7ForH4Initiation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StateTransitionError("Entry must be at S7 to initiate H4", "NOT_AT_S7");
}

/** Policy 1 — H4 initiation requires ACTIVE entry. */
export function enforceEntryActiveForH4Initiation(input: { status: EntryStatus }) {
  if (input.status === EntryStatus.ACTIVE) return;
  throw new StateTransitionError("Entry must be ACTIVE to initiate H4");
}

/** Policy 1 — createH2 requires active entry at S6. */
export function enforceEntryAtS6AndActiveForCreateH2(input: { currentStage: Stage; status: EntryStatus }) {
  if (input.currentStage === Stage.S6 && input.status === EntryStatus.ACTIVE) return;
  throw new StateTransitionError("createH2 is only available for active entries at S6");
}

/** Policy 1 — S7 room-change re-entry (application slice) requires entry at S7. */
export function enforceEntryAtS7ForRoomChangeReEntry(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StateTransitionError("Room change re-entry is only supported from S7", "NOT_AT_S7");
}

/** Policy 1 — generic progressive stage route must not operate on CLOSED entries. */
export function enforceEntryNotClosedForStageProgression(input: { status: EntryStatus }) {
  if (input.status !== EntryStatus.CLOSED) return;
  throw new StateTransitionError("Cannot progress stage for CLOSED entry", "ENTRY_ALREADY_CLOSED");
}

/** Policy 1 — S2→S3 progression requires entry at S2 (StateTransitionError matches prior service). */
export function enforceEntryAtS2ForS2ToS3Progression(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S2) return;
  throw new StateTransitionError("Entry is not at S2");
}
