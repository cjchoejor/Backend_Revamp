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

## OPEN — no way to reopen a closed or cancelled booking (found 2026-07-31)

See the "reopen" analysis: `closeEntryAtS9` sets `status = CLOSED` and nothing anywhere sets it back; cancellation sets `status = CANCELLED` + `stage = TERMINAL` and there is no un-cancel. Post-stay CHARGES can still be posted after closure (the gate checks stage, not status) but PAYMENTS cannot (`recordPayment` requires `folio.state = PROVISIONAL`). That asymmetry means a late-discovered payment currently has no home.
→ Decide: a proper `reopenEntryAtS9` (L3/L4, audited, reversible) vs. leaving it and handling late money as an adjustment.

---
