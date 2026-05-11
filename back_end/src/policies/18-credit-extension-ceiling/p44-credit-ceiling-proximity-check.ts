import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 44 — Credit Ceiling Proximity Check Policy (S5).
 * SIG-S5: Tier 2 (>=90%) requires FOM acknowledgement before check-in.
 */
export function enforceCreditCeilingTier2Acknowledged(input: {
  ceilingAmount: number | null | undefined;
  outstandingBalance: number;
  hasTier2Acknowledgement: boolean;
}) {
  const ceiling = input.ceilingAmount;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;
  const ratio = input.outstandingBalance / ceiling;
  if (ratio < 0.9) return;
  if (input.hasTier2Acknowledgement) return;
  throw new StageGateBlockedError(
    "Credit ceiling Tier 2 proximity requires FOM acknowledgement before check-in",
    "CREDIT_CEILING_TIER2_UNACKNOWLEDGED",
  );
}

