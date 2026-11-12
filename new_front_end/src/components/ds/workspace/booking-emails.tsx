"use client";

/**
 * EMAILS — the booking's conversation, under Papers (2026-11-12, operator: "where will you show [the
 * guest's replies]" → "do it"): their first email, every email the system sent for a stay of the
 * enquiry (with the paper it carried) and each reply they sent, oldest first. Any of them opens in
 * full. A reply can be recorded as the guest's answer to the paper it answers, with their words.
 *
 * The mailbox is looked at by the server every couple of minutes; Look in the mailbox now asks it
 * at once. Opening this tab marks the new replies as seen, which takes them off the bell.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Icon } from "@/design-system";
import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { useConversation } from "@/hooks/use-conversation";
import {
  PAPER_WORDS,
  checkConversation,
  markConversationSeen,
  recordReplyAsAnswer,
  type ConversationEmail,
} from "@/lib/api/inbox";
import type { EntryCommunication } from "@/lib/api/entries";
import { fmtDateTime } from "@/lib/ds/format";
import { BookingEmailField, EmailReadDialog } from "@/components/ds/guest-email";
import { Choice, DsDialog, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

const who = (name: string | null, address: string | null) => name || address || "someone";

function kindWords(e: ConversationEmail): { tag: string; tone: "in" | "out" } {
  if (e.kind === "FIRST") return { tag: "Their email", tone: "in" };
  if (e.kind === "REPLY") return { tag: "Their reply", tone: "in" };
  return { tag: `We sent · ${PAPER_WORDS[e.paperKind ?? "OTHER"] ?? "Email"}`, tone: "out" };
}

export function EmailsView({
  entry,
  communications,
  sealed,
}: {
  entry: EntryDetail;
  communications: EntryCommunication[];
  sealed: boolean;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const params = useSearchParams();
  const conv = useConversation(entry.id);
  const emails = conv.data?.emails ?? [];
  const [reading, setReading] = useState<string | null>(null);
  const [answering, setAnswering] = useState<ConversationEmail | null>(null);

  // Seen once the desk is looking at this tab, which takes the replies off the bell.
  const shown = params.get("view") === "docs" && params.get("sub") === "emails";
  const marking = useRef(false);
  useEffect(() => {
    if (!shown || !session || marking.current || !(conv.data?.unseen ?? 0)) return;
    marking.current = true;
    void markConversationSeen(session, entry.id)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["unseen-replies"] });
        void qc.invalidateQueries({ queryKey: ["conversation", entry.id] });
      })
      .finally(() => {
        marking.current = false;
      });
  }, [shown, session, conv.data?.unseen, entry.id, qc]);

  const check = useMutation({
    mutationFn: () => checkConversation(session!, entry.id),
    onSuccess: (r) => {
      qc.setQueryData(["conversation", entry.id], r);
      void qc.invalidateQueries({ queryKey: ["unseen-replies"] });
      toast.success(r.found ? `${r.found === 1 ? "A new reply" : `${r.found} new replies`} filed on this booking` : "Nothing new in the mailbox");
    },
    onError: (e) => toastRefusal(e, "The mailbox could not be read"),
  });

  return (
    <div className="emails-view" data-emails-view>
      <BookingEmailField entry={entry} editable={!sealed} />
      <div className="emails-head">
        <span className="sm muted">
          {conv.data?.mailbox ? <>The hotel&rsquo;s mailbox, {conv.data.mailbox}, is looked at every couple of minutes</> : null}
          <Help>
            Every email the hotel sent for this booking is listed here, with each reply that answers one of them. A reply
            to any paper is found by itself, whether or not their own email was picked above. Double-click an email to read
            it in full.
          </Help>
        </span>
        <Button kind="quiet" compact state={check.isPending ? "working" : "default"} onClick={() => check.mutate()} data-check-mail>
          <Icon name="retry" /> Look in the mailbox now
        </Button>
      </div>
      {conv.isLoading ? (
        <div className="muted">Reading the conversation…</div>
      ) : !emails.length ? (
        <div className="muted">No email for this booking yet — the first paper sent by email starts the conversation.</div>
      ) : (
        <ul className="conv-list" aria-label="Emails for this booking">
          {emails.map((e) => {
            const k = kindWords(e);
            const answeredTo = e.answered ? communications.find((c) => c.id === e.answered!.communicationId) : null;
            return (
              <li key={e.id} className={`conv-row ${k.tone}${e.seen ? "" : " new"}`} data-conv-row={e.kind}>
                <button type="button" className="conv-main" onDoubleClick={() => setReading(e.messageId)} title="Double-click to read it in full">
                  <span className="conv-top">
                    <span className={`conv-tag ${k.tone}`}>{k.tag}</span>
                    {!e.seen ? <span className="conv-new">new</span> : null}
                    <span className="conv-who">
                      {e.kind === "SENT" ? <>to {e.to.join(", ") || "the guest"}</> : <>from {who(e.fromName, e.fromAddress)}</>}
                    </span>
                    <span className="conv-when">{fmtDateTime(e.at)}</span>
                  </span>
                  <span className="conv-subject">{e.subject}</span>
                  {e.snippet ? <span className="conv-snippet">{e.snippet}</span> : null}
                  {e.attachmentNames.length ? (
                    <span className="conv-files">
                      <Icon name="file" /> {e.attachmentNames.join(" · ")}
                    </span>
                  ) : null}
                </button>
                <span className="conv-acts">
                  <Button kind="quiet" compact onClick={() => setReading(e.messageId)}>
                    Read
                  </Button>
                  {e.kind === "REPLY" ? (
                    e.answered ? (
                      <span className="sm ok-ink conv-answered">
                        <Icon name="check" /> Recorded as their answer
                        {answeredTo ? <> to the {(PAPER_WORDS[answeredTo.commType] ?? "paper").toLowerCase()}</> : null}
                      </span>
                    ) : !sealed ? (
                      <Button kind="secondary" compact onClick={() => setAnswering(e)} data-record-answer>
                        Record as their answer
                      </Button>
                    ) : null
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {reading ? <EmailReadDialog messageId={reading} onClose={() => setReading(null)} /> : null}
      {answering ? (
        <AnswerDialog entry={entry} reply={answering} communications={communications} onClose={() => setAnswering(null)} />
      ) : null}
    </div>
  );
}

/** Which paper the reply answers, then record it: the paper's own answer, with their words. */
function AnswerDialog({
  entry,
  reply,
  communications,
  onClose,
}: {
  entry: EntryDetail;
  reply: ConversationEmail;
  communications: EntryCommunication[];
  onClose: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const waiting = useMemo(
    () =>
      communications
        .filter((c) => c.canAcknowledge && c.direction !== "INBOUND")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [communications],
  );
  const [pick, setPick] = useState<string>(() => waiting.find((c) => c.commType === reply.answersKind)?.id ?? (waiting.length === 1 ? waiting[0].id : ""));
  const save = useMutation({
    mutationFn: () => recordReplyAsAnswer(session!, reply.id, pick),
    onSuccess: async () => {
      const c = waiting.find((x) => x.id === pick);
      toast.success(`Their answer to the ${(PAPER_WORDS[c?.commType ?? ""] ?? "paper").toLowerCase()} is recorded, in their words`);
      void qc.invalidateQueries({ queryKey: ["conversation", entry.id] });
      await refresh();
      onClose();
    },
    onError: (e) => toastRefusal(e, "Their answer could not be recorded"),
  });
  const paperName = (c: EntryCommunication) => {
    const p = c.payload ?? {};
    const no = (p.quotationId ?? p.invoiceId ?? p.reservationId ?? null) as string | null;
    return `${PAPER_WORDS[c.commType] ?? "Paper"}${no ? ` · ${no}` : ""} · sent ${fmtDateTime(c.createdAt)}`;
  };
  return (
    <DsDialog
      open
      closeX
      width={600}
      register="report"
      onClose={onClose}
      busy={save.isPending}
      title="Record their reply as their answer"
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className={pick ? "go" : undefined}
            state={save.isPending ? "working" : pick ? "default" : "inert"}
            reason={waiting.length ? "pick the paper it answers" : "no paper is waiting for an answer"}
            onClick={() => save.mutate()}
          >
            Record their answer
          </Button>
        </>
      }
    >
      <div className="email-read">
        <div className="sm">
          From <b>{who(reply.fromName, reply.fromAddress)}</b> · {fmtDateTime(reply.at)}
        </div>
        {reply.snippet ? <div className="email-read-text">{reply.snippet}</div> : null}
        {waiting.length ? (
          <div className="field">
            <label>It answers</label>
            <Choice value={pick} onChange={(v: string) => setPick(v)} options={waiting.map((c) => [c.id, paperName(c)] as const)} />
          </div>
        ) : (
          <div className="notice next" role="status">
            No paper of this booking is waiting for an answer — every one is answered, or its answer is not asked for.
          </div>
        )}
        {waiting.find((c) => c.id === pick)?.commType === "QUOTATION" ? (
          <div className="notice next" role="status">
            For a quotation, their answer is that they accept it: the quotation will read accepted.
          </div>
        ) : null}
        <div className="sm muted">
          Their words above the quoted mail are recorded as their written answer.
        </div>
      </div>
    </DsDialog>
  );
}
