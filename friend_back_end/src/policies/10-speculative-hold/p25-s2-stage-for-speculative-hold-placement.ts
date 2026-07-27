import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 25 — speculative hold placement requires entry at S2. */
export function enforceEntryAtS2ForSpeculativeHoldPlacement(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S2) return;
  throw new StageGateBlockedError("Entry must be at S2 to place speculative hold", "NOT_AT_S2");
}
