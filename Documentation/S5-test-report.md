# S5 Acceptance Tests Report (Automated)

Generated: **2026-04-20**  
API base: `http://localhost:4000/api`

This report validates the implemented **Stage 5 (S5) — Pre‑Arrival / Pre‑Event** behaviors against key acceptance criteria listed in `SIG-S5-v1_0.md` (Section 10).  
We run tests by **hitting real HTTP routes** and asserting on status codes + error shapes, using freshly seeded data.

The raw machine output is saved as `Documentation/S5-test-output.json`.

---

## Test environment / setup

- **Backend**: `back_end` (Express + Prisma)
- **DB**: PostgreSQL
- **Seed reset**: `npm run db:seed` before each run
- **Auth headers**: all protected routes require:
  - `X-Actor-Id`
  - `X-Actor-Level` (`L1` for front desk, `L2` for FOM)

Actors used by the test runner:
- **L1**: `test-fd-1`
- **L2**: `test-fom-1`

Seeded primary entities (example run):
- **Primary S5 entry (LEISURE)**: created at `Entry.currentStage = S5`
- **Credit Tier‑2 entry (CORPORATE)**: created at `Entry.currentStage = S5` with `Reservation.creditCeilingIfExtended` and high `Folio.outstandingBalance`
- Rooms:
  - `501` clean room (assignable)
  - `502-DEF` (has an active unresolved `DeficientConditionRecord`)

---

## What we tested (by acceptance criteria)

### H1 handoff

- **AC-S5-013 — H1 acceptance enforces checklist completion**
  - **Route**: `POST /handoffs/:id/accept`
  - **Test**: send incomplete `checklistCompletion`
  - **Expected**: `409 PolicyGateBlockedError` with checklist blocking condition
  - **Result**: **PASS**

- **AC-S5-009 — H1 cannot fulfil from CREATED**
  - **Route**: `POST /handoffs/:id/fulfil`
  - **Test**: attempt fulfil on a newly created H1 in `CREATED`
  - **Expected**: `409 StateTransitionError`
  - **Result**: **PASS**

- **AC-S5-011 — S5→S6 blocked if H1 not FULFILLED**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S6"`
  - **Test**: attempt S5→S6 while H1 is only `ACCEPTED`
  - **Expected**: `409 StageGateBlockedError` with `blockingCondition = H1_NOT_FULFILLED`
  - **Result**: **PASS**

### Room assignment / DEFICIENT / maintenance rules

- **AC-S5-014 — DEFICIENT room requires acknowledgement**
  - **Route**: `POST /entries/:id/room-assignments`
  - **Test**: assign `502-DEF` without `deficientAcknowledgement`
  - **Expected**: `409 PolicyGateBlockedError` with `blockingCondition = DEFICIENT_ACKNOWLEDGEMENT_REQUIRED`
  - **Result**: **PASS**

- **AC-S5-016 — UNDER_MAINTENANCE room without expectedReadyAt blocked**
  - **Route**: `POST /entries/:id/room-assignments`
  - **Test**: create a room in `UNDER_MAINTENANCE` with `expectedReadyAt = null`, attempt assignment
  - **Expected**: `409 PolicyGateBlockedError` with `blockingCondition = UNDER_MAINTENANCE_WITHOUT_SCHEDULE`
  - **Result**: **PASS**

- **AC-S5-015 — DEFICIENT assignment preserves deficientConditionRecordId**
  - **Route**: `POST /entries/:id/room-assignments`
  - **Test**:
    - assign DEFICIENT room **with** acknowledgement payload (using L2)
    - mark the `DeficientConditionRecord` as resolved afterwards
    - verify `RoomAssignment.deficientConditionRecordId` remains unchanged
  - **Expected**: FK preserved
  - **Result**: **PASS**

### Pre-arrival tasks

- **AC-S5-019 — WAIVE requires waivedReason**
  - **Route**: `PATCH /pre-arrival-tasks/:id`
  - **Test**: `action = "WAIVE"` with no `waivedReason`
  - **Expected**: `409 PolicyGateBlockedError` with waiver blocking condition
  - **Result**: **PASS**

- **AC-S5-018 — S5→S6 blocked if any task is PENDING**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S6"`
  - **Test**: after H1 is FULFILLED + room assigned, attempt S5→S6 while at least 1 task remains PENDING
  - **Expected**: `409 StageGateBlockedError` with `blockingCondition = PRE_ARRIVAL_TASK_PENDING`
  - **Result**: **PASS**

### Normal exit (happy path)

- **AC-S5-023 — Complete normal exit path**
  - **Route**: `POST /entries/:id/progress-stage` with `targetStage = "S6"`
  - **Test**: satisfy all gates (H1 FULFILLED, room assignment valid, tasks complete, reconciliation ok, guest present)
  - **Expected**: `200` and `Entry.currentStage = S6`
  - **Result**: **PASS**

### Credit ceiling Tier‑2 gate

- **AC-S5-022 — Tier 2 (90%) blocks until FOM acknowledgement**
  - **Route**:
    - `POST /entries/:id/progress-stage` (`targetStage = "S6"`)
    - then `POST /entries/:id/credit-ceiling-tier2-ack` (L2)
    - then retry progress-stage
  - **Expected**:
    - first attempt: `409 StageGateBlockedError` with `blockingCondition = CREDIT_CEILING_TIER2_UNACKNOWLEDGED`
    - after ack: progress succeeds
  - **Result**: **PASS**

### No-show path (authority + cutoff + contacts + cap)

- **AC-S5-025 — No-show requires L2 authority**
  - **Route**: `POST /entries/:id/no-show`
  - **Test**: call as L1
  - **Expected**: `403 AuthorizationError`
  - **Result**: **PASS**

- **AC-S5-031 — No-show blocked if cutoff not reached**
  - **Route**: `POST /entries/:id/no-show`
  - **Test**: call as L2 but entry has no `noShowCutoffReachedAt`
  - **Expected**: `409 PolicyGateBlockedError` with `blockingCondition = CUTOFF_NOT_REACHED`
  - **Result**: **PASS**

- **AC-S5-026 — No-show requires at least one contact attempt**
  - **Route**: `POST /entries/:id/no-show`
  - **Test**: cutoff reached but `contactAttemptLog = []`
  - **Expected**: `409 PolicyGateBlockedError` with `blockingCondition = CONTACT_ATTEMPTS_REQUIRED`
  - **Result**: **PASS**

- **AC-S5-028 — No-show penalty capped at advance payment total**
  - **Route**: `POST /entries/:id/no-show`
  - **Test**: set cancellation penalty higher than advance payment, determine no-show
  - **Expected**: stored penalty \(\le\) total advance payments
  - **Result**: **PASS**

### Missing configuration behavior

- **AC-S5-036 — Missing `handoff.H1.checklist` blocks accept**
  - **Route**: `POST /handoffs/:id/accept`
  - **Test**: delete config row then attempt accept
  - **Expected**: `422 MissingConfigurationError`
  - **Result**: **PASS**

- **AC-S5-035 — Missing `noShow.cutoffWindowMinutes` blocks no-show**
  - **Route**: `POST /entries/:id/no-show`
  - **Test**: delete config row then attempt no-show (with cutoff marked reached)
  - **Expected**: `422 MissingConfigurationError`
  - **Result**: **PASS**

---

## Fixes applied while testing

These were required to match the SIG behavior for missing configuration:

- **Handoff acceptance now requires checklist config to exist**
  - File: `back_end/src/services/handoff-service.ts`
  - Change: if `ConfigurationEntry` is missing for `handoff.H1.checklist` / `handoff.H2.checklist` / `handoff.H3.checklist`, throw `MissingConfigurationError`.

- **No-show now requires `noShow.cutoffWindowMinutes` config**
  - File: `back_end/src/services/no-show-service.ts`
  - Change: if config key missing, throw `MissingConfigurationError` before proceeding.

---

## Not covered by this automated S5 run

The following SIG-S5 items are **out of scope for the current repo slice** and were not executed:

- **Workers & timers**: W4/W5/W23 idempotency and SLA behavior (requires pg-boss/timer engine and trace events).
- **Pricing pipeline “not invoked” proof**: we do not have a pricing engine in this slice to trace.
- **Folio charge posting rejection**: no “post charge” route exists in this slice yet, so AC-S5-010 is not directly testable via HTTP.
- **Atomicity rollback tests** (AC-S5-029): would require fault injection inside a DB transaction.

---

## How to re-run locally

From `back_end`:

```bash
npx prisma db push
npm run db:seed
npm run dev
npx tsx scripts/s5-acceptance-tests.ts > ..\\Documentation\\S5-test-output.json
```

