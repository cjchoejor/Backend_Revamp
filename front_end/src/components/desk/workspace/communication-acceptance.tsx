"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  acknowledgeCommunication,
  listEntryCommunications,
  type EntryCommunication,
  type EntryCommunicationType,
} from "@/lib/api/entries";

/**
 * "Record the guest's answer" for a governed outbound communication — the same affordance the S2
 * quote step has always had, now reusable for the proforma invoice (S3), confirmation voucher (S4)
 * and pre-arrival reminder (S5).
 *
 * Two rules it exists to express, both enforced server-side:
 *  - Acceptance is only recordable against something actually SENT. It is evidence of what the
 *    guest said, and there is no response to an email that never went out. When nothing has been
 *    dispatched the block says so rather than offering a button that would 409.
 *  - Recording it is evidence, and for one boundary also a gate (2026-07-31): a DISPATCHED
 *    proforma must have its answer recorded before the S3→S4 freeze. The voucher and
 *    pre-arrival acknowledgements remain evidence-only and never block a stage.
 *
 * All state (dispatched? acknowledged? overdue?) is read from the backend's `canAcknowledge` /
 * `isOverdue` — never re-derived here, so the production frontend and this one always agree.
 */

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

const COPY: Record<EntryCommunicationType, { title: string; nothingSent: string; optionalHint: string }> = {
  QUOTATION: {
    title: "Quote",
    nothingSent: "No quote has been emailed to the guest yet.",
    optionalHint: "Sending the quote is optional — it's the generated quote that moves the booking on.",
  },
  PROFORMA_INVOICE: {
    title: "Proforma invoice",
    nothingSent: "The proforma hasn't been emailed to the guest yet — nothing to answer.",
    optionalHint:
      "Sending the proforma is optional — but once it has been sent, the guest's answer must be recorded here before the booking can be confirmed.",
  },
  CONFIRMATION_VOUCHER: {
    title: "Confirmation voucher",
    nothingSent: "The voucher goes out automatically when the reservation is confirmed.",
    optionalHint: "Acknowledgement is recorded for the file — it doesn't hold up arrival.",
  },
  PRE_ARRIVAL_REMINDER: {
    title: "Pre-arrival reminder",
    nothingSent: "No pre-arrival reminder has been sent yet.",
    optionalHint: "Acknowledgement is recorded for the file — it doesn't hold up check-in.",
  },
};

function fmt(ts: string | null | undefined) {
  return ts ? ts.slice(0, 16).replace("T", " ") : "—";
}

export function CommunicationAcceptanceBlock({
  entryId,
  commType,
  title,
}: {
  entryId: string;
  commType: EntryCommunicationType;
  /** Override the default heading (e.g. when the host step already names the artifact). */
  title?: string;
}) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<"VERBAL" | "WRITTEN">("VERBAL");
  const [verbatim, setVerbatim] = useState("");

  const commsQuery = useQuery({
    queryKey: ["entry-communications", entryId],
    queryFn: () => listEntryCommunications(session!, entryId),
    enabled: !!session,
  });

  // Newest first from the backend, so the first match is the live one. Earlier ones are prior
  // rounds (a superseded quote, a re-issued proforma) and are history, not actionable.
  const items = commsQuery.data?.items ?? [];
  const comm: EntryCommunication | undefined = items.find((c) => c.commType === commType);

  const ackM = useMutation({
    mutationFn: () => {
      if (!comm) throw new Error("Nothing to acknowledge");
      return acknowledgeCommunication(session!, comm.id, {
        method,
        verbatimNote: method === "VERBAL" ? verbatim.trim() : undefined,
      });
    },
    onSuccess: () => {
      toast.success("Guest response recorded");
      setVerbatim("");
      void queryClient.invalidateQueries({ queryKey: ["entry-communications", entryId] });
      void queryClient.invalidateQueries({ queryKey: ["entry-trace", entryId] });
      // The W22 window is cancelled in the same transaction — refresh so the countdown clears.
      void queryClient.invalidateQueries({ queryKey: ["entry-timers", entryId] });
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't record the response"),
  });

  const copy = COPY[commType];
  const heading = title ?? copy.title;

  // Nothing dispatched at all — say so plainly instead of rendering a dead form.
  if (!comm) {
    return (
      <div className="block">
        <BlockH>{heading} · guest response</BlockH>
        <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>{copy.nothingSent}</p>
        <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "6px 0 0" }}>{copy.optionalHint}</p>
      </div>
    );
  }

  if (comm.acknowledgementStatus === "RECEIVED") {
    return (
      <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 13 }}>
        <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
        {heading} accepted by guest · {fmt(comm.acknowledgementReceivedAt)}
      </div>
    );
  }

  return (
    <div className="block">
      <BlockH>{heading} · record the guest&rsquo;s answer</BlockH>
      <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
        <Mail style={{ width: 12, height: 12, verticalAlign: "-1px", marginRight: 4 }} />
        Sent {fmt(comm.createdAt)}
        {comm.acknowledgementTimeoutAt ? ` · reply window to ${fmt(comm.acknowledgementTimeoutAt)}` : ""}
      </p>

      {comm.isOverdue && (
        <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, marginBottom: 9 }}>
          <Clock style={{ width: 13, height: 13 }} />
          No reply inside the window. Recording a late response is still fine — it&rsquo;s dated as given.
        </div>
      )}

      <div className="field">
        <label>How did they accept?</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as "VERBAL" | "WRITTEN")}>
          <option value="VERBAL">Verbal (staff records)</option>
          <option value="WRITTEN">Written</option>
        </select>
      </div>
      {method === "VERBAL" && (
        <div className="field">
          <label>Verbatim note</label>
          <input value={verbatim} onChange={(e) => setVerbatim(e.target.value)} placeholder="What the guest said" />
        </div>
      )}
      <button
        className="btn btn-primary"
        disabled={ackM.isPending || !comm.canAcknowledge || (method === "VERBAL" && !verbatim.trim())}
        onClick={() => ackM.mutate()}
      >
        {ackM.isPending ? "Recording…" : "Record acceptance"}
      </button>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "7px 0 0" }}>{copy.optionalHint}</p>
    </div>
  );
}
