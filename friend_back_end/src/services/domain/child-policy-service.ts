/**
 * Child-policy runtime — classifies guests by age band, looks up meal-rate multipliers,
 * computes separate-bed charges, and exposes the loaded policy bundle for downstream use
 * by the pricing engine and the capacity validator. Always reads from `policy_registry` so
 * hotel staff can change the values from /admin/policies without a deploy.
 *
 * Source of truth for default values: docs/Legphel-Child-Policy.md.
 */
import type { PrismaClient } from "@prisma/client";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { mulMoney, round2, toDecimal } from "../../lib/money.js";

export type AgeBand = "YOUNG_CHILD" | "CHILD" | "ADULT";

export type ChildPolicyBundle = {
  ageBands: { youngChildMaxAge: number; childMaxAge: number; enabled: boolean };
  mealPricing: {
    enabled: boolean;
    youngChildPercent: number;
    childPercent: number;
    adultPercent: number;
  };
  separateBedCharge: {
    enabled: boolean;
    basis: "FLAT" | "PERCENT_OF_ROOM";
    amount: number;
    currency: string;
  };
  unaccompaniedMinor: { enabled: boolean; minimumAge: number };
  adultToChildRatio: { enabled: boolean; maxChildrenPerAdult: number };
};

/**
 * Load all five child policies in one shot. Caller passes a `Db` (prisma OR a transaction
 * client) so this composes inside the same tx as the entry create / quotation calc.
 */
export async function loadChildPolicyBundle(db: PrismaClient): Promise<ChildPolicyBundle> {
  const [ageBands, mealPricing, separateBedCharge, unaccompaniedMinor, adultToChildRatio] =
    await Promise.all([
      getRegistryPolicy(db, "registry.child.ageBands"),
      getRegistryPolicy(db, "registry.child.mealPricing"),
      getRegistryPolicy(db, "registry.child.separateBedCharge"),
      getRegistryPolicy(db, "registry.child.unaccompaniedMinorMinAge"),
      getRegistryPolicy(db, "registry.child.adultToChildRatio"),
    ]);

  // Defaults match docs/Legphel-Child-Policy.md — used only when a registry row is missing
  // (e.g., a fresh DB that hasn't run scripts/seed-child-policies.ts).
  return {
    ageBands: {
      enabled: ageBands?.enabled !== false,
      youngChildMaxAge: numberOr(ageBands?.youngChildMaxAge, 5),
      childMaxAge: numberOr(ageBands?.childMaxAge, 10),
    },
    mealPricing: {
      enabled: mealPricing?.enabled !== false,
      youngChildPercent: numberOr(mealPricing?.youngChildPercent, 0),
      childPercent: numberOr(mealPricing?.childPercent, 70),
      adultPercent: numberOr(mealPricing?.adultPercent, 100),
    },
    separateBedCharge: {
      enabled: separateBedCharge?.enabled === true,
      basis: (separateBedCharge?.basis as "FLAT" | "PERCENT_OF_ROOM") ?? "FLAT",
      amount: numberOr(separateBedCharge?.amount, 0),
      currency: (separateBedCharge?.currency as string) ?? "BTN",
    },
    unaccompaniedMinor: {
      enabled: unaccompaniedMinor?.enabled !== false,
      minimumAge: numberOr(unaccompaniedMinor?.minimumAge, 18),
    },
    adultToChildRatio: {
      enabled: adultToChildRatio?.enabled === true,
      maxChildrenPerAdult: numberOr(adultToChildRatio?.maxChildrenPerAdult, 3),
    },
  };
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/**
 * Classifies a single age into one of three bands using the live registry values. Ages above
 * `childMaxAge` are ADULT; ages between youngChildMaxAge+1 and childMaxAge inclusive are CHILD;
 * everything else (0..youngChildMaxAge) is YOUNG_CHILD.
 */
export function classifyAge(age: number, bundle: ChildPolicyBundle): AgeBand {
  const { youngChildMaxAge, childMaxAge } = bundle.ageBands;
  if (age > childMaxAge) return "ADULT";
  if (age > youngChildMaxAge) return "CHILD";
  return "YOUNG_CHILD";
}

/** Returns the meal-rate multiplier for a given age (0..1). */
export function getMealRateMultiplier(age: number, bundle: ChildPolicyBundle): number {
  const band = classifyAge(age, bundle);
  const pct =
    band === "ADULT"
      ? bundle.mealPricing.adultPercent
      : band === "CHILD"
        ? bundle.mealPricing.childPercent
        : bundle.mealPricing.youngChildPercent;
  return Math.max(0, Math.min(100, pct)) / 100;
}

/**
 * Computes the separate-bed charge for one child for one night. Returns 0 when the policy is
 * disabled or when the child is already in the ADULT band (adults pay full room rate, not a
 * separate-bed surcharge). Caller passes the roomBaseRate when basis = PERCENT_OF_ROOM.
 */
export function getSeparateBedCharge(
  age: number,
  bundle: ChildPolicyBundle,
  roomBaseRate?: number,
): number {
  if (!bundle.separateBedCharge.enabled) return 0;
  const band = classifyAge(age, bundle);
  if (band === "ADULT") return 0;
  const { basis, amount } = bundle.separateBedCharge;
  if (basis === "PERCENT_OF_ROOM") {
    if (!roomBaseRate || roomBaseRate <= 0) return 0;
    return Math.max(0, roomBaseRate * (amount / 100));
  }
  return Math.max(0, amount);
}

/**
 * Bundles together every age in a child-ages array into per-band counts. Use this to answer
 * "how many children are free / 70% / full-rate" in a single pass.
 */
export function summarizeChildAges(
  childAges: number[],
  bundle: ChildPolicyBundle,
): { youngChildCount: number; childCount: number; adultCount: number; bands: AgeBand[] } {
  const bands = childAges.map((a) => classifyAge(a, bundle));
  return {
    youngChildCount: bands.filter((b) => b === "YOUNG_CHILD").length,
    childCount: bands.filter((b) => b === "CHILD").length,
    adultCount: bands.filter((b) => b === "ADULT").length,
    bands,
  };
}

/**
 * Total meal charge for a group of guests after applying child-age multipliers per person.
 *
 * Adults pay `adultMealRate * 100%`. Every age in `childAges` gets classified through the
 * policy bands and pays the corresponding percentage (default: young child = 0% free,
 * child = 70%, teen who classified as adult = 100%). Nights multiplies the whole thing so
 * multi-night stays add up correctly.
 *
 * Callers (pricing engine, S2 quotation service, S8 settlement) should replace naive
 * `adults * adultMealRate` calculations with this helper. Non-negative in all cases.
 */
export function computeGroupMealCharge(
  input: { adultCount: number; childAges: number[]; adultMealRate: number; nights: number },
  bundle: ChildPolicyBundle,
): { total: number; perGuest: Array<{ classification: AgeBand; multiplier: number; charge: number }> } {
  const nights = Math.max(1, input.nights);
  // Decimal-safe: per-guest charges computed via Decimal and rounded at the boundary; reduce
  // accumulates a Decimal so drift never builds up across many guests.
  const adultRateDec = toDecimal(input.adultMealRate);
  const nightsDec = toDecimal(nights);
  const perGuest: Array<{ classification: AgeBand; multiplier: number; charge: number }> = [];

  const adultChargeDec = round2(mulMoney(adultRateDec, nightsDec));
  for (let i = 0; i < Math.max(0, input.adultCount); i++) {
    perGuest.push({ classification: "ADULT", multiplier: 1, charge: Number(adultChargeDec.toFixed(2)) });
  }

  for (const age of input.childAges) {
    const multiplier = getMealRateMultiplier(age, bundle);
    const chargeDec = round2(mulMoney(mulMoney(adultRateDec, multiplier), nightsDec));
    perGuest.push({
      classification: classifyAge(age, bundle),
      multiplier,
      charge: Number(chargeDec.toFixed(2)),
    });
  }

  let totalDec = toDecimal(0);
  for (const g of perGuest) totalDec = totalDec.add(toDecimal(g.charge));
  return { total: Number(totalDec.toFixed(2)), perGuest };
}
