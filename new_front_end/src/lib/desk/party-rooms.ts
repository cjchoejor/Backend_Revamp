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

/**
 * The per-room compositions the booking is seated (and priced) on TODAY. Layered, most
 * authoritative first — MIRRORS the backend's `resolveCompositionBasis`
 * (back_end/src/lib/party-seating.ts), keep the two in step:
 *   1. the CURRENT segment's operative quotation (ACCEPTED > SENT > DRAFT, newest version);
 *   2. the current segment's newest quotation in ANY state — W15 keeps the validity clock
 *      ticking after the freeze, so a confirmed booking's own quote routinely reads EXPIRED;
 *   3. the current reservation's frozen terms;
 *   4. the newest composition-bearing quote of ANY segment — the last KNOWN seating, for a
 *      booking whose current segment was re-quoted without compositions (the 2026-08-21 defect:
 *      a room change that dropped them). Such rows may still name the REPLACED room — the
 *      backend's seating repair re-points them; the desk shows the gap and offers the repair.
 * Before 2026-08-21 this picked "any ACCEPTED quote with compositions across all segments",
 * which after a room change could seat the party in a room the booking no longer held.
 * Null when no composition exists anywhere.
 */
export function operativeRoomCompositions(entry: EntryDetail): RoomCompositionInput[] | null {
  const compsOf = (terms: unknown): RoomCompositionInput[] | null => {
    const rows = (terms as { roomCompositions?: unknown[] } | null | undefined)?.roomCompositions;
    return Array.isArray(rows) && rows.length > 0 ? (rows as RoomCompositionInput[]) : null;
  };
  const quotes = [...(entry.quotations ?? [])].filter((q) => compsOf(q.commercialTerms));
  const byNewest = (a: { versionNumber?: number; createdAt?: string }, b: { versionNumber?: number; createdAt?: string }) =>
    (b.versionNumber ?? 0) - (a.versionNumber ?? 0) || (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  // `segments` arrive newest-first (segmentNumber desc) — [0] is the current one.
  const currentSegmentId = entry.segments?.[0]?.id ?? null;
  if (currentSegmentId) {
    const current = quotes.filter((q) => q.segmentId === currentSegmentId);
    const rank = (s: string) => (s === "ACCEPTED" ? 3 : s === "SENT" ? 2 : s === "DRAFT" ? 1 : 0);
    const live = current.filter((q) => rank(q.state) > 0).sort((a, b) => rank(b.state) - rank(a.state) || byNewest(a, b));
    if (live[0]) return compsOf(live[0].commercialTerms);
    const any = current.sort(byNewest)[0];
    if (any) return compsOf(any.commercialTerms);
  }
  const frozen = compsOf(entry.reservation?.frozenCommercialTerms);
  if (frozen) return frozen;
  const legacy = quotes.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
  return legacy ? compsOf(legacy.commercialTerms) : null;
}

export type PartySeatingIssues = {
  /** Slot keys with no room at all (labels via `partySlotLabels`). */
  unseated: string[];
  /** Plan rooms whose composition counts nobody — or that have no row at all. */
  emptyRooms: string[];
  /** Composition rows naming a room the current plan no longer holds. */
  strayRooms: string[];
  ok: boolean;
};

/**
 * The two seating invariants, as the desk sees them (2026-08-21): everyone has a room, no plan
 * room is empty. Display-side mirror of the backend's `assessPartySeating` — the authoritative
 * answer is `GET /api/entries/:id/party-seating`, and the fix is its `/repair`. Vacuously OK
 * when the booking carries no composition (nothing to seat).
 */
export function partySeatingIssues(entry: EntryDetail, youngMax = 5, childMax = 10): PartySeatingIssues {
  const comps = operativeRoomCompositions(entry);
  if (!comps) return { unseated: [], emptyRooms: [], strayRooms: [], ok: true };
  const seated = seatPartyRoomsByComposition(entry, youngMax, childMax);
  const unseated = [...partySlotLabels(entry).keys()].filter((k) => !(seated.get(k)?.length ?? 0));
  const plan = [...roomNightsByRoom(entry).keys()];
  const planSet = new Set(plan);
  const emptyRooms = plan.filter((id) => {
    const c = comps.find((x) => x.roomId === id);
    return !c || (c.adultCount ?? 0) + (c.cnb6To10Count ?? 0) + (c.cnbUnder6Count ?? 0) === 0;
  });
  const strayRooms = comps.map((c) => c.roomId).filter((id) => !!id && !planSet.has(id));
  return { unseated, emptyRooms, strayRooms, ok: unseated.length === 0 && emptyRooms.length === 0 && strayRooms.length === 0 };
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
