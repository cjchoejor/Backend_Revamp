import { Prisma, type PrismaClient } from "@prisma/client";
import { getActiveConfigEntry } from "./config-store.js";
import { round2, toDecimal } from "./money.js";
import { hotelTodayUtc } from "./stay-dates.js";

/**
 * THE HOTEL'S CANCELLATION POLICY (2026-11-10, operator: the voucher's "45 days or more, 30 to 44
 * days, less than 30 days" is the hotel's real policy, "100%" meaning the whole advance paid; "keep
 * the rules editable in admin console, like the amount, the days range, and also enable and disable
 * cancellation"). Money.
 *
 * The one reading of `cancellation.policyTiers`: the charge (Policy 35), the copy a booking keeps of
 * it from Set up, and the words the voucher and its email print. Each line says how many days before
 * the arrival day it starts and what is kept: a share of the advance paid, or a set amount. The days
 * are counted on the hotel's calendar, as the voucher states them. A line saved before this counted
 * hours to the check-in time, and still does.
 *
 * Off (`enabled: false`), a cancellation before arrival costs nothing. A booking keeps the policy it
 * reached Set up under, so turning it off reaches the bookings set up from then on; a booking set up
 * before is waived by the GM, as any charge is.
 */

export type CancellationBasis = "PERCENT_OF_PAID" | "AMOUNT";

export type CancellationLine = {
  /** Whole days before the arrival day, on the hotel's calendar. */
  minDays: number | null;
  /** A line saved before 2026-11-10: hours to the check-in time. */
  minHours: number | null;
  basis: CancellationBasis;
  /** A percent of the advance paid (0–100), or Nu. */
  value: number;
};

export type CancellationPolicy = {
  enabled: boolean;
  usualAmount: number;
  beforeArrivalAmount: number | null;
  walkOutAmount: number | null;
  /** Farthest from the arrival first. */
  lines: CancellationLine[];
};

export type CancellationRule = {
  basis: CancellationBasis;
  value: number;
  /** "30 to 44 days before arrival · 50% of the advance paid" — printed on the cancellation paper. */
  label: string;
  /** The booking's own charge, the policy it was set up under, the setting as it is now, or none. */
  from: "BOOKING" | "BOOKING_TERMS" | "SETTING" | "NONE";
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Math.max(0, Number(v));
  return null;
}

const keyOf = (l: CancellationLine) => (l.minDays != null ? l.minDays * 24 : (l.minHours ?? 0));

/** The policy in a stored value, or null when there is none to read (a list left by an old save). */
export function readCancellationPolicy(raw: unknown): CancellationPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const lines: CancellationLine[] = [];
  for (const t of Array.isArray(o.tiers) ? o.tiers : []) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, unknown>;
    const minDays = num(r.minDaysBeforeArrival);
    const minHours = minDays == null ? num(r.minHoursBeforeCheckIn) : null;
    if (minDays == null && minHours == null) continue;
    const basis: CancellationBasis = r.basis === "PERCENT_OF_PAID" ? "PERCENT_OF_PAID" : "AMOUNT";
    const value = basis === "PERCENT_OF_PAID" ? Math.min(100, num(r.value) ?? 0) : (num(r.value) ?? num(r.penaltyAmount) ?? 0);
    lines.push({ minDays: minDays == null ? null : Math.floor(minDays), minHours, basis, value });
  }
  lines.sort((a, b) => keyOf(b) - keyOf(a));
  return {
    enabled: o.enabled !== false,
    usualAmount: num(o.sameDayPenaltyAmount) ?? 0,
    beforeArrivalAmount: num(o.preArrivalPenaltyAmount),
    walkOutAmount: num(o.postCheckInEarlyDeparturePenaltyAmount),
    lines,
  };
}

/** Whole days from the hotel's today to the arrival day (stored at UTC midnight). Negative once passed. */
export function daysBeforeArrival(now: Date, checkInDate: Date): number {
  const arrival = Date.UTC(checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate());
  return Math.round((arrival - hotelTodayUtc(now).getTime()) / 86_400_000);
}

const fmtNu = (n: number) => `Nu ${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const fmtPct = (n: number) => `${Number(n.toFixed(2))}%`;
const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const hourWord = (h: number) => (h % 24 === 0 && h > 0 ? dayWord(h / 24) : `${h} hour${h === 1 ? "" : "s"}`);

/** When a line applies, in words. `later`: the cancellation is nearer than every line. */
function whenWords(lines: CancellationLine[], i: number, later = false): string {
  const ln = lines[i]!;
  const prev = i > 0 ? lines[i - 1]! : null;
  if (ln.minDays == null) {
    const h = ln.minHours ?? 0;
    if (later) return h > 0 ? `less than ${hourWord(h)} before check-in` : "after the check-in time";
    if (!prev) return h > 0 ? `${hourWord(h)} or more before check-in` : "any time before check-in";
    const ph = prev.minDays != null ? prev.minDays * 24 : (prev.minHours ?? 0);
    return h > 0 ? `${hourWord(h)} to under ${hourWord(ph)} before check-in` : `less than ${hourWord(ph)} before check-in`;
  }
  const d = ln.minDays;
  if (later) return d > 0 ? `less than ${dayWord(d)} before arrival` : "after the arrival day";
  if (!prev) return d > 0 ? `${dayWord(d)} or more before arrival` : "any time before arrival";
  const pd = prev.minDays ?? Math.ceil((prev.minHours ?? 0) / 24);
  if (d === 0) return `less than ${dayWord(pd)} before arrival`;
  return d === pd - 1 ? `${dayWord(d)} before arrival` : `${d} to ${pd - 1} days before arrival`;
}

function chargeShort(basis: CancellationBasis, value: number): string {
  if (value <= 0) return "no charge";
  if (basis === "PERCENT_OF_PAID") return value >= 100 ? "the whole advance paid" : `${fmtPct(value)} of the advance paid`;
  return fmtNu(value);
}

function chargeLong(basis: CancellationBasis, value: number): string {
  if (value <= 0) return "the advance paid is refunded in full";
  if (basis === "PERCENT_OF_PAID") {
    return value >= 100 ? "the advance paid is kept, no refund" : `${fmtPct(value)} of the advance paid is kept, the rest refunded`;
  }
  return `${fmtNu(value)} is kept from the advance paid, the rest refunded`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Which line a cancellation pays, with its words. */
export function chooseCancellationRule(
  policy: CancellationPolicy | null,
  at: { daysBeforeArrival: number; hoursUntilCheckIn: number },
  from: CancellationRule["from"] = "SETTING",
): CancellationRule {
  if (!policy) return { basis: "AMOUNT", value: 0, label: "No cancellation charge is set", from: "NONE" };
  if (!policy.enabled) return { basis: "AMOUNT", value: 0, label: "No cancellation charge — the policy is off", from };
  const lines = policy.lines;
  if (lines.length) {
    const i = lines.findIndex((l) => (l.minDays != null ? at.daysBeforeArrival >= l.minDays : at.hoursUntilCheckIn >= (l.minHours ?? 0)));
    // Later than every line — nearer the arrival than the last line, or on and after it: the last
    // line applies (2026-11-10). The spec's lines run "far out to day-of-arrival" (DEV-SPEC-001
    // Part 12 §73), and the nearest line is that cover.
    const idx = i >= 0 ? i : lines.length - 1;
    const ln = lines[idx]!;
    return { basis: ln.basis, value: ln.value, label: `${cap(whenWords(lines, idx, i < 0))} · ${chargeShort(ln.basis, ln.value)}`, from };
  }
  const amount = policy.beforeArrivalAmount ?? policy.usualAmount;
  return { basis: "AMOUNT", value: amount, label: `Before arrival · ${chargeShort("AMOUNT", amount)}`, from };
}

/** The charge a rule puts on what was paid, to the chhertum. Not yet capped at the money held. */
export function cancellationChargeOn(rule: Pick<CancellationRule, "basis" | "value">, paid: Prisma.Decimal | number): number {
  if (rule.basis === "AMOUNT") return Number(round2(rule.value).toFixed(2));
  const base = toDecimal(paid);
  if (base.lte(0) || rule.value <= 0) return 0;
  return Number(round2(base.mul(rule.value).div(100)).toFixed(2));
}

/** The policy in sentences, for the voucher and its email. */
export function describeCancellationPolicy(policy: CancellationPolicy | null): string[] {
  const free = "Cancelling before arrival costs nothing: any advance paid is refunded in full.";
  if (!policy || !policy.enabled) return [free];
  const lines = policy.lines;
  if (lines.length) {
    const out = lines.map((ln, i) => {
      let when = whenWords(lines, i);
      // The last line also covers a cancellation nearer than it (and a no-show day, when it is above 0).
      if (i === lines.length - 1 && (ln.minDays ?? ln.minHours ?? 0) > 0) when += ", or nearer the arrival";
      return `${cap(when)}: ${chargeLong(ln.basis, ln.value)}.`;
    });
    if (lines.some((l) => l.basis === "AMOUNT" && l.value > 0)) out.push("A charge is never more than the advance paid.");
    return out;
  }
  const amount = policy.beforeArrivalAmount ?? policy.usualAmount;
  if (amount <= 0) return [free];
  return [`A cancellation before arrival costs ${fmtNu(amount)}, kept from the advance paid; the rest is refunded.`];
}

/**
 * The policy as a booking keeps it from Set up (2026-11-10): the setting's value as it was, so the
 * guest pays what they were told even if the setting changes later. Stored as `policy` on the
 * booking's cancellation terms, beside what the terms already carried.
 */
export function cancellationPolicySnapshot(setting: unknown, now: Date): Record<string, unknown> | null {
  const read = readCancellationPolicy(setting);
  if (!read) return null;
  return { ...(setting as Record<string, unknown>), takenAt: now.toISOString() };
}

/** The policy a booking's terms carry, else null (the setting as it is now then applies). */
export function policyInTerms(terms: Record<string, unknown> | null | undefined): unknown | null {
  const p = terms?.policy;
  return p && typeof p === "object" && !Array.isArray(p) ? p : null;
}

/**
 * The policy a booking's terms carry, in sentences (the voucher and its email): its own charge,
 * else the policy it keeps from Set up, else the setting as it is now.
 */
export async function cancellationWordsForTerms(db: Prisma.TransactionClient | PrismaClient, terms: unknown): Promise<string[]> {
  const t = terms && typeof terms === "object" && !Array.isArray(terms) ? (terms as Record<string, unknown>) : {};
  const own = num(t.sameDayPenaltyAmount ?? t.preArrivalPenaltyAmount ?? t.penaltyAmount) ?? 0;
  if (own > 0) return [`A cancellation before arrival costs ${fmtNu(own)}, kept from the advance paid; the rest is refunded.`];
  const setting = policyInTerms(t) ?? (await getActiveConfigEntry(db as PrismaClient, "cancellation.policyTiers"))?.configValue ?? null;
  return describeCancellationPolicy(readCancellationPolicy(setting));
}

/** Several stays' policies (a trip's voucher): one list when they read the same, else each stay's. */
export async function cancellationWordsForStays(db: Prisma.TransactionClient | PrismaClient, stays: Array<{ stayNo: number; terms: unknown }>): Promise<string[]> {
  const each = await Promise.all(stays.map(async (s) => ({ stayNo: s.stayNo, words: await cancellationWordsForTerms(db, s.terms) })));
  if (each.every((e) => e.words.join(" ") === each[0]?.words.join(" "))) return each[0]?.words ?? [];
  return each.map((e) => `Stay ${e.stayNo}: ${e.words.join(" ")}`);
}
