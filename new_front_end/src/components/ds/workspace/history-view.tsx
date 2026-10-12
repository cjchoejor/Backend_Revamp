"use client";

/**
 * History — "how it got here" (the 14 Sep storyboards HISTORY-1…4).
 *
 * Every act, newest first, in chapters by step (the booking's current step open), each chapter
 * under day headings, each act time first with who did it. The inner tabs narrow the same record
 * (2026-10-12, operator): All · Changes · Price & payments · Approvals · Desk notes. Nothing here
 * is ever edited; the system's own bookkeeping is left to Under the hood.
 *
 * "As it stands" left on 2026-10-12: it restated Booking details and Charges & payments, and the
 * operator's rule for that pass was that nothing on the booking shows twice.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { getEntryTrace } from "@/lib/api/entries";
import type { TraceEvent } from "@/lib/trace/humanize";
import { fmtInstantDate, fmtTime, plural } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import { isHousekeeping, traceDetail, traceWords } from "@/lib/ds/trace-words";
import { SegmentHistoryPanel } from "@/components/desk/workspace/segment-history";
import type { EntryDetail } from "@/types/api";

type Lens = "all" | "changes" | "money" | "approvals" | "notes";

const LENSES: ReadonlyArray<readonly [Lens, string]> = [
  ["all", "All"],
  ["changes", "Changes"],
  ["money", "Price & payments"],
  ["approvals", "Approvals"],
  ["notes", "Desk notes"],
];

const LENS_TEST: Record<Exclude<Lens, "all">, RegExp> = {
  changes:
    /TRANSITION|BACKFLOW|REENTRY|AMEND|ROOM_CHANGE|BED_TYPE|EXTENSION|EARLY_DEPARTURE|BILLING_MODEL|INTAKE|CONFIGURATION_SELECTED|HOLD|PARK|CANCELLED|EXPIRED|CLOSED|ROOM_KEY|CHECK_IN|ACTIVATION|ASSIGN|CALLER|SOURCE_CHANGED|GUEST_NAMED|GUEST_REQUEST|PREFERENCE|DECLINED/,
  money:
    /PAYMENT|CHARGE|CORRECTION|CREDIT_NOTE|WRITE_OFF|WRITEOFF|SETTLE|REFUND|INTERIM|ADVANCE|NIGHT_AUDIT\.|RECONCIL|PENALT|DISCOUNT|REPRICE|QUOTATION\.(CREATED|SUPERSEDED|ACCEPTED)|INVOICE\.(CREATED|ISSUED)/,
  approvals: /APPROV|OVERRIDE|AUTHORITY|WAIV|CREDIT_EXTENSION|VERIFIED|ESCALAT|ACCEPTED|CONFIRMED|DETERMIN/,
  notes: /^BOOKING_NOTE\./,
};

const isLens = (v: string | null | undefined): v is Lens => !!v && LENSES.some(([k]) => k === v);

const inLens = (ev: TraceEvent, lens: Lens) => lens === "all" || LENS_TEST[lens].test(ev.eventType);

const whoDid = (ev: TraceEvent) =>
  ev.actorId === "SYSTEM" || ev.actorLevel === "SYSTEM" || ev.actorName === "SYSTEM"
    ? /NIGHT_AUDIT/.test(ev.eventType)
      ? "night audit"
      : "system"
    : ev.actorName ?? ev.actorId;

/** The step an act belongs to: where the booking was when it happened. */
function chapterOf(ev: TraceEvent): number {
  const code = ev.stageContext ?? ((ev.payload ?? {}) as { stage?: string }).stage ?? null;
  return code && /^S[1-9]$/.test(code) ? stepNoOfStage(code) : 0;
}

export function HistoryView({
  entry,
  tz,
  initialLens,
  onOpenedPass,
}: {
  entry: EntryDetail;
  tz: string;
  /** Opened from another tab on one of the inner tabs — Charges & payments opens Price & payments. */
  initialLens?: string | null;
  onOpenedPass: (stage: string) => void;
}) {
  const { session } = useSession();
  const trace = useQuery({
    queryKey: ["entry-trace", entry.id, 300],
    queryFn: () => getEntryTrace(session!, entry.id, 300),
    enabled: !!session,
  });
  const [lens, setLens] = useState<Lens>(isLens(initialLens) ? initialLens : "all");
  const [showPasses, setShowPasses] = useState(false);

  const all = useMemo(() => (trace.data?.items ?? []).filter((e) => !isHousekeeping(e.eventType)), [trace.data]);
  const shown = useMemo(() => all.filter((e) => inLens(e, lens)), [all, lens]);
  const chapters = useMemo(() => {
    const m = new Map<number, TraceEvent[]>();
    for (const ev of shown) m.set(chapterOf(ev), [...(m.get(chapterOf(ev)) ?? []), ev]);
    return [...m.entries()].sort((a, b) => (b[1][0]?.timestamp ?? "").localeCompare(a[1][0]?.timestamp ?? ""));
  }, [shown]);
  const current = stepNoOfStage(entry.currentStage);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const isOpen = (n: number, i: number) => open[n] ?? (n === current || (i === 0 && !chapters.some(([k]) => k === current)));

  return (
    <>
      <h3>
        History <span className="need">how it got here</span>
      </h3>
      <div className="steps-canvas">
        <div className="card">
          <div className="card-top">
            <h4>Everything that happened</h4>
          </div>
          <div className="row-acts" style={{ marginBottom: 8 }}>
            <div className="filters choice">
              {LENSES.map(([k, label]) => (
                <Button key={k} kind={k === lens ? "secondary" : "quiet"} compact aria-pressed={k === lens} onClick={() => setLens(k)}>
                  {label}
                </Button>
              ))}
            </div>
            <span className="meta">
              {shown.length} of {plural(all.length, "act")} · newest first · nothing here is ever edited
            </span>
          </div>
          {trace.isLoading ? (
            <p className="meta">Reading the record…</p>
          ) : chapters.length === 0 ? (
            <EmptyState title={lens === "all" ? "Nothing recorded yet" : "Nothing of this kind yet"} />
          ) : (
            chapters.map(([n, evs], i) => {
              const people = [...new Set(evs.map(whoDid).filter((w) => w !== "system" && w !== "night audit"))];
              const first = evs[evs.length - 1];
              const last = evs[0];
              const openNow = isOpen(n, i);
              const days = new Map<string, TraceEvent[]>();
              for (const ev of evs) {
                const d = fmtInstantDate(ev.timestamp, tz);
                days.set(d, [...(days.get(d) ?? []), ev]);
              }
              return (
                <div key={n} style={{ borderTop: "1px solid var(--line)" }}>
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [n]: !openNow }))}
                    aria-expanded={openNow}
                    style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "10px 0", background: "none", border: 0, cursor: "pointer", textAlign: "left" }}
                  >
                    <span>
                      <b style={{ fontSize: "var(--t-lead)" }}>{n ? STEP_NAMES[n - 1] : "Around the booking"}</b>
                      <span className="meta">
                        {" "}
                        · {plural(evs.length, "act")} · {fmtInstantDate(first.timestamp, tz)}
                        {fmtInstantDate(first.timestamp, tz) !== fmtInstantDate(last.timestamp, tz) ? ` → ${fmtInstantDate(last.timestamp, tz)}` : ""}
                        {people.length ? ` · ${people.join(", ")}` : ""}
                      </span>
                    </span>
                    <span style={{ display: "inline-flex", transform: openNow ? "rotate(90deg)" : undefined, transition: "transform .15s" }}>
                      <Icon name="chev" />
                    </span>
                  </button>
                  {openNow ? (
                    <div style={{ paddingBottom: 10 }}>
                      {[...days.entries()].map(([day, list]) => (
                        <div key={day}>
                          <div className="sm" style={{ fontWeight: 700, color: "var(--ink-2)", margin: "8px 0 4px" }}>
                            {day}
                          </div>
                          {list.map((ev) => {
                            const detail = traceDetail(ev);
                            return (
                              <div key={ev.id} style={{ display: "grid", gridTemplateColumns: "72px 1fr auto", gap: "0 10px", padding: "5px 0", alignItems: "baseline" }}>
                                <span className="meta">{fmtTime(ev.timestamp, tz)}</span>
                                <span>
                                  <span>{traceWords(ev)}</span>
                                  {detail ? (
                                    <span className="meta" style={{ display: "block" }}>
                                      {detail}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="meta" style={{ textAlign: "right" }}>
                                  {whoDid(ev)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          <div className="meta" style={{ marginTop: 8 }}>
            The system&rsquo;s own bookkeeping — timers set, documents printed, checks run — is left out here; Under the hood shows every line.
            {all.length >= 300 ? " The newest 300 acts are shown." : ""}
          </div>
        </div>

        <div className="card">
          <div className="card-top">
            <h4>Every pass, in full</h4>
            <Button kind="quiet" compact onClick={() => setShowPasses((v) => !v)}>
              {showPasses ? "Hide" : "Show"}
            </Button>
          </div>
          <div className="meta">A change after reserving closes the current pass and opens a new one; what a closed pass decided stays as it was.</div>
          {showPasses ? (
            <div className="desk-root tool">
              <SegmentHistoryPanel entryId={entry.id} currentStage={entry.currentStage} onSegmentOpened={onOpenedPass} />
            </div>
          ) : null}
        </div>

      </div>
    </>
  );
}
