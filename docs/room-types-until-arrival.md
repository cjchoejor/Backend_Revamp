# Room types until Arrival

**Status: all six stages built 2026-10-28 — see "Stage 1, as built" and "Stages 2–6, as built" below, with what is not built at the end of the second.** Written 2026-10-28 as a plan, then built the same day.

## In one paragraph

From Inquiry to Reserve, a booking holds **room types**, not room numbers — "2 Deluxe Double and 1 Standard Double, every night". Room numbers are chosen at **Arrival**: the system proposes them and the desk confirms or changes them. A guest who asks for one particular room gets that room **fixed** on the booking.

## The rulings (operator, 2026-10-28)

- A guest may ask for one particular room. It is fixed on the booking and kept when rooms are given out.
- When Arrival opens, the system proposes the room numbers and the desk confirms them.
- Bookings already at Negotiation, Set up or Reserve that have rooms keep those rooms, as fixed rooms. Nothing moves under anyone.
- A booking may still change type between nights (Deluxe on night 1, Standard on night 2).
- The chart: build the "room not chosen yet" look first, then look at it again.

## How it will work

### A booking's rooms are numbered, not named

A booking's rooms are **room 1, room 2, room 3**. Each has a type for each night. Everything the desk sets for a room belongs to "room 1", not to a room number:

- who sleeps in it;
- the meal plan and the extra beds;
- the negotiated rate;
- the bed setup (King, Twin …).

Example: a family books 2 Deluxe Doubles. Room 1 has 2 adults on MAP+D with an extra bed; room 2 has 1 adult on breakfast only. At this point neither is "Room 204" or "Room 305" — they are Deluxe Double room 1 and Deluxe Double room 2.

### Behind each booking room, a real room the system keeps quietly

The system still puts each booking room into a real room behind the scenes. That is what lets everything else keep working as it does today:

- the checks that stop two bookings sharing a room;
- holds and the reservation;
- the chart;
- the house's answer when the desk asks what is free.

Until Arrival the system may **move a booking room to another room of the same type** whenever that lets another booking fit. It does this quietly: no new pass, no new quotation, no new voucher, nothing sent to the guest. Nobody sees these numbers before Arrival, except fixed rooms.

This is what would have saved the booking blocked this afternoon: Room 203 was taken, but the question would only have been whether a Standard Double was free each night.

### One room for the whole stay

Counting free rooms night by night is not quite enough. The counts can fit every night and still leave a guest who would have to change rooms halfway through their stay.

Example with the 2 Premium Suites (503 and 504):
- booking A holds 503 on the 1st only, and the guest asked for 503;
- booking B holds 504 on the 2nd only, and the guest asked for 504;
- booking C wants one suite on the 1st and the 2nd.

The count says yes each night — one suite is free on the 1st (504) and one on the 2nd (503) — but it is not the same suite, so C could only be fitted by changing rooms halfway.

This happens only because A and B are fixed. Had the system chosen A's suite quietly, it would move A to 504, which is free on the 1st, and C gets 503 for both nights.

The rule: **the system takes a booking only if every guest can still be given one room for their whole stay** (or the change of type they asked for). This applies to the house's answer, the provisional block, the committed hold and Reserve.

- For a type whose rooms are all alike, with none fixed, this is always possible when the nightly counts fit, and the system just re-places the quiet rooms.
- Fixed rooms, a guest already in a room, or a room out of order on some nights can make it impossible. Then the system checks and says so in words before anything is held. It never splits a stay by itself.

### Your question: the meal plan set at Negotiation, the room changed at Arrival

Say at Negotiation, Deluxe Double room 1 gets 2 adults, MAP+D and an extra bed. The system quietly keeps it in 305. At Arrival the desk gives it 204 instead.

- **The setup moves with it.** The meal plan, the extra bed, the guests and the rate belong to room 1, so 204 carries them. The price does not change, because every room of a type has the type's rate.
- **No new pass.** Nothing about the booking changed except which Deluxe Double it is, so there is no walk back through Negotiation, no new quotation and no new voucher.
- **The bed setup follows too.** If room 1 asked for a King, 204 is made up as a King.
- **A room of another type** (a Suite instead of a Deluxe) is an upgrade or a downgrade, handled as a room change is today: the FOM's call, keeping the agreed price or re-pricing with the guest's agreement.

### A guest's own room

The desk can fix a booking room to one particular room ("they always want 305"):

- the system never moves it;
- it is checked like any booking today — refused in words if someone already has that room on those nights;
- the desk can **release** it again ("any Deluxe Double will do"), and the system goes back to choosing.

### Arrival

1. When Arrival opens, the system proposes a room for every booking room: its quiet room, or a better fit, with fixed rooms as they are.
2. The desk confirms, or picks another room. A room of the same type is the case above. A room of another type is a room change.
3. Once the rooms are confirmed, everything is as it is today: the guest-detail table by room, keys, check-in, the night audit, room moves.

### The chart

Before Arrival, a booking is drawn on its quiet room but marked **"room not chosen yet"** (lighter, with a dashed edge). A fixed room is drawn as it is today. A booking dragged onto another room of the same type before Arrival becomes **fixed** to that room — the desk chose it. To be looked at again once built.

### Papers

- Quotation and proforma: already name rooms by type (since 2026-10-28). No change.
- The confirmation voucher at Reserve: room types, or the fixed room where there is one. It prints room numbers today.
- The bills from the stay on (interim statement, master bill, tax invoice): room numbers, as today.

### What stays the same

- **Prices.** Rates are already per type.
- **Money.** Payments, the advance and refunds are unchanged.
- **From Arrival on**, everything is as today, and the bills from the stay on with it.

## Bookings already in the system

| Where the booking is | What happens |
|---|---|
| Inquiry | Its picked rooms become fixed rooms. The desk can release them to "any room of the type". |
| Negotiation · Set up · Reserve | Its rooms become fixed rooms (ruling). Nothing moves. |
| Arrival onward | Unchanged — the rooms are already given out. |

## How it will be built

In stages, each one checked on test bookings and with the money audit (`back_end/scripts/audit-money.ts`) before and after, before the next one starts:

1. **The engine.**
   - Booking rooms, each with a type per night, an optional fixed room and a quiet room.
   - The one-room-for-the-stay check, and the re-placing of quiet rooms.
   - The house's answer per type per night.
   - Bookings already in the system read as fixed rooms.
2. **Inquiry.** The desk picks types and how many per night, and can fix a particular room. The bill is per type.
3. **Negotiation.** The table's rows read "Deluxe Double · room 1". The quotation is priced per booking room.
4. **Set up and Reserve.** The holds and the reservation keep booking rooms, not numbers. Quiet rooms may still move until Arrival.
5. **Arrival.** The proposal; confirm; a change within a type in place; a change of type through today's room change.
6. **The rest.** The chart's "room not chosen yet", room moves on the chart before Arrival, the "another booking is working these rooms" box, the voucher.

### Stage 1, as built (2026-10-28)

Read-only. Nothing on the desk, the holds or the bills changed.

- **Booking rooms** — [back_end/src/lib/booking-rooms.ts](../back_end/src/lib/booking-rooms.ts). A booking room is `{key: "R1", nights: [{date, roomTypeId, roomId, fixed}]}`. It will live on the sealed pick (`optionSelected.bookingRooms`), beside the plain `perNight` list every reader uses today, which `sealFromBookingRooms` writes from it. `readBookingRooms` reads a seal written without booking rooms as fixed rooms: one booking room per distinct room, on the nights it appears. `bookingRoomRuns` cuts a booking room into the stretches that must each be one room (a change of type, a gap, or a change of fixed room starts a new one).
- **Placing stays** — [back_end/src/lib/room-placement.ts](../back_end/src/lib/room-placement.ts), pure, one room type at a time. Fixed stays are facts (two on one room-night, or one on a night the room is out of order, is reported, not refused). Movable stays each get one room for all their nights, trying their current room first, with backtracking and a step limit. `maxExtraStays` says how many more whole stays a type can take once the quiet ones are re-placed.
- **The house by type** — [back_end/src/services/domain/room-placement-service.ts](../back_end/src/services/domain/room-placement-service.ts) `answerHouseByType`, served at `POST /api/entries/:id/availability/by-type` (L1, no-store; body `{checkInDate?, checkOutDate?, bookingRooms?}`). The house is read through `buildRoomChart`, the asking booking's own claims left out. Every claim is fixed, except a booking before Arrival whose current seal carries booking rooms with a quiet room it holds on every night. The answer gives:
  - per type per night, the rooms usable, taken and free;
  - rooms free every night of the stay;
  - whole stays the type can still take with quiet rooms re-placed;
  - for the booking's rooms (its seal, or the ones sent), whether they fit, the room each would be in, the quiet rooms of other bookings that would move, and every refusal in words: "Room 503 is held for … (ENT-…) on 24 Aug", "Only 1 Premium Suite free on 24 Aug — 2 asked", "There is a Premium Suite free every night, but no one Premium Suite is free for all of room 1's stay (24 Aug → 26 Aug) …", nights outside the stay.
- **Verified**:
  - a rule matrix over the two modules, including 2,000 random houses with no fixed stays — always placed, never two stays in one room;
  - on `legphel_pms_dev2`, every live booking with a stay ahead: no quiet stays, each type's free rooms per night equal to the chart's once the booking's own rooms are given back, and the booking's rooms fitting exactly when the holds' conflict check finds nothing;
  - the example above built on 503 and 504 with throwaway bookings: refused while A and B are fixed, then — A's suite written as a quiet one — C fits by moving A from 503 to 504; A asking about itself stays in 503; the chart unchanged by asking;
  - the money audit at 0 critical. Test data removed.
- **Today no seal carries booking rooms**, so every answer is the chart's. Quiet rooms begin when stage 2 writes them.

### Stages 2–6, as built (2026-10-28)

**How the rooms are kept.** A booking picked by type carries its booking rooms on the sealed pick (`optionSelected.bookingRooms`), beside the plain per-night room list every other reader uses. Each booking room has a real room behind it on every night. A room is **quiet** — the system's choice, which it may move within its type — while the booking is at Inquiry to Arrival (S1–S5), has no rooms assigned yet, is not in a room move, and is active or parked. Everything else is **fixed**: a room the guest asked for, a room the desk gave, every room of a booking picked by number, and every booking from before today.

**A quiet move** ([quiet-rooms-service.ts](../back_end/src/services/domain/quiet-rooms-service.ts) `relabelEntryRoomsTx`, `applyQuietMoves`) swaps one room id for another, in one transaction, in that booking's pick, its provisional block, its committed hold, its live quotations of the pass (with the room's number inside their priced rooms), its bed plan and its carried-over setup. Traced `BOOKING_ROOMS.QUIET_MOVED`; the room flags are put right afterwards. No new pass, no new quotation, nothing sent. The reservation's frozen terms are not rewritten (reservations are immutable): the voucher names a by-type booking's rooms by type, so they do not show there, and the price is read from the quotation.

**When the rooms are placed**: on every save of a pick by type (`sealBookingRoomsByType`), before every provisional block and committed hold (`ensureQuietPlacement` — the room asked for is followed if it moved), and when the rooms are assigned at Arrival (placed, assigned, then fixed).

**2 Inquiry.** The house card asks how many rooms of each type, night by night (`RoomsByType` in [s1-by-type.tsx](../new_front_end/src/components/ds/steps/s1-by-type.tsx)):
- one row per type (33px), its count picked from a **dropdown**, never typed;
- in every box, first **how many of that type are free**, in words and coloured by what it means: green "6 free" — enough for the whole booking, amber "only 1 free" — some but fewer than the rooms asked, red "none free" (under Every night, the rooms free for the whole stay); the hover says it in full ("1 Suite free on 3 Oct — fewer than the 3 rooms this booking needs"). Then **take** and the dropdown. The words sit on the numbers, not in a key above the grid (operator: "the words on top is not something the user will see");
- a dropdown offers only counts that can stand: never more than the type has free that night, never more than the rooms the booking still needs that night, never fewer than a room kept for the guest. Once a night has all its rooms, the other types show a dash saying why ("23 Sep already has its 3 rooms — lower another type first");
- by default one dropdown per type, for every night; **Night by night** opens one per night, and the grid opens that way by itself when the nights already differ (**Same every night** folds it back once they agree);
- a type with nothing free on any night, and nothing asked of it, is named in one line under the grid instead of a row;
- a tally per night, "0 of 3 picked", red while short and green with a tick once complete;
- the pick checked by the server as it changes (`POST /api/entries/:id/availability/by-type/seal` with `preview`), refusals in words and other bookings it would move named. Only the answer for the counts on screen is shown: while the counts settle and the house is asked it reads "Checking…" (the previous answer, for other counts, used to flash for a moment — "29 Oct has 1 room" over a grid reading 3/3);
- then **Save the rooms** (green), and the page goes on to Wrap up.

When the stay's Done moves the work to the house, the house lands with its top just under the sticky head (`StepCard revealAtTop`), and is kept there while its answer arrives — it used to be centred while it was still asking, so it grew down the page with the stay still showing above it.

**Pick every room by number instead** leaves picking by type for the room-number table, where every room is chosen by hand and fixed. The table opens as a **pop-up over the left column only** (`WorkPopup` in [kit.tsx](../new_front_end/src/components/ds/steps/kit.tsx)): the work column is dimmed and blurred and holds still, the booking file on the right stays clear, and a room picked by hand opens its bill there (Charges › The price). Close, Escape or a press on the blurred page goes back to picking by type when nothing was saved by number; **Pick by room type instead** in its head does the same; saving closes it and goes on to Wrap up. The picker that added one room by number beside the types was taken off (operator: "I don't think it'll be used much"); a room kept for a guest earlier still shows as "Kept for the guest" and can be let go. "Offer what we have" (never possible) was taken off the house card.

**3 Negotiation.** A quiet room reads "Deluxe Double · room 1" in:
- the negotiation table and the guest board — the row, the room's tab, every message about it;
- the folded line, the marked rooms and the priced summary;
- the booking file's price rows (`GET /api/quotations/:id/price-lines`) and the live preview (`POST …/quotation-preview`).

Every room of a type is numbered in booking order, a guest's own room included (named by its number), so "room 2" stays "room 2" when another room is fixed. The money is unchanged: rates are per type, and the quotation's rows follow their room through a quiet move.

**4 Set up and Reserve.** The holds keep the quiet rooms and may still move them.
- The hold card reads "Deluxe Double · rooms 1, 2 blocked until …"; the booking header, Booking details and Reserve's facts name them the same way.
- On the Rooms tab a quiet room offers **Give it this room**: another room of its type, chosen in place and then fixed (`POST /api/entries/:id/booking-rooms/choose`, L1). Its list (`GET /api/entries/:id/booking-rooms/choices?fromRoomId=`, L1, `listQuietRoomChoices`) is every other room of the type with what giving it does — "free", "Pema Penjor moves to make way" (a room another booking holds only as the system's choice: that booking is moved to another room of the type, and the line under the list names the move), or why not ("held for … on these nights", out of order). It is refused in words for another type, a room someone holds for certain, or a fixed or assigned room.
- The room change beside it offers only **Another room type**, as today.
- The voucher prints "2 × Deluxe Double", and a room the guest asked for by its number.

**5 Arrival.** The rooms are the system's proposal, by number: "The system's rooms for this booking: Deluxe Double · room 1 — Room 204 · Deluxe Double · room 2 — Room 205", with **Confirm and assign the 2 rooms**. The assignment names what it handed out (`roomNumbers`), and when the house changed since the proposal was shown — another booking took one — it says which room the guest has instead (`movedSinceProposal`, "The system gave Room 207 instead of Room 205 (same type)"). A room can be given another of its type first, as at Set up; a change of type is the room change. Once assigned the rooms are fixed and everything is as before.

**6 The rest.**
- The chart draws a quiet room faded with a dashed edge, and its card says the room is not chosen yet.
- Dropping quiet rooms onto other rooms of their type on the same nights asks **Give Deluxe Double · room 2 Room 204?** — or, for several, **Give these rooms Room 206 and Room 305?** with a line per room — instead of opening a room move ([quiet-room-dialog.tsx](../new_front_end/src/components/ds/rooms/quiet-room-dialog.tsx)). A target another booking holds only as the system's choice is fine: the dialog says that booking is moved to another room of the type. The rooms are placed together (`chooseQuietRooms`, `{picks: [...]}` on the same route), so a booking's rooms moved along by one row work. Other dates, another type, or a room someone holds for certain still run the room move.
- The "another booking is working these rooms" box leaves out a clash the system settles by moving a quiet room, this booking's or another's. It asks the same check the holds run; when the booking does not fit, every clash stays.

**Reads**: `GET /api/entries/:id/booking-rooms` (L1) gives `byType`, `movable`, `atArrival`, and per room its label, its number within the type (`ordinal`) and whether it is quiet. The desk's `useBookingRooms(entry)` ([use-booking-rooms.ts](../new_front_end/src/hooks/use-booking-rooms.ts)) gives the labels before Arrival and the proposal at Arrival.

**Verified** on throwaway bookings on `legphel_pms_dev2`:
- over HTTP (17 checks):
  - the labels and their numbers;
  - the price rows and the live preview by type, the preview's total equal to the quotation's;
  - a booking holding a quiet room by number being no competition, while two held suites are still a clash;
  - the voucher's own text: "2 × Deluxe Double · 2 CP · 2 nights total";
  - a room given at Reserve: fixed, with the priced rooms, the hold, the price and the pass following;
  - the proposal at Arrival, its confirmation, and no quiet room afterwards;
- on the desk (22 checks):
  - Negotiation showing no room number of its rooms, on the step or in the file;
  - Set up's hold line;
  - the Rooms tab's choice, its toast, and the page staying put;
  - the chart's dashed bar, and the drop asking to give the room;
  - Reserve's names;
  - Arrival's proposal and confirmation;
  - no page errors;
- the earlier quiet-move test (17) and the Inquiry desk test (18) again;
- the money audit at 0 critical before and after; no room flag wrong. Test data removed.

**The walks keep the system's rooms (built 2026-10-28)**: a room change (including a change of type), a setup change, a seating repair, a date move, the rooms left after a split, and Change configuration at Negotiation now write the booking rooms on their new seal (`carryBookingRooms` in [lib/booking-rooms.ts](../back_end/src/lib/booking-rooms.ts), called by the room-change walk and `amendNegotiationConfiguration`). A room stays the system's choice when it was before and the change did not name it; a room the change brought in or named is fixed. Rooms keep their order, so "Deluxe Double · room 2" keeps its number.

**Verified** (2026-10-28) over HTTP on throwaway bookings (21 checks: the Negotiation change keeping the ticked room the system's and fixing the new one; a meal change at Set up keeping both rooms the system's, its seal carrying them; a change of type fixing the new room and keeping the other; Give it this room listing another booking's quiet room with the move named, taking it, that booking moved to another Deluxe Double and its hold following, the room then refused to others in words; two rooms given at once, one into the other's room; another type refused; a date move keeping the room the system's; Arrival naming the two rooms) and on the desk (12 checks: the key's words, no add-a-room picker and no Offer what we have, no refusal flashing once both nights read 3/3, the list's "ZZTest DeskC2 moves to make way" and the line naming the move, the room given; two quiet rooms dropped together on the chart asking "Give these rooms Room 206 and Room 305?" and given, fixed, no new pass; no page errors). Test data removed; no room flag wrong.

**Not built, said plainly**:
- A booking made from a split or a night move, and a booking combined into another, are picked by number (fixed rooms).
- The chart's "room not chosen yet" look is to be looked at again with the operator.
- A voucher already rendered is write-once and keeps its wording.

### For whoever builds it — where it lands

- **The room pick**: the sealed selection (`lib/option-selected-reader.ts`, `s1-availability-service.ts`) gains booking rooms; its per-night room ids become the quiet rooms.
- **The price table**: compositions are keyed by room today. That is the riskiest change, because it touches money:
  - backend: `lib/room-composition.ts`, `s2-quotation-service.ts`, `quotation-preview-service.ts`, `lib/quotation-price-lines.ts`, `lib/hydrate-room-assignment-composition.ts`;
  - desk: `room-compositions-table.tsx`.
- **Holds and inventory**: `s2-hold-service.ts`, `s3-hold-service.ts`, `lib/entry-inventory-claim.ts`. `lib/room-booking-conflicts.ts` stays per room and reads the quiet rooms.
- **The reservation**: `s4-confirmation-service.ts` freezes booking rooms; Arrival's assignment (`assignRoomsFromSealedPerNight`) turns them into rooms.
- **Beds**: `entry-bed-plan-service.ts` is keyed by booking room.
- **Chart and moves**: `room-chart-service.ts`, `room-chart.tsx`, `room-move-service.ts`, `date-move-service.ts`, `room-split-service.ts`, `night-move-service.ts`.
- **Desk**: `use-room-selection.ts`, `room-status-table.tsx`, `s5-rooms.tsx`, `identity-proof.tsx` (the guest table grouped by booking room before Arrival).

## Risks, said plainly

- **The bill.** The price table is keyed by room today. Re-keying it is where a figure could go wrong, so every stage re-reads every quotation and runs the money audit.
- **A quiet room moving while a screen is open.** The desk must never show a quiet room number as a promise before Arrival.
- **Arrival's proposal on a full house.** When fixed rooms, guests already in and rooms out of order leave no clean fit, the proposal must say so rather than guess.
