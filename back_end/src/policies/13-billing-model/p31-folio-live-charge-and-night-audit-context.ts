import { FolioState, Stage } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 31 — S7 charge posting requires LIVE folio. */
export function enforceFolioLiveForS7ChargePosting(input: { folioState: FolioState }) {
  if (input.folioState === FolioState.LIVE) return;
  throw new StateTransitionError(`Folio must be LIVE at S7 (current: ${input.folioState})`);
}

/** Policy 1 — S7 charge posting requires entry at S7. */
export function enforceEntryAtS7ForChargePosting(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7) return;
  throw new StateTransitionError("Entry must be at S7 to post charges", "NOT_AT_S7");
}

/**
 * Policy 1 (S8 extension) — charge posting is valid at S7 *or* S8. SIG-S8 §2.2 permits
 * final-morning charges (breakfast, last-minute services) on the LIVE folio before
 * settlement, using the same postCharge mechanics as S7. The folio-LIVE gate on the same
 * path still blocks any posting once the folio has settled (S8 post-settlement / S9).
 */
export function enforceEntryAtS7OrS8ForChargePosting(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S7 || input.currentStage === Stage.S8) return;
  throw new StateTransitionError("Entry must be at S7 or S8 to post charges", "NOT_AT_S7_OR_S8");
}

/** Policy 31 — night-audit processing path requires LIVE folio. */
export function enforceFolioLiveForNightAuditProcessing(input: { folioState: FolioState | string }) {
  const s = String(input.folioState);
  if (s === FolioState.LIVE || s === "LIVE") return;
  throw new StateTransitionError("Folio must be LIVE for night audit processing");
}
