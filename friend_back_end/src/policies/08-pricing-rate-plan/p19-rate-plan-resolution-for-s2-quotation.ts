import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError } from "../../lib/errors.js";
import { loadEligibleRatePlans } from "../../lib/load-eligible-rate-plans.js";
import { resolveS2Pricing, type S2ResolvePricingInput, type S2ResolvePricingResult } from "../../engines/pricing-pipeline-engine.js";

/**
 * Policy 19 — Rate Plan Resolution (S2 quotation slice).
 * Reads from `rate_plan_registry` (ACIG §6.1058) and delegates to `PricingPipelineEngine.resolve`.
 * Pass `opts.stay` to apply an active SeasonCalendar multiplier when one covers the stay window.
 */
export async function resolveRatePlanPricingForS2Quotation(
  prisma: PrismaClient,
  opts?: Pick<S2ResolvePricingInput, "groupSize" | "discountPercentOffRequested" | "actorMaxDiscountPercent" | "isDeficientGuestTier"> & {
    stay?: { checkIn: Date; checkOut: Date };
    /** SIG-S2 §366 — when supplied, only plans bound to this room type or universal plans (`roomTypeId IS NULL`) are returned. */
    roomTypeId?: string;
  },
): Promise<S2ResolvePricingResult> {
  const ratePlans = await loadEligibleRatePlans(prisma, opts?.stay, opts?.roomTypeId);
  if (ratePlans.length === 0) {
    throw new MissingConfigurationError("rate_plan_registry");
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
