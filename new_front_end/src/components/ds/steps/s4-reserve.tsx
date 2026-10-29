"use client";

/**
 * Step 4 · Reserve — "freeze the booking" (SS03 §7 as amended by R1–R4, prototype `stepCanvas[4]`).
 *
 * Before the click: *facts, not ticks*. Each thing the desk did at Negotiation and Set up shows as
 * a line with who recorded it and when — "on record", or a Fix that goes to the step where it is
 * put right. Only what the system cannot know asks for a word. The system's own checks sit in grey.
 * Reserve is one signature over the set; the button opens the workspace's commit dialog.
 *
 * After the click: the record of what Reserve decided, the confirmation voucher and the guest's
 * answer to it (Arrival waits for that answer), the pre-arrival tasks Reserve opened, and the
 * advance, which can still come in before Arrival.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Refusal } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { useStaffNames } from "@/hooks/use-desk-data";
import { acknowledgeMultiBooking, resendConfirmationVoucher, verifyConference } from "@/lib/api/confirmation";
import { getBillingSummary, getEntryTrace, getJourneySummary, type EntryCommunication } from "@/lib/api/entries";
import { listSameGuestBookings } from "@/lib/api/guest-bookings";
import { HeldPaperRow, useHeldDocuments } from "@/components/ds/workspace/held-papers";
import { confirmReadiness, reservedThisPass } from "@/lib/desk/workspace";
import { fmtDate, fmtDateTime, fmtRange, fmtStamp, money, nightsOf, plural } from "@/lib/ds/format";
import { roomRatesOf } from "@/lib/ds/rates";
import { JourneySummaryPanel } from "@/components/desk/workspace/journey-summary";
import { AdvanceSettlementBlock, PLAN_LABEL, dueLabel } from "@/components/desk/workspace/advance-settlement";
import type { EntryDetail, PaymentStatusSummary, QuotationSummary } from "@/types/api";
import {
  DsDialog,
  FactBox,
  FactLine,
  Facts,
  Fact,
  Live,
  OnRecord,
  PaperDrawer,
  StepCanvas,
  StepCard,
  Tool,
  AnswerLine,
  atLeast,
  currentPassStart,
  latestDispatched,
  toastRefusal,
  useCommunications,
  useFinishWhenDone,
  useRefreshEntry,
  useStepMode,
  useStepPane,
  words,
  type FactState,
  type PaperRef,
} from "./kit";
import { BookingOtherWays } from "./s4-other-ways";
import { roomsHeldWord } from "./s2-shared";
import { PreArrivalTasksCard, RESERVE_PREP_TASKS } from "./s5-pre-arrival-tasks";
import { Help } from "@/components/ds/help";

/* ------------------------------------------------------------------ vocabulary */

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};

/** The billing model in the desk's words (ruling S1). */
export function billingWord(code?: string | null): string {
  if (!code) return "";
  return BILLING_WORD[code] ?? words(code);
}

export const BILLING_CHOICES = [
  ["TOUR_OPERATOR_VOUCHER", BILLING_WORD.TOUR_OPERATOR_VOUCHER],
  ["DIRECT_BILL", BILLING_WORD.DIRECT_BILL],
  ["GUEST_PAY", BILLING_WORD.GUEST_PAY],
] as const;

const QUOTE_WORD: Record<string, string> = {
  DRAFT: "ready to send",
  SENT: "sent",
  ACCEPTED: "accepted",
  EXPIRED: "lapsed",
  SUPERSEDED: "replaced",
};

const HOLD_WORD: Record<string, string> = {
  PLACED: "held",
  UPGRADED: "held",
  CONFIRMED: "confirmed by Reserve",
  RELEASED: "released",
  EXPIRED: "lapsed",
};

const ANSWER_WORD: Record<string, string> = { WRITTEN: "they wrote to us", VERBAL: "they told us" };

/** "answered · they told us “…”", or null when nothing is on record yet. */
export function answerWords(c: EntryCommunication | undefined): string | null {
  if (!c || c.acknowledgementStatus !== "RECEIVED") return null;
  const p = (c.payload ?? {}) as { acknowledgementMethod?: string; verbatimNote?: string };
  const how = ANSWER_WORD[p.acknowledgementMethod ?? ""] ?? "answered";
  const said = p.verbatimNote?.trim();
  return `${how}${said ? ` · “${said.length > 60 ? `${said.slice(0, 60)}…` : said}”` : ""}`;
}

type EntryScalars = {
  reservationPaymentPending?: boolean | null;
  contactPersonName?: string | null;
  contactPersonPhone?: string | null;
};

type TraceItem = { eventType: string; timestamp: string; payload: unknown };

function useTrace(entryId: string) {
  const { session } = useSession();
  // Same key and limit as the old voucher panel, so the two share one read.
  return useQuery({
    queryKey: ["entry-trace", entryId],
    queryFn: () => getEntryTrace(session!, entryId, 80),
    enabled: !!session,
  });
}

function useJourney(entryId: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["journey-summary", entryId],
    queryFn: () => getJourneySummary(session!, entryId),
    enabled: !!session,
  });
}

function useBilling(entry: EntryDetail) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session,
  });
}

/** The quotation the freeze would take as its basis — the gate's own choice, within this pass. */
function operativeQuote(entry: EntryDetail): QuotationSummary | null {
  const segId = entry.segments?.[0]?.id ?? null;
  const live = (entry.quotations ?? []).filter(
    (q) => ["DRAFT", "SENT", "ACCEPTED"].includes(q.state) && (!segId || q.segmentId === segId),
  );
  return live.find((q) => q.state === "ACCEPTED") ?? live.find((q) => q.state === "SENT") ?? live[0] ?? null;
}

/* ------------------------------------------------------------------ the step */

export function S4Reserve({
  entry,
  past,
  parkNow,
  parking,
  goToStep,
  reserve,
  onOpenItems,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  goToStep: (n: number) => void;
  reserve: { onClick: () => void; ready: boolean; reason?: string } | null;
  /** Open items only this canvas knows (conference verification, the desk's own words) — the
   *  workspace adds them to the gate so both Reserve buttons agree. */
  onOpenItems?: (items: string[]) => void;
}) {
  const confirmed = reservedThisPass(entry);
  // Reserve in the stage layout (2026-10-29, operator: "now can we make the new UI changes to stage
  // 4 and 5"): its Rooms tab became Change booking's "Move a room", opened in the page as at Set up.
  const stepPane = useStepPane();
  return (
    <StepCanvas past={past}>
      {confirmed ? (
        <>
          {/* The work first — the voucher and the guest's answer, which Arrival waits for — then
              the record of what was reserved. */}
          <VoucherCard entry={entry} />
          <WhatReserveDecided entry={entry} />
          <PreArrivalTasksCard
            entry={entry}
            title="Pre-arrival · opened by Reserve, worked at Arrival"
            meta="Four of these are the desk's own preparation and can be ticked here; the rest are done at Arrival. When Arrival opens, completed tasks re-open so the arrival desk confirms them fresh."
            actionable={RESERVE_PREP_TASKS}
            movedOn={past && entry.currentStage === "S5" ? { onGo: () => goToStep(5) } : null}
          />
          <StepCard>
            <Tool>
              <AdvanceSettlementBlock
                entry={entry}
                title="The advance"
                intro="The booking is reserved; the rest of the advance can still be paid here before Arrival. It goes on the same bill as the advance already paid."
              />
            </Tool>
          </StepCard>
        </>
      ) : (
        <>
          <BeforeYouReserve entry={entry} goToStep={goToStep} reserve={reserve} onOpenItems={onOpenItems} />
          <WhoReceives entry={entry} />
          <SoFar entry={entry} />
        </>
      )}
      <BookingOtherWays entry={entry} parkNow={parkNow} parking={parking} onMoveRoom={past ? undefined : () => stepPane.open("rooms")} />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ before the click */

type Line = {
  key: string;
  label: string;
  value: React.ReactNode;
  who?: React.ReactNode;
  state: FactState;
  fix?: number;
  action?: React.ReactNode;
};

const KNOWN = [
  "Quote generated",
  "Who pays chosen",
  "Cancellation terms recorded",
  "Proforma invoice generated",
  "Proforma sent to guest",
  "Guest's answer to the proforma recorded",
  "Advance settled or credit extended",
  "Rooms blocked",
  "A contact on file",
];

function BeforeYouReserve({
  entry,
  goToStep,
  reserve,
  onOpenItems,
}: {
  entry: EntryDetail;
  goToStep: (n: number) => void;
  reserve: { onClick: () => void; ready: boolean; reason?: string } | null;
  onOpenItems?: (items: string[]) => void;
}) {
  // A room the system chose and may still move reads "Deluxe Double · room 1" until Arrival.
  const roomByNo = useBookingRooms(entry).byNumber;
  const { session } = useSession();
  const { past } = useStepMode();
  const clock = useHotelClock(60_000);
  const tz = clock.tz;
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio }).data;
  const comms = useCommunications(entry.id).data?.items ?? null;
  const journey = useJourney(entry.id).data ?? null;
  const billing = useBilling(entry).data ?? null;
  const trace = useTrace(entry.id).data?.items ?? [];
  const asked = useRequestWords(entry, session?.displayName ?? session?.username ?? "the desk");
  const since = currentPassStart(entry);
  const cur = billing?.currency ?? "BTN";

  const checks = confirmReadiness(entry, {
    paymentSatisfied: pay?.satisfied,
    totalReceived: pay?.totalReceived ?? null,
    requiredAmount: pay?.requiredAmount ?? null,
    communications: comms,
  });
  const check = (prefix: string) => checks.find((c) => c.label.startsWith(prefix));
  const metOr = (prefix: string, dflt = true) => check(prefix)?.met ?? dflt;

  const lines: Line[] = [];

  /* the quote */
  const quote = operativeQuote(entry);
  const quoteAnswer = answerWords(latestDispatched(comms ?? undefined, "QUOTATION", since));
  const jq = journey?.s2Quote;
  const sameQuote = !!quote && jq?.reference === quote.referenceNumber;
  lines.push({
    key: "quote",
    label: quote?.state === "ACCEPTED" ? "Accepted quotation" : "Quotation",
    value: quote ? (
      <>
        {quote.referenceNumber} · {QUOTE_WORD[quote.state] ?? words(quote.state)}
        {quoteAnswer ? ` · ${quoteAnswer}` : ""}
      </>
    ) : (
      "no quotation in this pass — Negotiation"
    ),
    who: quote
      ? quote.state === "ACCEPTED"
        ? `${sameQuote && jq?.acceptedByName ? `${jq.acceptedByName} · ` : ""}accepted ${fmtStamp(quote.acceptedAt, tz)}`
        : quote.state === "SENT"
          ? `sent ${fmtStamp(quote.sentAt, tz)}${quote.sentTo ? ` to ${quote.sentTo}` : ""}`
          : `${sameQuote && jq?.draftedBy ? `${jq.draftedBy} · ` : ""}generated ${fmtStamp(quote.createdAt, tz)} · sending it is optional`
      : undefined,
    state: quote ? "on" : "missing",
    fix: 2,
  });

  /* the parties and the rate */
  const party = journey?.s1Inquiry.commercialContext;
  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const guestName = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ") || guest?.displayName || "the guest";
  const rateSource = jq?.agentRateDetail?.source ?? null;
  lines.push({
    key: "rate",
    label: "Parties and the rate",
    value: quote ? (
      <>
        <b>{party?.partyName ?? "Direct"}</b> for {guestName}
        {jq?.nightlyRate != null && sameQuote ? ` · ${money(jq.nightlyRate, jq.currency ?? cur)} / night` : ""}
        {billing?.stayTotal.amount != null ? ` · ${money(billing.stayTotal.amount, cur)} for the stay` : ""}
      </>
    ) : (
      "the price comes with the quotation"
    ),
    who: quote
      ? party?.type === "TRAVEL_AGENT" || party?.type === "CORPORATE"
        ? rateSource
          ? `the account's rate · ${words(rateSource)}`
          : "the account's rate"
        : "published rates · the price freezes on the click"
      : undefined,
    state: quote ? "on" : "waiting",
  });

  /* the billing model */
  const folio = entry.folio ?? null;
  const lastModelChange = folio?.billingModelTransitions?.[0] ?? null;
  lines.push({
    key: "billing",
    label: "Who pays",
    value: folio?.billingModel ? billingWord(folio.billingModel) : "not set — Set up",
    who: folio?.billingModel
      ? lastModelChange
        ? `set ${fmtStamp(lastModelChange.createdAt, tz)}`
        : "set at Set up"
      : undefined,
    state: metOr("Who pays chosen") ? "on" : "missing",
    fix: 3,
  });

  /* the rooms held */
  const hold = entry.committedHold ?? null;
  const holdJ = journey?.s3Setup.committedHold ?? null;
  // Counted by type while the system may still move them; a room given by number by its number (2026-10-29).
  const holdRooms = holdJ?.rooms ?? [];
  const holdWord = holdRooms.length
    ? roomsHeldWord(holdRooms.map((r) => ({ number: r.roomNumber, typeName: r.roomTypeName, quiet: !!r.roomNumber && roomByNo.has(r.roomNumber) })))
    : null;
  const holdOk = metOr("Rooms blocked");
  lines.push({
    key: "hold",
    label: "Rooms held",
    value: hold ? (
      <>
        {holdWord ?? "the rooms"} · {HOLD_WORD[hold.state] ?? words(hold.state)}
        {holdOk ? ` until ${fmtDateTime(hold.expiresAt, tz)}` : hold.state === "EXPIRED" ? ` at ${fmtDateTime(hold.expiresAt, tz)} — hold them again at Set up` : " — hold them again at Set up"}
        {hold.commercialJustification ? ` · ${hold.commercialJustification.slice(0, 60)}` : ""}
      </>
    ) : (
      "not held — Set up"
    ),
    who: hold ? `placed ${fmtStamp(hold.placedAt, tz)}${holdJ?.placedBy ? ` · ${holdJ.placedBy}` : ""}` : undefined,
    state: holdOk ? "on" : "missing",
    fix: 3,
  });

  /* the terms disclosed */
  const disc = entry.cancellationDisclosure ?? null;
  const discJ = journey?.s3Setup.cancellation ?? null;
  lines.push({
    key: "terms",
    label: "Terms disclosed",
    value: disc
      ? `cancellation and no-show · ${disc.noShowTreatmentStatement.length > 80 ? `${disc.noShowTreatmentStatement.slice(0, 80)}…` : disc.noShowTreatmentStatement}`
      : "not yet — Set up · record that the terms were told",
    who: disc ? `${discJ?.disclosedBy ? `${discJ.disclosedBy} · ` : ""}${fmtStamp(disc.disclosedAt, tz)}` : undefined,
    state: metOr("Cancellation terms recorded") ? "on" : "missing",
    fix: 3,
  });

  /* the advance */
  const advCheck = check("Advance settled or credit extended");
  lines.push(
    folio
      ? advanceLine(pay, advCheck ? advCheck.met : null, cur, tz)
      : { key: "advance", label: "Advance", value: "no folio yet — Set up opens it", state: advCheck && !advCheck.met ? "missing" : "waiting", fix: 3 },
  );

  /* the proforma and the guest's answer */
  const proformas = (folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED");
  const pi = proformas[0] ?? null;
  const piComm = latestDispatched(comms ?? undefined, "PROFORMA_INVOICE", since);
  const piAnswer = answerWords(piComm);
  const piOk = metOr("Proforma invoice generated", false) && metOr("Proforma sent to guest") && metOr("Guest's answer to the proforma recorded");
  const piSent = !!pi && (pi.dispatchedAt != null || pi.state !== "DRAFT");
  lines.push({
    key: "proforma",
    label: "Proforma and the answer",
    value: pi ? (
      <>
        {pi.invoiceNumber ?? pi.id} · {piSent ? `sent${pi.dispatchedTo ? ` to ${pi.dispatchedTo}` : ""}` : "generated, not sent"}
        {piSent ? (piAnswer ? ` · ${piAnswer}` : " · their answer is not on record — Set up") : ""}
        {!metOr("Proforma sent to guest") ? " · money came in, so it must go out first" : ""}
      </>
    ) : (
      "not generated — Set up"
    ),
    who: pi ? (piSent ? `sent ${fmtStamp(pi.dispatchedAt, tz)}` : `generated ${fmtStamp(pi.createdAt, tz)} · sending it is optional`) : undefined,
    state: piOk ? "on" : "missing",
    fix: 3,
  });

  /* the guest's contact */
  const guestReach = [guest?.email, guest?.phone].filter(Boolean).join(" · ");
  const bookingReach = [entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ");
  lines.push({
    key: "contact",
    label: "Contact",
    value: guestReach || (entry.contactPersonPhone ? bookingReach : "") || "no email or phone on the booking",
    who: guestReach ? "on the guest's record" : entry.contactPersonPhone ? "the booking's contact" : undefined,
    state: metOr("A contact on file") ? "on" : "missing",
    fix: 1,
  });

  /* any readiness item this list does not name — never hidden */
  for (const c of checks) {
    if (c.met || KNOWN.some((k) => c.label.startsWith(k))) continue;
    lines.push({ key: c.label, label: c.label, value: "not yet on record", state: "missing", fix: 3 });
  }

  /* conference verification — a gate the backend applies at the click */
  const conference = entry.useType === "CONFERENCE";
  const conferenceDone = trace.some((t) => t.eventType === "CONFERENCE.VERIFIED");
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [overlapOpen, setOverlapOpen] = useState(false);
  const fom = atLeast(session?.actorLevel, "L2");
  // The guest's other reserved booking over these nights — what Reserve asks the FOM about
  // (Policy 13), read the gate's own way (2026-10-29). Said here with its act, only when it is so.
  const overlapQ = useQuery({
    queryKey: ["guest-bookings", entry.id, "reserve", entry.updatedAt],
    queryFn: () => listSameGuestBookings(session!, entry.id),
    enabled: !!session,
  });
  const overlap = overlapQ.data?.reserveOverlap ?? null;
  const overlapOpenItem = !!overlap && !overlap.acknowledged;
  if (overlap) {
    lines.push({
      key: "overlap",
      label: "The guest's other booking",
      value: overlap.acknowledged
        ? `${overlap.entryId} (${fmtRange(overlap.checkInDate, overlap.checkOutDate)}) — both bookings are meant`
        : `${overlap.entryId} is reserved over these nights (${fmtRange(overlap.checkInDate, overlap.checkOutDate)})`,
      who: overlap.acknowledged ? "acknowledged by the FOM" : "the FOM says whether both are meant before Reserve",
      state: overlap.acknowledged ? "on" : "missing",
      action:
        overlap.acknowledged || past ? undefined : (
          <Button
            className="go"
            state={fom ? "default" : "inert"}
            title={fom ? undefined : "needs the FOM"}
            reason={fom ? undefined : "The FOM's call"}
            onClick={() => setOverlapOpen(true)}
          >
            Acknowledge the overlap
          </Button>
        ),
    });
  }
  if (conference) {
    lines.push({
      key: "conference",
      label: "Conference verification",
      value: conferenceDone ? "venue, catering and AV verified" : "venue, catering and AV not yet verified",
      who: conferenceDone ? "by the FOM" : "the FOM verifies it before Reserve",
      state: conferenceDone ? "on" : "missing",
      action: conferenceDone || past ? undefined : (
        <Button kind="secondary" compact state={fom ? "default" : "inert"} title={fom ? undefined : "needs the FOM"} onClick={() => setVerifyOpen(true)}>
          Verify
        </Button>
      ),
    });
  }

  const missing = lines.filter((l) => l.state === "missing");
  const done = lines.filter((l) => l.state !== "missing");
  const openWords = asked.items.filter((w) => !asked.saved[w.id]).length;

  const renderLine = (l: Line) => (
    <FactLine
      key={l.key}
      label={l.label}
      value={l.value}
      who={l.who}
      state={l.state}
      action={
        l.action ??
        (l.state === "missing" && l.fix && !past ? (
          <Button kind="secondary" compact onClick={() => goToStep(l.fix!)}>
            Fix
          </Button>
        ) : undefined)
      }
    />
  );

  const extraOpen = [
    ...(conference && !conferenceDone ? ["The conference verified by the FOM"] : []),
    ...(overlapOpenItem ? ["The guest's other booking acknowledged by the FOM"] : []),
    ...(openWords ? [`${openWords === 1 ? "One thing" : `${openWords} things`} only you can know, said`] : []),
  ].join("|");
  useEffect(() => {
    onOpenItems?.(extraOpen ? extraOpen.split("|") : []);
  }, [extraOpen, onOpenItems]);
  useEffect(() => () => onOpenItems?.([]), [onOpenItems]);

  // The overlap is not a fact to fix but the FOM's answer, so it is said in its own words.
  const toFix = missing.filter((l) => l.key !== "overlap").length;
  const inertWhy = toFix
    ? `${plural(toFix, "fact")} missing — Fix ${toFix === 1 ? "it" : "them"} first`
    : overlapOpenItem
      ? "The FOM says whether both of this guest's bookings are meant — Acknowledge the overlap"
      : openWords
      ? `${openWords === 1 ? "one thing" : `${openWords} things`} only you can know — say how ${openWords === 1 ? "it was" : "they were"} arranged`
      : reserve && !reserve.ready
        ? reserve.reason ?? "the list at the foot of the page names what is left"
        : null;

  return (
    <>
      <StepCard
        flow="facts"
        title="Before you reserve"
        meta="Each line is a fact already on record, with who recorded it and when. Nothing to tick — if a line is wrong or missing, Fix takes you to it. Reserve is your signature on the set."
        // What still stands in the way, said where the lines are; once nothing does, Reserve the
        // booking floats in at the foot of the page (2026-10-29).
        status={
          inertWhy ? (
            <span className="warn-ink">{inertWhy}</span>
          ) : entry.status === "PARKED" ? (
            <span className="warn-ink">Parked — resume the booking to reserve it</span>
          ) : reserve ? (
            <span className="ok-ink">Everything is on record — Reserve the booking</span>
          ) : undefined
        }
      >
        {missing.map(renderLine)}
        {done.map(renderLine)}
        {asked.items.map((w) => (
          <WordRow key={w.id} item={w} saved={asked.saved[w.id]} onRecord={(word) => asked.record(w.id, word)} onUndo={() => asked.undo(w.id)} tz={tz} />
        ))}
      </StepCard>

      <ConferenceVerifyDialog entry={entry} open={verifyOpen} onClose={() => setVerifyOpen(false)} />
      <OverlapDialog entry={entry} open={overlapOpen} onClose={() => setOverlapOpen(false)} />
    </>
  );
}

function advanceLine(pay: PaymentStatusSummary | undefined, met: boolean | null, cur: string, tz: string): Line {
  if (!pay) return { key: "advance", label: "Advance", value: "reading the payment position…", state: "waiting", fix: 3 };
  const plan = pay.paymentPlan ?? null;
  const planWords = plan ? `${PLAN_LABEL[plan.plan]}${plan.balanceDueAt ? ` · ${dueLabel(plan.plan, plan.balanceDueAt)}` : ""}${plan.promisedBy ? ` by ${fmtDateTime(plan.promisedBy, tz)}` : ""}` : null;
  const last = pay.installments?.length ? pay.installments[pay.installments.length - 1] : null;
  if (met === null) {
    return {
      key: "advance",
      label: "Advance",
      value: pay.totalReceived > 0 ? `not required · ${money(pay.totalReceived, cur)} received anyway` : "not required for this booking",
      state: "on",
      action: <Chip tone="quiet">not needed</Chip>,
    };
  }
  if (met) {
    return {
      key: "advance",
      label: "Advance",
      value: pay.paidInFull
        ? `${money(pay.totalReceived, cur)} received of ${money(pay.requiredAmount, cur)}`
        : pay.creditExtensionActive
          ? `${money(pay.totalReceived, cur)} received of ${money(pay.requiredAmount, cur)} · the rest on credit up to ${money(pay.ceilingAmount, cur)}`
          : `${money(pay.totalReceived, cur)} received of ${money(pay.requiredAmount, cur)}`,
      who: [last ? `last payment ${fmtStamp(last.receivedAt, tz)}` : null, planWords].filter(Boolean).join(" · ") || undefined,
      state: "on",
    };
  }
  return {
    key: "advance",
    label: "Advance",
    value: `${money(pay.shortfall, cur)} still to come of ${money(pay.requiredAmount, cur)}${pay.creditExtensionExpired ? " · the credit extension has run out" : ""}`,
    who: planWords ?? (pay.totalReceived > 0 ? `${money(pay.totalReceived, cur)} received so far` : "nothing received yet"),
    state: "missing",
    fix: 3,
  };
}

/* ---- what only the desk can know (the prototype's reading of the notes) ---- */

type WordItem = { id: string; k: string; note: string };
type SavedWord = { word: string; at: string; by: string };

function useRequestWords(entry: EntryDetail, by: string) {
  const notes = entry.inquiry?.notes?.trim() ?? "";
  const items = useMemo<WordItem[]>(() => {
    const out: WordItem[] = [];
    if (!notes) return out;
    if (/late|arriv.*night|after 9|after 10/i.test(notes)) out.push({ id: "late", k: "Late arrival · dinner arranged with the kitchen", note: notes });
    if (/cake|anniversary|birthday|honeymoon|request|special/i.test(notes)) out.push({ id: "special", k: "Special request · arranged", note: notes });
    return out;
  }, [notes]);
  const key = `desk:reserve-words:${entry.id}`;
  const [saved, setSaved] = useState<Record<string, SavedWord>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setSaved(raw ? (JSON.parse(raw) as Record<string, SavedWord>) : {});
    } catch {
      setSaved({});
    }
  }, [key]);
  const store = (next: Record<string, SavedWord>) => {
    try {
      if (Object.keys(next).length) localStorage.setItem(key, JSON.stringify(next));
      else localStorage.removeItem(key);
    } catch {
      /* the word just won't survive a reload */
    }
  };
  const record = (id: string, word: string) =>
    setSaved((p) => {
      const next = { ...p, [id]: { word, at: new Date().toISOString(), by } };
      store(next);
      return next;
    });
  const undo = (id: string) =>
    setSaved((p) => {
      const next = { ...p };
      delete next[id];
      store(next);
      return next;
    });
  return { items, saved, record, undo };
}

function WordRow({
  item,
  saved,
  onRecord,
  onUndo,
  tz,
}: {
  item: WordItem;
  saved?: SavedWord;
  onRecord: (word: string) => void;
  onUndo: () => void;
  tz: string;
}) {
  const [word, setWord] = useState("");
  return (
    <FactLine
      label="Only you can know"
      state={saved ? "on" : "word"}
      value={
        <>
          {item.k}
          <span className="who">the guest asked: “{item.note.length > 90 ? `${item.note.slice(0, 90)}…` : item.note}”</span>
          {saved ? (
            <span className="who">
              “{saved.word}” · {saved.by} · {fmtStamp(saved.at, tz)}
            </span>
          ) : (
            <Live>
              <span className="row-acts" style={{ marginTop: 4 }}>
                <input className="input" style={{ width: 260 }} value={word} placeholder="how it was arranged" onChange={(e) => setWord(e.target.value)} />
                <Button
                  kind="secondary"
                  compact
                  state={word.trim() ? "default" : "inert"}
                  title={word.trim() ? undefined : "a word on how it was arranged — the one thing the system cannot know"}
                  onClick={() => onRecord(word.trim())}
                >
                  It&rsquo;s done
                </Button>
              </span>
            </Live>
          )}
        </>
      }
      action={
        saved ? (
          <span className="row-acts">
            <OnRecord word="recorded" />
            <Live>
              <Button kind="quiet" compact onClick={onUndo}>
                Undo
              </Button>
            </Live>
          </span>
        ) : undefined
      }
    />
  );
}

/* ---- the FOM's two checks the click applies ---- */

function ConferenceVerifyDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [venue, setVenue] = useState(false);
  const [catering, setCatering] = useState(false);
  const [av, setAv] = useState(false);
  const [note, setNote] = useState("");
  const run = useMutation({
    mutationFn: () =>
      verifyConference(session!, entry.id, {
        venueConfirmed: venue,
        cateringConfirmed: catering,
        avConfirmed: av,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("Conference verified — on record");
      onClose();
      refresh();
    },
    onError: (e) => toastRefusal(e, "The conference could not be verified"),
  });
  const all = venue && catering && av;
  const tick = (label: string, v: boolean, set: (x: boolean) => void) => (
    <label className="sm" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      busy={run.isPending}
      title="Verify the conference"
      caseLines={[entry.id]}
      help="Reserve refuses a conference booking until the FOM has checked the three below." 
      footer={
        <>
          <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button state={run.isPending ? "working" : all ? "default" : "inert"} title={all ? undefined : "tick all three first"} workingLabel="Saving…" onClick={() => run.mutate()}>
            Verify
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 6 }}>
        {tick("The venue is confirmed", venue, setVenue)}
        {tick("Catering is confirmed", catering, setCatering)}
        {tick("Audio-visual is confirmed", av, setAv)}
      </div>
      <div className="field">
        <label>Note · optional</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="who confirmed, what was agreed" />
      </div>
    </DsDialog>
  );
}

function OverlapDialog({ entry, open, onClose }: { entry: EntryDetail; open: boolean; onClose: () => void }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (open) setNote("");
  }, [open]);
  const run = useMutation({
    mutationFn: () => acknowledgeMultiBooking(session!, entry.id, note.trim() || undefined),
    onSuccess: () => {
      toast.success("The overlap is acknowledged — Reserve can go ahead");
      onClose();
      refresh([["guest-bookings", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The overlap could not be acknowledged"),
  });
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      busy={run.isPending}
      title="This guest already holds a booking over these nights"
      caseLines={[entry.id]}
      help="Most bookings never need this. Only when Reserve says the guest already has a live booking over the same nights does the FOM say whether this is a deliberate second booking or a duplicate." 
      footer={
        <>
          <Button kind="quiet" state={run.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button state={run.isPending ? "working" : "default"} workingLabel="Saving…" onClick={() => run.mutate()}>
            It is deliberate
          </Button>
        </>
      }
    >
      <p className="sm">A duplicate should be cancelled instead.</p>
      <div className="field">
        <label>Note · optional</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. a second room for the driver, booked separately" />
      </div>
    </DsDialog>
  );
}

/* ---- who receives the confirmation ---- */

function WhoReceives({ entry }: { entry: EntryDetail }) {
  const journey = useJourney(entry.id).data ?? null;
  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const email = guest?.email?.trim() || null;
  const booker = journey?.s1Inquiry.commercialContext.partyName ?? null;
  return (
    <StepCard
      title="Who receives the confirmation"
      meta="Reserve makes the confirmation voucher and sends nothing. After it, you choose: send it by email, record that it went on WhatsApp, or don't send it."
    >
      <FactBox
        k="By email to"
        v={email ? <><b>{email}</b> · when you send it, the PDF attached</> : <span className="warn-ink">no email on file</span>}
        meta={email ? (booker ? `booked by ${booker}` : undefined) : "share the voucher another way after Reserve, and record their answer"}
      />
    </StepCard>
  );
}

function SoFar({ entry }: { entry: EntryDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <StepCard
      title="Everything chosen so far"
      right={
        <Button kind="quiet" compact onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </Button>
      }
      meta={open ? undefined : "The journey from Inquiry to here in one read — dates, party, rooms, the quote, the hold, the money."}
    >
      {open ? (
        <Tool inert={false}>
          <JourneySummaryPanel entryId={entry.id} />
        </Tool>
      ) : null}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ after the click */

function WhatReserveDecided({ entry }: { entry: EntryDetail }) {
  // A room the system chose and may still move reads "Deluxe Double · room 1" until Arrival.
  const bookingRooms = useBookingRooms(entry);
  const roomByNo = bookingRooms.byNumber;
  const clock = useHotelClock(60_000);
  const tz = clock.tz;
  const staff = useStaffNames();
  const res = entry.reservation!;
  const journey = useJourney(entry.id).data ?? null;
  const billing = useBilling(entry).data ?? null;
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio }).data;
  const comms = useCommunications(entry.id).data?.items;
  const trace = useTrace(entry.id).data?.items ?? [];
  const cur = billing?.currency ?? "BTN";
  const by = staff.get(res.confirmedBy) ?? journey?.s4Confirmation.confirmedByName ?? null;
  const held = !!(entry as EntryDetail & EntryScalars).reservationPaymentPending;
  const nights = nightsOf(res.frozenCheckInDate, res.frozenCheckOutDate);
  const quoteRef = journey?.s2Quote.reference ?? null;
  const since = currentPassStart(entry);
  const quoteAnswer = answerWords(latestDispatched(comms, "QUOTATION", since));
  // Every room the booking holds: the priced rooms, the assigned rooms and the hold's rooms.
  const roomRates = roomRatesOf(billing);
  const preDiscount = (billing?.rooms ?? []).some((r) => r.componentsPreDiscount);
  const rooms = Array.from(
    new Set([
      ...(billing?.rooms ?? []).map((r) => r.roomNumber),
      ...(entry.roomAssignments ?? []).map((a) => a.room?.roomNumber),
      ...(journey?.s3Setup.committedHold?.rooms ?? []).map((r) => r.roomNumber),
    ]),
  )
    .filter((x): x is string => !!x)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  // Each room's type, by number — the booking's rooms, the priced rooms, the hold's rooms.
  const typeOfNo = new Map<string, string>();
  for (const r of bookingRooms.data?.rooms ?? []) if (r.roomNumber) typeOfNo.set(r.roomNumber, r.typeName);
  for (const r of billing?.rooms ?? []) if (r.roomNumber && r.roomTypeName && !typeOfNo.has(r.roomNumber)) typeOfNo.set(r.roomNumber, r.roomTypeName);
  for (const r of journey?.s3Setup.committedHold?.rooms ?? []) if (r.roomNumber && r.roomTypeName && !typeOfNo.has(r.roomNumber)) typeOfNo.set(r.roomNumber, r.roomTypeName);
  const tasks = entry.preArrivalTasks ?? [];
  const emailEvents = trace.filter((t) => t.eventType.startsWith("RESERVATION_CONFIRMATION_EMAIL"));
  const sent = emailEvents.some((t) => t.eventType.endsWith(".SENT"));
  const disc = entry.cancellationDisclosure ?? null;
  return (
    <StepCard
      title={`What Reserve decided · ${fmtDateTime(res.confirmedAt, tz)}${by ? ` · ${by}` : ""}`}
      meta="This is what was reserved. A change from here makes the booking's papers again — the quotation and the voucher — and keeps these as they were."
    >
      <Facts wide>
        <Fact k="Reservation">
          <b>{res.id}</b> · dates frozen {fmtRange(res.frozenCheckInDate, res.frozenCheckOutDate)}
          {nights ? ` · ${plural(nights, "night")}` : ""}
        </Fact>
        <Fact k={roomRates && roomRates.length > 1 ? "Rates frozen" : "Rate frozen"} meta={preDiscount ? "before the booking discount — the price below is after it" : undefined}>
          {roomRates ? (
            <div style={{ display: "grid", gap: 2 }}>
              {roomRates.map((r) => (
                <span key={r.roomNumber ?? r.roomTypeName ?? String(r.rate)}>
                  {r.roomNumber && roomByNo.has(r.roomNumber) ? roomByNo.get(r.roomNumber) : `Room ${r.roomNumber ?? "—"}`}
                  {r.roomTypeName && !(r.roomNumber && roomByNo.has(r.roomNumber)) ? <span className="meta"> · {r.roomTypeName}</span> : null} ·{" "}
                  <span className="money">{money(r.rate, cur)}</span> / night
                </span>
              ))}
            </div>
          ) : (
            `${money(res.frozenRate, cur)} / night`
          )}
        </Fact>
        <Fact k="The price" meta={billing?.stayTotal.frozen ? "as confirmed" : billing ? "indicative" : undefined}>
          {billing?.stayTotal.amount != null ? money(billing.stayTotal.amount, cur) : null}
        </Fact>
        <Fact k="Quotation" meta={quoteAnswer ?? undefined}>
          {quoteRef ? `${quoteRef}${journey?.s2Quote.state ? ` · ${QUOTE_WORD[journey.s2Quote.state] ?? words(journey.s2Quote.state)}` : ""}` : null}
        </Fact>
        <Fact k="Who pays">{billingWord(res.frozenBillingModel) || null}</Fact>
        <Fact k="Rooms" meta={held ? "the advance is not fully paid — the rooms read Reserved once it is" : undefined}>
          {held ? <Chip tone="warning">Held · not yet Reserved</Chip> : <Chip tone="success">Reserved</Chip>}{" "}
          {/* The booking's own rooms first — each with its type, and whether the system may still move it. */}
          {bookingRooms.data?.rooms.length
            ? roomsHeldWord(bookingRooms.data.rooms.map((r) => ({ number: r.roomNumber, typeName: r.typeName, quiet: r.quiet && !bookingRooms.atArrival })))
            : rooms.length
              ? roomsHeldWord(rooms.map((n) => ({ number: n, typeName: typeOfNo.get(n) ?? null, quiet: roomByNo.has(n) })))
              : `${plural(entry.numberOfRooms ?? 1, "room")} · numbers assigned at Arrival`}
        </Fact>
        <Fact k="Terms disclosed" meta={disc ? fmtStamp(disc.disclosedAt, tz) : undefined}>
          {disc ? "cancellation and no-show, as told to the guest" : null}
        </Fact>
        <Fact k="Advance" meta={pay?.paymentPlan ? `${PLAN_LABEL[pay.paymentPlan.plan]}${pay.paymentPlan.balanceDueAt ? ` · ${dueLabel(pay.paymentPlan.plan, pay.paymentPlan.balanceDueAt)}` : ""}` : undefined}>
          {pay ? (pay.requiredAmount > 0 || pay.totalReceived > 0 ? `${money(pay.totalReceived, cur)} received of ${money(pay.requiredAmount, cur)}` : "not required") : null}
        </Fact>
        {res.creditCeilingIfExtended != null ? <Fact k="Credit ceiling">{money(res.creditCeilingIfExtended, cur)}</Fact> : null}
        <Fact k="Voucher" meta={sent ? "sent" : emailEvents.length ? "the email did not go out" : undefined}>
          confirmation voucher · to {entry.guestProfile?.email ?? "no email on file"}
        </Fact>
        <Fact k="Pre-arrival">
          {plural(tasks.length, "task")} opened for {fmtDate(res.frozenCheckInDate)} · {tasks.filter((t) => t.status === "PENDING").length} open
        </Fact>
      </Facts>
    </StepCard>
  );
}

function VoucherCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const clock = useHotelClock(60_000);
  const tz = clock.tz;
  const refresh = useRefreshEntry(entry.id);
  const res = entry.reservation!;
  const trace = useTrace(entry.id);
  const comms = useCommunications(entry.id).data?.items;
  const since = currentPassStart(entry);
  const [paper, setPaper] = useState<PaperRef | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const guestEmail = entry.guestProfile?.email?.trim() ?? "";
  const [sendTo, setSendTo] = useState(guestEmail);
  useEffect(() => {
    if (sendOpen) setSendTo(guestEmail);
  }, [sendOpen, guestEmail]);

  const items = (trace.data?.items ?? []) as TraceItem[];
  const emailEvents = items.filter((t) => t.eventType.startsWith("RESERVATION_CONFIRMATION_EMAIL."));
  const last = emailEvents[0];
  const lastPayload = (last?.payload ?? null) as { actualRecipient?: string; intendedRecipient?: string; redirected?: boolean; reason?: string; message?: string } | null;
  // Reserve makes the voucher and sends nothing (2026-10-29, operator: "that should also be
  // optional like how I did for quotation and proforma"): it waits as a held paper until the desk
  // sends it by email, records it as sent on WhatsApp, or says it is not sent.
  const heldQ = useHeldDocuments(entry.id);
  const heldRows = (heldQ.data ?? []).filter((h) => h.kind === "CONFIRMATION_VOUCHER" && h.documentId === res.id);
  const held = heldRows.find((h) => h.decision == null) ?? null;
  const decided = heldRows.find((h) => h.decision && h.decision !== "SUPERSEDED") ?? null;
  const onWhatsApp = decided?.decision === "SENT_WHATSAPP";
  const notSent = decided?.decision === "NOT_SENT";
  const emailed = emailEvents.some((t) => t.eventType.endsWith(".SENT"));
  const sent = emailed || onWhatsApp;
  // Said the way it went out, on the answer line (2026-10-29).
  const answerWords = { notSent: notSent && !emailed, sentAt: onWhatsApp && !emailed ? decided?.decidedAt ?? null : null };
  // A guest with no email on file is not a failed send — there was nobody to send to, and the
  // voucher is shared at the desk or by phone. It read as "could not be sent — have the email
  // settings fixed" beside the raw code GUEST_HAS_NO_EMAIL (2026-09-18). Nor is a voucher held
  // for the desk — it has not been sent yet, by choice.
  const reasonOf = (t: TraceItem) => (t.payload as { reason?: string } | null)?.reason;
  const noAddress = (t: TraceItem) => reasonOf(t) === "GUEST_HAS_NO_EMAIL";
  const heldSkip = (t: TraceItem) => reasonOf(t) === "HELD_FOR_DESK_DECISION";
  const failed = !sent && emailEvents.some((t) => !noAddress(t) && !heldSkip(t));
  const voucherComm = latestDispatched(comms, "CONFIRMATION_VOUCHER", since);
  const answered = voucherComm?.acknowledgementStatus === "RECEIVED";
  const { past } = useStepMode();
  const afterReserve = !["S3", "S4"].includes(entry.currentStage);
  // The answer, once on record, finishes the section — as Set up's proforma does (2026-10-29).
  const finish = useFinishWhenDone("voucher");
  const loading = trace.isLoading || heldQ.isLoading;
  // Held: whether and how it goes out is the next thing to do here (2026-10-29).
  const decideFirst = !past && !afterReserve && !answered && !loading && !!held;
  // Gone out, or the desk said how the guest has it: the answer is next (Set up's answer box).
  const answerDue = !past && !afterReserve && !answered && !loading && !held && (sent || failed || notSent || !guestEmail);
  // A voucher made before 2026-10-29 that never went out — Send is its main act.
  const sendFirst = !past && !afterReserve && !answered && !loading && !held && !sent && !notSent && !!guestEmail && !failed;
  // Send before record (2026-08-07): the answer waits until the voucher went out — unless the guest
  // has no email (verbal is their only way), every attempt failed, or the desk said it is not sent.
  const locked = !!guestEmail && !afterReserve && !loading && !sent && !failed && !notSent;

  const send = useMutation({
    mutationFn: () => resendConfirmationVoucher(session!, res.id, { dispatchedTo: sendTo.trim() || undefined }),
    onSuccess: (out) => {
      toast.success(`Voucher sent to ${out.dispatchedTo} — a fresh reply window is open`);
      setSendOpen(false);
      refresh();
    },
    onError: (e) => toastRefusal(e, "The voucher could not be sent"),
  });

  const emailLine = loading ? (
    <span className="meta">checking what was sent…</span>
  ) : held ? (
    <span className="meta">Made at Reserve, not sent yet — you choose below</span>
  ) : onWhatsApp ? (
    <span>
      Sent on WhatsApp{decided?.sentTo ? ` to ${decided.sentTo}` : ""} · {fmtStamp(decided?.decidedAt ?? null, tz)}
    </span>
  ) : notSent && !last?.eventType.endsWith(".SENT") ? (
    <span className="meta">Not sent{decided?.note ? ` — ${decided.note}` : ""} · {fmtStamp(decided?.decidedAt ?? null, tz)}</span>
  ) : last?.eventType.endsWith(".SENT") ? (
    <span>
      Emailed to {lastPayload?.actualRecipient ?? lastPayload?.intendedRecipient ?? guestEmail} · {fmtStamp(last.timestamp, tz)}
      {lastPayload?.redirected ? <span className="meta"> · a test redirect{lastPayload.intendedRecipient ? `, meant for ${lastPayload.intendedRecipient}` : ""}</span> : null}
    </span>
  ) : last?.eventType.endsWith(".SKIPPED") && lastPayload?.reason === "GUEST_HAS_NO_EMAIL" ? (
    <span className="meta">No email on file — share the voucher at the desk or by phone (Preview → PDF), then record their answer below</span>
  ) : last?.eventType.endsWith(".SKIPPED") ? (
    <span className="warn-ink">
      Not emailed — {lastPayload?.reason === "EMAIL_DISABLE" ? "email sending is turned off on this system" : (lastPayload?.reason ?? "no reason recorded")}
    </span>
  ) : last ? (
    <span className="warn-ink">The email failed — {lastPayload?.message ?? "no message recorded"}</span>
  ) : guestEmail ? (
    <span className="meta">no email sent yet — Send… it to {guestEmail}</span>
  ) : (
    <span className="warn-ink">No email on file — nothing was emailed</span>
  );

  return (
    <StepCard
      flow="voucher"
      title={`Confirmation voucher · ${res.confirmationVoucherNumber ?? res.id}`}
      icon="file"
      summary={`${res.confirmationVoucherNumber ?? res.id} · ${onWhatsApp ? "sent on WhatsApp" : sent ? "sent" : notSent ? "not sent" : "issued"} · the guest's answer recorded`}
      right={
        sent ? (
          <Chip tone="success" icon="check">
            {onWhatsApp ? "sent on WhatsApp" : "sent"}
          </Chip>
        ) : held ? (
          <Chip tone="warning">not sent yet</Chip>
        ) : failed ? (
          <Chip tone="warning">not sent</Chip>
        ) : notSent ? (
          <Chip tone="quiet">not sent</Chip>
        ) : (
          <Chip tone="success" icon="check">
            issued
          </Chip>
        )
      }
    >
      <div className="meta">
        Generated {fmtDate(res.confirmationVoucherRenderedAt ?? res.confirmedAt)}
        {res.confirmationVoucherChecksum ? ` · signed ${res.confirmationVoucherChecksumAlgo ?? "SHA-256"} ${res.confirmationVoucherChecksum.slice(0, 12)}…` : " · the PDF is stored on first preview"}
      </div>
      <div className="sm" style={{ marginTop: 6 }}>
        {emailLine}
      </div>
      <div className="row-acts" style={{ marginTop: 10 }}>
        <Button kind="secondary" compact icon="eye" onClick={() => setPaper({ kind: "voucher", reservationId: res.id, label: `Confirmation voucher · ${res.id}` })}>
          Preview · full
        </Button>
        <Button kind="quiet" compact icon="eye" state="inert" title="Not possible yet — a copy of the voucher without the prices can't be made yet">
          Preview · guest copy
        </Button>
        {held ? null : (
          <Live>
            {/* The main act while it has not gone out (2026-10-29), as the proforma's Send is. */}
            <Button kind={sendFirst ? "primary" : "quiet"} className={sendFirst ? "go" : undefined} compact={!sendFirst} icon="send" onClick={() => setSendOpen(true)}>
              {sent ? "Send again" : "Send"}
            </Button>
          </Live>
        )}
        <Button kind="quiet" compact state="inert">
          Re-issue as v2
        </Button>
        <Help label="Not available yet">Not possible by hand. A new version of the voucher is made by itself whenever the booking&rsquo;s rooms, dates or price change.</Help>
      </div>
      {failed && !answered && !afterReserve ? (
        <div style={{ marginTop: 10 }}>
          <Refusal
            kind="fault"
            message="The voucher email could not be sent — the guest has not received it by email."
            carries="Share it another way (Preview → PDF or Print), record their answer below, and have the email settings fixed — or Send… again once email works."
          />
        </div>
      ) : null}
      {decideFirst && held ? (
        // Nothing went out on the click: the desk chooses — as the quotation and proforma are sent.
        <div className="voucher-send" role="status">
          <div className="notice next">
            <span>
              The voucher is made and nothing was sent. Send it to the guest, record that it went on WhatsApp, or say it is not sent —
              then record their answer. Arrival waits for it.
            </span>
          </div>
          <Live>
            <HeldPaperRow h={held} tz={tz} onView={() => setPaper({ kind: "voucher", reservationId: res.id, label: `Confirmation voucher · ${res.confirmationVoucherNumber ?? res.id}` })} />
          </Live>
        </div>
      ) : sendFirst ? (
        <div className="notice next" role="status" style={{ marginTop: 10 }}>
          <span>
            Send the voucher to the guest first. Their answer is recorded once they have it — Arrival waits for it.
          </span>
        </div>
      ) : null}
      {decideFirst ? null : answerDue ? (
        // Sent and not yet answered: the answer is the next thing to do (2026-10-29, as at Set up).
        <div className="answer-due" role="status">
          <span className="due-head">
            The guest&rsquo;s answer is needed
            <Help label="About the answer">Write down how the guest answered the voucher — by message or by telling the desk — and what they said.</Help>
          </span>
          <span className="sm">Arrival opens only once it is recorded.</span>
          <AnswerLine entryId={entry.id} type="CONFIRMATION_VOUCHER" sinceIso={since} what="the voucher" tz={tz} prominent onAnswered={() => finish()} {...answerWords} />
        </div>
      ) : (
        <div className="rule-above" style={{ borderTop: "1px solid var(--line)", marginTop: 12, paddingTop: 10 }}>
          <div className="sm" style={{ marginBottom: 4, fontWeight: 600 }}>
            What they said about it
            <Help label="About the answer">Arrival waits for the guest&rsquo;s answer to the voucher.</Help>
          </div>
          <AnswerLine
            entryId={entry.id}
            type="CONFIRMATION_VOUCHER"
            sinceIso={since}
            what="the voucher"
            tz={tz}
            lockedHint={locked ? "The voucher email hasn't gone out yet — send it first, then record their answer here." : null}
            onAnswered={() => finish()}
            {...answerWords}
          />
        </div>
      )}
      <PaperDrawer paper={paper} onClose={() => setPaper(null)} />
      <DsDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        busy={send.isPending}
        title="Send the confirmation voucher"
        caseLines={[res.id]}
        help="The same email and PDF Reserve sent, recorded as a new send with a fresh reply window." 
        footer={
          <>
            <Button kind="quiet" state={send.isPending ? "inert" : "default"} onClick={() => setSendOpen(false)}>
              Not now
            </Button>
            <Button icon="send" state={send.isPending ? "working" : sendTo.trim() ? "default" : "inert"} title={sendTo.trim() ? undefined : "an email address first"} workingLabel="Sending…" onClick={() => send.mutate()}>
              Send
            </Button>
          </>
        }
      >
        <div className="field">
          <label>
            To
            <Help label="About the address">Prefilled from the guest&rsquo;s record — change it to correct a wrong address.</Help>
          </label>
          <input className="input" type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="guest@example.com" />
        </div>
      </DsDialog>
    </StepCard>
  );
}
