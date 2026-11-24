"use client";

/**
 * Send the tax invoice with the paper beside it — by email, or recorded as sent on WhatsApp. Shared by
 * Check-out (2026-11-24: the invoice a settlement issues is read and sent here, as every other paper
 * is) and Closed (2026-11-10). With no invoice issued yet, the draft is shown and the press issues it
 * with a new number, then sends it.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useInvoiceRecipient } from "@/hooks/use-invoice-recipient";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { problemOfPhone } from "@/lib/ds/phone";
import { PhoneField } from "@/components/ds/phone-field";
import { issueFinalInvoice } from "@/lib/api/checkout";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import type { EntryDetail, InvoiceSummary } from "@/types/api";
import { Choice, DsDialog, SendPaperPanel, toastRefusal, useRefreshEntry, useReplyAsked, type PaperRef } from "./kit";
import { useFolioIndex } from "./s8-parts";

/** What the box needs of an invoice — the bills index's own row carries no more. */
export type TaxInvoiceTarget = Pick<InvoiceSummary, "id" | "invoiceNumber">;

function invoiceLabel(inv: TaxInvoiceTarget) {
  return `${inv.invoiceNumber ?? inv.id}`;
}

const SEND_CHANNELS = [
  ["EMAIL", "Email"],
  ["WHATSAPP", "WhatsApp"],
] as const;

/**
 * Send the tax invoice from the payment box (2026-11-10, operator: "when send invoice is clicked, show
 * the page like how we show for other paper sends, where on the right it views the invoice and on the
 * left it shows the send by WhatsApp or email option"). The invoice issued and not sent, or — when
 * none is issued — the draft, which is issued with a new number on the press.
 */
export function TaxInvoiceSendDialog({
  entry,
  target,
  onClose,
  onSent,
}: {
  entry: EntryDetail;
  target: TaxInvoiceTarget | null;
  onClose: () => void;
  onSent: () => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const recipient = useInvoiceRecipient(entry);
  const phoneRules = usePhoneRules();
  const replyAsked = useReplyAsked(entry.id, "FINAL_INVOICE");
  const index = useFolioIndex(entry);
  const [channel, setChannel] = useState<"EMAIL" | "WHATSAPP">("EMAIL");
  const [to, setTo] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched) return;
    setTo(channel === "EMAIL" ? recipient.defaultTo : recipient.phone);
  }, [channel, touched, recipient.defaultTo, recipient.phone]);
  const typed = to.trim();
  const emailish = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);
  const numberBad = channel === "WHATSAPP" ? problemOfPhone(phoneRules, typed) : null;
  const ok = channel === "WHATSAPP" ? typed.length > 0 && !numberBad : emailish;
  const send = useMutation({
    mutationFn: async () => {
      let id = target?.id ?? null;
      let number = target ? invoiceLabel(target) : null;
      if (!id) {
        if (!entry.folio) throw new Error("There is no bill on this booking");
        const issued = (await issueFinalInvoice(session!, entry.folio.id, entry.id, "final-v1")) as { id?: string; invoiceNumber?: string | null } | null;
        if (!issued?.id) throw new Error("The tax invoice could not be issued");
        id = issued.id;
        number = issued.invoiceNumber ?? issued.id;
      }
      await dispatchInvoice(session!, id, { dispatchedTo: typed, channel });
      return number;
    },
    onSuccess: (number) => {
      toast.success(
        channel === "WHATSAPP"
          ? `Tax invoice ${number} recorded as sent on WhatsApp to ${typed}`
          : `Tax invoice ${number} sent by email to ${typed}${replyAsked ? " — their answer is awaited" : ""}`,
      );
      refresh([["settlement-targets"], ["folio-documents", entry.id], ["entry-communications", entry.id]]);
      onSent();
    },
    onError: (e) => {
      toastRefusal(e, "The tax invoice could not be sent");
      refresh();
    },
  });
  const paper: PaperRef = target
    ? { kind: "invoice", id: target.id, label: `Tax invoice ${invoiceLabel(target)}`, issued: true, invoiceType: "FINAL" }
    : { kind: "folio", entryId: entry.id, doc: "tax-invoice", label: "Tax invoice · not issued yet", refreshKey: `${entry.updatedAt}|${index.data?.asAt ?? ""}` };
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
      beside={<SendPaperPanel paper={paper} nightsEach={false} />}
      title={target ? `Send tax invoice ${invoiceLabel(target)}` : "Issue and send the tax invoice"}
      caseLines={[entry.id, target ? "Issued, not sent yet" : "Not issued yet"]}
      footer={
        <>
          <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className="go"
            icon={target ? "send" : "lock"}
            state={send.isPending ? "working" : ok ? "default" : "inert"}
            title={ok ? undefined : channel === "WHATSAPP" ? (numberBad ?? "put in the WhatsApp number") : "type an email address"}
            workingLabel={target ? "Sending…" : "Issuing…"}
            onClick={() => send.mutate()}
          >
            {target ? "Send now" : "Issue and send"}
          </Button>
        </>
      }
    >
      {!target ? (
        <p className="sm">
          This cannot be undone: the tax invoice is made for the bill as it stands now, with a new number, and that is the copy they
          receive.
        </p>
      ) : null}
      <div className="field">
        <label>Send via</label>
        <Choice
          options={SEND_CHANNELS}
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
    </DsDialog>
  );
}
