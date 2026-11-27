/**
 * What an apartment holds, and an extra bed asked for during the stay (2026-11-27, operator: "we need
 * the option to add amenities and their counts but they are not priced ... a field to add it and choose
 * number, and also others option"; "they can ask extra bed during stay, so somewhere in stay we need an
 * option to add bed for how many days and charge it, now for extra bed rate it can be different rate
 * than normal hotel reservations, so maybe add a section in apartments in admin console to type rate").
 *
 * Amenities are a list with counts, never priced: the hotel's list of items (a setting), each package's
 * usual list (`ApartmentPackage.amenityKit`), and the booking's own (`Entry.apartmentAmenities`), which
 * starts from its package's and is changed freely until the booking ends.
 *
 * An extra bed is a record (`ApartmentExtraBed`) the night audit charges night by night, as it charges
 * the rooms — at the apartments' extra bed rate when it was added, without taxes, on the apartment's
 * first room, with service charge and GST as on any line. Money only through the night audit; the
 * figures shown before adding are the same rule (`lineTax`).
 */
import { Prisma, Stage, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { round2, toDecimal } from "../../lib/money.js";
import { lineTax } from "../../lib/stay-posting.js";
import { effectiveCheckOutDate, hotelTodayUtc } from "../../lib/stay-dates.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";
import { amenityWords, cleanAmenityItems, DEFAULT_AMENITY_ITEMS, type AmenityItem } from "../../lib/apartment-amenities.js";
export { cleanAmenityItemNames, cleanAmenityItems, DEFAULT_AMENITY_ITEMS, type AmenityItem } from "../../lib/apartment-amenities.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { apartmentsOfRooms, type ApartmentInfo } from "./apartment-booking-service.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";

type Level = "L1" | "L2" | "L3" | "L4";
const DAY = 86_400_000;

export const APARTMENT_AMENITY_ITEMS_KEY = "apartment.amenityItems";
export const APARTMENT_EXTRA_BED_RATE_KEY = "apartment.extraBedRate";
import { NIGHT_AUDIT_APARTMENT_BED_PREFIX } from "../../lib/folio-tax-lines.js";
export { NIGHT_AUDIT_APARTMENT_BED_PREFIX };

/** The hotel's list of items an apartment may hold — the setting, else the operator's list. */
export async function readAmenityItems(prisma: PrismaClient): Promise<string[]> {
  const row = await getActiveConfigEntry(prisma, APARTMENT_AMENITY_ITEMS_KEY);
  const v = row?.configValue;
  return Array.isArray(v) && v.length ? v.map((x) => String(x)).filter(Boolean) : [...DEFAULT_AMENITY_ITEMS];
}

export type ExtraBedRate = {
  /** Without service charge and GST, a bed a night; null when no rate is set. */
  rate: string | null;
  typed: string | null;
  typedWithTax: boolean;
  serviceCharge: string | null;
  gst: string | null;
  total: string | null;
};

/** The apartments' extra bed rate, a bed a night (the setting), with its service charge and GST. */
export async function readApartmentExtraBedRate(prisma: PrismaClient): Promise<ExtraBedRate> {
  const row = await getActiveConfigEntry(prisma, APARTMENT_EXTRA_BED_RATE_KEY);
  const v = (row?.configValue ?? null) as { rate?: unknown; typed?: unknown; typedWithTax?: unknown } | null;
  const rate = v?.rate != null && Number.isFinite(Number(v.rate)) && Number(v.rate) > 0 ? round2(toDecimal(String(v.rate))) : null;
  if (!rate) return { rate: null, typed: null, typedWithTax: false, serviceCharge: null, gst: null, total: null };
  const rule = await resolveChargeRates(prisma);
  const t = lineTax(rate, { serviceChargeApplies: true, gstApplies: true, ...rule });
  return {
    rate: rate.toFixed(2),
    typed: v?.typed != null && Number.isFinite(Number(v.typed)) ? Number(v.typed).toFixed(2) : null,
    typedWithTax: v?.typedWithTax === true,
    serviceCharge: t.serviceCharge.toFixed(2),
    gst: t.gst.toFixed(2),
    total: rate.add(t.serviceCharge).add(t.gst).toFixed(2),
  };
}

/** The apartments a booking holds: its pick on its own pass, and the rooms handed out to it. */
async function unitsOfEntry(prisma: PrismaClient, entryId: string): Promise<ApartmentInfo[]> {
  const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" }, select: { id: true } });
  const cfg = await prisma.availabilityConfiguration.findFirst({
    where: { entryId, optionSelected: { not: { equals: null } } as never, ...(seg ? { OR: [{ segmentId: seg.id }, { segmentId: null }] } : {}) },
    orderBy: { createdAt: "desc" },
    select: { optionSelected: true },
  });
  const picked = readOptionSelected(cfg?.optionSelected ?? null).distinctRoomIds;
  const assigned = await prisma.roomAssignment.findMany({ where: { entryId }, select: { roomId: true } });
  const ids = [...new Set([...picked, ...assigned.map((a) => a.roomId)])];
  const map = await apartmentsOfRooms(prisma, ids);
  const byUnit = new Map<string, ApartmentInfo>();
  for (const a of map.values()) if (!byUnit.has(a.unitId)) byUnit.set(a.unitId, a);
  return [...byUnit.values()].sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
}

/** A booking's own list per apartment, kept by the apartment's NUMBER: a package saved on the admin
 *  console makes its apartments afresh, with new ids, and the number is what stays. */
type SavedUnit = { unitId: string; label: string; items: AmenityItem[] };
const savedOf = (v: unknown): SavedUnit[] =>
  Array.isArray(v)
    ? (v as SavedUnit[]).filter((u) => u && typeof u.label === "string" && u.label).map((u) => ({ unitId: String(u.unitId ?? ""), label: u.label, items: Array.isArray(u.items) ? u.items : [] }))
    : [];

/** What each of the booking's apartments holds: the booking's own list, else its package's. */
export async function getEntryApartmentAmenities(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, useType: true, status: true, apartmentAmenities: true } });
  if (!entry) throw new NotFoundError("Entry");
  const known = await readAmenityItems(prisma);
  if (String(entry.useType) !== "APARTMENT") return { entryId, units: [], known, editable: false };
  const units = await unitsOfEntry(prisma, entryId);
  const pkgs = await prisma.apartmentPackage.findMany({ where: { id: { in: [...new Set(units.map((u) => u.packageId))] } }, select: { id: true, amenityKit: true } });
  const kitOf = new Map(pkgs.map((p) => [p.id, (() => { try { return cleanAmenityItems(p.amenityKit, "kit"); } catch { return []; } })()]));
  const saved = savedOf(entry.apartmentAmenities);
  const names = new Set(known.map((k) => k.toLowerCase()));
  const extra: string[] = [];
  for (const k of kitOf.values()) {
    for (const i of k) {
      if (names.has(i.name.toLowerCase())) continue;
      names.add(i.name.toLowerCase());
      extra.push(i.name);
    }
  }
  return {
    entryId,
    known: [...known, ...extra],
    editable: entry.status === "ACTIVE" || entry.status === "PARKED",
    units: units.map((u) => {
      const own = saved.find((s) => s.label === u.label);
      const kit = kitOf.get(u.packageId) ?? [];
      return {
        unitId: u.unitId,
        label: u.label,
        packageName: u.packageName,
        roomNumbers: u.roomNumbers,
        items: own ? own.items : kit,
        source: own ? ("BOOKING" as const) : kit.length ? ("PACKAGE" as const) : ("NONE" as const),
      };
    }),
  };
}

/** What each apartment of a booking holds, for a paper — only apartments with something on their list. */
export async function amenitiesForPaper(prisma: PrismaClient, entryId: string): Promise<Array<{ label: string; words: string }>> {
  try {
    const out = await getEntryApartmentAmenities(prisma, entryId);
    return out.units.map((u) => ({ label: u.label, words: amenityWords(u.items) })).filter((u) => u.words);
  } catch {
    return [];
  }
}

/** Keep what this booking's apartments hold. Any live step; traced with the list before and after. */
export async function setEntryApartmentAmenities(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: Level },
  body: { units: Array<{ unitId: string; items: unknown }> },
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true, inquiryId: true, useType: true, status: true, currentStage: true, apartmentAmenities: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (String(entry.useType) !== "APARTMENT") throw new ValidationError("Only an apartment booking keeps a list of what the apartment holds");
  const units = await unitsOfEntry(prisma, entryId);
  if (!Array.isArray(body?.units) || !body.units.length) throw new ValidationError("Name the apartment whose list this is");
  const before = savedOf(entry.apartmentAmenities);
  const after = [...before];
  for (const u of body.units) {
    const unit = units.find((x) => x.unitId === u.unitId);
    if (!unit) throw new ValidationError("That apartment is not on this booking");
    const items = cleanAmenityItems(u.items, `Apartment ${unit.label}`);
    const i = after.findIndex((s) => s.label === unit.label);
    const row = { unitId: unit.unitId, label: unit.label, items };
    if (i >= 0) after[i] = row;
    else after.push(row);
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.entry.update({ where: { id: entryId }, data: { apartmentAmenities: after as unknown as Prisma.InputJsonValue } });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.APARTMENT_AMENITIES_SET",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { before, after } as unknown as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
  });
  return getEntryApartmentAmenities(prisma, entryId);
}

/* ------------------------------------------------------------------ extra beds */

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dayOf = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError(`${s || "A day"} is not a date (YYYY-MM-DD)`);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${s} is not a real date`);
  return d;
};
const nightsBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const words = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** One bed a night with its taxes, and the nights given — the night audit's own rule. */
async function bedFigures(prisma: PrismaClient, rate: Prisma.Decimal, beds: number, nights: number) {
  const rule = await resolveChargeRates(prisma);
  const net = round2(rate.mul(beds));
  const t = lineTax(net, { serviceChargeApplies: true, gstApplies: true, ...rule });
  const night = { net: net.toFixed(2), serviceCharge: t.serviceCharge.toFixed(2), gst: t.gst.toFixed(2), total: net.add(t.serviceCharge).add(t.gst).toFixed(2) };
  const all = {
    net: net.mul(nights).toFixed(2),
    serviceCharge: t.serviceCharge.mul(nights).toFixed(2),
    gst: t.gst.mul(nights).toFixed(2),
    total: net.add(t.serviceCharge).add(t.gst).mul(nights).toFixed(2),
  };
  return { night, all };
}

/** The night-audit line a bed record posts — its words name the record so two beds are two lines. */
export function apartmentBedLineDescription(r: { id: string; unitLabel: string; beds: number }) {
  return `${NIGHT_AUDIT_APARTMENT_BED_PREFIX} · Apartment ${r.unitLabel} · ${r.beds} bed${r.beds === 1 ? "" : "s"} · ${r.id.slice(0, 8)}`;
}

async function stayOf(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      useType: true,
      status: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      folio: { select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/** The booking's extra beds, what they come to, and whether a bed can be added now (and why not). */
export async function listApartmentExtraBeds(prisma: PrismaClient, entryId: string) {
  const entry = await stayOf(prisma, entryId);
  const rate = await readApartmentExtraBedRate(prisma);
  const units = String(entry.useType) === "APARTMENT" ? await unitsOfEntry(prisma, entryId) : [];
  const records = await prisma.apartmentExtraBed.findMany({ where: { entryId }, orderBy: { createdAt: "asc" } });
  const posted = entry.folio
    ? await prisma.folioLine.findMany({
        where: { folioId: entry.folio.id, description: { startsWith: NIGHT_AUDIT_APARTMENT_BED_PREFIX } },
        select: { description: true, chargeDate: true },
      })
    : [];
  const beds = [];
  for (const r of records) {
    const nights = nightsBetween(r.fromDate, r.toDate);
    const f = await bedFigures(prisma, r.ratePerBed, r.beds, nights);
    const d = apartmentBedLineDescription(r);
    beds.push({
      id: r.id,
      unitId: r.unitId,
      unitLabel: r.unitLabel,
      beds: r.beds,
      fromDate: ymd(r.fromDate),
      toDate: ymd(r.toDate),
      nights,
      ratePerBed: r.ratePerBed.toFixed(2),
      night: f.night,
      all: f.all,
      nightsPosted: posted.filter((l) => l.description === d).length,
      note: r.note,
      endedAt: r.endedAt?.toISOString() ?? null,
      endReason: r.endReason,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    });
  }
  const stayEnd = effectiveCheckOutDate(entry);
  const today = hotelTodayUtc();
  const why =
    String(entry.useType) !== "APARTMENT"
      ? "Only an apartment stay takes an extra bed this way"
      : entry.status !== "ACTIVE"
        ? "The booking is not live"
        : entry.currentStage !== Stage.S7
          ? "An extra bed is added once the guest is in, at Stay"
          : !rate.rate
            ? "No extra bed rate is set for the apartments — an admin sets it under Apartments › Extra bed"
            : stayEnd && stayEnd.getTime() <= today.getTime()
              ? "The stay ends today — there is no night left to add a bed for"
              : null;
  return {
    entryId,
    rate,
    units: units.map((u) => ({ unitId: u.unitId, label: u.label, packageName: u.packageName })),
    stay: { today: ymd(today), lastMorning: stayEnd ? ymd(stayEnd) : null },
    mayAdd: !why,
    why,
    beds,
  };
}

/** What a bed would come to — nothing written. */
export async function previewApartmentExtraBed(prisma: PrismaClient, entryId: string, input: { unitId: string; beds: number; fromDate: string; toDate: string }) {
  const checked = await checkBedAsk(prisma, entryId, input);
  const f = await bedFigures(prisma, checked.rate, input.beds, checked.nights);
  return { nights: checked.nights, ratePerBed: checked.rate.toFixed(2), night: f.night, all: f.all, unitLabel: checked.unit.label };
}

async function checkBedAsk(prisma: PrismaClient, entryId: string, input: { unitId: string; beds: number; fromDate: string; toDate: string }) {
  const entry = await stayOf(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  if (String(entry.useType) !== "APARTMENT") throw new ValidationError("Only an apartment stay takes an extra bed this way — a room's extra bed is set with Change booking");
  if (entry.currentStage !== Stage.S7) throw new ValidationError("An extra bed is added once the guest is in, at Stay");
  const rateNow = await readApartmentExtraBedRate(prisma);
  if (!rateNow.rate) throw new ValidationError("No extra bed rate is set for the apartments — an admin sets it under Apartments › Extra bed");
  const units = await unitsOfEntry(prisma, entryId);
  const unit = units.find((u) => u.unitId === input.unitId);
  if (!unit) throw new ValidationError("That apartment is not on this booking");
  if (!Number.isInteger(input.beds) || input.beds < 1 || input.beds > 5) throw new ValidationError("Beds: a whole number from 1 to 5");
  const from = dayOf(input.fromDate);
  const to = dayOf(input.toDate);
  const today = hotelTodayUtc();
  const stayEnd = effectiveCheckOutDate(entry);
  if (from.getTime() < today.getTime()) throw new ValidationError(`A bed starts tonight at the earliest — ${words(from)} has passed`);
  if (to.getTime() <= from.getTime()) throw new ValidationError("The bed goes back after the night it starts — pick at least one night");
  if (stayEnd && to.getTime() > stayEnd.getTime()) throw new ValidationError(`The stay ends the morning of ${words(stayEnd)} — the bed cannot run past it`);
  return { entry, unit, from, to, nights: nightsBetween(from, to), rate: toDecimal(rateNow.rate) };
}

/** Add an extra bed. Charged by the night audit; tonight's posted ahead is put right at once. */
export async function addApartmentExtraBed(
  prisma: PrismaClient,
  entryId: string,
  actor: { actorId: string; actorLevel: Level },
  input: { unitId: string; beds: number; fromDate: string; toDate: string; note?: string | null },
) {
  const c = await checkBedAsk(prisma, entryId, input);
  const lead = c.unit.roomIds[0];
  const now = new Date();
  const record = await prisma.$transaction(async (tx) => {
    const r = await tx.apartmentExtraBed.create({
      data: {
        entryId,
        unitId: c.unit.unitId,
        unitLabel: c.unit.label,
        roomId: lead,
        beds: input.beds,
        fromDate: c.from,
        toDate: c.to,
        ratePerBed: c.rate,
        note: input.note?.trim() || null,
        createdBy: actor.actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.APARTMENT_EXTRA_BED_ADDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: c.entry.currentStage,
        inquiryId: c.entry.inquiryId,
        entryId,
        payload: {
          recordId: r.id,
          apartment: c.unit.label,
          beds: input.beds,
          fromDate: ymd(c.from),
          toDate: ymd(c.to),
          nights: c.nights,
          ratePerBed: c.rate.toFixed(2),
          note: r.note,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return r;
  });
  // Tonight's lines, when tonight was posted ahead, take the bed now (the hotel's run would).
  if (c.from.getTime() === hotelTodayUtc().getTime()) {
    const { reconcileTonightBestEffort } = await import("../application/s7-night-audit-service.js");
    await reconcileTonightBestEffort(prisma, { entryId, actorId: actor.actorId, actorLevel: actor.actorLevel, reason: `Extra bed added in apartment ${c.unit.label}` });
  }
  return { recordId: record.id, ...(await listApartmentExtraBeds(prisma, entryId)) };
}

/**
 * End a bed: it goes back the morning of `toDate` (today at the earliest), or is taken off before its
 * first night. Nights already posted stay billed; tonight's, when posted ahead, is put right at once.
 */
export async function endApartmentExtraBed(
  prisma: PrismaClient,
  entryId: string,
  recordId: string,
  actor: { actorId: string; actorLevel: Level },
  input: { toDate: string; reason?: string | null },
) {
  const entry = await stayOf(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const r = await prisma.apartmentExtraBed.findFirst({ where: { id: recordId, entryId } });
  if (!r) throw new NotFoundError("Extra bed");
  const to = dayOf(input.toDate);
  const today = hotelTodayUtc();
  if (to.getTime() < today.getTime()) throw new ValidationError(`The bed can go back this morning at the earliest — ${words(to)} has passed`);
  if (to.getTime() >= r.toDate.getTime()) throw new ValidationError(`The bed already goes back the morning of ${words(r.toDate)}`);
  const posted = entry.folio
    ? await prisma.folioLine.count({ where: { folioId: entry.folio.id, description: apartmentBedLineDescription(r), chargeDate: { gte: to } } })
    : 0;
  const now = new Date();
  const takenOff = to.getTime() <= r.fromDate.getTime();
  // Taken off on the night it starts, with tonight already posted: the record goes and tonight's
  // line is put right to nothing below (a bed added by mistake is not charged).
  await prisma.$transaction(async (tx) => {
    if (takenOff) await tx.apartmentExtraBed.delete({ where: { id: r.id } });
    else await tx.apartmentExtraBed.update({ where: { id: r.id }, data: { toDate: to, endedAt: now, endedBy: actor.actorId, endReason: input.reason?.trim() || null } });
    await tx.traceEvent.create({
      data: {
        eventType: takenOff ? "ENTRY.APARTMENT_EXTRA_BED_TAKEN_OFF" : "ENTRY.APARTMENT_EXTRA_BED_ENDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          recordId: r.id,
          apartment: r.unitLabel,
          beds: r.beds,
          fromDate: ymd(r.fromDate),
          toDateBefore: ymd(r.toDate),
          toDate: ymd(to),
          reason: input.reason?.trim() || null,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
  });
  if (posted > 0 && entry.currentStage === Stage.S7) {
    const { reconcileTonightBestEffort } = await import("../application/s7-night-audit-service.js");
    await reconcileTonightBestEffort(prisma, { entryId, actorId: actor.actorId, actorLevel: actor.actorLevel, reason: `Extra bed in apartment ${r.unitLabel} ended` });
  }
  return listApartmentExtraBeds(prisma, entryId);
}

/** The beds a booking has on a night — what the night audit posts (exported for it). */
export async function apartmentBedsOnNight(prisma: PrismaClient, entryId: string, night: Date) {
  return prisma.apartmentExtraBed.findMany({ where: { entryId, fromDate: { lte: night }, toDate: { gt: night } }, orderBy: { createdAt: "asc" } });
}

