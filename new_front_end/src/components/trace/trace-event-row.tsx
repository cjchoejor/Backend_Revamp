"use client";

import { humanizeTrace, type TraceEvent, type TraceTone } from "@/lib/trace/humanize";

const TONE: Record<TraceTone, { dot: string; text: string; chip: string }> = {
  info: { dot: "bg-sky-500", text: "text-sky-600", chip: "bg-sky-500/10 text-sky-600" },
  success: { dot: "bg-emerald-500", text: "text-emerald-600", chip: "bg-emerald-500/10 text-emerald-600" },
  warning: { dot: "bg-amber-500", text: "text-amber-600", chip: "bg-amber-500/10 text-amber-700" },
  critical: { dot: "bg-red-500", text: "text-red-600", chip: "bg-red-500/10 text-red-600" },
};

export function TraceEventRow({ event, compact = false }: { event: TraceEvent; compact?: boolean }) {
  const h = humanizeTrace(event);
  const tone = TONE[h.tone];

  return (
    <div className="flex gap-3 py-2">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone.chip}`}>{h.category}</span>
          <span className="text-sm font-medium text-foreground">{h.title}</span>
        </div>
        {h.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{h.detail}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span title={`Level ${h.actorLevel}`}>{h.actor}</span>
          <span aria-hidden>·</span>
          <span title={h.whenAbsolute}>{h.whenRelative}</span>
          {!compact && h.stage && (
            <>
              <span aria-hidden>·</span>
              <span>{h.stage}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
