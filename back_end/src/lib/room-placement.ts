/**
 * Putting stays into rooms, one room type at a time (2026-10-28, docs/room-types-until-arrival.md).
 *
 * PURE: no database. The caller hands over one room type's rooms, the nights each is out of order,
 * and every stay that needs a room of that type over the window:
 *   - a FIXED stay sits in its room and is never moved — another booking's room the system may not
 *     touch, a guest already in, or a room the desk or the guest chose;
 *   - a MOVABLE stay needs ONE room of the type for all of its nights, and may sit in any of them.
 *     Its current room (the quiet room the system chose before) is tried first, so nothing moves
 *     that does not have to.
 *
 * WHY COUNTING NIGHTS IS NOT ENOUGH. Free rooms can be counted night by night and fit every night,
 * and still leave no single room free for a whole stay — once fixed stays are in the way. Two
 * suites; A is fixed in suite 1 on night 1 only, B fixed in suite 2 on night 2 only; C wants nights
 * 1–2. Each night one suite is free, but not the same one, so C would have to change rooms halfway.
 * With no fixed stays, rooms of a type all alike, the counts fitting every night is enough — the
 * search below then finds the placement at once.
 *
 * The search: fixed stays first, then the movable ones in order of their first night, each trying
 * its current room first; backtracking when a stay finds no room. A step limit stops a search that
 * runs too long and says so rather than guessing.
 *
 * ROOMS OTHERS HAVE PICKED (2026-10-29). A booking's pick at Inquiry, Negotiation or Set up holds
 * nothing, so it never blocks a room here — but a stay marked `avoidPicked` tries the rooms nobody
 * else has picked first, then the ones picked least (`soft`: room → night → weight; a room chosen by
 * number weighs more than one the system chose). Three bookings asking for a Standard Double get
 * three different rooms while there are three free, instead of all landing in the first one.
 */

export type PlacementItem = {
  id: string;
  /** Night indexes into the window, consecutive. */
  nights: number[];
  /** The room it must sit in — never moved. */
  fixedRoomId: string | null;
  /** Where it sits now, for a movable stay — tried first. */
  currentRoomId: string | null;
  /** Try rooms other bookings have picked last (`PlacementInput.soft`). */
  avoidPicked?: boolean;
};

export type PlacementInput = {
  /** The type's rooms, in a stable order (room number). */
  roomIds: string[];
  /** Nights each room is out of order. */
  unusable?: Map<string, Set<number>>;
  items: PlacementItem[];
  /** Search steps before giving up. */
  stepLimit?: number;
  /** Rooms other bookings have picked but do not hold: room → night → weight. Never blocks. */
  soft?: Map<string, Map<number, number>>;
};

export type FixedClash = {
  roomId: string;
  night: number;
  /** The fixed stays on that room-night (two or more), or the one on a night it is out of order. */
  itemIds: string[];
  outOfOrder: boolean;
};

export type PlacementResult = {
  ok: boolean;
  /** Where each stay sits — every fixed stay, and every movable stay when `ok`. */
  roomOf: Map<string, string>;
  /** Movable stays whose room is not their current one. */
  moved: string[];
  /** Two fixed stays on one room-night, or a fixed stay on a night the room is out of order. */
  fixedClashes: FixedClash[];
  /** When not ok: why. COUNT — some night has more stays than rooms; NO_SINGLE_ROOM — the counts
   *  fit but no placement gives each stay one room; TOO_HARD — the step limit ran out. */
  reason: "COUNT" | "NO_SINGLE_ROOM" | "TOO_HARD" | null;
  /** For COUNT: the nights with more movable stays than free rooms. */
  shortNights: number[];
  steps: number;
};

export const PLACEMENT_STEP_LIMIT = 200_000;

export function placeStays(input: PlacementInput): PlacementResult {
  const roomIds = input.roomIds;
  const unusable = input.unusable ?? new Map<string, Set<number>>();
  const limit = input.stepLimit ?? PLACEMENT_STEP_LIMIT;
  const roomOf = new Map<string, string>();
  const known = new Set(roomIds);

  // Every night the window touches.
  let nightCount = 0;
  for (const it of input.items) for (const n of it.nights) nightCount = Math.max(nightCount, n + 1);
  for (const set of unusable.values()) for (const n of set) nightCount = Math.max(nightCount, n + 1);

  // busy[room][night] — taken by a fixed stay or out of order
  const busy = new Map<string, boolean[]>();
  for (const r of roomIds) {
    const row = new Array<boolean>(nightCount).fill(false);
    for (const n of unusable.get(r) ?? []) if (n < nightCount) row[n] = true;
    busy.set(r, row);
  }

  // ---- fixed stays: facts, placed first -------------------------------------------------------
  const onCell = new Map<string, string[]>(); // `${room}|${night}` -> fixed item ids
  const movable: PlacementItem[] = [];
  for (const it of input.items) {
    if (it.fixedRoomId && known.has(it.fixedRoomId)) {
      roomOf.set(it.id, it.fixedRoomId);
      for (const n of it.nights) {
        const key = `${it.fixedRoomId}|${n}`;
        onCell.set(key, [...(onCell.get(key) ?? []), it.id]);
      }
    } else if (it.nights.length > 0) {
      movable.push(it);
    }
  }
  const fixedClashes: FixedClash[] = [];
  for (const [key, ids] of onCell) {
    const [roomId, nightStr] = key.split("|");
    const night = Number(nightStr);
    const out = unusable.get(roomId)?.has(night) === true;
    if (ids.length > 1 || out) fixedClashes.push({ roomId, night, itemIds: ids, outOfOrder: out });
    busy.get(roomId)![night] = true;
  }
  fixedClashes.sort((a, b) => a.night - b.night || a.roomId.localeCompare(b.roomId));

  const done = (ok: boolean, reason: PlacementResult["reason"], shortNights: number[], steps: number): PlacementResult => {
    const moved = ok
      ? movable.filter((it) => it.currentRoomId && roomOf.get(it.id) !== it.currentRoomId).map((it) => it.id)
      : [];
    return { ok, roomOf, moved, fixedClashes, reason, shortNights, steps };
  };

  if (movable.length === 0) return done(true, null, [], 0);

  // ---- counts: a night with more movable stays than free rooms can never fit -----------------
  const freeOn = new Array<number>(nightCount).fill(0);
  for (const r of roomIds) busy.get(r)!.forEach((b, n) => (freeOn[n] += b ? 0 : 1));
  const need = new Array<number>(nightCount).fill(0);
  for (const it of movable) for (const n of it.nights) need[n]++;
  const shortNights = need.map((k, n) => (k > freeOn[n] ? n : -1)).filter((n) => n >= 0);
  if (shortNights.length > 0) return done(false, "COUNT", shortNights, 0);

  // ---- the search ------------------------------------------------------------------------------
  const order = [...movable].sort(
    (a, b) => a.nights[0] - b.nights[0] || b.nights.length - a.nights.length || a.id.localeCompare(b.id),
  );
  const fits = (roomId: string, it: PlacementItem) => {
    const row = busy.get(roomId)!;
    return it.nights.every((n) => !row[n]);
  };
  const mark = (roomId: string, it: PlacementItem, value: boolean) => {
    const row = busy.get(roomId)!;
    for (const n of it.nights) row[n] = value;
  };
  let steps = 0;
  let gaveUp = false;
  const search = (k: number): boolean => {
    if (k === order.length) return true;
    if (++steps > limit) {
      gaveUp = true;
      return false;
    }
    const it = order[k];
    const tried = new Set<string>();
    let candidates = [
      ...(it.currentRoomId && known.has(it.currentRoomId) ? [it.currentRoomId] : []),
      ...roomIds,
    ];
    if (it.avoidPicked && input.soft && input.soft.size > 0) {
      // Rooms nobody else has picked first; the current room stays first among equals.
      const weight = (r: string) => it.nights.reduce((sum, n) => sum + (input.soft!.get(r)?.get(n) ?? 0), 0);
      candidates = candidates.map((r, i) => ({ r, i, w: weight(r) })).sort((a, b) => a.w - b.w || a.i - b.i).map((x) => x.r);
    }
    for (const r of candidates) {
      if (tried.has(r)) continue;
      tried.add(r);
      if (!fits(r, it)) continue;
      mark(r, it, true);
      roomOf.set(it.id, r);
      if (search(k + 1)) return true;
      mark(r, it, false);
      roomOf.delete(it.id);
      if (gaveUp) return false;
    }
    return false;
  };
  const ok = search(0);
  if (!ok) {
    for (const it of movable) roomOf.delete(it.id);
    return done(false, gaveUp ? "TOO_HARD" : "NO_SINGLE_ROOM", [], steps);
  }
  return done(true, null, [], steps);
}

/**
 * How many MORE stays over `nights` (one room each, for all of them) the type can take, with the
 * movable stays re-placed as needed. Never more than the night with the fewest free rooms.
 */
export function maxExtraStays(input: PlacementInput, nights: number[]): { count: number; gaveUp: boolean } {
  if (nights.length === 0) return { count: 0, gaveUp: false };
  // The ceiling: free rooms on the tightest night, once fixed stays and movable stays are counted.
  const base = placeStays({ ...input, items: input.items });
  const unusable = input.unusable ?? new Map<string, Set<number>>();
  let ceiling = Number.POSITIVE_INFINITY;
  for (const n of nights) {
    let free = 0;
    for (const r of input.roomIds) {
      if (unusable.get(r)?.has(n)) continue;
      const taken = input.items.some((it) => it.nights.includes(n) && it.fixedRoomId === r);
      if (!taken) free++;
    }
    const movableThatNight = input.items.filter((it) => !(it.fixedRoomId && input.roomIds.includes(it.fixedRoomId)) && it.nights.includes(n)).length;
    ceiling = Math.min(ceiling, free - movableThatNight);
  }
  if (!base.ok || ceiling <= 0) return { count: 0, gaveUp: base.reason === "TOO_HARD" };
  let gaveUp = false;
  for (let k = ceiling; k > 0; k--) {
    const extra: PlacementItem[] = Array.from({ length: k }, (_, i) => ({
      id: `__extra_${i}`,
      nights,
      fixedRoomId: null,
      currentRoomId: null,
    }));
    const res = placeStays({ ...input, items: [...input.items, ...extra] });
    if (res.ok) return { count: k, gaveUp };
    // Too hard to tell at k: a smaller count is easier — keep going, and say the answer may be low.
    if (res.reason === "TOO_HARD") gaveUp = true;
  }
  return { count: 0, gaveUp };
}

/** Rooms of the type free on EVERY one of `nights`, with every stay left where it is now. */
export function roomsFreeEveryNight(input: PlacementInput, nights: number[]): string[] {
  const unusable = input.unusable ?? new Map<string, Set<number>>();
  return input.roomIds.filter((r) =>
    nights.every(
      (n) =>
        !unusable.get(r)?.has(n) &&
        !input.items.some((it) => it.nights.includes(n) && (it.fixedRoomId ?? it.currentRoomId) === r),
    ),
  );
}
