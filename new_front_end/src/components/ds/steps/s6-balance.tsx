"use client";

/**
 * The rest of the bill at Check-in (2026-10-29, operator: "this registration promised to pay the
 * remaining amount of the bill when it reached check-in … it should prompt the user that the
 * guest said that as well; if they can't pay here, the issue should be raised to the FOM, GM or
 * admin to let them pay during the stay, at check-out or later").
 *
 * Shown in the Check-in step's advance section whenever the guest's payment plan says the rest
 * comes at check-in. The figures are the server's (`GET /checkin-payment`); check-in waits for the
 * payment or the FOM's word (the backend refuses otherwise).
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useCheckInPayment } from "@/hooks/use-checkin-payment";
import { ApiError } from "@/lib/api/client";
import { askToPayLater, decidePayLater, PAY_BY_WORDS, withdrawPayLater, type CheckInPayBy, type CheckInPaymentStanding } from "@/lib/api/checkin-payment";
import { ADVANCE_PAYMENT_MODES, recordFolioPayment, type AdvancePaymentMode } from "@/lib/api/reservation-setup";
import { fmtDate, fmtDateTime, HOTEL_TZ_DEFAULT, money } from "@/lib/ds/format";
import { DateTimeInput } from "@/components/ds/date-input";
import { Help } from "@/components/ds/help";
import type { EntryDetail } from "@/types/api";
import { hotelLocalToIso } from "./s2-shared";
import { Choice, DsDialog, atLeast } from "./kit";

/** One line for what the FOM decided — shared by Check-in, Stay and Check-out. */
export function payLaterWords(d: { payBy: CheckInPayBy | null; dueBy: string | null }, tz?: string): string {
  if (!d.payBy) return "later";
  if (d.payBy === "DURING_STAY") return d.dueBy ? `during the stay, by ${fmtDateTime(d.dueBy, tz)}` : "during the stay";
  if (d.payBy === "AFTER_STAY") return d.dueBy ? `after the stay, by ${fmtDate(d.dueBy)}` : "after the stay";
  return PAY_BY_WORDS[d.payBy];
}

export function CheckInBalance({ entry, onChanged, tz }: { entry: EntryDetail; onChanged?: () => void; tz?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const fom = atLeast(session?.actorLevel, "L2");
  const standing = useCheckInPayment(entry.id, entry.updatedAt, { enabled: !!entry.folio }).data;

  const [amount, setAmount] = useState("");
  const touched = useRef(false);
  const [mode, setMode] = useState<AdvancePaymentMode | "">("");
  const [notes, setNotes] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [decideOpen, setDecideOpen] = useState<null | "APPROVE" | "REJECT">(null);

  const owed = standing?.stillToPay ?? null;
  // Prefill the amount with what is still to pay — the server's figure — until the desk types.
  useEffect(() => {
    if (touched.current) return;
    setAmount(owed != null && owed > 0 ? String(owed) : "");
  }, [owed]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["entry", entry.id] });
    void qc.invalidateQueries({ queryKey: ["checkin-payment", entry.id] });
    void qc.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void qc.invalidateQueries({ queryKey: ["billing-summary", entry.id] });
    void qc.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void qc.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };

  const pay = useMutation({
    mutationFn: () =>
      recordFolioPayment(session!, entry.folio!.id, {
        entryId: entry.id,
        amount: Number(amount),
        notes: notes.trim() || "The rest of the bill, at check-in",
        paymentMethod: mode || undefined,
      }),
    onSuccess: () => {
      toast.success(`${money(Number(amount))} taken`);
      touched.current = false;
      setNotes("");
      setMode("");
      refresh();
      onChanged?.();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't record the payment"),
  });

  const withdraw = useMutation({
    mutationFn: () => withdrawPayLater(session!, entry.id, standing!.open!.id),
    onSuccess: () => {
      toast.success("Request taken back");
      refresh();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't take it back"),
  });

  if (!standing || !standing.promisedAtCheckIn) return null;
  const { approved, open } = standing;
  const lastTurnedDown = !open && !approved ? standing.history.find((h) => h.status === "REJECTED") : null;

  // The FOM agreed a later time — said plainly, the money form still at hand.
  if (approved) {
    return (
      <div className="balance-due ok" role="status">
        <span className="due-head ok-ink">
          The FOM let the guest pay the rest {payLaterWords(approved, tz)}
        </span>
        <span className="sm">
          {money(approved.stillToPay)} was still to pay at check-in{approved.decisionNote ? ` · “${approved.decisionNote}”` : ""}
          {approved.payBy === "AFTER_STAY" ? " · credit extended so check-out can leave it owing" : ""}
        </span>
      </div>
    );
  }

  if (owed == null || owed <= 0) {
    return (
      <div className="balance-due ok" role="status">
        <span className="due-head ok-ink">The rest of the bill is paid</span>
        <span className="sm">
          The guest said they would pay the rest at check-in — {money(standing.received)} received of {money(standing.stayTotal ?? 0)}.
        </span>
      </div>
    );
  }

  const ready = Number(amount) > 0 && !!mode;
  return (
    <div className="answer-due balance-due" role="status">
      <span className="due-head">
        The guest said they would pay the rest at check-in
        <Help label="About the rest of the bill">
          The payment plan recorded at Set up says the rest comes at check-in. Check-in waits until it is paid, or until the FOM, the GM or an admin agrees a later time — during the stay, at check-out, or after the stay.
        </Help>
      </span>
      <span className="balance-figure">
        <strong>{money(owed)}</strong> still to pay
        <span className="sm"> · the stay {money(standing.stayTotal ?? 0)} less {money(standing.received)} received</span>
      </span>
      {standing.plan?.note ? <span className="sm">What they said: “{standing.plan.note}”</span> : null}

      {open ? (
        <div className="balance-wait">
          <strong>Waiting for the FOM</strong>
          <span className="sm">
            Asked {fmtDateTime(open.requestedAt, tz)} — “{open.reason}”
          </span>
          <div className="actbar">
            {fom ? (
              <>
                <Button className="go" onClick={() => setDecideOpen("APPROVE")}>
                  Let them pay later
                </Button>
                <Button kind="secondary" onClick={() => setDecideOpen("REJECT")}>
                  Turn it down
                </Button>
              </>
            ) : null}
            <Button kind="quiet" state={withdraw.isPending ? "working" : "default"} workingLabel="Taking back…" onClick={() => withdraw.mutate()}>
              Take the request back
            </Button>
          </div>
        </div>
      ) : lastTurnedDown ? (
        <span className="stop-ink sm" role="alert">
          The FOM turned it down{lastTurnedDown.decisionNote ? ` — “${lastTurnedDown.decisionNote}”` : ""}. Take the payment, or ask again.
        </span>
      ) : null}

      <div className="form3 balance-pay">
        <div className="field">
          <label>Amount received</label>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              touched.current = true;
              setAmount(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label>How it was paid</label>
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value as AdvancePaymentMode | "")}>
            <option value="">choose…</option>
            {ADVANCE_PAYMENT_MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Notes</label>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. the slip's reference" />
        </div>
      </div>
      <div className="actbar">
        <Button
          className={ready ? "go" : undefined}
          state={pay.isPending ? "working" : ready ? "default" : "inert"}
          workingLabel="Recording…"
          title={ready ? undefined : !mode ? "choose how it was paid" : "type the amount"}
          onClick={() => pay.mutate()}
        >
          Take the payment
        </Button>
        {!open ? (
          fom ? (
            <Button kind="secondary" onClick={() => setDecideOpen("APPROVE")}>
              Let them pay later
            </Button>
          ) : (
            <Button kind="secondary" onClick={() => setAskOpen(true)}>
              They can&rsquo;t pay now — ask the FOM
            </Button>
          )
        ) : null}
      </div>

      {askOpen ? <AskDialog entry={entry} owed={owed} onClose={() => setAskOpen(false)} onDone={refresh} /> : null}
      {decideOpen ? (
        <DecideDialog
          entry={entry}
          standing={standing}
          decision={decideOpen}
          tz={tz}
          onClose={() => setDecideOpen(null)}
          onDone={() => {
            refresh();
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

function AskDialog({ entry, owed, onClose, onDone }: { entry: EntryDetail; owed: number; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const [reason, setReason] = useState("");
  const ask = useMutation({
    mutationFn: () => askToPayLater(session!, entry.id, reason.trim()),
    onSuccess: () => {
      toast.success("Asked — the FOM is told on their screen");
      onDone();
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't ask the FOM"),
  });
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={ask.isPending}
      title="Ask the FOM to let them pay later"
      caseLines={[`${money(owed)} still to pay`]}
      help="An FOM, the GM or an admin decides when the guest pays — during the stay, at check-out, or after the stay. Check-in waits for their answer."
      footer={
        <>
          <Button kind="quiet" state={ask.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className={reason.trim() ? "go" : undefined}
            state={ask.isPending ? "working" : reason.trim() ? "default" : "inert"}
            workingLabel="Asking…"
            title={reason.trim() ? undefined : "write what the guest said"}
            onClick={() => ask.mutate()}
          >
            Ask the FOM
          </Button>
        </>
      }
    >
      <div className="field">
        <label>What did the guest say?</label>
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the card was declined — they will transfer tomorrow" autoFocus />
      </div>
    </DsDialog>
  );
}

const PAY_BY_OPTIONS: ReadonlyArray<readonly [CheckInPayBy, string]> = [
  ["DURING_STAY", "During the stay"],
  ["AT_CHECKOUT", "At check-out"],
  ["AFTER_STAY", "After the stay"],
];

function DecideDialog({
  entry,
  standing,
  decision,
  tz,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  standing: CheckInPaymentStanding;
  decision: "APPROVE" | "REJECT";
  tz?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  const [payBy, setPayBy] = useState<CheckInPayBy | null>(null);
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const needsDate = payBy === "DURING_STAY" || payBy === "AFTER_STAY";
  const ready = decision === "REJECT" ? !!note.trim() : !!payBy && !!note.trim() && (!needsDate || !!due);
  const decide = useMutation({
    mutationFn: () =>
      decidePayLater(session!, entry.id, {
        requestId: standing.open?.id ?? null,
        decision,
        payBy: decision === "APPROVE" ? payBy : null,
        dueBy: decision === "APPROVE" && needsDate ? (hotelLocalToIso(due, tz ?? HOTEL_TZ_DEFAULT) ?? new Date(due).toISOString()) : null,
        note: note.trim(),
      }),
    onSuccess: (s) => {
      toast.success(decision === "REJECT" ? "Turned down — the desk sees why" : `The guest may pay ${payLaterWords(s.approved ?? { payBy, dueBy: null }, tz)}`);
      onDone();
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't record the decision"),
  });
  const owed = standing.stillToPay ?? 0;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={decide.isPending}
      title={decision === "REJECT" ? "Turn down paying later" : "Let the guest pay later"}
      caseLines={[`${money(owed)} still to pay${standing.open ? ` · the desk asked: “${standing.open.reason}”` : ""}`]}
      help={
        decision === "REJECT"
          ? "The guest is not checked in until the rest is paid."
          : "During the stay: the desk is reminded on the date. At check-out: the bill says so. After the stay: your credit is recorded so check-out can leave it owing until the date."
      }
      footer={
        <>
          <Button kind="quiet" state={decide.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className={ready && decision === "APPROVE" ? "go" : undefined}
            kind={decision === "REJECT" ? "danger" : undefined}
            state={decide.isPending ? "working" : ready ? "default" : "inert"}
            workingLabel="Recording…"
            title={ready ? undefined : decision === "REJECT" ? "say why" : !payBy ? "pick when they will pay" : needsDate && !due ? "pick the date" : "say why"}
            onClick={() => decide.mutate()}
          >
            {decision === "REJECT" ? "Turn it down" : "Let them pay later"}
          </Button>
        </>
      }
    >
      {decision === "APPROVE" ? (
        <>
          <div className="field">
            <label>When will they pay?</label>
            <Choice options={PAY_BY_OPTIONS} value={payBy} onChange={setPayBy} />
          </div>
          {needsDate ? (
            <div className="field">
              <label>{payBy === "DURING_STAY" ? "Paying by" : "Paying by (after they leave)"}</label>
              <DateTimeInput className="input" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          ) : null}
        </>
      ) : null}
      <div className="field">
        <label>{decision === "REJECT" ? "Why not?" : "Why — it goes on the booking's history"}</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </DsDialog>
  );
}

/**
 * The FOM's "pay later" at Stay and Check-out (2026-10-29): what was agreed and what is still to
 * pay of it — the server's figure. Nothing when no such decision stands.
 */
export function PayLaterNote({ entry, tz, at }: { entry: EntryDetail; tz?: string; at: "stay" | "checkout" }) {
  const standing = useCheckInPayment(entry.id, entry.updatedAt, { enabled: !!entry.folio }).data;
  const d = standing?.decision;
  if (!d) return null;
  const owed = standing?.stillToPay ?? null;
  const paid = owed != null && owed <= 0;
  const overdue = !paid && d.payBy === "DURING_STAY" && !!d.dueBy && new Date(d.dueBy).getTime() <= Date.now();
  const tail = paid
    ? "it has been paid"
    : at === "checkout"
      ? d.payBy === "AFTER_STAY"
        ? `${money(owed ?? 0)} may be left owing — the FOM's credit runs to ${fmtDate(d.dueBy)}`
        : `${money(owed ?? 0)} of it is still to pay — settle it here`
      : `${money(owed ?? 0)} still to pay`;
  return (
    <div className={paid ? "notice ok-ink" : overdue ? "notice stop-ink" : "notice next"} role={overdue ? "alert" : "status"}>
      <strong>The FOM let the guest pay the rest of the bill {payLaterWords(d, tz)}</strong>
      {" — "}
      {tail}
      {overdue ? " · the date has passed" : ""}
      {d.decisionNote ? <span className="sm"> · “{d.decisionNote}”</span> : null}
    </div>
  );
}
