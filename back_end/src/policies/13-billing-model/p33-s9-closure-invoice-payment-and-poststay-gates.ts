import { FolioState, InvoiceState, Stage } from "@prisma/client";
import { StageGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Policy 33 — Billing / settlement surfaces (SIG-S9 closure slice).
 */
export function enforceInvoicesDispatchedForS9Closure(input: { draftInvoice: unknown | null | undefined }) {
  if (!input.draftInvoice) return;
  throw new StageGateBlockedError("Undispatched invoice blocks closure", "INVOICE_NOT_DISPATCHED");
}

export function enforceGovernmentInvoicePaymentTrackedForS9Closure(input: {
  billingModel: string;
  latestInvoice: { state: InvoiceState | string } | null | undefined;
}) {
  if (input.billingModel !== "GOVERNMENT") return;
  const inv = input.latestInvoice;
  if (inv && String(inv.state) === InvoiceState.DISPATCHED) {
    throw new StageGateBlockedError("Government invoice must be PAYMENT_TRACKED before closure", "GOV_PAYMENT_NOT_TRACKED");
  }
}

export function enforceDirectBillPaymentsMatchedForS9Closure(input: {
  billingModel: string;
  unmatchedInPayment: unknown | null | undefined;
}) {
  if (input.billingModel !== "DIRECT_BILL") return;
  if (input.unmatchedInPayment) {
    throw new StageGateBlockedError("Unmatched payment blocks closure", "PAYMENT_NOT_MATCHED");
  }
}

export function enforceOutstandingFolioHasW8OrWriteOffForS9Closure(input: {
  folioState: FolioState;
  outstandingBalance: number;
  hasScheduledW8: boolean;
  hasWriteOff: boolean;
}) {
  if (input.folioState !== FolioState.OUTSTANDING) return;
  if (input.outstandingBalance === 0) {
    throw new StageGateBlockedError("OUTSTANDING folio cannot have zero balance", "OUTSTANDING_ZERO_BALANCE");
  }
  if (!input.hasScheduledW8 && !input.hasWriteOff) {
    throw new StageGateBlockedError("OUTSTANDING folio requires active W8 follow-up or write-off", "OUTSTANDING_WITHOUT_W8");
  }
}

export function enforceApartmentSecurityDepositResolvedForS9Closure(input: {
  useType: string;
  hasHeldDeposit: boolean;
  hasReturnOrZeroBalanceEvidence: boolean;
}) {
  if (input.useType !== "APARTMENT") return;
  if (!input.hasHeldDeposit) return;
  if (input.hasReturnOrZeroBalanceEvidence) return;
  throw new StageGateBlockedError("Apartment security deposit not resolved", "SECURITY_DEPOSIT_NOT_RESOLVED");
}

export function enforcePostStayChargeNotWithinStayWindow(input: {
  checkInDate: Date | null | undefined;
  checkOutDate: Date | null | undefined;
  postedAt: Date;
}) {
  const ci = input.checkInDate;
  const co = input.checkOutDate;
  if (!ci || !co) return;
  if (input.postedAt >= ci && input.postedAt <= co) {
    throw new ValidationError("postedAt cannot be within the original stay period");
  }
}

export function enforceEntryAtS9ForPostStayCharge(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S9) return;
  throw new StageGateBlockedError("Entry must be at S9 for post-stay charges", "NOT_AT_S9");
}
