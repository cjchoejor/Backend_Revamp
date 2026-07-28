"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, History, Lock, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import {
  duplicateSegment,
  DUPLICATE_ROUTES,
  getSegmentHistory,
  recallSegment,
  type SegmentHistoryItem,
  type SegmentRecallOutcome,
} from "@/lib/api/entries";
import { ApiError } from "@/lib/api/client";
import { DESK_STEPS, stepForStage } from "@/lib/desk/model";
import { moneyOrDash } from "@/lib/desk/workspace";

/**
 * Segment history. One Segment per pass through the stages (Implementation Reference §1.2):
 * a re-entry seals the current pass read-only and opens a new one, so the booking's full story
 * is a stack of segments. Rendered from the backend aggregation at
 * GET /api/entries/:id/segments — nothing is derived here (money included).
 *
 * Each sealed segment can be REUSED as the current segment's basis. That is a
 * recall-plus-revalidate (Canon Block 10 §59), not a copy: the preview call re-runs the
 * availability engine against present state and reports what moved; applying it writes a NEW
 * configuration on the current segment and never touches the sealed one. Any material change
 * needs FOM (L2) authority — §59 M.4.
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

/** Stages where swapping the commercial basis is still legitimate (mirrors the backend gate). */
const RECALLABLE_STAGES = new Set(["S1", "S2", "S3"]);

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

function stageLabel(stage: string): string {
  return stepForStage(stage).label;
}

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
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(iso)} ${hh}:${min}`;
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
        gridTemplateColumns: "112px 1fr",
        gap: 10,
        padding: "3px 0",
        fontSize: 12,
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "var(--ink-3)" }}>{label}</div>
      <div style={{ color: "var(--ink-2)", wordBreak: "break-word" }}>{children ?? "—"}</div>
    </div>
  );
}

/**
 * Stage-by-stage drill-in for ONE segment: the nine journey steps, marked by whether this
 * segment actually reached them, each carrying that segment's own records.
 *
 * Honesty note baked into the S3 row: the folio, committed hold, and cancellation disclosure are
 * `entryId @unique` singletons in the schema — one row per booking that persists (and mutates)
 * across every segment, by design (the Implementation Reference is explicit that the entry-level
 * folio "persists through every segment"). So those cannot be shown "as they were" in an earlier
 * segment; only the genuinely segment-scoped records can (availability configuration, quotations,
 * speculative holds, reservation, amendments, billing-model transitions).
 */
function StageBreakdown({ seg }: { seg: SegmentHistoryItem }) {
  const reached = new Set(seg.stagePath);
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--line)" }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 8,
        }}
      >
        Step by step in this segment
      </div>
      {DESK_STEPS.map((step) => {
        const wasReached = reached.has(step.stage);
        const amendmentsHere = seg.amendments.filter((a) => a.stageAtAmendment === step.stage);

        // Segment-scoped records that belong to this step.
        const rows: React.ReactNode[] = [];
        if (step.stage === "S1") {
          for (const c of seg.availabilityConfigs) {
            rows.push(
              <div key={c.id}>
                {c.checkInDate && c.checkOutDate ? `${fmtDate(c.checkInDate)} → ${fmtDate(c.checkOutDate)}` : "Dates not recorded"}
                {c.guestCount != null ? ` · ${c.guestCount} guest${c.guestCount === 1 ? "" : "s"}` : ""}
                {c.rooms.length
                  ? ` · ${c.rooms.map((r) => r.roomNumber ?? r.roomId.slice(0, 6)).join(", ")}`
                  : " · no room chosen"}
                {c.selectionShape === "per-night" ? " (varies per night)" : ""}
                {c.sealedAt ? " · sealed" : c.rooms.length ? " · not sealed" : ""}
                {c.recalledFromSegmentNumber != null ? (
                  <span style={{ color: "var(--green)" }}> · reused from segment {c.recalledFromSegmentNumber}</span>
                ) : null}
              </div>,
            );
          }
        }
        if (step.stage === "S2") {
          for (const q of seg.quotations) {
            rows.push(
              <div key={q.id}>
                {q.referenceNumber ?? q.id} · v{q.versionNumber} · {q.state} ·{" "}
                {moneyOrDash(q.totalAmount, q.currency)}
                {q.acceptedAt ? ` · accepted ${fmtDate(q.acceptedAt)}` : ""}
              </div>,
            );
          }
          if (seg.speculativeHoldCount > 0) {
            rows.push(
              <div key="spec">
                {seg.speculativeHoldCount} speculative hold{seg.speculativeHoldCount === 1 ? "" : "s"} placed
              </div>,
            );
          }
        }
        if (step.stage === "S3") {
          for (const b of seg.billingModelTransitions) {
            rows.push(
              <div key={`${b.toModel}-${b.createdAt}`}>
                Billing model {b.fromModel ? `${b.fromModel} → ${b.toModel}` : `set to ${b.toModel}`}
                {b.changeSource ? ` (${b.changeSource})` : ""}
              </div>,
            );
          }
          if (wasReached) {
            rows.push(
              <div key="entry-level" style={{ color: "var(--ink-3)", fontStyle: "italic" }}>
                Folio, committed hold and cancellation terms are booking-level — they carry across every
                segment, so they show current state rather than this segment&rsquo;s.
              </div>,
            );
          }
        }
        if (step.stage === "S4" && seg.reservation) {
          rows.push(
            <div key={seg.reservation.id}>
              {seg.reservation.id} · {moneyOrDash(seg.reservation.frozenRate, null)}/night ·{" "}
              {fmtDate(seg.reservation.frozenCheckIn)} → {fmtDate(seg.reservation.frozenCheckOut)}
              {seg.reservation.frozenGuestCount != null ? ` · ${seg.reservation.frozenGuestCount} guests` : ""}
              {seg.reservation.frozenBillingModel ? ` · ${seg.reservation.frozenBillingModel}` : ""}
              {seg.reservation.confirmedAt ? ` · confirmed ${fmtDateTime(seg.reservation.confirmedAt)}` : ""}
              {seg.reservation.confirmedByName ? ` by ${seg.reservation.confirmedByName}` : ""}
            </div>,
          );
        }
        for (const a of amendmentsHere) {
          rows.push(
            <div key={a.id}>
              Amendment · {a.amendmentType} ({a.amendmentPath}) — {a.reason}
            </div>,
          );
        }

        return (
          <div
            key={step.order}
            style={{
              display: "grid",
              gridTemplateColumns: "20px 116px 1fr",
              gap: 8,
              alignItems: "baseline",
              padding: "4px 0",
              borderBottom: "1px solid var(--line)",
              opacity: wasReached ? 1 : 0.4,
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 18,
                height: 18,
                borderRadius: 999,
                fontSize: 9.5,
                fontWeight: 700,
                background: wasReached ? "var(--green)" : "transparent",
                color: wasReached ? "#fff" : "var(--ink-3)",
                border: wasReached ? "none" : "1px dashed var(--line)",
              }}
            >
              {step.order}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: wasReached ? 600 : 400, color: "var(--ink-2)" }}>
              {step.label}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
              {rows.length ? (
                rows
              ) : (
                <span style={{ color: "var(--ink-3)" }}>
                  {wasReached ? "Reached — nothing recorded at this step" : "Not reached in this segment"}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RoundCard({
  seg,
  canReuse,
  canDuplicate,
  onReuse,
  onDuplicate,
  reusePending,
}: {
  seg: SegmentHistoryItem;
  canReuse: boolean;
  canDuplicate: boolean;
  onReuse: () => void;
  onDuplicate: () => void;
  reusePending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasBasis = seg.availabilityConfigs.some((c) => c.rooms.length > 0);
  const acceptedQuote = seg.quotations.find((q) => q.state === "ACCEPTED") ?? null;
  const modeLabel = seg.openedBy?.modeKey ? MODE_LABEL[seg.openedBy.modeKey] ?? seg.openedBy.modeKey : null;
  const sealText = sealCauseText(seg.sealCause);
  return (
    <div
      style={{
        border: `1px solid ${seg.isActive ? "var(--green)" : "var(--line)"}`,
        borderRadius: "var(--r-md)",
        background: seg.isActive ? "var(--paper)" : "var(--cream-2)",
        padding: "12px 14px",
        marginTop: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "Hide the step-by-step detail" : "See what was done at each step in this segment"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "inherit",
            color: "var(--ink)",
          }}
        >
          {open ? (
            <ChevronDown style={{ width: 14, height: 14, color: "var(--ink-3)" }} />
          ) : (
            <ChevronRight style={{ width: 14, height: 14, color: "var(--ink-3)" }} />
          )}
          <span style={{ fontSize: 13, fontWeight: 700 }}>Segment {seg.segmentNumber}</span>
        </button>
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
        <Row label="Quotes">{seg.quotations.length} drafted · none accepted in this segment</Row>
      ) : null}

      {seg.amendments.length ? (
        <Row label="Amendments">{seg.amendments.map((a) => a.amendmentType).join(", ")}</Row>
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

      {open ? <StageBreakdown seg={seg} /> : null}

      {hasBasis && (canReuse || canDuplicate) ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px dashed var(--line)",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          {canDuplicate ? (
            <button className="btn btn-ghost btn-sm" onClick={onDuplicate}>
              <Copy style={{ width: 12, height: 12 }} />
              Copy into a new segment
            </button>
          ) : null}
          {!seg.isActive && canReuse ? (
            <button className="btn btn-ghost btn-sm" onClick={onReuse} disabled={reusePending}>
              <RotateCcw style={{ width: 12, height: 12 }} />
              {reusePending ? "Checking…" : "Reuse in this segment"}
            </button>
          ) : null}
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Both re-check availability first — neither changes this segment.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** The revalidation result — what moved since the segment was configured, and the apply gate. */
function RecallPreviewModal({
  outcome,
  actorLevel,
  pending,
  onApply,
  onClose,
}: {
  outcome: SegmentRecallOutcome;
  actorLevel: string | undefined;
  pending: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const needsFom = outcome.requiresFomDecision;
  const hasAuthority = RANK[actorLevel ?? "L1"] >= RANK.L2;
  const blocked = needsFom && !hasAuthority;
  const noneViable = outcome.droppedRooms.length > 0 && outcome.droppedRooms.length === outcome.recalledSelection.distinctRoomCount;

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Reuse a previous segment">
        <div
          className="modal-top"
          style={
            needsFom
              ? { background: "var(--warn-t)", borderBottomColor: "#e6cf9a" }
              : undefined
          }
        >
          <div className="modal-ic" style={needsFom ? { background: "var(--warn)" } : undefined}>
            {needsFom ? <AlertTriangle /> : <RotateCcw />}
          </div>
          <div>
            <h3>Reuse segment {outcome.fromSegmentNumber} on segment {outcome.toSegmentNumber}?</h3>
            <p>
              {outcome.recalledSelection.distinctRoomCount} room
              {outcome.recalledSelection.distinctRoomCount === 1 ? "" : "s"} ·{" "}
              {outcome.recalledSelection.rooms.map((r) => r.roomNumber ?? r.roomId.slice(0, 6)).join(", ")}
            </p>
          </div>
        </div>
        <div className="modal-body">
          <p className="why">
            This doesn&rsquo;t copy segment {outcome.fromSegmentNumber} — it re-checks that basis against today&rsquo;s
            state and starts a fresh selection from it. Segment {outcome.fromSegmentNumber} stays sealed exactly as it is.
          </p>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 6 }}>
              What was re-checked
            </div>
            {(
              [
                ["Rooms still available", outcome.delta.availabilityChanged],
                ["Room condition (deficiencies)", outcome.delta.deficientStatusChanged],
                ["Indicative rate", outcome.delta.pricingChanged],
              ] as Array<[string, boolean]>
            ).map(([label, changed]) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 0" }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: changed ? "var(--warn)" : "var(--ok, var(--green))",
                    flex: "0 0 auto",
                  }}
                />
                <span style={{ color: "var(--ink-2)" }}>{label}</span>
                <span style={{ marginLeft: "auto", color: changed ? "var(--warn)" : "var(--ink-3)", fontWeight: changed ? 600 : 400 }}>
                  {changed ? "changed" : "unchanged"}
                </span>
              </div>
            ))}
          </div>

          {outcome.materialChanges.length ? (
            <div
              style={{
                marginTop: 12,
                background: "var(--warn-t)",
                border: "1px solid #e6cf9a",
                borderRadius: "var(--r-md)",
                padding: "10px 12px",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>
                What changed since segment {outcome.fromSegmentNumber}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
                {outcome.materialChanges.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              {outcome.droppedRooms.length ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 6 }}>
                  {outcome.droppedRooms.length} room{outcome.droppedRooms.length === 1 ? "" : "s"} won&rsquo;t be carried
                  over. You can pick replacements after this.
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 12 }}>
              Nothing has changed — this segment&rsquo;s basis is still exactly as viable as when it was configured.
            </div>
          )}

          {blocked ? (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                background: "var(--stop-t, rgba(155,34,38,0.08))",
                border: "1px solid rgba(155,34,38,0.35)",
                borderRadius: "var(--r-md)",
                padding: "10px 12px",
              }}
            >
              <ShieldAlert style={{ width: 15, height: 15, color: "var(--stop)", flex: "0 0 auto", marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
                Conditions have changed, so this needs <b>FOM approval</b> before it can be reused. Ask a front-office
                manager to apply it — your access level is {actorLevel ?? "L1"}.
              </div>
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={needsFom ? { background: "var(--warn)" } : undefined}
            onClick={onApply}
            disabled={pending || blocked || noneViable}
          >
            <RotateCcw />
            {pending ? "Applying…" : needsFom ? "Approve & reuse" : "Reuse this segment"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Copy into a new segment" — the composite action. Two governed steps behind one dialog: a
 * re-entry opens the new segment (authority enforced per route — e.g. leaving a confirmed
 * booking needs FOM), then the source segment's basis is recalled and revalidated into it.
 */
function DuplicateModal({
  fromSegmentNumber,
  routes,
  stage,
  reason,
  setStage,
  setReason,
  pending,
  onConfirm,
  onClose,
}: {
  fromSegmentNumber: number;
  routes: string[];
  stage: string;
  reason: string;
  setStage: (s: string) => void;
  setReason: (s: string) => void;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Copy into a new segment">
        <div className="modal-top">
          <div className="modal-ic">
            <Copy />
          </div>
          <div>
            <h3>Copy segment {fromSegmentNumber} into a new segment?</h3>
            <p>Opens a fresh segment and carries this one&rsquo;s rooms and dates into it</p>
          </div>
        </div>
        <div className="modal-body">
          <p className="why">
            Segment {fromSegmentNumber} stays sealed exactly as it is. A new segment opens, and this
            segment&rsquo;s basis is re-checked against today&rsquo;s availability before it&rsquo;s carried over — so
            you start from what worked rather than from a blank search.
          </p>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="dup-stage">Where should the new segment start?</label>
            <select id="dup-stage" value={stage} onChange={(e) => setStage(e.target.value)} disabled={pending}>
              {routes.map((r) => (
                <option key={r} value={r}>
                  {stageLabel(r)}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              This is a re-entry, so what it releases depends on where it lands — and higher-impact
              routes need manager authority.
            </span>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="dup-reason">Reason (required)</label>
            <textarea
              id="dup-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. guest wants the original rooms back"
              maxLength={500}
              disabled={pending}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={pending || !reason.trim()}>
            <Copy />
            {pending ? "Copying…" : "Copy into a new segment"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SegmentHistoryPanel({ entryId, currentStage }: { entryId: string; currentStage?: string }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<SegmentRecallOutcome | null>(null);
  const [pendingRound, setPendingRound] = useState<number | null>(null);
  const [dupSeg, setDupSeg] = useState<number | null>(null);
  const [dupStage, setDupStage] = useState<string>("");
  const [dupReason, setDupReason] = useState("");

  const q = useQuery({
    queryKey: ["segment-history", entryId],
    queryFn: () => getSegmentHistory(session!, entryId),
    enabled: !!session,
    refetchInterval: 30_000,
  });

  const previewMutation = useMutation({
    mutationFn: (segmentNumber: number) => recallSegment(session!, entryId, segmentNumber, { apply: false }),
    onSuccess: (out) => setPreview(out),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't re-check that segment"),
    onSettled: () => setPendingRound(null),
  });

  const applyMutation = useMutation({
    mutationFn: (segmentNumber: number) => recallSegment(session!, entryId, segmentNumber, { apply: true }),
    onSuccess: (out) => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["segment-history", entryId] });
      toast.success(
        `Segment ${out.fromSegmentNumber}'s basis is now on segment ${out.toSegmentNumber} — review the selection and save it.`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't reuse that segment"),
  });

  const duplicateMutation = useMutation({
    mutationFn: () => duplicateSegment(session!, entryId, dupSeg!, { toStage: dupStage, reason: dupReason.trim() }),
    onSuccess: (out) => {
      setDupSeg(null);
      setDupReason("");
      void queryClient.invalidateQueries({ queryKey: ["entry", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      void queryClient.invalidateQueries({ queryKey: ["segment-history", entryId] });
      if (out.prefilled) {
        toast.success(
          `Segment ${out.newSegmentNumber} opened at ${stageLabel(out.toStage)} with segment ${out.fromSegmentNumber}'s basis — review the selection and save it.`,
        );
      } else {
        // The re-entry committed; only the basis carry-over was blocked (usually the FOM gate).
        toast.warning(
          `Segment ${out.newSegmentNumber} opened, but the basis needs approval before it carries over. ${out.recallBlocked?.message ?? ""}`,
          { duration: 10_000 },
        );
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't copy that segment"),
  });

  if (q.isLoading) {
    return <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}>Loading segments…</div>;
  }
  if (q.isError || !q.data) {
    return (
      <div style={{ fontSize: 12, color: "var(--stop)", padding: "8px 0" }}>
        Couldn&rsquo;t load the segment history.
      </div>
    );
  }

  const segs = q.data.segments;
  const sealedCount = segs.filter((s) => !s.isActive).length;
  const stage = currentStage ?? q.data.currentStage;
  const recallable = RECALLABLE_STAGES.has(String(stage));
  // Which stages a new segment could open at from here. Empty → no re-entry route leads back to a
  // configuration stage (e.g. already at S1, or in-house past the point of re-quoting).
  const dupRoutes = DUPLICATE_ROUTES[String(stage)] ?? [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <History style={{ width: 14, height: 14, color: "var(--green)" }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
          {segs.length === 1 ? "One segment so far" : `${segs.length} segments`}
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "2px 0 6px", lineHeight: 1.5 }}>
        Each segment is one pass through the journey. A change after confirmation doesn&rsquo;t edit the
        old segment — it seals it as history and opens a fresh one.
        {sealedCount > 0 ? ` ${sealedCount} sealed segment${sealedCount === 1 ? "" : "s"} below are read-only.` : ""}
        {sealedCount > 0 && !recallable
          ? " Reusing an earlier segment is only possible before the booking is frozen."
          : ""}
      </p>
      {/* Newest first — the active segment on top, history beneath. */}
      {[...segs].reverse().map((s) => (
        <RoundCard
          key={s.id}
          seg={s}
          canReuse={recallable}
          canDuplicate={dupRoutes.length > 0}
          reusePending={pendingRound === s.segmentNumber}
          onReuse={() => {
            setPendingRound(s.segmentNumber);
            previewMutation.mutate(s.segmentNumber);
          }}
          onDuplicate={() => {
            setDupSeg(s.segmentNumber);
            setDupStage(dupRoutes[0] ?? "S1");
            setDupReason("");
          }}
        />
      ))}

      {preview ? (
        <RecallPreviewModal
          outcome={preview}
          actorLevel={session?.actorLevel}
          pending={applyMutation.isPending}
          onApply={() => applyMutation.mutate(preview.fromSegmentNumber)}
          onClose={() => setPreview(null)}
        />
      ) : null}

      {dupSeg != null ? (
        <DuplicateModal
          fromSegmentNumber={dupSeg}
          routes={dupRoutes}
          stage={dupStage}
          reason={dupReason}
          setStage={setDupStage}
          setReason={setDupReason}
          pending={duplicateMutation.isPending}
          onConfirm={() => duplicateMutation.mutate()}
          onClose={() => setDupSeg(null)}
        />
      ) : null}
    </div>
  );
}
