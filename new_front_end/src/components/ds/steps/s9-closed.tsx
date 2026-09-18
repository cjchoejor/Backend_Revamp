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
import {
  AnswerLine,
  DocCard,
  DsDialog,
  Fact,
  Facts,
  Live,
  PaperDrawer,
  PapersCard,
  ReasonDialog,
  SeeRow,
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
} from "./kit";
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
  useIssueAndSend,
  useSendInvoice,
} from "./s8-parts";

/* ------------------------------------------------------------------ vocabulary */

const LATE_CHARGE_TYPES = [
  ["OTHER", "Other"],
  ["F_AND_B", "Food and drink"],
  ["MINIBAR", "Minibar"],
  ["LAUNDRY", "Laundry"],
  ["DAMAGE", "Damage"],
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

export function S9Closed({
  entry,
  past,
  close,
}: {
  entry: EntryDetail;
  past: boolean;
  close: { onClick: () => void; ready: boolean; reason?: string } | null;
}) {
  const clock = useHotelClock(60_000);
  // A cancelled or expired booking reaching this page is only a record. A CLOSED one keeps its
  // tail open (Z4): money, a late chit and a write-off are not changes to what was sealed.
  const readOnly = past || entry.status === "CANCELLED" || entry.status === "EXPIRED";
  return (
    <StepCanvas past={readOnly}>
      <DisputesCard entry={entry} tz={clock.tz} />
      <WhatTheStayWas entry={entry} />
      {entry.folio ? <AfterTheStay entry={entry} tz={clock.tz} close={readOnly ? null : close} /> : null}
      <OneDoorBackIn />
      <SealedPapers entry={entry} tz={clock.tz} />
      {entry.status === "CANCELLED" ? <Cancellation entry={entry} /> : null}
      <PapersCard entry={entry} />
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
  return (
    <StepCard title="What the stay was">
      <div className="grid4" style={{ gap: "12px 24px" }}>
        <div>
          <div className="meta">Stay</div>
          <div>
            <b>
              {fmtRange(ci, co)}
              {nights ? ` · ${plural(nights, "night")}` : ""}
            </b>
          </div>
          <div className="meta">{entry.earlyDeparture ? `left early · booked to ${fmtDay(entry.earlyDeparture.originalCheckOutDate)}` : passes > 1 ? `${plural(passes, "pass", "passes")} — changed along the way` : "as booked"}</div>
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
      <p className="meta" style={{ marginTop: 6 }}>
        By category — rooms, food and drink, services — the master bill shows it; the figures by category are not served to the desk yet ·{" "}
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

/* ------------------------------------------------------------------ after the stay (Z3, Z4) */

function AfterTheStay({ entry, tz, close }: { entry: EntryDetail; tz: string; close: { onClick: () => void; ready: boolean; reason?: string } | null }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const day = useHotelDay();
  const fom = atLeast(session?.actorLevel, "L2");
  const gm = atLeast(session?.actorLevel, "L3");
  const folio = entry.folio!;
  const pay = usePaymentStatus(entry.id, { enabled: true });
  const fin = deriveFinancials(entry, { paymentStatus: pay.data });
  const billing = useBilling(entry);
  const booked = useBookedBy(entry);
  const comms = useCommunications(entry.id);
  const issueSend = useIssueAndSend(entry, "final-v1");
  const send = useSendInvoice(entry);
  const ps = pay.data;
  const cur = billing.data?.currency ?? fin.currency;
  const outstanding = fin.outstanding;
  const sealed = entry.status === "CLOSED";
  const writtenOff = folio.state === "WRITTEN_OFF";
  const owed = outstanding != null && outstanding > 0 && !writtenOff;

  const invoices = useMemo(() => [...(folio.invoices ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [folio.invoices]);
  const finals = invoices.filter((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED");
  const lastSent = finals.filter((i) => i.dispatchedAt).sort((a, b) => (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? ""))[0] ?? null;
  // Days since the tax invoice went out, on the hotel's calendar — day counting, not money.
  const sentYmd = lastSent?.dispatchedAt ? instantYmd(lastSent.dispatchedAt, tz) : null;
  const ageDays = sentYmd && day ? nightsOf(sentYmd, day.today) : null;
  const writeOff = (folio.writeOffRecords ?? [])[0] ?? null;

  // Answer before money (the backend refuses a payment while the tax invoice's answer is open).
  const finalComm = latestDispatched(comms.data?.items, "FINAL_INVOICE");
  const answerPending = !!finalComm && finalComm.acknowledgementStatus !== "RECEIVED";

  const h5 = (entry.handoffs ?? []).find((h) => h.handoffType === "H5") ?? null;
  const h5Open = !!h5 && (h5.state === "CREATED" || h5.state === "ASSIGNED" || h5.state === "ACCEPTED");
  // Where the room inspection stands, read from the backend's closure checks (2026-09-18).
  const closure = useClosureReadiness(entry.id, !sealed && entry.currentStage === "S9");
  const insp = closure.data?.inspection ?? null;
  const wasPutOff = (entry.roomInspectionRecords ?? []).some((i) => i.isDeferred);
  const commissions = entry.commissionDueRecords ?? [];
  const followUps = entry.followUpTasks ?? [];

  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [paying, setPaying] = useState(false);
  const [writing, setWriting] = useState(false);
  const [late, setLate] = useState(false);
  const [issuing, setIssuing] = useState(false);
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
  const [faultFlag, setFaultFlag] = useState<"RESOLVED" | "UNRESOLVED_AT_CHECKOUT">("UNRESOLVED_AT_CHECKOUT");
  const [assessment, setAssessment] = useState("");
  const [damage, setDamage] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");
  const fault = insp?.openFault ?? null;
  const inspectionMissing = fault && faultFlag === "UNRESOLVED_AT_CHECKOUT" && !assessment.trim()
    ? "write what the inspector found"
    : damage && !damageNotes.trim()
      ? "say what is damaged"
      : null;
  const completeInspection = useMutation({
    mutationFn: () =>
      recordRoomInspection(session!, entry.id, {
        isDeferred: false,
        deficientFlagStatus: fault ? faultFlag : "NOT_APPLICABLE",
        deficientConditionId: fault ? fault.id : undefined,
        inspectorAssessment: fault && faultFlag === "UNRESOLVED_AT_CHECKOUT" ? assessment.trim() : undefined,
        damageFound: damage,
        damageNotes: damage ? damageNotes.trim() : undefined,
      }),
    onSuccess: () => {
      toast.success(damage ? "The inspection is on record — post the damage as a late charge below" : "The inspection is on record");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The inspection could not be recorded"),
  });
  const expireInspection = useMutation({
    mutationFn: () => expirePostCheckoutInspectionWindow(session!, entry.id),
    onSuccess: () => {
      toast.success("The inspection window is closed");
      refresh();
    },
    onError: (e) => toastRefusal(e, "The inspection window could not be closed"),
  });

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
      {lastSent ? `tax invoice sent ${fmtInstantDate(lastSent.dispatchedAt, tz)} · not yet paid` : finals.length ? "tax invoice issued, not yet sent" : "not yet invoiced"}
      {ageDays ? ` · ${plural(ageDays, "day")}` : ""}
      {ps?.creditExtensionExpiresAt ? (
        <span className={ps.creditExtensionExpired && !ps.creditExtensionActive ? "warn-ink" : "meta"}>
          {" "}
          · pay by {fmtDateTime(ps.creditExtensionExpiresAt, tz)}
          {ps.creditExtensionExpired && !ps.creditExtensionActive ? " — the date has passed" : ""}
        </span>
      ) : null}
      <span className="meta" title="The account's own payment terms and ageing are not in the backend yet (BE-71)">
        {" "}
        · terms not tracked yet
      </span>
    </>
  ) : (
    FOLIO_STATE_WORD[folio.state] ?? words(folio.state)
  );

  const owingChip = writtenOff ? (
    <Chip tone="success">nothing owing · written off</Chip>
  ) : owed ? (
    <Chip tone={ps?.creditExtensionExpired && !ps?.creditExtensionActive ? "danger" : "warning"}>
      {money(outstanding, cur)} outstanding on {booked.payer}&rsquo;s account
    </Chip>
  ) : outstanding != null ? (
    <Chip tone="success">nothing owing</Chip>
  ) : null;

  return (
    <StepCard title="After the stay">
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
                  : "not yet — the record is still open"} {owingChip ? <>· {owingChip}</> : null}
          </span>
        </Fact>
        <Fact k="Where it sits">{whereItSits}</Fact>
        <Fact k="Invoices">
          {invoices.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              {invoices.map((inv) => (
                <div key={inv.id} className="row-acts sm">
                  <span className={inv.state === "SUPERSEDED" ? "meta" : undefined}>
                    {invoiceLabel(inv)} · {INVOICE_TYPE_WORD[inv.invoiceType] ?? words(inv.invoiceType)} · {INVOICE_STATE_WORD[inv.state] ?? words(inv.state)}
                    {inv.dispatchedAt ? <span className="meta"> · sent {fmtInstantDate(inv.dispatchedAt, tz)}</span> : null}
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
                  {/* Only a tax invoice is sent after the stay. A proforma or an interim bill
                      that never went out is history — sending a pre-arrival bill to a guest who
                      has already paid and left would only confuse them (2026-09-18). */}
                  {inv.state === "DRAFT" && inv.invoiceType === "FINAL" ? (
                    <Live>
                      <Button compact icon="send" state={send.isPending ? "working" : "default"} workingLabel="Sending…" onClick={() => send.mutate(inv.id)}>
                        Send it
                      </Button>
                    </Live>
                  ) : inv.state === "DRAFT" ? (
                    <span className="meta">never sent — not needed after the stay</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            "none issued"
          )}
        </Fact>
        {finalComm ? (
          <Fact k="Their answer">
            <AnswerLine entryId={entry.id} type="FINAL_INVOICE" what="the tax invoice" tz={tz} />
          </Fact>
        ) : null}
        <Fact k="Payments">
          {(folio.payments ?? []).length ? (
            <div style={{ display: "grid", gap: 2 }}>
              {fin.advanceReceived != null ? (
                <span className="sm">
                  <b className="money">{money(fin.advanceReceived, cur)}</b> <span className="meta">received in all</span>
                </span>
              ) : null}
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
          ) : null}
        </Fact>
        {owed && ps?.creditExtensionActive ? (
          <Fact k="Credit">
            extended at check-out — up to <span className="money">{money(ps.ceilingAmount, cur)}</span>
            <span className="meta">{ps.creditExtensionExpiresAt ? ` · pay by ${fmtDateTime(ps.creditExtensionExpiresAt, tz)}` : " · no time limit"}</span>
          </Fact>
        ) : null}
        <Fact k="Set off by the close">
          {sealed
            ? "the record sealed read-only · the rooms released to housekeeping · feedback, payment follow-up and retention handed to the system"
            : "closing seals the record read-only and hands feedback, payment follow-up and retention to the system"}
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
                  {HANDOFF_STATE_WORD[h5.state] ?? words(h5.state)} <span className="meta">· done once the money is matched, written off, or nothing is left to do</span>
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
        {insp?.state === "PUT_OFF" ? (
          <Fact k="The inspection">
            <div style={{ display: "grid", gap: 8 }}>
              <span>
                {insp.roomNumber ? `Room ${insp.roomNumber} · ` : ""}put off at check-out, not yet done
                {insp.windowEndsAt ? <span className="meta"> · the window closes {fmtDateTime(insp.windowEndsAt, tz)}</span> : null}
              </span>
              <Live>
                <div className="bind provisional" style={{ display: "grid", gap: 8 }}>
                  {fault ? (
                    <span className="sm warn-ink">
                      The room has an open fault — {words(fault.category)}: {fault.description}. Say how the inspection leaves it.
                    </span>
                  ) : null}
                  <div className="form2">
                    {fault ? (
                      <div className="field">
                        <label>The room&rsquo;s fault</label>
                        <select className="input" value={faultFlag} onChange={(e) => setFaultFlag(e.target.value as typeof faultFlag)}>
                          <option value="RESOLVED">Put right at inspection</option>
                          <option value="UNRESOLVED_AT_CHECKOUT">Still there</option>
                        </select>
                      </div>
                    ) : null}
                    {fault && faultFlag === "UNRESOLVED_AT_CHECKOUT" ? (
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
                      state={completeInspection.isPending ? "working" : inspectionMissing ? "inert" : "default"}
                      title={inspectionMissing ?? undefined}
                      workingLabel="Recording…"
                      onClick={() => completeInspection.mutate()}
                    >
                      Record the inspection
                    </Button>
                  </div>
                </div>
                {insp.windowCanBeClosed ? (
                  <SeeRow
                    label="Close the inspection window"
                    note="only when nobody inspected the room in time — it records that nothing was found; the FOM's"
                    onClick={fom && !expireInspection.isPending ? () => expireInspection.mutate() : undefined}
                    reason={fom ? undefined : "Closing the inspection window needs the FOM"}
                  />
                ) : null}
              </Live>
            </div>
          </Fact>
        ) : insp?.state === "LAPSED" ? (
          <Fact k="The inspection">
            put off at check-out · the window closed{insp.lapsedAt ? ` ${fmtDateTime(insp.lapsedAt, tz)}` : ""} with nothing recorded
          </Fact>
        ) : insp?.state === "DONE" && wasPutOff ? (
          <Fact k="The inspection">
            inspected after departure
            <span className="meta">
              {insp.inspectedAt ? ` · ${fmtDateTime(insp.inspectedAt, tz)}` : ""}
              {insp.damageFound ? ` · damage noted${insp.damageNotes ? `: ${insp.damageNotes}` : ""}` : " · no damage"}
            </span>
          </Fact>
        ) : null}
      </Facts>

      <Live>
        <div className="stack sm" style={{ display: "grid", gap: 6, marginTop: 14 }}>
          <SeeRow
            kind="primary"
            label="Record a payment"
            note="money arriving is not a change to the record — no re-entry"
            onClick={fom && invoices.length ? () => setPaying(true) : undefined}
            reason={!fom ? "Recording a payment after the stay needs the FOM" : !invoices.length ? "there is no invoice to record it against — issue one first" : undefined}
          />
          <SeeRow
            label={byPart ? "Hide the parts" : "Who still owes what…"}
            note="each room or space and what it still owes — take a payment against one part; the bill stays one"
            onClick={() => setByPart((v) => !v)}
          />
          <SeeRow
            label="Write off…"
            note="the GM, with the amount and a reason; the configured threshold refuses anything above the GM's band"
            onClick={gm && folio.state === "OUTSTANDING" ? () => setWriting(true) : undefined}
            reason={!gm ? "A write-off is the GM's" : folio.state !== "OUTSTANDING" ? "only a bill with money still owed can be written off" : undefined}
          />
          <SeeRow
            label="A charge found after departure…"
            note="the post-stay charge: it posts to the bill and the guest is told — no re-entry"
            onClick={fom ? () => setLate(true) : undefined}
            reason={fom ? undefined : "A charge after departure needs the FOM"}
          />
          <SeeRow
            label="Issue and send a tax invoice…"
            note="for the bill as it stands now — issued and sent in one act"
            onClick={() => setIssuing(true)}
          />
          <SeeRow
            label="Credit note…"
            note="a credit on a settled bill is an adjustment note"
            reason="After settlement a credit is an adjustment note — not in the backend yet (BE-47 · BE-51); the bill takes credit notes only while it is live"
          />
        </div>
        {byPart ? (
          <Tool>
            <SplitSettlementBlock entry={entry} folioId={folio.id} defaultOpen />
          </Tool>
        ) : null}
        {close && !sealed ? (
          <div className="row-acts" style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <Button icon="lock" state={close.ready ? "default" : "inert"} reason={close.ready ? undefined : close.reason} onClick={close.onClick}>
              Close &amp; seal the record
            </Button>
          </div>
        ) : null}
      </Live>

      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      <RecordPayment entry={entry} open={paying} onClose={() => setPaying(false)} invoices={invoices} outstanding={outstanding} answerPending={answerPending} currency={cur} payer={booked.payer} />
      <WriteOff entry={entry} open={writing} onClose={() => setWriting(false)} outstanding={outstanding} currency={cur} payer={booked.payer} />
      <LateCharge entry={entry} open={late} onClose={() => setLate(false)} />
      <DsDialog
        open={issuing}
        onClose={() => setIssuing(false)}
        title="Issue and send a tax invoice"
        caseLines={[<b key="p">{booked.payer}</b>, entry.id]}
        busy={issueSend.isPending}
        footer={
          <>
            <Button kind="quiet" state={issueSend.isPending ? "inert" : "default"} onClick={() => setIssuing(false)}>
              Not now
            </Button>
            <Button
              icon="lock"
              state={issueSend.isPending ? "working" : "default"}
              workingLabel="Issuing…"
              onClick={() => issueSend.mutate(undefined, { onSettled: () => setIssuing(false) })}
            >
              Issue and send
            </Button>
          </>
        }
      >
        <p className="sm">This cannot be undone. What becomes binding:</p>
        <ul className="plain-list sm" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>A tax invoice is issued for the bill as it stands — its number is allocated now.</li>
          <li>It is sent in the same act; its answer is awaited like any paper.</li>
          <li>An invoice already sent stays as it was — the guest received that file.</li>
        </ul>
      </DsDialog>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ record a payment */

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
  const live = invoices.filter((i) => i.state !== "SUPERSEDED");
  const preferred = live.find((i) => i.invoiceType === "FINAL") ?? live[0] ?? invoices[0] ?? null;
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [ref, setRef] = useState("");
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
  const target = invoiceId || preferred?.id || "";
  const n = Number.parseFloat(amount);

  const tracked = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("Choose the invoice the money is for");
      const body: Parameters<typeof recordInvoicePaymentEvent>[2] = { nextState: "PAYMENT_TRACKED", referenceNumber: ref.trim() || undefined };
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
      busy={busy}
      footer={
        <>
          <Button kind="quiet" state={busy ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button kind="secondary" state={reconciled.isPending ? "working" : busy || !target ? "inert" : "default"} workingLabel="Working…" onClick={() => reconciled.mutate()}>
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
          <select className="input" value={target} onChange={(e) => setInvoiceId(e.target.value)} disabled={answerPending}>
            {invoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {invoiceLabel(inv)} · {INVOICE_TYPE_WORD[inv.invoiceType] ?? words(inv.invoiceType)} · {INVOICE_STATE_WORD[inv.state] ?? words(inv.state)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Received · Nu.</label>
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
          <span className="hint">what is still owed, unless you type less</span>
        </div>
        <div className="field">
          <label>Reference</label>
          <input className="input" value={ref} disabled={answerPending} placeholder="the transaction reference" onChange={(e) => setRef(e.target.value)} />
        </div>
      </div>
      <p className="meta">Reconciled means the invoice&rsquo;s money is matched and nothing more is chased.</p>
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
  useEffect(() => {
    if (open) setAmount("");
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
      lead="The GM writes off what will not be collected. The configured threshold refuses anything above the GM's band. Recorded with the amount, the reason, who and when."
      reasonLabel="Why"
      placeholder="the agency ceased trading"
      confirmLabel="Write off"
      extraValid={ok}
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
  const ok = amount.trim() !== "" && Number.isFinite(n) && desc.trim() !== "";
  const run = useMutation({
    mutationFn: () =>
      postStayCharge(session!, entry.folio!.id, {
        entryId: entry.id,
        lineType: type,
        description: desc.trim(),
        amount: n,
        // The instant it was found; the backend dates the line on the hotel's calendar.
        postedAt: new Date().toISOString(),
        isPostStay: true,
      }),
    onSuccess: () => {
      toast.success("The charge is posted and the guest is told");
      onClose();
      refresh([["settlement-targets"]]);
    },
    onError: (e) => toastRefusal(e, "The charge could not be posted"),
  });
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      title="A charge found after departure"
      caseLines={[entry.id]}
      busy={run.isPending}
      footer={
        <>
          <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button state={run.isPending ? "working" : ok ? "default" : "inert"} title={ok ? undefined : "what it was and the amount first"} workingLabel="Posting…" onClick={() => run.mutate()}>
            Post the charge
          </Button>
        </>
      }
    >
      <p className="sm">A late chit, a minibar count, damage found after the room was turned. It posts to the bill and a notice goes to the guest; the record is not re-opened.</p>
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

/* ------------------------------------------------------------------ one door back in (Z2) */

function OneDoorBackIn() {
  return (
    <StepCard
      title="One door back in"
      acts={
        <Live>
          <Button
            kind="quiet"
            compact
            state="inert"
            reason="Re-entry after Closed is the FOM's · opens a new pass · not in the backend yet (the prototype files it under BE-42)"
          >
            Re-enter…
          </Button>
        </Live>
      }
    >
      <p className="sm">
        Anything else — a correction, a dispute raised weeks later, a change of dates for a return — is a <b>governed re-entry</b>: the FOM&rsquo;s authority, a reason, and a new pass the history shows as such. Nothing on a closed booking is ever edited in place.
      </p>
      <p className="meta">The rail&rsquo;s Re-enter menu lists what the backend allows at each step; after Check-out it offers nothing yet.</p>
    </StepCard>
  );
}

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
                {issued.invoiceNumber ?? issued.id} <span className="meta">· {INVOICE_STATE_WORD[issued.state] ?? words(issued.state)} · served from the stored original</span>
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
