import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { resolveRatePackageForBooking, type RatePackageBreakdown } from "../../lib/rate-package-resolution.js";
import { resolveRatePlanPricingForS2Quotation } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { resolveActiveHouseTariff } from "../../lib/house-tariff.js";
import { plansAgainstMeals, type PlanRateKey } from "../../lib/room-composition.js";

/**
 * Rate reference for the S2 composition editors (2026-08-01).
 *
 * The operator typing a per-room negotiated rate needs to see what the booking would be
 * charged WITHOUT one — this returns exactly the defaults `prepareQuotationDraft` feeds the
 * composition pricing: the agent/corporate rate card (room rate incl. per-room-type override
 * + extra-bed/meal add-ons) when the inquiry is linked to a party, else the standard rate
 * plan resolution for the sealed room type. Pure read — nothing persisted, no new business
 * outcome; every figure comes from the same records the pricing pipeline reads, so what the
 * desk shows as "reference" is what the draft will actually use.
 *
 * Grouped per room TYPE (rates don't vary per room within a type), listing the sealed room
 * numbers under each so the strip lines up with the composition table's rows.
 */

export type RoomTypeRateReference = {
  roomTypeId: string;
  code: string | null;
  name: string;
  /** Sealed rooms of this type, by room number. */
  roomNumbers: string[];
  /** The per-night room rate the pricing will use when no negotiated rate is entered. */
  roomRate: number | null;
  roomRateSource: "AGENT_RATE_PACKAGE" | "STANDARD_RATE_PLAN" | null;
  /** Which named package supplied the rate — "Season", "Premium". Null when standard. */
  packageName: string | null;
  /** That package's id (2026-11-13). Null when standard. */
  ratePackageId?: string | null;
  /** True when the stay gave this type a package of its own; false when it takes the primary one. */
  packageChosenForType?: boolean;
  /** Standard rate-plan resolution, kept as reference even when a card applies. */
  standardRate: number | null;
  /** Minimum sellable rate from the standard plan — the discount floor. Null for card rates (negotiated, not MSR-bound). */
  msrValue: number | null;
  /** Add-on per-unit rates from the rate card. Null when the party has no card (no house price list yet — Track B). */
  extraBedRate: number | null;
  breakfastRate: number | null;
  /** Meal-PLAN rates. Null means the plan is not separately priced and falls back to the sum
   *  of its constituent meals. */
  cpRate?: number | null;
  mapLunchRate?: number | null;
  mapDinnerRate?: number | null;
  apRate?: number | null;
  /** Where the add-ons came from — the party's package, or the hotel's own tariff. */
  addOnSource?: "RATE_PACKAGE" | "HOUSE_TARIFF" | null;
  lunchRate: number | null;
  dinnerRate: number | null;
};

export type EntryRateReference = {
  entryId: string;
  currency: string;
  nights: number | null;
  /** Statutory/config rates applied on top of the subtotal (e.g. 0.05 = 5%). */
  gstRate: number;
  serviceChargeRate: number;
  /** The linked agent/corporate whose rate card supplies the rates, when any. */
  party: { type: "TRAVEL_AGENT" | "CORPORATE"; id: string; name: string } | null;
  roomTypes: RoomTypeRateReference[];
  /**
   * Meal plans charged at a figure of their own, not what their meals add up to (2026-11-04). With
   * room types on different packages (2026-11-13), each names its package.
   */
  plansOff: Array<{ key: PlanRateKey; rate: string | null; meals: string | null; packageName?: string | null }>;
  /** The packages chosen on the enquiry, the primary first (2026-11-13). Empty for a walk-in. */
  packages: Array<{ id: string; name: string }>;
  /** Whether the stay's package per room type may still be changed (Inquiry and Negotiation). */
  packagesEditable: boolean;
};

export async function buildEntryRateReference(
  prisma: PrismaClient,
  entryId: string,
  opts?: {
    /**
     * Rooms the booking does NOT hold yet whose types must be priced too (2026-10-12, a room
     * move's preview): a booking moving to a Suite needs the Suite's rate, which the sealed rooms
     * alone would never resolve. Added to the sealed rooms, never instead of them.
     */
    planRoomIds?: string[];
    /**
     * The stay to price for, when it is not the booking's own (2026-10-13, a date move's preview):
     * a season on the new nights changes the published rate.
     */
    stay?: { checkIn: Date; checkOut: Date };
  },
): Promise<EntryRateReference> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
      inquiry: {
        select: {
          // The chosen package rides along so the reference strip anchors on the package the
          // booking is actually quoted on, not just the party's default.
          ratePackageId: true,
          ratePackageIds: true,
          travelAgent: { select: { id: true, displayName: true } },
          corporateAccount: { select: { id: true, displayName: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const party = entry.inquiry?.travelAgent
    ? ({ type: "TRAVEL_AGENT", id: entry.inquiry.travelAgent.id, name: entry.inquiry.travelAgent.displayName } as const)
    : entry.inquiry?.corporateAccount
      ? ({ type: "CORPORATE", id: entry.inquiry.corporateAccount.id, name: entry.inquiry.corporateAccount.displayName } as const)
      : null;

  const stay =
    opts?.stay ??
    (entry.checkInDate && entry.checkOutDate
      ? { checkIn: entry.checkInDate, checkOut: entry.checkOutDate }
      : undefined);
  const nights = stay
    ? Math.max(1, Math.round((stay.checkOut.getTime() - stay.checkIn.getTime()) / 86_400_000))
    : null;

  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);

  const sealedCfg = entry.availabilityConfigs.find((c) => c.sealedAt != null && c.optionSelected != null) ?? null;
  const sealed = sealedCfg ? readOptionSelected(sealedCfg.optionSelected) : null;
  const roomIds = Array.from(new Set([...(sealed?.distinctRoomIds ?? []), ...(opts?.planRoomIds ?? [])]));

  const rooms = roomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: roomIds } },
        select: {
          id: true,
          roomNumber: true,
          roomType: { select: { id: true, code: true, name: true } },
        },
      })
    : [];

  // Group sealed rooms by type — the rate resolution is per room type, not per room.
  const byType = new Map<string, { code: string | null; name: string; roomNumbers: string[] }>();
  for (const r of rooms) {
    if (!r.roomType) continue;
    const g = byType.get(r.roomType.id) ?? { code: r.roomType.code ?? null, name: r.roomType.name, roomNumbers: [] };
    g.roomNumbers.push(r.roomNumber);
    byType.set(r.roomType.id, g);
  }

  // Loaded once for the whole reference: it is a hotel-wide list, not per room type.
  const houseTariff = party ? null : await resolveActiveHouseTariff(prisma);
  const num = (v: unknown): number | null => (v == null ? null : Number(v));

  let currency = "BTN";
  const roomTypes: RoomTypeRateReference[] = [];
  for (const [roomTypeId, g] of byType) {
    // Standard plan resolution — same call the S2 draft makes. A hotel with no eligible rate
    // plans throws MissingConfigurationError; here that's a display gap, not a hard failure.
    let standardRate: number | null = null;
    let msrValue: number | null = null;
    let standardCurrency: string | null = null;
    try {
      const pricing = await resolveRatePlanPricingForS2Quotation(prisma, { roomTypeId, stay });
      standardRate = pricing.effectiveRate ?? null;
      msrValue = pricing.msrValue ?? null;
      standardCurrency = pricing.currency ?? null;
    } catch {
      /* no eligible rate plan — leave standard side null */
    }

    let agentRate: RatePackageBreakdown | null = null;
    if (party) {
      agentRate = await resolveRatePackageForBooking(prisma, {
        ratePackageId: entry.inquiry?.ratePackageId ?? null,
        ratePackageIds: entry.inquiry?.ratePackageIds ?? [],
        ratePackageByRoomType: entry.ratePackageByRoomType,
        travelAgentId: party.type === "TRAVEL_AGENT" ? party.id : null,
        corporateAccountId: party.type === "CORPORATE" ? party.id : null,
        roomTypeId,
      });
    }

    if (agentRate?.currency) currency = agentRate.currency;
    else if (standardCurrency) currency = standardCurrency;

    roomTypes.push({
      roomTypeId,
      code: g.code,
      name: g.name,
      roomNumbers: g.roomNumbers.sort(),
      roomRate: agentRate ? agentRate.roomRate : standardRate,
      roomRateSource: agentRate ? "AGENT_RATE_PACKAGE" : standardRate != null ? "STANDARD_RATE_PLAN" : null,
      packageName: agentRate?.packageName ?? null,
      ratePackageId: agentRate?.ratePackageId ?? null,
      packageChosenForType: agentRate?.resolvedVia === "ROOM_TYPE_SELECTION",
      standardRate,
      // Agent rates are negotiated and not MSR-bound (same rule as the quotation pipeline).
      msrValue: agentRate ? null : msrValue,
      // A booking with no package resolves add-ons from the hotel's own tariff; one WITH a
      // package does not, because a blank field on a negotiated package means "we agreed
      // nothing" and must stay free rather than acquire the rack price.
      extraBedRate: agentRate?.addOns.extraBed ?? num(houseTariff?.extraBedRate) ?? null,
      breakfastRate: agentRate?.addOns.breakfast ?? num(houseTariff?.breakfastRate) ?? null,
      lunchRate: agentRate?.addOns.lunch ?? num(houseTariff?.lunchRate) ?? null,
      dinnerRate: agentRate?.addOns.dinner ?? num(houseTariff?.dinnerRate) ?? null,
      cpRate: agentRate?.mealPlanRates?.cp ?? num(houseTariff?.cpRate) ?? null,
      mapLunchRate: agentRate?.mealPlanRates?.mapLunch ?? num(houseTariff?.mapLunchRate) ?? null,
      mapDinnerRate: agentRate?.mealPlanRates?.mapDinner ?? num(houseTariff?.mapDinnerRate) ?? null,
      apRate: agentRate?.mealPlanRates?.ap ?? num(houseTariff?.apRate) ?? null,
      addOnSource: agentRate ? "RATE_PACKAGE" : houseTariff ? "HOUSE_TARIFF" : null,
    });
  }

  // The meal rates are each package's: once per package the room types are on (2026-11-13).
  const byPackage = new Map<string, RoomTypeRateReference>();
  for (const t of roomTypes) if (!byPackage.has(t.ratePackageId ?? "")) byPackage.set(t.ratePackageId ?? "", t);
  const several = byPackage.size > 1;
  const plansOff = [...byPackage.values()].flatMap((first) =>
    plansAgainstMeals({
      breakfastRate: first.breakfastRate,
      lunchRate: first.lunchRate,
      dinnerRate: first.dinnerRate,
      cpRate: first.cpRate,
      mapLunchRate: first.mapLunchRate,
      mapDinnerRate: first.mapDinnerRate,
      apRate: first.apRate,
    })
      .filter((p) => p.differs)
      .map(({ key, rate, meals }) => ({ key, rate, meals, ...(several ? { packageName: first.packageName } : {}) })),
  );

  // The packages chosen on the enquiry, by name, in the order chosen.
  const chosenIds = entry.inquiry?.ratePackageIds?.length
    ? entry.inquiry.ratePackageIds
    : entry.inquiry?.ratePackageId
      ? [entry.inquiry.ratePackageId]
      : [];
  const named = chosenIds.length
    ? await prisma.ratePackage.findMany({ where: { id: { in: chosenIds } }, select: { id: true, name: true } })
    : [];
  const packages = chosenIds.map((id) => named.find((p) => p.id === id)).filter((p): p is { id: string; name: string } => !!p);
  const packagesEditable =
    (entry.currentStage === "S1" || entry.currentStage === "S2") && (entry.status === "ACTIVE" || entry.status === "PARKED");
  return { entryId: entry.id, currency, nights, gstRate, serviceChargeRate, party, roomTypes, plansOff, packages, packagesEditable };
}
