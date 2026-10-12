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
import { useMemo, useState } from "react";
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
import { acknowledgeCommunication, getEntryTrace, type EntryBillingSummary, type EntryCommunication } from "@/lib/api/entries";
import { updateInquiryNotes } from "@/lib/api/inquiries";
import { resendConfirmationVoucher } from "@/lib/api/confirmation";
import { fmtDateTime, fmtDay, fmtStamp, hotelFormParts, money, plural } from "@/lib/ds/format";
import { STEP_NAMES, stepNoOfStage } from "@/lib/ds/steps";
import { isHousekeeping, traceWords } from "@/lib/ds/trace-words";
import type { TraceEvent } from "@/lib/trace/humanize";
import { Choice, DsDialog, Fact, Facts, PapersCard, ReasonDialog, StepCard, SubTabs, Tool, atLeast, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import { FolioDocumentsBlock } from "@/components/desk/workspace/folio-documents";
import { HeldPapersCard } from "@/components/ds/workspace/held-papers";
import { useStayPrice, type StayPrice } from "@/lib/ds/stay-price";
import type { EntryDetail } from "@/types/api";

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

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};

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

const METHOD_WORD: Record<string, string> = {
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
  const cur = billing?.currency ?? "BTN";
  const st = billing?.stayTotal ?? null;
  const fo = billing?.folio ?? null;
  const tag = !billing
    ? null
    : billing.headline.kind === "BILLED_SO_FAR"
      ? "billed so far"
      : st?.earlyDeparture
        ? "shortened stay"
        : st?.frozen
          ? "as confirmed"
          : "indicative — not a promise until it is agreed";
  const payments = ((entry.folio?.payments ?? []) as PaymentRow[]).slice().sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
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
        <StepCard title="The price" meta={sp.source === "QUOTE" ? (tag ?? undefined) : sp.kind || undefined}>
          {sp.source === "TABLE" ? (
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
              <div className="bigfig">
                <span className="meta">Stay total</span>
                <b>{money(st.amount, cur)}</b>
                {st.basis === "PER_NIGHT_TIMES_NIGHTS" && st.perNightAmount != null ? (
                  <span className="meta">
                    {money(st.perNightAmount, cur)} a night{st.nights != null ? ` · ${plural(st.nights, "night")}` : ""}
                  </span>
                ) : null}
              </div>
              {st.earlyDeparture ? (
                <p className="meta">
                  Shortened: {st.earlyDeparture.sleptNights} nights slept · {money(st.earlyDeparture.forgoneRoomTotal, cur)} not charged
                </p>
              ) : null}
              {billing?.rooms?.length ? (
                <table className="table compact" style={{ marginTop: 8 }}>
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
                        <td>{r.nights ?? "—"}</td>
                        <td className="num">{money(r.roomSubtotal, cur)}</td>
                        <td className="num">{(r.mealsSubtotal ?? 0) > 0 ? money(r.mealsSubtotal, cur) : "—"}</td>
                        <td className="num">{r.extraBedCount > 0 ? money(r.extraBedSubtotal, cur) : "—"}</td>
                        <td className="num">{r.serviceCharge != null || r.gst != null ? money((r.serviceCharge ?? 0) + (r.gst ?? 0), cur) : "—"}</td>
                        <td className="num">
                          <b>{money(r.total, cur)}</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <p className="meta" style={{ marginTop: 6 }}>
                Room, meals and bed are before tax; each room&rsquo;s total adds the 10% service charge and the 5% GST.
                {billing?.rooms?.some((r) => r.componentsPreDiscount) ? " The parts are before the booking discount; the totals after it." : ""}
                {st.segmentNumber != null && (entry.segmentNumber ?? 1) > 1 ? ` Priced on pass ${st.segmentNumber}.` : ""}
              </p>
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
        <StepCard title="The bill" meta={entry.folio?.billingModel ? BILLING_WORD[entry.folio.billingModel] ?? entry.folio.billingModel : "who pays is chosen at Set up"}>
          {!fo ? (
            <p className="meta">No bill yet — it starts at Set up, and charges post on it from check-in.</p>
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
                {fo.writtenOff ? <Fact k="Written off">{money(fo.writtenOff, cur)}</Fact> : null}
                {fo.overpaid ? <Fact k="Paid above the bill">{money(fo.overpaid, cur)}</Fact> : null}
              </Facts>
              <div className={`balance-line ${balance != null && balance > 0.005 ? "due" : "clear"}`}>
                <span>Balance due</span>
                <b>{money(balance, cur)}</b>
              </div>
              {parts.length > 1 ? (
                <table className="table compact" style={{ marginTop: 10 }}>
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
                        <td className="num">{money(x.b.base, cur)}</td>
                        <td className="num">{money(x.b.serviceCharge, cur)}</td>
                        <td className="num">{money(x.b.gst, cur)}</td>
                        <td className="num">
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
                  {payments.length ? <span className="n">{payments.length}</span> : null}
                </>,
              content: (
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
              <Fact k="Advance asked" meta={p.requirementSource === "OPERATOR" ? "set for this booking" : "the house's rule"}>
                {p.requiredAmount > 0 ? money(p.requiredAmount, cur) : "none asked"}
              </Fact>
              <Fact k="Received">{money(p.totalReceived, cur)}</Fact>
              {p.shortfall > 0.005 ? <Fact k="Still to come">{money(p.shortfall, cur)}</Fact> : null}
              {p.paymentPlan ? (
                <Fact k="What they said" meta={p.paymentPlan.promiseOverdue ? "the promised time has passed" : undefined}>
                  {p.paymentPlan.promisedBy ? `by ${fmtDateTime(p.paymentPlan.promisedBy, tz)}` : p.paymentPlan.balanceDueAt === "AT_CHECKIN" ? "at check-in" : "paying now"}
                </Fact>
              ) : null}
              {p.creditExtensionActive ? (
                <Fact k="Credit extended" meta={p.creditExtensionExpiresAt ? `until ${fmtDateTime(p.creditExtensionExpiresAt, tz)}` : undefined}>
                  {money(p.ceilingAmount, cur)}
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
          ]}
        />
      </div>
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
      <table className="table compact" style={{ marginTop: 8 }}>
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
          {p.rooms.map((r) => (
            <tr key={r.roomId}>
              <td>
                <b>Room {r.roomNumber ?? "—"}</b>
                {r.isFoc ? <span className="meta"> · free of charge</span> : null}
              </td>
              <td>{r.nights}</td>
              <td className="num">{money(r.roomSubtotal, cur)}</td>
              <td className="num">{r.mealsSubtotal > 0 ? money(r.mealsSubtotal, cur) : "—"}</td>
              <td className="num">{r.extraBedCount > 0 ? money(r.extraBedSubtotal, cur) : "—"}</td>
              <td className="num">{money(r.serviceCharge + r.gst, cur)}</td>
              <td className="num">
                <b>{money(r.total, cur)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Facts wide style={{ marginTop: 8 }}>
        <Fact k="Net">{money(p.payableSubtotal, cur)}</Fact>
        <Fact k="Service charge">{money(p.payableServiceCharge, cur)}</Fact>
        <Fact k="GST">{money(p.payableGst, cur)}</Fact>
        {p.discount ? (
          <Fact k="Discount" meta={p.discount.requestedPercent != null ? `${p.discount.requestedPercent}% asked` : "a set amount"}>
            − {money(p.discount.amountOffTotal, cur)}
          </Fact>
        ) : null}
      </Facts>
      <p className="meta" style={{ marginTop: 6 }}>
        The figures follow the negotiation table as it is changed — priced by the hotel server, the same way the quotation will be.
      </p>
    </>
  );
}

/** The rooms picked at Inquiry, priced rooms only by the server. */
function PicksPrice({ sp }: { sp: StayPrice }) {
  const p = sp.pick;
  const cur = sp.currency;
  if (!p) return null;
  return (
    <>
      <div className="bigfig">
        <span className="meta">Stay total · rooms only</span>
        <b>{money(p.totals.total, cur)}</b>
        {sp.loading ? <span className="meta">updating…</span> : null}
      </div>
      <table className="table compact" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>Room type</th>
            <th>Room-nights</th>
            <th className="num">Rate a night</th>
            <th className="num">Net</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {p.byType.map((t) => (
            <tr key={t.roomTypeId}>
              <td>
                <b>{t.name}</b>
                {t.packageName ? <span className="meta"> · {t.packageName}</span> : null}
              </td>
              <td>{t.roomNights}</td>
              <td className="num">{t.rate != null ? money(t.rate, cur) : "no rate"}</td>
              <td className="num">{money(t.net, cur)}</td>
              <td className="num">
                <b>{money(t.total, cur)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Facts wide style={{ marginTop: 8 }}>
        <Fact k="Net">{money(p.totals.net, cur)}</Fact>
        <Fact k="Service charge">{money(p.totals.serviceCharge, cur)}</Fact>
        <Fact k="GST">{money(p.totals.gst, cur)}</Fact>
      </Facts>
      {p.unpricedTypes.length ? (
        <p className="warn-ink sm">No rate on file for {p.unpricedTypes.map((t) => t.name).join(", ")} — not counted above.</p>
      ) : null}
    </>
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
          meta={
            items.length
              ? open
                ? <span className="warn-ink"><b>{plural(open, "request")} still to arrange</b></span>
                : <span className="ok-ink"><b>everything asked is arranged</b></span>
              : "something to arrange — a pickup, a cake, an early room; taken at any step"
          }
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
                        Take back…
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
                <label>For which day · optional</label>
                <input className="input" type="date" value={forDate} min={minDate} max={maxDate} onChange={(e) => setForDate(e.target.value)} />
                <span className="hint">from today to the day they leave</span>
              </div>
              <div className="field">
                <label>Time · optional</label>
                <input className="input" type="time" value={forTime} onChange={(e) => setForTime(e.target.value)} />
                <span className="hint">the hotel&rsquo;s clock</span>
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
                <label>By when</label>
                <select className="input" value={due} onChange={(e) => setDue(e.target.value as DueChoice)}>
                  {dueOptions.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <span className="hint">the hotel&rsquo;s clock</span>
              </div>
              {due === "PICK" ? (
                <div className="field">
                  <label>Day and time</label>
                  <div className="row-acts">
                    <input className="input" type="date" min={day?.today} value={pickDate} onChange={(e) => setPickDate(e.target.value)} />
                    <input className="input" type="time" value={pickTime} onChange={(e) => setPickTime(e.target.value)} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </StepCard>
        {todos.length ? (
          <StepCard
            title="To-dos"
            meta={
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
        <StepCard title="Notes" meta={notes.length + termNotes.length ? plural(notes.length + termNotes.length, "note") : undefined}>
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
  // One sub-tab per kind of paper (2026-10-12, operator: "for papers it should be divided among
  // different types of papers"). A kind with nothing in it has no tab.
  const quotes = (entry.quotations ?? []).length;
  const invoices = entry.folio?.invoices ?? [];
  const proformas = invoices.filter((i) => i.invoiceType === "PROFORMA").length;
  const bills = invoices.filter((i) => i.invoiceType !== "PROFORMA").length;
  const vouchers = (entry.reservation?.id ? 1 : 0) + (entry.status === "CANCELLED" ? 1 : 0);
  const sent = communications.filter((c) => c.direction !== "INBOUND");
  const awaiting = sent.filter((c) => c.sendStatus === "DISPATCHED" && c.acknowledgementStatus !== "RECEIVED").length;
  const count = (n: number) => (n ? <span className="n">{n}</span> : null);
  return (
    <>
      <h3>
        Documents <span className="need">every paper, every version, and what the guest said back</span>
      </h3>
      <div className="steps-canvas">
        <HeldPapersCard entryId={entry.id} tz={tz} />
        {quotes + invoices.length + vouchers + sent.length === 0 && !folioLive ? (
          <EmptyState title="No papers yet">A quotation is the first — it is generated at Negotiation.</EmptyState>
        ) : (
          <SubTabs
            label="Documents"
            tabs={[
              quotes ? { key: "quotations", label: <>Quotations{count(quotes)}</>, content: <PapersCard entry={entry} show="quotes" title="Quotations" /> } : null,
              proformas
                ? { key: "proformas", label: <>Proforma invoices{count(proformas)}</>, content: <PapersCard entry={entry} show="proformas" title="Proforma invoices" /> }
                : null,
              bills || folioLive
                ? {
                    key: "bills",
                    label: <>Bills &amp; statements{count(bills)}</>,
                    content: (
                      <>
                        {bills ? <PapersCard entry={entry} show="bills" title="Bills" withFolioDocs={!folioLive} /> : null}
                        {folioLive ? (
                          // The interim statement, the master bill and the tax invoice — views of the
                          // bill as it stands (moved here from Stay's own tab, 2026-10-12).
                          <Tool inert={false}>
                            <FolioDocumentsBlock entry={entry} stage="S7" />
                          </Tool>
                        ) : null}
                      </>
                    ),
                  }
                : null,
              vouchers
                ? { key: "vouchers", label: <>Vouchers{count(vouchers)}</>, content: <PapersCard entry={entry} show="others" title="Vouchers" withFolioDocs={false} /> }
                : null,
              sent.length
                ? {
                    key: "sent",
                    label: (
                      <>
                        Sent &amp; answers
                        {awaiting ? <span className="n warn">{awaiting}</span> : count(sent.length)}
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
  if (papers.length === 0) return null;
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
          {papers.map((c) => {
            const answered = c.acknowledgementStatus === "RECEIVED";
            const sent = c.sendStatus === "DISPATCHED";
            return (
              <tr key={c.id}>
                <td>
                  <b>{PAPER_NAME[c.commType] ?? c.commType}</b>
                  <span className="meta"> · {c.channel?.toLowerCase() ?? "email"}</span>
                </td>
                <td>{fmtStamp(c.createdAt, tz)}</td>
                <td>{answered ? <Chip tone="success">answered</Chip> : sent ? <Chip tone="warning">{c.isOverdue ? "no answer — chase it" : "awaiting"}</Chip> : <Chip tone="quiet">not sent</Chip>}</td>
                <td>
                  <span className="row-acts" style={{ justifyContent: "flex-end" }}>
                    {!answered && sent && c.canAcknowledge && !sealed ? (
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
                    {!answered && !sealed && (c.commType === "CONFIRMATION_VOUCHER" ? !!entry.reservation?.id : !!PAPER_STEP[c.commType]) ? (
                      <Button kind="quiet" compact state={resend.isPending ? "working" : "default"} onClick={() => sendAgain(c)}>
                        Send again
                      </Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
