"use client";

/**
 * Leaving owing at Check-out, asked of the FOM (2026-11-26, operator: "does it pop up on the fom and
 * gm's page, and how do they approve it" — then "okay do it").
 *
 * The front desk may not let a guest leave with part of the bill unpaid (Policy 46). It asks here,
 * with what the guest said; the request shows in the FOM's and GM's bell and on Notifications. The
 * FOM opens the booking and answers on this same card: "Let them leave owing" records the FOM's
 * credit extension for what the bill owes, after which the settle card offers "Settle — leave it
 * owing" to whoever is at the desk; "Turn it down" needs words the desk reads.
 *
 * Every figure is the server's (`GET /api/entries/:id/leave-owing`). Nothing is worked out here.
 */
import { useEffect, useRef, useState } from "react";
import { useMayApprove } from "@/hooks/use-approvals";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { askToLeaveOwing, decideLeaveOwing, getLeaveOwing, withdrawLeaveOwing, type LeaveOwingStanding } from "@/lib/api/leave-owing";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, NotNow, toastRefusal } from "./kit";

const KEY = (entryId: string) => ["leave-owing", entryId] as const;

/** Where leaving owing stands; read again every few seconds while the FOM's answer is awaited. */
export function useLeaveOwing(entry: EntryDetail, enabled: boolean) {
  const { session } = useSession();
  return useQuery({
    queryKey: KEY(entry.id),
    queryFn: () => getLeaveOwing(session!, entry.id),
    enabled: enabled && !!session,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data as LeaveOwingStanding | undefined)?.open ? 8_000 : false),
    refetchOnWindowFocus: true,
  });
}

/** The desk's button: "They can't pay now — ask the FOM", with the guest's words. */
export function AskFomToLeaveOwing({
  entry,
  standing,
  cur,
  live,
  guest,
  onDone,
}: {
  entry: EntryDetail;
  standing: LeaveOwingStanding | undefined;
  cur: string;
  live: boolean;
  guest: string;
  onDone: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const ask = useMutation({
    mutationFn: () => askToLeaveOwing(session!, entry.id, words.trim()),
    onSuccess: (data) => {
      qc.setQueryData(KEY(entry.id), data);
      setOpen(false);
      setWords("");
      toast.success("The FOM has been asked — their answer shows here");
      onDone();
    },
    onError: (e) => toastRefusal(e, "Could not ask the FOM"),
  });
  if (!standing?.mayAsk) return null;
  return (
    <>
      <Button kind="secondary" state={live ? "default" : "inert"} reason={live ? undefined : "only while the booking is at Check-out"} onClick={() => setOpen(true)}>
        They can&rsquo;t pay now — ask the FOM
      </Button>
      <DsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Ask the FOM to let the guest leave owing"
        caseLines={[<b key="g">{guest}</b>, `${entry.id} · still owed ${money(standing.balance, cur)}`]}
        busy={ask.isPending}
        footer={
          <>
            <NotNow onClick={() => setOpen(false)} busy={ask.isPending} />
            <Button
              className={words.trim() ? "go" : undefined}
              state={ask.isPending ? "working" : words.trim() ? "default" : "inert"}
              reason={words.trim() ? undefined : "write what the guest said first"}
              workingLabel="Asking…"
              onClick={() => ask.mutate()}
            >
              Ask the FOM
            </Button>
          </>
        }
      >
        <p className="sm" style={{ marginTop: 0 }}>
          The FOM, the GM or an admin sees it in their bell. If they agree, the bill is settled here with what the guest can pay now — or nothing — and the rest is collected
          after the stay.
        </p>
        <div className="field">
          <label>What did the guest say?</label>
          <textarea
            className="input"
            rows={3}
            value={words}
            placeholder="e.g. their company pays by bank transfer on Monday"
            onChange={(e) => setWords(e.target.value)}
          />
        </div>
      </DsDialog>
    </>
  );
}

/** The request waiting, or the FOM's last word — with the FOM's acts when the FOM is signed in. */
export function LeaveOwingStatus({
  entry,
  standing,
  cur,
  tz,
  live,
  fom,
  guest,
  onDecided,
}: {
  entry: EntryDetail;
  standing: LeaveOwingStanding | undefined;
  cur: string;
  tz: string;
  live: boolean;
  fom: boolean;
  guest: string;
  onDecided: () => void;
}) {
  const { session } = useSession();
  // Who decides is the admin console's (2026-11-26); the caller's rule stands while it is read.
  fom = useMayApprove("LEAVE_OWING", fom).may;
  const qc = useQueryClient();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");

  // When the FOM answers on another screen, the desk's card reads the bill again so the
  // credit extension the approval recorded turns the card to "leave it owing".
  const seen = useRef<string | null>(null);
  const latestKey = standing?.latest ? `${standing.latest.id}:${standing.latest.status}` : null;
  useEffect(() => {
    if (!latestKey) return;
    if (seen.current && seen.current !== latestKey) onDecided();
    seen.current = latestKey;
  }, [latestKey, onDecided]);
  const openId = standing?.open?.id ?? null;
  const prevOpen = useRef<string | null>(null);
  useEffect(() => {
    if (prevOpen.current && !openId) onDecided();
    prevOpen.current = openId;
  }, [openId, onDecided]);

  const done = (data: LeaveOwingStanding, msg: string) => {
    qc.setQueryData(KEY(entry.id), data);
    setApproveOpen(false);
    setRejectOpen(false);
    toast.success(msg);
    onDecided();
  };
  const approve = useMutation({
    mutationFn: () =>
      decideLeaveOwing(session!, entry.id, standing!.open!.id, {
        decision: "APPROVE",
        note: note.trim() || null,
        payWithinDays: days.trim() ? Number(days) : null,
      }),
    onSuccess: (d) => done(d, "Approved — the desk can settle the bill and let the guest leave owing"),
    onError: (e) => toastRefusal(e, "Could not approve it"),
  });
  const reject = useMutation({
    mutationFn: () => decideLeaveOwing(session!, entry.id, standing!.open!.id, { decision: "REJECT", note: why.trim() }),
    onSuccess: (d) => done(d, "Turned down — the desk reads your words"),
    onError: (e) => toastRefusal(e, "Could not turn it down"),
  });
  const withdraw = useMutation({
    mutationFn: () => withdrawLeaveOwing(session!, entry.id, standing!.open!.id),
    onSuccess: (d) => done(d, "The request was taken back"),
    onError: (e) => toastRefusal(e, "Could not take it back"),
  });

  const open = standing?.open ?? null;
  const latest = standing?.latest ?? null;
  const daysBad = days.trim() !== "" && !(Number(days) > 0 && Number(days) <= 365);

  if (open) {
    return (
      <div className="notice next owing-ask" role="status" data-leave-owing="waiting" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <span style={{ flex: "1 1 320px" }}>
          <b>{fom ? "The desk asks to let the guest leave owing" : "Waiting for the FOM"}</b> · <b className="money">{money(open.amountOwed, cur)}</b> owed · asked by{" "}
          {open.requestedByName}, {fmtDateTime(open.requestedAt, tz)}
          <br />
          <span className="sm">The guest said: &ldquo;{open.guestWords}&rdquo;</span>
        </span>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {fom ? (
            <>
              <Button className={live ? "go" : undefined} state={live ? "default" : "inert"} onClick={() => setApproveOpen(true)}>
                Let them leave owing
              </Button>
              <Button kind="secondary" state={live ? "default" : "inert"} onClick={() => setRejectOpen(true)}>
                Turn it down
              </Button>
            </>
          ) : (
            <Button kind="secondary" state={withdraw.isPending ? "working" : "default"} workingLabel="Taking it back…" onClick={() => withdraw.mutate()}>
              Take the request back
            </Button>
          )}
        </span>

        <DsDialog
          open={approveOpen}
          onClose={() => setApproveOpen(false)}
          title="Let the guest leave owing"
          caseLines={[<b key="g">{guest}</b>, `${entry.id} · still owed ${money(standing?.balance, cur)}`]}
          busy={approve.isPending}
          footer={
            <>
              <NotNow onClick={() => setApproveOpen(false)} busy={approve.isPending} />
              <Button
                className={daysBad ? undefined : "go"}
                state={approve.isPending ? "working" : daysBad ? "inert" : "default"}
                reason={daysBad ? "pay within is 1 to 365 days, or empty" : undefined}
                workingLabel="Approving…"
                onClick={() => approve.mutate()}
              >
                Let them leave owing
              </Button>
            </>
          }
        >
          <p className="sm" style={{ marginTop: 0 }}>
            This records your credit extension for the <b className="money">{money(standing?.balance, cur)}</b> the bill still owes. The desk then settles the bill, and the
            rest is collected after the stay, on the Closed step.
          </p>
          <p className="sm">The guest said: &ldquo;{open.guestWords}&rdquo;</p>
          <div className="form2">
            <div className="field">
              <label>Pay within · days · optional</label>
              <input className="input narrow" inputMode="numeric" value={days} placeholder="7" onChange={(e) => setDays(e.target.value.replace(/[^\d.]/g, ""))} />
              {daysBad ? <span className="hint stop-ink">1 to 365 days, or leave it empty for no time limit</span> : null}
            </div>
            <div className="field">
              <label>Note · optional</label>
              <input className="input" value={note} placeholder="e.g. regular guest, known company" onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        </DsDialog>

        <DsDialog
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
          title="Turn it down"
          caseLines={[<b key="g">{guest}</b>, `${entry.id} · still owed ${money(standing?.balance, cur)}`]}
          busy={reject.isPending}
          footer={
            <>
              <NotNow onClick={() => setRejectOpen(false)} busy={reject.isPending} />
              <Button
                kind="danger"
                state={reject.isPending ? "working" : why.trim() ? "default" : "inert"}
                reason={why.trim() ? undefined : "say why — the desk reads it"}
                workingLabel="Turning it down…"
                onClick={() => reject.mutate()}
              >
                Turn it down
              </Button>
            </>
          }
        >
          <p className="sm" style={{ marginTop: 0 }}>
            The guest pays before leaving. The desk reads what you write.
          </p>
          <div className="field">
            <label>Why</label>
            <input className="input" value={why} placeholder="e.g. take a card payment; the guest has no history with us" onChange={(e) => setWhy(e.target.value)} />
          </div>
        </DsDialog>
      </div>
    );
  }

  if (latest?.status === "REJECTED") {
    return (
      <div className="notice stop" role="alert" data-leave-owing="rejected" style={{ marginTop: 12 }}>
        The FOM turned it down — &ldquo;{latest.decisionNote}&rdquo; · {latest.decidedByName}, {latest.decidedAt ? fmtDateTime(latest.decidedAt, tz) : ""}. The guest pays before
        leaving.
      </div>
    );
  }
  if (latest?.status === "APPROVED") {
    return (
      <p className="sm ok-ink" data-leave-owing="approved" style={{ marginTop: 10 }}>
        {latest.decidedByName} let the guest leave owing, {latest.decidedAt ? fmtDateTime(latest.decidedAt, tz) : ""}
        {latest.payBy ? <> · pay by {fmtDateTime(latest.payBy, tz)}</> : null}.
      </p>
    );
  }
  return null;
}
