import type { QuotationState } from "@prisma/client";
import { readOptionSelected } from "./option-selected-reader.js";
import { resolveOperativeQuotation } from "./operative-quotation.js";
import { autoAddRequiredExtraBeds } from "./room-composition.js";

/**
 * Party seating — who sleeps in which room (2026-08-21, operator report: "sometimes when a
 * room is changed the occupants don't get assigned and are without a room … make sure no room
 * is empty and everyone has a room assigned; if it doesn't, inform the user and make it
 * assign").
 *
 * The S2 composition stores COUNTS per room, never which same-band person — so "who sleeps
 * where" is re-DERIVED, deterministically, from the party (adults + per-child ages) and the
 * per-room counts: band pools in party order, rooms in sealed order, adults → 6–10s → under-6s
 * per row's counts, NIGHT-AWARE so the sequential rooms of a per-night split carry the same
 * guests. This module is the ONE home of that derivation and of the two invariants every room
 * change must leave standing:
 *
 *   1. on every night of the stay, the rooms in use that night seat the WHOLE party — nobody
 *      is left without a room;
 *   2. no room in the plan is EMPTY — a plan room with no composition row, or a row with zero
 *      occupants, is a room the guest pays for that nobody sleeps in.
 *
 * `assessPartySeating` states whether they hold; `repairPartySeating` restores them — minting
 * the missing rows, re-pointing rows left behind on a replaced room (through the room-change
 * chain), then seating the shortfall night by night into the emptiest room that has space on
 * EVERY night it covers, so no night overflows the party. Deliberately partial and vocal: what
 * it could not seat is named, never silently dropped.
 *
 * Pure functions over rows the caller loaded — no DB, no money. MIRRORED on the desk in
 * front_end/src/lib/desk/party-rooms.ts (`operativeRoomCompositions`,
 * `seatPartyRoomsByComposition`, `partySeatingIssues`) — keep the two in step, or the desk
 * table and the backend would disagree about who sleeps where.
 */

export type PartyBand = "ADULT" | "C6TO10" | "UNDER6";
export type PartySlot = { key: string; label: string; band: PartyBand };
export type AgeBands = { youngChildMaxAge: number; childMaxAge: number };

/** The minimum a composition row needs for seating; real rows carry much more (meals, rates…). */
export type SeatingRow = {
  roomId: string;
  occupantCount?: number | null;
  adultCount?: number | null;
  cnb6To10Count?: number | null;
  cnbUnder6Count?: number | null;
  extraBedCount?: number | null;
  isFoc?: boolean;
  serviceChargeApplies?: boolean;
  gstApplies?: boolean;
  nightMealOverrides?: Array<{ date: string }> | null;
};

export type NightPicture = Array<{ date: string; roomIds: string[] }>;

const BANDS: PartyBand[] = ["ADULT", "C6TO10", "UNDER6"];

// ── The party ───────────────────────────────────────────────────────────────────────────────

/**
 * The party as seating slots — the SAME derivation the desk table, the S6 coverage gate and the
 * phone roster use (adults + per-child ages off the intake breakdown, `guestCount` anonymous
 * fallback, guest-board keys A0…/K0…). Labels are GENERIC ("Adult 1"), never the profile's
 * name (the profile is the CONTACT PERSON, operator ruling 2026-08-11). A child above
 * `childMaxAge` is an ADULT for seating — 11+ takes a bed slot (composition rows count them as
 * adults), while staying a minor for supervision elsewhere.
 */
export function derivePartySlots(
  entry: { adultCount: number | null; childAges: number[] | null; guestCount: number | null },
  bands: AgeBands,
): PartySlot[] {
  const slots: PartySlot[] = [];
  const adults = Math.max(0, entry.adultCount ?? 0);
  const childAges = entry.childAges ?? [];
  if (adults > 0 || childAges.length > 0) {
    for (let i = 0; i < adults; i++) slots.push({ key: `A${i}`, label: `Adult ${i + 1}`, band: "ADULT" });
    childAges.forEach((age, i) =>
      slots.push({
        key: `K${i}`,
        label: `Child ${i + 1} (${age}y)`,
        band: age <= bands.youngChildMaxAge ? "UNDER6" : age <= bands.childMaxAge ? "C6TO10" : "ADULT",
      }),
    );
  } else {
    const n = Math.max(1, entry.guestCount ?? 1);
    for (let i = 0; i < n; i++) slots.push({ key: `A${i}`, label: `Guest ${i + 1}`, band: "ADULT" });
  }
  return slots;
}

function poolOf(slots: PartySlot[]): Record<PartyBand, string[]> {
  const pool: Record<PartyBand, string[]> = { ADULT: [], C6TO10: [], UNDER6: [] };
  for (const s of slots) pool[s.band].push(s.key);
  return pool;
}

function partySize(slots: PartySlot[]): Record<PartyBand, number> {
  const n: Record<PartyBand, number> = { ADULT: 0, C6TO10: 0, UNDER6: 0 };
  for (const s of slots) n[s.band]++;
  return n;
}

function rowCount(row: SeatingRow | undefined, band: PartyBand): number {
  if (!row) return 0;
  const v = band === "ADULT" ? row.adultCount : band === "C6TO10" ? row.cnb6To10Count : row.cnbUnder6Count;
  return Math.max(0, v ?? 0);
}

function rowOccupants(row: SeatingRow | undefined): number {
  return rowCount(row, "ADULT") + rowCount(row, "C6TO10") + rowCount(row, "UNDER6");
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────

/** Per-night picture of a room plan, normalised across the three seal shapes. Rooms with no
 *  per-night seal sleep every night. */
export function currentPerNightPicture(input: {
  sealedOption: unknown;
  fallbackRoomIds: string[];
  nightsIso: string[];
}): NightPicture {
  const sel = readOptionSelected(input.sealedOption ?? null);
  if (sel.perNight && sel.perNight.length > 0) {
    return sel.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...n.roomIds] }));
  }
  const rooms = sel.distinctRoomIds.length > 0 ? sel.distinctRoomIds : input.fallbackRoomIds;
  return input.nightsIso.map((date) => ({ date, roomIds: [...rooms] }));
}

/** Distinct plan rooms in first-appearance order — the seating order. */
export function planRoomOrder(picture: NightPicture): string[] {
  const out: string[] = [];
  for (const n of [...picture].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const id of n.roomIds) if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function nightsByRoomFromPicture(picture: NightPicture): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const n of picture) for (const id of n.roomIds) m.set(id, [...(m.get(id) ?? []), n.date]);
  for (const [id, nights] of m) m.set(id, [...new Set(nights)].sort());
  return m;
}

// ── The composition basis ───────────────────────────────────────────────────────────────────

export type CompositionBasisSource =
  | "OPERATIVE_QUOTATION"
  | "CURRENT_SEGMENT_QUOTATION"
  | "FROZEN_RESERVATION"
  | "PRIOR_SEGMENT_QUOTATION"
  | "PRIOR_RESERVATION"
  | "NONE";

export type CompositionBasis<T extends SeatingRow = SeatingRow> = {
  /** The commercialTerms the rows came from (discount, currency… ride with them). Null = none. */
  terms: Record<string, unknown> | null;
  compositions: T[] | null;
  source: CompositionBasisSource;
  quotationId: string | null;
};

/**
 * WHICH compositions a booking is seated (and priced) on today. Layered, most authoritative
 * first — every layer is a quote/reservation that CARRIES per-room compositions:
 *
 *   1. the current segment's operative quotation (`resolveOperativeQuotation`);
 *   2. the current segment's newest quotation in ANY state — W15 keeps the validity clock
 *      ticking after the freeze, so a confirmed booking's own quote routinely reads EXPIRED
 *      (the billing-summary precedent: an expired clock must not un-price committed money);
 *   3. the current reservation's frozen terms;
 *   4. the newest composition-bearing quotation of ANY segment, then 5. any reservation —
 *      the last KNOWN seating, for a booking whose current segment was re-quoted without
 *      compositions (the reported defect: a room change that dropped them). Rows from a prior
 *      segment may still name rooms the plan no longer holds — `repointStrayRows` follows the
 *      room-change chain to the rooms they became.
 *
 * The desk's `operativeRoomCompositions` mirrors this order exactly.
 */
export function resolveCompositionBasis<T extends SeatingRow = SeatingRow>(entry: {
  segments: Array<{ id: string }>;
  quotations: Array<{
    id: string;
    segmentId: string | null;
    state: string;
    versionNumber?: number | null;
    createdAt: Date;
    commercialTerms: unknown;
  }>;
  reservation?: { frozenCommercialTerms: unknown } | null;
  reservations?: Array<{ confirmedAt?: Date | null; frozenCommercialTerms: unknown }> | null;
}): CompositionBasis<T> {
  const compsOf = (terms: unknown): T[] | null => {
    const rows = (terms as { roomCompositions?: unknown } | null | undefined)?.roomCompositions;
    return Array.isArray(rows) && rows.length > 0 ? (rows as T[]) : null;
  };
  const termsOf = (terms: unknown) =>
    terms && typeof terms === "object" && !Array.isArray(terms) ? (terms as Record<string, unknown>) : null;
  const currentSegmentId = entry.segments[0]?.id ?? null;

  if (currentSegmentId) {
    const operative = resolveOperativeQuotation(
      entry.quotations.map((q) => ({ ...q, state: q.state as QuotationState })),
      currentSegmentId,
    );
    if (operative && compsOf(operative.commercialTerms)) {
      return { terms: termsOf(operative.commercialTerms), compositions: compsOf(operative.commercialTerms), source: "OPERATIVE_QUOTATION", quotationId: operative.id };
    }
    const LIVE = ["ACCEPTED", "SENT", "DRAFT"];
    const currentAny = entry.quotations
      .filter((q) => q.segmentId === currentSegmentId && compsOf(q.commercialTerms))
      .sort(
        (a, b) =>
          (LIVE.includes(b.state) ? 1 : 0) - (LIVE.includes(a.state) ? 1 : 0) ||
          (b.versionNumber ?? 0) - (a.versionNumber ?? 0) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      )[0];
    if (currentAny) {
      return { terms: termsOf(currentAny.commercialTerms), compositions: compsOf(currentAny.commercialTerms), source: "CURRENT_SEGMENT_QUOTATION", quotationId: currentAny.id };
    }
  }
  if (entry.reservation && compsOf(entry.reservation.frozenCommercialTerms)) {
    return { terms: termsOf(entry.reservation.frozenCommercialTerms), compositions: compsOf(entry.reservation.frozenCommercialTerms), source: "FROZEN_RESERVATION", quotationId: null };
  }
  const priorAny = entry.quotations
    .filter((q) => compsOf(q.commercialTerms))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (priorAny) {
    return { terms: termsOf(priorAny.commercialTerms), compositions: compsOf(priorAny.commercialTerms), source: "PRIOR_SEGMENT_QUOTATION", quotationId: priorAny.id };
  }
  const priorRes = (entry.reservations ?? [])
    .filter((r) => compsOf(r.frozenCommercialTerms))
    .sort((a, b) => (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0))[0];
  if (priorRes) {
    return { terms: termsOf(priorRes.frozenCommercialTerms), compositions: compsOf(priorRes.frozenCommercialTerms), source: "PRIOR_RESERVATION", quotationId: null };
  }
  return { terms: null, compositions: null, source: "NONE", quotationId: null };
}

// ── The room-change chain ───────────────────────────────────────────────────────────────────

/**
 * from-room → the rooms it was replaced by, folded from the `roomChange` markers every in-place
 * room change writes into its sealed configuration (oldest first). A per-night split replaces
 * one room with several; a later change can replace a replacement — `successorsInPlan` follows
 * the chain to the rooms that are in the plan TODAY.
 */
export function successorChainFromConfigs(configs: Array<{ optionSelected: unknown }>): Map<string, string[]> {
  const successorOf = new Map<string, string[]>();
  for (const cfg of configs) {
    const marker = (cfg.optionSelected as { roomChange?: { fromRoomId?: unknown; toRoomId?: unknown; toRoomIds?: unknown } } | null)
      ?.roomChange;
    const from = typeof marker?.fromRoomId === "string" ? marker.fromRoomId : null;
    const toIds = Array.isArray(marker?.toRoomIds)
      ? (marker!.toRoomIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const targets = toIds.length > 0 ? toIds : typeof marker?.toRoomId === "string" ? [marker.toRoomId] : [];
    if (!from || targets.length === 0 || targets.every((t) => t === from)) continue;
    successorOf.set(from, targets.filter((t) => t !== from));
  }
  return successorOf;
}

function successorsInPlan(roomId: string, successorOf: Map<string, string[]>, planSet: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > 12 || seen.has(id)) return;
    seen.add(id);
    for (const next of successorOf.get(id) ?? []) {
      if (planSet.has(next)) {
        if (!out.includes(next)) out.push(next);
      } else {
        walk(next, depth + 1);
      }
    }
  };
  walk(roomId, 0);
  return out;
}

export type SeatingRepairAction =
  | { type: "ROW_MINTED"; roomId: string }
  | { type: "ROW_REPOINTED"; fromRoomId: string; toRoomId: string }
  | { type: "ROW_DROPPED"; roomId: string }
  | { type: "GUESTS_SEATED"; roomId: string; band: PartyBand; count: number }
  | { type: "EXTRA_BED_ADDED"; roomId: string };

function cloneRow<T extends SeatingRow>(row: T): T {
  return {
    ...row,
    ...(row.nightMealOverrides ? { nightMealOverrides: row.nightMealOverrides.map((o) => ({ ...o })) } : {}),
  };
}

/**
 * Reconcile composition rows against the plan. A row naming a room the plan no longer holds is
 * RE-POINTED at the room it became (the room-change chain — exact), else paired positionally
 * with a plan room that lacks a row (its guest data most likely belongs there — the stray IS the
 * pre-drift identity), and anything still stray is dropped. A split's several successors each
 * get a copy (sequential rooms carry the same guests — the carry's own precedent). No-op when
 * the rows already match the plan, which is every normal case.
 */
export function repointStrayRows<T extends SeatingRow>(
  rows: T[],
  planRoomIds: string[],
  successorOf: Map<string, string[]>,
): { rows: T[]; actions: SeatingRepairAction[] } {
  const planSet = new Set(planRoomIds);
  const actions: SeatingRepairAction[] = [];
  const kept: T[] = rows.filter((r) => planSet.has(r.roomId)).map(cloneRow);
  const strays = rows.filter((r) => !planSet.has(r.roomId));
  const has = (id: string) => kept.some((r) => r.roomId === id);
  const leftovers: T[] = [];
  for (const stray of strays) {
    const targets = successorsInPlan(stray.roomId, successorOf, planSet).filter((id) => !has(id));
    if (targets.length === 0) {
      leftovers.push(stray);
      continue;
    }
    for (const target of targets) {
      kept.push({ ...cloneRow(stray), roomId: target });
      actions.push({ type: "ROW_REPOINTED", fromRoomId: stray.roomId, toRoomId: target });
    }
  }
  // Positional fallback for rows with no chain (legacy bookings, plans re-built elsewhere).
  const missing = planRoomIds.filter((id) => !has(id));
  for (let i = 0; i < leftovers.length; i++) {
    const stray = leftovers[i];
    const target = missing[i];
    if (target) {
      kept.push({ ...cloneRow(stray), roomId: target });
      actions.push({ type: "ROW_REPOINTED", fromRoomId: stray.roomId, toRoomId: target });
    } else {
      actions.push({ type: "ROW_DROPPED", roomId: stray.roomId });
    }
  }
  // Keep plan order so the seating stays deterministic.
  kept.sort((a, b) => planRoomIds.indexOf(a.roomId) - planRoomIds.indexOf(b.roomId));
  return { rows: kept, actions };
}

// ── Seating ─────────────────────────────────────────────────────────────────────────────────

/**
 * slot key → EVERY room that guest sleeps in, in seating order. Night-aware: a guest already
 * seated may be seated again by a room whose nights don't overlap (a per-night split duplicates
 * the party across sequential rooms); rooms with no night data keep the exclusive rule. The
 * first room is the guest's PRIMARY room. Mirrors the desk's `seatPartyRoomsByComposition`.
 */
export function seatPartyRooms(input: {
  slots: PartySlot[];
  rows: SeatingRow[];
  order: string[];
  nightsByRoom: Map<string, string[]>;
}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const pool = poolOf(input.slots);
  const order = input.order.length > 0 ? input.order : input.rows.map((r) => r.roomId);
  const occupied = new Map<string, Set<string>>();
  for (const id of order) {
    const row = input.rows.find((r) => r.roomId === id);
    if (!row) continue;
    const nights = input.nightsByRoom.get(id) ?? [];
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
    take("ADULT", rowCount(row, "ADULT"));
    take("C6TO10", rowCount(row, "C6TO10"));
    take("UNDER6", rowCount(row, "UNDER6"));
  }
  return out;
}

export type PartySeatingAssessment = {
  /** slot key → rooms (primary first). */
  seating: Map<string, string[]>;
  unseated: PartySlot[];
  /** Plan rooms with a row counting nobody. */
  emptyRooms: string[];
  /** Plan rooms with no composition row at all (also listed in `emptyRooms`). */
  roomsWithoutRow: string[];
  perNight: Array<{ date: string; roomIds: string[]; shortfall: Record<PartyBand, number>; overflow: Record<PartyBand, number> }>;
  /** Both invariants hold: everyone seated every night, no room empty. */
  ok: boolean;
};

export function assessPartySeating(input: {
  slots: PartySlot[];
  rows: SeatingRow[];
  picture: NightPicture;
}): PartySeatingAssessment {
  const picture = [...input.picture].sort((a, b) => a.date.localeCompare(b.date));
  const order = planRoomOrder(picture);
  const nightsByRoom = nightsByRoomFromPicture(picture);
  const party = partySize(input.slots);
  const rowFor = (id: string) => input.rows.find((r) => r.roomId === id);
  const seating = seatPartyRooms({ slots: input.slots, rows: input.rows, order, nightsByRoom });
  const unseated = input.slots.filter((s) => !(seating.get(s.key)?.length ?? 0));
  const roomsWithoutRow = order.filter((id) => !rowFor(id));
  const emptyRooms = order.filter((id) => rowOccupants(rowFor(id)) === 0);
  const perNight = picture.map((n) => {
    const shortfall: Record<PartyBand, number> = { ADULT: 0, C6TO10: 0, UNDER6: 0 };
    const overflow: Record<PartyBand, number> = { ADULT: 0, C6TO10: 0, UNDER6: 0 };
    for (const band of BANDS) {
      const sum = n.roomIds.reduce((acc, id) => acc + rowCount(rowFor(id), band), 0);
      shortfall[band] = Math.max(0, party[band] - sum);
      overflow[band] = Math.max(0, sum - party[band]);
    }
    return { date: n.date, roomIds: [...n.roomIds], shortfall, overflow };
  });
  const anyShort = perNight.some((n) => BANDS.some((b) => n.shortfall[b] > 0));
  return {
    seating,
    unseated,
    emptyRooms,
    roomsWithoutRow,
    perNight,
    ok: unseated.length === 0 && emptyRooms.length === 0 && !anyShort,
  };
}

export type RoomSeatingFacts = {
  /** Chargeable-occupant ceiling (adults incl. 11+; under-11s share bedding). Null = unknown. */
  maxCapacity: number | null;
  /** The room TYPE's extra-bed ceiling, for p78's mandatory third-adult bed. Null = unknown. */
  maxExtraBeds: number | null;
};

export type PartySeatingRepair<T extends SeatingRow> = {
  rows: T[];
  actions: SeatingRepairAction[];
  /** What could NOT be seated, in operator words. */
  unresolved: string[];
  changed: boolean;
  before: PartySeatingAssessment;
  after: PartySeatingAssessment;
};

/**
 * Restore both invariants, touching as little as possible:
 *  - a plan room with no row gets a bare one (room only, SC/GST apply, no extra bed);
 *  - then night by night, each band's shortfall is seated into the room that (a) is empty,
 *    else (b) is short on EVERY night it covers — so adding there overflows no night — with
 *    the fewest occupants first, in plan order; adults respect the room's chargeable ceiling;
 *  - the mandatory third-adult extra bed is auto-added exactly as the quote would.
 * A shortfall no room can take is reported in `unresolved`, never hidden. Rows are cloned —
 * the caller's array is untouched.
 */
export function repairPartySeating<T extends SeatingRow>(input: {
  slots: PartySlot[];
  rows: T[];
  picture: NightPicture;
  facts?: Map<string, RoomSeatingFacts>;
  /** How a freshly minted row looks beyond the counts (the caller's row type may need more). */
  mintRow?: (roomId: string) => T;
}): PartySeatingRepair<T> {
  const picture = [...input.picture].sort((a, b) => a.date.localeCompare(b.date));
  const order = planRoomOrder(picture);
  const nightsByRoom = nightsByRoomFromPicture(picture);
  const party = partySize(input.slots);
  const before = assessPartySeating({ slots: input.slots, rows: input.rows, picture });
  const actions: SeatingRepairAction[] = [];
  const unresolved: string[] = [];
  let rows: T[] = input.rows.map(cloneRow);
  const rowFor = (id: string) => rows.find((r) => r.roomId === id);

  // 1. Every plan room has a row.
  for (const id of order) {
    if (rowFor(id)) continue;
    const minted =
      input.mintRow?.(id) ??
      ({
        roomId: id,
        occupantCount: 0,
        adultCount: 0,
        cnb6To10Count: 0,
        cnbUnder6Count: 0,
        extraBedCount: 0,
        serviceChargeApplies: true,
        gstApplies: true,
        isFoc: false,
      } as T);
    rows.push(minted);
    actions.push({ type: "ROW_MINTED", roomId: id });
  }
  rows.sort((a, b) => {
    const ai = order.indexOf(a.roomId);
    const bi = order.indexOf(b.roomId);
    return (ai === -1 ? 1e9 : ai) - (bi === -1 ? 1e9 : bi);
  });

  // 2. Everyone has a room on every night.
  const sumOn = (date: string, band: PartyBand) =>
    (picture.find((n) => n.date === date)?.roomIds ?? []).reduce((acc, id) => acc + rowCount(rowFor(id), band), 0);
  const seated = new Map<string, number>(); // `${roomId}|${band}` → added
  for (const night of picture) {
    for (const band of BANDS) {
      let guard = 0;
      while (party[band] - sumOn(night.date, band) > 0 && guard++ < 64) {
        const candidates = night.roomIds
          .filter((id) => rowFor(id))
          .filter((id) => {
            // Adding one guest here must leave no night of this room over the party.
            const nights = nightsByRoom.get(id) ?? [night.date];
            if (!nights.every((d) => sumOn(d, band) + 1 <= party[band])) return false;
            if (band === "ADULT") {
              const cap = input.facts?.get(id)?.maxCapacity ?? null;
              if (cap != null && rowCount(rowFor(id), "ADULT") + 1 > cap) return false;
            }
            return true;
          })
          .sort(
            (a, b) =>
              (rowOccupants(rowFor(a)) === 0 ? 0 : 1) - (rowOccupants(rowFor(b)) === 0 ? 0 : 1) ||
              rowOccupants(rowFor(a)) - rowOccupants(rowFor(b)) ||
              order.indexOf(a) - order.indexOf(b),
          );
        const pick = candidates[0];
        if (!pick) {
          const short = party[band] - sumOn(night.date, band);
          unresolved.push(
            `${short} ${bandWord(band, short)} could not be seated on ${night.date} — no room in use that night has space for them`,
          );
          break;
        }
        const row = rowFor(pick)!;
        const key = band === "ADULT" ? "adultCount" : band === "C6TO10" ? "cnb6To10Count" : "cnbUnder6Count";
        (row as SeatingRow)[key] = rowCount(row, band) + 1;
        row.occupantCount = rowOccupants(row);
        seated.set(`${pick}|${band}`, (seated.get(`${pick}|${band}`) ?? 0) + 1);
      }
    }
  }
  for (const [k, count] of seated) {
    const [roomId, band] = k.split("|") as [string, PartyBand];
    actions.push({ type: "GUESTS_SEATED", roomId, band, count });
  }

  // 3. The third adult's mandatory extra bed, exactly as the quote auto-adds it (p78).
  const touched = new Set(actions.flatMap((a) => ("roomId" in a ? [a.roomId] : [])));
  if (touched.size > 0) {
    const bedded = autoAddRequiredExtraBeds(rows, {
      maxExtraBedsForRoom: (c) => input.facts?.get(c.roomId)?.maxExtraBeds,
    });
    for (const i of bedded.autoAddedIndexes) {
      if (!touched.has(rows[i].roomId)) continue;
      actions.push({ type: "EXTRA_BED_ADDED", roomId: rows[i].roomId });
    }
    // Only rows the repair touched take the bed here — every other row is exactly what the
    // quote will see, and the quote adds its own.
    rows = rows.map((r, i) => (bedded.autoAddedIndexes.includes(i) && touched.has(r.roomId) ? bedded.compositions[i] : r));
  }

  const after = assessPartySeating({ slots: input.slots, rows, picture });
  return { rows, actions, unresolved, changed: actions.length > 0, before, after };
}

function bandWord(band: PartyBand, n: number): string {
  if (band === "ADULT") return n === 1 ? "adult" : "adults";
  if (band === "C6TO10") return n === 1 ? "child (6–10)" : "children (6–10)";
  return n === 1 ? "child (under 6)" : "children (under 6)";
}

/** One operator-facing sentence per thing the repair did (or could not do). */
export function describeSeatingRepair(
  repair: { actions: SeatingRepairAction[]; unresolved: string[] },
  roomNumber: (roomId: string) => string,
): string[] {
  const lines: string[] = [];
  const room = (id: string) => `Room ${roomNumber(id)}`;
  for (const a of repair.actions) {
    if (a.type === "ROW_REPOINTED") lines.push(`${room(a.fromRoomId)}'s guests and setup moved to ${room(a.toRoomId)}, the room it was changed to`);
    if (a.type === "ROW_DROPPED") lines.push(`A composition row for ${room(a.roomId)} — no longer in the plan — was dropped`);
  }
  const minted = repair.actions.filter((a) => a.type === "ROW_MINTED").map((a) => (a as { roomId: string }).roomId);
  const seatedByRoom = new Map<string, string[]>();
  for (const a of repair.actions) {
    if (a.type !== "GUESTS_SEATED") continue;
    seatedByRoom.set(a.roomId, [...(seatedByRoom.get(a.roomId) ?? []), `${a.count} ${bandWord(a.band, a.count)}`]);
  }
  for (const [roomId, parts] of seatedByRoom) {
    const fresh = minted.includes(roomId);
    lines.push(
      `${parts.join(" + ")} seated in ${room(roomId)}${fresh ? " (it had no guests recorded — room only, no meal plan; set meals through the room-change table if needed)" : ""}`,
    );
  }
  for (const roomId of minted) {
    if (!seatedByRoom.has(roomId)) lines.push(`${room(roomId)} had no composition row — one was recorded (empty)`);
  }
  for (const a of repair.actions) {
    if (a.type === "EXTRA_BED_ADDED") lines.push(`An extra bed was added in ${room(a.roomId)} for the third adult`);
  }
  lines.push(...repair.unresolved);
  return lines;
}
