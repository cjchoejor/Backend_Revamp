import { PolicyGateBlockedError } from "../../lib/errors.js";

// Policy 33 — Billing Model Settlement (subset: settlement method must be compatible with billing model).
export function enforceSettlementMethodCompatibility(input: { billingModel: string; settlementMethod: string }) {
  if (input.billingModel === "DIRECT_BILL" && input.settlementMethod !== "DIRECT_BILL") {
    throw new PolicyGateBlockedError("BILLING_MODEL_SETTLEMENT_POLICY", "DIRECT_BILL folios must settle via DIRECT_BILL");
  }
  // The guest's own bill is settled with the guest's money (2026-11-26, operator: "if the billing
  // model was everything to guest, showing the agent's voucher makes no sense since it's not the
  // agent paying"). A voucher or an account would record the agency or company as owing the
  // guest's bill — and Billing › Vouchers would wait for money nobody owes the hotel.
  if (input.billingModel === "GUEST_PAY" && (input.settlementMethod === "VOUCHER" || input.settlementMethod === "DIRECT_BILL")) {
    throw new PolicyGateBlockedError(
      "BILLING_MODEL_SETTLEMENT_POLICY",
      "This bill is the guest's to pay — settle it with the guest's money (cash, card, QR or a transfer). A voucher or an account does not pay the guest's bill.",
    );
  }
}

