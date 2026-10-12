import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 33 — Billing Model Settlement (SIG-S8 §3.2 / §8.1).
 * S8→S9: folio must be SETTLED or OUTSTANDING (governed residual path) — or WRITTEN_OFF.
 *
 * WRITTEN_OFF (2026-10-12, found checking out three overstays on the operator's instruction): the
 * write-off route asks only that the folio be OUTSTANDING, which it is right after a partial
 * settlement at check-out, so the balance can be written off while the booking is still at S8. The
 * folio then owes nothing — more resolved than an OUTSTANDING one, which this gate already lets
 * through — yet it was refused, stranding the booking at Check-out with no way forward. S9's own
 * closure checks already treat a written-off folio as resolved (`ensureOutstandingHasW8OrWrittenOff`).
 */
export function enforceFolioStateAllowsS8ToS9Progression(input: { folioState: FolioState }) {
  if (
    input.folioState === FolioState.SETTLED ||
    input.folioState === FolioState.OUTSTANDING ||
    input.folioState === FolioState.WRITTEN_OFF
  ) {
    return;
  }
  throw new StageGateBlockedError("The bill must be settled, left owing, or written off before the stay leaves Check-out", "FOLIO_NOT_SETTLED");
}
