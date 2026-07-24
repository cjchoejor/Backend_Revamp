import type { PrismaClient } from "@prisma/client";
import { loadEligibleRatePlans } from "../../lib/load-eligible-rate-plans.js";
import { resolveIndicativePricing, type PricingResult } from "../../engines/pricing-pipeline-engine.js";

export type S1IndicativePricingChip = PricingResult & {
  stayNights: number;
  /** Nightly rate × stay nights (per room; display-only). */
  lineTotalIndicative: number;
  disclaimer: "INDICATIVE_ONLY_NO_QUOTATION";
};

/**
 * Policy 19 — Indicative rate plan for S1 availability display (SIG §6.3).
 * Reads from `rate_plan_registry` per ACIG §6.1058. Skips cleanly when no active rate plans exist.
 * When `roomTypeId` is supplied, only universal plans + plans bound to that room type are considered.
 */
export async function resolveIndicativePricingForS1Availability(
  prisma: PrismaClient,
  stay: { checkIn: Date; checkOut: Date },
  roomTypeId?: string,
): Promise<S1IndicativePricingChip | null> {
  const plans = await loadEligibleRatePlans(prisma, stay, roomTypeId);
  if (plans.length === 0) return null;

  const selected = resolveIndicativePricing({ eligibleRatePlans: plans });
  const stayNights = Math.max(1, Math.ceil((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000));
  const lineTotalIndicative = selected.rateAmount * stayNights;

  return {
    ...selected,
    stayNights,
    lineTotalIndicative,
    disclaimer: "INDICATIVE_ONLY_NO_QUOTATION",
  };
}
