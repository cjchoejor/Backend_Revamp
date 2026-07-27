import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 33 — Billing Model Settlement (SIG-S8 §3.2 / §8.1).
 * S8→S9: folio must be SETTLED or OUTSTANDING (governed residual path).
 */
export function enforceFolioStateAllowsS8ToS9Progression(input: { folioState: FolioState }) {
  if (input.folioState === FolioState.SETTLED || input.folioState === FolioState.OUTSTANDING) return;
  throw new StageGateBlockedError("Folio must be SETTLED or OUTSTANDING to exit S8", "FOLIO_NOT_SETTLED");
}
