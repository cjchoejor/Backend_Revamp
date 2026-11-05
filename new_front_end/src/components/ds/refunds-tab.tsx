"use client";

/**
 * Notifications › Refunds (2026-11-05, operator: "there should a tab for refund where the above told
 * details are shown"; "fom and gm should also be allowed to enter the account number if refunded by
 * bank or card or online payment with bank name field as well, and the amount refunded, and the
 * journal number, if cash no need, and then saved"). For the FOM, GM and admin: the route refuses the
 * front desk, since it carries bank details. Every figure is the server's.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, EmptyState, MoneyInput } from "@/design-system";
import { LoadFailed, LoadingBlock, MoreRow, usePaged } from "@/components/ds/ui";
import { StayDates } from "@/components/ds/stay-dates";
import { useRefunds } from "@/hooks/use-refunds";
import { useSession } from "@/hooks/use-session";
import { keepRefund, recordRefund, type RefundRow } from "@/lib/api/refunds";
import { fmtDateTime, money, plural } from "@/lib/ds/format";
import { endingOf } from "@/lib/ds/status";
import { stepName, stepNoOfStage } from "@/lib/ds/steps";
import { RefundCoin, REFUND_METHOD_WORD } from "./refund-bits";
import { Choice, DsDialog, PaperDrawer, toastRefusal, type PaperRef } from "./steps/kit";

const CAUSE_WORD: Record<RefundRow["cause"], string> = {
  RENEGOTIATED: "The desk chose to refund it when the booking was priced again",
  LAPSED: "The booking lapsed while it held this money",
};

const METHODS = [
  ["CASH", "Cash"],
  ["BANK_TRANSFER", "Bank transfer"],
  ["CARD", "Card"],
  ["MOBILE_PAYMENT", "Online payment"],
] as const;

function whereItStands(r: RefundRow) {
  const b = r.booking;
  if (b.status === "ACTIVE" || b.status === "PARKED") {
    return `${b.status === "PARKED" ? "Parked at " : "At "}${stepName(stepNoOfStage(b.stage))}`;
  }
  return endingOf(b.closedAs)?.word ?? "Ended";
}

function partyLine(r: RefundRow) {
  const b = r.booking;
  const guests = b.adults != null ? [plural(b.adults, "adult"), b.children ? plural(b.children, "child", "children") : null].filter(Boolean).join(" · ") : b.guests != null ? plural(b.guests, "guest") : null;
  return [b.rooms != null ? plural(b.rooms, "room") : null, guests].filter(Boolean).join(" · ");
}

function RecordDialog({ row, tz, onClose }: { row: RefundRow; tz: string; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [method, setMethod] = useState<string | null>(null);
  const [amount, setAmount] = useState(String(row.amountAsked));
  const [bank, setBank] = useState("");
  const [account, setAccount] = useState("");
  const [journal, setJournal] = useState("");
  const [note, setNote] = useState("");
  const n = Number(amount);
  const amountOk = /^\d+(\.\d{1,2})?$/.test(amount) && n > 0 && n <= row.amountAsked;
  const needsDetails = !!method && method !== "CASH";
  const detailsOk = !needsDetails || (!!bank.trim() && !!account.trim() && !!journal.trim());
  const ok = !!method && amountOk && detailsOk;
  const left = amountOk ? Number((row.amountAsked - n).toFixed(2)) : 0;
  const why = !method
    ? "choose how it went back"
    : !amountOk
      ? `an amount up to ${money(row.amountAsked, row.currency)}`
      : !detailsOk
        ? "the bank's name, the account number and the journal number"
        : undefined;
  const save = useMutation({
    mutationFn: () =>
      recordRefund(session!, row.id, {
        method: method!,
        amount: n,
        ...(needsDetails ? { bankName: bank.trim(), accountNumber: account.trim(), journalNumber: journal.trim() } : {}),
        note: note.trim() || undefined,
      }),
    onSuccess: (out) => {
      toast.success(`${money(out.refunded, row.currency)} refunded · recorded against the bill`, {
        description: out.stayedOnBill > 0 ? `${money(out.stayedOnBill, row.currency)} stays on the bill.` : undefined,
        duration: 9000,
      });
      void qc.invalidateQueries({ queryKey: ["refunds"] });
      void qc.invalidateQueries({ queryKey: ["payment-status", row.booking.id] });
      void qc.invalidateQueries({ queryKey: ["entry", row.booking.id] });
      onClose();
    },
    onError: (e) => toastRefusal(e, "The refund could not be saved"),
  });
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      busy={save.isPending}
      title="Record the refund"
      caseLines={[`${row.guest.name ?? row.booking.id} · ${money(row.amountAsked, row.currency)} · ${row.id}`, `Asked ${fmtDateTime(row.raisedAt, tz)}`]}
      footer={
        <>
          {why ? <span className="sm warn-ink">First: {why}</span> : null}
          <Button className="go" state={save.isPending ? "working" : ok ? "default" : "inert"} workingLabel="Saving…" reason={why} onClick={() => save.mutate()}>
            Save the refund
          </Button>
        </>
      }
    >
      <div className="field">
        <label>How did it go back?</label>
        <Choice options={METHODS} value={method as (typeof METHODS)[number][0] | null} onChange={setMethod} />
      </div>
      <div className="field">
        <label>Amount refunded</label>
        <MoneyInput value={amount} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setAmount(e.target.value)} />
        {amountOk && left > 0 ? <span className="hint">{money(left, row.currency)} stays on the bill.</span> : null}
        {amount && !amountOk ? <span className="hint stop-ink">At most {money(row.amountAsked, row.currency)}.</span> : null}
      </div>
      {needsDetails ? (
        <>
          <div className="field">
            <label>Bank name</label>
            <input value={bank} onChange={(e) => setBank(e.target.value)} maxLength={120} autoFocus />
          </div>
          <div className="form2">
            <div className="field">
              <label>Account number</label>
              <input value={account} onChange={(e) => setAccount(e.target.value)} maxLength={60} />
            </div>
            <div className="field">
              <label>Journal number</label>
              <input value={journal} onChange={(e) => setJournal(e.target.value)} maxLength={60} />
            </div>
          </div>
        </>
      ) : null}
      <div className="field">
        <label>Note · optional</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </div>
    </DsDialog>
  );
}

function KeepDialog({ row, onClose }: { row: RefundRow; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const live = row.booking.status === "ACTIVE" || row.booking.status === "PARKED";
  const save = useMutation({
    mutationFn: () => keepRefund(session!, row.id, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(live ? `${money(row.amountAsked, row.currency)} stays on the booking` : `The hotel keeps ${money(row.amountAsked, row.currency)}`);
      void qc.invalidateQueries({ queryKey: ["refunds"] });
      void qc.invalidateQueries({ queryKey: ["payment-status", row.booking.id] });
      void qc.invalidateQueries({ queryKey: ["entry", row.booking.id] });
      onClose();
    },
    onError: (e) => toastRefusal(e, "That could not be saved"),
  });
  return (
    <DsDialog
      open
      closeX
      onClose={onClose}
      busy={save.isPending}
      title={live ? "Keep it on the booking" : "The hotel keeps it"}
      caseLines={[`${row.guest.name ?? row.booking.id} · ${money(row.amountAsked, row.currency)} · ${row.id}`]}
      footer={
        <Button state={save.isPending ? "working" : reason.trim() ? "default" : "inert"} workingLabel="Saving…" reason={reason.trim() ? undefined : "say why"} onClick={() => save.mutate()}>
          {live ? "Keep it on the booking" : "Keep it, no refund"}
        </Button>
      }
    >
      <p className="sm" style={{ marginBottom: 10 }}>
        {live ? "No refund. The money counts on this booking again." : "No refund. The money stays with the hotel, and the record says why."}
      </p>
      <div className="field">
        <label>Why?</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoFocus />
      </div>
    </DsDialog>
  );
}

function WaitingCard({ row, tz, focus }: { row: RefundRow; tz: string; focus: boolean }) {
  const [recording, setRecording] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const ref = useRef<HTMLElement | null>(null);
  // The bell's row asked to come here.
  useEffect(() => {
    if (focus && ref.current) ref.current.scrollIntoView({ block: "center" });
  }, [focus]);
  const b = row.booking;
  const g = row.guest;
  const live = b.status === "ACTIVE" || b.status === "PARKED";
  return (
    <article ref={ref} className={`refund-card${focus ? " focus" : ""}`} data-refund={row.id}>
      <header className="refund-head">
        <RefundCoin size="lg" />
        <div className="refund-amt">
          <b className="money">{money(row.amountAsked, row.currency)}</b>
          <span className="sm">to refund · {row.id}</span>
        </div>
        <Chip tone="warning">Waiting</Chip>
        <div className="refund-acts">
          <Button kind="secondary" onClick={() => setKeeping(true)}>
            {live ? "Keep it on the booking" : "The hotel keeps it"}
          </Button>
          <Button className="go" onClick={() => setRecording(true)}>
            Record the refund
          </Button>
        </div>
      </header>
      <p className="sm refund-why">
        {CAUSE_WORD[row.cause]} · {row.raisedByName ?? "the desk"} · {fmtDateTime(row.raisedAt, tz)}
        {row.note ? ` · “${row.note}”` : ""}
      </p>
      <div className="refund-grid">
        <section>
          <h5>The guest</h5>
          <b>{g.name ?? "No name on file"}</b>
          {g.phone ? <div className="sm">{g.phone}</div> : null}
          {g.email ? <div className="sm">{g.email}</div> : null}
          {g.nationality ? <div className="sm">{g.nationality}</div> : null}
        </section>
        <section>
          <h5>The booking</h5>
          <Link className="row-link" href={`/bookings/${encodeURIComponent(b.id)}`}>
            {b.id}
          </Link>
          {b.inquiryId ? <div className="meta">{b.inquiryId}</div> : null}
          <div style={{ margin: "4px 0" }}>
            <StayDates checkIn={b.checkInDate} checkOut={b.checkOutDate} />
          </div>
          <div className="sm">{partyLine(row)}</div>
          {b.party ? <div className="sm">Through {b.party}</div> : null}
          <div className="sm">
            <b>{whereItStands(row)}</b>
          </div>
        </section>
        <section>
          <h5>The money paid</h5>
          {row.payments.map((p) => (
            <div key={p.id} className="sm refund-pay">
              <b className="money">{money(p.amount, row.currency)}</b> · {p.method ? (REFUND_METHOD_WORD[p.method] ?? p.method) : "not said"} · {fmtDateTime(p.receivedAt, tz)}
              {p.notes ? ` · ${p.notes}` : ""}
              {p.recordedByName ? ` · ${p.recordedByName}` : ""}
            </div>
          ))}
          {row.paidOn ? (
            <div className="sm refund-paper">
              Proforma {row.paidOn.number}
              {row.paidOn.version > 1 ? ` · v${row.paidOn.version}` : ""}
              {row.paidOn.sentAt ? ` · sent ${fmtDateTime(row.paidOn.sentAt, tz)}` : " · not sent"}
              <Button
                kind="secondary"
                compact
                icon="file"
                onClick={() => setPaper({ kind: "invoice", id: row.paidOn!.id, invoiceType: "PROFORMA", frozen: row.paidOn!.stored, label: `Proforma ${row.paidOn!.number}` })}
              >
                View
              </Button>
            </div>
          ) : (
            <div className="sm meta">No proforma on file for this money.</div>
          )}
        </section>
      </div>
      {recording ? <RecordDialog row={row} tz={tz} onClose={() => setRecording(false)} /> : null}
      {keeping ? <KeepDialog row={row} onClose={() => setKeeping(false)} /> : null}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </article>
  );
}

const DONE_WORD: Record<string, string> = { REFUNDED: "Refunded", KEPT: "Kept", CANCELLED: "Closed by a cancellation" };

function DoneTable({ tz }: { tz: string }) {
  const done = useRefunds("done");
  const rows = done.data?.items ?? [];
  const paged = usePaged(rows);
  if (done.isLoading) return <LoadingBlock />;
  if (done.error) return <LoadFailed what="the refunds" onRetry={() => void done.refetch()} />;
  if (rows.length === 0) return null;
  return (
    <section className="block" style={{ marginTop: 24 }}>
      <div className="block-head">
        <h3>
          Answered <span className="meta">{rows.length}</span>
        </h3>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Refund</th>
            <th>Booking</th>
            <th>What happened</th>
            <th>How it went back</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {paged.shown.map((r) => (
            <tr key={r.id} data-refund-done={r.id}>
              <td>
                <b>{r.guest.name ?? "—"}</b>
                <div className="meta">{r.id}</div>
              </td>
              <td>
                <Link className="row-link" href={`/bookings/${encodeURIComponent(r.booking.id)}`}>
                  {r.booking.id}
                </Link>
              </td>
              <td>
                {DONE_WORD[r.status] ?? r.status} <b className="money">{money(r.status === "REFUNDED" ? r.refundedAmount : r.amountAsked, r.currency)}</b>
                {r.status === "REFUNDED" && r.refundedAmount != null && r.refundedAmount < r.amountAsked ? (
                  <div className="meta">of {money(r.amountAsked, r.currency)} · the rest stayed on the bill</div>
                ) : null}
                {r.closeNote ? <div className="meta">{r.closeNote}</div> : null}
              </td>
              <td>
                {r.refundMethod ? (REFUND_METHOD_WORD[r.refundMethod] ?? r.refundMethod) : "—"}
                {r.bankName ? <div className="meta">{r.bankName}</div> : null}
                {r.accountNumber ? <div className="meta">Account {r.accountNumber}</div> : null}
                {r.journalNumber ? <div className="meta">Journal {r.journalNumber}</div> : null}
              </td>
              <td>
                {r.closedAt ? fmtDateTime(r.closedAt, tz) : "—"}
                {r.closedByName ? <div className="meta">{r.closedByName}</div> : null}
              </td>
            </tr>
          ))}
          <MoreRow more={paged.more} onMore={paged.showMore} colSpan={5} />
        </tbody>
      </table>
    </section>
  );
}

export function RefundsTab({ tz, focusId }: { tz: string; focusId: string | null }) {
  const waiting = useRefunds("waiting");
  const rows = waiting.data?.items ?? [];
  return (
    <>
      {waiting.isLoading ? (
        <LoadingBlock />
      ) : waiting.error ? (
        <LoadFailed what="the refunds" onRetry={() => void waiting.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No refund is waiting">Money that has to go back to a guest shows here.</EmptyState>
      ) : (
        <div className="refund-list">
          {rows.map((r) => (
            <WaitingCard key={r.id} row={r} tz={tz} focus={focusId === r.id} />
          ))}
        </div>
      )}
      <DoneTable tz={tz} />
    </>
  );
}
