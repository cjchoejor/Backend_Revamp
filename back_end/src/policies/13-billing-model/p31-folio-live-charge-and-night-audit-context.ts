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

/** Policy 31 — night-audit processing path requires LIVE folio. */
export function enforceFolioLiveForNightAuditProcessing(input: { folioState: FolioState | string }) {
  const s = String(input.folioState);
  if (s === FolioState.LIVE || s === "LIVE") return;
  throw new StateTransitionError("Folio must be LIVE for night audit processing");
}
