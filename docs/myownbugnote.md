number 8 mandatory in travel agent

we will add one more cancellation policy where they will stay in and then cancel said by boss.

night audit gi list chi lo, ani dhe hamago jamtsho lu dresh, what things are need like money, room bill check once.

stage 9 feedback no have, w28 gi dhen lu

for timer configs sir and madam will tell.

//////
Change the map for future lines — PATCH /folios/:id/billing-model-defaults. E.g., mid-stay agent says "we'll cover F&B too" → operator flips F_AND_B from GUEST_PAY to DIRECT_BILL in the map. Only affects charges posted after this call; existing lines keep their assignment.

///////////

That's a check that runs when the operator hits Save. It says: for group bookings, only DIRECT_BILL / TOUR_OPERATOR_VOUCHER can be saved by L1/L2; anything else (like GUEST_PAY) needs an L3 manager.

What my new suggestion does:

Group booking → dropdown pre-selects GUEST_PAY
What happens if a receptionist (L1) hits Save:

Backend throws: "Requires L3+ authority"
Operator confused: "You told me GUEST_PAY was the default, then blocked me from saving it?"
Two rules built at different times, both live, both fighting each other. You need to pick one:

Option A — trust your new rule (group → GUEST_PAY): delete the S3 authority gate so L1 can save GUEST_PAY for groups.

Option B — trust the old spec (group → agent-billed): keep the authority gate, revert my suggestion for groups.

You wrote "walk-in or group → GUEST_PAY" — that's option A. Say the word and I'll drop the gate.

//////////

folio issue, give bill is splited, guest pay gets the the subsubtotal good, but direct bill is zero.
also when new folio is added, it shows gst and services each time for gueest pay, instead of adding on top, also rate round off is being done too much for example, i added a folio line od 500, service charge is 10 percent which is 50, and gst is being shown as 28, instead of 27.5

oh direct bill is shown after night audit, but i think service change and gst is not showing, also the direct bill subtotal is showing 1909 when after night audit it was 1920

also in s8, say the bill is splitted into two, if i settle some amounts for guest pay, it doesn't give options later to settle for the other billing models
///
