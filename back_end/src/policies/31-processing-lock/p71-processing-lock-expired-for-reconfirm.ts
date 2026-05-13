import { ProcessingLockStatus } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 71 — reconfirm path requires prior lock in EXPIRED status. */
export function enforceProcessingLockExpiredForReconfirm(input: { status: ProcessingLockStatus }) {
  if (input.status === ProcessingLockStatus.EXPIRED) return;
  throw new StateTransitionError("Lock must be EXPIRED to reconfirm");
}
