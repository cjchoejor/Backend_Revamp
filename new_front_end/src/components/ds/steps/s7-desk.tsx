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
import { fmtStamp, money, plural } from "@/lib/ds/format";
import { changePayer, getPayer, previewPayerChange } from "@/lib/api/payer";
import { refusalText } from "@/lib/ds/translate";
import { useBookedBy } from "./s8-parts";
import type { DeficientConditionSummary, DisputeSummary, EntryDetail, HandoffSummary } from "@/types/api";
import { Choice, DsDialog, Fact, Facts, Live, ReasonDialog, StepCard, atLeast, toastRefusal, useRefreshEntry, useStepMode, words, NotNow, useInlineWay } from "./kit";
import { BILLING_WORD } from "./s7-folio";
import { Help } from "@/components/ds/help";

/* ------------------------------------------------------------------ vocabulary */

const HANDOFF_WORD: Record<string, string> = {
  CREATED: "told, not yet accepted",
  ACCEPTED: "accepted",
  FULFILLED: "done",
  CLOSED: "closed",
  CANCELLED: "withdrawn",
  ESCALATED: "not accepted in time — passed to the FOM",
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

/**
 * Housekeeping's and the kitchen's own handoffs (H2 · H3), accepted from the desk (2026-09-25,
 * operator: "for kitchen to accept and housekeeping to accept we have nowhere to record that").
 * The departments have no terminal of their own yet, so the desk records the acceptance on
 * their word — the same checklist the backend demands, ticked here. Acceptance is all there is
 * to record: the code fulfils H1, H4 and H5 only.
 *
 * One row per department, not one card per room (2026-10-29, operator: "it seems to be asking
 * housekeeping and kitchen and bar for every room, consuming a lot of space"): the rooms it was told
 * about and not yet accepted, its checklist ticked once, and one Accept that records it for each.
 */
function AcceptDepartment({ entry, type, handoffs }: { entry: EntryDetail; type: "H2" | "H3"; handoffs: HandoffSummary[] }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const dept = type === "H3" ? "Kitchen and bar" : "Housekeeping";
  const roomOf = (h: HandoffSummary) => {
    const id = (h as HandoffSummary & { roomAssignmentId?: string | null }).roomAssignmentId ?? null;
    return id ? ((entry.roomAssignments ?? []).find((a) => a.id === id)?.room?.roomNumber ?? null) : null;
  };
  const rooms = handoffs.map(roomOf).filter((r): r is string => !!r);
  const checklist = useQuery({
    queryKey: ["handoff-checklist", type],
    queryFn: () => getHandoffChecklist(session!, type),
    enabled: !!session,
  });
  const items = (checklist.data?.items ?? []) as HandoffChecklistItem[];
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const allTicked = items.filter((i) => i.mandatory).every((i) => ticks[i.code] === true);
  const accept = useMutation({
    mutationFn: async () => {
      const c: Record<string, boolean> = {};
      for (const i of items) c[i.code] = ticks[i.code] === true;
      const failed: string[] = [];
      for (const h of handoffs) {
        try {
          await acceptHandoff(session!, h.id, c);
        } catch {
          failed.push(roomOf(h) ?? h.id);
        }
      }
      return failed;
    },
    onSuccess: (failed) => {
      const ok = handoffs.length - failed.length;
      if (ok) toast.success(`${dept} accepted · ${rooms.length > 1 ? `Rooms ${rooms.join(", ")}` : rooms[0] ? `Room ${rooms[0]}` : plural(ok, "handoff")}`);
      if (failed.length) toast.error(`${dept}: not accepted for ${failed.map((r) => `Room ${r}`).join(", ")} — try again`);
      setTicks({});
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be accepted"),
  });
  if (handoffs.length === 0) return null;
  return (
    <div className="dept-row">
      <span className="dept-what">
        <b>{dept}</b>
        <span className="meta"> · to accept: {rooms.length ? `${rooms.length > 1 ? "Rooms" : "Room"} ${rooms.join(", ")}` : plural(handoffs.length, "handoff")}</span>
      </span>
      <span className="dept-ticks">
        {items.length === 0 ? (
          <span className="meta">{checklist.isLoading ? "Reading the checklist…" : "No checklist"}</span>
        ) : (
          items.map((i) => (
            <label key={i.code} className="sm" style={{ display: "inline-flex", gap: 6, cursor: "pointer", alignItems: "center" }}>
              <input type="checkbox" checked={ticks[i.code] === true} onChange={(e) => setTicks((p) => ({ ...p, [i.code]: e.target.checked }))} />
              <span>
                {i.description ?? words(i.code)}
                {i.mandatory ? null : <span className="meta"> · optional</span>}
              </span>
            </label>
          ))
        )}
      </span>
      <Button
        className={allTicked ? "go" : undefined}
        state={accept.isPending ? "working" : allTicked ? "default" : "inert"}
        title={allTicked ? undefined : "tick what they confirmed first"}
        workingLabel="Accepting…"
        onClick={() => accept.mutate()}
      >
        Accept{handoffs.length > 1 ? ` all ${handoffs.length}` : ""}
      </Button>
    </div>
  );
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
    <StepCard flow="departments" title="The departments" icon="broom">
      <Facts>
        <Fact k="Housekeeping">{housekeeping.length ? tally(housekeeping) : null}</Fact>
        <Fact k="Kitchen and bar">{kitchen.length ? tally(kitchen) : null}</Fact>
        <Fact k="Before check-out" meta={before?.acceptedAt ? `accepted ${fmtStamp(before.acceptedAt, tz)}` : undefined}>
          {before ? handoffWord(before) : <span className="warn-ink">not started — the move to Check-out waits for it</span>}
        </Fact>
      </Facts>
      {/* The departments' own handoffs waiting to be accepted — one row per department. */}
      {past ? null : (
        <div className="dept-rows">
          <AcceptDepartment entry={entry} type="H2" handoffs={housekeeping.filter((h) => h.state === "CREATED")} />
          <AcceptDepartment entry={entry} type="H3" handoffs={kitchen.filter((h) => h.state === "CREATED")} />
        </div>
      )}
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
      ) : before.state === "ACCEPTED" || before.state === "ESCALATED" ? (
        <div className="bind provisional" style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {before.state === "ESCALATED" ? (
            <span className="sm warn-ink" style={{ fontWeight: 600 }}>
              Nobody accepted it in time. Mark it done once the room is checked — the move to Check-out waits for it.
            </span>
          ) : null}
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
  // A section of the step (2026-10-29) — said when there is none, with the act that raises one.
  if (disputes.length === 0)
    return (
      <div id="s7-disputes">
        <StepCard
          flow="disputes"
          title="Disputes"
          icon="alert"
          status="None raised"
          meta="A guest who disagrees with a charge. An open dispute holds the move to Check-out."
          acts={
            <Live>
              <Button kind="secondary" compact onClick={onRaise}>
                Raise a dispute
              </Button>
            </Live>
          }
        />
      </div>
    );
  return (
    <div id="s7-disputes">
      <StepCard
        flow="disputes"
        title="Disputes"
        icon="alert"
        meta="An open dispute holds the move to Check-out."
        acts={
          <Live>
            <Button kind="quiet" compact onClick={onRaise}>
              Raise another
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
                    Close
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
  const inline = useInlineWay();
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
      help="An open dispute holds the move to Check-out until it is reviewed and settled." 
      footer={
        <>
          <NotNow onClick={onClose} busy={save.isPending} />
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
      <div className="field">
        <label>What is disputed</label>
        <input className="input" value={title} placeholder="Restaurant chit R-1182 · did not order this" onChange={(e) => setTitle(e.target.value)} autoFocus={!inline} />
        <span className="control-note">Name the charge here. It stays on the bill while the dispute is open.</span>
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
  // A section of the step (2026-10-29) — said when there is none, with the act that reports one.
  if (records.length === 0)
    return (
      <StepCard
        flow="faults"
        title="Faults in the room"
        icon="wrench"
        status="None reported"
        meta="Something broken or not working in a room. A room with a fault that stops it being used is taken out of service."
        acts={
          <Live>
            <Button kind="secondary" compact onClick={onFlag}>
              Report a fault
            </Button>
          </Live>
        }
      />
    );
  return (
    <StepCard
      flow="faults"
      title="Faults in the room"
      icon="wrench"
      meta="Each fault is fixed, or recorded as still open, before check-out."
      acts={
        <Live>
          <Button kind="quiet" compact onClick={onFlag}>
            Report another
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
    <StepCard title="A change to the terms · the FOM" icon="pen" meta="Recorded by the FOM. To move the guest to a room of another type, use Change room on that room, above.">
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

/* ------------------------------------------------------------------ who pays */

/** The kinds of charge, in the words of a bill. */
const KIND_WORDS: Array<[string, string]> = [
  ["ROOM_CHARGE", "Room nights"],
  ["F_AND_B", "Food and drink"],
  ["SERVICE", "Services"],
  ["OTHER", "Other charges"],
];

/** Who a payer is, in words — the agency or company by name when there is one. */
export function payerWord(model: string, party: string | null): string {
  if (model === "GUEST_PAY") return "the guest";
  if (model === "DIRECT_BILL") return party ? `${party}, on account` : "the account";
  if (model === "TOUR_OPERATOR_VOUCHER") return party ? `${party}, by voucher` : "the agent, by voucher";
  if (model === "GOVERNMENT") return "the government account";
  return words(model);
}

/** "Room nights → the guest · Food and drink, services → the guest", grouped by payer. */
function splitWords(map: Record<string, string> | null, fallback: string | null, party: string | null): string {
  const byPayer = new Map<string, string[]>();
  for (const [kind, label] of KIND_WORDS) {
    const m = map?.[kind] ?? fallback;
    if (!m) continue;
    byPayer.set(m, [...(byPayer.get(m) ?? []), label]);
  }
  if (byPayer.size === 0) return "not set";
  if (byPayer.size === 1) return `Everything to ${payerWord([...byPayer.keys()][0], party)}`;
  return [...byPayer].map(([m, kinds]) => `${kinds.join(", ")} → ${payerWord(m, party)}`).join(" · ");
}

/**
 * Who pays (2026-10-26, operator ruling) — changed here, while the guest is staying. It replaced
 * the Re-enter item that sent the booking back to Set up with no way back to Stay. The FOM picks
 * the new payer and whether the charges already on the bill move with it; the server's preview
 * says what each payer owes before and after; money already received stays with whoever paid it.
 */
export function WhoPaysCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const booked = useBookedBy(entry);
  const fom = atLeast(session?.actorLevel, "L2");
  const folio = entry.folio ?? null;
  const read = useQuery({
    queryKey: ["payer", entry.id, entry.updatedAt],
    queryFn: () => getPayer(session!, entry.id),
    enabled: !!session && !!folio,
  });
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const [move, setMove] = useState<"move" | "keep" | null>(null);
  const [reason, setReason] = useState("");
  const current = read.data?.current ?? folio?.billingModel ?? null;
  const cur = folio?.lines?.[0]?.currency ?? "BTN";
  const preview = useQuery({
    queryKey: ["payer-preview", entry.id, entry.updatedAt, to, move],
    queryFn: () => previewPayerChange(session!, entry.id, { billingModel: to!, moveExisting: move === "move" }),
    enabled: open && !!session && !!to && !!move,
    retry: false,
  });
  const run = useMutation({
    mutationFn: () => changePayer(session!, entry.id, { billingModel: to!, moveExisting: move === "move", reason: reason.trim() }),
    onSuccess: (r) => {
      toast.success(
        `Now billed to ${payerWord(r.to, booked.party)}${
          r.linesMoved ? ` — ${plural(r.linesMoved, "line")} already on the bill moved with it` : " — the charges already on the bill stay where they were"
        }`,
      );
      setOpen(false);
      setTo(null);
      setMove(null);
      setReason("");
      refresh([["payer", entry.id], ["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "Who pays could not be changed"),
  });
  const history = [...(folio?.billingModelTransitions ?? [])]
    .filter((t) => !t.folioLineId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const allowed = read.data?.allowed ?? [];
  const canChange = !!read.data?.canChange;
  const lines = read.data?.linesOnBill ?? folio?.lines?.length ?? 0;
  const pv = preview.data ?? null;
  const pvError = preview.error ? refusalText(preview.error) : null;
  const ready = !!to && !!move && !!pv && !preview.isFetching && reason.trim().length > 0;

  return (
    <StepCard
      title="Who pays"
      meta="Who each kind of charge on the bill goes to. It is set at Set up and can be changed here while the guest is staying — the booking stays on this step."
      status={<span>{splitWords(read.data?.map ?? null, current, booked.party)}</span>}
      acts={
        canChange && !open ? (
          <Live>
            <Button
              kind="secondary"
              compact
              state={fom ? "default" : "inert"}
              reason={fom ? undefined : "Changing who pays needs the FOM"}
              onClick={() => setOpen(true)}
            >
              Change who pays
            </Button>
          </Live>
        ) : null
      }
    >
      {open ? (
        <Live>
          <div className="form2" style={{ marginTop: 4 }}>
            <div className="wide field">
              <label>Bill it to</label>
              <Choice
                options={allowed.map((m) => [m, payerWord(m, booked.party)] as const)}
                value={to}
                onChange={(v) => setTo(v)}
              />
            </div>
            <div className="wide field">
              <label>
                The {plural(lines, "charge")} already on the bill
                <Help label="About the charges already on the bill">
                  Moving them bills every charge so far to the new payer as well — each with its service charge and GST. Keeping them leaves
                  them with whoever they are billed to now; only charges from now on go to the new payer. Money already paid always stays with
                  whoever paid it.
                </Help>
              </label>
              <Choice
                options={[
                  ["move", "Move them to the new payer too"],
                  ["keep", "Keep them where they are · only new charges move"],
                ] as const}
                value={move}
                onChange={(v) => setMove(v)}
              />
            </div>
          </div>
          {pvError ? (
            <p className="sm stop-ink" role="alert">
              {pvError}
            </p>
          ) : pv ? (
            <div className="payer-shares" role="group" aria-label="What each payer owes">
              {pv.byPayer.map((s) => {
                const before = Number(s.before);
                const after = Number(s.after);
                return (
                  <div key={s.billingModel} className="ps-cell">
                    <span className="ps-k">{payerWord(s.billingModel, booked.party)}</span>
                    <span className="ps-v money">
                      <span className={before < 0 ? "warn-ink" : undefined}>{money(Math.abs(before), cur)}</span> <span className="ps-arrow">→</span>{" "}
                      <b className={after < 0 ? "warn-ink" : after > before ? "stop-ink" : undefined}>{money(Math.abs(after), cur)}</b>
                    </span>
                    <span className="ps-note">{after < 0 ? "paid over — refunded or used at check-out" : after > 0 ? "to pay" : "nothing to pay"}</span>
                  </div>
                );
              })}
            </div>
          ) : to && move ? (
            <p className="sm meta">Working it out…</p>
          ) : null}
          {pv ? <p className="sm">{pv.linesMoving ? `${plural(pv.linesMoving, "line")} on the bill move to the new payer.` : "No line on the bill moves."}</p> : null}
          <div className="field" style={{ marginTop: 8 }}>
            <label>Why · kept with the change</label>
            <input className="input" value={reason} maxLength={1000} placeholder="the company agreed to cover the stay" onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button
              state={run.isPending ? "working" : ready ? "default" : "inert"}
              reason={ready ? undefined : !to ? "Choose who pays" : !move ? "Say what happens to the charges already on the bill" : !reason.trim() ? "Say why" : undefined}
              workingLabel="Changing…"
              onClick={() => run.mutate()}
            >
              Change who pays
            </Button>
            <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </Live>
      ) : null}
      {history.length ? (
        <div style={{ marginTop: 8, display: "grid", gap: 2 }}>
          {history.map((t) => (
            <div key={t.id} className="sm">
              {t.fromModel ? `${payerWord(t.fromModel, booked.party)} → ` : "Set to "}
              {payerWord(t.toModel, booked.party)} <span className="meta">· {fmtStamp(t.createdAt, tz)}{t.reason ? ` · “${t.reason}”` : ""}</span>
            </div>
          ))}
        </div>
      ) : null}
    </StepCard>
  );
}
