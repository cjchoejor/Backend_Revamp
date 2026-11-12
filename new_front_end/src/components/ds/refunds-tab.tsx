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
import { Button, Chip, EmptyState, Input, MoneyInput } from "@/design-system";
import { LoadFailed, LoadingBlock, MoreRow, OpenRow, usePaged } from "@/components/ds/ui";
import { Help } from "@/components/ds/help";
import { StayDates } from "@/components/ds/stay-dates";
import { useRefunds, useRefundsMade } from "@/hooks/use-refunds";
import { useSession } from "@/hooks/use-session";
import { keepRefund, recordRefund, type BookingRefunds, type RefundRow } from "@/lib/api/refunds";
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

/* ------------------------------------------------------------------ refunds made */

export const methodWord = (m: string | null) => (m ? (REFUND_METHOD_WORD[m] ?? m.charAt(0) + m.slice(1).toLowerCase().replace(/_/g, " ")) : "—");

export function refundStanding(b: BookingRefunds) {
  if (b.status === "ACTIVE" || b.status === "PARKED") return `${b.status === "PARKED" ? "Parked at " : "At "}${stepName(stepNoOfStage(b.stage ?? "S1"))}`;
  return endingOf(b.closedAs)?.word ?? (b.status === "CANCELLED" ? "Cancelled" : b.status === "CLOSED" ? "Closed" : "Ended");
}

/**
 * Refunds made, booking by booking (2026-11-12, operator: "the list of refunds made to a booking … the
 * total refund made to that booking, when clicked on it, which refunds were made, when, at what stage,
 * reason if there is, by who, to be human readable, avoid unnecessary words"). The server sums.
 */
function RefundsMadeTable({ tz }: { tz: string }) {
  const made = useRefundsMade();
  const [picked, setPicked] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const bookings = made.data?.bookings ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? bookings.filter((b) => [b.guestName, b.entryId, b.inquiryId, b.party].filter(Boolean).join(" ").toLowerCase().includes(needle))
    : bookings;
  const paged = usePaged(shown, 25);
  if (made.isLoading) return <LoadingBlock />;
  if (made.error) return <LoadFailed what="the refunds made" onRetry={() => void made.refetch()} />;
  const t = made.data!.totals;
  return (
    <section className="block refunds-made" data-refunds-made>
      <div className="block-head">
        <h3>
          Refunds made
          <Help label="About this list">Double-click a booking to see its refunds.</Help>
        </h3>
        {t.refunds ? (
          <span className="meta" data-refunds-total>
            {plural(t.refunds, "refund")} to {plural(t.bookings, "booking")} · <b className="money">{money(t.amount, t.currency)}</b> in all
          </span>
        ) : null}
      </div>
      {!bookings.length ? (
        <EmptyState title="No refund made yet" />
      ) : (
        <>
          <div className="filters">
            <div className="field searchwrap" style={{ width: 320 }}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, booking or agency" aria-label="Search the refunds" />
            </div>
            {needle ? <span className="meta">{shown.length} of {bookings.length}</span> : null}
          </div>
          <table className="table zebra refund-table">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Stay</th>
                <th>Where it stands</th>
                <th>Last refund</th>
                <th className="num">Refunded</th>
              </tr>
            </thead>
            <tbody>
              {paged.shown.map((b, i) => (
                <OpenRow
                  key={b.entryId}
                  entryId={b.entryId}
                  href={`/billing/refunds/${encodeURIComponent(b.entryId)}`}
                  alt={i % 2 === 1}
                  selected={picked === b.entryId}
                  onSelect={() => setPicked((p) => (p === b.entryId ? null : b.entryId))}
                >
                  <td data-refund-booking={b.entryId}>
                    <Link className="row-link" href={`/bookings/${encodeURIComponent(b.entryId)}`} onClick={(e) => e.stopPropagation()}>
                      {b.guestName ?? b.entryId}
                    </Link>
                    <div className="meta">{[b.entryId, b.party].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>
                    <StayDates stacked compact checkIn={b.checkInDate} checkOut={b.checkOutDate} />
                  </td>
                  <td className="ink-2">{refundStanding(b)}</td>
                  <td className="ink-2">{fmtDateTime(b.lastAt, tz)}</td>
                  <td className="num">
                    <b className="money">{money(b.total, b.currency)}</b>
                    {b.count > 1 ? <div className="meta">{plural(b.count, "refund")}</div> : null}
                  </td>
                </OpenRow>
              ))}
              <MoreRow more={paged.more} onMore={paged.showMore} colSpan={5} step={25} />
            </tbody>
          </table>
        </>
      )}
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
      ) : rows.length ? (
        <section className="block">
          <div className="block-head">
            <h3>
              To make <span className="meta">{rows.length}</span>
            </h3>
          </div>
          <div className="refund-list">
            {rows.map((r) => (
              <WaitingCard key={r.id} row={r} tz={tz} focus={focusId === r.id} />
            ))}
          </div>
        </section>
      ) : null}
      <RefundsMadeTable tz={tz} />
    </>
  );
}
