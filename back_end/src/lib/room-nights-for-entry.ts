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
 * How a paper writes a room's nights (2026-10-30, operator — a choice when the paper is made, like
 * "without prices"): SHORT, the default, writes three or more nights in a row as the first and the
 * last night ("10–19 Mar"); EACH names every night ("10, 11, 12 Mar").
 */
export type NightsMode = "SHORT" | "EACH";

/** `?nights=each` / `nightsEach: true` → EACH; anything else the default. */
export function readNightsMode(v: unknown): NightsMode {
  if (v === true) return "EACH";
  return String(v ?? "").trim().toLowerCase() === "each" ? "EACH" : "SHORT";
}

function nextDayKey(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The nights a room is held for, in words (2026-10-30, operator: "show it per room nights, not date
 * range" — "30 Oct – 01 Nov" for two nights read as three days). The last date is always the last
 * night slept, never the check-out morning.
 *
 * - EACH: every night named — "30 Oct", "30, 31 Oct", "30, 31 Oct, 01 Nov".
 * - SHORT (the default): one or two nights named as above; three or more in a row written as the
 *   first and the last night — "10–19 Mar", "30 Oct–02 Nov"; a gap starts a new piece —
 *   "10–14 Mar, 17, 18 Mar".
 */
export function labelRoomNights(nights: readonly string[], mode: NightsMode = "SHORT"): string {
  const sorted = [...new Set(nights.map((n) => String(n).slice(0, 10)))]
    .filter((n) => !Number.isNaN(new Date(`${n}T00:00:00.000Z`).getTime()))
    .sort();
  const runs: string[][] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && nextDayKey(last[last.length - 1]) === n) last.push(n);
    else runs.push([n]);
  }
  const parts = (iso: string) => {
    const d = new Date(`${iso}T00:00:00.000Z`);
    return { day: String(d.getUTCDate()).padStart(2, "0"), month: MONTHS[d.getUTCMonth()], key: `${d.getUTCFullYear()}-${d.getUTCMonth()}` };
  };
  // Pieces in order: a whole run ("10–14 Mar"), or single nights that share a month ("17, 18 Mar").
  const pieces: string[] = [];
  let days: { key: string; month: string; list: string[] } | null = null;
  const flush = () => {
    if (days) pieces.push(`${days.list.join(", ")} ${days.month}`);
    days = null;
  };
  for (const run of runs) {
    if (mode === "SHORT" && run.length >= 3) {
      flush();
      const a = parts(run[0]);
      const b = parts(run[run.length - 1]);
      pieces.push(a.key === b.key ? `${a.day}–${b.day} ${b.month}` : `${a.day} ${a.month}–${b.day} ${b.month}`);
      continue;
    }
    for (const n of run) {
      const p = parts(n);
      if (days && days.key === p.key) days.list.push(p.day);
      else {
        flush();
        days = { key: p.key, month: p.month, list: [p.day] };
      }
    }
  }
  flush();
  return pieces.join(", ");
}

/**
 * Rooms with their nights on one line — the proforma's and the voucher's Rooms line: each name with
 * its nights, rooms of one name on the same nights counted together ("2 × Deluxe Double (10–19 Mar)"),
 * earliest nights first.
 */
export function roomsWithNightsLine(items: ReadonlyArray<{ name: string; nights: readonly string[] }>, mode: NightsMode = "SHORT"): string {
  const groups = new Map<string, { name: string; label: string; first: string; count: number }>();
  for (const it of items) {
    const label = labelRoomNights(it.nights, mode);
    const key = `${it.name}|${label}`;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { name: it.name, label, first: [...it.nights].sort()[0] ?? "", count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => a.first.localeCompare(b.first) || a.name.localeCompare(b.name))
    .map((g) => `${g.count > 1 ? `${g.count} × ` : ""}${g.name}${g.label ? ` (${g.label})` : ""}`)
    .join(" · ");
}

/**
 * The rooms a booking was given, by number, each with the nights it holds them (2026-10-30) — the
 * bill papers' Rooms line. Read off the assignment rows: a row with no dates runs the whole stay, a
 * dated row its own nights (a room change, a split), and nothing outside the stay counts.
 */
export async function assignedRoomNights(
  prisma: PrismaClient,
  entryId: string,
  stay: { checkIn: Date | null; checkOut: Date | null },
): Promise<Array<{ name: string; nights: string[] }>> {
  if (!stay.checkIn || !stay.checkOut) return [];
  const rows = await prisma.roomAssignment.findMany({
    where: { entryId },
    select: { roomId: true, startDate: true, endDate: true, room: { select: { roomNumber: true } } },
  });
  const inStay = new Set(stayNightDates(stay.checkIn, stay.checkOut));
  const byRoom = new Map<string, { name: string; nights: Set<string> }>();
  for (const r of rows) {
    const nights = stayNightDates(r.startDate ?? stay.checkIn, r.endDate ?? stay.checkOut).filter((n) => inStay.has(n));
    if (nights.length === 0) continue;
    const cur = byRoom.get(r.roomId) ?? { name: r.room?.roomNumber ? `Room ${r.room.roomNumber}` : "Room", nights: new Set<string>() };
    for (const n of nights) cur.nights.add(n);
    byRoom.set(r.roomId, cur);
  }
  return [...byRoom.values()]
    .map((x) => ({ name: x.name, nights: [...x.nights].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
