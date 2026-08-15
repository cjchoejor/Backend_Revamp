import type { RoomCompositionInput } from "@/lib/api/quotations";
import { optionSelectedRoomIds, type EntryDetail } from "@/types/api";

/**
 * Party ↔ room helpers shared by the S5 guest-detail table and the S5 room-assignment block
 * (2026-08-11). The S2 composition stores COUNTS per room, never which same-band person —
 * so "who sleeps where" is re-derived with the SAME deterministic algorithm the S2 guest
 * board uses to rebuild chips from counts (`deriveFromSeed` in room-compositions-board):
 * band pools in party order, rooms in sealed order, adults → 6–10s → under-6s per room's
 * counts. Exact when the board did the placing; same-band guests are interchangeable.
 */

export type PartyBand = "ADULT" | "C6TO10" | "UNDER6";

/** The operative quotation's per-room compositions — newest live quote that carries any
 *  (ACCEPTED wins, else SENT/DRAFT, else newest of the rest). Null when none. */
export function operativeRoomCompositions(entry: EntryDetail): RoomCompositionInput[] | null {
  const quotes = (entry.quotations ?? [])
    .filter((q) => {
      const comps = (q.commercialTerms as { roomCompositions?: unknown[] } | null | undefined)?.roomCompositions;
      return Array.isArray(comps) && comps.length > 0;
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const operative =
    quotes.find((q) => q.state === "ACCEPTED") ?? quotes.find((q) => q.state === "SENT" || q.state === "DRAFT") ?? quotes[0];
  if (!operative) return null;
  return ((operative.commercialTerms as { roomCompositions?: unknown[] }).roomCompositions ?? []) as RoomCompositionInput[];
}

/** Default display label per party slot — GENERIC band labels only ("Adult 1"), never the
 *  profile's name: the booking's guest profile is the CONTACT PERSON, not necessarily anyone
 *  sleeping in the rooms (operator ruling 2026-08-11). Typed names from the guest-detail
 *  table overlay these where recorded. */
export function partySlotLabels(entry: EntryDetail): Map<string, string> {
  const m = new Map<string, string>();
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) m.set(`A${i}`, `Adult ${i + 1}`);
    childAges.forEach((age, i) => m.set(`K${i}`, `Child ${i + 1} · ${age}y`));
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) m.set(`A${i}`, `Guest ${i + 1}`);
  }
  return m;
}

/**
 * slot key → EVERY room that guest sleeps in, in seating (sealed) order (2026-08-14). A
 * mid-stay split duplicates the moving party across SEQUENTIAL rooms — 501 nights 1–2 and 302
 * night 3 carry the SAME two guests — so seating is NIGHT-AWARE: a guest already seated in a
 * room may be seated again by a room whose nights don't overlap (the exact reported case:
 * exclusive one-room-per-guest seating exhausted the pool on 501 and left 302 guest-less).
 * Rooms without night data keep the old exclusive rule.
 */
export function seatPartyRoomsByComposition(entry: EntryDetail, youngMax = 5, childMax = 10): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const comps = operativeRoomCompositions(entry);
  if (!comps) return out;
  const pool: Record<PartyBand, string[]> = { ADULT: [], C6TO10: [], UNDER6: [] };
  for (let i = 0; i < Math.max(0, entry.adultCount ?? 0); i++) pool.ADULT.push(`A${i}`);
  (entry.childAges ?? []).forEach((age, i) => {
    pool[age <= youngMax ? "UNDER6" : age <= childMax ? "C6TO10" : "ADULT"].push(`K${i}`);
  });
  const cfg = [...(entry.availabilityConfigs ?? [])]
    .filter((c) => c.sealedAt && c.optionSelected)
    .sort((a, b) => String(b.sealedAt).localeCompare(String(a.sealedAt)))[0];
  const sealedOrder = optionSelectedRoomIds(cfg?.optionSelected);
  const order = sealedOrder.length > 0 ? sealedOrder : comps.map((c) => c.roomId).filter((id): id is string => !!id);
  const nightsByRoom = roomNightsByRoom(entry);
  /** Nights (or exclusive room markers) each guest is already committed to. */
  const occupied = new Map<string, Set<string>>();
  for (const id of order) {
    const c = comps.find((x) => x.roomId === id);
    if (!c) continue;
    const nights = nightsByRoom.get(id) ?? [];
    const take = (band: PartyBand, n: number) => {
      let taken = 0;
      for (const slot of pool[band]) {
        if (taken >= n) break;
        const occ = occupied.get(slot);
        const clash = occ ? (nights.length > 0 ? nights.some((d) => occ.has(d)) : occ.size > 0) : false;
        if (clash) continue;
        const set = occ ?? new Set<string>();
        if (nights.length > 0) for (const d of nights) set.add(d);
        else set.add(`room:${id}`);
        occupied.set(slot, set);
        out.set(slot, [...(out.get(slot) ?? []), id]);
        taken++;
      }
    };
    take("ADULT", c.adultCount ?? 0);
    take("C6TO10", c.cnb6To10Count ?? 0);
    take("UNDER6", c.cnbUnder6Count ?? 0);
  }
  return out;
}

/** slot key → the guest's PRIMARY room (the first that seats them, in sealed order). Same
 *  output as before the night-aware seater for uniform bookings, and identical to the
 *  backend's `seatPartyByCompositionServer` (its pool consumption in sealed order yields the
 *  same primaries) — keep the two in step. Empty map when there's no composition. */
export function seatPartyByComposition(entry: EntryDetail, youngMax = 5, childMax = 10): Map<string, string> {
  const out = new Map<string, string>();
  for (const [slot, rooms] of seatPartyRoomsByComposition(entry, youngMax, childMax)) {
    if (rooms.length > 0) out.set(slot, rooms[0]);
  }
  return out;
}

/** Compact meal-plan sentence for one room's composition — "2 × CP · 1 × AP", "EP (room
 *  only)" when no plan, with a varies-by-night flag when per-date overrides exist. */
export function mealPlanSummary(c: RoomCompositionInput): string {
  const parts: string[] = [];
  if (c.mealPlanCpCount) parts.push(`${c.mealPlanCpCount} × CP (breakfast)`);
  if (c.mealPlanMaplCount) parts.push(`${c.mealPlanMaplCount} × MAP +lunch`);
  if (c.mealPlanMapdCount) parts.push(`${c.mealPlanMapdCount} × MAP +dinner`);
  if (c.mealPlanApCount) parts.push(`${c.mealPlanApCount} × AP (all meals)`);
  if (c.mealPlanOthersCount) parts.push(`${c.mealPlanOthersCount} × à-la-carte`);
  const base = parts.length > 0 ? parts.join(" · ") : "EP (room only)";
  return (c.nightMealOverrides?.length ?? 0) > 0 ? `${base} · varies by night` : base;
}

// ── Which nights each room holds (2026-08-14, operator request) ────────────────────────────
// A room row must SAY the dates the guest sleeps in it: one range when the room covers the
// whole stay, one range per room after a mid-stay change, and SEVERAL ranges on one room when
// the guest leaves it and comes back (nights 1 and 3 in room A, night 2 elsewhere).

const DAY_MS = 86_400_000;
const isoDay = (v: string) => v.slice(0, 10);
const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function nightsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return out;
  for (let t = from; t < to; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Fold ISO stay-NIGHTS into display ranges whose ends are CHECKOUT mornings — the hotel
 * reading of a stay ("31 Jul – 2 Aug" = sleeps the nights of 31 Jul and 1 Aug, out on the
 * 2nd). Non-contiguous nights produce several spans joined with " · ".
 */
export function foldNightsToRangesLabel(nightsIso: string[]): string {
  const nights = [...new Set(nightsIso.map(isoDay))].sort();
  if (nights.length === 0) return "";
  const spans: Array<{ from: string; lastNight: string }> = [];
  for (const n of nights) {
    const last = spans[spans.length - 1];
    if (last && addDaysIso(last.lastNight, 1) === n) last.lastNight = n;
    else spans.push({ from: n, lastNight: n });
  }
  return spans.map((s) => `${fmtDay(s.from)} – ${fmtDay(addDaysIso(s.lastNight, 1))}`).join(" · ");
}

export type RoomStayRanges = { nightCount: number; firstNight: string | null; label: string };

/**
 * roomId → the RAW sorted ISO nights that room holds in the CURRENT plan. Sources, most
 * authoritative first: the newest sealed selection's per-night picture (carries mid-stay
 * splits exactly), then dated assignment rows (the S7 split's [start, end) windows), then the
 * whole stay for every room of a uniform plan. Empty map when the booking has no stay dates.
 * Feeds both the display ranges and the night-aware party seating.
 */
export function roomNightsByRoom(entry: EntryDetail): Map<string, string[]> {
  const nightsByRoom = new Map<string, string[]>();
  const add = (roomId: string, night: string) =>
    nightsByRoom.set(roomId, [...(nightsByRoom.get(roomId) ?? []), night]);

  const cfg = [...(entry.availabilityConfigs ?? [])]
    .filter((c) => c.sealedAt && c.optionSelected)
    .sort((a, b) => String(b.sealedAt).localeCompare(String(a.sealedAt)))[0];
  const opt = cfg?.optionSelected ?? null;
  const perNight = opt && "perNight" in opt && Array.isArray(opt.perNight) ? opt.perNight : null;

  if (perNight && perNight.length > 0) {
    for (const n of perNight) for (const r of n.roomIds ?? []) if (r?.roomId) add(r.roomId, isoDay(String(n.date)));
  } else {
    const stayIn = entry.checkInDate ? isoDay(entry.checkInDate) : null;
    const stayOut = entry.checkOutDate ? isoDay(entry.checkOutDate) : null;
    for (const a of entry.roomAssignments ?? []) {
      if (!a.startDate) continue;
      const to = a.endDate ? isoDay(a.endDate) : stayOut;
      if (!to) continue;
      for (const night of nightsBetween(isoDay(a.startDate), to)) add(a.roomId, night);
    }
    // Uniform fallback: rooms with no dated window sleep the whole stay.
    if (stayIn && stayOut) {
      const uniform = new Set<string>([
        ...optionSelectedRoomIds(opt),
        ...(entry.roomAssignments ?? []).filter((a) => !a.startDate).map((a) => a.roomId),
      ]);
      for (const id of uniform) {
        if (!nightsByRoom.has(id)) for (const night of nightsBetween(stayIn, stayOut)) add(id, night);
      }
    }
  }

  const out = new Map<string, string[]>();
  for (const [roomId, nights] of nightsByRoom) out.set(roomId, [...new Set(nights)].sort());
  return out;
}

/**
 * Rooms occupied on the ARRIVAL night (2026-08-14, key-swap ruling) — the only rooms whose
 * keys are issued at S6 check-in. A room a per-night split moves the guest into later gets
 * its key on the move day at S7, after the vacated room's key is returned. Mirrors the
 * backend's `dayOneRoomIds` in room-key-service.ts — keep the two in step. Rooms with no
 * derivable nights (and bookings with no stay dates) fall back to day-one, matching the
 * backend's "no dates → no way to sequence keys" rule.
 */
export function arrivalNightRoomIds(entry: EntryDetail): Set<string> {
  const out = new Set<string>();
  const checkInIso = entry.checkInDate ? isoDay(entry.checkInDate) : null;
  const nights = roomNightsByRoom(entry);
  for (const roomId of new Set((entry.roomAssignments ?? []).map((a) => a.roomId))) {
    const first = nights.get(roomId)?.[0] ?? null;
    if (!checkInIso || !first || first <= checkInIso) out.add(roomId);
  }
  return out;
}

/** roomId → display-ready stay ranges (see `roomNightsByRoom` for the sourcing). */
export function roomStayRangesByRoom(entry: EntryDetail): Map<string, RoomStayRanges> {
  const out = new Map<string, RoomStayRanges>();
  for (const [roomId, nights] of roomNightsByRoom(entry)) {
    out.set(roomId, { nightCount: nights.length, firstNight: nights[0] ?? null, label: foldNightsToRangesLabel(nights) });
  }
  return out;
}
