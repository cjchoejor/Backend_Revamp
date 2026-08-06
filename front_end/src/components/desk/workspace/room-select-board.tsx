"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Undo2, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getChildPolicy } from "@/lib/api/child-policy";
import type { PerDateAvailabilityResult } from "@/lib/api/availability";
import type { RoomStatusRow } from "./room-status-table";

/**
 * Guest-board ROOM SELECTION for S1 (2026-07-31) — the people-first alternative to the
 * room-status table, mirroring the S2 quote step's guest board (room-compositions-board).
 *
 * The intake party is one chip per guest; every room that is free for the stay is a bin.
 * The operator drags (or tap-places) people into rooms, and **a room with at least one
 * guest in it IS the selection** — the board emits per-night room lists upward, feeding
 * the same save/counter/deficient-acknowledgement flow the table modes use.
 *
 * Multi-night stays (2026-07-31): a night strip appears — "All nights" edits the base
 * placement that applies to the whole stay; picking one night edits THAT night only
 * (mid-stay room changes), mirroring the S2 board's per-night meal scope. A night that
 * differs carries a mark and can be reset to the base. Pickability follows the scope:
 * per-night scope admits rooms free on that night alone.
 *
 * Capacity counts CHARGEABLE guests only (2026-07-31, mirrors
 * `computeChargeableOccupants` + the OVER_MAX_OCCUPANCY check server-side): children
 * under 11 share bedding and consume no capacity slot — 2 adults + an infant in a
 * 3-cap room reads 2/3, not 3/3. Placement of a child never trips the Full guard.
 *
 * Scope honesty: S1 seals ROOM IDS (whole-stay or per-night) only — `optionSelected`
 * has no guest-composition field, so the chip→room placement here is a picking aid and
 * is not persisted at S1. Who actually sleeps where — and meals — is set on the Quote
 * step's guest board. NO MONEY and no business rules here; the backend re-validates
 * everything at save / quote time.
 */

type Band = "ADULT" | "C6TO10" | "UNDER6";

type Guest = {
  /** Stable key — independent of the async policy cutoffs (same scheme as the S2 board). */
  key: string;
  band: Band;
  label: string;
};

/** One night's saved-selection payload, in the shape the seal endpoint takes. */
export type BoardPerNight = Array<{ date: string; roomIds: string[] }>;

/** "Tue 12 Aug" — compact, unambiguous across month boundaries. */
function nightLabel(key: string): string {
  const d = new Date(key + "T00:00:00.000Z");
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function RoomSelectBoard({
  rows,
  nights,
  perDate,
  entryAdults,
  entryChildAges,
  maxRooms,
  selectedRoomIds,
  initialPerNight,
  onSelectionChange,
  onPerNightChange,
  capacityByRoomId,
  maxChildrenByRoomId,
  capacitiesReady = true,
  disabled,
}: {
  /** The availability result, one row per room (same rows the table renders). */
  rows: RoomStatusRow[];
  /** ISO YYYY-MM-DD stay nights, in order. */
  nights: string[];
  perDate?: PerDateAvailabilityResult[];
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  /** Entry.numberOfRooms — the selection each night must reach, and the cap on occupied bins. */
  maxRooms: number;
  /** Current whole-stay selection (shared with table mode) — mount-time seed for placement. */
  selectedRoomIds: string[];
  /**
   * The effective rooms per night, when some nights differ from the whole-stay base. Seeded as
   * overrides so a room the table picked for a single night shows on that night's board too,
   * instead of vanishing on the way across.
   */
  initialPerNight?: Record<string, string[]>;
  /** Emits the base (whole-stay) occupied rooms — keeps `tableSel` in step for mode switches. */
  onSelectionChange: (roomIds: string[]) => void;
  /**
   * Emits the full per-night picture on every change: one entry per stay night (uniform stays
   * included), plus whether any night actually differs from the base. The parent seals from
   * THIS payload, so per-night differences flow into the same save the table's vary mode uses.
   */
  onPerNightChange?: (perNight: BoardPerNight, hasNightDifferences: boolean) => void;
  /** roomId → max occupancy (catalog data, maxCapacity ?? standardCapacity). */
  capacityByRoomId?: Map<string, number>;
  /** roomId → RoomType.maxChildren. The second ceiling: a bed-full room still can't take
   *  unlimited children, and this is what stops it (mirrors backend OVER_MAX_CHILDREN). */
  maxChildrenByRoomId?: Map<string, number>;
  /** False while the rooms catalog is loading — the mount auto-spread waits for it. */
  capacitiesReady?: boolean;
  disabled?: boolean;
}) {
  const { session } = useSession();
  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  // The party as chips — identical construction to the S2 board so the two boards agree.
  const guests: Guest[] = useMemo(() => {
    const out: Guest[] = [];
    for (let i = 0; i < Math.max(0, entryAdults ?? 0); i++) {
      out.push({ key: `A${i}`, band: "ADULT", label: `Adult ${i + 1}` });
    }
    (entryChildAges ?? []).forEach((age, i) => {
      const band: Band = age <= youngMax ? "UNDER6" : age <= childMax ? "C6TO10" : "ADULT";
      out.push({
        key: `K${i}`,
        band,
        label: band === "ADULT" ? `Guest · ${age}y` : band === "C6TO10" ? `Child · ${age}y` : `Infant · ${age}y`,
      });
    });
    return out;
  }, [entryAdults, entryChildAges, youngMax, childMax]);
  const guestByKey = useMemo(() => new Map(guests.map((g) => [g.key, g])), [guests]);
  /** Chargeable = consumes a capacity slot. Under-11s share bedding (backend rule). */
  const isChargeable = (key: string) => guestByKey.get(key)?.band === "ADULT";

  // Which rooms are taken per night, straight from the engine's per-date breakdown.
  const occupiedByNight = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const pd of perDate ?? []) {
      m.set(pd.date, new Set(pd.occupiedRoomIds.map((o) => o.roomId)));
    }
    return m;
  }, [perDate]);

  /** Scope: null = the whole stay (base placement); a night key = that night alone. */
  const [scopeNight, setScopeNight] = useState<string | null>(null);
  // With no "All nights" control there must always be a night in scope, so open on the first
  // one. A single-night stay keeps the null scope — there is nothing to choose between, and the
  // null path writes the base, which is what a one-night booking should carry.
  useEffect(() => {
    if (nights.length > 1 && scopeNight == null) setScopeNight(nights[0]);
  }, [nights, scopeNight]);

  // Bins for the CURRENT scope. Whole-stay: free on every night (same rule as the table's
  // row-click). Single-night scope: free on that night — that's the whole point of the scope.
  const binRows = useMemo(
    () =>
      rows.filter((r) => {
        if (r.bucket === "unavailable") return false;
        if (scopeNight != null) return !occupiedByNight.get(scopeNight)?.has(r.roomId);
        return nights.every((n) => !occupiedByNight.get(n)?.has(r.roomId));
      }),
    [rows, nights, occupiedByNight, scopeNight],
  );
  const binIds = useMemo(() => new Set(binRows.map((r) => r.roomId)), [binRows]);

  /**
   * The rooms that can't take guests at the current scope — already booked, held, or out of
   * service. They used to be dropped from the board entirely, leaving a bare count and a nudge to
   * "switch to the table to see who holds them". The floor is easier to read when the taken rooms
   * are visible in place, so they're rendered here too: same grid, muted, never a drop target.
   */
  const takenRows = useMemo(() => rows.filter((r) => !binIds.has(r.roomId)), [rows, binIds]);

  /**
   * Why a room is unavailable, at the scope being viewed. The engine supplies all of it — the
   * whole-range `occupiedBy` (with the booking's own dates) and the per-night breakdown (with the
   * guest on each night). Nothing about occupancy is inferred here.
   */
  const takenDetail = (row: RoomStatusRow) => {
    const nightsInScope = scopeNight != null ? [scopeNight] : nights;
    const takenNights = nightsInScope.filter((n) => occupiedByNight.get(n)?.has(row.roomId));
    // Whoever the per-night breakdown names first, else the whole-range occupancy record.
    let holder: { name: string | null; ref: string | null; source: "RESERVED" | "HOLD" } | null = null;
    for (const n of takenNights) {
      const o = perDate?.find((p) => p.date === n)?.occupiedRoomIds.find((x) => x.roomId === row.roomId);
      if (o) {
        holder = { name: o.guestName ?? o.agentName ?? null, ref: o.entryReferenceNumber ?? null, source: o.source };
        break;
      }
    }
    if (!holder && row.occupiedBy?.length) {
      const o = row.occupiedBy[0];
      holder = { name: o.guestName ?? o.agentName ?? null, ref: o.entryReferenceNumber ?? null, source: o.source };
    }
    const outOfService = !holder && (row.blockedReason || row.bucket === "unavailable");
    return {
      holder,
      takenNights,
      // Only worth spelling out the nights when the room is free on some of them.
      partial: takenNights.length > 0 && takenNights.length < nightsInScope.length,
      label: holder ? (holder.source === "HOLD" ? "On hold" : "Reserved") : outOfService ? "Out of service" : "Taken",
      note: holder ? null : row.blockedReason ?? row.unavailabilityReason ?? null,
    };
  };

  // Placement state. `base` applies to every night; `nightOverrides[n]` is night n's FULL
  // map when it deliberately differs (copy-on-first-edit from the base, S2-board style).
  const [base, setBase] = useState<Record<string, string>>({});
  const [nightOverrides, setNightOverrides] = useState<Record<string, Record<string, string>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState<string | null>(null);

  /** The map being viewed/edited at the current scope. */
  const scopeMap: Record<string, string> =
    scopeNight != null ? nightOverrides[scopeNight] ?? base : base;
  /** Effective map for an arbitrary night (used for emission). */
  const mapForNight = (n: string): Record<string, string> => nightOverrides[n] ?? base;

  // Transient blocked-placement notice (room-count cap or a full room).
  const [capMsg, setCapMsg] = useState<string | null>(null);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (msg: string) => {
    setCapMsg(msg);
    if (capTimer.current) clearTimeout(capTimer.current);
    capTimer.current = setTimeout(() => setCapMsg(null), 5000);
  };

  const capOf = (roomId: string) => capacityByRoomId?.get(roomId) ?? null;
  /** Chargeable guests a map places in a room — the number capacity math sees. */
  const chargeableIn = (map: Record<string, string>, roomId: string) =>
    guests.filter((g) => map[g.key] === roomId && g.band === "ADULT").length;
  const totalIn = (map: Record<string, string>, roomId: string) =>
    guests.filter((g) => map[g.key] === roomId).length;
  /**
   * The room type's own ceiling on children (RoomType.maxChildren). A separate limit from
   * capacity, and the reason a bed-full room is not necessarily closed: under-11s share bedding
   * so they never consume a capacity slot, but a room still only takes so many of them. Mirrors
   * the backend's OVER_MAX_CHILDREN check in capacity-validation-service.
   */
  const maxChildrenOf = (roomId: string) => maxChildrenByRoomId?.get(roomId) ?? null;
  const childrenIn = (map: Record<string, string>, roomId: string) =>
    guests.filter((g) => map[g.key] === roomId && g.band !== "ADULT").length;

  /**
   * Why `keys` cannot go into `roomId` — null when the move is allowed.
   *
   * THE single rule for placement, used by the drop guard, the drag feedback and the place
   * button alike, so what the board refuses and what it looks like it will refuse can't drift.
   * Both ceilings are the backend's (capacity-validation-service): chargeable occupants against
   * the room's maxCapacity, and children against maxChildren.
   */
  const rejectReason = (
    roomId: string,
    keys: string[],
    map: Record<string, string> = scopeMap,
  ): string | null => {
    if (keys.length === 0) return null;
    const label = rows.find((r) => r.roomId === roomId)?.roomNumber ?? "";
    const moving = keys.filter((k) => map[k] !== roomId);

    const cap = capOf(roomId);
    if (cap != null) {
      const current = chargeableIn(map, roomId);
      const incoming = moving.filter((k) => isChargeable(k)).length;
      if (current + incoming > cap) {
        const spots = Math.max(0, cap - current);
        return `Room ${label} sleeps ${cap} — ${
          spots === 0 ? "it's full" : `only space for ${spots} more adult${spots === 1 ? "" : "s"}`
        }. Children under ${childMax + 1} share bedding and don't take a slot.`;
      }
    }

    const maxKids = maxChildrenOf(roomId);
    if (maxKids != null) {
      const currentKids = childrenIn(map, roomId);
      const incomingKids = moving.filter((k) => !isChargeable(k)).length;
      if (currentKids + incomingKids > maxKids) {
        return maxKids === 0
          ? `Room ${label} doesn't take children.`
          : `Room ${label} takes at most ${maxKids} child${maxKids === 1 ? "" : "ren"} — it already has ${currentKids}.`;
      }
    }

    const next = { ...map };
    for (const k of keys) next[k] = roomId;
    const distinct = new Set(Object.values(next).filter((id) => binIds.has(id)));
    if (distinct.size > maxRooms) {
      return `This booking needs ${maxRooms} room${maxRooms === 1 ? "" : "s"}${
        scopeNight ? ` on ${nightLabel(scopeNight)}` : ""
      } — move everyone out of one room first, or raise "Rooms required" and search again.`;
    }
    return null;
  };

  /**
   * Spread `guests` across `roomIds`: adults fill the least-loaded room with chargeable space,
   * children sit with the family lead but roll on to the next room once one hits its
   * `maxChildren` ceiling. Whoever doesn't fit stays in the tray.
   */
  const spreadAcross = (roomIds: string[]): Record<string, string> => {
    const next: Record<string, string> = {};
    if (roomIds.length === 0) return next;
    const load = new Map<string, number>(roomIds.map((id) => [id, 0]));
    const kids = new Map<string, number>(roomIds.map((id) => [id, 0]));
    const fits = (id: string) => {
      const cap = capOf(id);
      return cap == null || (load.get(id) ?? 0) < cap;
    };
    const fitsChild = (id: string) => {
      const m = maxChildrenOf(id);
      return m == null || (kids.get(id) ?? 0) < m;
    };
    for (const g of guests.filter((x) => x.band !== "ADULT")) {
      // Earliest room with room for another child — keeps the family together where it can.
      const id = roomIds.find(fitsChild);
      if (!id) continue;
      next[g.key] = id;
      kids.set(id, (kids.get(id) ?? 0) + 1);
    }
    for (const g of guests.filter((x) => x.band === "ADULT")) {
      const open = roomIds.filter(fits);
      if (open.length === 0) continue;
      const id = open.reduce((a, b) => ((load.get(b) ?? 0) < (load.get(a) ?? 0) ? b : a));
      next[g.key] = id;
      load.set(id, (load.get(id) ?? 0) + 1);
    }
    return next;
  };

  /**
   * The table's selection, captured on the first render.
   *
   * It cannot be read from the prop when the seed finally runs: the emit effect below calls
   * `onSelectionChange` as soon as the board mounts, and until the seed has happened the board's
   * placement is empty — so that first emit pushes `[]` back to the parent and overwrites the
   * very selection the seed needs to read. Holding the mount-time value here makes the seed
   * immune to it (bug: picking rooms in the table then opening the guest board cleared them).
   */
  const initialSelectionRef = useRef<string[] | null>(null);
  if (initialSelectionRef.current === null) initialSelectionRef.current = selectedRoomIds;
  /** Same capture for the per-night picks, for the same reason. */
  const initialPerNightRef = useRef<Record<string, string[]> | null>(null);
  if (initialPerNightRef.current === null) initialPerNightRef.current = initialPerNight ?? {};

  /**
   * Mount-time seed: resume from the table's selection, spreading the party across it, so the
   * board opens showing the rooms already chosen with guests in them rather than an empty floor.
   * Waits for the capacities so the spread can't overfill blind.
   *
   * Nights the table gave their own rooms are seeded as overrides, not folded into the base —
   * a room picked for one night of three is exactly the case the base cannot express, and
   * dropping it here would silently lose it on the way back out.
   */
  const [seedApplied, setSeedApplied] = useState(false);
  useEffect(() => {
    if (seedApplied || guests.length === 0 || !capacitiesReady) return;
    const seedRooms = (initialSelectionRef.current ?? []).filter((id) => binIds.has(id)).slice(0, maxRooms);
    const seededBase = seedRooms.length > 0 ? spreadAcross(seedRooms) : {};
    if (seedRooms.length > 0) setBase(seededBase);

    const perNight = initialPerNightRef.current ?? {};
    const overrides: Record<string, Record<string, string>> = {};
    for (const [date, ids] of Object.entries(perNight)) {
      const nightRooms = ids.filter((id) => binIds.has(id)).slice(0, maxRooms);
      // Only nights that actually differ from the base are overrides; the rest follow it.
      const sameAsBase =
        nightRooms.length === seedRooms.length && nightRooms.every((id) => seedRooms.includes(id));
      if (nightRooms.length === 0 || sameAsBase) continue;
      overrides[date] = spreadAcross(nightRooms);
    }
    if (Object.keys(overrides).length > 0) setNightOverrides(overrides);
    setSeedApplied(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedApplied, guests.length, binIds, capacitiesReady]);

  /**
   * Emit on every change: base rooms for tableSel continuity + the full per-night picture for
   * the seal. Skipped for a party-less entry so mounting can't wipe the table's picks — and
   * skipped until the seed has been applied, for the same reason. `seedApplied` is state rather
   * than a ref precisely so this effect does not run in the same commit that schedules the seed,
   * when `base` would still be the empty mount value.
   */
  useEffect(() => {
    if (guests.length === 0 || !seedApplied) return;
    const roomsOf = (map: Record<string, string>) =>
      rows.filter((r) => guests.some((g) => map[g.key] === r.roomId)).map((r) => r.roomId);
    onSelectionChange(roomsOf(base));
    if (onPerNightChange) {
      const perNight: BoardPerNight = nights.map((n) => ({ date: n, roomIds: roomsOf(mapForNight(n)) }));
      onPerNightChange(perNight, Object.keys(nightOverrides).length > 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, nightOverrides, rows, guests, nights, seedApplied]);

  /** Write a placement into the current scope. Every refusal comes from `rejectReason`. */
  const placeKeys = (keys: string[], roomId: string | null) => {
    const cur = scopeMap;
    if (roomId) {
      const why = rejectReason(roomId, keys, cur);
      if (why) {
        flash(why);
        return;
      }
    }
    const next = { ...cur };
    for (const k of keys) {
      if (roomId) next[k] = roomId;
      else delete next[k];
    }
    if (scopeNight == null) setBase(next);
    else setNightOverrides((prev) => ({ ...prev, [scopeNight]: next }));
  };

  /** Drop a night's differences — it returns to the base placement. */
  const resetNight = (n: string) =>
    setNightOverrides((prev) => {
      if (!prev[n]) return prev;
      const next = { ...prev };
      delete next[n];
      return next;
    });

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const placeSelection = (roomId: string | null) => {
    if (selected.size === 0) return;
    placeKeys([...selected], roomId);
  };

  /** Auto-assign at the current scope: across the rooms in use, else the first free rooms. */
  const autoAssign = () => {
    const cur = scopeMap;
    const inUse = binRows.filter((r) => guests.some((g) => cur[g.key] === r.roomId)).map((r) => r.roomId);
    const target =
      inUse.length > 0
        ? inUse
        : [...binRows]
            .sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket === "available" ? -1 : 1))
            .slice(0, maxRooms)
            .map((r) => r.roomId);
    const next = spreadAcross(target);
    if (scopeNight == null) setBase(next);
    else setNightOverrides((prev) => ({ ...prev, [scopeNight]: next }));
  };

  // Drag carries the dragged chip — or the whole selection when the chip is part of it.
  const dragKeysRef = useRef<string[]>([]);
  // Mirrored into state so the rooms can re-render as the drag moves: a room that would refuse
  // this particular guest is shown as closed WHILE dragging, rather than accepting the drop and
  // explaining afterwards.
  const [dragging, setDragging] = useState<string[]>([]);
  const endDrag = () => {
    dragKeysRef.current = [];
    setDragging([]);
    setDragOver(null);
  };
  const onChipDragStart = (key: string) => (e: React.DragEvent) => {
    const keys = selected.has(key) ? [...selected] : [key];
    dragKeysRef.current = keys;
    setDragging(keys);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", keys.join(","));
  };
  const onZoneDrop = (roomId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const keys = dragKeysRef.current.length
      ? dragKeysRef.current
      : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
    endDrag();
    if (keys.length) placeKeys(keys, roomId);
  };
  /**
   * `reject` (non-null) makes the zone refuse the drag outright: without `preventDefault` on
   * dragover the browser treats it as a non-target, so the cursor shows "no drop" and no drop
   * event fires at all. The reason is surfaced on the room, so the refusal explains itself
   * before the operator lets go instead of after.
   */
  const zoneDragProps = (zone: string, roomId: string | null, reject?: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (reject) {
        e.dataTransfer.dropEffect = "none";
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(zone);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(null);
    },
    onDrop: onZoneDrop(roomId),
  });

  const unplaced = guests.filter((g) => !scopeMap[g.key] || !binIds.has(scopeMap[g.key]));
  const placedCount = guests.length - unplaced.length;
  const roomsInUse = binRows.filter((r) => guests.some((g) => scopeMap[g.key] === r.roomId)).length;
  const overriddenNights = nights.filter((n) => nightOverrides[n] != null);

  if (guests.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
        This booking has no party breakdown (adults / child ages) — use the table to select rooms.
      </p>
    );
  }

  const chip = (g: Guest) => {
    const isSel = selected.has(g.key);
    return (
      <div
        key={g.key}
        className={`rcb-chip band-${g.band.toLowerCase()}${isSel ? " sel" : ""}`}
        draggable={!disabled}
        onDragStart={onChipDragStart(g.key)}
        onDragEnd={endDrag}
        onClick={() => toggleSelect(g.key)}
        title={isSel ? "Tap to deselect" : "Tap to select, then tap a room to place — or drag"}
      >
        <span className="b">{g.band === "ADULT" ? "A" : g.band === "C6TO10" ? "C" : "i"}</span>
        <span className="n">{g.label}</span>
      </div>
    );
  };

  return (
    <div className="rcb">
      <div className="rce-bar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={autoAssign}
          disabled={disabled}
          title="Spread the party across the rooms in use — or, with none yet, across the first free rooms (children stay with the first room; they don't take a capacity slot)"
        >
          <Wand2 style={{ width: 13, height: 13 }} /> Auto-assign
        </button>
        <span className="ln" />
        <span className={`rce-tally${roomsInUse !== maxRooms ? " off" : ""}`}>
          {roomsInUse} of {maxRooms} room{maxRooms === 1 ? "" : "s"} in use
          {scopeNight ? ` · ${nightLabel(scopeNight)}` : ""}
        </span>
        <span className={`rce-tally${placedCount !== guests.length ? " off" : ""}`}>
          {placedCount} of {guests.length} guests placed
        </span>
      </div>

      {/* Night scope. Placement is always for ONE night (2026-08-06, operator request): the
          "All nights" scope was removed, because a room is booked night by night and a
          whole-stay placement quietly overwrote nights the operator had already set. A night
          not yet touched still shows the rooms carried in from the table. */}
      {nights.length > 1 && (
        <div className="rcb-planbar rcb-nightbar">
          <span className="lbl">placing for:</span>
          {nights.map((n) => (
            <button
              key={n}
              type="button"
              className={`${scopeNight === n ? "on" : ""}${nightOverrides[n] ? " has" : ""}`}
              onClick={() => setScopeNight(n)}
              title={`Place rooms for ${nightLabel(n)} only${nightOverrides[n] ? " — this night already differs" : ""}`}
            >
              {nightLabel(n)}
            </button>
          ))}
          {scopeNight != null && nightOverrides[scopeNight] && (
            <button
              type="button"
              className="ghost"
              onClick={() => resetNight(scopeNight)}
              title="Drop this night's differences — it returns to the whole-stay rooms"
            >
              Reset night
            </button>
          )}
        </div>
      )}
      {overriddenNights.length > 0 && (
        <div className="rcb-nightsum">
          <span className="rce-lbl">Nights that differ</span>
          {overriddenNights.map((n) => (
            <span key={n} className="rcb-nightpill">
              {nightLabel(n)}
              <button type="button" onClick={() => resetNight(n)} title={`Reset ${nightLabel(n)} to the whole-stay rooms`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {capMsg && <p className="rce-warns" style={{ margin: 0 }}>{capMsg}</p>}

      {/* Unplaced tray — also a drop target for pulling guests back out of rooms. */}
      {unplaced.length > 0 && (
        <div className={`rcb-tray${dragOver === "tray" ? " drop" : ""}`} {...zoneDragProps("tray", null)}>
          <div className="rcb-tray-head">
            <span className="rce-lbl">Unplaced guests</span>
            <button
              type="button"
              className="rcb-mini"
              onClick={() => setSelected(new Set(unplaced.map((g) => g.key)))}
              title="Select every unplaced guest"
            >
              <CheckSquare style={{ width: 11, height: 11 }} /> Select all
            </button>
            <span className="rcb-tray-note">tap guests, then tap a room — or drag them in</span>
          </div>
          <div className="rcb-chips">{unplaced.map((g) => chip(g))}</div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="rcb-planbar">
          <span className="cnt">{selected.size} selected</span>
          <span className="ln" />
          <button type="button" className="ghost" onClick={() => placeSelection(null)} title="Move the selection back to the tray">
            <Undo2 style={{ width: 11, height: 11 }} /> To tray
          </button>
          <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
            Done
          </button>
        </div>
      )}

      <div className="rcb-rooms" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))" }}>
        {/* EVERY room, in room-number order — the ones that can't take guests are rendered in
            place rather than in a separate list below, so the board reads as one floor exactly
            like the table does. `rows` is already sorted by room number. */}
        {rows.map((row) => {
          if (!binIds.has(row.roomId)) {
            const d = takenDetail(row);
            return (
              <div
                key={row.roomId}
                className="rcb-room"
                style={{ opacity: 0.6, background: "var(--cream-2)", borderStyle: "dashed", cursor: "not-allowed" }}
                title={
                  d.holder
                    ? `${d.label}${d.holder.name ? ` by ${d.holder.name}` : ""}${d.holder.ref ? ` (${d.holder.ref})` : ""}`
                    : d.note ?? d.label
                }
              >
                <div className="rcb-room-head">
                  <span className="rce-roomno">Room {row.roomNumber}</span>
                  <span className="rcb-type">{row.roomTypeName}</span>
                  <span className="ln" />
                  <span className="tag" style={{ fontSize: 9 }}>
                    {d.label}
                  </span>
                </div>
                <p style={{ fontSize: 10.5, color: "var(--ink-3)", margin: "4px 0 0", lineHeight: 1.45 }}>
                  {d.holder ? (
                    <>
                      {d.holder.name ?? "Another booking"}
                      {d.holder.ref ? <span className="mono"> · {d.holder.ref}</span> : null}
                    </>
                  ) : (
                    d.note ?? "Not available for these dates"
                  )}
                  {d.partial && (
                    <>
                      <br />
                      Taken {d.takenNights.map(nightLabel).join(", ")} only
                    </>
                  )}
                </p>
              </div>
            );
          }
          const here = guests.filter((g) => scopeMap[g.key] === row.roomId);
          const chargeable = chargeableIn(scopeMap, row.roomId);
          const inUse = here.length > 0;
          const cap = capOf(row.roomId);
          // Capacity is CHARGEABLE guests only — under-11s share bedding (backend rule).
          const overCap = cap != null && chargeable > cap;
          // Beds full is NOT the same as closed: an under-11 takes no slot, so the room may still
          // have room for a child. `closed` is the honest "nothing more fits" — both ceilings hit.
          const bedsFull = cap != null && chargeable >= cap;
          const kidsMax = maxChildrenOf(row.roomId);
          const kidsFull = kidsMax != null && childrenIn(scopeMap, row.roomId) >= kidsMax;
          const closed = bedsFull && (kidsFull || kidsMax === 0);
          // Would the CURRENT drag land here? Non-null = this room refuses it, and says why.
          const dragReject = dragging.length > 0 ? rejectReason(row.roomId, dragging) : null;
          const blockedForSelection = selected.size > 0 ? rejectReason(row.roomId, [...selected]) : null;
          return (
            <div
              key={row.roomId}
              className={`rcb-room${bedsFull ? " full" : ""}${dragOver === row.roomId && !dragReject ? " drop" : ""}`}
              style={
                dragReject
                  ? { borderColor: "var(--stop)", opacity: 0.55, cursor: "not-allowed" }
                  : inUse && !bedsFull
                    ? { borderColor: "var(--green)", boxShadow: "0 0 0 1px var(--green)" }
                    : undefined
              }
              title={dragReject ?? undefined}
              {...zoneDragProps(row.roomId, row.roomId, dragReject)}
            >
              <div className="rcb-room-head">
                <span className="rce-roomno">Room {row.roomNumber}</span>
                <span className="rcb-type">{row.roomTypeName}</span>
                <span className="ln" />
                {bedsFull && (
                  <span
                    className="tag warn"
                    style={{ fontSize: 9 }}
                    title={
                      closed
                        ? "Nothing more fits in this room"
                        : `Beds are full, but a child under ${childMax + 1} shares bedding and can still join`
                    }
                  >
                    {closed ? "Full" : "Beds full"}
                  </span>
                )}
                {row.bucket === "deficient" && (
                  <span className="tag warn" style={{ fontSize: 9 }}>
                    Deficient
                  </span>
                )}
                <span
                  className={`rcb-occ${overCap ? " over" : ""}`}
                  title={
                    cap != null
                      ? `${here.length} guest${here.length === 1 ? "" : "s"} in the room · ${chargeable}/${cap} capacity used — children under ${childMax + 1} share bedding and don't count`
                      : undefined
                  }
                >
                  {here.length ? `${chargeable}${cap != null ? `/${cap}` : ""}${here.length > chargeable ? ` +${here.length - chargeable}kid` : ""}` : "free"}
                </span>
              </div>

              {selected.size > 0 && !disabled && (
                <button
                  type="button"
                  className="rcb-place"
                  disabled={!!blockedForSelection}
                  title={blockedForSelection ?? undefined}
                  onClick={() => placeSelection(row.roomId)}
                >
                  {blockedForSelection ? "Doesn't fit here" : `+ Place ${selected.size} here`}
                </button>
              )}

              {here.length > 0 && <div className="rcb-chips">{here.map((g) => chip(g))}</div>}
              {overCap && (
                <p className="rcb-overcap">
                  {chargeable} adult-rate guests for capacity {cap} — move someone out, or extra beds are
                  arranged on the Quote step.
                </p>
              )}
            </div>
          );
        })}
      </div>

      {takenRows.length > 0 && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", margin: 0 }}>
          {takenRows.length} of these room{takenRows.length === 1 ? " is" : "s are"} booked, held or out of
          service {scopeNight ? `on ${nightLabel(scopeNight)}` : "for these dates"} — shown dashed above,
          with who holds {takenRows.length === 1 ? "it" : "them"}. Nobody can be placed in those.
        </p>
      )}
      {unplaced.length > 0 && roomsInUse === maxRooms && (
        <p className="rce-warns" style={{ margin: 0 }}>
          {unplaced.length} guest{unplaced.length === 1 ? "" : "s"} still in the tray — place everyone so the
          room split is realistic (rooms are saved either way; placement itself isn&rsquo;t kept at this step).
        </p>
      )}
      <p className="rce-hint">
        Placing guests is how you pick rooms here — a room with someone in it joins the selection ({maxRooms}{" "}
        room{maxRooms === 1 ? "" : "s"} needed{nights.length > 1 ? " on every night" : ""}, then save with the
        button above). Children under {childMax + 1} share bedding and don&rsquo;t use a capacity slot. Who
        finally sleeps where — and meal plans — is set on the <b>Quote</b> step&rsquo;s guest board; this
        placement isn&rsquo;t saved at S1.
      </p>
    </div>
  );
}
