"use client";

/**
 * The booking's running clocks as a strip of small rings (2026-10-07, operator: "the timers should
 * be visible all the time … I need a visual for the timer as well, so we know the time — maybe a
 * small circular timer beside it"). Each ring empties as the clock runs down — green, amber in its
 * warning window, red in its last hour or once passed — with the label and the time left beside
 * it. The strip sticks under the board's bar, so it stays in sight whatever is scrolled.
 */
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { fmtDateTime } from "@/lib/ds/format";

const HOUR = 3_600_000;
/** 1d 23h · 5h 12m — the two units that matter. */
const dh = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
};
/** 42:07 — under an hour the seconds tick, so the ring reads as a clock. */
const mmss = (ms: number) => {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export type StripClock = { id: string; label: string; firesAt: string; createdAt: string; warningAt?: string | null; criticalAt?: string | null };

export function ClockRing({ clock, now, tz }: { clock: StripClock; now: number; tz: string }) {
  const fires = new Date(clock.firesAt).getTime();
  const start = new Date(clock.createdAt).getTime();
  const left = fires - now;
  const whole = Math.max(1, fires - start);
  const remaining = Math.min(1, Math.max(0, left / whole));
  const warnAt = clock.warningAt ? new Date(clock.warningAt).getTime() : fires - 6 * HOUR;
  const critAt = clock.criticalAt ? new Date(clock.criticalAt).getTime() : fires - HOUR;
  const level = left <= 0 ? "late" : now >= critAt ? "crit" : now >= warnAt ? "warn" : "ok";
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className={`cring ${level}`} title={`${clock.label} · ${fmtDateTime(clock.firesAt, tz)}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="bg" cx="18" cy="18" r={r} />
        <circle className="fg" cx="18" cy="18" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - remaining)} transform="rotate(-90 18 18)" />
      </svg>
      <div className="txt">
        <span className="lb">{clock.label}</span>
        <b>{left <= 0 ? `${dh(-left)} late` : left < HOUR ? `${mmss(left)} left` : `${dh(left)} left`}</b>
      </div>
    </div>
  );
}

export function ClockStrip({ clocks }: { clocks: StripClock[] }) {
  const { now, tz } = useHotelClock(1000);
  return (
    <div className="cstrip">
      <span className="k">Clocks</span>
      {clocks.length ? clocks.map((c) => <ClockRing key={c.id} clock={c} now={now} tz={tz} />) : <span className="quiet">nothing running</span>}
    </div>
  );
}
