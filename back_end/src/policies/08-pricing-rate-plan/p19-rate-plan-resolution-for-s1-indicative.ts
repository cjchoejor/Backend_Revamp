import type { PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { resolveIndicativePricing, type PricingResult, type RatePlanType } from "../../engines/pricing-pipeline-engine.js";

export type S1IndicativePricingChip = PricingResult & {
  stayNights: number;
  /** Nightly rate × stay nights (per room; display-only). */
  lineTotalIndicative: number;
  disclaimer: "INDICATIVE_ONLY_NO_QUOTATION";
};

function parseEligibleRatePlans(raw: unknown): Array<{ id: string; type: RatePlanType; rateAmount: number; currency: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; type: RatePlanType; rateAmount: number; currency: string }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.type !== "string" || typeof o.rateAmount !== "number") continue;
    const currency = typeof o.currency === "string" ? o.currency : "BTN";
    out.push({ id: o.id, type: o.type as RatePlanType, rateAmount: o.rateAmount, currency });
  }
  return out;
}

/**
 * Policy 19 — Indicative rate plan for S1 availability display (SIG §6.3).
 * Does not persist quotations; skips cleanly when `pricing.ratePlans` is absent or empty.
 */
export async function resolveIndicativePricingForS1Availability(
  prisma: PrismaClient,
  stay: { checkIn: Date; checkOut: Date },
): Promise<S1IndicativePricingChip | null> {
  const row = await getActiveConfigEntry(prisma, "pricing.ratePlans");
  const plans = parseEligibleRatePlans(row?.configValue);
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
