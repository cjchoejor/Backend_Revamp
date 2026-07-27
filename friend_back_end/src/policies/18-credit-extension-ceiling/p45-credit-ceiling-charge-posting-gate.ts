import type { Prisma, PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";

/**
 * SIG-S7 §4 — Policy 45 (Credit Ceiling Active Monitoring) — charge posting slice.
 *
 * Admin overrides:
 *   - `registry.creditCeiling.tier2Percent.percent` — Tier 2 FOM-acknowledgement gate %
 *   - `registry.creditCeiling.softGatePercent.percent` — soft-gate ratio for non-mandatory charges
 */
export async function enforceCreditCeilingChargePostingGate(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    ceiling: number | null | undefined;
    outstandingBalance: number;
    chargeAmount: number;
    isMandatoryCharge: boolean;
    creditCeilingTier2AcknowledgedAt: Date | null | undefined;
    allowSoftGateBypass?: boolean;
  },
) {
  const ceiling = input.ceiling;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;

  const tier2Policy = await getRegistryPolicy(db, "registry.creditCeiling.tier2Percent");
  const tier2Ratio =
    (tier2Policy && tier2Policy.enabled !== false && typeof tier2Policy.percent === "number"
      ? (tier2Policy.percent as number)
      : 90) / 100;

  const softGatePolicy = await getRegistryPolicy(db, "registry.creditCeiling.softGatePercent");
  const softGateRatio =
    (softGatePolicy && softGatePolicy.enabled !== false && typeof softGatePolicy.percent === "number"
      ? (softGatePolicy.percent as number)
      : 100) / 100;

  const projected = input.outstandingBalance + input.chargeAmount;
  const ratio = projected / ceiling;

  if (ratio >= tier2Ratio && !input.creditCeilingTier2AcknowledgedAt && input.allowSoftGateBypass !== true) {
    throw new PolicyGateBlockedError(
      "CREDIT_CEILING_ACTIVE_INTERRUPTION",
      `Credit ceiling ${Math.round(tier2Ratio * 100)}% threshold reached — FOM acknowledgement required`,
    );
  }
  if (ratio >= softGateRatio && !input.isMandatoryCharge && input.allowSoftGateBypass !== true) {
    throw new PolicyGateBlockedError(
      "CREDIT_CEILING_SOFT_GATE",
      "Credit ceiling reached — FOM acknowledgement required for non-mandatory charges",
    );
  }
}
