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
export type RoomCompositionInput = {
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
  /**
   * Meal-PLAN rates (per guest, per night) — from the agent rate card or the HouseTariff.
   * A guest on a plan is charged their plan rate INSTEAD of the individual meals that plan
   * covers (CP = breakfast; MAPL = breakfast + lunch; MAPD = breakfast + dinner; AP = all
   * three).
   *
   * `null` / omitted means the plan isn't priced, and the plan falls back to the SUM of its
   * constituent à-la-carte rates. That fallback is exactly the old formula, so leaving all
   * four unset reproduces pre-2026-07-30 totals to the cent.
   *
   * A plan rate of 0 is honoured as "deliberately free" — only null triggers the fallback.
   */
  defaultCpRate?: Prisma.Decimal | null;
  defaultMapLunchRate?: Prisma.Decimal | null;
  defaultMapDinnerRate?: Prisma.Decimal | null;
  defaultApRate?: Prisma.Decimal | null;
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
  /** Resolved per-plan rates AFTER the à-la-carte fallback — what each plan guest is charged. */
  cpRate: Prisma.Decimal;
  mapLunchRate: Prisma.Decimal;
  mapDinnerRate: Prisma.Decimal;
  apRate: Prisma.Decimal;
  perNightRoom: Prisma.Decimal;
  perNightExtraBed: Prisma.Decimal;
  /** Charged to guests on a meal plan (plan rate × plan pax). */
  perNightPlanMeals: Prisma.Decimal;
  /** Charged to OTHERS-category guests eating à la carte (per-meal rate × others pax). */
  perNightAlaCarteMeals: Prisma.Decimal;
  /** perNightPlanMeals + perNightAlaCarteMeals. */
  perNightMeals: Prisma.Decimal;
  perNightSubtotal: Prisma.Decimal;
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
      cpRate: ZERO,
      mapLunchRate: ZERO,
      mapDinnerRate: ZERO,
      apRate: ZERO,
      perNightRoom: ZERO,
      perNightExtraBed: ZERO,
      perNightPlanMeals: ZERO,
      perNightAlaCarteMeals: ZERO,
      perNightMeals: ZERO,
      perNightSubtotal: ZERO,
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

  // Meal-plan rates. A configured plan rate REPLACES the meals that plan covers; an
  // unconfigured one (null) falls back to summing those same meals à la carte. The fallback is
  // algebraically identical to the pre-2026-07-30 formula:
  //   cp·bf + mapl·(bf+ln) + mapd·(bf+dn) + ap·(bf+ln+dn) + others
  //     = bf·(cp+mapl+mapd+ap+oB) + ln·(mapl+ap+oL) + dn·(mapd+ap+oD)
  // so quotes priced before plan rates existed reprice to the cent.
  const bf = toDecimal(breakfastRate);
  const ln = toDecimal(lunchRate);
  const dn = toDecimal(dinnerRate);

  // Per-room negotiation beats the hotel's configured plan price. Without this, a hotel that
  // sets CP = 350 would ignore an operator who negotiated breakfast down to 300 for one room —
  // the CP guests would still be charged 350, and the negotiation would silently do nothing.
  //
  // The override is scoped per plan: only the plans that actually INCLUDE a re-priced meal are
  // re-derived. Negotiating dinner re-prices MAPD and AP but leaves CP (breakfast-only) on the
  // hotel's configured rate, which is what an operator would expect.
  const bfNegotiated = input.negotiatedBreakfastRate != null;
  const lnNegotiated = input.negotiatedLunchRate != null;
  const dnNegotiated = input.negotiatedDinnerRate != null;
  const resolvePlanRate = (
    configured: Prisma.Decimal | null | undefined,
    alaCarteSum: Prisma.Decimal,
    anyConstituentNegotiated: boolean,
  ) => {
    if (anyConstituentNegotiated) return alaCarteSum;
    return configured != null ? toDecimal(configured) : alaCarteSum;
  };

  const cpRate = resolvePlanRate(ctx.defaultCpRate, bf, bfNegotiated);
  const mapLunchRate = resolvePlanRate(ctx.defaultMapLunchRate, bf.add(ln), bfNegotiated || lnNegotiated);
  const mapDinnerRate = resolvePlanRate(ctx.defaultMapDinnerRate, bf.add(dn), bfNegotiated || dnNegotiated);
  const apRate = resolvePlanRate(ctx.defaultApRate, bf.add(ln).add(dn), bfNegotiated || lnNegotiated || dnNegotiated);

  const perNightRoom = toDecimal(roomRate);
  const perNightExtraBed = toDecimal(extraBedRate).mul(extraBeds);

  // Guests on a plan pay their plan rate; OTHERS-category guests pay per serving consumed.
  const perNightPlanMeals = cpRate
    .mul(input.mealPlanCpCount ?? 0)
    .add(mapLunchRate.mul(input.mealPlanMaplCount ?? 0))
    .add(mapDinnerRate.mul(input.mealPlanMapdCount ?? 0))
    .add(apRate.mul(input.mealPlanApCount ?? 0));
  const perNightAlaCarteMeals = bf
    .mul(input.othersBreakfastPax ?? 0)
    .add(ln.mul(input.othersLunchPax ?? 0))
    .add(dn.mul(input.othersDinnerPax ?? 0));
  const perNightMeals = perNightPlanMeals.add(perNightAlaCarteMeals);

  const perNightSubtotal = perNightRoom.add(perNightExtraBed).add(perNightMeals);

  const subtotal = perNightSubtotal.mul(nights);
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
    breakfastRate: bf,
    lunchRate: ln,
    dinnerRate: dn,
    cpRate,
    mapLunchRate,
    mapDinnerRate,
    apRate,
    perNightRoom,
    perNightExtraBed,
    perNightPlanMeals,
    perNightAlaCarteMeals,
    perNightMeals,
    perNightSubtotal,
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
