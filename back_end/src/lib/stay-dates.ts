import { HOTEL_TIMEZONE } from "../services/infrastructure/pdf-templates/legphel-document-format.js";

/**
 * Stay-date helpers shared by every reader of "when does this stay end" (2026-08-22).
 *
 * Two facts live here:
 *
 *  1. The hotel's calendar day. Stay dates are stored as UTC-midnight calendar dates
 *     (frozenCheckInDate, frozenCheckOutDate, NightAuditRecord.operatingDate), but whether
 *     "today" IS the checkout day, or whether last night has ENDED, is a question about the
 *     hotel's own clock - Thimphu is UTC+6, so between midnight and 06:00 local the UTC date is
 *     still yesterday. hotelTodayUtc() answers it: the hotel-local calendar date, expressed as
 *     the UTC-midnight Date the stored columns use, so the two compare directly.
 *
 *  2. The effective checkout. The Reservation row is immutable, so when a guest leaves early
 *     (Policy 36) the real end of the stay lives on Entry.actualCheckOutDate. Every consumer
 *     that used to read `reservation.frozenCheckOutDate ?? entry.checkOutDate` reads
 *     effectiveCheckOutDate(entry) instead - the S7->S8 gate, the settlement windows, the
 *     inventory claim, the billing summary, the statements. Keep them on this helper.
 */

const DAY_MS = 86_400_000;

export function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addUtcDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 0, 0, 0, 0));
}

/** Whole nights between two calendar dates (exclusive end); never negative. */
export function nightsBetweenUtc(from: Date, to: Date): number {
  return Math.max(0, Math.round((utcDateOnly(to).getTime() - utcDateOnly(from).getTime()) / DAY_MS));
}

/** Every stay night's operating date (ISO yyyy-mm-dd) in [checkIn, checkOut). */
export function listNightYmdsUtc(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  let d = utcDateOnly(checkIn);
  const end = utcDateOnly(checkOut);
  while (d.getTime() < end.getTime()) {
    out.push(ymdUtc(d));
    d = addUtcDays(d, 1);
  }
  return out;
}

/** The hotel-local calendar date (yyyy-mm-dd) for an instant - HOTEL_TIMEZONE, default Asia/Thimphu. */
export function hotelCalendarYmd(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOTEL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** The hotel-local calendar date as a UTC-midnight Date - comparable with the stored stay dates. */
export function hotelTodayUtc(at: Date = new Date()): Date {
  const [y, m, d] = hotelCalendarYmd(at).split("-").map((x) => Number(x));
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/** HOTEL_TIMEZONE's offset from UTC at `at`, in ms (Bhutan has no DST, so this is constant). */
function hotelOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HOTEL_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const hour = n("hour") % 24; // some ICU builds render midnight as "24"
  return Date.UTC(n("year"), n("month") - 1, n("day"), hour, n("minute"), n("second")) - at.getTime();
}

/**
 * The instant the hotel-local calendar day CONTAINING `at` ends - i.e. the next local midnight.
 *
 * Stay dates are stored at UTC midnight, which is already 06:00 in Bhutan - so "stored date +
 * 24h" overshoots the end of that day by six hours and lands in the next one. The end of a
 * hotel day is a question about the hotel's clock, so it goes through the timezone.
 *
 * (Corrected 2026-09-17: an earlier version of this note claimed some rows were stored at the
 * hotel's local midnight instead. That was a misreading - node-postgres renders a timestamp
 * column in the process's zone. Every stay date on the database is UTC midnight.)
 */
export function hotelDayEndUtc(at: Date): Date {
  const [y, m, d] = hotelCalendarYmd(at).split("-").map((x) => Number(x));
  return new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - hotelOffsetMs(at));
}

/**
 * The instant a hotel-local time of day falls on a stored calendar date (2026-09-18) — e.g. the
 * check-in date at 14:00 in Thimphu. Stay dates are stored at UTC midnight, which is 06:00 in
 * Bhutan, so "stored date + 14h" would land at 20:00 local; the time goes through the timezone.
 */
export function hotelLocalTimeOn(dateUtcMidnight: Date, hhmm: string): Date {
  const [y, m, d] = ymdUtc(dateUtcMidnight).split("-").map((x) => Number(x));
  const [hh, mm] = hhmm.split(":").map((x) => Number(x));
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  return new Date(asIfUtc - hotelOffsetMs(new Date(asIfUtc)));
}

export type StayDateSource = {
  checkInDate?: Date | null;
  checkOutDate?: Date | null;
  /** Early departure (Policy 36): the day the guest actually left, when earlier than booked. */
  actualCheckOutDate?: Date | null;
  reservation?: { frozenCheckInDate: Date; frozenCheckOutDate: Date } | null;
};

export function effectiveCheckInDate(e: StayDateSource): Date | null {
  return e.reservation?.frozenCheckInDate ?? e.checkInDate ?? null;
}

/**
 * The day the stay really ends: the early-departure date when one is recorded (and earlier
 * than booked), else the frozen checkout, else the intake checkout.
 */
export function effectiveCheckOutDate(e: StayDateSource): Date | null {
  const booked = e.reservation?.frozenCheckOutDate ?? e.checkOutDate ?? null;
  const actual = e.actualCheckOutDate ?? null;
  if (actual && (!booked || actual.getTime() < booked.getTime())) return actual;
  return booked;
}
