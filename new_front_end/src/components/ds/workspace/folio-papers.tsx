"use client";

/**
 * Bills & statements in the booking file (2026-11-10, operator: "make the view like how we view
 * other papers, also show the send button"). The papers that are views of the bill — the tentative
 * invoice during the stay, the master bill, the tax invoice before it is issued — as paper rows:
 * Preview opens the paper in the same panel as every other paper, Send by email or WhatsApp. An
 * issued tax invoice is listed with the bills above it, with its own Send. Every figure is the
 * server's; the backend's list says what exists and in what state.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { problemOfPhone } from "@/lib/ds/phone";
import { PhoneField } from "@/components/ds/phone-field";
import { Help, HelpHere } from "@/components/ds/help";
import { getFolioDocuments, sendFolioDocument, type FolioDocumentEntry } from "@/lib/api/documents";
import { fmtStamp, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, Live, NightsChoice, PaperDrawer, SendPaperPanel, StepCard, toastRefusal, type PaperRef } from "@/components/ds/steps/kit";

function chipOf(d: FolioDocumentEntry): { word: string; tone: "default" | "success" | "warning" | "quiet" } {
  switch (d.state) {
    case "SNAPSHOT":
      return { word: "as it stands now", tone: "quiet" };
    case "INDICATIVE":
      return { word: "so far · charges still coming", tone: "warning" };
    case "FROZEN":
      return { word: "final · the bill is settled", tone: "success" };
    case "DRAFT":
      return { word: "draft · not numbered yet", tone: "warning" };
    default:
      return { word: "not available", tone: "quiet" };
  }
}

/** Where a draft tax invoice is issued, by the step the booking is at. */
function issueWhere(stage: string | null | undefined): string {
  if (stage === "S8") return "Issued at Check-out once the bill is settled — then sent from its own row";
  if (stage === "S9") return "Issue it on the Closed step (Tax invoice), then send it from its own row";
  return "It is issued at check-out, when the bill is settled";
}

export function FolioPapersCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const folio = entry.folio;
  const q = useQuery({
    queryKey: ["folio-documents", entry.id, entry.currentStage, folio?.state ?? null, entry.updatedAt],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && !!folio,
  });
  const [open, setOpen] = useState<PaperRef | null>(null);
  const [sending, setSending] = useState<FolioDocumentEntry | null>(null);
  if (!folio || !session) return null;

  // An issued tax invoice is a bill of its own, listed with the bills; it is not repeated here.
  const docs = (q.data?.documents ?? []).filter((d) => d.available && !(d.kind === "tax-invoice" && d.state === "ISSUED"));
  const firstReason = (q.data?.documents ?? []).find((d) => !d.available && d.unavailableReason)?.unavailableReason ?? null;
  const refreshKey = `${entry.updatedAt}|${q.data?.asAt ?? ""}`;

  return (
    <StepCard title="Bills & statements">
      {q.isLoading ? <p className="sm meta">Reading the bill…</p> : null}
      {q.isError ? (
        <p className="sm warn-ink" role="alert">
          The bills could not be read — try again in a moment.
        </p>
      ) : null}
      {q.data && docs.length === 0 ? <p className="sm meta">{firstReason ?? "Nothing to show yet."}</p> : null}
      {docs.length ? (
        <div className="papergrp">
          {docs.map((d) => {
            const chip = chipOf(d);
            const draftTax = d.kind === "tax-invoice";
            const when = d.sent
              ? `sent ${fmtStamp(d.sent.at)} ${d.sent.channel === "WHATSAPP" ? "on WhatsApp" : "by email"}`
              : d.state === "FROZEN" && d.reprintCount != null
                ? d.reprintCount
                  ? `${plural(d.reprintCount, "copy", "copies")} made`
                  : "no copy made yet"
                : draftTax
                  ? "not handed to the guest"
                  : "";
            return (
              <div className="paperrow" key={d.kind} data-folio-paper={d.kind}>
                <span className="nm">
                  <b>{d.title}</b>
                  <span className="v"> · {d.subtitle}</span>
                  {d.purpose ? <Help label={`About the ${d.title.toLowerCase()}`}>{d.purpose}</Help> : null}
                </span>
                <Chip tone={chip.tone}>{chip.word}</Chip>
                <span className="when">{when}</span>
                <span className="acts">
                  <Button
                    kind="quiet"
                    compact
                    icon="eye"
                    onClick={() => setOpen({ kind: "folio", entryId: entry.id, doc: d.kind, label: d.title, refreshKey })}
                  >
                    Preview
                  </Button>
                  <Live>
                    {draftTax ? (
                      <Button kind="quiet" compact icon="send" state="inert" title={issueWhere(entry.currentStage)}>
                        Send
                      </Button>
                    ) : (
                      <Button kind="quiet" compact icon="send" onClick={() => setSending(d)}>
                        {d.sent ? "Send again" : "Send"}
                      </Button>
                    )}
                  </Live>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {docs.some((d) => d.kind === "tax-invoice") ? <p className="sm meta" style={{ marginTop: 6 }}>Tax invoice — {issueWhere(entry.currentStage)}.</p> : null}
      <HelpHere label="About these bills">
        The tentative invoice shows the guest what they have been charged so far, during the stay. The master bill is the bill the
        guest signs at check-out: every charge by kind and what was paid. The tax invoice is the numbered bill for tax, issued once
        when the bill is settled. A preview never sends anything.
      </HelpHere>
      <PaperDrawer paper={open} onClose={() => setOpen(null)} />
      {sending ? <FolioSendDialog entry={entry} doc={sending} refreshKey={refreshKey} onClose={() => setSending(null)} /> : null}
    </StepCard>
  );
}

const CHANNELS = [
  ["EMAIL", "Email"],
  ["WHATSAPP", "WhatsApp"],
] as const;
type Channel = (typeof CHANNELS)[number][0];

export function FolioSendDialog({ entry, doc, refreshKey, onClose }: { entry: EntryDetail; doc: FolioDocumentEntry; refreshKey: string; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const recipient = useInvoiceRecipient(entry);
  const phoneRules = usePhoneRules();
  const [channel, setChannel] = useState<Channel>("EMAIL");
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  const [nightsEach, setNightsEach] = useState(false);
  useEffect(() => {
    if (touched) return;
    setTo(channel === "EMAIL" ? recipient.defaultTo : recipient.phone);
  }, [channel, touched, recipient.defaultTo, recipient.phone]);
  const typed = to.trim();
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);
  const numberBad = channel === "WHATSAPP" ? problemOfPhone(phoneRules, typed) : null;
  const ok = channel === "WHATSAPP" ? typed.length > 0 && !numberBad : emailish;
  const send = useMutation({
    mutationFn: () => sendFolioDocument(session!, entry.id, doc.kind, { channel, to: typed, nightsEach }),
    onSuccess: (r) => {
      if (r.channel === "WHATSAPP") toast.success(`${doc.title} recorded as sent on WhatsApp to ${r.to}`);
      else if (r.emailed) toast.success(`${doc.title} sent by email to ${r.to}`);
      else toast.error(`${doc.title} was not sent: ${r.reason ?? "the email did not go"}`);
      void qc.invalidateQueries({ queryKey: ["folio-documents", entry.id] });
      void qc.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
      if (r.channel === "WHATSAPP" || r.emailed) onClose();
    },
    onError: (e) => toastRefusal(e, `${doc.title} could not be sent`),
  });
  const hint =
    channel === "WHATSAPP"
      ? recipient.phoneWhose && typed === recipient.phone
        ? `${recipient.phoneWhose} — send it on WhatsApp yourself; the desk records the send with this number`
        : "send it on WhatsApp yourself — the desk records the send with this number"
      : !typed
        ? "no email on file — type one"
        : !emailish
          ? "that is not an email address"
          : recipient.defaultWhose && typed === recipient.defaultTo
            ? recipient.defaultWhose
            : "the send is recorded on the booking with this address";
  return (
    <DsDialog
      open
      onClose={onClose}
      busy={send.isPending}
      beside={<SendPaperPanel paper={{ kind: "folio", entryId: entry.id, doc: doc.kind, label: doc.title, refreshKey }} nightsEach={nightsEach} />}
      title={`Send the ${doc.title.toLowerCase()}`}
      caseLines={[entry.id, doc.sent ? `Sent before ${fmtStamp(doc.sent.at)} — this sends it again` : "Not sent yet"]}
      footer={
        <>
          <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            icon="send"
            state={send.isPending ? "working" : ok ? "default" : "inert"}
            title={ok ? undefined : channel === "WHATSAPP" ? (numberBad ?? "put in the WhatsApp number") : "type an email address"}
            workingLabel="Sending…"
            onClick={() => send.mutate()}
          >
            Send now
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Send via</label>
        <Choice
          options={CHANNELS}
          value={channel}
          onChange={(c) => {
            setChannel(c);
            setTouched(false);
          }}
        />
      </div>
      <div className="field">
        <label>{channel === "EMAIL" ? "Email address" : "WhatsApp number"}</label>
        {channel === "EMAIL" ? (
          <input
            className="input"
            value={to}
            onChange={(e) => {
              setTouched(true);
              setTo(e.target.value);
            }}
            placeholder="name@example.com"
            autoFocus
          />
        ) : (
          <PhoneField
            value={to}
            ariaLabel="WhatsApp number"
            autoFocus
            onChange={(v) => {
              setTouched(true);
              setTo(v);
            }}
          />
        )}
        <span className="hint">{hint}</span>
      </div>
      <div className="paper-faces in-dialog">
        <NightsChoice each={nightsEach} onChange={setNightsEach} of={{ entryId: entry.id }} />
      </div>
      {doc.state === "FROZEN" ? <p className="sm meta">The copy sent is numbered like a printed one.</p> : null}
    </DsDialog>
  );
}
