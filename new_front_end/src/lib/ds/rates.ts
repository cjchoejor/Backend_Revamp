/**
 * The frozen room rate in words (2026-09-18). A booking with two room types carries two rates;
 * `Reservation.frozenRate` is the booking's single headline rate and printed alone it misstated
 * every mixed-type booking. Each room's own per-night rate comes from the billing summary's
 * per-room rows (the backend's stored figures) — nothing here computes money, it only groups
 * and words the rates the server returned.
 */
import type { EntryBillingSummary } from "@/lib/api/entries";
import { money } from "./format";

export type RoomRate = { roomNumber: string | null; roomTypeName: string | null; rate: number };

/** Each priced room with its per-night rate, in room-number order; null when the booking has none. */
export function roomRatesOf(billing: EntryBillingSummary | null | undefined): RoomRate[] | null {
  const rows = (billing?.rooms ?? [])
    .filter((r) => r.roomRate != null)
    .map((r) => ({ roomNumber: r.roomNumber, roomTypeName: r.roomTypeName, rate: r.roomRate as number }))
    .sort((a, b) => (a.roomNumber ?? "").localeCompare(b.roomNumber ?? "", "en", { numeric: true }));
  return rows.length ? rows : null;
}

/**
 * One line: "Nu 3,500.00 / night" when every room shares the rate (or only the headline rate is
 * known), else each room's own — "Room 501 Nu 3,500.00 · Room 504 Nu 5,000.00 / night".
 */
export function rateWords(billing: EntryBillingSummary | null | undefined, headline: number | string | null | undefined, cur: string): string | null {
  const rooms = roomRatesOf(billing);
  if (rooms && new Set(rooms.map((r) => r.rate)).size > 1) {
    return `${rooms.map((r) => `Room ${r.roomNumber ?? "—"} ${money(r.rate, cur)}`).join(" · ")} / night`;
  }
  if (rooms) return `${money(rooms[0].rate, cur)} / night`;
  return headline != null ? `${money(headline, cur)} / night` : null;
}
