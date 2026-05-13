import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { resolveS2Pricing, type EligibleRatePlan, type S2ResolvePricingInput, type S2ResolvePricingResult } from "../../engines/pricing-pipeline-engine.js";

/**
 * Policy 19 — Rate Plan Resolution (S2 quotation slice).
 * SIG-S2: loads eligible rate plans from configuration and delegates to `PricingPipelineEngine.resolve` (`resolveS2Pricing`).
 */
export async function resolveRatePlanPricingForS2Quotation(
  prisma: PrismaClient,
  opts?: Pick<S2ResolvePricingInput, "groupSize" | "discountPercentOffRequested" | "actorMaxDiscountPercent" | "isDeficientGuestTier">,
): Promise<S2ResolvePricingResult> {
  const ratePlans = await requireActiveConfigValue<EligibleRatePlan[]>(prisma, "pricing.ratePlans").catch(() => {
    throw new MissingConfigurationError("pricing.ratePlans");
  });
  if (!Array.isArray(ratePlans) || ratePlans.length === 0) {
    throw new MissingConfigurationError("pricing.ratePlans");
  }
  return resolveS2Pricing({
    eligibleRatePlans: ratePlans,
    groupSize: opts?.groupSize,
    discountPercentOffRequested: opts?.discountPercentOffRequested,
    actorMaxDiscountPercent: opts?.actorMaxDiscountPercent,
    isDeficientGuestTier: opts?.isDeficientGuestTier,
    currentTimestamp: new Date(),
  });
}

export type { S2ResolvePricingResult };
