import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 31 — Billing Model Activation / folio pre-conversion (SIG-S6).
 * Folio must exist and remain PROVISIONAL until `convertToLive()` in the completion transaction.
 */
export function enforceFolioProvisionalBeforeCheckInCompletion(input: {
  folio: { state: FolioState } | null | undefined;
}) {
  const folio = input.folio;
  if (!folio || folio.state !== FolioState.PROVISIONAL) {
    throw new StageGateBlockedError("Folio must be PROVISIONAL before check-in completion", "FOLIO_NOT_CONVERTED");
  }
}
