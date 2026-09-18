"use client";

/**
 * The cards a booking's situation adds above any step (prototype `V16.caseCards`): parked,
 * cancelled, a no-show, earlier passes and amendments, and the credit ceiling while the guest is
 * in the house. Each appears only when it applies. Figures are the backend's own — the
 * cancellation's are the ones its record carries.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { getSegmentHistory } from "@/lib/api/entries";
import type { TraceEvent } from "@/lib/trace/humanize";
import { fmtDateTime, fmtInstantDate, money } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import type { EntryDetail } from "@/types/api";
import { Fact, Facts, PaperDrawer, SeeRow, StepCard, words, type PaperRef } from "./kit";

const PASS_WORD: Record<string, string> = {
  NEW_BOOKING: "new dates or rooms",
  ROOM_CHANGE: "a room change",
  RATE_REVISION: "a change to the rate",
  DATE_EXTENSION: "an extended stay",
  EARLY_DEPARTURE: "an early departure",
  BILLING_MODEL_CHANGE: "a change of who pays",
  GUEST_COMPOSITION_CHANGE: "a change to the party",
  COMPLAINT_RESOLUTION: "a complaint",
};

const NO_SHOW_PATH: Record<string, string> = {
  SUB_PATH_1: "no contact after the cut-off, determined by the FOM",
  DEFER: "deferred — waiting for the written word",
  REACTIVATE: "the guest turned up — the booking went on",
};

const stepWord = (stage?: string | null) => (stage ? STEP_NAMES[stepNoOfStage(stage) - 1] : "");

type CancelPayload = { reason?: string; penalty?: number; netRefund?: number; advanceTotal?: number; penaltyWaiverRequested?: boolean };

export function CaseCards({
  entry,
  step,
  events,
  tz,
  park,
  onResume,
  resuming,
  onHistory,
}: {
  entry: EntryDetail;
  step: number;
  events: TraceEvent[];
  tz: string;
  park: { reason: string | null; followUpAt: string | null; lapsesAt: string | null } | null;
  onResume?: () => void;
  resuming?: boolean;
  onHistory: () => void;
}) {
  const { session } = useSession();
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const cur = "BTN";

  const passes = useQuery({
    queryKey: ["segment-history", entry.id, entry.segmentNumber ?? 1],
    queryFn: () => getSegmentHistory(session!, entry.id),
    enabled: !!session && (entry.segmentNumber ?? 1) > 1,
  });
  const inHouse = step >= 6 && step <= 8 && !!entry.folio;
  const pay = usePaymentStatus(entry.id, { enabled: inHouse });

  const cards: React.ReactNode[] = [];

  if (entry.status === "PARKED" && park) {
    cards.push(
      <StepCard key="parked" title="Parked">
        <Facts wide>
          <Fact k="Why">{park.reason}</Fact>
          <Fact k="Follow up">{park.followUpAt ? fmtInstantDate(park.followUpAt, tz) : null}</Fact>
          <Fact k="Lapses">{park.lapsesAt ? fmtDateTime(park.lapsesAt, tz) : null}</Fact>
        </Facts>
        {onResume ? (
          <div style={{ marginTop: 10 }}>
            <SeeRow label={resuming ? "Resuming…" : "Resume"} kind="secondary" note="returns the booking to where it was; the follow-up is cleared" onClick={resuming ? undefined : onResume} />
          </div>
        ) : null}
      </StepCard>,
    );
  }

  if (entry.status === "CANCELLED") {
    const ev = events.find((e) => /CANCELLED$/.test(e.eventType) && e.payload && typeof e.payload === "object");
    const p = (ev?.payload ?? {}) as CancelPayload;
    cards.push(
      <StepCard key="cancelled" title="Cancelled" sealed>
        <Facts wide>
          <Fact k="When">{ev ? fmtDateTime(ev.timestamp, tz) : null}</Fact>
          <Fact k="Reason">{p.reason}</Fact>
          <Fact k="Charge" meta={p.penaltyWaiverRequested ? "the GM was asked to waive it" : undefined}>
            {typeof p.penalty === "number" ? (p.penalty > 0 ? money(p.penalty, cur) : "none") : null}
          </Fact>
          {typeof p.advanceTotal === "number" && p.advanceTotal > 0 ? <Fact k="Advance held">{money(p.advanceTotal, cur)}</Fact> : null}
          {typeof p.netRefund === "number" && p.netRefund > 0 ? <Fact k="Refund">{money(p.netRefund, cur)}</Fact> : null}
        </Facts>
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button kind="secondary" compact icon="file" onClick={() => setPaper({ kind: "cancellation", entryId: entry.id, label: "Cancellation confirmation" })}>
            Cancellation confirmation
          </Button>
        </div>
      </StepCard>,
    );
  }

  const ns = entry.noShowDetermination;
  if (ns) {
    cards.push(
      <StepCard key="noshow" title="No-show" sealed>
        <Facts wide>
          <Fact k="Determined">{fmtDateTime(ns.createdAt, tz)}</Fact>
          <Fact k="How">{NO_SHOW_PATH[ns.determinationPath] ?? words(ns.determinationPath)}</Fact>
          <Fact k="Reason">{ns.decisionReason}</Fact>
        </Facts>
      </StepCard>,
    );
  }

  const earlier = (passes.data?.segments ?? []).filter((s) => !s.isActive || s.sealedAt).sort((a, b) => a.segmentNumber - b.segmentNumber);
  const amendments = (passes.data?.segments ?? []).flatMap((s) => s.amendments.map((a) => ({ ...a, pass: s.segmentNumber })));
  if (earlier.length || amendments.length) {
    const opener = (n: number) => passes.data?.segments.find((s) => s.segmentNumber === n + 1);
    cards.push(
      <StepCard key="passes" title="Passes and amendments" acts={<Button kind="quiet" compact icon="history" onClick={onHistory}>See every pass</Button>}>
        <div className="stack sm" style={{ display: "grid", gap: 4 }}>
          {earlier.map((s) => {
            const next = opener(s.segmentNumber);
            const why = next?.openedBy?.modeKey ? PASS_WORD[next.openedBy.modeKey] ?? words(next.openedBy.modeKey) : null;
            return (
              <div key={s.id} className="row-acts" style={{ justifyContent: "space-between" }}>
                <span>
                  Pass {s.segmentNumber} closed
                  {next?.openedBy?.fromStage ? ` · from ${stepWord(next.openedBy.fromStage)} back to ${stepWord(next.openedBy.toStage)}` : ""}
                  {why ? ` · for ${why}` : ""}
                  {next?.openReason ? <span className="meta"> · “{next.openReason.replace(/^[A-Z_]+:\s*/, "")}”</span> : null}
                </span>
                <span className="meta">{s.sealedAt ? fmtDateTime(s.sealedAt, tz) : ""}{s.sealedByName ? ` · ${s.sealedByName}` : ""}</span>
              </div>
            );
          })}
          {amendments.map((a) => (
            <div key={a.id} className="row-acts" style={{ justifyContent: "space-between" }}>
              <span>
                <b>{words(a.amendmentType)}</b> · {a.reason}
              </span>
              <span className="meta">
                at {stepWord(a.stageAtAmendment)} · pass {a.pass} · {fmtDateTime(a.createdAt, tz)}
              </span>
            </div>
          ))}
        </div>
      </StepCard>,
    );
  }

  const ps = pay.data;
  // Once the advance is paid in full the ceiling no longer polices charges — the backend
  // discharges it at posting (2026-08-17) — so the card said "postings stop at it" about a limit
  // that was not in force (2026-09-18). Shown only while it still applies.
  if (inHouse && ps && !ps.paidInFull && (ps.creditExtensionActive || ps.creditExtensionExpired)) {
    cards.push(
      <StepCard key="credit" title="Credit ceiling">
        <Facts wide>
          <Fact k="Extended up to">{ps.ceilingAmount != null ? money(ps.ceilingAmount, cur) : null}</Fact>
          <Fact k="Until">
            {ps.creditExtensionExpiresAt ? (
              <span className={ps.creditExtensionExpired ? "warn-ink" : undefined}>
                {fmtDateTime(ps.creditExtensionExpiresAt, tz)}
                {ps.creditExtensionExpired ? " · the extension has run out" : ""}
              </span>
            ) : (
              "no time limit"
            )}
          </Fact>
          <Fact k="Still owed">{entry.folio?.outstandingBalance != null ? money(entry.folio.outstandingBalance, cur) : null}</Fact>
        </Facts>
        <div className="meta" style={{ marginTop: 6 }}>
          The FOM&rsquo;s extension · the desk is warned near the ceiling, and postings stop at it until credit is extended again or an interim payment is taken
        </div>
      </StepCard>,
    );
  }

  if (cards.length === 0) return null;
  return (
    <div className="steps-canvas">
      {cards}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </div>
  );
}
