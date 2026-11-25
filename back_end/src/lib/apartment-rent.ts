/**
 * An apartment's rent over a stay (2026-11-25, operator rulings) — ONE rule, read by the house, the
 * quotation and the bill.
 *
 * - **A month runs from the check-in date to the same date the month after** (calendar months, so
 *   February and leap years are the calendar's). A stay starting on the 29th–31st keeps its day: from
 *   31 Jan the months end 28 (or 29) Feb, 31 Mar, 30 Apr.
 * - **A week is seven nights.**
 * - **Nights left over** after the whole months are the monthly rate ÷ the nights of the month they
 *   fall in (the next whole month, as it would run) × the nights left; after whole weeks, the weekly
 *   rate ÷ 7 × the nights left. To the chhertum.
 * - **Which plan a stay may take**: monthly only for at least one whole month; weekly for at least
 *   seven nights; under seven nights the ordinary nightly rates (no plan).
 * - The rates here are WITHOUT service charge and GST. Each period is one line on the bill, taxed as a
 *   line (`lineTax`), so a month typed as Nu 48,000 with both in bills Nu 47,999.99.
 *
 * Dates are the hotel's stay dates, stored at UTC midnight; nothing here reads a clock.
 */
import { Prisma } from "@prisma/client";
import { round2, toDecimal, ZERO, type MoneyLike } from "./money.js";
import { lineTax, type PostingTaxRule } from "./stay-posting.js";

export const APARTMENT_PLANS = ["MONTHLY", "WEEKLY"] as const;
export type ApartmentPlan = (typeof APARTMENT_PLANS)[number];

const DAY = 86_400_000;

function utcDay(d: Date | string): Date {
  const x = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
export const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const nightsBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The check-in date `k` months on, keeping the check-in's day (or the month's last day). */
export function monthsOn(checkIn: Date | string, k: number): Date {
  const s = utcDay(checkIn);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth() + k;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return new Date(Date.UTC(yy, mm, Math.min(s.getUTCDate(), daysInMonth(yy, mm))));
}

/** Which plans a stay may take. */
export function plansForStay(checkIn: Date | string, checkOut: Date | string) {
  const ci = utcDay(checkIn);
  const co = utcDay(checkOut);
  const nights = nightsBetween(ci, co);
  const firstMonthEnds = monthsOn(ci, 1);
  return {
    nights,
    firstMonthEnds: ymdOf(firstMonthEnds),
    firstWeekEnds: ymdOf(new Date(ci.getTime() + 7 * DAY)),
    monthly: nights > 0 && co.getTime() >= firstMonthEnds.getTime(),
    weekly: nights >= 7,
  };
}

/** Why a plan cannot be taken for this stay, in words, or null when it can. */
export function planRefusal(plan: string | null | undefined, checkIn: Date | string, checkOut: Date | string): string | null {
  if (!plan) return null;
  const p = plansForStay(checkIn, checkOut);
  if (plan === "MONTHLY" && !p.monthly)
    return `A stay of ${p.nights} night${p.nights === 1 ? "" : "s"} is under a month — monthly needs the stay to run to ${p.firstMonthEnds} at least${p.weekly ? "; let it weekly" : ""}`;
  if (plan === "WEEKLY" && !p.weekly) return `A stay of ${p.nights} night${p.nights === 1 ? "" : "s"} is under a week — under seven nights is charged by the night`;
  if (plan !== "MONTHLY" && plan !== "WEEKLY") return `"${plan}" is not a way to let an apartment — monthly or weekly`;
  return null;
}

export type RentPeriod = {
  /** The first night of the period, and the morning it ends. */
  from: string;
  to: string;
  nights: number;
  /** The nights of the whole period these nights are a part of (7 for a week, the month's nights). */
  ofNights: number;
  whole: boolean;
  /** Without service charge and GST, to the chhertum. */
  net: string;
};

/** The periods of a stay under a plan, with their rent. `rate` is the plan's rate without taxes. */
export function rentPeriods(plan: ApartmentPlan, checkIn: Date | string, checkOut: Date | string, rate: MoneyLike): RentPeriod[] {
  const ci = utcDay(checkIn);
  const co = utcDay(checkOut);
  const r = toDecimal(rate);
  const out: RentPeriod[] = [];
  if (!(co.getTime() > ci.getTime())) return out;
  let start = ci;
  for (let k = 1; start.getTime() < co.getTime() && k < 1200; k++) {
    const end = plan === "MONTHLY" ? monthsOn(ci, k) : new Date(ci.getTime() + 7 * k * DAY);
    const ofNights = nightsBetween(start, end);
    if (end.getTime() <= co.getTime()) {
      out.push({ from: ymdOf(start), to: ymdOf(end), nights: ofNights, ofNights, whole: true, net: round2(r).toFixed(2) });
      start = end;
      continue;
    }
    const nights = nightsBetween(start, co);
    out.push({ from: ymdOf(start), to: ymdOf(co), nights, ofNights, whole: false, net: round2(r.mul(nights).div(ofNights)).toFixed(2) });
    start = co;
  }
  return out;
}

/** A stay's rent as the bill will read it: each period a line, its service charge and GST, the total. */
export function rentForStay(input: {
  plan: ApartmentPlan;
  checkIn: Date | string;
  checkOut: Date | string;
  weeklyRate: MoneyLike;
  monthlyRate: MoneyLike;
  rule: Pick<PostingTaxRule, "serviceChargeRate" | "gstRate">;
}) {
  const rate = input.plan === "MONTHLY" ? input.monthlyRate : input.weeklyRate;
  const periods = rentPeriods(input.plan, input.checkIn, input.checkOut, rate);
  let net: Prisma.Decimal = ZERO;
  let serviceCharge: Prisma.Decimal = ZERO;
  let gst: Prisma.Decimal = ZERO;
  const lines = periods.map((p) => {
    const t = lineTax(p.net, { serviceChargeApplies: true, gstApplies: true, ...input.rule });
    net = net.add(p.net);
    serviceCharge = serviceCharge.add(t.serviceCharge);
    gst = gst.add(t.gst);
    return { ...p, serviceCharge: t.serviceCharge.toFixed(2), gst: t.gst.toFixed(2), total: toDecimal(p.net).add(t.serviceCharge).add(t.gst).toFixed(2) };
  });
  return {
    plan: input.plan,
    periods: lines,
    net: net.toFixed(2),
    serviceCharge: serviceCharge.toFixed(2),
    gst: gst.toFixed(2),
    total: net.add(serviceCharge).add(gst).toFixed(2),
  };
}

/** A period in words: "10 Feb – 10 Mar 2027 · a month" or "10 Mar – 9 Apr 2027 · 30 of 31 nights". */
export function periodWords(p: Pick<RentPeriod, "from" | "to" | "nights" | "ofNights" | "whole">, plan: ApartmentPlan) {
  const fmt = (ymd: string, withYear: boolean) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  const span = `${fmt(p.from, p.from.slice(0, 4) !== p.to.slice(0, 4))} – ${fmt(p.to, true)}`;
  return p.whole ? `${span} · a ${plan === "MONTHLY" ? "month" : "week"}` : `${span} · ${p.nights} of ${p.ofNights} nights`;
}

/** One period of what the rent asks, over every apartment a booking lets (they share the plan and dates). */
export type RentAskPeriod = {
  plan: ApartmentPlan;
  from: string;
  to: string;
  nights: number;
  ofNights: number;
  whole: boolean;
  /** The period's rent with its service charge and GST, as the booking was priced. */
  total: Prisma.Decimal;
  units: string[];
  words: string;
};

/**
 * What the rent asks, period by period (2026-11-25, operator: "the money is asked like rent, at the
 * start of each period"). Read from the booking's own priced terms — the reservation's frozen terms,
 * else the quotation's — so the ask is exactly what the bill will post. Each period's own total is
 * used as stored (its service charge and GST worked out as one line); nothing is priced again here.
 * Empty when the booking is not let by the month or the week.
 */
export function rentScheduleFromTerms(terms: unknown): RentAskPeriod[] {
  const rows = (terms as { compositionTotals?: { perRoom?: unknown } } | null | undefined)?.compositionTotals?.perRoom;
  if (!Array.isArray(rows)) return [];
  const byFrom = new Map<string, RentAskPeriod>();
  for (const r of rows as Array<{ rent?: unknown }>) {
    const rent = r?.rent as { plan?: unknown; unitLabel?: unknown; periods?: unknown } | null | undefined;
    if (!rent || (rent.plan !== "MONTHLY" && rent.plan !== "WEEKLY") || !Array.isArray(rent.periods)) continue;
    for (const p of rent.periods as Array<Record<string, unknown>>) {
      if (!p || typeof p.from !== "string" || typeof p.to !== "string") continue;
      const from = p.from.slice(0, 10);
      const to = p.to.slice(0, 10);
      const total =
        p.total != null
          ? toDecimal(p.total as MoneyLike)
          : toDecimal((p.net ?? 0) as MoneyLike).add(toDecimal((p.serviceCharge ?? 0) as MoneyLike)).add(toDecimal((p.gst ?? 0) as MoneyLike));
      const seen = byFrom.get(from);
      if (seen) {
        seen.total = round2(seen.total.add(total));
        if (rent.unitLabel) seen.units.push(String(rent.unitLabel));
        continue;
      }
      const period = { from, to, nights: Number(p.nights) || 0, ofNights: Number(p.ofNights) || 0, whole: p.whole === true };
      byFrom.set(from, {
        plan: rent.plan,
        ...period,
        total: round2(total),
        units: rent.unitLabel ? [String(rent.unitLabel)] : [],
        words: periodWords(period, rent.plan),
      });
    }
  }
  return [...byFrom.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}
