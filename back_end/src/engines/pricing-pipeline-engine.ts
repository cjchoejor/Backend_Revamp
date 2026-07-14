/**
 * SIG-S2 §5.1 — PricingPipelineEngine (S2 contract slice).
 * Pure logic: no Prisma queries. Callers inject rate plans, thresholds, and an explicit timestamp.
 * Money math routes through Prisma.Decimal (via lib/money) so uplift/discount/MSR cascades don't
 * accumulate float drift; results serialise back to `number` at the return boundary because the
 * public shape is `number`.
 */

import { mulMoney, round2, toDecimal } from "../lib/money.js";

export type RatePlanType = "INDIVIDUAL" | "PROMOTIONAL" | "TIER" | "CHANNEL" | "RACK";

export type EligibleRatePlan = {
  id: string;
  type: RatePlanType;
  rateAmount: number;
  currency: string;
  /** Minimum sell rate; when absent, defaults to 70% of nightly (placeholder MSR floor). */
  msr?: number;
};

export type PricingInput = {
  eligibleRatePlans: EligibleRatePlan[];
};

/** Legacy S1 indicative chip (narrower than full S2 result). */
export type PricingResult = {
  selectedRatePlanId: string;
  selectedRatePlanType: RatePlanType;
  rateAmount: number;
  currency: string;
  isDeterrentRateApplied: boolean;
};

export type S2ResolvePricingInput = {
  eligibleRatePlans: EligibleRatePlan[];
  groupSize?: number;
  discountPercentOffRequested?: number;
  /** Max discount % the acting authority may apply without escalation (e.g. FOM cap for L1). */
  actorMaxDiscountPercent?: number;
  isDeficientGuestTier?: boolean;
  currentTimestamp: Date;
};

export type S2ResolvePricingResult = {
  resolvedRatePlanId: string;
  resolvedRatePlanType: RatePlanType;
  resolvedNightlyRate: number;
  effectiveRate: number;
  currency: string;
  discountApplied: number;
  discountWithinAuthorityBounds: boolean;
  overrideApplied: number;
  belowMsr: boolean;
  msrValue: number;
  overrideExceedsMargin: boolean;
  isDeterrentRateApplied: boolean;
  appliedGroupBand: string | null;
  resolutionPath: Array<{ step: string; detail: string }>;
};

const priority: Record<RatePlanType, number> = {
  INDIVIDUAL: 1,
  PROMOTIONAL: 2,
  TIER: 3,
  CHANNEL: 4,
  RACK: 5,
};

let resolveIndicativePricingCallCount = 0;
export function getIndicativePricingResolveCallCount() {
  return resolveIndicativePricingCallCount;
}
export function resetIndicativePricingResolveCallCount() {
  resolveIndicativePricingCallCount = 0;
}

function defaultMsr(nightly: number, explicit?: number): number {
  if (explicit != null && Number.isFinite(explicit)) return explicit;
  return Number(round2(mulMoney(nightly, 0.7)).toFixed(2));
}

/**
 * SIG-shaped resolver used at S2 (create / group / discount revalidation).
 * `resolve` is the canonical name from SIG; `resolveS2Pricing` is the typed export used by policies.
 */
export function resolveS2Pricing(input: S2ResolvePricingInput): S2ResolvePricingResult {
  if (!input.eligibleRatePlans.length) {
    throw new Error("No eligible rate plans");
  }
  const path: S2ResolvePricingResult["resolutionPath"] = [];
  const sorted = [...input.eligibleRatePlans].sort((a, b) => priority[a.type] - priority[b.type]);
  const selected = sorted[0]!;
  path.push({ step: "RATE_PLAN_PRIORITY", detail: `selected=${selected.id} type=${selected.type}` });

  // Decimal-safe pricing cascade: uplift → group band → discount. Each step reads/writes a Decimal
  // and only the final display value is coerced back to number. Prevents Math.round(x*100)/100
  // float drift cascading through deterrent × 1.15, band × 0.98, and (1 - pct/100) discount.
  let nightlyDec = toDecimal(selected.rateAmount);
  let isDeterrent = false;
  if (input.isDeficientGuestTier) {
    nightlyDec = round2(mulMoney(nightlyDec, 1.15));
    isDeterrent = true;
    path.push({ step: "DETERRENT_TIER", detail: "CAUTION/RESTRICTED uplift applied (not guest-facing)" });
  }

  let appliedGroupBand: string | null = null;
  if (input.groupSize != null && Number.isFinite(input.groupSize) && input.groupSize > 10) {
    nightlyDec = round2(mulMoney(nightlyDec, 0.98));
    appliedGroupBand = "VOLUME_10_PLUS";
    path.push({ step: "GROUP_VOLUME_BAND", detail: appliedGroupBand });
  }

  const nightly = Number(nightlyDec.toFixed(2));
  const msrValue = defaultMsr(nightly, selected.msr);
  let effectiveDec = nightlyDec;
  let discountAppliedDec = toDecimal(0);
  let discountWithinAuthorityBounds = true;
  const pct = input.discountPercentOffRequested;
  if (pct != null && pct > 0) {
    const cap = input.actorMaxDiscountPercent;
    // Authority cap comparison in Decimal — a `Number(pct)` at 25.0000000001 would slip past
    // a Number(cap) of 25 in a float compare.
    discountWithinAuthorityBounds = cap == null || toDecimal(pct).lte(toDecimal(cap));
    if (discountWithinAuthorityBounds) {
      // effective = nightly * (1 - pct/100). Compute in Decimal.
      const factor = toDecimal(1).sub(toDecimal(pct).div(100));
      effectiveDec = round2(mulMoney(nightlyDec, factor));
      discountAppliedDec = round2(nightlyDec.sub(effectiveDec));
      path.push({ step: "DISCOUNT", detail: `${pct}% applied` });
    } else {
      path.push({ step: "DISCOUNT_BLOCKED_AUTHORITY", detail: `requested=${pct} cap=${cap}` });
    }
  }
  const effective = Number(effectiveDec.toFixed(2));
  const discountApplied = Number(discountAppliedDec.toFixed(2));

  const belowMsr = effectiveDec.lt(toDecimal(msrValue));
  if (belowMsr) path.push({ step: "MSR_CHECK", detail: `effective=${effective} msr=${msrValue}` });

  return {
    resolvedRatePlanId: selected.id,
    resolvedRatePlanType: selected.type,
    resolvedNightlyRate: nightly,
    effectiveRate: effective,
    currency: selected.currency,
    discountApplied,
    discountWithinAuthorityBounds,
    overrideApplied: 0,
    belowMsr,
    msrValue,
    overrideExceedsMargin: false,
    isDeterrentRateApplied: isDeterrent,
    appliedGroupBand,
    resolutionPath: path,
  };
}

/** SIG alias — same as `resolveS2Pricing`. */
export function resolve(input: S2ResolvePricingInput): S2ResolvePricingResult {
  return resolveS2Pricing(input);
}

export function resolveIndicativePricing(input: PricingInput): PricingResult {
  resolveIndicativePricingCallCount += 1;
  const r = resolveS2Pricing({
    eligibleRatePlans: input.eligibleRatePlans,
    currentTimestamp: new Date(),
  });
  return {
    selectedRatePlanId: r.resolvedRatePlanId,
    selectedRatePlanType: r.resolvedRatePlanType,
    rateAmount: r.effectiveRate,
    currency: r.currency,
    isDeterrentRateApplied: r.isDeterrentRateApplied,
  };
}
