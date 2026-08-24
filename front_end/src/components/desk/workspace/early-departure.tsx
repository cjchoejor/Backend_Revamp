"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LogOut } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { previewEarlyDeparture, recordEarlyDeparture } from "@/lib/api/entries";
import { runNightAudit } from "@/lib/api/in-stay";
import { departureWouldBeEarly, money } from "@/lib/desk/workspace";
import { DeskConfirmModal } from "./confirm-modal";
import type { EntryDetail } from "@/types/api";

/**
 * Early departure on the Stay step (2026-08-22, SIG-S8 §1.2 / Policy 36).
 *
 * Replaces the old cancel-style "Record early departure" (which terminated the booking and left
 * the folio LIVE and unsettled). This one drives the governed route: the backend shortens the
 * stay against the commitment snapshot (slept nights keep their audited charges, unstayed nights
 * are never billed), posts the configured fee — or the GM waives it — frees the unstayed nights
 * for new bookings, and compresses into Check-out, where settlement runs as normal.
 *
 * Every figure shown is SERVER-computed (`POST /entries/:id/early-departure/preview`); the desk
 * adds no money up. GM (L3+) records it; below that the button locks with the reason.
 */

function shortDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function EarlyDepartureBlock({ entry, setSelected }: { entry: EntryDetail; setSelected: (n: number) => void }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const level = session?.actorLevel ?? "L1";
  const isGm = level === "L3" || level === "L4";
  const elevated = level === "L2" || isGm;
  const early = departureWouldBeEarly(entry);

  const [reason, setReason] = useState("");
  const [waive, setWaive] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const previewQ = useQuery({
    queryKey: ["early-departure-preview", entry.id, entry.updatedAt],
    queryFn: () => previewEarlyDeparture(session!, entry.id),
    enabled: !!session && early && !entry.earlyDeparture && entry.currentStage === "S7",
  });
  const fig = previewQ.data ?? null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entries"] });
    void queryClient.invalidateQueries({ queryKey: ["billing-summary", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["early-departure-preview", entry.id] });
  };

  const auditM = useMutation({
    mutationFn: (ymd: string) => runNightAudit(session!, `${ymd}T00:00:00.000Z`),
    onSuccess: (_d, ymd) => {
      toast.success(`Night audit run for ${ymd}.`);
      void queryClient.invalidateQueries({ queryKey: ["night-audit"] });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Night audit failed"),
  });

  const recordM = useMutation({
    mutationFn: () =>
      recordEarlyDeparture(session!, entry.id, {
        reason: reason.trim(),
        ...(waive ? { waiveFee: true, waiveReason: waiveReason.trim() } : {}),
      }),
    onSuccess: (out) => {
      setConfirmOpen(false);
      if (out.movedToCheckout) {
        toast.success(`Early departure recorded (${out.record.id}) — the booking is at Check-out.`);
        setSelected(8);
      } else {
        toast.warning(
          `Early departure recorded (${out.record.id}) — checkout is still blocked: ${out.checkoutBlocked?.message ?? "see the gate bar"}`,
        );
      }
      if (out.feeError) toast.warning(`The fee could not be posted: ${out.feeError} — post it on the folio manually.`);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Early departure failed"),
  });

  // Not early (checkout day reached / passed), already recorded, or not in-house — nothing to offer.
  if (!early || entry.earlyDeparture || entry.currentStage !== "S7") return null;

  const missing = fig?.missingNightYmds ?? [];
  const blockers = (fig?.blockers ?? []).filter((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  const feeWaivedOk = !waive || !!waiveReason.trim();
  const ready = !!fig && blockers.length === 0 && missing.length === 0 && !!reason.trim() && feeWaivedOk;
  const feeLine = fig
    ? fig.fee.amount > 0
      ? `${money(fig.fee.amount, "BTN")} net (≈ ${money(fig.fee.gross, "BTN")} with service charge & GST)`
      : "none under the configured rule"
    : "…";

  return (
    <div className="block" style={{ borderColor: "#e2b3ac" }}>
      <div className="block-h">
        <LogOut style={{ width: 13, height: 13 }} />
        Leaving early
        <span className="ln" />
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
        The booked checkout is <b>{shortDay(fig?.bookedCheckOut ?? entry.reservation?.frozenCheckOutDate)}</b>. Leaving today shortens
        the stay: the {fig ? fig.sleptNights : "…"} night{fig?.sleptNights === 1 ? "" : "s"} slept stay billed exactly as audited, the{" "}
        {fig ? fig.unstayedNights : "…"} unstayed night{fig?.unstayedNights === 1 ? "" : "s"} are not billed, and the booking moves to
        Check-out for settlement. The rate is never renegotiated (Policy 36).
      </p>

      {fig && (
        <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", display: "block" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>Room charges the stay drops ({fig.unstayedNights} night{fig.unstayedNights === 1 ? "" : "s"})</span>
            <span className="mono">− {money(fig.forgoneRoomTotal, "BTN")}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 3 }}>
            <span>
              Early departure fee{" "}
              <span style={{ color: "var(--ink-3)" }} title={fig.fee.explanation}>
                ({fig.fee.rule.basis === "NONE" ? "no rule configured" : fig.fee.explanation})
              </span>
            </span>
            <span className="mono">{feeLine}</span>
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div style={{ marginTop: 9, fontSize: 12, color: "var(--ink-2)" }}>
          <p style={{ margin: "0 0 5px", color: "var(--warn)" }}>
            The night{missing.length === 1 ? "" : "s"} already stayed must be audited first:
          </p>
          {missing.map((ymd) => (
            <div key={ymd} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="mono">{ymd}</span>
              {elevated ? (
                <button className="btn btn-ghost btn-sm" disabled={auditM.isPending} onClick={() => auditM.mutate(ymd)}>
                  {auditM.isPending ? "Running…" : `Run night audit for ${shortDay(ymd)}`}
                </button>
              ) : (
                <span style={{ color: "var(--ink-3)" }}>needs FOM (L2+)</span>
              )}
            </div>
          ))}
        </div>
      )}

      {blockers.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--stop)", margin: "8px 0 0", lineHeight: 1.5 }}>
          {blockers.map((b) => b.message).join(" · ")}
        </p>
      )}

      <div className="field" style={{ marginTop: 9 }}>
        <label>Why is the guest leaving early?</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. called away on family business" />
      </div>
      {isGm && (
        <>
          <label className="checkline" style={{ cursor: "pointer", margin: "6px 0" }}>
            <input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} />
            <span>Waive the early-departure fee (GM)</span>
          </label>
          {waive && (
            <div className="field">
              <label>Why is the fee waived?</label>
              <input value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} />
            </div>
          )}
        </>
      )}

      <button
        className="btn btn-ghost"
        style={{ borderColor: "#e2b3ac", color: "var(--stop)", marginTop: 6 }}
        disabled={!isGm || !ready || recordM.isPending}
        onClick={() => isGm && ready && setConfirmOpen(true)}
      >
        {recordM.isPending ? "Recording…" : "Record early departure & go to Check-out"}
      </button>
      {!isGm && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0 0" }}>
          Recording an early departure needs <b>GM authority</b> (Policy 36) — ask a GM to record it.
        </p>
      )}
      {isGm && !ready && (
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0 0" }}>
          {!reason.trim()
            ? "Type the reason to continue."
            : missing.length > 0
              ? "Run the slept nights' audits above first."
              : !feeWaivedOk
                ? "A waived fee needs its reason."
                : blockers.length > 0
                  ? "Resolve the blockers above first."
                  : "Loading the figures…"}
        </p>
      )}

      <DeskConfirmModal
        open={confirmOpen}
        tone="danger"
        title="Record early departure?"
        subtitle={entry.id}
        why="The stay is shortened to today. Here is exactly what happens:"
        consequences={[
          <>
            The {fig?.unstayedNights ?? "?"} booked night{fig?.unstayedNights === 1 ? "" : "s"} from tonight are <b>not billed</b> — the
            slept nights keep their audited charges (the rate is never renegotiated).
          </>,
          waive ? (
            "The early-departure fee is waived (GM) — nothing extra is posted."
          ) : fig && fig.fee.amount > 0 ? (
            <>
              The early-departure fee <b>{money(fig.fee.amount, "BTN")}</b> (+ service charge &amp; GST) is posted on the live folio.
            </>
          ) : (
            "No early-departure fee applies under the configured rule."
          ),
          "The freed nights open for new bookings immediately.",
          "The booking moves to Check-out — settle the bill, take the keys back, inspect the room there.",
        ]}
        confirmLabel="Record early departure"
        cancelLabel="Keep the stay"
        pending={recordM.isPending}
        onConfirm={() => recordM.mutate()}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/** The standing fact once an early departure is recorded — pinned on the workspace, every step. */
export function EarlyDepartureFacts({ entry }: { entry: EntryDetail }) {
  const ed = entry.earlyDeparture;
  if (!ed) return null;
  const fee = ed.feeWaived
    ? "fee waived"
    : Number(ed.feeAmount) > 0
      ? `fee ${money(Number(ed.feeAmount), "BTN")} on the folio`
      : "no fee";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        background: "var(--warn-t)",
        border: "1px solid var(--warn)",
        borderRadius: 9,
        padding: "5px 11px",
        fontSize: 12,
        color: "var(--ink)",
      }}
    >
      <AlertTriangle style={{ width: 12, height: 12, color: "var(--warn)", flexShrink: 0 }} />
      <span>
        <b>Left early on {shortDay(ed.departureDate)}</b> — booked to {shortDay(ed.originalCheckOutDate)} · {ed.sleptNights} of{" "}
        {ed.bookedNights} night{ed.bookedNights === 1 ? "" : "s"} slept · {fee} ({ed.id})
      </span>
    </div>
  );
}
