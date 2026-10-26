"use client";

/**
 * Housekeeping (2026-10-26, operator: "after a room has been departed we don't have anywhere where
 * we can mark it clean — mainly for housekeeping staff, where in the future we can monitor it").
 *
 * The rooms a guest has left, most urgent first — late, then a guest due in today, then the soonest
 * clean-by time — each with one act, **Mark clean**. Cleaning puts the room back to what its
 * bookings say (free, or held for the next guest) and stops its cleaning clock. Below: what was
 * cleaned today, and every other room, where a room found dirty again can be put back on the list.
 * Every figure is the server's (`GET /api/housekeeping/rooms`); a phone app will read the same.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Chip, EmptyState, Icon } from "@/design-system";
import { Help } from "@/components/ds/help";
import { DsDialog, ReasonDialog } from "@/components/ds/steps/kit";
import { LoadFailed, LoadingBlock } from "@/components/ds/ui";
import { useHousekeepingBoard } from "@/hooks/use-housekeeping";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { markRoomCleaned, markRoomNeedsCleaning, type HousekeepingRoom } from "@/lib/api/housekeeping";
import { fmtDate, fmtTime, plural, span } from "@/lib/ds/format";
import { groupByRoomType } from "@/lib/ds/group-by-type";

const BED: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };

/** "14:00" → "2:00 PM", the desk's way of writing a time. */
function wallTime(hhmm: string | null): string | null {
  const m = hhmm ? /^(\d{1,2}):(\d{2})$/.exec(hhmm) : null;
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

function afterCleaning(toState: string): string {
  if (toState === "FREE") return "free to sell";
  if (toState === "CONFIRMED") return "kept for its next booking";
  if (toState === "COMMITTED_HELD" || toState === "SPECULATIVELY_HELD") return "held for its next booking";
  if (toState === "OCCUPIED") return "back to its guest";
  return toState.toLowerCase();
}

function errText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export default function HousekeepingPage() {
  const board = useHousekeepingBoard();
  const clock = useHotelClock(30_000);
  const today = useHotelDay()?.today ?? null;
  const data = board.data;
  const toClean = useMemo(() => (data?.rooms ?? []).filter((r) => r.state === "TO_CLEAN"), [data]);
  const others = useMemo(() => (data?.rooms ?? []).filter((r) => r.state !== "TO_CLEAN"), [data]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>
            Housekeeping
            <Help label="About housekeeping">
              A room joins this list when a guest leaves it — at check-out, or when one room of a party is released
              early. Each has {data ? span(data.windowMinutes * 60_000) : "a few hours"} to be cleaned (set by the admin as the
              housekeeping window). Marking a room clean puts it back to what its bookings say — free to sell, or kept
              for the next guest — and stops its cleaning clock.
            </Help>
          </h2>
          {data ? (
            <div className="meta">
              <b className={data.counts.toClean ? "warn-ink" : "ok-ink"}>{plural(data.counts.toClean, "room")} to clean</b>
              {data.counts.overdue ? <> · <b className="stop-ink">{data.counts.overdue} late</b></> : null}
              {data.counts.guestDueToday ? <> · {plural(data.counts.guestDueToday, "room")} with a guest due in today</> : null}
              {" · "}
              {data.cleanedToday.length} cleaned today
            </div>
          ) : null}
        </div>
      </div>

      {board.error && !data ? (
        <LoadFailed what="the rooms" onRetry={() => void board.refetch()} />
      ) : !data ? (
        <LoadingBlock />
      ) : (
        <>
          <section className="block">
            <div className="block-head">
              <h3>To clean</h3>
            </div>
            {toClean.length ? (
              <div className="hk-grid">
                {toClean.map((r) => (
                  <ToCleanCard key={r.roomId} room={r} now={clock.now} tz={clock.tz} today={today} />
                ))}
              </div>
            ) : (
              <EmptyState title="Every room is clean">A room appears here when a guest leaves it.</EmptyState>
            )}
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Cleaned today</h3>
            </div>
            {data.cleanedToday.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Room</th>
                    <th>Cleaned at</th>
                    <th>By</th>
                    <th>Took</th>
                    <th>In time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cleanedToday.map((c) => (
                    <tr key={`${c.roomId}-${c.cleanedAt}`}>
                      <td>
                        <b>Room {c.roomNumber}</b>
                      </td>
                      <td className="nowrap">{fmtTime(c.cleanedAt, clock.tz)}</td>
                      <td>{c.cleanedByName ?? c.cleanedBy}</td>
                      <td className="nowrap">{c.minutesTaken != null ? span(c.minutesTaken * 60_000) : "—"}</td>
                      <td>
                        {c.inTime == null ? (
                          "—"
                        ) : c.inTime ? (
                          <b className="ok-ink">In time</b>
                        ) : (
                          <b className="stop-ink">Late</b>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="Nothing cleaned yet today" />
            )}
          </section>

          <section className="block">
            <div className="block-head">
              <h3>Every other room</h3>
              <span className="meta">
                {plural(data.counts.occupied, "room")} with a guest in · {data.counts.ready} ready
                {data.counts.outOfOrder ? ` · ${data.counts.outOfOrder} out of order` : ""}
              </span>
            </div>
            <OtherRooms rooms={others} />
          </section>
        </>
      )}
    </div>
  );
}

function ToCleanCard({ room, now, tz, today }: { room: HousekeepingRoom; now: number; tz: string; today: string | null }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const t = room.toClean!;
  const due = t.cleanBy ? new Date(t.cleanBy).getTime() : null;
  const left = due != null ? due - now : null;
  const late = t.overdue || (left != null && left <= 0);
  const soon = !late && left != null && left < 30 * 60_000;
  const next = room.nextGuest;

  const clean = useMutation({
    mutationFn: () => markRoomCleaned(session!, room.roomId),
    onSuccess: (r) => {
      toast.success(`Room ${r.roomNumber} is clean — ${afterCleaning(r.toState)}${r.inTime === false ? " (cleaned late)" : ""}`);
      void qc.invalidateQueries({ queryKey: ["housekeeping-board"] });
      void qc.invalidateQueries({ queryKey: ["rooms-catalog"] });
      void qc.invalidateQueries({ queryKey: ["room-chart"] });
      void qc.invalidateQueries({ queryKey: ["rooms"] });
    },
    onError: (e) => toast.error(errText(e, `Could not mark Room ${room.roomNumber} clean`)),
  });

  return (
    <div className={`hk-card${late ? " late" : soon ? " soon" : ""}${next?.arrivesToday ? " due-today" : ""}`}>
      <div className="hk-card-head">
        <b className="hk-room">Room {room.roomNumber}</b>
        <span className="meta">
          {[room.roomTypeName, room.bedType ? BED[room.bedType] ?? room.bedType : null].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className={`hk-due${late ? " stop-ink" : soon ? " warn-ink" : ""}`} role={late ? "alert" : undefined}>
        <Icon name={late ? "alert" : "clock"} />
        {due == null
          ? "No clean-by time"
          : late
            ? `Late by ${span(Math.max(0, now - due))} · was due ${fmtTime(t.cleanBy, tz)}${instantDay(t.cleanBy, tz, today)}`
            : `Clean by ${fmtTime(t.cleanBy, tz)} · in ${span(left!)}`}
      </div>
      <div className="hk-line">
        Left {t.leftAt ? <>{fmtTime(t.leftAt, tz)}{instantDay(t.leftAt, tz, today)}</> : "—"}
        {t.leftBy ? (
          <>
            {" "}by{" "}
            <Link href={`/bookings/${encodeURIComponent(t.leftBy.entryId)}`}>{t.leftBy.guestName ?? t.leftBy.entryId}</Link>
          </>
        ) : (
          " · put back on the list by the desk"
        )}
      </div>
      <div className={`hk-line${next?.arrivesToday ? " hk-next-today" : ""}`}>
        {next ? (
          <>
            {next.arrivesToday ? <b>Next guest today</b> : <>Next guest {fmtDate(next.arrives)}</>}
            {" · "}
            <Link href={`/bookings/${encodeURIComponent(next.entryId)}`}>{next.guestName ?? next.entryId}</Link>
            {next.arrivesToday && wallTime(next.expectedArrivalTime) ? ` · arrives ${wallTime(next.expectedArrivalTime)}` : ""}
            {next.holds === "HELD" ? " · not confirmed yet" : ""}
          </>
        ) : (
          <span className="meta">No booking next</span>
        )}
      </div>
      {room.openFault ? (
        <div className="hk-line">
          <Chip tone="warning" icon="wrench" title={room.openFault.description}>
            Fault open · {room.openFault.description}
          </Chip>
        </div>
      ) : null}
      <div className="hk-act">
        <Button kind="primary" icon="broom" state={clean.isPending ? "working" : "default"} workingLabel="Marking…" onClick={() => clean.mutate()}>
          Mark clean
        </Button>
      </div>
    </div>
  );
}

/** " (yesterday)" / " · 24 Oct" when the instant is not on the hotel's today. */
function instantDay(iso: string | null, tz: string, today: string | null): string {
  if (!iso || !today) return "";
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  return ymd === today ? "" : ` · ${fmtDate(ymd)}`;
}

const OTHER_WORD: Record<string, string> = { OCCUPIED: "guest in", READY: "ready", OUT_OF_ORDER: "out of order" };

/** The room as the pop-up's top lines: its type and bed, where it stands, an open fault. */
function roomFacts(r: HousekeepingRoom): string[] {
  const lines = [[r.roomTypeName, r.bedType ? BED[r.bedType] ?? r.bedType : null, OTHER_WORD[r.state]].filter(Boolean).join(" · ")];
  if (r.openFault) lines.push(`Fault open · ${r.openFault.description}`);
  return lines;
}

function OtherRooms({ rooms }: { rooms: HousekeepingRoom[] }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const room = rooms.find((r) => r.roomId === open) ?? null;
  const dirty = useMutation({
    mutationFn: (reason: string) => markRoomNeedsCleaning(session!, room!.roomId, reason),
    onSuccess: (r) => {
      toast.success(`Room ${r.roomNumber} is back on the list to clean`);
      setOpen(null);
      void qc.invalidateQueries({ queryKey: ["housekeeping-board"] });
      void qc.invalidateQueries({ queryKey: ["rooms-catalog"] });
      void qc.invalidateQueries({ queryKey: ["room-chart"] });
    },
    onError: (e) => toast.error(errText(e, "Could not put the room back on the list")),
  });

  if (!rooms.length) return <EmptyState title="No other rooms" />;
  return (
    <div className="stack">
      {/* The room types sit side by side and fill the row (2026-10-26, operator: "wasting a lot of space on the right"). */}
      <div className="type-groups flow">
      {groupByRoomType(rooms, (r) => r.roomTypeName, (r) => r.roomNumber).map((g) => {
        const counts = (
          [
            ["ready", g.rooms.filter((r) => r.state === "READY").length],
            ["guest in", g.rooms.filter((r) => r.state === "OCCUPIED").length],
            ["out of order", g.rooms.filter((r) => r.state === "OUT_OF_ORDER").length],
          ] as const
        )
          .filter(([, n]) => n > 0)
          .map(([w, n]) => `${n} ${w}`)
          .join(" · ");
        return (
          <div key={g.name} className="type-group">
            <div className="tg-head">
              <b>{g.name}</b>
              <span className="meta">
                {plural(g.rooms.length, "room")}
                {counts ? ` · ${counts}` : ""}
              </span>
            </div>
            <div className="hk-tiles">
              {g.rooms.map((r) => (
                <button
                  key={r.roomId}
                  type="button"
                  className={`hk-tile ${r.state.toLowerCase()}${open === r.roomId ? " sel" : ""}`}
                  aria-haspopup="dialog"
                  title={r.openFault ? `Fault open · ${r.openFault.description}` : undefined}
                  onClick={() => setOpen(r.roomId)}
                >
                  <b>{r.roomNumber}</b>
                  <span>{OTHER_WORD[r.state] ?? r.state}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      </div>
      {/* A room's form opens in a pop-up box (2026-10-26, operator) — a panel under the tiles sat
          out of sight below a long list. */}
      {room && room.state === "OCCUPIED" ? (
        <DsDialog
          open
          onClose={() => setOpen(null)}
          register="report"
          title={`Room ${room.roomNumber}`}
          caseLines={roomFacts(room)}
          footer={
            <Button kind="secondary" onClick={() => setOpen(null)}>
              Close
            </Button>
          }
        >
          <p>A guest is in this room. It is cleaned as a stay-over, not put on the list.</p>
        </DsDialog>
      ) : null}
      <ReasonDialog
        open={!!room && room.state !== "OCCUPIED"}
        onClose={() => setOpen(null)}
        title={room ? `Room ${room.roomNumber} needs cleaning again` : ""}
        caseLines={room ? roomFacts(room) : undefined}
        lead="The room goes back on the list to clean. No guest can be checked into it until it is marked clean."
        reasonLabel="Why does it need cleaning again?"
        placeholder="e.g. a spill found on inspection"
        confirmLabel="Needs cleaning again"
        busy={dirty.isPending}
        onConfirm={(reason) => dirty.mutate(reason)}
      />
    </div>
  );
}
