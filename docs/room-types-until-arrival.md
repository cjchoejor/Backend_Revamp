# Room types until Arrival — the plan

**Status: a plan, not built yet.** Written 2026-10-28 for the operator to check before any of it is built.

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

Example with the 2 Premium Suites:
- booking A holds a suite on the 1st and 2nd;
- booking B holds one on the 2nd and 3rd;
- booking C wants one on the 1st, 2nd and 3rd.

The count says yes every night, but no single suite is free on all three nights. So C could only be fitted by changing rooms halfway.

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
