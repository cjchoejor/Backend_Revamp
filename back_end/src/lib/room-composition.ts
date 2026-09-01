/**
 * Per-room composition helpers (Phase A of the per-room track, 2026-07-27).
 *
 * `RoomAssignment` carries a bundle of composition fields (adults / CNB counts / meal-plan
 * distribution / à-la-carte pax / negotiated rates / toggles / frozen totals). This module
 * provides the pure functions that turn that bundle into the numbers the pricing engine,
 * validation policies, and PDF renderers need.
 *
 * Nothing here touches the database — every function is pure. The service layer is
 * responsible for loading `RoomAssignment` rows and calling these helpers.
 */

import { Prisma } from "@prisma/client";
import { toDecimal } from "./money.js";

const ZERO = new Prisma.Decimal(0);

/** Subset of `RoomAssignment` fields the composition helpers care about. Kept as a plain
 *  type (not the full Prisma model) so callers can pass in a subset without doing an extra
 *  DB round-trip to fetch fields they don't need. */
/**
 * A single night whose meal distribution differs from the room's stay-wide default
 * (2026-07-28). The counts REPLACE the room-level ones for that night — they don't add to
 * them — so "AP on arrival night, CP the rest" is one override row, not two.
 *
 * Mirrors `RoomNightMealPlan`. Nights with no override price from the room-level fields, so
 * a booking with no overrides prices exactly as it did before per-night meals existed.
 */
export type RoomNightMealOverride = {
  /** The stay-night the guest sleeps. Compared by calendar day, not by timestamp. */
  date: Date;
  mealPlanCpCount?: number | null;
  mealPlanMaplCount?: number | null;
  mealPlanMapdCount?: number | null;
  mealPlanApCount?: number | null;
  mealPlanOthersCount?: number | null;
  othersBreakfastPax?: number | null;
  othersLunchPax?: number | null;
  othersDinnerPax?: number | null;
  /**
   * Extra beds on this ONE night when it differs from the room's stay-wide `extraBedCount`
   * (2026-08-19 — an in-house setup change: the bed is added from tonight, so the slept nights
   * keep the old count while the row shows the new one). Null/absent = the room default. An
   * override that carries ONLY this field leaves the night's meals at the room default.
   */
  extraBedCount?: number | null;
};

export type RoomCompositionInput = {
  /**
   * Per-night meal-plan overrides. Only applied when the composition knows its `startDate`
   * — without it there is no way to say which night is which, so overrides are ignored
   * rather than guessed at.
   */
  nightMealOverrides?: RoomNightMealOverride[] | null;
  // meal-plan distribution
  mealPlanCpCount?: number | null;
  mealPlanMaplCount?: number | null;
  mealPlanMapdCount?: number | null;
  mealPlanApCount?: number | null;
  mealPlanOthersCount?: number | null;
  // à-la-carte pax overrides for OTHERS-category guests
  othersBreakfastPax?: number | null;
  othersLunchPax?: number | null;
  othersDinnerPax?: number | null;
  // composition counts. Anyone aged 11+ counts as an adult per registry.child.ageBands.
  occupantCount?: number | null;
  adultCount?: number | null;
  cnb6To10Count?: number | null;
  cnbUnder6Count?: number | null;
  extraBedCount?: number | null;
  // negotiated per-room rates (fall back to context defaults when null)
  negotiatedRoomRate?: Prisma.Decimal | null;
  negotiatedExtraBedRate?: Prisma.Decimal | null;
  negotiatedBreakfastRate?: Prisma.Decimal | null;
  negotiatedLunchRate?: Prisma.Decimal | null;
  negotiatedDinnerRate?: Prisma.Decimal | null;
  // toggles
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  isFoc?: boolean;
  // date range — for nights calc
  startDate?: Date | null;
  endDate?: Date | null;
};

/** Rates + tax percentages fetched from rate card + config at pricing time. Callers assemble
 *  this and pass in — the helper never queries. */
export type RoomCompositionRateContext = {
  /** Standard room rate from rate card / rate plan resolution. Used when
   *  `negotiatedRoomRate` is null. */
  defaultRoomRate: Prisma.Decimal;
  defaultExtraBedRate: Prisma.Decimal;
  defaultBreakfastRate: Prisma.Decimal;
  /**
   * Meal-PLAN rates (per guest, per night) — from the party's rate package or the HouseTariff.
   * A guest on a plan is charged their plan rate INSTEAD of the individual meals it covers
   * (CP = breakfast; MAPL = breakfast + lunch; MAPD = breakfast + dinner; AP = all three).
   *
   * `null` / omitted means the plan is not separately priced and falls back to the SUM of its
   * constituent a-la-carte rates — which is exactly the previous formula, so leaving all four
   * unset reproduces existing totals to the cent. A plan rate of 0 is honoured as "deliberately
   * free"; only null triggers the fallback.
   */
  defaultCpRate?: Prisma.Decimal | null;
  defaultMapLunchRate?: Prisma.Decimal | null;
  defaultMapDinnerRate?: Prisma.Decimal | null;
  defaultApRate?: Prisma.Decimal | null;
  defaultLunchRate: Prisma.Decimal;
  defaultDinnerRate: Prisma.Decimal;
  /** Service-charge percentage (e.g., 0.10 for 10%). Comes from
   *  `billing.serviceChargeRate` ConfigurationEntry. */
  serviceChargeRate: number;
  /** GST percentage (e.g., 0.05 for 5%). Comes from `billing.salesTaxRate`. */
  gstRate: number;
  /**
   * Age-band meal shares from `registry.child.mealPricing` (admin-editable) — the percentage OF
   * the adult meal rate each band pays: under-6 0, 6–10 70, adult 100 by default. Pass
   * `loadChildPolicyBundle(db).mealPricing`.
   *
   * Optional only so a caller with no DB access still type-checks; when it is omitted every
   * cover is charged the full adult rate, which is what the composition path did before
   * 2026-08-04 and is wrong for any room with children. Every caller should pass it.
   */
  childMealPricing?: {
    enabled: boolean;
    youngChildPercent: number;
    childPercent: number;
    adultPercent: number;
  };
  /**
   * Nights the composition covers. Callers can either pass this explicitly (e.g., from
   * `entry.checkOutDate - entry.checkInDate`) or leave it undefined and rely on the
   * assignment's own `startDate`/`endDate`. When both are null → treated as 1 night
   * (defensive default matching existing night-audit semantics).
   */
  nights?: number;
};

/**
 * Effective breakfast / lunch / dinner pax counts derived from the meal-plan distribution
 * + à-la-carte overrides. This is the number of "meal servings" the room is billed for,
 * per meal, per night.
 */
export function paxFromMealPlanCounts(input: RoomCompositionInput): {
  breakfastPax: number;
  lunchPax: number;
  dinnerPax: number;
} {
  const cp = input.mealPlanCpCount ?? 0;
  const mapl = input.mealPlanMaplCount ?? 0;
  const mapd = input.mealPlanMapdCount ?? 0;
  const ap = input.mealPlanApCount ?? 0;
  const otherB = input.othersBreakfastPax ?? 0;
  const otherL = input.othersLunchPax ?? 0;
  const otherD = input.othersDinnerPax ?? 0;
  return {
    // Every plan includes breakfast.
    breakfastPax: cp + mapl + mapd + ap + otherB,
    // MAPL and AP include lunch.
    lunchPax: mapl + ap + otherL,
    // MAPD and AP include dinner.
    dinnerPax: mapd + ap + otherD,
  };
}

/** Calendar-day key (UTC) — overrides are matched by day, never by timestamp. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The stay-nights this composition covers, as day keys, starting at `startDate`.
 * Empty when the start date is unknown — callers then have no way to place an override.
 */
export function nightKeys(input: RoomCompositionInput, nights: number): string[] {
  if (!input.startDate) return [];
  const start = Date.UTC(
    input.startDate.getUTCFullYear(),
    input.startDate.getUTCMonth(),
    input.startDate.getUTCDate(),
  );
  return Array.from({ length: nights }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Index the overrides by day key, keeping the LAST entry for a repeated day so a caller
 * that appends corrections doesn't silently price the stale one.
 */
function indexOverrides(overrides: RoomNightMealOverride[] | null | undefined): Map<string, RoomNightMealOverride> {
  const map = new Map<string, RoomNightMealOverride>();
  for (const o of overrides ?? []) {
    if (!o?.date || Number.isNaN(o.date.getTime())) continue;
    map.set(dayKey(o.date), o);
  }
  return map;
}

/** Whether an override says anything about MEALS (a bed-only override leaves meals alone). */
function overrideCarriesMeals(o: RoomNightMealOverride): boolean {
  return (
    o.mealPlanCpCount != null ||
    o.mealPlanMaplCount != null ||
    o.mealPlanMapdCount != null ||
    o.mealPlanApCount != null ||
    o.mealPlanOthersCount != null ||
    o.othersBreakfastPax != null ||
    o.othersLunchPax != null ||
    o.othersDinnerPax != null
  );
}

/** The meal counts in force on a given night: the override if there is one, else the room default. */
function mealCountsForNight(
  input: RoomCompositionInput,
  override: RoomNightMealOverride | undefined,
): RoomCompositionInput {
  if (!override || !overrideCarriesMeals(override)) return input;
  return {
    mealPlanCpCount: override.mealPlanCpCount ?? 0,
    mealPlanMaplCount: override.mealPlanMaplCount ?? 0,
    mealPlanMapdCount: override.mealPlanMapdCount ?? 0,
    mealPlanApCount: override.mealPlanApCount ?? 0,
    mealPlanOthersCount: override.mealPlanOthersCount ?? 0,
    othersBreakfastPax: override.othersBreakfastPax ?? 0,
    othersLunchPax: override.othersLunchPax ?? 0,
    othersDinnerPax: override.othersDinnerPax ?? 0,
  };
}

/**
 * Number of nights this room is stayed for. Prefers explicit `rateContext.nights`, falls
 * back to the assignment's own date range, then to 1 night as a defensive default.
 */
/**
 * Auto-add the mandatory extra bed (2026-08-12, operator ruling — "much better would be to
 * put extra bed automatically wherever required"): a non-FOC room with 3+ adults (p78 —
 * anyone 11+ counts as an adult) and no extra bed gets exactly ONE added, the p78 minimum,
 * instead of the quotation being refused. Returns the corrected list plus the touched
 * indexes so callers can surface/record the correction.
 *
 * Shared by the S2 draft pipeline (`prepareQuotationDraft`) and the live preview
 * (`buildQuotationPreview`) so the two can never price differently. p78 stays wired after
 * this as belt-and-braces for callers that skip normalization.
 */
export function autoAddRequiredExtraBeds<
  T extends { adultCount?: number | null; extraBedCount?: number | null; isFoc?: boolean },
>(
  compositions: T[],
  opts?: {
    /** The room TYPE's `maxExtraBeds` for this composition's room, when the caller knows it.
     *  A room that physically takes no extra bed is left untouched — p78 then refuses with
     *  its "add a bed or reduce the adults" message, which is the honest answer there. Null/
     *  undefined (caller can't resolve the type) is treated as permissive, matching p78's
     *  own ignorance of bed limits. */
    maxExtraBedsForRoom?: (c: T, index: number) => number | null | undefined;
  },
): { compositions: T[]; autoAddedIndexes: number[] } {
  const autoAddedIndexes: number[] = [];
  const out = compositions.map((c, i) => {
    if (c.isFoc === true) return c;
    if ((c.adultCount ?? 0) < 3) return c;
    if ((c.extraBedCount ?? 0) > 0) return c;
    const allowed = opts?.maxExtraBedsForRoom?.(c, i);
    if (allowed != null && allowed < 1) return c;
    autoAddedIndexes.push(i);
    return { ...c, extraBedCount: 1 };
  });
  return { compositions: out, autoAddedIndexes };
}

export function resolveNights(input: RoomCompositionInput, ctx: RoomCompositionRateContext): number {
  if (typeof ctx.nights === "number" && Number.isFinite(ctx.nights) && ctx.nights > 0) {
    return Math.floor(ctx.nights);
  }
  if (input.startDate && input.endDate) {
    const diffMs = input.endDate.getTime() - input.startDate.getTime();
    const nights = Math.round(diffMs / 86_400_000);
    if (nights > 0) return nights;
  }
  return 1;
}

/**
 * Full per-room breakdown. Callers use this for:
 *   - Pricing the quotation (S2 — sum across rooms for the total quote)
 *   - Freezing per-room totals at S4 confirmation
 *   - Rendering the invoice PDF row-by-row per room
 *
 * When `isFoc` is true, every money field returns 0 (full waiver semantics).
 */
export function computeRoomComposition(
  input: RoomCompositionInput,
  ctx: RoomCompositionRateContext,
): {
  nights: number;
  effectiveBreakfastPax: number;
  effectiveLunchPax: number;
  effectiveDinnerPax: number;
  roomRate: Prisma.Decimal;
  extraBedRate: Prisma.Decimal;
  breakfastRate: Prisma.Decimal;
  lunchRate: Prisma.Decimal;
  dinnerRate: Prisma.Decimal;
  perNightRoom: Prisma.Decimal;
  perNightExtraBed: Prisma.Decimal;
  /** One un-overridden night's meals — the room's usual night, and what the UI calls "per night". */
  perNightMeals: Prisma.Decimal;
  perNightSubtotal: Prisma.Decimal;
  /** Meals across the whole stay. Equals `perNightMeals × nights` when no night is overridden. */
  mealsSubtotal: Prisma.Decimal;
  /**
   * The meals subtotal split by meal (2026-08-07, for the negotiation table's per-column
   * money). Each is the whole-stay figure — banded by age and override-aware, exactly the
   * components `mealsSubtotal` is the sum of.
   */
  breakfastSubtotal: Prisma.Decimal;
  lunchSubtotal: Prisma.Decimal;
  dinnerSubtotal: Prisma.Decimal;
  /** Populated only when overrides applied — one entry per stay-night, for display/audit.
   *  `extraBeds` is that night's count (2026-08-19) — equals the row's stay-wide count unless
   *  the night carries a bed override. */
  perNightMealBreakdown: Array<{ date: string; meals: Prisma.Decimal; overridden: boolean; extraBeds: number }>;
  /** Extra beds across the whole stay — `perNightExtraBed × nights` unless a night overrides
   *  the bed count (2026-08-19). */
  extraBedSubtotal: Prisma.Decimal;
  /** True when at least one night carries its own extra-bed count — "count × nights" no longer
   *  describes the room and consumers should print the subtotal as "varies by night". */
  extraBedsVaryByNight: boolean;
  subtotal: Prisma.Decimal;
  serviceCharge: Prisma.Decimal;
  gst: Prisma.Decimal;
  total: Prisma.Decimal;
} {
  if (input.isFoc === true) {
    // Full waiver — every money value zero. Still return the pax counts + rates for display.
    const { breakfastPax, lunchPax, dinnerPax } = paxFromMealPlanCounts(input);
    return {
      nights: resolveNights(input, ctx),
      effectiveBreakfastPax: breakfastPax,
      effectiveLunchPax: lunchPax,
      effectiveDinnerPax: dinnerPax,
      roomRate: ZERO,
      extraBedRate: ZERO,
      breakfastRate: ZERO,
      lunchRate: ZERO,
      dinnerRate: ZERO,
      perNightRoom: ZERO,
      perNightExtraBed: ZERO,
      perNightMeals: ZERO,
      perNightSubtotal: ZERO,
      mealsSubtotal: ZERO,
      breakfastSubtotal: ZERO,
      lunchSubtotal: ZERO,
      dinnerSubtotal: ZERO,
      perNightMealBreakdown: [],
      extraBedSubtotal: ZERO,
      extraBedsVaryByNight: false,
      subtotal: ZERO,
      serviceCharge: ZERO,
      gst: ZERO,
      total: ZERO,
    };
  }

  const nights = resolveNights(input, ctx);
  const { breakfastPax, lunchPax, dinnerPax } = paxFromMealPlanCounts(input);
  const roomRate = input.negotiatedRoomRate ?? ctx.defaultRoomRate;
  const extraBedRate = input.negotiatedExtraBedRate ?? ctx.defaultExtraBedRate;
  const breakfastRate = input.negotiatedBreakfastRate ?? ctx.defaultBreakfastRate;
  const lunchRate = input.negotiatedLunchRate ?? ctx.defaultLunchRate;
  const dinnerRate = input.negotiatedDinnerRate ?? ctx.defaultDinnerRate;

  const extraBeds = input.extraBedCount ?? 0;

  const perNightRoom = toDecimal(roomRate);
  const perNightExtraBed = toDecimal(extraBedRate).mul(extraBeds);
  /**
   * One meal's covers, priced by age band (docs/Legphel-Child-Policy.md §4).
   *
   * The rule is a share OF the adult rate, not a discount off it: under-6 free, 6–10 at 70%,
   * 11+ at the full rate. The percentages come from `registry.child.mealPricing` and are
   * admin-editable — nothing here assumes 70.
   *
   * The row stores COUNTS, not who is on which plan, so covers are allocated adults first, then
   * 6–10, then under-6. When everyone in the room takes the plan — the normal case, and what the
   * guest board produces — that allocation is exact. When only some do, it charges the adults
   * first, which is the conservative reading rather than the one that discounts most. Covers
   * beyond the room's declared bands price as adults.
   *
   * With no children in the room, or with the policy disabled, this is `rate × pax` to the cent —
   * so nothing changes for the bookings that were already correct.
   */
  const bandedMealCost = (rate: Prisma.Decimal, pax: number): Prisma.Decimal => {
    const pricing = ctx.childMealPricing;
    const kids = Math.max(0, input.cnb6To10Count ?? 0);
    const young = Math.max(0, input.cnbUnder6Count ?? 0);
    if (!pricing || pricing.enabled === false || pax <= 0 || (kids === 0 && young === 0)) {
      return toDecimal(rate).mul(pax);
    }
    const adultCovers = Math.min(pax, Math.max(0, input.adultCount ?? 0));
    const kidCovers = Math.min(pax - adultCovers, kids);
    const youngCovers = Math.min(pax - adultCovers - kidCovers, young);
    const unbanded = pax - adultCovers - kidCovers - youngCovers;
    const weight =
      (adultCovers + unbanded) * pricing.adultPercent +
      kidCovers * pricing.childPercent +
      youngCovers * pricing.youngChildPercent;
    return toDecimal(rate).mul(weight).div(100);
  };

  /** One night's meals for a given distribution, split by meal — the split is what the
   *  negotiation table's per-column money reads; `mealsSubtotal` stays their exact sum. */
  const bf = toDecimal(breakfastRate);
  const ln = toDecimal(lunchRate);
  const dn = toDecimal(dinnerRate);

  // Per-room negotiation beats the hotel's configured plan price. Without this, a hotel that
  // sets CP = 350 would ignore an operator who negotiated breakfast down to 300 for one room —
  // the CP guests would still be charged 350 and the negotiation would silently do nothing.
  // Scoped per plan: only plans that actually INCLUDE a re-priced meal are re-derived, so
  // negotiating dinner re-prices MAPD and AP but leaves CP (breakfast-only) alone.
  const bfNeg = input.negotiatedBreakfastRate != null;
  const lnNeg = input.negotiatedLunchRate != null;
  const dnNeg = input.negotiatedDinnerRate != null;
  const resolvePlanRate = (
    configured: Prisma.Decimal | null | undefined,
    alaCarteSum: Prisma.Decimal,
    anyConstituentNegotiated: boolean,
  ): Prisma.Decimal => {
    if (anyConstituentNegotiated) return alaCarteSum;
    return configured != null ? toDecimal(configured) : alaCarteSum;
  };

  /**
   * A plan's price is charged as ONE figure per guest, but the negotiation table shows money per
   * MEAL — so a plan rate that differs from the sum of its meals has to be attributed back
   * across them, or the columns would stop adding up to the total.
   *
   * Attribution is proportional to the a-la-carte rates: an AP rate of 900 against meals of
   * 300/350/350 (sum 1000) charges each meal at 90%. When the plan rate EQUALS the sum — the
   * normal case, and what happens whenever no plan rate is configured — the factor is exactly 1
   * and every figure is identical to before. When the constituent rates are all zero there is
   * nothing to be proportional to, so the plan rate is split evenly among its meals.
   */
  const planMeals: Array<{ pax: number; rate: Prisma.Decimal; meals: Array<"b" | "l" | "d"> }> = [
    { pax: input.mealPlanCpCount ?? 0, rate: resolvePlanRate(ctx.defaultCpRate, bf, bfNeg), meals: ["b"] },
    { pax: input.mealPlanMaplCount ?? 0, rate: resolvePlanRate(ctx.defaultMapLunchRate, bf.add(ln), bfNeg || lnNeg), meals: ["b", "l"] },
    { pax: input.mealPlanMapdCount ?? 0, rate: resolvePlanRate(ctx.defaultMapDinnerRate, bf.add(dn), bfNeg || dnNeg), meals: ["b", "d"] },
    { pax: input.mealPlanApCount ?? 0, rate: resolvePlanRate(ctx.defaultApRate, bf.add(ln).add(dn), bfNeg || lnNeg || dnNeg), meals: ["b", "l", "d"] },
  ];
  const rateOf = (m: "b" | "l" | "d") => (m === "b" ? bf : m === "l" ? ln : dn);

  const mealCostByMeal = (counts: RoomCompositionInput) => {
    const acc = { breakfast: ZERO, lunch: ZERO, dinner: ZERO };
    const bump = (m: "b" | "l" | "d", v: Prisma.Decimal) => {
      if (m === "b") acc.breakfast = acc.breakfast.add(v);
      else if (m === "l") acc.lunch = acc.lunch.add(v);
      else acc.dinner = acc.dinner.add(v);
    };
    const paxFor = (i: number) =>
      [counts.mealPlanCpCount ?? 0, counts.mealPlanMaplCount ?? 0, counts.mealPlanMapdCount ?? 0, counts.mealPlanApCount ?? 0][i];

    planMeals.forEach((plan, i) => {
      const pax = paxFor(i);
      if (pax <= 0) return;
      const sum = plan.meals.reduce((t, m) => t.add(rateOf(m)), ZERO);
      for (const m of plan.meals) {
        const share = sum.isZero()
          ? plan.rate.div(plan.meals.length)
          : rateOf(m).mul(plan.rate).div(sum);
        bump(m, bandedMealCost(share, pax));
      }
    });

    // OTHERS-category guests eat a la carte — charged per serving consumed, no plan involved.
    bump("b", bandedMealCost(bf, counts.othersBreakfastPax ?? 0));
    bump("l", bandedMealCost(ln, counts.othersLunchPax ?? 0));
    bump("d", bandedMealCost(dn, counts.othersDinnerPax ?? 0));
    return acc;
  };
  // The room's usual night — what an un-overridden night costs, and what the UI shows as
  // "per night".
  const perNightByMeal = mealCostByMeal(input);
  const perNightMeals = perNightByMeal.breakfast.add(perNightByMeal.lunch).add(perNightByMeal.dinner);
  const perNightSubtotal = perNightRoom.add(perNightExtraBed).add(perNightMeals);

  // The room rate is the same every night; meals — and, since 2026-08-19, the extra-bed count —
  // can vary per night. Summing night by night is what makes "AP on arrival, CP after" (and
  // "extra bed from tonight" on an in-house setup change) price correctly.
  const overrides = indexOverrides(input.nightMealOverrides);
  const keys = overrides.size > 0 ? nightKeys(input, nights) : [];
  const perNight: Array<{ date: string; meals: Prisma.Decimal; overridden: boolean; extraBeds: number }> = [];
  let mealsSubtotal: Prisma.Decimal;
  let breakfastSubtotal: Prisma.Decimal;
  let lunchSubtotal: Prisma.Decimal;
  let dinnerSubtotal: Prisma.Decimal;
  let extraBedSubtotal: Prisma.Decimal;
  let extraBedsVaryByNight = false;
  if (keys.length === 0) {
    // No overrides (or no start date to place them against) — identical to the pre-2026-07-28
    // behaviour, to the cent.
    mealsSubtotal = perNightMeals.mul(nights);
    breakfastSubtotal = perNightByMeal.breakfast.mul(nights);
    lunchSubtotal = perNightByMeal.lunch.mul(nights);
    dinnerSubtotal = perNightByMeal.dinner.mul(nights);
    extraBedSubtotal = perNightExtraBed.mul(nights);
  } else {
    mealsSubtotal = ZERO;
    breakfastSubtotal = ZERO;
    lunchSubtotal = ZERO;
    dinnerSubtotal = ZERO;
    extraBedSubtotal = ZERO;
    for (const key of keys) {
      const o = overrides.get(key);
      const m = o ? mealCostByMeal(mealCountsForNight(input, o)) : perNightByMeal;
      const meals = m.breakfast.add(m.lunch).add(m.dinner);
      const bedsTonight = o?.extraBedCount != null ? Math.max(0, Math.trunc(o.extraBedCount)) : extraBeds;
      if (bedsTonight !== extraBeds) extraBedsVaryByNight = true;
      perNight.push({ date: key, meals, overridden: !!o, extraBeds: bedsTonight });
      mealsSubtotal = mealsSubtotal.add(meals);
      breakfastSubtotal = breakfastSubtotal.add(m.breakfast);
      lunchSubtotal = lunchSubtotal.add(m.lunch);
      dinnerSubtotal = dinnerSubtotal.add(m.dinner);
      extraBedSubtotal = extraBedSubtotal.add(toDecimal(extraBedRate).mul(bedsTonight));
    }
  }

  const subtotal = perNightRoom.mul(nights).add(extraBedSubtotal).add(mealsSubtotal);
  const serviceCharge =
    input.serviceChargeApplies !== false && ctx.serviceChargeRate > 0
      ? subtotal.mul(ctx.serviceChargeRate)
      : ZERO;
  // GST is compounded on (subtotal + serviceCharge) per the hotel-wide rule (see
  // compute-stay-charges.ts + the invoice PDF renderer).
  const gst =
    input.gstApplies !== false && ctx.gstRate > 0
      ? subtotal.add(serviceCharge).mul(ctx.gstRate)
      : ZERO;
  const total = subtotal.add(serviceCharge).add(gst);

  return {
    nights,
    effectiveBreakfastPax: breakfastPax,
    effectiveLunchPax: lunchPax,
    effectiveDinnerPax: dinnerPax,
    roomRate: toDecimal(roomRate),
    extraBedRate: toDecimal(extraBedRate),
    breakfastRate: toDecimal(breakfastRate),
    lunchRate: toDecimal(lunchRate),
    dinnerRate: toDecimal(dinnerRate),
    perNightRoom,
    perNightExtraBed,
    perNightMeals,
    perNightSubtotal,
    mealsSubtotal,
    breakfastSubtotal,
    lunchSubtotal,
    dinnerSubtotal,
    perNightMealBreakdown: perNight,
    extraBedSubtotal,
    extraBedsVaryByNight,
    subtotal,
    serviceCharge,
    gst,
    total,
  };
}

/**
 * Sum of the composition's three "how many people" fields. `null` counts count as 0.
 * Used by the consistency validator (should equal `occupantCount`) and by the mandatory-
 * extra-bed rule (uses `adultCount` alone — anyone 11+ is an adult).
 */
export function totalPeopleFromComposition(input: RoomCompositionInput): number {
  return (
    (input.adultCount ?? 0) +
    (input.cnb6To10Count ?? 0) +
    (input.cnbUnder6Count ?? 0)
  );
}

/**
 * Sum of the meal-plan distribution counts. Should be ≤ occupantCount (a room can't have
 * more meal-plan pax than physical guests).
 */
export function totalMealPlanAssignments(input: RoomCompositionInput): number {
  return (
    (input.mealPlanCpCount ?? 0) +
    (input.mealPlanMaplCount ?? 0) +
    (input.mealPlanMapdCount ?? 0) +
    (input.mealPlanApCount ?? 0) +
    (input.mealPlanOthersCount ?? 0)
  );
}

/**
 * Aggregate per-room compositions into a single quotation-wide summary. Used by S2
 * `createQuotation` when the caller supplied a `roomCompositions` array — replaces the
 * flat `rate × nights × roomCount` model with a proper per-room sum.
 *
 * Each entry gets its own `computeRoomComposition` call (with its own rate context so
 * negotiated per-room rates work); the results are then summed into a single set of
 * totals for the quotation.
 *
 * `perRoom` in the return value is retained so downstream (PDF renderer, folio card,
 * settlement UI) can show the per-room breakdown alongside the aggregate.
 */
export function computeQuotationCompositionTotals(
  rooms: Array<{ input: RoomCompositionInput; ctx: RoomCompositionRateContext; roomId: string; roomNumber?: string | null }>,
): {
  perRoom: Array<
    ReturnType<typeof computeRoomComposition> & { roomId: string; roomNumber: string | null }
  >;
  subtotal: Prisma.Decimal;
  serviceCharge: Prisma.Decimal;
  gst: Prisma.Decimal;
  total: Prisma.Decimal;
} {
  const perRoom = rooms.map((r) => ({
    ...computeRoomComposition(r.input, r.ctx),
    roomId: r.roomId,
    roomNumber: r.roomNumber ?? null,
  }));
  const sum = (pick: (r: (typeof perRoom)[number]) => Prisma.Decimal) =>
    perRoom.reduce<Prisma.Decimal>((acc, r) => acc.add(pick(r)), ZERO);
  return {
    perRoom,
    subtotal: sum((r) => r.subtotal),
    serviceCharge: sum((r) => r.serviceCharge),
    gst: sum((r) => r.gst),
    total: sum((r) => r.total),
  };
}

export type CompositionTotals = ReturnType<typeof computeQuotationCompositionTotals>;

/** How the operator expressed the booking discount — one of the two, never both. */
export type BookingDiscountRequest = { percent?: number | null; amount?: number | null };

export type BookingDiscountResult = {
  /** Totals after the deduction — same shape as the undiscounted run. */
  totals: CompositionTotals;
  /** Money off the grand total, exactly as promised to the guest. */
  amountOffTotal: Prisma.Decimal;
  /** The same deduction as a share of the grand total. Authority ceilings are measured in this. */
  effectivePercent: Prisma.Decimal;
  /** The net-level reduction that produces it. */
  netReduction: Prisma.Decimal;
};

/**
 * Take a booking discount off the composition GRAND TOTAL — percent or flat amount, same result.
 *
 * Operator ruling 2026-08-04: a discount applies to everything in the table, meals and extra beds
 * included, not to the room rate alone. Per-room negotiated rates are a separate mechanism — they
 * decide what a room costs, and the discount then comes off whatever the table adds up to.
 *
 * The deduction is applied to each room's NET rather than subtracted from the tax-inclusive
 * total. Subtracting at the end would leave service charge and GST computed on the undiscounted
 * figure, so the hotel would remit GST on money it never received. Because
 * `total = net × (1 + sc) × (1 + gst)` for every room, scaling all nets by one ratio scales the
 * grand total by that same ratio — the guest sees exactly the figure asked for, and each room's
 * tax follows the true consideration. Rooms differ in whether SC/GST apply at all, which is why
 * this recomputes tax per room instead of working back through one blended factor.
 *
 * Displayed RATES are left untouched: they are what the operator negotiated, and the document
 * prints them as the original prices with the deduction shown as its own line.
 */
export function applyBookingDiscountToTotals(
  totals: CompositionTotals,
  rooms: Array<{ input: RoomCompositionInput; ctx: RoomCompositionRateContext }>,
  request: BookingDiscountRequest,
): BookingDiscountResult | null {
  const pct = request.percent ?? null;
  const amt = request.amount ?? null;
  const wantsPercent = pct != null && pct > 0;
  const wantsAmount = amt != null && amt > 0;
  if (!wantsPercent && !wantsAmount) return null;

  const grand = totals.total;
  if (grand.lte(ZERO)) return null;

  const asked = wantsAmount ? new Prisma.Decimal(amt as number) : grand.mul(new Prisma.Decimal(pct as number)).div(100);
  // A discount bigger than the bill settles the bill; it never turns into a refund.
  const off = asked.gt(grand) ? grand : asked;
  const ratio = grand.sub(off).div(grand);

  const perRoom = totals.perRoom.map((r, i) => {
    const ctx = rooms[i]?.ctx;
    const flags = rooms[i]?.input;
    const subtotal = r.subtotal.mul(ratio);
    const serviceCharge =
      flags?.serviceChargeApplies !== false && (ctx?.serviceChargeRate ?? 0) > 0
        ? subtotal.mul(ctx!.serviceChargeRate)
        : ZERO;
    const gst =
      flags?.gstApplies !== false && (ctx?.gstRate ?? 0) > 0
        ? subtotal.add(serviceCharge).mul(ctx!.gstRate)
        : ZERO;
    return { ...r, subtotal, serviceCharge, gst, total: subtotal.add(serviceCharge).add(gst) };
  });
  const sum = (pick: (r: (typeof perRoom)[number]) => Prisma.Decimal) =>
    perRoom.reduce<Prisma.Decimal>((acc, r) => acc.add(pick(r)), ZERO);

  return {
    totals: {
      perRoom,
      subtotal: sum((r) => r.subtotal),
      serviceCharge: sum((r) => r.serviceCharge),
      gst: sum((r) => r.gst),
      total: sum((r) => r.total),
    },
    amountOffTotal: off,
    effectivePercent: off.div(grand).mul(100),
    netReduction: totals.subtotal.sub(sum((r) => r.subtotal)),
  };
}
