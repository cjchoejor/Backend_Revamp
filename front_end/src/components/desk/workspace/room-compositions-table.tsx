"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import type { RoomCompositionInput } from "@/lib/api/quotations";

/**
 * Spreadsheet-style composition table (2026-07-28) — the pure-tabular alternative to the
 * guest board on the S2 quote step. One row per sealed room, every field a cell, in the
 * shape the hotel's legacy PMS grid trained the staff on.
 *
 * What makes it a spreadsheet and not just a dense form:
 *   - "Occ" is DERIVED (adults + child bands) — the Policy-79 "breakdown ≠ occupants"
 *     error can no longer be typed, so that whole warning class is gone;
 *   - arrow keys / Enter walk the grid cell-to-cell (inputs are text+numeric, not
 *     type=number, so ArrowUp/Down navigates instead of spinning the value);
 *   - bulk actions do the repetitive part: "Distribute party" spreads the booking's
 *     guests across rows, "Everyone on <plan>" sets each room's plan pax to its
 *     occupancy, "Copy row 1 ↓" clones meals / beds / toggles / rates (never the
 *     guest bands) onto every other row;
 *   - a live Σ footer reconciles guests placed vs the intake party and sums each
 *     meal-plan column;
 *   - columns are ADAPTIVE (2026-07-28): CNB columns only exist when the intake party
 *     has children (a "Kids +" corner toggle covers occupancies that differ from
 *     intake), and meal-plan columns appear per plan as the operator toggles its chip
 *     or picks "Everyone on…" — a two-adult CP booking sees a 2-guest, 1-meal grid,
 *     not the full matrix. A column with pax in it can never silently hide; switching
 *     a plan chip off zeroes its column so nothing invisible feeds the draft.
 *
 * Meal pax that exceed a row's occupancy get a warn outline (Policy 79's second rule —
 * still enforced server-side on draft). Negotiated-rate columns and Others à-la-carte
 * columns stay collapsed until toggled / needed so the common case stays narrow.
 * NO MONEY IS COMPUTED HERE — the backend prices when the draft is created.
 */

type RowState = {
  ad: string;
  c6: string;
  u6: string;
  bed: string;
  cp: string;
  ml: string;
  md: string;
  ap: string;
  ot: string;
  obf: string;
  olu: string;
  odi: string;
  rRoom: string;
  rBed: string;
  rBf: string;
  rLu: string;
  rDi: string;
  sc: boolean;
  gst: boolean;
  foc: boolean;
};

const EMPTY_ROW: RowState = {
  ad: "",
  c6: "",
  u6: "",
  bed: "0",
  cp: "0",
  ml: "0",
  md: "0",
  ap: "0",
  ot: "0",
  obf: "",
  olu: "",
  odi: "",
  rRoom: "",
  rBed: "",
  rBf: "",
  rLu: "",
  rDi: "",
  sc: true,
  gst: true,
  foc: false,
};

type NumCol = Exclude<keyof RowState, "sc" | "gst" | "foc">;
const MEAL_COLS: NumCol[] = ["cp", "ml", "md", "ap", "ot"];
const MEAL_META: Record<string, { chip: string; th: string; title: string }> = {
  cp: { chip: "CP", th: "CP", title: "Breakfast only" },
  ml: { chip: "MAP+L", th: "M+L", title: "Breakfast + lunch" },
  md: { chip: "MAP+D", th: "M+D", title: "Breakfast + dinner" },
  ap: { chip: "AP", th: "AP", title: "All meals" },
  ot: { chip: "Others", th: "Oth", title: "Others — à-la-carte, set pax in the columns that appear" },
};

function cnt(v: string): number {
  const n = parseInt(v || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function numOrUndef(v: string): number | undefined {
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Normalise an entry date to a midnight-UTC ISO string (entry dates arrive as full
 *  ISO timestamps; slicing the day out first avoids invalid-date throws). */
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function RoomCompositionsTable({
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

  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [ratesOpen, setRatesOpen] = useState(false);
  // Plans the operator switched on. A plan column is VISIBLE when toggled on OR when any
  // row carries pax for it — a column with data can never silently disappear.
  const [activePlans, setActivePlans] = useState<Set<NumCol>>(new Set());
  // CNB columns exist automatically when the intake party has children; the manual
  // toggle covers quoted occupancies that differ from intake (incl. no-party entries).
  const hasKids = (entryChildAges?.length ?? 0) > 0;
  const [childColsManual, setChildColsManual] = useState(false);
  const childColsVisible = hasKids || childColsManual;

  useEffect(() => {
    setRows((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const next = { ...prev };
      for (const id of sealedRoomIds) if (!next[id]) next[id] = { ...EMPTY_ROW };
      return next;
    });
  }, [sealedRoomIds]);

  const setCell = (roomId: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? EMPTY_ROW), ...patch } }));

  const visibleMeals = MEAL_COLS.filter(
    (c) => activePlans.has(c) || sealedRoomIds.some((id) => cnt(rows[id]?.[c] ?? "0") > 0),
  );

  /** Chip toggle for a plan column. Switching a visible plan OFF zeroes its column
   *  (and the Others à-la-carte pax when it's `ot`) — a hidden column must not keep
   *  feeding the draft. */
  const togglePlan = (c: NumCol) => {
    if (visibleMeals.includes(c)) {
      setActivePlans((prev) => {
        const n = new Set(prev);
        n.delete(c);
        return n;
      });
      setRows((prev) => {
        const next = { ...prev };
        for (const id of sealedRoomIds) {
          next[id] = { ...(next[id] ?? EMPTY_ROW), [c]: "0", ...(c === "ot" ? { obf: "", olu: "", odi: "" } : {}) };
        }
        return next;
      });
    } else {
      setActivePlans((prev) => new Set(prev).add(c));
    }
  };

  /** Manual CNB-columns toggle (only offered when the intake party has no children).
   *  Hiding zeroes the child cells for the same no-invisible-data reason as plans. */
  const toggleChildCols = () => {
    if (childColsVisible) {
      setChildColsManual(false);
      setRows((prev) => {
        const next = { ...prev };
        for (const id of sealedRoomIds) next[id] = { ...(next[id] ?? EMPTY_ROW), c6: "0", u6: "0" };
        return next;
      });
    } else {
      setChildColsManual(true);
    }
  };

  /** Party spread — adults evenly with the remainder on the first row, children all on
   *  the first row so a family shares a room. CNB 11+ retired: declared children above
   *  the child band join the adult pool. */
  const distribute = () => {
    const n = sealedRoomIds.length;
    if (n === 0) return;
    const ages = entryChildAges ?? [];
    const under6 = ages.filter((a) => a <= youngMax).length;
    const c6to10 = ages.filter((a) => a > youngMax && a <= childMax).length;
    const adults = Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length;
    const base = Math.floor(adults / n);
    const rem = adults % n;
    setRows((prev) => {
      const next = { ...prev };
      sealedRoomIds.forEach((id, i) => {
        next[id] = {
          ...(next[id] ?? { ...EMPTY_ROW }),
          ad: String(base + (i < rem ? 1 : 0)),
          c6: String(i === 0 ? c6to10 : 0),
          u6: String(i === 0 ? under6 : 0),
        };
      });
      return next;
    });
  };

  // First-open distribute, once, while the band columns are untouched — the operator
  // lands on a filled grid instead of a wall of zeros. Ref-guarded against re-renders.
  const autoRanRef = useRef(false);
  const ready = sealedRoomIds.length > 0 && sealedRoomIds.every((id) => rows[id]);
  useEffect(() => {
    if (autoRanRef.current || !ready) return;
    const pristine = sealedRoomIds.every((id) => rows[id].ad === "" && rows[id].c6 === "" && rows[id].u6 === "");
    autoRanRef.current = true;
    if (pristine && (entryAdults ?? 0) + (entryChildAges?.length ?? 0) > 0) distribute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** Every room's plan pax = its occupancy on ONE plan — the "whole booking is on CP"
   *  case in a single pick. Also collapses the visible plan columns to just that one. */
  const everyoneOn = (col: NumCol | "none") => {
    setActivePlans(col === "none" ? new Set() : new Set([col as NumCol]));
    setRows((prev) => {
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        const r = next[id] ?? { ...EMPTY_ROW };
        const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
        const meals = Object.fromEntries(MEAL_COLS.map((c) => [c, c === col ? String(occ) : "0"]));
        next[id] = { ...r, ...(meals as Partial<RowState>), ...(col === "ot" ? {} : { obf: "", olu: "", odi: "" }) };
      }
      return next;
    });
  };

  /** Clone row 1's meals / beds / toggles / rates / others pax onto every other row —
   *  never the guest bands (copying people would double the party). */
  const copyFirstDown = () => {
    const first = rows[sealedRoomIds[0]];
    if (!first) return;
    const { ad: _a, c6: _c, u6: _u, ...rest } = first;
    setRows((prev) => {
      const next = { ...prev };
      for (const id of sealedRoomIds.slice(1)) next[id] = { ...(next[id] ?? EMPTY_ROW), ...rest };
      return next;
    });
  };

  // Emit on every change. Occ is derived, so invariant (1) of Policy 79 holds by
  // construction; invariant (2) (plan pax ≤ occ) is warned inline and enforced server-side.
  useEffect(() => {
    const out: RoomCompositionInput[] = sealedRoomIds
      .filter((id) => rows[id])
      .map((id) => {
        const r = rows[id];
        const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
        return {
          roomId: id,
          startDate: dayToIso(entryCheckIn),
          endDate: dayToIso(entryCheckOut),
          occupantCount: occ,
          adultCount: cnt(r.ad),
          cnb6To10Count: cnt(r.c6),
          cnbUnder6Count: cnt(r.u6),
          extraBedCount: cnt(r.bed),
          mealPlanCpCount: cnt(r.cp),
          mealPlanMaplCount: cnt(r.ml),
          mealPlanMapdCount: cnt(r.md),
          mealPlanApCount: cnt(r.ap),
          mealPlanOthersCount: cnt(r.ot),
          othersBreakfastPax: numOrUndef(r.obf),
          othersLunchPax: numOrUndef(r.olu),
          othersDinnerPax: numOrUndef(r.odi),
          negotiatedRoomRate: numOrUndef(r.rRoom),
          negotiatedExtraBedRate: numOrUndef(r.rBed),
          negotiatedBreakfastRate: numOrUndef(r.rBf),
          negotiatedLunchRate: numOrUndef(r.rLu),
          negotiatedDinnerRate: numOrUndef(r.rDi),
          serviceChargeApplies: r.sc,
          gstApplies: r.gst,
          isFoc: r.foc,
        };
      });
    onChange(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sealedRoomIds, entryCheckIn, entryCheckOut]);

  // Others à-la-carte columns appear only once someone is on the Others plan.
  const othersVisible = sealedRoomIds.some((id) => cnt(rows[id]?.ot ?? "0") > 0);

  // ---- Spreadsheet keyboard navigation -------------------------------------------
  // Cells are addressed `row:col` via data-cell. Arrow keys move between cells (Left/
  // Right only once the caret is at the text boundary, so in-value cursor movement
  // still works); Enter moves down. Checkboxes participate too (Space still toggles).
  const wrapRef = useRef<HTMLDivElement>(null);
  const visibleCols: string[] = useMemo(() => {
    const cols: string[] = ["ad"];
    if (childColsVisible) cols.push("c6", "u6");
    cols.push("bed", ...visibleMeals);
    if (othersVisible) cols.push("obf", "olu", "odi");
    cols.push("sc", "gst", "foc");
    if (ratesOpen) cols.push("rRoom", "rBed", "rBf", "rLu", "rDi");
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [othersVisible, ratesOpen, childColsVisible, visibleMeals.join(",")]);

  const focusCell = (rowIdx: number, col: string) => {
    const el = wrapRef.current?.querySelector<HTMLInputElement>(`[data-cell="${rowIdx}:${col}"]`);
    if (el) {
      el.focus();
      if (el.type === "text") el.select();
    }
  };
  const onCellKeyDown = (rowIdx: number, col: string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const ci = visibleCols.indexOf(col);
    const atStart = input.type !== "text" || (input.selectionStart === 0 && input.selectionEnd === 0);
    const atEnd =
      input.type !== "text" ||
      (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      focusCell(Math.min(sealedRoomIds.length - 1, rowIdx + 1), col);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusCell(Math.max(0, rowIdx - 1), col);
    } else if (e.key === "ArrowRight" && atEnd && ci < visibleCols.length - 1) {
      e.preventDefault();
      focusCell(rowIdx, visibleCols[ci + 1]);
    } else if (e.key === "ArrowLeft" && atStart && ci > 0) {
      e.preventDefault();
      focusCell(rowIdx, visibleCols[ci - 1]);
    }
  };

  // ---- Totals ---------------------------------------------------------------------
  const sum = (col: NumCol) => sealedRoomIds.reduce((s, id) => s + cnt(rows[id]?.[col] ?? "0"), 0);
  const totalGuests = sum("ad") + sum("c6") + sum("u6");
  const partySize = (entryAdults ?? 0) + (entryChildAges?.length ?? 0);

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
        Seal a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  const numCell = (
    rowIdx: number,
    roomId: string,
    col: NumCol,
    opts?: { warn?: boolean; decimal?: boolean; wide?: boolean },
  ) => {
    const raw = rows[roomId]?.[col] ?? "";
    return (
      <td key={col} className={opts?.warn ? "warn" : undefined}>
        <input
          type="text"
          inputMode={opts?.decimal ? "decimal" : "numeric"}
          className={opts?.wide ? "wide" : undefined}
          data-cell={`${rowIdx}:${col}`}
          value={raw}
          onKeyDown={onCellKeyDown(rowIdx, col)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const v = e.target.value;
            // Digits only for counts; digits + one dot for rate cells.
            if (opts?.decimal ? /^\d*\.?\d*$/.test(v) : /^\d*$/.test(v)) setCell(roomId, { [col]: v });
          }}
        />
      </td>
    );
  };
  const boolCell = (rowIdx: number, roomId: string, col: "sc" | "gst" | "foc") => (
    <td key={col} className="ck">
      <input
        type="checkbox"
        data-cell={`${rowIdx}:${col}`}
        checked={rows[roomId]?.[col] ?? EMPTY_ROW[col]}
        onKeyDown={onCellKeyDown(rowIdx, col)}
        onChange={(e) => setCell(roomId, { [col]: e.target.checked })}
      />
    </td>
  );

  return (
    <div className="rct">
      <div className="rce-bar">
        {partySize > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={distribute}
            title="Spread the booking's party across the rows (children stay together on the first room)"
          >
            <Wand2 style={{ width: 13, height: 13 }} /> Distribute party
          </button>
        )}
        <select
          className="rce-allsel"
          style={{ marginLeft: 0 }}
          value=""
          onChange={(e) => {
            if (e.target.value) everyoneOn(e.target.value as NumCol | "none");
          }}
          title="Set every room's meal-plan pax to its occupancy on one plan"
        >
          <option value="">Everyone on…</option>
          <option value="none">None (EP)</option>
          <option value="cp">CP · breakfast</option>
          <option value="ml">MAP · +lunch</option>
          <option value="md">MAP · +dinner</option>
          <option value="ap">AP · all meals</option>
          <option value="ot">Others</option>
        </select>
        {sealedRoomIds.length > 1 && (
          <button
            type="button"
            className="rcb-mini"
            onClick={copyFirstDown}
            title="Copy row 1's meals, beds, toggles and rates onto every other row (guest counts stay put)"
          >
            <ArrowDownToLine style={{ width: 11, height: 11 }} /> Copy row 1 ↓
          </button>
        )}
        <span className="rce-lbl">Meals</span>
        {MEAL_COLS.map((c) => {
          const on = visibleMeals.includes(c);
          return (
            <button
              key={c}
              type="button"
              className={`rct-chip${on ? " on" : ""}`}
              onClick={() => togglePlan(c)}
              title={
                on
                  ? `${MEAL_META[c].title} — click to remove the column (zeroes its pax)`
                  : `${MEAL_META[c].title} — click to add the column`
              }
            >
              {MEAL_META[c].chip}
            </button>
          );
        })}
        <span className="ln" />
        {roomMin != null && (
          <span
            className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`}
            title="Backend capacity envelope: chargeable guests vs the largest room capacity"
          >
            needs ≥ {roomMin} room{roomMin === 1 ? "" : "s"} · {sealedRoomIds.length} sealed
          </span>
        )}
        {partySize > 0 && (
          <span className={`rce-tally${totalGuests !== partySize ? " off" : ""}`}>
            {totalGuests} of {partySize} guests placed
          </span>
        )}
      </div>
      {roomMin != null && sealedRoomIds.length < roomMin && (
        <p className="rce-block">
          {roomEnvelopeQuery.data?.chargeableOccupants} chargeable guest
          {(roomEnvelopeQuery.data?.chargeableOccupants ?? 0) === 1 ? "" : "s"} won&rsquo;t fit in{" "}
          {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} — go back to Inquiry and seal at
          least {roomMin}.
        </p>
      )}

      <div className="rct-scroll" ref={wrapRef}>
        <table className="rct-t">
          <thead>
            <tr className="grp">
              <th className="room" />
              <th />
              <th colSpan={childColsVisible ? 4 : 2}>Guests</th>
              {visibleMeals.length > 0 && <th colSpan={visibleMeals.length}>Meal-plan pax</th>}
              {othersVisible && <th colSpan={3}>Others à-la-carte pax</th>}
              <th colSpan={3}>Charges</th>
              {ratesOpen && <th colSpan={5}>Negotiated rates (Nu., optional)</th>}
              <th className="ratebtn" rowSpan={2}>
                <div className="rct-corner">
                  <button type="button" className="rcb-mini" onClick={() => setRatesOpen((v) => !v)}>
                    {ratesOpen ? "Rates −" : "Rates +"}
                  </button>
                  {!hasKids && (
                    <button
                      type="button"
                      className="rcb-mini"
                      onClick={toggleChildCols}
                      title={
                        childColsVisible
                          ? "Hide the child columns (zeroes them) — the intake party has no children"
                          : "Show child columns even though the intake party has none"
                      }
                    >
                      {childColsVisible ? "Kids −" : "Kids +"}
                    </button>
                  )}
                </div>
              </th>
            </tr>
            <tr>
              <th className="room">Room</th>
              <th title="Occupants — derived: adults + children">Occ</th>
              <th>Adult</th>
              {childColsVisible && (
                <>
                  <th title="Children 6–10">6–10</th>
                  <th title="Children under 6">&lt;6</th>
                </>
              )}
              <th title="Extra beds">Bed</th>
              {visibleMeals.map((c) => (
                <th key={c} title={MEAL_META[c].title}>
                  {MEAL_META[c].th}
                </th>
              ))}
              {othersVisible && (
                <>
                  <th>B'fast</th>
                  <th>Lunch</th>
                  <th>Dinner</th>
                </>
              )}
              <th title="Service charge applies">SC</th>
              <th title="GST applies">GST</th>
              <th title="Free of charge — room priced at zero">FOC</th>
              {ratesOpen && (
                <>
                  <th>Room</th>
                  <th>Bed</th>
                  <th>B'fast</th>
                  <th>Lunch</th>
                  <th>Dinner</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {sealedRoomIds.map((id, rowIdx) => {
              const r = rows[id] ?? EMPTY_ROW;
              const room = roomById.get(id);
              const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
              const planSum = MEAL_COLS.reduce((s, c) => s + cnt(r[c]), 0);
              const plansOver = planSum > occ;
              const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
              const overCap = cap != null && occ > cap + cnt(r.bed);
              return (
                <tr key={id} className={r.foc ? "foc" : undefined}>
                  <td className="room">
                    <b>{room?.roomNumber ?? id.slice(0, 6)}</b>
                    {room?.roomType?.code && <span>{room.roomType.code}</span>}
                  </td>
                  <td
                    className={`occ${overCap ? " over" : ""}`}
                    title={overCap ? `Over capacity ${cap} + ${cnt(r.bed)} extra bed(s)` : cap != null ? `Capacity ${cap}` : undefined}
                  >
                    {occ}
                  </td>
                  {numCell(rowIdx, id, "ad")}
                  {childColsVisible && (
                    <>
                      {numCell(rowIdx, id, "c6")}
                      {numCell(rowIdx, id, "u6")}
                    </>
                  )}
                  {numCell(rowIdx, id, "bed")}
                  {visibleMeals.map((c) => numCell(rowIdx, id, c, { warn: plansOver }))}
                  {othersVisible && (
                    <>
                      {numCell(rowIdx, id, "obf")}
                      {numCell(rowIdx, id, "olu")}
                      {numCell(rowIdx, id, "odi")}
                    </>
                  )}
                  {boolCell(rowIdx, id, "sc")}
                  {boolCell(rowIdx, id, "gst")}
                  {boolCell(rowIdx, id, "foc")}
                  {ratesOpen && (
                    <>
                      {numCell(rowIdx, id, "rRoom", { decimal: true, wide: true })}
                      {numCell(rowIdx, id, "rBed", { decimal: true, wide: true })}
                      {numCell(rowIdx, id, "rBf", { decimal: true, wide: true })}
                      {numCell(rowIdx, id, "rLu", { decimal: true, wide: true })}
                      {numCell(rowIdx, id, "rDi", { decimal: true, wide: true })}
                    </>
                  )}
                  <td />
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="room">Σ</td>
              <td className={`occ${partySize > 0 && totalGuests !== partySize ? " off" : ""}`}>{totalGuests}</td>
              <td>{sum("ad")}</td>
              {childColsVisible && (
                <>
                  <td>{sum("c6")}</td>
                  <td>{sum("u6")}</td>
                </>
              )}
              <td>{sum("bed")}</td>
              {visibleMeals.map((c) => (
                <td key={c}>{sum(c)}</td>
              ))}
              {othersVisible && (
                <>
                  <td>{sum("obf")}</td>
                  <td>{sum("olu")}</td>
                  <td>{sum("odi")}</td>
                </>
              )}
              <td colSpan={3} />
              {ratesOpen && <td colSpan={5} />}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {sealedRoomIds.some((id) => {
        const r = rows[id] ?? EMPTY_ROW;
        return MEAL_COLS.reduce((s, c) => s + cnt(r[c]), 0) > cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
      }) && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          A row has more meal-plan pax than occupants — one plan per guest; the backend will reject the
          draft until it fits.
        </p>
      )}
      <p className="rce-hint">
        Occ is computed from the guest columns. Arrow keys / Enter move between cells. Meal-plan columns
        appear as you switch plans on with the <b>Meals</b> chips (or <i>Everyone on…</i>). Totals are
        priced by the backend when you create the draft. Child meal discounts on per-room plans are pending
        a backend update; until then every counted guest pays the full plan rate (leave infants off the
        plan columns if they eat free).
      </p>
    </div>
  );
}
