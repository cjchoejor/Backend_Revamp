import { ValidationError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability query parameter gate (SIG-S1 §4, §6.3 `AvailabilityService.query()`).
 *
 * Engine receives resolved data; this policy only validates **shape** of the query before DB/engine work.
 */
export function enforceAvailabilityQueryParamsForS1(input: {
  checkInDate: string;
  checkOutDate: string;
  guestCount?: number | null;
}): { checkIn: Date; checkOut: Date; guestCount: number } {
  if (!input.checkInDate?.trim() || !input.checkOutDate?.trim()) {
    throw new ValidationError("checkInDate and checkOutDate are required");
  }
  const checkIn = new Date(input.checkInDate);
  const checkOut = new Date(input.checkOutDate);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime())) {
    throw new ValidationError("Invalid checkInDate or checkOutDate");
  }
  if (checkIn.getTime() >= checkOut.getTime()) {
    throw new ValidationError("checkInDate must be before checkOutDate");
  }
  const gc = input.guestCount;
  if (gc != null) {
    if (!Number.isFinite(gc) || gc < 1) {
      throw new ValidationError("guestCount must be a positive integer when provided");
    }
  }
  return { checkIn, checkOut, guestCount: gc != null && Number.isFinite(gc) ? Math.floor(gc) : 1 };
}
