# Stay extension ("night extension") and interim payments — reference

Built 2026-08-21/22. This is the document to read before touching stay extensions, interim
(mid-stay) payments, or the S7 money order. It records what the operator asked for, what was
decided, what the code does, how it was verified, and what is still open.

---

## 1. The ask (operator, 2026-08-21)

Two related needs at the **Stay step (S7)**:

1. **Interim payment on a long stay.** "Sometimes when a guest stays for a longer period, the
   hotel needs to get a certain payment halfway through the stay." The checkout date does not
   change — the hotel just wants part of the money before the end.
2. **Stay extension.** "The guest can extend the stay, saying they need to stay for more N
   nights; in that also we need to get some payment from the guest." And the question: *"can it
   be done from the Stay stage in the frontend but in the backend start from S1, right?"*

## 2. The rulings (what was decided, and why)

| Question | Ruling |
|---|---|
| Does the backend walk back to S1? | **No.** S1 would release the room and re-run the whole journey + the arrival ceremony. The spec's path is **S7→S4 DATE_EXTENSION** (SIG-S7 §3.3 table, §48 "Return from S7→S4", §86 "a date extension must verify that the room is available for the extended dates"). S1 contributes only its *predicates* (availability over the extra nights). |
| What if the room is taken on the extra nights? | The extension still happens — as a **room change for those nights**: the guest stays in the current room until the old checkout and moves to another room from that date (a *scheduled* move). |
| Authority | **FOM and above (L2+)** for the extension. |
| Rate for the extra nights | **Same room → the negotiated rate carries.** **Different room type → starts at that type's published rate, with the option to negotiate.** Negotiating the extension nights' rate is **FOM** (not GM): the in-house GM rule exists to protect nights already posted to the folio; the extension nights are not posted yet, so it is pre-arrival-style negotiation. |
| The interim figure | Show the **projected total** — nights slept + nights to come (extension included) + every other charge already on the folio — and let the operator ask for **a % or a Nu amount of it**. Money already received is **netted off** (otherwise a 100% ask on a guest who paid an advance would double-charge). Generate a **proforma-style bill** (the INTERIM invoice) for it. |
| Order of money vs commit | **Payment must be taken BEFORE the extension commits.** This is the S3 doctrine applied at S7: **bill → guest's answer → money → commit**. |
| Interim payments without an extension | **Both** manual (any time, earlier or later than the rule) **and automatic** — the night audit raises a prompt every N nights so the hotel cannot forget. Default every **7 nights**, admin-editable. |
| How the commit is triggered once paid | An explicit **"Commit extension"** button (the walk's result stays visible to the operator), not an automatic commit on payment. |

## 3. What existed before, and why it was dead

- `backflowS7ToS4` ([backflows-state-machine.ts](../back_end/src/state-machines/backflows-state-machine.ts)) and the Re-enter menu's "Extend stay (date extension)" item. **It had never once run on the DB**: its hook did `tx.reservation.updateMany({ frozenCheckOutDate })`, which the [db.ts](../back_end/src/db.ts) reservation-immutability guard forbids (only the six voucher-artifact fields may be updated; a new checkout means a **new** Reservation row). It also checked no availability for the extra nights, extended no hold/assignment, re-priced nothing, and left the booking at S4 facing S4→S5→S6→S7 (the arrival ceremony) for a guest already in-house.
- Mid-stay money could not be recorded at all: `recordPayment` is gated S3–S6 and PROVISIONAL folio (p27 `enforceEntryWithinAdvanceCollectionWindow`); at S7 the folio is LIVE and the only money-in was S8 settlement. The S7 credit-ceiling tiers (75/90/100%, W12) were an alarm with no resolution path.
- The in-place room-change composite (`changeRoomToNewSegment`, [room-change-service.ts](../back_end/src/services/domain/room-change-service.ts)) already ran the exact governed journey an extension needs — new segment, silent re-quote, S2→S3, hold, re-freeze, voucher answer auto-recorded, **compressed S4→S7 return** (SIG-S6 §102 / SIG-S7 §42) — so both features were built on it.

The Re-enter menu item was removed from the desk ([backflows.ts](../front_end/src/lib/api/backflows.ts) `BACKFLOWS_BY_STAGE.S7`); the `backflows.s7ToS4` client function and the HTTP route still exist for API compatibility but should not be used.

## 4. The flow, end to end

### 4.1 Interim payment (long stay, no extension)

```
(night audit: every N nights → SUGGESTED request, or the desk presses "Generate interim bill")
  → REQUESTED   figures computed + frozen on the request, INTERIM invoice minted (DRAFT, totalAmount = dueNow)
  → BILLED      POST /invoices/:id/dispatch — INTERIM_INVOICE communication + W22 answer window, email + PDF
  → (guest's answer recorded — p52 acknowledge, verbal or written)
  → PAID        POST /interim-payments/:id/record-payment (partials accumulate until dueNow)
```

### 4.2 Stay extension

```
preview  POST /entries/:id/stay-extension/preview   (no writes) — standing of each current room over the
                                                    extra nights, alternatives, projected price, figures
request  POST /entries/:id/stay-extension (L2)      — REQUESTED: extra nights CLAIMED for the guest (hold
                                                    TTL), EXTENSION interim request + INTERIM invoice
dispatch POST /invoices/:id/dispatch                — extension + interim → BILLED
answer   POST /communications/:id/acknowledge
pay      POST /interim-payments/:id/record-payment  — interim PAID → extension PAID
commit   POST /entries/:id/stay-extensions/:requestId/commit (L2) — Policy 80 refuses unless PAID; runs the
                                                    composite in extension mode; request → COMMITTED
(or)     POST /entries/:id/stay-extensions/:requestId/withdraw; or W40 lapses an unpaid request on TTL
```

What the commit does (all inside `changeRoomToNewSegment` with `extension: {...}`):
1. Context runs the stay to the **new** checkout; the extra nights are in the per-night picture
   from the start; `substitutionNights` = the extra nights.
2. Every room that continues past the old checkout is availability-checked over those nights
   (own claims — the reservation and the pending extension — excluded, via `findRoomBookingConflicts`).
3. Re-entry S7→S2 (ROOM_CHANGE mode backflow). S7 hooks in extension mode: **nobody moves today**;
   `entry.checkOutDate` → new date; every assignment row ending on the old checkout runs on when its
   room continues; a new room (scheduled move) gets a bare row `[old checkout → new checkout]`;
   no physical swap, no H2/H3 cancellation.
4. Sealed config on the new segment: per-night shape with the extra nights + a `stayExtension`
   marker (`{requestId, priorCheckOutDate, newCheckOutDate, extraNights}`), plus the usual
   `roomChange` marker when a room moves.
5. Carried compositions: every row carries (an extended room prices more nights through the
   per-night seal); a new room gets the moving party's row, with `negotiatedRoomRate` dropped
   when cross-type. The request's stored `roomCompositions` (the extension table) go through the
   supplied-table path; commercial-change detection skips the extension's new rooms (FOM
   territory), so only a changed rate on an already-posted room trips the in-house GM rule.
6. Silent quote (nights = the extended stay) → S2→S3 → hold refreshed over the full plan →
   `confirmReservation` re-freeze (**new** Reservation row with the new `frozenCheckOutDate`) →
   voucher answer auto-recorded (the request + the paid bill ARE the guest's answer) → compressed
   S4→S7 return (no H2/H3 minted for an extension).
7. Continuing rooms' assignment rows re-frozen from the quote (`hydrateRoomAssignmentComposition`),
   a new room's bare row hydrated over its own window; then `registerNightAuditTimers` (extra
   nights get their clocks), W26 checkout timer cancelled/re-keyed, the W40 hold timer cancelled.

Partial-outcome contract as the room change: the re-entry commits first; a later blocked step
returns `walk.blocked` naming the step and the request stays PAID with the outcome stored.

### 4.3 From the desk — what the operator sees (reshaped 2026-08-22)

The first cut of the **Extend the stay** block showed every control at once (two striped
figure strips, three different totals, a half-width %/Nu switch, a "(the S2 table)" checkbox
and a disabled "Request extension" that never said why) and the operator reported it as
confusing to use. It is now two **numbered step lists** in
[stay-money.tsx](../front_end/src/components/desk/workspace/stay-money.tsx) — a step list is a
form with an order, not a wizard: every step with controls renders them, the bubble says where
the operator is (green tick = done, terra number = needs you, dashed = later).

**Setting up an extension** (no open request; FOM at S7):

| Step | What it holds | Done when |
|---|---|---|
| ① New checkout | date input (min = current checkout + 1) · "= N more nights" · **Check availability & price** (primary; becomes a ghost "Check again" once checked). Changing the date discards the check. | a preview exists for that date |
| ② Rooms for the extra nights | one row per current room: type · a chip per extra night (free / reserved (guest) / held / blocked) · "✓ stays on" or "taken — the guest moves out of it on <old checkout>"; a taken room opens **Move Room N to, from <date>** listing free rooms **same type first** ("same type — rate carries" / "different type — published rate"). The backend's `blockedReason` prints under it. | no `blockedReason` |
| ③ Price & the payment to take now | ONE ledger: stay total before → after (+delta) · other charges on the folio · **projected total at checkout** · "Ask the guest now for [50] [% \| Nu] of the projected total" = ask amount · − already received · **Due now** · left to pay at checkout. Then an optional **Negotiate the extra nights' rates** toggle that opens the S2 `RoomCompositionPlanner` for the extension's rooms. Shown only once ② is settled — a price for an unresolved plan was half the confusion. | `dueNow > 0` (otherwise: "what the guest already paid covers this share — raise the ask") |
| ④ Hold the nights & generate the bill | reason + the button of the same name (the modal's confirm label too — one name for the act; the hint says "type the reason to continue" while it is disabled). | — |

**An open request** is a five/six-step checklist, only the CURRENT step carrying its controls
and the later ones saying what they wait for: *Extra nights held* ✓ (until … / N h left —
released if unpaid) → *Interim bill generated* ✓ (an S3-style **document row** — INV number · "Interim invoice" ·
due now · Ready to send / Sent / Paid · **View/Hide** · **PDF** — with the house-format document
**open inline by default until the bill is sent** (same-day operator report: "it shows bill is
generated but I cannot see the bill"); it folds once sent and View re-opens it; the small
ledger sits beneath)
→ *Send the bill to the guest* (Send-to + **Send interim invoice**) → *Record the guest's
answer* (`CommunicationAcceptanceBlock`) → *Log the payment received* (amount prefilled with
the remainder · method · **Log payment received**; partials show "X received · Y still to
come") → *Commit the extension* (**Commit extension** + consequence modal; locked until PAID
with "after the payment is in — the booking keeps its current checkout until then").
**Withdraw extension** sits under the list. The header tag follows the state:
"Nights held — bill ready to send" → "Bill sent — awaiting payment" → **"Paid — ready to
commit"** (a bare "Paid" read as finished) → "Extended". The long-stay **Interim payment**
block uses the same shared checklist (`InterimRequestPanel`: bill → send → answer → money)
and a three-row ledger (projected total · received · outstanding) above its ask; its history
lists LONG_STAY bills only — the extension's bills live under Extend the stay.

**The reminder clock — "need a timer for a reminder to get that mid-stay payment" (2026-08-22,
operator request).** Every interim bill now carries **`dueBy`** — when the money is expected —
and the **W41 `INTERIM_PAYMENT_REMINDER_W41`** clock fires there while the bill is unpaid:

- **Default due-by** from config **`interimPayment.reminder`** = `{ enabled: true, dueAfterHours: 24,
  extensionLeadHours: 6, repeatEveryHours: 24, maxReminders: 5 }`: a long-stay bill is due
  `dueAfterHours` after it is generated; an extension's bill `extensionLeadHours` **before its
  held nights lapse** (never less than an hour out). The desk can set any future date/time on
  the ask ("Payment due by") and change it later (`POST /api/interim-payments/:id/due-by`, trace
  `INTERIM_PAYMENT.DUE_BY_SET`, clock re-armed). `resolveInterimDueBy` / `armInterimPaymentReminder`
  / `cancelInterimPaymentReminder` in [interim-payment-service.ts](../back_end/src/services/domain/interim-payment-service.ts);
  the extension preview returns `reminder.defaultDueBy` so the desk can show the default.
- **When it fires** ([w41-interim-payment-reminder-worker.ts](../back_end/src/workers/w41-interim-payment-reminder-worker.ts)):
  paid / withdrawn / lapsed / booking moved on → skip; a re-armed clock's stale fire → skip;
  otherwise `remindersSent` + 1, `lastReminderAt`, trace **`INTERIM_PAYMENT.REMINDER_DUE`** (kind,
  due, received, remaining, whether the bill was even sent, hold expiry) + notification
  `NOTIFICATION.INTERIM_PAYMENT_REMINDER_DISPATCHED` (routing `notification.routing.interimPayment`,
  default OPERATOR), then **re-arms every `repeatEveryHours` up to `maxReminders`**. It gates
  nothing — Policy 80 and W40 stay the teeth.
- **Cancelled** the moment the bill is paid in full (`recordInterimPayment`), withdrawn
  (`withdrawInterimPaymentRequest`), replaced by a new ask, or its extension is withdrawn / lapses.
- **Where the desk shows it**: the timer rail ("Mid-stay payment reminder"); the bill step's
  due-by line — "Payment due by … · reminder in 22h" / red "Payment overdue — was due …", with
  reminders raised + the next one, and **Change / Set a due date**; a "Payment overdue" tag on the
  block header; the **Today list** — the entry list carries open interim bills
  (`interimPaymentRequests`), so a due-within-24h bill ranks `warn` and an overdue one `crit`
  with "Mid-stay payment overdue — collect it (N reminders raised)" as the booking's need
  (`interimPaymentAlert` in [model.ts](../front_end/src/lib/desk/model.ts)); the interim
  invoice document and email print "Payment due by".
- Columns on `InterimPaymentRequest` (migration `20260822130000`): `dueBy`, `reminderTimerRecordId`,
  `remindersSent`, `lastReminderAt`.

**The guest's promise — "before sending the interim bill, put the option to put when they are
going to pay, a promised time like S3's advance" (2026-08-22, operator request, same day).** The
S3 idea at S7: between *Bill generated* and *Send the bill* the checklist asks **"When will the
guest pay?"** — *By a promised date & time* (+ "Note — what they actually said") or *Now — paying
at the desk* — and **Send waits for that answer** (desk order, like S3's requirement → plan →
proforma; the backend does not gate it). `POST /api/interim-payments/:id/promise` →
`recordInterimPaymentPromise` (columns `promiseKind NOW|BY_DATE`, `promisedBy`, `promiseNote`,
`promiseRecordedAt/By`, migration `20260822140000`; trace `INTERIM_PAYMENT.PROMISE_RECORDED`).
A dated promise **becomes the bill's `dueBy`** and re-arms W41, so the reminder fires at the
guest's own time — a lapsed promise then reads "Promise lapsed — the guest said …" on the desk
and "promised mid-stay payment overdue" on Today; "paying at the desk" keeps the default due-by
in case it slips. An extension's promise cannot land after its held nights lapse (W40 would
release them first — refused naming the expiry). The interim invoice and email print
**"Payment promised: by 25 Aug 2026 — “will transfer after lunch”"** (`describeInterimPromise`,
shared by document, email and desk) in place of the plain due-by; a promise recorded after the
bill went out updates the reminder but does not re-issue the sent copy (stored PDFs are
write-once). The ask-time "Payment due by" field was retired in the promise's favour (the API
still accepts `dueBy`).

**Two defects found while reshaping it (both fixed 2026-08-22, backend):**

- **A multi-room move could never unblock.** The desk's move-to pick posts `perNight` as one
  room for every extra night, and the preview resolved "which current room is being
  replaced" as *the first current room not named in the overrides* — on a four-room booking
  the pick meant for the taken Room 302 paired with Room 206 (`moves: 206 → 205`) and 302 stayed
  blocked, so step ③ never opened. The preview/request input now carries **`replaceRoomId`**
  (DTO `stayExtensionShape`, optional; refused naming the last-night rooms when it is not one
  of them); without it the service picks the current room that is **not free** over the extra
  nights, then the first not-in-overrides one. The desk always names the taken room.
- **Candidate `sameType` was judged against the booking's first room**, so the select said
  "205 · Deluxe Double (same type — rate carries)" for a move out of a *Standard* Double while
  the move priced cross-type. `sameType` / `requiredLevel` on the preview's `candidates` are
  re-derived against the replaced room (the caller's `replaceRoomId`, else the taken one) and
  the list re-sorted same-type first.

## 5. Data model (migration `20260821150000_interim_payment_and_stay_extension`)

- `InvoiceType.INTERIM` — the mid-stay bill. Document: `renderLegphelInterimHtml` (house A2 format,
  hero = "Due now"); email: `renderInterimInvoiceEmail`; inline preview via `GET /invoices/:id/preview-html`;
  PDF via `generateOrLoadInvoicePdf` (storage kind `interim-invoice`). The figures printed are the
  ones **frozen on the request** at ask time, so the bill the guest answers is the bill the money
  is recorded against.
- `CommunicationType.INTERIM_INVOICE` — acknowledgeable (p52); its answer **gates** the payment.
  W22 window key `acknowledgement.windowPerType.interimInvoice` (falls back to `pi`).
- `InterimPaymentRequest` — `kind` LONG_STAY | EXTENSION; `state` SUGGESTED → REQUESTED → BILLED →
  PAID / WITHDRAWN / LAPSED; `promptedBy` MANUAL | NIGHT_AUDIT; `askMode` PERCENT | AMOUNT,
  `askValue`, `projectedTotal`, `receivedAtRequest`, `dueNow`, `figures` (the full frozen figure set),
  `invoiceId` (unique), `stayExtensionRequestId` (unique), `nightsSleptAtPrompt`.
- `StayExtensionRequest` — `state` REQUESTED → BILLED → PAID → COMMITTED / LAPSED / WITHDRAWN;
  `priorCheckOutDate`, `newCheckOutDate`, `extraNights [{date, roomId}]` (one entry per room per
  night — every room of the plan that continues), `roomCompositions` (the extension table, full
  basis for the extension's rooms), `requestedDiscount`, `pricingPreview` (projection + figures +
  moves at request time), `reason`, `holdExpiresAt`, `timerRecordId`, `outcome` (the commit's
  RoomChangeOutcome).
- `PaymentRecord.interimPaymentRequestId` — links the money to the ask (stage S7, direction IN).
- Config keys (ConfigurationService, seeded + `scripts/seed-additional-config-keys.ts`):
  `interimPayment.schedule` = `{ enabled: true, everyNights: 7, minimumOutstanding: 0 }`;
  `stayExtension.holdTtlSeconds` = 86400.
- Timer code `STAY_EXTENSION_HOLD_EXPIRY_W40` + [w40-stay-extension-hold-expiry-worker.ts](../back_end/src/workers/w40-stay-extension-hold-expiry-worker.ts).
- Timer code `INTERIM_PAYMENT_REMINDER_W41` + [w41-interim-payment-reminder-worker.ts](../back_end/src/workers/w41-interim-payment-reminder-worker.ts)
  (2026-08-22; config `interimPayment.reminder`; `InterimPaymentRequest.dueBy / reminderTimerRecordId / remindersSent / lastReminderAt`) — see §4.3.

### The interim figures (`computeInterimFigures`, Decimal-safe)

- `roomChargesPostedSoFar` = ROOM_CHARGE lines + the SC/GST companions stamped with a night-audit
  run id; everything else on the ledger = `otherChargesSoFar`.
- `projectedRoomTotal` = the extension projection when there is one, else the booking's priced stay
  total (`buildEntryBillingSummary.stayTotal`), else the posted run-rate forward (legacy bookings).
- `projectedTotal` = projectedRoomTotal + otherChargesSoFar. `receivedSoFar` = payments IN − OUT.
- `askAmount` = % of projectedTotal or the Nu figure; `dueNow` = max(0, askAmount − receivedSoFar),
  capped at what the stay can still owe; `balanceAtCheckout` = projectedTotal − received − dueNow.

### Policy 80 — [p80-interim-payment-gates.ts](../back_end/src/policies/35-interim-payment/p80-interim-payment-gates.ts)

`enforceInterimPaymentStage` (S7 + LIVE folio), `enforceInterimInvoiceDispatchedBeforePayment`
(`INTERIM_INVOICE_NOT_DISPATCHED`), `enforceInterimGuestAnswerRecordedBeforePayment`
(`INTERIM_GUEST_ANSWER_REQUIRED`), `enforceExtensionPaidBeforeCommit` (`EXTENSION_PAYMENT_PENDING`).

### Room claims

`pendingStayExtensionClaims` ([entry-inventory-claim.ts](../back_end/src/lib/entry-inventory-claim.ts))
— a request in REQUESTED/BILLED with a live `holdExpiresAt`, or PAID (money taken, so the claim
stands until the commit), claims its `extraNights`. Read by **both** `findRoomBookingConflicts`
(Policy 26 / candidates) and the S1 availability engine as a committed-hold span, deliberately
**not** deduped against the entry's own reservation (different nights, both real). Keep the two
consumers in step — that pairing is the same "search and hold must agree" rule as the rest of
the inventory code.

## 6. Where the code is

| Piece | File |
|---|---|
| Interim service (figures, create, dispatch hook, record payment, withdraw, night-audit prompt, list) | [back_end/src/services/domain/interim-payment-service.ts](../back_end/src/services/domain/interim-payment-service.ts) |
| Extension service (preview, request, withdraw, lapse, commit, list) | [back_end/src/services/domain/stay-extension-service.ts](../back_end/src/services/domain/stay-extension-service.ts) |
| Composite extension mode + `listRoomStandingForNights` (shared with room-change candidates) | [back_end/src/services/domain/room-change-service.ts](../back_end/src/services/domain/room-change-service.ts) (search `isExtension`, `StayExtensionWalkInput`) |
| Quotation preview `stayOverride` (price a different checkout / night counts) | [back_end/src/services/domain/quotation-preview-service.ts](../back_end/src/services/domain/quotation-preview-service.ts) |
| INTERIM document / preview / PDF branch | [back_end/src/services/domain/invoice-pdf-service.ts](../back_end/src/services/domain/invoice-pdf-service.ts) (`buildInterimDocRender`), [legphel-proforma-template.ts](../back_end/src/services/infrastructure/pdf-templates/legphel-proforma-template.ts) (`renderLegphelInterimHtml`) |
| Dispatch (INTERIM branch) + email | [back_end/src/services/domain/s9-service.ts](../back_end/src/services/domain/s9-service.ts), [stage-email-templates.ts](../back_end/src/services/infrastructure/stage-email-templates.ts) (`renderInterimInvoiceEmail`) |
| Night-audit prompt hook | [back_end/src/services/application/s7-night-audit-service.ts](../back_end/src/services/application/s7-night-audit-service.ts) (`maybePromptInterimPaymentTx` per entry) |
| Routes | entries router: `POST /:id/stay-extension/preview` (L1), `POST /:id/stay-extension` (L2), `GET /:id/stay-extensions`, `POST /:id/stay-extensions/:requestId/commit|withdraw` (L2). Folios router: `GET/POST /entries/:id/interim-payments`, `POST /interim-payments/:id/record-payment`, `POST /interim-payments/:id/withdraw` (L1). |
| DTOs | [06-reservations/request-schemas.ts](../back_end/src/dtos/06-reservations/request-schemas.ts) (`stayExtension*`), [07-folios/request-schemas.ts](../back_end/src/dtos/07-folios/request-schemas.ts) (`createInterimPaymentRequestSchema`, `recordInterimPaymentRequestSchema`) |
| Desk | [front_end/src/components/desk/workspace/stay-money.tsx](../front_end/src/components/desk/workspace/stay-money.tsx) (`InterimPaymentBlock`, `StayExtensionBlock`, shared `InterimRequestPanel`), client [front_end/src/lib/api/stay-money.ts](../front_end/src/lib/api/stay-money.ts); mounted on the Stay step above Night audit |
| Entry payload | `entry-detail-include.ts` carries `interimPaymentRequests` (10) and `stayExtensionRequests` (5) |

## 7. How it was verified (2026-08-22, dev DB `legphel`, as FOM)

- **Interim (long stay)** on ENT-20260821-0001: 50% ask → figures → INV dispatched; paying before
  dispatch refused `INTERIM_INVOICE_NOT_DISPATCHED`; paying before the answer refused
  `INTERIM_GUEST_ANSWER_REQUIRED`; answer recorded; 100 + remainder → PAID, invoice
  PAYMENT_TRACKED, folio balance 0.
- **Extension** on the same booking, 26→28 Aug and again 28→29 Aug: preview (Room 201 FREE per
  night; stay total 10,395 → 20,790 → 25,987.50), request (REQUESTED, held 24h, interim for the
  net ask), commit refused `EXTENSION_PAYMENT_PENDING` until paid, then COMMITTED: new segment,
  S7, entry + frozen checkout on the new date, assignment row run on with `frozenSubtotal` 22,500
  (5 × 4,500), night-audit clocks for every night, W40 cancelled, billing stayTotal = the new quote.
- **Claims + lapse** on ENT-20260819-0001: L1 refused 403; a second open request refused; the
  pending claim reported as HOLD/COMMITTED by `findRoomBookingConflicts`; W40 lapse → request
  LAPSED, interim LAPSED, invoice SUPERSEDED, claim gone.
- **Desk** (Puppeteer, FOM): both blocks render with live figures; the extension preview shows the
  per-night standing and re-projects (25,987.50 → 31,185.00 for one more night).

The smoke scripts used live in the session scratchpad and are not in the repo; the flow above is
easy to replay with curl (login `fom` / `2222`).

**2026-08-22 reshape (desk + the two preview fixes), verified by driving the desk with Puppeteer as
FOM and over HTTP:** ENT-20260821-0001 — the four setup steps render, ③ prices the single-room
extension (25,987.50 → 31,185.00; due now 2,598.75 after the 22,207.50 received). ENT-20260812-0001
(four rooms, 302 reserved on the extra night) — ② lists the three free rooms as "stays on" and 302 as
taken with the move-to select **same-type first** (202, 303 Standard Double; 205 now reads
"different type"); picking a room unblocks ③ (`moves 302 → 205`, plan 206/204/201/205, projected
122,127.39); over HTTP the same pick with and without `replaceRoomId` resolves to 302, a bogus id is
refused naming 206, 204, 201, 302. ENT-20260819-0001 — a real request walked send → answer → pay
through the checklist (each step flipping to its ✓ summary and the next opening), the header going
"Nights held — bill ready to send" → "Paid — ready to commit", the Commit-extension modal opening
from step 6; withdrawn afterwards rather than committed (its dates are in the past).

## 8. What went wrong on the way (so it isn't repeated)

- The **first commit crashed after the irreversible re-entry**: an in-place extension has no
  "target" room, and the composite resolved `toRoom` from `targetById`, which only got the
  from-room in setup-only mode → `toRoom.id` on undefined at the outcome, with the booking already
  at S2 in a new segment. Fixed (`if (setupOnly || isExtension) targetById.set(...)`). The stranded
  booking was finished by [scripts/resume-stay-extension-walk-ent-20260821-0001.ts](../back_end/scripts/resume-stay-extension-walk-ent-20260821-0001.ts)
  — a manual mirror of steps 2–7 for an S7 origin. Keep it as the template if a walk ever
  strands a booking again.
- Earlier the same day a seating repair (sibling feature, same composite) stranded a booking at
  S2 because an L1's walk hit the discount-authority gate at the silent quote — the carry now
  reads the `S2.DISCOUNT.APPROVED` trace when the quote has no `discountAuthority` stamp.

## 9. Not built / open

1. **Move-day execution of a scheduled move.** When the extension puts the guest in a different
   room from the old checkout, the commit writes the plan (sealed config, a bare assignment row for
   the new room from that date) but nothing executes the move on the day: the old room's
   OCCUPIED → DEPARTED_DIRTY, the new room → OCCUPIED, fresh H2/H3 for the new room, the key
   swap. Today the desk would use the existing S7 key-swap flow (per-room key return/issue) and a
   manual room-state change. A "Move today" action on the Stay step's Rooms block that reuses the
   S7 room-change hook code (physical swap + H2/H3) is the natural next piece.
2. **A crashed/blocked walk is not resumable in-product.** Both recovery scripts are one-offs.
   The composite's steps 2–7 would need extracting into a resumable tail keyed on the new segment.
3. **Multi-room moves.** On a multi-room booking, every room continues by default; if one current
   room is taken on the extra nights the preview replaces only that one (`replacedRoomId`) with the
   picked room. Moving more than one room in the same extension is not supported (request it as
   two steps, or extend then room-change).
4. **Desk per-night picker.** The desk's move-to select applies one room to all extra nights
   (and names the replaced room via `replaceRoomId`); the API accepts a room per night (`perNight`).
5. **Interim payment outside S7** (e.g. at S8 before settlement) is deliberately refused —
   settlement is the S8 money path.
6. **Admin typed editor** for `interimPayment.schedule` — it is description-only (JSON editor);
   `stayExtension.holdTtlSeconds` has a typed seconds field.

## 10. Starting a new session on this

- Read this doc, then the CLAUDE.md entry "Mid-stay money — interim payments on long stays +
  payment-before-commit stay extension" for the one-paragraph version and the desk details.
- Backend must run with workers (`npm run dev:workers`) for W22/W40/night audit to fire.
- Test bookings at S7 on the dev DB: ENT-20260821-0001 (Room 201, now 24→29 Aug after the two
  test extensions), ENT-20260819-0001, ENT-20260812-0001 (multi-room).
- The two invariants this feature must keep: (a) a pending extension's nights are claimed in BOTH
  the S1 engine and `findRoomBookingConflicts`; (b) money before commit (Policy 80) — do not add a
  shortcut that commits on payment without the explicit commit, or that records an interim payment
  without the dispatched-and-answered bill.
