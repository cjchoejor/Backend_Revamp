"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Maximize2, Minimize2, Wand2 } from "lucide-react";
import { RateReferenceStrip } from "./rate-reference-strip";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { getRateReference } from "@/lib/api/entries";
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
 *     has children (or saved data already carries child counts — the manual "Kids +"
 *     corner toggle was removed 2026-07-31; only the Rates toggle remains),
 *     and meal-plan columns appear per plan as the operator toggles its chip
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

/**
 * Booking-wide discount, edited from inside the composition panel. The figure can be a percent
 * OR a flat Nu amount (2026-08-06, operator request) — `discountUnit` says which; both are
 * measured against the grand total server-side (`applyBookingDiscountToTotals`).
 */
export type DiscountUnit = "percent" | "amount";
export type DiscountEdit = {
  discountValue?: string;
  discountUnit?: DiscountUnit;
  discountBasis?: string;
  onDiscountChange?: (patch: { value?: string; unit?: DiscountUnit; basis?: string }) => void;
};

/**
 * Negotiation strip (2026-08-03, operator request) — the discount moved out of the form
 * blocks below and into the composition panel, so rates, FOC and the discount are edited in
 * one place and the panel reads as the negotiation surface.
 *
 * The discount is BOOKING-WIDE, not per room: the backend folds it into the resolved room
 * rate before the compositions are costed (`prepareQuotationDraft`). Two consequences the
 * strip states outright rather than leaving the operator to discover them from the total —
 * a room carrying its own negotiated rate ignores the default rate and so prices the same
 * discounted or not, and meals / extra beds are never discounted (they come off the rate
 * card's add-ons). NO MONEY IS COMPUTED HERE — the backend prices on create/regenerate.
 */
export function NegotiationDiscountBar({ discountValue, discountUnit, discountBasis, onDiscountChange }: DiscountEdit) {
  if (!onDiscountChange) return null;
  const unit: DiscountUnit = discountUnit ?? "percent";
  const n = Number(discountValue ?? "");
  const live = Number.isFinite(n) && n > 0;
  return (
    <div className="rct-neg">
      <span className="rce-lbl">Negotiate</span>
      <label className="rct-neg-f">
        Discount
        <input
          type="text"
          inputMode="decimal"
          className="rct-neg-val"
          value={discountValue ?? ""}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value;
            if (!/^\d*\.?\d*$/.test(v)) return;
            // 100% off is a full waiver — use the per-room FOC toggle for that instead. A flat
            // amount has no such cap client-side; the backend clamps it to the bill.
            if (unit === "percent" && v !== "" && Number(v) > 100) return;
            onDiscountChange({ value: v });
          }}
          title={
            unit === "percent"
              ? "Percentage off the booking's grand total"
              : "Flat amount off the booking's grand total (Nu)"
          }
        />
      </label>
      {/* The unit is the operator's choice (2026-08-06): the same figure box holds a percent or
          a flat Nu amount, and this switch says which the backend receives. The `amount` class
          slides the pill thumb (CSS ::before) — the buttons themselves never move or resize. */}
      <span className={`rct-neg-unit${unit === "amount" ? " amount" : ""}`} role="group" aria-label="Discount given as">
        <button
          type="button"
          className={unit === "percent" ? "on" : ""}
          title="Give the discount as a percentage of the grand total"
          onClick={() =>
            // A figure over 100 is legal as an amount but not as a percent — clear it on switch
            // rather than carrying an untypeable value into the capped input.
            onDiscountChange({ unit: "percent", ...(live && n > 100 ? { value: "" } : {}) })
          }
        >
          %
        </button>
        <button
          type="button"
          className={unit === "amount" ? "on" : ""}
          title="Give the discount as a flat amount in Nu"
          onClick={() => onDiscountChange({ unit: "amount" })}
        >
          Nu
        </button>
      </span>
      <label className="rct-neg-f wide">
        Basis
        <input
          type="text"
          value={discountBasis ?? ""}
          placeholder="negotiation"
          onChange={(e) => onDiscountChange({ basis: e.target.value })}
          title="Why the discount is being given — recorded on the quote and audited"
        />
      </label>
      {live && (
        <span className="rct-neg-on">
          −{unit === "percent" ? `${n}%` : `Nu ${n.toLocaleString()}`} off the total
        </span>
      )}
      <span className="ln" />
      {/* States the CURRENT model (operator ruling 2026-08-04, applyBookingDiscountToTotals):
          the deduction comes off the grand total, meals and beds included — the earlier
          "room rate only" wording described the superseded 2026-08-03 model. */}
      <span
        className="rct-neg-note"
        style={{ textAlign: "right", flex: "0 1 auto" }}
        title="Percent or flat amount — both come off the booking's grand total, meals and extra beds included. Service charge and GST follow the discounted figure, and a discount larger than the bill settles it (never a refund). Priced by the backend when you create or regenerate the quote."
      >
        Comes off the grand total — meals &amp; beds included
      </span>
    </div>
  );
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

/** Rebuild a row's field state from an emitted composition — used when the planner hands
 *  this editor the other mode's last snapshot so a mode switch resumes, not resets. */
function rowFromComposition(c: RoomCompositionInput): RowState {
  const s = (v: number | undefined | null, blankWhenNull = false): string =>
    v == null ? (blankWhenNull ? "" : "0") : String(v);
  return {
    ad: s(c.adultCount),
    c6: s(c.cnb6To10Count),
    u6: s(c.cnbUnder6Count),
    bed: s(c.extraBedCount),
    cp: s(c.mealPlanCpCount),
    ml: s(c.mealPlanMaplCount),
    md: s(c.mealPlanMapdCount),
    ap: s(c.mealPlanApCount),
    ot: s(c.mealPlanOthersCount),
    obf: s(c.othersBreakfastPax, true),
    olu: s(c.othersLunchPax, true),
    odi: s(c.othersDinnerPax, true),
    rRoom: s(c.negotiatedRoomRate, true),
    rBed: s(c.negotiatedExtraBedRate, true),
    rBf: s(c.negotiatedBreakfastRate, true),
    rLu: s(c.negotiatedLunchRate, true),
    rDi: s(c.negotiatedDinnerRate, true),
    sc: c.serviceChargeApplies ?? true,
    gst: c.gstApplies ?? true,
    foc: c.isFoc ?? false,
  };
}

export function RoomCompositionsTable({
  entryId,
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  initial,
  onChange,
  onOpenRoomInBoard,
  discountValue,
  discountUnit,
  discountBasis,
  onDiscountChange,
}: DiscountEdit & {
  /** Set by the planner — clicking a room number opens that room alone in the guest board. */
  onOpenRoomInBoard?: (roomId: string) => void;
  /** Enables the reference-rate placeholders in the negotiated-rate cells. */
  entryId?: string;
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  /** Snapshot from the other planner mode — mount-time seed so switching modes resumes
   *  from the same data. Read once on mount; later prop changes are ignored. */
  initial?: RoomCompositionInput[];
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

  /**
   * Reference rates, resolved per ROOM. The endpoint answers by room type; each room's type comes
   * from the catalogue above, so no extra call is needed. These become the rate cells' placeholder
   * text: an empty negotiated cell is not "no rate", it is "price at this", and the operator had
   * no way to see which figure that was without leaving the grid.
   */
  const rateRefQuery = useQuery({
    queryKey: ["rate-reference", entryId],
    queryFn: () => getRateReference(session!, entryId!),
    enabled: !!session && !!entryId,
    staleTime: 5 * 60_000,
  });
  const rateRef = rateRefQuery.data ?? null;
  const refByRoomType = useMemo(
    () => new Map((rateRef?.roomTypes ?? []).map((t) => [t.roomTypeId, t])),
    [rateRef],
  );
  /** The reference figure a given rate cell would fall back to — null when nothing is on file. */
  const refFor = (roomId: string, col: NumCol): number | null => {
    const typeId = roomById.get(roomId)?.roomType?.id;
    const t = typeId ? refByRoomType.get(typeId) : undefined;
    if (!t) return null;
    switch (col) {
      case "rRoom":
        return t.roomRate;
      case "rBed":
        return t.extraBedRate;
      case "rBf":
        return t.breakfastRate;
      case "rLu":
        return t.lunchRate;
      case "rDi":
        return t.dinnerRate;
      default:
        return null;
    }
  };

  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  // Mount-time copy of the seed snapshot — deliberately not reactive.
  const initialRef = useRef(initial);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [ratesOpen, setRatesOpen] = useState(
    () => (initial ?? []).some((c) =>
      [c.negotiatedRoomRate, c.negotiatedExtraBedRate, c.negotiatedBreakfastRate, c.negotiatedLunchRate, c.negotiatedDinnerRate].some((v) => v != null),
    ),
  );
  // Full-screen layer, same affordance as the S1 room table: with the rate columns open the grid
  // is wider than the canvas column, so reading rooms against their rates meant scrolling
  // sideways. Reuses the .rst-expandwrap / .rst-expandbar styles.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);
  // Plans the operator switched on. A plan column is VISIBLE when toggled on OR when any
  // row carries pax for it — a column with data can never silently disappear.
  const [activePlans, setActivePlans] = useState<Set<NumCol>>(new Set());
  // CNB columns exist automatically when the intake party has children, or when saved
  // data already carries child counts — the manual "Kids +" toggle was removed
  // (2026-07-31, operator request); only the Rates toggle remains in the corner.
  const hasKids = (entryChildAges?.length ?? 0) > 0;
  const [childColsManual] = useState(
    () => !hasKids && (initial ?? []).some((c) => (c.cnb6To10Count ?? 0) > 0 || (c.cnbUnder6Count ?? 0) > 0),
  );
  const childColsVisible = hasKids || childColsManual;

  useEffect(() => {
    setRows((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const seedById = new Map((initialRef.current ?? []).map((c) => [c.roomId, c]));
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        if (!next[id]) {
          const seed = seedById.get(id);
          next[id] = seed ? rowFromComposition(seed) : { ...EMPTY_ROW };
        }
      }
      return next;
    });
  }, [sealedRoomIds]);

  const setCell = (roomId: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? EMPTY_ROW), ...patch } }));

  // ---- Input bounds (2026-08-01) --------------------------------------------------
  // The grid used to accept ANY number in the people cells; the Σ footer only warned.
  // The counts must stay within the party captured at Inquiry (S1) — the same bands the
  // guest board is bound to by construction. Type-time clamps, with a notice saying why.
  // An entry with NO party breakdown stays unconstrained (the table is deliberately the
  // fallback editor for those).
  const partyBands = useMemo(() => {
    const ages = entryChildAges ?? [];
    return {
      ad: Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length,
      c6: ages.filter((a) => a > youngMax && a <= childMax).length,
      u6: ages.filter((a) => a <= youngMax).length,
    };
  }, [entryAdults, entryChildAges, youngMax, childMax]);
  const partyBound = (entryAdults ?? 0) + (entryChildAges?.length ?? 0) > 0;

  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashLimit = (msg: string) => {
    setLimitMsg(msg);
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = setTimeout(() => setLimitMsg(null), 5000);
  };

  const bandLabel = (col: "ad" | "c6" | "u6", n: number): string =>
    col === "ad"
      ? `adult-rate guest${n === 1 ? "" : "s"} (adults + 11+)`
      : col === "c6"
        ? `child${n === 1 ? "" : "ren"} ${youngMax + 1}–${childMax}`
        : `child${n === 1 ? "" : "ren"} under ${youngMax + 1}`;
  const roomNoOf = (id: string) => roomById.get(id)?.roomNumber ?? id.slice(0, 6);
  const capOf = (id: string): number | null => {
    const rt = roomById.get(id)?.roomType;
    return rt?.maxCapacity ?? rt?.standardCapacity ?? null;
  };
  const bedMaxOf = (id: string): number => roomById.get(id)?.roomType?.maxExtraBeds ?? 0;
  /** Extra beds a room NEEDS for its adults: everyone past base capacity gets one
   *  (children under 11 share bedding — they never need a bed). */
  const bedsNeeded = (id: string, adults: number): number => {
    const cap = capOf(id);
    if (cap == null) return 0;
    return Math.min(Math.max(0, adults - cap), bedMaxOf(id));
  };
  /** Re-derive a row's bed cell from its adults — auto-add when adults exceed base
   *  capacity, auto-remove when they no longer do (2026-08-01 operator ruling). */
  const withAutoBed = (id: string, row: RowState): RowState => ({
    ...row,
    bed: String(bedsNeeded(id, cnt(row.ad))),
  });

  /**
   * Band-cell edit (2026-08-01) — a HARD cap, never an auto-move (operator ruling: the
   * earlier version pulled overflow out of other rooms, which read as the grid changing
   * numbers behind your back):
   *   1. `ad` is capped at the ROOM's ceiling (base capacity + max extra beds; beds
   *      auto-derive below) — pooling every adult into one room stops at what it can sleep.
   *   2. The cell is capped at what's LEFT of the intake party band once the other rooms
   *      are counted — moving someone between rooms means reducing the source room first
   *      (or dragging their chip on the guest board, which moves them properly).
   *   3. The room's extra beds re-derive whenever its adults change.
   */
  const applyBandChange = (roomId: string, col: "ad" | "c6" | "u6", v: string) => {
    let n = cnt(v);
    let display = v; // keep the raw string (e.g. "") when nothing clamps
    if (col === "ad") {
      const cap = capOf(roomId);
      if (cap != null) {
        const ceil = cap + bedMaxOf(roomId);
        if (n > ceil) {
          flashLimit(
            `Room ${roomNoOf(roomId)} sleeps at most ${ceil} adult-rate guests (${cap} + ${bedMaxOf(roomId)} extra bed${bedMaxOf(roomId) === 1 ? "" : "s"}) — capped.`,
          );
          n = ceil;
          display = String(n);
        }
      }
    }
    if (partyBound) {
      const others = sealedRoomIds.reduce((s, id) => (id === roomId ? s : s + cnt(rows[id]?.[col] ?? "0")), 0);
      const remaining = Math.max(0, partyBands[col] - others);
      if (n > remaining) {
        flashLimit(
          `This booking has ${partyBands[col]} ${bandLabel(col, partyBands[col])}${
            others > 0 ? ` and ${others} ${others === 1 ? "is" : "are"} already in other rooms` : ""
          } — capped at ${remaining}. Reduce the other room first to move someone here, or change the party at the Inquiry step.`,
        );
        n = remaining;
        display = String(n);
      }
    }
    setRows((prev) => {
      const next = { ...prev };
      let mine = { ...(next[roomId] ?? EMPTY_ROW), [col]: display };
      if (col === "ad") mine = withAutoBed(roomId, mine);
      next[roomId] = mine;
      return next;
    });
  };

  /** Extra beds: floored at what the room's adults need, capped at the type's max.
   *  Manual raises (e.g. a separate bed for a child) stay until the adults change. */
  const clampBed = (roomId: string, v: string): string => {
    const max = bedMaxOf(roomId);
    const needed = bedsNeeded(roomId, cnt(rows[roomId]?.ad ?? "0"));
    const n = cnt(v);
    if (n > max) {
      flashLimit(`Room ${roomNoOf(roomId)} allows at most ${max} extra bed${max === 1 ? "" : "s"} — capped.`);
      return String(max);
    }
    if (n < needed) {
      flashLimit(
        `Room ${roomNoOf(roomId)} needs ${needed} extra bed${needed === 1 ? "" : "s"} for its adults — it can't go lower while they're in the room.`,
      );
      return String(needed);
    }
    return v;
  };
  /** Meal-plan pax: a room can't feed more people than it sleeps (Policy 79 rule 2). */
  const clampMeal = (roomId: string, col: NumCol, v: string): string => {
    const r = rows[roomId] ?? EMPTY_ROW;
    const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
    const otherMeals = MEAL_COLS.reduce((s, c) => (c === col ? s : s + cnt(r[c] ?? "0")), 0);
    const allowed = Math.max(0, occ - otherMeals);
    if (cnt(v) <= allowed) return v;
    const roomNo = roomById.get(roomId)?.roomNumber ?? "";
    flashLimit(
      `Room ${roomNo} has ${occ} guest${occ === 1 ? "" : "s"}${
        otherMeals > 0 ? ` (${otherMeals} already on other plans)` : ""
      } — meal-plan pax can't exceed the people in the room; capped at ${allowed}.`,
    );
    return String(allowed);
  };

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
        next[id] = withAutoBed(id, {
          ...(next[id] ?? { ...EMPTY_ROW }),
          ad: String(base + (i < rem ? 1 : 0)),
          c6: String(i === 0 ? c6to10 : 0),
          u6: String(i === 0 ? under6 : 0),
        });
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
   *  never the guest bands (copying people would double the party). Beds and meal pax
   *  are clamped per target row (its own bed limit / its own occupancy), so the copy
   *  can't write what typing wouldn't have allowed. */
  const copyFirstDown = () => {
    const first = rows[sealedRoomIds[0]];
    if (!first) return;
    const { ad: _a, c6: _c, u6: _u, ...rest } = first;
    setRows((prev) => {
      const next = { ...prev };
      for (const id of sealedRoomIds.slice(1)) {
        const target = next[id] ?? EMPTY_ROW;
        const merged = { ...target, ...rest };
        // Bed bounds per target room: capped at its type's max, floored at what its own
        // adults need (the copy must not strip beds a fuller room depends on).
        const bedMax = bedMaxOf(id);
        const needed = bedsNeeded(id, cnt(target.ad));
        merged.bed = String(Math.max(needed, Math.min(cnt(merged.bed), bedMax)));
        // Meal pax ≤ the TARGET row's occupancy (it keeps its own guest bands).
        const occ = cnt(target.ad) + cnt(target.c6) + cnt(target.u6);
        let left = occ;
        for (const c of MEAL_COLS) {
          const take = Math.min(cnt(merged[c] ?? "0"), left);
          merged[c] = String(take);
          left -= take;
        }
        next[id] = merged;
      }
      return next;
    });
  };

  // Per-night overrides carried in from the board, keyed by room. Read from the mount-time
  // seed only — same lifetime rule as the rest of `initial`.
  const nightOverridesBySeedRoom = useMemo(
    () =>
      new Map(
        (initialRef.current ?? [])
          .filter((c) => (c.nightMealOverrides?.length ?? 0) > 0)
          .map((c) => [c.roomId, c.nightMealOverrides]),
      ),
    [],
  );

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
          // GST is statutory — always applied regardless of any historic seed value.
          gstApplies: true,
          isFoc: r.foc,
          // Per-night meal overrides are a guest-board concept — this grid has no column for
          // them. Carry the seed's through untouched so a board → table → board round trip
          // doesn't quietly delete the operator's per-date plans. The board re-derives them
          // from chip placement on its next emit, so a stale carry-through can't win.
          ...(nightOverridesBySeedRoom.get(id)?.length
            ? { nightMealOverrides: nightOverridesBySeedRoom.get(id) }
            : {}),
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
    opts?: { warn?: boolean; decimal?: boolean; wide?: boolean; placeholder?: string; title?: string },
  ) => {
    const raw = rows[roomId]?.[col] ?? "";
    return (
      <td key={col} className={opts?.warn ? "warn" : undefined} title={opts?.title}>
        <input
          type="text"
          inputMode={opts?.decimal ? "decimal" : "numeric"}
          className={opts?.wide ? "wide" : undefined}
          data-cell={`${rowIdx}:${col}`}
          placeholder={opts?.placeholder}
          value={raw}
          onKeyDown={onCellKeyDown(rowIdx, col)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            let v = e.target.value;
            // Digits only for counts; digits + one dot for rate cells.
            if (!(opts?.decimal ? /^\d*\.?\d*$/.test(v) : /^\d*$/.test(v))) return;
            // People/bed/meal cells are bounded — see the clamp helpers above. Band cells go
            // through the MOVE-semantics writer (it updates other rooms + auto beds itself).
            if (col === "ad" || col === "c6" || col === "u6") {
              applyBandChange(roomId, col, v);
              return;
            }
            if (col === "bed") v = clampBed(roomId, v);
            else if ((MEAL_COLS as string[]).includes(col)) v = clampMeal(roomId, col, v);
            setCell(roomId, { [col]: v });
          }}
        />
      </td>
    );
  };
  const boolCell = (rowIdx: number, roomId: string, col: "sc" | "gst" | "foc") =>
    col === "gst" ? (
      // GST is statutory — not an option (2026-08-01 operator ruling). Always on, always sent.
      <td key={col} className="ck" title="GST is mandatory — applied on every room">
        <input type="checkbox" checked disabled />
      </td>
    ) : (
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
    <div className={expanded ? "rct rst-expandwrap on" : "rct"}>
      {expanded && (
        <div className="rst-expandbar">
          <b>Room composition · {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"}</b>
          <span className="ln" />
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
            <Minimize2 style={{ width: 13, height: 13 }} /> Close
          </button>
        </div>
      )}
      {/* Reference rates ride above the grid in NORMAL PAGE FLOW (2026-08-03, operator request).
          The old `position: sticky` wrapper pinned the strip to the viewport whenever the canvas
          scrolled — so it hung over unrelated blocks inline, and in the expanded layer it drifted
          across the close bar. Inline it now simply scrolls away with the panel; expanded, the
          layer is a flex column in which only `.rct-scroll` scrolls, so this strip, the close bar
          and the toolbar are held at the top structurally rather than by sticky positioning. */}
      {entryId && <RateReferenceStrip entryId={entryId} compact />}
      {/* Discount rides with the rates, inside the panel — one negotiation surface. */}
      <NegotiationDiscountBar
        discountValue={discountValue}
        discountUnit={discountUnit}
        discountBasis={discountBasis}
        onDiscountChange={onDiscountChange}
      />
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
        {/* Compact tallies — the long forms crowded the row until "Expand" wrapped onto its own
            orphan line. Full wording rides on hover. */}
        {roomMin != null && (
          <span
            className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`}
            title={`Backend capacity envelope: this party needs at least ${roomMin} room${roomMin === 1 ? "" : "s"} — ${sealedRoomIds.length} sealed at Inquiry`}
          >
            {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} · needs ≥{roomMin}
          </span>
        )}
        {partySize > 0 && (
          <span
            className={`rce-tally${totalGuests !== partySize ? " off" : ""}`}
            title={`${totalGuests} of ${partySize} intake guests placed in rooms`}
          >
            {totalGuests}/{partySize} placed
          </span>
        )}
        {!expanded && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded(true)}
            title="Expand to full screen — fits every room and the rate columns on one screen"
          >
            <Maximize2 style={{ width: 13, height: 13 }} /> Expand
          </button>
        )}
      </div>
      {limitMsg && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          {limitMsg}
        </p>
      )}
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
                  {/* The room cell doubles as "open this room in the guest board". Deliberately
                      the room cell and not the whole row: a row-level handler would fire on
                      every cell click and fight the grid's own editing/navigation. */}
                  <td
                    className={`room${onOpenRoomInBoard ? " opens" : ""}`}
                    onClick={onOpenRoomInBoard ? () => onOpenRoomInBoard(id) : undefined}
                    title={onOpenRoomInBoard ? "Open this room on its own in the guest board" : undefined}
                  >
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
                  {/* Each rate cell shows the figure it would price at when left empty, as the
                      placeholder — so the column reads as rates rather than as blanks, and a
                      negotiation is entered against a visible anchor. Typing overrides it. */}
                  {ratesOpen &&
                    (["rRoom", "rBed", "rBf", "rLu", "rDi"] as const).map((col) => {
                      const ref = refFor(id, col);
                      return numCell(rowIdx, id, col, {
                        decimal: true,
                        wide: true,
                        placeholder: ref != null ? String(ref) : "—",
                        title:
                          ref != null
                            ? `Prices at ${ref} ${rateRef?.currency ?? ""} unless you type a negotiated rate`
                            : "No rate on file for this room type — leave empty and it prices at zero",
                      });
                    })}
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
      {/* One line. The old version also warned that child meal discounts were "pending a backend
          update" — stale since 2026-08-04: computeRoomComposition now prices covers by age band
          (under-6 free, 6–10 at the child share), so children SHOULD be counted on the plans. */}
      <p className="rce-hint">
        Occ is derived from the guest columns · arrow keys / Enter move between cells · totals are priced
        by the backend on create. Count children on the meal plans — child pricing applies automatically
        (under-6 free, 6–10 at the child rate).
      </p>
    </div>
  );
}
