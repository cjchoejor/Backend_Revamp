"use client";

/**
 * The clock a booking is on, on one line of a list (2026-09-25, operator: "show the most
 * important timer running for that reservation in the table as well").
 *
 * Most important is read as the one that runs out FIRST — that is the one that will bite, and it
 * is the only ranking that stays true as the day moves. The desk names a clock by its code and
 * has no name for every code the engine arms, so the row takes the soonest it can name; when the
 * booking is on more than one, it says so. The countdown ticks on the hotel clock, anchored to
 * the server, like the one in the workspace rail.
 */
import { Icon } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { fmtDateTime } from "@/lib/ds/format";
import { timerLabel } from "@/lib/ds/timers";
import type { DeskTimerRow } from "@/lib/api/desk";

const HOUR = 3_600_000;

/** The label, with the department named on an acceptance clock — the rail does the same. */
function labelOf(t: DeskTimerRow["next"][number]): string | null {
  if (t.timerCode === "H2_H3_ACCEPTANCE_W25") {
    if (t.handoffType === "H3") return "Kitchen to accept";
    if (t.handoffType === "H2") return "Housekeeping to accept";
  }
  return timerLabel(t);
}

/** "in 2d 4h" · "in 3h 05m" · "in 12:07" · "overdue 1h 05m" — the two units that matter. */
export function countdownWords(ms: number): string {
  const abs = Math.abs(ms);
  const s = Math.floor(abs / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const core =
    d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return ms <= 0 ? `overdue ${core}` : `in ${core}`;
}

/** Every clock the desk can name on this booking, for the list's preview panel. */
export function RowTimerList({ row }: { row: DeskTimerRow | undefined }) {
  const { now, tz } = useHotelClock(1000);
  const named = (row?.next ?? []).map((t) => ({ t, label: labelOf(t) })).filter((x): x is { t: NonNullable<typeof row>["next"][number]; label: string } => !!x.label);
  if (named.length === 0) return <span className="dash">—</span>;
  return (
    <div className="row-timer-list">
      {named.map(({ t, label }, i) => {
        const ms = new Date(t.firesAt).getTime() - now;
        const level = ms <= 0 ? "due" : ms <= HOUR ? "crit" : ms <= 6 * HOUR ? "warn" : "ok";
        return (
          <div key={`${t.timerCode}-${i}`} className="row-timer" title={fmtDateTime(t.firesAt, tz)}>
            <span className={`timer ${level === "due" ? "overdue" : level === "ok" ? "" : "close"}`}>
              <Icon name={level === "due" ? "alert" : "clock"} />
              {label}
            </span>
            <span className={`row-timer-eta ${level}`}>{countdownWords(ms)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function RowTimer({ row }: { row: DeskTimerRow | undefined }) {
  const { now, tz } = useHotelClock(1000);
  if (!row || row.running === 0) return <span className="dash">—</span>;
  // Only the clocks the desk has words for: the dwell monitor and the retention purge run on
  // every booking and are the system's business, not the front desk's.
  const named = row.next.map((t) => ({ t, label: labelOf(t) })).filter((x): x is { t: (typeof row.next)[number]; label: string } => !!x.label);
  const first = named[0];
  if (!first) return <span className="dash">—</span>;
  const fires = new Date(first.t.firesAt).getTime();
  const ms = fires - now;
  const level = ms <= 0 ? "due" : ms <= HOUR ? "crit" : ms <= 6 * HOUR ? "warn" : "ok";
  const others = named.length - 1;
  return (
    <span className="row-timer" title={`${first.label} · ${fmtDateTime(first.t.firesAt, tz)}${others > 0 ? ` · ${others} more running` : ""}`}>
      <span className={`timer ${level === "due" ? "overdue" : level === "ok" ? "" : "close"}`}>
        <Icon name={level === "due" ? "alert" : "clock"} />
        {first.label}
      </span>
      <span className={`row-timer-eta ${level}`}>
        {countdownWords(ms)}
        {others > 0 ? <span className="meta"> · +{others}</span> : null}
      </span>
    </span>
  );
}
