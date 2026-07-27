import { FolioState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 31 — folio must be LIVE before S8 settlement in this slice. */
export function enforceFolioLiveForS8Settlement(input: { folioState: FolioState }) {
  if (input.folioState === FolioState.LIVE) return;
  throw new StateTransitionError("Folio must be LIVE to settle at S8");
}
