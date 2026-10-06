/**
 * Which nights each room is held for, for the papers.
 *
 * A booking that moves rooms mid-stay prints one row per room, and without dates those rows read
 * as the same room over and over (2026-10-06, operator: "in quotation I think we need a date
 * column to show the dates reserved for the rooms like in the table for s2, or else it just looks
 * like it's repeating"). The desk's own table has shown this since the Dates column landed; this
 * is the same fact, read server-side so every document says it the same way.
 *
 * The source is the booking's sealed room selection — the pick the quotation was priced on. When
 * the seal carries no per-night shape (a plain booking, every room for the whole stay) the map
 * comes back empty and the papers print no Dates column: the Stay line above already says it, and
 * repeating it on every row is the noise the operator was objecting to.
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

  const perNight = readOptionSelected(chosen.optionSelected).perNight;
  const out: RoomNights = new Map();
  if (!perNight) return out;
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

/**
 * True when the rooms are NOT all held for the same nights — the only case worth a Dates column.
 * A booking where every room runs the whole stay says it once, on the Stay line.
 */
export function roomNightsVary(map: RoomNights): boolean {
  const keys = [...map.keys()];
  if (keys.length < 2) return false;
  const first = (map.get(keys[0]) ?? []).join(",");
  return keys.some((k) => (map.get(k) ?? []).join(",") !== first);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "06–08 Oct" for consecutive nights, "06 Oct · 09 Oct" when they are not — the END is the
 * checkout morning, so two nights from the 6th read "06–08 Oct". Several spans join with " · ",
 * which is how a room kept for the first and third nights is told from one kept for both.
 */
export function labelRoomNights(nights: readonly string[]): string {
  const sorted = [...new Set(nights)].sort();
  if (sorted.length === 0) return "";
  const spans: Array<[string, string]> = [];
  for (const n of sorted) {
    const last = spans[spans.length - 1];
    if (last && nextDay(last[1]) === n) last[1] = n;
    else spans.push([n, n]);
  }
  return spans.map(([from, to]) => span(from, nextDay(to))).join(" · ");
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function span(fromIso: string, toIso: string): string {
  const from = new Date(`${fromIso}T00:00:00.000Z`);
  const to = new Date(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return fromIso;
  const dd = (d: Date) => String(d.getUTCDate()).padStart(2, "0");
  if (from.getUTCMonth() === to.getUTCMonth() && from.getUTCFullYear() === to.getUTCFullYear()) {
    return `${dd(from)}–${dd(to)} ${MONTHS[to.getUTCMonth()]}`;
  }
  return `${dd(from)} ${MONTHS[from.getUTCMonth()]} – ${dd(to)} ${MONTHS[to.getUTCMonth()]}`;
}
