import { FolioState } from "@prisma/client";

/**
 * Policy 11 — Post-Stay Payment Follow-Up Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Pure evaluator: should follow-up run for this folio?
 */
export function shouldRunPostStayPaymentFollowUp(input: { folioState: FolioState; outstandingBalance: number }) {
  return input.folioState === FolioState.OUTSTANDING && Number.isFinite(input.outstandingBalance) && input.outstandingBalance > 0;
}

