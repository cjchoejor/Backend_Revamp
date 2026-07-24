"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, Timer } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getEntryTimers, getEntryTrace, type TimerRecordSummary } from "@/lib/api/entries";
import { labelForTimer, isPassedStageAckWindow } from "@/lib/desk/timers";
import { humanizeTrace, type TraceEvent, type TraceTone } from "@/lib/trace/humanize";
import type { BackendItem } from "@/lib/desk/backend-map";

const TONE_COLOR: Record<TraceTone, string> = {
  info: "var(--ink-3)",
  success: "var(--green)",
  warning: "var(--warn)",
  critical: "var(--stop)",
};

const TIMER_TONE: Record<string, string> = {
  SCHEDULED: "var(--ok)",
  FIRED: "var(--ink-3)",
  CANCELLED: "var(--ink-3)",
};

// ───────── category colour-coding (so policy / engine / timer / … are distinct) ─────────

export type BackendCategory = "policy" | "engine" | "timer" | "stateMachine" | "service" | "handoff" | "other";

const CATEGORY_STYLE: Record<BackendCategory, { bd: string; bg: string; fg: string; label: string }> = {
  policy: { bd: "#e0a06f", bg: "#fbeee2", fg: "#9a531f", label: "Policy" },
  engine: { bd: "#88abc4", bg: "#e7eef3", fg: "#37607d", label: "Engine" },
  timer: { bd: "#7fbf9a", bg: "#e6f0ea", fg: "#256b45", label: "Timer / worker" },
  stateMachine: { bd: "#b39ad0", bg: "#efe8f5", fg: "#664a86", label: "State machine" },
  service: { bd: "#c7b79f", bg: "#f0ebe3", fg: "#6b5b45", label: "Service" },
  handoff: { bd: "#e6c877", bg: "#fbf3dc", fg: "#856012", label: "Handoff" },
  other: { bd: "#c2c2bd", bg: "#eeeeec", fg: "#5f5f5a", label: "Other" },
};

/** Best-effort classification of a backend item from its name / ref, for colour-coding. */
export function categorize(it: BackendItem): BackendCategory {
  const s = `${it.name} ${it.ref ?? ""}`;
  if (/state[- ]?machine/i.test(s)) return "stateMachine";
  if (/engine/i.test(s)) return "engine";
  if (/\bW\d+\b|_W\d|worker|timer|ENTRY_EXPIRY|EXPIRY|STAGE_DWELL|FOLLOW_UP|COUNTDOWN|SLA|armed|monitor/i.test(s))
    return "timer";
  if (/handoff|\bH[1-4]\b/i.test(s)) return "handoff";
  if (/policy|validation|registry\.|\bp\d/i.test(s)) return "policy";
  if (/service|createEntry|createInquiry|createGuestProfile|dispatch|folio/i.test(s)) return "service";
  return "other";
}

/** Plain-English gloss for each category, so the colour actually means something. */
const CATEGORY_GLOSS: Record<BackendCategory, string> = {
  policy: "Business rule / guard",
  engine: "Calculation",
  timer: "Timed background job",
  stateMachine: "Stage transition",
  service: "Reads / writes data",
  handoff: "Department handoff",
  other: "Other",
};

/**
 * Legend at the top of a BackendRail. Two keys: colour = *what kind* of backend step,
 * shade = *whether it has run* (the traffic-light state used on each group).
 */
export function CategoryLegend() {
  return (
    <div className="bx-legend">
      <div className="bx-legend-h">Colour = kind of step</div>
      {(Object.keys(CATEGORY_STYLE) as BackendCategory[])
        .filter((k) => k !== "other")
        .map((k) => (
          <span className="bx-legend-item" key={k}>
            <span className="bx-rdot" style={{ background: CATEGORY_STYLE[k].bd }} />
            <b>{CATEGORY_STYLE[k].label}</b>
            <span className="bx-legend-gloss">{CATEGORY_GLOSS[k]}</span>
          </span>
        ))}
      <div className="bx-legend-h" style={{ marginTop: 7 }}>State = has it run?</div>
      <span className="bx-legend-item">
        <span className="bx-state-chip done">✓ Ran</span>
        <span className="bx-legend-gloss">already happened for this booking</span>
      </span>
      <span className="bx-legend-item">
        <span className="bx-state-chip run">● Now</span>
        <span className="bx-legend-gloss">running right now</span>
      </span>
      <span className="bx-legend-item">
        <span className="bx-state-chip idle" />
        <span className="bx-legend-gloss">not yet — waits for its step</span>
      </span>
    </div>
  );
}

export type RailGroup = { key: string; label: string; items: BackendItem[] };

/**
 * Side-by-side "Backend" rail for a stage: the live feed (when there's an entry) + the stage's
 * backend elements grouped by the action that triggers them, colour-coded by category.
 *
 * - `activeKeys`: groups whose action HAS run for this booking — they stay highlighted throughout.
 * - `firingKey`: the group whose action is firing right now — extra "running now" pulse on top.
 */
export function BackendRail({
  groups,
  activeKeys,
  firingKey,
}: {
  /**
   * Retained for call-site compatibility (steps still pass the entry id). The live feed now
   * renders once in the workspace's left column, so the rail itself is legend + groups only.
   */
  entryId?: string;
  groups: RailGroup[];
  activeKeys?: string[];
  firingKey?: string | null;
}) {
  const activeSet = new Set(activeKeys ?? []);
  return (
    <div className="bx-rail">
      <CategoryLegend />
      <div className="bx-groups">
        {groups.map((g) => {
          const firing = firingKey === g.key;
          const active = firing || activeSet.has(g.key);
          return (
            <div className={`bx-g${active ? " active" : ""}${firing ? " firing" : ""}`} key={g.key}>
              <div className="bx-g-h">
                {g.label}
                {firing ? (
                  <span className="bx-g-run">● Now</span>
                ) : active ? (
                  <span className="bx-g-used">✓ Ran</span>
                ) : null}
              </div>
              <div className="bx-g-items">
                {g.items.map((it) => {
                  const c = CATEGORY_STYLE[categorize(it)];
                  return (
                    <div
                      className="bx-ritem"
                      key={it.name}
                      title={`${it.name}${it.ref ? ` · ${it.ref}` : ""}\n${it.detail}`}
                      style={{ borderLeftColor: c.bd }}
                    >
                      <span className="bx-rdot" style={{ background: c.bd }} />
                      <span
                        className="bx-rname"
                        style={{ color: active ? "var(--ink)" : "var(--ink-2)", fontWeight: active ? 600 : 500 }}
                      >
                        {it.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Inline "what runs in the backend when you do this" annotation, attached under an
 * operate action. Curated from the spec — each chip names a policy / engine / state
 * machine / service / timer with the plain-English detail on hover.
 */
export function BackendChips({ title, items }: { title?: string; items: BackendItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="bx-inline">
      <div className="bx-inline-h">
        <Cpu style={{ width: 12, height: 12 }} />
        {title ?? "What this triggers in the backend"}
      </div>
      <div className="bx-chips">
        {items.map((it) => (
          <span className="bx-chip" key={it.name} title={it.detail}>
            <b>{it.name}</b>
            {it.ref && <span className="bx-chip-ref mono">{it.ref}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Format a signed millisecond delta as a countdown — seconds granularity when close. */
function formatCountdown(ms: number): string {
  const overdue = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const core =
    d > 0
      ? `${d}d ${h}h`
      : h > 0
        ? `${h}h ${String(m).padStart(2, "0")}m`
        : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return overdue ? `overdue ${core}` : `in ${core}`;
}

/**
 * A live, per-second timer cell: countdown to its fire time + a progress bar that fills as it
 * elapses (armed → fires), coloured by urgency. Isolated into its own component so the 1s tick
 * re-renders only this cell — not the whole feed (its event list stays put).
 */
function LiveTimer({ timer }: { timer: TimerRecordSummary }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const start = new Date(timer.createdAt).getTime();
  const fires = new Date(timer.firesAt).getTime();
  const ms = fires - now;
  const total = Math.max(1, fires - start);
  const pct = Math.min(100, Math.max(0, ((now - start) / total) * 100));
  // Urgency prefers the timer's own warning/critical marks; falls back to a 5-minute window.
  const warnAt = timer.warningAt ? new Date(timer.warningAt).getTime() : null;
  const critAt = timer.criticalAt ? new Date(timer.criticalAt).getTime() : null;
  const level =
    ms < 0 || (critAt != null && now >= critAt)
      ? "crit"
      : (warnAt != null && now >= warnAt) || ms < 5 * 60_000
        ? "warn"
        : "ok";
  const color = level === "crit" ? "var(--stop)" : level === "warn" ? "var(--warn)" : "var(--green)";
  return (
    <div className="bx-timer" title={`${timer.status} · fires ${timer.firesAt}`}>
      <div className="bx-timer-head">
        <span className="bx-dot" style={{ background: color }} />
        <span className="bx-timer-code" title={timer.timerCode || timer.timerType}>{labelForTimer(timer)}</span>
        <span className="mono bx-timer-eta" style={{ color, fontWeight: level === "ok" ? 400 : 600 }}>
          {formatCountdown(ms)}
        </span>
      </div>
      <div className="bx-timer-bar">
        <div className="bx-timer-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * Live, auto-refreshing feed of what the backend actually did for this entry —
 * active timers + the decision journey (TraceEvents). Drop it on a stage page so the
 * operator sees policies firing / timers arming in real time as they act.
 */
export function LiveBackendFeed({ entryId, limit = 24, currentStage }: { entryId: string; limit?: number; currentStage?: string | null }) {
  const { session } = useSession();
  const now = Date.now();

  const timersQuery = useQuery({
    queryKey: ["entry-timers", entryId],
    queryFn: () => getEntryTimers(session!, entryId),
    enabled: !!session,
    refetchInterval: 8000,
  });
  const traceQuery = useQuery({
    queryKey: ["entry-trace", entryId],
    queryFn: () => getEntryTrace(session!, entryId, 80),
    enabled: !!session,
    refetchInterval: 8000,
  });

  const allTimers = (timersQuery.data?.items ?? []) as TimerRecordSummary[];
  // Hide acknowledgement windows whose stage the booking has already moved past — they're moot
  // (progression implies the guest engaged) and otherwise read as duplicate "W22" rows.
  const hiddenPassed = allTimers.filter((t) => isPassedStageAckWindow(t, currentStage)).length;
  const timers = allTimers.filter((t) => !isPassedStageAckWindow(t, currentStage));
  const activeTimers = timers.filter((t) => t.status === "SCHEDULED");
  const events = [...(traceQuery.data?.items ?? [])]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit) as TraceEvent[];

  return (
    <div className="bx-feed">
      <div className="bx-feed-h">
        <span className="bx-live-dot" />
        <Activity style={{ width: 13, height: 13 }} />
        Backend activity — live
        <span className="bx-feed-sub">auto-refreshing · what actually fired for this booking</span>
      </div>

      <div className="bx-timers">
        <div className="bx-timers-h">
          <Timer style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
          <span className="bx-feed-label">Timers</span>
          <span className="bx-feed-count">{activeTimers.length} active</span>
        </div>
        {timers.length === 0 ? (
          <span className="bx-muted">none yet</span>
        ) : (
          <div className="bx-timer-list">
            {timers.map((t) =>
              t.status === "SCHEDULED" ? (
                <LiveTimer key={t.id} timer={t} />
              ) : (
                <div className="bx-timer bx-timer-done" key={t.id} title={`${t.timerCode || t.timerType} · ${t.status}${t.firesAt ? ` · ${t.firesAt}` : ""}`}>
                  <div className="bx-timer-head">
                    <span className="bx-dot" style={{ background: TIMER_TONE[t.status] ?? "var(--ink-3)" }} />
                    <span className="bx-timer-code">{labelForTimer(t)}</span>
                    <span className="bx-muted">{t.status.toLowerCase()}</span>
                  </div>
                </div>
              ),
            )}
          </div>
        )}
        {hiddenPassed > 0 && (
          <span className="bx-muted" style={{ fontSize: 10.5 }}>
            +{hiddenPassed} earlier acknowledgement window{hiddenPassed === 1 ? "" : "s"} (stage passed)
          </span>
        )}
      </div>

      <div className="bx-events">
        {events.length === 0 ? (
          <p className="bx-muted" style={{ margin: 0 }}>No backend events yet — take an action and they'll appear here.</p>
        ) : (
          events.map((e) => {
            const h = humanizeTrace(e, new Date(now));
            return (
              <div className="bx-event" key={e.id}>
                <span className="bx-dot" style={{ background: TONE_COLOR[h.tone] }} />
                <div className="bx-event-body">
                  <div className="bx-event-title">
                    <span className="bx-event-cat">{h.category}</span>
                    {h.title}
                    {h.stage && <span className="bx-event-stage mono">{h.stage}</span>}
                  </div>
                  {h.detail && <div className="bx-event-detail">{h.detail}</div>}
                  <div className="bx-event-meta mono">
                    {h.actor} · {h.actorLevel} · {h.whenRelative}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
