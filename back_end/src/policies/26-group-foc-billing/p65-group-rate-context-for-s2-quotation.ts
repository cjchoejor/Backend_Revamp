import { EntryUseType } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";

/**
 * SIG-S2 Policy 65 — Group rate application (S2 slice).
 * Ensures group-size context exists before group quotation pricing is assembled.
 */
export function enforceGroupRateContextForS2Quotation(input: { useType: EntryUseType; guestCount: number | null | undefined }) {
  if (input.useType !== EntryUseType.GROUP) {
    throw new ValidationError("createGroupQuotation requires Entry.useType = GROUP");
  }
  const n = Number(input.guestCount);
  if (!Number.isFinite(n) || n < 1) {
    throw new ValidationError("guestCount is required for group quotations");
  }
}
