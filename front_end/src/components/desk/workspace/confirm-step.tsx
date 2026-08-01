"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ListChecks, Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { acknowledgeMultiBooking, verifyConference } from "@/lib/api/confirmation";
import { patchPreArrivalTask } from "@/lib/api/pre-arrival";
import { deriveFinancials, money } from "@/lib/desk/workspace";
import { BackendRail, type RailGroup } from "./backend-inline";
import { JourneySummaryBlock } from "./journey-summary";
import { ConfirmationVoucherBlock } from "./confirmation-voucher";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}
function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}

/**
 * The front-desk prep subset of the pre-arrival task set, surfaced on S4 (2026-08-02, operator
 * request). The tasks are seeded at confirmation (backend, idempotent) so they can be worked
 * here before the arrival window opens; the same records show on the Arrival step — completing
 * one in either place writes the same row.
 */
const HANDOFF_TASKS: Array<{ type: string; label: string }> = [
  { type: "PAYMENT_RECONCILIATION", label: "Payment reconciliation" },
  { type: "SPECIAL_REQUEST_FULFILMENT", label: "Special request fulfilment" },
  { type: "LATE_ARRIVAL_MEAL_COORDINATION", label: "Late-arrival meal coordination" },
  { type: "SITE_VISIT", label: "Site visit" },
];

/**
 * Confirm (S3→S4) interactive step. Rendered in place of the read-only confirm canvas while the
 * booking is still at S3 and not yet frozen. Carries the two pre-confirm gates the backend
 * enforces but the read-only canvas can't satisfy:
 *  - multi-booking overlap acknowledgement (p13, FOM+) — required when the guest has an
 *    overlapping reservation, else confirmReservation throws.
 *  - conference verification (p67, FOM+) — required for CONFERENCE use-type bookings.
 * The freeze itself stays on the gate bar ("Freeze & confirm").
 */
export function ConfirmStep({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const elevated = isElevated(session?.actorLevel);
  const fin = deriveFinancials(entry);
  const isConference = entry.useType === "CONFERENCE";
  // Once the reservation is confirmed, this step becomes a read-back: the journey recap + the
  // confirmation-voucher receipt, not the pre-freeze gates.
  const confirmed = !!entry.reservation?.confirmedAt;

  const [multiBookingNote, setMultiBookingNote] = useState("");
  const [conferenceChecklist, setConferenceChecklist] = useState(
    '{"venueConfirmed": true, "cateringConfirmed": true, "avConfirmed": true}',
  );
  const [waiveReasons, setWaiveReasons] = useState<Record<string, string>>({});

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
  };
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const ackM = useMutation(
    wrap(() => acknowledgeMultiBooking(session!, entry.id, multiBookingNote.trim() || undefined), "Multi-booking overlap acknowledged"),
  );
  const conferenceM = useMutation(
    wrap(() => {
      let checklist: unknown;
      try {
        checklist = JSON.parse(conferenceChecklist);
      } catch {
        checklist = { raw: conferenceChecklist };
      }
      return verifyConference(session!, entry.id, checklist);
    }, "Conference verified"),
  );
  const handoffTaskM = useMutation({
    mutationFn: (args: { taskId: string; action: "COMPLETE" | "WAIVE" }) =>
      patchPreArrivalTask(session!, args.taskId, {
        action: args.action,
        waivedReason: args.action === "WAIVE" ? waiveReasons[args.taskId]?.trim() || undefined : undefined,
      }),
    onSuccess: (_d, args) => {
      toast.success(args.action === "COMPLETE" ? "Task completed" : "Task waived");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  // The four front-desk prep tasks, in the fixed display order above.
  const handoffTasks = HANDOFF_TASKS.map((h) => ({
    ...h,
    task: (entry.preArrivalTasks ?? []).find((t) => t.taskType === h.type) ?? null,
  }));

  const s4Groups: RailGroup[] = [
    { key: "confirm", label: "On freeze & confirm", items: STAGE_ACTIONS.S4.confirm },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
        <div className="speak">
          {confirmed ? (
            <>
              <div className="now">Confirmed &amp; frozen</div>
              <h2>This booking is locked in.</h2>
              <p>
                The rooms are held, the total is frozen, and the confirmation voucher has gone to the guest.
                Below is the full record of what was agreed and what the guest received.
              </p>
            </>
          ) : (
            <>
              <div className="now">The one moment that locks</div>
              <h2>Ready to freeze this booking.</h2>
              <p>
                Confirming turns the range into a total the guest is held to, locks the rooms, and sends the
                confirmation. Clear any pre-confirm gates below, then freeze from the bar.
              </p>
            </>
          )}
        </div>

        <JourneySummaryBlock entryId={entry.id} />

        {confirmed && <ConfirmationVoucherBlock entry={entry} />}

        {/* The voucher goes out automatically on confirmation and opens a W22 window. This is the
            desk's way to close that loop when the guest replies — evidence only, arrival is not
            held up by it. */}
        {confirmed && <CommunicationAcceptanceBlock entryId={entry.id} commType="CONFIRMATION_VOUCHER" />}

        {!confirmed && (
          <div className="block">
            <BlockH>
              <Lock style={{ width: 13, height: 13 }} />
              What gets frozen
            </BlockH>
            <div className="field">
              <label>Total to be frozen</label>
              <div className="val derived">
                {fin.indicativeTotal !== null ? money(fin.indicativeTotal, fin.currency) : "—"}
              </div>
            </div>
          </div>
        )}

        {/* The proforma answer capture lives on Set up ONLY (2026-08-01, operator request —
            it was duplicated here). Set up stays editable until the freeze, so the p40 gate's
            checklist item points the operator back there when the answer is still missing. */}

        {/* Multi-booking overlap acknowledgement (FOM+) */}
        {!confirmed && elevated && (
          <div className="block">
            <BlockH>
              <AlertTriangle style={{ width: 13, height: 13 }} />
              Overlapping booking? <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>· only if needed</span>
            </BlockH>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
              Most bookings don&rsquo;t need this. Only if this guest already holds a <b>separate overlapping
              reservation</b> does the freeze require an acknowledgement — if it does, the confirm will tell you.
              Otherwise skip it; it won&rsquo;t block anything.
            </p>
            <div className="frow">
              <div className="field">
                <label>Acknowledgement note (optional)</label>
                <input value={multiBookingNote} onChange={(e) => setMultiBookingNote(e.target.value)} />
              </div>
              <div className="field" style={{ alignSelf: "end" }}>
                <button className="btn btn-ghost" disabled={ackM.isPending} onClick={() => ackM.mutate()}>
                  <Check style={{ width: 14, height: 14 }} />
                  Acknowledge overlap
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Conference verification (CONFERENCE use-type, FOM+) */}
        {!confirmed && isConference && elevated && (
          <div className="block">
            <BlockH>
              <Users style={{ width: 13, height: 13 }} />
              Conference verification
            </BlockH>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
              Verify venue, catering and AV readiness — required before a conference booking can be confirmed.
            </p>
            <div className="field">
              <label>Verification checklist (JSON)</label>
              <textarea
                value={conferenceChecklist}
                onChange={(e) => setConferenceChecklist(e.target.value)}
                rows={3}
                style={{ fontFamily: "var(--font-plex-mono, monospace)", fontSize: 12 }}
              />
            </div>
            <button className="btn btn-ghost" disabled={conferenceM.isPending} onClick={() => conferenceM.mutate()}>
              <Check style={{ width: 14, height: 14 }} />
              Verify conference
            </button>
          </div>
        )}

        {/* Handoff to front desk — kept at the BOTTOM of S4 (2026-08-02, operator request).
            The front-desk prep subset of the pre-arrival tasks, workable as soon as the
            booking is frozen. Same records as the Arrival step's task list — whichever step
            completes one, the other shows it done. */}
        {confirmed && (
          <div className="block">
            <BlockH>
              <ListChecks style={{ width: 13, height: 13 }} />
              Handoff to front desk
            </BlockH>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
              What the front desk needs squared away before this guest arrives. These can be worked
              here or on the Arrival step — it&rsquo;s the same list.
            </p>
            {handoffTasks.every((h) => !h.task) ? (
              <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
                Tasks are seeded at confirmation — refresh if they haven&rsquo;t appeared yet. (Bookings
                confirmed before this feature get theirs when the arrival window is activated.)
              </p>
            ) : (
              handoffTasks
                .filter((h) => h.task)
                .map(({ label, task }) => (
                  <div key={task!.id} style={{ borderBottom: "1px dashed var(--line)", padding: "8px 0" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
                      <span className={`tag ${task!.status === "PENDING" ? "warn" : ""}`}>{task!.status}</span>
                    </div>
                    {task!.status === "PENDING" && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 7 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={handoffTaskM.isPending}
                          onClick={() => handoffTaskM.mutate({ taskId: task!.id, action: "COMPLETE" })}
                        >
                          Complete
                        </button>
                        <input
                          className="dinput"
                          style={{ flex: 1, minWidth: 140 }}
                          placeholder="Waive reason"
                          value={waiveReasons[task!.id] ?? ""}
                          onChange={(e) => setWaiveReasons((prev) => ({ ...prev, [task!.id]: e.target.value }))}
                        />
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={handoffTaskM.isPending || !(waiveReasons[task!.id] ?? "").trim()}
                          onClick={() => handoffTaskM.mutate({ taskId: task!.id, action: "WAIVE" })}
                        >
                          Waive
                        </button>
                      </div>
                    )}
                    {task!.status === "WAIVED" && task!.waivedReason ? (
                      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "5px 0 0" }}>Waived — {task!.waivedReason}</p>
                    ) : null}
                  </div>
                ))
            )}
          </div>
        )}
      </div>

      {/* "✓ Ran" only when the freeze actually happened — confirmed derives from the real
          reservation row, so before the freeze the group correctly sits unlit. */}
      <BackendRail entryId={entry.id} groups={s4Groups} activeKeys={confirmed ? ["confirm"] : []} firingKey={null} />
    </div>
  );
}
