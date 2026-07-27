import { EntryStatus, FolioState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 70 — Feedback Solicitation Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Pure evaluator: solicitation only for CLOSED entries; excluded statuses and NO_SHOW_CLOSED.
 */
export function enforceFeedbackSolicitationAllowed(input: { entryStatus: EntryStatus; folioState: FolioState | null | undefined }) {
  if (input.entryStatus !== EntryStatus.CLOSED) {
    throw new PolicyGateBlockedError("FEEDBACK_SOLICITATION_NOT_CLOSED", "Feedback solicitation requires EntryStatus.CLOSED");
  }
  if (input.folioState === FolioState.NO_SHOW_CLOSED) {
    throw new PolicyGateBlockedError("FEEDBACK_SOLICITATION_NO_SHOW_EXCLUDED", "No-show closures are excluded from feedback solicitation");
  }
}

