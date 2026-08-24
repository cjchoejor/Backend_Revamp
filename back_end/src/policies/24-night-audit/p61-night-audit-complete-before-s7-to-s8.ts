import { NightAuditRunStatus } from "@prisma/client";
import { PolicyGateBlockedError, StageGateBlockedError } from "../../lib/errors.js";
import { utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";

/**
 * Policy 61 — Night audit (SIG-S7→S8 slice).
 * Last operating date before checkout must have a COMPLETE night audit run.
 */
export function enforceNightAuditCompleteForLastOperatingDateBeforeS7ToS8(input: {
  nightAudit: { runStatus: NightAuditRunStatus | string } | null | undefined;
}) {
  if (input.nightAudit?.runStatus === NightAuditRunStatus.COMPLETE) return;
  throw new StageGateBlockedError("Night audit must be COMPLETE for last operating date before checkout", "NIGHT_AUDIT_NOT_COMPLETE");
}

/**
 * Policy 61 - a night audit covers a night that has ENDED on the hotel calendar (2026-08-22).
 *
 * Running it for today or a later date sealed a day that was still open: the desk used it to
 * audit the final night in the morning and check a guest out a day early through the standard
 * route - billing the unstayed night - and, because the NightAuditRecord is hotel-wide and the
 * run is idempotent, the real 02:00 run for that night then found the record and posted NOTHING
 * for every other in-house guest. A guest leaving before the booked checkout is an early
 * departure (Policy 36), recorded on the Stay step; it never needs a future night audited.
 */
export function enforceNightAuditOperatingDateEnded(input: { operatingDate: Date; hotelToday: Date }) {
  const op = utcDateOnly(input.operatingDate).getTime();
  const today = utcDateOnly(input.hotelToday).getTime();
  if (op < today) return;
  throw new PolicyGateBlockedError(
    "NIGHT_AUDIT_DATE_NOT_ENDED",
    `Night audit for ${ymdUtc(input.operatingDate)} can only run once that night has ended (the hotel day is ${ymdUtc(input.hotelToday)}). A guest leaving before the booked checkout is an early departure - record it on the Stay step, it needs no future night audited`,
    { operatingDate: ymdUtc(input.operatingDate), hotelToday: ymdUtc(input.hotelToday) },
  );
}

