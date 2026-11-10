"use client";

/**
 * The booking's own tabs — the same on every step, Inquiry to Closed (2026-10-12, operator, after
 * the boss's journey mockup: "charges & payment, guest request, notes, documents, history — these
 * 5 tabs should be across every stage from stage one itself").
 *
 *   Charges & payments · the price, the bill, the money in — every figure the server's own
 *   Guest requests     · the guest's preference and what they asked us to arrange (BE-64)
 *   Notes              · what the desk wants kept, to-dos with an owner, and the words the
 *                        system kept with each act
 *   Documents          · every paper, every version, and what the guest said back
 *   History            · lives in history-view.tsx
 *
 * What these tabs hold was taken OUT of the steps, the side panel and the header, so nothing on
 * the booking is shown twice (the operator's rule for this pass).
 */
import { payerChoiceWord, payerPartyOf } from "@/lib/ds/payer-words";
import { BookingRateSheet } from "@/components/ds/rate-sheet";
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, EmptyState } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import {
  NOTE_ASSIGNEES,
  addBookingNote,
  addGuestRequest,
  arrangeGuestRequest,
  editBookingNote,
  listBookingNotes,
  listGuestRequests,
  setBookingTodoDone,
  withdrawGuestRequest,
  type BookingNote,
  type GuestRequest,
  type NoteAssignee,
} from "@/lib/api/booking-notes";
import { acknowledgeCommunication, getEntryTrace, replySettled, type EntryBillingSummary, type EntryCommunication } from "@/lib/api/entries";
import { updateInquiryNotes } from "@/lib/api/inquiries";
import { resendConfirmationVoucher } from "@/lib/api/confirmation";
import { fmtDateTime, fmtDay, fmtStamp, fmtStay, hotelFormParts, money, plural } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import { isHousekeeping, traceWords } from "@/lib/ds/trace-words";
import type { TraceEvent } from "@/lib/trace/humanize";
import { StayBand, TripPapersShelf, useTripStays } from "./trip-papers-shelf";
import { useStaysTogether } from "@/components/ds/steps/s2-together";
import { TripMoneyReceived } from "@/components/ds/steps/s3-money";
import { Choice, DsDialog, Fact, Facts, PapersCard, ReasonDialog, StepCard, SubTabs, Tool, atLeast, toastRefusal, useRefreshEntry, NotSentChip } from "@/components/ds/steps/kit";
import { FolioPapersCard } from "@/components/ds/workspace/folio-papers";
import { HeldSendDialog, useHeldDocuments } from "@/components/ds/workspace/held-papers";
import type { HeldDocument } from "@/lib/api/room-moves";
import { PLAN_LABEL, dueLabel } from "@/components/desk/workspace/advance-settlement";
import { useStayPrice, type StayPrice } from "@/lib/ds/stay-price";
import { getQuotationPriceLines, type QuotationLivePreview } from "@/lib/api/quotations";
import { PriceLineRows, PriceLinesHead, PriceLinesTable, type PriceLinesFigures } from "@/components/ds/workspace/price-lines";
import { StayDates } from "@/components/ds/stay-dates";
import { useTripBillView } from "@/components/ds/steps/s1-bill";
import { PickBill, TripPickBill } from "@/components/ds/steps/s1-bill";
import type { EntryDetail } from "@/types/api";
import { Help, HelpHere } from "@/components/ds/help";
import { DateInput, TimeInput } from "@/components/ds/date-input";

export type BookingTab = "money" | "requests" | "notes" | "docs" | "history";

export const BOOKING_TABS: ReadonlyArray<readonly [BookingTab, string]> = [
  ["money", "Charges & payments"],
  ["requests", "Guest requests"],
  ["notes", "Notes"],
  ["docs", "Documents"],
  ["history", "History"],
];

const stepWord = (stage?: string | null) => (stage && /^S[1-9]$/.test(stage) ? STEP_NAMES[stepNoOfStage(stage) - 1] : null);

/* ================================================================== Charges & payments */

type PaymentRow = {
  id: string;
  amount: string | number;
  paymentDirection: string;
  currency: string;
  receivedAt: string;
  notes?: string | null;
  paymentMethod?: string | null;
  stage?: string | null;
};

export const METHOD_WORD: Record<string, string> = {
  CASH: "cash",
  MOBILE_PAYMENT: "QR / mobile",
  BANK_TRANSFER: "bank transfer",
  CARD: "card",
  VOUCHER: "agent's voucher",
  DIRECT_BILL: "on account",
  INWARD_REMITTANCE: "inward remittance",
};

export function ChargesView({
  entry,
  billing,
  tz,
  onPaymentHistory,
}: {
  entry: EntryDetail;
  billing: EntryBillingSummary | null;
  tz: string;
  onPaymentHistory: () => void;
}) {
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  // The price as it stands — the table or the picks while nothing is saved (2026-10-12).
  const sp = useStayPrice(entry, billing);
  // Viewing the stays together, Money received is the trip's (2026-11-09).
  const together = useStaysTogether(entry);
  const tripMoney = together.active && entry.currentStage !== "S2";
  const cur = billing?.currency ?? "BTN";
  const st = billing?.stayTotal ?? null;
  const fo = billing?.folio ?? null;
  const tag = !billing
    ? null
    : st?.earlyDeparture
      ? "shortened stay"
      : st?.frozen
        ? "as confirmed"
        : "indicative — not a promise until it is agreed";
  // Once something was added during the stay, the figure at the top is the stay with it (2026-11-10,
  // operator: "that is where the user will mostly see, so there show the stay with what was added").
  const withAdded = fo?.addedDuringStay && billing?.stayWithAdded != null ? billing.stayWithAdded : null;
  const payments = ((entry.folio?.payments ?? []) as PaymentRow[]).slice().sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
  const paymentsIn = payments.filter((x) => x.paymentDirection !== "OUT").length;
  const balance = fo?.outstandingBalance ?? null;
  const parts = [
    ...(fo?.perRoomCharges ?? []).map((r) => ({ key: `r:${r.roomId}`, label: `Room ${r.roomNumber ?? "—"}`, b: r })),
    ...(fo?.perSpaceCharges ?? []).map((r) => ({ key: `s:${r.spaceId}`, label: r.spaceName ?? "A space", b: r })),
    ...(fo?.unassignedCharges ? [{ key: "none", label: "No room / space", b: fo.unassignedCharges }] : []),
  ];
  const p = pay.data;

  return (
    <>
      <h3>
        Charges &amp; payments <span className="need">the price, the bill and the money in</span>
      </h3>
      <div className="steps-canvas">
        {/* Sub-tabs (2026-10-12, operator): the price, the bill and the money in, one at a time. */}
        <SubTabs
          label="Charges & payments"
          tabs={[
            {
              key: "price",
              label: "The price",
              content: (
                <>
        <StepCard title="The price" status={sp.tableTrip ? undefined : sp.source === "QUOTE" ? (tag ?? undefined) : sp.source === "PICKS" ? undefined : sp.kind || undefined}>
          {sp.tableTrip ? (
            <TripTablePrice sp={sp} />
          ) : sp.source === "TABLE" ? (
            <TablePrice sp={sp} />
          ) : sp.source === "PICKS" ? (
            <PicksPrice sp={sp} />
          ) : st?.amount == null ? (
            <p className="meta">
              {sp.loading
                ? "Pricing what is chosen…"
                : "Nothing priced yet — the price builds up here as rooms are picked at Inquiry, and follows the table at Negotiation."}
            </p>
          ) : (
            <>
              {withAdded != null && fo?.addedDuringStay ? (
                <div className="bigfig" data-stay-with-added>
                  <span className="meta">The stay with what was added</span>
                  <b>{money(withAdded, cur)}</b>
                  <span className="meta bf-parts">
                    the stay {money(st.amount, cur)} + added during the stay {money(fo.addedDuringStay.total, cur)}
                  </span>
                </div>
              ) : (
                <div className="bigfig">
                  <span className="meta">Stay total</span>
                  <b>{money(st.amount, cur)}</b>
                  {st.basis === "PER_NIGHT_TIMES_NIGHTS" && st.perNightAmount != null ? (
                    <span className="meta">
                      {money(st.perNightAmount, cur)} a night{st.nights != null ? ` · ${plural(st.nights, "night")}` : ""}
                    </span>
                  ) : null}
                </div>
              )}
              {st.earlyDeparture ? (
                <p className="meta">
                  Shortened: {st.earlyDeparture.sleptNights} nights slept · {money(st.earlyDeparture.forgoneRoomTotal, cur)} not charged
                </p>
              ) : null}
              {st.quotationId ? (
                <QuotePriceLines quotationId={st.quotationId} rooms={roomsNamed(entry, st.quotationId)} stayTotal={st.amount} currency={cur} />
              ) : billing?.rooms?.length ? (
                <table className="table compact resp" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Nights</th>
                      <th className="num">Room</th>
                      <th className="num">Meals</th>
                      <th className="num">Extra bed</th>
                      <th className="num">Service + GST</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billing.rooms.map((r, i) => (
                      <tr key={r.roomId ?? i}>
                        <td>
                          <b>Room {r.roomNumber ?? "—"}</b>
                          <span className="meta">
                            {r.roomTypeName ? ` · ${r.roomTypeName}` : ""}
                            {r.isFoc ? " · free of charge" : ""}
                          </span>
                        </td>
                        <td data-label="Nights">{r.nights ?? "—"}</td>
                        <td className="num" data-label="Room">{money(r.roomSubtotal, cur)}</td>
                        <td className="num" data-label="Meals">{(r.mealsSubtotal ?? 0) > 0 ? money(r.mealsSubtotal, cur) : "—"}</td>
                        <td className="num" data-label="Extra bed">{r.extraBedCount > 0 ? money(r.extraBedSubtotal, cur) : "—"}</td>
                        <td className="num" data-label="Service + GST">{r.serviceCharge != null || r.gst != null ? money((r.serviceCharge ?? 0) + (r.gst ?? 0), cur) : "—"}</td>
                        <td className="num" data-label="Total">
                          <b>{money(r.total, cur)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {/* What was added to the stay as priced (2026-11-10, operator: "when charges are added to
                  the folio … the price sub tab should also get updated"). The server's own split. */}
              {fo?.addedDuringStay ? (
                <div className="added-stay" data-added-stay>
                  <div className="added-h">
                    <b>Added during the stay</b>
                    <Help label="About what was added">
                      Every charge on the bill that is not the stay as priced: food and drink, services, extras, a fee, a correction
                      or a credit note. Each is shown with its service charge and GST.
                    </Help>
                  </div>
                  <table className="table compact resp">
                    <thead>
                      <tr>
                        <th style={{ width: 92 }}>Date</th>
                        <th>What</th>
                        <th style={{ width: 96 }}>Room</th>
                        <th className="num">With tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fo.addedDuringStay.lines.map((l) => (
                        <tr key={l.id}>
                          <td data-label="Date">{fmtDay(l.date)}</td>
                          <td data-label="What">{l.description}</td>
                          <td data-label="Room">{l.place ?? "—"}</td>
                          <td
                            className="num money"
                            data-label="With tax"
                            title={`${money(l.net, cur)} + service charge ${money(l.serviceCharge, cur)} + GST ${money(l.gst, cur)}`}
                          >
                            {money(l.total, cur)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="added-sum">
                    <span>Added</span>
                    <b className="money">{money(fo.addedDuringStay.total, cur)}</b>
                  </div>
                </div>
              ) : null}
              {st.segmentNumber != null && (entry.segmentNumber ?? 1) > 1 ? (
                <p className="meta" style={{ marginTop: 6 }}>Priced on pass {st.segmentNumber}.</p>
              ) : null}
              <HelpHere label="About these figures">
                {st.quotationId
                  ? "Set out as the quotation is: each room, with its extra beds and meals beneath it, all before tax and before any discount. The service charge, the GST and the discount follow, then the total."
                  : "Room, meals and bed are before tax; each room’s total adds the service charge and the GST."}
              </HelpHere>
            </>
          )}
        </StepCard>
                </>
              ),
            },
            {
              key: "bill",
              label: <>
                  The bill
                  {balance != null && balance > 0.005 ? <span className="n stop">due</span> : null}
                </>,
              content: (
                <>
        <StepCard title="The bill" status={entry.folio?.billingModel ? payerChoiceWord(entry.folio.billingModel, payerPartyOf(entry)) : "who pays is chosen at Set up"}>
          {!fo ? (
            <p className="meta">
              No bill yet.
              <Help label="About the bill">It starts at Set up, and charges post on it from check-in.</Help>
            </p>
          ) : (
            <>
              <Facts wide>
                {fo.chargeBreakdown ? (
                  <>
                    <Fact k="Charges">{money(fo.chargeBreakdown.base, cur)}</Fact>
                    <Fact k="Service charge">{money(fo.chargeBreakdown.serviceCharge, cur)}</Fact>
                    <Fact k="GST">{money(fo.chargeBreakdown.gst, cur)}</Fact>
                  </>
                ) : null}
                <Fact k="Billed so far" meta={fo.lineCount ? plural(fo.lineCount, "line") : "nothing posted yet"}>
                  {money(fo.billedSoFar, cur)}
                </Fact>
                <Fact k="Payments received">{money(fo.paymentsReceived, cur)}</Fact>
                {fo.refunded ? <Fact k="Refunded">{money(fo.refunded, cur)}</Fact> : null}
                {fo.refundWaiting ? <Fact k="Waiting to be refunded">{money(fo.refundWaiting, cur)}</Fact> : null}
                {fo.writtenOff ? <Fact k="Written off">{money(fo.writtenOff, cur)}</Fact> : null}
                {fo.overpaid ? <Fact k="Paid above the bill">{money(fo.overpaid, cur)}</Fact> : null}
              </Facts>
              <div className={`balance-line ${balance != null && balance > 0.005 ? "due" : "clear"}`}>
                <span>Balance due</span>
                <b>{money(balance, cur)}</b>
              </div>
              {parts.length > 1 ? (
                <table className="table compact resp" style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Part of the bill</th>
                      <th className="num">Charges</th>
                      <th className="num">Service</th>
                      <th className="num">GST</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((x) => (
                      <tr key={x.key}>
                        <td>{x.label}</td>
                        <td className="num" data-label="Charges">{money(x.b.base, cur)}</td>
                        <td className="num" data-label="Service">{money(x.b.serviceCharge, cur)}</td>
                        <td className="num" data-label="GST">{money(x.b.gst, cur)}</td>
                        <td className="num" data-label="Total">
                          <b>{money(x.b.charges, cur)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          )}
        </StepCard>
                </>
              ),
            },
            {
              key: "money",
              label: <>
                  Money received
                  {tripMoney ? null : payments.length ? <span className="n">{payments.length}</span> : null}
                </>,
              content: tripMoney ? (
                <StepCard title="Money received">
                  <TripMoneyReceived entry={entry} stays={[entry, ...together.others].sort((a, b) => together.stayNoOf(a.id) - together.stayNoOf(b.id))} stayNoOf={together.stayNoOf} tz={tz} />
                </StepCard>
              ) : (
                <>
        <StepCard
          title="Money received"
          right={
            <Button kind="quiet" compact icon="clock" onClick={onPaymentHistory}>
              Price &amp; payment history
            </Button>
          }
        >
          {p ? (
            <Facts wide>
              <Fact
                k="Advance asked"
                meta={
                  p.requirementSource === "OPERATOR"
                    ? "set for this booking"
                    : p.requirementSource === "PARTY"
                      ? `${p.requirementBasis?.partyName ?? "their"} rule`
                      : undefined
                }
              >
                {p.requiredAmount > 0 ? money(p.requiredAmount, cur) : "none asked"}
              </Fact>
              {/* The standing words from Arrival's old Advance and credit card live here now
                  (2026-10-23): paid in full, the guest's plan and whether it was kept, the sign-off. */}
              <Fact k="Received">
                {money(p.totalReceived, cur)}
                {p.requiredAmount > 0 ? (
                  <span className="meta">
                    {" "}
                    of {money(p.requiredAmount, cur)}
                    {paymentsIn ? ` · ${plural(paymentsIn, "payment")}` : ""}
                  </span>
                ) : null}
                {p.requiredAmount > 0 && p.paidInFull ? (
                  <>
                    {" "}
                    <Chip tone="success" icon="check">
                      Paid in full
                    </Chip>
                  </>
                ) : null}
              </Fact>
              {p.shortfall > 0.005 ? <Fact k="Still to come">{money(p.shortfall, cur)}</Fact> : null}
              {p.paymentPlan ? (
                <Fact k="Guest's plan">
                  {PLAN_LABEL[p.paymentPlan.plan]}
                  {dueLabel(p.paymentPlan.plan, p.paymentPlan.balanceDueAt) ? ` · ${dueLabel(p.paymentPlan.plan, p.paymentPlan.balanceDueAt)}` : ""}
                  {p.paymentPlan.promisedBy ? ` · by ${fmtDateTime(p.paymentPlan.promisedBy, tz)}` : ""}{" "}
                  {p.paidInFull ? (
                    <Chip tone="success" icon="check">
                      Kept — paid in full
                    </Chip>
                  ) : p.paymentPlan.promiseOverdue ? (
                    <Chip tone="danger">Promise lapsed</Chip>
                  ) : null}
                  {p.paymentPlan.note ? <span className="meta"> · &ldquo;{p.paymentPlan.note}&rdquo;</span> : null}
                </Fact>
              ) : null}
              {p.creditExtensionActive ? (
                <Fact k="Credit extended" meta={p.creditExtensionExpiresAt ? `until ${fmtDateTime(p.creditExtensionExpiresAt, tz)}` : undefined}>
                  {money(p.ceilingAmount, cur)}
                </Fact>
              ) : null}
              {entry.folio?.advancePaymentReconciliationComplete ? (
                <Fact k="Signed off">
                  <Chip tone="success" icon="check">
                    {p.paidInFull ? "Advance settled in full · reconciled" : "Reconciled — the money position is accepted"}
                  </Chip>
                </Fact>
              ) : null}
            </Facts>
          ) : null}
          {payments.length ? (
            <table className="table compact" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>How</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((x) => {
                  const out = x.paymentDirection === "OUT";
                  return (
                    <tr key={x.id}>
                      <td>{fmtStamp(x.receivedAt, tz)}</td>
                      <td>
                        {out ? "Paid back" : "Received"}
                        {stepWord(x.stage) ? <span className="meta"> · at {stepWord(x.stage)}</span> : null}
                        {x.notes ? <span className="meta"> · {x.notes}</span> : null}
                      </td>
                      <td>{x.paymentMethod ? METHOD_WORD[x.paymentMethod] ?? x.paymentMethod.toLowerCase().replace(/_/g, " ") : "—"}</td>
                      <td className={`num${out ? " stop-ink" : ""}`}>
                        <b>{out ? "− " : ""}{money(x.amount, x.currency || cur)}</b>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="meta" style={{ marginTop: 6 }}>Nothing received yet.</p>
          )}
        </StepCard>
                </>
              ),
            },
            {
              key: "package",
              label: "Package",
              content: <BookingRateSheet entry={entry} />,
            },
          ]}
        />
      </div>
    </>
  );
}

/** "10%" — a rate as the quotation's labels print it. */
const pctWord = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

/**
 * The live preview's figures in the quotation's shape — the rows are the server's, and so is every
 * figure; only the labels are worded here, exactly as the quotation words them.
 */
function previewFigures(p: QuotationLivePreview): PriceLinesFigures {
  const d = p.discount;
  return {
    lines: p.lines,
    datesShown: p.datesShown,
    net: p.subtotal,
    netAfterDiscount: d ? p.payableSubtotal : null,
    serviceChargeLabel: p.serviceChargeRate > 0 ? `Service charge ${pctWord(p.serviceChargeRate)} of ${d ? "net after discount" : "net value"}` : "Service charge",
    serviceCharge: p.payableServiceCharge,
    gstLabel: p.gstRate > 0 ? `GST @ ${pctWord(p.gstRate)} of net + service charge` : "GST",
    gst: p.payableGst,
    discountLabel: !d ? null : d.requestedPercent != null ? `Discount ${Number(d.requestedPercent.toFixed(2))}%` : "Discount",
    discountAmount: d ? d.netReduction : null,
    discountNote: null,
    total: p.payable,
  };
}

/**
 * What the quotation's rows depend on besides the quotation: a room moving within its type keeps the
 * same quotation (2026-11-03), and the rooms handed out change how a room is named.
 */
function roomsNamed(entry: EntryDetail, quotationId: string): string {
  const q = (entry.quotations ?? []).find((x) => x.id === quotationId);
  const rows = (q?.commercialTerms as { roomCompositions?: Array<{ roomId?: string }> } | null | undefined)?.roomCompositions ?? [];
  return [...rows.map((r) => r.roomId), "|", ...(entry.roomAssignments ?? []).map((a) => a.roomId)].join(",");
}

/** The saved quotation's own rows, read from the server — the paper set out on the tab. */
function QuotePriceLines({ quotationId, rooms, stayTotal, currency }: { quotationId: string; rooms: string; stayTotal: number | null; currency: string }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["quotation-price-lines", quotationId, rooms],
    queryFn: () => getQuotationPriceLines(session!, quotationId),
    enabled: !!session,
  });
  if (q.isLoading) return <p className="meta">Reading the quotation…</p>;
  if (!q.data) return <p className="meta">The quotation&rsquo;s rows could not be read.</p>;
  const f = q.data;
  return (
    <>
      <p className="meta" style={{ margin: "8px 0 4px" }}>
        As quoted · {f.referenceNumber}
        {f.versionNumber > 1 ? ` · v${f.versionNumber}` : ""}
      </p>
      <PriceLinesTable f={f} currency={currency} />
      {stayTotal != null && Math.abs(stayTotal - f.total) > 0.005 ? (
        <p className="meta" style={{ marginTop: 6 }}>
          The quotation&rsquo;s total is for the stay as booked; the stay as it stands comes to {money(stayTotal, currency)}.
        </p>
      ) : null}
    </>
  );
}

/**
 * The stays set up the same, at Negotiation (2026-11-09, operator: the panel "shows only the stay
 * whose page you are on"): every stay's rows in one table, or stay by stay. Each stay is its own
 * figure from the server, as quoted when it is saved; the trip's are those added up there.
 */
function TripTablePrice({ sp }: { sp: StayPrice }) {
  const [view, setView] = useTripBillView();
  const t = sp.tableTrip!;
  const cur = t.data.currency;
  const stays = [...t.data.stays]
    .sort((a, b) => t.stayNoOf(a.entryId) - t.stayNoOf(b.entryId))
    .map((s) => ({ s, n: t.stayNoOf(s.entryId), f: (s.quote ?? (s.preview ? previewFigures(s.preview) : null)) as PriceLinesFigures | null }));
  const dated = stays.some((x) => x.f?.datesShown);
  const first = stays.find((x) => x.f)?.f ?? null;
  const tt = t.data.totals;
  const plain = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const quotedWord = (x: (typeof stays)[number]) =>
    x.s.source === "QUOTE" ? `As quoted · ${x.s.quote!.referenceNumber}${x.s.quote!.versionNumber > 1 ? ` · v${x.s.quote!.versionNumber}` : ""}` : "as on the table · not saved yet";
  const head = (x: (typeof stays)[number]) => (
    <>
      <span className="trip-stay-name">Stay {x.n}</span>
      <StayDates checkIn={x.s.checkIn} checkOut={x.s.checkOut} />
      <span className="meta">{quotedWord(x)}</span>
    </>
  );
  return (
    <>
      <div className="bigfig">
        <span className="meta">Trip total · {plural(stays.length, "stay")}</span>
        <b>{money(tt.payable, cur)}</b>
        {t.loading ? <span className="meta">updating…</span> : null}
      </div>
      <div className="trip-bill-switch">
        <Choice options={[["TOGETHER", "Together"], ["EACH", "Stay by stay"]] as const} value={view} onChange={setView} />
      </div>
      {view === "TOGETHER" ? (
        <div className="plines-wrap">
          {stays.map((x, i) => (
            <Fragment key={x.s.entryId}>
              <div className="trip-stay-band">
                <span>
                  <span className="trip-stay-name">Stay {x.n}</span> <span className="meta">{quotedWord(x)}</span>
                  <span className="sm trip-stay-when">{fmtStay(x.s.checkIn, x.s.checkOut)}</span>
                </span>
                <b className="money">{money(x.s.payable, cur)}</b>
              </div>
              <table className={`table compact plines${dated ? " dated" : ""}`}>
                {i === 0 ? <PriceLinesHead datesShown={dated} currency={cur} /> : null}
                <tbody>{x.f ? <PriceLineRows lines={x.f.lines} datesShown={dated} /> : null}</tbody>
              </table>
            </Fragment>
          ))}
          <div className="pl-foot">
            <span>Net value · the trip</span>
            <b>{plain(tt.subtotal)}</b>
            {tt.netReduction > 0 ? (
              <>
                <span>Discount</span>
                <b>− {plain(tt.netReduction)}</b>
                <span>Net after discount</span>
                <b>{plain(tt.payableSubtotal)}</b>
              </>
            ) : null}
            <span>{first?.serviceChargeLabel ?? "Service charge"}</span>
            <b>{plain(tt.payableServiceCharge)}</b>
            <span>{first?.gstLabel ?? "GST"}</span>
            <b>{plain(tt.payableGst)}</b>
            <span className="total">Trip total</span>
            <b className="total">{money(tt.payable, cur)}</b>
          </div>
        </div>
      ) : (
        stays.map((x) => (
          <div key={x.s.entryId} className="trip-stay-block">
            <div className="trip-stay-h-in">
              {head(x)}
            </div>
            {x.f ? <PriceLinesTable f={x.f} currency={cur} /> : null}
          </div>
        ))
      )}
      {t.unsaved ? <p className="warn-ink sm" style={{ margin: "6px 0 0" }}>A stay has changes not saved yet — save the table to put them on its quotation.</p> : null}
      <HelpHere label="About these figures">Each stay is priced by the hotel server on its own, and each keeps its own quotation. The trip&rsquo;s figures are those added up.</HelpHere>
    </>
  );
}

/** The Negotiation table, priced by the server as it stands — saved or not. */
function TablePrice({ sp }: { sp: StayPrice }) {
  const p = sp.preview;
  const cur = sp.currency;
  if (!p) return <p className="meta">Pricing the table…</p>;
  return (
    <>
      <div className="bigfig">
        <span className="meta">Stay total</span>
        <b>{money(p.payable, cur)}</b>
        {sp.loading ? <span className="meta">updating…</span> : null}
      </div>
      {sp.savedQuoteAmount != null ? (
        <p className="warn-ink sm" style={{ margin: "4px 0 0" }}>
          <b>The quotation on file says {money(sp.savedQuoteAmount, cur)}</b> — save the table at Negotiation to bring it up to date.
        </p>
      ) : null}
      {p.lines ? <PriceLinesTable f={previewFigures(p)} currency={cur} /> : null}
      <HelpHere label="About these figures">
        The figures follow the negotiation table as it is changed — priced by the hotel server, the same way the quotation will be,
        and set out as the quotation will set them out.
      </HelpHere>
    </>
  );
}

/**
 * The rooms picked at Inquiry, priced rooms only by the server — the same bill the house card
 * carried (2026-10-27, moved here): each night with its rooms, each room's nights, room-nights ×
 * rate per type, the net, the service charge, the GST and the stay's total.
 */
function PicksPrice({ sp }: { sp: StayPrice }) {
  const p = sp.pick;
  // A trip at Inquiry: every stay in one bill, together or stay by stay (2026-11-07).
  if (sp.trip) {
    const t = sp.trip;
    return (
      <TripPickBill
        trip={t.pricing}
        entries={t.entries}
        stayNoOf={t.stayNoOf}
        labelsOverride={t.labels}
        loading={t.loading}
        title={t.unsaved ? "The rooms picked · not all saved yet" : "The rooms chosen"}
        caption={
          t.unsaved ? <span className="warn-ink">Save the rooms on the Inquiry step to keep this choice — the figures follow every pick.</span> : undefined
        }
        help="Indicative, not a quote — rooms only. Meals, extra beds and any agreed rate are added at Negotiation, where each stay's quotation prices them."
      />
    );
  }
  if (!p) return null;
  return (
    <PickBill
      pricing={p}
      roomLabels={sp.labels}
      loading={sp.loading}
      title={sp.unsaved ? "The rooms picked · not saved yet" : "The rooms chosen"}
      caption={
        sp.unsaved ? (
          <span className="warn-ink">Save the rooms on the Inquiry step to keep this choice — the figures follow every pick.</span>
        ) : undefined
      }
      help="Indicative, not a quote — rooms only. Meals, extra beds and any agreed rate are added at Negotiation, where the quotation prices them."
    />
  );
}

/* ================================================================== Guest requests */

export function RequestsView({ entry, sealed, tz }: { entry: EntryDetail; sealed: boolean; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const day = useHotelDay();
  const q = useQuery({
    queryKey: ["guest-requests", entry.id],
    queryFn: () => listGuestRequests(session!, entry.id),
    enabled: !!session,
  });
  const data = q.data;
  const again = () => {
    void q.refetch();
    refresh([["guest-requests", entry.id]]);
  };

  /* the preference line */
  const pref = data?.preference ?? entry.inquiry?.notes?.trim() ?? "";
  const [editingPref, setEditingPref] = useState(false);
  const [prefDraft, setPrefDraft] = useState("");
  const savePref = useMutation({
    mutationFn: () => updateInquiryNotes(session!, entry.inquiryId, prefDraft.trim()),
    onSuccess: () => {
      toast.success(prefDraft.trim() ? "Preference saved" : "Preference cleared");
      setEditingPref(false);
      again();
    },
    onError: (e) => toastRefusal(e, "The preference could not be saved"),
  });

  /* a new request */
  const [kind, setKind] = useState<string | null>(null);
  const [what, setWhat] = useState("");
  const [forDate, setForDate] = useState("");
  const [forTime, setForTime] = useState("");
  const add = useMutation({
    mutationFn: () => addGuestRequest(session!, entry.id, { kind: kind!, what: what.trim(), forDate: forDate || null, forTime: forTime || null }),
    onSuccess: () => {
      toast.success(`Request taken — ${kind}`);
      setKind(null);
      setWhat("");
      setForDate("");
      setForTime("");
      again();
    },
    onError: (e) => toastRefusal(e, "The request could not be taken"),
  });
  const addBlock = !kind ? "pick what kind of request it is" : !what.trim() ? "say what they asked for" : forTime && !forDate ? "a time needs its day" : null;

  const [arranging, setArranging] = useState<GuestRequest | null>(null);
  const [arrangeNote, setArrangeNote] = useState("");
  const arrange = useMutation({
    mutationFn: () => arrangeGuestRequest(session!, arranging!.id, arrangeNote.trim() || null),
    onSuccess: () => {
      toast.success(`Arranged — ${arranging?.kind}`);
      setArranging(null);
      again();
    },
    onError: (e) => toastRefusal(e, "Could not mark it arranged"),
  });
  const [withdrawing, setWithdrawing] = useState<GuestRequest | null>(null);
  const withdraw = useMutation({
    mutationFn: (reason: string) => withdrawGuestRequest(session!, withdrawing!.id, reason),
    onSuccess: () => {
      toast.success("Request taken back — it stays on the record");
      setWithdrawing(null);
      again();
    },
    onError: (e) => toastRefusal(e, "Could not take it back"),
  });

  const order = (r: GuestRequest) => (r.state === "ASKED" ? 0 : r.state === "ARRANGED" ? 1 : 2);
  const items = [...(data?.items ?? [])].sort((a, b) => order(a) - order(b) || b.createdAt.localeCompare(a.createdAt));
  const open = items.filter((r) => r.state === "ASKED").length;
  const minDate = day?.today ?? undefined;
  const maxDate = data?.stay.checkOutDate ?? undefined;

  return (
    <>
      <h3>
        Guest requests <span className="need">what the guest likes, and what they asked us to arrange</span>
      </h3>
      <div className="steps-canvas">
        {/* Sub-tabs (2026-10-12): the requests to arrange first, the guest's preference beside them. */}
        <SubTabs
          label="Guest requests"
          tabs={[
            {
              key: "requests",
              label: <>
                  Requests
                  {open ? <span className="n warn">{open}</span> : null}
                </>,
              content: (
                <>
        <StepCard
          title="Requests"
          status={
            items.length ? (
              open ? (
                <span className="warn-ink"><b>{plural(open, "request")} still to arrange</b></span>
              ) : (
                <span className="ok-ink"><b>everything asked is arranged</b></span>
              )
            ) : undefined
          }
          meta="Something to arrange — a pickup, a cake, an early room; taken at any step." 
        >
          {q.isLoading ? (
            <p className="meta">Reading the requests…</p>
          ) : items.length === 0 ? (
            <p className="meta" style={{ margin: 0 }}>Nothing asked yet.</p>
          ) : (
            <div className="reqlist">
              {items.map((r) => (
                <div key={r.id} className={`reqrow ${r.state.toLowerCase()}`}>
                  <div className="req-main">
                    <b>{r.kind}</b> · {r.what}
                    {r.forDate ? (
                      <span className="meta">
                        {" "}
                        · {fmtDay(r.forDate)}
                        {r.forTime ? ` ${r.forTime}` : ""}
                      </span>
                    ) : null}
                    <div className="meta">
                      taken {fmtStamp(r.createdAt, tz)}
                      {stepWord(r.stageContext) ? ` at ${stepWord(r.stageContext)}` : ""}
                      {r.createdByName ? ` · ${r.createdByName}` : ""}
                      {r.state === "ARRANGED"
                        ? ` · arranged ${fmtStamp(r.arrangedAt, tz)}${r.arrangedByName ? ` by ${r.arrangedByName}` : ""}${r.arrangedNote ? ` — ${r.arrangedNote}` : ""}`
                        : ""}
                      {r.state === "WITHDRAWN" ? ` · taken back ${fmtStamp(r.withdrawnAt, tz)}${r.withdrawnReason ? ` — “${r.withdrawnReason}”` : ""}` : ""}
                    </div>
                  </div>
                  <div className="row-acts">
                    {r.state === "ASKED" ? <Chip tone="warning">to arrange</Chip> : r.state === "ARRANGED" ? <Chip tone="success">arranged</Chip> : <Chip tone="quiet">taken back</Chip>}
                    {!sealed && r.state === "ASKED" ? (
                      <Button
                        kind="secondary"
                        compact
                        icon="check"
                        onClick={() => {
                          setArrangeNote("");
                          setArranging(r);
                        }}
                      >
                        Arranged
                      </Button>
                    ) : null}
                    {!sealed && r.state !== "WITHDRAWN" ? (
                      <Button kind="quiet" compact onClick={() => setWithdrawing(r)}>
                        Take back
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </StepCard>
        {sealed ? null : (
          <StepCard title="Take a request" meta="a request is something to arrange — what the guest simply likes goes under Preference, above">
            <div className="form2">
              <div className="wide field">
                <label>What kind</label>
                <Choice options={(data?.kinds ?? []).map((k) => [k, k] as const)} value={kind} onChange={setKind} />
              </div>
              <div className="wide field">
                <label>What exactly</label>
                <input className="input" value={what} maxLength={1000} placeholder="e.g. pickup at Paro airport, flight KB 540" onChange={(e) => setWhat(e.target.value)} />
              </div>
              <div className="field">
                <label>
                  For which day · optional
                  <Help label="About the day">From today to the day they leave.</Help>
                </label>
                <DateInput className="input" value={forDate} min={minDate} max={maxDate} onChange={(e) => setForDate(e.target.value)} />
              </div>
              <div className="field">
                <label>
                  Time · optional
                  <Help label="About the time">On the hotel&rsquo;s clock.</Help>
                </label>
                <TimeInput className="input" value={forTime} onChange={(e) => setForTime(e.target.value)} />
              </div>
            </div>
            <div className="row-acts" style={{ marginTop: 10 }}>
              <Button state={add.isPending ? "working" : addBlock ? "inert" : "default"} reason={addBlock ?? undefined} workingLabel="Taking it…" onClick={() => add.mutate()}>
                Take the request
              </Button>
            </div>
          </StepCard>
        )}
                </>
              ),
            },
            {
              key: "preference",
              label: <>
                  Preference
                  {pref ? <span className="n">1</span> : null}
                </>,
              content: (
                <>
        <StepCard
          title="Preference"
          meta="what the guest likes — a high floor, a quiet room; it stays with the booking at every step"
          right={
            sealed || editingPref ? null : (
              <Button
                kind="quiet"
                compact
                icon="pen"
                onClick={() => {
                  setPrefDraft(pref);
                  setEditingPref(true);
                }}
              >
                {pref ? "Change" : "Add"}
              </Button>
            )
          }
        >
          {editingPref ? (
            <div className="row-acts" style={{ alignItems: "flex-start" }}>
              <textarea
                className="input"
                rows={2}
                autoFocus
                maxLength={2000}
                style={{ flex: 1, minWidth: 260 }}
                value={prefDraft}
                placeholder="e.g. high floor, quiet room, honeymoon — allergic to nuts"
                onChange={(e) => setPrefDraft(e.target.value)}
              />
              <Button compact state={savePref.isPending ? "working" : prefDraft.trim() === pref ? "inert" : "default"} reason={prefDraft.trim() === pref ? "nothing changed" : undefined} onClick={() => savePref.mutate()}>
                Save
              </Button>
              <Button kind="quiet" compact onClick={() => setEditingPref(false)}>
                Cancel
              </Button>
            </div>
          ) : pref ? (
            <p className="sm" style={{ margin: 0 }}>
              <b>{pref}</b>
            </p>
          ) : (
            <p className="meta" style={{ margin: 0 }}>
              {sealed ? "No preference was recorded." : "None noted yet."}
            </p>
          )}
        </StepCard>
                </>
              ),
            },
          ]}
        />
      </div>

      <DsDialog
        open={!!arranging}
        onClose={() => setArranging(null)}
        busy={arrange.isPending}
        title={`Arranged — ${arranging?.kind ?? ""}`}
        caseLines={arranging ? [arranging.what] : undefined}
        footer={
          <>
            <Button kind="quiet" onClick={() => setArranging(null)}>
              Not now
            </Button>
            <Button state={arrange.isPending ? "working" : "default"} onClick={() => arrange.mutate()}>
              Mark it arranged
            </Button>
          </>
        }
      >
        <div className="field">
          <label>How · optional</label>
          <input className="input" value={arrangeNote} maxLength={1000} placeholder="e.g. car booked with Tashi, 11:00" onChange={(e) => setArrangeNote(e.target.value)} autoFocus />
        </div>
      </DsDialog>
      <ReasonDialog
        open={!!withdrawing}
        onClose={() => setWithdrawing(null)}
        title={`Take back the request — ${withdrawing?.kind ?? ""}`}
        caseLines={withdrawing ? [withdrawing.what] : undefined}
        lead="It stays on the record as taken back, with the reason."
        confirmLabel="Take it back"
        busy={withdraw.isPending}
        reasonLabel="Why"
        placeholder="e.g. their flight changed"
        onConfirm={(reason) => withdraw.mutate(reason)}
      />
    </>
  );
}

/* ================================================================== Notes */

/** The words a person typed with an act — a park, a decline, an answer — kept by the system. */
function saidWith(ev: TraceEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  for (const k of ["reason", "verbatimNote", "note", "justification", "decisionNote", "comment"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim() && !/^[A-Z_]+$/.test(v.trim())) return v.trim();
  }
  return null;
}

type DueChoice = "" | "HOUR" | "T12" | "T16" | "T18" | "M10" | "PICK";

export function NotesView({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const day = useHotelDay();
  const q = useQuery({
    queryKey: ["booking-notes", entry.id],
    queryFn: () => listBookingNotes(session!, entry.id),
    enabled: !!session,
  });
  const trace = useQuery({
    queryKey: ["entry-trace", entry.id, 300],
    queryFn: () => getEntryTrace(session!, entry.id, 300),
    enabled: !!session,
  });
  const again = () => {
    void q.refetch();
    refresh([["booking-notes", entry.id]]);
  };

  const [text, setText] = useState("");
  const [todo, setTodo] = useState(false);
  const [who, setWho] = useState<NoteAssignee | null>("DESK");
  const [due, setDue] = useState<DueChoice>("");
  const [pickDate, setPickDate] = useState("");
  const [pickTime, setPickTime] = useState("");
  const nowHm = hotelFormParts(new Date(), tz).time;
  const dueOptions: Array<[DueChoice, string]> = [
    ["", "no time"],
    ["HOUR", "within the hour"],
    ...(nowHm < "12:00" ? [["T12", "today 12:00"] as [DueChoice, string]] : []),
    ...(nowHm < "16:00" ? [["T16", "today 16:00"] as [DueChoice, string]] : []),
    ...(nowHm < "18:00" ? [["T18", "today 18:00"] as [DueChoice, string]] : []),
    ["M10", "tomorrow 10:00"],
    ["PICK", "a day and time…"],
  ];
  const dueBody = (): { dueAt?: string; dueDate?: string; dueTime?: string } | null => {
    if (!todo || due === "") return {};
    if (due === "HOUR") return { dueAt: new Date(Date.now() + 3600_000).toISOString() };
    if (!day) return null;
    if (due === "T12") return { dueDate: day.today, dueTime: "12:00" };
    if (due === "T16") return { dueDate: day.today, dueTime: "16:00" };
    if (due === "T18") return { dueDate: day.today, dueTime: "18:00" };
    if (due === "M10") return { dueDate: day.tomorrow, dueTime: "10:00" };
    return pickDate && pickTime ? { dueDate: pickDate, dueTime: pickTime } : null;
  };
  const blocked = !text.trim() ? "write the note first" : todo && !who ? "say who it is for" : todo && dueBody() === null ? "pick the day and time" : null;
  const add = useMutation({
    mutationFn: () =>
      addBookingNote(
        session!,
        entry.id,
        todo ? { kind: "TODO", text: text.trim(), assignee: who!, ...(dueBody() ?? {}) } : { kind: "NOTE", text: text.trim() },
      ),
    onSuccess: () => {
      toast.success(todo ? "To-do set" : "Note kept");
      setText("");
      setTodo(false);
      setDue("");
      setPickDate("");
      setPickTime("");
      again();
    },
    onError: (e) => toastRefusal(e, "The note could not be kept"),
  });

  const done = useMutation({
    mutationFn: (v: { id: string; done: boolean }) => setBookingTodoDone(session!, v.id, v.done),
    onSuccess: (_r, v) => {
      toast.success(v.done ? "To-do done" : "To-do opened again");
      again();
    },
    onError: (e) => toastRefusal(e, "The to-do could not be changed"),
  });

  const [editing, setEditing] = useState<BookingNote | null>(null);
  const [editText, setEditText] = useState("");
  const edit = useMutation({
    mutationFn: () => editBookingNote(session!, editing!.id, editText.trim()),
    onSuccess: () => {
      toast.success("Note changed — the earlier wording is kept");
      setEditing(null);
      again();
    },
    onError: (e) => toastRefusal(e, "The note could not be changed"),
  });
  const canEdit = (n: BookingNote) => n.createdBy === session?.userId || atLeast(session?.actorLevel, "L2");

  const items = q.data?.items ?? [];
  const todos = items.filter((n) => n.kind === "TODO").sort((a, b) => (a.doneAt ? 1 : 0) - (b.doneAt ? 1 : 0) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"));
  const notes = items.filter((n) => n.kind === "NOTE");
  /** Notes written into a quotation's own terms before 2026-10-12 — read back, read-only. */
  const termNotes = q.data?.quotationNotes ?? [];
  const system = useMemo(
    () =>
      (trace.data?.items ?? [])
        .filter((ev) => !isHousekeeping(ev.eventType) && !/^(BOOKING_NOTE|GUEST_REQUEST)\./.test(ev.eventType))
        .map((ev) => ({ ev, said: saidWith(ev) }))
        .filter((x): x is { ev: TraceEvent; said: string } => !!x.said),
    [trace.data],
  );
  const whoWord = (a: string | null) => NOTE_ASSIGNEES.find(([k]) => k === a)?.[1] ?? "Desk";

  return (
    <>
      <h3>
        Notes <span className="need">what was said, what was promised, and what is still to do</span>
      </h3>
      <div className="steps-canvas">
        {/* Sub-tabs (2026-10-12): what the desk keeps, and what the system kept with each act. */}
        <SubTabs
          label="Notes"
          tabs={[
            {
              key: "notes",
              label: <>
                  Notes &amp; to-dos
                  {q.data?.counts.overdueTodos ? (
                    <span className="n stop">{q.data.counts.overdueTodos}</span>
                  ) : q.data?.counts.openTodos ? (
                    <span className="n warn">{q.data.counts.openTodos}</span>
                  ) : notes.length + termNotes.length ? (
                    <span className="n">{notes.length + termNotes.length}</span>
                  ) : null}
                </>,
              content: (
                <>
        <StepCard title="Write a note" meta="a note is locked once kept; a change keeps the earlier wording">
          <div className="notes-input">
            <input
              className="input"
              value={text}
              maxLength={2000}
              placeholder="Type a point, press Enter"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !blocked && !add.isPending) add.mutate();
              }}
            />
            <label className="tick">
              <input type="checkbox" checked={todo} onChange={(e) => setTodo(e.target.checked)} /> To do
            </label>
            <Button state={add.isPending ? "working" : blocked ? "inert" : "default"} reason={blocked ?? undefined} onClick={() => add.mutate()}>
              {todo ? "Set the to-do" : "Keep the note"}
            </Button>
          </div>
          {todo ? (
            <div className="form2" style={{ marginTop: 10 }}>
              <div className="wide field">
                <label>Who must do it</label>
                <Choice options={NOTE_ASSIGNEES} value={who} onChange={setWho} />
              </div>
              <div className="field">
                <label>
                  By when
                  <Help label="About the time">On the hotel&rsquo;s clock.</Help>
                </label>
                <select className="input" value={due} onChange={(e) => setDue(e.target.value as DueChoice)}>
                  {dueOptions.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              {due === "PICK" ? (
                <div className="field">
                  <label>Day and time</label>
                  <div className="row-acts">
                    <DateInput className="input" min={day?.today} value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
                    <TimeInput className="input" value={pickTime} onChange={(e) => setPickTime(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </StepCard>
        {todos.length ? (
          <StepCard
            title="To-dos"
            status={
              q.data?.counts.overdueTodos ? (
                <span className="stop-ink">
                  <b>{plural(q.data.counts.overdueTodos, "to-do")} past its time</b>
                </span>
              ) : q.data?.counts.openTodos ? (
                <span className="warn-ink">
                  <b>{plural(q.data.counts.openTodos, "to-do")} open</b>
                </span>
              ) : (
                <span className="ok-ink">
                  <b>all done</b>
                </span>
              )
            }
          >
            <div className="reqlist">
              {todos.map((n) => (
                <div key={n.id} className={`reqrow ${n.doneAt ? "arranged" : n.overdue ? "late" : "asked"}`}>
                  <div className="req-main">
                    <b>{whoWord(n.assignee)}</b> · {n.paper ? <span className="papernote-tag">{n.paper.label}</span> : null}
                    {n.text}
                    <div className="meta">
                      {n.dueAt ? <span className={n.overdue ? "stop-ink" : undefined}>by {fmtDateTime(n.dueAt, tz)}{n.overdue ? " — past its time" : ""} · </span> : null}
                      set {fmtStamp(n.createdAt, tz)}
                      {n.createdByName ? ` by ${n.createdByName}` : ""}
                      {n.doneAt ? ` · done ${fmtStamp(n.doneAt, tz)}${n.doneByName ? ` by ${n.doneByName}` : ""}` : ""}
                    </div>
                  </div>
                  <div className="row-acts">
                    {n.doneAt ? (
                      <>
                        <Chip tone="success">done</Chip>
                        <Button kind="quiet" compact state={done.isPending ? "inert" : "default"} onClick={() => done.mutate({ id: n.id, done: false })}>
                          Open again
                        </Button>
                      </>
                    ) : (
                      <Button kind="secondary" compact icon="check" state={done.isPending ? "inert" : "default"} onClick={() => done.mutate({ id: n.id, done: true })}>
                        Done
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </StepCard>
        ) : null}
        <StepCard title="Notes" status={notes.length + termNotes.length ? plural(notes.length + termNotes.length, "note") : undefined}>
          {q.isLoading ? (
            <p className="meta">Reading the notes…</p>
          ) : notes.length === 0 && termNotes.length === 0 ? (
            <p className="meta" style={{ margin: 0 }}>No notes yet.</p>
          ) : (
            <div className="reqlist">
              {notes.map((n) => (
                <div key={n.id} className="reqrow note">
                  <div className="req-main">
                    {editing?.id === n.id ? (
                      <div className="row-acts" style={{ alignItems: "flex-start" }}>
                        <textarea className="input" rows={2} autoFocus style={{ flex: 1, minWidth: 260 }} value={editText} maxLength={2000} onChange={(e) => setEditText(e.target.value)} />
                        <Button
                          compact
                          state={edit.isPending ? "working" : !editText.trim() || editText.trim() === n.text ? "inert" : "default"}
                          reason={!editText.trim() ? "a note cannot be emptied" : editText.trim() === n.text ? "nothing changed" : undefined}
                          onClick={() => edit.mutate()}
                        >
                          Save
                        </Button>
                        <Button kind="quiet" compact onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <span>
                        {n.paper ? <span className="papernote-tag">{n.paper.label}</span> : null}
                        {n.text}
                      </span>
                    )}
                    <div className="meta">
                      {fmtStamp(n.createdAt, tz)}
                      {stepWord(n.stageContext) ? ` · at ${stepWord(n.stageContext)}` : ""}
                      {n.createdByName ? ` · ${n.createdByName}` : ""}
                      {n.editedAt ? ` · changed ${fmtStamp(n.editedAt, tz)}${n.editedByName ? ` by ${n.editedByName}` : ""}` : ""}
                    </div>
                    {n.priorTexts.length ? (
                      <div className="meta" style={{ fontStyle: "italic" }}>
                        earlier: {n.priorTexts.map((p) => `“${p.text}” (${fmtStamp(p.at, tz)})`).join(" · ")}
                      </div>
                    ) : null}
                  </div>
                  {editing?.id === n.id || !canEdit(n) ? null : (
                    <Button
                      kind="quiet"
                      compact
                      icon="pen"
                      onClick={() => {
                        setEditText(n.text);
                        setEditing(n);
                      }}
                    >
                      Change
                    </Button>
                  )}
                </div>
              ))}
              {termNotes.map((t) => (
                <div key={`t:${t.quotationId}`} className="reqrow note">
                  <div className="req-main">
                    <span>
                      <span className="papernote-tag">{t.label}</span>
                      {t.text}
                    </span>
                    <div className="meta">
                      {fmtStamp(t.createdAt, tz)} · written with the quotation{t.createdByName ? ` · ${t.createdByName}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </StepCard>
                </>
              ),
            },
            {
              key: "system",
              label: <>
                  Kept by the system
                  {system.length ? <span className="n">{system.length}</span> : null}
                </>,
              content: (
                <>
        <StepCard title="Kept by the system" meta="the words typed with each act — a park, a decline, a change, the guest's answer" quiet>
          {trace.isLoading ? (
            <p className="meta">Reading the record…</p>
          ) : system.length === 0 ? (
            <p className="meta" style={{ margin: 0 }}>Nothing yet.</p>
          ) : (
            <div className="reqlist">
              {system.map(({ ev, said }) => (
                <div key={ev.id} className="reqrow sys">
                  <div className="req-main">
                    <span>
                      {traceWords(ev)} — “{said}”
                    </span>
                    <div className="meta">
                      {fmtStamp(ev.timestamp, tz)}
                      {ev.actorName && ev.actorName !== "SYSTEM" ? ` · ${ev.actorName}` : " · system"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </StepCard>
                </>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

/* ================================================================== Documents */

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

export function DocumentsView({
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
  const folioLive = !!entry.folio && ["LIVE", "OUTSTANDING", "SETTLED", "CLOSED"].includes(entry.folio.state);
  const heldDocs = useHeldDocuments(entry.id).data ?? [];
  const heldOpen = sealed ? 0 : heldDocs.filter((h) => h.decision == null).length;
  // One sub-tab per kind of paper (2026-10-12, operator: "for papers it should be divided among
  // different types of papers"). A kind with nothing in it has no tab.
  const invoices = entry.folio?.invoices ?? [];
  const bills = invoices.filter((i) => i.invoiceType !== "PROFORMA").length;
  // A trip's papers: viewing the stays together, the trip's own or stay by stay (2026-11-09). On one
  // stay's own page only that stay's (same day, operator: "i am in stay one but it is showing stay 2s
  // proforma").
  const trip = useTripStays(entry);
  const together = useStaysTogether(entry);
  const shownStays = together.active ? trip.stays.filter((e) => together.stayIds.includes(e.id)) : [entry];
  const quotesOf = (e: EntryDetail) => (e.quotations ?? []).length;
  const proformasOf = (e: EntryDetail) => (e.folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA").length;
  const vouchersOf = (e: EntryDetail) => Math.max(e.reservations?.length ?? 0, e.reservation?.id ? 1 : 0) + (e.status === "CANCELLED" ? 1 : 0);
  const sumOf = (f: (e: EntryDetail) => number) => shownStays.reduce((n, e) => n + f(e), 0);
  const quotes = sumOf(quotesOf);
  const proformas = sumOf(proformasOf);
  const vouchers = sumOf(vouchersOf);
  const otherBills = shownStays.filter((e) => e.id !== entry.id && (e.folio?.invoices ?? []).some((i) => i.invoiceType !== "PROFORMA"));
  const sent = communications.filter((c) => c.direction !== "INBOUND");
  // A replaced paper awaits no answer — only the one in force does (2026-10-13).
  const awaiting = sent.filter((c) => c.sendStatus === "DISPATCHED" && !replySettled(c) && !c.superseded && !c.held).length;
  const count = (n: number) => (n ? <span className="n">{n}</span> : null);
  return (
    <>
      <h3>
        Documents <span className="need">every paper, every version, and what the guest said back</span>
      </h3>
      <div className="steps-canvas">
        {/* A paper not sent is sent from Sent & answers (2026-11-09); the tab opens on Quotations, so it says so. */}
        {heldOpen > 0 ? (
          <p className="notice next" role="status" style={{ margin: "0 0 10px" }}>
            <span>
              {heldOpen === 1 ? "A paper has" : `${heldOpen} papers have`} not been sent — it is under Sent &amp; answers. Leave it if it need not go.
            </span>
          </p>
        ) : null}
        {quotes + invoices.length + vouchers + sent.length === 0 && !folioLive ? (
          <EmptyState title="No papers yet">A quotation is the first — it is generated at Negotiation.</EmptyState>
        ) : (
          <SubTabs
            label="Documents"
            tabs={[
              quotes
                ? {
                    key: "quotations",
                    label: <>Quotations{count(quotes)}</>,
                    content: trip.isTrip ? <TripPapersShelf entry={entry} show="quotes" title="Quotations" sealed={sealed} has={(e) => quotesOf(e) > 0} /> : <PapersCard entry={entry} show="quotes" title="Quotations" />,
                  }
                : null,
              proformas
                ? {
                    key: "proformas",
                    label: <>Proforma invoices{count(proformas)}</>,
                    content: trip.isTrip ? <TripPapersShelf entry={entry} show="proformas" title="Proforma invoices" sealed={sealed} has={(e) => proformasOf(e) > 0} /> : <PapersCard entry={entry} show="proformas" title="Proforma invoices" />,
                  }
                : null,
              bills || folioLive || otherBills.length
                ? {
                    key: "bills",
                    label: <>Bills &amp; statements{count(bills)}</>,
                    content: (
                      <>
                        {folioLive ? (
                          // The tentative invoice, the master bill and the tax invoice before it is
                          // issued — paper rows with Preview and Send since 2026-11-10.
                          <FolioPapersCard entry={entry} />
                        ) : null}
                        {bills ? <PapersCard entry={entry} show="bills" title="Issued and sent bills" withFolioDocs={!folioLive} /> : null}
                        {otherBills.map((e) => (
                          // A stay's bill is its own, so a trip has no bill together.
                          <div key={e.id} className="trip-stay-block">
                            <StayBand stay={e} stayNo={trip.stayNoOf(e.id)} />
                            <PapersCard entry={e} show="bills" title="Bills" withFolioDocs={false} />
                          </div>
                        ))}
                      </>
                    ),
                  }
                : null,
              vouchers
                ? {
                    key: "vouchers",
                    label: <>Vouchers{count(vouchers)}</>,
                    content: trip.isTrip ? <TripPapersShelf entry={entry} show="others" title="Vouchers" sealed={sealed} has={(e) => vouchersOf(e) > 0} /> : <PapersCard entry={entry} show="others" title="Vouchers" withFolioDocs={false} />,
                  }
                : null,
              sent.length || heldOpen
                ? {
                    key: "sent",
                    label: (
                      <>
                        Sent &amp; answers
                        {awaiting + heldOpen ? <span className="n warn">{awaiting + heldOpen}</span> : count(sent.length)}
                      </>
                    ),
                    content: <SentPapers entry={entry} communications={communications} tz={tz} sealed={sealed} onGo={onGo} />,
                  }
                : null,
            ]}
          />
        )}
      </div>
    </>
  );
}

/** The number printed on the paper a communication carried — a voucher by its VOU number. */
function paperNumber(entry: EntryDetail, id: unknown): string | null {
  if (typeof id !== "string" || !id) return null;
  const res = (entry.reservations ?? []).find((r) => r.id === id);
  if (res) return res.confirmationVoucherNumber ?? id;
  if (entry.reservation?.id === id) return entry.reservation.confirmationVoucherNumber ?? id;
  return id;
}

function paperIdOf(c: EntryCommunication): unknown {
  // A pre-arrival message is not a paper with a number of its own.
  if (c.commType === "PRE_ARRIVAL_REMINDER") return null;
  const p = c.payload ?? {};
  return p.quotationId ?? p.invoiceId ?? p.reservationId ?? null;
}

/** Each paper sent, with the guest's answer, and the two things the desk does next. */
function SentPapers({
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
  const papers = communications.filter((c) => c.direction !== "INBOUND");
  // A paper made and not sent yet. A bill has no line in the list until it goes out, so it gets one here.
  const heldDocs = useHeldDocuments(entry.id).data ?? [];
  const openHeld = sealed ? [] : heldDocs.filter((h) => h.decision == null);
  const heldOf = (c: EntryCommunication) => (c.held ? openHeld.find((h) => h.documentId === paperIdOf(c)) : undefined);
  const heldWithNoLine = openHeld.filter((h) => !papers.some((c) => paperIdOf(c) === h.documentId));
  const [sending, setSending] = useState<HeldDocument | null>(null);
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
  if (papers.length === 0 && heldWithNoLine.length === 0) return null;
  const sendButton = (h: HeldDocument) => (
    <Button kind="primary" compact icon="send" onClick={() => setSending(h)}>
      Send
    </Button>
  );
  return (
    <StepCard title="Sent, and what they said">
      <table className="table compact">
        <thead>
          <tr>
            <th>Paper</th>
            <th>Sent</th>
            <th>Their answer</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {heldWithNoLine.map((h) => (
            <tr key={h.id}>
              <td>
                <b>{PAPER_NAME[h.kind === "PROFORMA" ? "PROFORMA_INVOICE" : h.kind] ?? h.kind}</b>
                <span className="mono sm"> {h.documentNumber ?? h.documentId}</span>
              </td>
              <td>
                <span className="meta">—</span>
              </td>
              <td>
                <NotSentChip />
              </td>
              <td>
                <span className="row-acts" style={{ justifyContent: "flex-end" }}>
                  {sendButton(h)}
                </span>
              </td>
            </tr>
          ))}
          {papers.map((c) => {
            const answered = c.acknowledgementStatus === "RECEIVED";
            const sent = c.sendStatus === "DISPATCHED";
            const replaced = !answered && !!c.superseded;
            const number = paperNumber(entry, paperIdOf(c));
            const replacedBy = paperNumber(entry, c.replacedBy);
            return (
              <tr key={c.id}>
                <td>
                  <b>{PAPER_NAME[c.commType] ?? c.commType}</b>
                  {number ? <span className="mono sm"> {number}</span> : null}
                  {sent ? <span className="meta"> · {c.channel?.toLowerCase() ?? "email"}</span> : null}
                </td>
                {/* A held or not-sent voucher has no "sent" moment (2026-10-29). */}
                <td>{sent ? fmtStamp(c.createdAt, tz) : <span className="meta">—</span>}</td>
                <td>
                  {answered ? (
                    <Chip tone="success">answered</Chip>
                  ) : replaced ? (
                    <span title={replacedBy ? `Replaced by ${replacedBy}` : undefined}>
                      <Chip tone="quiet">replaced — no answer needed</Chip>
                      {replacedBy ? (
                        <span className="meta">
                          {c.commType === "PRE_ARRIVAL_REMINDER" ? ` · the booking was confirmed again (${replacedBy})` : ` · by ${replacedBy}`}
                        </span>
                      ) : null}
                    </span>
                  ) : c.acknowledgementStatus === "NOT_ASKED" ? (
                    <Chip tone="quiet">no answer needed</Chip>
                  ) : c.held ? (
                    <NotSentChip />
                  ) : sent ? (
                    <Chip tone="warning">{c.isOverdue ? "no answer — chase it" : "awaiting"}</Chip>
                  ) : (
                    <Chip tone="quiet">not sent</Chip>
                  )}
                </td>
                <td>
                  <span className="row-acts" style={{ justifyContent: "flex-end" }}>
                    {!answered && !replaced && sent && c.canAcknowledge && !sealed ? (
                      <Button
                        kind="quiet"
                        compact
                        onClick={() => {
                          setMethod(null);
                          setSaid("");
                          setRecording(c);
                        }}
                      >
                        Record their answer
                      </Button>
                    ) : null}
                    {heldOf(c) ? (
                      sendButton(heldOf(c)!)
                    ) : !answered && !replaced && !sealed && (c.commType === "CONFIRMATION_VOUCHER" ? !!entry.reservation?.id : !!PAPER_STEP[c.commType]) ? (
                      <Button kind="quiet" compact state={resend.isPending ? "working" : "default"} onClick={() => sendAgain(c)}>
                        {c.held ? "Send" : "Send again"}
                      </Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sending ? <HeldSendDialog h={sending} tz={tz} onClose={() => setSending(null)} /> : null}
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
    </StepCard>
  );
}
