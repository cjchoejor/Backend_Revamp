"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, MoneyInput } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { StayDates } from "@/components/ds/stay-dates";
import { Help } from "@/components/ds/help";
import { money } from "@/lib/ds/format";
import { ADVANCE_PAYMENT_MODES, type AdvancePaymentMode } from "@/lib/api/reservation-setup";
import { getTripProforma, makeTripProforma, previewTripPayment, recordTripPayment, type TripPaymentShare, type TripProforma } from "@/lib/api/trip-papers";
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

export function TripProformaCard({ entry, editable }: { entry: EntryDetail; editable: boolean }) {
  const { session } = useSession();
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
  const make = useMutation({
    mutationFn: () => makeTripProforma(session!, entry.id),
    onSuccess: (r) => {
      toast.success(r.made ? "The trip's proforma is made" : "The trip's proforma already holds these stays");
      after();
    },
    onError: (e) => toastRefusal(e, "The trip's proforma could not be made"),
  });
  if (!t || t.stays.length < 2) return null;
  const cur = t.current;
  const outOfDate = !!cur && !cur.upToDate;
  const label = cur ? `The trip's proforma ${cur.number}` : "The trip's proforma";
  const due = t.dueNow != null ? Number(t.dueNow) : null;
  const chip = !cur ? (
    <Chip tone="quiet">not made yet</Chip>
  ) : outOfDate ? (
    <Chip tone="warning">a stay changed</Chip>
  ) : cur.sentAt ? (
    <Chip tone="success">sent{cur.answeredAt ? " · answered" : ""}</Chip>
  ) : (
    <NotSentChip />
  );
  return (
    <StepCard
      title={cur ? `The trip's proforma · ${cur.number}` : "The trip's proforma"}
      icon="file"
      right={chip}
      status={`${t.stays.length} stays · a payment for the trip goes to the first stay's advance first`}
      meta="Each stay keeps its own proforma; this one is made of them and is the guest's paper by default. Its totals are only the stays' added up. A change to a stay's proforma makes this one again, as its next version."
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>Stay</th>
            <th>Dates</th>
            <th>Its own proforma</th>
            <th style={{ textAlign: "right" }}>Total</th>
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
                {s.entryId === entry.id ? <span className="sub">this booking</span> : <span className="sub">{s.entryId}</span>}
              </td>
              <td>
                <StayDates checkIn={s.checkIn} checkOut={s.checkOut} stacked />
              </td>
              <td>
                {s.proforma ? (
                  <>
                    {s.proforma.number}
                    <span className="sub">{s.proforma.lapsed ? "ran out" : s.proforma.sent ? "sent" : "not sent"}</span>
                  </>
                ) : (
                  <span className="warn-ink">none yet</span>
                )}
              </td>
              <td style={{ textAlign: "right" }}>{s.proforma ? money(s.proforma.total) : "—"}</td>
              <td style={{ textAlign: "right" }}>{s.proforma?.advanceAsked ? money(s.proforma.advanceAsked) : "none"}</td>
              <td style={{ textAlign: "right" }}>{s.proforma ? money(s.proforma.received) : "—"}</td>
              <td style={{ textAlign: "right" }} className={s.proforma?.advanceAsked ? (Number(s.proforma.dueNow) > 0 ? "stop-ink" : "ok-ink") : undefined}>
                {s.proforma?.advanceAsked ? money(s.proforma.dueNow) : "—"}
              </td>
            </tr>
          ))}
          <tr className="static trip-total">
            <td colSpan={3}>The trip</td>
            <td style={{ textAlign: "right" }}>{t.total ? money(t.total) : "—"}</td>
            <td style={{ textAlign: "right" }}>{t.advanceAsked ? money(t.advanceAsked) : "none"}</td>
            <td style={{ textAlign: "right" }}>{money(t.received)}</td>
            <td style={{ textAlign: "right" }} className={due != null ? (due > 0 ? "stop-ink" : "ok-ink") : undefined}>
              {t.dueNow != null ? money(t.dueNow) : "—"}
            </td>
          </tr>
        </tbody>
      </table>
      {!t.canMake && t.reason ? <p className="sm warn-ink" style={{ marginTop: 8 }}>{t.reason}</p> : null}
      {outOfDate ? (
        <p className="sm warn-ink" style={{ marginTop: 8 }}>
          A stay&rsquo;s proforma changed since {cur!.number} was made — make it again before sending it or taking money against it.
        </p>
      ) : null}
      <div className="row-acts" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        {editable && t.canMake && (!cur || outOfDate) ? (
          <Button className="go" compact state={make.isPending ? "working" : "default"} workingLabel="Making…" onClick={() => make.mutate()}>
            {cur ? "Make it again" : "Make the trip's proforma"}
          </Button>
        ) : null}
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
      {payOpen && cur ? <TripPaymentDialog trip={t} tripId={cur.id} number={cur.number} onClose={() => setPayOpen(false)} onDone={after} /> : null}
    </StepCard>
  );
}

const isAmount = (v: string) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) > 0;

/**
 * A payment for the trip (2026-11-07): what was received and how, then how it is shared — the first
 * stay's advance first (the default), or as the desk types each stay's share. The server shares it
 * and says what is wrong; nothing is added up here.
 */
function TripPaymentDialog({
  trip,
  tripId,
  number,
  onClose,
  onDone,
}: {
  trip: TripProforma;
  tripId: string;
  number: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  // Filled with what the trip's advance still asks only while nothing has been paid, as a stay's own box.
  const [amount, setAmount] = useState(trip.dueNow && Number(trip.dueNow) > 0 && Number(trip.received) === 0 ? trip.dueNow : "");
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
  const shares: TripPaymentShare[] | null =
    how === "TYPED" ? trip.stays.map((s) => ({ entryId: s.entryId, amount: isAmount(typed[s.entryId] ?? "") ? Number(typed[s.entryId]) : 0 })) : null;
  const preview = useQuery({
    queryKey: ["trip-payment-preview", tripId, settled],
    queryFn: () => previewTripPayment(session!, tripId, { amount: isAmount(amount) ? Number(amount) : null, shares }),
    enabled: !!session && isAmount(amount),
    placeholderData: (prev) => prev,
  });
  const p = preview.data;
  const fresh = settled === ask && !preview.isFetching;
  const pay = useMutation({
    mutationFn: () => recordTripPayment(session!, tripId, { amount: Number(amount), paymentMethod: mode ?? undefined, notes: notes.trim() || undefined, shares }),
    onSuccess: (r) => {
      toast.success(`${money(r.amount)} recorded for the trip`, {
        description: r.shares.map((s) => `${money(s.amount)} to stay ${s.stayNo}`).join(" · "),
      });
      const notBlocked = r.autoHolds.filter((h) => h.autoHold && !h.autoHold.placed && h.autoHold.reason !== "ALREADY_HELD" && h.autoHold.reason !== "NOT_AT_S3");
      if (notBlocked.length) toast.warning("Some rooms were not blocked automatically", { description: "Move to Reserve blocks them.", duration: 10000 });
      onDone();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The payment could not be recorded"),
  });
  const holdReason = !isAmount(amount)
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
      title={`A payment for the trip · ${number}`}
      caseLines={[`The trip's advance still asks ${trip.dueNow != null ? money(trip.dueNow) : "nothing"} · received so far ${money(trip.received)}`]}
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
            if (v === "TYPED" && p) setTyped(Object.fromEntries(p.stays.map((s) => [s.entryId, Number(s.share) > 0 ? s.share : ""])));
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
          {trip.stays.map((s) => {
            const row = p?.stays.find((x) => x.entryId === s.entryId);
            return (
              <tr key={s.entryId} className="static">
                <td>Stay {s.stayNo}</td>
                <td>{s.proforma?.number ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{row ? money(row.dueNow) : s.proforma ? money(s.proforma.dueNow) : "—"}</td>
                <td style={{ textAlign: "right", width: 160 }}>
                  {how === "TYPED" ? (
                    <MoneyInput
                      aria-label={`Stay ${s.stayNo}'s share`}
                      value={typed[s.entryId] ?? ""}
                      onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setTyped((m) => ({ ...m, [s.entryId]: e.target.value }))}
                    />
                  ) : (
                    <b>{row ? money(row.share) : "—"}</b>
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
