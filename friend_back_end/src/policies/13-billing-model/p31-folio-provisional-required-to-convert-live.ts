import { FolioState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 31 — convert-to-live requires PROVISIONAL folio. */
export function enforceFolioProvisionalToConvertLive(input: { state: FolioState }) {
  if (input.state === FolioState.PROVISIONAL) return;
  throw new StateTransitionError(`Folio must be PROVISIONAL to convert (current: ${input.state})`);
}
