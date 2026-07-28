"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, Undo2, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import { RoomCompositionsTable } from "./room-compositions-table";

/**
 * Guest-board composition planner (2026-07-28) — the people-first replacement for the
 * counts-first grid on the S2 quote step.
 *
 * The booking party from intake (adults + per-child ages) is rendered as one chip per
 * GUEST; sealed rooms are bins. The operator moves people, not numbers:
 *   - tap chips to multi-select, then tap "Place here" on a room — or drag-and-drop;
 *   - with a selection active, a plan bar appears: one tap puts everyone selected on
 *     CP / MAP / AP; a tiny per-chip dropdown handles one-off plans;
 *   - every count the backend needs (occupants, adult / CNB bands, mealPlan*Count
 *     tallies) is DERIVED from chip placement, so the Policy-79 consistency rules hold
 *     by construction — no clamp warnings, no mental arithmetic.
 *
 * Room-level extras (extra beds, SC / GST / FOC, Others à-la-carte pax, negotiated
 * rates) stay as a compact per-room footer, same fields as the counts grid.
 *
 * `RoomCompositionPlanner` is the export the quote step mounts: it defaults to the
 * board whenever the entry carries a party breakdown, and offers the legacy
 * `RoomCompositionsEditor` counts grid as a fallback mode — needed when intake never
 * captured adults/children, or when the quoted occupancy legitimately differs from
 * the intake party. Only the ACTIVE mode is mounted (both auto-emit on mount; keeping
 * both alive would race the parent's single `roomCompositions` state).
 *
 * Age-band cutoffs come from GET /api/lookups/child-policy (admin-editable). CNB 11+
 * is retired (2026-07-28): a declared child above the child band joins the adult pool.
 * NO MONEY IS COMPUTED HERE — the backend prices when the draft is created.
 */

type PlanPick = "NONE" | "CP" | "MAPL" | "MAPD" | "AP" | "OTHERS";

const PLAN_LABEL: Record<PlanPick, string> = {
  NONE: "None (EP)",
  CP: "CP · breakfast",
  MAPL: "MAP · +lunch",
  MAPD: "MAP · +dinner",
  AP: "AP · all meals",
  OTHERS: "Others",
};

/** Short form for the plan bar buttons + chip badge. */
const PLAN_SHORT: Record<PlanPick, string> = {
  NONE: "EP",
  CP: "CP",
  MAPL: "MAP+L",
  MAPD: "MAP+D",
  AP: "AP",
  OTHERS: "Oth",
};

const PLAN_ORDER: PlanPick[] = ["NONE", "CP", "MAPL", "MAPD", "AP", "OTHERS"];

type Band = "ADULT" | "C6TO10" | "UNDER6";

type Guest = {
  /** Stable key — independent of the async policy cutoffs so placements survive the
   *  child-policy lookup resolving after first paint. */
  key: string;
  band: Band;
  label: string;
};

/** Normalise an entry date to a midnight-UTC ISO string (entry dates arrive as full
 *  ISO timestamps; slicing the day out first avoids invalid-date throws). */
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function num(v: string | undefined): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type RoomExtras = {
  extraBed: string;
  sc: boolean;
  gst: boolean;
  foc: boolean;
  othersB: string;
  othersL: string;
  othersD: string;
  rateRoom: string;
  rateBed: string;
  rateBf: string;
  rateLu: string;
  rateDi: string;
  ratesOpen: boolean;
};

const EMPTY_EXTRAS: RoomExtras = {
  extraBed: "0",
  sc: true,
  gst: true,
  foc: false,
  othersB: "",
  othersL: "",
  othersD: "",
  rateRoom: "",
  rateBed: "",
  rateBf: "",
  rateLu: "",
  rateDi: "",
  ratesOpen: false,
};

export function RoomCompositionsBoard({
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  onChange,
}: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const { session } = useSession();
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomById = new Map((roomsQuery.data?.items ?? []).map((r) => [r.id, r]));

  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  // Same backend capacity envelope the S1 rooms inputs use — surfaces "this party can't
  // fit in the sealed room count" up front, because the fix is back in Inquiry.
  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  // The party as individual guests. Child keys are positional (`K3`) rather than
  // band-derived so a placement survives the policy cutoffs arriving and re-banding
  // a child; only the label/band swap, never the key.
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
  const guestByKey = new Map(guests.map((g) => [g.key, g]));

  // guestKey → roomId; missing/"" = unplaced tray.
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [plans, setPlans] = useState<Record<string, PlanPick>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<Record<string, RoomExtras>>({});
  // Drop-target highlight while dragging: roomId or "tray".
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    setExtras((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const next = { ...prev };
      for (const id of sealedRoomIds) if (!next[id]) next[id] = { ...EMPTY_EXTRAS };
      return next;
    });
  }, [sealedRoomIds]);

  /** Spread the party: adults evenly with the remainder on the first room; children all
   *  in the first room so a family stays together (and that room is guaranteed the most
   *  adults). A starting point — every chip stays movable. */
  const autoAssign = () => {
    const n = sealedRoomIds.length;
    if (n === 0) return;
    const adultKeys = guests.filter((g) => g.band === "ADULT").map((g) => g.key);
    const childKeys = guests.filter((g) => g.band !== "ADULT").map((g) => g.key);
    const base = Math.floor(adultKeys.length / n);
    const rem = adultKeys.length % n;
    const next: Record<string, string> = {};
    let cursor = 0;
    sealedRoomIds.forEach((id, i) => {
      const take = base + (i < rem ? 1 : 0);
      for (let k = 0; k < take; k++) next[adultKeys[cursor++]] = id;
    });
    for (const key of childKeys) next[key] = sealedRoomIds[0];
    setAssign(next);
  };

  // First-open auto-assign, once, while nothing has been placed — the operator lands on
  // a sensible split instead of an empty board. Ref-guarded against re-renders.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current || sealedRoomIds.length === 0 || guests.length === 0) return;
    if (Object.keys(assign).length > 0) {
      autoRanRef.current = true;
      return;
    }
    autoRanRef.current = true;
    autoAssign();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealedRoomIds, guests.length]);

  // Derive + emit the backend composition rows whenever the board changes. Counts are
  // tallied from chip placement, so adults + bands always equals occupants and plan pax
  // never exceeds occupants (Policy 79 by construction).
  useEffect(() => {
    const out: RoomCompositionInput[] = sealedRoomIds.map((id) => {
      const here = guests.filter((g) => assign[g.key] === id);
      const x = extras[id] ?? EMPTY_EXTRAS;
      const tally: Record<PlanPick, number> = { NONE: 0, CP: 0, MAPL: 0, MAPD: 0, AP: 0, OTHERS: 0 };
      for (const g of here) tally[plans[g.key] ?? "NONE"] += 1;
      return {
        roomId: id,
        startDate: dayToIso(entryCheckIn),
        endDate: dayToIso(entryCheckOut),
        occupantCount: here.length,
        adultCount: here.filter((g) => g.band === "ADULT").length,
        cnb6To10Count: here.filter((g) => g.band === "C6TO10").length,
        cnbUnder6Count: here.filter((g) => g.band === "UNDER6").length,
        extraBedCount: num(x.extraBed) ?? 0,
        mealPlanCpCount: tally.CP,
        mealPlanMaplCount: tally.MAPL,
        mealPlanMapdCount: tally.MAPD,
        mealPlanApCount: tally.AP,
        mealPlanOthersCount: tally.OTHERS,
        othersBreakfastPax: num(x.othersB),
        othersLunchPax: num(x.othersL),
        othersDinnerPax: num(x.othersD),
        negotiatedRoomRate: num(x.rateRoom),
        negotiatedExtraBedRate: num(x.rateBed),
        negotiatedBreakfastRate: num(x.rateBf),
        negotiatedLunchRate: num(x.rateLu),
        negotiatedDinnerRate: num(x.rateDi),
        serviceChargeApplies: x.sc,
        gstApplies: x.gst,
        isFoc: x.foc,
      };
    });
    onChange(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assign, plans, extras, sealedRoomIds, guests, entryCheckIn, entryCheckOut]);

  const setExtra = (roomId: string, patch: Partial<RoomExtras>) =>
    setExtras((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? EMPTY_EXTRAS), ...patch } }));

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const placeKeys = (keys: string[], roomId: string | null) => {
    setAssign((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (roomId) next[k] = roomId;
        else delete next[k];
      }
      return next;
    });
  };

  /** Place the current selection (tap flow) and keep it selected so a plan can be
   *  applied right after — the two most common actions chain without re-picking. */
  const placeSelection = (roomId: string | null) => {
    if (selected.size === 0) return;
    placeKeys([...selected], roomId);
  };

  const applyPlanToSelection = (plan: PlanPick) => {
    if (selected.size === 0) return;
    setPlans((prev) => {
      const next = { ...prev };
      for (const k of selected) next[k] = plan;
      return next;
    });
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
      // Only clear when actually leaving the zone, not moving between its children.
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver(null);
    },
    onDrop: onZoneDrop(roomId),
  });

  const unplaced = guests.filter((g) => !assign[g.key] || !sealedRoomIds.includes(assign[g.key]));
  const placedCount = guests.length - unplaced.length;

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
        Seal a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  const chip = (g: Guest, inRoom: boolean) => {
    const plan = plans[g.key] ?? "NONE";
    const isSel = selected.has(g.key);
    return (
      <div
        key={g.key}
        className={`rcb-chip band-${g.band.toLowerCase()}${isSel ? " sel" : ""}`}
        draggable
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
        {inRoom && (
          <select
            value={plan}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setPlans((prev) => ({ ...prev, [g.key]: e.target.value as PlanPick }))}
            title="Meal plan for this guest"
          >
            {PLAN_ORDER.map((p) => (
              <option key={p} value={p}>
                {PLAN_SHORT[p]}
              </option>
            ))}
          </select>
        )}
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
          title="Spread the party evenly across the rooms (children stay together in the first room)"
        >
          <Wand2 style={{ width: 13, height: 13 }} /> Auto-assign
        </button>
        <span className="ln" />
        {roomMin != null && (
          <span
            className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`}
            title="Backend capacity envelope: chargeable guests vs the largest room capacity"
          >
            needs ≥ {roomMin} room{roomMin === 1 ? "" : "s"} · {sealedRoomIds.length} sealed
          </span>
        )}
        <span className={`rce-tally${placedCount !== guests.length ? " off" : ""}`}>
          {placedCount} of {guests.length} guests placed
        </span>
      </div>
      {roomMin != null && sealedRoomIds.length < roomMin && (
        <p className="rce-block">
          {roomEnvelopeQuery.data?.chargeableOccupants} chargeable guest
          {(roomEnvelopeQuery.data?.chargeableOccupants ?? 0) === 1 ? "" : "s"} won&rsquo;t fit in{" "}
          {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} — go back to Inquiry and seal at
          least {roomMin}.
        </p>
      )}

      {/* Plan bar — appears with a selection; the one place bulk actions live. */}
      {selected.size > 0 && (
        <div className="rcb-planbar">
          <span className="cnt">
            {selected.size} selected
          </span>
          <span className="lbl">meal plan:</span>
          {PLAN_ORDER.map((p) => (
            <button key={p} type="button" onClick={() => applyPlanToSelection(p)} title={PLAN_LABEL[p]}>
              {PLAN_SHORT[p]}
            </button>
          ))}
          <span className="ln" />
          <button type="button" className="ghost" onClick={() => placeSelection(null)} title="Move the selection back to the tray">
            <Undo2 style={{ width: 11, height: 11 }} /> To tray
          </button>
          <button type="button" className="ghost" onClick={() => setSelected(new Set())}>
            Done
          </button>
        </div>
      )}

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
          <div className="rcb-chips">{unplaced.map((g) => chip(g, false))}</div>
        </div>
      )}

      <div className="rcb-rooms">
        {sealedRoomIds.map((id) => {
          const room = roomById.get(id);
          const roomNumber = room?.roomNumber ?? id.slice(0, 6);
          const here = guests.filter((g) => assign[g.key] === id);
          const x = extras[id] ?? EMPTY_EXTRAS;
          const othersCount = here.filter((g) => (plans[g.key] ?? "NONE") === "OTHERS").length;
          const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
          const overCap = cap != null && here.length > cap + (num(x.extraBed) ?? 0);
          return (
            <div key={id} className={`rcb-room${x.foc ? " foc" : ""}${dragOver === id ? " drop" : ""}`} {...zoneDragProps(id, id)}>
              <div className="rcb-room-head">
                <span className="rce-roomno">Room {roomNumber}</span>
                {room?.roomType?.name && <span className="rcb-type">{room.roomType.name}</span>}
                <span className="ln" />
                <span className={`rcb-occ${overCap ? " over" : ""}`} title={cap != null ? `Capacity ${cap}${overCap ? " — over" : ""}` : undefined}>
                  {here.length}
                  {cap != null ? `/${cap}` : ""} <span aria-hidden>·</span> {num(x.extraBed) ?? 0} bed
                </span>
                {here.length > 0 && (
                  <button
                    type="button"
                    className="rcb-mini"
                    onClick={() => setSelected(new Set(here.map((g) => g.key)))}
                    title="Select everyone in this room"
                  >
                    <CheckSquare style={{ width: 11, height: 11 }} /> Select
                  </button>
                )}
              </div>

              {selected.size > 0 && (
                <button type="button" className="rcb-place" onClick={() => placeSelection(id)}>
                  + Place {selected.size} here
                </button>
              )}

              {here.length === 0 && selected.size === 0 ? (
                <p className="rcb-empty">No guests — tap or drag chips in.</p>
              ) : (
                <div className="rcb-chips">{here.map((g) => chip(g, true))}</div>
              )}
              {overCap && (
                <p className="rcb-overcap">
                  {here.length} guests for capacity {cap} + {num(x.extraBed) ?? 0} extra bed{(num(x.extraBed) ?? 0) === 1 ? "" : "s"} —
                  add beds below or move someone out.
                </p>
              )}

              <div className="rcb-foot">
                <span className="rcb-step">
                  <label>Extra beds</label>
                  <button type="button" onClick={() => setExtra(id, { extraBed: String(Math.max(0, (num(x.extraBed) ?? 0) - 1)) })}>
                    −
                  </button>
                  <b>{num(x.extraBed) ?? 0}</b>
                  <button type="button" onClick={() => setExtra(id, { extraBed: String((num(x.extraBed) ?? 0) + 1) })}>
                    +
                  </button>
                </span>
                <span className="ln" />
                <label className="rce-tog">
                  <input type="checkbox" checked={x.sc} onChange={(e) => setExtra(id, { sc: e.target.checked })} /> SC
                </label>
                <label className="rce-tog">
                  <input type="checkbox" checked={x.gst} onChange={(e) => setExtra(id, { gst: e.target.checked })} /> GST
                </label>
                <label className="rce-tog">
                  <input type="checkbox" checked={x.foc} onChange={(e) => setExtra(id, { foc: e.target.checked })} /> <b>FOC</b>
                </label>
              </div>

              {othersCount > 0 && (
                <div className="rce-grid three rce-others">
                  <MiniNum label="Others b'fast pax" value={x.othersB} onChange={(v) => setExtra(id, { othersB: v })} />
                  <MiniNum label="Others lunch pax" value={x.othersL} onChange={(v) => setExtra(id, { othersL: v })} />
                  <MiniNum label="Others dinner pax" value={x.othersD} onChange={(v) => setExtra(id, { othersD: v })} />
                </div>
              )}

              <button type="button" className="rce-adv" onClick={() => setExtra(id, { ratesOpen: !x.ratesOpen })}>
                {x.ratesOpen ? "− Hide" : "+ Negotiated rates (optional)"}
              </button>
              {x.ratesOpen && (
                <div className="rce-grid five">
                  <MiniNum label="Room rate" value={x.rateRoom} onChange={(v) => setExtra(id, { rateRoom: v })} />
                  <MiniNum label="Extra bed" value={x.rateBed} onChange={(v) => setExtra(id, { rateBed: v })} />
                  <MiniNum label="Breakfast" value={x.rateBf} onChange={(v) => setExtra(id, { rateBf: v })} />
                  <MiniNum label="Lunch" value={x.rateLu} onChange={(v) => setExtra(id, { rateLu: v })} />
                  <MiniNum label="Dinner" value={x.rateDi} onChange={(v) => setExtra(id, { rateDi: v })} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {unplaced.length > 0 && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          {unplaced.length} guest{unplaced.length === 1 ? "" : "s"} still unplaced — they won&rsquo;t be on the
          quote until placed in a room.
        </p>
      )}
      <p className="rce-hint">
        Totals are priced by the backend when you create the draft — figures appear on the quote below.
        Child meal discounts on per-room plans are pending a backend update; until then every counted
        guest is charged the full plan rate (leave infants on <i>EP</i> if they eat free).
      </p>
    </div>
  );
}

function MiniNum({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <div className="rce-f">
      <label>{label}</label>
      <input type="number" min={0} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * Mode wrapper the quote step mounts. Two modes: the spreadsheet-style table
 * (`RoomCompositionsTable`, default — one row per room, derived Occ, arrow-key cell
 * navigation, bulk fills) and the guest board above (chips into bins). The board needs
 * the intake party breakdown, so its toggle hides when the entry has none; the table
 * works either way (raw counts entry — also the path when quoted occupancy differs
 * from the intake party). Only the active mode is mounted — both auto-emit on mount,
 * and keeping both alive would race the parent's single `roomCompositions` state;
 * switching starts the new mode fresh. The pre-2026-07-28 per-room-cards editor
 * (`RoomCompositionsEditor`) is retired from this wrapper — the table covers the same
 * counts-first entry in one grid.
 */
export function RoomCompositionPlanner(props: {
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const canBoard = (props.entryAdults ?? 0) > 0 || (props.entryChildAges?.length ?? 0) > 0;
  const [mode, setMode] = useState<"table" | "board">("table");
  if (!canBoard) return <RoomCompositionsTable {...props} />;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="seg rce-seg" style={{ justifySelf: "start" }}>
        <button
          type="button"
          className={mode === "table" ? "on" : ""}
          onClick={() => setMode("table")}
          title="Spreadsheet grid — one row per room, arrow keys move between cells, Occ is derived"
        >
          Table
        </button>
        <button
          type="button"
          className={mode === "board" ? "on" : ""}
          onClick={() => setMode("board")}
          title="Place each guest in a room and pick their meal plan — counts are derived. Switching resets entries."
        >
          Guest board
        </button>
      </div>
      {mode === "table" ? <RoomCompositionsTable {...props} /> : <RoomCompositionsBoard {...props} />}
    </div>
  );
}
