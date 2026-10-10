import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { resolveRatePackageForBooking } from "../../lib/rate-package-resolution.js";
import { resolveRatePlanPricingForS2Quotation } from "../../policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";

/**
 * What the rooms picked at Inquiry cost — night by night and for the whole stay (2026-10-10,
 * operator, after the boss's journey mockup: "it shows total amount of the cost of rooms booked
 * in a day and per day and all together").
 *
 * The desk sends the picks as they stand on the room table, saved or not, and gets back the
 * bill: every night with its rooms and its figure, every room type as `room-nights × rate`, and
 * the stay's net, service charge, GST and total. Pure read — nothing is written, no trace, and
 * the picks are not checked for availability (the search that drew the table already did).
 *
 * The ROOM only. Meals, extra beds and negotiated rates are settled on the table at Negotiation,
 * so this is the figure the guest hears on the phone, and the quotation prices it exactly later.
 * The rate per type is the one the quotation draft defaults to — the party's package (with its
 * per-room-type override) when the inquiry is linked to one, else the type's own rate plan —
 * resolved exactly as the rate reference strip resolves it, so the two can never disagree.
 *
 * Money is Decimal throughout. Each night's service charge and GST are rounded on that night's
 * net, and the stay's figures are the sums of the nights', so the bill adds up line by line.
 */

export type PickPricingInput = {
  /** One entry per night of the stay that has rooms; nights may differ. */
  perNight?: Array<{ date: string; roomIds: string[] }>;
  /** The same rooms on every night of the stay. */
  roomIds?: string[];
};

type Money = number;

export type PickPricing = {
  entryId: string;
  currency: string;
  serviceChargeRate: number;
  gstRate: number;
  /** The party whose package priced the rooms, when one is linked. */
  party: { type: "TRAVEL_AGENT" | "CORPORATE"; name: string } | null;
  stayNights: number;
  nights: Array<{
    date: string;
    rooms: Array<{ roomId: string; roomNumber: string; roomTypeId: string | null; roomTypeName: string | null; rate: Money | null }>;
    net: Money;
    serviceCharge: Money;
    gst: Money;
    total: Money;
    /** Rooms on this night whose type has no rate — left out of the figures. */
    unpricedRooms: number;
  }>;
  byType: Array<{
    roomTypeId: string;
    code: string | null;
    name: string;
    roomNights: number;
    rate: Money | null;
    rateSource: "AGENT_RATE_PACKAGE" | "STANDARD_RATE_PLAN" | null;
    packageName: string | null;
    net: Money | null;
  }>;
  byRoom: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; dates: string[] }>;
  totals: { roomNights: number; net: Money; serviceCharge: Money; gst: Money; total: Money };
  /** Types with no rate on file — the totals leave their nights out and say so. */
  unpricedTypes: Array<{ roomTypeId: string; name: string }>;
};

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dec = (n: number | string) => new Prisma.Decimal(n);
const round2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const out = (d: Prisma.Decimal): Money => Number(round2(d).toFixed(2));

export async function priceRoomPick(prisma: PrismaClient, entryId: string, input: PickPricingInput): Promise<PickPricing> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      checkInDate: true,
      checkOutDate: true,
      inquiry: {
        select: {
          ratePackageId: true,
          travelAgent: { select: { id: true, displayName: true } },
          corporateAccount: { select: { id: true, displayName: true } },
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.checkInDate || !entry.checkOutDate) throw new ValidationError("The booking has no stay dates yet — put them in first");

  const checkIn = entry.checkInDate;
  const checkOut = entry.checkOutDate;
  const stayNights = Math.max(1, Math.round((checkOut.getTime() - checkIn.getTime()) / DAY_MS));
  const stayDates = Array.from({ length: stayNights }, (_, i) => isoDay(new Date(checkIn.getTime() + i * DAY_MS)));
  const inStay = new Set(stayDates);

  // One shape for both forms: the whole-stay list is every night with the same rooms.
  const raw = input.perNight?.length
    ? input.perNight
    : input.roomIds?.length
      ? stayDates.map((date) => ({ date, roomIds: input.roomIds! }))
      : [];
  const byDate = new Map<string, Set<string>>();
  for (const n of raw) {
    if (!inStay.has(n.date)) throw new ValidationError(`${n.date} is not a night of this stay`);
    const set = byDate.get(n.date) ?? new Set<string>();
    for (const id of n.roomIds) set.add(id);
    byDate.set(n.date, set);
  }

  const allRoomIds = [...new Set([...byDate.values()].flatMap((s) => [...s]))];
  const rooms = allRoomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: allRoomIds } },
        select: { id: true, roomNumber: true, roomType: { select: { id: true, code: true, name: true } } },
      })
    : [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const missing = allRoomIds.filter((id) => !roomById.has(id));
  if (missing.length) throw new ValidationError(`Unknown room${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);

  const party = entry.inquiry?.travelAgent
    ? ({ type: "TRAVEL_AGENT", id: entry.inquiry.travelAgent.id, name: entry.inquiry.travelAgent.displayName } as const)
    : entry.inquiry?.corporateAccount
      ? ({ type: "CORPORATE", id: entry.inquiry.corporateAccount.id, name: entry.inquiry.corporateAccount.displayName } as const)
      : null;

  // The rate per room TYPE — the same resolution as the rate reference strip and the S2 draft.
  type TypeRate = { rate: number | null; source: PickPricing["byType"][number]["rateSource"]; packageName: string | null; currency: string | null };
  const typeRates = new Map<string, TypeRate>();
  const stay = { checkIn, checkOut };
  for (const r of rooms) {
    const t = r.roomType;
    if (!t || typeRates.has(t.id)) continue;
    let standard: { rate: number; currency: string } | null = null;
    try {
      const p = await resolveRatePlanPricingForS2Quotation(prisma, { roomTypeId: t.id, stay });
      if (p.effectiveRate != null) standard = { rate: p.effectiveRate, currency: p.currency };
    } catch {
      /* no eligible rate plan for this type — the type is reported unpriced */
    }
    const pkg = party
      ? await resolveRatePackageForBooking(prisma, {
          ratePackageId: entry.inquiry?.ratePackageId ?? null,
          travelAgentId: party.type === "TRAVEL_AGENT" ? party.id : null,
          corporateAccountId: party.type === "CORPORATE" ? party.id : null,
          roomTypeId: t.id,
        })
      : null;
    typeRates.set(
      t.id,
      pkg
        ? { rate: pkg.roomRate, source: "AGENT_RATE_PACKAGE", packageName: pkg.packageName ?? null, currency: pkg.currency ?? null }
        : standard
          ? { rate: standard.rate, source: "STANDARD_RATE_PLAN", packageName: null, currency: standard.currency }
          : { rate: null, source: null, packageName: null, currency: null },
    );
  }

  const { serviceChargeRate, gstRate } = await resolveChargeRates(prisma);
  const sc = dec(serviceChargeRate);
  const gst = dec(gstRate);
  const currency = [...typeRates.values()].find((t) => t.currency)?.currency ?? "BTN";

  const typeTally = new Map<string, { nights: number }>();
  const roomDates = new Map<string, string[]>();
  let stayNet = dec(0);
  let staySc = dec(0);
  let stayGst = dec(0);
  let roomNights = 0;

  const nights: PickPricing["nights"] = [];
  for (const date of stayDates) {
    const ids = byDate.get(date);
    if (!ids || ids.size === 0) continue;
    let net = dec(0);
    let unpriced = 0;
    const nightRooms: PickPricing["nights"][number]["rooms"] = [];
    for (const id of ids) {
      const r = roomById.get(id)!;
      const tr = r.roomType ? typeRates.get(r.roomType.id) : undefined;
      const rate = tr?.rate ?? null;
      nightRooms.push({
        roomId: r.id,
        roomNumber: r.roomNumber,
        roomTypeId: r.roomType?.id ?? null,
        roomTypeName: r.roomType?.name ?? null,
        rate,
      });
      (roomDates.get(r.id) ?? roomDates.set(r.id, []).get(r.id)!).push(date);
      if (r.roomType) {
        const t = typeTally.get(r.roomType.id) ?? { nights: 0 };
        t.nights += 1;
        typeTally.set(r.roomType.id, t);
      }
      if (rate == null) unpriced += 1;
      else net = net.plus(dec(rate));
      roomNights += 1;
    }
    nightRooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
    // Compound, as every charge in the house: SC on the net, GST on net + SC.
    const nSc = round2(net.times(sc));
    const nGst = round2(net.plus(nSc).times(gst));
    stayNet = stayNet.plus(net);
    staySc = staySc.plus(nSc);
    stayGst = stayGst.plus(nGst);
    nights.push({ date, rooms: nightRooms, net: out(net), serviceCharge: out(nSc), gst: out(nGst), total: out(net.plus(nSc).plus(nGst)), unpricedRooms: unpriced });
  }

  const typeById = new Map(rooms.filter((r) => r.roomType).map((r) => [r.roomType!.id, r.roomType!]));
  const byType: PickPricing["byType"] = [...typeTally.entries()]
    .map(([roomTypeId, t]) => {
      const info = typeById.get(roomTypeId)!;
      const tr = typeRates.get(roomTypeId);
      return {
        roomTypeId,
        code: info.code ?? null,
        name: info.name,
        roomNights: t.nights,
        rate: tr?.rate ?? null,
        rateSource: tr?.source ?? null,
        packageName: tr?.packageName ?? null,
        net: tr?.rate == null ? null : out(dec(tr.rate).times(t.nights)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const byRoom: PickPricing["byRoom"] = [...roomDates.entries()]
    .map(([roomId, dates]) => {
      const r = roomById.get(roomId)!;
      return { roomId, roomNumber: r.roomNumber, roomTypeName: r.roomType?.name ?? null, dates: dates.sort() };
    })
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));

  return {
    entryId: entry.id,
    currency,
    serviceChargeRate,
    gstRate,
    party: party ? { type: party.type, name: party.name } : null,
    stayNights,
    nights,
    byType,
    byRoom,
    totals: { roomNights, net: out(stayNet), serviceCharge: out(staySc), gst: out(stayGst), total: out(stayNet.plus(staySc).plus(stayGst)) },
    unpricedTypes: byType.filter((t) => t.rate == null).map((t) => ({ roomTypeId: t.roomTypeId, name: t.name })),
  };
}
