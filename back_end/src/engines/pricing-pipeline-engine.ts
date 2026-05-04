export type RatePlanType = "INDIVIDUAL" | "PROMOTIONAL" | "TIER" | "CHANNEL" | "RACK";

export type PricingInput = {
  eligibleRatePlans: Array<{ id: string; type: RatePlanType; rateAmount: number; currency: string }>;
};

export type PricingResult = {
  selectedRatePlanId: string;
  selectedRatePlanType: RatePlanType;
  rateAmount: number;
  currency: string;
  isDeterrentRateApplied: boolean;
};

let resolveIndicativePricingCallCount = 0;
export function getIndicativePricingResolveCallCount() {
  return resolveIndicativePricingCallCount;
}
export function resetIndicativePricingResolveCallCount() {
  resolveIndicativePricingCallCount = 0;
}

const priority: Record<RatePlanType, number> = {
  INDIVIDUAL: 1,
  PROMOTIONAL: 2,
  TIER: 3,
  CHANNEL: 4,
  RACK: 5,
};

export function resolveIndicativePricing(input: PricingInput): PricingResult {
  resolveIndicativePricingCallCount += 1;
  if (!input.eligibleRatePlans.length) {
    throw new Error("No eligible rate plans");
  }
  const selected = [...input.eligibleRatePlans].sort((a, b) => priority[a.type] - priority[b.type])[0]!;
  return {
    selectedRatePlanId: selected.id,
    selectedRatePlanType: selected.type,
    rateAmount: selected.rateAmount,
    currency: selected.currency,
    isDeterrentRateApplied: false,
  };
}

