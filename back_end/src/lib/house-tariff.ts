import type { HouseTariff, Prisma, PrismaClient } from "@prisma/client";

/**
 * HouseTariff resolution — the hotel's own add-on price list.
 *
 * Used for every booking that has NO negotiated rate card (walk-in, direct, OTA). Agent and
 * corporate bookings deliberately do NOT fall back here: a blank field on a negotiated card
 * means "we agreed nothing", and the operator's decision (2026-07-30) is that it stays free
 * rather than silently acquiring the rack add-on price.
 *
 * The room rate is NOT part of this — see the model comment in schema.prisma. Room rates live
 * on `rate_plan_registry`, which owns per-room-type pricing plus the MSR floor, the season
 * multiplier and the discount pipeline.
 */

/** Short TTL so the pricing path doesn't hit the DB once per room on a multi-room quote. */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; row: HouseTariff | null } | null = null;

/** Drop the cache. Call after any admin write so edits take effect immediately. */
export function invalidateHouseTariffCache() {
  cache = null;
}

/**
 * The tariff version active at `asOf` (default: now). Returns null when no tariff has ever
 * been configured — callers then resolve add-ons to 0, which is the pre-2026-07-30 behaviour.
 *
 * Only the "now" lookup is cached; historical lookups always query, since re-deriving an old
 * quotation must never be served a stale or wrong-era row.
 */
export async function resolveActiveHouseTariff(
  db: PrismaClient | Prisma.TransactionClient,
  asOf?: Date,
): Promise<HouseTariff | null> {
  const now = Date.now();
  const isNowLookup = asOf == null;
  if (isNowLookup && cache && now - cache.at < CACHE_TTL_MS) return cache.row;

  const at = asOf ?? new Date();
  const row = await db.houseTariff.findFirst({
    where: {
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });

  if (isNowLookup) cache = { at: now, row };
  return row;
}
