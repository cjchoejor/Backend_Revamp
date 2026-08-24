import { PolicyGateBlockedError, StageGateBlockedError, ValidationError } from "../../lib/errors.js";
import { utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";

/**
 * Policy 36 - Early Departure Policy (DEV-SPEC Part 5 Policy 36; SIG-S7 Policy 36 / section 8.9;
 * SIG-S8 section 1.2 entry routes + Policy 36).
 *
 * "Guest departs before confirmed checkout date ... Early Departure mode compresses S7->S8; charges
 * for unstayed nights governed by cancellation/early departure policy against commitment
 * snapshot. GM authority required. Shortened stay charges are calculated against the original
 * commitment snapshot - the rate is not retrospectively renegotiated as a condition of early
 * departure. Configurable: early departure penalty terms per rate plan."
 *
 * Wired 2026-08-22 (was an orphan evaluator): the standard S7->S8 route refuses a departure ahead
 * of the booked checkout (`enforceDepartureNotBeforeBookedCheckout`), and the governed route
 * (`recordEarlyDeparture`) runs the in-house, authority and date-bound gates below.
 */

/** Early departure is only meaningful while in-stay - never after closure. */
export function enforceEarlyDepartureAllowed(input: { currentStage: string }) {
  if (input.currentStage === "S9") {
    throw new PolicyGateBlockedError("EARLY_DEPARTURE_POST_CLOSURE_FORBIDDEN", "Early departure is not applicable after closure");
  }
}

/** The governed route applies to an in-house guest: S7 only (S8 is already checking out). */
export function enforceEarlyDepartureInHouse(input: { currentStage: string }) {
  enforceEarlyDepartureAllowed(input);
  if (input.currentStage !== "S7") {
    throw new PolicyGateBlockedError(
      "EARLY_DEPARTURE_NOT_IN_HOUSE",
      `Early departure is recorded for an in-house guest (Stay step) - this booking is at ${input.currentStage}`,
    );
  }
}

/** GM (L3+) authority - Part 5 Policy 36 hardcoded rule; the actor level comes from the session. */
export function enforceEarlyDepartureAuthority(input: { actorLevel: string }) {
  if (input.actorLevel === "L3" || input.actorLevel === "L4") return;
  throw new PolicyGateBlockedError(
    "AUTH_REQUIRED_L3",
    "Recording an early departure needs GM authority (Policy 36) - a GM has to record it",
  );
}

/**
 * The STANDARD S7->S8 route presumes the guest slept every booked night. Before the booked
 * checkout day (hotel calendar) a departure is an early departure and must go through the
 * governed route, which shortens the stay first - after which this gate passes on its own.
 */
export function enforceDepartureNotBeforeBookedCheckout(input: { hotelToday: Date; checkOut: Date | null | undefined }) {
  if (!input.checkOut) return;
  const today = utcDateOnly(input.hotelToday).getTime();
  const booked = utcDateOnly(input.checkOut).getTime();
  if (today >= booked) return;
  throw new StageGateBlockedError(
    `The booked checkout is ${ymdUtc(input.checkOut)} and today is ${ymdUtc(input.hotelToday)} - leaving earlier is an early departure: record it on the Stay step (GM), which shortens the stay, then check out`,
    "EARLY_DEPARTURE_REQUIRED",
  );
}

/**
 * The departure date is bound to the stay: on or after check-in, strictly before the booked
 * checkout (otherwise it is not early), and never ahead of the hotel's today (the guest is
 * leaving now - a future shortening is a date amendment, not a departure).
 */
export function enforceEarlyDepartureDateWithinStay(input: {
  checkIn: Date;
  bookedCheckOut: Date;
  departure: Date;
  hotelToday: Date;
}) {
  const dep = utcDateOnly(input.departure).getTime();
  const ci = utcDateOnly(input.checkIn).getTime();
  const co = utcDateOnly(input.bookedCheckOut).getTime();
  const today = utcDateOnly(input.hotelToday).getTime();
  if (dep < ci) throw new ValidationError(`Departure ${ymdUtc(input.departure)} is before check-in ${ymdUtc(input.checkIn)}`);
  if (dep >= co) {
    throw new ValidationError(
      `Departure ${ymdUtc(input.departure)} is not before the booked checkout ${ymdUtc(input.bookedCheckOut)} - that is a normal checkout, not an early departure`,
    );
  }
  if (dep > today) {
    throw new ValidationError(
      `Departure ${ymdUtc(input.departure)} is ahead of today (${ymdUtc(input.hotelToday)}) - an early departure is recorded on the day the guest leaves`,
    );
  }
}

/**
 * SIG-S8 section 1.2: "night audit complete for all nights already stayed" - the slept nights must
 * be on the ledger before the stay is shortened, so the figures the guest settles are the audited
 * ones.
 */
export function enforceSleptNightsAuditedForEarlyDeparture(input: { missingNightYmds: string[] }) {
  if (input.missingNightYmds.length === 0) return;
  throw new PolicyGateBlockedError(
    "NIGHT_AUDITS_INCOMPLETE_FOR_EARLY_DEPARTURE",
    `Night audit not complete for the night(s) already stayed: ${input.missingNightYmds.join(", ")} - run them first`,
    { missingNightYmds: input.missingNightYmds },
  );
}
