/**
 * What to do next, at any step (2026-10-07) — the second screen's "Do next".
 *
 * The step's checklist only says what the FORWARD MOVE needs. Plenty of real work is not in it:
 * a quotation that was sent and is waiting for the guest's answer, a hold that runs out within the
 * hour, a quote generated but never sent. Those left the board saying "Everything it needs is
 * done" while the desk still had something to do (operator report, 2026-10-07).
 *
 * So the guide merges four sources, most urgent first:
 *   1. fixes      — a refusal just now, a clock already past its time;
 *   2. the step   — the checklist items still unmet, each as an instruction with words for the guest;
 *   3. the guest  — papers sent and not yet answered; a quote generated and not sent;
 *   4. clocks     — anything running out within the day.
 * …and when all of that is clear, the forward move itself, with what pressing it will do.
 *
 * Nothing is decided here: the checklist is the desk's own (the "desk" draft), the papers and
 * clocks are the backend's, and every figure is printed as the backend gave it.
 */
import type { EntryCommunication, TimerRecordSummary } from "@/lib/api/entries";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { DeskDraft } from "./drafts";

export type GuideTone = "fix" | "act" | "wait" | "ready";

export type GuideItem = {
  key: string;
  tone: GuideTone;
  now: string;
  how?: string | null;
  say?: string | null;
  then?: string | null;
  /** The desk card this is done on — clicking the line on the board takes the desk there. */
  card?: string | null;
  /** Set on lines that wait on the GUEST — the box then reads "Waiting on the guest". */
  onGuest?: boolean;
  /** A clock this item runs against — shown as a live countdown. */
  clock?: { label: string; at: string } | null;
};

type StepWords = { now: string; how?: string; say?: string };

/** Each checklist line, as something to do. Matched on the desk's own label words. */
const STEP_WORDS: Array<[RegExp, StepWords | ((ctx: Ctx) => StepWords)]> = [
  [/^A contact on file/, { now: "Get a way to reach the guest", how: "A phone or an email on The guest card — or the agency's contact person.", say: "May I have a phone number or an email, in case we need to reach you?" }],
  [/^Stay dates set/, { now: "Fix the dates", how: "Check-in and nights, on The stay card.", say: "Which night do you arrive, and for how many nights?" }],
  [/^Guest count set/, { now: "Ask who is coming", how: "Adults, children and each child's age — the age decides the price.", say: "How many adults are coming? Any children — how old are they?" }],
  [/^Availability searched/, { now: "Ask the house for these dates", how: "Press Ask the house — the free rooms appear on the desk." }],
  [/^(Preferred room selected|Configuration chosen)/, { now: "Pick the rooms for every night", how: "Click a room's row in the rooms table, then Save." }],
  [/^Availability sealed from Inquiry/, { now: "Save the rooms at Inquiry first", how: "This pass has no saved rooms. Go back to Inquiry, pick them and save." }],
  [/^Quote generated/, { now: "Price the stay", how: "Fill Who sleeps where, and their meals — guests, meals, extra beds, any agreed rate — and press Save & price it. That makes the quotation." }],
  [/^Quote still valid/, { now: "The quote has run out — price it again", how: "Press Save & price it again for a fresh quotation with a new validity." }],
  [/^Any holds still healthy/, { now: "A marker on the rooms needs looking at", how: "Release it, or place a new one on the Provisional block card." }],
  [/^Provisional folio/, { now: "Choose who pays", how: "On the Billing model card: the guest, the agency's voucher, or the company.", say: "Will you be paying yourself, or is the agency or company paying?" }],
  [/^Cancellation terms recorded/, { now: "Tell the guest the cancellation terms", how: "Read them from the Terms disclosed card, then record that the guest was told.", say: "Before we go on, here are our cancellation terms…" }],
  [/^Proforma invoice generated/, { now: "Make the proforma invoice", how: "Generate it on the Proforma card — it asks the guest for the advance." }],
  [/^Proforma sent to guest/, { now: "Send the proforma", how: "Money came in before the proforma went out — send it so the advance is on paper." }],
  [/^Guest's answer to the proforma recorded/, { now: "Record the guest's answer to the proforma", how: "On the Proforma card (Record the answer…) — what they said and how they will pay.", say: "Did the proforma reach you? How would you like to pay the advance?" }],
  [
    /^Advance settled or credit extended/,
    (c) => ({
      now: "Take the advance — or get the FOM's credit",
      how: `Log the money under Record payment when it comes in, or ask the FOM to extend credit.${c.shortfall ? ` Still owed: ${c.shortfall}.` : ""}`,
      say: c.required ? `To hold the rooms we ask for an advance of ${c.required}. How would you like to pay it?` : undefined,
    }),
  ],
  [/^Room held/, { now: "Hold the rooms", how: "On The committed hold card — it keeps the rooms for this guest until the booking is reserved. Logging an advance payment places it on its own." }],
  [/^The guest's answer to the confirmation voucher/, { now: "Record the guest's answer to the confirmation", how: "On the Confirmation voucher card (Record the answer…).", say: "Did our confirmation reach you? Is everything on it right?" }],
  [/^Room assigned$/, { now: "Assign the rooms", how: "On the Assign the rooms card." }],
  [/^Pre-arrival tasks done/, { now: "Finish the pre-arrival tasks", how: "On the Pre-arrival tasks card — tick each one off, or waive it with a reason." }],
  [/^Advance reconciled/, { now: "The FOM reconciles the advance", how: "The FOM signs off that the money position is accepted." }],
  [/^Credit ceiling acknowledged/, { now: "The FOM acknowledges the credit ceiling", how: "The balance is near the credit allowed — the FOM signs it off." }],
  [/^Handoff( to front desk)? fulfilled/, { now: "Complete the handoff to the front desk", how: "On The front-desk handoff card — accept it and tick its checklist." }],
  [/^Guest is present/, { now: "When the guest is at the desk, mark them here", how: "On The guest is here card." }],
  [/^Identity verified/, { now: "Check the guest's ID", how: "On The document, at the desk card — then record the verification.", say: "May I see your passport or ID card, please?" }],
  [/^Guest details recorded/, { now: "Record every guest's details", how: "One row per guest in the guest table — the ID photo or the document number.", say: "May I have an ID for everyone staying?" }],
  [/^Registration confirmed/, { now: "Have the registration card signed", how: "On the Registration card, then tick it as signed." }],
  [/^VIP arrival notified/, { now: "Tell the VIP team the guest has arrived", how: "On the VIP arrival card." }],
  [/rooms? assigned & ready/i, { now: "Get the rooms ready", how: "Housekeeping marks each room clean and ready." }],
  [/^Keys returned/, { now: "Collect the keys", how: "On The departure card.", say: "May I have your keys, please?" }],
  [/^Rooms released/, { now: "Release the rooms to housekeeping", how: "Settling the bill releases them on its own; a room still held shows on The departure card." }],
  [/key (marked|issued)|keys? issued|arrival-night key/i, { now: "Hand over the keys", how: "Tick each room's key as you give it.", say: "Here are your keys." }],
  [/^(Checkout date on file|Early departure recorded)/, { now: "Check the checkout date", how: "The stay must end today to move to Check-out — or record an early departure." }],
  [/^Charges posted/, { now: "Post the charges", how: "On The folio — anything the guest used. Room nights come from the night audit." }],
  [/^Pre-checkout handoff/, { now: "Start the pre-checkout handoff", how: "Housekeeping checks the room before the guest leaves." }],
  [/^No open disputes/, { now: "Settle the open dispute", how: "On the Disputes card." }],
  [/^Night audit complete/, { now: "Post the final night", how: "On The nights card (the Night audit tab) — post the last night." }],
  [/^Folio settled/, (c) => ({ now: "Settle the bill", how: "On How the bill is settled — take the payment.", say: c.balance ? `Your bill comes to ${c.balance}. How would you like to pay?` : "How would you like to pay?" })],
  [/^Room inspection recorded/, { now: "Record the room inspection", how: "On The departure card — what housekeeping found, or that the room was fine." }],
  [/^Sealing needs the FOM/, { now: "Ask the FOM to seal the record" }],
  // Closed — the seal's own checks, worded by the backend (closure-readiness)
  [/^No dispute left open/, { now: "Close the open dispute", how: "Answer it and close it on the Disputes card." }],
  [/^Every invoice sent/, { now: "Send the invoice", how: "Issue the final invoice and send it — none may be left as a draft." }],
  [/payment tracked|Every payment matched/, { now: "Match the payments to the invoice", how: "Record each payment received against the invoice it pays." }],
  [/^The bill settled, or left owing/, { now: "Settle the bill — or leave it owing for follow-up", say: "We still show a balance on your stay — how would you like to settle it?" }],
  [/^The no-show decision/, { now: "Record the no-show decision", how: "The FOM records what was decided about the no-show." }],
  [/^The room inspected, or its inspection window/, { now: "Record the room inspection", how: "What housekeeping found — or the FOM closes the inspection window." }],
  [/^The after-stay handoff/, { now: "Complete the after-stay handoff" }],
  [/^Lent equipment back/, { now: "Get the lent equipment back", how: "Record each item as returned." }],
  [/security deposit returned/, { now: "Return the security deposit", how: "Record the deposit refund on the bill." }],
  [/^A folio for the booking/, { now: "This booking has no bill", how: "Nothing can be invoiced or sealed until the bill exists." }],
];

/** What pressing the forward move does — so the operator knows before they press it. */
const MOVE_WORDS: Array<[RegExp, string]> = [
  [/^Move to Negotiation/, "Moving on stops the inquiry's clock and starts the negotiation's. Nothing is held and nothing is sent to the guest yet — the next step prices the stay."],
  [/^Move to Set up/, "The quotation becomes the basis. Set up records who pays, the cancellation terms, the proforma and the advance. The rooms are still not held."],
  [/^Move to Reserve/, "Opens the freeze checklist — one last look before the price is frozen."],
  [/^Reserve the booking/, "The price freezes and the guest is held to it, the rooms become Reserved, and the confirmation voucher goes to the guest."],
  [/^Move to Arrival/, "Opens the arrival window — the room is assigned and readied, and the pre-arrival tasks begin."],
  [/^Move to Check-in/, "The guest is here — the ID, registration and keys come next."],
  [/^Check in/, "The folio goes live, the rooms become occupied, and housekeeping and the kitchen are told."],
  [/^Move to Check-out/, "Opens settlement — the bill, the keys and the room inspection."],
  [/^Move to Closed/, "Opens the post-stay step — the invoice and any payment still owed."],
  [/^Close & seal/, "The record is sealed and becomes read-only."],
  [/^Resume/, "The booking comes back to work, and its step's clock starts again."],
];

const PAPER: Record<string, { name: string; say: string }> = {
  QUOTATION: { name: "the quotation", say: "Have you had a chance to look at the quotation we sent? Shall I go ahead?" },
  PROFORMA_INVOICE: { name: "the proforma invoice", say: "Did the proforma reach you? How would you like to pay the advance?" },
  CONFIRMATION_VOUCHER: { name: "the confirmation voucher", say: "Did our confirmation reach you? Is everything on it right?" },
  PRE_ARRIVAL_REMINDER: { name: "the pre-arrival message", say: "We look forward to your arrival — what time do you expect to reach us?" },
  INTERIM_INVOICE: { name: "the mid-stay bill", say: "Did you receive the bill for the stay so far? When would you like to settle it?" },
  FINAL_INVOICE: { name: "the final invoice", say: "Did you receive the invoice? When can we expect the payment?" },
};

/** Where each paper's answer is recorded on the desk. */
const PAPER_CARD: Record<string, string> = { QUOTATION: "quote", PROFORMA_INVOICE: "proforma" };

/** Clocks worth a line of their own, and what to do about them. */
const CLOCK_WORDS: Record<string, { now: string; how: string }> = {
  ENTRY_EXPIRY: { now: "The inquiry lapses soon", how: "Move it on to Negotiation, or park it if the guest needs time." },
  NEGOTIATION_EXPIRY: { now: "The negotiation lapses soon", how: "Get the guest's answer and move to Set up, or park it." },
  QUOTATION_VALIDITY_W15: { now: "The quote runs out soon", how: "Get the guest's answer before then, or price it again." },
  SPECULATIVE_HOLD_EXPIRY_W2: { now: "The marker on the rooms ends soon", how: "Move on to Set up, or extend the marker on the Provisional block card." },
  COMMITTED_HOLD_EXPIRY_W3: { now: "The hold on the rooms ends soon", how: "Reserve the booking before then, or set a later hold time." },
  ADVANCE_PROMISE_DEADLINE_W38: { now: "The advance the guest promised is due", how: "Check whether it came in; if not, call the guest." },
  ADVANCE_PAYMENT_FOLLOW_UP_W34: { now: "Follow up the advance", how: "Call or write to the guest about the advance." },
  NO_SHOW_CUTOFF_W5: { now: "The no-show cut-off is near", how: "If the guest has not arrived by then, the booking becomes a no-show. Call them now." },
  CHECKOUT_TIME_W26: { now: "Checkout time is near", how: "Settle the bill and collect the keys." },
  PAYMENT_FOLLOW_UP_W8: { now: "Follow up the payment", how: "Call or write to the guest about what is still owed." },
  INTERIM_PAYMENT_REMINDER_W41: { now: "The mid-stay payment is due", how: "Ask the guest for it at the desk or by phone." },
  PRE_ARRIVAL_COUNTDOWN_W4: { now: "The arrival window opens soon", how: "Move to Arrival when it does." },
};

const HOUR = 3_600_000;

type Ctx = { required: string | null; shortfall: string | null; balance: string | null };

export function guideFor(input: {
  desk: DeskDraft | null;
  stage: string;
  timers: TimerRecordSummary[];
  communications: EntryCommunication[];
  /** When this pass began — papers sent before it belong to an earlier pass. */
  passStart: string | null;
  quotes: Array<{ id?: string; state: string; sentAt?: string | null; validUntil?: string | null }>;
  payment: { requiredAmount: number; shortfall: number } | null;
  balance: number | null;
  currency: string;
  latestRefusal: string | null;
  now: number;
  /** In-house: nights already slept with no room charge posted yet (counted by the board). */
  unpostedNights?: string[];
}): GuideItem[] {
  const { desk, timers, communications, passStart, quotes, payment, balance, currency, latestRefusal, now, stage } = input;
  const out: GuideItem[] = [];
  const ctx: Ctx = {
    required: payment && payment.requiredAmount > 0 ? money(payment.requiredAmount, currency) : null,
    shortfall: payment && payment.shortfall > 0 ? money(payment.shortfall, currency) : null,
    balance: balance && balance > 0 ? money(balance, currency) : null,
  };

  if (latestRefusal) out.push({ key: "refusal", tone: "fix", now: "The desk was just refused", how: `${latestRefusal} Put it right on the desk, then try again.` });

  /* the step's own checklist */
  const looking = !desk || desk.viewing === desk.current;
  // Mid-stay, the checkout line is unmet only because the day has not come — that is waiting, not
  // a task; so are the lines that belong to the checkout day (the final night, the pre-checkout
  // handoff).
  const stayRunning = (desk?.items ?? []).some((i) => !i.met && /^Booked checkout is /.test(i.label));
  if (looking) {
    for (const item of desk?.items ?? []) {
      if (item.met) continue;
      const booked = /^Booked checkout is (.+?) — /.exec(item.label);
      if (booked) {
        out.push({
          key: `step:${item.label}`,
          tone: "wait",
          now: `The guest stays until ${booked[1]}`,
          how: "Nothing to do for check-out yet. If they want to leave earlier, record an early departure (the GM) on the Leaving early tab.",
          card: null,
        });
        continue;
      }
      if (/^Checking today's date/.test(item.label)) continue;
      const hit = STEP_WORDS.find(([re]) => re.test(item.label));
      const w = hit ? (typeof hit[1] === "function" ? hit[1](ctx) : hit[1]) : { now: item.label };
      const onTheDay = stayRunning && /^(Night audit complete|Pre-checkout handoff)/.test(item.label);
      out.push({
        key: `step:${item.label}`,
        tone: onTheDay ? "wait" : "act",
        now: onTheDay ? `${w.now} — on the checkout day` : w.now,
        how: w.how ?? null,
        say: w.say ?? null,
        card: item.card ?? null,
      });
    }
  }

  /* in-house: a night already slept that is not posted yet */
  if (input.unpostedNights?.length) {
    out.push({
      key: "unposted-nights",
      tone: "wait",
      now: `${input.unpostedNights.length === 1 ? "A night is" : `${input.unpostedNights.length} nights are`} not posted yet: ${input.unpostedNights.join(", ")}`,
      how: "The hotel's night audit posts each night in the morning. Post it now from the Night audit tab if the guest is settling.",
      card: "nights",
    });
  }

  /* what the guest still owes an answer to (this pass only) */
  const answerClock = new Map<string, TimerRecordSummary>();
  for (const t of timers) if (t.status === "SCHEDULED" && t.timerCode === "ACKNOWLEDGEMENT_WINDOW_W22" && t.entityId) answerClock.set(t.entityId, t);
  // Only the NEWEST paper of each kind counts: when the guest answered the re-sent quotation, the
  // first one's silence means nothing (2026-10-07 — the board asked for an answer already given).
  // A quotation that is no longer live (replaced, retired, run out) is waited on by nobody, and an
  // accepted one is answered whatever its email record says.
  const quoteState = new Map(quotes.filter((q) => q.id).map((q) => [q.id!, q.state]));
  const anyAccepted = quotes.some((q) => q.state === "ACCEPTED");
  const newest = new Map<string, EntryCommunication>();
  for (const c of [...communications].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (c.direction !== "OUTBOUND" || c.sendStatus !== "DISPATCHED") continue;
    if (passStart && c.createdAt < passStart) continue;
    if (!newest.has(c.commType)) newest.set(c.commType, c);
  }
  const seenType = new Set<string>(newest.keys());
  for (const c of newest.values()) {
    if (c.acknowledgementStatus === "RECEIVED" || !c.canAcknowledge) continue;
    if (c.commType === "QUOTATION") {
      const qid = typeof c.payload?.quotationId === "string" ? c.payload.quotationId : null;
      const state = qid ? quoteState.get(qid) : undefined;
      if (anyAccepted || (qid && state !== "SENT")) continue;
    }
    const p = PAPER[c.commType] ?? { name: "the paper sent", say: "Did you receive what we sent?" };
    const due = c.acknowledgementTimeoutAt ?? answerClock.get(c.id)?.firesAt ?? null;
    const late = c.isOverdue || (due != null && new Date(due).getTime() <= now);
    out.push({
      key: `answer:${c.id}`,
      tone: late ? "fix" : "wait",
      now: late ? `No answer yet to ${p.name} — call the guest` : `Record the guest's answer to ${p.name}`,
      how: late
        ? `The time for an answer has passed. Ask the guest, then record what they said where ${p.name} is on the desk.`
        : `When the guest replies — by email, by phone or in person — record it where ${p.name} is on the desk (Record the answer).`,
      say: p.say,
      onGuest: !late,
      card: PAPER_CARD[c.commType] ?? null,
      clock: due ? { label: `Answer to ${p.name}`, at: due } : null,
    });
  }

  /* a quote generated but never sent */
  if (stage === "S2" && looking) {
    const live = quotes.filter((q) => q.state === "DRAFT" || q.state === "SENT" || q.state === "ACCEPTED");
    const quoteSent = live.some((q) => q.state === "SENT" || q.state === "ACCEPTED" || q.sentAt) || seenType.has("QUOTATION") || communications.some((c) => c.commType === "QUOTATION" && c.sendStatus === "DISPATCHED" && (!passStart || c.createdAt >= passStart));
    if (live.length && !quoteSent) {
      out.push({
        key: "send-quote",
        tone: "act",
        card: "quote",
        now: "Send the quotation to the guest",
        how: "On The quote card, press Send the quote… — by email, or record that you gave it on WhatsApp. Moving on does not need it sent, but the guest needs it to answer.",
        say: live[0]?.validUntil
          ? `I'll send you the quotation now — the price holds until ${fmtDateTime(live[0].validUntil)}.`
          : "I'll send you the quotation now.",
      });
    }
  }

  /* clocks running out within six hours (red inside the last quarter hour, or once passed) */
  for (const t of timers) {
    if (t.status !== "SCHEDULED") continue;
    const w = CLOCK_WORDS[t.timerCode ?? ""];
    if (!w) continue;
    const left = new Date(t.firesAt).getTime() - now;
    if (left > 6 * HOUR) continue;
    out.push({
      key: `clock:${t.id}`,
      tone: left <= 15 * 60_000 ? "fix" : "wait",
      now: left <= 0 ? w.now.replace(/ soon$| is near$| is due$/, " — the time has passed") : w.now,
      how: w.how,
      clock: { label: w.now.replace(/ soon$/, ""), at: t.firesAt },
    });
  }

  /* everything clear — the move itself */
  if (desk?.gate) {
    const then = MOVE_WORDS.find(([re]) => re.test(desk.gate!.label))?.[1] ?? null;
    if (desk.gate.ready) out.push({ key: "move", tone: "ready", now: desk.gate.label, how: "Everything this step needs is done.", then });
    // Not open yet, and nothing left to do but wait: the move is the last thing listed, waiting too.
    else if (!out.some((o) => o.tone === "act" || o.tone === "fix")) out.push({ key: "move", tone: "wait", now: `Then: ${desk.gate.label}`, how: desk.gate.reason ? `It waits: ${desk.gate.reason}.` : null, then });
  }

  const rank: Record<GuideTone, number> = { fix: 0, act: 1, wait: 2, ready: 3 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
