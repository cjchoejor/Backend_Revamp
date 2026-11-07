"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { problemOfPhone } from "@/lib/ds/phone";
import { PhoneField } from "@/components/ds/phone-field";
import { StayDates } from "@/components/ds/stay-dates";
import { Help } from "@/components/ds/help";
import { money } from "@/lib/ds/format";
import { answerTripQuotation, getTripQuotation, makeTripQuotation, sendTripQuotation } from "@/lib/api/trip-papers";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, NotSentChip, PaperDrawer, SendPaperPanel, StepCard, toastRefusal, useRefreshEntry, useReplyAsked, type PaperRef } from "./kit";

/**
 * THE TRIP'S QUOTATION (2026-11-07, operator: each stay keeps its own quotation and the trip has
 * one of its own, "QUO-0003 v2"). On every stay's Negotiation when the enquiry has more than one
 * stay: the stays with their own quotations and totals, the trip total (the server's sum), the trip
 * paper's number and version, and Make · Preview · Send · the guest's answer. The stay's own
 * quotation above stays the separate view.
 */
/** The trip this booking is a stay of, with the trip's quotation — one read shared by the cards. */
export function useTripQuotation(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["trip-quotation", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getTripQuotation(session!, entry.id),
    enabled: !!session,
  });
}

export function TripQuotationCard({ entry, editable }: { entry: EntryDetail; editable: boolean }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const replyAsked = useReplyAsked(entry.id, "QUOTATION");
  const trip = useTripQuotation(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["trip-quotation"] });
    refresh((t?.stays ?? []).flatMap((s) => [["entry", s.entryId], ["entry-communications", s.entryId]]));
  };
  const make = useMutation({
    mutationFn: () => makeTripQuotation(session!, entry.id),
    onSuccess: (r) => {
      toast.success(r.made ? "The trip's quotation is made" : "The trip's quotation already holds these stays");
      after();
    },
    onError: (e) => toastRefusal(e, "The trip's quotation could not be made"),
  });
  const t = trip.data;
  if (!t || t.stays.length < 2) return null;
  const cur = t.current;
  const outOfDate = !!cur && !cur.upToDate;
  const label = cur ? `The trip's quotation ${cur.number}` : "The trip's quotation";
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
      title={cur ? `The trip's quotation · ${cur.number}` : "The trip's quotation"}
      icon="file"
      right={chip}
      status={`${t.stays.length} stays · each keeps its own quotation · the trip's is made of them`}
      meta="The guest gets this one by default. Its total is only the stays' totals added up. A change to a stay makes the trip's quotation again, as its next version."
    >
      <table className="table compact">
        <thead>
          <tr>
            <th>Stay</th>
            <th>Dates</th>
            <th>Its own quotation</th>
            <th style={{ textAlign: "right" }}>Total</th>
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
              <td>{s.quotation ? s.quotation.number : <span className="warn-ink">not priced yet</span>}</td>
              <td style={{ textAlign: "right" }}>{s.quotation ? money(s.quotation.total) : "—"}</td>
            </tr>
          ))}
          <tr className="static trip-total">
            <td colSpan={3}>Trip total</td>
            <td style={{ textAlign: "right" }}>{t.total ? money(t.total) : "—"}</td>
          </tr>
        </tbody>
      </table>
      {!t.canMake && t.reason ? <p className="sm warn-ink" style={{ marginTop: 8 }}>{t.reason}</p> : null}
      {outOfDate ? (
        <p className="sm warn-ink" style={{ marginTop: 8 }}>
          A stay&rsquo;s quotation changed since {cur!.number} was made — make it again before sending.
        </p>
      ) : null}
      <div className="row-acts" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
        {editable && t.canMake && (!cur || outOfDate) ? (
          <Button className="go" compact state={make.isPending ? "working" : "default"} workingLabel="Making…" onClick={() => make.mutate()}>
            {cur ? "Make it again" : "Make the trip's quotation"}
          </Button>
        ) : null}
        {cur ? (
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "trip", id: cur.id, label, tripKind: "QUOTATION" })}>
            Preview
          </Button>
        ) : null}
        {editable && cur && !outOfDate ? (
          <Button kind={cur.sentAt ? "secondary" : "primary"} compact icon="send" onClick={() => setSendOpen(true)}>
            {cur.sentAt ? "Send again" : "Send"}
          </Button>
        ) : null}
        {editable && cur?.sentAt && !cur.answeredAt && replyAsked ? (
          <Button className="go" compact onClick={() => setAnswerOpen(true)}>
            Record the guest&rsquo;s answer
          </Button>
        ) : null}
      </div>
      {t.versions.length > 1 ? (
        <p className="meta" style={{ marginTop: 8 }}>
          Earlier: {t.versions.filter((v) => v.state !== "LIVE").map((v) => v.number).join(" · ")}
        </p>
      ) : null}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      {sendOpen && cur ? <TripSendDialog entry={entry} tripId={cur.id} label={label} onClose={() => setSendOpen(false)} onSent={after} /> : null}
      {answerOpen && cur ? <TripAnswerDialog tripId={cur.id} onClose={() => setAnswerOpen(false)} onDone={after} /> : null}
    </StepCard>
  );
}

/** Send a trip's paper — its quotation or its proforma — by email or WhatsApp, the paper beside the box. */
export function TripSendDialog({
  entry,
  tripId,
  label,
  word = "quotation",
  onClose,
  onSent,
}: {
  entry: EntryDetail;
  tripId: string;
  label: string;
  word?: "quotation" | "proforma";
  onClose: () => void;
  onSent: () => void;
}) {
  const { session } = useSession();
  const recipient = useInvoiceRecipient(entry);
  const phoneRules = usePhoneRules();
  const [channel, setChannel] = useState<"EMAIL" | "WHATSAPP">("EMAIL");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || recipient.loading) return;
    setEmail(recipient.defaultTo);
    setPhone(recipient.phone);
  }, [touched, recipient.loading, recipient.defaultTo, recipient.phone]);
  const to = channel === "EMAIL" ? email.trim() : phone.trim();
  const emailBad = channel === "EMAIL" && !!to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to);
  const phoneBad = channel === "WHATSAPP" ? problemOfPhone(phoneRules, to) : null;
  const send = useMutation({
    mutationFn: () => sendTripQuotation(session!, tripId, { channel, to: to || null }),
    onSuccess: (r) => {
      toast.success(
        r.channel === "WHATSAPP"
          ? `${r.number} recorded as sent on WhatsApp${r.sentTo ? ` to ${r.sentTo}` : ""} — each stay's ${word} with it`
          : r.sentTo
            ? `${r.number} sent by email to ${r.sentTo} — each stay's ${word} with it`
            : `${r.number} recorded as sent — nothing was emailed (no address); hand it over`,
      );
      onSent();
      onClose();
    },
    onError: (e) => toastRefusal(e, `The trip's ${word} could not be sent`),
  });
  const blocked = channel === "EMAIL" ? (emailBad ? "that is not an email address" : null) : phoneBad;
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={send.isPending}
      beside={<SendPaperPanel paper={{ kind: "trip", id: tripId, label, tripKind: word === "proforma" ? "PROFORMA" : "QUOTATION" }} />}
      title={`Send ${label.replace(`The trip's ${word} `, "")}`}
      help={`One email with the trip's paper; each stay's ${word} not sent yet is sent with it, with no email of its own.`}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Not now
          </Button>
          <Button icon="send" state={send.isPending ? "working" : blocked ? "inert" : "default"} title={blocked ?? undefined} workingLabel="Sending…" onClick={() => send.mutate()}>
            Send now
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Send via</label>
        <Choice
          options={[
            ["EMAIL", "Email"],
            ["WHATSAPP", "WhatsApp"],
          ]}
          value={channel}
          onChange={setChannel}
        />
      </div>
      {channel === "EMAIL" ? (
        <div className="field">
          <label>
            Email address
            {recipient.defaultWhose && email.trim() === recipient.defaultTo ? <span className="muted"> · {recipient.defaultWhose}</span> : null}
          </label>
          <input
            className="input"
            value={email}
            placeholder="name@example.com"
            onChange={(e) => {
              setTouched(true);
              setEmail(e.target.value);
            }}
          />
        </div>
      ) : (
        <div className="field">
          <label>
            WhatsApp number
            {recipient.phoneWhose && phone.trim() === recipient.phone ? <span className="muted"> · {recipient.phoneWhose}</span> : null}
          </label>
          <PhoneField
            value={phone}
            ariaLabel="WhatsApp number"
            onChange={(v) => {
              setTouched(true);
              setPhone(v);
            }}
          />
        </div>
      )}
    </DsDialog>
  );
}

/** The guest's answer to a trip's paper, recorded on each stay's paper it was sent with. */
export function TripAnswerDialog({
  tripId,
  word = "quotation",
  onClose,
  onDone,
}: {
  tripId: string;
  word?: "quotation" | "proforma";
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();
  const [method, setMethod] = useState<"WRITTEN" | "VERBAL" | "">("");
  const [said, setSaid] = useState("");
  const answer = useMutation({
    mutationFn: () => answerTripQuotation(session!, tripId, { method: method as "WRITTEN" | "VERBAL", verbatimNote: said.trim() || null }),
    onSuccess: (r) => {
      toast.success(r.recorded ? `The guest's answer is recorded on ${r.recorded === 1 ? "1 stay's" : `${r.recorded} stays'`} ${word}${r.recorded === 1 ? "" : "s"}` : "The answer is recorded");
      onDone();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  const ready = method === "WRITTEN" || (method === "VERBAL" && said.trim().length > 0);
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={answer.isPending}
      title={`The guest's answer to the trip's ${word}`}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Not now
          </Button>
          <Button className="go" state={answer.isPending ? "working" : ready ? "default" : "inert"} workingLabel="Recording…" onClick={() => answer.mutate()}>
            Record
          </Button>
        </>
      }
    >
      <div className="field">
        <label>
          How they answered
          <Help label="About the answer">It is recorded on each stay&rsquo;s {word} the trip&rsquo;s was sent with.</Help>
        </label>
        <Choice
          options={[
            ["WRITTEN", "They wrote to us"],
            ["VERBAL", "They told us"],
          ]}
          value={method}
          onChange={(v) => setMethod(v as "WRITTEN" | "VERBAL")}
        />
      </div>
      <div className="field">
        <label>What they said{method === "VERBAL" ? "" : " · optional"}</label>
        <textarea className="input" style={{ height: 70, paddingTop: 8 }} value={said} onChange={(e) => setSaid(e.target.value)} />
      </div>
    </DsDialog>
  );
}
