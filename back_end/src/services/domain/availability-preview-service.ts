/**
 * "What has the house got for these dates?" — answered while the operator is still typing them
 * (2026-10-07, for the second screen).
 *
 * The Inquiry step's "Ask the house" runs the availability engine AND records the search
 * (`queryAvailability` writes an AvailabilityConfiguration), so it cannot run on every keystroke.
 * This runs the same engine — `runAvailabilityEngineForEntry`, which only reads — and writes
 * nothing. The second screen calls it for the dates and party typed on the desk, before they are
 * saved, so the operator on the phone can tell the guest at once whether the stay fits, at what
 * price, and which nights are tight.
 *
 * Per room type: the rooms free on EVERY night (what can be sold for the whole stay), the rooms
 * free night by night, the per-night rate the engine already resolves for the booking (the party's
 * package when one is linked, else the type's own rate plan), and that rate over the stay — net and
 * with the house's service charge and GST, both worked out here in Decimal so the desk never adds
 * money up. When the stay does not fit, the same stay a day or two either side is checked too.
 *
 * Nothing here is a quote: the figures are indicative, exactly as the Inquiry step's own.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { runAvailabilityEngineForEntry } from "./s1-availability-service.js";

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

export type AvailabilityPreviewType = {
  roomTypeId: string;
  name: string;
  /** Rooms of this type the house sells (shadow inventory left out). */
  roomsInType: number;
  maxCapacity: number | null;
  /** Free on every night of the stay — what can be sold for the whole stay. */
  freeEveryNight: number;
  freeByNight: Array<{ date: string; free: number }>;
  /** Per night, before service charge and GST; null when no rate resolves for the type. */
  rate: number | null;
  rateSource: string | null;
  /** One room for the whole stay, before tax and with service charge + GST. */
  stayPerRoomNet: number | null;
  stayPerRoomWithTax: number | null;
};

export type AvailabilityPreview = {
  checkInDate: string;
  checkOutDate: string;
  nights: string[];
  roomsNeeded: number;
  guestCount: number;
  currency: string;
  serviceChargeRate: number;
  gstRate: number;
  /** Rooms free on every night, all types together. */
  freeEveryNight: number;
  /** True when at least `roomsNeeded` rooms are free on every night. */
  fits: boolean;
  /** Nights with fewer free rooms than needed. */
  shortNights: Array<{ date: string; free: number }>;
  types: AvailabilityPreviewType[];
  /** The same length of stay a day or two either side — only when this one does not fit. */
  nearby: Array<{ checkInDate: string; checkOutDate: string; freeEveryNight: number; fits: boolean }>;
};

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const dayOf = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

type Chip = { rateAmount?: number; source?: string; currency?: string } | null | undefined;

export async function previewAvailabilityForEntry(
  prisma: PrismaClient,
  entryId: string,
  input: { checkInDate: string; checkOutDate: string; guestCount?: number; roomsNeeded?: number },
  actorLevel: ActorLevel,
): Promise<AvailabilityPreview> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, guestCount: true, useType: true, otaSource: true, inquiryId: true, numberOfRooms: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const checkIn = dayOf(input.checkInDate);
  const checkOut = dayOf(input.checkOutDate);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    throw new ValidationError("Give a check-in before the check-out.");
  }
  const stayNights = Math.round((checkOut.getTime() - checkIn.getTime()) / DAY);
  if (stayNights > 60) throw new ValidationError("Stays longer than 60 nights are checked with Ask the house.");
  const roomsNeeded = Math.max(1, Math.floor(input.roomsNeeded ?? entry.numberOfRooms ?? 1));
  const guestCount = Math.max(1, Math.floor(input.guestCount ?? entry.guestCount ?? 1));

  const [roomTypes, rooms, rates] = await Promise.all([
    prisma.roomType.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, maxCapacity: true } }),
    prisma.room.findMany({ select: { id: true, roomTypeId: true, isShadowInventory: true } }),
    resolveChargeRates(prisma),
  ]);
  const sold = rooms.filter((r) => !r.isShadowInventory);
  const typeOfRoom = new Map(sold.map((r) => [r.id, r.roomTypeId]));

  const run = async (from: Date, to: Date) => {
    const { engineOut } = await runAvailabilityEngineForEntry(
      prisma,
      entry,
      { checkInDate: from.toISOString(), checkOutDate: to.toISOString(), guestCount },
      actorLevel,
    );
    return engineOut as unknown as {
      availableRooms: Array<{ inventoryId: string; roomTypeId: string; pricingIndicative?: Chip }>;
      deficientRooms: Array<{ inventoryId: string; roomTypeId: string; pricingIndicative?: Chip }>;
      perDate?: Array<{ date: string; availableRoomIds: string[] }>;
    };
  };

  const out = await run(checkIn, checkOut);
  const nights = Array.from({ length: stayNights }, (_, i) => ymd(new Date(checkIn.getTime() + i * DAY)));
  const freeOn = new Map<string, Set<string>>();
  for (const p of out.perDate ?? []) freeOn.set(String(p.date).slice(0, 10), new Set(p.availableRoomIds.filter((id) => typeOfRoom.has(id))));
  const wholeStay = out.availableRooms.filter((r) => typeOfRoom.has(r.inventoryId));

  const chipOf = new Map<string, Chip>();
  for (const r of [...out.availableRooms, ...out.deficientRooms]) if (r.pricingIndicative && !chipOf.has(r.roomTypeId)) chipOf.set(r.roomTypeId, r.pricingIndicative);

  const withTax = (net: Prisma.Decimal) =>
    net.mul(new Prisma.Decimal(1).add(rates.serviceChargeRate)).mul(new Prisma.Decimal(1).add(rates.gstRate)).toDecimalPlaces(2);
  let currency = "BTN";

  const types: AvailabilityPreviewType[] = roomTypes
    .map((t): AvailabilityPreviewType | null => {
      const inType = sold.filter((r) => r.roomTypeId === t.id);
      if (inType.length === 0) return null;
      const chip = chipOf.get(t.id) ?? null;
      if (chip?.currency) currency = chip.currency;
      const rate = typeof chip?.rateAmount === "number" ? chip.rateAmount : null;
      const net = rate != null ? new Prisma.Decimal(rate).mul(stayNights).toDecimalPlaces(2) : null;
      return {
        roomTypeId: t.id,
        name: t.name,
        roomsInType: inType.length,
        maxCapacity: t.maxCapacity,
        freeEveryNight: wholeStay.filter((r) => r.roomTypeId === t.id).length,
        freeByNight: nights.map((date) => ({
          date,
          free: [...(freeOn.get(date) ?? [])].filter((id) => typeOfRoom.get(id) === t.id).length,
        })),
        rate,
        rateSource: chip?.source ?? null,
        stayPerRoomNet: net != null ? net.toNumber() : null,
        stayPerRoomWithTax: net != null ? withTax(net).toNumber() : null,
      };
    })
    .filter((x): x is AvailabilityPreviewType => !!x)
    .sort((a, b) => b.freeEveryNight - a.freeEveryNight || a.name.localeCompare(b.name));

  const freeEveryNight = wholeStay.length;
  const shortNights = nights
    .map((date) => ({ date, free: (freeOn.get(date) ?? new Set()).size }))
    .filter((n) => n.free < roomsNeeded);
  const fits = freeEveryNight >= roomsNeeded;

  const nearby: AvailabilityPreview["nearby"] = [];
  if (!fits) {
    const today = hotelTodayUtc();
    for (const shift of [-2, -1, 1, 2]) {
      const from = new Date(checkIn.getTime() + shift * DAY);
      if (from < today) continue;
      const to = new Date(checkOut.getTime() + shift * DAY);
      const alt = await run(from, to);
      const free = alt.availableRooms.filter((r) => typeOfRoom.has(r.inventoryId)).length;
      nearby.push({ checkInDate: ymd(from), checkOutDate: ymd(to), freeEveryNight: free, fits: free >= roomsNeeded });
    }
  }

  return {
    checkInDate: ymd(checkIn),
    checkOutDate: ymd(checkOut),
    nights,
    roomsNeeded,
    guestCount,
    currency,
    serviceChargeRate: rates.serviceChargeRate,
    gstRate: rates.gstRate,
    freeEveryNight,
    fits,
    shortNights,
    types,
    nearby,
  };
}
