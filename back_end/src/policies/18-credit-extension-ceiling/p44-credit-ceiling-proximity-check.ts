import type { Prisma, PrismaClient } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";

/**
 * Policy 44 — Credit Ceiling Proximity Check Policy (S5).
 * SIG-S5: Tier 2 proximity requires FOM acknowledgement before check-in.
 *
 * Admin override: `registry.creditCeiling.tier2Percent` (when present and enabled) supplies
 * the proximity ratio. Defaults to 90% when absent.
 */
export async function enforceCreditCeilingTier2Acknowledged(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    ceilingAmount: number | null | undefined;
    outstandingBalance: number;
    hasTier2Acknowledgement: boolean;
  },
) {
  const ceiling = input.ceilingAmount;
  if (ceiling == null || !Number.isFinite(ceiling) || ceiling <= 0) return;

  const policy = await getRegistryPolicy(db, "registry.creditCeiling.tier2Percent");
  const registryPercent =
    policy && policy.enabled !== false && typeof policy.percent === "number"
      ? (policy.percent as number)
      : null;
  const tier2Ratio = (registryPercent ?? 90) / 100;

  const ratio = input.outstandingBalance / ceiling;
  if (ratio < tier2Ratio) return;
  if (input.hasTier2Acknowledgement) return;
  throw new StageGateBlockedError(
    "Credit ceiling Tier 2 proximity requires FOM acknowledgement before check-in",
    "CREDIT_CEILING_TIER2_UNACKNOWLEDGED",
  );
}
