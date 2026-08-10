/**
 * Resolve the negotiated rate for a booking from `RatePackage`.
 *
 * Replaces the RateCard path. Rates used to hang off the party one-to-one, so every negotiated
 * variant needed its own travel-agent row; packages let one agency carry "Off season", "Season"
 * and "Premium" side by side, and the operator says which applies.
 *
 * RESOLUTION ORDER
 *   1. The package chosen on the inquiry (`Inquiry.ratePackageId`) — the operator's explicit answer.
 *   2. The party's own default package, then any active package of theirs. Covers bookings taken
 *      before package selection existed, and parties with exactly one package.
 *   3. The COMMON package — the house fallback, so an agency that has just signed up can be
 *      quoted the day they call instead of falling to zero.
 *
 * A booking with NO party at all returns null and is priced from the hotel's rate plans plus the
 * HouseTariff add-ons. The COMMON package is a fallback for agents and companies, not a
 * replacement for walk-in pricing.
 */
import { type PrismaClient, RatePackageScope } from "@prisma/client";

/**
 * The shape S2 pricing consumes. Kept from the retired `agent-rate-resolution` so the
 * composition pricing path was untouched by the RateCard → RatePackage move; `rateCardId` now
 * carries the PACKAGE id, and `commercialTerms.agentRate` additionally records `ratePackageId`,
 * `packageName` and `resolvedVia`.
 */
export type AgentRateBreakdown = {
  rateCardId: string;
  partyType: "TRAVEL_AGENT" | "CORPORATE";
  partyId: string;
  roomTypeId: string;
  roomRate: number;
  roomRateSource: "ROOM_TYPE_OVERRIDE" | "BASE_RATE";
  mealPlan: string | null;
  mealPlanRate: number | null;
  mealPlanRates: { cp: number | null; mapLunch: number | null; mapDinner: number | null; ap: number | null };
  perNightTotal: number;
  addOns: { extraBed: number | null; breakfast: number | null; lunch: number | null; dinner: number | null };
  cnbPercent: number | null;
  currency: string;
};

export type RatePackageBreakdown = {
  ratePackageId: string;
  packageName: string;
  scope: RatePackageScope;
  travelAgentId: string | null;
  corporateAccountId: string | null;
  roomTypeId: string;
  /** Per-night room rate after per-room-type override resolution. */
  roomRate: number;
  roomRateSource: "ROOM_TYPE_OVERRIDE" | "BASE_RATE";
  /** How we arrived at this package — surfaced in commercialTerms so pricing stays explainable. */
  resolvedVia: "INQUIRY_SELECTION" | "PARTY_DEFAULT" | "COMMON_FALLBACK";
  addOns: {
    extraBed: number | null;
    breakfast: number | null;
    lunch: number | null;
    dinner: number | null;
  };
  /** All four meal-plan rates. `null` for a plan means it falls back to summing its meals. */
  mealPlanRates: {
    cp: number | null;
    mapLunch: number | null;
    mapDinner: number | null;
    ap: number | null;
  };
  cnbPercent: number | null;
  currency: string;
  rateIsTaxInclusive: boolean;
};

function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : null;
}

/** Active at `asOf`: started, and either never closed or closed later. */
function activeWindow(asOf: Date) {
  return { effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }] };
}

export async function resolveRatePackageForBooking(
  prisma: PrismaClient,
  input: {
    /** The operator's explicit choice, when the booking has one. */
    ratePackageId?: string | null;
    travelAgentId?: string | null;
    corporateAccountId?: string | null;
    roomTypeId: string;
    asOf?: Date;
  },
): Promise<RatePackageBreakdown | null> {
  const asOf = input.asOf ?? new Date();
  const hasParty = !!(input.travelAgentId || input.corporateAccountId);
  const include = { overrides: { where: { roomTypeId: input.roomTypeId } } } as const;

  let pkg = null as Awaited<ReturnType<typeof prisma.ratePackage.findFirst>> | null;
  let resolvedVia: RatePackageBreakdown["resolvedVia"] = "INQUIRY_SELECTION";

  // 1. Explicit selection. Not date-filtered: a booking quoted on a package that has since been
  // superseded must still resolve to the package it was actually quoted on.
  if (input.ratePackageId) {
    pkg = await prisma.ratePackage.findUnique({ where: { id: input.ratePackageId }, include });
  }

  // 2. The party's own package — default first, then any active one.
  if (!pkg && hasParty) {
    const partyWhere = input.travelAgentId
      ? { travelAgentId: input.travelAgentId }
      : { corporateAccountId: input.corporateAccountId! };
    pkg = await prisma.ratePackage.findFirst({
      where: { ...partyWhere, ...activeWindow(asOf) },
      orderBy: [{ isDefault: "desc" }, { effectiveFrom: "desc" }],
      include,
    });
    if (pkg) resolvedVia = "PARTY_DEFAULT";
  }

  // 3. House fallback — only for a booking that HAS a party. A booking with no party is a
  // walk-in and is priced from rate plans + HouseTariff, not from an agent package.
  if (!pkg && hasParty) {
    // `isDefault` first, THEN newest. Ordering by date alone meant that adding a second common
    // package silently changed which rate every package-less party was quoted on, with no way
    // to say which should win — same rule as party packages, so the choice is always explicit.
    pkg = await prisma.ratePackage.findFirst({
      where: { scope: RatePackageScope.COMMON, ...activeWindow(asOf) },
      orderBy: [{ isDefault: "desc" }, { effectiveFrom: "desc" }],
      include,
    });
    if (pkg) resolvedVia = "COMMON_FALLBACK";
  }

  if (!pkg) return null;

  const withOverrides = pkg as typeof pkg & { overrides: Array<{ roomBaseRate: unknown }> };
  const override = withOverrides.overrides?.[0] ?? null;

  return {
    ratePackageId: pkg.id,
    packageName: pkg.name,
    scope: pkg.scope,
    travelAgentId: pkg.travelAgentId,
    corporateAccountId: pkg.corporateAccountId,
    roomTypeId: input.roomTypeId,
    roomRate: override ? num(override.roomBaseRate) : num(pkg.roomBaseRate),
    roomRateSource: override ? "ROOM_TYPE_OVERRIDE" : "BASE_RATE",
    resolvedVia,
    addOns: {
      extraBed: numOrNull(pkg.extraBedRate),
      breakfast: numOrNull(pkg.breakfastRate),
      lunch: numOrNull(pkg.lunchRate),
      dinner: numOrNull(pkg.dinnerRate),
    },
    mealPlanRates: {
      cp: numOrNull(pkg.cpRate),
      mapLunch: numOrNull(pkg.mapLunchRate),
      mapDinner: numOrNull(pkg.mapDinnerRate),
      ap: numOrNull(pkg.apRate),
    },
    cnbPercent: pkg.cnbPercent,
    currency: pkg.currency,
    rateIsTaxInclusive: pkg.rateIsTaxInclusive,
  };
}

/** Packages a party can be quoted on, for the S1 picker. Active only, default first. */
export async function listPackagesForParty(
  prisma: PrismaClient,
  input: { travelAgentId?: string | null; corporateAccountId?: string | null; asOf?: Date },
) {
  const asOf = input.asOf ?? new Date();
  if (!input.travelAgentId && !input.corporateAccountId) return [];
  const partyWhere = input.travelAgentId
    ? { travelAgentId: input.travelAgentId }
    : { corporateAccountId: input.corporateAccountId! };
  return prisma.ratePackage.findMany({
    where: { ...partyWhere, ...activeWindow(asOf) },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: {
      id: true, name: true, isDefault: true, roomBaseRate: true, extraBedRate: true,
      breakfastRate: true, lunchRate: true, dinnerRate: true,
      cpRate: true, mapLunchRate: true, mapDinnerRate: true, apRate: true, currency: true,
    },
  });
}
