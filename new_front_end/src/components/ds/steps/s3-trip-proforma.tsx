"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, MoneyInput } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { StayDates } from "@/components/ds/stay-dates";
import { Help } from "@/components/ds/help";
import { fmtStamp, money } from "@/lib/ds/format";
import { ADVANCE_PAYMENT_MODES, type AdvancePaymentMode } from "@/lib/api/reservation-setup";
import { getTripPayment, getTripProforma, previewTripPaymentForEntry, recordTripPaymentForEntry, type TripPaymentShare } from "@/lib/api/trip-papers";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, NotSentChip, PaperDrawer, StepCard, toastRefusal, useRefreshEntry, useReplyAsked, type PaperRef } from "./kit";
import { TripAnswerDialog, TripSendDialog } from "./s2-trip-quotation";

/**
 * THE TRIP'S PROFORMA (2026-11-07, operator: each stay keeps its own proforma and the trip has one
 * of its own; a part payment goes to the first stay's advance first, or as the desk shares it).
 * On every stay's Set up when the enquiry has two stays or more: each stay's proforma, total and
 * advance, the trip's sums (all the server's), and Make · Preview · Send · the answer · a payment
 * for the trip. The stay's own proforma above stays its own.
 */
export function useTripProforma(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["trip-proforma", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getTripProforma(session!, entry.id),
    enabled: !!session,
  });
}

export function TripProformaCard({ entry, editable, inFlow = false }: { entry: EntryDetail; editable: boolean; inFlow?: boolean }) {
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const replyAsked = useReplyAsked(entry.id, "PROFORMA_INVOICE");
  const trip = useTripProforma(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const t = trip.data;
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["trip-proforma"] });
    void qc.invalidateQueries({ queryKey: ["trip-quotation"] });
    refresh(
      (t?.stays ?? []).flatMap((s) => [
        ["entry", s.entryId],
        ["entry-communications", s.entryId],
        ["payment-status", s.entryId],
        ["billing-summary", s.entryId],
      ]),
    );
  };
  if (!t || t.stays.length < 2) return null;
  const cur = t.current;
  const outOfDate = !!cur && !cur.upToDate;
  const label = cur ? `The trip's proforma ${cur.number}` : "The trip's proforma";
  const due = t.dueNow != null ? Number(t.dueNow) : null;
  const chip = !cur ? (
    <Chip tone="quiet">waits for every stay</Chip>
  ) : outOfDate ? (
    <Chip tone="warning">a stay changed</Chip>
  ) : cur.sentAt ? (
    <Chip tone="success">sent{cur.answeredAt ? " · answered" : ""}</Chip>
  ) : (
    <NotSentChip />
  );
  return (
    <StepCard
      flow={inFlow ? "proforma" : undefined}
      flowAfter={inFlow ? "billing-model" : undefined}
      summary={inFlow && cur?.sentAt ? `${cur.number} · sent${cur.answeredAt ? " · the guest's answer recorded" : ""}` : undefined}
      keepRight
      title={cur ? `Proforma · ${cur.number}` : "Proforma"}
      icon="file"
      right={chip}
      meta="One proforma for the stays, made by itself from each stay's own. Sending it sends each stay's with it. A payment for the trip goes to the first stay's advance first."
    >
      {cur ? (
        <>
          <div className="sm">
            <b>{money(cur.total)}</b> for the {t.stays.length} stays
            {t.advanceAsked ? <> · advance asked {money(t.advanceAsked)}</> : " · no advance asked"}
            {Number(t.received) > 0 ? <> · received {money(t.received)}</> : null}
            {t.dueNow != null ? (
              <>
                {" · "}
                <span className={due != null && due > 0 ? "stop-ink" : "ok-ink"}>due now {money(t.dueNow)}</span>
              </>
            ) : null}
          </div>
          {cur.sentAt ? (
            <div className="sm">
              Sent {fmtStamp(cur.sentAt)}
              {cur.sentTo ? <span className="meta"> · to {cur.sentTo}</span> : null}
            </div>
          ) : null}
        </>
      ) : null}
      {!t.canMake && t.reason ? <p className="sm warn-ink" style={{ marginTop: 8 }}>{t.reason}</p> : null}
      <div className="row-acts" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        {cur ? (
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "trip", id: cur.id, label, tripKind: "PROFORMA" })}>
            Preview
          </Button>
        ) : null}
        {editable && cur && !outOfDate && t.canMake ? (
          <Button kind={cur.sentAt ? "secondary" : "primary"} compact icon="send" onClick={() => setSendOpen(true)}>
            {cur.sentAt ? "Send again" : "Send"}
          </Button>
        ) : null}
        {editable && cur?.sentAt && !cur.answeredAt && replyAsked ? (
          <Button className="go" compact onClick={() => setAnswerOpen(true)}>
            Record the guest&rsquo;s answer
          </Button>
        ) : null}
        {editable && cur && !outOfDate ? (
          <Button
            className={due != null && due > 0 && cur.sentAt ? "go" : undefined}
            kind={due != null && due > 0 && cur.sentAt ? "primary" : "secondary"}
            compact
            onClick={() => setPayOpen(true)}
          >
            Record a payment for the trip
          </Button>
        ) : null}
      </div>
      {t.versions.length > 1 ? (
        <p className="meta" style={{ marginTop: 8 }}>
          Earlier: {t.versions.filter((v) => v.state !== "LIVE").map((v) => v.number).join(" · ")}
        </p>
      ) : null}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {sendOpen && cur ? <TripSendDialog entry={entry} tripId={cur.id} label={label} word="proforma" onClose={() => setSendOpen(false)} onSent={after} /> : null}
      {answerOpen && cur ? <TripAnswerDialog tripId={cur.id} word="proforma" onClose={() => setAnswerOpen(false)} onDone={after} /> : null}
      {payOpen && cur ? (
        <TripPaymentDialog
          entryId={entry.id}
          onClose={() => setPayOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["trip-payment"] });
            after();
          }}
        />
      ) : null}
    </StepCard>
  );
}

const isAmount = (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0;

/** The trip as a payment sees it — one read shared by the block and the box. */
export function useTripPayment(entryId: string, enabled = true) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["trip-payment", entryId],
    queryFn: () => getTripPayment(session!, entryId),
    enabled: !!session && enabled,
  });
}

/**
 * The trip in a stay's Payments (2026-11-07, operator: a trip payment "for these stages as well" —
 * Reserve and Arrival): each stay's advance, what it holds and what is still due, the trip's sums,
 * and Record a payment for the trip. Nothing when the booking is a trip of one stay.
 */
export function TripPaymentBlock({ entry }: { entry: EntryDetail }) {
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const trip = useTripPayment(entry.id);
  const [open, setOpen] = useState(false);
  const t = trip.data;
  if (!t || t.stays.length < 2) return null;
  const due = Number(t.dueNow);
  const anyPayable = t.stays.some((s) => s.payable);
  return (
    <StepCard
      title={t.tripPaper ? `The trip · ${t.tripPaper.number}` : "The trip"}
      icon="file"
      status={`${t.stays.length} stays · a payment for the trip goes to the first stay's advance first`}
      meta="A payment for the whole trip, shared between the stays' own bills. Each share is taken as that stay's own payment."
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>Stay</th>
            <th>Dates</th>
            <th style={{ textAlign: "right" }}>Advance asked</th>
            <th style={{ textAlign: "right" }}>Received</th>
            <th style={{ textAlign: "right" }}>Due now</th>
          </tr>
        </thead>
        <tbody>
          {t.stays.map((s) => (
            <tr key={s.entryId} className="static">
              <td>
                Stay {s.stayNo}
                <span className="sub">{s.entryId === entry.id ? "this booking" : s.entryId}</span>
                {!s.payable && s.why ? <span className="sub warn-ink">{s.why}</span> : null}
              </td>
              <td>
                <StayDates checkIn={s.checkIn} checkOut={s.checkOut} stacked />
              </td>
              <td style={{ textAlign: "right" }}>{s.advanceAsked ? money(s.advanceAsked) : "none"}</td>
              <td style={{ textAlign: "right" }}>{money(s.received)}</td>
              <td style={{ textAlign: "right" }} className={s.advanceAsked ? (Number(s.dueNow) > 0 ? "stop-ink" : "ok-ink") : undefined}>
                {s.advanceAsked ? money(s.dueNow) : "—"}
              </td>
            </tr>
          ))}
          <tr className="static trip-total">
            <td colSpan={3}>The trip</td>
            <td style={{ textAlign: "right" }}>{money(t.received)}</td>
            <td style={{ textAlign: "right" }} className={due > 0 ? "stop-ink" : "ok-ink"}>
              {money(t.dueNow)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="row-acts" style={{ marginTop: 10 }}>
        <Button
          className={due > 0 && anyPayable ? "go" : undefined}
          kind={due > 0 && anyPayable ? "primary" : "secondary"}
          compact
          state={anyPayable ? "default" : "inert"}
          title={anyPayable ? undefined : "No stay of this trip can take a payment here"}
          onClick={() => setOpen(true)}
        >
          Record a payment for the trip
        </Button>
      </div>
      {open ? (
        <TripPaymentDialog
          entryId={entry.id}
          onClose={() => setOpen(false)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["trip-payment"] });
            void qc.invalidateQueries({ queryKey: ["trip-proforma"] });
            refresh(t.stays.flatMap((s) => [["entry", s.entryId], ["payment-status", s.entryId], ["billing-summary", s.entryId]]));
          }}
        />
      ) : null}
    </StepCard>
  );
}

/**
 * A payment for the trip (2026-11-07): what was received and how, then how it is shared — the first
 * stay's advance first (the default), or as the desk types each stay's share. The server shares it
 * and says what is wrong; nothing is added up here. Opened from Set up's trip proforma card and from
 * Reserve's and Arrival's Payments.
 */
export function TripPaymentDialog({ entryId, onClose, onDone }: { entryId: string; onClose: () => void; onDone: () => void }) {
  const { session } = useSession();
  const standing = useTripPayment(entryId);
  const st = standing.data;
  const [amount, setAmount] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  // Filled with what the trip's advance still asks only while nothing has been paid, as a stay's own box.
  useEffect(() => {
    if (prefilled || !st) return;
    setPrefilled(true);
    if (Number(st.dueNow) > 0 && Number(st.received) === 0) setAmount(st.dueNow);
  }, [st, prefilled]);
  const [mode, setMode] = useState<AdvancePaymentMode | null>(null);
  const [how, setHow] = useState<"FIRST" | "TYPED">("FIRST");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  // The preview is asked once the typing settles.
  const ask = JSON.stringify({ amount, how, typed });
  const [settled, setSettled] = useState(ask);
  useEffect(() => {
    const h = setTimeout(() => setSettled(ask), 350);
    return () => clearTimeout(h);
  }, [ask]);
  const stays = st?.stays ?? [];
  const shares: TripPaymentShare[] | null =
    how === "TYPED" ? stays.map((s) => ({ entryId: s.entryId, amount: isAmount(typed[s.entryId] ?? "") ? Number(typed[s.entryId]) : 0 })) : null;
  const preview = useQuery({
    queryKey: ["trip-payment-preview", entryId, settled],
    queryFn: () => previewTripPaymentForEntry(session!, entryId, { amount: isAmount(amount) ? Number(amount) : null, shares }),
    enabled: !!session && !!st && isAmount(amount),
    placeholderData: (prev) => prev,
  });
  const p = preview.data;
  const fresh = settled === ask && !preview.isFetching;
  const pay = useMutation({
    mutationFn: () => recordTripPaymentForEntry(session!, entryId, { amount: Number(amount), paymentMethod: mode ?? undefined, notes: notes.trim() || undefined, shares }),
    onSuccess: (r) => {
      toast.success(`${money(r.amount)} recorded for the trip`, {
        description: r.shares.map((s) => `${money(s.amount)} to stay ${s.stayNo}`).join(" · "),
      });
      onDone();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The payment could not be recorded"),
  });
  const holdReason = !st
    ? "reading the trip"
    : !isAmount(amount)
      ? "put in the amount received"
      : !mode
        ? "choose how it was paid"
        : !fresh
          ? "working out how it is shared"
          : p?.problem
            ? p.problem
            : null;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={pay.isPending}
      width={680}
      title={st?.tripPaper ? `A payment for the trip · ${st.tripPaper.number}` : "A payment for the trip"}
      caseLines={st ? [`The trip's advance still asks ${money(st.dueNow)} · received so far ${money(st.received)}`] : undefined}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Not now
          </Button>
          <Button className="go" state={pay.isPending ? "working" : holdReason ? "inert" : "default"} title={holdReason ?? undefined} workingLabel="Recording…" onClick={() => pay.mutate()}>
            {isAmount(amount) ? `Record ${money(amount)}` : "Record the payment"}
          </Button>
        </>
      }
    >
      <div className="field">
        <label>
          Amount received
          <Help label="About the amount">What the guest paid for the trip, as one payment. It is written on each stay&rsquo;s own bill as that stay&rsquo;s share.</Help>
        </label>
        <MoneyInput value={amount} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setAmount(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>How it was paid</label>
        <Choice options={ADVANCE_PAYMENT_MODES} value={mode} onChange={setMode} />
      </div>
      <div className="field">
        <label>
          How it is shared between the stays
          <Help label="About sharing">
            First stay first: the first stay&rsquo;s advance is filled, then the next stay&rsquo;s; anything beyond the advances goes to the stays in the same order. Or type each stay&rsquo;s share yourself.
          </Help>
        </label>
        <Choice
          options={[
            ["FIRST", "First stay first"],
            ["TYPED", "Share it myself"],
          ]}
          value={how}
          onChange={(v) => {
            if (v === "TYPED" && p) setTyped(Object.fromEntries(p.stays.map((s) => [s.entryId, Number(s.share ?? 0) > 0 ? (s.share as string) : ""])));
            setHow(v);
          }}
        />
      </div>
      <table className="table compact">
        <thead>
          <tr>
            <th>Stay</th>
            <th>Its own proforma</th>
            <th style={{ textAlign: "right" }}>Advance still asked</th>
            <th style={{ textAlign: "right" }}>Gets</th>
          </tr>
        </thead>
        <tbody>
          {stays.map((s) => {
            const row = p?.stays.find((x) => x.entryId === s.entryId);
            return (
              <tr key={s.entryId} className="static">
                <td>
                  Stay {s.stayNo}
                  {!s.payable && s.why ? <span className="sub warn-ink">{s.why}</span> : null}
                </td>
                <td>{s.number ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{money((row ?? s).dueNow)}</td>
                <td style={{ textAlign: "right", width: 160 }}>
                  {how === "TYPED" ? (
                    <MoneyInput
                      aria-label={`Stay ${s.stayNo}'s share`}
                      disabled={!s.payable}
                      value={typed[s.entryId] ?? ""}
                      onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setTyped((m) => ({ ...m, [s.entryId]: e.target.value }))}
                    />
                  ) : (
                    <b>{row?.share != null ? money(row.share) : "—"}</b>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {p && isAmount(amount) ? (
        p.problem ? (
          <p className="rct-refusal" role="alert" aria-live="polite" style={{ marginTop: 8, marginBottom: 0 }}>
            <span className="ic" aria-hidden="true">
              !
            </span>
            {p.problem}
          </p>
        ) : (
          <p className="sm ok-ink" style={{ marginTop: 8, fontWeight: 700 }}>
            The shares come to {money(p.sharesTotal)}
            {how === "FIRST" ? " — the first stay's advance first" : ""}
          </p>
        )
      ) : null}
      <div className="field">
        <label>Note</label>
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="QR · paid from India · ref 4471…" />
      </div>
    </DsDialog>
  );
}
