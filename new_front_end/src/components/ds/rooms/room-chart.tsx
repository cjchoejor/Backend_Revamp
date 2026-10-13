"use client";

/**
 * The house chart — rooms down the side, nights across the top (2026-10-12, operator: "show it
 * like the mockup's Rooms tab ... a row named House booked, as numbers like 3/28 ... it will
 * show all the reservations, and checked in, confirmed or parked in different styles").
 *
 * Every figure and every bar comes from `GET /api/rooms/chart`, which reads the same claim rules
 * the room search does — so a room drawn free here is a room the search offers. The desk only
 * lays the bars out: one bar per run of nights a booking holds a room; two bookings on one
 * room-night are drawn as a conflict.
 *
 * Second pass, same day (operator: "the hover shows a black box — can it show with more colour
 * and distinction; the dates and days more unique; the room numbers too; a solid box for each
 * room type so its rooms read as falling under it; and clicking a box should start an inquiry
 * right away"):
 *   - pointing at anything opens a HOVER CARD in the chart's own colours (no browser tooltip);
 *   - the night headers carry the weekday, a large day number, the month, weekends tinted and
 *     today a solid column; room numbers sit in a box;
 *   - each room type is a solid band, its rooms bracketed beneath it;
 *   - a FREE night opens "Start an inquiry": the nights it can run (counted over this room's
 *     free nights on the chart), then the new-inquiry screen with the check-in, the nights and
 *     the room filled in (`/bookings/new?checkIn=&nights=&room=`). The room itself is chosen on
 *     the booking, where the house is asked — the chart only suggests it.
 *
 * Third pass, same day (operator: "add a full screen button"; "it shows the hover for everything as
 * soon as I hover over the table — just show the data, not for a free room or Free that night and
 * House booked, and show it after one second"; "why are the today, Sat and Sun columns beige"):
 *   - **Full screen** lifts the chart over the whole window (Escape closes it);
 *   - the hover card is for what is ON the chart — a booking, a run out of order, two bookings on
 *     a night — and opens after a second's rest, so moving across the table shows nothing;
 *   - a free night is white whatever its day: today is drawn as a thin column edge and the
 *     weekend in the header's weekday, never as a fill that reads like something is there.
 *
 * Switch rooms (2026-10-12, operator: "switch rooms between two reservations from this chart —
 * different stages, rooms and dates — through every procedure, with the papers and the choice to
 * send them"): **Switch rooms** marks a booking, then a second booking swaps their rooms or a free
 * night on another room moves it there. The dialog shows what the server says the move would do
 * and runs it (room-move-dialog.tsx); a move still running or part-done is drawn as MOVING.
 *
 * Drag and drop (same day, operator: "drag and drop the rooms to another one; Ctrl to pick several,
 * Shift to pick a range"): a booking's bar is dragged onto another room's row. Ctrl-click (Cmd on
 * a Mac) picks more rooms, Shift-click a booking's rooms in between; dragging one of the picked
 * rooms moves them all — the grabbed room lands on the row dropped on and the rest keep their
 * spacing. A booking already in a room one of them lands on is swapped into the room left behind
 * (the server adds that leg). Each room is its own governed walk.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, type ChartBarKind, type RoomChart, type RoomChartBar, type RoomChartBooking } from "@/lib/api/rooms";
import { fmtDateTime, fmtRange, plural } from "@/lib/ds/format";
import { rowNameOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";
import { RoomMoveDialog } from "./room-move-dialog";
import { DateMoveDialog } from "./date-move-dialog";
import type { DateMoveInput } from "@/lib/api/room-moves";

const KIND_WORD: Record<ChartBarKind, string> = {
  OVERSTAY: "Due out · still in",
  IN_HOUSE: "In house",
  CHECKED_OUT: "Checked out",
  RESERVED: "Reserved",
  HELD: "Held · not confirmed",
  MOVING: "Moving in",
  EXTENSION_HELD: "Extension · held",
  PROVISIONAL: "Provisional block",
};
const KIND_CLASS: Record<ChartBarKind, string> = {
  OVERSTAY: "k-over",
  IN_HOUSE: "k-in",
  CHECKED_OUT: "k-out",
  RESERVED: "k-res",
  HELD: "k-held",
  MOVING: "k-move",
  EXTENSION_HELD: "k-held",
  PROVISIONAL: "k-prov",
};
const BED_WORD: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };
const BED_LETTER: Record<string, string> = { KING: "K", TWIN: "T", QUEEN: "Q", SINGLE: "S" };
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WINDOWS = [7, 14, 21, 28];
/** The longest window the backend draws (`CHART_MAX_NIGHTS`). */
const MAX_NIGHTS = 62;
/** How far an inquiry started from a free night may run past the chart's own nights. */
const START_MAX_NIGHTS = 30;

const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayOfWeek = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const weekend = (ymd: string) => dayOfWeek(ymd) === 0 || dayOfWeek(ymd) === 6;
const longDay = (ymd: string) => `${WEEKDAY[dayOfWeek(ymd)]} ${Number(ymd.slice(8, 10))} ${MONTH[Number(ymd.slice(5, 7)) - 1]}`;

type ChartRoom = RoomChart["rooms"][number];

type Seg =
  | { t: "free"; night: string; index: number }
  | { t: "ooo"; span: number; reason: string | null; from: string; to: string }
  | { t: "bar"; span: number; bar: RoomChartBar }
  | { t: "conflict"; night: string; bars: RoomChartBar[] };

/** What the hover card is about — only what is on the chart (2026-10-12). */
type Hover =
  | { t: "bar"; bar: RoomChartBar; room: ChartRoom; rect: DOMRect }
  | { t: "conflict"; bars: RoomChartBar[]; room: ChartRoom; night: string; rect: DOMRect }
  | { t: "ooo"; room: ChartRoom; reason: string | null; from: string; to: string; rect: DOMRect };

/** How long the pointer rests on a booking before its card opens. */
const HOVER_DELAY_MS = 1000;

/** The open "Start an inquiry" box on a free night. */
type Pick = { room: ChartRoom; night: string; freeRun: number; reachesEnd: boolean; rect: DOMRect };

/** A booking's claim on one room, picked on the chart (Ctrl / Shift click) or grabbed by a drag. */
type Sel = { entryId: string; roomId: string; roomNumber: string; name: string };
const selKey = (s: { entryId: string; roomId: string }) => `${s.entryId}|${s.roomId}`;
/**
 * A drag under way: what moves, the room grabbed, the row under the pointer — and, since
 * 2026-10-13, how many nights sideways it has been dragged (a date move when not 0).
 */
type Drag = { items: Sel[]; grabbed: Sel; over: string | null; x: number; y: number; shift: number };

const DAY_MS = 86_400_000;
const ymdShift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd.slice(0, 10)}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);

/**
 * Whether a booking can be dragged to other dates (2026-10-13 rulings: any booking before check-in;
 * the whole stay shifts; one booking at a time). The server re-checks all of it and more — this only
 * says, while dragging, what would certainly be refused.
 */
function dateMoveWhy(drag: Drag, booking: RoomChartBooking | undefined): string | null {
  if (new Set(drag.items.map((s) => s.entryId)).size > 1) return "Move one booking's dates at a time";
  if (drag.items.length > 1 && drag.over && drag.over !== drag.grabbed.roomId) return "Move the dates first, then the rooms";
  if (!booking) return null;
  if (booking.status === "PARKED") return "This booking is parked — resume it first";
  if (booking.status !== "ACTIVE") return "This booking has ended — its dates are a record now";
  switch (booking.stage) {
    case "S1":
      return "At Inquiry the dates are changed on the booking's Inquiry step";
    case "S6":
    case "S7":
      return "In house — the stay changes through Extend the stay or Leaving early";
    case "S8":
    case "S9":
      return "The guest has left or is leaving — the stay does not move";
    default:
      return booking.checkInDate ? null : "This booking has no dates to move";
  }
}
/** The server takes at most 8 picked rooms in one move. */
const MAX_PICK = 8;
/** Bars that can be picked up — the server refuses the rest with its reason (a provisional block,
 * a guest due out), but a stay that has ended is not offered at all. */
const MOVABLE = new Set<ChartBarKind>(["RESERVED", "HELD", "IN_HOUSE", "PROVISIONAL", "OVERSTAY"]);

/**
 * Where a drop sends the picked rooms: the grabbed one lands on the row dropped on and the others
 * keep their spacing from it (operator ruling 2026-10-12, "keep their order"). Rows run down the
 * chart as drawn, across room types.
 */
function planDrop(
  items: Sel[],
  grabbed: Sel,
  onRoomId: string,
  rows: string[],
): { ok: true; legs: RoomMoveLegInput[]; to: string[] } | { ok: false; why: string | null } {
  const at = rows.indexOf(onRoomId);
  const from = rows.indexOf(grabbed.roomId);
  if (at < 0 || from < 0 || at === from) return { ok: false, why: null };
  const shift = at - from;
  const legs: RoomMoveLegInput[] = [];
  for (const it of items) {
    const i = rows.indexOf(it.roomId) + shift;
    if (i < 0) return { ok: false, why: `Room ${it.roomNumber} would land above the first room — drop lower` };
    if (i >= rows.length) return { ok: false, why: `Room ${it.roomNumber} would land below the last room — drop higher` };
    legs.push({ entryId: it.entryId, fromRoomId: it.roomId, toRoomId: rows[i] });
  }
  return { ok: true, legs, to: legs.map((l) => l.toRoomId) };
}

/** The box that scrolls the chart up and down: the full-screen table, else the page. */
function scrollerOf(el: HTMLElement | null): Element | null {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return document.scrollingElement;
}

function housekeepingOf(room: ChartRoom): { cls: string; word: string } {
  const claim = room.currentClaimState.toUpperCase();
  const ps = room.physicalState.toUpperCase();
  if (claim === "DEPARTED_DIRTY" || ps === "DIRTY") return { cls: "hk-warn", word: "needs cleaning" };
  if (ps === "AVAILABLE_INSPECTED") return { cls: "hk-ok", word: "inspected" };
  if (ps === "UNDER_MAINTENANCE") return { cls: "hk-bad", word: "under maintenance" };
  return { cls: "hk-ok", word: "clean" };
}

function segmentsFor(room: ChartRoom, chart: RoomChart, bars: RoomChartBar[]): Seg[] {
  const { nights } = chart;
  const on = nights.map((night) => bars.filter((b) => b.from <= night && night < b.to));
  const out: Seg[] = [];
  let i = 0;
  while (i < nights.length) {
    const here = on[i];
    if (here.length > 1) {
      out.push({ t: "conflict", night: nights[i], bars: here });
      i++;
      continue;
    }
    if (here.length === 1) {
      let j = i;
      while (j + 1 < nights.length && on[j + 1].length === 1 && on[j + 1][0] === here[0]) j++;
      out.push({ t: "bar", span: j - i + 1, bar: here[0] });
      i = j + 1;
      continue;
    }
    if (room.outOfOrder?.nights[i]) {
      let j = i;
      while (j + 1 < nights.length && on[j + 1].length === 0 && room.outOfOrder.nights[j + 1]) j++;
      out.push({ t: "ooo", span: j - i + 1, reason: room.outOfOrder.reason, from: nights[i], to: shiftDay(nights[j], 1) });
      i = j + 1;
      continue;
    }
    out.push({ t: "free", night: nights[i], index: i });
    i++;
  }
  return out;
}

/** Positions a floating box beside the cell it belongs to, inside the window. */
function placeBeside(rect: DOMRect, width: number): React.CSSProperties {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = window.innerHeight - rect.bottom > 260 || rect.top < 260;
  return below
    ? { position: "fixed", top: rect.bottom + 6, left, width }
    : { position: "fixed", top: rect.top - 6, left, width, transform: "translateY(-100%)" };
}

/** Rendered at the desk's root, so the scrolling table never clips it. */
function Floating({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.querySelector<HTMLElement>("[data-ds-overlays]") ?? document.body), []);
  return host ? createPortal(children, host) : null;
}

export function RoomChartView({ onOpenRoom }: { onOpenRoom: (room: { id: string; roomNumber: string }) => void }) {
  const { session, isLoading } = useSession();
  const router = useRouter();
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [nightsAsked, setNightsAsked] = useState(14);
  const q = useQuery({
    queryKey: ["room-chart", from ?? "today", nightsAsked],
    queryFn: () => getRoomChart(session!, { from, nights: nightsAsked }),
    enabled: !!session && !isLoading,
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const chart = q.data;
  /** A range longer than the chart draws — said, not silently cut. */
  const [rangeNote, setRangeNote] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [full, setFull] = useState(false);
  const [pickNights, setPickNights] = useState(1);
  const pickRef = useRef<HTMLDivElement | null>(null);
  /** Switch rooms: pick a booking's room, then click another booking (a swap) or a free night (a move). */
  const [switching, setSwitching] = useState(false);
  /** Rooms picked on the chart — Ctrl-click adds one, Shift-click a booking's rooms in between. */
  const [selected, setSelected] = useState<Sel[]>([]);
  const anchor = useRef<Sel | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /** Set for the click that ends a drag, so it does not also open the booking. */
  const dragEnded = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [moveLegs, setMoveLegs] = useState<RoomMoveLegInput[] | null>(null);
  /** A bar dragged sideways: the booking's stay moving to other dates (2026-10-13). */
  const [dateMove, setDateMove] = useState<(DateMoveInput & { label: string }) | null>(null);
  const stopSwitching = () => {
    setSwitching(false);
    setSelected([]);
    anchor.current = null;
  };
  const picking = selected.length > 0;

  // Escape leaves Switch rooms and drops the picks (the dialog, when open, takes Escape for itself).
  useEffect(() => {
    if (!(switching || picking) || moveLegs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopSwitching();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [switching, picking, moveLegs]);

  const bookingOf = useMemo(() => new Map((chart?.bookings ?? []).map((b) => [b.entryId, b])), [chart]);
  const typeOf = useMemo(() => new Map((chart?.roomTypes ?? []).map((t) => [t.id, t])), [chart]);
  const barsByRoom = useMemo(() => {
    const m = new Map<string, RoomChartBar[]>();
    for (const b of chart?.bars ?? []) m.set(b.roomId, [...(m.get(b.roomId) ?? []), b]);
    return m;
  }, [chart]);
  /** The rooms in the order the chart draws them, top to bottom — what "keep their spacing" counts. */
  const rows = useMemo(() => {
    const have = new Set((chart?.rooms ?? []).map((r) => r.id));
    return (chart?.roomTypes ?? []).flatMap((t) => t.roomIds).filter((id) => have.has(id));
  }, [chart]);

  // The start box closes on Escape, on a click outside it, and when the chart scrolls away.
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPick(null);
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPick(null);
    };
    const onScroll = () => setPick(null);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pick]);

  // Full screen: Escape closes it (unless the start box is open — Escape closes that first), and the
  // page behind does not scroll.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape closes what is on top first: the start box, Switch rooms, the move dialog.
      if (e.key === "Escape" && !pickRef.current && !switching && !picking && !moveLegs && !dateMove) setFull(false);
    };
    // The page reserves a scrollbar gutter on <html> (`scrollbar-gutter: stable`), which a fixed
    // layer cannot cover — released while full screen is on, so the chart reaches the window's edge.
    const html = document.documentElement;
    const prev = { body: document.body.style.overflow, html: html.style.overflow, gutter: html.style.scrollbarGutter };
    document.body.style.overflow = "hidden";
    html.style.overflow = "hidden";
    html.style.scrollbarGutter = "auto";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev.body;
      html.style.overflow = prev.html;
      html.style.scrollbarGutter = prev.gutter;
      document.removeEventListener("keydown", onKey);
    };
  }, [full, switching, picking, moveLegs, dateMove]);
  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  if (q.error && !chart) return <LoadFailed what="the house chart" onRetry={() => void q.refetch()} />;
  if (!chart) return <LoadingBlock />;

  const lastNight = chart.nights[chart.nights.length - 1];
  const nameOf = (b?: RoomChartBooking) => (b ? rowNameOf(b) : "Booking");
  // The card opens after the pointer has rested a second, so sweeping across the table shows nothing.
  const point = (h: Hover) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (document.body.classList.contains("rchart-dragging")) return;
    hoverTimer.current = window.setTimeout(() => setHover(h), HOVER_DELAY_MS);
  };
  const leave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHover(null);
  };
  const rectOf = (e: React.SyntheticEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
  const openPick = (room: ChartRoom, night: string, index: number, rect: DOMRect, segs: Seg[]) => {
    // How many nights this room is free from here, on the chart.
    const freeIdx = new Set(segs.filter((s) => s.t === "free").map((s) => (s as { index: number }).index));
    let run = 0;
    while (freeIdx.has(index + run)) run++;
    const reachesEnd = index + run >= chart.nights.length;
    leave();
    setPickNights(1);
    setPick({ room, night, freeRun: run, reachesEnd, rect });
  };
  const pickMax = pick ? (pick.reachesEnd ? Math.max(pick.freeRun, START_MAX_NIGHTS) : pick.freeRun) : 1;
  const roomNoOf = (id: string) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?";
  const selKeys = new Set(selected.map(selKey));
  const byRow = (list: Sel[]) => [...list].sort((x, y) => rows.indexOf(x.roomId) - rows.indexOf(y.roomId));
  /** Add picks, never past the server's limit — said, not silently cut. */
  const addPicks = (more: Sel[]) => {
    const fresh = more.filter((m) => !selKeys.has(selKey(m)));
    if (selected.length + fresh.length > MAX_PICK) {
      toast.error(`Pick at most ${MAX_PICK} rooms at a time`);
      return;
    }
    setSelected([...selected, ...fresh]);
  };
  const togglePick = (sel: Sel) => {
    anchor.current = sel;
    if (selKeys.has(selKey(sel))) setSelected(selected.filter((x) => selKey(x) !== selKey(sel)));
    else addPicks([sel]);
  };
  /** Shift-click: that booking's rooms between the last one picked and this one (operator ruling). */
  const pickRange = (sel: Sel) => {
    const a = anchor.current;
    if (!a || a.entryId !== sel.entryId) {
      if (a) toast("Shift picks one booking's rooms — Ctrl-click adds another booking's room");
      anchor.current = sel;
      addPicks([sel]);
      return;
    }
    const i = rows.indexOf(a.roomId);
    const j = rows.indexOf(sel.roomId);
    const between = rows
      .slice(Math.min(i, j), Math.max(i, j) + 1)
      .filter((rid) => (barsByRoom.get(rid) ?? []).some((x) => x.entryId === sel.entryId && MOVABLE.has(x.kind)));
    anchor.current = sel;
    addPicks(between.map((rid) => ({ entryId: sel.entryId, roomId: rid, roomNumber: roomNoOf(rid), name: sel.name })));
  };
  /** The picked rooms, the top one landing on this room and the rest keeping their spacing. */
  const moveSelectionTo = (roomId: string) => {
    const items = byRow(selected);
    const plan = planDrop(items, items[0], roomId, rows);
    if (!plan.ok) {
      if (plan.why) toast.error(plan.why);
      return;
    }
    setMoveLegs(plan.legs);
  };
  const clickBar = (e: React.MouseEvent, sel: Sel, movable: boolean) => {
    if (dragEnded.current) return;
    leave();
    const adding = e.ctrlKey || e.metaKey;
    if (adding || e.shiftKey) {
      e.preventDefault();
      if (!movable) {
        toast.error("A stay that has ended cannot be moved");
        return;
      }
      if (e.shiftKey && !adding) pickRange(sel);
      else togglePick(sel);
      return;
    }
    if (!switching) {
      router.push(`/bookings/${sel.entryId}`);
      return;
    }
    if (selKeys.has(selKey(sel))) {
      togglePick(sel);
      return;
    }
    if (!picking) {
      if (!movable) {
        toast.error("A stay that has ended cannot be moved");
        return;
      }
      anchor.current = sel;
      setSelected([sel]);
      return;
    }
    if (selected.some((x) => x.entryId === sel.entryId)) {
      toast.error("That is the same booking — Ctrl-click to pick its room too, or click another booking or a free night");
      return;
    }
    moveSelectionTo(sel.roomId);
  };
  /**
   * A press on a bar becomes a drag once the pointer moves; the picked rooms move with it when the
   * grabbed bar is one of them, else the grabbed bar alone. Escape drops it where it was.
   */
  const beginPress = (e: React.PointerEvent, sel: Sel) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.pointerType === "touch") return;
    const sx = e.clientX;
    const sy = e.clientY;
    const items = selKeys.has(selKey(sel)) ? byRow(selected) : [sel];
    const scroller = scrollerOf(wrapRef.current);
    // The night under the pointer, read off the header's columns — a bar spans several nights, so
    // the cell under the pointer cannot say which one.
    const nightAt = (x: number): string | null => {
      for (const th of Array.from(wrapRef.current?.querySelectorAll<HTMLElement>("th[data-night]") ?? [])) {
        const r = th.getBoundingClientRect();
        if (x >= r.left && x < r.right) return th.dataset.night ?? null;
      }
      return null;
    };
    const startNight = nightAt(sx);
    let current: Drag | null = null;
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("rchart-dragging");
      const done = current;
      setDrag(null);
      if (!done) return;
      dragEnded.current = true;
      window.setTimeout(() => {
        dragEnded.current = false;
      }, 0);
      if (!drop || !done.over) return;
      if (done.shift !== 0) {
        // Dragged sideways: the whole stay moves to other dates (and the room grabbed may land in
        // another row on the way). The dialog asks the server what that would do.
        const booking = bookingOf.get(done.grabbed.entryId);
        const why = dateMoveWhy(done, booking);
        if (why) {
          toast.error(why);
          return;
        }
        if (!booking?.checkInDate) return;
        setDateMove({
          entryId: done.grabbed.entryId,
          fromRoomId: done.grabbed.roomId,
          toRoomId: done.over !== done.grabbed.roomId ? done.over : null,
          newCheckInDate: ymdShift(booking.checkInDate, done.shift),
          label: done.grabbed.name,
        });
        return;
      }
      const plan = planDrop(done.items, done.grabbed, done.over, rows);
      if (!plan.ok) {
        if (plan.why) toast.error(plan.why);
        return;
      }
      setMoveLegs(plan.legs);
    };
    const onMove = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!current) {
        leave();
        setPick(null);
        document.body.classList.add("rchart-dragging");
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const row = under?.closest<HTMLElement>("tr[data-room-id]");
      const nightNow = nightAt(ev.clientX);
      const shift = startNight && nightNow ? daysFrom(startNight, nightNow) : current?.shift ?? 0;
      current = { items, grabbed: sel, over: row?.dataset.roomId ?? null, x: ev.clientX, y: ev.clientY, shift };
      setDrag(current);
      // Over the chart's own sticky header, or near the bottom edge, the chart scrolls — so a drop
      // can reach any room.
      if (scroller) {
        const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
        if (under?.closest(".rchart thead") || ev.clientY < box.top + 48) scroller.scrollBy(0, -18);
        else if (ev.clientY > box.bottom - 48) scroller.scrollBy(0, 18);
      }
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !current) return;
      ev.stopPropagation();
      ev.preventDefault();
      end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };
  // A sideways drag is a date move: its own plan and its own label.
  const dateDrag = drag && drag.shift !== 0 ? drag : null;
  const dateBooking = dateDrag ? bookingOf.get(dateDrag.grabbed.entryId) : undefined;
  const dateWhy = dateDrag ? dateMoveWhy(dateDrag, dateBooking) : null;
  const dateSpan =
    dateDrag && dateBooking?.checkInDate && dateBooking.checkOutDate
      ? { from: ymdShift(dateBooking.checkInDate, dateDrag.shift), to: ymdShift(dateBooking.checkOutDate, dateDrag.shift) }
      : null;
  const dropPlan = drag?.over && !dateDrag ? planDrop(drag.items, drag.grabbed, drag.over, rows) : null;
  const dropTo = new Set(dateDrag ? (dateWhy ? [] : [dateDrag.over ?? dateDrag.grabbed.roomId]) : dropPlan?.ok ? dropPlan.to : []);
  const dragged = new Set(drag ? drag.items.map(selKey) : []);
  const pickedWords = (() => {
    const by = new Map<string, Sel[]>();
    for (const s of byRow(selected)) by.set(s.entryId, [...(by.get(s.entryId) ?? []), s]);
    return [...by.values()].map((l) => `${l[0].name} · ${l.map((s) => s.roomNumber).join(", ")}`).join("  ·  ");
  })();
  const startInquiry = () => {
    if (!pick) return;
    const p = new URLSearchParams({ checkIn: pick.night, nights: String(pickNights), room: pick.room.roomNumber });
    setPick(null);
    router.push(`/bookings/new?${p.toString()}`);
  };

  const body = (
    <div className={`rchart${full ? " is-full" : ""}${drag ? " is-dragging" : ""}`}>
      <div className="rchart-bar">
        <div className="rchart-nav">
          <Button kind="quiet" compact onClick={() => setFrom(shiftDay(chart.from, -7))}>
            ← 7 nights
          </Button>
          <Button kind="quiet" compact state={chart.from === chart.today ? "inert" : "default"} onClick={() => setFrom(undefined)}>
            Today
          </Button>
          <Button kind="quiet" compact onClick={() => setFrom(shiftDay(chart.from, 7))}>
            7 nights →
          </Button>
          {/* The range (2026-10-12, operator: "keep the 7 nights up and down, but also a date
              range"). From is the first night shown, To the last; the week buttons and the
              lengths move or stretch the same window. */}
          <label className="rchart-date">
            <span>From</span>
            <input
              className="input"
              type="date"
              value={chart.from}
              onChange={(e) => {
                if (!isYmd(e.target.value)) return;
                setRangeNote(null);
                setFrom(e.target.value);
              }}
            />
          </label>
          <label className="rchart-date">
            <span>To</span>
            <input
              className="input"
              type="date"
              value={lastNight}
              min={chart.from}
              max={shiftDay(chart.from, MAX_NIGHTS - 1)}
              onChange={(e) => {
                if (!isYmd(e.target.value)) return;
                const n = nightsBetween(chart.from, e.target.value) + 1;
                if (n < 1) return;
                setRangeNote(n > MAX_NIGHTS ? `At most ${MAX_NIGHTS} nights at a time — showing the first ${MAX_NIGHTS}.` : null);
                setNightsAsked(Math.min(MAX_NIGHTS, n));
              }}
            />
          </label>
          <select
            className="input rchart-len"
            value={nightsAsked}
            onChange={(e) => {
              setRangeNote(null);
              setNightsAsked(Number(e.target.value));
            }}
            aria-label="How many nights"
          >
            {(WINDOWS.includes(nightsAsked) ? WINDOWS : [...WINDOWS, nightsAsked].sort((a, b) => a - b)).map((n) => (
              <option key={n} value={n}>
                {n} nights
              </option>
            ))}
          </select>
          <b className="rchart-span">{plural(chart.nights.length, "night")}</b>
          <Button
            kind={switching ? "primary" : "quiet"}
            compact
            aria-pressed={switching}
            onClick={() => {
              setPick(null);
              if (switching) stopSwitching();
              else setSwitching(true);
            }}
          >
            {switching ? "Stop switching" : "Switch rooms"}
          </Button>
          <Button kind="quiet" compact onClick={() => setFull((f) => !f)} aria-pressed={full}>
            {full ? "Exit full screen" : "Full screen"}
          </Button>
          <Help label="About the house chart">
            <p>Every room, night by night: who holds it and how firmly. Rest the pointer on a booking for a second to see it; click it to open the booking.</p>
            <p>Click a free night to start an inquiry for that room from that night. The room is chosen on the booking, where the house is asked.</p>
            <p>Click a room number to report a fault or review one. A room drawn free here is one the room search offers.</p>
            <p>Move rooms: drag a booking onto another room. Ctrl-click (Cmd on a Mac) picks more rooms, Shift-click picks a booking&apos;s rooms in between; drag one of them and they all move, the one you hold landing where you drop it and the rest keeping their spacing.</p>
            <p>Move dates: drag a booking sideways — the whole stay moves earlier or later, keeping its nights (before check-in only). Drag it down or up at the same time to change the room too.</p>
            <p>A booking already in a room you drop on swaps into the room left behind. Switch rooms does the same by clicking: pick a booking, then click another booking or a free night.</p>
            <p>Each room walks every step its booking needs; you see what each will do before anything runs.</p>
          </Help>
        </div>
        {rangeNote ? (
          <p className="warn-ink sm" role="status" style={{ margin: 0, fontWeight: 600 }}>
            {rangeNote}
          </p>
        ) : null}
        {switching || picking ? (
          <div className="rchart-switch" role="status">
            <b>{picking ? `${plural(selected.length, "room")} picked — ${pickedWords}` : "Switch rooms — click the booking whose room should change"}</b>
            <span>
              {picking
                ? switching
                  ? "Click the room the top one should move to, or a booking to swap with — the rest keep their spacing. Or drag them there."
                  : "Drag them onto another room: the one you hold lands where you drop it, the rest keep their spacing."
                : "Ctrl-click picks more rooms; Shift-click picks a booking's rooms in between."}
            </span>
            {picking ? (
              <Button
                kind="quiet"
                compact
                onClick={() => {
                  setSelected([]);
                  anchor.current = null;
                }}
              >
                Clear the picks
              </Button>
            ) : null}
          </div>
        ) : null}
        <Legend />
      </div>

      <div className="rchart-wrap" ref={wrapRef} onScroll={leave}>
        {/* At least 70px a night; wider screens share the rest evenly. */}
        <table className="tape" style={{ minWidth: 190 + 64 + 70 * chart.nights.length }}>
          <thead>
            <tr className="h1">
              <th className="rc">Rooms</th>
              {chart.nights.map((d, i) => {
                const showMonth = i === 0 || d.slice(8, 10) === "01";
                return (
                  <th
                    key={d}
                    data-night={d}
                    className={
                      [
                        d === chart.today ? "today" : "",
                        d < chart.today ? "past" : "",
                        weekend(d) ? "we" : "",
                        d.slice(8, 10) === "01" && i > 0 ? "m1" : "",
                        dateSpan && !dateWhy && d >= dateSpan.from && d < dateSpan.to ? "drop-night" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    <span className="wd">{d === chart.today ? "Today" : WEEKDAY[dayOfWeek(d)]}</span>
                    <b className="dn">{Number(d.slice(8, 10))}</b>
                    <span className={`mo${showMonth ? "" : " hidden"}`}>{MONTH[Number(d.slice(5, 7)) - 1]}</span>
                  </th>
                );
              })}
              <th className="tc">Taken</th>
            </tr>
            <tr className="h2">
              <th className="rc">Free that night</th>
              {chart.perNight.map((n) => (
                <td key={n.date} className={`need ${n.free >= 5 ? "ok" : n.free > 0 ? "short" : "none"}`}>
                  {n.free}
                </td>
              ))}
              <td className="tc" />
            </tr>
            <tr className="h3">
              <th className="rc">House booked</th>
              {chart.perNight.map((n) => (
                <td key={n.date} className="hb">
                  {n.booked}/{n.total}
                </td>
              ))}
              <td className="tc" />
            </tr>
          </thead>
          <tbody>
            {chart.roomTypes.map((t) => (
              <Fragment key={t.id}>
                <tr className="trow">
                  <th className="rc">
                    <span className="tname">{t.name}</span>
                    <span className="tcount">{plural(t.roomIds.length, "room")}</span>
                  </th>
                  {t.freePerNight.map((f, i) => (
                    <td key={chart.nights[i]} className={`fc ${f === 0 ? "none" : ""}`}>
                      {f === 0 ? "none" : `${f} free`}
                    </td>
                  ))}
                  <td className="tc" />
                </tr>
                {t.roomIds.map((rid, ri) => {
                  const room = chart.rooms.find((r) => r.id === rid);
                  if (!room) return null;
                  const hk = housekeepingOf(room);
                  const segs = segmentsFor(room, chart, barsByRoom.get(rid) ?? []);
                  return (
                    <tr
                      key={rid}
                      data-room-id={rid}
                      className={[
                        "rrow",
                        ri === t.roomIds.length - 1 ? "last" : "",
                        dropTo.has(rid) ? "drop-to" : "",
                        drag?.over === rid && ((dropPlan && !dropPlan.ok && dropPlan.why) || dateWhy) ? "drop-bad" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <th className="rc rno">
                        <button type="button" className="rno-btn" onClick={() => onOpenRoom(room)} aria-label={`Room ${room.roomNumber} — ${hk.word}${room.faultOpen ? ", fault reported" : ""}`}>
                          <span className="rnum">{room.roomNumber}</span>
                          {room.bedType ? <span className="bed">{BED_LETTER[room.bedType] ?? room.bedType}</span> : null}
                          <i className={`hkdot ${hk.cls}`} />
                          {room.faultOpen ? <span className="fault">fault</span> : null}
                        </button>
                      </th>
                      {segs.map((s, k) => {
                        if (s.t === "free") {
                          const past = s.night < chart.today;
                          return (
                            <td
                              key={k}
                              className={[
                                "cell free",
                                s.night === chart.today ? "tday" : "",
                                past ? "past" : "pick",
                                switching && picking && !selected.some((x) => x.roomId === room.id) ? "moveto" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              aria-label={
                                switching
                                  ? picking && !selected.some((x) => x.roomId === room.id)
                                    ? `Move the picked rooms so the top one lands in Room ${room.roomNumber}`
                                    : undefined
                                  : past
                                    ? undefined
                                    : `Room ${room.roomNumber} free on ${longDay(s.night)} — click to start an inquiry`
                              }
                              onClick={(e) => {
                                if (dragEnded.current) return;
                                if (switching) {
                                  if (!picking) toast("Click the booking to move first");
                                  else moveSelectionTo(room.id);
                                } else if (!past) openPick(room, s.night, s.index, rectOf(e), segs);
                              }}
                            />
                          );
                        }
                        if (s.t === "ooo")
                          return (
                            <td
                              key={k}
                              colSpan={s.span}
                              className="seg k-ooo"
                              onMouseEnter={(e) => point({ t: "ooo", room, reason: s.reason, from: s.from, to: s.to, rect: rectOf(e) })}
                              onMouseLeave={leave}
                            >
                              <div className="bar">Out of order{s.reason ? ` · ${s.reason}` : ""}</div>
                            </td>
                          );
                        if (s.t === "conflict")
                          return (
                            <td
                              key={k}
                              className="seg k-conflict"
                              onMouseEnter={(e) => point({ t: "conflict", bars: s.bars, room, night: s.night, rect: rectOf(e) })}
                              onMouseLeave={leave}
                            >
                              <div className="bar">{s.bars.length}×</div>
                            </td>
                          );
                        const b = bookingOf.get(s.bar.entryId);
                        const sel: Sel = { entryId: s.bar.entryId, roomId: room.id, roomNumber: room.roomNumber, name: nameOf(b) };
                        const movable = MOVABLE.has(s.bar.kind);
                        const contL = s.bar.from === chart.from && !!b?.checkInDate && b.checkInDate < chart.from;
                        const contR = s.bar.to === chart.to && !!b?.checkOutDate && b.checkOutDate > chart.to;
                        return (
                          <td
                            key={k}
                            colSpan={s.span}
                            className={`seg ${KIND_CLASS[s.bar.kind]}${s.bar.parked ? " parked" : ""}${s.bar.paymentPending ? " paypend" : ""}${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}${selKeys.has(selKey(sel)) ? " marked" : ""}${dragged.has(selKey(sel)) ? " dragging" : ""}`}
                          >
                            <button
                              type="button"
                              className={`bar${movable ? " grab" : ""}`}
                              aria-pressed={selKeys.has(selKey(sel)) || undefined}
                              onMouseEnter={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onMouseLeave={leave}
                              onFocus={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onBlur={leave}
                              onPointerDown={movable ? (e) => beginPress(e, sel) : undefined}
                              // Shift and Ctrl clicks pick rooms; they must not select text.
                              onMouseDown={(e) => (e.shiftKey || e.ctrlKey || e.metaKey) && e.preventDefault()}
                              onClick={(e) => clickBar(e, sel, movable)}
                            >
                              {s.bar.parked ? <span className="pk">Parked</span> : null}
                              {nameOf(b)}
                              {s.span > 1 && b ? <span className="st"> · {STEP_NAMES[stepNoOfStage(b.stage) - 1]}</span> : null}
                            </button>
                          </td>
                        );
                      })}
                      <td className="tc rsub">
                        {room.nightsTaken}/{chart.nights.length}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <RoomMoveDialog
        legs={moveLegs}
        onClose={() => {
          setMoveLegs(null);
          stopSwitching();
        }}
      />

      {drag ? (
        <Floating>
          <div className={`rchart-ghost${(dropPlan && !dropPlan.ok && dropPlan.why) || dateWhy ? " bad" : ""}`} style={{ left: drag.x + 16, top: drag.y + 16 }} role="status">
            {dateDrag ? (
              dateWhy ? (
                <span>{dateWhy}</span>
              ) : (
                <>
                  <span>
                    {dateDrag.grabbed.name} · <b>{dateSpan ? fmtRange(dateSpan.from, dateSpan.to) : ""}</b>
                  </span>
                  <span className="sub">
                    {Math.abs(dateDrag.shift)} {Math.abs(dateDrag.shift) === 1 ? "day" : "days"} {dateDrag.shift > 0 ? "later" : "earlier"}
                    {dateDrag.over && dateDrag.over !== dateDrag.grabbed.roomId ? ` · Room ${dateDrag.grabbed.roomNumber} → ${roomNoOf(dateDrag.over)}` : ""}
                  </span>
                  <span className="sub">Let go to see what moving the dates would do</span>
                </>
              )
            ) : dropPlan?.ok ? (
              <>
                {dropPlan.legs.slice(0, 5).map((l) => (
                  <span key={selKey({ entryId: l.entryId, roomId: l.fromRoomId })}>
                    Room {roomNoOf(l.fromRoomId)} → <b>{roomNoOf(l.toRoomId)}</b>
                  </span>
                ))}
                {dropPlan.legs.length > 5 ? <span>and {dropPlan.legs.length - 5} more</span> : null}
                <span className="sub">Let go to see what the move would do</span>
              </>
            ) : dropPlan && !dropPlan.ok && dropPlan.why ? (
              <span>{dropPlan.why}</span>
            ) : (
              <>
                <span>
                  Moving {drag.items.length > 1 ? plural(drag.items.length, "room") : `Room ${drag.grabbed.roomNumber}`} · {drag.grabbed.name}
                </span>
                <span className="sub">Drop it on another room</span>
              </>
            )}
          </div>
        </Floating>
      ) : null}

      <DateMoveDialog
        move={dateMove}
        onClose={() => {
          setDateMove(null);
          stopSwitching();
        }}
      />

      {hover && !pick && !moveLegs && !dateMove ? (
        <Floating>
          <HoverCard hover={hover} chart={chart} bookingOf={bookingOf} typeName={(id) => typeOf.get(id)?.name ?? ""} />
        </Floating>
      ) : null}

      {pick ? (
        <Floating>
          <div className="rchart-pick e-k-free" ref={pickRef} style={placeBeside(pick.rect, 300)} role="dialog" aria-label="Start an inquiry">
            <div className="hc-head k-free">
              <span className="hc-kind">Free</span>
              <span className="hc-room">Room {pick.room.roomNumber}</span>
            </div>
            <div className="hc-body">
              <div className="hc-name">Start an inquiry</div>
              <div className="hc-sub">
                {typeOf.get(pick.room.roomTypeId)?.name}
                {pick.room.bedType ? ` · ${BED_WORD[pick.room.bedType] ?? pick.room.bedType}` : ""}
              </div>
              <div className="pick-row">
                <span>From</span>
                <b>{longDay(pick.night)}</b>
              </div>
              <div className="pick-row">
                <span>Nights</span>
                <span className="stepper">
                  <button type="button" aria-label="One night fewer" disabled={pickNights <= 1} onClick={() => setPickNights((n) => Math.max(1, n - 1))}>
                    −
                  </button>
                  <b>{pickNights}</b>
                  <button type="button" aria-label="One night more" disabled={pickNights >= pickMax} onClick={() => setPickNights((n) => Math.min(pickMax, n + 1))}>
                    +
                  </button>
                </span>
                <span className="pick-out">out {longDay(shiftDay(pick.night, pickNights))}</span>
              </div>
              {pickNights > pick.freeRun ? (
                <p className="pick-note">Past the chart — the house is asked for those nights on the booking.</p>
              ) : !pick.reachesEnd && pickNights === pick.freeRun ? (
                <p className="pick-note">The room is taken the night after.</p>
              ) : null}
              <div className="pick-acts">
                <Button kind="primary" compact onClick={startInquiry}>
                  Start an inquiry
                </Button>
                <Button kind="quiet" compact onClick={() => setPick(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </Floating>
      ) : null}
    </div>
  );

  // Full screen is the same chart lifted over the whole window, at the desk's root so no page
  // layout (a scrolling main, a sticky header) can clip or out-stack it.
  return full ? (
    <Floating>
      <div className="rchart-full" role="dialog" aria-label="House chart, full screen">
        {body}
      </div>
    </Floating>
  ) : (
    body
  );
}

/** The hover card — the chart's own colours, the booking's facts in order. */
function HoverCard({
  hover,
  chart,
  bookingOf,
  typeName,
}: {
  hover: Hover;
  chart: RoomChart;
  bookingOf: Map<string, RoomChartBooking>;
  typeName: (roomTypeId: string) => string;
}) {
  const style = placeBeside(hover.rect, 320);
  const roomLine = (r: ChartRoom) => `Room ${r.roomNumber} · ${typeName(r.roomTypeId)}${r.bedType ? ` · ${BED_WORD[r.bedType] ?? r.bedType}` : ""}`;
  const fact = (k: string, v: ReactNode) => (
    <div className="hc-fact" key={k}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );

  if (hover.t === "bar") {
    const { bar, room } = hover;
    const b = bookingOf.get(bar.entryId);
    const stay = b?.checkInDate && b.checkOutDate ? nightsBetween(b.checkInDate, b.checkOutDate) : null;
    return (
      <div className={`rchart-hc e-${KIND_CLASS[bar.kind]}`} style={style} role="tooltip">
        <div className={`hc-head ${KIND_CLASS[bar.kind]}${bar.parked ? " parked" : ""}`}>
          <span className="hc-kind">{KIND_WORD[bar.kind]}</span>
          {bar.parked ? <span className="hc-tag">Parked</span> : null}
          {bar.paymentPending ? <span className="hc-tag">Advance short</span> : null}
        </div>
        <div className="hc-body">
          <div className="hc-name">{b ? rowNameOf(b) : bar.entryId}</div>
          {b?.partyName ? <div className="hc-sub">Booked by {b.partyName}</div> : null}
          <div className="hc-facts">
            {fact("Room", roomLine(room))}
            {fact("In this room", `${fmtRange(bar.from, bar.to)} · ${plural(nightsBetween(bar.from, bar.to), "night")} on the chart`)}
            {b?.checkInDate ? fact("Stay", `${fmtRange(b.checkInDate, b.checkOutDate)}${stay ? ` · ${plural(stay, "night")}` : ""}`) : null}
            {b ? fact("Step", <span className="hc-step">{STEP_NAMES[stepNoOfStage(b.stage) - 1]}</span>) : null}
            {fact("Booking", b ? `${b.entryId} · ${b.inquiryId}` : bar.entryId)}
            {bar.holdExpiresAt ? fact("Held until", fmtDateTime(bar.holdExpiresAt)) : null}
            {bar.moveId ? fact("Room move", bar.moveId) : null}
          </div>
        </div>
        <div className="hc-foot">{bar.kind === "MOVING" ? "Being moved into this room — open the booking to see the move" : "Click to open the booking"}</div>
      </div>
    );
  }
  if (hover.t === "conflict") {
    return (
      <div className="rchart-hc e-k-conflict" style={style} role="tooltip">
        <div className="hc-head k-conflict">
          <span className="hc-kind">Two bookings on one night</span>
        </div>
        <div className="hc-body">
          <div className="hc-sub">
            {roomLine(hover.room)} · {longDay(hover.night)}
          </div>
          <div className="hc-facts">
            {hover.bars.map((x) => {
              const b = bookingOf.get(x.entryId);
              return fact(KIND_WORD[x.kind], `${b ? rowNameOf(b) : "Booking"} · ${x.entryId}`);
            })}
          </div>
        </div>
        <div className="hc-foot">One of them has to move — open each from the Bookings list</div>
      </div>
    );
  }
  if (hover.t === "ooo") {
    return (
      <div className="rchart-hc e-k-ooo" style={style} role="tooltip">
        <div className="hc-head k-ooo">
          <span className="hc-kind">Out of order</span>
        </div>
        <div className="hc-body">
          <div className="hc-name">{hover.reason ?? "Off sale"}</div>
          <div className="hc-facts">
            {fact("Room", roomLine(hover.room))}
            {fact("Nights", `${fmtRange(hover.from, hover.to)} on the chart`)}
            {hover.room.outOfOrder?.until ? fact("Due back", fmtDateTime(hover.room.outOfOrder.until)) : null}
          </div>
        </div>
        <div className="hc-foot">Click the room number for its fault record</div>
      </div>
    );
  }
  return null;
}

function Legend() {
  const items: Array<[string, string]> = [
    ["free", "Free"],
    ["k-prov", "Provisional block"],
    ["k-held", "Held · not confirmed"],
    ["k-move", "Moving in"],
    ["k-res", "Reserved"],
    ["k-res paypend", "Reserved · advance short"],
    ["k-in", "In house"],
    ["k-over", "Due out · still in"],
    ["k-out", "Checked out"],
    ["k-res parked", "Parked"],
    ["k-ooo", "Out of order"],
    ["k-conflict", "Two bookings"],
  ];
  return (
    <div className="rslegend">
      {items.map(([cls, word]) => (
        <span key={word}>
          <i className={`sw ${cls}`} />
          {word}
        </span>
      ))}
      <span>
        <i className="hkdot hk-ok" />
        clean <i className="hkdot hk-warn" style={{ marginLeft: 8 }} />
        to clean
      </span>
    </div>
  );
}

