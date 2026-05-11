import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 31 — folio must exist before placing a committed hold in this slice. */
export function enforceFolioPresentBeforeCommittedHoldS3(input: { folio: unknown | null | undefined }) {
  if (input.folio) return;
  throw new StageGateBlockedError("Folio required before committed hold", "MISSING_FOLIO");
}
