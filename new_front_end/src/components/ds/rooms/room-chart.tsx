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
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, type ChartBarKind, type RoomChart, type RoomChartBar, type RoomChartBooking, type RoomChartPick } from "@/lib/api/rooms";
import { fmtDateTime, fmtRange, plural } from "@/lib/ds/format";
import { rowNameOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { RoomMoveLegInput } from "@/lib/api/room-moves";
import { RoomMoveDialog } from "./room-move-dialog";
import { QuietRoomDialog, type QuietPick } from "./quiet-room-dialog";
import { DateMoveDialog } from "./date-move-dialog";
import { SplitMoveDialog, type SplitMove } from "./split-move-dialog";
import { NightMoveDialog, type NightMove } from "./night-move-dialog";
import { BookingBox, type BoxMove } from "./booking-box";
import type { DateMoveInput } from "@/lib/api/room-moves";
import { DateInput } from "@/components/ds/date-input";

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
/** The window's length when the address names none. */
const DEFAULT_NIGHTS = 14;
/** Where the desk was in the chart, kept for this browser tab (see `RoomChartView`). */
const PLACE_KEY = "desk:chart-place";
type ChartPlace = { key: string; left: number; top: number; pageY: number; full: boolean };

function readPlace(key: string): ChartPlace | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(PLACE_KEY) ?? "null") as Partial<ChartPlace> | null;
    if (!v || v.key !== key) return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
    return { key, left: n(v.left), top: n(v.top), pageY: n(v.pageY), full: v.full === true };
  } catch {
    return null;
  }
}
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
  | { t: "conflict"; night: string; bars: RoomChartBar[] }
  /** Free, but chosen by bookings that hold nothing yet (2026-10-16) — drawn faint, counted nowhere. */
  | { t: "picks"; span: number; index: number; from: string; to: string; picks: RoomChartPick[] };

/** What the hover card is about — only what is on the chart (2026-10-12). */
type Hover =
  | { t: "bar"; bar: RoomChartBar; room: ChartRoom; rect: DOMRect }
  | { t: "conflict"; bars: RoomChartBar[]; room: ChartRoom; night: string; rect: DOMRect }
  | { t: "picks"; picks: RoomChartPick[]; room: ChartRoom; from: string; to: string; rect: DOMRect }
  | { t: "ooo"; room: ChartRoom; reason: string | null; from: string; to: string; rect: DOMRect };

/** How long the pointer rests on a booking before its card opens. */
const HOVER_DELAY_MS = 1000;

/** The open "Start an inquiry" box on a free night. */
type Pick = { room: ChartRoom; night: string; freeRun: number; reachesEnd: boolean; rect: DOMRect };
/** The open list of the bookings that chose a room-night (2026-10-16). */
type PickList = { room: ChartRoom; picks: RoomChartPick[]; rect: DOMRect };
/** The open list of two bookings that hold one room-night (2026-10-23) — each opens from here. */
type ClashList = { room: ChartRoom; night: string; bars: RoomChartBar[]; rect: DOMRect };
/** One entry per booking, in the order given. */
const uniquePicks = (list: RoomChartPick[]) => list.filter((p, i) => list.findIndex((q) => q.entryId === p.entryId) === i);

/** A booking's claim on one room, picked on the chart (Ctrl / Shift click) or grabbed by a drag. */
type Sel = { entryId: string; roomId: string; roomNumber: string; name: string };
const selKey = (s: { entryId: string; roomId: string }) => `${s.entryId}|${s.roomId}`;
/**
 * A drag under way: what moves, the room grabbed, the row under the pointer — and, since
 * 2026-10-13, how many nights sideways it has been dragged (a date move when not 0).
 */
type Drag = {
  items: Sel[];
  grabbed: Sel;
  over: string | null;
  x: number;
  y: number;
  shift: number;
  /**
   * Set on an Alt-drag (2026-10-14): only these nights move — the grabbed room's and, since
   * 2026-10-15, every other room of the booking picked with Alt+Ctrl. The grabbed room first.
   */
  nightRooms?: NightRoom[];
};
/** One room's run of nights, picked with Alt-click. */
type NightRoom = { roomId: string; roomNumber: string; nights: string[] };
/** Nights picked with Alt-click — one booking; Alt+Ctrl-click adds another of its rooms (2026-10-15). */
type NightSel = { entryId: string; name: string; rooms: NightRoom[] };
/** "A night picked — Room 206 · 21 → 22 Oct" · "2 rooms' nights picked — 205 · 22 → 23 Oct · 206 · 22 → 23 Oct" */
/** Nights in runs that follow one another (2026-10-22: a room's picked nights may have gaps). */
const nightRuns = (nights: string[]): string[][] => {
  const out: string[][] = [];
  for (const n of [...new Set(nights)].sort()) {
    const last = out[out.length - 1];
    if (last && shiftDay(last[last.length - 1], 1) === n) last.push(n);
    else out.push([n]);
  }
  return out;
};
/** "21 → 22 Oct" · "25 → 26 Oct · 27 → 28 Oct" */
const runsWords = (nights: string[]) => nightRuns(nights).map((run) => fmtRange(run[0], shiftDay(run[run.length - 1], 1))).join(" · ");
const nightRunWords = (r: NightRoom) => runsWords(r.nights);
const nightPickWords = (rooms: NightRoom[]) =>
  rooms.length === 1
    ? `${rooms[0].nights.length === 1 ? "A night" : `${rooms[0].nights.length} nights`} picked — Room ${rooms[0].roomNumber} · ${nightRunWords(rooms[0])}`
    : `${rooms.length} rooms' nights picked — ${rooms.map((r) => `${r.roomNumber} · ${nightRunWords(r)}`).join(" · ")}`;

const DAY_MS = 86_400_000;
const ymdShift = (ymd: string, days: number) =>
  new Date(Date.parse(`${ymd.slice(0, 10)}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
/**
 * The room number when the booking already holds this room on the chart, else null. A drop onto
 * one of the booking's own rooms is refused by the server ("already part of this booking"), so the
 * chart says so while the bar is still in the hand.
 */
type OwnRoom = (entryId: string, roomId: string) => string | null;
const ownRoomOf =
  (barsByRoom: Map<string, RoomChartBar[]>, roomNo: (id: string) => string): OwnRoom =>
  (entryId, roomId) =>
    (barsByRoom.get(roomId) ?? []).some((b) => b.entryId === entryId && MOVABLE.has(b.kind)) ? roomNo(roomId) : null;
const ownRoomWhy = (no: string) => `Room ${no} is already part of this booking — drop it on a room outside it`;

/**
 * Whether a booking can be dragged to other dates (2026-10-13 rulings: any booking before check-in;
 * the whole stay shifts; one booking at a time). The server re-checks all of it and more — this only
 * says, while dragging, what would certainly be refused.
 */
function dateMoveWhy(drag: Drag, booking: RoomChartBooking | undefined): string | null {
  if (new Set(drag.items.map((s) => s.entryId)).size > 1) return "Move one booking's dates at a time";
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
  }
  return booking.checkInDate ? null : "This booking has no dates to move";
}
/**
 * Whether a night of a booking can be moved (2026-10-14): before check-in to other dates or another
 * room; in house only to another room on the same dates, the server deciding the rest.
 */
function nightMoveWhy(d: Drag, booking: RoomChartBooking | undefined): string | null {
  if (!booking) return null;
  if (booking.status === "PARKED") return "This booking is parked — resume it first";
  if (booking.status !== "ACTIVE") return "This booking has ended — its nights are a record now";
  if (booking.stage === "S1") return "At Inquiry the rooms are picked on the booking's Inquiry step";
  if (booking.stage === "S8" || booking.stage === "S9") return "The guest has left or is leaving — the stay does not move";
  if (d.shift !== 0 && (booking.stage === "S6" || booking.stage === "S7")) return "In house — a night leaves the stay through Leaving early";
  return null;
}
/** The nights a booking holds in a room on the chart. */
type Holds = (entryId: string, roomId: string) => Set<string>;
const holdsOf =
  (barsByRoom: Map<string, RoomChartBar[]>): Holds =>
  (entryId, roomId) => {
    const out = new Set<string>();
    for (const b of barsByRoom.get(roomId) ?? []) {
      if (b.entryId !== entryId || !MOVABLE.has(b.kind)) continue;
      for (let d = b.from; d < b.to; d = shiftDay(d, 1)) out.add(d);
    }
    return out;
  };
/**
 * Where an Alt-drag sends each picked room's nights (2026-10-15): the grabbed room to the row under
 * the pointer, every other picked room keeping its spacing from it — rows counted down the chart as
 * drawn, across room types. A room the booking holds on OTHER nights may take them (operator: "305
 * on the 23rd was in 206, but I can't move it back to 206"); a night the booking already holds there,
 * and does not move out of it, is refused, as the server refuses it.
 */
function planNightDrop(
  d: Drag,
  rows: string[],
  roomNo: (id: string) => string,
  holds: Holds,
): { ok: true; idle: boolean; picks: Array<NightRoom & { to: string }> } | { ok: false; why: string | null } {
  const list = d.nightRooms ?? [];
  const from = rows.indexOf(d.grabbed.roomId);
  const at = rows.indexOf(d.over ?? d.grabbed.roomId);
  if (!list.length || from < 0 || at < 0) return { ok: false, why: null };
  const step = at - from;
  const idle = d.shift === 0 && step === 0;
  const picks: Array<NightRoom & { to: string }> = [];
  for (const r of list) {
    const i = rows.indexOf(r.roomId) + step;
    if (i < 0) return { ok: false, why: `Room ${r.roomNumber} would land above the first room — drop lower` };
    if (i >= rows.length) return { ok: false, why: `Room ${r.roomNumber} would land below the last room — drop higher` };
    picks.push({ ...r, to: rows[i] });
  }
  if (!idle) {
    for (const p of picks) {
      const leaving = new Set(list.filter((r) => r.roomId === p.to).flatMap((r) => r.nights));
      const held = holds(d.grabbed.entryId, p.to);
      const clash = p.nights.map((n) => shiftDay(n, d.shift)).find((n) => held.has(n) && !leaving.has(n));
      if (clash) return { ok: false, why: `Room ${roomNo(p.to)} already holds this booking on ${longDay(clash)} — drop it on a free night` };
    }
  }
  return { ok: true, idle, picks };
}
/**
 * A date drag moves the booking as a block (2026-10-13, operator: "they should have gone together"):
 * every room it holds on the chart shifts by the rows the grabbed room moved, keeping the spacing —
 * rows counted down the chart as drawn, across room types. An empty map: no room changes row.
 */
function dateBlock(
  d: Drag,
  rows: string[],
  ownRows: string[],
  roomNo: (id: string) => string,
): { map: Map<string, string>; why: string | null } {
  const map = new Map<string, string>();
  const from = rows.indexOf(d.grabbed.roomId);
  const at = rows.indexOf(d.over ?? d.grabbed.roomId);
  if (from < 0 || at < 0 || at === from) return { map, why: null };
  const step = at - from;
  for (const rid of ownRows) {
    const i = rows.indexOf(rid) + step;
    if (i < 0) return { map: new Map(), why: `Room ${roomNo(rid)} would land above the first room — drop lower` };
    if (i >= rows.length) return { map: new Map(), why: `Room ${roomNo(rid)} would land below the last room — drop higher` };
    map.set(rid, rows[i]);
  }
  return { map, why: null };
}
/**
 * The rooms a date drag takes (2026-10-14, operator: "move one singular room to another date range
 * without selecting the other rooms with it"): the room grabbed, or the rooms picked with it (Ctrl /
 * Shift). All of them moves the whole booking; fewer splits them off to a booking of their own.
 */
function dateMovingRows(d: Drag, ownRows: string[]): string[] {
  const picked = new Set(d.items.filter((s) => s.entryId === d.grabbed.entryId).map((s) => s.roomId));
  picked.add(d.grabbed.roomId);
  const rows = ownRows.filter((r) => picked.has(r));
  return rows.length ? rows : [d.grabbed.roomId];
}
/** "Room 205" · "Rooms 205 + 206" */
const roomsWords = (ids: string[], roomNo: (id: string) => string) =>
  ids.length === 1 ? `Room ${roomNo(ids[0])}` : `Rooms ${ids.map(roomNo).join(" + ")}`;

/** "204 → 306 · 205 → 307 · and 2 more" */
function blockWords(map: Map<string, string>, roomNo: (id: string) => string, max = 3): string {
  const pairs = [...map].map(([f, t]) => `${roomNo(f)} → ${roomNo(t)}`);
  return pairs.length > max ? `${pairs.slice(0, max).join(" · ")} · and ${pairs.length - max} more` : pairs.join(" · ");
}

/** The server takes at most 8 picked rooms in one move. */
const MAX_PICK = 8;
/** Bars that can be picked up — the server refuses the rest with its reason (a provisional block,
 * a guest due out), but a stay that has ended is not offered at all. */
const MOVABLE = new Set<ChartBarKind>(["RESERVED", "HELD", "IN_HOUSE", "PROVISIONAL", "OVERSTAY"]);

/**
 * Guest colours (2026-10-23, operator: "all reservations almost look the same"; then "some colours
 * are used again for other guests — can we have unique colours"): with the switch on, every booking
 * in view takes its OWN shade — pale while reserved or held, deep once in house — and its edge still
 * says how it is held (dashed held, dotted provisional). The shades are generated, as many as there
 * are bookings: hues stepped by the golden ratio over the wheel without red (a problem) or the
 * accent's purple (a selection), at three lightness levels. The warning kinds keep their own look.
 */
type GuestColour = { hue: number; level: number; bg: string; line: string; tx: string };
const HUE_ARCS: ReadonlyArray<readonly [number, number]> = [
  [18, 255],
  [295, 345],
];
const HUE_SPAN = HUE_ARCS.reduce((n, [a, b]) => n + (b - a), 0);
const LEVELS = [
  { s: 68, l: 84 },
  { s: 58, l: 75 },
  { s: 74, l: 91 },
];
/** The shade for the i-th booking in view: consecutive ones land far apart on the wheel. */
const guestShade = (i: number): GuestColour => {
  let x = ((i * 0.6180339887) % 1) * HUE_SPAN;
  let hue = HUE_ARCS[0][0];
  for (const [a, b] of HUE_ARCS) {
    if (x <= b - a) {
      hue = Math.round((a + x) * 10) / 10; // a tenth of a degree, so no two shades in view ever round together
      break;
    }
    x -= b - a;
  }
  const level = i % LEVELS.length;
  const L = LEVELS[level];
  return { hue, level, bg: `hsl(${hue} ${L.s}% ${L.l}%)`, line: `hsl(${hue} 55% 40%)`, tx: `hsl(${hue} 65% 23%)` };
};
/** How far apart two shades look: the hue's distance round the wheel, and a step for lightness. */
const shadeDistance = (a: GuestColour, b: GuestColour) => {
  const d = Math.abs(a.hue - b.hue) % 360;
  return Math.min(d, 360 - d) + 28 * Math.abs(a.level - b.level);
};
const GUEST_KINDS = new Set<ChartBarKind>(["RESERVED", "HELD", "PROVISIONAL", "IN_HOUSE"]);
const guestStyle = (c: GuestColour) => ({ "--g-bg": c.bg, "--g-line": c.line, "--g-tx": c.tx }) as React.CSSProperties;

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
  ownRoom?: OwnRoom,
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
    const own = ownRoom?.(it.entryId, rows[i]);
    if (own) return { ok: false, why: ownRoomWhy(own) };
    legs.push({ entryId: it.entryId, fromRoomId: it.roomId, toRoomId: rows[i] });
  }
  return { ok: true, legs, to: legs.map((l) => l.toRoomId) };
}

/**
 * Where a dragged bar would land, drawn as a grey copy over the chart (2026-10-13, operator: "when
 * I move can it visually show the selected rooms move like greyed ghost of it"). One box per bar:
 * on its new row and, for a sideways drag, its new nights. Measured off the table's own cells, so
 * the copy sits exactly where the move would put it; cut at the chart's visible box.
 */
type LandBox = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  name: string;
  note: string;
  cutL: boolean;
  cutR: boolean;
  /** A booking that would be swapped into the room left behind — the server adds that leg. */
  swapped: boolean;
};

function landingBoxes(
  d: Drag,
  ctx: {
    wrap: HTMLElement;
    chart: RoomChart;
    bookingOf: Map<string, RoomChartBooking>;
    barsByRoom: Map<string, RoomChartBar[]>;
    rows: string[];
  },
): LandBox[] {
  const { wrap, chart, bookingOf, barsByRoom, rows } = ctx;
  const shift = d.shift;
  // An Alt-drag: only the picked nights, each room on its new row and its new nights.
  if (d.nightRooms) {
    if (nightMoveWhy(d, bookingOf.get(d.grabbed.entryId))) return [];
    const roomNoN = (id: string) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?";
    const plan = planNightDrop(d, rows, roomNoN, holdsOf(barsByRoom));
    if (!plan.ok || plan.idle) return [];
    const nightRectN = new Map(
      Array.from(wrap.querySelectorAll<HTMLElement>("thead th[data-night]")).map((th) => [th.dataset.night ?? "", th.getBoundingClientRect()]),
    );
    const boxN = wrap.getBoundingClientRect();
    const clipLN = Math.max(boxN.left, wrap.querySelector("thead th.rc")?.getBoundingClientRect().right ?? boxN.left);
    const clipRN = boxN.left + wrap.clientLeft + wrap.clientWidth;
    const clipTN = Math.max(boxN.top, wrap.querySelector("thead")?.getBoundingClientRect().bottom ?? boxN.top);
    const clipBN = Math.min(boxN.top + wrap.clientTop + wrap.clientHeight, window.innerHeight);
    const lastNightN = chart.nights[chart.nights.length - 1];
    const booking = bookingOf.get(d.grabbed.entryId);
    const outN: LandBox[] = [];
    for (const p of plan.picks) {
      const row = wrap.querySelector<HTMLElement>(`tr[data-room-id="${p.to}"]`);
      if (!row) continue;
      // One copy per run of the room's nights — a gap between picked nights is not drawn as taken.
      const rr = row.getBoundingClientRect();
      nightRuns(p.nights.map((n) => shiftDay(n, shift))).forEach((moved, ri) => {
        const first = moved[0] < chart.from ? chart.from : moved[0];
        const last = moved[moved.length - 1] > lastNightN ? lastNightN : moved[moved.length - 1];
        if (first > last) return;
        const a = nightRectN.get(first);
        const z = nightRectN.get(last);
        if (!a || !z) return;
        let left = a.left + 2;
        let right = z.right - 2;
        let cutL = moved[0] < chart.from;
        let cutR = moved[moved.length - 1] > lastNightN;
        if (left < clipLN) {
          left = clipLN;
          cutL = true;
        }
        if (right > clipRN) {
          right = clipRN;
          cutR = true;
        }
        const top = Math.max(rr.top + 3, clipTN);
        const bottom = Math.min(rr.bottom - 3, clipBN);
        if (right - left < 6 || bottom - top < 6) return;
        outN.push({
          key: `night|${d.grabbed.entryId}|${p.roomId}|${ri}`,
          left,
          top,
          width: right - left,
          height: bottom - top,
          name: booking ? rowNameOf(booking) : "Booking",
          note: shift !== 0 ? `${fmtRange(moved[0], shiftDay(moved[moved.length - 1], 1))}${p.to !== p.roomId ? ` · Room ${roomNoN(p.to)}` : ""}` : `Room ${roomNoN(p.to)}`,
          cutL,
          cutR,
          swapped: false,
        });
      });
    }
    return outN;
  }
  const ownRoom = ownRoomOf(barsByRoom, (id) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?");
  // What lands where: a sideways drag moves the whole stay (every room the booking holds, the
  // grabbed one onto the row under the pointer); a drag down or up moves the picked rooms.
  type Move = { entryId: string; from: string; to: string; swapped: boolean };
  let moves: Move[];
  if (shift !== 0) {
    if (dateMoveWhy(d, bookingOf.get(d.grabbed.entryId))) return [];
    const ownRows = rows.filter((rid) => ownRoom(d.grabbed.entryId, rid) != null);
    const moving = dateMovingRows(d, ownRows);
    const block = dateBlock(d, rows, moving, (id) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?");
    if (block.why) return [];
    moves = moving.map((rid) => ({ entryId: d.grabbed.entryId, from: rid, to: block.map.get(rid) ?? rid, swapped: false }));
  } else {
    if (!d.over) return [];
    const plan = planDrop(d.items, d.grabbed, d.over, rows, ownRoom);
    if (!plan.ok) return [];
    moves = plan.legs.map((l) => ({ entryId: l.entryId, from: l.fromRoomId, to: l.toRoomId, swapped: false }));
    // Whoever holds a room being taken over those nights is swapped into the room left behind —
    // the same rule the server applies when it adds the swap legs.
    const moving = new Set(moves.map((m) => `${m.entryId}|${m.from}`));
    const partners: Move[] = [];
    for (const m of moves) {
      const own = (barsByRoom.get(m.from) ?? []).filter((b) => b.entryId === m.entryId && MOVABLE.has(b.kind));
      for (const other of barsByRoom.get(m.to) ?? []) {
        if (other.entryId === m.entryId || !MOVABLE.has(other.kind) || moving.has(`${other.entryId}|${m.to}`)) continue;
        if (!own.some((b) => b.from < other.to && other.from < b.to)) continue;
        if (partners.some((p) => p.entryId === other.entryId && p.from === m.to)) continue;
        partners.push({ entryId: other.entryId, from: m.to, to: m.from, swapped: true });
      }
    }
    moves = [...moves, ...partners];
  }

  const nightRect = new Map(
    Array.from(wrap.querySelectorAll<HTMLElement>("thead th[data-night]")).map((th) => [th.dataset.night ?? "", th.getBoundingClientRect()]),
  );
  const box = wrap.getBoundingClientRect();
  const clipL = Math.max(box.left, wrap.querySelector("thead th.rc")?.getBoundingClientRect().right ?? box.left);
  const clipR = box.left + wrap.clientLeft + wrap.clientWidth;
  const clipT = Math.max(box.top, wrap.querySelector("thead")?.getBoundingClientRect().bottom ?? box.top);
  const clipB = Math.min(box.top + wrap.clientTop + wrap.clientHeight, window.innerHeight);
  const lastNight = chart.nights[chart.nights.length - 1];
  const roomNo = (id: string) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?";

  const out: LandBox[] = [];
  for (const m of moves) {
    const row = wrap.querySelector<HTMLElement>(`tr[data-room-id="${m.to}"]`);
    if (!row) continue;
    const rr = row.getBoundingClientRect();
    const booking = bookingOf.get(m.entryId);
    const ci = booking?.checkInDate?.slice(0, 10) ?? null;
    const co = booking?.checkOutDate?.slice(0, 10) ?? null;
    for (const b of (barsByRoom.get(m.from) ?? []).filter((x) => x.entryId === m.entryId && MOVABLE.has(x.kind))) {
      // A bar stops at the chart's edges; the stay itself runs on past them.
      const realFrom = b.from === chart.from && ci && ci < chart.from ? ci : b.from;
      const realTo = b.to === chart.to && co && co > chart.to ? co : b.to;
      const nf = shiftDay(realFrom, shift);
      const nt = shiftDay(realTo, shift);
      const first = nf < chart.from ? chart.from : nf;
      const lastIn = shiftDay(nt, -1);
      const last = lastIn > lastNight ? lastNight : lastIn;
      if (first > last) continue;
      const a = nightRect.get(first);
      const z = nightRect.get(last);
      if (!a || !z) continue;
      let left = a.left + 2;
      let right = z.right - 2;
      let cutL = nf < chart.from;
      let cutR = nt > chart.to;
      if (left < clipL) {
        left = clipL;
        cutL = true;
      }
      if (right > clipR) {
        right = clipR;
        cutR = true;
      }
      const top = Math.max(rr.top + 3, clipT);
      const bottom = Math.min(rr.bottom - 3, clipB);
      if (right - left < 6 || bottom - top < 6) continue;
      const roomChanged = m.to !== m.from;
      const note = m.swapped
        ? `swapped into Room ${roomNo(m.to)}`
        : shift !== 0
          ? `${fmtRange(nf, nt)}${roomChanged ? ` · Room ${roomNo(m.to)}` : ""}`
          : `Room ${roomNo(m.to)}`;
      out.push({
        key: `${m.entryId}|${m.from}|${b.from}`,
        left,
        top,
        width: right - left,
        height: bottom - top,
        name: booking ? rowNameOf(booking) : "Booking",
        note,
        cutL,
        cutR,
        swapped: m.swapped,
      });
    }
  }
  return out;
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

function segmentsFor(room: ChartRoom, chart: RoomChart, bars: RoomChartBar[], picks: RoomChartPick[] = []): Seg[] {
  const { nights } = chart;
  const on = nights.map((night) => bars.filter((b) => b.from <= night && night < b.to));
  const pickedOn = nights.map((night) => uniquePicks(picks.filter((p) => p.from <= night && night < p.to)));
  const pickKey = (i: number) => pickedOn[i].map((p) => p.entryId).sort().join("|");
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
    if (pickedOn[i].length) {
      let j = i;
      while (j + 1 < nights.length && on[j + 1].length === 0 && !room.outOfOrder?.nights[j + 1] && pickKey(j + 1) === pickKey(i)) j++;
      out.push({ t: "picks", span: j - i + 1, index: i, from: nights[i], to: shiftDay(nights[j], 1), picks: pickedOn[i] });
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
  // The window — its first night and its length — lives in the address (2026-10-24, operator: "when
  // I go back it doesn't hold the last state of the screen on the charts"), so Back, a reload and the
  // Room cards · Chart tabs all come back to the same nights. No `from` means today.
  const params = useSearchParams();
  const pathname = usePathname();
  const askedFrom = params.get("from");
  const from = askedFrom && isYmd(askedFrom) ? askedFrom : undefined;
  const askedNights = Number(params.get("nights"));
  const nightsAsked = Number.isInteger(askedNights) && askedNights >= 1 && askedNights <= MAX_NIGHTS ? askedNights : DEFAULT_NIGHTS;
  const setWindow = (patch: { from?: string | null; nights?: number }) => {
    const next = new URLSearchParams(window.location.search);
    if (patch.from !== undefined) {
      if (patch.from) next.set("from", patch.from);
      else next.delete("from");
    }
    if (patch.nights !== undefined) {
      if (patch.nights === DEFAULT_NIGHTS) next.delete("nights");
      else next.set("nights", String(patch.nights));
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const setFrom = (v: string | undefined) => setWindow({ from: v ?? null });
  const setNightsAsked = (n: number) => setWindow({ nights: n });
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
  const [pickList, setPickList] = useState<PickList | null>(null);
  const pickListRef = useRef<HTMLDivElement | null>(null);
  const [clash, setClash] = useState<ClashList | null>(null);
  const clashRef = useRef<HTMLDivElement | null>(null);
  // Rooms chosen and not held, drawn faintly (2026-10-16) — shown unless this desk has hidden them.
  const [showPicks, setShowPicks] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("desk:chart-picks") === "hidden") setShowPicks(false);
    } catch {
      /* storage unavailable — keep them shown */
    }
  }, []);
  const toggleShowPicks = () =>
    setShowPicks((v) => {
      try {
        window.localStorage.setItem("desk:chart-picks", v ? "hidden" : "shown");
      } catch {
        /* storage unavailable — the choice lasts this visit */
      }
      return !v;
    });
  // Guest colours, remembered on this computer like the picks (2026-10-23).
  const [byGuest, setByGuest] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem("desk:chart-colours") === "guest") setByGuest(true);
    } catch {
      /* storage unavailable — colour by state */
    }
  }, []);
  const toggleByGuest = () =>
    setByGuest((v) => {
      try {
        window.localStorage.setItem("desk:chart-colours", v ? "state" : "guest");
      } catch {
        /* storage unavailable — the choice lasts this visit */
      }
      return !v;
    });
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
  /** A room the system chose, given another room of its type on the same nights — no room move. */
  const [quietPick, setQuietPick] = useState<QuietPick | null>(null);
  /** A bar dragged sideways: the booking's stay moving to other dates (2026-10-13). */
  const [dateMove, setDateMove] = useState<(DateMoveInput & { label: string }) | null>(null);
  /** Some of a booking's rooms dragged to other dates — a booking of their own (2026-10-14). */
  const [splitMove, setSplitMove] = useState<SplitMove | null>(null);
  /** Nights picked with Alt-click, and a night move under way (2026-10-14). */
  const [nightPick, setNightPick] = useState<NightSel | null>(null);
  // A booking's rooms in one box (2026-10-16): a single click opens it, a double click the booking.
  const [box, setBox] = useState<string | null>(null);
  const clickTimer = useRef<number | null>(null);
  /** One click waits a moment for a second: one opens `single`, two open the booking. */
  const oneOrTwo = (e: React.MouseEvent, entryId: string, single: () => void) => {
    if (clickTimer.current) window.clearTimeout(clickTimer.current);
    clickTimer.current = null;
    if (e.detail >= 2) {
      router.push(`/bookings/${entryId}`);
      return;
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      single();
    }, 260);
  };
  /** Where an Alt+Shift range starts: the room and night last Alt-clicked. */
  const nightAnchor = useRef<{ roomId: string; night: string } | null>(null);
  const [nightMove, setNightMove] = useState<NightMove | null>(null);
  const stopSwitching = () => {
    setSwitching(false);
    setSelected([]);
    anchor.current = null;
  };
  const picking = selected.length > 0;

  // Escape leaves Switch rooms and drops the picks (the dialog, when open, takes Escape for itself).
  useEffect(() => {
    if (!(switching || picking || nightPick) || moveLegs || nightMove) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      stopSwitching();
      setNightPick(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [switching, picking, nightPick, moveLegs, nightMove]);
  // Alt picks and drags a night here; on its own it would move the browser's focus to its menu.
  useEffect(() => {
    const onAlt = (e: KeyboardEvent) => {
      if (e.key === "Alt") e.preventDefault();
    };
    window.addEventListener("keydown", onAlt);
    window.addEventListener("keyup", onAlt);
    return () => {
      window.removeEventListener("keydown", onAlt);
      window.removeEventListener("keyup", onAlt);
    };
  }, []);

  const bookingOf = useMemo(() => new Map((chart?.bookings ?? []).map((b) => [b.entryId, b])), [chart]);
  const typeOf = useMemo(() => new Map((chart?.roomTypes ?? []).map((t) => [t.id, t])), [chart]);
  const barsByRoom = useMemo(() => {
    const m = new Map<string, RoomChartBar[]>();
    for (const b of chart?.bars ?? []) m.set(b.roomId, [...(m.get(b.roomId) ?? []), b]);
    return m;
  }, [chart]);
  const picksByRoom = useMemo(() => {
    const m = new Map<string, RoomChartPick[]>();
    for (const p of chart?.picks ?? []) m.set(p.roomId, [...(m.get(p.roomId) ?? []), p]);
    return m;
  }, [chart]);
  /** The rooms in the order the chart draws them, top to bottom — what "keep their spacing" counts. */
  const rows = useMemo(() => {
    const have = new Set((chart?.rooms ?? []).map((r) => r.id));
    return (chart?.roomTypes ?? []).flatMap((t) => t.roomIds).filter((id) => have.has(id));
  }, [chart]);
  /**
   * Each booking's colour when the chart is coloured by guest — every booking in view its own
   * shade, none repeated. Bookings that touch (the same room on nights that meet or overlap, or the
   * next row on a shared night) take the free shades that look furthest from each other.
   */
  const guestColour = useMemo(() => {
    const out = new Map<string, GuestColour>();
    if (!byGuest || !chart) return out;
    const rowIx = new Map(rows.map((id, i) => [id, i]));
    const spans = chart.bars
      .filter((b) => GUEST_KINDS.has(b.kind) && rowIx.has(b.roomId))
      .map((b) => ({ e: b.entryId, r: rowIx.get(b.roomId)!, from: b.from, to: b.to }));
    const near = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      near.set(a, (near.get(a) ?? new Set<string>()).add(b));
      near.set(b, (near.get(b) ?? new Set<string>()).add(a));
    };
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i];
        const b = spans[j];
        if (a.e === b.e) continue;
        const apart = Math.abs(a.r - b.r);
        if ((apart === 0 && a.from <= b.to && b.from <= a.to) || (apart === 1 && a.from < b.to && b.from < a.to)) link(a.e, b.e);
      }
    const first = new Map<string, { r: number; from: string }>();
    for (const x of spans) {
      const f = first.get(x.e);
      if (!f || x.r < f.r || (x.r === f.r && x.from < f.from)) first.set(x.e, { r: x.r, from: x.from });
    }
    const order = [...first.keys()].sort((a, b) => first.get(a)!.r - first.get(b)!.r || first.get(a)!.from.localeCompare(first.get(b)!.from));
    const shades = order.map((_, i) => guestShade(i));
    const free = new Set(shades.map((_, i) => i));
    for (const e of order) {
      const beside = [...(near.get(e) ?? [])].map((n) => out.get(n)).filter((c): c is GuestColour => !!c);
      let pick = -1;
      let best = -1;
      for (const i of free) {
        // With nothing coloured beside it, the next shade in turn; otherwise the one furthest away.
        const score = beside.length ? Math.min(...beside.map((c) => shadeDistance(c, shades[i]))) : -i;
        if (pick < 0 || score > best) {
          pick = i;
          best = score;
        }
      }
      free.delete(pick);
      out.set(e, shades[pick]);
    }
    return out;
  }, [byGuest, chart, rows]);

  // The list of picks closes the way the start box does.
  useEffect(() => {
    if (!pickList) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPickList(null);
    const onDown = (e: MouseEvent) => {
      if (pickListRef.current && !pickListRef.current.contains(e.target as Node)) setPickList(null);
    };
    const onScroll = () => setPickList(null);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pickList]);
  // …and so does the list of two bookings on one night.
  useEffect(() => {
    if (!clash) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setClash(null);
    const onDown = (e: MouseEvent) => {
      if (clashRef.current && !clashRef.current.contains(e.target as Node)) setClash(null);
    };
    const onScroll = () => setClash(null);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [clash]);
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
      if (e.key === "Escape" && !pickRef.current && !switching && !picking && !nightPick && !moveLegs && !dateMove && !splitMove && !nightMove) setFull(false);
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
  }, [full, switching, picking, nightPick, moveLegs, dateMove, splitMove, nightMove]);
  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  // The grey copies of the dragged bars, re-measured whenever the drag changes — and the drag
  // changes on every move and every scroll under the pointer.
  const [lands, setLands] = useState<LandBox[]>([]);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!drag || !chart || !wrap) {
      setLands((l) => (l.length ? [] : l));
      return;
    }
    setLands(landingBoxes(drag, { wrap, chart, bookingOf, barsByRoom, rows }));
  }, [drag, chart, bookingOf, barsByRoom, rows]);

  // Where the desk was — the chart's own scroll, the page's, and full screen — kept for this browser
  // tab (2026-10-24), so a booking opened from the chart and left with Back comes back to the same
  // rooms and nights. It belongs to its window: other nights start at the top.
  const placeKey = `${from ?? "today"}|${nightsAsked}`;
  const place = useRef({ left: 0, top: 0, pageY: 0 });
  const placeKeyRef = useRef(placeKey);
  placeKeyRef.current = placeKey;
  const fullRef = useRef(full);
  fullRef.current = full;
  /** The place read back on arrival: undefined until read, null once applied or when there is none. */
  const restoring = useRef<ChartPlace | null | undefined>(undefined);
  const saveTimer = useRef<number | null>(null);
  const savePlace = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (restoring.current) return; // not yet back where it was — keep what was saved
    try {
      const v: ChartPlace = { key: placeKeyRef.current, full: fullRef.current, ...place.current };
      window.sessionStorage.setItem(PLACE_KEY, JSON.stringify(v));
    } catch {
      /* storage unavailable — the chart starts at the top next time */
    }
  };
  const notePlace = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(savePlace, 150);
  };
  const readPlaceOnce = () => {
    if (restoring.current === undefined) restoring.current = readPlace(placeKeyRef.current);
    return restoring.current;
  };
  // The place is put back the moment the chart's box is drawn — inline, or in the full-screen layer,
  // which draws a beat later at the desk's root. Stable, so a re-render never re-applies it.
  const attachWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el;
    if (!el) return;
    const want = readPlaceOnce();
    if (want) {
      if (want.full !== fullRef.current) return; // full screen is switched on below; its box comes back here
      el.scrollLeft = want.left;
      el.scrollTop = want.top;
      if (!fullRef.current) window.scrollTo(0, want.pageY);
      place.current = { left: want.left, top: want.top, pageY: want.pageY };
      restoring.current = null;
      return;
    }
    // A box drawn afresh — full screen switched on or off — keeps the place it had.
    el.scrollLeft = place.current.left;
    el.scrollTop = place.current.top;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, []);
  useLayoutEffect(() => {
    if (readPlaceOnce()?.full && !full) setFull(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);
  useEffect(() => {
    notePlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new window or full screen is a new place
  }, [placeKey, full]);
  useEffect(() => {
    const onScroll = () => {
      if (fullRef.current) return;
      place.current.pageY = window.scrollY;
      notePlace();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (saveTimer.current) savePlace();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once; reads refs
  }, []);

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
    // A night only picked is still free — nobody holds it.
    const freeIdx = new Set<number>();
    for (const s of segs) {
      if (s.t === "free") freeIdx.add(s.index);
      else if (s.t === "picks") for (let x = 0; x < s.span; x++) freeIdx.add(s.index + x);
    }
    let run = 0;
    while (freeIdx.has(index + run)) run++;
    const reachesEnd = index + run >= chart.nights.length;
    leave();
    setPickNights(1);
    setPick({ room, night, freeRun: run, reachesEnd, rect });
  };
  const pickMax = pick ? (pick.reachesEnd ? Math.max(pick.freeRun, START_MAX_NIGHTS) : pick.freeRun) : 1;
  const roomNoOf = (id: string) => chart.rooms.find((r) => r.id === id)?.roomNumber ?? "?";
  /**
   * Where a drop goes (2026-10-28, docs/room-types-until-arrival.md). One room the system chose,
   * moved onto another room of its type on the same nights with nobody in the way, is the desk
   * choosing which room of the type the guest gets: it is given and fixed, with no new pass. Every
   * other drop is the room move as before.
   */
  const openMove = (legs: RoomMoveLegInput[]) => {
    // Rooms the system chose, onto other rooms of their type on the same nights: the desk is
    // choosing which rooms the guest gets, not moving a booking — one room or several. A room in
    // the way held only as another booking's system choice is moved by the system; anything held
    // for certain (or other dates, another type) is the room move.
    const quiet = (() => {
      if (legs.length === 0 || legs.some((l) => l.newCheckInDate)) return null;
      const entryId = legs[0].entryId;
      if (legs.some((l) => l.entryId !== entryId)) return null;
      const froms = new Set(legs.map((l) => l.fromRoomId));
      const picks: QuietPick["picks"] = [];
      const inWay: QuietPick["inWay"] = [];
      for (const l of legs) {
        const own = (barsByRoom.get(l.fromRoomId) ?? []).filter((b) => b.entryId === entryId);
        const fromRoom = chart.rooms.find((r) => r.id === l.fromRoomId);
        const toRoom = chart.rooms.find((r) => r.id === l.toRoomId);
        if (!own.length || !own.every((b) => b.quiet) || !fromRoom || !toRoom || fromRoom.roomTypeId !== toRoom.roomTypeId) return null;
        const first = own.reduce((m, b) => (b.from < m ? b.from : m), "9999-12-31");
        const last = own.reduce((m, b) => (b.to > m ? b.to : m), "0000-01-01");
        const there = (barsByRoom.get(l.toRoomId) ?? []).filter((b) => b.from < last && first < b.to);
        for (const b of there) {
          if (b.entryId === entryId) {
            if (!froms.has(l.toRoomId)) return null;
            continue;
          }
          if (!b.quiet) return null;
          const guest = nameOf(bookingOf.get(b.entryId));
          if (!inWay.some((w) => w.guest === guest && w.roomNumber === toRoom.roomNumber)) inWay.push({ guest, roomNumber: toRoom.roomNumber });
        }
        picks.push({ fromRoomId: l.fromRoomId, fromRoomNumber: fromRoom.roomNumber, toRoomId: l.toRoomId, toRoomNumber: toRoom.roomNumber });
      }
      return { entryId, guest: nameOf(bookingOf.get(entryId)), picks, inWay };
    })();
    if (quiet) {
      setQuietPick(quiet);
      return;
    }
    setMoveLegs(legs);
  };
  const ownRoom = ownRoomOf(barsByRoom, roomNoOf);
  /** The rows a booking holds on the chart, top to bottom. */
  const ownRowsOf = (entryId: string) => rows.filter((rid) => ownRoom(entryId, rid) != null);
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
    const plan = planDrop(items, items[0], roomId, rows, ownRoom);
    if (!plan.ok) {
      if (plan.why) toast.error(plan.why);
      return;
    }
    openMove(plan.legs);
  };
  /** The night whose column is under the pointer, read off the header. */
  const nightAtX = (x: number): string | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    for (const th of Array.from(wrap.querySelectorAll<HTMLElement>("thead th[data-night]"))) {
      const r = th.getBoundingClientRect();
      if (x >= r.left && x < r.right) return th.dataset.night ?? null;
    }
    return null;
  };
  /** The nights this booking holds in this room on the chart. */
  const heldNights = (sel: Sel): Set<string> => {
    const out = new Set<string>();
    for (const b of barsByRoom.get(sel.roomId) ?? []) {
      if (b.entryId !== sel.entryId || !MOVABLE.has(b.kind)) continue;
      for (let d = b.from; d < b.to; d = shiftDay(d, 1)) out.add(d);
    }
    return out;
  };
  /**
   * Trading stays (2026-10-19, operator: two bookings on different dates "should have swapped both
   * date and room"). A one-room booking landing on another booking's stay — dragged sideways onto
   * it, or picked in Switch rooms and the other booking clicked — trades places with it: each takes
   * the other's room and first night. Here: the one booking in the way, when there is exactly one.
   */
  const bookingInWay = (grabbed: Sel, toRoomId: string, shift: number): { entryId: string; name: string; firstNight: string } | null => {
    const mine = [...heldNights(grabbed)];
    if (mine.length === 0) return null;
    const landing = new Set(mine.map((n) => shiftDay(n, shift)));
    const found = new Map<string, string>();
    for (const b of barsByRoom.get(toRoomId) ?? []) {
      if (b.entryId === grabbed.entryId || !MOVABLE.has(b.kind)) continue;
      let hit = false;
      for (let d = b.from; d < b.to && !hit; d = shiftDay(d, 1)) hit = landing.has(d);
      if (!hit) continue;
      const first = bookingOf.get(b.entryId)?.checkInDate ?? b.from;
      const cur = found.get(b.entryId);
      if (!cur || first < cur) found.set(b.entryId, first);
    }
    if (found.size !== 1) return null;
    const [entryId, firstNight] = [...found][0];
    return { entryId, name: nameOf(bookingOf.get(entryId)), firstNight };
  };
  /** The trade's own leg; the server adds the other booking's leg into the room and dates left. */
  const tradeLeg = (grabbed: Sel, toRoomId: string, firstNight: string): RoomMoveLegInput => ({
    entryId: grabbed.entryId,
    fromRoomId: grabbed.roomId,
    toRoomId,
    newCheckInDate: firstNight,
  });
  /**
   * Switch rooms, a free night clicked (2026-10-19): inside the picked stay's own nights it is the
   * room move it always was; on other dates the booking moves there, room and dates — the date
   * window asks the server. Before, the date clicked was quietly dropped and only the room changed.
   */
  const moveSelectionToNight = (roomId: string, night: string | null) => {
    const one = selected.length === 1 ? selected[0] : null;
    if (one && night && !heldNights(one).has(night) && bookingOf.get(one.entryId)?.checkInDate) {
      setDateMove({
        entryId: one.entryId,
        fromRoomId: one.roomId,
        roomMap: roomId !== one.roomId ? { [one.roomId]: roomId } : {},
        newCheckInDate: night,
        label: one.name,
      });
      return;
    }
    moveSelectionTo(roomId);
  };
  /**
   * Alt-click picks a night of a bar (2026-10-14): another night of the same bar is added — next to
   * the ones picked or not (2026-10-22, operator: "305 on the 25th and then 305 on the 27th") —
   * Alt+Shift-click takes the nights in between, a picked night clicked again leaves the pick, and a
   * night of another bar starts a new pick. Alt+Ctrl-click (2026-10-15) adds a night of another of
   * the same booking's rooms — each room keeps its own nights, and they move together.
   */
  const pickNight = (sel: Sel, night: string, range: boolean, add: boolean) => {
    const own = heldNights(sel);
    if (!own.has(night)) return;
    const save = (rooms: NightRoom[]) => setNightPick(rooms.length ? { entryId: sel.entryId, name: sel.name, rooms } : null);
    const mine: NightRoom = { roomId: sel.roomId, roomNumber: sel.roomNumber, nights: [night] };
    if (!nightPick || nightPick.entryId !== sel.entryId) {
      if (add && nightPick) toast("Alt+Ctrl adds nights of the same booking's rooms — a night of another booking starts a new pick");
      nightAnchor.current = { roomId: sel.roomId, night };
      save([mine]);
      return;
    }
    const at = nightPick.rooms.findIndex((r) => r.roomId === sel.roomId);
    if (at < 0) {
      nightAnchor.current = { roomId: sel.roomId, night };
      if (!add) {
        save([mine]);
        return;
      }
      if (nightPick.rooms.length >= MAX_PICK) {
        toast.error(`Pick at most ${MAX_PICK} rooms' nights at a time`);
        return;
      }
      save([...nightPick.rooms, mine]);
      return;
    }
    // A room already picked: its own run changes, the other rooms stay picked.
    const put = (nights: string[]) => save(nightPick.rooms.map((r, i) => (i === at ? { ...r, nights } : r)).filter((r) => r.nights.length > 0));
    const cur = nightPick.rooms[at].nights;
    const from = nightAnchor.current?.roomId === sel.roomId ? nightAnchor.current.night : null;
    if (range && from) {
      const [lo, hi] = from < night ? [from, night] : [night, from];
      const list: string[] = [];
      for (let d = lo; d <= hi; d = shiftDay(d, 1)) if (own.has(d)) list.push(d);
      put(list);
      return;
    }
    if (cur.includes(night)) {
      // Clicked again: that night leaves the pick.
      put(cur.filter((d) => d !== night));
      return;
    }
    nightAnchor.current = { roomId: sel.roomId, night };
    put([...cur, night].sort());
  };
  const clickBar = (e: React.MouseEvent, sel: Sel, movable: boolean) => {
    if (dragEnded.current) return;
    leave();
    if (e.altKey) {
      e.preventDefault();
      if (!movable) {
        toast.error("A stay that has ended cannot be moved");
        return;
      }
      const night = nightAtX(e.clientX);
      if (night) pickNight(sel, night, e.shiftKey, e.ctrlKey || e.metaKey);
      return;
    }
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
      oneOrTwo(e, sel.entryId, () => setBox(sel.entryId));
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
    // A booking on other dates (2026-10-19): the two trade places — room AND dates. Before, the
    // pick quietly took the room on its own dates and nothing was swapped.
    if (bookingInWay(selected[0], sel.roomId, 0)?.entryId !== sel.entryId) {
      if (selected.length > 1) {
        toast.error("Trading stays works one room at a time — pick one booking's room");
        return;
      }
      const first = bookingOf.get(sel.entryId)?.checkInDate ?? [...heldNights(sel)].sort()[0];
      if (first) {
        setMoveLegs([tradeLeg(selected[0], sel.roomId, first)]);
        return;
      }
    }
    moveSelectionTo(sel.roomId);
  };
  /**
   * A press on a bar becomes a drag once the pointer moves; the picked rooms move with it when the
   * grabbed bar is one of them, else the grabbed bar alone. Escape drops it where it was.
   */
  const beginPress = (e: React.PointerEvent, sel: Sel, bar?: { from: string; to: string }) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    // Ctrl and Shift clicks pick rooms; with Alt they pick nights, and an Alt press may still drag —
    // a press that never moves stays the click it was.
    if (!e.altKey && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const startScrollLeft = wrap.scrollLeft;
    // Alt (2026-10-14): only the night under the pointer moves — or the runs picked, when it is one
    // of them (every room picked with Alt+Ctrl moves with it, 2026-10-15).
    // A picked night drags the picks with or without Alt (2026-10-15, operator: "I selected 206 21st
    // and 305 23rd and moved it, but it moved only one room").
    let nightRooms: NightRoom[] | undefined;
    const pressNight = nightAtX(e.clientX);
    const mine = pressNight && nightPick && nightPick.entryId === sel.entryId ? nightPick.rooms.find((r) => r.roomId === sel.roomId) : undefined;
    if (mine && pressNight && mine.nights.includes(pressNight)) {
      nightRooms = [mine, ...nightPick!.rooms.filter((r) => r.roomId !== sel.roomId)];
    } else if (e.altKey) {
      if (!pressNight) return;
      nightRooms = [{ roomId: sel.roomId, roomNumber: sel.roomNumber, nights: [pressNight] }];
    }
    // A bar that holds the room for only part of the stay (2026-10-16, operator: "305 on the 23rd
    // was in 206 on the 23rd, but I can't move it back to 206 for any of the dates"): a plain drag
    // of it to other dates, or onto another of the booking's own rooms, moves the bar's own nights —
    // the room does not hold the rest of the stay, so moving "the room" would move nights it never
    // had. Dropped on another booking's room on the same dates it stays the room move (a swap).
    let barNights: NightRoom | null = null;
    if (!nightRooms && bar && !selKeys.has(selKey(sel))) {
      const b = bookingOf.get(sel.entryId);
      const ci = b?.checkInDate?.slice(0, 10) ?? null;
      const co = b?.checkOutDate?.slice(0, 10) ?? null;
      const from = bar.from === chart?.from && ci && ci < bar.from ? ci : bar.from;
      const to = bar.to === chart?.to && co && co > bar.to ? co : bar.to;
      if (ci && co && (from > ci || to < co)) {
        const nights: string[] = [];
        for (let d = from; d < to; d = shiftDay(d, 1)) nights.push(d);
        barNights = { roomId: sel.roomId, roomNumber: sel.roomNumber, nights };
      }
    }
    const pickedItems = selKeys.has(selKey(sel)) ? byRow(selected) : [sel];
    const scroller = scrollerOf(wrap);
    // One night's width, off the header. The dates move by the pointer's sideways travel in nights,
    // rounded — so a drag up or down that wobbles a little stays a room move, and the dates move
    // only once the pointer has gone half a night across (2026-10-13, operator: "sometimes the rooms
    // show, sometimes they don't").
    const nightW = wrap.querySelector<HTMLElement>("thead th[data-night]")?.getBoundingClientRect().width || 70;
    // The room under the pointer, by its height alone: over a room-type band, a border, or the
    // sticky header, the nearest room in sight stays the target instead of the target dropping out.
    const rowAt = (x: number, y: number): string | null => {
      const box = wrap.getBoundingClientRect();
      if (x < box.left - 40 || x > box.right + 40) return null;
      const top = Math.max(box.top, wrap.querySelector("thead")?.getBoundingClientRect().bottom ?? box.top);
      const bottom = Math.min(box.top + wrap.clientTop + wrap.clientHeight, window.innerHeight);
      const yy = Math.min(Math.max(y, top + 1), bottom - 1);
      let best: string | null = null;
      let bestGap = Infinity;
      for (const tr of Array.from(wrap.querySelectorAll<HTMLElement>("tbody tr[data-room-id]"))) {
        const r = tr.getBoundingClientRect();
        if (r.bottom <= top || r.top >= bottom) continue;
        if (yy >= r.top && yy < r.bottom) return tr.dataset.roomId ?? null;
        const gap = Math.min(Math.abs(yy - r.top), Math.abs(yy - r.bottom));
        if (gap < bestGap) {
          bestGap = gap;
          best = tr.dataset.roomId ?? null;
        }
      }
      return best;
    };
    let current: Drag | null = null;
    let last = { x: sx, y: sy };
    let edgeTimer: number | null = null;
    const update = () => {
      const shift = Math.round((last.x - sx + (wrap.scrollLeft - startScrollLeft)) / nightW);
      // The booking's own rows are home (2026-10-13, operator: "it says that error but works when I
      // move the cursor differently"): a sideways drag over any of them moves the dates and leaves
      // the rooms as they are, and a drag up or down over them moves nothing — the same as resting
      // on the row it started from. Only a row outside the booking changes the room.
      const raw = rowAt(last.x, last.y);
      const ontoOwn = !!raw && raw !== sel.roomId && ownRoom(sel.entryId, raw);
      const nr = nightRooms ?? (barNights && (shift !== 0 || ontoOwn) ? [barNights] : undefined);
      const items = nr ? [sel] : pickedItems;
      // Nights may go back into the booking's own rooms (2026-10-15) — only a whole-room drag is home there.
      const over = !nr && ontoOwn ? sel.roomId : raw;
      current = { items, grabbed: sel, over, x: last.x, y: last.y, shift, ...(nr ? { nightRooms: nr } : {}) };
      setDrag(current);
    };
    // Over the chart's own sticky header, or within 48px of its bottom, the chart keeps scrolling
    // while the pointer rests there — so a drop can reach any room, across room types.
    const edgeStep = (): number => {
      if (!scroller) return 0;
      const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : (scroller as Element).getBoundingClientRect();
      const head = wrap.querySelector("thead")?.getBoundingClientRect().bottom ?? box.top;
      if (last.y < Math.max(head, box.top + 48)) return -10;
      if (last.y > Math.min(box.bottom, window.innerHeight) - 48) return 10;
      return 0;
    };
    const onEdge = () => {
      const step = edgeStep();
      if (step && scroller) scroller.scrollBy(0, step);
    };
    // A scroll under a resting pointer changes the room under it — and the grey copies' places.
    const onScroll = () => {
      if (current) update();
    };
    const end = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      if (edgeTimer !== null) window.clearInterval(edgeTimer);
      document.body.classList.remove("rchart-dragging");
      const done = current;
      setDrag(null);
      if (!done) return;
      dragEnded.current = true;
      window.setTimeout(() => {
        dragEnded.current = false;
      }, 0);
      if (!drop || !done.over) return;
      if (done.nightRooms) {
        // An Alt-drag: those nights to other rooms, or to other dates — the dialog asks the server.
        const plan = planNightDrop(done, rows, roomNoOf, holdsOf(barsByRoom));
        if (plan.ok && plan.idle) return;
        const why = nightMoveWhy(done, bookingOf.get(done.grabbed.entryId)) ?? (plan.ok ? null : plan.why);
        if (why || !plan.ok) {
          if (why) toast.error(why);
          return;
        }
        const first = [...plan.picks[0].nights].sort()[0];
        setNightMove({
          entryId: done.grabbed.entryId,
          label: done.grabbed.name,
          newFirstNight: ymdShift(first, done.shift),
          picks: plan.picks.map((p) => ({
            fromRoomId: p.roomId,
            nights: [...p.nights].sort(),
            toRoomId: p.to,
            roomNumber: p.roomNumber,
            toRoomNumber: roomNoOf(p.to),
          })),
        });
        return;
      }
      if (done.shift !== 0) {
        // Dropped on another booking's stay (2026-10-19): a one-room booking trades places with it —
        // room and dates.
        if (done.items.length === 1 && ownRowsOf(done.grabbed.entryId).length === 1) {
          const inWay = bookingInWay(done.grabbed, done.over, done.shift);
          if (inWay && !dateMoveWhy(done, bookingOf.get(done.grabbed.entryId))) {
            setMoveLegs([tradeLeg(done.grabbed, done.over, inWay.firstNight)]);
            return;
          }
        }
        // Dragged sideways: the whole stay moves to other dates (and the room grabbed may land in
        // another row on the way). The dialog asks the server what that would do.
        const booking = bookingOf.get(done.grabbed.entryId);
        const ownRows = ownRowsOf(done.grabbed.entryId);
        const moving = dateMovingRows(done, ownRows);
        const block = dateBlock(done, rows, moving, roomNoOf);
        const why = dateMoveWhy(done, booking) ?? block.why;
        if (why) {
          toast.error(why);
          return;
        }
        if (!booking?.checkInDate) return;
        // Some of the booking's rooms: they leave as a booking of their own — the dialog asks where.
        if (moving.length < ownRows.length) {
          setSplitMove({
            entryId: done.grabbed.entryId,
            fromRoomId: done.grabbed.roomId,
            roomMap: Object.fromEntries(moving.map((r) => [r, block.map.get(r) ?? r])),
            newCheckInDate: ymdShift(booking.checkInDate, done.shift),
            label: done.grabbed.name,
            roomWords: roomsWords(moving, roomNoOf),
          });
          return;
        }
        setDateMove({
          entryId: done.grabbed.entryId,
          fromRoomId: done.grabbed.roomId,
          roomMap: Object.fromEntries(block.map),
          newCheckInDate: ymdShift(booking.checkInDate, done.shift),
          label: done.grabbed.name,
        });
        return;
      }
      const plan = planDrop(done.items, done.grabbed, done.over, rows, ownRoom);
      if (!plan.ok) {
        if (plan.why) toast.error(plan.why);
        return;
      }
      openMove(plan.legs);
    };
    const onMove = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!current) {
        leave();
        setPick(null);
        document.body.classList.add("rchart-dragging");
        window.addEventListener("scroll", onScroll, true);
        edgeTimer = window.setInterval(onEdge, 30);
      }
      update();
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
  const dateDrag = drag && drag.shift !== 0 && !drag.nightRooms ? drag : null;
  /** An Alt-drag of nights (2026-10-14). */
  const nightDrag = drag?.nightRooms ? drag : null;
  const nightPlan = nightDrag ? planNightDrop(nightDrag, rows, roomNoOf, holdsOf(barsByRoom)) : null;
  const nightWhy = nightDrag ? nightMoveWhy(nightDrag, bookingOf.get(nightDrag.grabbed.entryId)) ?? (nightPlan && !nightPlan.ok ? nightPlan.why : null) : null;
  const nightIdle = !!nightPlan && nightPlan.ok && nightPlan.idle;
  const nightPicks = nightPlan?.ok ? nightPlan.picks : [];
  const nightTo = nightPicks[0]?.to ?? null;
  const nightNew = nightDrag ? [...new Set(nightPicks.flatMap((p) => p.nights.map((n) => shiftDay(n, nightDrag.shift))))].sort() : [];
  /** Several rooms' nights in the hand (2026-10-15). */
  const nightMany = (nightDrag?.nightRooms?.length ?? 0) > 1;
  const dateBooking = dateDrag ? bookingOf.get(dateDrag.grabbed.entryId) : undefined;
  const dateOwnRows = dateDrag ? ownRowsOf(dateDrag.grabbed.entryId) : [];
  const dateMovingNow = dateDrag ? dateMovingRows(dateDrag, dateOwnRows) : [];
  /** Some, not all, of the booking's rooms — they would leave as a booking of their own. */
  const dateSplitNow = !!dateDrag && dateMovingNow.length < dateOwnRows.length;
  const dateBlockNow = dateDrag ? dateBlock(dateDrag, rows, dateMovingNow, roomNoOf) : null;
  const dateWhy = dateDrag ? dateMoveWhy(dateDrag, dateBooking) ?? dateBlockNow?.why ?? null : null;
  /** The booking the drop would trade places with (2026-10-19) — rooms and dates. */
  const tradeNow =
    dateDrag && dateDrag.over && dateDrag.items.length === 1 && dateOwnRows.length === 1 && !dateMoveWhy(dateDrag, dateBooking)
      ? bookingInWay(dateDrag.grabbed, dateDrag.over, dateDrag.shift)
      : null;
  const dateSpan =
    dateDrag && dateBooking?.checkInDate && dateBooking.checkOutDate
      ? { from: ymdShift(dateBooking.checkInDate, dateDrag.shift), to: ymdShift(dateBooking.checkOutDate, dateDrag.shift) }
      : null;
  const dropPlan = drag?.over && !dateDrag && !nightDrag ? planDrop(drag.items, drag.grabbed, drag.over, rows, ownRoom) : null;
  const dropTo = new Set(
    nightDrag
      ? nightWhy || nightIdle || !nightTo
        ? []
        : nightPicks.map((p) => p.to)
      : dateDrag
      ? tradeNow
        ? [dateDrag.over!]
        : dateWhy
        ? []
        : dateBlockNow?.map.size
          ? [...dateBlockNow.map.values()]
          : [dateDrag.grabbed.roomId]
      : dropPlan?.ok
        ? dropPlan.to
        : [],
  );
  const dragged = new Set(drag && !drag.nightRooms ? drag.items.map(selKey) : []);
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
    <div className={`rchart${full ? " is-full" : ""}${drag ? " is-dragging" : ""}${byGuest ? " by-guest" : ""}`}>
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
            <DateInput
              className="input"
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
            <DateInput
              className="input"
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
          <Button kind="quiet" compact onClick={toggleShowPicks} aria-pressed={showPicks}>
            {showPicks ? "Hide picks" : "Show picks"}
          </Button>
          <Button kind="quiet" compact onClick={toggleByGuest} aria-pressed={byGuest}>
            {byGuest ? "Colour by state" : "Colour by guest"}
          </Button>
          <Button kind="quiet" compact onClick={() => setFull((f) => !f)} aria-pressed={full}>
            {full ? "Exit full screen" : "Full screen"}
          </Button>
          <Help label="About the house chart">
            <p>Every room, night by night: who holds it and how firmly. Rest the pointer on a booking for a second to see it. Click it once for a box with all its rooms night by night, where you tick what to move; double-click it to open the booking.</p>
            <p>Click a free night to start an inquiry for that room from that night. The room is chosen on the booking, where the house is asked.</p>
            <p>Click a room number to report a fault or review one. A room drawn free here is one the room search offers.</p>
            <p>A faint dashed bar is a pick: a booking at Inquiry, or at Negotiation without a provisional block, has chosen the room but holds nothing — the room is still free, and whoever reserves first takes it. Several picks on one night show as &ldquo;2 picks&rdquo;; a pick on a room someone holds shows as a &ldquo;+1 pick&rdquo; badge on that booking. Hide picks clears them from the chart on this computer.</p>
            <p>Colour by guest gives every booking in view its own colour — no two the same — so its rooms read as one and the bookings beside it look furthest apart — pale while reserved or held, deep once in house; a dashed edge is still held, a dotted edge a provisional block. Colour by state goes back to one colour per state. The colours are shared out among the bookings on screen, so moving to other dates can change them. The choice is kept on this computer.</p>
            <p>Move rooms: drag a booking onto another room. Ctrl-click (Cmd on a Mac) picks more rooms, Shift-click picks a booking&apos;s rooms in between; drag one of them and they all move, the one you hold landing where you drop it and the rest keeping their spacing.</p>
            <p>Move dates: drag a booking sideways — the room you hold moves earlier or later, keeping its nights (before check-in only). Pick its other rooms first (Ctrl or Shift) to take them along; all of them moves the whole booking. A room moved alone becomes a booking of its own — on the same enquiry, or a new enquiry. Drag it down or up at the same time to change the room too.</p>
            <p>Move one night: hold Alt and drag a night of a booking — only that night moves. Alt-click picks a night first, Alt-click the next one to add it, Alt+Shift-click to take the nights in between. Dropped on another room on the same dates, the booking changes room for those nights. Dropped on other dates, the stay is cut apart: a one-room booking keeps its earliest stay and every other stay becomes a booking of its own; on a booking with other rooms, the room leaves with its guests and each of its stays becomes a booking of its own — on the same enquiry, or a new one.</p>
            <p>A booking already in a room you drop on swaps into the room left behind. Switch rooms does the same by clicking: pick a booking, then click another booking or a free night.</p>
            <p>Each room walks every step its booking needs; you see what each will do before anything runs.</p>
          </Help>
        </div>
        {rangeNote ? (
          <p className="warn-ink sm" role="status" style={{ margin: 0, fontWeight: 600 }}>
            {rangeNote}
          </p>
        ) : null}
        {/* The nights picked float at the foot of the window — a strip in the toolbar would push the
            table down under the pointer, and the next Alt-drag would start on the wrong row. */}
        {nightPick && !drag && !nightMove ? (
          <Floating>
            <div className="rchart-nightbar" role="status">
              <b>
                {nightPickWords(nightPick.rooms)} · {nightPick.name}
              </b>
              <span>
                Hold Alt and drag {nightPick.rooms.length > 1 ? "them" : "it"} onto other rooms or to other dates · Alt-click the next night to add it · Alt+Ctrl-click
                another of its rooms · Esc clears
              </span>
              <button
                type="button"
                onClick={() => {
                  setNightPick(null);
                  nightAnchor.current = null;
                }}
              >
                Clear
              </button>
            </div>
          </Floating>
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
        <Legend byGuest={byGuest} />
      </div>

      <div
        className="rchart-wrap"
        ref={attachWrap}
        onScroll={(e) => {
          leave();
          place.current.left = e.currentTarget.scrollLeft;
          place.current.top = e.currentTarget.scrollTop;
          notePlace();
        }}
      >
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
                        nightDrag && !nightWhy && !nightIdle && nightNew.includes(d) ? "drop-night" : "",
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
                  const segs = segmentsFor(room, chart, barsByRoom.get(rid) ?? [], showPicks ? (picksByRoom.get(rid) ?? []) : []);
                  return (
                    <tr
                      key={rid}
                      data-room-id={rid}
                      className={[
                        "rrow",
                        ri === t.roomIds.length - 1 ? "last" : "",
                        dropTo.has(rid) ? "drop-to" : "",
                        drag?.over === rid && ((dropPlan && !dropPlan.ok && dropPlan.why) || dateWhy || nightWhy) ? "drop-bad" : "",
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
                        const segFirst = chart.nights[segs.slice(0, k).reduce((n, x) => n + (x.t === "bar" || x.t === "ooo" || x.t === "picks" ? x.span : 1), 0)];
                        if (s.t === "picks") {
                          const one = s.picks.length === 1 ? s.picks[0] : null;
                          const pb = one ? bookingOf.get(one.entryId) : undefined;
                          return (
                            <td key={k} colSpan={s.span} className={`seg k-pick${s.picks.every((p) => p.parked) ? " parked" : ""}`}>
                              <button
                                type="button"
                                className="bar"
                                aria-label={
                                  one
                                    ? `Room ${room.roomNumber}: picked by ${nameOf(pb)}, not held`
                                    : `Room ${room.roomNumber}: ${s.picks.length} bookings have picked it, none holds it`
                                }
                                onMouseEnter={(e) => point({ t: "picks", picks: s.picks, room, from: s.from, to: s.to, rect: rectOf(e) })}
                                onMouseLeave={leave}
                                onClick={(e) => {
                                  if (dragEnded.current) return;
                                  if (switching) {
                                    if (!picking) toast("Click the booking to move first");
                                    else moveSelectionToNight(room.id, nightAtX(e.clientX));
                                    return;
                                  }
                                  leave();
                                  const rect = rectOf(e);
                                  oneOrTwo(e, (one ?? s.picks[0]).entryId, () => setPickList({ room, picks: s.picks, rect }));
                                }}
                              >
                                {one ? (
                                  <>
                                    {one.parked ? <span className="pk">Parked</span> : null}
                                    {nameOf(pb)}
                                    <span className="st"> · picked, not held</span>
                                  </>
                                ) : (
                                  <>
                                    {s.picks.length} picks<span className="st"> · not held</span>
                                  </>
                                )}
                              </button>
                            </td>
                          );
                        }
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
                                  else moveSelectionToNight(room.id, s.night);
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
                            <td key={k} className="seg k-conflict">
                              <button
                                type="button"
                                className="bar"
                                aria-label={`${s.bars.length} bookings hold Room ${room.roomNumber} on ${longDay(s.night)} — click to open them`}
                                onMouseEnter={(e) => point({ t: "conflict", bars: s.bars, room, night: s.night, rect: rectOf(e) })}
                                onMouseLeave={leave}
                                onClick={(e) => {
                                  if (dragEnded.current) return;
                                  leave();
                                  setClash({ room, night: s.night, bars: s.bars, rect: rectOf(e) });
                                }}
                              >
                                {s.bars.length}×
                              </button>
                            </td>
                          );
                        const b = bookingOf.get(s.bar.entryId);
                        const gi = byGuest && GUEST_KINDS.has(s.bar.kind) ? guestColour.get(s.bar.entryId) : undefined;
                        const sel: Sel = { entryId: s.bar.entryId, roomId: room.id, roomNumber: room.roomNumber, name: nameOf(b) };
                        const movable = MOVABLE.has(s.bar.kind);
                        const contL = s.bar.from === chart.from && !!b?.checkInDate && b.checkInDate < chart.from;
                        const contR = s.bar.to === chart.to && !!b?.checkOutDate && b.checkOutDate > chart.to;
                        return (
                          <td
                            key={k}
                            colSpan={s.span}
                            style={gi ? guestStyle(gi) : undefined}
                            data-entry={s.bar.entryId}
                            className={`seg ${KIND_CLASS[s.bar.kind]}${gi ? " g" : ""}${s.bar.parked ? " parked" : ""}${s.bar.quiet ? " quiet" : ""}${s.bar.paymentPending ? " paypend" : ""}${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}${selKeys.has(selKey(sel)) ? " marked" : ""}${dragged.has(selKey(sel)) ? " dragging" : ""}`}
                          >
                            <button
                              type="button"
                              className={`bar${movable ? " grab" : ""}`}
                              aria-pressed={selKeys.has(selKey(sel)) || undefined}
                              onMouseEnter={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onMouseLeave={leave}
                              onFocus={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onBlur={leave}
                              onPointerDown={movable ? (e) => beginPress(e, sel, s.bar) : undefined}
                              // Shift, Ctrl and Alt clicks pick rooms and nights; they must not select text.
                              onMouseDown={(e) => (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) && e.preventDefault()}
                              onClick={(e) => clickBar(e, sel, movable)}
                            >
                              {s.bar.parked ? <span className="pk">Parked</span> : null}
                              {nameOf(b)}
                              {s.span > 1 && b ? <span className="st"> · {STEP_NAMES[stepNoOfStage(b.stage) - 1]}</span> : null}
                            </button>
                            {(() => {
                              // Other bookings that chose this room on these nights and hold nothing (2026-10-16).
                              if (!showPicks || !segFirst) return null;
                              const segTo = shiftDay(segFirst, s.span);
                              const also = uniquePicks((picksByRoom.get(room.id) ?? []).filter((p) => p.entryId !== s.bar.entryId && p.from < segTo && p.to > segFirst));
                              if (!also.length) return null;
                              return (
                                <button
                                  type="button"
                                  className="pickbadge"
                                  aria-label={`${plural(also.length, "booking")} also picked Room ${room.roomNumber} on these nights — none holds it`}
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    leave();
                                    setPickList({ room, picks: also, rect: rectOf(e) });
                                  }}
                                >
                                  +{also.length} {also.length === 1 ? "pick" : "picks"}
                                </button>
                              );
                            })()}
                            {(() => {
                              // The nights picked with Alt, or being dragged, marked on the bar itself.
                              const marked =
                                nightDrag && nightDrag.grabbed.entryId === sel.entryId
                                  ? (nightDrag.nightRooms!.find((r) => r.roomId === sel.roomId)?.nights ?? null)
                                  : nightPick && nightPick.entryId === sel.entryId
                                    ? (nightPick.rooms.find((r) => r.roomId === sel.roomId)?.nights ?? null)
                                    : null;
                              if (!marked || !segFirst) return null;
                              return marked
                                .map((n) => nightsBetween(segFirst, n))
                                .filter((i) => i >= 0 && i < s.span)
                                .map((i) => (
                                  <span
                                    key={i}
                                    className={`npick${nightDrag ? " moving" : ""}`}
                                    style={{ left: `calc(${(i / s.span) * 100}% + 2px)`, width: `calc(${100 / s.span}% - 4px)` }}
                                    aria-hidden
                                  />
                                ));
                            })()}
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

      <QuietRoomDialog
        pick={quietPick}
        onClose={() => {
          setQuietPick(null);
          stopSwitching();
        }}
        onDone={() => {
          setQuietPick(null);
          stopSwitching();
          void q.refetch();
        }}
      />

      <RoomMoveDialog
        legs={moveLegs}
        onClose={() => {
          setMoveLegs(null);
          stopSwitching();
        }}
      />

      {drag ? (
        <Floating>
          {lands.map((l) => (
            <div
              key={l.key}
              className={`rchart-land${l.cutL ? " cut-l" : ""}${l.cutR ? " cut-r" : ""}${l.swapped ? " swap" : ""}`}
              style={{ left: l.left, top: l.top, width: l.width, height: l.height }}
              aria-hidden
            >
              <b>{l.name}</b>
              <span>· {l.note}</span>
            </div>
          ))}
          <div className={`rchart-ghost${(dropPlan && !dropPlan.ok && dropPlan.why) || dateWhy || nightWhy ? " bad" : ""}`} style={{ left: drag.x + 16, top: drag.y + 16 }} role="status">
            {nightDrag ? (
              nightWhy ? (
                <span>{nightWhy}</span>
              ) : nightIdle || !nightTo ? (
                <>
                  <span>
                    {nightMany
                      ? `Nights of Rooms ${nightDrag.nightRooms!.map((r) => r.roomNumber).join(" + ")}`
                      : `${nightDrag.nightRooms![0].nights.length === 1 ? "A night" : `${nightDrag.nightRooms![0].nights.length} nights`} of Room ${nightDrag.grabbed.roomNumber}`}{" "}
                    · {nightDrag.grabbed.name}
                  </span>
                  <span className="sub">Drop {nightMany ? "them" : "it"} on another room, or on other dates</span>
                </>
              ) : nightDrag.shift === 0 ? (
                <>
                  <span>
                    {nightMany ? (
                      nightPicks.map((p) => `${p.roomNumber} → ${roomNoOf(p.to)}`).join(" · ")
                    ) : (
                      <>
                        Room {nightDrag.grabbed.roomNumber} → <b>{roomNoOf(nightTo)}</b>
                      </>
                    )}{" "}
                    · {runsWords(nightNew)}
                  </span>
                  <span className="sub">
                    Let go to see the room change for {nightMany ? "their nights" : nightNew.length === 1 ? "that night" : "those nights"}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    {nightMany ? `Rooms ${nightPicks.map((p) => p.roomNumber).join(" + ")}` : `Room ${nightDrag.grabbed.roomNumber}`}
                    {nightPicks.some((p) => p.to !== p.roomId) ? ` → ${nightPicks.map((p) => roomNoOf(p.to)).join(" + ")}` : ""} ·{" "}
                    <b>{runsWords(nightNew)}</b>
                  </span>
                  <span className="sub">
                    {Math.abs(nightDrag.shift)} {Math.abs(nightDrag.shift) === 1 ? "day" : "days"} {nightDrag.shift > 0 ? "later" : "earlier"} · the stay is cut apart, each part a booking of its own
                  </span>
                  <span className="sub">Let go to choose: new bookings on this enquiry, or a new enquiry</span>
                </>
              )
            ) : dateDrag ? (
              tradeNow ? (
                <>
                  <span>
                    {dateDrag.grabbed.name} ⇄ <b>{tradeNow.name}</b>
                  </span>
                  <span className="sub">They trade places — rooms and dates</span>
                  <span className="sub">Let go to see what trading would do</span>
                </>
              ) : dateWhy ? (
                <span>{dateWhy}</span>
              ) : (
                <>
                  <span>
                    {dateDrag.grabbed.name} · <b>{dateSpan ? fmtRange(dateSpan.from, dateSpan.to) : ""}</b>
                  </span>
                  <span className="sub">
                    {Math.abs(dateDrag.shift)} {Math.abs(dateDrag.shift) === 1 ? "day" : "days"} {dateDrag.shift > 0 ? "later" : "earlier"}
                    {dateBlockNow?.map.size ? ` · ${blockWords(dateBlockNow.map, roomNoOf)}` : ""}
                  </span>
                  {dateSplitNow ? (
                    <span className="sub">
                      <b>{roomsWords(dateMovingNow, roomNoOf)}</b> alone — {dateMovingNow.length === 1 ? "it leaves" : "they leave"} as a booking of {dateMovingNow.length === 1 ? "its" : "their"} own
                    </span>
                  ) : null}
                  <span className="sub">{dateSplitNow ? "Let go to choose: a new booking on this enquiry, or a new enquiry" : "Let go to see what moving the dates would do"}</span>
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
                <span className="sub">
                  {rows.filter((rid) => ownRoom(drag.grabbed.entryId, rid)).length > 1 ? "Drop it on a room outside this booking" : "Drop it on another room"}
                </span>
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
      <SplitMoveDialog
        move={splitMove}
        onClose={() => {
          setSplitMove(null);
          stopSwitching();
        }}
      />
      <NightMoveDialog
        move={nightMove}
        onClose={() => {
          setNightMove(null);
          setNightPick(null);
          nightAnchor.current = null;
        }}
      />

      {box && bookingOf.get(box) ? (
        <BookingBox
          booking={bookingOf.get(box)!}
          isMovable={(k) => MOVABLE.has(k)}
          roomOrder={rows}
          onClose={() => setBox(null)}
          onOpen={() => router.push(`/bookings/${box}`)}
          onMove={(m: BoxMove) => {
            const entryId = box;
            const name = nameOf(bookingOf.get(entryId));
            setBox(null);
            if (m.kind === "nights") setNightMove(m.move);
            else if (m.kind === "split") setSplitMove(m.move);
            else if (m.kind === "dates") setDateMove(m.move);
            else if (m.kind === "rooms") setMoveLegs(m.legs);
            else {
              // Marked on the chart for a drag — and the chart brought to their dates when they are not on it.
              const first = m.kind === "mark-nights" ? [...m.rooms.flatMap((r) => r.nights)].sort()[0] : bookingOf.get(entryId)?.checkInDate ?? null;
              if (first && !chart.nights.includes(first)) setFrom(shiftDay(first, -1));
              if (m.kind === "mark-nights") {
                setSelected([]);
                setNightPick({ entryId, name, rooms: m.rooms });
                nightAnchor.current = { roomId: m.rooms[0].roomId, night: m.rooms[0].nights[0] };
                toast("Marked on the chart — drag one of the marked nights to move them all");
              } else {
                setNightPick(null);
                const sels = m.rooms.map((r) => ({ entryId, roomId: r.roomId, roomNumber: r.roomNumber, name }));
                anchor.current = sels[0];
                setSelected(sels);
                toast(`Marked on the chart — drag ${sels.length === 1 ? "the room" : "one of the rooms"} to move ${sels.length === 1 ? "it" : "them all"}`);
              }
            }
          }}
        />
      ) : null}

      {hover && !box && !pick && !pickList && !clash && !moveLegs && !dateMove && !splitMove && !nightMove ? (
        <Floating>
          <HoverCard hover={hover} chart={chart} bookingOf={bookingOf} typeName={(id) => typeOf.get(id)?.name ?? ""} showPicks={showPicks} />
        </Floating>
      ) : null}

      {pickList ? (
        <Floating>
          <div className="rchart-pick e-k-pick" ref={pickListRef} style={placeBeside(pickList.rect, 320)} role="dialog" aria-label="Bookings that picked this room">
            <div className="hc-head k-pick">
              <span className="hc-kind">{pickList.picks.length === 1 ? "Picked · not held" : `${pickList.picks.length} picks · not held`}</span>
              <span className="hc-room">Room {pickList.room.roomNumber}</span>
            </div>
            <div className="hc-body">
              <div className="hc-sub">None of them holds the room — whoever reserves first takes it.</div>
              <div className="pl-list">
                {pickList.picks.map((p) => {
                  const b = bookingOf.get(p.entryId);
                  return (
                    <button key={p.entryId} type="button" className="pl-row" onClick={() => router.push(`/bookings/${p.entryId}`)}>
                      <b>{nameOf(b)}</b>
                      <span>
                        {p.entryId} · {b ? STEP_NAMES[stepNoOfStage(b.stage) - 1] : ""}
                        {p.parked ? " · parked" : ""}
                      </span>
                      <span>
                        {fmtRange(p.from, p.to)} in this room{b?.checkInDate ? ` · stay ${fmtRange(b.checkInDate, b.checkOutDate)}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="pick-acts">
                <Button kind="quiet" compact onClick={() => setPickList(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        </Floating>
      ) : null}

      {clash ? (
        <Floating>
          <div className="rchart-pick e-k-conflict" ref={clashRef} style={placeBeside(clash.rect, 340)} role="dialog" aria-label="Bookings that hold this room on one night">
            <div className="hc-head k-conflict">
              <span className="hc-kind">{clash.bars.length === 2 ? "Two bookings on one night" : `${clash.bars.length} bookings on one night`}</span>
              <span className="hc-room">Room {clash.room.roomNumber}</span>
            </div>
            <div className="hc-body">
              <div className="hc-sub">
                {longDay(clash.night)} · one of them has to move
              </div>
              <div className="pl-list">
                {clash.bars.map((x) => {
                  const b = bookingOf.get(x.entryId);
                  return (
                    <div key={x.entryId} className="pl-row static">
                      <b>{nameOf(b)}</b>
                      <span>
                        {KIND_WORD[x.kind]} · {x.entryId}
                        {b ? ` · ${STEP_NAMES[stepNoOfStage(b.stage) - 1]}` : ""}
                        {x.parked ? " · parked" : ""}
                      </span>
                      <span>
                        {fmtRange(x.from, x.to)} in this room{b?.checkInDate ? ` · stay ${fmtRange(b.checkInDate, b.checkOutDate)}` : ""}
                      </span>
                      <span className="pl-acts">
                        <Button kind="secondary" compact onClick={() => router.push(`/bookings/${x.entryId}`)}>
                          Open the booking
                        </Button>
                        {MOVABLE.has(x.kind) ? (
                          <Button
                            kind="quiet"
                            compact
                            onClick={() => {
                              setClash(null);
                              setBox(x.entryId);
                            }}
                          >
                            Its rooms
                          </Button>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="pick-acts">
                <Button kind="quiet" compact onClick={() => setClash(null)}>
                  Close
                </Button>
              </div>
            </div>
          </div>
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
  showPicks = true,
}: {
  hover: Hover;
  chart: RoomChart;
  bookingOf: Map<string, RoomChartBooking>;
  typeName: (roomTypeId: string) => string;
  showPicks?: boolean;
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
            {bar.quiet ? fact("Room", "not chosen yet — the system keeps a room of this type and may move it until Arrival") : null}
            {bar.moveId ? fact("Room move", bar.moveId) : null}
            {showPicks
              ? uniquePicks((chart.picks ?? []).filter((p) => p.roomId === room.id && p.entryId !== bar.entryId && p.from < bar.to && p.to > bar.from)).map((p) => {
                  const pb = bookingOf.get(p.entryId);
                  return fact("Also picked by", `${pb ? rowNameOf(pb) : "Booking"} · ${p.entryId} · ${fmtRange(p.from, p.to)}`);
                })
              : null}
          </div>
        </div>
        <div className="hc-foot">{bar.kind === "MOVING" ? "Being moved into this room — open the booking to see the move" : "Click for its rooms · double-click to open the booking"}</div>
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
        <div className="hc-foot">One of them has to move — click to open either booking</div>
      </div>
    );
  }
  if (hover.t === "picks") {
    const n = hover.picks.length;
    return (
      <div className="rchart-hc e-k-pick" style={style} role="tooltip">
        <div className={`hc-head k-pick${hover.picks.every((p) => p.parked) ? " parked" : ""}`}>
          <span className="hc-kind">{n === 1 ? "Picked · not held" : `${n} picks · not held`}</span>
        </div>
        <div className="hc-body">
          {n === 1 ? <div className="hc-name">{(() => { const b = bookingOf.get(hover.picks[0].entryId); return b ? rowNameOf(b) : "Booking"; })()}</div> : null}
          <div className="hc-sub">
            {roomLine(hover.room)} · {fmtRange(hover.from, hover.to)}
          </div>
          <div className="hc-facts">
            {hover.picks.map((p) => {
              const b = bookingOf.get(p.entryId);
              return fact(
                b ? STEP_NAMES[stepNoOfStage(b.stage) - 1] : "Booking",
                `${n > 1 && b ? `${rowNameOf(b)} · ` : ""}${p.entryId}${b?.checkInDate ? ` · stay ${fmtRange(b.checkInDate, b.checkOutDate)}` : ""}${p.parked ? " · parked" : ""}`,
              );
            })}
          </div>
        </div>
        <div className="hc-foot">Chosen, but nothing holds the room — whoever reserves first takes it. Click for {n === 1 ? "the booking" : "the list"} · double-click to open {n === 1 ? "it" : "the first"}</div>
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

function Legend({ byGuest }: { byGuest: boolean }) {
  // Coloured by guest, the held kinds show one sample colour with their edges (2026-10-23).
  const g = byGuest ? "g " : "";
  const items: Array<[string, string]> = [
    ["free", "Free"],
    [`${g}k-prov`, "Provisional block"],
    [`${g}k-held`, "Held · not confirmed"],
    ["k-move", "Moving in"],
    [`${g}k-res`, "Reserved"],
    [`${g}k-res paypend`, "Reserved · advance short"],
    [`${g}k-in`, "In house"],
    ["k-over", "Due out · still in"],
    ["k-out", "Checked out"],
    ["k-res parked", "Parked"],
    ["k-ooo", "Out of order"],
    ["k-conflict", "Two bookings"],
    ["k-pick", "Picked · not held"],
  ];
  return (
    <div className={`rslegend${byGuest ? " by-guest" : ""}`}>
      {byGuest ? <b className="rslegend-lead">Each booking its own colour ·</b> : null}
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

