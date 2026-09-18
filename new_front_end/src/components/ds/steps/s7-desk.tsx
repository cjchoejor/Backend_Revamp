"use client";

/**
 * Stay — the work around the guest: the departments told at check-in and the one before
 * check-out, disputes, faults in the room, a change to the terms, and who the bill goes to.
 * Operator words only; the departments' handoffs are named by what they are for.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  acceptHandoff,
  amendEntry,
  buildH4FulfilmentEvidence,
  createH4Handoff,
  finalizeDeficientCondition,
  fulfilHandoff,
  getHandoffChecklist,
  openDispute,
  progressDispute,
} from "@/lib/api/in-stay";
import type { HandoffChecklistItem } from "@/lib/api/handoffs";
import { closeDispute } from "@/lib/api/checkout";
import { fmtStamp } from "@/lib/ds/format";
import type { DeficientConditionSummary, DisputeSummary, EntryDetail, HandoffSummary } from "@/types/api";
import { Choice, DsDialog, Fact, Facts, Live, ReasonDialog, StepCard, atLeast, toastRefusal, useRefreshEntry, useStepMode, words } from "./kit";
import { BILLING_WORD } from "./s7-folio";

/* ------------------------------------------------------------------ vocabulary */

const HANDOFF_WORD: Record<string, string> = {
  CREATED: "told, not yet accepted",
  ACCEPTED: "accepted",
  FULFILLED: "done",
  CLOSED: "closed",
  CANCELLED: "withdrawn",
};

const FINAL_FAULT = [
  ["NOT_APPLICABLE", "No fault to report"],
  ["RESOLVED", "Fault fixed"],
  ["UNRESOLVED_AT_CHECKOUT", "Fault still open at check-out"],
  ["RECORDED", "Fault recorded"],
] as const;
type FinalFault = (typeof FINAL_FAULT)[number][0];

const DISPUTE_WORD: Record<string, string> = { OPEN: "open", IN_PROGRESS: "being reviewed", RESOLVED: "resolved" };

const FAULT_WORD: Record<string, string> = {
  OPEN: "open",
  RESOLVED: "fixed",
  UNRESOLVED: "still open — carried to check-out",
  DEFICIENT_UNRESOLVED_AT_CHECKOUT: "still open at check-out",
};
const faultSettled = (s: string) => s === "RESOLVED" || s === "UNRESOLVED" || s === "DEFICIENT_UNRESOLVED_AT_CHECKOUT";

const AMEND_KINDS = [
  ["INCLUSION_CHANGE", "What's included"],
  ["MEAL_PLAN_CHANGE", "Meal plan"],
  ["DISCOUNT", "Discount"],
] as const;
type AmendKind = (typeof AMEND_KINDS)[number][0];

function handoffWord(h: HandoffSummary) {
  if (h.rejectedAt) return "turned back";
  return HANDOFF_WORD[h.state] ?? words(h.state).toLowerCase();
}

/** "2 accepted · 1 done" across the rooms a department was told about. */
function tally(list: HandoffSummary[]) {
  const counts = new Map<string, number>();
  for (const h of list) counts.set(handoffWord(h), (counts.get(handoffWord(h)) ?? 0) + 1);
  return [...counts].map(([w, n]) => (list.length > 1 ? `${n} ${w}` : w)).join(" · ");
}

/* ------------------------------------------------------------------ the departments */

export function HandoffsCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entry.id);
  const handoffs = entry.handoffs ?? [];
  const housekeeping = handoffs.filter((h) => h.handoffType === "H2" && h.state !== "CANCELLED");
  const kitchen = handoffs.filter((h) => h.handoffType === "H3" && h.state !== "CANCELLED");
  const before = handoffs.find((h) => h.handoffType === "H4") ?? null;

  const checklist = useQuery({
    queryKey: ["handoff-checklist", "H4"],
    queryFn: () => getHandoffChecklist(session!, "H4"),
    enabled: !!session && before?.state === "CREATED",
  });
  const items = (checklist.data?.items ?? []) as HandoffChecklistItem[];
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [fault, setFault] = useState<FinalFault>("NOT_APPLICABLE");
  const allTicked = items.filter((i) => i.mandatory).every((i) => ticks[i.code] === true);

  const start = useMutation({
    mutationFn: () => createH4Handoff(session!, entry.id, { notes: "Pre-checkout coordination" }),
    onSuccess: () => {
      toast.success("The departments are told the guest is leaving");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be started"),
  });
  const accept = useMutation({
    mutationFn: () => {
      const c: Record<string, boolean> = {};
      for (const i of items) c[i.code] = ticks[i.code] === true;
      return acceptHandoff(session!, before!.id, c);
    },
    onSuccess: () => {
      toast.success("Accepted");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be accepted"),
  });
  const done = useMutation({
    mutationFn: () => fulfilHandoff(session!, before!.id, buildH4FulfilmentEvidence(fault)),
    onSuccess: () => {
      toast.success("Before check-out · done");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be marked done"),
  });

  return (
    <StepCard title="The departments" icon="broom">
      <Facts>
        <Fact k="Housekeeping">{housekeeping.length ? tally(housekeeping) : null}</Fact>
        <Fact k="Kitchen and bar">{kitchen.length ? tally(kitchen) : null}</Fact>
        <Fact k="Before check-out" meta={before?.acceptedAt ? `accepted ${fmtStamp(before.acceptedAt, tz)}` : undefined}>
          {before ? handoffWord(before) : <span className="warn-ink">not started — the move to Check-out waits for it</span>}
        </Fact>
      </Facts>
      {past ? null : !before ? (
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button kind="secondary" compact state={start.isPending ? "working" : "default"} workingLabel="Telling them…" onClick={() => start.mutate()}>
            Tell the departments the guest is leaving
          </Button>
        </div>
      ) : before.state === "CREATED" ? (
        <div className="bind provisional" style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {items.length === 0 ? (
            <span className="meta">{checklist.isLoading ? "Reading the checklist…" : "No checklist for this handoff."}</span>
          ) : (
            items.map((i) => (
              <label key={i.code} className="sm" style={{ display: "flex", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={ticks[i.code] === true} onChange={(e) => setTicks((p) => ({ ...p, [i.code]: e.target.checked }))} />
                <span>
                  {i.description ?? words(i.code)}
                  {i.mandatory ? null : <span className="meta"> · optional</span>}
                </span>
              </label>
            ))
          )}
          <div className="row-acts">
            <Button
              compact
              state={accept.isPending ? "working" : allTicked ? "default" : "inert"}
              title={allTicked ? undefined : "tick every item that is required first"}
              workingLabel="Accepting…"
              onClick={() => accept.mutate()}
            >
              Accept it
            </Button>
          </div>
        </div>
      ) : before.state === "ACCEPTED" ? (
        <div className="bind provisional" style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <div className="field">
            <label>Any fault in the room, at the end</label>
            <Choice options={FINAL_FAULT} value={fault} onChange={setFault} />
          </div>
          <div className="row-acts">
            <Button compact state={done.isPending ? "working" : "default"} workingLabel="Saving…" onClick={() => done.mutate()}>
              Mark it done
            </Button>
          </div>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ disputes */

export function DisputesCard({ entry, tz, onRaise }: { entry: EntryDetail; tz: string; onRaise: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const disputes = entry.disputes ?? [];
  const elevated = atLeast(session?.actorLevel, "L2");
  const gm = atLeast(session?.actorLevel, "L3");
  const [closing, setClosing] = useState<DisputeSummary | null>(null);
  const review = useMutation({
    mutationFn: (id: string) => progressDispute(session!, id, "IN_PROGRESS"),
    onSuccess: () => {
      toast.success("The review has started");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The review could not be started"),
  });
  // The GM closes a dispute here too (2026-09-18): an open dispute holds the move to Check-out,
  // and the only Close was on the Check-out step — a dispute raised in-house could never be
  // answered from the desk.
  const close = useMutation({
    mutationFn: (v: { id: string; reason: string }) => closeDispute(session!, v.id, v.reason),
    onSuccess: () => {
      toast.success("The dispute is closed — it no longer holds the booking");
      setClosing(null);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The dispute could not be closed"),
  });
  if (disputes.length === 0) return null;
  return (
    <div id="s7-disputes">
      <StepCard
        title="Disputes"
        icon="alert"
        meta="An open dispute holds the move to Check-out."
        acts={
          <Live>
            <Button kind="quiet" compact onClick={onRaise}>
              Raise another…
            </Button>
          </Live>
        }
      >
        {disputes.map((d) => (
          <div key={d.id} className="fact">
            <span className="k">{fmtStamp(d.openedAt, tz)}</span>
            <span className="v">
              <b>{d.title}</b>
              {d.description ? <span className="meta"> · {d.description}</span> : null}
            </span>
            <span className="row-acts" style={{ alignItems: "center" }}>
              <Chip tone={d.status === "RESOLVED" ? "success" : "warning"}>{DISPUTE_WORD[d.status] ?? words(d.status).toLowerCase()}</Chip>
              {d.status === "OPEN" || d.status === "REOPENED" ? (
                <Live>
                  <Button
                    kind="quiet"
                    compact
                    state={!elevated ? "inert" : review.isPending ? "working" : "default"}
                    unlockRole={elevated ? undefined : "FOM"}
                    onClick={() => review.mutate(d.id)}
                  >
                    Start the review
                  </Button>
                </Live>
              ) : null}
              {d.status !== "CLOSED" ? (
                <Live>
                  <Button
                    kind="secondary"
                    compact
                    state={gm ? "default" : "inert"}
                    unlockRole={gm ? undefined : "GM"}
                    onClick={() => setClosing(d)}
                  >
                    Close…
                  </Button>
                </Live>
              ) : null}
            </span>
          </div>
        ))}
        <ReasonDialog
          open={!!closing}
          onClose={() => setClosing(null)}
          title="Close the dispute"
          caseLines={closing ? [<b key="t">{closing.title}</b>, closing.id] : undefined}
          lead="The GM's answer to the guest's query. It is recorded with your name; the dispute no longer holds the booking."
          reasonLabel="The answer · recorded on the dispute"
          placeholder="credited in full — the minibar was charged twice"
          confirmLabel="Close the dispute"
          busy={close.isPending}
          onConfirm={(reason) => closing && close.mutate({ id: closing.id, reason })}
        />
      </StepCard>
    </div>
  );
}

export function RaiseDisputeDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDetail("");
  }, [open]);
  const save = useMutation({
    mutationFn: () => {
      if (!entry.folio?.id) throw new Error("There is no folio to dispute");
      return openDispute(session!, { entryId: entry.id, folioId: entry.folio.id, title: title.trim(), description: detail.trim() || undefined });
    },
    onSuccess: () => {
      toast.success("The dispute is open — it holds the move to Check-out until it is settled");
      refresh();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The dispute could not be raised"),
  });
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      register="danger"
      title="Raise a dispute"
      busy={save.isPending}
      footer={
        <>
          <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            kind="danger"
            solid
            state={save.isPending ? "working" : title.trim() ? "default" : "inert"}
            title={title.trim() ? undefined : "say what is disputed first"}
            workingLabel="Raising…"
            onClick={() => save.mutate()}
          >
            Raise
          </Button>
        </>
      }
    >
      <p className="sm" style={{ marginTop: 0 }}>
        An open dispute holds the move to Check-out until it is reviewed and settled.
      </p>
      <div className="field">
        <label>What is disputed</label>
        <input className="input" value={title} placeholder="Restaurant chit R-1182 · did not order this" onChange={(e) => setTitle(e.target.value)} autoFocus />
        <span className="control-note">Holding one posting out of the bill is not in the backend yet (BE-53) — name the charge here</span>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>The guest&rsquo;s words · optional</label>
        <textarea className="input" rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ faults in the room */

export function FaultsCard({ entry, tz, onFlag }: { entry: EntryDetail; tz: string; onFlag: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const records = useMemo(() => {
    const m = new Map<string, DeficientConditionSummary & { roomNumber: string }>();
    for (const a of entry.roomAssignments ?? [])
      for (const d of a.room?.deficientConditionRecords ?? []) if (!m.has(d.id)) m.set(d.id, { ...d, roomNumber: a.room?.roomNumber ?? "?" });
    return [...m.values()];
  }, [entry.roomAssignments]);
  const settle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "RESOLVED" | "UNRESOLVED" }) =>
      finalizeDeficientCondition(session!, id, {
        status,
        resolutionNotes: status === "RESOLVED" ? "Resolved during stay" : "Unresolved — carries to checkout",
      }),
    onSuccess: () => {
      toast.success("The fault is updated");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The fault could not be updated"),
  });
  if (records.length === 0) return null;
  return (
    <StepCard
      title="Faults in the room"
      icon="wrench"
      meta="Each fault is fixed, or recorded as still open, before check-out."
      acts={
        <Live>
          <Button kind="quiet" compact onClick={onFlag}>
            Report another…
          </Button>
        </Live>
      }
    >
      {records.map((d) => (
        <div key={d.id} className="fact">
          <span className="k">Room {d.roomNumber}</span>
          <span className="v">
            <b>{words(d.category)}</b> · {d.description}
            <span className="meta"> · found {fmtStamp(d.detectedAt, tz)}</span>
          </span>
          <span className="row-acts" style={{ alignItems: "center" }}>
            <Chip tone={faultSettled(d.status) ? "success" : "warning"}>{FAULT_WORD[d.status] ?? words(d.status).toLowerCase()}</Chip>
            {faultSettled(d.status) ? null : (
              <Live>
                <Button kind="quiet" compact state={settle.isPending ? "inert" : "default"} onClick={() => settle.mutate({ id: d.id, status: "RESOLVED" })}>
                  Fixed
                </Button>
                <Button kind="quiet" compact state={settle.isPending ? "inert" : "default"} onClick={() => settle.mutate({ id: d.id, status: "UNRESOLVED" })}>
                  Still open
                </Button>
              </Live>
            )}
          </span>
        </div>
      ))}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ a change to the terms */

export function TermsChangeCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const refresh = useRefreshEntry(entry.id);
  const [kind, setKind] = useState<AmendKind>("INCLUSION_CHANGE");
  const [reason, setReason] = useState("");
  const [terms, setTerms] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const segmentId = entry.segments?.[0]?.id;
      if (!segmentId) throw new Error("This booking has no open pass to record it against");
      return amendEntry(session!, entry.id, {
        amendmentType: kind,
        segmentId,
        amendmentPath: "PATH_2",
        requestedBy: session!.userId,
        authorisedBy: session!.userId,
        authorityBasis: "FOM mid-stay amendment",
        reason: reason.trim(),
        newTermsSummary: terms.trim(),
        stageAtAmendment: "S7",
      });
    },
    onSuccess: () => {
      toast.success("The change to the terms is recorded");
      setReason("");
      setTerms("");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The change could not be recorded"),
  });
  if (past || !atLeast(session?.actorLevel, "L2")) return null;
  const missing = !reason.trim() ? "the reason" : !terms.trim() ? "the new terms, in a sentence" : null;
  return (
    <StepCard title="A change to the terms · the FOM" icon="pen" meta="Recorded against this pass with the FOM's authority. A room of another type is the room's own Change room, above.">
      <div className="form2">
        <div className="wide field">
          <label>What changes</label>
          <Choice options={AMEND_KINDS} value={kind} onChange={setKind} />
        </div>
        <div className="field">
          <label>Reason</label>
          <input className="input" value={reason} placeholder="the guest asked for dinner every night" onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="field">
          <label>The new terms</label>
          <input className="input" value={terms} placeholder="MAP + dinner from 13 Sep" onChange={(e) => setTerms(e.target.value)} />
        </div>
      </div>
      <div className="row-acts" style={{ marginTop: 10 }}>
        <Button compact state={save.isPending ? "working" : missing ? "inert" : "default"} title={missing ?? undefined} workingLabel="Recording…" onClick={() => save.mutate()}>
          Record the change
        </Button>
      </div>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ billing model */

const MODELS = [
  ["TOUR_OPERATOR_VOUCHER", BILLING_WORD.TOUR_OPERATOR_VOUCHER],
  ["DIRECT_BILL", BILLING_WORD.DIRECT_BILL],
  ["GUEST_PAY", BILLING_WORD.GUEST_PAY],
] as const;

export function BillingModelCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const folio = entry.folio ?? null;
  const model = folio?.billingModel ?? null;
  const known = MODELS.some(([v]) => v === model);
  const history = [...(folio?.billingModelTransitions ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <StepCard title="Billing model">
      {known ? (
        <Choice options={MODELS} value={model as (typeof MODELS)[number][0]} disabled />
      ) : (
        <span className="sm">{model ? BILLING_WORD[model] ?? words(model) : <span className="dash">not set</span>}</span>
      )}
      {history.map((t) => (
        <div key={t.id} className="meta" style={{ marginTop: 6 }}>
          {t.fromModel ? `${BILLING_WORD[t.fromModel] ?? words(t.fromModel)} → ` : "set to "}
          {BILLING_WORD[t.toModel] ?? words(t.toModel)} · {fmtStamp(t.createdAt, tz)}
        </div>
      ))}
      <div className="meta" style={{ marginTop: 6 }}>
        Set at Set up, before the folio existed. A change now opens a new pass through Re-enter · Change billing model, with the FOM&rsquo;s authority and a reason.
      </div>
    </StepCard>
  );
}
