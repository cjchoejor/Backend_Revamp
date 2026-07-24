import { FolioState } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 27 (slice) — inbound advance payments at S3 may only be posted to a provisional folio.
 */
export function enforceAdvancePaymentInboundRecordAtS3(input: { folioState: FolioState; amount: number }) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new ValidationError("Payment amount must be a positive number");
  }
  if (input.folioState !== FolioState.PROVISIONAL) {
    throw new PolicyGateBlockedError("FOLIO_NOT_PROVISIONAL", "Advance payments at S3 require a provisional folio");
  }
}
