import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — the QUOTED allocation an S1 availability SEARCH writes is S1-only by construction:
 * it belongs to a search, and a search only happens at S1.
 */
export function enforceEntryAtS1ForConferenceSpaceAllocation(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S1) return;
  throw new StageGateBlockedError("Entry must be at S1", "NOT_AT_S1");
}

/**
 * Policy 1 — DELIBERATELY allocating a space to a booking is valid S1–S7 (2026-09-09, operator
 * ruling: "keep it for s1 to s7, just like how rooms are booked"). A corporate guest deciding
 * mid-stay to take the hall is ordinary desk work — the charge follows through the folio, which
 * carries per-space attribution since PMS-237. S8 is check-out and S9 is sealed, so a space
 * added there would have no stay left to sit in.
 */
const SPACE_ALLOCATION_STAGES: Stage[] = [Stage.S1, Stage.S2, Stage.S3, Stage.S4, Stage.S5, Stage.S6, Stage.S7];

export function enforceEntryStageForSpaceAllocation(input: { currentStage: Stage }) {
  if (SPACE_ALLOCATION_STAGES.includes(input.currentStage)) return;
  throw new StageGateBlockedError(
    `A space can be allocated from Inquiry through the stay (S1–S7) — this booking is at ${input.currentStage}`,
    "SPACE_ALLOCATION_STAGE",
  );
}
