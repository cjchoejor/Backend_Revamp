import { Stage } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** SIG-S2 §3.3 / SIG-S1 — entry-level park is valid for active negotiation stages. */
export function enforceEntryParkAllowedForCurrentStage(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1 || input.currentStage === Stage.S2) return;
  throw new StateTransitionError("Entry park is only supported at S1 or S2");
}
