import type { Prisma, PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "./errors.js";
import { hotelDayEndUtc, hotelTodayUtc } from "./stay-dates.js";

/** A booking with no dates at all has no check-in to run to. */
const NO_DATES_MAX_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type QuoteValidityWindow = { mode: "DAYS" | "HOURS"; max: number; checkIn: string | null };

/**
 * How long a quotation may stand (2026-11-05, operator: "the validity of the quote will be till the
 * check in date. so the user can set the valid days for before it so can decrease it but not increase
 * it. but say if there is a walk in or someone does reservation for today's date then, user can set
 * number of hrs"). This is the hotel's rule, with no setting: it replaced `registry.quotationValidity.days`
 * and `expiry.s2.quotationValidityDays`. The Negotiation clock runs on the same rule
 * (`lib/negotiation-expiry.ts`), so it lives here and not in the quotation service.
 *
 *  - Check-in on a later day: whole days, up to the days from the hotel's today to the check-in date.
 *  - Check-in today, or gone by: whole hours, up to what is left of the hotel's day; always at least one,
 *    so a walk-in at 11:30 at night can still be quoted.
 *
 * Both are the hotel's calendar, never the machine's (`hotelTodayUtc`).
 */
export async function quoteValidityWindow(
  db: Prisma.TransactionClient | PrismaClient,
  entryId: string,
  now: Date = new Date(),
): Promise<QuoteValidityWindow> {
  const entry = await db.entry.findUnique({ where: { id: entryId }, select: { checkInDate: true } });
  if (!entry) throw new NotFoundError("Entry");
  const checkIn = entry.checkInDate;
  if (!checkIn) return { mode: "DAYS", max: NO_DATES_MAX_DAYS, checkIn: null };
  const ymd = checkIn.toISOString().slice(0, 10);
  const daysAhead = Math.round((Date.parse(`${ymd}T00:00:00.000Z`) - hotelTodayUtc(now).getTime()) / DAY_MS);
  if (daysAhead >= 1) return { mode: "DAYS", max: daysAhead, checkIn: ymd };
  const left = hotelDayEndUtc(now).getTime() - now.getTime();
  return { mode: "HOURS", max: Math.max(1, Math.floor(left / HOUR_MS)), checkIn: ymd };
}

/** The moment `count` days or hours from now. Days run from now, so the longest ends on the check-in date at the time of day it was made. */
export function quoteStandsUntil(mode: QuoteValidityWindow["mode"], count: number, now: Date): Date {
  return new Date(now.getTime() + count * (mode === "HOURS" ? HOUR_MS : DAY_MS));
}

/**
 * How long a paper stands: what the desk asked for, inside the window, else the longest (2026-11-05 — a
 * proforma runs on the quote's rule). More than the window allows is refused, naming the most it can be.
 */
export async function resolveStandsUntil(
  db: Prisma.TransactionClient | PrismaClient,
  entryId: string,
  ask: { validDays?: number; validHours?: number },
  now: Date,
  what: "quote" | "proforma",
): Promise<{ validUntil: Date }> {
  const window = await quoteValidityWindow(db, entryId, now);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (window.mode === "HOURS") {
    if (ask.validDays != null) throw new ValidationError(`Check-in is today, so set how long the ${what} stands in hours, at most ${plural(window.max, "hour")}`);
    const hours = ask.validHours ?? window.max;
    if (!Number.isInteger(hours) || hours < 1 || hours > window.max) {
      throw new ValidationError(`A ${what} for a stay starting today stands for 1 to ${plural(window.max, "hour")}, the rest of today`);
    }
    return { validUntil: quoteStandsUntil("HOURS", hours, now) };
  }
  if (ask.validHours != null) throw new ValidationError(`Check-in is on a later day, so set how long the ${what} stands in days, at most ${plural(window.max, "day")}`);
  const days = ask.validDays ?? window.max;
  if (!Number.isInteger(days) || days < 1 || days > window.max) {
    throw new ValidationError(
      window.checkIn
        ? `A ${what} stands until check-in at the latest: 1 to ${plural(window.max, "day")} (check-in ${window.checkIn})`
        : `A ${what} stands for 1 to ${plural(window.max, "day")}`,
    );
  }
  return { validUntil: quoteStandsUntil("DAYS", days, now) };
}
