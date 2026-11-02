"use client";

import { Help } from "@/components/ds/help";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sendTestEmail, verifyEmailTransport } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const DEFAULT_SUBJECT = "Test from Legphel PMS";
const DEFAULT_BODY =
  "Hi,\n\nThis is a test email from the Legphel PMS admin console — confirming that email is working.\n\nThanks!";

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
        threadReadableId: threadEntryId.trim() || undefined,
      }),
    onSuccess: (result) => {
      const log: SendLog = {
        at: new Date().toLocaleTimeString(),
        result,
        subject,
        threadEntryId: threadEntryId.trim() || undefined,
        threadReadableId: threadEntryId.trim() || undefined,
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
        <p className="admin-eyebrow mb-2">Tools</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Email test
          <Help label="Email test">Send a test email to check that mail goes out and that replies stay in one conversation. On a test machine all mail may be sent to one address instead of the one typed here.</Help>
        </h1>
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
        {verifyQuery.isLoading && <p className="admin-muted text-sm">Checking the mail connection…</p>}
        {verifyQuery.error && (
          <p className="text-sm text-destructive">
            Could not check: {verifyQuery.error instanceof ApiError ? verifyQuery.error.message : "unknown"}
          </p>
        )}
        {verify && (
          <p className="text-sm">
            {verify.ok ? (
              <span className="admin-tag admin-tag-ok">The mail connection works</span>
            ) : (
              <span className="text-destructive">
                <span className="admin-tag admin-tag-warn">The mail connection failed</span>
                <span className="ml-2 font-mono text-xs">{verify.error}</span>
              </span>
            )}
          </p>
        )}
      </section>

      <section className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Compose</h2>

        <label className="block space-y-1 text-xs">
          <span className="admin-muted flex items-center gap-1">
            To
            <Help label="To">If this server is set to send every test mail to one address, the mail goes there instead. The list below says where each one went.</Help>
          </span>
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
          <span className="admin-muted">Message</span>
          <textarea
            className="admin-input w-full min-h-[160px] font-mono"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <label className="block space-y-1 text-xs">
          <span className="admin-muted flex items-center gap-1">
            Booking number (optional)
            <Help label="Booking number">Every email about one booking lands in one conversation in the guest's inbox. Send twice with the same number to see it happen.</Help>
          </span>
          <input
            className="admin-input w-full"
            placeholder="ENT-20261102-0001"
            value={threadEntryId}
            onChange={(e) => setThreadEntryId(e.target.value)}
          />
        </label>

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
          <h2 className="admin-display text-lg">Sent from this page</h2>
          <table className="admin-table">
            <thead>
              <tr>
                <th>At</th>
                <th>Subject</th>
                <th>Booking</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td className="font-mono text-xs">{h.at}</td>
                  <td className="text-xs">{h.subject}</td>
                  <td className="text-xs">{h.threadReadableId ?? "—"}</td>
                  <td className="text-xs">
                    {h.result.status === "sent" ? (
                      <>
                        <span className="admin-tag admin-tag-ok">sent</span>
                        <span className="admin-muted ml-2 block font-mono text-[10px]">
                          {h.result.redirected ? `→ ${h.result.actualRecipient} (redirected from ${h.result.intendedRecipient})` : `→ ${h.result.actualRecipient}`}
                        </span>
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
