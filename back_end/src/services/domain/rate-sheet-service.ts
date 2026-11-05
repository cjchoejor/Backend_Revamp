import { Prisma, RatePackageScope, type PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { resolveActiveHouseTariff } from "../../lib/house-tariff.js";
import { resolveRatePackageForBooking, type RatePackageBreakdown } from "../../lib/rate-package-resolution.js";
import { plansAgainstMeals } from "../../lib/room-composition.js";
import { resolveRatePlanPricingForS2Quotation } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";

/**
 * The rates a booking is priced on, as one sheet (2026-11-05, operator: "when a travel agent or
 * anything is chosen, they have their package rate right … add a new sub tab and name it as package,
 * there you can show the package in tabular form").
 *
 * A read, nothing written. It asks the same resolvers the quotation asks — the party's package per
 * room type (explicit choice → party default → common), else the room type's published plan and the
 * house tariff — so the sheet cannot say one thing while the bill says another. Each figure is before
 * service charge and GST; `withTax` is that figure with both, worked out here in Decimal.
 *
 * The figures mean what pricing makes them mean:
 *  - a blank add-on on a package is free ("we agreed nothing"), never the house's price;
 *  - a meal plan with no rate of its own is charged as the sum of its meals, a blank meal adding nothing;
 *  - a plan of 0 is deliberately free.
 */

const MEALS_OF_PLAN = {
  cp: ["breakfast"],
  mapLunch: ["breakfast", "lunch"],
  mapDinner: ["breakfast", "dinner"],
  ap: ["breakfast", "lunch", "dinner"],
} as const;
type PlanKey = keyof typeof MEALS_OF_PLAN;
type MealKey = "breakfast" | "lunch" | "dinner";
const PLAN_RATE_KEY = { cp: "cpRate", mapLunch: "mapLunchRate", mapDinner: "mapDinnerRate", ap: "apRate" } as const;

export type RateSheetSource =
  /** The party's own package. */
  | "PACKAGE"
  /** The party has none: the hotel's common package. */
  | "COMMON"
  /** No party: the room types' published plans and the house tariff. */
  | "PUBLISHED"
  /** A party, but no package of theirs and no common one: priced as published. */
  | "NO_PACKAGE";

export type RateSheet = {
  source: RateSheetSource;
  party: { kind: "TRAVEL_AGENT" | "CORPORATE"; id: string; name: string } | null;
  packageName: string | null;
  currency: string;
  /** "10" and "5", for the column's words. */
  serviceChargePercent: string;
  gstPercent: string;
  rooms: Array<{ roomTypeId: string; code: string | null; name: string; rate: string | null; withTax: string | null }>;
  extraBed: { rate: string | null; withTax: string | null };
  meals: Array<{ key: MealKey; rate: string | null; withTax: string | null }>;
  plans: Array<{
    key: PlanKey;
    /** What a guest on the plan is charged. Null: nothing set for it or its meals, so nothing is charged. */
    rate: string | null;
    withTax: string | null;
    fromMeals: boolean;
    /** A plan at a figure of its own that its meals do not add up to: what they do add up to. */
    mealsAddUpTo: string | null;
  }>;
};

const dec = (v: unknown): Prisma.Decimal | null => (v == null || v === "" ? null : new Prisma.Decimal(v as Prisma.Decimal.Value));

/** Rooms in the order the house lists them: by the lowest room number of each type. */
function byRoomNumber(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}

export async function buildRateSheet(
  prisma: PrismaClient,
  input: {
    travelAgentId?: string | null;
    corporateAccountId?: string | null;
    ratePackageId?: string | null;
    /** A season on these nights changes a published rate; a package's rates have no season. */
    stay?: { checkIn: Date; checkOut: Date };
  },
): Promise<RateSheet> {
  const travelAgentId = input.travelAgentId ?? null;
  const corporateAccountId = input.corporateAccountId ?? null;

  let party: RateSheet["party"] = null;
  if (travelAgentId) {
    const row = await prisma.travelAgent.findUnique({ where: { id: travelAgentId }, select: { id: true, displayName: true } });
    if (!row) throw new NotFoundError("Travel agent");
    party = { kind: "TRAVEL_AGENT", id: row.id, name: row.displayName };
  } else if (corporateAccountId) {
    const row = await prisma.corporateAccount.findUnique({ where: { id: corporateAccountId }, select: { id: true, displayName: true } });
    if (!row) throw new NotFoundError("Company");
    party = { kind: "CORPORATE", id: row.id, name: row.displayName };
  }

  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);
  const taxFactor = new Prisma.Decimal(1).add(serviceChargeRate).mul(new Prisma.Decimal(1).add(gstRate));
  const withTax = (rate: Prisma.Decimal | null) => (rate ? rate.mul(taxFactor).toDecimalPlaces(2).toFixed(2) : null);
  const percent = (rate: number) => new Prisma.Decimal(rate).mul(100).toDecimalPlaces(2).toString();

  // Every room type the hotel sells, in the order of its rooms.
  const rooms = await prisma.room.findMany({
    where: { isShadowInventory: false },
    select: { roomNumber: true, roomType: { select: { id: true, code: true, name: true } } },
  });
  const firstRoomOf = new Map<string, { code: string | null; name: string; first: string }>();
  for (const r of rooms) {
    if (!r.roomType) continue;
    const had = firstRoomOf.get(r.roomType.id);
    if (!had || byRoomNumber(r.roomNumber, had.first) < 0) {
      firstRoomOf.set(r.roomType.id, { code: r.roomType.code ?? null, name: r.roomType.name, first: r.roomNumber });
    }
  }
  const types = [...firstRoomOf.entries()].sort((a, b) => byRoomNumber(a[1].first, b[1].first));

  let currency = "BTN";
  let chosen: RatePackageBreakdown | null = null;
  const sheetRooms: RateSheet["rooms"] = [];
  for (const [roomTypeId, t] of types) {
    let pkg: RatePackageBreakdown | null = null;
    if (party) {
      pkg = await resolveRatePackageForBooking(prisma, {
        ratePackageId: input.ratePackageId ?? null,
        travelAgentId,
        corporateAccountId,
        roomTypeId,
      });
    }
    if (pkg) {
      chosen = chosen ?? pkg;
      currency = pkg.currency || currency;
    }
    let rate: Prisma.Decimal | null = pkg ? dec(pkg.roomRate) : null;
    if (!pkg) {
      try {
        const published = await resolveRatePlanPricingForS2Quotation(prisma, { roomTypeId, stay: input.stay });
        rate = dec(published.effectiveRate);
        if (published.currency) currency = published.currency;
      } catch {
        // No plan for this room type: the sheet says none is set, as the rate reference does.
      }
    }
    sheetRooms.push({ roomTypeId, code: t.code, name: t.name, rate: rate ? rate.toFixed(2) : null, withTax: withTax(rate) });
  }

  // The add-ons are one list for the whole booking: the package's, else the hotel's own tariff. One
  // WITH a package never falls to the tariff, the same rule the quotation follows.
  const tariff = chosen ? null : await resolveActiveHouseTariff(prisma);
  const extraBed = dec(chosen ? chosen.addOns.extraBed : tariff?.extraBedRate);
  const meal: Record<MealKey, Prisma.Decimal | null> = {
    breakfast: dec(chosen ? chosen.addOns.breakfast : tariff?.breakfastRate),
    lunch: dec(chosen ? chosen.addOns.lunch : tariff?.lunchRate),
    dinner: dec(chosen ? chosen.addOns.dinner : tariff?.dinnerRate),
  };
  const ownPlan: Record<PlanKey, Prisma.Decimal | null> = {
    cp: dec(chosen ? chosen.mealPlanRates.cp : tariff?.cpRate),
    mapLunch: dec(chosen ? chosen.mealPlanRates.mapLunch : tariff?.mapLunchRate),
    mapDinner: dec(chosen ? chosen.mealPlanRates.mapDinner : tariff?.mapDinnerRate),
    ap: dec(chosen ? chosen.mealPlanRates.ap : tariff?.apRate),
  };
  const against = plansAgainstMeals({
    breakfastRate: meal.breakfast,
    lunchRate: meal.lunch,
    dinnerRate: meal.dinner,
    cpRate: ownPlan.cp,
    mapLunchRate: ownPlan.mapLunch,
    mapDinnerRate: ownPlan.mapDinner,
    apRate: ownPlan.ap,
  });

  const plans = (Object.keys(MEALS_OF_PLAN) as PlanKey[]).map((key) => {
    const own = ownPlan[key];
    const parts = MEALS_OF_PLAN[key].map((m) => meal[m]).filter((v): v is Prisma.Decimal => v != null);
    const fromMeals = own == null && parts.length > 0;
    const rate = own ?? (fromMeals ? parts.reduce((sum, v) => sum.add(v), new Prisma.Decimal(0)) : null);
    const check = against.find((a) => a.key === PLAN_RATE_KEY[key]);
    return {
      key,
      rate: rate ? rate.toFixed(2) : null,
      withTax: withTax(rate),
      fromMeals,
      mealsAddUpTo: check?.differs ? check.meals : null,
    };
  });

  const source: RateSheetSource = !party
    ? "PUBLISHED"
    : !chosen
      ? "NO_PACKAGE"
      : chosen.scope === RatePackageScope.COMMON
        ? "COMMON"
        : "PACKAGE";

  return {
    source,
    party,
    packageName: chosen?.packageName ?? null,
    currency,
    serviceChargePercent: percent(serviceChargeRate),
    gstPercent: percent(gstRate),
    rooms: sheetRooms,
    extraBed: { rate: extraBed ? extraBed.toFixed(2) : null, withTax: withTax(extraBed) },
    meals: (["breakfast", "lunch", "dinner"] as const).map((key) => ({
      key,
      rate: meal[key] ? meal[key]!.toFixed(2) : null,
      withTax: withTax(meal[key]),
    })),
    plans,
  };
}
