import { FolioState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 33 — write-off requires OUTSTANDING folio. */
export function enforceFolioOutstandingForWriteOff(input: { folioState: FolioState }) {
  if (input.folioState === FolioState.OUTSTANDING) return;
  throw new StateTransitionError("Folio must be OUTSTANDING to write off");
}
