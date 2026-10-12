"use client";

/**
 * The house chart — rooms down the side, nights across the top (2026-10-12, operator: "show it
 * like the mockup's Rooms tab ... a row named House booked, as numbers like 3/28 ... it will
 * show all the reservations, and checked in, confirmed or parked in different styles").
 *
 * For seeing, not choosing: rooms are chosen inside a booking. Every figure and every bar comes
 * from `GET /api/rooms/chart`, which reads the same claim rules the room search does — so a room
 * drawn free here is a room the search offers. The desk only lays the bars out: one bar per run
 * of nights a booking holds a room; two bookings on one room-night are drawn as a conflict.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, type ChartBarKind, type RoomChart, type RoomChartBar, type RoomChartBooking } from "@/lib/api/rooms";
import { fmtDateTime, fmtDay, fmtRange, plural } from "@/lib/ds/format";
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
const BED_LETTER: Record<string, string> = { KING: "K", TWIN: "T", QUEEN: "Q", SINGLE: "S" };
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WINDOWS = [14, 21, 28];

const shiftDay = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (ymd: string) => WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()];

type Seg =
  | { t: "free"; night: string }
  | { t: "ooo"; span: number; reason: string | null }
  | { t: "bar"; span: number; bar: RoomChartBar }
  | { t: "conflict"; night: string; bars: RoomChartBar[] };

function housekeepingOf(room: RoomChart["rooms"][number]): { cls: string; word: string } {
  const claim = room.currentClaimState.toUpperCase();
  const ps = room.physicalState.toUpperCase();
  if (claim === "DEPARTED_DIRTY" || ps === "DIRTY") return { cls: "hk-warn", word: "needs cleaning" };
  if (ps === "AVAILABLE_INSPECTED") return { cls: "hk-ok", word: "inspected" };
  if (ps === "UNDER_MAINTENANCE") return { cls: "hk-bad", word: "under maintenance" };
  return { cls: "hk-ok", word: "clean" };
}

function segmentsFor(room: RoomChart["rooms"][number], chart: RoomChart, bars: RoomChartBar[]): Seg[] {
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
      out.push({ t: "ooo", span: j - i + 1, reason: room.outOfOrder.reason });
      i = j + 1;
      continue;
    }
    out.push({ t: "free", night: nights[i] });
    i++;
  }
  return out;
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

  const bookingOf = useMemo(() => new Map((chart?.bookings ?? []).map((b) => [b.entryId, b])), [chart]);
  const barsByRoom = useMemo(() => {
    const m = new Map<string, RoomChartBar[]>();
    for (const b of chart?.bars ?? []) m.set(b.roomId, [...(m.get(b.roomId) ?? []), b]);
    return m;
  }, [chart]);

  if (q.error && !chart) return <LoadFailed what="the house chart" onRetry={() => void q.refetch()} />;
  if (!chart) return <LoadingBlock />;

  const lastNight = chart.nights[chart.nights.length - 1];
  const nameOf = (b?: RoomChartBooking) => (b ? rowNameOf(b) : "Booking");
  const tipOf = (bar: RoomChartBar, roomNumber: string) => {
    const b = bookingOf.get(bar.entryId);
    return [
      `${KIND_WORD[bar.kind]}${bar.parked ? " · parked" : ""}${bar.paymentPending ? " · advance short" : ""} — ${nameOf(b)}`,
      `Room ${roomNumber} · ${fmtRange(bar.from, bar.to)} on this chart`,
      b ? `${b.entryId} · ${b.inquiryId}` : bar.entryId,
      b?.checkInDate ? `Stay ${fmtRange(b.checkInDate, b.checkOutDate)} · now at ${STEP_NAMES[stepNoOfStage(b.stage) - 1]}` : null,
      b?.partyName ? `Booked by ${b.partyName}` : null,
      bar.holdExpiresAt ? `Held until ${fmtDateTime(bar.holdExpiresAt)}` : null,
      "Click to open the booking",
    ]
      .filter(Boolean)
      .join("\n");
  };

  return (
    <div className="rchart">
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
          <select className="input rchart-len" value={nightsAsked} onChange={(e) => setNightsAsked(Number(e.target.value))} aria-label="How many nights">
            {WINDOWS.map((n) => (
              <option key={n} value={n}>
                {n} nights
              </option>
            ))}
          </select>
          <b className="rchart-span">{fmtRange(chart.from, lastNight)}</b>
          <Help label="About the house chart">
            <p>Every room, night by night: who holds it and how firmly. Point at a bar for the booking; click it to open the booking.</p>
            <p>For seeing, not choosing — rooms are chosen inside a booking. A room drawn free here is one the room search offers.</p>
            <p>Click a room number to report a fault or review one.</p>
          </Help>
        </div>
        <Legend />
      </div>

      <div className="rchart-wrap">
        {/* At least 70px a night; wider screens share the rest evenly. */}
        <table className="tape" style={{ minWidth: 190 + 64 + 70 * chart.nights.length }}>
          <thead>
            <tr className="h1">
              <th className="rc">Rooms</th>
              {chart.nights.map((d) => (
                <th key={d} className={d === chart.today ? "today" : d < chart.today ? "past" : undefined}>
                  {weekdayOf(d)}
                  <br />
                  <b>{Number(d.slice(8, 10))}</b>
                  {d === chart.today ? <small>today</small> : d.slice(8, 10) === "01" || d === chart.from ? <small>{fmtDay(d).split(" ")[1]}</small> : null}
                </th>
              ))}
              <th className="tc">Taken</th>
            </tr>
            <tr className="h2">
              <th className="rc">Free that night</th>
              {chart.perNight.map((n) => (
                <td key={n.date} className={`need ${n.free >= 5 ? "ok" : n.free > 0 ? "short" : "none"}`} title={`${plural(n.free, "room")} free on ${fmtDay(n.date)}`}>
                  {n.free}
                </td>
              ))}
              <td className="tc" />
            </tr>
            <tr className="h3">
              <th className="rc">House booked</th>
              {chart.perNight.map((n) => (
                <td
                  key={n.date}
                  className="hb"
                  title={`${n.booked} of ${n.total} rooms taken on ${fmtDay(n.date)} — ${n.inHouse} with a guest in · ${n.reserved} reserved · ${n.held} held${n.outOfOrder ? ` · ${n.outOfOrder} out of order` : ""}`}
                >
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
                    <b>{t.name}</b> <span className="meta">{plural(t.roomIds.length, "room")}</span>
                  </th>
                  {t.freePerNight.map((f, i) => (
                    <td key={chart.nights[i]} className={`fc ${f === 0 ? "none" : ""}`}>
                      {f === 0 ? "none" : `${f} free`}
                    </td>
                  ))}
                  <td className="tc" />
                </tr>
                {t.roomIds.map((rid) => {
                  const room = chart.rooms.find((r) => r.id === rid);
                  if (!room) return null;
                  const hk = housekeepingOf(room);
                  return (
                    <tr key={rid} className="rrow">
                      <th className="rc rno">
                        <button type="button" className="rno-btn" onClick={() => onOpenRoom(room)} title="Open the room — report a fault or review one">
                          <b>{room.roomNumber}</b>
                          {room.bedType ? <span className="bed">{BED_LETTER[room.bedType] ?? room.bedType}</span> : null}
                          <i className={`hkdot ${hk.cls}`} title={`Housekeeping · ${hk.word}`} />
                          {room.faultOpen ? <span className="fault">fault</span> : null}
                        </button>
                      </th>
                      {segmentsFor(room, chart, barsByRoom.get(rid) ?? []).map((s, k) => {
                        if (s.t === "free") return <td key={k} className={`cell free${s.night === chart.today ? " today" : ""}`} />;
                        if (s.t === "ooo")
                          return (
                            <td key={k} colSpan={s.span} className="seg k-ooo" title={`Out of order · ${s.reason ?? ""}`}>
                              <div className="bar">Out of order{s.reason ? ` · ${s.reason}` : ""}</div>
                            </td>
                          );
                        if (s.t === "conflict")
                          return (
                            <td
                              key={k}
                              className="seg k-conflict"
                              title={`Two bookings on Room ${room.roomNumber} on ${fmtDay(s.night)}:\n${s.bars.map((b) => `${KIND_WORD[b.kind]} — ${nameOf(bookingOf.get(b.entryId))} · ${b.entryId}`).join("\n")}`}
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
                            <button type="button" className="bar" title={tipOf(s.bar, room.roomNumber)} onClick={() => router.push(`/bookings/${s.bar.entryId}`)}>
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
    </div>
  );
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
