# S9 flowchart coverage vs automated tests

This report compares what we exercised in `Documentation/S9-test-report.md` against **`LEGPHEL_Implementation_Reference_v1_1.html` → Layer 03c (Deep‑Dives S7–S9) → S9 closure flow** (diagram block id `s9-deep`, labelled **3c.3 “S9 · Post‑Stay & Closure — operational flow”**).

## What the S9 tests actually cover (high-level)

From the S9 acceptance run we exercised the **standard departure population (from S8)** and then executed core S9 closure actions:

- **S7→S8→S9 setup**: `POST /night-audit/run` → `POST /entries/:id/progress-stage (S8)` → S8 checkout steps → `POST /entries/:id/progress-stage (S9)`
- **Invoices lifecycle**: DISPATCHED → PAYMENT_TRACKED → RECONCILED (`POST /invoices/:id/record-payment-event`)
- **Write-off**: OUTSTANDING → WRITTEN_OFF with mandatory reason (`POST /folios/:id/write-off`)
- **H5 fulfilment**: residual obligations cleared (`POST /handoffs/:id/fulfil`)
- **Loop closure enforcement**: `POST /entries/:id/close` blocked while H5 open, then succeeds after invariants satisfied

## Flow nodes / branches: Tested vs Not tested

### Entry populations (top of flow)

- **Tested**
  - **Standard departure from S8**: covered end-to-end by `S9-setup-*` + `AC-S9-045` + `AC-S9-011`.
- **Not tested**
  - **No-show from S5 (S9-equivalent)**: not exercised (requires `FolioState.NO_SHOW_CLOSED` path and S9-equivalent closure logic).
  - **Cancelled pre-arrival (S9-equivalent)**: not exercised (requires cancellation financial closure path).

### Parallel open-loop workstreams (box “PARALLEL · OPEN-LOOP WORKSTREAMS”)

- **Tested**
  - **INVOICES** (“CREATED → DISPATCHED → PAYMENT_TRACKED → RECONCILED”)
    - Covered by `S9-list-invoices`, `AC-S9-032-1`, `AC-S9-032-2`.
  - **OUTSTANDING** (governed balance)
    - Covered via S8 settlement into `Folio.state = OUTSTANDING` and then resolution via write-off (`S9-setup-settle-outstanding`, `AC-S9-041`).
  - **FEEDBACK / W28 timer registration**
    - **Partially covered**: closure registers W28 timer (implicitly via `AC-S9-011`), but we do **not** run a worker execution to confirm “two channels sent” behaviour.
  - **COMMISSION / W11**
    - **Not covered in tests** (we did not create an agent-mediated entry with commission configured or the RATE_MISSING/W11 path).
  - **DISPUTES**
    - **Not covered in tests** (no OPEN/IN_PROGRESS/REOPENED dispute created and verified as a closure blocker).
  - **POST-STAY CHARGES**
    - **Not covered in tests** (we did not call the post-stay charge endpoint nor validate `isPostStay=true` and “today” transaction date constraints).

### Decision: “Outstanding balance?”

- **Tested**
  - **→ WRITTEN_OFF** (GM authority + reason)
    - Covered by `AC-S9-039` (reason required) and `AC-S9-041` (successful write-off).
- **Not tested**
  - **→ SETTLED** (payment matched; invoice PAYMENT_TRACKED)
    - We did payment tracking on the invoice, but we did **not** drive a folio state transition to SETTLED at S9 (in this test run we chose the WRITTEN_OFF branch).
  - **remains OUTSTANDING with active W8**
    - Not exercised (requires leaving folio OUTSTANDING and asserting an active W8 follow-up timer exists while still allowing closure).

### Loop Closure Invariant (11 items in the flow box)

Below is each invariant line from the diagram, mapped to whether our automated test run demonstrated it.

- **① All invoices dispatched**: **Tested** (S8 settlement created DISPATCHED invoice; verified via `S9-list-invoices` + payment state transitions).
- **② All payments matched**: **Partially tested** (we transitioned invoice to PAYMENT_TRACKED; but we did not model an “unmatched payment received event” blocker case).
- **③ All disputes RESOLVED/CLOSED**: **Not tested** (no dispute created to block closure).
- **④ All post-stay charges posted**: **Not tested** (no post-stay charge posted).
- **⑤ Obligations settled OR OUTSTANDING with active W8 OR WRITTEN_OFF**: **Tested** (WRITTEN_OFF branch via `AC-S9-041`).
- **⑥ Feedback solicited both channels + W28 registered + SOLICITATION_SENT TraceEvent**: **Partially tested**
  - We register W28 on closure, but we do not execute W28 or assert two `CommunicationRecord` rows and the TraceEvent content.
- **⑦ CommissionDueRecord rules + RATE_MISSING/W11**: **Not tested**.
- **⑧ Conference/group FollowUpTaskRecord created**: **Partially tested**
  - The entry useType in the test is GROUP; closure should create `FollowUpTaskRecord`, but the test report does not yet include a DB verification step to assert it exists.
- **⑨ Government: PAYMENT_TRACKED minimum**: **Not tested** (not a government entry).
- **⑩ No-show advance payment disposition confirmed**: **Not tested**.
- **⑪ H5 fulfilled/closed + GuestDataRetention timer registered**: **Partially tested**
  - H5 fulfilment is explicitly tested (`AC-S9-046-setup`).
  - Guest data retention timer registration is part of closure implementation, but we do not assert the timer exists in DB in the acceptance report.

### Close + seal (EntryService.close “atomic seal”)

- **Tested (via `AC-S9-011`)**
  - EntryStatus ACTIVE → CLOSED, closedAt/closedBy populated.
  - Inventory claim released (room claim set to FREE in our implementation).
  - Timers registered at closure (W28 + retention) — covered as “happens during closure”, but not DB-asserted.
- **Not tested**
  - “FOLIO_SEALED / ENTRY_CLOSED TraceEvent” records (the current test harness does not assert trace events for S9).

### Forbidden-at-S9 panel

Only a subset is covered by automated tests today:

- **Tested**
  - **Write-off reason required**: `AC-S9-039`.
- **Not tested**
  - Close with dispute OPEN/IN_PROGRESS (needs dispute setup).
  - Backdate post-stay entry (needs post-stay charge test with a date inside stay window).
  - Auto-SETTLE balance while balance remains (needs negative test around folio settlement invariants).
  - Modify sealed folio lines / modify night audit (needs post-closure mutation attempts).
  - Commission without rate / close agent without commission (needs agent-mediated scenarios).

## Summary

- **Strong coverage** of the **standard departure path** and the core closure mechanics: invoice payment-state progression, write-off, H5 fulfilment, closure blocking and successful close.
- **Missing coverage** for the **two S9-equivalent entry populations** (no-show + cancellation) and for several loop-closure invariant branches (disputes blocking, post-stay charges, W8 governed-outstanding path, commission/W11, government-specific rule, worker executions like W28).

