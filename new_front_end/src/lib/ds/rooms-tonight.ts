/**
 * What holds a room TONIGHT, read off the house chart's own claims (2026-10-27, moved here 2026-11-28
 * so the Rooms page and Today read tonight the same way). The room's stored flag marks the strongest
 * claim from today on — a booking a week away included — and can be left behind by a stay that ended
 * without a check-in; the dates are the truth, as on the chart.
 */
import type { RoomChart, RoomChartBar } from "@/lib/api/rooms";

/** Which claim wins when two bars cover the same room tonight. */
const RANK: Record<string, number> = { OVERSTAY: 6, IN_HOUSE: 5, RESERVED: 4, MOVING: 3, HELD: 3, EXTENSION_HELD: 2, PROVISIONAL: 1, CHECKED_OUT: 0 };

/** Each room's bar tonight (null when nothing holds it) and the next one after tonight. */
export function barsTonight(
  chart: RoomChart | undefined,
  today: string | null,
): Map<string, { now: RoomChartBar | null; next: RoomChartBar | null }> | null {
  if (!chart || !today) return null;
  const out = new Map<string, { now: RoomChartBar | null; next: RoomChartBar | null }>();
  for (const room of chart.rooms) {
    const bars = chart.bars.filter((b) => b.roomId === room.id && b.kind !== "CHECKED_OUT");
    const now = bars.filter((b) => b.from <= today && today < b.to).sort((a, b) => (RANK[b.kind] ?? 0) - (RANK[a.kind] ?? 0))[0] ?? null;
    const next = bars.filter((b) => b.from > today).sort((a, b) => a.from.localeCompare(b.from))[0] ?? null;
    out.set(room.id, { now, next });
  }
  return out;
}

/** A guest is in the room tonight (in house, or due out and still in). */
export const isInNow = (b: RoomChartBar | null) => !!b && (b.kind === "IN_HOUSE" || b.kind === "OVERSTAY");

/** A booking holds the room for tonight and its guest is not in yet. */
export const isComingTonight = (b: RoomChartBar | null) => !!b && (b.kind === "RESERVED" || b.kind === "MOVING" || b.kind === "EXTENSION_HELD");

/** Held for tonight, not confirmed: a block at Set up, or a provisional block at Negotiation. */
export const isHeldTonight = (b: RoomChartBar | null) => !!b && (b.kind === "HELD" || b.kind === "PROVISIONAL");
