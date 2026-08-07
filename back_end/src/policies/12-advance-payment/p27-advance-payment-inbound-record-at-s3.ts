import { FolioState, Stage } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 27 (slice) — inbound advance payments may only be posted to a provisional folio.
 * (Named "AtS3" historically; since 2026-08-07 the collection window is S3–S6 and the
 * provisional-folio requirement is what actually bounds it — the folio goes LIVE at S6→S7.)
 */
export function enforceAdvancePaymentInboundRecordAtS3(input: { folioState: FolioState; amount: number }) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new ValidationError("Payment amount must be a positive number");
  }
  if (input.folioState !== FolioState.PROVISIONAL) {
    throw new PolicyGateBlockedError("FOLIO_NOT_PROVISIONAL", "Advance payments require a provisional folio");
  }
}

/**
 * The advance-collection window (2026-08-07, operator request): the guest may pay the advance
 * — or the remainder of a partial/installment plan — at setup (S3), after confirmation (S4),
 * during pre-arrival (S5) or at the check-in desk (S6). Before S3 there is no folio; from S7
 * the folio is LIVE and money flows through in-stay charges and the S8 settlement instead.
 */
const ADVANCE_COLLECTION_STAGES: ReadonlySet<Stage> = new Set([Stage.S3, Stage.S4, Stage.S5, Stage.S6]);

export function enforceEntryWithinAdvanceCollectionWindow(input: { currentStage: Stage }) {
  if (ADVANCE_COLLECTION_STAGES.has(input.currentStage)) return;
  throw new PolicyGateBlockedError(
    "OUTSIDE_ADVANCE_COLLECTION_WINDOW",
    "Advance payments are collected between setup and check-in (S3–S6) — during the stay use the folio, at check-out use settlement",
  );
}
