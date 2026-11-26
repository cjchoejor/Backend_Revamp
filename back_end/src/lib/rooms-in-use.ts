/**
 * The rooms a booking is in — ONE rule for every screen and gate that names them (2026-11-26,
 * operator, on the hotel's Today list: ENT-20261124-0026 asked 3 rooms and listed 4 — "it is
 * showing the historical room, usually where rooms are swapped, changed or moved").
 *
 * A booking's room assignment rows are a history: a move in house end-dates the room left and
 * starts a row for the room entered, and a change the evening the guest arrived leaves a row
 * that starts and ends the same day (a room never slept in). Read as "the booking's rooms", that
 * history named rooms the guest had left — and the check-out gate demanded every one of them
 * still read OCCUPIED, though housekeeping had cleaned them and other guests were in them, so the
 * booking could never check out ("Room must be OCCUPIED to check out", found on three bookings).
 *
 * - **In house (S7)**: the rooms not yet left — a row with no end, or one ending after the hotel's
 *   today (the room the guest is in tonight, and any room booked for a later night of the stay).
 * - **At Check-out and after (S8, S9)**: the rooms the guest leaves at check-out — every row that
 *   runs to the checkout morning (the effective one: an early departure ends the stay sooner).
 * - **Otherwise** (before check-in, an ended booking): every room the booking sleeps in.
 *
 * A zero-night row is never one of the booking's rooms. When a rule leaves no room at all, the
 * wider set stands — naming no room says less than naming the ones it had.
 *
 * The desk carries the same rule (`roomsInUseFor` in new_front_end/src/lib/desk/party-rooms.ts) —
 * keep the two in step.
 */
import { effectiveCheckOutDate, hotelTodayUtc, type StayDateSource } from "./stay-dates.js";

export type RoomRow = { roomId: string; startDate: Date | null; endDate: Date | null };

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A row that starts and ends on the same day: a room the guest left before sleeping a night in it. */
export function isZeroNightRow(r: { startDate: Date | null; endDate: Date | null }): boolean {
  return !!r.startDate && !!r.endDate && ymd(r.startDate) >= ymd(r.endDate);
}

/** The rows of rooms the guest sleeps in: every row but a zero-night one (all, if that leaves none). */
export function sleptRows<T extends RoomRow>(rows: readonly T[]): T[] {
  const slept = rows.filter((r) => !isZeroNightRow(r));
  return slept.length ? slept : [...rows];
}

/** The rows that run to the checkout morning — the rooms the guest leaves at check-out. A row with
 *  no end runs to checkout; a dated row reaches it when it ends on (or after) the checkout morning.
 *  A row that starts and ends ON the checkout day counts: the guest moved rooms and left the same
 *  day, and that room is the one they leave. */
export function rowsAtCheckout<T extends RoomRow>(rows: readonly T[], checkout: Date | null): T[] {
  const slept = sleptRows(rows);
  if (!checkout) return slept;
  const at = rows.filter((r) => !r.endDate || ymd(r.endDate) >= ymd(checkout));
  return at.length ? at : slept;
}

/** The rows of the rooms the booking is in, by the rule above. */
export function rowsInUse<T extends RoomRow>(
  stage: string | null | undefined,
  rows: readonly T[],
  opts: { checkout: Date | null; hotelToday?: Date },
): T[] {
  if (stage === "S8" || stage === "S9") return rowsAtCheckout(rows, opts.checkout);
  const slept = sleptRows(rows);
  if (stage !== "S7") return slept;
  const today = ymd(opts.hotelToday ?? hotelTodayUtc());
  const live = slept.filter((r) => !r.endDate || ymd(r.endDate) > today);
  return live.length ? live : rowsAtCheckout(rows, opts.checkout);
}

/** The distinct room ids of `rowsInUse`, in the order the rows came. */
export function roomIdsInUse<T extends RoomRow>(
  stage: string | null | undefined,
  rows: readonly T[],
  opts: { checkout: Date | null; hotelToday?: Date },
): string[] {
  return [...new Set(rowsInUse(stage, rows, opts).map((r) => r.roomId))];
}

/** The checkout this rule reads — the effective one (an early departure ends the stay sooner). */
export function checkoutOf(e: StayDateSource): Date | null {
  return effectiveCheckOutDate(e);
}
