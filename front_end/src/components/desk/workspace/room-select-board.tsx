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
  onSelectionChange,
  onPerNightChange,
  capacityByRoomId,
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
  const hiddenCount = rows.length - binRows.length;

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
   * Spread `guests` across `roomIds`, capacity-aware on CHARGEABLE load: children go to the
   * earliest room (they consume no slot but should sit with the family lead), adults fill the
   * least-loaded room with chargeable space. Whoever doesn't fit stays in the tray.
   */
  const spreadAcross = (roomIds: string[]): Record<string, string> => {
    const next: Record<string, string> = {};
    if (roomIds.length === 0) return next;
    const load = new Map<string, number>(roomIds.map((id) => [id, 0]));
    const fits = (id: string) => {
      const cap = capOf(id);
      return cap == null || (load.get(id) ?? 0) < cap;
    };
    for (const g of guests.filter((x) => x.band !== "ADULT")) {
      next[g.key] = roomIds[0]; // no capacity slot consumed — keep the family together
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

  // Mount-time seed: resume from the table mode's selection (spread the party across it).
  // Waits for the capacities so the spread can't overfill blind.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || guests.length === 0 || !capacitiesReady) return;
    seededRef.current = true;
    const seedRooms = selectedRoomIds.filter((id) => binIds.has(id)).slice(0, maxRooms);
    if (seedRooms.length > 0) setBase(spreadAcross(seedRooms));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guests.length, binIds, capacitiesReady]);

  // Emit on every change: base rooms for tableSel continuity + the full per-night picture
  // for the seal. Skipped for a party-less entry so mounting can't wipe the table's picks.
  useEffect(() => {
    if (guests.length === 0) return;
    const roomsOf = (map: Record<string, string>) =>
      rows.filter((r) => guests.some((g) => map[g.key] === r.roomId)).map((r) => r.roomId);
    onSelectionChange(roomsOf(base));
    if (onPerNightChange) {
      const perNight: BoardPerNight = nights.map((n) => ({ date: n, roomIds: roomsOf(mapForNight(n)) }));
      onPerNightChange(perNight, Object.keys(nightOverrides).length > 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, nightOverrides, rows, guests, nights]);

  /** Write a placement into the current scope, guarding room-count and chargeable capacity. */
  const placeKeys = (keys: string[], roomId: string | null) => {
    const cur = scopeMap;
    if (roomId) {
      const cap = capOf(roomId);
      if (cap != null) {
        const current = chargeableIn(cur, roomId);
        const incoming = keys.filter((k) => cur[k] !== roomId && isChargeable(k)).length;
        if (current + incoming > cap) {
          const spots = Math.max(0, cap - current);
          const row = binRows.find((r) => r.roomId === roomId);
          flash(
            `Room ${row?.roomNumber ?? ""} sleeps ${cap} — ${
              spots === 0 ? "it's full" : `only space for ${spots} more adult${spots === 1 ? "" : "s"}`
            }. Children under ${childMax + 1} share bedding and don't take a slot.`,
          );
          return;
        }
      }
    }
    const next = { ...cur };
    for (const k of keys) {
      if (roomId) next[k] = roomId;
      else delete next[k];
    }
    const distinct = new Set(Object.values(next).filter((id) => binIds.has(id)));
    if (roomId && distinct.size > maxRooms) {
      flash(
        `This booking needs ${maxRooms} room${maxRooms === 1 ? "" : "s"}${
          scopeNight ? ` on ${nightLabel(scopeNight)}` : ""
        } — move everyone out of one room first, or raise "Rooms required" and search again.`,
      );
      return;
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
  const onChipDragStart = (key: string) => (e: React.DragEvent) => {
    const keys = selected.has(key) ? [...selected] : [key];
    dragKeysRef.current = keys;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", keys.join(","));
  };
  const onZoneDrop = (roomId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const keys = dragKeysRef.current.length
      ? dragKeysRef.current
      : (e.dataTransfer.getData("text/plain") || "").split(",").filter(Boolean);
    dragKeysRef.current = [];
    if (keys.length) placeKeys(keys, roomId);
  };
  const zoneDragProps = (zone: string, roomId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
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
        onDragEnd={() => {
          dragKeysRef.current = [];
          setDragOver(null);
        }}
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

      {/* Night scope — placement can differ per night (mid-stay room change). "All nights"
          edits the base; a marked night carries its own placement until reset. */}
      {nights.length > 1 && (
        <div className="rcb-planbar rcb-nightbar">
          <span className="lbl">placing for:</span>
          <button
            type="button"
            className={scopeNight == null ? "on" : ""}
            onClick={() => setScopeNight(null)}
            title="Place rooms for the whole stay"
          >
            All nights
          </button>
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
        {binRows.map((row) => {
          const here = guests.filter((g) => scopeMap[g.key] === row.roomId);
          const chargeable = chargeableIn(scopeMap, row.roomId);
          const inUse = here.length > 0;
          const cap = capOf(row.roomId);
          // Capacity is CHARGEABLE guests only — under-11s share bedding (backend rule).
          const overCap = cap != null && chargeable > cap;
          const incomingChargeable = [...selected].filter((k) => scopeMap[k] !== row.roomId && isChargeable(k)).length;
          const wontFit = cap != null && chargeable + incomingChargeable > cap;
          const full = cap != null && chargeable >= cap;
          // A full room still takes a selection of ONLY children (they consume no slot).
          const blockedForSelection = wontFit && incomingChargeable > 0;
          return (
            <div
              key={row.roomId}
              className={`rcb-room${full ? " full" : ""}${dragOver === row.roomId && !blockedForSelection ? " drop" : ""}`}
              style={inUse && !full ? { borderColor: "var(--green)", boxShadow: "0 0 0 1px var(--green)" } : undefined}
              {...zoneDragProps(row.roomId, row.roomId)}
            >
              <div className="rcb-room-head">
                <span className="rce-roomno">Room {row.roomNumber}</span>
                <span className="rcb-type">{row.roomTypeName}</span>
                <span className="ln" />
                {full && (
                  <span className="tag warn" style={{ fontSize: 9 }}>
                    Full
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

              {selected.size > 0 && !disabled && !(full && incomingChargeable > 0) && (
                <button
                  type="button"
                  className="rcb-place"
                  disabled={blockedForSelection}
                  title={
                    blockedForSelection
                      ? `Room ${row.roomNumber} sleeps ${cap} adults — the selection doesn't fit`
                      : undefined
                  }
                  onClick={() => placeSelection(row.roomId)}
                >
                  {blockedForSelection
                    ? `Only space for ${Math.max(0, (cap ?? 0) - chargeable)}`
                    : `+ Place ${selected.size} here`}
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

      {hiddenCount > 0 && (
        <p style={{ fontSize: 11, color: "var(--ink-3)", margin: 0 }}>
          {hiddenCount} room{hiddenCount === 1 ? "" : "s"} not shown — taken or out of service{" "}
          {scopeNight ? `on ${nightLabel(scopeNight)}` : "for these dates"}. Switch to the table to see who
          holds them.
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
