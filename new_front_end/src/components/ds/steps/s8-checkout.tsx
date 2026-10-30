"use client";

/**
 * Step 8 · Check-out — "settle up" (SS03 amendment O1–O5, prototype `stepCanvas[8]`).
 *
 * The order the desk works in (2026-10-30, the stage template): the keys back and every room
 * inspected → any damage found answered → the master bill reviewed and the bill settled → the tax
 * invoice issued and sent → the departure handed over. Each numbered section folds to its line once
 * its own act finishes it; the charges, the disputes and the way back to Stay open from the step line.
 * Taking payment is the last thing that cannot be taken back; it sits behind its dialog.
 *
 * Every figure is the backend's: the billing summary's buckets and totals, the folio's own
 * balance, the payment-status position. The desk compares a typed amount with the balance only
 * to say, before the click, the rule the backend will apply (partial settlement needs the FOM).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Icon, Refusal } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { useRoomInspections } from "@/hooks/use-room-inspections";
import { RoomInspectionGrid } from "./room-inspections";
import { DamageCard, useUnansweredDamage } from "./damage-card";
import {
  buildH4FulfilmentEvidence,
  fulfilHandoff,
  initiateSettlement,
  reEnterS8ToS7,
  recordKeyReturn,
  recordRoomInspection,
} from "@/lib/api/checkout";
import { getNightAuditRecord, openDispute } from "@/lib/api/in-stay";
import { recordCreditExtension } from "@/lib/api/reservation-setup";
import { openFolioDocumentPdf, openInvoicePdf } from "@/lib/api/documents";
import { deriveFinancials, effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDate, fmtDateTime, fmtStamp, money, plural } from "@/lib/ds/format";
import { PLAN_LABEL, dueLabel } from "@/components/desk/workspace/advance-settlement";
import { FolioLinesTable, spaceNamesFromAllocations } from "@/components/desk/workspace/folio-lines";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import type { EntryDetail } from "@/types/api";
import { sentWords } from "@/hooks/use-invoice-recipient";
import { OverpaidCard } from "./refund-card";
import {
  AnswerLine,
  ChangeBookingMenu,
  DsDialog,
  Fact,
  Facts,
  Live,
  PaperDrawer,
  ReasonDialog,
  SeeRow,
  StageActs,
  StepCanvas,
  StepCard,
  Tool,
  WorkPopup,
  atLeast,
  toastRefusal,
  useFinishWhenDone,
  useFinishWhenMet,
  useOpenAlsoWay,
  useRefreshEntry,
  useStepPane,
  words,
  type ChangeBookingItem,
  type PaperRef,
  OtherWaysTabs,
  InlineWay,
  NotNow,
  ShutWay,
  type StepPane,
} from "./kit";
import {
  BILLING_MODEL_WORD,
  BillByPart,
  DEFICIENCY_WORD,
  DisputesCard,
  FOLIO_STATE_WORD,
  HANDOFF_STATE_WORD,
  INVOICE_STATE_WORD,
  ON_ACCOUNT_MODELS,
  lastStayNight,
  useBilling,
  useBookedBy,
  useFolioIndex,
  SendToField,
  useIssueAndSend,
  useSendInvoice,
  useSendTo,
} from "./s8-parts";
import {
  PayerShares,
  ReferenceField,
  defaultSettleMethod,
  settleMethodsFor,
  sharesToSettle,
  useSettlementShares,
  type SettleMethod,
} from "./s8-shares";
import { Help } from "@/components/ds/help";
import { PayLaterNote } from "./s6-balance";
import { CorrectionDialog, CreditNoteDialog, PostChargeDialog } from "./s7-folio";

/* ------------------------------------------------------------------ vocabulary */

const H4_FLAGS = [
  ["RECORDED", "The fault is recorded"],
  ["NOT_APPLICABLE", "No fault on the room"],
  ["RESOLVED", "The fault was put right"],
  ["UNRESOLVED_AT_CHECKOUT", "The fault is still there"],
] as const;

const isSettled = (state?: string | null) => state === "SETTLED" || state === "OUTSTANDING";

function distinctRooms(entry: EntryDetail) {
  return Array.from(new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values())
    .map((a) => ({ roomId: a.roomId, roomNumber: a.room?.roomNumber ?? a.roomId.slice(0, 6), room: a.room }))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

/* ------------------------------------------------------------------ the step */

/**
 * Check-out's pane (2026-10-26, operator: "add this add or correct a charge as a tab in stage 8,
 * it can also show the folio table again in that tab"). The last-morning charges and corrections
 * have a tab of their own, the bill's lines above the form. Like Stay's, the pane is hidden,
 * never unmounted, so a half-typed charge survives a look at This step.
 */
export const S8_PANES: StepPane[] = [{ key: "charges", label: "Add a charge", cards: [] }];

export function S8CheckOut({
  entry,
  past,
  goToStep,
  pane = null,
}: {
  entry: EntryDetail;
  past: boolean;
  goToStep: (n: number) => void;
  /** Which view is open in the page — null is the step itself. */
  pane?: string | null;
}) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  const fom = atLeast(session?.actorLevel, "L2");
  const live = !past && entry.currentStage === "S8";
  const folio = entry.folio ?? null;
  const settled = isSettled(folio?.state);
  // The Stay step defaults its "for" to the folio tab opened; Check-out does the same.
  const [chargeTarget, setChargeTarget] = useState("");
  // Going back and raising a dispute open in the middle of the screen, from the step line (2026-10-30).
  const openWay = useOpenAlsoWay();
  const stepPane = useStepPane();
  const [disputesOpen, setDisputesOpen] = useState(false);

  // One way back from Check-out: to Stay. "Re-open to Negotiation" was taken off (2026-10-26) — the
  // guest is still in, and from Negotiation the booking could never reach Check-out again. A price is
  // put right here: a credit note, a correction, or a dispute.
  const backMutation = useMutation({
    mutationFn: (reason: string) => reEnterS8ToS7(session!, entry.id, entry.version, reason),
    onSuccess: () => {
      toast.success("Back at Stay — post the charge there");
      refresh();
      goToStep(7);
    },
    onError: (e) => toastRefusal(e, "The booking could not be taken back"),
  });

  const backForm = () => (
    <InlineWay
      render={() => (
        <ReasonDialog
          open
          onClose={() => undefined}
          title="Back to Stay"
          caseLines={[folio ? `the bill is ${FOLIO_STATE_WORD[folio.state] ?? words(folio.state)}` : "no bill"]}
          lead="The booking goes back to Stay so a missed charge can be posted there. The bill stays open; bring the booking back to Check-out when it is done."
          reasonLabel="Why · recorded on the booking"
          placeholder="minibar found after the bill was reviewed"
          confirmLabel="Back to Stay"
          busy={backMutation.isPending}
          onConfirm={(reason) => backMutation.mutate(reason)}
        />
      )}
    />
  );

  const chargeable = live && folio?.state === "LIVE";
  // A pane is hidden, never unmounted — see S8_PANES.
  const at = (k: string | null) => ((pane ?? null) === k ? undefined : true);

  return (
    <StepCanvas past={past}>
      <div className="pane" hidden={at(null)}>
        {past ? null : <CheckoutAttention entry={entry} onDisputes={() => setDisputesOpen(true)} />}
        <Departure entry={entry} live={live} />
        {/* A damage found is answered before the bill is settled (2026-10-26). */}
        <DamageCard entry={entry} live={live} />
        <MasterBill entry={entry} tz={clock.tz} onTab={setChargeTarget} onAddCharge={chargeable ? () => stepPane.open("charges") : undefined} />
        <HowSettled entry={entry} live={live} tz={clock.tz} onBackToStay={() => openWay("stay")} goToStep={goToStep} />
        <OverpaidCard entry={entry} live={live} />
        <Invoices entry={entry} live={live} tz={clock.tz} />
        <DepartureHandoff entry={entry} live={live} tz={clock.tz} />
      </div>

      {/* The disputes, from the step line — in a pop-up over the work column, the booking file clear. */}
      <WorkPopup open={disputesOpen} title="Disputes" onClose={() => setDisputesOpen(false)}>
        {(entry.disputes ?? []).length ? <DisputesCard entry={entry} tz={clock.tz} /> : <p className="meta">No dispute has been raised on this booking.</p>}
        {live && folio ? (
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button
              kind="secondary"
              onClick={() => {
                setDisputesOpen(false);
                openWay("dispute");
              }}
            >
              Raise a dispute
            </Button>
          </div>
        ) : null}
      </WorkPopup>

      <div className="pane" hidden={at("charges")}>
        <FolioTableCard entry={entry} onTab={setChargeTarget} chargeable={chargeable} target={chargeTarget} setTarget={setChargeTarget} />
      </div>

      {past ? null : (
        <CheckoutActs
          entry={entry}
          live={live}
          onCharges={() => stepPane.open("charges")}
          onDisputes={() => setDisputesOpen(true)}
          onBackToStay={() => openWay("stay")}
        />
      )}

      {/* Going back and raising a dispute open in the middle of the screen (2026-10-30). */}
      <OtherWaysTabs
        tabs={[
          live && !settled
            ? {
                key: "stay",
                label: "Back to Stay",
                inBar: false,
                content: fom ? backForm() : <ShutWay act="Back to Stay" why="Going back to Stay needs the FOM." />,
              }
            : null,
          live && folio
            ? { key: "dispute", label: "Raise a dispute", inBar: false, content: <InlineWay render={(done) => <RaiseDispute entry={entry} open onClose={done} />} /> }
            : null,
        ]}
      />
    </StepCanvas>
  );
}

/**
 * What needs doing from what opens on the step line — one line each, with the way to it
 * (2026-10-30): an open dispute holds the booking at Check-out.
 */
function CheckoutAttention({ entry, onDisputes }: { entry: EntryDetail; onDisputes: () => void }) {
  const open = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS").length;
  if (!open) return null;
  return (
    <div className="stay-attention">
      <div className="att stop" role="alert">
        <b>
          {open} open dispute{open === 1 ? "" : "s"} — the booking stays at Check-out until {open === 1 ? "it is" : "they are"} closed
        </b>
        <Button kind="secondary" onClick={onDisputes}>
          Disputes
        </Button>
      </div>
    </div>
  );
}

/**
 * The step line's right end at Check-out (2026-10-30): the charges and the disputes (Charges ▾, the
 * open disputes as a red count), and the way back to Stay (Change booking ▾, the FOM's — shut once
 * the bill is settled).
 */
function CheckoutActs({
  entry,
  live,
  onCharges,
  onDisputes,
  onBackToStay,
}: {
  entry: EntryDetail;
  live: boolean;
  onCharges: () => void;
  onDisputes: () => void;
  onBackToStay: () => void;
}) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const folio = entry.folio ?? null;
  const settled = isSettled(folio?.state);
  const openDisputes = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS").length;
  const chargeWhy = !folio
    ? "There is no bill on this booking"
    : settled
      ? "The bill is settled — a charge found now is posted on the Closed step, as a late charge"
      : folio.state !== "LIVE"
        ? "The bill is not open"
        : !live
          ? "Only while the booking is at Check-out"
          : undefined;
  const charges: ChangeBookingItem[] = [
    {
      key: "charge",
      label: "Add or correct a charge",
      note: "The bill's lines, and a charge found this morning — posted while the bill is open.",
      onSelect: chargeWhy ? undefined : onCharges,
      reason: chargeWhy,
    },
    {
      key: "disputes",
      label: openDisputes ? `Disputes · ${openDisputes} open` : "Disputes",
      note: "A charge the guest questions — raised, reviewed, closed. The booking stays at Check-out while one is open.",
      onSelect: onDisputes,
    },
  ];
  const backWhy = !live
    ? "Only while the booking is at Check-out"
    : settled
      ? "The bill is settled — a charge found now is posted on the Closed step"
      : !fom
        ? "The FOM's call"
        : undefined;
  const items: ChangeBookingItem[] = [
    {
      key: "stay",
      label: "Back to Stay",
      note: "The booking goes back to Stay so a missed charge can be posted there. The bill stays open.",
      onSelect: backWhy ? undefined : onBackToStay,
      reason: backWhy,
    },
  ];
  return (
    <StageActs>
      <ChangeBookingMenu
        label="Charges"
        items={charges}
        badge={openDisputes}
        badgeTitle={openDisputes ? `${openDisputes} open dispute${openDisputes === 1 ? "" : "s"} — the booking stays at Check-out until answered` : undefined}
      />
      <ChangeBookingMenu items={items} />
    </StageActs>
  );
}

/* ------------------------------------------------------------------ the last night's audit */

/**
 * Settlement refuses while the last night is unaudited, so the warning sits on the settle card
 * (2026-10-26 — "Is the folio complete?" is gone; Back to Stay lives in Other ways). The Stay
 * step reads the final night's audit with the same query key.
 */
function UnauditedLastNight({
  entry,
  live,
  onBackToStay,
  goToStep,
}: {
  entry: EntryDetail;
  live: boolean;
  onBackToStay: () => void;
  goToStep: (n: number) => void;
}) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const lastNight = useMemo(() => lastStayNight(effectiveCheckOutIso(entry)), [entry]);
  const audit = useQuery({
    queryKey: ["night-audit", lastNight],
    queryFn: () => getNightAuditRecord(session!, lastNight!),
    enabled: !!session && !!lastNight && live,
  });
  if (!live || !lastNight || !audit.isFetched || audit.data?.runStatus === "COMPLETE") return null;
  if (isSettled(entry.folio?.state)) return null;
  // A night posted for this booking alone counts, as settlement counts it (2026-09-25) — the Stay
  // step's nights card reads it the same way: the booking's room charge for that night is on the bill.
  if ((entry.folio?.lines ?? []).some((l) => l.lineType === "ROOM_CHARGE" && l.chargeDate?.slice(0, 10) === lastNight)) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <Refusal
        kind="state"
        message={`The last night (${fmtDate(lastNight)}) is not audited — the bill cannot be settled until it is.`}
        guidance={fom ? "Take the booking back to Stay and post the night there." : "The FOM takes the booking back to Stay to post the night."}
        actions={
          fom ? (
            <Button kind="secondary" compact onClick={onBackToStay}>
              Back to Stay
            </Button>
          ) : (
            <Button kind="quiet" compact onClick={() => goToStep(7)}>
              Look at the Stay step
            </Button>
          )
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ the departure handoff */

const capFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The H4 handoff, a card of its own (2026-10-26) — it was a box inside "Is the folio complete?". */
function DepartureHandoff({ entry, live, tz }: { entry: EntryDetail; live: boolean; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  // The entry payload lists handoffs newest first — the departure handoff is the newest H4.
  const h4 = (entry.handoffs ?? []).find((h) => h.handoffType === "H4") ?? null;
  const done = !!h4 && (h4.state === "FULFILLED" || h4.isAutoFulfilled === true);
  // The room's fault is asked ONCE, at the inspection (2026-10-26, operator: "isn't these the
  // same?"). The inspection's answer is the record the backend checks — a fault still there needs
  // what the inspector found — so the handoff carries it rather than asking again and possibly
  // disagreeing. One inspection per ROOM since 2026-10-26: the handoff waits for every room the
  // guest leaves, and the most serious answer across them stands.
  const inspQ = useRoomInspections(entry, !done);
  const inspRooms = inspQ.data?.rooms ?? [];
  const allIn = !!inspQ.data?.allRecorded;
  const SEVERITY = ["UNRESOLVED_AT_CHECKOUT", "RESOLVED", "NOT_APPLICABLE"];
  const rank = (f: string) => (SEVERITY.includes(f) ? SEVERITY.indexOf(f) : SEVERITY.length);
  const answers = inspRooms.map((r) => r.deficientFlagStatus).filter((f): f is string => !!f);
  const flag = allIn && answers.length ? [...answers].sort((a, b) => rank(a) - rank(b))[0] : null;
  const putOffRooms = inspRooms.filter((r) => r.state === "PUT_OFF").map((r) => r.roomNumber);
  const flagWords = flag ? (H4_FLAGS.find(([v]) => v === flag)?.[1] ?? words(flag)) : null;
  const many = inspRooms.length > 1;
  const finish = useFinishWhenDone("handoff");
  const fulfil = useMutation({
    mutationFn: () => {
      if (!flag) throw new Error(many ? "Inspect every room first — their answer is the handoff's" : "Record the inspection first — its answer is the handoff's");
      return fulfilHandoff(session!, h4!.id, buildH4FulfilmentEvidence(flag));
    },
    onSuccess: () => {
      toast.success("The departure handoff is done");
      refresh();
      finish();
    },
    onError: (e) => toastRefusal(e, "The departure handoff could not be completed"),
  });
  const doneAt = h4?.fulfilledAt ?? null;
  const reason = !live
    ? "only while the booking is at Check-out"
    : !flag
      ? many
        ? "inspect every room in The keys and the rooms first"
        : "record the inspection in The keys and the rooms first"
      : undefined;

  return (
    <StepCard
      flow="handoff"
      title="The departure handoff"
      summary={`Done${doneAt ? ` · ${fmtStamp(doneAt, tz)}` : ""}${h4?.isAutoFulfilled ? " · recorded by itself" : ""}`}
      status={
        done ? (
          <span className="ok-ink">
            Done{doneAt ? ` · ${fmtStamp(doneAt, tz)}` : ""}
            {h4?.isAutoFulfilled ? " · recorded by itself, a same-day departure" : ""}
          </span>
        ) : h4 ? (
          <span className="warn-ink">
            {flag
              ? `${capFirst(HANDOFF_STATE_WORD[h4.state] ?? words(h4.state))} — ready to mark done`
              : many
                ? `Waiting for every room's inspection — ${inspQ.data?.inspectedCount ?? 0} of ${inspRooms.length} done`
                : "Waiting for the room's inspection — its answer is carried here"}
          </span>
        ) : (
          <span className="warn-ink">Not raised — it is raised when the booking leaves Stay</span>
        )
      }
      meta="Charges posted, every room inspected or put off, any damage assessed — the last check before the booking closes. The fault is the inspections' own answer: the most serious one across the rooms."
    >
      {h4 && !done ? (
        <div className="row-acts" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <span className="sm">
            {flagWords ? (
              <>
                {many ? <>The rooms&rsquo; fault, from the inspections: </> : <>The room&rsquo;s fault, from the inspection: </>}
                <b>{flagWords}</b>
                {putOffRooms.length ? (
                  <span className="meta">
                    {" "}
                    · put off to after departure{many ? `: Room ${putOffRooms.join(", ")}` : ""}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="warn-ink">The inspection is not recorded yet.</span>
            )}
          </span>
          <Button
            className={reason ? undefined : "go"}
            state={fulfil.isPending ? "working" : reason ? "inert" : "default"}
            title={reason}
            workingLabel="Recording…"
            onClick={() => fulfil.mutate()}
          >
            Mark the handoff done
          </Button>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the master bill */

/** The bill's lines, its room / space tabs and their server-summed footers — shown on the master
 * bill and again on the Add a charge tab. A tab opened here becomes the next charge's "For". */
export function BillLines({ entry, onTab }: { entry: EntryDetail; onTab: (target: string) => void }) {
  const billing = useBilling(entry);
  const fo = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  const roomNumberById = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  return (
    <Tool inert={false}>
      <FolioLinesTable
        lines={entry.folio?.lines ?? []}
        roomNumberById={roomNumberById}
        perRoomCharges={fo?.perRoomCharges ?? null}
        perSpaceCharges={fo?.perSpaceCharges ?? null}
        spaceNameById={spaceNamesFromAllocations(entry.spaceAllocations)}
        unassignedCharges={fo?.unassignedCharges ?? null}
        chargeBreakdown={fo?.chargeBreakdown ?? null}
        balance={fo?.outstandingBalance ?? entry.folio?.outstandingBalance ?? null}
        currency={cur}
        emptyText="No charges on this bill"
        onTabChange={(t) => onTab(typeof t === "string" ? "" : "spaceId" in t ? `space:${t.spaceId}` : `room:${t.roomId}`)}
      />
    </Tool>
  );
}

type BillFolio = NonNullable<NonNullable<ReturnType<typeof useBilling>["data"]>["folio"]>;

/** Billed · received · still owed, read across the desk ("UIappeal", 2026-10-26). Every figure is
 * the billing summary's; the "still owed" cell takes its colour from the balance it shows. */
export function BillFigures({ fo, cur }: { fo: BillFolio | null; cur: string }) {
  if (!fo) return null;
  const owed = Number(fo.outstandingBalance);
  const tone = owed > 0 ? "due" : owed < 0 ? "over" : "clear";
  const owedLabel = owed > 0 ? "Still owed" : owed < 0 ? "Paid over the bill" : "Nothing owed";
  return (
    <div className="bill-band" role="group" aria-label="The bill's figures">
      <div className="bb-cell">
        <span className="bb-k">Billed</span>
        <span className="bb-v money">{money(fo.billedSoFar, cur)}</span>
      </div>
      <div className="bb-cell">
        <span className="bb-k">Received</span>
        <span className="bb-v money">{money(fo.paymentsReceived, cur)}</span>
      </div>
      {fo.refunded != null && Number(fo.refunded) !== 0 ? (
        <div className="bb-cell">
          <span className="bb-k">Refunded</span>
          <span className="bb-v money">{money(fo.refunded, cur)}</span>
        </div>
      ) : null}
      {fo.writtenOff != null && Number(fo.writtenOff) !== 0 ? (
        <div className="bb-cell">
          <span className="bb-k">Written off</span>
          <span className="bb-v money">{money(fo.writtenOff, cur)}</span>
        </div>
      ) : null}
      <div className={`bb-cell owed ${tone}`} role={owed > 0 ? "status" : undefined}>
        <span className="bb-k">{owedLabel}</span>
        <span className="bb-v money">{money(fo.outstandingBalance, cur)}</span>
      </div>
    </div>
  );
}

/**
 * The folio again, on the Add a charge tab — so a charge is posted with the bill in view. Its acts
 * are Stay's (2026-10-30, operator: "post charge and correct charge to be made into buttons like
 * this in stage 7, after clicking showing pop up"): Post a charge, Correct a charge and the FOM's
 * credit note, each in its own pop-up — the same forms, so the two steps cannot word them apart.
 */
function FolioTableCard({
  entry,
  onTab,
  chargeable,
  target,
  setTarget,
}: {
  entry: EntryDetail;
  onTab: (target: string) => void;
  /** The bill is open at Check-out — a charge can still go on it. */
  chargeable: boolean;
  target: string;
  setTarget: (v: string) => void;
}) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const billing = useBilling(entry);
  const fo = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  const folio = entry.folio ?? null;
  const [open, setOpen] = useState<null | "post" | "correct" | "credit">(null);
  const shut = !folio
    ? "There is no bill on this booking."
    : isSettled(folio.state)
      ? "The bill is settled — a charge found now is posted on the Closed step, as a late charge."
      : folio.state !== "LIVE"
        ? `The bill is ${FOLIO_STATE_WORD[folio.state] ?? words(folio.state)} — charges can be added only while it is open.`
        : null;
  return (
    <StepCard
      title="The folio"
      status={shut ? <span className="warn-ink">{shut}</span> : fo ? `${plural(fo.lineCount, "line")} on the bill` : undefined}
      meta="A charge on the bill is never edited — a correction adds a line beside it that puts it right, and its service charge and GST move with it."
    >
      <BillFigures fo={fo} cur={cur} />
      <div style={{ marginTop: 12 }}>
        <BillLines entry={entry} onTab={onTab} />
      </div>
      {folio ? (
        <Live>
          <div className="folio-acts">
            <Button className={chargeable ? "go" : undefined} icon="pen" state={chargeable ? "default" : "inert"} reason={shut ?? undefined} onClick={() => setOpen("post")}>
              Post a charge
            </Button>
            <Button kind="secondary" state={chargeable ? "default" : "inert"} title={shut ?? undefined} onClick={() => setOpen("correct")}>
              Correct a charge
            </Button>
            <Button
              kind="secondary"
              state={chargeable && fom ? "default" : "inert"}
              reason={fom ? undefined : "a credit note is the FOM's"}
              title={shut ?? undefined}
              onClick={() => setOpen("credit")}
            >
              Credit note
            </Button>
          </div>
          <PostChargeDialog entry={entry} open={open === "post"} onClose={() => setOpen(null)} target={target} setTarget={setTarget} />
          <CorrectionDialog entry={entry} open={open === "correct"} onClose={() => setOpen(null)} />
          <CreditNoteDialog entry={entry} open={open === "credit"} onClose={() => setOpen(null)} />
        </Live>
      ) : null}
    </StepCard>
  );
}

function MasterBill({
  entry,
  tz,
  onTab,
  onAddCharge,
}: {
  entry: EntryDetail;
  tz: string;
  onTab: (target: string) => void;
  /** Opens the Add a charge tab — only while the bill is open at Check-out. */
  onAddCharge?: () => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const billing = useBilling(entry);
  const index = useFolioIndex(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  // The lines wait for "Show the lines" (2026-10-30, operator).
  const [showLines, setShowLines] = useState(false);
  const doc = index.data?.documents.find((d) => d.kind === "master-bill") ?? null;
  const fo = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  const frozen = doc?.state === "FROZEN";
  const print = () => {
    if (!session) return;
    openFolioDocumentPdf(session, entry.id, "master-bill")
      .then(() => refresh())
      .catch((e) => toastRefusal(e, "The master bill could not be printed"));
  };
  // The facts stay on screen; what the paper is goes behind the card's "?".
  const status = frozen
    ? `Frozen when the bill was settled${doc?.frozenAt ? `, ${fmtStamp(doc.frozenAt, tz)}` : ""}${doc?.reprintCount != null ? ` · printed ${plural(doc.reprintCount, "time")}` : ""}`
    : `As at ${index.data ? fmtStamp(index.data.asAt, tz) : "now"}`;
  const meta = "A statement — not a tax invoice.";

  return (
    <StepCard
      title="Master bill · reviewed with the guest"
      meta={meta}
      status={status}
      acts={
        <>
          <Button
            kind="secondary"
            compact
            icon="eye"
            state={doc?.available ? "default" : "inert"}
            title={doc?.available ? undefined : doc?.unavailableReason ?? "the master bill is not available yet"}
            onClick={() => setPaper({ kind: "folio", entryId: entry.id, doc: "master-bill", label: "Master bill", refreshKey: `${entry.updatedAt}|${index.data?.asAt ?? ""}` })}
          >
            Preview
          </Button>
          <Button
            kind="quiet"
            compact
            icon="print"
            state={doc?.available ? "default" : "inert"}
            title={doc?.available ? undefined : doc?.unavailableReason ?? "the master bill is not available yet"}
            onClick={print}
          >
            {frozen ? "Print a copy" : "Print master bill"}
          </Button>
          {onAddCharge ? (
            <Button kind="secondary" compact onClick={onAddCharge}>
              Add or correct a charge
            </Button>
          ) : null}
          <Help label="About the master bill">What a guest gets who wants paper before paying, or who pays nothing here.</Help>
        </>
      }
    >
      <BillByPart billing={billing.data} loading={billing.isLoading} />
      <BillFigures fo={fo} cur={cur} />
      <div className="bill-lines-row">
        <span className="bl-n">{fo ? `${plural(fo.lineCount, "line")} on the bill` : "—"}</span>
        <Button kind="quiet" compact onClick={() => setShowLines((v) => !v)}>
          {showLines ? "Hide the lines" : "Show the lines"}
        </Button>
      </div>
      {showLines ? <BillLines entry={entry} onTab={onTab} /> : null}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ how the bill is settled */

function HowSettled({
  entry,
  live,
  tz,
  onBackToStay,
  goToStep,
}: {
  entry: EntryDetail;
  live: boolean;
  tz: string;
  onBackToStay: () => void;
  goToStep: (n: number) => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const fom = atLeast(session?.actorLevel, "L2");
  const folio = entry.folio ?? null;
  const pay = usePaymentStatus(entry.id, { enabled: !!folio });
  const billing = useBilling(entry);
  const fin = deriveFinancials(entry, { paymentStatus: pay.data });
  const booked = useBookedBy(entry);
  const cur = billing.data?.currency ?? fin.currency;
  const balance = fin.outstanding;
  const settled = isSettled(folio?.state);
  // The bill's own balance says whether anything is left — the state alone can read OUTSTANDING at zero.
  const stillOwed = folio?.state === "OUTSTANDING" && balance != null && Number(balance) > 0;
  const folioLive = folio?.state === "LIVE";
  const ps = pay.data;
  const creditActive = !!ps?.creditExtensionActive;
  const creditExpired = !!ps?.creditExtensionExpired && !creditActive;
  const [byPart, setByPart] = useState(false);
  // The bill waits for every damage found to have an answer (Policy 81, 2026-10-26).
  const damage = useUnansweredDamage(entry);
  const damageWhy = damage.unanswered.length
    ? `answer the damage found in ${damage.unanswered.length > 1 ? `Rooms ${damage.unanswered.join(", ")}` : `Room ${damage.unanswered[0]}`} first`
    : undefined;

  // More than one payer still to settle → the bill settles share by share (2026-09-18).
  const sharesQ = useSettlementShares(entry, !!folio);
  const shares = sharesToSettle(sharesQ.data?.buckets, folio?.state);

  const model0 = folio?.billingModel ?? null;
  const [method, setMethodRaw] = useState<SettleMethod>(defaultSettleMethod(model0));
  // The default follows the billing model until the operator picks — never over a choice.
  const methodTouched = useRef(false);
  useEffect(() => {
    if (!methodTouched.current) setMethodRaw(defaultSettleMethod(model0));
  }, [model0]);
  const setMethod = (m: SettleMethod) => {
    methodTouched.current = true;
    setMethodRaw(m);
  };
  const [ref, setRef] = useState("");
  const [paidNow, setPaidNow] = useState("");
  // What the agency's voucher covers — starts at the whole balance (the voucher usually covers
  // the stay); what it leaves is invoiced to the agency.
  const [voucherCovers, setVoucherCovers] = useState("");
  const voucherTouched = useRef(false);
  useEffect(() => {
    if (voucherTouched.current) return;
    if (balance != null && balance > 0) setVoucherCovers(String(balance));
  }, [balance]);
  const [invoiceTo, setInvoiceTo] = useSendTo(entry);
  const [fomAck, setFomAck] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The amount starts at the whole balance (the common case); typing a smaller figure makes the
  // settlement partial. Latched on the first keystroke so a refetch never overwrites it.
  const paidTouched = useRef(false);
  useEffect(() => {
    if (paidTouched.current) return;
    if (balance != null && balance > 0) setPaidNow(String(balance));
  }, [balance]);

  const [ceiling, setCeiling] = useState("");
  const ceilingTouched = useRef(false);
  useEffect(() => {
    if (ceilingTouched.current) return;
    if (balance != null && balance > 0) setCeiling(String(balance));
  }, [balance]);
  const [creditWhy, setCreditWhy] = useState("");
  const [creditOpen, setCreditOpen] = useState(false);
  const [payWithin, setPayWithin] = useState("");

  // The backend's partial-settlement rule, said before the click (it enforces it regardless):
  // a guest-pay settlement that leaves part of the balance unpaid needs the FOM, or a credit
  // extension on file that covers what is left. Comparisons against server figures only —
  // nothing derived here is ever shown.
  const balanceNum = balance ?? 0;
  const typed = paidNow.trim() === "" ? Number.NaN : Number.parseFloat(paidNow);
  const guestPays = method !== "DIRECT_BILL" && method !== "VOUCHER";
  const partial = guestPays && Number.isFinite(typed) && typed >= 0 && balanceNum > 0 && typed < balanceNum;
  const creditCovers = partial && creditActive && ps?.ceilingAmount != null && ps.ceilingAmount >= balanceNum - typed;
  const partialLocked = partial && !fom && !creditCovers;
  // The FOM's sign-off is asked only where the backend asks for it (Policy 46): the booking was
  // reserved on the FOM's credit for an advance still not paid in full, the balance is now above
  // that credit, and nobody signed it off at Arrival. Server figures compared, nothing shown derived.
  const ceilingRaw = entry.reservation?.creditCeilingIfExtended;
  const ceilingNum = ceilingRaw == null ? null : Number(ceilingRaw);
  const overCeiling =
    ceilingNum != null &&
    Number.isFinite(ceilingNum) &&
    ceilingNum > 0 &&
    ps?.paidInFull !== true &&
    balanceNum > ceilingNum &&
    !entry.creditCeilingTier2AcknowledgedAt;

  const voucherTyped = voucherCovers.trim() === "" ? Number.NaN : Number.parseFloat(voucherCovers);
  const voucherValid = Number.isFinite(voucherTyped) && voucherTyped >= 0;
  const invoicesParty = method === "DIRECT_BILL" || method === "VOUCHER";

  const finish = useFinishWhenDone("settle");
  const settle = useMutation({
    mutationFn: () => {
      if (!folio?.id || !folio.billingModel) throw new Error("The bill or its billing model is missing");
      const body: Parameters<typeof initiateSettlement>[2] = { settlementMethod: method, billingModelConfirmation: folio.billingModel };
      if (ref.trim() && method !== "DIRECT_BILL") body.paymentVerificationRef = ref.trim();
      if (method === "VOUCHER") {
        // The backend requires what the voucher covers; anything it leaves is invoiced to the agency.
        if (voucherValid) body.voucherAmount = voucherTyped;
      } else if (guestPays && paidNow.trim() !== "" && Number.isFinite(typed) && typed >= 0) {
        // Zero is a real answer: the guest pays nothing now and the balance leaves on credit.
        // Empty means the full balance. A direct bill takes no money at the desk.
        body.partialAmount = typed;
      }
      if (invoicesParty && invoiceTo.trim()) body.invoiceDispatchedTo = invoiceTo.trim();
      if (fomAck.trim()) body.fomAcknowledgementRef = fomAck.trim();
      return initiateSettlement(session!, folio.id, body);
    },
    onSuccess: () => {
      setConfirmOpen(false);
      toast.success(
        partial
          ? "Settled in part — the rest stays owed and is collected after the stay; the rooms are released"
          : method === "DIRECT_BILL"
            ? `Settled — the balance is invoiced to ${booked.payer}; the tax invoice is below`
            : method === "VOUCHER"
              ? `Settled — the voucher is recorded; anything it leaves is invoiced to ${booked.payer}`
              : "Settled — the bill is closed and the rooms go to housekeeping",
      );
      refresh([["settlement-targets"]]);
      finish();
    },
    onError: (e) => toastRefusal(e, "The settlement did not go through"),
  });
  const creditExt = useMutation({
    mutationFn: () => {
      const days = Number.parseFloat(payWithin);
      const body: Parameters<typeof recordCreditExtension>[2] = { ceilingAmount: Number(ceiling), reason: creditWhy.trim() };
      if (payWithin.trim() !== "" && Number.isFinite(days) && days > 0) body.validForHours = days * 24;
      return recordCreditExtension(session!, entry.id, body);
    },
    onSuccess: () => {
      setCreditOpen(false);
      toast.success("Credit extension approved — a part-payment within it can now be settled");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The credit extension was not recorded"),
  });

  const plan = ps?.paymentPlan ?? null;
  const planShort = !!plan && ps?.paidInFull === false;
  const model = folio?.billingModel ?? null;
  const chargedToAccount = !!model && ON_ACCOUNT_MODELS.has(model);
  const guest = booked.guest;

  const methods = settleMethodsFor(model, booked.kind === "Travel agent", !!booked.party);
  // Cash and QR carry a reference whenever money is taken — the backend refuses them without one.
  // Empty "paid now" means the whole balance — which takes nothing when the balance is zero.
  const takesMoney = guestPays && (Number.isFinite(typed) ? typed > 0 : balanceNum > 0);
  const settleReason = !folioLive
    ? "the bill must be live to settle"
    : damageWhy
      ? damageWhy
      : partialLocked
      ? "a part-payment needs the FOM or a credit extension"
      : !folio?.billingModel
        ? "the bill has no billing model"
        : method === "VOUCHER" && !voucherValid
          ? "put in what the voucher covers"
          : !methods.some(([v]) => v === method)
            ? "this billing model does not settle that way"
            : (method === "CASH" || method === "MOBILE_PAYMENT") && takesMoney && !ref.trim()
              ? "cash and QR need a payment reference"
              : overCeiling && !fom
                ? "the balance is above the credit the FOM allowed — the FOM settles this one"
                : overCeiling && !fomAck.trim()
                  ? "the balance is above the credit allowed — write the FOM's sign-off"
                  : undefined;

  return (
    <StepCard
      flow="settle"
      title="How the bill is settled"
      meta="One bill by the model; part by part when each room or hall pays its own; free to change until the bill is settled — after that, the tax invoice decides."
      summary={
        stillOwed
          ? `Settled in part · ${money(balance, cur)} still owed, collected after the stay`
          : `Settled${folio?.closedAt ? ` · the bill closed ${fmtStamp(folio.closedAt, tz)}` : ""} · the rooms released`
      }
    >
      <UnauditedLastNight entry={entry} live={live} onBackToStay={onBackToStay} goToStep={goToStep} />
      <PayLaterNote entry={entry} at="checkout" />
      <div className="row-acts">
        <Chip tone="accent">by the billing model · {model ? BILLING_MODEL_WORD[model] ?? words(model) : "not set"}</Chip>
        {entry.groupBillingMode === "GROUP_MASTER" ? <Chip tone="quiet">one bill for the party</Chip> : null}
        {folio ? (
          <SeeRow
            label="Settle part by part"
            note="each room or space pays its own part — the money is filed against it; the bill stays one"
            onClick={() => setByPart(true)}
          />
        ) : null}
        <Live>
          <SeeRow
            label="Settle by proportion"
            note="whatever split was agreed — 60 / 40 — each invoice its share of everything"
            reason="Not possible yet — use Settle part by part instead"
            notYet
          />
        </Live>
      </div>

      {planShort && plan ? (
        <div className="notice inert" style={{ marginTop: 10 }}>
          <span className="sm">
            The guest&rsquo;s advance plan was <b>{PLAN_LABEL[plan.plan] ?? words(plan.plan)}</b>
            {plan.balanceDueAt ? ` · ${dueLabel(plan.plan, plan.balanceDueAt)}` : ""} — the advance is still short <b className="money">{money(ps?.shortfall, cur)}</b>. The unpaid part is inside the balance below; settling collects it with the rest.
          </span>
        </div>
      ) : null}

      {/* In a pop-up over the work column (2026-10-30, operator: "settle part by part can show a pop up"). */}
      {folio ? (
        <WorkPopup open={byPart} title="Settle part by part" onClose={() => setByPart(false)}>
          <Tool>
            <SplitSettlementBlock entry={entry} folioId={folio.id} unfolded />
          </Tool>
        </WorkPopup>
      ) : null}

      {!folio ? (
        <p className="meta" style={{ marginTop: 10 }}>
          There is no bill on this booking.
        </p>
      ) : shares ? (
        <PayerShares entry={entry} shares={shares} live={live} currency={cur} onSettled={() => finish()} />
      ) : settled ? (
        <div className="bind bound" style={{ marginTop: 12 }}>
          {/* an OUTSTANDING bill with nothing left on it (an import, a later payment) reads as settled */}
          <span className="state">
            <Icon name="lock" />
            in force
          </span>
          <div className="sm">
            <b>{stillOwed ? "Settled in part — the rest is still owed" : "Settled"}</b>
            {folio.closedAt ? <span className="meta"> · the bill closed {fmtStamp(folio.closedAt, tz)}</span> : null}
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            {stillOwed
              ? `Still owed ${money(balance, cur)} — collected after the stay, at Closed.`
              : "Issue and send the tax invoice below; the master bill above is frozen and prints as a copy."}
          </div>
          {folio.state === "OUTSTANDING" && ps?.creditExtensionActive ? (
            <div className="meta">
              Credit extended — up to {money(ps.ceilingAmount, cur)}
              {ps.creditExtensionExpiresAt ? ` · pay by ${fmtDateTime(ps.creditExtensionExpiresAt, tz)}` : " · no time limit"}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <Facts wide style={{ marginTop: 12 }}>
            <Fact k="Billed so far">
              {billing.data?.folio?.chargeBreakdown ? (
                <>
                  <b className="money">{money(billing.data.folio.chargeBreakdown.total, cur)}</b>
                  <span className="meta">
                    {" "}
                    · charges {money(billing.data.folio.chargeBreakdown.base, cur)} · service charge {money(billing.data.folio.chargeBreakdown.serviceCharge, cur)} · GST{" "}
                    {money(billing.data.folio.chargeBreakdown.gst, cur)}
                  </span>
                </>
              ) : null}
            </Fact>
            <Fact k="Received">{fin.advanceReceived != null ? <span className="money">{money(fin.advanceReceived, cur)}</span> : null}</Fact>
            <Fact k="Still owed">{balance != null ? <b className="money">{money(balance, cur)}</b> : null}</Fact>
            {chargedToAccount ? <Fact k="The guest">pays nothing at the desk — the balance is invoiced to {booked.payer}</Fact> : null}
          </Facts>

          {creditActive ? (
            <div className="notice inert" style={{ marginTop: 10 }}>
              <span className="sm">
                Credit extension on file — covers up to <b className="money">{money(ps?.ceilingAmount, cur)}</b>
                {ps?.creditExtensionExpiresAt ? <> · pay by <b>{fmtDateTime(ps.creditExtensionExpiresAt, tz)}</b></> : " · no time limit"}. A part-payment within it can be
                settled at any desk; the rest is collected after the stay.
              </span>
            </div>
          ) : null}
          {creditExpired ? (
            <p className="sm warn-ink" style={{ marginTop: 8 }}>
              The credit extension on file has run out — it no longer covers a part-payment. The FOM approves it again (Change the credit extension), or settles it.
            </p>
          ) : null}

          <Live>
            {/* How they pay · the reference · the amount, in one line (2026-10-30, operator). */}
            <div className="form3 settle-row" style={{ marginTop: 12 }}>
              <div className="field">
                <label>
                  How they pay
                  {model === "DIRECT_BILL" ? (
                    <Help label="About a direct bill">A direct-bill stay settles only by invoicing {booked.payer}.</Help>
                  ) : null}
                </label>
                <select className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                  {methods.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              {method === "DIRECT_BILL" ? (
                <SendToField entry={entry} value={invoiceTo} onChange={setInvoiceTo} label="Send the invoice to" />
              ) : (
                <ReferenceField method={method} value={ref} onChange={setRef} takesMoney={takesMoney} />
              )}
              {method === "VOUCHER" ? (
                <div className="field">
                  <label>
                    The voucher covers · Nu.
                    <Help label="About the voucher">Anything it leaves of the {money(balance, cur)} balance is invoiced to {booked.payer}.</Help>
                  </label>
                  <input
                    className="input money"
                    inputMode="decimal"
                    value={voucherCovers}
                    onChange={(e) => {
                      voucherTouched.current = true;
                      setVoucherCovers(e.target.value);
                    }}
                  />
                </div>
              ) : method === "DIRECT_BILL" ? null : (
                <div className="field">
                  <label>Paid now · Nu.</label>
                  <input
                    className="input money"
                    inputMode="decimal"
                    value={paidNow}
                    placeholder="empty = the full balance"
                    onChange={(e) => {
                      paidTouched.current = true;
                      setPaidNow(e.target.value);
                    }}
                  />
                  {partial ? (
                    <span className="hint warn-ink">less than the {money(balance, cur)} balance — the rest stays owed, collected after the stay</span>
                  ) : null}
                </div>
              )}
            </div>
            {method === "VOUCHER" || (overCeiling && fom) ? (
            <div className="form2 settle-row" style={{ marginTop: 10 }}>
              {method === "VOUCHER" ? <SendToField entry={entry} value={invoiceTo} onChange={setInvoiceTo} label="Send the invoice to" /> : null}
              {overCeiling && fom ? (
                <div className="field">
                  <label>
                    FOM&rsquo;s sign-off · the balance is above the credit allowed
                    <Help label="About the sign-off">
                      The booking was reserved on the FOM&rsquo;s credit, the advance was never paid in full, and the balance is now above that credit. Write a reference for the sign-off — it is kept on the settlement.
                    </Help>
                  </label>
                  <input className="input" value={fomAck} placeholder="e.g. approved by the FOM on the phone" onChange={(e) => setFomAck(e.target.value)} />
                  <span className="hint warn-ink">
                    Balance {money(balance, cur)} · credit allowed {money(ceilingNum, cur)}
                  </span>
                </div>
              ) : null}
            </div>
            ) : null}
            {partialLocked ? (
              <div style={{ marginTop: 10 }}>
                <Refusal
                  kind="authority"
                  message={`Leaving part of the ${money(balance, cur)} balance unpaid needs the FOM.`}
                  guidance={`The FOM settles it, or records a credit extension that covers what is left${creditExpired ? " — the one on file has run out" : creditActive ? " — the one on file does not cover it" : ""}.`}
                />
              </div>
            ) : null}
            <div className="row-acts" style={{ marginTop: 12 }}>
              <Button
                className={live && !settleReason ? "go" : undefined}
                icon="lock"
                state={live && !settleReason ? "default" : "inert"}
                reason={live ? settleReason : "only while the booking is at Check-out"}
                onClick={() => setConfirmOpen(true)}
              >
                Take payment &amp; settle
              </Button>
              {fom ? (
                <Button kind="secondary" state={live ? "default" : "inert"} onClick={() => setCreditOpen(true)}>
                  {creditActive || creditExpired ? "Change the credit extension" : "Let the guest leave owing"}
                </Button>
              ) : null}
            </div>

            {/* The FOM's credit extension, in a pop-up (2026-10-30, operator: "credit extension to be made
                into a button, when clicked, it should show a pop up"). */}
            <DsDialog
              open={creditOpen}
              onClose={() => setCreditOpen(false)}
              title="Let the guest leave owing — a credit extension"
              caseLines={[<b key="g">{guest}</b>, `${entry.id} · balance ${money(balance, cur)}`]}
              help="The FOM's approval covers what is left, so a part-payment (even nothing) can settle and the rest is collected after the stay."
              busy={creditExt.isPending}
              footer={
                <>
                  <NotNow onClick={() => setCreditOpen(false)} busy={creditExt.isPending} />
                  <Button
                    className={live && ceiling.trim() && creditWhy.trim() ? "go" : undefined}
                    state={creditExt.isPending ? "working" : live && ceiling.trim() && creditWhy.trim() ? "default" : "inert"}
                    reason={!ceiling.trim() ? "put in the amount it covers" : !creditWhy.trim() ? "write why first" : undefined}
                    workingLabel="Approving…"
                    onClick={() => creditExt.mutate()}
                  >
                    {creditActive || creditExpired ? "Approve it again" : "Approve the credit extension"}
                  </Button>
                </>
              }
            >
              <div className="form2">
                <div className="field">
                  <label>Covers up to · Nu.</label>
                  <input
                    className="input money"
                    inputMode="decimal"
                    value={ceiling}
                    onChange={(e) => {
                      ceilingTouched.current = true;
                      setCeiling(e.target.value);
                    }}
                  />
                </div>
                <div className="field">
                  <label>
                    Pay within · days · optional
                    <Help label="About the time limit">Past it the cover lapses and the balance reads overdue. Empty means no time limit.</Help>
                  </label>
                  <input className="input narrow" inputMode="numeric" value={payWithin} placeholder="7" onChange={(e) => setPayWithin(e.target.value.replace(/[^\d.]/g, ""))} />
                </div>
                <div className="wide field">
                  <label>Why</label>
                  <input className="input" value={creditWhy} placeholder="bank transfer promised by Friday" onChange={(e) => setCreditWhy(e.target.value)} />
                </div>
              </div>
            </DsDialog>
          </Live>
        </>
      )}

      <DsDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Take payment and settle"
        caseLines={[<b key="g">{guest}</b>, `${entry.id} · balance ${money(balance, cur)}`]}
        busy={settle.isPending}
        footer={
          <>
            <Button kind="quiet" state={settle.isPending ? "inert" : "default"} onClick={() => setConfirmOpen(false)}>
              Not yet
            </Button>
            <Button icon="lock" state={settle.isPending ? "working" : "default"} workingLabel="Settling…" onClick={() => settle.mutate()}>
              Take payment
            </Button>
          </>
        }
      >
        <p className="sm">This cannot be undone. What becomes binding:</p>
        <ul className="plain-list sm" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>
            {partial ? (
              <>
                The guest pays <b className="money">{money(typed, cur)}</b> now — the rest of the {money(balance, cur)} balance stays owed and is collected after the stay.
                {fom ? " Your authority as FOM covers it." : creditCovers ? " The credit extension on file covers it." : ""}
              </>
            ) : method === "VOUCHER" ? (
              <>
                The agency&rsquo;s voucher covers <b className="money">{money(voucherValid ? voucherTyped : null, cur)}</b> of the{" "}
                <b className="money">{money(balance, cur)}</b> balance — anything it leaves is invoiced to {booked.payer}
                {invoiceTo.trim() ? `, sent to ${invoiceTo.trim()}` : " and handed over (no email)"}.
              </>
            ) : method === "DIRECT_BILL" ? (
              <>
                The balance of <b className="money">{money(balance, cur)}</b> is invoiced to {booked.payer}
                {invoiceTo.trim() ? (
                  <>
                    {" "}
                    and the invoice is emailed to <b>{invoiceTo.trim()}</b>
                  </>
                ) : (
                  " — no email address, so the invoice is handed over"
                )}
                .
              </>
            ) : (
              <>
                The balance of <b className="money">{money(balance, cur)}</b> is taken in full.
              </>
            )}
          </li>
          <li>The bill closes — nothing more can be posted to it here.</li>
          <li>The rooms are released to housekeeping.</li>
        </ul>
      </DsDialog>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the invoices, by payer */

function Invoices({ entry, live, tz }: { entry: EntryDetail; live: boolean; tz: string }) {
  const { session } = useSession();
  const billing = useBilling(entry);
  const index = useFolioIndex(entry);
  const booked = useBookedBy(entry);
  const issueSend = useIssueAndSend(entry);
  const send = useSendInvoice(entry);
  const [sendTo, setSendTo] = useSendTo(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  if (!entry.folio) return null;
  const tax = index.data?.documents.find((d) => d.kind === "tax-invoice") ?? null;
  const sealed = !!index.data?.sealedAt;
  const issued = tax?.state === "ISSUED" && tax.invoice ? tax.invoice : null;
  const fo = billing.data?.folio ?? null;
  const cb = fo?.chargeBreakdown ?? null;
  const cur = billing.data?.currency ?? "BTN";
  const hasParty = !!booked.party;

  const stateChip = issued ? (
    <Chip tone={issued.state === "DRAFT" ? "warning" : "success"} icon={issued.state === "DRAFT" ? undefined : "check"}>
      {issued.invoiceNumber ?? issued.id} · {INVOICE_STATE_WORD[issued.state] ?? words(issued.state)}
    </Chip>
  ) : tax?.state === "DRAFT" ? (
    <Chip tone="warning">draft · not issued</Chip>
  ) : (
    <Chip tone="quiet">{tax ? "not available" : "reading…"}</Chip>
  );

  const issueReason = !live
    ? "only while the booking is at Check-out"
    : !tax?.available
      ? tax?.unavailableReason ?? "the tax invoice is not available yet"
      : !sealed
        ? "settle the bill first — the tax invoice issues once, when the supply is settled"
        : undefined;

  const main = (
    <StepCard
      title={`Tax invoice · ${booked.payer}`}
      right={stateChip}
      meta={`${tax?.purpose ?? "A draft until the bill is settled — its particulars become the one original."}${issued ? "" : ` Issuing it sends it to ${booked.payer} in the same act — no invoice exists unsent.`}`}
      acts={
        <>
          {issued ? (
            <>
              <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "invoice", id: issued.id, issued: true, label: `Tax invoice ${issued.invoiceNumber ?? issued.id}` })}>
                Preview
              </Button>
              <Button
                kind="quiet"
                compact
                icon="file"
                onClick={() => session && openInvoicePdf(session, issued.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}
              >
                PDF
              </Button>
              {issued.state === "DRAFT" ? (
                <Live>
                  <Button icon="send" compact state={send.isPending ? "working" : "default"} workingLabel="Sending…" onClick={() => send.mutate({ invoiceId: issued.id, to: sendTo })}>
                    Send it
                  </Button>
                </Live>
              ) : null}
            </>
          ) : (
            <>
              <Button
                kind="secondary"
                compact
                icon="eye"
                state={tax?.available ? "default" : "inert"}
                title={tax?.available ? undefined : tax?.unavailableReason ?? undefined}
                onClick={() => setPaper({ kind: "folio", entryId: entry.id, doc: "tax-invoice", label: "Tax invoice · draft", refreshKey: `${entry.updatedAt}|${index.data?.asAt ?? ""}` })}
              >
                Preview draft
              </Button>
              <Live>
                <Button state={issueSend.isPending ? "working" : issueReason ? "inert" : "default"} reason={issueReason} workingLabel="Issuing…" onClick={() => issueSend.mutate(sendTo)}>
                  Issue and send
                </Button>
              </Live>
            </>
          )}
        </>
      }
    >
      <div className="meta">{booked.kind}</div>
      <div className="sm" style={{ display: "grid", gap: 4, marginTop: 8 }}>
        <div className="row-acts" style={{ justifyContent: "space-between" }}>
          <span>Billed so far{fo ? ` · ${plural(fo.lineCount, "line")}` : ""}</span>
          <span className="money">{money(fo?.billedSoFar, cur)}</span>
        </div>
        {cb ? (
          <div className="meta">
            net {money(cb.base, cur)} · service charge {money(cb.serviceCharge, cur)} · GST {money(cb.gst, cur)}
          </div>
        ) : null}
        <div className="row-acts" style={{ justifyContent: "space-between" }}>
          <span>Received</span>
          <span className="money">{money(fo?.paymentsReceived, cur)}</span>
        </div>
        {fo?.refunded != null && fo.refunded !== 0 ? (
          <div className="row-acts" style={{ justifyContent: "space-between" }}>
            <span>Refunded</span>
            <span className="money">{money(fo.refunded, cur)}</span>
          </div>
        ) : null}
        {fo?.writtenOff != null && fo.writtenOff !== 0 ? (
          <div className="row-acts" style={{ justifyContent: "space-between" }}>
            <span>Written off</span>
            <span className="money">{money(fo.writtenOff, cur)}</span>
          </div>
        ) : null}
        <div className="row-acts" style={{ justifyContent: "space-between", borderTop: "2px solid var(--ink)", paddingTop: 6 }}>
          <b>Balance due on this invoice</b>
          <b className="money">{money(fo?.outstandingBalance, cur)}</b>
        </div>
      </div>
      {issued && issued.state !== "DRAFT" ? (
        <div style={{ marginTop: 10 }}>
          <div className="meta">
            Sent {issued.dispatchedAt ? fmtStamp(issued.dispatchedAt, tz) : ""} · {sentWords(issued.dispatchedTo, entry, booked.party)}
          </div>
          <AnswerLine entryId={entry.id} type="FINAL_INVOICE" what="the tax invoice" tz={tz} />
        </div>
      ) : issued ? (
        <>
          <p className="sm warn-ink" style={{ marginTop: 8 }}>
            Issued {issued.issuedAt ? fmtStamp(issued.issuedAt, tz) : ""} and not sent — no invoice may stay undispatched.
          </p>
          <Live>
            <div className="form2" style={{ marginTop: 8 }}>
              <SendToField entry={entry} value={sendTo} onChange={setSendTo} />
            </div>
          </Live>
        </>
      ) : (
        <Live>
          <div className="form2" style={{ marginTop: 8 }}>
            <SendToField entry={entry} value={sendTo} onChange={setSendTo} />
          </div>
        </Live>
      )}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </StepCard>
  );

  if (!hasParty) return main;
  // The agency pays the rooms, the guest their own extras (O1, BE-41). Today the folio issues one
  // tax invoice; the second, per-payer draft is shown so the desk sees where it will go.
  return (
    <div className="grid2">
      {main}
      <StepCard
        title={`Extras · ${booked.guest}`}
        right={<Chip tone="quiet">not a separate invoice yet</Chip>}
        meta={`A tax invoice of the guest's own extras — food, laundry, the minibar — apart from the rooms billed to ${booked.party ?? "the account"}. It can't be made yet.`}
      >
        <p className="sm">
          Today the bill issues <b>one</b> tax invoice to {booked.payer}. Until the split exists, take the guest&rsquo;s part with <b>Settle part by part</b> above.
        </p>
        <Live>
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button kind="secondary" compact icon="eye" state="inert" title="Not possible yet — there is one tax invoice for the whole bill">
              Preview draft
            </Button>
            <Button state="inert" title="Not possible yet — take the guest's part with Settle part by part, above">
              Record payment · issue · send
            </Button>
          </div>
        </Live>
      </StepCard>
    </div>
  );
}

/* ------------------------------------------------------------------ the departure */

function Departure({ entry, live }: { entry: EntryDetail; live: boolean }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const booked = useBookedBy(entry);
  const rooms = useMemo(() => distinctRooms(entry), [entry]);
  const keyReturn = (entry.keyReturnRecords ?? [])[0] ?? null;
  const keysIssued = entry.keysIssuedCount ?? 0;

  /* ---- keys, room by room when the stamps exist ---- */
  const keyPlan = useMemo(() => {
    const byRoom = new Map<string, NonNullable<EntryDetail["roomAssignments"]>>();
    for (const a of entry.roomAssignments ?? []) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
    return Array.from(byRoom.entries())
      .map(([roomId, rs]) => ({
        roomId,
        roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 6),
        outstanding: rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt && !r.keyLostAt),
        backEarlier: rs.some((r) => r.keyReturnedAt) && !rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt && !r.keyLostAt),
        lost: rs.some((r) => r.keyLostAt),
        lostNote: rs.find((r) => r.keyLostAt)?.keyLostNote ?? null,
      }))
      .filter((k) => k.outstanding || k.backEarlier || k.lost)
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [entry.roomAssignments]);
  const roomWise = keyPlan.length > 0;
  const outstandingKeys = keyPlan.filter((k) => k.outstanding);
  // Each room's key is RETURNED or LOST (2026-10-26, operator: "tell the system which room's key
  // exactly is missing"). A lost key says what happened, in a pop-up, and the reason stays with that
  // room (2026-10-30, operator); every room is answered before the keys are recorded.
  const [keyState, setKeyState] = useState<Record<string, "back" | "lost">>({});
  const [lostNotes, setLostNotes] = useState<Record<string, string>>({});
  const [askLost, setAskLost] = useState<{ roomId: string; roomNumber: string } | null>(null);
  const marked = outstandingKeys.filter((k) => keyState[k.roomId] === "back");
  const lostKeys = outstandingKeys.filter((k) => keyState[k.roomId] === "lost");
  const unanswered = outstandingKeys.filter((k) => !keyState[k.roomId]);
  const toggleKey = (roomId: string, v: "back" | "lost") =>
    setKeyState((p) => {
      const next = { ...p };
      if (next[roomId] === v) delete next[roomId];
      else next[roomId] = v;
      return next;
    });
  // Lost asks why first; pressed again it takes the answer back.
  const pressLost = (k: { roomId: string; roomNumber: string }) => {
    if (keyState[k.roomId] === "lost") toggleKey(k.roomId, "lost");
    else setAskLost(k);
  };
  const notLost = outstandingKeys.filter((k) => keyState[k.roomId] !== "lost");
  const allReturned = notLost.length > 0 && notLost.every((k) => keyState[k.roomId] === "back");
  const setAllReturned = () =>
    setKeyState((p) => {
      const next = { ...p };
      for (const k of notLost) {
        if (allReturned) delete next[k.roomId];
        else next[k.roomId] = "back";
      }
      return next;
    });
  const [count, setCount] = useState(String(keysIssued || 1));
  // The record-the-keys act is the section's own; it is green once it can be pressed.
  const [lostCount, setLostCount] = useState("0");
  const lostN = Number.parseInt(lostCount || "0", 10) || 0;
  const [keyNote, setKeyNote] = useState("");
  const countN = Number.parseInt(count, 10);
  // A booking keyed by count (no room stamps) keeps the counts and the one note.
  const anyLost = lostN > 0;
  const short = countN !== keysIssued || anyLost;
  const notePrompt = anyLost ? "what happened to the lost key" : "a key has not come back — say what happened";

  const keys = useMutation({
    mutationFn: () => {
      if (roomWise) {
        const ids = marked.map((k) => k.roomId);
        const lostIds = lostKeys.map((k) => k.roomId);
        return recordKeyReturn(session!, entry.id, {
          keyCountReturned: ids.length,
          ...(ids.length ? { returnedRoomIds: ids } : {}),
          ...(lostIds.length
            ? { lostRooms: lostKeys.map((k) => ({ roomId: k.roomId, note: (lostNotes[k.roomId] ?? "").trim() })), keyCountLost: lostIds.length }
            : {}),
        });
      }
      if (!Number.isInteger(countN) || countN < 0) throw new Error("Put in how many keys came back");
      return recordKeyReturn(session!, entry.id, {
        keyCountReturned: countN,
        ...(lostN > 0 ? { keyCountLost: lostN } : {}),
        ...(short ? { reconciliationNote: keyNote.trim() } : {}),
      });
    },
    onSuccess: () => {
      toast.success("The keys are on record");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The key return could not be recorded"),
  });


  const released = rooms.length > 0 && rooms.every((r) => r.room?.currentClaimState === "DEPARTED_DIRTY" || r.room?.currentClaimState === "DEPARTED_CLEAN");
  const onAccount = !!entry.folio?.billingModel && ON_ACCOUNT_MODELS.has(entry.folio.billingModel);

  // Folds once every key is back and every room inspected or put off — finished by the presses in it.
  useFinishWhenMet("departure");
  const insp = useRoomInspections(entry);
  const inspRooms = insp.data?.rooms ?? [];
  const doneRooms = inspRooms.filter((r) => r.state === "DONE");
  const putOff = inspRooms.filter((r) => r.state === "PUT_OFF").length;
  const damaged = inspRooms.filter((r) => r.damageFound).length;
  const keysLine = keyReturn
    ? keyReturn.keyCountLost
      ? `${keyReturn.keyCountReturned} of ${keyReturn.keyCountIssued} keys returned · ${keyReturn.keyCountLost} lost`
      : "Keys returned"
    : "";
  const roomsLine =
    inspRooms.length === 1
      ? inspRooms[0].state === "PUT_OFF"
        ? `Room ${inspRooms[0].roomNumber}'s inspection put off`
        : `Room ${inspRooms[0].roomNumber} inspected · ${damaged ? "damage found" : "nothing found"}`
      : inspRooms.length
        ? `${plural(doneRooms.length, "room")} inspected${putOff ? ` · ${putOff} put off` : ""}${damaged ? ` · damage in ${damaged}` : " · nothing found"}`
        : "";
  const leavesWith = onAccount
    ? `They leave with the master bill — charged to ${booked.payer}, nothing due from them at the desk.`
    : "They leave with their tax invoice, sent — and printed if they want paper.";

  return (
    <StepCard
      flow="departure"
      title="The keys and the rooms"
      meta={`Each room's key back, and each room inspected or put off to after the departure. ${leavesWith} A printed receipt for the payment can't be made yet — the tax invoice shows what was paid. The stay stays on ${booked.guest}'s record; closing the booking seals it.`}
      summary={[keysLine, roomsLine].filter(Boolean).join(" · ")}
    >
      <Facts wide>
        <Fact k="Keys">
          {keyReturn ? (
            <span>
              {keyReturn.keyCountLost ? (
                <Chip tone="warning" icon="key">
                  {keyReturn.keyCountLost === 1 ? "a key lost" : `${keyReturn.keyCountLost} keys lost`}
                </Chip>
              ) : (
                <Chip tone="success" icon="check">
                  returned
                </Chip>
              )}{" "}
              {keyReturn.keyCountReturned} of {keyReturn.keyCountIssued} returned
              {keyReturn.lostRoomIds?.length ? (
                <b className="warn-ink">
                  {" "}
                  · lost: {keyReturn.lostRoomIds.map((id) => `Room ${keyPlan.find((k) => k.roomId === id)?.roomNumber ?? "?"}`).join(", ")}
                </b>
              ) : null}
              <span className="meta">
                {keyReturn.countReconciled && !keyReturn.keyCountLost ? " · all accounted for" : keyReturn.reconciliationNote ? ` · “${keyReturn.reconciliationNote}”` : ""}
              </span>
            </span>
          ) : roomWise ? (
            <div style={{ display: "grid", gap: 6 }}>
              <span className="row-acts" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  {outstandingKeys.length} out
                  <span className="meta">
                    {" "}
                    · {marked.length} returned{lostKeys.length ? ` · ${lostKeys.length} lost` : ""}
                    {unanswered.length ? ` · ${unanswered.length} not answered` : ""}
                  </span>
                </span>
                {live && notLost.length > 1 ? (
                  <Button kind="secondary" compact icon={allReturned ? undefined : "check"} onClick={setAllReturned}>
                    {allReturned ? "Clear" : "All returned"}
                  </Button>
                ) : null}
              </span>
              {keyPlan.map((k) => (
                <div key={k.roomId} style={{ display: "grid", gap: 2 }}>
                  <div className="row-acts sm">
                    <span style={{ minWidth: 90 }}>Room {k.roomNumber}</span>
                    {k.outstanding ? (
                      live ? (
                        <span className="row-acts" role="group" aria-label={`Room ${k.roomNumber}'s key`}>
                          <Button
                            kind={keyState[k.roomId] === "back" ? "primary" : "secondary"}
                            compact
                            icon={keyState[k.roomId] === "back" ? "check" : undefined}
                            aria-pressed={keyState[k.roomId] === "back"}
                            onClick={() => toggleKey(k.roomId, "back")}
                          >
                            Returned
                          </Button>
                          <Button
                            kind={keyState[k.roomId] === "lost" ? "danger" : "secondary"}
                            compact
                            icon={keyState[k.roomId] === "lost" ? "check" : undefined}
                            aria-pressed={keyState[k.roomId] === "lost"}
                            onClick={() => pressLost(k)}
                          >
                            Lost
                          </Button>
                        </span>
                      ) : (
                        <span className="meta">key out</span>
                      )
                    ) : k.lost ? (
                      <Chip tone="warning" icon="key">
                        lost
                      </Chip>
                    ) : (
                      <Chip tone="quiet" icon="check">
                        returned earlier
                      </Chip>
                    )}
                  </div>
                  {k.outstanding && keyState[k.roomId] === "lost" && lostNotes[k.roomId] ? (
                    <span className="sm warn-ink" style={{ paddingLeft: 98 }}>
                      Lost — &ldquo;{lostNotes[k.roomId]}&rdquo;
                    </span>
                  ) : !k.outstanding && k.lost && k.lostNote ? (
                    <span className="sm warn-ink" style={{ paddingLeft: 98 }}>
                      Lost — &ldquo;{k.lostNote}&rdquo;
                    </span>
                  ) : null}
                </div>
              ))}
              <Live>
                <div className="row-acts">
                  <Button
                    className={live && unanswered.length === 0 ? "go" : undefined}
                    state={keys.isPending ? "working" : live && unanswered.length === 0 ? "default" : "inert"}
                    reason={!live ? "only while the booking is at Check-out" : unanswered.length ? "answer every room's key — Returned or Lost" : undefined}
                    workingLabel="Recording…"
                    onClick={() => keys.mutate()}
                  >
                    Record the keys
                  </Button>
                </div>
              </Live>
              <ReasonDialog
                open={!!askLost}
                onClose={() => setAskLost(null)}
                title={askLost ? `Room ${askLost.roomNumber}'s key is lost` : "A lost key"}
                lead="What happened is kept with this room. Nothing is charged for it."
                reasonLabel="What happened to it"
                placeholder="dropped on the hike to Taktsang"
                confirmLabel="Mark it lost"
                onConfirm={(reason) => {
                  if (!askLost) return;
                  setLostNotes((p) => ({ ...p, [askLost.roomId]: reason.trim() }));
                  setKeyState((p) => ({ ...p, [askLost.roomId]: "lost" }));
                  setAskLost(null);
                }}
              />
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <span>
                {keysIssued} out <span className="meta">· from check-in</span>
              </span>
              <Live>
                <div className="row-acts">
                  <span className="count-in sm">
                    returned
                    <input className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} disabled={!live} />
                  </span>
                  <span className="count-in sm">
                    lost
                    <input className="input" inputMode="numeric" value={lostCount} onChange={(e) => setLostCount(e.target.value.replace(/\D/g, ""))} disabled={!live} />
                  </span>
                  {short && live ? (
                    <input className="input" style={{ flex: 1, minWidth: 200 }} value={keyNote} placeholder={notePrompt} onChange={(e) => setKeyNote(e.target.value)} />
                  ) : null}
                  <Button
                    kind="secondary"
                    compact
                    state={keys.isPending ? "working" : live && count.trim() !== "" && (!short || keyNote.trim()) ? "default" : "inert"}
                    title={!live ? "only while the booking is at Check-out" : short && !keyNote.trim() ? "the count differs — write what happened first" : undefined}
                    workingLabel="Recording…"
                    onClick={() => keys.mutate()}
                  >
                    Keys returned
                  </Button>
                </div>
              </Live>
            </div>
          )}
        </Fact>

        <Fact k="The room">
          <div style={{ display: "grid", gap: 6 }}>
            <span>
              {released ? (
                <Chip tone="success" icon="check">
                  released to housekeeping
                </Chip>
              ) : (
                <>released to housekeeping when the bill is settled</>
              )}
            </span>
            <RoomInspectionGrid entry={entry} live={live} />
          </div>
        </Fact>
      </Facts>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ raise a dispute */

function RaiseDispute({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (open) setTitle("");
  }, [open]);
  const raise = useMutation({
    mutationFn: (description: string) => openDispute(session!, { entryId: entry.id, folioId: entry.folio!.id, title: title.trim(), description }),
    onSuccess: () => {
      toast.success("The dispute is on record — the booking stays at Check-out until it is answered");
      onClose();
      refresh();
    },
    onError: (e) => toastRefusal(e, "The dispute could not be raised"),
  });
  if (!entry.folio) return null;
  return (
    <ReasonDialog
      open={open}
      onClose={onClose}
      title="Raise a dispute"
      lead="What the guest queried and what they say about it. An open dispute keeps the booking at Check-out, with no override; the FOM reviews it, the GM closes it."
      reasonLabel="The guest's words"
      placeholder="we were one cover, not two"
      confirmLabel="Raise the dispute"
      extraValid={!!title.trim()}
      busy={raise.isPending}
      onConfirm={(reason) => raise.mutate(reason)}
    >
      <div className="field">
        <label>What was queried</label>
        <input className="input" value={title} placeholder="dinner · 2 covers · 11 Sep" onChange={(e) => setTitle(e.target.value)} />
      </div>
    </ReasonDialog>
  );
}
