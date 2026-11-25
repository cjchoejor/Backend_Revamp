/**
 * Apartments — the hotel's service apartments, let by the week or the month (2026-11-25, operator:
 * "add apartment section under rates and limits … premium suite would be the name of the package
 * and under that admin will choose the rooms that fall under it, and also the max occupant for each
 * room, and some details like amenities and carpet area, and then rates … inclusive of gst and
 * service charge, so keep option to input rates with gst and service charge like we do in packages,
 * the rate will be of two kinds, weekly and monthly").
 *
 * A package ("Premium Suite") holds its apartments ("503", "504"). An apartment is one room, or
 * several rooms always let together — the 2 BHK "505" is rooms 5051 + 5052, one rate, up to five
 * guests (operator's choice, the same day). A room belongs to one apartment at most.
 *
 * ⚠️ Money. A rate is stored WITHOUT service charge and GST, to the chhertum, as every rate in the
 * system is. When the manager types the sheet's figure with both in, the rate is worked out by the
 * same rule as a rate package's (`figure ÷ ((1 + service charge) × (1 + GST))`, rounded to the
 * chhertum), and the figure typed is kept beside it. What the guest is billed is the rate taxed as a
 * line is (`lineTax`): Nu 48,000 typed comes to Nu 47,999.99 (operator's choice: strict 5%).
 *
 * Writes: audited in the same transaction (`writeAdminAuditEvent`, the whole package before and
 * after, its apartments included), the package row snapshotted before an update.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { writeAdminAuditEvent } from "../../lib/admin/write-admin-audit.js";
import { captureSnapshotTx } from "../../lib/admin/entity-version-snapshot.js";
import { lineTax } from "../../lib/stay-posting.js";
import { round2, toDecimal } from "../../lib/money.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";

type DecimalInput = number | string;

export type ApartmentUnitInput = { label: string; maxOccupants: number; roomIds: string[] };
export type ApartmentPackageInput = {
  name: string;
  carpetAreaSqft?: number | null;
  amenities?: string | null;
  /** The two rates were typed with service charge and GST in them. */
  ratesWithTaxes: boolean;
  weeklyRate: DecimalInput;
  monthlyRate: DecimalInput;
  sortOrder?: number | null;
  units: ApartmentUnitInput[];
};

type Rule = { serviceChargeRate: number; gstRate: number };

/** A rate as the bill will read it: the rate, its service charge and GST as a line, and the total. */
export function apartmentRateFigures(net: DecimalInput | Prisma.Decimal, rule: Rule) {
  const n = round2(toDecimal(net));
  const t = lineTax(n, { serviceChargeApplies: true, gstApplies: true, ...rule });
  return {
    rate: n.toFixed(2),
    serviceCharge: t.serviceCharge.toFixed(2),
    gst: t.gst.toFixed(2),
    total: n.add(t.serviceCharge).add(t.gst).toFixed(2),
  };
}

/** The rate without service charge and GST, from a figure that has them in it (rate packages' rule). */
function rateFromFigureWithTaxes(figure: Prisma.Decimal, rule: Rule) {
  const factor = new Prisma.Decimal(1).add(rule.serviceChargeRate).mul(new Prisma.Decimal(1).add(rule.gstRate));
  return figure.div(factor).toDecimalPlaces(2);
}

function positive(v: DecimalInput | null | undefined, what: string) {
  if (v == null || String(v).trim() === "") throw new ValidationError(`Type the ${what}`);
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(String(v).replace(/,/g, "").trim());
  } catch {
    throw new ValidationError(`The ${what} does not read as an amount`);
  }
  if (!d.gt(0)) throw new ValidationError(`The ${what} must be more than Nu 0`);
  if (d.decimalPlaces() > 2) throw new ValidationError(`The ${what} goes to the chhertum at most (two decimal places)`);
  return d;
}

/**
 * Work out both rates as they will be stored and billed, from what was typed. Saves nothing.
 * `withTaxes`: the figures have service charge and GST in them.
 */
export async function workOutApartmentRates(
  prisma: PrismaClient,
  input: { weekly?: DecimalInput | null; monthly?: DecimalInput | null; withTaxes: boolean },
) {
  const rule = await resolveChargeRates(prisma);
  const one = (v: DecimalInput | null | undefined) => {
    if (v == null || String(v).trim() === "") return null;
    let d: Prisma.Decimal;
    try {
      d = new Prisma.Decimal(String(v).replace(/,/g, "").trim());
    } catch {
      return null;
    }
    if (!d.gt(0)) return null;
    const rate = input.withTaxes ? rateFromFigureWithTaxes(d, rule) : d.toDecimalPlaces(2);
    return { typed: d.toFixed(2), ...apartmentRateFigures(rate, rule) };
  };
  return { serviceChargeRate: rule.serviceChargeRate, gstRate: rule.gstRate, weekly: one(input.weekly), monthly: one(input.monthly) };
}

const packageInclude = {
  units: {
    orderBy: [{ sortOrder: "asc" as const }, { label: "asc" as const }],
    include: {
      rooms: {
        include: {
          room: { select: { id: true, roomNumber: true, bedType: true, roomType: { select: { id: true, name: true, code: true, maxCapacity: true } } } },
        },
      },
    },
  },
};

type PackageRow = Prisma.ApartmentPackageGetPayload<{ include: typeof packageInclude }>;

function describe(row: PackageRow, rule: Rule) {
  return {
    id: row.id,
    name: row.name,
    carpetAreaSqft: row.carpetAreaSqft,
    amenities: row.amenities,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    ratesTypedWithTax: row.ratesTypedWithTax,
    weekly: { typed: row.weeklyRateTyped?.toFixed(2) ?? null, ...apartmentRateFigures(row.weeklyRate, rule) },
    monthly: { typed: row.monthlyRateTyped?.toFixed(2) ?? null, ...apartmentRateFigures(row.monthlyRate, rule) },
    units: row.units.map((u) => ({
      id: u.id,
      label: u.label,
      maxOccupants: u.maxOccupants,
      rooms: u.rooms
        .map((r) => ({
          roomId: r.room.id,
          roomNumber: r.room.roomNumber,
          bedType: r.room.bedType,
          roomTypeId: r.room.roomType.id,
          roomTypeName: r.room.roomType.name,
          roomTypeCode: r.room.roomType.code,
          roomTypeMaxCapacity: r.room.roomType.maxCapacity,
        }))
        .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true })),
    })),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export type ApartmentPackageView = ReturnType<typeof describe>;

export async function listApartmentPackages(prisma: PrismaClient, opts: { activeOnly?: boolean } = {}) {
  const rule = await resolveChargeRates(prisma);
  const rows = await prisma.apartmentPackage.findMany({
    where: opts.activeOnly ? { isActive: true } : undefined,
    include: packageInclude,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return { serviceChargeRate: rule.serviceChargeRate, gstRate: rule.gstRate, packages: rows.map((r) => describe(r, rule)) };
}

/** Every room the hotel sells, with the apartment it is in, for the room picker. */
export async function listRoomsForApartments(prisma: PrismaClient) {
  const rooms = await prisma.room.findMany({
    where: { isShadowInventory: false },
    select: {
      id: true,
      roomNumber: true,
      bedType: true,
      roomType: { select: { id: true, name: true, code: true, maxCapacity: true } },
      apartmentUnitRoom: { select: { unit: { select: { id: true, label: true, package: { select: { id: true, name: true } } } } } },
    },
  });
  return rooms
    .map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      bedType: r.bedType,
      roomTypeId: r.roomType.id,
      roomTypeName: r.roomType.name,
      roomTypeCode: r.roomType.code,
      roomTypeMaxCapacity: r.roomType.maxCapacity,
      apartment: r.apartmentUnitRoom
        ? { unitId: r.apartmentUnitRoom.unit.id, label: r.apartmentUnitRoom.unit.label, packageId: r.apartmentUnitRoom.unit.package.id, packageName: r.apartmentUnitRoom.unit.package.name }
        : null,
    }))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

/** Everything that can be said about a package before it is written, in words. */
async function cleanInput(prisma: PrismaClient, input: ApartmentPackageInput, packageId: string | null, rule: Rule) {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new ValidationError("Give the package a name");
  if (name.length > 80) throw new ValidationError("The name is longer than 80 characters");
  const sameName = await prisma.apartmentPackage.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(packageId ? { id: { not: packageId } } : {}) },
    select: { id: true },
  });
  if (sameName) throw new ValidationError(`There is already a package called "${name}"`);

  let carpetAreaSqft: number | null = null;
  if (input.carpetAreaSqft != null && String(input.carpetAreaSqft).trim() !== "") {
    const a = Number(input.carpetAreaSqft);
    if (!Number.isInteger(a) || a < 1 || a > 100000) throw new ValidationError("The carpet area is a whole number of square feet, 1 to 100,000");
    carpetAreaSqft = a;
  }
  const amenities = input.amenities?.trim() ? input.amenities.trim().replace(/\r\n/g, "\n") : null;
  if (amenities && amenities.length > 4000) throw new ValidationError("The amenities are longer than 4,000 characters");

  const weeklyTyped = positive(input.weeklyRate, "weekly rate");
  const monthlyTyped = positive(input.monthlyRate, "monthly rate");
  const withTaxes = !!input.ratesWithTaxes;
  const weeklyRate = withTaxes ? rateFromFigureWithTaxes(weeklyTyped, rule) : weeklyTyped;
  const monthlyRate = withTaxes ? rateFromFigureWithTaxes(monthlyTyped, rule) : monthlyTyped;
  if (!weeklyRate.gt(0) || !monthlyRate.gt(0)) throw new ValidationError("A rate comes to nothing once service charge and GST are taken out");

  // The apartments.
  const units = (input.units ?? []).map((u, i) => ({
    label: String(u.label ?? "").trim(),
    maxOccupants: Number(u.maxOccupants),
    roomIds: [...new Set((u.roomIds ?? []).map(String))],
    sortOrder: i,
  }));
  const labels = new Map<string, number>();
  for (const u of units) {
    if (!u.label) throw new ValidationError("Every apartment needs its number (for example 503)");
    if (u.label.length > 20) throw new ValidationError(`Apartment "${u.label}": the number is longer than 20 characters`);
    const key = u.label.toLowerCase();
    if (labels.has(key)) throw new ValidationError(`Apartment ${u.label} is listed twice`);
    labels.set(key, 1);
    if (!Number.isInteger(u.maxOccupants) || u.maxOccupants < 1 || u.maxOccupants > 20)
      throw new ValidationError(`Apartment ${u.label}: the most guests is a whole number, 1 to 20`);
    if (!u.roomIds.length) throw new ValidationError(`Apartment ${u.label}: pick its room`);
  }
  const allRoomIds = units.flatMap((u) => u.roomIds);
  const seen = new Map<string, string>();
  for (const u of units)
    for (const r of u.roomIds) {
      if (seen.has(r)) throw new ValidationError(`A room is in apartment ${seen.get(r)} and apartment ${u.label} — a room belongs to one apartment`);
      seen.set(r, u.label);
    }
  if (allRoomIds.length) {
    const rooms = await prisma.room.findMany({
      where: { id: { in: allRoomIds } },
      select: { id: true, roomNumber: true, isShadowInventory: true, apartmentUnitRoom: { select: { unit: { select: { label: true, packageId: true, package: { select: { name: true } } } } } } },
    });
    const byId = new Map(rooms.map((r) => [r.id, r]));
    for (const id of allRoomIds) {
      const r = byId.get(id);
      if (!r || r.isShadowInventory) throw new ValidationError("A room picked is not one of the hotel's rooms");
      const held = r.apartmentUnitRoom?.unit;
      if (held && held.packageId !== packageId)
        throw new ValidationError(`Room ${r.roomNumber} is already in apartment ${held.label} of ${held.package.name} — take it off there first`);
    }
    // Apartment numbers are the hotel's own: one number, one apartment, across every package.
    const otherLabels = await prisma.apartmentUnit.findMany({
      where: { label: { in: units.map((u) => u.label), mode: "insensitive" }, ...(packageId ? { packageId: { not: packageId } } : {}) },
      select: { label: true, package: { select: { name: true } } },
    });
    if (otherLabels.length) throw new ValidationError(`Apartment ${otherLabels[0].label} is already in ${otherLabels[0].package.name}`);
  }

  const sortOrder = input.sortOrder == null || String(input.sortOrder).trim() === "" ? 0 : Number(input.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999) throw new ValidationError("The order is a whole number, 0 to 999");

  return {
    data: {
      name,
      carpetAreaSqft,
      amenities,
      weeklyRate,
      monthlyRate,
      ratesTypedWithTax: withTaxes,
      weeklyRateTyped: withTaxes ? weeklyTyped : null,
      monthlyRateTyped: withTaxes ? monthlyTyped : null,
      sortOrder,
    },
    units,
  };
}

async function writeUnits(tx: Prisma.TransactionClient, packageId: string, units: Array<{ label: string; maxOccupants: number; roomIds: string[]; sortOrder: number }>) {
  await tx.apartmentUnit.deleteMany({ where: { packageId } });
  for (const u of units) {
    await tx.apartmentUnit.create({
      data: {
        packageId,
        label: u.label,
        maxOccupants: u.maxOccupants,
        sortOrder: u.sortOrder,
        rooms: { create: u.roomIds.map((roomId) => ({ roomId })) },
      },
    });
  }
}

/** What the audit keeps of a package: everything on it, its apartments and their rooms. */
async function auditShape(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.apartmentPackage.findUnique({ where: { id }, include: packageInclude });
  if (!row) return null;
  return {
    name: row.name,
    carpetAreaSqft: row.carpetAreaSqft,
    amenities: row.amenities,
    weeklyRate: row.weeklyRate.toFixed(2),
    monthlyRate: row.monthlyRate.toFixed(2),
    ratesTypedWithTax: row.ratesTypedWithTax,
    weeklyRateTyped: row.weeklyRateTyped?.toFixed(2) ?? null,
    monthlyRateTyped: row.monthlyRateTyped?.toFixed(2) ?? null,
    isActive: row.isActive,
    units: row.units.map((u) => ({ label: u.label, maxOccupants: u.maxOccupants, rooms: u.rooms.map((r) => r.room.roomNumber).sort() })),
  };
}

export async function createApartmentPackage(prisma: PrismaClient, input: ApartmentPackageInput, actorId: string) {
  const rule = await resolveChargeRates(prisma);
  const clean = await cleanInput(prisma, input, null, rule);
  const id = await prisma.$transaction(async (tx) => {
    const created = await tx.apartmentPackage.create({ data: { ...clean.data, createdBy: actorId, updatedBy: actorId } });
    await writeUnits(tx, created.id, clean.units);
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.APARTMENT_PACKAGE_CREATED",
      entityType: "ApartmentPackage",
      entityId: created.id,
      operation: "CREATE",
      payload: { after: await auditShape(tx, created.id) },
    });
    return created.id;
  });
  return getApartmentPackage(prisma, id);
}

export async function updateApartmentPackage(prisma: PrismaClient, id: string, input: ApartmentPackageInput, actorId: string) {
  const existing = await prisma.apartmentPackage.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new NotFoundError("Apartment package");
  const rule = await resolveChargeRates(prisma);
  const clean = await cleanInput(prisma, input, id, rule);
  await prisma.$transaction(async (tx) => {
    const before = await auditShape(tx, id);
    await captureSnapshotTx(tx, { entityType: "ApartmentPackage", entityId: id, actorId, changeNote: "Apartment package edited" });
    await tx.apartmentPackage.update({ where: { id }, data: { ...clean.data, updatedBy: actorId } });
    await writeUnits(tx, id, clean.units);
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.APARTMENT_PACKAGE_UPDATED",
      entityType: "ApartmentPackage",
      entityId: id,
      operation: "UPDATE",
      payload: { before, after: await auditShape(tx, id) },
    });
  });
  return getApartmentPackage(prisma, id);
}

export async function setApartmentPackageActive(prisma: PrismaClient, id: string, isActive: boolean, actorId: string) {
  const existing = await prisma.apartmentPackage.findUnique({ where: { id }, select: { id: true, isActive: true } });
  if (!existing) throw new NotFoundError("Apartment package");
  if (existing.isActive !== isActive) {
    await prisma.$transaction(async (tx) => {
      await captureSnapshotTx(tx, { entityType: "ApartmentPackage", entityId: id, actorId, changeNote: isActive ? "Offered again" : "No longer offered" });
      await tx.apartmentPackage.update({ where: { id }, data: { isActive, updatedBy: actorId } });
      await writeAdminAuditEvent(tx, {
        actorId,
        eventType: isActive ? "ADMIN.APARTMENT_PACKAGE_ACTIVATED" : "ADMIN.APARTMENT_PACKAGE_DEACTIVATED",
        entityType: "ApartmentPackage",
        entityId: id,
        operation: "UPDATE",
        payload: { isActive },
      });
    });
  }
  return getApartmentPackage(prisma, id);
}

/** Deleting takes the package and its apartments off; the rooms stay rooms. */
export async function deleteApartmentPackage(prisma: PrismaClient, id: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    const before = await auditShape(tx, id);
    if (!before) throw new NotFoundError("Apartment package");
    await tx.apartmentPackage.delete({ where: { id } });
    await writeAdminAuditEvent(tx, {
      actorId,
      eventType: "ADMIN.APARTMENT_PACKAGE_DELETED",
      entityType: "ApartmentPackage",
      entityId: id,
      operation: "DELETE",
      payload: { before },
    });
  });
  return { deleted: true };
}

export async function getApartmentPackage(prisma: PrismaClient, id: string) {
  const rule = await resolveChargeRates(prisma);
  const row = await prisma.apartmentPackage.findUnique({ where: { id }, include: packageInclude });
  if (!row) throw new NotFoundError("Apartment package");
  return describe(row, rule);
}
