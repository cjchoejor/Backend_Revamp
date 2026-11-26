"use client";

/**
 * A charge on a settled bill the desk asked the FOM to correct (2026-11-26, operator: "if front desk
 * wants to do it, it should ask the FOM for permission … and they approve it from notification or do
 * it by themselves, like how we handle other cases like this").
 *
 * On Check-out and Closed, where the bell lands: the front desk sees its ask waiting, with Take the
 * request back; the FOM, the GM or an admin sees "The desk asks to correct a charge" with the charge,
 * the figure now and the figure asked, the desk's reason, **Correct it** (which posts the correction
 * and, when money was paid over, opens the refund straight away) and **Turn it down** (words the desk
 * reads). The card reads the asks again every 8 s while one waits. Every figure is the server's.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  decideChargeCorrection,
  getChargeCorrections,
  withdrawChargeCorrection,
  type ChargeCorrectionAsk,
  type ChargeCorrectionStanding,
} from "@/lib/api/charge-corrections";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, NotNow, atLeast, toastRefusal, useRefreshEntry } from "./kit";
import { RefundDialog, type RefundTarget } from "./refund-card";
import { toastSettledOutcome } from "./s7-folio";

const KEY = (entryId: string) => ["charge-corrections", entryId] as const;

export function useChargeCorrections(entry: EntryDetail) {
  const { session } = useSession();
  const enabled = !!session && !!entry.folio && (entry.currentStage === "S8" || entry.currentStage === "S9");
  return useQuery({
    queryKey: KEY(entry.id),
    queryFn: () => getChargeCorrections(session!, entry.id),
    enabled,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data as ChargeCorrectionStanding | undefined)?.open.length ? 8_000 : false),
    refetchOnWindowFocus: true,
  });
}

const askWords = (a: ChargeCorrectionAsk) => {
  const what = a.charge?.description ?? "A charge";
  // The night audit's lines already name their room — said once.
  const where = a.charge?.where && !what.includes(a.charge.where) ? ` · ${a.charge.where}` : "";
  return `${what}${where} — net ${money(a.netBefore)} → ${money(a.netAfter)}`;
};

export function ChargeCorrectionAsks({ entry, tz, live }: { entry: EntryDetail; tz: string; live: boolean }) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const q = useChargeCorrections(entry);
  const [approving, setApproving] = useState<ChargeCorrectionAsk | null>(null);
  const [rejecting, setRejecting] = useState<ChargeCorrectionAsk | null>(null);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [refundFor, setRefundFor] = useState<RefundTarget | null>(null);
  const [refundLead, setRefundLead] = useState<string | null>(null);

  // An answer given on another screen: read the bill again, so the corrected figures show here.
  const answered = q.data?.latest ? `${q.data.latest.id}:${q.data.latest.status}` : null;
  const openCount = q.data?.open.length ?? 0;
  const seen = useRef<{ answered: string | null; open: number } | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const before = seen.current;
    seen.current = { answered, open: openCount };
    if (before && (before.answered !== answered || before.open > openCount)) {
      refresh([["billing-summary"], ["settlement-buckets"], ["folio-documents"], ["vouchers"]]);
      if (!fom && q.data.latest && before.answered !== answered) {
        if (q.data.latest.status === "APPROVED") toast.success(`${q.data.latest.decidedByName ?? "The FOM"} corrected the charge`);
        else if (q.data.latest.status === "REJECTED") toast.warning(`${q.data.latest.decidedByName ?? "The FOM"} turned down the correction`);
      }
    }
  }, [q.data, answered, openCount, fom, refresh]);

  const done = (standing: ChargeCorrectionStanding) => {
    qc.setQueryData(KEY(entry.id), standing);
    refresh([["billing-summary"], ["settlement-buckets"], ["folio-documents"], ["vouchers"]]);
  };
  const approve = useMutation({
    mutationFn: () => decideChargeCorrection(session!, entry.id, approving!.id, { decision: "APPROVE", note: note.trim() || null }),
    onSuccess: ({ standing, outcome }) => {
      const asked = approving;
      setApproving(null);
      done(standing);
      toast.success("Corrected — its service charge and GST moved with it");
      if (outcome) {
        toastSettledOutcome(outcome);
        if (outcome.refundDue) {
          setRefundLead(`The correction leaves ${outcome.refundDue.payerName} ${money(outcome.refundDue.amount)} paid above their share. Record the refund now.`);
          setRefundFor({
            billingModel: outcome.refundDue.billingModel,
            amount: outcome.refundDue.amount,
            payerName: outcome.refundDue.payerName,
            wayItCame: outcome.refundDue.wayItCame,
            why: asked?.reason,
          });
        }
      }
    },
    onError: (e) => toastRefusal(e, "Could not correct it"),
  });
  const reject = useMutation({
    mutationFn: () => decideChargeCorrection(session!, entry.id, rejecting!.id, { decision: "REJECT", note: why.trim() }),
    onSuccess: ({ standing }) => {
      setRejecting(null);
      done(standing);
      toast.success("Turned down — the desk reads your words");
    },
    onError: (e) => toastRefusal(e, "Could not turn it down"),
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => withdrawChargeCorrection(session!, entry.id, id),
    onSuccess: (standing) => {
      done(standing);
      toast.success("The request was taken back");
    },
    onError: (e) => toastRefusal(e, "Could not take it back"),
  });

  const open = q.data?.open ?? [];
  const latest = q.data?.latest ?? null;
  return (
    <>
      {open.map((a) => (
        <div key={a.id} className="notice next" role="status" data-charge-ask="waiting" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 320px" }}>
            <b>{fom ? "The desk asks to correct a charge" : "Waiting for the FOM to correct a charge"}</b>
            <br />
            {askWords(a)}
            <br />
            <span className="sm">
              &ldquo;{a.reason}&rdquo; · asked by {a.requestedByName}, {fmtDateTime(a.requestedAt, tz)}
            </span>
          </span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {fom ? (
              <>
                <Button
                  className={live ? "go" : undefined}
                  state={live ? "default" : "inert"}
                  onClick={() => {
                    setNote("");
                    setApproving(a);
                  }}
                >
                  Correct it
                </Button>
                <Button
                  kind="secondary"
                  state={live ? "default" : "inert"}
                  onClick={() => {
                    setWhy("");
                    setRejecting(a);
                  }}
                >
                  Turn it down
                </Button>
              </>
            ) : (
              <Button kind="secondary" state={withdraw.isPending ? "working" : "default"} workingLabel="Taking it back…" onClick={() => withdraw.mutate(a.id)}>
                Take the request back
              </Button>
            )}
          </span>
        </div>
      ))}
      {!open.length && latest?.status === "REJECTED" ? (
        <div className="notice stop" role="alert" data-charge-ask="rejected" style={{ marginTop: 12 }}>
          The FOM turned down correcting {latest.charge?.description ?? "the charge"} — &ldquo;{latest.decisionNote}&rdquo; · {latest.decidedByName}
          {latest.decidedAt ? `, ${fmtDateTime(latest.decidedAt, tz)}` : ""}.
        </div>
      ) : null}
      {!open.length && latest?.status === "APPROVED" ? (
        <p className="sm ok-ink" data-charge-ask="approved" style={{ marginTop: 10 }}>
          {latest.decidedByName} corrected {latest.charge?.description ?? "the charge"}: net {money(latest.netBefore)} → {money(latest.netAfter)}
          {latest.decidedAt ? `, ${fmtDateTime(latest.decidedAt, tz)}` : ""}.
        </p>
      ) : null}

      <DsDialog
        open={!!approving}
        onClose={() => setApproving(null)}
        title="Correct the charge"
        caseLines={approving ? [entry.id, askWords(approving)] : []}
        busy={approve.isPending}
        footer={
          <>
            <NotNow onClick={() => setApproving(null)} busy={approve.isPending} />
            <Button className="go" state={approve.isPending ? "working" : "default"} workingLabel="Correcting…" onClick={() => approve.mutate()}>
              Correct it
            </Button>
          </>
        }
      >
        {approving ? (
          <>
            <p className="sm" style={{ marginTop: 0 }}>
              The charge&rsquo;s net goes from <b className="money">{money(approving.netBefore)}</b> to <b className="money">{money(approving.netAfter)}</b>, its service charge and GST with
              it, on the share it belongs to. Money paid above that share is refunded next; an agency&rsquo;s voucher not paid for yet covers less; a tax invoice that went out
              is replaced by a new one.
            </p>
            <p className="sm">
              The desk said: &ldquo;{approving.reason}&rdquo;
            </p>
            <div className="field">
              <label>Note · optional</label>
              <input className="input" value={note} placeholder="e.g. checked with the restaurant" onChange={(e) => setNote(e.target.value)} />
            </div>
          </>
        ) : null}
      </DsDialog>

      <DsDialog
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Turn it down"
        caseLines={rejecting ? [entry.id, askWords(rejecting)] : []}
        busy={reject.isPending}
        footer={
          <>
            <NotNow onClick={() => setRejecting(null)} busy={reject.isPending} />
            <Button
              kind="danger"
              state={reject.isPending ? "working" : why.trim() ? "default" : "inert"}
              reason={why.trim() ? undefined : "say why — the desk reads it"}
              workingLabel="Turning it down…"
              onClick={() => reject.mutate()}
            >
              Turn it down
            </Button>
          </>
        }
      >
        <p className="sm" style={{ marginTop: 0 }}>
          The charge stays as it is. The desk reads what you write.
        </p>
        <div className="field">
          <label>Why</label>
          <input className="input" value={why} placeholder="e.g. the restaurant's chit shows Nu 1,000" onChange={(e) => setWhy(e.target.value)} />
        </div>
      </DsDialog>

      <RefundDialog
        entry={entry}
        open={!!refundFor}
        onClose={() => setRefundFor(null)}
        target={refundFor}
        lead={refundLead ? <div className="notice next" role="status"><span>{refundLead}</span></div> : undefined}
      />
    </>
  );
}
