# Early departure — a guest leaving before the booked checkout (built 2026-08-24)

The operator's report (2026-08-24): *"even if I checkout on the same day as check-in, it is allowed
in the same process"* — and the investigation confirmed it. This document is the reference for what
was wrong, what the spec mandates, what was built, and what is deliberately not built. Read it
before touching the S7→S8 gate, the night-audit run, `Entry.actualCheckOutDate`, or anything under
`early-departure-service.ts`.

## 1. What was wrong

The spec (SIG-S8 §1.2) defines early departure as its **own S8 entry route** — GM authority
(Policy 36), night audits complete for the nights *already stayed*, unstayed-night charges governed
against the commitment snapshot, the Early Departure mode compressing S7→S8. None of it was wired:

- **The standard S7→S8 route had no idea what the checkout date was.** Its only date-shaped gate
  was "night audit COMPLETE for the frozen final night" — and `runNightAudit` accepted **any**
  operating date, with the desk explicitly allowing *today*. So the final night could be audited in
  the morning and the guest checked out days early through the standard route, **billed for every
  unstayed night** (live case ENT-20260814-0001: stay 14→17 Aug, audit for the 16th run at 10:57
  *on* the 16th, S8 the same minute, all three nights charged, S9 next day; 6 of the 7 bookings
  that ever reached S8 on `legphel` did so before their frozen checkout date).
- **The hotel-wide idempotency hole.** `NightAuditRecord` is keyed on the operating date alone and
  the run returns early when a record exists — so auditing a night ahead of time made the real
  02:00 nightly run a **no-op for every other in-house guest** that night.
- **The only "early departure" affordance was a cancellation.** The Stay step's old button called
  `POST /entries/:id/cancel-early-departure`: L2 (spec says L3), penalty read config keys that
  don't exist on the live DB (always 0), entry → CANCELLED/TERMINAL, rooms OCCUPIED→FREE with no
  housekeeping turnover, and **the folio left LIVE and unsettled forever** — no settlement, no
  invoice, no way to ever collect. `p36-early-departure.ts` was an orphan; the seeded
  EARLY_DEPARTURE mode was never consulted.

## 2. The rulings encoded

Per Policy 36 (DEV-SPEC Part 5 / SIG-S7 §361 / SIG-S8 §399) and SIG-S8 §1.2, following the SIG-S8
reading (the early leaver **settles through S8/S9**; the Part-13 "S7 → terminal" cancellation
survives as the separate walk-out route):

1. **GM (L3+) records it.** Below that the desk button locks with the reason.
2. **The slept nights are never re-priced** — they stay on the ledger exactly as the audits posted
   them from the frozen figures. Nothing is re-quoted; no new segment.
3. **The unstayed nights are simply never posted**, and the stay's frozen row figures are scaled to
   the nights actually covered (the same row surgery an in-house room change performs), so
   settlement's p22 rate-basis expectation and the p61 stay-night audit window read the shortened
   stay on their own.
4. **The fee is configurable** (`earlyDeparture.penalty`, per rate plan) and posted as one SERVICE
   charge on the live folio — SC/GST companions follow like any charge — or waived by the GM with
   a reason.
5. **The freed nights open immediately** — the inventory claim ends on the actual departure, not at
   S9 closure.
6. **Then checkout runs unchanged**: the record compresses into S8 (H4 auto-fulfils as a same-day
   departure) and settlement, keys, inspection, invoice, S9 follow the normal path over the slept
   nights.

## 3. What was built

### Schema (migration `20260822160000_early_departure`)

- `Entry.actualCheckOutDate DateTime?` — the day the guest actually left, when earlier than booked.
  The Reservation row is immutable, so this is the denormalised real end of the stay.
- `EarlyDepartureRecord` (readable id `ED-YYYYMMDD-NNNN`, one per entry) — booked vs actual dates,
  slept/unstayed nights, the per-row figures (`rooms` json), the forgone room subtotal/total, the
  resolved fee rule + arithmetic (`feeBasis`), the fee (or waiver), reason, GM identity.

### The one date reader — `lib/stay-dates.ts`

`effectiveCheckOutDate(entry)` = `actualCheckOutDate` (when earlier) → `frozenCheckOutDate` →
`entry.checkOutDate`. Consumers moved onto it: the S7→S8 gate (final-night audit + same-day H4),
settlement (`s8-settlement-service` — p61 stay-night window + p22 charge window), the folio
statements (`folio-statement-service.stayFrame`) and the invoice prelude, the billing summary, and
the desk mirror `effectiveCheckOutIso` in `lib/desk/workspace.ts`. `hotelTodayUtc()` is the
hotel-local calendar day (`HOTEL_TIMEZONE`, default Asia/Thimphu) expressed as the UTC-midnight
date the stored columns use — Thimphu is UTC+6, so between midnight and 06:00 local the bare UTC
date is still yesterday, which is exactly when "has last night ended?" and "is today checkout day?"
would go wrong.

### The two new gates

- **Night audit runs only for a night that has ENDED** —
  `enforceNightAuditOperatingDateEnded` (in
  [p61-night-audit-complete-before-s7-to-s8.ts](../back_end/src/policies/24-night-audit/p61-night-audit-complete-before-s7-to-s8.ts),
  wired into `runNightAudit`): `operatingDate >= hotelToday` → 409 `NIGHT_AUDIT_DATE_NOT_ENDED`.
  Closes both the early-checkout door and the hotel-wide no-op hole. The desk's date input is
  capped at yesterday and its copy says an early leaver never needs a future night audited.
- **The standard S7→S8 refuses a departure before the booked checkout** —
  `enforceDepartureNotBeforeBookedCheckout` (Policy 36, now wired): `hotelToday < effective
  checkout` → 409 `EARLY_DEPARTURE_REQUIRED` pointing at the Stay step. Once the departure is
  recorded, the effective checkout IS today and the gate passes on its own.

### The governed route — `services/domain/early-departure-service.ts`

- `POST /api/entries/:id/early-departure/preview` (**L1**) — the figures, computed and nothing
  written: slept/unstayed nights, per-row scaled frozen figures, forgone room subtotal/total, the
  fee the configured rule yields (net + indicative gross), each slept night's audit status, and
  every blocker (`blockers[]`), so the desk shows *why* the button is locked.
- `POST /api/entries/:id/early-departure` (**L3**, body `{departureDate?, reason, waiveFee?,
  waiveReason?}`) — `recordEarlyDeparture`: gates (S7 + ACTIVE + folio LIVE, `requireActiveMode
  ("EARLY_DEPARTURE")` — the mode is finally load-bearing, p36 authority + date bounds, no open
  stay-extension request, slept nights audited), then in one transaction: the `EarlyDepartureRecord`,
  each touched RoomAssignment row end-dated at the departure with `frozenSubtotal`/`frozenTotal`
  scaled to its slept nights (a never-entered future-move row collapses to zero nights and its
  forward claim flag is released), `Entry.actualCheckOutDate` + `checkOutDate` = departure (the
  Today list's "leaving" column follows), W37 stay-night reminders for the departure onward +
  W26 checkout clocks cancelled, trace `ENTRY.EARLY_DEPARTURE_RECORDED`. After the transaction,
  best-effort and reported honestly (the room-change composite's partial-outcome contract): the fee
  via `postCharge` (SC/GST companions, soft-gate bypass as GM; `feePosted`/`feeError`), then the
  S7→S8 compression via the standard `progressStageS7ToS8` (`movedToCheckout` /
  `checkoutBlocked {code, message}` — a blocked move leaves the stay already shortened at S7 and
  the operator continues through the normal gate).
- **Fee config `earlyDeparture.penalty`** (ConfigurationService; seeded, applied to `legphel`):
  `{ basis: NONE | FLAT_AMOUNT | UNSTAYED_NIGHTS | PERCENT_OF_UNSTAYED, amount, nights, percent,
  perRatePlan: { <ratePlanId>: {…} } }`. Default: one unstayed night at the frozen per-night room
  figure (`UNSTAYED_NIGHTS, nights 1, percent 100`). Surfaced on the admin operational page as an
  info-described key.

### Inventory release

`reservedClaimEndDate()` in [entry-inventory-claim.ts](../back_end/src/lib/entry-inventory-claim.ts)
caps every RESERVED claim at the actual departure; `findRoomBookingConflicts` and the S1 engine's
reserved blockages both read it (and `reservedEntryRoomsSelect` now carries
`actualCheckOutDate`), so the unstayed nights are searchable the moment the departure is recorded —
verified: room 203's claim ended on the departure day while the slept nights stayed claimed.

### The old cancellation route

`POST /entries/:id/cancel-early-departure` is kept for API compatibility as the **terminal
walk-out** path, raised to **L3** per SIG-S7 §8.9, and it no longer strands money: the folio is
sealed at the end (OUTSTANDING while a balance remains, SETTLED at zero, `closedAt` stamped —
Part 13 "folio financial residue governed"). The desk no longer calls it.

### Desk

- **Stay step — "Leaving early"** ([early-departure.tsx](../front_end/src/components/desk/workspace/early-departure.tsx)),
  replacing the old cancel-style block: shown only while today is before the effective checkout and
  nothing is recorded yet. Server figures only — the room charges the stay drops, the fee (net +
  ≈ gross, rule explanation on hover), each unaudited slept night with a **Run night audit** button
  (L2+), reason, GM-only waive + reason, and **"Record early departure & go to Check-out"** (locked
  below GM with the reason) behind a danger consequence modal. Success lands the workspace on the
  Check-out step; a blocked compression or unposted fee is toasted verbatim.
- **Gate line** — `s7Readiness` now leads with the checkout-date line: "Booked checkout is 28 Aug —
  leaving earlier is an early departure (GM, Stay step)" until the day arrives / the departure is
  recorded, so "Continue to Check-out" locks honestly.
- **Facts strip** — `EarlyDepartureFacts` pinned in the workspace top bar on every step once
  recorded: "Left early on 24 Aug — booked to 28 Aug · 2 of 6 nights slept · fee Nu 2,000.00 on the
  folio (ED-…)". The header total reads **"Total · shortened stay"** and the billing summary's
  `stayTotal` is the basis total less the unstayed nights' frozen room totals
  (`stayTotal.earlyDeparture` carries the breakdown).
- **Night audit block** — date capped at yesterday; the "Final stay night" line follows the
  effective checkout.

### Fixture

`scripts/seed-in-house-test-booking.ts` (dry-run default; `--commit`, `--clean --commit`;
`--slept/--ahead/--rate/--room`) — a minimal `TEST-ED-` prefixed in-house S7 booking with real
frozen figures, because no live booking was mid-stay when this was built.

## 4. Verified

- **API (fixture, 2 slept / 4 booked ahead, rate 2,000 net):** audit for today and tomorrow → 409;
  past nights run; preview: 6/2/4 nights, forgone 8,000 net / 9,240 gross, fee 2,000 net / 2,310
  gross, future departure date refused; standard S7→S8 → `EARLY_DEPARTURE_REQUIRED`; FOM record →
  403; GM record → `ED-…`, fee + SC (200) + GST (110) on the folio, row 20→22 Aug at 4,000/4,620,
  `movedToCheckout: true`, H4 auto-fulfilled, repeat → refused; billing summary shortened; timers
  cleared; settlement CASH 6,930 → folio SETTLED, room DEPARTED_DIRTY (p61/p22 passed over the
  slept nights); master bill "Stay 20–22 Aug · 2 nights"; claim check: unstayed nights free, slept
  nights still claimed.
- **Desk (Puppeteer as GM):** readiness 4/7 with Continue locked; the block's figures; both
  missing-audit Run buttons; reason → record → modal → confirm → Check-out step with the facts
  strip "Left early on Aug 24 … fee Nu 2,000.00 on the folio (ED-20260824-0001)".
- Both typechecks clean.

## 5. Deliberately not built

- **A future-dated early departure** ("we'll leave on Thursday instead of Saturday") — that is a
  date **amendment**, the shrink twin of the stay extension's S7→S4 walk; the record route accepts
  only today (or a past date within the stay for late recording — currently also refused ahead of
  today). Build it on the stay-extension composite if asked.
- **Refunds** — if the advance exceeds the shortened bill, settlement/S9 handle the credit as they
  always did; no automatic refund is initiated here.
- **Per-night early departure of ONE room** of a multi-room booking (party splits, one room leaves
  early) — that is the in-place room-change / setup-change territory, not a stay-end event.
- The calendar for everything remains **hotel-local (Asia/Thimphu) days over UTC-midnight stored
  dates**; the desk mirrors with the browser's local day (an on-site desk is in the hotel's zone).
