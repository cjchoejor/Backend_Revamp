/**
 * Does a date of birth fit the guest row it was put on? (2026-10-23, operator: "if a child is 4y
 * the date of birth shouldn't be more or less than that; the same for adults, so the user doesn't
 * put a child in an adult's row — and if it's wrong, warn them".)
 *
 * The rows are the party as the booking states it — `Adult N` for each adult, `Child N (4y)` for
 * each child with the age given at intake (the same slots as `derivePartySlots`). The check is a
 * WARNING, never a refusal: the desk may still save the date, since the booking's stated age is
 * the thing that may be wrong.
 *
 * - A child's row fits when the guest is the stated age at some moment between the day the
 *   booking was made and the check-in day — so a birthday in between still fits.
 * - An adult's row fits from the legal adult age (`registry.child.unaccompaniedMinorMinAge`,
 *   18 by default): the intake's child ages run up to that age less one, so anyone younger
 *   belongs on a child row.
 * - Any row: a date after today, or one that makes the guest over 120, is a typing slip.
 *
 * Ages are counted on the hotel's calendar; stay dates are stored at UTC midnight and a date of
 * birth is a calendar date, so both are read on the UTC calendar.
 *
 * **What stops a booking (2026-11-25, operator: an adult's passport filed on a child's row and a
 * four-year-old's on an adult's row went through Check-in and on to Stay).** `blocks` marks the
 * mismatches that must be put right before Check-in completes and before the table is confirmed:
 * - a date that cannot be right (in the future, after the check-in day, over 120);
 * - a child's row whose date gives another price band than the age it was booked at (under 6,
 *   6 to 10, 11 and over — `registry.child.ageBands`): 64 on a row for a child of 5, or 6 for 5;
 * - an adult's row whose date gives a child's band (under 11): a four-year-old on an adult row.
 * A child a year off inside the same band, and an 11-to-17-year-old on an adult row (charged as
 * an adult either way), stay a warning.
 */
import type { PrismaClient } from "@prisma/client";
import { classifyAge, loadChildPolicyBundle } from "../services/domain/child-policy-service.js";
import { hotelTodayUtc } from "./stay-dates.js";

export type AgeCheck = {
  /** Full years on the check-in day (or today, for a booking with no dates). */
  ageAtCheckIn: number;
  ok: boolean;
  /** What the desk says when the date does not fit the row; null when it does. */
  message: string | null;
  /** Must be put right before Check-in completes and before the table is confirmed (2026-11-25). */
  blocks: boolean;
};

/** The price band an age falls in — the child policy's own cut (under 6 · 6 to 10 · 11 and over). */
export type AgeBandOf = (age: number) => "YOUNG_CHILD" | "CHILD" | "ADULT";

type SlotRule = { kind: "ADULT"; minAge: number } | { kind: "CHILD"; age: number } | { kind: "ANY" };

/** Full years from a date of birth to a day, both read on the UTC calendar. */
export function fullYears(dob: Date, at: Date): number {
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  const months = at.getUTCMonth() - dob.getUTCMonth();
  if (months < 0 || (months === 0 && at.getUTCDate() < dob.getUTCDate())) years--;
  return years;
}

function dobWords(dob: Date): string {
  return dob.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : v;
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The pure check — exported for the rule matrix. */
export function checkDobAgainstRule(
  dob: Date,
  rule: SlotRule,
  days: { today: Date; checkIn: Date; bookedOn: Date },
  bandOf?: AgeBandOf,
): AgeCheck {
  const age = fullYears(dob, days.checkIn);
  const born = `Born ${dobWords(dob)}`;
  if (dob.getTime() > days.today.getTime()) {
    return { ageAtCheckIn: age, ok: false, blocks: true, message: `${born} — that date is in the future. Check the year.` };
  }
  if (age < 0) {
    return { ageAtCheckIn: age, ok: false, blocks: true, message: `${born} — after the check-in day. Check the year.` };
  }
  if (age > 120) {
    return { ageAtCheckIn: age, ok: false, blocks: true, message: `${born} — that makes this guest ${age}. Check the year.` };
  }
  if (rule.kind === "CHILD") {
    const atBooking = fullYears(dob, days.bookedOn);
    const lo = Math.min(age, atBooking);
    const hi = Math.max(age, atBooking);
    if (rule.age >= lo && rule.age <= hi) return { ageAtCheckIn: age, ok: true, blocks: false, message: null };
    // Without the bands every mismatch counts; with them, only one that moves the price band.
    const blocks = bandOf ? bandOf(age) !== bandOf(rule.age) && bandOf(atBooking) !== bandOf(rule.age) : true;
    return {
      ageAtCheckIn: age,
      ok: false,
      blocks,
      message: `${born} — ${age} at check-in, but this row is for a child of ${rule.age}. Check the date, or whether this is the right guest's row.`,
    };
  }
  if (rule.kind === "ADULT" && age < rule.minAge) {
    return {
      ageAtCheckIn: age,
      ok: false,
      blocks: bandOf ? bandOf(age) !== "ADULT" : true,
      message: `${born} — ${age} at check-in, but this row is for an adult (${rule.minAge} or over). A child goes on a child row — check the date, or whether this is the right guest's row.`,
    };
  }
  return { ageAtCheckIn: age, ok: true, blocks: false, message: null };
}

/**
 * The check for one booking: `(subjectKey, dateOfBirth) → AgeCheck`, or null when there is no
 * date, or the key is not one of the party's rows.
 */
export async function partyAgeChecker(
  prisma: PrismaClient,
  entryId: string,
): Promise<(subjectKey: string | null | undefined, dob: Date | string | null | undefined) => AgeCheck | null> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { adultCount: true, childAges: true, guestCount: true, checkInDate: true, createdAt: true },
  });
  if (!entry) return () => null;
  const bundle = await loadChildPolicyBundle(prisma);
  const minAge = bundle.unaccompaniedMinor.minimumAge;
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  const broken = adults > 0 || childAges.length > 0;
  const today = hotelTodayUtc();
  const bookedOn = hotelTodayUtc(entry.createdAt);
  const checkIn = entry.checkInDate ?? today;
  const ruleFor = (key: string): SlotRule | null => {
    const m = /^([AK])(\d+)$/.exec(key);
    if (!m) return null;
    const i = Number(m[2]);
    if (m[1] === "K") return i < childAges.length ? { kind: "CHILD", age: childAges[i] } : null;
    if (!broken) return { kind: "ANY" };
    return i < adults ? { kind: "ADULT", minAge } : null;
  };
  const bandOf: AgeBandOf = (age) => classifyAge(age, bundle);
  return (subjectKey, dobIn) => {
    const dob = asDate(dobIn);
    if (!dob || !subjectKey) return null;
    const rule = ruleFor(subjectKey);
    if (!rule) return null;
    return checkDobAgainstRule(dob, rule, { today, checkIn, bookedOn }, bandOf);
  };
}

export type AgeMismatch = { subjectKey: string; label: string; message: string; blocks: boolean };

/**
 * Every row of this booking whose date of birth does not fit it (2026-11-25), with whether it must
 * be put right before Check-in. The label is the name typed on the row, else its slot ("Adult 5").
 */
export async function findAgeMismatches(prisma: PrismaClient, entryId: string): Promise<AgeMismatch[]> {
  const rows = await prisma.guestIdentityDocument.findMany({
    where: { entryId, storageKey: null, clearedAt: null, subjectKey: { not: null }, dateOfBirth: { not: null } },
    select: { subjectKey: true, subjectLabel: true, dateOfBirth: true },
  });
  if (!rows.length) return [];
  const check = await partyAgeChecker(prisma, entryId);
  const out: AgeMismatch[] = [];
  for (const r of rows) {
    const c = check(r.subjectKey, r.dateOfBirth);
    if (!c || c.ok || !c.message) continue;
    out.push({ subjectKey: r.subjectKey!, label: r.subjectLabel?.trim() || slotWords(r.subjectKey!), message: c.message, blocks: c.blocks });
  }
  return out.sort((a, b) => a.subjectKey.localeCompare(b.subjectKey, undefined, { numeric: true }));
}

/** "A4" → "Adult 5", "K0" → "Child 1" — the slot's own words when no name is typed. */
export function slotWords(key: string): string {
  const m = /^([AK])(\d+)$/.exec(key);
  if (!m) return key;
  return `${m[1] === "K" ? "Child" : "Adult"} ${Number(m[2]) + 1}`;
}
