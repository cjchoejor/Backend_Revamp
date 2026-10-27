# new_front_end — the redesign mapped onto the backend

The September 2026 redesign (`September 14 2026/`, with `September 11 2026/` as its base), built on
the real backend. It started as a copy of `front_end/`. The admin console (`/admin`), the phone
capture page (`/capture`), sign-in and the whole API layer are kept as they were. Everything the
desk uses was rebuilt in the new design.

Runs on **:3002** (`npm run dev`). The old `front_end` keeps :3001. Both talk to the same backend
on :4000.

## How it is put together

| Piece | Where |
|---|---|
| Design system (tokens, components, fonts, icons) | `src/design-system/` — `styles/components.css` is generated from the prototype's CSS, with every rule scoped under `.ds` and kept out of `.desk-root` |
| The frame (bar, clock, bell, user panel, second row) | `src/components/ds/app-shell.tsx`, mounted by `src/app/(app)/(ds)/layout.tsx` |
| Shared list pieces (step chip, status chip, row that opens a booking) | `src/components/ds/ui.tsx` |
| The booking workspace | `src/components/ds/workspace/ds-workspace.tsx` |
| The nine step canvases, and the kit they share | `src/components/ds/steps/` (`kit.tsx`, `s1-inquiry.tsx` … `s9-closed.tsx`, with their `sN-*.tsx` parts) |
| Desk words: steps, status phrase, timers, refusals, history lines | `src/lib/ds/` (`steps`, `status`, `timers`, `words`, `translate`, `trace-words`) |
| Today's lists (what needs a person, the hotel's day) | `src/lib/ds/attention.ts` |
| Dates, times and money formatting | `src/lib/ds/format.ts` |
| Old working tools used inside the new cards | `src/components/desk/**` — the composition planner, the room-by-night table, the guest table, the folio lines, the money blocks — each placed in a card through the kit's `Tool`, inside `.desk-root`, re-dressed by `styles/legacy-bridge.css` |

**Rules the code keeps.**
- **No stage codes on screen.** Steps are always Inquiry · Negotiation · Set up · Reserve · Arrival · Check-in · Stay · Check-out · Closed. Every error message from the backend is translated once, in `lib/api/client.ts`.
- **No money arithmetic.** Every amount is the backend's own figure. When the backend has no figure, the screen shows "—" or "Not available yet".
- **One "today".** The hotel's day comes from `GET /api/lookups/hotel-day`. The clock is corrected against the server's time.

## Screen by screen

| Screen | Route | Reads | State |
|---|---|---|---|
| Today | `/today` | `GET /api/desk/bookings`, `POST /api/desk/bookings/money` (Leaving list), `GET /api/rooms` (occupancy line) | Built. Needs attention (bands, folds), the incomplete record, the hotel's day (arriving / leaving / in-house / new inquiries / parked), arriving this week. |
| Bookings | `/bookings` | same list + money for the rows on screen | Built. Search, date range, phase groups, Parked / Cancelled, sort, "Show 50 more", preview on click, open on double-click. The filters live in the address. |
| New booking | `/bookings/new` | the existing intake (`/api/guest-profiles`, `/api/inquiries`, `/api/entries`, lookups) | Built (`components/ds/steps/new-inquiry.tsx`). The five Stage 1 sections in the journey mockup's order (2026-10-10): 1 The caller (a phone or an email, "On WhatsApp?", the name can wait — 2026-10-12) · 2 Who is asking · 3 The stay as a form, worked one at a time — the current one ringed "you are here", a finished one folding to a line with Edit once the desk moves on — then 4 The house and 5 Wrap up, which wait for the booking. The stay's own button, "Done · Start the inquiry", keeps the lead and opens the booking, where the house is asked. Every rule of the old intake is kept. `?edit=<id>` redirects to the booking's Inquiry step (2026-10-12) — a saved inquiry is edited there, section by section. "Name to come from the agent" waits for BE-62. |
| Booking workspace | `/bookings/:id?step=N&view=other\|details\|money\|requests\|notes\|docs\|history` | `GET /api/entries/:id`, `…/billing-summary`, `…/payment-status`, `…/communications`, `…/timers`, `…/trace`, `…/identity-proofs` (at Check-in) | Built frame. **Stage 1 (2026-10-27)** runs in the stage-template layout (`docs/PMS Stage Template.html`): the clocks with rings in the header, the journey and the step's sections as lines under it, the step on the left, the booking file (Booking · Charges & payments · Guest requests · Notes · Documents · History) on the right, the other ways in the fixed bar at the foot — no rail, no step tabs, no side panel; the rest below describes the other steps. **Header:** status, dates, rooms, source, custodian, total — it opens Charges & payments. **Rail:** phases, the two boundaries, Re-enter, Park / Resume, Under the hood. **Tabs (2026-10-12):** This step · the step's own tabs · Other ways · Booking details (the three parties, the stay, the trip, the numbers) › the booking's five (Set up and Reserve have a Rooms tab of their own since 2026-10-13, the rooms table Arrival, Check-in and Stay already had), the same on every step — Charges & payments (`…/billing-summary`, `…/payment-status`; the price set out as the quotation prints it — rooms with their extra beds and meals beneath, then net, SC, GST, discount, total — from `GET /api/quotations/:id/price-lines`, or the live table's `lines` from `…/quotation-preview` (2026-10-27); before a quotation, or while the table differs from it, the step's own picks or table priced by `…/availability/price-pick` / `…/quotation-preview` — `lib/ds/stay-price.ts`) · Guest requests (`…/guest-requests`: the preference and requests) · Notes (`…/notes`: notes, to-dos, and the words kept with each act from the trace) · Documents (papers and versions, bills & statements, what the guest said back — every confirmation voucher by its VOU number since 2026-10-13, and a replaced paper reads "no answer needed": `…/communications` carries `superseded` / `inForce` / `held`) · History (every act in chapters by step, inner tabs All · Changes · Price & payments · Approvals · Desk notes; `…/trace?limit=300` and `…/segments`). **Situation cards** above any step when they apply: parked, cancelled, no-show, passes and amendments, credit ceiling. **Side panel:** Timers · To do here (the papers and the recent acts moved to Documents and History). **Explanations on request (2026-10-12):** on Negotiation the explanatory text sits behind a **?** (`components/ds/help.tsx` — `Help` + the `QuietScreen` switch) and only messages stay on screen; the other steps follow once the operator approves. Negotiation's Other ways is sub-tabs (`OtherWaysTabs`, `?way=`): Provisional block · Park · The guest said no, each panel the act itself (Counter-offer taken off 2026-10-27). The booking's tabs have sub-tabs (`SubTabs`, `?sub=`): Charges & payments (price · bill · money received), Guest requests (requests · preference), Notes (notes & to-dos · kept by the system), Documents by kind of paper. A quotation's internal note is typed in the send dialog and kept as a booking note filed with it (`POST …/notes` with `paperKind`/`paperId`), shown in Notes and under the paper. **Change configuration (Negotiation)** changes the dates too since 2026-10-12: Check-in · Nights · Check-out in step 1, the house asked for the new dates (`POST …/availability/query`), the rooms picked for every new night, one `POST …/negotiation-amendment` with `dates` + `rooms`; History reads `ENTRY.STAY_DATES_CHANGED`. **Gate bar:** the readiness list and one forward move, with Reserve, Check-in and Close behind their commit dialogs. **Step canvases:** built from the prototype's cards (see below). |
| Under the hood | `/bookings/:id/backend` | as before | The existing view, inside the frame. |
| Rooms | `/rooms?view=tonight\|chart` | `GET /api/rooms`, `GET /api/spaces`, `GET /api/rooms/chart`, deficiency routes | Built, two sections (2026-10-12). **Tonight** (Room cards — grouped by room type, the type boxes side by side, 2026-10-26): claim standing and physical state shown separately, with each room's occupant; halls and spaces on the same page; a tile opens its fault record (the old desk's Spaces page is merged in here). **Chart**: the house night by night (`components/ds/rooms/room-chart.tsx`) — rooms by type down the side, Free that night, House booked n/total, every booking a bar by kind (provisional, held, reserved, advance short, in house, due out · still in, checked out, parked, out of order, two bookings); a bar opens its booking, a room number its faults; a From / To range and 7/14/21/28 nights, a week back or on, scrolling inside its box. Full screen (Escape closes). Resting the pointer a second on a booking (or an out-of-order run, or two bookings on a night) opens a card in the chart's colours — nothing else does; today is a dark header with a thin column edge, the weekend named in the header, free nights always white, room types solid bands. **A free night starts an inquiry**: `/bookings/new?checkIn=&nights=&room=` fills the stay, and the booking's Inquiry step asks the house and picks that room when it is free on every night (`?room=`). **Move rooms** (2026-10-12): drag a booking's bar onto another room; Ctrl-click picks more rooms, Shift-click a booking's rooms in between, and they move together keeping their spacing; a booking in a room being taken is swapped into the room left (the server adds that leg). **Switch rooms** does the same by clicking. → `POST /api/room-moves/preview` / `POST /api/room-moves` (room-move-dialog.tsx); a running or part-done move is drawn as Moving in. **Move dates** (2026-10-13): drag a bar sideways — the whole stay shifts, same nights, from Negotiation to Arrival (FOM from Set up on) → `POST /api/date-moves/preview` / `POST /api/date-moves` (date-move-dialog.tsx). While dragging, a grey copy of each bar sits where it would land (a swapped-back booking too). A date drag moves the booking's rooms as a block, keeping their spacing (`roomMap`), and the dialog asks the price per room (`priceModes`, each room's figure both ways). Since 2026-10-14 the drag takes the room held (more when picked); fewer than all of a booking's rooms opens the split window (`POST /date-moves/split[/preview]`): a booking of their own on the same enquiry, walked to the original's step, or a new enquiry started at Inquiry with `Entry.carryOver` filling the Negotiation table, the payer and the terms. An **Alt-drag** takes one night (or an Alt-picked run): onto another room on the same dates a room change for those nights, onto other dates the stay cut apart (`POST /date-moves/nights[/preview]`) — the booking keeps its earliest stay (one room) or loses the room (several), every other stay a booking of its own on this enquiry or one new enquiry. **Alt+Ctrl-click** adds a night of another of the booking's rooms (2026-10-15): each keeps its own run, the drag carries them all, same dates walk one room at a time, and stays leaving on the same dates are one booking. Held papers on every booking: `GET /api/entries/:id/held-documents`, `POST /api/held-documents/:id/decide`. **The chart keeps its place** (2026-10-24): the window is in the address (`&from=YYYY-MM-DD&nights=N`), and the chart box scroll, the page scroll and full screen are kept for the tab (`sessionStorage` `desk:chart-place`), so Back from a booking returns to the same view. |
| Housekeeping | `/housekeeping` | `GET /api/housekeeping/rooms`, `POST /api/housekeeping/rooms/:id/cleaned`, `POST /api/housekeeping/rooms/:id/needs-cleaning` | Built 2026-10-26: the rooms a guest left as cards, late first, each with clean-by, who left, the next guest, any open fault and **Mark clean**; what was cleaned today; every other room as tiles grouped by room type, the type boxes side by side; a tile opens a pop-up where one found dirty again goes back on the list with a reason. The bell carries the late rooms; Today lists the rooms to clean. A room a guest leaves is physically dirty until marked clean, so the next check-in waits for it (2026-10-26). |
| Billing | `/billing` | list + money | Built: open bills (in-house, check-out) and money still owed after a stay. There are no account totals (see gaps). |
| Shift | `/shift` | list + money + rooms | The paper form, in order. The outstanding bills and the room summary are real. The typed sections wait for a backend shift (see gaps). |
| Reports | `/reports` | list | Counts only: where the business comes from, inquiry to stay, demand lost, top agents. Occupancy and revenue wait for the backend (see gaps). |
| Guests | `/guests`, `/guests/:id` | `GET /api/guest-profiles?q=`, `GET /api/guest-profiles/:id`, `GET /api/desk/bookings?guestProfileId=` | Built. Search and the guest record with their bookings. The record is read-only. |
| Audit | `/audit` | `GET /api/desk/activity` (FOM and above) | Built. One hotel day, filtered by person or booking. The front desk sees why it is closed to them. |
| Notifications | `/notifications?view=now|sent` | the bookings list (as the bell), `GET /api/desk/alerts?days=` | Built (2026-10-23), opened from the bell's **See all notifications**. **Needs a person**: the bell's whole list — overdue, due soon, waiting — grouped by kind of work (money · arrivals · departures and closing · quotes, holds and papers · follow-ups; `WORK_KINDS` in `lib/ds/attention.ts`), filtered by urgency. **Alerts sent**: what the system sent (`NOTIFICATION.*` traces) by hotel day, one row per booking and step with its earlier alerts folded under it (`lib/ds/alerts.ts`), who each was for (front desk · FOM · GM, filterable), and how the booking stands now; Today / 7 / 14 / 31 days. |
| Handoffs · Disputes · Messages | `/handoffs`, `/disputes`, `/messages` | — | "Not available yet". Each item is still worked from its booking. |
| Console | `/admin/**` | unchanged | Copied as it was. Reached from the user panel (administrators only). |

The old `/desk/...` addresses redirect to the new ones.

## The step canvases

Each step is its own canvas in `src/components/ds/steps/`, built from the prototype's cards and the 13–14 Sep storyboards.

- Every action the old step offered is still there. Facts, small forms and buttons are native; the big old grids sit inside a card through `Tool`.
- A passed step shows what was decided, with the working controls hidden. Its papers still open.
- Every step ends with Requests (BE-64), "Other ways this booking can go" and Papers.

| Step | Cards, in order | Old tools placed inside |
|---|---|---|
| Inquiry | Five numbered sections in one column (2026-10-10, the journey mockup's order): **1 The caller** (`POST …/caller`) · **2 Who is asking** (with the rate package) · **3 The stay** (check-in · nights · check-out) — folded to a line each, with Edit — · **4 The house** (free rooms by type, Take it, and the bill: each night, each room's nights, room-nights × rate, net, service charge, GST, the stay's total — `POST …/availability/price-pick`) · Which rooms · **5 Wrap up** (the guest STAYING — the caller, someone on file or someone new, `POST …/guest`; the caller's name if not taken; who is arriving; notes; opens once the rooms are chosen). The room table carries a total band, per-type totals and each night's price | the room-by-night table and the guest board, behind "Choose the rooms…" |
| Negotiation | Who sleeps where, and their meals · Provisional block, or send the quote · Quotation · every version · competing claims | the composition planner (with its discount bar and rate strip), "Why this price" |
| Set up | The three parties · Who pays · The committed hold · The payment plan · Terms disclosed · Proforma · coordinator, milestones and free rooms when they apply | — |
| Reserve | Before: Before you reserve (signature rows with Fix) · Who receives the confirmation · Reserve · Everything chosen so far. After: What Reserve decided · Confirmation voucher · Pre-arrival tasks · The advance | the journey summary, the advance block |
| Arrival | Ready the room · Assign the rooms · Guest details · The front-desk handoff · Pre-arrival tasks · Advance and credit · the pre-arrival answer · Billing model | the per-room editors, the guest table, the advance block |
| Check-in | Before you check in · The document, at the desk · Registration card · the remaining advance · Rooms with their keys · Check in | the guest table, the per-room editors, the advance block |
| Stay | The folio · live · Post a charge (by outlet) · Chits waiting (BE-68) · The nights · Rooms in use · Keys to swap today (only on a move day) · the departments · disputes · faults · a change to the terms · **Who pays** (2026-10-26 — the FOM changes the payer here, moving the charges already on the bill or keeping them; `GET /api/entries/:id/payer`, `POST …/payer-change/preview`, `POST …/payer-change`); tabs Night audit · Rooms · **Keys** (2026-10-26, a red count of keys owed today) · Interim payment · Extend the stay · Leaving early | the folio lines, interim payment, extension, split settlement, bills and statements, leaving early, the guest table |
| Check-out | Master bill (Billed · Received · Still owed as a band) · **Damage found** (2026-10-26 — `GET /api/entries/:id/damages`, `POST …/damages/preview`, `POST …/damages/:inspectionId/answer`: charge with or without service charge and GST, waive (the FOM's), decide after departure; settle waits for an answer; also on Closed, where the seal waits for charged or waived) · How the bill is settled (the last night unaudited warned here) · Tax invoice, by payer · The departure (one inspection per room the guest leaves, as tiles, 2026-10-26 — `GET /api/entries/:id/room-inspections`, `POST …/room-inspections/bulk`) · The departure handoff; an **Add a charge** tab (`?pane=charges`, 2026-10-26): the folio and its table again, then Add or correct a charge | the folio lines, split settlement |
| Closed | What the stay was · After the stay (the bill as a band, then the acts as tiles: Record a payment · Who owes what · Late charge · Tax invoice · Write off · Credit note) · Changing a closed booking · Sealed papers; tabs **Late charge** (the bill above the form) · **Tax invoice** (what it is for, the issued ones, issue and send a new one) — 2026-10-26 | the folio lines, split settlement |

"Frozen" means **reserved in this pass** (`reservedThisPass`). The quote readiness lines count only this pass's quotations, as the backend's gates do.

## Backend added for this frontend

All read-only, in `back_end/src/routes/desk/router.ts` and `services/domain/desk-read-service.ts`:

| Route | Level | What it gives |
|---|---|---|
| `GET /api/desk/bookings` | desk | Up to 500 bookings, newest first. Each carries names, booker, custodian, rooms, holds, quote state, the latest park reason and follow-up, interim-payment dues and running timers. No money. |
| `POST /api/desk/bookings/money` | desk | Each booking header's own billing summary, for up to 100 bookings in one call. |
| `GET /api/desk/staff` | desk | Staff names, for "who did it" lines. |
| `GET /api/desk/activity?date=` | FOM+ | One hotel day of the trace, newest first, with the actor's name. |
| `GET /api/desk/alerts?days=` | desk | The alerts the system sent (`NOTIFICATION.*`) over the last 1–31 hotel days, newest first, at most 400: kind, who it was for, severity, the step and how long, the payment figures, and the booking as it stands now. |

Also for Stage 1 (2026-10-10), outside the desk router: `POST /api/entries/:id/availability/price-pick` (desk, read-only — the bill for the rooms on the table) and `POST /api/guest-profiles/:id/contact` (desk — fills a guest's empty phone or email from Wrap up; never replaces one on file).

## What the redesign asks for that the backend does not have yet

| Gap | Where it shows | Register |
|---|---|---|
| A Today feed built by the server (the lists are selected on the screen from the 500 newest bookings) | Today | SS01-P1 |
| The status phrase built by the server | every list, the header | SS02-P3 |
| Recording a decline with its reason, and the waitlist | Today (incomplete record), Reports | BE-36, BE-37 |
| A shift: float, payments by method, closing count, handover, keys out | Shift | BE-73 |
| Reporting totals: occupancy, revenue, ADR, RevPAR, GST summary | Reports | BE-12, BE-76 |
| Receivables by account and statements of account | Billing | BE-31, BE-48 |
| Hotel-wide boards: handoffs, disputes, the message inbox | second row | HW-02 |
| Editing a guest record, with its change trail | Guest record | BE-32 |
| Custodian names: every inquiry — new ones too — gets `staff-frontdesk-1` from the ownership rules, and no staff record has that id (staff ids are `STF-…`), so the custodian shows "—" everywhere | workspace header, preview, lists | config (`ownership.assignmentRules`) |
| A walk-in checked in in one governed act | the walk-in screen (not built) | BE-16 |
| An agent's record with its change trail, statements and outstanding by account | agent record, accounts (not built) | BE-31, BE-32, BE-48 |
| Requests, chits, tablet registration, voucher versions, a second confirmation channel, per-payer tax invoices | the step canvases (drawn inert, each naming its item) | BE-64, BE-68, BE-45, BE-42, BE-65, BE-41/43/69 |
| The bill's totals by category (rooms · food and drink · services) on the billing summary | Closed, "What the stay was" | BE-55 |

## Next passes

1. Replace the old tools still placed inside the canvases with native ones:
   - the composition planner
   - the room-by-night table
   - the guest table
   - the folio lines
   - the money blocks (interim, extension, split, advance, leaving early)

   They still show a few old words, such as "min threshold".
2. Build the second-row boards, the walk-in, the agent record and the accounts as their backend items land.
