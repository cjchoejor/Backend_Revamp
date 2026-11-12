"use client";

/**
 * THEIR EMAIL — the guest's or the agency's own email, picked from the hotel's mailbox (2026-11-12,
 * operator: "suppose say a guest or travel agent sends an email with stay details, when we send an
 * email like quotation and other papers, how can we send it in that same thread of the first email
 * guest sent").
 *
 * Once an email is picked, every paper of every stay on the enquiry goes back as a reply inside it,
 * to whoever wrote it — the backend does it (`sendEmail`, `resolveSendTo`). The desk only picks.
 *
 *   - `GuestEmailField` — the line: the email picked (subject, who, when) with Change and ×, or a
 *     button to pick one. The new inquiry holds the pick until the lead is kept.
 *   - `BookingEmailField` — the same, saved on the booking's enquiry at once.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  clearInquiryEmail,
  emailThreadOf,
  linkInquiryEmail,
  listInboxEmails,
  readInboxEmail,
  type EmailThread,
  type InboxEmail,
} from "@/lib/api/inbox";
import { fmtDateTime } from "@/lib/ds/format";
import { DsDialog, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

const who = (name: string | null, address: string | null) =>
  name && address ? `${name} <${address}>` : name || address || "unknown sender";

export function GuestEmailField({
  thread,
  onPick,
  onClear,
  disabled,
  busy,
  suggest,
  inquiryId = null,
}: {
  thread: EmailThread | null;
  onPick: (email: InboxEmail) => void | Promise<unknown>;
  onClear: () => void | Promise<unknown>;
  disabled?: boolean;
  busy?: boolean;
  /** What to search for when the list opens: the caller's email or name, typed so far. */
  suggest?: string;
  /** The enquiry the field belongs to, left out of "already the conversation of". */
  inquiryId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  return (
    <div className="field guest-email" data-guest-email>
      <label>
        Their email
        <Help>
          When the guest or the agency wrote to the hotel, pick their email here. Every paper — the quotation, the
          proforma, the voucher and the bills — then goes back as a reply inside it, to whoever wrote it, so they and the
          hotel&rsquo;s mailbox see one conversation. Without one, the papers start a conversation of their own.
        </Help>
      </label>
      {thread ? (
        <div className="email-line" data-email-linked>
          <Icon name="send" />
          <span className="email-line-main">
            <span className="email-line-lead">Papers reply in</span>
            <b className="email-line-subject">{thread.subject}</b>
            <span className="email-line-from">
              from {who(thread.fromName, thread.fromAddress)}
              {thread.receivedAt ? <> · {fmtDateTime(thread.receivedAt)}</> : null}
            </span>
          </span>
          <span className="email-line-acts">
            <Button kind="quiet" compact onClick={() => setReading(true)} data-read-email>
              Read
            </Button>
            {!disabled ? (
              <>
              <Button kind="quiet" compact state={busy ? "working" : "default"} onClick={() => setOpen(true)}>
                Change
              </Button>
              <Button
                kind="quiet"
                compact
                iconOnly
                aria-label="Unlink the email"
                title="Unlink the email — the papers start a conversation of their own"
                state={busy ? "inert" : "default"}
                onClick={() => void onClear()}
              >
                <Icon name="x" />
              </Button>
              </>
            ) : null}
          </span>
        </div>
      ) : (
        <div className="email-line none">
          {disabled ? (
            <span className="muted">No email picked</span>
          ) : (
            <Button kind="secondary" compact state={busy ? "working" : "default"} onClick={() => setOpen(true)} data-pick-email>
              <Icon name="send" /> Pick their email
            </Button>
          )}
        </div>
      )}
      {reading && thread ? (
        <EmailReadDialog messageId={thread.messageId} currentId={thread.messageId} inquiryId={inquiryId} onClose={() => setReading(false)} />
      ) : null}
      {open ? (
        <EmailPickDialog
          suggest={suggest}
          currentId={thread?.messageId ?? null}
          inquiryId={inquiryId}
          onClose={() => setOpen(false)}
          onPick={async (email) => {
            await onPick(email);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function EmailPickDialog({
  suggest,
  currentId,
  inquiryId,
  onClose,
  onPick,
}: {
  suggest?: string;
  currentId: string | null;
  inquiryId: string | null;
  onClose: () => void;
  onPick: (email: InboxEmail) => Promise<void>;
}) {
  const { session } = useSession();
  const [typed, setTyped] = useState((suggest ?? "").trim());
  const [q, setQ] = useState((suggest ?? "").trim());
  const [days, setDays] = useState(14);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<InboxEmail | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState<InboxEmail | null>(null);
  // The first look reads the mailbox afresh; typing in the search reads the list kept a moment.
  const freshNext = useRef(true);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const list = useQuery({
    queryKey: ["inbox-emails", q, days, all],
    queryFn: () => {
      const fresh = freshNext.current;
      freshNext.current = false;
      return listInboxEmails(session!, { q, days, all, fresh });
    },
    enabled: !!session,
    staleTime: 20_000,
    retry: false,
  });
  const emails = list.data?.emails ?? [];
  const err = list.error instanceof ApiError ? list.error.message : list.error ? "The hotel's mailbox could not be read" : null;
  const ready = !!picked && picked.messageId !== currentId;
  return (
    <DsDialog
      open
      closeX
      width={640}
      register="report"
      onClose={onClose}
      title="Their email in the hotel's mailbox"
      help={<>The papers go back as a reply inside the email picked, to whoever wrote it. Nothing in the mailbox is changed.</>}
      busy={saving}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className={ready ? "go" : undefined}
            state={saving ? "working" : ready ? "default" : "inert"}
            reason={picked && picked.messageId === currentId ? "this is the email already picked" : "pick an email first"}
            onClick={async () => {
              if (!picked) return;
              setSaving(true);
              try {
                await onPick(picked);
              } catch {
                /* the refusal is already said in a toast */
              } finally {
                setSaving(false);
              }
            }}
          >
            Reply in this email
          </Button>
        </>
      }
    >
      <div className="email-pick">
        <div className="email-pick-tools">
          <div className="field grow">
            <label>Search</label>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="who wrote, the subject or a word in it"
              autoFocus
              data-email-search
            />
          </div>
          <div className="field">
            <label>From the last</label>
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </div>
          <label className="email-pick-all">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Newsletters too
          </label>
        </div>
        <div className="email-pick-from sm muted">
          <span>
            {list.data?.mailbox ? <>Reading {list.data.mailbox} · </> : null}double-click an email to read it in full
          </span>
          <Button
            kind="quiet"
            compact
            state={list.isFetching ? "working" : "default"}
            onClick={() => {
              freshNext.current = true;
              void list.refetch();
            }}
          >
            <Icon name="retry" /> Look again
          </Button>
        </div>
        {err ? (
          <div className="notice stop" role="alert">
            <Icon name="alert" /> {err}{" "}
            <Button
              kind="quiet"
              compact
              onClick={() => {
                freshNext.current = true;
                void list.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        ) : list.isLoading ? (
          <div className="muted">Reading the hotel&rsquo;s mailbox…</div>
        ) : !emails.length ? (
          <div className="muted">
            No email {q ? <>matching &ldquo;{q}&rdquo; </> : null}in the last {days} days{all ? "" : " (newsletters left out)"}.
          </div>
        ) : (
          <ul className="email-pick-list" role="listbox" aria-label="Emails in the hotel's mailbox">
            {emails.map((e) => {
              const on = picked?.messageId === e.messageId;
              const current = e.messageId === currentId;
              const others = e.linkedTo.filter((o) => o.inquiryId !== inquiryId);
              return (
                <li key={e.messageId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`email-row${on ? " on" : ""}`}
                    onClick={() => setPicked(e)}
                    onDoubleClick={() => {
                      setPicked(e);
                      setReading(e);
                    }}
                    data-email-row
                  >
                    <span className="email-row-top">
                      <b>{e.fromName || e.fromAddress || "unknown sender"}</b>
                      {e.fromName && e.fromAddress ? <span className="email-row-addr">{e.fromAddress}</span> : null}
                      <span className="email-row-when">{e.receivedAt ? fmtDateTime(e.receivedAt) : ""}</span>
                    </span>
                    <span className="email-row-subject">{e.subject}</span>
                    {e.snippet ? <span className="email-row-snippet">{e.snippet}</span> : null}
                    {current ? <span className="email-row-note ok-ink">picked for this enquiry</span> : null}
                    {others.length ? (
                      <span className="email-row-note warn-ink">
                        already the conversation of {others.map((o) => o.referenceNumber).join(", ")}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {reading ? (
        <EmailReadDialog
          messageId={reading.messageId}
          currentId={currentId}
          inquiryId={inquiryId}
          onClose={() => setReading(null)}
          onPick={async (email) => {
            await onPick(email);
          }}
        />
      ) : null}
    </DsDialog>
  );
}

/**
 * One email in full (2026-11-12, operator: "when double clicked can we show the whole detail of the
 * mail content"): who wrote, who it went to, when, its words as written and its attachments' names.
 * Over the list it was opened from, with Reply in this email; on its own, to read again.
 */
export function EmailReadDialog({
  messageId,
  currentId = null,
  inquiryId = null,
  onClose,
  onPick,
}: {
  messageId: string;
  currentId?: string | null;
  inquiryId?: string | null;
  onClose: () => void;
  /** Given when it was opened from the list: Reply in this email picks it. */
  onPick?: (email: InboxEmail) => Promise<void>;
}) {
  const { session } = useSession();
  const [saving, setSaving] = useState(false);
  // This pop-up may sit on the list that opened it, so Escape closes only this one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!saving) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, saving]);
  const read = useQuery({
    queryKey: ["inbox-email", messageId],
    queryFn: () => readInboxEmail(session!, messageId),
    enabled: !!session,
    staleTime: 60_000,
    retry: false,
  });
  const m = read.data?.email ?? null;
  const err = read.error instanceof ApiError ? read.error.message : read.error ? "The email could not be read" : null;
  const isCurrent = messageId === currentId;
  return (
    <DsDialog
      open
      closeX
      width={760}
      register="report"
      onClose={onClose}
      busy={saving}
      title={m?.subject ?? "The email"}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            {onPick ? "Back to the list" : "Close"}
          </Button>
          {onPick ? (
            <Button
              className={m && !isCurrent ? "go" : undefined}
              state={saving ? "working" : m && !isCurrent ? "default" : "inert"}
              reason={isCurrent ? "this is the email already picked" : "the email is still being read"}
              onClick={async () => {
                if (!m) return;
                setSaving(true);
                try {
                  await onPick(m);
                } catch {
                  /* the refusal is already said in a toast */
                } finally {
                  setSaving(false);
                }
              }}
            >
              Reply in this email
            </Button>
          ) : null}
        </>
      }
    >
      {err ? (
        <div className="notice stop" role="alert">
          <Icon name="alert" /> {err}
        </div>
      ) : !m ? (
        <div className="muted">Reading the email…</div>
      ) : (
        <div className="email-read" data-email-read>
          <dl className="email-read-head">
            <dt>From</dt>
            <dd>{who(m.fromName, m.fromAddress)}</dd>
            {m.to.length ? (
              <>
                <dt>To</dt>
                <dd>{m.to.join(", ")}</dd>
              </>
            ) : null}
            {m.cc.length ? (
              <>
                <dt>Cc</dt>
                <dd>{m.cc.join(", ")}</dd>
              </>
            ) : null}
            <dt>When</dt>
            <dd>{m.receivedAt ? fmtDateTime(m.receivedAt) : "—"}</dd>
            {m.attachments.length ? (
              <>
                <dt>Attached</dt>
                <dd>
                  {m.attachments.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="email-read-file">
                      <Icon name="file" /> {a.name}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
          </dl>
          {isCurrent ? <div className="sm ok-ink">The papers reply in this email</div> : null}
          {m.linkedTo.some((o) => o.inquiryId !== inquiryId) ? (
            <div className="sm warn-ink">
              Already the conversation of{" "}
              {m.linkedTo
                .filter((o) => o.inquiryId !== inquiryId)
                .map((o) => o.referenceNumber)
                .join(", ")}
            </div>
          ) : null}
          <div className="email-read-text" tabIndex={0}>
            {m.text || <span className="muted">No words in this email — only what is attached.</span>}
          </div>
          {m.cut ? <div className="sm muted">The email is longer than the desk shows — the rest is in the mailbox.</div> : null}
        </div>
      )}
    </DsDialog>
  );
}

/** Their email on a booking: picked or changed, saved on the enquiry at once. */
export function BookingEmailField({ entry, editable, suggest }: { entry: EntryDetail; editable: boolean; suggest?: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const inquiryId = entry.inquiryId ?? entry.inquiry?.id ?? "";
  const thread = emailThreadOf(entry.inquiry);
  const link = useMutation({
    mutationFn: (email: InboxEmail) => linkInquiryEmail(session!, inquiryId, email.messageId),
    onSuccess: async (r) => {
      toast.success(`The papers now reply in “${r.emailThread.subject}”, to ${r.emailThread.fromAddress ?? "whoever wrote it"}`);
      await refresh([["send-to", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The email could not be picked"),
  });
  const clear = useMutation({
    mutationFn: () => clearInquiryEmail(session!, inquiryId),
    onSuccess: async () => {
      toast.success("Email unlinked — the papers start a conversation of their own");
      await refresh([["send-to", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The email could not be unlinked"),
  });
  return (
    <GuestEmailField
      thread={thread}
      disabled={!editable || !inquiryId}
      busy={link.isPending || clear.isPending}
      suggest={suggest}
      inquiryId={inquiryId || null}
      onPick={(email) => link.mutateAsync(email)}
      onClear={() => clear.mutateAsync()}
    />
  );
}
