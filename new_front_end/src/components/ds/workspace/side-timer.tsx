"use client";

/**
 * One running timer in the side panel: what runs out, a live countdown to it, and a bar that fills
 * from when the clock was armed to when it fires — green, amber as it gets close, red once it is
 * due (the old desk's timer rail, in the new frame). Each row ticks on its own, once a second, on
 * the hotel clock (anchored to the server), so the rest of the page does not re-render with it.
 */
import { Icon } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { fmtDateTime, span } from "@/lib/ds/format";
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

/** How long the booking has sat at this step — a fact beside the clocks, not a countdown (2026-09-29). */
export function StepDwell({ since }: { since: string }) {
  const { now } = useHotelClock(30_000);
  return (
    <div className="row">
      <span className="t">At this step</span>
      <span className="meta">{span(now - new Date(since).getTime())}</span>
    </div>
  );
}

/** The same fact on the header's clock line (2026-10-27). */
export function HeaderDwell({ since }: { since: string }) {
  const { now } = useHotelClock(30_000);
  return (
    <span className="hdwell">
      At this step <b>{span(now - new Date(since).getTime())}</b>
    </span>
  );
}

/** Where a clock stands: time left, how much of its run has gone (0–100), and its colour. */
function timerProgress(timer: TimerRecordSummary, now: number) {
  const fires = new Date(timer.firesAt).getTime();
  // A clock shown only from a moment of its own fills from then (the no-show cut-off's grace).
  const start = new Date(timer.showsFrom ?? timer.createdAt).getTime();
  const ms = fires - now;
  const pct = Math.min(100, Math.max(0, ((now - start) / Math.max(1, fires - start)) * 100));
  // The timer's own warning / critical marks when it has them; otherwise six hours / one hour out.
  const warnAt = timer.warningAt ? new Date(timer.warningAt).getTime() : fires - 6 * HOUR;
  const critAt = timer.criticalAt ? new Date(timer.criticalAt).getTime() : fires - HOUR;
  const level = ms <= 0 ? "due" : now >= critAt ? "crit" : now >= warnAt ? "warn" : "ok";
  return { ms, pct, level };
}

/** The one unit that fits inside the ring: "2d" · "5h" · "42m" · "due". */
function shortLeft(ms: number): string {
  if (ms <= 0) return "due";
  if (ms < HOUR) return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
  const h = Math.floor(ms / HOUR);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * The folded side panel's clock (2026-10-23): a ring that fills from when the clock was armed to
 * when it fires, in the bar's own colours, with the time left inside it.
 */
export function TimerRing({ timer, label }: { timer: TimerRecordSummary; label: string }) {
  const { now } = useHotelClock(1000);
  const { ms, pct, level } = timerProgress(timer, now);
  const r = 19;
  const c = 2 * Math.PI * r;
  return (
    <span className={`side-ring ${level}`} role="img" aria-label={`${label} · ${countdown(ms)}`} title={`${label} · ${countdown(ms)}`}>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle className="track" cx="22" cy="22" r={r} />
        <circle className="fill" cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 22 22)" />
      </svg>
      <b>{shortLeft(ms)}</b>
    </span>
  );
}

/**
 * A clock in the booking header (2026-10-27, after the operator's stage template: "the timer is now
 * on the top bar … with a circular indicator showing time flow"): what runs out and when, with a
 * small ring that fills from when the clock was armed to when it fires, in the same colours.
 */
export function HeaderClock({ timer, label }: { timer: TimerRecordSummary; label: string }) {
  const { now, tz } = useHotelClock(1000);
  const { ms, pct, level } = timerProgress(timer, now);
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <span className={`hclock ${level}`} title={`${label} · ${fmtDateTime(timer.firesAt, tz)}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="track" cx="10" cy="10" r={r} />
        <circle className="fill" cx="10" cy="10" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 10 10)" />
      </svg>
      <span>
        {label} <b>{countdown(ms)}</b>
      </span>
    </span>
  );
}

export function SideTimer({ timer, label }: { timer: TimerRecordSummary; label: string }) {
  const { now, tz } = useHotelClock(1000);
  const { ms, pct, level } = timerProgress(timer, now);

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
