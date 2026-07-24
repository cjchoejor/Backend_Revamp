import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 1 — conference space allocation requires entry at S1 in this slice. */
export function enforceEntryAtS1ForConferenceSpaceAllocation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1) return;
  throw new StageGateBlockedError("Entry must be at S1", "NOT_AT_S1");
}
