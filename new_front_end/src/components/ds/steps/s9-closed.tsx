"use client";

/**
 * Step 9 · Closed — "sealed" (SS03 amendment Z1–Z6, prototype `stepCanvas[9]`).
 *
 * The page opened months later when someone asks about an old booking: what the stay was, where
 * the money sits in the tail after the stay, the one door back in, and the papers as they were
 * sealed. Money arriving after the close is not a change to the record, so recording it — or a
 * charge found after departure, or a write-off — stays open on a closed booking without a
 * re-entry (Z4). Anything else goes through the door back in.
 *
 * Figures are the backend's: the billing summary, the folio's balance, payment-status.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { useClosureReadiness } from "@/hooks/use-closure-readiness";
import { recordRoomInspection } from "@/lib/api/checkout";
import { RoomInspectionGrid } from "./room-inspections";
import {
  expirePostCheckoutInspectionWindow,
  fulfilHandoff,
  postStayCharge,
  recordInvoicePaymentEvent,
  writeOffOutstanding,
} from "@/lib/api/post-stay";
import { openCancellationConfirmationPdf, openFolioDocumentPdf, openInvoicePdf } from "@/lib/api/documents";
import { activeQuotation, deriveFinancials, effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDateTime, fmtDay, fmtInstantDate, fmtRange, fmtStamp, instantYmd, money, nightsOf, plural } from "@/lib/ds/format";
import { rateWords } from "@/lib/ds/rates";
import { FolioLinesTable, spaceNamesFromAllocations } from "@/components/desk/workspace/folio-lines";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import type { EntryDetail, InvoiceSummary } from "@/types/api";
import { sentWords } from "@/hooks/use-invoice-recipient";
import { OverpaidCard } from "./refund-card";
import {
  ActTiles,
  AnswerLine,
  DocCard,
  DsDialog,
  Fact,
  Facts,
  InlineWay,
  Live,
  NotNow,
  PaperDrawer,
  ReasonDialog,
  ShutWay,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  latestDispatched,
  toastRefusal,
  useCommunications,
  useRefreshEntry,
  words,
  type PaperRef,
  type StepPane,
} from "./kit";
import { BillFigures, BillLines } from "./s8-checkout";
import {
  BillByPart,
  DisputesCard,
  FOLIO_STATE_WORD,
  HANDOFF_STATE_WORD,
  INVOICE_STATE_WORD,
  INVOICE_TYPE_WORD,
  useBilling,
  useBookedBy,
  useFolioIndex,
  SendToField,
  useIssueAndSend,
  useSendInvoice,
  useSendTo,
} from "./s8-parts";
import { Help } from "@/components/ds/help";

/* ------------------------------------------------------------------ vocabulary */

/**
 * What a charge after departure is — each maps to a line type the backend stores, the finer kind
 * leading the description (2026-09-18). Minibar, Laundry and Damage used to be sent AS line types,
 * which the folio does not have, so choosing any of them failed with a server error.
 */
const LATE_CHARGE_TYPES = [
  ["OTHER", "Other", "OTHER", null],
  ["F_AND_B", "Food and drink", "F_AND_B", null],
  ["MINIBAR", "Minibar", "F_AND_B", "Minibar"],
  ["LAUNDRY", "Laundry", "SERVICE", "Laundry"],
  ["DAMAGE", "Damage", "OTHER", "Damage"],
] as const;

const COMMISSION_WORD: Record<string, string> = {
  PENDING: "to be paid",
  DUE: "due",
  PAID: "paid",
  CANCELLED: "cancelled",
};

function invoiceLabel(inv: InvoiceSummary) {
  return `${inv.invoiceNumber ?? inv.id}`;
}

/* ------------------------------------------------------------------ the step */

/**
 * The Closed step's tabs (2026-10-26, operator: "a charge found after departure, make it into a
 * proper tab in this stage", and the tax invoice beside it). Like Stay's and Check-out's, a pane is
 * hidden, never unmounted, so a half-typed charge survives a look at This step. Only while the
 * tail is open: a cancelled or expired booking is a record and has none.
 */
export const S9_PANES: StepPane[] = [
  { key: "late", label: "Late charge", cards: [] },
  { key: "invoice", label: "Tax invoice", cards: [] },
];

export function S9Closed({
  entry,
  past,
  close,
  pane = null,
  openPane,
}: {
  entry: EntryDetail;
  past: boolean;
  close: { onClick: () => void; ready: boolean; reason?: string } | null;
  /** Which pane is open — null is This step. */
  pane?: string | null;
  openPane?: (key: string | null) => void;
}) {
  const clock = useHotelClock(60_000);
  // A cancelled or expired booking reaching this page is only a record. A CLOSED one keeps its
  // tail open (Z4): money, a late chit and a write-off are not changes to what was sealed.
  const readOnly = past || entry.status === "CANCELLED" || entry.status === "EXPIRED";
  const tail = !readOnly && !!entry.folio;
  const shown = tail ? (pane ?? null) : null;
  const at = (k: string | null) => (shown === k ? undefined : true);
  return (
    <StepCanvas past={readOnly}>
      <div className="pane" hidden={at(null)}>
        <DisputesCard entry={entry} tz={clock.tz} />
        <WhatTheStayWas entry={entry} />
        {entry.folio ? <OverpaidCard entry={entry} live={!readOnly} /> : null}
        {entry.folio ? <AfterTheStay entry={entry} tz={clock.tz} close={readOnly ? null : close} openPane={tail ? openPane : undefined} /> : null}
        <SealedPapers entry={entry} tz={clock.tz} />
        {entry.status === "CANCELLED" ? <Cancellation entry={entry} /> : null}
      </div>
      {tail ? (
        <>
          <div className="pane" hidden={at("late")}>
            <LateChargePane entry={entry} />
          </div>
          <div className="pane" hidden={at("invoice")}>
            <TaxInvoicePane entry={entry} tz={clock.tz} />
          </div>
        </>
      ) : null}
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ what the stay was (Z1) */

function WhatTheStayWas({ entry }: { entry: EntryDetail }) {
  const billing = useBilling(entry);
  const booked = useBookedBy(entry);
  const co = effectiveCheckOutIso(entry);
  const ci = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  const nights = nightsOf(ci, co);
  const roomNumbers = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  const stayTotal = billing.data?.stayTotal ?? null;
  const passes = entry.segmentNumber ?? 1;
  const [showLines, setShowLines] = useState(false);
  const fo = billing.data?.folio ?? null;
  const roomNumberById = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  // A no-show never stayed — the card says what was booked instead (2026-09-18).
  const noShow = entry.folio?.state === "NO_SHOW_CLOSED";
  return (
    <StepCard title={noShow ? "What was booked" : "What the stay was"}>
      <div className="grid4" style={{ gap: "12px 24px" }}>
        <div>
          <div className="meta">Stay</div>
          <div>
            <b>
              {fmtRange(ci, co)}
              {nights ? ` · ${plural(nights, "night")}` : ""}
            </b>
          </div>
          <div className="meta">
            {noShow
              ? "a no-show — the guest never arrived"
              : entry.earlyDeparture
                ? `left early · booked to ${fmtDay(entry.earlyDeparture.originalCheckOutDate)}`
                : passes > 1
                  ? `${plural(passes, "pass", "passes")} — changed along the way`
                  : "as booked"}
          </div>
        </div>
        <div>
          <div className="meta">Rooms</div>
          <div>
            <b>{roomNumbers.length ? roomNumbers.join(", ") : entry.numberOfRooms ?? "—"}</b>
          </div>
          <div className="meta">{entry.guestCount != null ? plural(entry.guestCount, "guest") : "—"}</div>
        </div>
        <div>
          <div className="meta">Booked by</div>
          <div>
            <b>{booked.party ?? booked.guest}</b>
          </div>
          <div className="meta">{booked.kind}</div>
        </div>
        <div>
          <div className="meta">Rate</div>
          <div>
            <b className="money">{entry.reservation ? rateWords(billing.data, entry.reservation.frozenRate, cur) : "—"}</b>
          </div>
          <div className="meta">
            {entry.reservation ? "as confirmed" : "never confirmed"}
            {stayTotal?.amount != null ? ` · stay ${money(stayTotal.amount, cur)}` : ""}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <BillByPart billing={billing.data} loading={billing.isLoading} totalOnly />
      </div>
      <p className="sm" style={{ marginTop: 6 }}>
        <Help label="About the bill by category">The bill split into rooms, food and drink, and services is on the master bill, under Sealed papers.</Help>{" "}
        {entry.folio ? (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setShowLines((v) => !v);
            }}
          >
            {showLines ? "hide the lines" : "show every line"}
          </a>
        ) : null}
      </p>
      {showLines && entry.folio ? (
        <Tool inert={false}>
          <FolioLinesTable
            lines={entry.folio.lines ?? []}
            roomNumberById={roomNumberById}
            perRoomCharges={fo?.perRoomCharges ?? null}
            perSpaceCharges={fo?.perSpaceCharges ?? null}
            spaceNameById={spaceNamesFromAllocations(entry.spaceAllocations)}
            unassignedCharges={fo?.unassignedCharges ?? null}
            chargeBreakdown={fo?.chargeBreakdown ?? null}
            balance={fo?.outstandingBalance ?? entry.folio.outstandingBalance ?? null}
            currency={cur}
            emptyText="No charges on this bill"
          />
        </Tool>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the invoices, read once */

/** The tax invoices on the bill and what they cover — read by This step and the Tax invoice tab. */
function useInvoiceFacts(entry: EntryDetail, tz: string) {
  const day = useHotelDay();
  const folio = entry.folio;
  const invoices = useMemo(() => [...(folio?.invoices ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [folio?.invoices]);
  const finals = invoices.filter((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED");
  const lastSent = finals.filter((i) => i.dispatchedAt).sort((a, b) => (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? ""))[0] ?? null;
  // Days since the tax invoice went out, on the hotel's calendar — day counting, not money.
  const sentYmd = lastSent?.dispatchedAt ? instantYmd(lastSent.dispatchedAt, tz) : null;
  const ageDays = sentYmd && day ? nightsOf(sentYmd, day.today) : null;
  // A charge found after departure, posted after the last tax invoice went out — that invoice
  // does not carry it (2026-09-18).
  const lateSinceInvoice =
    !!lastSent?.dispatchedAt && (folio?.lines ?? []).some((l) => l.isPostStay && (l.postedAt ?? "") > (lastSent.dispatchedAt ?? ""));
  return { invoices, finals, lastSent, ageDays, lateSinceInvoice };
}

/* ------------------------------------------------------------------ after the stay (Z3, Z4) */

function AfterTheStay({
  entry,
  tz,
  close,
  openPane,
}: {
  entry: EntryDetail;
  tz: string;
  close: { onClick: () => void; ready: boolean; reason?: string } | null;
  openPane?: (key: string | null) => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const fom = atLeast(session?.actorLevel, "L2");
  const gm = atLeast(session?.actorLevel, "L3");
  const folio = entry.folio!;
  const pay = usePaymentStatus(entry.id, { enabled: true });
  const fin = deriveFinancials(entry, { paymentStatus: pay.data });
  const billing = useBilling(entry);
  const booked = useBookedBy(entry);
  const comms = useCommunications(entry.id);
  const inv = useInvoiceFacts(entry, tz);
  const ps = pay.data;
  const cur = billing.data?.currency ?? fin.currency;
  const outstanding = fin.outstanding;
  const sealed = entry.status === "CLOSED";
  // A no-show's folio closed at the decision with its charge on it (2026-09-18).
  const noShow = folio.state === "NO_SHOW_CLOSED";
  const writtenOff = folio.state === "WRITTEN_OFF";
  const owed = outstanding != null && outstanding > 0 && !writtenOff;
  const writeOff = (folio.writeOffRecords ?? [])[0] ?? null;

  // Answer before money (the backend refuses a payment while the tax invoice's answer is open).
  const finalComm = latestDispatched(comms.data?.items, "FINAL_INVOICE");
  const answerPending = !!finalComm && finalComm.acknowledgementStatus !== "RECEIVED";

  const h5 = (entry.handoffs ?? []).find((h) => h.handoffType === "H5") ?? null;
  const h5Open = !!h5 && (h5.state === "CREATED" || h5.state === "ASSIGNED" || h5.state === "ACCEPTED");
  // Where the room inspection stands, read from the backend's closure checks (2026-09-18).
  const closure = useClosureReadiness(entry.id, !sealed && entry.currentStage === "S9");
  // Each room's inspection (2026-10-26 — one per room).
  const inspRooms = closure.data?.inspections?.rooms ?? [];
  const commissions = entry.commissionDueRecords ?? [];
  const followUps = entry.followUpTasks ?? [];

  const [paying, setPaying] = useState(false);
  const [writing, setWriting] = useState(false);
  const [byPart, setByPart] = useState(false);
  const [h5Basis, setH5Basis] = useState("Nothing left to settle");

  const h5Done = useMutation({
    mutationFn: () => fulfilHandoff(session!, h5!.id, { resolutionBasis: h5Basis.trim() }),
    onSuccess: () => {
      toast.success("The after-stay handoff is done");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The after-stay handoff could not be completed"),
  });

  const { finals, lastSent, ageDays, lateSinceInvoice } = inv;
  const whereItSits = writtenOff ? (
    <>
      written off
      {writeOff ? (
        <span className="meta">
          {" "}
          · {money(writeOff.writtenOffAmount, writeOff.currency)} · {fmtInstantDate(writeOff.createdAt, tz)} · “{writeOff.reason}”
        </span>
      ) : null}
    </>
  ) : folio.state === "NO_SHOW_CLOSED" ? (
    "closed as a no-show"
  ) : folio.state === "SETTLED" ? (
    "settled"
  ) : folio.state === "OUTSTANDING" ? (
    <>
      {lateSinceInvoice ? (
        <span className="warn-ink">a charge found after departure isn&rsquo;t on the tax invoice sent {fmtInstantDate(lastSent!.dispatchedAt, tz)} — issue a new one on the Tax invoice tab</span>
      ) : lastSent ? (
        `tax invoice sent ${fmtInstantDate(lastSent.dispatchedAt, tz)} · not yet paid`
      ) : finals.length ? (
        "tax invoice issued, not yet sent"
      ) : (
        "no tax invoice yet"
      )}
      {ageDays ? ` · ${plural(ageDays, "day")} ago` : ""}
      {ps?.creditExtensionExpiresAt ? (
        <span className={ps.creditExtensionExpired && !ps.creditExtensionActive ? "warn-ink" : "meta"}>
          {" "}
          · pay by {fmtDateTime(ps.creditExtensionExpiresAt, tz)}
          {ps.creditExtensionExpired && !ps.creditExtensionActive ? " — the date has passed" : ""}
        </span>
      ) : null}
    </>
  ) : (
    FOLIO_STATE_WORD[folio.state] ?? words(folio.state)
  );

  return (
    <StepCard
      title="After the stay"
      meta="Money that comes in after the guest has left, a charge found later and a write-off are all recorded here — the booking is not reopened for any of them."
      status={
        writtenOff ? (
          <span className="ok-ink">Nothing owing — written off</span>
        ) : owed ? (
          <span className={ps?.creditExtensionExpired && !ps?.creditExtensionActive ? "stop-ink" : "warn-ink"}>Owed by {booked.payer}</span>
        ) : outstanding != null ? (
          <span className="ok-ink">Nothing owing</span>
        ) : undefined
      }
    >
      <BillFigures fo={billing.data?.folio ?? null} cur={cur} />
      <Live>
        <ActTiles
          label="What can be done after the stay"
          items={[
            {
              key: "pay",
              label: "Record a payment",
              primary: owed,
              icon: "check",
              sub: owed ? `${money(outstanding, cur)} still owed` : "nothing owed",
              tone: owed ? "danger" : "success",
              onClick: fom && inv.invoices.length ? () => setPaying(true) : undefined,
              reason: !fom ? "the FOM records payments after the stay" : !inv.invoices.length ? "issue a tax invoice first — the payment is matched to it" : undefined,
            },
            {
              key: "parts",
              label: byPart ? "Hide who owes what" : "Who owes what",
              sub: "each room or hall's share",
              pressed: byPart,
              onClick: () => setByPart((v) => !v),
            },
            {
              key: "late",
              label: "Late charge",
              sub: "a charge found after the guest left",
              onClick: openPane && fom && !noShow ? () => openPane("late") : undefined,
              reason: noShow ? "a no-show never stayed" : !fom ? "needs the FOM" : undefined,
            },
            {
              key: "invoice",
              label: "Tax invoice",
              sub: lateSinceInvoice ? "a late charge isn't on it yet" : lastSent ? `${invoiceLabel(lastSent)} sent` : finals.length ? "issued, not sent" : "none yet",
              tone: lateSinceInvoice || (!lastSent && !noShow) ? "warning" : undefined,
              onClick: openPane ? () => openPane("invoice") : undefined,
            },
            {
              key: "writeoff",
              label: "Write off",
              sub: "money that won't be collected",
              onClick: gm && folio.state === "OUTSTANDING" ? () => setWriting(true) : undefined,
              reason: !gm ? "only the GM can write off" : folio.state !== "OUTSTANDING" ? "nothing is owed to write off" : undefined,
            },
            {
              key: "credit",
              label: "Credit note",
              reason: "not possible once the bill is settled",
            },
          ]}
        />
        {byPart ? (
          <Tool>
            <SplitSettlementBlock entry={entry} folioId={folio.id} defaultOpen />
          </Tool>
        ) : null}
      </Live>

      <Facts wide>
        <Fact k="Sealed">
          <span>
            {sealed
              ? entry.closedAt
                ? fmtDateTime(entry.closedAt, tz)
                : "sealed — the close time was not recorded"
              : entry.status === "CANCELLED"
                ? "cancelled — the record is read-only"
                : entry.status === "EXPIRED"
                  ? "expired — the record is read-only"
                  : "not yet — the record is still open"}
          </span>
        </Fact>
        <Fact k="The bill">{whereItSits}</Fact>
        {finalComm ? (
          <Fact k="Their answer">
            <AnswerLine entryId={entry.id} type="FINAL_INVOICE" what="the tax invoice" tz={tz} />
          </Fact>
        ) : null}
        <Fact k="Payments">
          {(folio.payments ?? []).length ? (
            <div style={{ display: "grid", gap: 2 }}>
              {(folio.payments ?? []).map((p) => (
                <span key={p.id} className="sm">
                  <span className="money">{money(p.amount, p.currency)}</span>
                  <span className="meta">
                    {" "}
                    · {p.paymentDirection === "OUT" ? "refunded · " : ""}
                    {p.receivedAt ? `${fmtInstantDate(p.receivedAt, tz)} · ` : ""}
                    {p.id}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            "none"
          )}
        </Fact>
        {owed && ps?.creditExtensionActive ? (
          <Fact k="Credit">
            allowed at check-out — up to <span className="money">{money(ps.ceilingAmount, cur)}</span>
            <span className="meta">{ps.creditExtensionExpiresAt ? ` · pay by ${fmtDateTime(ps.creditExtensionExpiresAt, tz)}` : " · no date set"}</span>
          </Fact>
        ) : null}
        <Fact k="What closing does">
          {noShow ? (
            sealed ? (
              "the record is locked · the no-show charge was invoiced · a no-show is not asked for feedback"
            ) : (
              <>
                locks the record · invoices the no-show charge
                <Help label="About closing">
                  Closing locks the record so nothing on it can be changed, and invoices the no-show charge — unless a tax invoice was already
                  issued and sent on the Tax invoice tab.
                </Help>
              </>
            )
          ) : sealed ? (
            "the record is locked · the rooms went to housekeeping · the feedback request, any payment reminders and record keeping are handled by the system"
          ) : (
            <>
              locks the record · feedback · payment reminders · record keeping
              <Help label="About closing">
                Closing locks the record so nothing on it can be changed. After that the system sends the guest a feedback request, reminds
                about any money still owed, and keeps the record for as long as the hotel must.
              </Help>
            </>
          )}
        </Fact>
        {commissions.length || followUps.length ? (
          <Fact k="Follow-up">
            <div style={{ display: "grid", gap: 2 }}>
              {commissions.map((c) => (
                <span key={c.id} className="sm">
                  Commission to the agent · {COMMISSION_WORD[c.status] ?? words(c.status)}
                  {c.calculatedAmount != null ? <span className="money"> · {money(c.calculatedAmount, c.currency)}</span> : null}
                </span>
              ))}
              {followUps.map((t) => (
                <span key={t.id} className="sm">
                  Follow-up due {fmtInstantDate(t.dueAt, tz)}
                  {t.completedAt ? <span className="meta"> · done</span> : null}
                </span>
              ))}
            </div>
          </Fact>
        ) : null}
        {h5 ? (
          <Fact k="The last handoff">
            {h5Open ? (
              <div style={{ display: "grid", gap: 6 }}>
                <span>
                  {HANDOFF_STATE_WORD[h5.state] ?? words(h5.state)}
                  <Help label="About the last handoff">It is done once the money is all in, written off, or there is nothing left to do.</Help>
                </span>
                <Live>
                  <div className="row-acts">
                    <input className="input" style={{ flex: 1, minWidth: 220 }} value={h5Basis} onChange={(e) => setH5Basis(e.target.value)} />
                    <Button
                      kind="secondary"
                      compact
                      state={h5Done.isPending ? "working" : h5Basis.trim() ? "default" : "inert"}
                      title={h5Basis.trim() ? undefined : "say what settled it"}
                      workingLabel="Recording…"
                      onClick={() => h5Done.mutate()}
                    >
                      Mark it done
                    </Button>
                  </div>
                </Live>
              </div>
            ) : (
              <span>{HANDOFF_STATE_WORD[h5.state] ?? words(h5.state)}</span>
            )}
          </Fact>
        ) : null}
        {/* The rooms put off at check-out (or never inspected), as tiles, each finished here or its
            window closed by the FOM (2026-10-26). Nothing shows when every room was inspected at
            check-out. */}
        {inspRooms.some((r) => r.state !== "DONE" || (entry.roomInspectionRecords ?? []).some((i) => i.roomId === r.roomId && i.isDeferred)) ? (
          <Fact k={inspRooms.length > 1 ? "The inspections" : "The inspection"}>
            <Live>
              <RoomInspectionGrid entry={entry} live={!sealed && entry.currentStage === "S9"} atClosed fom={fom} />
            </Live>
          </Fact>
        ) : null}
      </Facts>

      {close && !sealed ? (
        <Live>
          <div className="row-acts" style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <Button icon="lock" state={close.ready ? "default" : "inert"} reason={close.ready ? undefined : close.reason} onClick={close.onClick}>
              Close &amp; seal the record
            </Button>
          </div>
        </Live>
      ) : null}

      <RecordPayment entry={entry} open={paying} onClose={() => setPaying(false)} invoices={inv.invoices} outstanding={outstanding} answerPending={answerPending} currency={cur} payer={booked.payer} />
      <WriteOff entry={entry} open={writing} onClose={() => setWriting(false)} outstanding={outstanding} currency={cur} payer={booked.payer} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ the Late charge tab */

function LateChargePane({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const fom = atLeast(session?.actorLevel, "L2");
  const billing = useBilling(entry);
  const fo = billing.data?.folio ?? null;
  const cur = billing.data?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";
  const noShow = entry.folio?.state === "NO_SHOW_CLOSED";
  return (
    <>
      <StepCard title="The bill" status={fo ? `${plural(fo.lineCount, "line")} on the bill` : undefined}>
        <BillFigures fo={fo} cur={cur} />
        <div style={{ marginTop: 12 }}>
          <BillLines entry={entry} onTab={() => undefined} />
        </div>
      </StepCard>
      {noShow ? (
        <StepCard
          title="A charge found after departure"
          status={<span className="warn-ink">A no-show never stayed — its bill closed with the no-show charge, so nothing more can be added.</span>}
        />
      ) : !fom ? (
        <ShutWay act="Post the charge" why="Adding a charge after the guest has left needs the FOM." />
      ) : (
        <InlineWay render={(done) => <LateCharge entry={entry} open onClose={done} />} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ the Tax invoice tab */

function TaxInvoicePane({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const booked = useBookedBy(entry);
  const send = useSendInvoice(entry);
  const [sendTo, setSendTo] = useSendTo(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const { invoices, finals, lastSent, lateSinceInvoice } = useInvoiceFacts(entry, tz);
  const others = invoices.filter((i) => i.invoiceType !== "FINAL");
  const row = (inv: InvoiceSummary) => (
    <div key={inv.id} className="row-acts sm">
      <span className={inv.state === "SUPERSEDED" ? "meta" : undefined}>
        <b>{invoiceLabel(inv)}</b> · {INVOICE_TYPE_WORD[inv.invoiceType] ?? words(inv.invoiceType)} · {INVOICE_STATE_WORD[inv.state] ?? words(inv.state)}
        {inv.dispatchedAt ? (
          <span className="meta">
            {" "}
            · {inv.metadata?.issuedAtNoShowClosure
              ? `issued at closing for the no-show charge ${fmtInstantDate(inv.dispatchedAt, tz)} · not emailed — the no-show notice told them`
              : `sent ${fmtInstantDate(inv.dispatchedAt, tz)} · ${sentWords(inv.dispatchedTo, entry, booked.party)}`}
          </span>
        ) : null}
      </span>
      <Button
        kind="quiet"
        compact
        icon="eye"
        onClick={() =>
          setPaper(
            inv.invoiceType === "FINAL"
              ? { kind: "invoice", id: inv.id, issued: true, label: `Tax invoice ${invoiceLabel(inv)}` }
              : { kind: "invoice", id: inv.id, frozen: !!inv.pdfStorageKey, label: `${words(INVOICE_TYPE_WORD[inv.invoiceType] ?? inv.invoiceType)} ${invoiceLabel(inv)}` },
          )
        }
      >
        Preview
      </Button>
      <Button kind="quiet" compact icon="file" onClick={() => session && openInvoicePdf(session, inv.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}>
        PDF
      </Button>
      {/* Only a tax invoice is sent after the stay. A proforma or an interim bill that never went
          out is history (2026-09-18). */}
      {inv.state === "DRAFT" && inv.invoiceType === "FINAL" ? (
        <Live>
          <Button compact icon="send" state={send.isPending ? "working" : "default"} workingLabel="Sending…" onClick={() => send.mutate({ invoiceId: inv.id, to: sendTo })}>
            Send it
          </Button>
        </Live>
      ) : null}
    </div>
  );
  return (
    <>
      <StepCard
        title="Tax invoice"
        meta="The tax invoice is the official bill, with its own number, that whoever pays keeps for tax (GST). It is made once for the bill as it stands and never changes afterwards. A new one is needed only when the bill changed after the last one went out — for example a charge found after departure — or when none was issued at check-out."
        status={
          lateSinceInvoice ? (
            <span className="warn-ink">
              A charge was added after {invoiceLabel(lastSent!)} went out — it isn&rsquo;t on that invoice. Issue a new one below.
            </span>
          ) : lastSent ? (
            <span className="ok-ink">
              {invoiceLabel(lastSent)} covers the bill as it stands · sent {fmtInstantDate(lastSent.dispatchedAt, tz)}
            </span>
          ) : finals.length ? (
            <span className="warn-ink">Issued but not sent yet — send it from its row.</span>
          ) : (
            <span className="warn-ink">No tax invoice yet — issue one below.</span>
          )
        }
      >
        {finals.length ? <div style={{ display: "grid", gap: 4 }}>{finals.map(row)}</div> : null}
        {finals.some((i) => i.state === "DRAFT") ? (
          <Live>
            <div className="form2" style={{ marginTop: 6 }}>
              <SendToField entry={entry} value={sendTo} onChange={setSendTo} />
            </div>
          </Live>
        ) : null}
        {others.length ? (
          <details className="fold" style={{ marginTop: 10 }}>
            <summary>Earlier bills · {others.length}</summary>
            <div className="fold-body" style={{ display: "grid", gap: 4 }}>
              {others.map(row)}
            </div>
          </details>
        ) : null}
      </StepCard>
      <Live>
        <InlineWay render={(done) => <IssueTaxInvoice entry={entry} onDone={done} hasOne={!!lastSent && !lateSinceInvoice} />} />
      </Live>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </>
  );
}

function IssueTaxInvoice({ entry, onDone, hasOne }: { entry: EntryDetail; onDone: () => void; hasOne: boolean }) {
  const booked = useBookedBy(entry);
  const issueSend = useIssueAndSend(entry, "final-v1");
  const [sendTo, setSendTo] = useSendTo(entry);
  return (
    <DsDialog
      open
      onClose={onDone}
      title="Issue and send a new tax invoice"
      caseLines={[<b key="p">{booked.payer}</b>, entry.id]}
      busy={issueSend.isPending}
      footer={
        <>
          <NotNow onClick={onDone} busy={issueSend.isPending} />
          <Button icon="lock" state={issueSend.isPending ? "working" : "default"} workingLabel="Issuing…" onClick={() => issueSend.mutate(sendTo, { onSettled: onDone })}>
            Issue and send
          </Button>
        </>
      }
    >
      {hasOne ? <p className="sm warn-ink">The last tax invoice already covers the bill as it stands — a new one would show the same figures.</p> : null}
      <p className="sm">This cannot be undone:</p>
      <ul className="plain-list sm" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
        <li>A tax invoice is made for the bill as it stands now, with a new number.</li>
        <li>It is emailed straight away, and their answer is waited for like any paper.</li>
        <li>An invoice sent before stays exactly as it was — that is the file they received.</li>
      </ul>
      <div className="form2" style={{ marginTop: 10 }}>
        <SendToField entry={entry} value={sendTo} onChange={setSendTo} />
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ record a payment */

/** How money arrives after the stay — the guest has gone, so a transfer is the usual way. */
const POST_STAY_METHODS = [
  ["BANK_TRANSFER", "Bank transfer"],
  ["MOBILE_PAYMENT", "Mobile payment (QR)"],
  ["CARD", "Card (POS terminal)"],
  ["CASH", "Cash"],
] as const;

function RecordPayment({
  entry,
  open,
  onClose,
  invoices,
  outstanding,
  answerPending,
  currency,
  payer,
}: {
  entry: EntryDetail;
  open: boolean;
  onClose: () => void;
  invoices: InvoiceSummary[];
  outstanding: number | null;
  answerPending: boolean;
  currency: string;
  payer: string;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  // Money is matched only against an invoice that went out — one sent, or one already taking
  // payments (a second instalment). A superseded or never-sent paper is not offered: the backend
  // refuses it (2026-09-18).
  const payable = invoices.filter((i) => i.state === "DISPATCHED" || i.state === "PAYMENT_TRACKED");
  const preferred = payable.find((i) => i.invoiceType === "FINAL") ?? payable[0] ?? null;
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
  const [method, setMethod] = useState<(typeof POST_STAY_METHODS)[number][0]>("BANK_TRANSFER");
  // The amount starts at what is still owed (the common case — the rest arriving); edit it down
  // for a part-payment. Latched on the first keystroke so a refetch never overwrites it.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    if (outstanding != null && outstanding > 0) setAmount(String(outstanding));
  }, [outstanding]);
  useEffect(() => {
    if (open && !invoiceId && preferred) setInvoiceId(preferred.id);
  }, [open, invoiceId, preferred]);
  // Each opening starts from what is still owed (2026-09-18): the dialog stays mounted, so a
  // second instalment used to re-send the first one's typed amount and reference.
  useEffect(() => {
    if (!open) return;
    touched.current = false;
    setRef("");
    setAmount(outstanding != null && outstanding > 0 ? String(outstanding) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening
  }, [open]);
  const target = invoiceId || preferred?.id || "";
  const targetState = payable.find((i) => i.id === target)?.state ?? null;
  const n = Number.parseFloat(amount);

  const tracked = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Choose the invoice the money is for");
      const body: Parameters<typeof recordInvoicePaymentEvent>[2] = {
        nextState: "PAYMENT_TRACKED",
        paymentMethod: method,
        referenceNumber: ref.trim() || undefined,
      };
      if (Number.isFinite(n) && n > 0) body.amount = n;
      return recordInvoicePaymentEvent(session!, target, body);
    },
    onSuccess: () => {
      toast.success("The payment is on record");
      onClose();
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The payment could not be recorded"),
  });
  const reconciled = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Choose the invoice");
      return recordInvoicePaymentEvent(session!, target, { nextState: "RECONCILED" });
    },
    onSuccess: () => {
      toast.success("The invoice is reconciled");
      onClose();
      refresh();
    },
    onError: (e) => toastRefusal(e, "The invoice could not be reconciled"),
  });
  const busy = tracked.isPending || reconciled.isPending;

  return (
    <DsDialog
      open={open}
      onClose={onClose}
      title="Record a payment"
      caseLines={[<b key="p">{payer}</b>, outstanding != null ? `${money(outstanding, currency)} still owed` : entry.id]}
      help="Mark it reconciled once all the money for this invoice is in — nothing more is chased for it."
      busy={busy}
      footer={
        <>
          <Button kind="quiet" state={busy ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            kind="secondary"
            state={reconciled.isPending ? "working" : busy || !target || targetState !== "PAYMENT_TRACKED" ? "inert" : "default"}
            title={target && targetState !== "PAYMENT_TRACKED" ? "record a payment against it first" : undefined}
            workingLabel="Working…"
            onClick={() => reconciled.mutate()}
          >
            Mark it reconciled
          </Button>
          <Button
            state={tracked.isPending ? "working" : busy || !target || answerPending ? "inert" : "default"}
            title={answerPending ? "record their answer to the tax invoice first" : undefined}
            workingLabel="Recording…"
            onClick={() => tracked.mutate()}
          >
            Record the payment
          </Button>
        </>
      }
    >
      {answerPending ? (
        <p className="sm warn-ink">Their answer to the tax invoice is not on record yet — record what they said first, then the money.</p>
      ) : null}
      <div className="form2">
        <div className="wide field">
          <label>For the invoice</label>
          <select className="input" value={target} onChange={(e) => setInvoiceId(e.target.value)} disabled={answerPending || !payable.length}>
            {payable.length ? null : <option value="">no invoice has gone out yet — send the tax invoice first</option>}
            {payable.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {invoiceLabel(inv)} · {INVOICE_TYPE_WORD[inv.invoiceType] ?? words(inv.invoiceType)} · {INVOICE_STATE_WORD[inv.state] ?? words(inv.state)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Received · Nu.
            <Help label="About the amount">What is still owed, unless you type less.</Help>
          </label>
          <input
            className="input money"
            inputMode="decimal"
            value={amount}
            disabled={answerPending}
            onChange={(e) => {
              touched.current = true;
              setAmount(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label>How it came in</label>
          <select className="input" value={method} disabled={answerPending} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {POST_STAY_METHODS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Reference</label>
          <input className="input" value={ref} disabled={answerPending} placeholder="the transaction reference" onChange={(e) => setRef(e.target.value)} />
        </div>
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ write off */

function WriteOff({
  entry,
  open,
  onClose,
  outstanding,
  currency,
  payer,
}: {
  entry: EntryDetail;
  open: boolean;
  onClose: () => void;
  outstanding: number | null;
  currency: string;
  payer: string;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [amount, setAmount] = useState("");
  // Starts at what is still owed — writing off the rest is the usual case; type less for a part
  // (2026-09-18: it opened empty and the lock blamed the reason).
  useEffect(() => {
    if (open) setAmount(outstanding != null && outstanding > 0 ? String(outstanding) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening
  }, [open]);
  const n = Number.parseFloat(amount);
  const ok = amount.trim() !== "" && Number.isFinite(n) && n > 0;
  const run = useMutation({
    mutationFn: (reason: string) => writeOffOutstanding(session!, entry.folio!.id, { amount: n, reason }),
    onSuccess: () => {
      toast.success("Written off — the bill reads written off");
      onClose();
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The write-off was refused"),
  });
  return (
    <ReasonDialog
      open={open}
      onClose={onClose}
      danger
      title="Write off"
      caseLines={[<b key="p">{payer}</b>, outstanding != null ? `${money(outstanding, currency)} still owed` : entry.id]}
      lead="Only the GM writes off money that won't be collected, up to the limit the hotel has set for one write-off. The amount, the reason, who and when are kept."
      reasonLabel="Why"
      placeholder="the agency ceased trading"
      confirmLabel="Write off"
      extraValid={ok}
      extraReason="put in the amount to write off"
      busy={run.isPending}
      onConfirm={(reason) => run.mutate(reason)}
    >
      <div className="field">
        <label>Amount · Nu.</label>
        <input className="input money" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
      </div>
    </ReasonDialog>
  );
}

/* ------------------------------------------------------------------ a charge found after departure */

function LateCharge({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [type, setType] = useState<(typeof LATE_CHARGE_TYPES)[number][0]>("OTHER");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  useEffect(() => {
    if (open) {
      setType("OTHER");
      setDesc("");
      setAmount("");
    }
  }, [open]);
  const n = Number.parseFloat(amount);
  // A charge is a positive amount — a credit on a settled bill is an adjustment note (2026-09-18).
  const amountOk = amount.trim() !== "" && Number.isFinite(n) && n > 0;
  const ok = amountOk && desc.trim() !== "";
  const kind = LATE_CHARGE_TYPES.find((t) => t[0] === type) ?? LATE_CHARGE_TYPES[0];
  const run = useMutation({
    mutationFn: () =>
      postStayCharge(session!, entry.folio!.id, {
        entryId: entry.id,
        lineType: kind[2],
        description: kind[3] ? `${kind[3]} · ${desc.trim()}` : desc.trim(),
        amount: n,
        // The instant it was found; the backend dates the line on the hotel's calendar.
        postedAt: new Date().toISOString(),
        isPostStay: true,
      }),
    onSuccess: (r) => {
      const total = r?.total != null ? ` — ${money(Number(r.total), "Nu.")} with service charge and GST` : "";
      toast.success(`The charge is posted${total}`);
      if (r?.notice?.sent) toast.success(`The notice was emailed to ${r.notice.to}`);
      else toast.warning("The notice could not be emailed — there is no address on file. Tell them another way.");
      onClose();
      refresh([["settlement-targets"], ["entry-communications", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The charge could not be posted"),
  });
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      title="A charge found after departure"
      caseLines={[entry.id]}
      help="A late bill from the restaurant, a minibar count, or damage found after the room was cleaned. It is added to the bill with its service charge and GST, and whoever pays is emailed a notice. The booking stays closed."
      busy={run.isPending}
      footer={
        <>
          <NotNow onClick={onClose} busy={run.isPending} />
          <Button
            state={run.isPending ? "working" : ok ? "default" : "inert"}
            reason={ok ? undefined : amount.trim() !== "" && !amountOk ? "a charge must be more than zero" : "say what it was and the amount first"}
            workingLabel="Posting…"
            onClick={() => run.mutate()}
          >
            Post the charge
          </Button>
        </>
      }
    >
      <div className="form2">
        <div className="field">
          <label>What it is</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {LATE_CHARGE_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Amount · Nu.</label>
          <input className="input money" inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="wide field">
          <label>What it was</label>
          <input className="input" value={desc} placeholder="breakfast · 2 covers · chit R-1190" onChange={(e) => setDesc(e.target.value)} />
        </div>
      </div>
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ changing a closed booking (Z2) */

/* ------------------------------------------------------------------ sealed papers */

function SealedPapers({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const index = useFolioIndex(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const quote = activeQuotation(entry);
  const invoices = entry.folio?.invoices ?? [];
  const proforma = [...invoices].filter((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const master = index.data?.documents.find((d) => d.kind === "master-bill") ?? null;
  const tax = index.data?.documents.find((d) => d.kind === "tax-invoice") ?? null;
  const issued = tax?.state === "ISSUED" ? tax.invoice : null;
  const keyReturn = (entry.keyReturnRecords ?? [])[0] ?? null;
  const audited = useMemo(
    () =>
      Array.from(new Set((entry.folio?.lines ?? []).filter((l) => l.nightAuditRecordId).map((l) => l.chargeDate.slice(0, 10)))).sort(),
    [entry.folio?.lines],
  );
  const printMaster = () => {
    if (!session) return;
    openFolioDocumentPdf(session, entry.id, "master-bill")
      .then(() => refresh())
      .catch((e) => toastRefusal(e, "The master bill could not be printed"));
  };
  return (
    <StepCard title="Sealed papers" sealed>
      <Facts wide>
        {quote ? <Fact k="Quotation">{quote.referenceNumber}</Fact> : null}
        {proforma ? <Fact k="Proforma">{invoiceLabel(proforma)}</Fact> : null}
        {entry.reservation ? (
          <Fact k="Reservation" meta={`confirmed ${fmtInstantDate(entry.reservation.confirmedAt, tz)}`}>
            {entry.reservation.id}
          </Fact>
        ) : null}
        <Fact k="Tax invoice">
          {issued ? (
            <span className="row-acts sm">
              <span>
                {issued.invoiceNumber ?? issued.id} <span className="meta">· {INVOICE_STATE_WORD[issued.state] ?? words(issued.state)} · the copy that was sent</span>
              </span>
              <Button kind="quiet" compact icon="eye" onClick={() => setPaper({ kind: "invoice", id: issued.id, issued: true, label: `Tax invoice ${issued.invoiceNumber ?? issued.id}` })}>
                Preview
              </Button>
              <Button kind="quiet" compact icon="file" onClick={() => session && openInvoicePdf(session, issued.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}>
                PDF
              </Button>
            </span>
          ) : tax ? (
            <span className="meta">{tax.available ? "not issued" : tax.unavailableReason ?? "not issued"}</span>
          ) : null}
        </Fact>
        <Fact k="Master bill">
          {master?.available ? (
            <span className="row-acts sm">
              <span>
                {master.state === "FROZEN" ? `frozen${master.frozenAt ? ` ${fmtStamp(master.frozenAt, tz)}` : ""}` : "as at now"}
                {master.reprintCount != null ? <span className="meta"> · printed {plural(master.reprintCount, "time")}</span> : null}
              </span>
              <Button
                kind="quiet"
                compact
                icon="eye"
                onClick={() => setPaper({ kind: "folio", entryId: entry.id, doc: "master-bill", label: "Master bill", refreshKey: `${entry.updatedAt}|${index.data?.asAt ?? ""}` })}
              >
                Preview
              </Button>
              <Button kind="quiet" compact icon="print" onClick={printMaster}>
                Print a copy
              </Button>
            </span>
          ) : master ? (
            <span className="meta">{master.unavailableReason ?? "not available"}</span>
          ) : null}
        </Fact>
        <Fact k="Registration">{entry.registrationCompletedAt ? `completed ${fmtStamp(entry.registrationCompletedAt, tz)}` : null}</Fact>
        <Fact k="Keys">{keyReturn ? `${keyReturn.keyCountReturned} of ${keyReturn.keyCountIssued} back${keyReturn.reconciliationNote ? ` · “${keyReturn.reconciliationNote}”` : ""}` : null}</Fact>
        <Fact k="Nights audited">{audited.length ? audited.map((d) => fmtDay(d)).join(", ") : null}</Fact>
      </Facts>
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </StepCard>
  );
}

/* ------------------------------------------------------------------ cancellation */

function Cancellation({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const [paper, setPaper] = useState<PaperRef | null>(null);
  return (
    <DocCard
      name="Cancellation confirmation"
      meta="What was held, what the disclosed terms kept, and what was refunded — the guest's proof of the outcome."
      right={<Chip tone="quiet">cancelled</Chip>}
      acts={
        <>
          <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "cancellation", entryId: entry.id, label: "Cancellation confirmation" })}>
            Preview
          </Button>
          <Button
            kind="quiet"
            compact
            icon="file"
            onClick={() => session && openCancellationConfirmationPdf(session, entry.id).catch((e) => toastRefusal(e, "The PDF could not be opened"))}
          >
            PDF
          </Button>
        </>
      }
    >
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
    </DocCard>
  );
}

