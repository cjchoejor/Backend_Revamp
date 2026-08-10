## OPEN — W34 advance-payment follow-up timer (found 2026-07-31, not yet fixed)

Three separate problems. All verified against the live dev DB. Decide each one, then wire.

**1. With `advancePayment.thresholds = {"DEFAULT":{"amount":0}}` the timer never arms at all.**
Arming test in [s9-service.ts](../back_end/src/services/domain/s9-service.ts) is `totalIn >= requiredAmount`. Required is 0, so it is satisfied by a guest who has paid nothing, and the `if (!satisfied)` branch never runs. DB confirms: 6 W34 records ever, all `CANCELLED`, none scheduled or fired.
→ Decide: should the follow-up chase an _unpaid required deposit_ (today's meaning) or an _outstanding balance / promised-but-unpaid advance_? The second is what the hotel actually wants given thresholds are 0.

**2. Tier 2 (escalate to FOM) fires BEFORE tier 1 (follow-up).**
Tier 1 reads `registry.advancePaymentFollowUp.windowSeconds` = **86400s (24h)** — the registry override is ACTIVE and beats `advancePayment.followUpWindowSeconds` (3600s).
Tier 2 reads `advancePayment.escalationWindowSeconds` = **7200s (2h)** and has **no registry override**.
So escalation lands at 2h and the gentle nudge at 24h. The two values live on different admin pages (`/admin/policies` vs `/admin/financial`) so nothing warns when they cross.
→ Fix: give tier 2 a registry override too, and/or validate `escalation > followUp` on save.

**3. When it fires, nobody is notified.**
[w34-advance-payment-follow-up-worker.ts](../back_end/src/workers/w34-advance-payment-follow-up-worker.ts) only writes a TraceEvent — `ADVANCE_PAYMENT.FOLLOW_UP_SENT` / `ADVANCE_PAYMENT.ESCALATED_TO_FOM`. No email to the guest, no notification to the FOM, no task. Despite the names, nothing is sent. Contrast the S2–S9 stage emails, which genuinely dispatch via `dispatchStageEmailBestEffort`.
→ Fix: wire the guest email + an FOM notification on tier 2.

Config/policy locations: `/admin/financial` → `advancePayment.thresholds`, `advancePayment.followUpWindowSeconds`, `advancePayment.escalationWindowSeconds`. `/admin/policies` → `registry.advancePaymentFollowUp.windowSeconds`.

## FUTURE SCOPE — Stay packages (`PackageRegistry`) affect nothing (found 2026-08-04)

**Deferred deliberately — the user will look at this last.** Logged so it isn't rediscovered as a surprise.

`/admin/packages` ("Stay packages (inclusions)") manages `PackageRegistry`: a named bundle of inclusions plus a price adjustment. The one existing row is `Honeymoon Package` — inclusions "Welcome flowers" / "Candlelight dinner", `priceAdjustment` 1500, `isActive: false`.

**Nothing reads it.** `git grep` over `back_end/src` finds only its own admin CRUD and an entry in `TRACKED_ENTITY_TYPES` for version snapshots. No pricing, quotation, folio or invoice code consults it, so buying a stay package changes no bill. There is also no way for an operator to attach one to a booking — no field on Inquiry/Entry, nothing in the S1 or S2 surfaces.

Same shape as the walk-in flag below: a configuration surface that looks load-bearing and is not. Distinct from `RatePackage` — see the disambiguation table in CLAUDE.md:

| Concept | Belongs to | Holds | Answers |
|---|---|---|---|
| `RatePackage` | an agency or company | room + meal **rates** | "what does this agent pay?" |
| `PackageRegistry` | the hotel, offered to any guest | **inclusions** + price adjustment | "what extras did this guest buy?" |

→ When picked up: decide whether a stay package is selected at S1 (like the rate package) or added at S7 as a folio line, then wire `priceAdjustment` into the pricing path and surface the inclusions on the confirmation voucher. Until then, treat the page as a place to record intent, not something that bills.

## OPEN — "Set walk-in" on /admin/rate-plans is wired to nothing (found 2026-08-04)

The column writes the config key `availability.walkIn.ratePlanId`, and that key is read in exactly two places, both administrative:

- `getWalkInRatePlan` / `setWalkInRatePlan` in [rate-plan-admin-service.ts](../back_end/src/services/admin/rate-plan-admin-service.ts) — the endpoints behind the column
- a guard in the same file that refuses to deactivate whichever plan is currently flagged

**No pricing code reads it.** [`loadEligibleRatePlans`](../back_end/src/lib/load-eligible-rate-plans.ts) is the single source of rate plans for both the S1 indicative chip and S2 quotations; it loads every active plan, filters by `roomTypeId`, and lets the pricing engine choose by type priority (`INDIVIDUAL: 1` … `RACK: 5`). The walk-in key never enters that path.

So the flag currently means only "this plan cannot be deactivated". What actually prices a walk-in is the plan's **type** plus its **room-type binding** — which is why seeding the 10 per-type `INDIVIDUAL` plans changed walk-in pricing and marking a plan "walk-in" would not have.

→ Decide: **wire it** (e.g. use it as the fallback when no type-bound plan matches, instead of relying on RACK priority), or **remove the column**. Leaving a switch that looks like it sets the walk-in price but doesn't is the kind of thing that quietly misconfigures a property.

Left as-is deliberately on 2026-08-04 — logged rather than fixed, per the user.

## OPEN — no way to reopen a closed or cancelled booking (found 2026-07-31)

See the "reopen" analysis: `closeEntryAtS9` sets `status = CLOSED` and nothing anywhere sets it back; cancellation sets `status = CANCELLED` + `stage = TERMINAL` and there is no un-cancel. Post-stay CHARGES can still be posted after closure (the gate checks stage, not status) but PAYMENTS cannot (`recordPayment` requires `folio.state = PROVISIONAL`). That asymmetry means a late-discovered payment currently has no home.
→ Decide: a proper `reopenEntryAtS9` (L3/L4, audited, reversible) vs. leaving it and handling late money as an adjustment.

---
