"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cpu,
  GitBranch,
  Handshake,
  Layers,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Wrench,
} from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getEntry, getEntryTimers, getEntryTrace, type TimerRecordSummary } from "@/lib/api/entries";
import { labelForTimer } from "@/lib/desk/timers";
import { guestName, stepForStage } from "@/lib/desk/model";
import { humanizeTrace, type TraceEvent, type TraceTone } from "@/lib/trace/humanize";
import {
  BACKEND_SECTIONS,
  STAGE_BACKEND,
  STAGE_ORDER,
  type BackendItem,
  type StageBackend,
} from "@/lib/desk/backend-map";
import type { Stage } from "@/types/api";

const SECTION_ICON: Record<keyof StageBackend, React.ReactNode> = {
  stateMachines: <GitBranch />,
  policies: <ShieldCheck />,
  engines: <Cpu />,
  workersTimers: <Timer />,
  handoffs: <Handshake />,
  services: <Wrench />,
  configKeys: <SlidersHorizontal />,
  // non-section keys (never rendered as sections)
  stage: null,
  deskStep: null,
  summary: null,
};

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

/** Compact "fires in 12 min" / "overdue 3 min" / "—" from an ISO instant. */
function timeUntil(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  const unit =
    min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} hr` : `${Math.round(min / 1440)} day`;
  return ms >= 0 ? `fires in ${unit}` : `overdue ${unit}`;
}

function SectionGroup({ label, icon, items }: { label: string; icon: React.ReactNode; items: BackendItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="bv-sec">
      <div className="bv-sec-h">
        <span className="bv-sec-ic">{icon}</span>
        {label}
        <span className="bv-sec-n">{items.length}</span>
      </div>
      <div className="bv-items">
        {items.map((it) => (
          <div className="bv-item" key={`${label}-${it.name}`}>
            <div className="bv-item-name">{it.name}</div>
            {it.ref && <div className="bv-item-ref mono">{it.ref}</div>}
            <div className="bv-item-detail">{it.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveTimers({ timers, now }: { timers: TimerRecordSummary[]; now: number }) {
  if (timers.length === 0) {
    return <p className="bv-empty">No timers recorded for this stage.</p>;
  }
  return (
    <div className="bv-timers">
      {timers.map((t) => {
        const until = timeUntil(t.firesAt, now);
        return (
          <div className="bv-timer" key={t.id}>
            <span className="bv-dot" style={{ background: TIMER_TONE[t.status] ?? "var(--ink-3)" }} />
            <span className="bv-timer-name" title={t.timerCode || t.timerType}>{labelForTimer(t)}</span>
            <span className={`tag ${t.status === "SCHEDULED" ? "" : "warn"}`} style={{ fontSize: 9.5 }}>
              {t.status}
            </span>
            {t.status === "SCHEDULED" && until && <span className="bv-timer-when">{until}</span>}
          </div>
        );
      })}
    </div>
  );
}

function JourneyList({ events, now }: { events: TraceEvent[]; now: number }) {
  if (events.length === 0) {
    return <p className="bv-empty">Nothing has happened at this stage yet.</p>;
  }
  return (
    <div className="bv-journey">
      {events.map((e) => {
        const h = humanizeTrace(e, new Date(now));
        return (
          <div className="bv-jrow" key={e.id}>
            <span className="bv-dot" style={{ background: TONE_COLOR[h.tone] }} />
            <div className="bv-jbody">
              <div className="bv-jtitle">
                <span className="bv-jcat">{h.category}</span>
                {h.title}
              </div>
              {h.detail && <div className="bv-jdetail">{h.detail}</div>}
              <div className="bv-jmeta mono">
                {h.actor} · {h.actorLevel} · {h.whenRelative}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StageCard({
  data,
  isCurrent,
  open,
  onToggle,
  timers,
  events,
  now,
}: {
  data: StageBackend;
  isCurrent: boolean;
  open: boolean;
  onToggle: () => void;
  timers: TimerRecordSummary[];
  events: TraceEvent[];
  now: number;
}) {
  const step = stepForStage(data.stage);
  return (
    <div className={`bv-stage${isCurrent ? " current" : ""}`}>
      <button type="button" className="bv-stage-head" onClick={onToggle} aria-expanded={open}>
        <span className="bv-stage-badge">{data.stage}</span>
        <span className="bv-stage-titles">
          <span className="bv-stage-label">
            {step.label}
            {isCurrent && <span className="bv-here">you are here</span>}
          </span>
          <span className="bv-stage-summary">{data.summary}</span>
        </span>
        <span className="bv-stage-stats">
          {timers.filter((t) => t.status === "SCHEDULED").length > 0 && (
            <span className="bv-stat" title="active timers">
              <Timer style={{ width: 12, height: 12 }} />
              {timers.filter((t) => t.status === "SCHEDULED").length}
            </span>
          )}
          {events.length > 0 && (
            <span className="bv-stat" title="decision-journey events">
              <Activity style={{ width: 12, height: 12 }} />
              {events.length}
            </span>
          )}
          {open ? <ChevronDown style={{ width: 16, height: 16 }} /> : <ChevronRight style={{ width: 16, height: 16 }} />}
        </span>
      </button>

      {open && (
        <div className="bv-stage-body">
          {/* Live overlay */}
          <div className="bv-live">
            <div className="bv-live-col">
              <div className="bv-live-h">
                <Timer style={{ width: 12, height: 12 }} /> Live timers
              </div>
              <LiveTimers timers={timers} now={now} />
            </div>
            <div className="bv-live-col">
              <div className="bv-live-h">
                <Activity style={{ width: 12, height: 12 }} /> Decision journey
              </div>
              <JourneyList events={events} now={now} />
            </div>
          </div>

          {/* Curated spec map */}
          {BACKEND_SECTIONS.map((s) => (
            <SectionGroup key={s.key} label={s.label} icon={SECTION_ICON[s.key]} items={data[s.key] as BackendItem[]} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BackendView({ entryId }: { entryId: string }) {
  const { session, isLoading: sessionLoading } = useSession();
  const router = useRouter();
  const now = Date.now();

  const entryQuery = useQuery({
    queryKey: ["entry", entryId],
    queryFn: () => getEntry(session!, entryId),
    enabled: !!session && !sessionLoading,
  });
  const timersQuery = useQuery({
    queryKey: ["entry-timers", entryId],
    queryFn: () => getEntryTimers(session!, entryId),
    enabled: !!session && !sessionLoading,
    refetchInterval: 20000,
  });
  const traceQuery = useQuery({
    queryKey: ["entry-trace", entryId],
    queryFn: () => getEntryTrace(session!, entryId, 250),
    enabled: !!session && !sessionLoading,
    refetchInterval: 20000,
  });

  const entry = entryQuery.data ?? null;
  const currentStage = (entry?.currentStage ?? "S1") as Stage;

  const [openStages, setOpenStages] = useState<Record<string, boolean>>({});
  const isOpen = (s: Stage) => openStages[s] ?? s === currentStage;
  const toggle = (s: Stage) => setOpenStages((p) => ({ ...p, [s]: !(p[s] ?? s === currentStage) }));

  // Group live timers + journey events by their stage context.
  const timersByStage = useMemo(() => {
    const map: Record<string, TimerRecordSummary[]> = {};
    for (const t of timersQuery.data?.items ?? []) {
      const key = (t.stageContext ?? "S1").toUpperCase();
      (map[key] ??= []).push(t);
    }
    return map;
  }, [timersQuery.data]);

  const eventsByStage = useMemo(() => {
    const map: Record<string, TraceEvent[]> = {};
    const sorted = [...(traceQuery.data?.items ?? [])].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    for (const e of sorted) {
      const key = (e.stageContext ?? "").toUpperCase();
      if (!key) continue;
      (map[key] ??= []).push(e);
    }
    return map;
  }, [traceQuery.data]);

  if (sessionLoading || entryQuery.isLoading) {
    return (
      <div className="view">
        <p className="lead">Opening the backend view…</p>
      </div>
    );
  }
  if (entryQuery.isError || !entry) {
    return (
      <div className="view">
        <p className="lead">Couldn&rsquo;t load this booking.</p>
        <Link className="btn btn-ghost btn-sm" href="/desk/bookings" style={{ marginTop: 12 }}>
          Back to bookings
        </Link>
      </div>
    );
  }

  const name = guestName(entry.guestProfile ?? entry.inquiry?.guestProfile);
  const totalEvents = traceQuery.data?.items?.length ?? 0;
  const activeTimers = (timersQuery.data?.items ?? []).filter((t) => t.status === "SCHEDULED").length;

  return (
    <section className="view bv-root">
      <button className="ws-back" onClick={() => router.push(`/desk/bookings/${entryId}`)} style={{ marginBottom: 12 }}>
        <ChevronLeft />
        Back to workspace
      </button>

      <div className="bv-top">
        <div>
          <div className="eyebrow">
            <Layers style={{ width: 12, height: 12, marginRight: 5, verticalAlign: "-2px" }} />
            Under the hood
          </div>
          <h1 className="h-lg" style={{ margin: "4px 0 4px" }}>
            What the backend is doing
          </h1>
          <p className="lead" style={{ margin: 0 }}>
            <b>{name}</b> · {entry.id} — every policy, state machine, engine, worker, timer and handoff across the
            S1–S9 journey, with live timers and the decision journey overlaid. Currently at{" "}
            <b>{stepForStage(currentStage).label}</b>.
          </p>
        </div>
        <div className="bv-kpis">
          <div className="bv-kpi">
            <span className="bv-kpi-n">{activeTimers}</span>
            <span className="bv-kpi-l">active timers</span>
          </div>
          <div className="bv-kpi">
            <span className="bv-kpi-n">{totalEvents}</span>
            <span className="bv-kpi-l">journey events</span>
          </div>
        </div>
      </div>

      <p className="bv-note">
        Curated from the SIG / DEV-SPEC and verified against the code — references point at the real module or
        policy id. Timers and the decision journey are live (auto-refresh).
      </p>

      <div className="bv-stages">
        {STAGE_ORDER.map((s) => (
          <StageCard
            key={s}
            data={STAGE_BACKEND[s]}
            isCurrent={s === currentStage}
            open={isOpen(s)}
            onToggle={() => toggle(s)}
            timers={timersByStage[s] ?? []}
            events={eventsByStage[s] ?? []}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
