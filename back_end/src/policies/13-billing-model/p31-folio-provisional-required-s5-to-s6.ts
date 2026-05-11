import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 31 — Billing model / folio state (SIG-S5→S6 slice).
 * Normal path: folio must remain PROVISIONAL until check-in completion converts it.
 */
export function enforceFolioProvisionalForS5ToS6(input: { folio: { state: FolioState } | null | undefined }) {
  if (input.folio && input.folio.state === FolioState.PROVISIONAL) return;
  throw new StageGateBlockedError("Folio must be PROVISIONAL for normal S5→S6 path", "FOLIO_NOT_PROVISIONAL");
}
