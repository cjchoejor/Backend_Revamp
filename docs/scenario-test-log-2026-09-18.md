# Scenario testing — 18 September 2026

Every booking path the hotel can take, run through the new desk (`new_front_end`, port 3002) as a
person at the counter would, with the backend and database checked behind each step. Each fault
found was fixed, re-tested, and committed; this file is the record.

## How it was run

- **The desk, driven like a person.** A Puppeteer driver signs in with the real PINs (front desk
  `1111`, FOM `2222`, GM `3333`), opens the booking, reads the cards, fills fields by their labels
  and clicks buttons by their words. It records every toast, every failed API call (4xx/5xx) and
  every page error, and takes a screenshot at each stop.
- **The backend behind it.** After each step the booking is read back over the API (stage, folio
  lines, balances, timers, trace, communications) and compared with what the desk showed.
- **Test data.** Every test guest is named `ZZTest …` so it can be found and removed. The user's own
  booking ENT-20260918-0002 (rooms 501 and 504) was only ever read, never changed.
- **Database:** `legphel_pms_dev2`. **Clock:** the hotel's own day (18 Sep 2026, Bhutan time).

## Scenarios

| # | Scenario | Result |
|---|---|---|
| 1 | Walk-in, 1 adult, 1 night, arriving today (18 Sep): Inquiry → Negotiation (quote generated, not sent) → Set up (no advance, disclosure, committed hold) → Reserve (guest with no email; voucher answer taken by phone) → Arrival (room assigned, handoff, all tasks) → Check-in (first-time guest, CID, keys) → Stay (restaurant charge to the room, airport transfer to the booking, two corrections) → **left early the same day** (GM) → Check-out (key, inspection, cash settlement, tax invoice) → Closed (sealed by the FOM) | **Passes end to end** after fixes 3–14 |

## Issues found

Severity: **High** = blocks the desk or records something untrue · **Medium** = wrong figure or
misleading screen · **Low** = wording / cosmetic.

| # | Sev | Where | What was wrong | Fix |
|---|---|---|---|---|
| 1 | Low | Negotiation | "Valid for" hint on a same-day booking said the quote "ends before check-in → 18 Sep, 6:00 AM" (already past) and capped it at 1 day; the server gives the full window when check-in has passed. | The desk mirrors the server: check-in caps the window only while it is still ahead. |
| 2 | Medium | Reserve | For a guest with no email the voucher card showed the raw code `GUEST_HAS_NO_EMAIL` and a red "could not be sent — have the email settings fixed" box. Nothing had failed. | A missing address reads "No email on file — share the voucher at the desk or by phone"; the red box only shows for a real failure; `EMAIL_DISABLE` gets words too. |
| 3 | Medium | Every step | After "Move to …" the side panel kept the previous step's clocks for up to 30 s — e.g. "Arrival window opens · overdue" after Arrival had opened. | A move refreshes everything the steps read (timers, trace, papers, billing…). |
| 4 | High | Arrival (backend) | A same-day booking that reached Arrival after the hotel's check-in time was a **no-show candidate one second after it existed**: the cut-off (expected arrival + grace = 4 PM) had already passed at 6:26 PM, so W5 fired immediately and the FOM's No-show button unlocked. | The cut-off never falls inside the grace of the moment the clock is set (`noShowCutoffFor`) — a late same-day booking gets the grace from when it reaches Arrival. Bookings that open days ahead are untouched. |
| 5 | High | Check-in | The guest type defaulted to "Returning — ID valid" for every guest who was not VIP — the one path that needs no document — and the backend accepted any path the caller named. A first-time guest could be checked in with no ID. SIG-S6 §756: the path is "determined from guest profile". | New `resolveVerificationPaths`: returning paths need an ID on file from an earlier stay (and "valid" one that hasn't expired), VIP needs a VIP tier; others refused `VERIFICATION_PATH_NOT_ALLOWED`. The desk defaults to the server's suggested path and locks the rest with the reason. |
| 6 | Low | Check-in (backend) | The identity-verified trace always recorded the actor as L1. | Records the real level. |
| 7 | High | Stay / Check-out | Reading "has this night been audited" was FOM-only (403 for the front desk), so for a front-desk user the "Night audit complete" gate never turned green and **"Move to Check-out" stayed locked** however often the FOM ran the audit. | New L1 read `GET /night-audit/operating-date/:date/status` (the answer only; the full record with the hotel's lines stays FOM-only). An unaudited night answers `null`, not 404. |
| 8 | High | Arrival (backend) | Completing "Pre-arrival message to the guest" for a guest with **no email** recorded the message as DISPATCHED by email and opened a 24-hour "waiting for their answer" clock. Nothing was sent. | No address → nothing is recorded as sent (the skip is traced); the desk says the message has not gone out. |
| 9 | Low | Side panel | The kitchen's handoff clock was labelled "Housekeeping to accept" (H2 and H3 share one clock code). | The timers read carries what each clock is on; the desk names the kitchen's "Kitchen to accept". |
| 10 | High | Check-out | After an early departure the check-out step dated new charges on the **booked** check-out (19 Sep) — for a guest leaving on day 2 of 10 that is days after they left — and the backend accepted any future date. | The desk dates them on the effective check-out; the backend refuses a charge dated after the hotel's today. |
| 11 | Medium | Header | After a same-day early departure the header total read **Nu 0.00** ("shortened stay") while the guest owed Nu 3,696.00. | From Check-out on, the headline is the bill as it stands (billed so far). |
| 12 | High | Closed | Closing was refused — "Undispatched invoice blocks closure" — because the Set-up proforma had been generated but never sent, which the operator's generate-vs-send rule allows. **Every such booking was unsealable** unless the desk emailed the guest a stale proforma after they had left. | Only FINAL (tax) invoices must have gone out; the Closed step no longer offers "Send it" on a proforma or interim bill ("never sent — not needed after the stay"). |
| 13 | Low | Check-in | The "registration complete" tick was lost on a page reload (the key ticks already survive one). | Kept per booking until check-in records it. |
| 14 | Medium | Header (all steps) | A **closed** booking's preference could still be edited ("Edit" on the strip; the backend accepted it) — sealed records are read-only. | Refused once every booking on the inquiry is sealed (`ENTRY_SEALED_READ_ONLY`); the desk hides Edit on a sealed booking. |

### Noted, not changed

- **Invoice and voucher "sent" for a guest with no email.** The tax invoice and the confirmation
  voucher are recorded as dispatched even when no email went out. Unlike the pre-arrival message
  they are documents handed over in person, so "issued to the guest" still holds; the desk words it
  correctly now (issue 2).
- **"Quote valid" countdown keeps running after Reserve.** The quotation's validity clock is not
  stopped by the reservation (the billing summary already copes with a lapsed quote on a frozen
  booking). It shows on the side panel through Stay. Cosmetic; left for a decision.
- Small wording: "the 1 unstayed night are not billed"; the billing-model card says "The package to
  the account" at Arrival and "to the agent" at Stay; "Received Nu 0.00 of the min threshold Nu
  0.00" on a booking that asked for no advance.

## Not covered yet

(Filled in as the run proceeds.)
