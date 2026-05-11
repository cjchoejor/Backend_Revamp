import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 1 — S9 entry closure requires entry at S9. */
export function enforceEntryAtS9ForS9Closure(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S9) return;
  throw new StageGateBlockedError("Entry must be at S9 to close", "NOT_AT_S9");
}
