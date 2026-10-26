"use client";

/**
 * Step 8 · Check-out — "settle up" (SS03 amendment O1–O5, prototype `stepCanvas[8]`).
 *
 * The order the desk works in: is the folio complete → the master bill reviewed with the guest →
 * how the bill is settled → the tax invoice issued and sent → the departure (keys, the room).
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
import { useHotelDay } from "@/hooks/use-hotel-day";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import {
  buildH4FulfilmentEvidence,
  correctFolioCharge,
  fulfilHandoff,
  initiateSettlement,
  postFolioCharge,
  reEnterS8ToS2,
  reEnterS8ToS7,
  recordKeyReturn,
  recordRoomInspection,
} from "@/lib/api/checkout";
import { getNightAuditRecord, openDispute, postCreditNote } from "@/lib/api/in-stay";
import { recordCreditExtension } from "@/lib/api/reservation-setup";
import { openFolioDocumentPdf, openInvoicePdf } from "@/lib/api/documents";
import { deriveFinancials, effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDate, fmtDateTime, fmtDay, fmtStamp, money, plural } from "@/lib/ds/format";
import { PLAN_LABEL, dueLabel } from "@/components/desk/workspace/advance-settlement";
import {
  FolioLinesTable,
  chargeTargetSpaces,
  isTaxCompanion,
  spaceNamesFromAllocations,
  splitChargeTarget,
} from "@/components/desk/workspace/folio-lines";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import type { EntryDetail, FolioLineSummary } from "@/types/api";
import { sentWords } from "@/hooks/use-invoice-recipient";
import { OverpaidCard } from "./refund-card";
import {
  AnswerLine,
  Choice,
  DsDialog,
  Fact,
  Facts,
  Live,
  PaperDrawer,
  ReasonDialog,
  SeeRow,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  toastRefusal,
  useRefreshEntry,
  words,
  type PaperRef,
  OtherWaysTabs,
  InlineWay,
  ShutWay,
  useOpenOtherWay,
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
  defaultSettleMethod,
  settleMethodsFor,
  sharesToSettle,
  useSettlementShares,
  type SettleMethod,
} from "./s8-shares";
import { Help } from "@/components/ds/help";

/* ------------------------------------------------------------------ vocabulary */

const CHARGE_TYPES = [
  ["F_AND_B", "Food and drink"],
  ["SERVICE", "Service"],
  ["OTHER", "Other"],
] as const;

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
  openPane,
}: {
  entry: EntryDetail;
  past: boolean;
  goToStep: (n: number) => void;
  /** Which pane is open — null is This step. */
  pane?: string | null;
  openPane?: (key: string | null) => void;
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
  // Going back and raising a dispute happen in Other ways' own tabs (2026-10-17).
  const openWay = useOpenOtherWay();

  const backMutation = useMutation({
    mutationFn: (v: { to: "stay" | "negotiation"; reason: string }) =>
      v.to === "stay" ? reEnterS8ToS7(session!, entry.id, entry.version, v.reason) : reEnterS8ToS2(session!, entry.id, entry.version, v.reason),
    onSuccess: (_d, v) => {
      toast.success(v.to === "stay" ? "Back at Stay — post the charge there" : "Re-opened to Negotiation — a new pass is open");
      refresh();
      goToStep(v.to === "stay" ? 7 : 2);
    },
    onError: (e) => toastRefusal(e, "The booking could not be taken back"),
  });

  const backForm = (to: "stay" | "negotiation") => (
    <InlineWay
      render={() => (
        <ReasonDialog
          open
          onClose={() => undefined}
          title={to === "negotiation" ? "Re-open to Negotiation" : "Back to Stay"}
          caseLines={[folio ? `the bill is ${FOLIO_STATE_WORD[folio.state] ?? words(folio.state)}` : "no bill"]}
          lead={
            to === "negotiation"
              ? "This closes the current pass and opens a new one at Negotiation for a full re-price. The live bill carries over. The history shows the new pass as such."
              : "The booking goes back to Stay so a missed charge can be posted there. The bill stays live; bring the booking back to Check-out when it is done."
          }
          reasonLabel="Why · recorded on the booking"
          placeholder={to === "negotiation" ? "the guest disputes the rate charged" : "minibar found after the bill was reviewed"}
          confirmLabel={to === "negotiation" ? "Re-open to Negotiation" : "Back to Stay"}
          busy={backMutation.isPending}
          onConfirm={(reason) => backMutation.mutate({ to, reason })}
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
        <DisputesCard entry={entry} tz={clock.tz} />
        <MasterBill
          entry={entry}
          tz={clock.tz}
          onTab={setChargeTarget}
          onAddCharge={chargeable && openPane ? () => openPane("charges") : undefined}
        />
        <HowSettled entry={entry} live={live} tz={clock.tz} onBackToStay={() => openWay("stay")} goToStep={goToStep} />
        <OverpaidCard entry={entry} live={live} />
        <Invoices entry={entry} live={live} tz={clock.tz} />
        <Departure entry={entry} live={live} />
        <DepartureHandoff entry={entry} live={live} tz={clock.tz} />
      </div>

      <div className="pane" hidden={at("charges")}>
        <FolioTableCard entry={entry} onTab={setChargeTarget} />
        {chargeable ? (
          <AddOrCorrectCharge entry={entry} target={chargeTarget} setTarget={setChargeTarget} />
        ) : (
          <StepCard
            title="Add or correct a charge"
            status={
              <span className="warn-ink">
                {!folio
                  ? "There is no bill on this booking."
                  : isSettled(folio.state)
                    ? "The bill is settled — a charge found now is posted on the Closed step, as a late charge."
                    : `The bill is ${FOLIO_STATE_WORD[folio.state] ?? words(folio.state)} — charges can be added only while it is open.`}
              </span>
            }
          />
        )}
      </div>

      {/* Other ways as sub-tabs (2026-10-17), each panel the form its button used to open. */}
      <OtherWaysTabs
        tabs={[
          live && !settled
            ? { key: "stay", label: "Back to Stay", content: fom ? backForm("stay") : <ShutWay act="Back to Stay" why="Going back to Stay needs the FOM." /> }
            : null,
          live && !settled
            ? {
                key: "negotiation",
                label: "Re-open to Negotiation",
                content: fom ? backForm("negotiation") : <ShutWay act="Re-open to Negotiation" why="Re-opening the rate needs the FOM." />,
              }
            : null,
          live && folio
            ? { key: "dispute", label: "Raise a dispute", content: <InlineWay render={(done) => <RaiseDispute entry={entry} open onClose={done} />} /> }
            : null,
        ]}
      />
    </StepCanvas>
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
  return (
    <div style={{ marginBottom: 10 }}>
      <Refusal
        kind="state"
        message={`The last night (${fmtDate(lastNight)}) is not audited — the bill cannot be settled until it is.`}
        guidance={fom ? "Take the booking back to Stay and post the night there." : "The FOM takes the booking back to Stay to post the night."}
        actions={
          fom ? (
            <Button kind="secondary" compact onClick={onBackToStay}>
              Back to Stay…
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
  const [flag, setFlag] = useState<(typeof H4_FLAGS)[number][0]>("RECORDED");
  const fulfil = useMutation({
    mutationFn: () => fulfilHandoff(session!, h4!.id, buildH4FulfilmentEvidence(flag)),
    onSuccess: () => {
      toast.success("The departure handoff is done");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The departure handoff could not be completed"),
  });
  const doneAt = h4?.fulfilledAt ?? null;

  return (
    <StepCard
      flow="handoff"
      title="The departure handoff"
      status={
        done ? (
          <span className="ok-ink">
            Done{doneAt ? ` · ${fmtStamp(doneAt, tz)}` : ""}
            {h4?.isAutoFulfilled ? " · recorded by itself, a same-day departure" : ""}
          </span>
        ) : h4 ? (
          <span className="warn-ink">
            {capFirst(HANDOFF_STATE_WORD[h4.state] ?? words(h4.state))} — say where the room&rsquo;s fault stands and mark it done
          </span>
        ) : (
          <span className="warn-ink">Not raised — it is raised when the booking leaves Stay</span>
        )
      }
      meta="Charges posted, the room inspected or put off, any damage assessed — the last check before the booking closes."
    >
      {h4 && !done ? (
        <div className="form2">
          <div className="field">
            <label>The room&rsquo;s fault, at departure</label>
            <select className="input" value={flag} onChange={(e) => setFlag(e.target.value as typeof flag)} disabled={!live}>
              {H4_FLAGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <Button
              compact
              state={fulfil.isPending ? "working" : live ? "default" : "inert"}
              title={live ? undefined : "only while the booking is at Check-out"}
              workingLabel="Recording…"
              onClick={() => fulfil.mutate()}
            >
              Mark the handoff done
            </Button>
          </div>
        </div>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the master bill */

/** The bill's lines, its room / space tabs and their server-summed footers — shown on the master
 * bill and again on the Add a charge tab. A tab opened here becomes the next charge's "For". */
function BillLines({ entry, onTab }: { entry: EntryDetail; onTab: (target: string) => void }) {
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
function BillFigures({ fo, cur }: { fo: BillFolio | null; cur: string }) {
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

/** The folio again, on the Add a charge tab — so a charge is posted with the bill in view. */
function FolioTableCard({ entry, onTab }: { entry: EntryDetail; onTab: (target: string) => void }) {
  const billing = useBilling(entry);
  const fo = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  return (
    <StepCard title="The folio" status={fo ? `${plural(fo.lineCount, "line")} on the bill` : undefined}>
      <BillFigures fo={fo} cur={cur} />
      <div style={{ marginTop: 12 }}>
        <BillLines entry={entry} onTab={onTab} />
      </div>
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
  const [showLines, setShowLines] = useState(true);
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

/* ------------------------------------------------------------------ add or correct a charge */

function AddOrCorrectCharge({ entry, target, setTarget }: { entry: EntryDetail; target: string; setTarget: (v: string) => void }) {
  const { session } = useSession();
  const hotelDay = useHotelDay();
  const refresh = useRefreshEntry(entry.id);
  const fom = atLeast(session?.actorLevel, "L2");
  const folio = entry.folio!;
  // Last-morning charges belong to the check-out day — never a stay night, so never sealed by the
  // night audit. The server normalises the date to the hotel's calendar. The EFFECTIVE check-out:
  // after an early departure the guest left on that day, and dating their last charges on the
  // booked check-out put them days after the stay ended (2026-09-18).
  const checkoutDate = effectiveCheckOutIso(entry);
  const dateForPosting = checkoutDate ?? hotelDay?.today ?? null;
  const rooms = useMemo(() => distinctRooms(entry), [entry]);
  const spaces = useMemo(() => chargeTargetSpaces(entry.spaceAllocations), [entry.spaceAllocations]);
  const roomNumberById = useMemo(() => new Map(rooms.map((r) => [r.roomId, r.roomNumber])), [rooms]);
  const spaceNameById = useMemo(() => new Map(spaces.map((s) => [s.spaceId, s.spaceName])), [spaces]);
  const targetLabel = (l: { roomId?: string | null; spaceId?: string | null }) =>
    l.roomId ? `Room ${roomNumberById.get(l.roomId) ?? "?"}` : l.spaceId ? spaceNameById.get(l.spaceId) ?? "a space" : "no room or space";

  const [type, setType] = useState<(typeof CHARGE_TYPES)[number][0]>("F_AND_B");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [posted, setPosted] = useState<FolioLineSummary | null>(null);

  const [lineId, setLineId] = useState("");
  const [mode, setMode] = useState<"adjust" | "setNet">("adjust");
  const [delta, setDelta] = useState("");
  const [toAmount, setToAmount] = useState("");
  const [why, setWhy] = useState("");

  // Charges only — a service-charge or GST line moves with its charge and is never corrected alone.
  const correctable = (folio.lines ?? []).filter((l) => !isTaxCompanion(l) && !l.description.toLowerCase().startsWith("correction for"));
  const amt = Number.parseFloat(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(amt);

  const post = useMutation({
    mutationFn: () => {
      if (!amountOk) throw new Error("Put in the amount");
      return postFolioCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: type,
        description: desc.trim() || "Final morning charge",
        amount: amt,
        chargeDate: dateForPosting ?? undefined,
        ...splitChargeTarget(target),
      });
    },
    onSuccess: (line) => {
      setPosted(line);
      setAmount("");
      setDesc("");
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The charge could not be posted"),
  });
  const credit = useMutation({
    mutationFn: () => {
      if (!amountOk || amt <= 0) throw new Error("Put in the amount of the credit");
      if (!dateForPosting) throw new Error("The hotel's date is not known yet");
      return postCreditNote(session!, folio.id, {
        entryId: entry.id,
        description: desc.trim() || "Credit note",
        amount: amt,
        creditDate: dateForPosting,
        ...splitChargeTarget(target),
      });
    },
    onSuccess: () => {
      toast.success("Credit note posted");
      setAmount("");
      setDesc("");
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The credit note could not be posted"),
  });
  const correct = useMutation({
    mutationFn: () => {
      if (!lineId) throw new Error("Choose the charge that is wrong");
      if (!dateForPosting) throw new Error("The hotel's date is not known yet");
      const body: Parameters<typeof correctFolioCharge>[2] = {
        entryId: entry.id,
        originalFolioLineId: lineId,
        reason: why.trim(),
        correctionDate: dateForPosting,
      };
      if (mode === "setNet") {
        const n = Number.parseFloat(toAmount);
        if (!Number.isFinite(n)) throw new Error("Put in what the charge should be");
        body.correctToAmount = n;
      } else {
        const v = Number.parseFloat(delta);
        if (!Number.isFinite(v) || v === 0) throw new Error("Put in the adjustment — more or less than zero");
        body.correctionAmount = v;
      }
      return correctFolioCharge(session!, folio.id, body);
    },
    onSuccess: () => {
      toast.success("Correction posted — its service charge and GST moved with it");
      setLineId("");
      setDelta("");
      setToAmount("");
      setWhy("");
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The correction could not be posted"),
  });

  return (
    <StepCard
      title="Add or correct a charge"
      status={`Dated the check-out day${checkoutDate ? `, ${fmtDate(checkoutDate)}` : ""}`}
      meta="The last night is already audited. Charges can be added or corrected until the bill is settled." 
    >
      <div className="form2">
        <div className="field">
          <label>What it is</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {CHARGE_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>For</label>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">No room or space</option>
            {rooms.map((r) => (
              <option key={r.roomId} value={`room:${r.roomId}`}>
                Room {r.roomNumber}
              </option>
            ))}
            {spaces.length ? (
              <optgroup label="Spaces">
                {spaces.map((s) => (
                  <option key={s.spaceId} value={`space:${s.spaceId}`}>
                    {s.spaceName}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
        <div className="field">
          <label>Amount · Nu. · before service charge and GST</label>
          <input className="input money" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label>Description</label>
          <input className="input" value={desc} placeholder="2 × mineral water, 1 × beer" onChange={(e) => setDesc(e.target.value)} />
        </div>
      </div>
      <div className="row-acts" style={{ marginTop: 10 }}>
        <Button
          compact
          state={post.isPending ? "working" : amountOk ? "default" : "inert"}
          title={amountOk ? undefined : "put in the amount first"}
          workingLabel="Posting…"
          onClick={() => post.mutate()}
        >
          Post the charge
        </Button>
        <Button
          kind="quiet"
          compact
          state={credit.isPending ? "working" : !fom ? "inert" : amountOk && amt > 0 ? "default" : "inert"}
          title={!fom ? "A credit note needs the FOM" : amountOk && amt > 0 ? undefined : "put in the amount of the credit first"}
          workingLabel="Posting…"
          onClick={() => credit.mutate()}
        >
          Post a credit note
        </Button>
        <Help label="About the credit note">Its service charge and GST post beside it on their own lines.</Help>
      </div>

      {correctable.length ? (
        <div className="form2" style={{ marginTop: 12 }}>
          <div className="rule-above">
            <b className="sm">Correct a charge</b>
            <Help label="About corrections">
              The bill only grows — a correction is a new line beside the original, and its service charge and GST move with it.
            </Help>
          </div>
          <div className="wide field">
            <label>Which charge is wrong</label>
            <select className="input" value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">Choose a charge from the bill…</option>
              {correctable.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.id.split("-").pop()} · {fmtDay(l.chargeDate)} · {targetLabel(l)} · {l.description} · {money(l.amount, l.currency)}
                </option>
              ))}
            </select>
          </div>
          <div className="wide field">
            <label>How</label>
            <Choice
              options={[
                ["adjust", "Adjust it by an amount"],
                ["setNet", "Set it to an amount"],
              ]}
              value={mode}
              onChange={setMode}
            />
          </div>
          <div className="field">
            <label>{mode === "adjust" ? "Adjustment · Nu. · minus to reduce" : "What it should be · Nu. · net"}</label>
            {mode === "adjust" ? (
              <input className="input money" inputMode="decimal" value={delta} placeholder="-50.00" onChange={(e) => setDelta(e.target.value)} />
            ) : (
              <input className="input money" inputMode="decimal" value={toAmount} placeholder="0.00" onChange={(e) => setToAmount(e.target.value)} />
            )}
          </div>
          <div className="field">
            <label>Why</label>
            <input className="input" value={why} placeholder="the guest had one beer, not two" onChange={(e) => setWhy(e.target.value)} />
          </div>
          <div className="wide row-acts">
            <Button
              kind="secondary"
              compact
              state={correct.isPending ? "working" : lineId && why.trim() ? "default" : "inert"}
              title={!lineId ? "choose the charge first" : !why.trim() ? "write why first" : undefined}
              workingLabel="Posting…"
              onClick={() => correct.mutate()}
            >
              Post the correction
            </Button>
          </div>
        </div>
      ) : null}

      <DsDialog
        open={!!posted}
        onClose={() => setPosted(null)}
        register="report"
        title="Charge posted"
        caseLines={posted ? [<b key="a">{money(posted.amount, posted.currency)}</b>, posted.description] : undefined}
        footer={
          <Button compact onClick={() => setPosted(null)}>
            Done
          </Button>
        }
      >
        {posted ? (
          <>
            <p className="sm">
              {CHARGE_TYPES.find(([v]) => v === posted.lineType)?.[1] ?? words(posted.lineType)} · for {targetLabel(posted)} · line {posted.id.split("-").pop()}
              <Help label="About the charge">Service charge and GST posted beside it on their own lines.</Help>
            </p>
          </>
        ) : null}
      </DsDialog>
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
    >
      <UnauditedLastNight entry={entry} live={live} onBackToStay={onBackToStay} goToStep={goToStep} />
      <div className="row-acts">
        <Chip tone="accent">by the billing model · {model ? BILLING_MODEL_WORD[model] ?? words(model) : "not set"}</Chip>
        {entry.groupBillingMode === "GROUP_MASTER" ? <Chip tone="quiet">one bill for the party</Chip> : null}
        {folio ? (
          <SeeRow
            label={byPart ? "Hide the parts" : "Settle part by part…"}
            note="each room or space pays its own part — the money is filed against it; the bill stays one"
            onClick={() => setByPart((v) => !v)}
          />
        ) : null}
        <Live>
          <SeeRow
            label="Settle by proportion…"
            note="whatever split was agreed — 60 / 40 — each invoice its share of everything"
            reason="Settlement by share is not in the backend yet (BE-70)"
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

      {byPart && folio ? (
        <Tool>
          <SplitSettlementBlock entry={entry} folioId={folio.id} defaultOpen />
        </Tool>
      ) : null}

      {!folio ? (
        <p className="meta" style={{ marginTop: 10 }}>
          There is no bill on this booking.
        </p>
      ) : shares ? (
        <PayerShares entry={entry} shares={shares} live={live} currency={cur} />
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
              The credit extension on file has run out — it no longer covers a part-payment. The FOM approves it again below, or settles it.
            </p>
          ) : null}

          <Live>
            <div className="form2" style={{ marginTop: 12 }}>
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
              {method === "DIRECT_BILL" ? null : (
                <div className="field">
                  <label>
                    {method === "VOUCHER" ? "Voucher number" : "Payment reference"}
                    <Help label="About the reference">{method === "VOUCHER" ? "As printed on the voucher." : "Cash and QR need one."}</Help>
                  </label>
                  <input
                    className="input"
                    value={ref}
                    placeholder={method === "VOUCHER" ? "the agency's voucher number" : "the transaction reference"}
                    onChange={(e) => setRef(e.target.value)}
                  />
                </div>
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
              {invoicesParty ? <SendToField entry={entry} value={invoiceTo} onChange={setInvoiceTo} label="Send the invoice to" /> : null}
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
                icon="lock"
                state={live && !settleReason ? "default" : "inert"}
                reason={live ? settleReason : "only while the booking is at Check-out"}
                onClick={() => setConfirmOpen(true)}
              >
                Take payment &amp; settle
              </Button>
            </div>

            {fom ? (
              <div className="form2" style={{ marginTop: 14 }}>
                <div className="rule-above">
                  <b className="sm">Let the guest leave owing — a credit extension</b>
                  <Help label="About the credit extension">
                    The FOM&rsquo;s approval covers what is left, so a part-payment (even nothing) can settle and the rest is collected after the
                    stay.
                  </Help>
                </div>
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
                <div className="wide row-acts">
                  <Button
                    kind="secondary"
                    compact
                    state={creditExt.isPending ? "working" : live && ceiling.trim() && creditWhy.trim() ? "default" : "inert"}
                    title={!ceiling.trim() ? "put in the amount it covers" : !creditWhy.trim() ? "write why first" : undefined}
                    workingLabel="Approving…"
                    onClick={() => creditExt.mutate()}
                  >
                    {creditActive || creditExpired ? "Approve it again" : "Approve the credit extension"}
                  </Button>
                </div>
              </div>
            ) : null}
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
        meta={`A tax invoice of the guest's own extras — food, laundry, the minibar — apart from the rooms billed to ${booked.party ?? "the account"}. Money in, the invoice issued, receipt and invoice sent in one act is BE-41 · BE-69.`}
      >
        <p className="sm">
          Today the bill issues <b>one</b> tax invoice to {booked.payer}. Until the split exists, take the guest&rsquo;s part with <b>Settle part by part…</b> above.
        </p>
        <Live>
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button kind="secondary" compact icon="eye" state="inert" title="A tax invoice per payer is not in the backend yet (BE-41 · BE-69)">
              Preview draft
            </Button>
            <Button state="inert" title="Money in, the guest's invoice issued, receipt and invoice sent in one act — per-payer invoices are not in the backend yet (BE-41 · BE-69 · BE-43)">
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
  const inspection = (entry.roomInspectionRecords ?? [])[0] ?? null;
  const keysIssued = entry.keysIssuedCount ?? 0;

  /* ---- keys, room by room when the stamps exist ---- */
  const keyPlan = useMemo(() => {
    const byRoom = new Map<string, NonNullable<EntryDetail["roomAssignments"]>>();
    for (const a of entry.roomAssignments ?? []) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
    return Array.from(byRoom.entries())
      .map(([roomId, rs]) => ({
        roomId,
        roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 6),
        outstanding: rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt),
        backEarlier: rs.some((r) => r.keyReturnedAt) && !rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt),
      }))
      .filter((k) => k.outstanding || k.backEarlier)
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [entry.roomAssignments]);
  const roomWise = keyPlan.length > 0;
  const outstandingKeys = keyPlan.filter((k) => k.outstanding);
  const [back, setBack] = useState<Record<string, boolean>>({});
  const marked = outstandingKeys.filter((k) => back[k.roomId]);
  const [count, setCount] = useState(String(keysIssued || 1));
  const [keyNote, setKeyNote] = useState("");
  const countN = Number.parseInt(count, 10);
  const short = roomWise ? marked.length !== outstandingKeys.length : countN !== keysIssued;

  const keys = useMutation({
    mutationFn: () => {
      if (roomWise) {
        const ids = marked.map((k) => k.roomId);
        return recordKeyReturn(session!, entry.id, {
          keyCountReturned: ids.length,
          ...(ids.length ? { returnedRoomIds: ids } : {}),
          ...(short ? { reconciliationNote: keyNote.trim() } : {}),
        });
      }
      if (!Number.isInteger(countN) || countN < 0) throw new Error("Put in how many keys came back");
      return recordKeyReturn(session!, entry.id, { keyCountReturned: countN, ...(short ? { reconciliationNote: keyNote.trim() } : {}) });
    },
    onSuccess: () => {
      toast.success("The keys are on record");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The key return could not be recorded"),
  });

  /* ---- the room inspection ---- */
  const firstRoom = entry.roomAssignments?.[0]?.room;
  const activeFault = (firstRoom?.deficientConditionRecords ?? []).find((d) => d.status === "UNRESOLVED" || d.status === "DEFICIENT_UNRESOLVED_AT_CHECKOUT") ?? null;
  const [deferred, setDeferred] = useState(false);
  const [flag, setFlag] = useState<"RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE">(activeFault ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  useEffect(() => {
    setFlag(activeFault ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  }, [activeFault?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [assessment, setAssessment] = useState("");
  const [damage, setDamage] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");
  const inspect = useMutation({
    mutationFn: () => {
      if (flag !== "NOT_APPLICABLE" && !activeFault?.id) throw new Error("There is no open fault on the room — choose 'no fault on the room'");
      if (flag === "UNRESOLVED_AT_CHECKOUT" && !assessment.trim()) throw new Error("Write what the inspector found");
      return recordRoomInspection(session!, entry.id, {
        isDeferred: deferred,
        deficientFlagStatus: flag,
        deficientConditionId: flag !== "NOT_APPLICABLE" ? activeFault!.id : undefined,
        inspectorAssessment: flag === "UNRESOLVED_AT_CHECKOUT" ? assessment.trim() : undefined,
        damageFound: damage,
        damageNotes: damage ? damageNotes.trim() : undefined,
      });
    },
    onSuccess: () => {
      toast.success(deferred ? "The inspection is put off to after departure" : "The room inspection is on record");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The inspection could not be recorded"),
  });

  const released = rooms.length > 0 && rooms.every((r) => r.room?.currentClaimState === "DEPARTED_DIRTY" || r.room?.currentClaimState === "DEPARTED_CLEAN");
  const onAccount = !!entry.folio?.billingModel && ON_ACCOUNT_MODELS.has(entry.folio.billingModel);

  return (
    <StepCard flow="departure" title="The departure">
      <Facts wide>
        <Fact k="Keys">
          {keyReturn ? (
            <span>
              <Chip tone="success" icon="check">
                returned
              </Chip>{" "}
              {keyReturn.keyCountReturned} of {keyReturn.keyCountIssued}
              <span className="meta">{keyReturn.countReconciled ? " · all accounted for" : keyReturn.reconciliationNote ? ` · “${keyReturn.reconciliationNote}”` : ""}</span>
            </span>
          ) : roomWise ? (
            <div style={{ display: "grid", gap: 6 }}>
              <span>
                {outstandingKeys.length} out
                <span className="meta"> · {marked.length} of {outstandingKeys.length} back</span>
              </span>
              {keyPlan.map((k) => (
                <div key={k.roomId} className="row-acts sm">
                  <span style={{ minWidth: 90 }}>Room {k.roomNumber}</span>
                  {k.outstanding ? (
                    live ? (
                      <label style={{ display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                        <input type="checkbox" checked={!!back[k.roomId]} onChange={() => setBack((p) => ({ ...p, [k.roomId]: !p[k.roomId] }))} />
                        its key is back
                      </label>
                    ) : (
                      <span className="meta">key out</span>
                    )
                  ) : (
                    <Chip tone="quiet" icon="check">
                      back earlier
                    </Chip>
                  )}
                </div>
              ))}
              <Live>
                {short && live ? (
                  <input className="input" value={keyNote} placeholder="a key is missing — say what happened" onChange={(e) => setKeyNote(e.target.value)} />
                ) : null}
                <div className="row-acts">
                  <Button
                    kind="secondary"
                    compact
                    state={keys.isPending ? "working" : live && (!short || keyNote.trim()) ? "default" : "inert"}
                    title={!live ? "only while the booking is at Check-out" : short && !keyNote.trim() ? "a key is missing — write what happened first" : undefined}
                    workingLabel="Recording…"
                    onClick={() => keys.mutate()}
                  >
                    Keys returned
                  </Button>
                </div>
              </Live>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <span>
                {keysIssued} out <span className="meta">· from check-in</span>
              </span>
              <Live>
                <div className="row-acts">
                  <span className="count-in sm">
                    back
                    <input className="input" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} disabled={!live} />
                  </span>
                  {short && live ? (
                    <input className="input" style={{ flex: 1, minWidth: 200 }} value={keyNote} placeholder="a key is missing — say what happened" onChange={(e) => setKeyNote(e.target.value)} />
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
            {inspection ? (
              <span>
                {inspection.isDeferred ? "Inspection put off to after departure" : "Inspected"}
                <span className="meta">
                  {" "}
                  · {DEFICIENCY_WORD[inspection.deficientFlagStatus] ?? words(inspection.deficientFlagStatus)}
                  {inspection.damageFound ? ` · damage noted${inspection.damageNotes ? `: ${inspection.damageNotes}` : ""}` : " · no damage"}
                </span>
              </span>
            ) : (
              <Live>
                <div className="bind provisional" style={{ display: "grid", gap: 8 }}>
                  {activeFault ? (
                    <span className="sm warn-ink">
                      The room has an open fault — {words(activeFault.category)}: {activeFault.description}. Say how the inspection leaves it.
                    </span>
                  ) : null}
                  <label className="sm" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={deferred} onChange={(e) => setDeferred(e.target.checked)} />
                    Put the inspection off to after departure
                  </label>
                  <div className="form2">
                    <div className="field">
                      <label>The room&rsquo;s fault, at check-out</label>
                      <select className="input" value={flag} onChange={(e) => setFlag(e.target.value as typeof flag)}>
                        {activeFault ? (
                          <>
                            <option value="RESOLVED">Put right at inspection</option>
                            <option value="UNRESOLVED_AT_CHECKOUT">Still there at departure</option>
                          </>
                        ) : (
                          <option value="NOT_APPLICABLE">No fault on the room</option>
                        )}
                      </select>
                    </div>
                    {flag === "UNRESOLVED_AT_CHECKOUT" ? (
                      <div className="field">
                        <label>What the inspector found</label>
                        <input className="input" value={assessment} onChange={(e) => setAssessment(e.target.value)} />
                      </div>
                    ) : null}
                    <div className="wide field">
                      <label className="sm" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={damage} onChange={(e) => setDamage(e.target.checked)} />
                        Damage found
                      </label>
                      {damage ? <input className="input" value={damageNotes} placeholder="what is damaged" onChange={(e) => setDamageNotes(e.target.value)} /> : null}
                    </div>
                  </div>
                  <div className="row-acts">
                    <Button
                      kind="secondary"
                      compact
                      state={inspect.isPending ? "working" : live ? "default" : "inert"}
                      title={live ? undefined : "only while the booking is at Check-out"}
                      workingLabel="Recording…"
                      onClick={() => inspect.mutate()}
                    >
                      Record the inspection
                    </Button>
                  </div>
                </div>
              </Live>
            )}
            {!inspection && !live ? <span className="meta">not inspected</span> : null}
          </div>
        </Fact>

        <Fact k="The guest leaves with">
          {onAccount ? (
            <>
              the master bill — <b>charged to {booked.payer}</b>, nothing due from them at the desk
            </>
          ) : (
            <>their tax invoice, sent — and printed if they want paper</>
          )}
          <Help label="About the receipt">A money receipt as a paper is not in the backend yet (BE-43).</Help>
        </Fact>
        <Fact k="The record">
          the stay stays on {booked.guest}&rsquo;s record; closing the booking seals it
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
