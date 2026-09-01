/**
 * HouseTariffService — admin CRUD for the hotel's own add-on price list.
 *
 * The hotel equivalent of an agent RateCard, minus the room rate. Supplies extra-bed,
 * à-la-carte meal and meal-plan rates for every booking that has NO negotiated rate card
 * (walk-in, direct, OTA). Before this existed those add-ons resolved to 0, so a walk-in's
 * extra bed and meals were silently free.
 *
 * Append-only versioned, same contract as RateCard / ConfigurationEntry: saving edits closes
 * the current row (`effectiveTo = now`) and inserts a new one in the same transaction, so a
 * quotation priced last month can always be re-derived from the tariff active then.
 *
 * Room rates are deliberately out of scope — they belong to `rate_plan_registry`, which
 * already supports per-room-type pricing plus the MSR floor, season multiplier and discount
 * pipeline. See the model comment in schema.prisma.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { invalidateHouseTariffCache, resolveActiveHouseTariff } from "../../lib/house-tariff.js";

type DecimalInput = number | string;

/**
 * Every rate is optional with three distinct meanings, all preserved end-to-end:
 *   omitted / null → not configured (meal plans fall back to summing their à-la-carte meals)
 *   0              → deliberately free
 *   > 0            → charged
 */
export type HouseTariffInput = {
  extraBedRate?: DecimalInput | null;
  breakfastRate?: DecimalInput | null;
  lunchRate?: DecimalInput | null;
  dinnerRate?: DecimalInput | null;
  cpRate?: DecimalInput | null;
  mapLunchRate?: DecimalInput | null;
  mapDinnerRate?: DecimalInput | null;
  apRate?: DecimalInput | null;
  currency?: string;
  notes?: string | null;
};

const RATE_FIELDS = [
  "extraBedRate",
  "breakfastRate",
  "lunchRate",
  "dinnerRate",
  "cpRate",
  "mapLunchRate",
  "mapDinnerRate",
  "apRate",
] as const;

function toDecimalOrNull(v: DecimalInput | null | undefined): Prisma.Decimal | null {
  if (v == null || v === "") return null;
  const d = new Prisma.Decimal(v);
  if (d.isNegative()) throw new ValidationError("Rates cannot be negative");
  return d;
}

/** The tariff in force now (or at `asOf`). Null when none has ever been configured. */
export async function getActiveHouseTariff(prisma: PrismaClient, asOf?: Date) {
  return resolveActiveHouseTariff(prisma, asOf);
}

/** Full version history, newest first. */
export async function listHouseTariffVersions(prisma: PrismaClient) {
  return prisma.houseTariff.findMany({ orderBy: { effectiveFrom: "desc" } });
}

/**
 * Create a new tariff version, superseding the current one. Both writes plus the audit event
 * share one transaction (ACIG §3.4), so a partial save can never leave two active tariffs —
 * which would make `resolveActiveHouseTariff` non-deterministic.
 */
export async function saveHouseTariffVersion(
  prisma: PrismaClient,
  input: HouseTariffInput,
  actorId: string,
) {
  const rates = Object.fromEntries(
    RATE_FIELDS.map((f) => [f, toDecimalOrNull(input[f])]),
  ) as Record<(typeof RATE_FIELDS)[number], Prisma.Decimal | null>;

  const result = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const prior = await tx.houseTariff.findFirst({
      where: { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
      orderBy: { effectiveFrom: "desc" },
    });

    if (prior) {
      await tx.houseTariff.update({ where: { id: prior.id }, data: { effectiveTo: now } });
    }

    const created = await tx.houseTariff.create({
      data: {
        ...rates,
        currency: input.currency?.trim() || "BTN",
        notes: input.notes?.trim() || null,
        effectiveFrom: now,
        createdBy: actorId,
      },
    });

    // Record which rates actually moved — a diff is far more useful in an audit trail than
    // a second copy of the full row, which the new version already is.
    const changed = RATE_FIELDS.filter((f) => {
      const before = prior?.[f] ?? null;
      const after = rates[f];
      if (before == null && after == null) return false;
      if (before == null || after == null) return true;
      return !new Prisma.Decimal(before).equals(after);
    }).map((f) => ({
      field: f,
      from: prior?.[f]?.toString() ?? null,
      to: rates[f]?.toString() ?? null,
    }));

    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.HOUSE_TARIFF_VERSION_CREATED",
      entityType: "HouseTariff",
      entityId: created.id,
      operation: "CREATE",
      payload: {
        priorHouseTariffId: prior?.id ?? null,
        currency: created.currency,
        changedFields: changed.map((c) => c.field),
        changes: changed,
      },
    });

    return created;
  });

  // The pricing path caches the active tariff for 30s; drop it so the edit applies at once.
  invalidateHouseTariffCache();
  return result;
}
