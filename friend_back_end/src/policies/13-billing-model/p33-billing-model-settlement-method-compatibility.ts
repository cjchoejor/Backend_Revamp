import { PolicyGateBlockedError } from "../../lib/errors.js";

// Policy 33 — Billing Model Settlement (subset: settlement method must be compatible with billing model).
export function enforceSettlementMethodCompatibility(input: { billingModel: string; settlementMethod: string }) {
  if (input.billingModel === "DIRECT_BILL" && input.settlementMethod !== "DIRECT_BILL") {
    throw new PolicyGateBlockedError("BILLING_MODEL_SETTLEMENT_POLICY", "DIRECT_BILL folios must settle via DIRECT_BILL");
  }
}

