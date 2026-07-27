import type { PrismaClient } from "@prisma/client";
import { type EligibleRatePlan, type RatePlanType } from "../engines/pricing-pipeline-engine.js";
import { mulMoney, round2, toDecimal } from "./money.js";

const ALLOWED_TYPES: RatePlanType[] = ["INDIVIDUAL", "PROMOTIONAL", "TIER", "CHANNEL", "RACK"];

/**
 * ACIG §6.1058 — the PricingPipelineEngine reads `rate_plan_registry`. This loader is the single
 * authoritative source of rate plans for both the S1 indicative chip and S2 quotation pricing.
 *
 * When the stay window overlaps an active `SeasonCalendar` row with a `rateMultiplier`, the
 * highest-priority overlapping season's multiplier is applied to every plan's nightly rate. This
 * is a transparent pre-engine adjustment: the engine still resolves type-priority / discount /
 * override / MSR against the already-scaled rates.
 *
 * When `roomTypeId` is supplied, only universal plans (`roomTypeId IS NULL`) and plans bound to
 * that specific room type are returned — per SIG-S2 §366. When it's omitted, every active plan
 * is returned (used by S1 indicative chip, which doesn't yet know the chosen room type).
 */
export async function loadEligibleRatePlans(
  prisma: PrismaClient,
  stay?: { checkIn: Date; checkOut: Date },
  roomTypeId?: string,
): Promise<EligibleRatePlan[]> {
  const rows = await prisma.ratePlanRegistry.findMany({
    where: {
      isActive: true,
      ...(roomTypeId ? { OR: [{ roomTypeId: null }, { roomTypeId }] } : {}),
    },
  });
  if (rows.length === 0) return [];

  let seasonMultiplier = 1;
  if (stay) {
    const overlapping = await prisma.seasonCalendar.findFirst({
      where: {
        isActive: true,
        startDate: { lte: stay.checkOut },
        endDate: { gte: stay.checkIn },
        rateMultiplier: { not: null },
      },
      orderBy: { priority: "desc" },
    });
    if (overlapping?.rateMultiplier) {
      const m = Number(overlapping.rateMultiplier);
      if (Number.isFinite(m) && m > 0) seasonMultiplier = m;
    }
  }

  return rows.map((r) => {
    const type = (ALLOWED_TYPES as string[]).includes(r.type) ? (r.type as RatePlanType) : "INDIVIDUAL";
    // Decimal-safe: base × multiplier in Decimal, then coerced to number at the boundary. The
    // downstream pricing engine also uses Decimal internally, so this stays lossless the whole way.
    const rateAmountDec = round2(mulMoney(toDecimal(r.baseRate), seasonMultiplier));
    return {
      id: r.id,
      type,
      rateAmount: Number(rateAmountDec.toFixed(2)),
      currency: r.currency,
      msr: r.msr == null ? undefined : Number(r.msr),
    };
  });
}
