"use client";

import { useQuery } from "@tanstack/react-query";
import { History, Lock } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getSegmentHistory, type SegmentHistoryItem } from "@/lib/api/entries";
import { stepForStage } from "@/lib/desk/model";
import { moneyOrDash } from "@/lib/desk/workspace";

/**
 * Segment history — "Rounds". One Segment per pass through the stages (Implementation
 * Reference §1.2): a re-entry seals the current pass read-only and opens a new one, so the
 * booking's full story is a stack of rounds. Rendered from the backend aggregation at
 * GET /api/entries/:id/segments — nothing is derived here (money included).
 *
 * Operator language: the desk already says "any later change opens a new round" — this panel
 * is where those rounds live.
 */

const MODE_LABEL: Record<string, string> = {
  NEW_BOOKING: "Re-search / date change",
  ROOM_CHANGE: "Room change",
  RATE_REVISION: "Rate revision",
  DATE_EXTENSION: "Date extension",
  EARLY_DEPARTURE: "Early departure",
  BILLING_MODEL_CHANGE: "Billing model change",
  GUEST_COMPOSITION_CHANGE: "Guest composition change",
  COMPLAINT_RESOLUTION: "Complaint resolution",
};

function stageLabel(stage: string): string {
  const step = stepForStage(stage);
  return step.label;
}

/** "S1 → S4" style path in operator step names: "Inquiry → Confirm". */
function pathText(stages: string[]): string {
  if (!stages.length) return "—";
  return stages.map(stageLabel).join(" → ");
}

/** Humanize a seal cause like "BACKFLOW_S4_TO_S2" / "REENTRY_S3_TO_S1". */
function sealCauseText(cause: string | null): string | null {
  if (!cause) return null;
  const m = cause.match(/^(?:BACKFLOW|REENTRY)_(S\d)_TO_(S\d)$/);
  if (m) return `Re-entered — ${stageLabel(m[1])} back to ${stageLabel(m[2])}`;
  return cause;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${min}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "96px 1fr",
        gap: 8,
        padding: "3px 0",
        fontSize: 11.5,
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "var(--ink-3)" }}>{label}</div>
      <div style={{ color: "var(--ink-2)", wordBreak: "break-word" }}>{children ?? "—"}</div>
    </div>
  );
}

function RoundCard({ seg }: { seg: SegmentHistoryItem }) {
  const acceptedQuote = seg.quotations.find((q) => q.state === "ACCEPTED") ?? null;
  const modeLabel = seg.openedBy?.modeKey ? MODE_LABEL[seg.openedBy.modeKey] ?? seg.openedBy.modeKey : null;
  const sealText = sealCauseText(seg.sealCause);
  return (
    <div
      style={{
        border: `1px solid ${seg.isActive ? "var(--green)" : "var(--line)"}`,
        borderRadius: "var(--r-md)",
        background: seg.isActive ? "var(--paper)" : "var(--cream-2)",
        padding: "10px 12px",
        marginTop: 8,
        opacity: seg.isActive ? 1 : 0.88,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>Round {seg.segmentNumber}</span>
        {seg.isActive ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              padding: "1px 7px",
              borderRadius: 999,
              background: "var(--green-t)",
              color: "var(--green)",
            }}
          >
            Active
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: "uppercase",
              padding: "1px 7px",
              borderRadius: 999,
              background: "var(--cream-3, rgba(0,0,0,0.05))",
              color: "var(--ink-3)",
            }}
          >
            <Lock style={{ width: 9, height: 9 }} />
            Sealed
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-3)", fontFamily: "var(--deskmono)" }}>
          {fmtDate(seg.startedAt)}
        </span>
      </div>

      <Row label="Journey">{pathText(seg.stagePath)}</Row>

      {seg.segmentNumber === 1 ? (
        <Row label="Started as">New booking</Row>
      ) : (
        <Row label="Opened by">
          {modeLabel ?? "Re-entry"}
          {seg.openedBy?.fromStage && seg.openedBy?.toStage
            ? ` · ${stageLabel(seg.openedBy.fromStage)} → ${stageLabel(seg.openedBy.toStage)}`
            : ""}
        </Row>
      )}

      {seg.openReason && seg.openReason !== "BOOKING_CREATED" ? (
        <Row label="Reason">
          {/* The complaint path stores "COMPLAINT_RESOLUTION: <text>" — the mode is already on
              the line above, so show just the operator's text. */}
          {seg.openedBy?.modeKey && seg.openReason.startsWith(`${seg.openedBy.modeKey}: `)
            ? seg.openReason.slice(seg.openedBy.modeKey.length + 2)
            : seg.openReason}
        </Row>
      ) : null}

      {seg.reservation ? (
        <Row label="Confirmed at">
          {moneyOrDash(seg.reservation.frozenRate, null)} / night · {fmtDate(seg.reservation.frozenCheckIn)} →{" "}
          {fmtDate(seg.reservation.frozenCheckOut)}
          {seg.reservation.confirmedByName ? ` · by ${seg.reservation.confirmedByName}` : ""}
        </Row>
      ) : null}

      {acceptedQuote ? (
        <Row label="Quote">
          {acceptedQuote.referenceNumber ?? acceptedQuote.id} · v{acceptedQuote.versionNumber} ·{" "}
          {moneyOrDash(acceptedQuote.totalAmount, acceptedQuote.currency)}
        </Row>
      ) : seg.quotations.length ? (
        <Row label="Quotes">
          {seg.quotations.length} drafted · none accepted this round
        </Row>
      ) : null}

      {seg.amendments.length ? (
        <Row label="Amendments">
          {seg.amendments.map((a) => a.amendmentType).join(", ")}
        </Row>
      ) : null}

      {seg.billingModelTransitions.length ? (
        <Row label="Billing">
          {seg.billingModelTransitions
            .map((b) => (b.fromModel ? `${b.fromModel} → ${b.toModel}` : b.toModel))
            .join(", ")}
        </Row>
      ) : null}

      {!seg.isActive ? (
        <Row label="Ended">
          {sealText ?? "Sealed"}
          {seg.sealedAt ? ` · ${fmtDateTime(seg.sealedAt)}` : ""}
          {seg.sealedByName ? ` · by ${seg.sealedByName}` : ""}
        </Row>
      ) : null}
    </div>
  );
}

export function SegmentHistoryPanel({ entryId }: { entryId: string }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["segment-history", entryId],
    queryFn: () => getSegmentHistory(session!, entryId),
    enabled: !!session,
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}>Loading rounds…</div>;
  }
  if (q.isError || !q.data) {
    return (
      <div style={{ fontSize: 12, color: "var(--stop)", padding: "8px 0" }}>
        Couldn&rsquo;t load the round history.
      </div>
    );
  }

  const segs = q.data.segments;
  const sealedCount = segs.filter((s) => !s.isActive).length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <History style={{ width: 13, height: 13, color: "var(--green)" }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>
          {segs.length === 1 ? "One round so far" : `${segs.length} rounds`}
        </span>
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "2px 0 6px", lineHeight: 1.5 }}>
        Each round is one pass through the journey. A change after confirmation doesn&rsquo;t edit the
        old round — it seals it as history and opens a fresh one.
        {sealedCount > 0 ? ` ${sealedCount} sealed round${sealedCount === 1 ? "" : "s"} below are read-only.` : ""}
      </p>
      {/* Newest first — the active round on top, history beneath. */}
      {[...segs].reverse().map((s) => (
        <RoundCard key={s.id} seg={s} />
      ))}
    </div>
  );
}
