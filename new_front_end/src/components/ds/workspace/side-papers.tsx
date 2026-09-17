"use client";

/**
 * "Papers sent, and what they said" (the side panel on every step, 14 Sep storyboard): each paper
 * with its answer — acknowledged, or no answer yet — and the two things the desk does next:
 * record what the guest said, or send it again. A paper is sent again where it is worked (the
 * step that owns it); the voucher is sent again from here.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { acknowledgeCommunication, type EntryCommunication } from "@/lib/api/entries";
import { resendConfirmationVoucher } from "@/lib/api/confirmation";
import { fmtStamp } from "@/lib/ds/format";
import { Choice, DsDialog, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

const PAPER_NAME: Record<string, string> = {
  QUOTATION: "Quotation",
  PROFORMA_INVOICE: "Proforma",
  CONFIRMATION_VOUCHER: "Confirmation voucher",
  PRE_ARRIVAL_REMINDER: "Pre-arrival message",
  FINAL_INVOICE: "Tax invoice",
  INTERIM_INVOICE: "Interim bill",
};

/** The step a paper is worked at — where "send again" takes the desk. */
const PAPER_STEP: Record<string, number> = {
  QUOTATION: 2,
  PROFORMA_INVOICE: 3,
  PRE_ARRIVAL_REMINDER: 5,
  INTERIM_INVOICE: 7,
  FINAL_INVOICE: 8,
};

export function SidePapers({
  entry,
  communications,
  tz,
  sealed,
  onGo,
}: {
  entry: EntryDetail;
  communications: EntryCommunication[];
  tz: string;
  sealed: boolean;
  onGo: (step: number) => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const papers = communications.filter((c) => c.direction !== "INBOUND").slice(0, 10);
  const [recording, setRecording] = useState<EntryCommunication | null>(null);
  const [method, setMethod] = useState<"WRITTEN" | "VERBAL" | null>(null);
  const [said, setSaid] = useState("");

  const record = useMutation({
    mutationFn: () => acknowledgeCommunication(session!, recording!.id, { method: method!, verbatimNote: said.trim() || undefined }),
    onSuccess: () => {
      toast.success("Their answer is on record");
      setRecording(null);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The answer could not be recorded"),
  });
  const resend = useMutation({
    mutationFn: () => resendConfirmationVoucher(session!, entry.reservation!.id),
    onSuccess: (r) => {
      toast.success(`Voucher sent again to ${r.dispatchedTo}`);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The voucher could not be sent"),
  });

  const sendAgain = (c: EntryCommunication) => {
    if (c.commType === "CONFIRMATION_VOUCHER" && entry.reservation?.id) resend.mutate();
    else if (PAPER_STEP[c.commType]) onGo(PAPER_STEP[c.commType]);
  };

  const notes = entry.inquiry?.notes?.trim();

  return (
    <>
      <div>
        <h4>Papers sent, and what they said</h4>
        <div className="list">
          {papers.length ? (
            papers.map((c) => {
              const answered = c.acknowledgementStatus === "RECEIVED";
              const sent = c.sendStatus === "DISPATCHED";
              return (
                <div className="row" key={c.id}>
                  <span className="t">
                    {PAPER_NAME[c.commType] ?? c.commType} · {c.channel?.toLowerCase() ?? "email"}
                  </span>
                  <span className="row-acts" style={{ gap: 6 }}>
                    {answered ? (
                      <Chip tone="success">acknowledged</Chip>
                    ) : sent ? (
                      <Chip tone="warning">{c.isOverdue ? "no answer" : "awaiting"}</Chip>
                    ) : (
                      <Chip tone="quiet">not sent</Chip>
                    )}
                    <span className="meta">{fmtStamp(c.createdAt, tz)}</span>
                    {!answered && sent && c.canAcknowledge && !sealed ? (
                      <Button
                        kind="quiet"
                        compact
                        onClick={() => {
                          setMethod(null);
                          setSaid("");
                          setRecording(c);
                        }}
                      >
                        Record
                      </Button>
                    ) : null}
                    {!answered && !sealed && (c.commType === "CONFIRMATION_VOUCHER" ? !!entry.reservation?.id : !!PAPER_STEP[c.commType]) ? (
                      <Button kind="quiet" compact state={resend.isPending ? "working" : "default"} onClick={() => sendAgain(c)}>
                        Send again
                      </Button>
                    ) : null}
                  </span>
                </div>
              );
            })
          ) : (
            <span className="quiet">nothing sent yet</span>
          )}
        </div>
      </div>
      {notes ? (
        <div>
          <h4>The thread</h4>
          <div className="list">
            <span className="meta">{notes}</span>
          </div>
        </div>
      ) : null}
      <DsDialog
        open={!!recording}
        onClose={() => setRecording(null)}
        busy={record.isPending}
        title={`What they said about the ${(PAPER_NAME[recording?.commType ?? ""] ?? "paper").toLowerCase()}`}
        caseLines={recording ? [`sent ${fmtStamp(recording.createdAt, tz)}`] : undefined}
        footer={
          <>
            <Button kind="quiet" onClick={() => setRecording(null)}>
              Not now
            </Button>
            <Button
              state={record.isPending ? "working" : !method || (method === "VERBAL" && !said.trim()) ? "inert" : "default"}
              title={!method ? "say how the answer came" : method === "VERBAL" && !said.trim() ? "write what they said" : undefined}
              onClick={() => record.mutate()}
            >
              Record
            </Button>
          </>
        }
      >
        <Choice
          options={[
            ["WRITTEN", "They wrote to us"],
            ["VERBAL", "They told us"],
          ]}
          value={method}
          onChange={setMethod}
        />
        <div className="field">
          <label>{method === "VERBAL" ? "What they said · the words are the record" : "Their words · optional"}</label>
          <textarea className="input" rows={2} value={said} onChange={(e) => setSaid(e.target.value)} />
        </div>
      </DsDialog>
    </>
  );
}
