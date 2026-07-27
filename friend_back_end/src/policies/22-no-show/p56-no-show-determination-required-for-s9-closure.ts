import { FolioState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 56 — No-show determination (SIG-S9 closure slice).
 */
export function enforceNoShowDeterminationPresentForS9Closure(input: {
  folioState: FolioState;
  noShowDetermination: unknown | null | undefined;
}) {
  if (input.folioState !== FolioState.NO_SHOW_CLOSED) return;
  if (input.noShowDetermination) return;
  throw new StageGateBlockedError("No-show entries require NoShowDeterminationRecord", "NO_SHOW_DETERMINATION_MISSING");
}
