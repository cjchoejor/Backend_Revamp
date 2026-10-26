"use client";

/**
 * "Other ways this booking can go" for Reserve and Arrival (prototype `V16.caseActs`, rulings A7):
 * Cancel… · No-show… · Park… · Amend dates… — each wired only to a route the backend has at the
 * stage the booking is at, otherwise shown inert with the reason.
 *
 *  - Set up (reserving):  cancel-at-s3 (L1; the GM waives) · re-entry to Inquiry (FOM)
 *  - Reserve (frozen):    cancel (FOM; the GM waives) · backflow to Inquiry (FOM)
 *  - Arrival:             cancel (FOM; the GM waives) · no-show after the cut-off (FOM) · backflow to Inquiry (FOM)
 */
import { reservedThisPass } from "@/lib/desk/workspace";
import { CancellationFiguresLine, WaiverTick, useRefundHow } from "./cancel-figures";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { determineNoShow, previewNoShow } from "@/lib/api/no-show";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { backflows } from "@/lib/api/backflows";
import { cancelEntryAtS3, cancelEntryAtS5, initiateS3ReEntryToS1 } from "@/lib/api/reservation-setup";
import { fmtDay, fmtStamp, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, ReasonDialog, atLeast, toastRefusal, useRefreshEntry, OtherWaysTabs, InlineWay, ShutWay, NotNow, parkTab, type OtherWayTab } from "./kit";
import { Help } from "@/components/ds/help";


type EntryScalars = { noShowCutoffReachedAt?: string | null };

export function BookingOtherWays({
  entry,
  parkNow,
  parking,
  guestPresent = false,
}: {
  entry: EntryDetail;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  guestPresent?: boolean;
}) {
  const { session } = useSession();
  const stage = entry.currentStage;
  const active = entry.status === "ACTIVE";
  const fom = atLeast(session?.actorLevel, "L2");
  const cutoffAt = (entry as EntryDetail & EntryScalars).noShowCutoffReachedAt ?? null;
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  const reserved = reservedThisPass(entry);
  const here = active && (stage === "S3" || stage === "S4" || stage === "S5");

  // Cancel. A reserved booking is cancelled at Reserve or at Arrival (2026-09-18) — it used to be
  // Arrival only, a day before the stay, so a booking further out could not be cancelled.
  const cancel: OtherWayTab | null = !here
    ? null
    : {
        key: "cancel",
        label: "Cancel",
        content:
          stage === "S3" ? (
            <InlineWay render={(done) => <CancelAtSetupDialog entry={entry} onClose={done} />} />
          ) : fom ? (
            <InlineWay render={(done) => <CancelAtArrivalDialog entry={entry} onClose={done} />} />
          ) : (
            <ShutWay
              act="Cancel the booking"
              why="Needs the FOM — cancelling a reserved booking."
              help={<p>They told us they&rsquo;re not coming. The charge follows the disclosed terms and the rooms are released.</p>}
            />
          ),
      };

  // No-show — only at Arrival, after the cut-off.
  let noShow: OtherWayTab | null = null;
  if (here) {
    const done = !!entry.noShowDetermination;
    const why =
      stage !== "S5"
        ? "Not at this step — a no-show is determined at Arrival, after the cut-off on the arrival day."
        : done
          ? "A no-show is already on record for this booking."
          : guestPresent
            ? "The guest is marked present — a present guest is not a no-show."
            : !cutoffAt
              ? `Not yet — a no-show is determined only after the cut-off on ${fmtDay(checkIn)}.`
              : !fom
                ? "Needs the FOM — determining a no-show."
                : null;
    noShow = {
      key: "noshow",
      label: "No-show",
      content: why ? (
        <ShutWay
          act="Record the no-show"
          why={why}
          help={<p>They never came. After the cut-off on {fmtDay(checkIn)} the disclosed no-show charge is taken and the rooms are released.</p>}
        />
      ) : (
        <InlineWay render={(close) => <NoShowDialog entry={entry} cutoffAt={cutoffAt} onClose={close} />} />
      ),
    };
  }

  const amend: OtherWayTab | null = !here
    ? null
    : {
        key: "amend",
        label: "Amend dates",
        content: fom ? (
          <InlineWay render={(done) => <AmendDatesDialog entry={entry} onClose={done} />} />
        ) : (
          <ShutWay
            act="Open a new pass"
            why="Needs the FOM — changing the dates sends the booking back to Inquiry."
            help={
              <p>
                {reserved
                  ? "The booking goes back to Inquiry for the new dates: the rooms are let go, a new quotation is made, and it is reserved again."
                  : "The booking goes back to Inquiry for the new dates and is priced again; the held rooms are let go."}
              </p>
            }
          />
        ),
      };

  // Other ways as sub-tabs (2026-10-17), each panel the form its button used to open.
  return <OtherWaysTabs tabs={[cancel, noShow, active ? parkTab(parkNow, parking) : null, amend]} />;
}

/* ------------------------------------------------------------------ cancel */

function useAfterTerminal(entryId: string) {
  const refresh = useRefreshEntry(entryId);
  const qc = useQueryClient();
  return () => {
    refresh([["journey-summary", entryId], ["rooms"], ["rooms-catalog"], ["identity-proofs", entryId]]);
    void qc.invalidateQueries({ queryKey: ["desk-bookings"] });
  };
}

function CancelAtSetupDialog({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) {
  const { session } = useSession();
  const after = useAfterTerminal(entry.id);
  const gm = atLeast(session?.actorLevel, "L3");
  const [waive, setWaive] = useState(false);
  const refund = useRefundHow();
  const run = useMutation({
    mutationFn: (reason: string) =>
      cancelEntryAtS3(session!, entry.id, { reason, penaltyWaiverRequested: gm && waive ? true : undefined, ...refund.body }),
    onSuccess: () => {
      toast.success("Cancelled — the hold is released and the booking is closed as cancelled");
      onClose();
      after();
    },
    onError: (e) => toastRefusal(e, "The booking could not be cancelled"),
  });
  return (
    <ReasonDialog
      open
      danger
      onClose={onClose}
      busy={run.isPending}
      title="Cancel this booking"
      lead={
        <>
          This cannot be undone. The held rooms return to the house, the timers stop, the proforma is withdrawn, the charge
          follows the terms the guest was told{waive ? " — waived by the GM" : ""}, and any advance above it is refunded.
        </>
      }
      confirmLabel="Cancel the booking"
      placeholder="what the guest or the booker said"
      onConfirm={(r) => run.mutate(r)}
    >
      <CancellationFiguresLine entryId={entry.id} waive={gm && waive} />
      <WaiverTick checked={waive} onChange={setWaive} gm={gm} />
      {refund.fields}
    </ReasonDialog>
  );
}

/** The cancel of a reserved booking — Reserve, Arrival and, since 2026-10-26, Check-in (SIG-S6
 *  §8.6 / Policy 35: the guest is at the desk but is not staying). One form for the three steps. */
export function CancelAtArrivalDialog({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) {
  const { session } = useSession();
  // Reserve (S4) or Arrival (S5): the no-show clock and the arrival tasks exist only at Arrival.
  const atArrival = entry.currentStage === "S5";
  const atCheckIn = entry.currentStage === "S6";
  const after = useAfterTerminal(entry.id);
  const gm = atLeast(session?.actorLevel, "L3");
  const [waive, setWaive] = useState(false);
  const refund = useRefundHow();
  // The reason is recorded on the cancellation, as at Set up (2026-09-18) — the Arrival cancel
  // used to take none, so a reserved booking could be cancelled with no why on record.
  const run = useMutation({
    mutationFn: (reason: string) =>
      cancelEntryAtS5(session!, entry.id, { reason, ...(gm && waive ? { penaltyWaiverRequested: true } : {}), ...refund.body }),
    onSuccess: () => {
      toast.success(
        atArrival
          ? "Cancelled — the rooms are released and the no-show clock is stopped"
          : atCheckIn
            ? "Cancelled at check-in — the rooms are released"
            : "Cancelled — the rooms are released",
      );
      onClose();
      after();
    },
    onError: (e) => toastRefusal(e, "The booking could not be cancelled"),
  });
  return (
    <ReasonDialog
      open
      danger
      onClose={onClose}
      busy={run.isPending}
      title={atCheckIn ? "They are not staying after all" : "They told us they're not coming"}
      lead={
        <>
          This cannot be undone. {atCheckIn ? "The rooms" : "The held rooms"} return to the house;{" "}
          {atArrival ? "the no-show clock and the open pre-arrival tasks stop;" : "the booking's clocks stop;"}{" "}
          the disclosed cancellation charge is posted{waive ? " — waived by the GM" : ""} and the rest of the advance is
          refunded; the booking closes as cancelled, with its cancellation confirmation under Papers.
        </>
      }
      confirmLabel="Cancel the booking"
      placeholder="what the guest or the booker said"
      onConfirm={(r) => run.mutate(r)}
    >
      <CancellationFiguresLine entryId={entry.id} waive={gm && waive} />
      <WaiverTick checked={waive} onChange={setWaive} gm={gm} />
      {refund.fields}
    </ReasonDialog>
  );
}

/* ------------------------------------------------------------------ no-show */

const CHANNELS = [
  ["PHONE", "Phone"],
  ["WHATSAPP", "WhatsApp"],
  ["EMAIL", "Email"],
  ["SMS", "SMS"],
] as const;
const OUTCOMES = [
  ["NO_ANSWER", "No answer"],
  ["VOICEMAIL", "Left a message"],
  ["UNREACHABLE", "Number unreachable"],
  ["ANSWERED_NOT_COMING", "Answered — not coming"],
] as const;

type Attempt = { channel: string; outcome: string; response: string; attemptedAt: string };

function NoShowDialog({ entry, cutoffAt, onClose }: { entry: EntryDetail; cutoffAt: string | null; onClose: () => void }) {
  const { session } = useSession();
  const clock = useHotelClock(30_000);
  const after = useAfterTerminal(entry.id);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [channel, setChannel] = useState<string>("PHONE");
  const [outcome, setOutcome] = useState<string>("NO_ANSWER");
  const [response, setResponse] = useState("");
  const [reason, setReason] = useState("");
  // What the no-show will charge and give back — the backend's own figures, read before the click.
  const figures = useQuery({
    queryKey: ["no-show-preview", entry.id],
    queryFn: () => previewNoShow(session!, entry.id),
    enabled: !!session,
    staleTime: 0,
  });
  const run = useMutation({
    mutationFn: () =>
      determineNoShow(session!, entry.id, {
        determinationPath: "SUB_PATH_1",
        contactAttemptLog: attempts.map((a) => ({
          channel: a.channel,
          attemptedAt: a.attemptedAt,
          outcome: a.outcome,
          response: a.response.trim() || undefined,
        })),
        decisionReason: reason.trim(),
      }),
    onSuccess: () => {
      const f = figures.data;
      toast.success(
        f
          ? `No-show on record — ${money(f.penalty, "Nu.")} kept${f.refund > 0 ? `, ${money(f.refund, "Nu.")} owed back to the guest` : ""}. The rooms are free; the booking waits at Closed to be sealed.`
          : "No-show on record — the rooms are free; the booking waits at Closed to be sealed",
      );
      onClose();
      after();
    },
    onError: (e) => toastRefusal(e, "The no-show could not be recorded"),
  });
  const ok = attempts.length > 0 && reason.trim().length > 0;
  const add = () => {
    setAttempts((p) => [...p, { channel, outcome, response, attemptedAt: new Date(clock.now).toISOString() }]);
    setResponse("");
  };
  return (
    <DsDialog
      open
      register="danger"
      onClose={onClose}
      busy={run.isPending}
      width={560}
      title="They never came"
      caseLines={[cutoffAt ? `the cut-off passed ${fmtStamp(cutoffAt, clock.tz)}` : "after the cut-off"]}
      footer={
        <>
          <NotNow onClick={onClose} busy={run.isPending} />
          <Button
            kind="danger"
            solid
            state={run.isPending ? "working" : ok ? "default" : "inert"}
            title={ok ? undefined : attempts.length === 0 ? "record at least one attempt to reach them" : "write the reason first"}
            workingLabel="Recording…"
            onClick={() => run.mutate()}
          >
            Record the no-show
          </Button>
        </>
      }
    >
      <p className="sm">
        The rooms go back to the house at once, the no-show charge is taken from the advance and the rest is owed back.
        The booking then waits at Closed to be sealed. The rule asks for at least one attempt to reach them.
      </p>
      {figures.isLoading ? (
        <p className="meta">Reading what the no-show would charge…</p>
      ) : figures.data ? (
        <div className="notice inert" style={{ margin: "8px 0" }}>
          <span className="sm">
            Received <b className="money">{money(figures.data.advanceReceived, "Nu.")}</b> · kept{" "}
            <b className="money">{money(figures.data.penalty, "Nu.")}</b> — {figures.data.explanation}
            {figures.data.capped ? ` (the rule asks ${money(figures.data.penaltyBeforeCap, "Nu.")} — never more than was received)` : ""} ·
            owed back <b className="money">{money(figures.data.refund, "Nu.")}</b>
          </span>
        </div>
      ) : (
        <p className="meta warn-ink">The charge could not be read — the no-show still applies the hotel&rsquo;s rule.</p>
      )}
      <div className="field">
        <label>Attempts to reach them</label>
        {attempts.length === 0 ? (
          <span className="meta">none yet</span>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {attempts.map((a, i) => (
              <div key={i} className="sm" style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <Chip tone="quiet">{CHANNELS.find((c) => c[0] === a.channel)?.[1] ?? a.channel}</Chip>
                <span>
                  {OUTCOMES.find((o) => o[0] === a.outcome)?.[1] ?? a.outcome}
                  {a.response.trim() ? <span className="meta"> · “{a.response.trim()}”</span> : null}
                  <span className="meta"> · {fmtStamp(a.attemptedAt, clock.tz)}</span>
                </span>
                <Button kind="quiet" compact iconOnly icon="x" aria-label="remove this attempt" onClick={() => setAttempts((p) => p.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="form2">
        <div className="field">
          <label>How</label>
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {CHANNELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>What happened</label>
          <select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOMES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="wide field">
          <label>
            What they said · optional
            <Help label="About the attempt">The attempt is stamped with the time you add it.</Help>
          </label>
          <input className="input" value={response} onChange={(e) => setResponse(e.target.value)} placeholder="'we missed the flight'" />
        </div>
      </div>
      <div className="row-acts">
        <Button kind="secondary" compact onClick={add}>
          Add this attempt
        </Button>
      </div>
      <div className="field">
        <label>Reason</label>
        <textarea className="input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="why this is a no-show" />
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ amend dates */

function AmendDatesDialog({ entry, onClose }: { entry: EntryDetail; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const stage = entry.currentStage;
  const run = useMutation({
    mutationFn: (reason: string) => {
      if (stage === "S3") return initiateS3ReEntryToS1(session!, entry.id, { reason });
      if (stage === "S4") return backflows.s4ToS1(session!, entry.id, reason);
      return backflows.s5ToS1(session!, entry.id, reason);
    },
    onSuccess: () => {
      toast.success("A new pass is open at Inquiry — search the new dates there");
      onClose();
      refresh([["journey-summary", entry.id], ["rooms"], ["rooms-catalog"], ["segment-history", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The dates could not be reopened"),
  });
  return (
    <ReasonDialog
      open
      onClose={onClose}
      busy={run.isPending}
      title="Amend the dates"
      lead={
        <>
          The booking goes back to Inquiry in a new pass. What was decided stays as a read-only record of this pass; the held rooms
          are released and the new dates are searched, quoted{entry.reservation?.confirmedAt ? " and reserved" : ""} again.
        </>
      }
      confirmLabel="Open a new pass"
      placeholder="e.g. the guest moved the stay to the following week"
      onConfirm={(r) => run.mutate(r)}
    />
  );
}
