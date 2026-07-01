"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, Timer } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getEntryTimers, getEntryTrace, type TimerRecordSummary } from "@/lib/api/entries";
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

/** Legend of the category colours — shown once at the top of a BackendRail. */
export function CategoryLegend() {
  return (
    <div className="bx-legend">
      {(Object.keys(CATEGORY_STYLE) as BackendCategory[])
        .filter((k) => k !== "other")
        .map((k) => (
          <span className="bx-legend-item" key={k}>
            <span className="bx-rdot" style={{ background: CATEGORY_STYLE[k].bd }} />
            {CATEGORY_STYLE[k].label}
          </span>
        ))}
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
  entryId,
  groups,
  activeKeys,
  firingKey,
}: {
  /** Omit on the pre-S1 intake page — no entry exists yet, so no live feed. */
  entryId?: string;
  groups: RailGroup[];
  activeKeys?: string[];
  firingKey?: string | null;
}) {
  const activeSet = new Set(activeKeys ?? []);
  return (
    <div className="bx-rail">
      {entryId && <LiveBackendFeed entryId={entryId} limit={14} />}
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
                  <span className="bx-g-run">running now</span>
                ) : active ? (
                  <span className="bx-g-used">used</span>
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
                      style={{
                        borderLeftColor: c.bd,
                        background: active ? c.bg : "#fff",
                      }}
                    >
                      <span className="bx-rdot" style={{ background: c.bd }} />
                      <span className="bx-rname" style={{ color: active ? c.fg : "var(--ink-2)", fontWeight: active ? 600 : 500 }}>
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

function timeUntil(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const unit = min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} hr` : `${Math.round(min / 1440)} day`;
  return ms >= 0 ? `in ${unit}` : `overdue ${unit}`;
}

/**
 * Live, auto-refreshing feed of what the backend actually did for this entry —
 * active timers + the decision journey (TraceEvents). Drop it on a stage page so the
 * operator sees policies firing / timers arming in real time as they act.
 */
export function LiveBackendFeed({ entryId, limit = 24 }: { entryId: string; limit?: number }) {
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

  const timers = (timersQuery.data?.items ?? []) as TimerRecordSummary[];
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

      <div className="bx-feed-row">
        <Timer style={{ width: 12, height: 12, color: "var(--ink-3)" }} />
        <span className="bx-feed-label">Timers</span>
        {timers.length === 0 ? (
          <span className="bx-muted">none yet</span>
        ) : (
          <span className="bx-timer-list">
            {timers.map((t) => (
              <span className="bx-timer" key={t.id} title={`${t.status}${t.firesAt ? ` · ${t.firesAt}` : ""}`}>
                <span className="bx-dot" style={{ background: TIMER_TONE[t.status] ?? "var(--ink-3)" }} />
                <span className="mono">{t.timerCode || t.timerType}</span>
                {t.status === "SCHEDULED" ? (
                  <span className="bx-muted">{timeUntil(t.firesAt, now) ?? ""}</span>
                ) : (
                  <span className="bx-muted">{t.status.toLowerCase()}</span>
                )}
              </span>
            ))}
          </span>
        )}
        <span className="bx-feed-count">{activeTimers.length} active</span>
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
