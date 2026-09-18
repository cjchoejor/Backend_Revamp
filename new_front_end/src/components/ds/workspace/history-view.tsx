"use client";

/**
 * History — "how it got here" (the 14 Sep storyboards HISTORY-1…4).
 *
 * "As it stands" first: the stay, the rate, the rooms, who pays, the advance, the position, the
 * disputes and papers — each the backend's own figure. Then every act, newest first, in chapters
 * by step (the booking's current step open), each chapter under day headings, each act time
 * first with who did it. The lenses narrow the same record: Money, Papers, Requests, Changes,
 * Approvals, Messages. Nothing here is ever edited; the system's own bookkeeping is left to
 * Under the hood.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, EmptyState, Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { getEntryTrace, type EntryBillingSummary } from "@/lib/api/entries";
import type { TraceEvent } from "@/lib/trace/humanize";
import { fmtInstantDate, fmtRange, fmtTime, money, nightsOf, plural } from "@/lib/ds/format";
import { rateWords } from "@/lib/ds/rates";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import { isHousekeeping, traceDetail, traceWords } from "@/lib/ds/trace-words";
import { reservedThisPass } from "@/lib/desk/workspace";
import { SegmentHistoryPanel } from "@/components/desk/workspace/segment-history";
import type { EntryDetail } from "@/types/api";

type Lens = "all" | "money" | "papers" | "requests" | "changes" | "approvals" | "messages";

const LENSES: ReadonlyArray<readonly [Lens, string]> = [
  ["all", "Everything"],
  ["money", "Money"],
  ["papers", "Papers"],
  ["requests", "Requests"],
  ["changes", "Changes"],
  ["approvals", "Approvals"],
  ["messages", "Messages"],
];

const LENS_TEST: Record<Exclude<Lens, "all">, RegExp> = {
  money: /PAYMENT|CHARGE|CORRECTION|CREDIT_NOTE|WRITE_OFF|WRITEOFF|SETTLE|REFUND|INTERIM|ADVANCE|NIGHT_AUDIT\.|RECONCIL|PENALT/,
  papers: /QUOTATION\.(CREATED|SENT|SUPERSEDED|EXPIRED)|INVOICE\.|PROFORMA|VOUCHER|CONFIRMATION_CONFIRMATION|MASTER_BILL|STATEMENT|CANCELLATION_CONFIRMATION|RESERVATION\.CONFIRMATION/,
  requests: /PREFERENCE|REQUEST|SPECIAL/,
  changes: /TRANSITION|BACKFLOW|REENTRY|AMEND|ROOM_CHANGE|BED_TYPE|EXTENSION|EARLY_DEPARTURE|BILLING_MODEL|INTAKE|CONFIGURATION_SELECTED|HOLD|PARK|CANCELLED|EXPIRED|CLOSED|ROOM_KEY|CHECK_IN|ACTIVATION|ASSIGN/,
  approvals: /APPROV|OVERRIDE|AUTHORITY|WAIV|CREDIT_EXTENSION|VERIFIED|ESCALAT|ACCEPTED|CONFIRMED|DETERMIN/,
  messages: /EMAIL|ACKNOWLEDGEMENT|COMMUNICATION|REMINDER|MESSAGE/,
};

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

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};

export function HistoryView({
  entry,
  billing,
  tz,
  onOpenedPass,
}: {
  entry: EntryDetail;
  billing: EntryBillingSummary | null;
  tz: string;
  onOpenedPass: (stage: string) => void;
}) {
  const { session } = useSession();
  const trace = useQuery({
    queryKey: ["entry-trace", entry.id, 300],
    queryFn: () => getEntryTrace(session!, entry.id, 300),
    enabled: !!session,
  });
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const [lens, setLens] = useState<Lens>("all");
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

  /* ---- as it stands ---- */
  const co = entry.actualCheckOutDate ?? entry.checkOutDate;
  const nights = nightsOf(entry.checkInDate, co);
  const rooms = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const res = reservedThisPass(entry) ? entry.reservation : null;
  const cur = billing?.currency ?? "BTN";
  const moves = Math.max(0, (entry.folio?.billingModelTransitions ?? []).length - 1);
  const openDisputes = (entry.disputes ?? []).filter((d) => !/CLOSED|RESOLVED/.test(String((d as { state?: string }).state ?? ""))).length;
  const voucherSent = !!entry.reservation?.confirmationVoucherSent;

  const stands: Array<{ k: string; v: React.ReactNode; meta?: React.ReactNode }> = [
    {
      k: "Stay",
      v: `${fmtRange(entry.checkInDate, co)}${nights ? ` · ${plural(nights, "night")}` : ""}`,
      meta: (entry.segmentNumber ?? 1) > 1 ? `pass ${entry.segmentNumber} · changed along the way` : "as booked",
    },
    {
      k: "Rate",
      v: res ? rateWords(billing, res.frozenRate, cur) ?? "—" : billing?.stayTotal?.amount != null ? money(billing.stayTotal.amount, cur) : "—",
      meta: res ? "as reserved" : billing?.stayTotal?.amount != null ? "the stay, as quoted" : "no quotation yet",
    },
    {
      k: "Rooms",
      v: rooms.length ? `${rooms.length} · ${rooms.join(", ")}` : `${entry.numberOfRooms ?? "—"}`,
      meta: rooms.length ? "assigned" : "not yet assigned",
    },
    {
      k: "Billing",
      v: entry.folio?.billingModel ? BILLING_WORD[entry.folio.billingModel] ?? entry.folio.billingModel : "not set yet",
      meta: moves > 0 ? `changed ${plural(moves, "time")}, with a reason` : undefined,
    },
    {
      k: "Advance",
      v: pay.data ? `${money(pay.data.totalReceived, cur)} received` : "—",
      meta: pay.data?.paymentPlan ? "a payment plan is on record" : pay.data?.creditExtensionActive ? "credit extended by the FOM" : undefined,
    },
    {
      k: "Position",
      v: billing?.folio?.outstandingBalance != null ? `${money(billing.folio.outstandingBalance, cur)} owing` : "—",
      meta:
        billing?.folio?.billedSoFar != null
          ? `${money(billing.folio.paymentsReceived ?? 0, cur)} received · ${money(billing.folio.billedSoFar, cur)} posted`
          : undefined,
    },
    { k: "Requests", v: "not tracked yet", meta: "requests as records are BE-64" },
    { k: "Disputes · papers", v: `${openDisputes} open · voucher ${voucherSent ? "sent" : "not sent"}` },
  ];

  return (
    <>
      <h3>
        History <span className="need">how it got here</span>
      </h3>
      <div className="steps-canvas">
        <div className="card">
          <div className="card-top">
            <h4>As it stands</h4>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "var(--s4)" }}>
            {stands.map((s) => (
              <div key={s.k} style={{ display: "grid", gap: 2 }}>
                <span className="meta">{s.k}</span>
                <b>{s.v}</b>
                {s.meta ? <span className="meta">{s.meta}</span> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-top">
            <h4>History</h4>
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
