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
| New booking | `/bookings/new` | the existing intake (`/api/guest-profiles`, `/api/inquiries`, `/api/entries`, lookups) | Built (`components/ds/steps/new-inquiry.tsx`). The four Inquiry cards as a form, the house card and the gate bar ("Start the inquiry · keep the lead"). "Ask the house" keeps the lead, runs the search and opens the booking. Every rule of the old intake is kept, including `?edit=`. "Name to come from the agent" waits for BE-62. |
| Booking workspace | `/bookings/:id?step=N&view=details\|history` | `GET /api/entries/:id`, `…/billing-summary`, `…/payment-status`, `…/communications`, `…/timers`, `…/trace`, `…/identity-proofs` (at Check-in) | Built frame. **Header:** status, dates, rooms, source, custodian, total with its money breakdown. **Preference strip.** **Rail:** phases, the two boundaries, Re-enter, Park / Resume, Under the hood. **Tabs:** This step · Booking details (the three parties, the stay, the numbers, the thread, papers) · History ("As it stands", then every act in chapters by step, with lenses for Money, Papers, Requests, Changes, Approvals, Messages; read from `…/trace?limit=300` and `…/segments`). **Situation cards** above any step when they apply: parked, cancelled, no-show, passes and amendments, credit ceiling. **Side panel:** Timers · Recent (without the system's bookkeeping) · Papers sent, each with its answer, Record and Send again · The thread. **Gate bar:** the readiness list and one forward move, with Reserve, Check-in and Close behind their commit dialogs. **Step canvases:** built from the prototype's cards (see below). |
| Under the hood | `/bookings/:id/backend` | as before | The existing view, inside the frame. |
| Rooms | `/rooms` | `GET /api/rooms`, `GET /api/spaces`, deficiency routes | Built. Claim standing and physical state are shown separately, with each room's occupant. Halls and spaces are on the same page. A tile opens its fault record (the old desk's Spaces page is merged in here). |
| Billing | `/billing` | list + money | Built: open bills (in-house, check-out) and money still owed after a stay. There are no account totals (see gaps). |
| Shift | `/shift` | list + money + rooms | The paper form, in order. The outstanding bills and the room summary are real. The typed sections wait for a backend shift (see gaps). |
| Reports | `/reports` | list | Counts only: where the business comes from, inquiry to stay, demand lost, top agents. Occupancy and revenue wait for the backend (see gaps). |
| Guests | `/guests`, `/guests/:id` | `GET /api/guest-profiles?q=`, `GET /api/guest-profiles/:id`, `GET /api/desk/bookings?guestProfileId=` | Built. Search and the guest record with their bookings. The record is read-only. |
| Audit | `/audit` | `GET /api/desk/activity` (FOM and above) | Built. One hotel day, filtered by person or booking. The front desk sees why it is closed to them. |
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
| Inquiry | Who is asking · The guest · The stay · Rate and notes, with **The house** beside them (free rooms by type, the indicative price, Take it) · Which rooms | the room-by-night table and the guest board, behind "Choose the rooms…" |
| Negotiation | The rate, with its basis · Counter-offers (BE-39) · Who sleeps where, and their meals · Provisional block, or send the quote · Quotation · every version · competing claims | the composition planner (with its discount bar and rate strip), "Why this price" |
| Set up | The three parties · Billing model · The committed hold · The payment plan · Terms disclosed · Proforma · coordinator, milestones and free rooms when they apply | — |
| Reserve | Before: Before you reserve (signature rows with Fix) · Who receives the confirmation · Reserve · Everything chosen so far. After: What Reserve decided · Confirmation voucher · Pre-arrival tasks · The advance | the journey summary, the advance block |
| Arrival | Ready the room · Assign the rooms · Guest details · The front-desk handoff · Pre-arrival tasks · Advance and credit · the pre-arrival answer · Billing model | the per-room editors, the guest table, the advance block |
| Check-in | Before you check in · The document, at the desk · Registration card · the remaining advance · Rooms with their keys · Check in | the guest table, the per-room editors, the advance block |
| Stay | The folio · live · Post a charge (by outlet) · Chits waiting (BE-68) · The nights · Rooms in use · Keys · the departments · disputes · faults · a change to the terms · Billing model | the folio lines, interim payment, extension, split settlement, bills and statements, leaving early, the guest table |
| Check-out | Is the folio complete? · Master bill · Add or correct a charge · How the bill is settled · Tax invoice, by payer · The departure | the folio lines, split settlement |
| Closed | What the stay was · After the stay · One door back in · Sealed papers | the folio lines, split settlement |

"Frozen" means **reserved in this pass** (`reservedThisPass`). The quote readiness lines count only this pass's quotations, as the backend's gates do.

## Backend added for this frontend

All read-only, in `back_end/src/routes/desk/router.ts` and `services/domain/desk-read-service.ts`:

| Route | Level | What it gives |
|---|---|---|
| `GET /api/desk/bookings` | desk | Up to 500 bookings, newest first. Each carries names, booker, custodian, rooms, holds, quote state, the latest park reason and follow-up, interim-payment dues and running timers. No money. |
| `POST /api/desk/bookings/money` | desk | Each booking header's own billing summary, for up to 100 bookings in one call. |
| `GET /api/desk/staff` | desk | Staff names, for "who did it" lines. |
| `GET /api/desk/activity?date=` | FOM+ | One hotel day of the trace, newest first, with the actor's name. |

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
| Rooms sold per night ahead | Rooms | — |
| Custodian names: every inquiry — new ones too — gets `staff-frontdesk-1` from the ownership rules, and no staff record has that id (staff ids are `STF-…`), so the custodian shows "—" everywhere | workspace header, preview, lists | config (`ownership.assignmentRules`) |
| A walk-in checked in in one governed act | the walk-in screen (not built) | BE-16 |
| An agent's record with its change trail, statements and outstanding by account | agent record, accounts (not built) | BE-31, BE-32, BE-48 |
| Counter-offers, requests, chits, tablet registration, voucher versions, a second confirmation channel, per-payer tax invoices | the step canvases (drawn inert, each naming its item) | BE-39, BE-64, BE-68, BE-45, BE-42, BE-65, BE-41/43/69 |
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
