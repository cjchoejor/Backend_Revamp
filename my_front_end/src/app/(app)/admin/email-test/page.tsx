"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sendTestEmail, verifyEmailTransport } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const DEFAULT_SUBJECT = "Test from Legphel PMS";
const DEFAULT_BODY =
  "Hi,\n\nThis is a test email from the Legphel PMS admin console — confirming that SMTP delivery is working.\n\nThanks!";

type SendLog = {
  at: string;
  result:
    | { status: "sent"; messageId: string; redirected: boolean; intendedRecipient: string; actualRecipient: string }
    | { status: "skipped"; reason: string }
    | { status: "error"; message: string };
  subject: string;
  threadEntryId?: string;
  threadReadableId?: string;
};

export default function AdminEmailTestPage() {
  const { session } = useSession();
  const [to, setTo] = useState("choejorwangdi@gmail.com");
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [threadEntryId, setThreadEntryId] = useState("");
  const [threadReadableId, setThreadReadableId] = useState("");
  const [history, setHistory] = useState<SendLog[]>([]);

  const verifyQuery = useQuery({
    queryKey: ["admin", "email", "verify"],
    queryFn: () => verifyEmailTransport(session!),
    enabled: !!session && session.actorLevel === "L4",
    retry: 0,
    staleTime: 60_000,
  });

  const sendMutation = useMutation({
    mutationFn: () =>
      sendTestEmail(session!, {
        to,
        subject,
        body,
        threadEntryId: threadEntryId.trim() || undefined,
        threadReadableId: threadReadableId.trim() || undefined,
      }),
    onSuccess: (result) => {
      const log: SendLog = {
        at: new Date().toLocaleTimeString(),
        result,
        subject,
        threadEntryId: threadEntryId.trim() || undefined,
        threadReadableId: threadReadableId.trim() || undefined,
      };
      setHistory((h) => [log, ...h].slice(0, 10));
      if (result.status === "sent") {
        toast.success(
          result.redirected
            ? `Sent (redirected to ${result.actualRecipient})`
            : `Sent to ${result.actualRecipient}`,
        );
      } else if (result.status === "skipped") {
        toast.info(`Skipped: ${result.reason}`);
      } else {
        toast.error(`Send failed: ${result.message}`);
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Send failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;

  const verify = verifyQuery.data;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Phase 1 · Email integration</p>
        <h1 className="admin-display text-3xl">Email test send</h1>
        <p className="admin-muted mt-2 max-w-3xl text-sm">
          Fire test emails through the SMTP transport to verify deliverability and threading
          before we wire S1–S9 stage events. While <span className="font-mono">EMAIL_REDIRECT_ALL_TO</span> is set,
          all sends route to that address regardless of the recipient field below — the original
          recipient is prepended to the subject like <span className="font-mono">[→guest@example.com]</span>.
        </p>
      </div>

      <section className="admin-panel space-y-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="admin-display text-lg">Transport status</h2>
          <button
            type="button"
            className="admin-btn text-[10px]"
            onClick={() => verifyQuery.refetch()}
            disabled={verifyQuery.isFetching}
          >
            Re-check
          </button>
        </div>
        {verifyQuery.isLoading && <p className="admin-muted text-sm">Checking SMTP authentication…</p>}
        {verifyQuery.error && (
          <p className="text-sm text-destructive">
            Verify call failed: {verifyQuery.error instanceof ApiError ? verifyQuery.error.message : "unknown"}
          </p>
        )}
        {verify && (
          <p className="text-sm">
            {verify.ok ? (
              <span className="admin-tag admin-tag-ok">SMTP OK — transporter authenticated</span>
            ) : (
              <span className="text-destructive">
                <span className="admin-tag admin-tag-warn">SMTP error</span>
                <span className="ml-2 font-mono text-xs">{verify.error}</span>
              </span>
            )}
          </p>
        )}
      </section>

      <section className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Compose</h2>

        <label className="block space-y-1 text-xs">
          <span className="admin-muted">To (intended recipient — overridden by EMAIL_REDIRECT_ALL_TO if set)</span>
          <input
            className="admin-input w-full"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="guest@example.com"
          />
        </label>

        <label className="block space-y-1 text-xs">
          <span className="admin-muted">Subject</span>
          <input
            className="admin-input w-full"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>

        <label className="block space-y-1 text-xs">
          <span className="admin-muted">Body (plain text — HTML version auto-generated)</span>
          <textarea
            className="admin-input w-full min-h-[160px] font-mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <div className="rounded border border-[var(--admin-rule)] p-3">
          <p className="admin-muted mb-2 text-xs font-medium">Threading (optional — for testing Gmail thread grouping)</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1 text-xs">
              <span className="admin-muted">Thread Entry ID (UUID of an Entry row)</span>
              <input
                className="admin-input w-full font-mono"
                placeholder="leave blank for no threading"
                value={threadEntryId}
                onChange={(e) => setThreadEntryId(e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="admin-muted">Thread readable ID (e.g. ENT-0042) — becomes subject prefix</span>
              <input
                className="admin-input w-full font-mono"
                placeholder="ENT-0042"
                value={threadReadableId}
                onChange={(e) => setThreadReadableId(e.target.value)}
              />
            </label>
          </div>
          <p className="admin-muted mt-2 text-[10px]">
            On the FIRST send for an Entry, the service mints a Message-ID and persists it on
            <span className="font-mono"> Entry.emailThreadRootMessageId</span>. On subsequent sends
            for the same Entry, it sets In-Reply-To / References so Gmail clusters them as one
            conversation. Use the same threadEntryId twice (with different subjects/bodies) to
            verify threading works.
          </p>
        </div>

        <button
          type="button"
          className="admin-btn w-fit"
          disabled={sendMutation.isPending || !to.trim() || !subject.trim() || !body.trim()}
          onClick={() => sendMutation.mutate()}
        >
          {sendMutation.isPending ? "Sending…" : "Send"}
        </button>
      </section>

      {history.length > 0 && (
        <section className="admin-panel space-y-2 p-5">
          <h2 className="admin-display text-lg">Recent sends (this session)</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>At</th>
                <th>Subject</th>
                <th>Thread</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td className="font-mono text-xs">{h.at}</td>
                  <td className="text-xs">{h.subject}</td>
                  <td className="font-mono text-[10px]">
                    {h.threadReadableId ?? "—"}
                    {h.threadEntryId && (
                      <span className="admin-muted block">{h.threadEntryId.slice(0, 8)}…</span>
                    )}
                  </td>
                  <td className="text-xs">
                    {h.result.status === "sent" ? (
                      <>
                        <span className="admin-tag admin-tag-ok">sent</span>
                        <span className="admin-muted ml-2 block font-mono text-[10px]">
                          {h.result.redirected ? `→ ${h.result.actualRecipient} (redirected from ${h.result.intendedRecipient})` : `→ ${h.result.actualRecipient}`}
                        </span>
                        <span className="admin-muted block font-mono text-[10px]">{h.result.messageId}</span>
                      </>
                    ) : h.result.status === "skipped" ? (
                      <>
                        <span className="admin-tag admin-tag-warn">skipped</span>
                        <span className="admin-muted ml-2 font-mono text-[10px]">{h.result.reason}</span>
                      </>
                    ) : (
                      <>
                        <span className="admin-tag admin-tag-warn text-destructive">error</span>
                        <span className="ml-2 text-[10px] text-destructive">{h.result.message}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
