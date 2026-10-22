"use client";

/**
 * A booking's rooms, night by night, in one box (2026-10-16, operator: "say it's a travel agent,
 * there would be many guests with many rooms ... it would be hard for the user to scroll and click
 * them ... click once and show in a new box all the rooms with dates like a table, and the user can
 * select them to move; make the single click that opens the booking a double click").
 *
 * Rulings (asked): the box lists THIS booking's rooms; the desk says where they go either in the box
 * (a new first night, another room per ticked room) or by dragging them on the chart; a room's name
 * ticks all its nights, single nights tick on their own.
 *
 * Nothing moves from here. "Show what happens" hands the chart the same move a drag would — the
 * night window, the split window, the date window or the room move — and that window asks the server.
 * The room-by-night picture is read from the chart's own endpoint over the booking's stay, so the box
 * and the chart cannot describe the booking differently.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { DsDialog } from "@/components/ds/steps/kit";
import { useSession } from "@/hooks/use-session";
import { getRoomChart, type ChartBarKind, type RoomChartBooking } from "@/lib/api/rooms";
import type { DateMoveInput, RoomMoveLegInput } from "@/lib/api/room-moves";
import { fmtRange } from "@/lib/ds/format";
import { rowNameOf } from "@/lib/ds/status";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { NightMove } from "./night-move-dialog";
import type { SplitMove } from "./split-move-dialog";

const DAY = 86_400_000;
const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDay = (ymd: string) => `${WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()]} ${Number(ymd.slice(8, 10))} ${MONTH[Number(ymd.slice(5, 7)) - 1]}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const roomsWords = (nos: string[]) => (nos.length === 1 ? `Room ${nos[0]}` : `Rooms ${nos.join(" + ")}`);

/** What the box hands the chart: a move to show, or picks to mark for dragging. */
export type BoxMove =
  | { kind: "nights"; move: NightMove }
  | { kind: "split"; move: SplitMove }
  | { kind: "dates"; move: DateMoveInput & { label: string } }
  | { kind: "rooms"; legs: RoomMoveLegInput[] }
  | { kind: "mark-nights"; rooms: Array<{ roomId: string; roomNumber: string; nights: string[] }> }
  | { kind: "mark-rooms"; rooms: Array<{ roomId: string; roomNumber: string }> };

export function BookingBox({
  booking,
  isMovable,
  roomOrder,
  onClose,
  onOpen,
  onMove,
}: {
  booking: RoomChartBooking;
  isMovable: (kind: ChartBarKind) => boolean;
  /** The rooms in the chart's own order, top to bottom. */
  roomOrder: string[];
  onClose: () => void;
  onOpen: () => void;
  onMove: (m: BoxMove) => void;
}) {
  const { session } = useSession();
  const ci = booking.checkInDate;
  const co = booking.checkOutDate;
  const stayLen = ci && co ? Math.max(1, Math.min(62, daysBetween(ci, co))) : 1;
  const q = useQuery({
    queryKey: ["room-chart", "box", booking.entryId, ci, stayLen],
    queryFn: () => getRoomChart(session!, { from: ci!, nights: stayLen }),
    enabled: !!session && !!ci,
    staleTime: 0,
  });
  const chart = q.data ?? null;

  // The booking's rooms and the nights it holds each — movable claims only.
  const { held, rooms, nights } = useMemo(() => {
    const h = new Map<string, Set<string>>();
    for (const b of chart?.bars ?? []) {
      if (b.entryId !== booking.entryId || !isMovable(b.kind)) continue;
      const set = h.get(b.roomId) ?? new Set<string>();
      for (let d = b.from; d < b.to; d = shift(d, 1)) set.add(d);
      h.set(b.roomId, set);
    }
    const order = roomOrder.length ? roomOrder : (chart?.rooms ?? []).map((r) => r.id);
    const ids = [...h.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return { held: h, rooms: ids, nights: chart?.nights ?? [] };
  }, [chart, booking.entryId, isMovable, roomOrder]);
  const roomById = useMemo(() => new Map((chart?.rooms ?? []).map((r) => [r.id, r])), [chart]);
  const typeName = useMemo(() => new Map((chart?.roomTypes ?? []).map((t) => [t.id, t.name])), [chart]);
  const no = (id: string) => roomById.get(id)?.roomNumber ?? "?";

  const [ticked, setTicked] = useState<Map<string, Set<string>>>(new Map());
  const [newFirst, setNewFirst] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});

  const isTicked = (r: string, n: string) => ticked.get(r)?.has(n) ?? false;
  const setNights = (r: string, ns: string[], on: boolean) =>
    setTicked((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(r) ?? []);
      for (const n of ns) (on ? set.add(n) : set.delete(n));
      if (set.size) next.set(r, set);
      else next.delete(r);
      return next;
    });
  const heldNights = (r: string) => nights.filter((n) => held.get(r)?.has(n));
  const roomAll = (r: string) => heldNights(r).every((n) => isTicked(r, n));
  const nightAll = (n: string) => rooms.filter((r) => held.get(r)?.has(n)).every((r) => isTicked(r, n));

  // ── what is ticked ──
  const tickedRooms = rooms
    .filter((r) => (ticked.get(r)?.size ?? 0) > 0)
    .map((r) => ({ roomId: r, roomNumber: no(r), nights: [...ticked.get(r)!].sort() }))
    .sort((a, b) => a.nights[0].localeCompare(b.nights[0]));
  const firstNight = tickedRooms[0]?.nights[0] ?? null;
  const tickedCount = tickedRooms.reduce((s, r) => s + r.nights.length, 0);
  const days = firstNight && newFirst ? daysBetween(firstNight, newFirst) : 0;
  const toOf = (r: string) => targets[r] || r;
  /** A room the booking holds on every night of its stay, ticked on all of them. */
  const wholeStayRoom = (r: string) => heldNights(r).length === nights.length && (ticked.get(r)?.size ?? 0) === heldNights(r).length;
  const allWhole = tickedRooms.length > 0 && tickedRooms.every((t) => wholeStayRoom(t.roomId));
  const everyRoom = allWhole && tickedRooms.length === rooms.length;
  const moves = days !== 0 || tickedRooms.some((t) => toOf(t.roomId) !== t.roomId);

  const why = !tickedRooms.length
    ? "Tick the nights to move, or a room's number for all its nights"
    : !moves
      ? "Choose a new first night, or another room"
      : null;
  // A room's ticked nights may have gaps (2026-10-22, operator: "305 on the 25th and the 27th"):
  // each run moves by the same days, and each run that lands apart is a stay of its own.
  const markWhy = !tickedRooms.length ? "Tick something to mark" : null;

  const label = rowNameOf(booking);
  const show = () => {
    if (why || !firstNight) return;
    if (allWhole && days !== 0 && ci) {
      const roomMap = Object.fromEntries(tickedRooms.map((t) => [t.roomId, toOf(t.roomId)]));
      if (everyRoom) {
        onMove({ kind: "dates", move: { entryId: booking.entryId, fromRoomId: tickedRooms[0].roomId, roomMap, newCheckInDate: shift(ci, days), label } });
      } else {
        onMove({
          kind: "split",
          move: {
            entryId: booking.entryId,
            fromRoomId: tickedRooms[0].roomId,
            roomMap,
            newCheckInDate: shift(ci, days),
            label,
            roomWords: roomsWords(tickedRooms.map((t) => t.roomNumber)),
          },
        });
      }
      return;
    }
    if (allWhole && days === 0) {
      onMove({
        kind: "rooms",
        legs: tickedRooms.filter((t) => toOf(t.roomId) !== t.roomId).map((t) => ({ entryId: booking.entryId, fromRoomId: t.roomId, toRoomId: toOf(t.roomId) })),
      });
      return;
    }
    onMove({
      kind: "nights",
      move: {
        entryId: booking.entryId,
        label,
        newFirstNight: shift(firstNight, days),
        picks: tickedRooms.map((t) => ({ fromRoomId: t.roomId, nights: t.nights, toRoomId: toOf(t.roomId), roomNumber: t.roomNumber, toRoomNumber: no(toOf(t.roomId)) })),
      },
    });
  };
  const mark = () => {
    if (markWhy) return;
    if (allWhole) onMove({ kind: "mark-rooms", rooms: tickedRooms.map((t) => ({ roomId: t.roomId, roomNumber: t.roomNumber })) });
    else onMove({ kind: "mark-nights", rooms: tickedRooms });
  };

  const step = STEP_NAMES[stepNoOfStage(booking.stage) - 1];
  const otherRooms = (chart?.roomTypes ?? []).map((t) => ({ name: t.name, ids: t.roomIds }));

  return (
    <DsDialog
      open
      onClose={onClose}
      register="report"
      width={Math.max(760, Math.min(1100, 360 + nights.length * 64))}
      title={
        <span className="bbox-title">
          {label}
          <span className="bbox-sub">
            {booking.entryId} · {step}
            {ci && co ? ` · ${fmtRange(ci, co)}` : ""}
          </span>
        </span>
      }
      footer={
        <div className="bbox-foot">
          <Button kind="quiet" onClick={onOpen}>
            Open the booking
          </Button>
          <span style={{ flex: 1 }} />
          <Button kind="quiet" onClick={onClose}>
            Leave it
          </Button>
          <Button kind="quiet" state={markWhy ? "inert" : "default"} onClick={mark} title={markWhy ?? "Mark the ticked rooms and nights on the chart, then drag them"}>
            Drag them on the chart
          </Button>
          <Button kind="primary" state={why ? "inert" : "default"} onClick={show}>
            Show what happens
          </Button>
        </div>
      }
    >
      {q.isLoading ? (
        <p className="sm muted">Reading the booking&apos;s rooms…</p>
      ) : q.isError ? (
        <p className="stop-ink sm">The rooms could not be read — close the box and try again.</p>
      ) : rooms.length === 0 ? (
        <p className="warn-ink" style={{ fontWeight: 700 }}>
          Nothing of this booking can be moved from the chart at its step ({step}). Open the booking for what it can do.
        </p>
      ) : (
        <div className="bbox">
          <div className="bbox-head">
            <b className={tickedCount ? "ok-ink" : "muted"}>
              {tickedCount ? `${plural(tickedCount, "night")} of ${plural(tickedRooms.length, "room")} ticked` : "Nothing ticked yet"}
            </b>
            <Help label="About this box">
              <p>Every room of this booking, night by night. Tick a night, a room&apos;s number for all its nights, or a date for every room that night.</p>
              <p>Then say where they go: a new first night moves them later or earlier by the same days; another room moves each ticked room. Show what happens opens the usual window — nothing moves until you confirm there.</p>
              <p>A whole room on other dates leaves as a booking of its own; every room on other dates moves the whole stay; the same dates in another room is a room change. Single nights move as the night move does.</p>
              <p>Drag them on the chart marks what you ticked on the chart, and you drag it there as usual.</p>
            </Help>
            {ticked.size ? (
              <Button kind="quiet" compact onClick={() => setTicked(new Map())}>
                Clear
              </Button>
            ) : null}
          </div>
          <div className="bbox-wrap">
            <table className="bbox-grid">
              <thead>
                <tr>
                  <th className="bbox-room">Room</th>
                  {nights.map((n) => {
                    const any = rooms.some((r) => held.get(r)?.has(n));
                    return (
                      <th key={n}>
                        <button
                          type="button"
                          className={`bbox-night${any && nightAll(n) ? " on" : ""}`}
                          disabled={!any}
                          onClick={() => {
                            const on = !nightAll(n);
                            for (const r of rooms) if (held.get(r)?.has(n)) setNights(r, [n], on);
                          }}
                          title={`Tick every room on ${longDay(n)}`}
                        >
                          <span>{WEEKDAY[new Date(`${n}T00:00:00Z`).getUTCDay()]}</span>
                          <b>{Number(n.slice(8, 10))}</b>
                          <span>{MONTH[Number(n.slice(5, 7)) - 1]}</span>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => {
                  const room = roomById.get(r);
                  return (
                    <tr key={r}>
                      <th className="bbox-room">
                        <button type="button" className={`bbox-rno${roomAll(r) ? " on" : ""}`} onClick={() => setNights(r, heldNights(r), !roomAll(r))} title={`Tick all of Room ${no(r)}'s nights`}>
                          <b>{no(r)}</b>
                          <span>{room ? typeName.get(room.roomTypeId) : ""}</span>
                        </button>
                      </th>
                      {nights.map((n) =>
                        held.get(r)?.has(n) ? (
                          <td key={n}>
                            <button
                              type="button"
                              className={`bbox-cell${isTicked(r, n) ? " on" : ""}`}
                              aria-pressed={isTicked(r, n)}
                              aria-label={`Room ${no(r)} on ${longDay(n)}`}
                              onClick={() => setNights(r, [n], !isTicked(r, n))}
                            >
                              {isTicked(r, n) ? "✓" : ""}
                            </button>
                          </td>
                        ) : (
                          <td key={n} className="bbox-none">
                            –
                          </td>
                        ),
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {tickedRooms.length ? (
            <div className="bbox-to">
              <label className="field bbox-first">
                <span>First night</span>
                <input
                  className="input"
                  type="date"
                  value={newFirst || firstNight || ""}
                  min={chart?.today}
                  onChange={(e) => setNewFirst(e.target.value === firstNight ? "" : e.target.value)}
                />
                <small className={days ? "warn-ink" : "muted"}>
                  {days ? `${plural(Math.abs(days), "day")} ${days > 0 ? "later" : "earlier"}` : "the same dates"}
                </small>
              </label>
              <div className="bbox-targets">
                {tickedRooms.map((t) => (
                  <label key={t.roomId} className="field">
                    <span>
                      Room {t.roomNumber} · {fmtRange(t.nights[0], shift(t.nights[t.nights.length - 1], 1))}
                    </span>
                    <select className="input" value={toOf(t.roomId)} onChange={(e) => setTargets((m) => ({ ...m, [t.roomId]: e.target.value }))}>
                      {otherRooms.map((g) => (
                        <optgroup key={g.name} label={g.name}>
                          {g.ids.map((id) => (
                            <option key={id} value={id}>
                              {no(id)}
                              {id === t.roomId ? " · stays in this room" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {why ? (
            <p className={tickedRooms.length ? "stop-ink bbox-why" : "muted bbox-why"} role={tickedRooms.length ? "alert" : undefined}>
              {why}
            </p>
          ) : null}
        </div>
      )}
    </DsDialog>
  );
}
