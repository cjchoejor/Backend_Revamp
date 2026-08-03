"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, CornerUpLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  backflows,
  BACKFLOWS_BY_STAGE,
  COMPLAINT_APPLICABLE_STAGES,
  type BackflowDescriptor,
} from "@/lib/api/backflows";
import { DateField, nextDayIso } from "@/components/desk/date-field";
import type { EntryDetail } from "@/types/api";
import type { Session } from "@/types/session";

const LEVEL_RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

// Complaint resolution is stage-agnostic (any active stage except S2/S9 per the backend). It isn't
// in BACKFLOWS_BY_STAGE because it isn't keyed to one source stage — surface it separately.
const COMPLAINT_DESCRIPTOR: BackflowDescriptor = {
  key: "complaintToS2",
  label: "Complaint resolution → re-quote",
  toStage: "S2",
  minLevel: "L2",
};

/** Dispatch a backflow by its descriptor key. Mirrors the `backflows` client surface. */
function runBackflow(
  session: Session,
  entryId: string,
  d: BackflowDescriptor,
  reason: string,
  newCheckOutDate: string,
) {
  switch (d.key) {
    case "s2ToS1":
      return backflows.s2ToS1(session, entryId, reason);
    case "s4ToS1":
      return backflows.s4ToS1(session, entryId, reason);
    case "s4ToS2":
      return backflows.s4ToS2(session, entryId, reason);
    case "s4ToS3":
      return backflows.s4ToS3(session, entryId, reason);
    case "s5ToS1":
      return backflows.s5ToS1(session, entryId, reason);
    case "s7ToS2":
      return backflows.s7ToS2(session, entryId, reason);
    case "s7ToS3":
      return backflows.s7ToS3(session, entryId, reason);
    case "s7ToS4":
      return backflows.s7ToS4(session, entryId, reason, newCheckOutDate);
    case "complaintToS2":
      return backflows.complaintToS2(session, entryId, reason);
    default:
      throw new Error(`Unknown backflow: ${d.key}`);
  }
}

/**
 * Header "Re-enter" menu — the desk surface for the 9 spec-mandated backflows (SIG-S2/S4/S5/S7 +
 * complaint resolution). Reads the entry's current stage, lists only the applicable backflows,
 * greys out ones above the actor's authority level, and drives each through a reason modal.
 *
 * Renders nothing when the entry has no applicable backflow, is terminal/closed, or is parked (the
 * backend state machine requires an ACTIVE entry, so those actions would only 4xx).
 */
export function ReEnterMenu({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<BackflowDescriptor | null>(null);
  const [reason, setReason] = useState("");
  const [newCheckOutDate, setNewCheckOutDate] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => runBackflow(session!, entry.id, active!, reason.trim(), newCheckOutDate),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      toast.success(`Re-entered to ${active?.toStage} — a new round is open.`);
      setActive(null);
      setReason("");
      setNewCheckOutDate("");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't re-enter this booking"),
  });

  const terminal =
    entry.status === "CLOSED" ||
    entry.status === "CANCELLED" ||
    entry.status === "EXPIRED" ||
    entry.status === "PARKED" ||
    entry.currentStage === "TERMINAL";

  const descriptors: BackflowDescriptor[] = [
    ...(BACKFLOWS_BY_STAGE[entry.currentStage] ?? []),
    ...(COMPLAINT_APPLICABLE_STAGES.has(entry.currentStage) ? [COMPLAINT_DESCRIPTOR] : []),
  ];

  if (terminal || descriptors.length === 0) return null;

  const myRank = LEVEL_RANK[session?.actorLevel ?? "L1"] ?? 1;
  const canDo = (d: BackflowDescriptor) => myRank >= LEVEL_RANK[d.minLevel];

  const dateInvalid = active?.needsNewCheckOutDate && !newCheckOutDate;
  const submitDisabled = mutation.isPending || !reason.trim() || dateInvalid;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Go back to an earlier step to fix dates, rate, billing model, or resolve a complaint"
      >
        <CornerUpLeft />
        Re-enter
        <ChevronDown style={{ width: 14, height: 14, marginLeft: 2 }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            minWidth: 260,
            background: "var(--paper, #fff)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.14)",
            padding: 6,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--ink-2)",
              padding: "6px 10px 4px",
            }}
          >
            Re-enter from {entry.currentStage}
          </div>
          {descriptors.map((d) => {
            const allowed = canDo(d);
            return (
              <button
                key={d.key}
                role="menuitem"
                disabled={!allowed}
                onClick={() => {
                  if (!allowed) return;
                  setActive(d);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: "transparent",
                  cursor: allowed ? "pointer" : "not-allowed",
                  opacity: allowed ? 1 : 0.5,
                  fontSize: 13,
                  color: d.destructive ? "var(--danger, #b4232a)" : "var(--ink)",
                }}
                onMouseEnter={(e) => allowed && (e.currentTarget.style.background = "var(--paper-2, rgba(0,0,0,0.04))")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {d.destructive ? (
                  <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
                ) : (
                  <CornerUpLeft style={{ width: 14, height: 14, flexShrink: 0, opacity: 0.7 }} />
                )}
                <span style={{ flex: 1 }}>{d.label}</span>
                {!allowed && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--ink-2)" }}>
                    <Lock style={{ width: 11, height: 11 }} />
                    {d.minLevel}+
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {active && (
        <div
          className="scrim"
          onClick={(e) => e.target === e.currentTarget && !mutation.isPending && setActive(null)}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label={active.label}>
            <div
              className="modal-top"
              style={
                active.destructive
                  ? { background: "var(--warn-t)", borderBottomColor: "#e6cf9a" }
                  : undefined
              }
            >
              <div className="modal-ic" style={active.destructive ? { background: "var(--warn)" } : undefined}>
                {active.destructive ? <AlertTriangle /> : <CornerUpLeft />}
              </div>
              <div>
                <h3>{active.label}</h3>
                <p>
                  Re-enter to {active.toStage} · {entry.currentStage} → {active.toStage}
                </p>
              </div>
            </div>
            <div className="modal-body">
              <p className="why">
                This opens a <b>new round</b> at {active.toStage}. What&rsquo;s already sealed stays as read-only
                history — this doesn&rsquo;t quietly edit it. The reason is recorded on the audit trail.
              </p>
              {active.needsNewCheckOutDate && (
                <div className="field" style={{ marginTop: 12 }}>
                  <label htmlFor="reenter-checkout">New check-out date (required)</label>
                  <DateField
                    id="reenter-checkout"
                    value={newCheckOutDate}
                    min={nextDayIso(entry.checkOutDate) || undefined}
                    onChange={setNewCheckOutDate}
                  />
                </div>
              )}
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="reenter-reason">Reason (required)</label>
                <textarea
                  id="reenter-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. guest asked to change the check-out date"
                  maxLength={500}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setActive(null)} disabled={mutation.isPending}>
                Not now
              </button>
              <button
                className="btn btn-primary"
                style={active.destructive ? { background: "var(--warn)" } : undefined}
                onClick={() => mutation.mutate()}
                disabled={submitDisabled}
              >
                <CornerUpLeft />
                {mutation.isPending ? "Re-entering…" : `Re-enter to ${active.toStage}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
