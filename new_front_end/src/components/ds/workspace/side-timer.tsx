"use client";

/**
 * One running timer in the side panel: what runs out, a live countdown to it, and a bar that fills
 * from when the clock was armed to when it fires — green, amber as it gets close, red once it is
 * due (the old desk's timer rail, in the new frame). Each row ticks on its own, once a second, on
 * the hotel clock (anchored to the server), so the rest of the page does not re-render with it.
 */
import { Icon } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { fmtDateTime } from "@/lib/ds/format";
import type { TimerRecordSummary } from "@/lib/api/entries";

const HOUR = 3_600_000;

/** "in 2d 4h" · "in 3h 05m" · "in 12:07" · "overdue 1h 05m" — the two units that matter. */
function countdown(ms: number): string {
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

export function SideTimer({ timer, label }: { timer: TimerRecordSummary; label: string }) {
  const { now, tz } = useHotelClock(1000);
  const fires = new Date(timer.firesAt).getTime();
  const start = new Date(timer.createdAt).getTime();
  const ms = fires - now;
  const pct = Math.min(100, Math.max(0, ((now - start) / Math.max(1, fires - start)) * 100));
  // The timer's own warning / critical marks when it has them; otherwise six hours / one hour out.
  const warnAt = timer.warningAt ? new Date(timer.warningAt).getTime() : fires - 6 * HOUR;
  const critAt = timer.criticalAt ? new Date(timer.criticalAt).getTime() : fires - HOUR;
  const level = ms <= 0 ? "due" : now >= critAt ? "crit" : now >= warnAt ? "warn" : "ok";

  return (
    <div className="row side-timer" title={`${label} · ${fmtDateTime(timer.firesAt, tz)}`}>
      <div className="side-timer-head">
        <span className={`timer ${level === "due" ? "overdue" : level === "ok" ? "" : "close"}`}>
          <Icon name={level === "due" ? "alert" : "clock"} />
          {label}
        </span>
        <span className={`side-timer-eta ${level}`}>{countdown(ms)}</span>
      </div>
      <div className="side-timer-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <span className={level} style={{ width: `${pct}%` }} />
      </div>
      <span className="meta">{ms <= 0 ? `was due ${fmtDateTime(timer.firesAt, tz)}` : fmtDateTime(timer.firesAt, tz)}</span>
    </div>
  );
}
