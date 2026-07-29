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
  defaultLunchRate: Prisma.Decimal;
  defaultDinnerRate: Prisma.Decimal;
  /** Service-charge percentage (e.g., 0.10 for 10%). Comes from
   *  `billing.serviceChargeRate` ConfigurationEntry. */
  serviceChargeRate: number;
  /** GST percentage (e.g., 0.05 for 5%). Comes from `billing.salesTaxRate`. */
  gstRate: number;
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

/** The meal counts in force on a given night: the override if there is one, else the room default. */
function mealCountsForNight(
  input: RoomCompositionInput,
  override: RoomNightMealOverride | undefined,
): RoomCompositionInput {
  if (!override) return input;
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
  /** Populated only when overrides applied — one entry per stay-night, for display/audit. */
  perNightMealBreakdown: Array<{ date: string; meals: Prisma.Decimal; overridden: boolean }>;
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
      perNightMealBreakdown: [],
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
  /** Cost of one night's meals for a given distribution. */
  const mealCostFor = (counts: RoomCompositionInput): Prisma.Decimal => {
    const p = paxFromMealPlanCounts(counts);
    return toDecimal(breakfastRate)
      .mul(p.breakfastPax)
      .add(toDecimal(lunchRate).mul(p.lunchPax))
      .add(toDecimal(dinnerRate).mul(p.dinnerPax));
  };
  // The room's usual night — what an un-overridden night costs, and what the UI shows as
  // "per night".
  const perNightMeals = mealCostFor(input);
  const perNightSubtotal = perNightRoom.add(perNightExtraBed).add(perNightMeals);

  // Room + extra bed are the same every night; only meals can vary. Summing meals night by
  // night is what makes "AP on arrival, CP after" price correctly.
  const overrides = indexOverrides(input.nightMealOverrides);
  const keys = overrides.size > 0 ? nightKeys(input, nights) : [];
  const perNight: Array<{ date: string; meals: Prisma.Decimal; overridden: boolean }> = [];
  let mealsSubtotal: Prisma.Decimal;
  if (keys.length === 0) {
    // No overrides (or no start date to place them against) — identical to the pre-2026-07-28
    // behaviour, to the cent.
    mealsSubtotal = perNightMeals.mul(nights);
  } else {
    mealsSubtotal = ZERO;
    for (const key of keys) {
      const o = overrides.get(key);
      const meals = o ? mealCostFor(mealCountsForNight(input, o)) : perNightMeals;
      perNight.push({ date: key, meals, overridden: !!o });
      mealsSubtotal = mealsSubtotal.add(meals);
    }
  }

  const subtotal = perNightRoom.add(perNightExtraBed).mul(nights).add(mealsSubtotal);
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
    perNightMealBreakdown: perNight,
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
