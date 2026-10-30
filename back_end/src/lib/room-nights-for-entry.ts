/**
 * Which nights each room is held for, for the papers.
 *
 * A booking that moves rooms mid-stay prints one row per room, and without dates those rows read
 * as the same room over and over (2026-10-06, operator: "in quotation I think we need a date
 * column to show the dates reserved for the rooms like in the table for s2, or else it just looks
 * like it's repeating"). The desk's own table has shown this since the Dates column landed; this
 * is the same fact, read server-side so every document says it the same way.
 *
 * The source is the booking's sealed room selection — the pick the quotation was priced on. A seal
 * with no per-night shape (a plain booking, every room for the whole stay) gives every room the
 * stay's nights: the papers print the Nights column on every booking, one night or many, the rooms
 * the same every night or not (2026-10-30, operator: "make it like the 5th image").
 */
import type { PrismaClient } from "@prisma/client";
import { readOptionSelected } from "./option-selected-reader.js";

/** room id → the nights it is held for, as `YYYY-MM-DD`, ascending. */
export type RoomNights = Map<string, string[]>;

export async function roomNightsForEntry(
  prisma: PrismaClient,
  entryId: string,
  opts?: {
    /** Prefer a seal from this pass — a later pass's pick is not what this paper was priced on. */
    segmentId?: string | null;
    /** Prefer a seal made no later than this — the pick in force when the paper was made. */
    asOf?: Date | null;
  },
): Promise<RoomNights> {
  const configs = await prisma.availabilityConfiguration.findMany({
    where: { entryId, sealedAt: { not: null } },
    select: { optionSelected: true, sealedAt: true, segmentId: true },
    orderBy: { sealedAt: "desc" },
  });
  if (configs.length === 0) return new Map();

  const inSegment = opts?.segmentId ? configs.filter((c) => c.segmentId === opts.segmentId) : configs;
  const pool = inSegment.length ? inSegment : configs;
  const asOf = opts?.asOf ?? null;
  const chosen =
    (asOf ? pool.find((c) => c.sealedAt && c.sealedAt.getTime() <= asOf.getTime()) : null) ?? pool[0];

  const read = readOptionSelected(chosen.optionSelected);
  const perNight = read.perNight;
  const out: RoomNights = new Map();
  if (!perNight) {
    // Every room for the whole stay.
    const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { checkInDate: true, checkOutDate: true } });
    const all = stayNightDates(entry?.checkInDate ?? null, entry?.checkOutDate ?? null);
    if (all.length) for (const roomId of read.distinctRoomIds) out.set(roomId, all);
    return out;
  }
  for (const night of perNight) {
    const date = String(night.date ?? "").slice(0, 10);
    if (!date) continue;
    for (const roomId of night.roomIds) {
      out.set(roomId, [...(out.get(roomId) ?? []), date]);
    }
  }
  for (const [roomId, nights] of out) out.set(roomId, [...new Set(nights)].sort());
  return out;
}

/** The stay's nights as `YYYY-MM-DD`, check-in up to (not including) the check-out morning. */
export function stayNightDates(checkIn: Date | null | undefined, checkOut: Date | null | undefined): string[] {
  if (!checkIn || !checkOut) return [];
  const out: string[] = [];
  const end = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  let t = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  for (let i = 0; t < end && i < 400; i += 1, t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The nights a room is held for, each named (2026-10-30, operator: "in the nights column, show it
 * per room nights, not date range"): "30 Oct", "30, 31 Oct", "30, 31 Oct, 01 Nov". A range ended on
 * the check-out morning — "30 Oct – 01 Nov" for two nights — read as three days.
 */
export function labelRoomNights(nights: readonly string[]): string {
  const sorted = [...new Set(nights)].sort();
  const groups: Array<{ key: string; month: string; days: string[] }> = [];
  for (const n of sorted) {
    const d = new Date(`${n}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const last = groups[groups.length - 1];
    const day = String(d.getUTCDate()).padStart(2, "0");
    if (last && last.key === key) last.days.push(day);
    else groups.push({ key, month: MONTHS[d.getUTCMonth()], days: [day] });
  }
  return groups.map((g) => `${g.days.join(", ")} ${g.month}`).join(", ");
}
