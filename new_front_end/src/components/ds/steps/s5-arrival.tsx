"use client";

/**
 * Step 5 · Arrival — "ready the room" (rulings A1–A8, P1; prototype `stepCanvas[5]` with the v1.6
 * board; Storyboard 01 frames 2–6).
 *
 * The desk's three: the rooms assigned, the contact person on file, the guest at the desk.
 * Housekeeping's readiness is shown with its source, never ticked here. The front-desk handoff
 * records its own fulfilment the moment the room, the tasks and the advance are in order. The
 * guest table, the pre-arrival tasks, the advance and the guest's answer to the pre-arrival
 * message sit below, then the billing model as it was frozen, and the other ways out of Arrival:
 * they told us they're not coming, they never came, park, new dates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import {
  acceptHandoff,
  acknowledgeCreditCeilingTier2,
  buildH1FulfilmentEvidence,
  fulfilHandoff,
  getExpectedArrival,
  getHandoffChecklist,
  setExpectedArrival,
  type HandoffChecklistItem,
} from "@/lib/api/pre-arrival";
import { deriveRoomStatus, ROOM_STATUS } from "@/lib/desk/rooms";
import { s5Readiness } from "@/lib/desk/workspace";
import { fmtStamp, fmtTime, instantYmd, money, plural } from "@/lib/ds/format";
import { AdvanceSettlementBlock } from "@/components/desk/workspace/advance-settlement";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import type { EntryDetail } from "@/types/api";
import {
  AnswerLine,
  Choice,
  Fact,
  FactLine,
  Facts,
  Live,
  PapersCard,
  RequestsCard,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  currentPassStart,
  toastRefusal,
  useRefreshEntry,
  useStepMode,
  words,
  type FactState,
} from "./kit";
import { BILLING_CHOICES, billingWord } from "./s4-reserve";
import { BookingOtherWays } from "./s4-other-ways";
import { PreArrivalTasksCard } from "./s5-pre-arrival-tasks";
import { AssignRoomsCard, ROOMS_CARD_ID, roomReady, useRoomsCatalog } from "./s5-rooms";

type EntryScalars = { contactPersonName?: string | null; contactPersonPhone?: string | null };

const HANDOFF_WORD: Record<string, string> = {
  CREATED: "waiting to be accepted",
  ACCEPTED: "accepted — fulfilled once the room, the tasks and the advance are in order",
  FULFILLED: "fulfilled",
  REJECTED: "turned back",
  ESCALATED: "with the FOM",
  CANCELLED: "cancelled",
  CLOSED: "closed",
};

const ROLE_WORD: Record<string, string> = {
  RESERVATIONS: "Reservations",
  FRONT_DESK: "the front desk",
  FRONT_OFFICE: "the front office",
  HOUSEKEEPING: "housekeeping",
};
const roleWord = (r?: string | null) => (r ? ROLE_WORD[r] ?? words(r) : "—");

/** Everything the handoff and the "ready" card both read, worked out once. */
function useArrivalFacts(entry: EntryDetail) {
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio }).data;
  const assignments = entry.roomAssignments ?? [];
  const latest = assignments[0];
  const multi = (entry.numberOfRooms ?? 1) > 1;
  const readinessConfirmed = multi ? assignments.length > 0 && assignments.every((a) => roomReady(a)) : roomReady(latest);
  const reconciled = entry.folio?.advancePaymentReconciliationComplete === true;
  const paymentReconciled = reconciled || pay?.satisfied === true;
  const tasks = entry.preArrivalTasks ?? [];
  const tasksComplete = tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "WAIVED");
  // The gate's own reading of "near the frozen ceiling" (p44) — no figure is worked out here.
  const ceilingLine = s5Readiness(entry).find((l) => l.label === "Credit ceiling acknowledged");
  const hasCeiling = entry.reservation?.creditCeilingIfExtended != null;
  // Only when the gate says so (2026-09-18): an ACTIVE credit extension used to be enough, so a
  // booking whose balance was nowhere near the ceiling — or whose advance had since been paid in
  // full — showed "the balance is near the credit the FOM extended" as a missing item the gate
  // (and p44) did not require.
  const creditNeedsAck = hasCeiling && !entry.creditCeilingTier2AcknowledgedAt && ceilingLine?.met === false;
  return { pay, assignments, latest, readinessConfirmed, reconciled, paymentReconciled, tasks, tasksComplete, creditNeedsAck };
}

/* ------------------------------------------------------------------ the step */

export function S5Arrival({
  entry,
  past,
  onPark,
  guestPresent,
  setGuestPresent,
}: {
  entry: EntryDetail;
  past: boolean;
  onPark?: () => void;
  guestPresent: boolean;
  setGuestPresent: (v: boolean) => void;
}) {
  const facts = useArrivalFacts(entry);
  const [boardOpen, setBoardOpen] = useState(() => (entry.roomAssignments ?? []).length === 0);
  const since = currentPassStart(entry);
  const clock = useHotelClock(60_000);
  const openRooms = () => {
    setBoardOpen(true);
    requestAnimationFrame(() => document.getElementById(ROOMS_CARD_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <StepCanvas past={past}>
      <ReadyTheRoom entry={entry} facts={facts} guestPresent={guestPresent} setGuestPresent={setGuestPresent} onAssign={openRooms} />
      <AssignRoomsCard entry={entry} boardOpen={boardOpen} setBoardOpen={setBoardOpen} />
      <StepCard>
        <Tool>
          <IdentityProofBlock entry={entry} collapsible />
        </Tool>
      </StepCard>
      <FrontDeskHandoff entry={entry} facts={facts} />
      <PreArrivalTasksCard
        entry={entry}
        title="Pre-arrival tasks"
        meta="Opened by Reserve. The desk completes or waives its tasks here; the guest-details task ticks itself when the guest table is full."
        actionable="all"
        guestDetailsHint
        flow="tasks"
        flowAfter="rooms"
      />
      <AdvanceAndCredit entry={entry} facts={facts} />
      <StepCard title="Pre-arrival message · what they said">
        <AnswerLine entryId={entry.id} type="PRE_ARRIVAL_REMINDER" sinceIso={since} what="the pre-arrival message" tz={clock.tz} />
        <div className="meta" style={{ marginTop: 6 }}>
          Evidence only — check-in does not wait for it.
        </div>
      </StepCard>
      <BillingModelCard entry={entry} />
      <RequestsCard />
      <BookingOtherWays entry={entry} onPark={onPark} guestPresent={guestPresent} />
      <PapersCard entry={entry} />
    </StepCanvas>
  );
}

type Facts_ = ReturnType<typeof useArrivalFacts>;

/* ------------------------------------------------------------------ ready the room */

/**
 * When the guest is expected, and when they become a no-show (2026-09-18). The hotel's check-in
 * time unless the guest gave their own; the desk records theirs here and the cut-off follows it.
 * Once the cut-off has passed, a later time is recorded but nothing is reopened — that is the
 * FOM's reactivation. Every time shown is the server's own.
 */
function ExpectedArrivalFact({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const tz = clock.tz;
  const refresh = useRefreshEntry(entry.id);
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState("");
  const q = useQuery({
    queryKey: ["expected-arrival", entry.id],
    queryFn: () => getExpectedArrival(session!, entry.id),
    enabled: !!session,
  });
  const save = useMutation({
    mutationFn: (t: string | null) => setExpectedArrival(session!, entry.id, t),
    onSuccess: (r) => {
      toast.success(
        r.cutoffAlreadyReached
          ? "Arrival time recorded — the no-show cut-off had already passed; reopening the booking is the FOM's reactivation"
          : r.rearmedAt
            ? `Expected at ${fmtTime(r.at, tz)} — the no-show cut-off is now ${fmtTime(r.rearmedAt, tz)}`
            : `Expected at ${fmtTime(r.at, tz)}`,
      );
      setEditing(false);
      refresh([["expected-arrival", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The arrival time could not be saved"),
  });
  const d = q.data;
  const cutoff = d?.cutoffClockAt ?? d?.cutoffAt ?? null;
  // The time alone on the arrival day; with its day on any other (2026-09-18) — a booking opened
  // a week ahead read "2:00 PM · no-show cut-off 4:00 PM" with nothing saying which day.
  const today = instantYmd(clock.now, tz);
  const when = (v: string | null | undefined) => (v && instantYmd(v, tz) !== today ? fmtStamp(v, tz) : fmtTime(v, tz));
  return (
    <Fact k="Expected arrival">
      {!d ? (
        <span className="meta">reading…</span>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          <span>
            {when(d.at)}{" "}
            <span className="meta">
              · {d.source === "GUEST" ? "the guest's own time" : "the hotel's check-in time"}
              {cutoff ? ` · no-show cut-off ${when(cutoff)}` : ""}
            </span>
          </span>
          {d.cutoffReachedAt ? (
            <span className="sm warn-ink">
              The no-show cut-off has passed (recorded {fmtTime(d.cutoffReachedAt, tz)}) — the guest can still check in; a no-show is the FOM&rsquo;s decision.
            </span>
          ) : null}
          <Live>
            {editing ? (
              <div className="row-acts">
                <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: 140 }} />
                <Button
                  kind="secondary"
                  compact
                  state={save.isPending ? "working" : /^\d\d:\d\d$/.test(time) ? "default" : "inert"}
                  title={/^\d\d:\d\d$/.test(time) ? undefined : "put in the time the guest gave"}
                  workingLabel="Saving…"
                  onClick={() => save.mutate(time)}
                >
                  Save
                </Button>
                {d.guestTime ? (
                  <Button kind="quiet" compact onClick={() => save.mutate(null)}>
                    Use the hotel&rsquo;s time
                  </Button>
                ) : null}
                <Button kind="quiet" compact onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            ) : d.editable ? (
              <div>
                <Button
                  kind="quiet"
                  compact
                  onClick={() => {
                    setTime(d.guestTime ?? d.time);
                    setEditing(true);
                  }}
                >
                  {d.guestTime ? "Change the time" : "The guest gave a time…"}
                </Button>
              </div>
            ) : null}
          </Live>
        </div>
      )}
    </Fact>
  );
}

function ReadyTheRoom({
  entry,
  facts,
  guestPresent,
  setGuestPresent,
  onAssign,
}: {
  entry: EntryDetail;
  facts: Facts_;
  guestPresent: boolean;
  setGuestPresent: (v: boolean) => void;
  onAssign: () => void;
}) {
  const catalog = useRoomsCatalog().data?.items ?? [];
  const byId = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog]);
  const { pay, assignments, reconciled } = facts;
  const cur = entry.folio?.lines?.[0]?.currency ?? "BTN";
  const distinct = Array.from(new Map(assignments.map((a) => [a.roomId, a])).values());
  const numbers = distinct.map((a) => a.room?.roomNumber ?? byId.get(a.roomId)?.roomNumber ?? a.roomId.slice(0, 6)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const needed = entry.numberOfRooms ?? 1;
  const notReady = distinct.filter((a) => !roomReady(a));
  const contact = entry as EntryDetail & EntryScalars;
  const h1 = (entry.handoffs ?? []).find((h) => h.handoffType === "H1") ?? null;

  const advance = reconciled ? (
    <Chip tone="success" icon="check">
      reconciled
    </Chip>
  ) : !pay ? (
    <span className="meta">reading the payment position…</span>
  ) : pay.paidInFull ? (
    <Chip tone="warning">paid · not yet reconciled</Chip>
  ) : pay.satisfied ? (
    <Chip tone="warning">covered by credit · not yet reconciled</Chip>
  ) : pay.requiredAmount > 0 ? (
    <Chip tone="warning">not in</Chip>
  ) : (
    <Chip tone="warning">not yet reconciled</Chip>
  );

  return (
    <StepCard
      title="Ready the room"
      acts={
        <Live>
          <Button kind="secondary" compact onClick={onAssign}>
            Assign rooms
          </Button>
          {guestPresent ? (
            <>
              <Chip tone="success" icon="check">
                Guest is at the desk
              </Chip>
              <Button kind="quiet" compact onClick={() => setGuestPresent(false)}>
                Not yet
              </Button>
            </>
          ) : (
            <Button compact onClick={() => setGuestPresent(true)}>
              Guest is present
            </Button>
          )}
        </Live>
      }
    >
      <Facts wide>
        <Fact k="Rooms">
          {numbers.length ? (
            <>
              {numbers.join(", ")}{" "}
              <span className="meta">
                · assigned{numbers.length > 1 ? " together" : ""} · a claim on the rooms, no step moved
                {numbers.length < needed ? ` · ${needed - numbers.length} more needed` : ""}
              </span>
            </>
          ) : (
            <>
              <span className="dash">—</span> <span className="meta">not yet assigned · {plural(needed, "room")} needed</span>
            </>
          )}
        </Fact>
        <Fact k="Housekeeping">
          {distinct.length === 0 ? (
            <span className="meta">read from the rooms once they are assigned</span>
          ) : notReady.length === 0 ? (
            <>
              <Chip tone="success" icon="check">
                clean and ready
              </Chip>{" "}
              <span className="meta">housekeeping&rsquo;s word, from the room board — not ticked here</span>
            </>
          ) : (
            <>
              <Chip tone="warning">{notReady.length === distinct.length && distinct.length === 1 ? "not ready" : `${notReady.length} of ${distinct.length} not ready`}</Chip>{" "}
              <span className="meta">
                {notReady
                  .map((a) => {
                    const r = byId.get(a.roomId);
                    return `Room ${a.room?.roomNumber ?? r?.roomNumber ?? "?"}${r ? ` · ${ROOM_STATUS[deriveRoomStatus(r)].label.toLowerCase()}` : ""}`;
                  })
                  .join(" · ")}{" "}
                · housekeeping&rsquo;s to clear
              </span>
            </>
          )}
        </Fact>
        <Fact k="Advance">
          {advance}{" "}
          {pay && (pay.requiredAmount > 0 || pay.totalReceived > 0) ? (
            <span className="meta">
              {money(pay.totalReceived, cur)} received of {money(pay.requiredAmount, cur)}
            </span>
          ) : null}
        </Fact>
        <Fact k="Contact person">
          {contact.contactPersonName ? (
            `${contact.contactPersonName}${contact.contactPersonPhone ? ` · ${contact.contactPersonPhone}` : ""}`
          ) : (
            <>
              <span className="warn-ink">not on file</span> <span className="meta">· the move to Arrival asks for it</span>
            </>
          )}
        </Fact>
        <ExpectedArrivalFact entry={entry} />
        <Fact k="Front-desk handoff">
          {h1 ? (
            h1.state === "FULFILLED" ? (
              <Chip tone="success" icon="check">
                fulfilled
              </Chip>
            ) : (
              <Chip tone="warning">{h1.state === "CREATED" ? "to accept" : h1.state === "ACCEPTED" ? "accepted" : words(h1.state)}</Chip>
            )
          ) : (
            <span className="meta">none on record</span>
          )}
        </Fact>
        <Fact k="Registration form">
          <span className="meta">pre-filled from the record and signed at Check-in · BE-45</span>
        </Fact>
        <Fact k="Keys">
          <span className="meta">handed over per room at Check-in — not needed to leave Arrival</span>
        </Fact>
      </Facts>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the front-desk handoff */

function FrontDeskHandoff({ entry, facts }: { entry: EntryDetail; facts: Facts_ }) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const { past } = useStepMode();
  const h1 = (entry.handoffs ?? []).find((h) => h.handoffType === "H1") ?? null;
  const { latest, readinessConfirmed, paymentReconciled, tasksComplete, creditNeedsAck } = facts;

  const checklist = useQuery({
    queryKey: ["handoff-checklist", "H1"],
    queryFn: () => getHandoffChecklist(session!, "H1"),
    enabled: !!session && h1?.state === "CREATED",
  });
  const items = (checklist.data?.items ?? []) as HandoffChecklistItem[];
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const mandatoryDone = items.filter((i) => i.mandatory).every((i) => ticks[i.code] === true);
  const canAccept = h1?.state === "CREATED" && (items.length === 0 || mandatoryDone);
  const canFulfil = h1?.state === "ACCEPTED" && !!latest && readinessConfirmed && paymentReconciled && tasksComplete;

  const accept = useMutation({
    mutationFn: () => {
      const completion: Record<string, boolean> = {};
      for (const i of items) completion[i.code] = ticks[i.code] === true;
      return acceptHandoff(session!, h1!.id, completion);
    },
    onSuccess: () => {
      toast.success("The front-desk handoff is accepted");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be accepted"),
  });
  const evidence = () =>
    buildH1FulfilmentEvidence({
      roomAssignmentId: latest!.id,
      readinessConfirmed,
      paymentStatusConfirmed: paymentReconciled,
      ceilingProximityAddressed: !creditNeedsAck,
    });
  const fulfil = useMutation({
    mutationFn: () => fulfilHandoff(session!, h1!.id, evidence()),
    onSuccess: () => {
      toast.success("The front-desk handoff is fulfilled");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not be fulfilled"),
  });
  // It records itself the moment everything it needs is on record (2026-08-14 ruling): the
  // evidence is built from facts already recorded elsewhere, so a press would add nothing.
  // One attempt per visit — the button stays as the retry.
  const autoFulfil = useMutation({
    mutationFn: () =>
      fulfilHandoff(session!, h1!.id, {
        ...evidence(),
        autoRecorded: true,
        autoRecordedNote: "Recorded automatically when the room, tasks and advance were all in order.",
      }),
    onSuccess: () => {
      toast.success("The front-desk handoff recorded itself — the room, the tasks and the advance are in order");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The handoff could not record itself — press Record it fulfilled"),
  });
  const tried = useRef(false);
  useEffect(() => {
    if (past || !canFulfil || tried.current || autoFulfil.isPending || fulfil.isPending) return;
    tried.current = true;
    autoFulfil.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFulfil, past]);

  if (!h1) {
    return (
      <StepCard title="The front-desk handoff">
        <p className="meta">No handoff on record — it opens when the booking moves to Arrival.</p>
      </StepCard>
    );
  }

  const needs: Array<{ label: string; met: boolean; value: string }> = [
    { label: "A room assigned", met: !!latest, value: latest ? `Room ${latest.room?.roomNumber ?? "—"}` : "assign the rooms above" },
    { label: "Rooms ready", met: readinessConfirmed, value: readinessConfirmed ? "housekeeping has them clean" : "waiting on housekeeping" },
    { label: "Pre-arrival tasks", met: tasksComplete, value: tasksComplete ? "done or waived" : "some are still open — below" },
    { label: "Advance", met: paymentReconciled, value: paymentReconciled ? "in order" : "not yet reconciled — below" },
    { label: "Credit ceiling", met: !creditNeedsAck, value: creditNeedsAck ? "the FOM acknowledges it — below" : "nothing to acknowledge" },
  ];

  return (
    <StepCard
      flow="handoff"
      flowAfter="advance"
      title="The front-desk handoff"
      right={
        h1.state === "FULFILLED" ? (
          <Chip tone="success" icon="check">
            fulfilled
          </Chip>
        ) : (
          <Chip tone="warning">{h1.state === "CREATED" ? "to accept" : h1.state === "ACCEPTED" ? "accepted" : words(h1.state)}</Chip>
        )
      }
    >
      <div className="sm">
        {roleWord(h1.fromRole)} → {roleWord(h1.toRole)} · {HANDOFF_WORD[h1.state] ?? words(h1.state)}
      </div>
      <div className="meta">
        {[
          h1.acceptedAt ? `accepted ${fmtStamp(h1.acceptedAt, clock.tz)}` : null,
          h1.fulfilledAt ? `fulfilled ${fmtStamp(h1.fulfilledAt, clock.tz)}` : null,
          h1.slaDeadlineAt && h1.state !== "FULFILLED" ? `due ${fmtStamp(h1.slaDeadlineAt, clock.tz)}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || `opened ${fmtStamp((h1 as { createdAt?: string }).createdAt ?? h1.assignedAt, clock.tz)}`}
      </div>

      {h1.state === "CREATED" ? (
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {checklist.isLoading ? (
            <span className="meta">reading the checklist…</span>
          ) : items.length === 0 ? (
            <span className="meta">No checklist is set for this handoff.</span>
          ) : (
            items.map((i) => (
              <label key={i.code} className="sm" style={{ display: "flex", gap: 8, alignItems: "baseline", cursor: past ? "default" : "pointer" }}>
                <input type="checkbox" checked={ticks[i.code] === true} onChange={(e) => setTicks((p) => ({ ...p, [i.code]: e.target.checked }))} />
                <span>
                  {i.description ?? words(i.code)}
                  {i.mandatory ? <span className="meta"> · required</span> : null}
                </span>
              </label>
            ))
          )}
          <Live>
            <div className="row-acts">
              <Button
                compact
                state={accept.isPending ? "working" : canAccept ? "default" : "inert"}
                title={canAccept ? undefined : "tick every required item first"}
                workingLabel="Accepting…"
                onClick={() => accept.mutate()}
              >
                Accept the handoff
              </Button>
            </div>
          </Live>
        </div>
      ) : null}

      {h1.state === "ACCEPTED" ? (
        <div style={{ marginTop: 10 }}>
          {needs.map((n) => (
            <FactLine key={n.label} label={n.label} value={n.value} state={(n.met ? "on" : "missing") as FactState} />
          ))}
          <Live>
            <div className="row-acts" style={{ marginTop: 8, alignItems: "center" }}>
              <Button
                kind="secondary"
                compact
                state={fulfil.isPending || autoFulfil.isPending ? "working" : canFulfil ? "default" : "inert"}
                title={canFulfil ? undefined : "the lines above first"}
                workingLabel="Recording…"
                onClick={() => fulfil.mutate()}
              >
                Record it fulfilled
              </Button>
              <span className="meta">it records itself the moment every line above is on record — no need to come back up here</span>
            </div>
          </Live>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ advance and credit */

function AdvanceAndCredit({ entry, facts }: { entry: EntryDetail; facts: Facts_ }) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const fom = atLeast(session?.actorLevel, "L2");
  const ack = useMutation({
    mutationFn: () => acknowledgeCreditCeilingTier2(session!, entry.id),
    onSuccess: () => {
      toast.success("The credit ceiling is acknowledged");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The credit ceiling could not be acknowledged"),
  });
  const acked = entry.creditCeilingTier2AcknowledgedAt ?? null;
  return (
    <StepCard flow="advance">
      <Tool>
        <AdvanceSettlementBlock
          entry={entry}
          title="Advance and credit"
          intro="Settle the advance before the guest arrives: log any remainder they send, or have the FOM cover the gap so check-in isn't held up."
        />
      </Tool>
      {facts.creditNeedsAck ? (
        <FactLine
          label="Credit ceiling"
          value="the balance is near the credit the FOM extended — the FOM acknowledges it before check-in"
          state="missing"
          action={
            <Live>
              <Button
                kind="secondary"
                compact
                state={ack.isPending ? "working" : fom ? "default" : "inert"}
                title={fom ? undefined : "needs the FOM"}
                workingLabel="Saving…"
                onClick={() => ack.mutate()}
              >
                Acknowledge
              </Button>
            </Live>
          }
        />
      ) : acked ? (
        <FactLine label="Credit ceiling" value="acknowledged by the FOM" who={fmtStamp(acked, clock.tz)} state="on" />
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ billing model */

function BillingModelCard({ entry }: { entry: EntryDetail }) {
  const clock = useHotelClock(60_000);
  const model = entry.folio?.billingModel ?? entry.reservation?.frozenBillingModel ?? null;
  const known = BILLING_CHOICES.some(([v]) => v === model);
  const log = entry.folio?.billingModelTransitions ?? [];
  return (
    <StepCard title="Billing model">
      {known ? (
        <Choice options={BILLING_CHOICES} value={model as (typeof BILLING_CHOICES)[number][0]} disabled />
      ) : (
        <div className="sm">{model ? billingWord(model) : <span className="dash">—</span>}</div>
      )}
      {log
        .filter((l) => l.fromModel)
        .map((l) => (
          <div key={l.id} className="meta" style={{ marginTop: 6 }}>
            changed from {billingWord(l.fromModel)} to {billingWord(l.toModel)} · {fmtStamp(l.createdAt, clock.tz)}
          </div>
        ))}
      <div className="meta" style={{ marginTop: 6 }}>
        Set at Set up and frozen by Reserve. From Arrival it changes only through a new pass, with the FOM — and once an invoice
        exists, through the amended-invoice path.
      </div>
    </StepCard>
  );
}
