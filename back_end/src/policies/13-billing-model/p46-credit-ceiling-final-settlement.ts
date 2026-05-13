import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 46 — Credit ceiling final balance (SIG-S8 §4.1 / §6.2).
 * If outstanding exceeds the approved ceiling, FOM acknowledgement is required before settlement.
 */
export function enforceCreditCeilingFinalBalanceForSettlement(input: {
  outstanding: number;
  ceilingAmount?: number | null;
  fomAcknowledgementRef?: string | null;
  creditCeilingTier2AcknowledgedAt?: Date | null;
}) {
  const ceiling = input.ceilingAmount;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;
  if (input.outstanding <= ceiling) return;
  if (input.fomAcknowledgementRef?.trim()) return;
  if (input.creditCeilingTier2AcknowledgedAt) return;
  throw new PolicyGateBlockedError(
    "CEILING_EXCEEDED_FOM_ACKNOWLEDGEMENT_REQUIRED",
    "Outstanding exceeds approved credit ceiling — provide fomAcknowledgementRef or prior tier-2 acknowledgement",
  );
}
