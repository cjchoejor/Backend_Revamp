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
  onChangeStay,
}: {
  entry: EntryDetail;
  past: boolean;
  /** Park with the reason typed in Other ways' own tab (2026-10-17). */
  parkNow?: (reason: string) => void;
  parking?: boolean;
  goToStep: (n: number) => void;
  /** Change booking › "Change the dates, rooms or guests" — the editor in the page (2026-10-29). */
  onChangeStay?: () => void;
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
      ) : null}
      <BookingOtherWays
        entry={entry}
        parkNow={parkNow}
        parking={parking}
        onMoveRoom={past ? undefined : () => stepPane.open("rooms")}
        onChangeStay={past ? undefined : onChangeStay}
      />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ before Reserve, at Set up */

/**
 * What Reserve asks that Set up's own sections do not (2026-10-29, operator: "it seems like the screen
 * shows as 4 · Reserve when we are actually in stage 3 … remove that first page, and put the Reserve
 * button on stage 3"). The page between Set up and Reserve is gone; these are the three questions it
 * held that no Set up section asks, shown on Set up as one section, and only when one applies:
 *   - the guest's other reserved booking over these nights (Policy 13 — the FOM says both are meant);
 *   - a conference booking's venue, catering and AV, verified by the FOM;
 *   - what only the desk can know about the guest's own requests ("It's done").
 * Each open one is an item the workspace adds to Reserve's gate.
 */
export function ReserveChecks({ entry, onOpenItems }: { entry: EntryDetail; onOpenItems?: (items: string[]) => void }) {
  const { session } = useSession();
  const { past } = useStepMode();
  const clock = useHotelClock(60_000);
  const tz = clock.tz;
  const trace = useTrace(entry.id).data?.items ?? [];
  const asked = useRequestWords(entry, session?.displayName ?? session?.username ?? "the desk");
  const fom = atLeast(session?.actorLevel, "L2");
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [overlapOpen, setOverlapOpen] = useState(false);

  // The guest's other reserved booking over these nights — read the gate's own way.
  const overlapQ = useQuery({
    queryKey: ["guest-bookings", entry.id, "reserve", entry.updatedAt],
    queryFn: () => listSameGuestBookings(session!, entry.id),
    enabled: !!session,
  });
  const overlap = overlapQ.data?.reserveOverlap ?? null;
  const overlapOpenItem = !!overlap && !overlap.acknowledged;
  const conference = entry.useType === "CONFERENCE";
  const conferenceDone = trace.some((t) => t.eventType === "CONFERENCE.VERIFIED");
  const openWords = asked.items.filter((w) => !asked.saved[w.id]).length;

  const extraOpen = [
    ...(overlapOpenItem ? ["The guest's other booking acknowledged by the FOM"] : []),
    ...(conference && !conferenceDone ? ["The conference verified by the FOM"] : []),
    ...(openWords ? [`${openWords === 1 ? "One thing" : `${openWords} things`} only you can know, said`] : []),
  ].join("|");
  useEffect(() => {
    onOpenItems?.(extraOpen ? extraOpen.split("|") : []);
  }, [extraOpen, onOpenItems]);
  useEffect(() => () => onOpenItems?.([]), [onOpenItems]);

  if (!overlap && !conference && asked.items.length === 0) return null;
  return (
    <>
      <StepCard
        flow={extraOpen ? "reserve" : undefined}
        title="Before you reserve"
        meta="What Reserve asks that the sections above do not. Reserve the booking floats in once each is answered."
        status={
          overlapOpenItem ? (
            <span className="warn-ink">The FOM says whether both of this guest&rsquo;s bookings are meant</span>
          ) : conference && !conferenceDone ? (
            <span className="warn-ink">The FOM verifies the venue, catering and AV</span>
          ) : openWords ? (
            <span className="warn-ink">
              {openWords === 1 ? "One thing" : `${openWords} things`} only you can know — say how {openWords === 1 ? "it was" : "they were"} arranged
            </span>
          ) : (
            <span className="ok-ink">Answered</span>
          )
        }
      >
        {overlap ? (
          <FactLine
            label="The guest's other booking"
            value={
              overlap.acknowledged
                ? `${overlap.entryId} (${fmtRange(overlap.checkInDate, overlap.checkOutDate)}) — both bookings are meant`
                : `${overlap.entryId} is reserved over these nights (${fmtRange(overlap.checkInDate, overlap.checkOutDate)})`
            }
            who={overlap.acknowledged ? "acknowledged by the FOM" : "the FOM says whether both are meant before Reserve"}
            state={overlap.acknowledged ? "on" : "missing"}
            action={
              overlap.acknowledged || past ? undefined : (
                <Button className="go" state={fom ? "default" : "inert"} title={fom ? undefined : "needs the FOM"} reason={fom ? undefined : "The FOM's call"} onClick={() => setOverlapOpen(true)}>
                  Acknowledge the overlap
                </Button>
              )
            }
          />
        ) : null}
        {conference ? (
          <FactLine
            label="Conference verification"
            value={conferenceDone ? "venue, catering and AV verified" : "venue, catering and AV not yet verified"}
            who={conferenceDone ? "by the FOM" : "the FOM verifies it before Reserve"}
            state={conferenceDone ? "on" : "missing"}
            action={
              conferenceDone || past ? undefined : (
                <Button className="go" state={fom ? "default" : "inert"} title={fom ? undefined : "needs the FOM"} reason={fom ? undefined : "The FOM's call"} onClick={() => setVerifyOpen(true)}>
                  Verify
                </Button>
              )
            }
          />
        ) : null}
        {asked.items.map((w) => (
          <WordRow key={w.id} item={w} saved={asked.saved[w.id]} onRecord={(word) => asked.record(w.id, word)} onUndo={() => asked.undo(w.id)} tz={tz} />
        ))}
      </StepCard>
      <ConferenceVerifyDialog entry={entry} open={verifyOpen} onClose={() => setVerifyOpen(false)} />
      <OverlapDialog entry={entry} open={overlapOpen} onClose={() => setOverlapOpen(false)} />
    </>
  );
}

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
    <span className="meta">{held.reason === "RESERVE" ? "Made at Reserve" : "Made again after the change"}, not sent yet — you choose below</span>
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
