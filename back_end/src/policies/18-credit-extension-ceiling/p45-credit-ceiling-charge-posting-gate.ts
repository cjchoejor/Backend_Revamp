import { PolicyGateBlockedError } from "../../lib/errors.js";

/** SIG-S7 §4 — Policy 45 (Credit Ceiling Active Monitoring) — charge posting slice. */
export function enforceCreditCeilingChargePostingGate(input: {
  ceiling: number | null | undefined;
  outstandingBalance: number;
  chargeAmount: number;
  isMandatoryCharge: boolean;
  creditCeilingTier2AcknowledgedAt: Date | null | undefined;
  allowSoftGateBypass?: boolean;
}) {
  const ceiling = input.ceiling;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;

  const projected = input.outstandingBalance + input.chargeAmount;
  const ratio = projected / ceiling;

  if (ratio >= 0.9 && !input.creditCeilingTier2AcknowledgedAt && input.allowSoftGateBypass !== true) {
    throw new PolicyGateBlockedError("CREDIT_CEILING_ACTIVE_INTERRUPTION", "Credit ceiling 90% threshold reached — FOM acknowledgement required");
  }
  if (ratio >= 1 && !input.isMandatoryCharge && input.allowSoftGateBypass !== true) {
    throw new PolicyGateBlockedError("CREDIT_CEILING_SOFT_GATE", "Credit ceiling reached — FOM acknowledgement required for non-mandatory charges");
  }
}
