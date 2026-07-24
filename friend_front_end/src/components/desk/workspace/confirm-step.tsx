"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { acknowledgeMultiBooking, verifyConference } from "@/lib/api/confirmation";
import { deriveFinancials, money } from "@/lib/desk/workspace";
import { BackendRail, type RailGroup } from "./backend-inline";
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

  const [multiBookingNote, setMultiBookingNote] = useState("");
  const [conferenceChecklist, setConferenceChecklist] = useState(
    '{"venueConfirmed": true, "cateringConfirmed": true, "avConfirmed": true}',
  );

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

  const s4Groups: RailGroup[] = [
    { key: "confirm", label: "On freeze & confirm", items: STAGE_ACTIONS.S4.confirm },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
        <div className="speak">
          <div className="now">The one moment that locks</div>
          <h2>Ready to freeze this booking.</h2>
          <p>
            Confirming turns the range into a total the guest is held to, locks the rooms, and sends the
            confirmation. Clear any pre-confirm gates below, then freeze from the bar.
          </p>
        </div>

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

        {/* Multi-booking overlap acknowledgement (FOM+) */}
        {elevated && (
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
        {isConference && elevated && (
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
      </div>

      <BackendRail entryId={entry.id} groups={s4Groups} activeKeys={[]} firingKey={null} />
    </div>
  );
}
