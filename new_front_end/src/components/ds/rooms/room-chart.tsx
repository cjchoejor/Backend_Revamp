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
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, type ChartBarKind, type RoomChart, type RoomChartBar, type RoomChartBooking } from "@/lib/api/rooms";
import { fmtDateTime, fmtRange, plural } from "@/lib/ds/format";
import { rowNameOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";

const KIND_WORD: Record<ChartBarKind, string> = {
  OVERSTAY: "Due out · still in",
  IN_HOUSE: "In house",
  CHECKED_OUT: "Checked out",
  RESERVED: "Reserved",
  HELD: "Held · not confirmed",
  EXTENSION_HELD: "Extension · held",
  PROVISIONAL: "Provisional block",
};
const KIND_CLASS: Record<ChartBarKind, string> = {
  OVERSTAY: "k-over",
  IN_HOUSE: "k-in",
  CHECKED_OUT: "k-out",
  RESERVED: "k-res",
  HELD: "k-held",
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

  const bookingOf = useMemo(() => new Map((chart?.bookings ?? []).map((b) => [b.entryId, b])), [chart]);
  const typeOf = useMemo(() => new Map((chart?.roomTypes ?? []).map((t) => [t.id, t])), [chart]);
  const barsByRoom = useMemo(() => {
    const m = new Map<string, RoomChartBar[]>();
    for (const b of chart?.bars ?? []) m.set(b.roomId, [...(m.get(b.roomId) ?? []), b]);
    return m;
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
      if (e.key === "Escape" && !pickRef.current) setFull(false);
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
  }, [full]);
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
  const startInquiry = () => {
    if (!pick) return;
    const p = new URLSearchParams({ checkIn: pick.night, nights: String(pickNights), room: pick.room.roomNumber });
    setPick(null);
    router.push(`/bookings/new?${p.toString()}`);
  };

  const body = (
    <div className={`rchart${full ? " is-full" : ""}`}>
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
          <Button kind="quiet" compact onClick={() => setFull((f) => !f)} aria-pressed={full}>
            {full ? "Exit full screen" : "Full screen"}
          </Button>
          <Help label="About the house chart">
            <p>Every room, night by night: who holds it and how firmly. Rest the pointer on a booking for a second to see it; click it to open the booking.</p>
            <p>Click a free night to start an inquiry for that room from that night. The room is chosen on the booking, where the house is asked.</p>
            <p>Click a room number to report a fault or review one. A room drawn free here is one the room search offers.</p>
          </Help>
        </div>
        {rangeNote ? (
          <p className="warn-ink sm" role="status" style={{ margin: 0, fontWeight: 600 }}>
            {rangeNote}
          </p>
        ) : null}
        <Legend />
      </div>

      <div className="rchart-wrap" onScroll={leave}>
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
                    className={[d === chart.today ? "today" : "", d < chart.today ? "past" : "", weekend(d) ? "we" : "", d.slice(8, 10) === "01" && i > 0 ? "m1" : ""].filter(Boolean).join(" ") || undefined}
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
                    <tr key={rid} className={`rrow${ri === t.roomIds.length - 1 ? " last" : ""}`}>
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
                              className={["cell free", s.night === chart.today ? "tday" : "", past ? "past" : "pick"].filter(Boolean).join(" ")}
                              aria-label={past ? undefined : `Room ${room.roomNumber} free on ${longDay(s.night)} — click to start an inquiry`}
                              onClick={(e) => {
                                if (!past) openPick(room, s.night, s.index, rectOf(e), segs);
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
                        const contL = s.bar.from === chart.from && !!b?.checkInDate && b.checkInDate < chart.from;
                        const contR = s.bar.to === chart.to && !!b?.checkOutDate && b.checkOutDate > chart.to;
                        return (
                          <td
                            key={k}
                            colSpan={s.span}
                            className={`seg ${KIND_CLASS[s.bar.kind]}${s.bar.parked ? " parked" : ""}${s.bar.paymentPending ? " paypend" : ""}${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}`}
                          >
                            <button
                              type="button"
                              className="bar"
                              onMouseEnter={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onMouseLeave={leave}
                              onFocus={(e) => point({ t: "bar", bar: s.bar, room, rect: rectOf(e) })}
                              onBlur={leave}
                              onClick={() => router.push(`/bookings/${s.bar.entryId}`)}
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

      {hover && !pick ? (
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
          </div>
        </div>
        <div className="hc-foot">Click to open the booking</div>
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

