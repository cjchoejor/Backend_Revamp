import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — stage placement (SIG-S2 auto-fulfilment slice).
 */
export function enforceEntryAtS1ForAutoFulfilS2ToS3(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1) return;
  throw new StageGateBlockedError("Entry must be at S1 for S2 auto-fulfilment", "NOT_AT_S1");
}
