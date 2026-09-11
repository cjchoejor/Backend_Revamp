import { Prisma } from "@prisma/client";
import { round2, toDecimal } from "./money.js";

/**
 * What a room's frozen stay total is MADE OF — accommodation vs meals (2026-09-11).
 *
 * The night audit posts a room's night from `RoomAssignment.frozenSubtotal`, which is one
 * combined figure: room + extra bed + meals. Two problems came out of that:
 *
 *   1. **The folio couldn't say what the money was for.** One "Night audit room charge" line
 *      carried the guest's dinner inside it, so a bill showing MAP+D listed no meal anywhere.
 *   2. **A silent under-charge.** The audit only trusted `frozenSubtotal` when the assignment
 *      row ALSO carried start/end dates; a plain single-room booking stores neither, so it fell
 *      back to `reservation.frozenRate` — the ROOM rate — and the meals were never billed at
 *      all. Settlement then refused, because p22 measures against the full composition
 *      (`SETTLEMENT_RATE_BASIS_MISMATCH`, found live on ENT-20260908-0001: 2,100 posted against
 *      2,650 expected — the 550 being exactly the un-posted MAP+D).
 *
 * The split lives on the **reservation's frozen commercial terms** (`compositionTotals.perRoom`),
 * which is immutable per segment and is the figure the guest was quoted — the right source. The
 * operative quotation is the fallback for bookings frozen before the terms were snapshotted.
 *
 * ## The money comes from the ROW, the proportion from the composition
 *
 * `RoomAssignment.frozenSubtotal` stays authoritative for HOW MUCH — an in-house setup change
 * re-freezes a row for its own window, and that figure must win. The composition supplies only
 * the RATIO of meals to accommodation, scaled so the two parts sum back to the row's own total
 * to the cent. In the ordinary case the scale is exactly 1 and nothing moves.
 *
 * `nights` comes from the composition when the row carries no dates — which is what stops the
 * audit falling back to the room-only rate, and is the actual fix for (2).
 */
export type FrozenRoomSplit = {
  roomId: string;
  /** Nights the frozen figures cover. Never 0. */
  nights: number;
  /** Room + extra bed, NET. What a ROOM_CHARGE line should carry. */
  accommodation: Prisma.Decimal;
  /** Meal plans / à-la-carte covers, NET. What an F&B line should carry. Often zero. */
  meals: Prisma.Decimal;
  /** accommodation + meals — equals the row's `frozenSubtotal` when one was supplied. */
  subtotal: Prisma.Decimal;
};

type PerRoomRow = {
  roomId?: unknown;
  nights?: unknown;
  subtotal?: unknown;
  roomSubtotal?: unknown;
  roomRate?: unknown;
  extraBedSubtotal?: unknown;
  mealsSubtotal?: unknown;
};

function perRoomRows(terms: Prisma.JsonValue | null | undefined): PerRoomRow[] {
  const rows = (terms as { compositionTotals?: { perRoom?: unknown } } | null | undefined)?.compositionTotals?.perRoom;
  return Array.isArray(rows) ? (rows as PerRoomRow[]) : [];
}

const n = (v: unknown): number => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : 0;
};

/**
 * Read the frozen per-room composition for a booking, newest authority first.
 *
 * Pass the reservation's `frozenCommercialTerms` and, as a fallback, the operative quotation's
 * `commercialTerms`. Returns a map keyed by roomId; a room missing from the composition simply
 * has no entry, and the caller keeps whatever it does today.
 */
export function frozenCompositionByRoom(
  sources: Array<Prisma.JsonValue | null | undefined>,
): Map<string, { nights: number; subtotal: number; accommodation: number; meals: number }> {
  const out = new Map<string, { nights: number; subtotal: number; accommodation: number; meals: number }>();
  for (const terms of sources) {
    for (const r of perRoomRows(terms)) {
      const roomId = typeof r.roomId === "string" ? r.roomId : null;
      if (!roomId || out.has(roomId)) continue;
      const nights = Math.max(1, Math.round(n(r.nights) || 1));
      const meals = n(r.mealsSubtotal);
      // `roomSubtotal` is the modern field; older rows carry only `roomRate` (per night).
      const room = r.roomSubtotal != null ? n(r.roomSubtotal) : n(r.roomRate) * nights;
      const bed = n(r.extraBedSubtotal);
      const subtotal = r.subtotal != null ? n(r.subtotal) : room + bed + meals;
      out.set(roomId, { nights, subtotal, accommodation: room + bed, meals });
    }
  }
  return out;
}

/**
 * Split ONE assignment row's frozen money into accommodation and meals.
 *
 * `rowSubtotal` wins on the total; the composition only decides the proportion. Returns null
 * when there is nothing to split — a legacy row with no composition anywhere — and the caller
 * falls back to whatever it did before (the flat `frozenRate`).
 */
export function splitFrozenRow(input: {
  roomId: string;
  rowSubtotal: Prisma.Decimal | number | string | null | undefined;
  rowNights: number | null;
  composition: { nights: number; subtotal: number; accommodation: number; meals: number } | undefined;
}): FrozenRoomSplit | null {
  const comp = input.composition;
  const rowHas = input.rowSubtotal != null;
  if (!rowHas && !comp) return null;

  // Nights: the row's own count when it has dates, else the composition's. Never zero.
  const nights = Math.max(1, Math.round(input.rowNights && input.rowNights > 0 ? input.rowNights : comp?.nights ?? 1));

  const subtotal = round2(toDecimal(rowHas ? input.rowSubtotal : comp!.subtotal));
  if (!comp || !(comp.subtotal > 0)) {
    // No usable proportion — treat the whole figure as accommodation, which is what the folio
    // has always shown. Never invent a meal charge out of nothing.
    return { roomId: input.roomId, nights, accommodation: subtotal, meals: toDecimal(0), subtotal };
  }

  // Scale the composition's parts onto the row's own total (scale is 1 in the normal case).
  const scale = subtotal.div(toDecimal(comp.subtotal));
  const meals = round2(toDecimal(comp.meals).mul(scale));
  // Accommodation takes the remainder, so the two ALWAYS sum to the row's total to the cent.
  const accommodation = round2(subtotal.sub(meals));
  return { roomId: input.roomId, nights, accommodation, meals, subtotal };
}
