/**
 * Agent/Corporate rate resolution.
 *
 * Given (partyType, partyId, roomTypeId, optional mealPlan, optional asOf), returns the
 * applicable rate breakdown. Reads the rate card active at `asOf` (default now); if a
 * room-type-specific override exists, uses that for the room rate; otherwise uses the
 * base rate. Meal plan adds the corresponding plan rate (CP/MAP_LUNCH/MAP_DINNER/AP);
 * standalone meals (breakfast/lunch/dinner) are returned as available add-ons.
 *
 * Returns null if no active rate card exists for the party — caller decides whether to
 * fall back to the hotel's standard rate plan.
 */
import type { PrismaClient } from "@prisma/client";
import { MealPlanType, type PartyType } from "@prisma/client";

export type AgentRateResolutionInput = {
  partyType: PartyType;
  partyId: string;
  roomTypeId: string;
  mealPlan?: MealPlanType | null;
  asOf?: Date;
};

export type AgentRateBreakdown = {
  rateCardId: string;
  partyType: PartyType;
  partyId: string;
  roomTypeId: string;
  /** Per-night room rate after override resolution. */
  roomRate: number;
  /** Source of the room rate. */
  roomRateSource: "ROOM_TYPE_OVERRIDE" | "BASE_RATE";
  /** Meal plan rate (if mealPlan was supplied and the card carries that plan). */
  mealPlan: MealPlanType | null;
  mealPlanRate: number | null;
  /** Per-night total = roomRate + mealPlanRate (excluding standalone add-ons, taxes, service charge). */
  perNightTotal: number;
  /** Standalone add-on rates (NOT included in perNightTotal — caller adds them if used). */
  addOns: {
    extraBed: number | null;
    breakfast: number | null;
    lunch: number | null;
    dinner: number | null;
  };
  cnbPercent: number | null;
  currency: string;
};

function decimalToNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : 0;
}

function decimalToNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : null;
}

function planRateFromCard(card: { cpRate: unknown; mapLunchRate: unknown; mapDinnerRate: unknown; apRate: unknown }, plan: MealPlanType): number | null {
  switch (plan) {
    case MealPlanType.CP: return decimalToNumberOrNull(card.cpRate);
    case MealPlanType.MAP_LUNCH: return decimalToNumberOrNull(card.mapLunchRate);
    case MealPlanType.MAP_DINNER: return decimalToNumberOrNull(card.mapDinnerRate);
    case MealPlanType.AP: return decimalToNumberOrNull(card.apRate);
  }
}

/**
 * Resolve the per-night rate for a party (agent/corporate) staying in a specific room type,
 * optionally with a meal plan, optionally at a historical timestamp.
 */
export async function resolveAgentRate(
  prisma: PrismaClient,
  input: AgentRateResolutionInput,
): Promise<AgentRateBreakdown | null> {
  const asOf = input.asOf ?? new Date();
  const card = await prisma.rateCard.findFirst({
    where: {
      partyType: input.partyType,
      partyId: input.partyId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: "desc" },
    include: {
      overrides: { where: { roomTypeId: input.roomTypeId } },
    },
  });
  if (!card) return null;

  const override = card.overrides[0] ?? null;
  const roomRate = override
    ? decimalToNumber(override.roomBaseRate)
    : decimalToNumber(card.roomBaseRate);
  const roomRateSource: AgentRateBreakdown["roomRateSource"] = override ? "ROOM_TYPE_OVERRIDE" : "BASE_RATE";

  const mealPlanRate = input.mealPlan ? planRateFromCard(card, input.mealPlan) : null;
  const perNightTotal = roomRate + (mealPlanRate ?? 0);

  return {
    rateCardId: card.id,
    partyType: card.partyType,
    partyId: card.partyId,
    roomTypeId: input.roomTypeId,
    roomRate,
    roomRateSource,
    mealPlan: input.mealPlan ?? null,
    mealPlanRate,
    perNightTotal,
    addOns: {
      extraBed: decimalToNumberOrNull(card.extraBedRate),
      breakfast: decimalToNumberOrNull(card.breakfastRate),
      lunch: decimalToNumberOrNull(card.lunchRate),
      dinner: decimalToNumberOrNull(card.dinnerRate),
    },
    cnbPercent: card.cnbPercent,
    currency: card.currency,
  };
}
