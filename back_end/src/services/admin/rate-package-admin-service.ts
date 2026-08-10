/**
 * RatePackageService — admin CRUD for negotiated rate packages.
 *
 * Replaces RateCardService. Rates used to hang off the party one-to-one, so a second negotiated
 * rate meant a second travel-agent row; packages let one agency carry "Off season", "Season" and
 * "Premium" side by side.
 *
 * Append-only versioned, same contract the rate cards had: editing closes the current row with
 * `effectiveTo` and inserts a new one, so a quotation issued last month can still be re-derived
 * from the package that was active then. Room-type overrides are carried forward automatically —
 * an admin adjusting a room rate should not silently lose the per-type exceptions.
 */
import { Prisma, RatePackageScope, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";

type DecimalInput = number | string;

export type RatePackageInput = {
  name: string;
  roomBaseRate: DecimalInput;
  extraBedRate?: DecimalInput | null;
  cnbPercent?: number | null;
  breakfastRate?: DecimalInput | null;
  lunchRate?: DecimalInput | null;
  dinnerRate?: DecimalInput | null;
  cpRate?: DecimalInput | null;
  mapLunchRate?: DecimalInput | null;
  mapDinnerRate?: DecimalInput | null;
  apRate?: DecimalInput | null;
  currency?: string;
  rateIsTaxInclusive?: boolean;
  isDefault?: boolean;
  notes?: string | null;
};

/** Exactly one of these, or neither for the house COMMON package. */
export type PackageOwner = { travelAgentId?: string | null; corporateAccountId?: string | null };

const RATE_FIELDS = [
  "roomBaseRate", "extraBedRate", "breakfastRate", "lunchRate", "dinnerRate",
  "cpRate", "mapLunchRate", "mapDinnerRate", "apRate",
] as const;

function dec(v: DecimalInput | null | undefined): Prisma.Decimal | null {
  if (v == null || v === "") return null;
  const d = new Prisma.Decimal(v);
  if (d.isNegative()) throw new ValidationError("Rates cannot be negative");
  return d;
}

/** Derive the scope from which owner is set, and reject an ambiguous pair up front. */
export function scopeOf(owner: PackageOwner): RatePackageScope {
  const ta = !!owner.travelAgentId;
  const ca = !!owner.corporateAccountId;
  if (ta && ca) throw new ValidationError("A package belongs to a travel agent OR a corporate account, not both");
  if (ta) return RatePackageScope.TRAVEL_AGENT;
  if (ca) return RatePackageScope.CORPORATE;
  return RatePackageScope.COMMON;
}

function ownerWhere(owner: PackageOwner) {
  const scope = scopeOf(owner);
  if (scope === RatePackageScope.TRAVEL_AGENT) return { travelAgentId: owner.travelAgentId! };
  if (scope === RatePackageScope.CORPORATE) return { corporateAccountId: owner.corporateAccountId! };
  return { scope: RatePackageScope.COMMON };
}

/** Currently-active packages for a party (or the house COMMON one), default first. */
export async function listPackages(prisma: PrismaClient, owner: PackageOwner) {
  const now = new Date();
  return prisma.ratePackage.findMany({
    where: {
      ...ownerWhere(owner),
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { overrides: { include: { roomType: { select: { code: true, name: true } } } } },
  });
}

/** Every version ever, newest first — the audit view. */
export async function listPackageHistory(prisma: PrismaClient, owner: PackageOwner) {
  return prisma.ratePackage.findMany({
    where: ownerWhere(owner),
    orderBy: [{ name: "asc" }, { effectiveFrom: "desc" }],
    include: { overrides: true },
  });
}

/**
 * Create a package, or a new VERSION of an existing one when the name already exists for this
 * owner. Superseding closes the prior row rather than editing it, so historical quotes stay
 * re-derivable, and carries its room-type overrides forward.
 */
export async function savePackage(
  prisma: PrismaClient,
  owner: PackageOwner,
  input: RatePackageInput,
  actorId: string,
) {
  const name = input.name?.trim();
  if (!name) throw new ValidationError("Package name is required");
  const scope = scopeOf(owner);

  if (scope === RatePackageScope.TRAVEL_AGENT) {
    const exists = await prisma.travelAgent.findUnique({ where: { id: owner.travelAgentId! }, select: { id: true } });
    if (!exists) throw new NotFoundError("TravelAgent");
  } else if (scope === RatePackageScope.CORPORATE) {
    const exists = await prisma.corporateAccount.findUnique({ where: { id: owner.corporateAccountId! }, select: { id: true } });
    if (!exists) throw new NotFoundError("CorporateAccount");
  }

  const rates = Object.fromEntries(RATE_FIELDS.map((f) => [f, dec(input[f])])) as Record<
    (typeof RATE_FIELDS)[number],
    Prisma.Decimal | null
  >;
  if (rates.roomBaseRate == null) throw new ValidationError("roomBaseRate is required");

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const prior = await tx.ratePackage.findFirst({
      where: { ...ownerWhere(owner), name, effectiveTo: null },
      include: { overrides: true },
      orderBy: { effectiveFrom: "desc" },
    });
    if (prior) await tx.ratePackage.update({ where: { id: prior.id }, data: { effectiveTo: now } });

    const created = await tx.ratePackage.create({
      data: {
        scope,
        travelAgentId: scope === RatePackageScope.TRAVEL_AGENT ? owner.travelAgentId! : null,
        corporateAccountId: scope === RatePackageScope.CORPORATE ? owner.corporateAccountId! : null,
        name,
        isDefault: input.isDefault ?? prior?.isDefault ?? false,
        roomBaseRate: rates.roomBaseRate!,
        extraBedRate: rates.extraBedRate,
        cnbPercent: input.cnbPercent ?? prior?.cnbPercent ?? null,
        breakfastRate: rates.breakfastRate,
        lunchRate: rates.lunchRate,
        dinnerRate: rates.dinnerRate,
        cpRate: rates.cpRate,
        mapLunchRate: rates.mapLunchRate,
        mapDinnerRate: rates.mapDinnerRate,
        apRate: rates.apRate,
        currency: input.currency?.trim() || prior?.currency || "BTN",
        rateIsTaxInclusive: input.rateIsTaxInclusive ?? prior?.rateIsTaxInclusive ?? false,
        effectiveFrom: now,
        notes: input.notes?.trim() || null,
        createdBy: actorId,
      },
    });

    // Carry the prior version's per-room-type overrides forward — an admin editing the base rate
    // should not silently lose them.
    for (const o of prior?.overrides ?? []) {
      await tx.roomTypePackageOverride.create({
        data: { ratePackageId: created.id, roomTypeId: o.roomTypeId, roomBaseRate: o.roomBaseRate, notes: o.notes, createdBy: actorId },
      });
    }

    // Only one default per owner.
    if (created.isDefault) {
      await tx.ratePackage.updateMany({
        where: { ...ownerWhere(owner), id: { not: created.id }, effectiveTo: null },
        data: { isDefault: false },
      });
    }

    const changed = RATE_FIELDS.filter((f) => String(prior?.[f] ?? "") !== String(rates[f] ?? ""));
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: prior ? "ADMIN.RATE_PACKAGE_VERSION_CREATED" : "ADMIN.RATE_PACKAGE_CREATED",
      entityType: "RatePackage",
      entityId: created.id,
      operation: "CREATE",
      payload: {
        scope, name,
        travelAgentId: created.travelAgentId,
        corporateAccountId: created.corporateAccountId,
        priorPackageId: prior?.id ?? null,
        changedFields: changed,
        overridesCarriedForward: prior?.overrides.length ?? 0,
      },
    });

    return tx.ratePackage.findUniqueOrThrow({ where: { id: created.id }, include: { overrides: true } });
  });
}

/** Make one package the party's default; clears the flag on its siblings. */
export async function setDefaultPackage(prisma: PrismaClient, packageId: string, actorId: string) {
  const pkg = await prisma.ratePackage.findUnique({ where: { id: packageId } });
  if (!pkg) throw new NotFoundError("RatePackage");
  return prisma.$transaction(async (tx) => {
    const owner: PackageOwner = { travelAgentId: pkg.travelAgentId, corporateAccountId: pkg.corporateAccountId };
    await tx.ratePackage.updateMany({ where: { ...ownerWhere(owner), effectiveTo: null }, data: { isDefault: false } });
    const updated = await tx.ratePackage.update({ where: { id: packageId }, data: { isDefault: true } });
    await writeAdminAuditEvent(tx, {
      actorId, eventType: "ADMIN.RATE_PACKAGE_DEFAULT_SET", entityType: "RatePackage", entityId: packageId,
      operation: "UPDATE", payload: { name: pkg.name, scope: pkg.scope },
    });
    return updated;
  });
}

/**
 * Retire a package by closing it, never deleting. Quotations reference it and an inquiry may
 * still point at it; a deleted row would orphan both.
 */
export async function retirePackage(prisma: PrismaClient, packageId: string, actorId: string) {
  const pkg = await prisma.ratePackage.findUnique({ where: { id: packageId } });
  if (!pkg) throw new NotFoundError("RatePackage");
  if (pkg.effectiveTo) throw new ValidationError("Package is already retired");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.ratePackage.update({ where: { id: packageId }, data: { effectiveTo: new Date(), isDefault: false } });
    await writeAdminAuditEvent(tx, {
      actorId, eventType: "ADMIN.RATE_PACKAGE_RETIRED", entityType: "RatePackage", entityId: packageId,
      operation: "UPDATE", payload: { name: pkg.name, scope: pkg.scope },
    });
    return updated;
  });
}

/** Set (or replace) a per-room-type room rate on a package. */
export async function setRoomTypeOverride(
  prisma: PrismaClient,
  packageId: string,
  input: { roomTypeId: string; roomBaseRate: DecimalInput; notes?: string | null },
  actorId: string,
) {
  const pkg = await prisma.ratePackage.findUnique({ where: { id: packageId } });
  if (!pkg) throw new NotFoundError("RatePackage");
  const rate = dec(input.roomBaseRate);
  if (rate == null) throw new ValidationError("roomBaseRate is required");
  return prisma.roomTypePackageOverride.upsert({
    where: { ratePackageId_roomTypeId: { ratePackageId: packageId, roomTypeId: input.roomTypeId } },
    create: { ratePackageId: packageId, roomTypeId: input.roomTypeId, roomBaseRate: rate, notes: input.notes?.trim() || null, createdBy: actorId },
    update: { roomBaseRate: rate, notes: input.notes?.trim() || null },
  });
}

export async function deleteRoomTypeOverride(prisma: PrismaClient, overrideId: string) {
  const row = await prisma.roomTypePackageOverride.findUnique({ where: { id: overrideId } });
  if (!row) throw new NotFoundError("RoomTypePackageOverride");
  return prisma.roomTypePackageOverride.delete({ where: { id: overrideId } });
}
