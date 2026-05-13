# SIG-S5 v1.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S5-v1_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 02 schema, Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Generated:** 2026-05-12 (S5 alignment / matrix pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **SIG-S5 codebase matrix** (this document) | **DONE** | `Documentation_V2/SIG-S5-v1_0-codebase-matrix.md` |
| **Policy 28** — `reconcileAdvancePayments` + PAYMENT_RECONCILIATION task gate | **DONE** | `pre-arrival-service.ts` |
| **Policy 52** — `PRE_ARRIVAL_REMINDER` + `dispatchPreArrivalOutboundTx` + complete **PRE_ARRIVAL_COMMUNICATION** | **DONE** | `prisma/schema.prisma` (`CommunicationType`), `communication-service.ts`, `pre-arrival-service.ts` |
| **Policy 59** — `registerNightAuditTimers` + **W37** stay-night jobs | **DONE** | `pre-arrival-service.ts`, `w37-night-audit-stay-night-worker.ts`, `lib/timer-engine.ts`, `workers/runner.ts` |
| **Policy 67** — conference/group work-order todos before S5→S6 | **DONE** | `p67-s5-work-order-todos-complete-for-checkin.ts`, `entry-lifecycle-state-machine.ts` |
| **W1 at S5** — `scheduleS5StageDwellWarningMonitor` after **W4** | **DONE** | `lib/schedule-s5-dwell-warning-monitor.ts`, `w4-pre-arrival-window-activation-worker.ts` |
| Seed **S5** dwell thresholds + **nightAudit.schedule** | **DONE** | `prisma/seed.ts` |

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` (see **Session Findings** COR-001 for `NoShowDeterminationRecord` backfill status) |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (1, 5, 9, 28, 35, 44, 48, 52, 56, 57, 59, 63, 67, 69, 71) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` (see **COR-002** for derived routes) |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S5-heavy)

Per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html**, S5 artefacts map as follows (paths under `back_end/src/` unless noted).

| Atlas category | S5 artefacts in repo |
|----------------|----------------------|
| **Cat 02** | Prisma: `Entry`, `Reservation`, `HandoffRecord`, `PreArrivalTask`, `RoomAssignment`, `NoShowDeterminationRecord`, `Folio`, `StageDwellRecord`, `TimerRecord`, `TraceEvent`, `CreditCeilingThresholdEvent`, `Room`, `DeficientConditionRecord` |
| **Cat 03** | `state-machines/entry-lifecycle-state-machine.ts` — **`progressStageS5ToS6`** (SIG §1.5 normal exit guards); `state-machines/index.ts` re-exports |
| **Cat 05** | `engines/credit-ceiling-monitor-engine.ts` (minimal `evaluate` surface; S5 proximity logic also inlined in `pre-arrival-service.ts`); `engines/room-assignment-suggestion-engine.ts` (**W23** breach path); `lib/timer-engine.ts` job names (`*_W4`, `*_W5`, `*_W23`, `*_W37`, …) |
| **Cat 06** | `p01-*` (S5 room assignment, reservation snapshot for W4, physical readiness), `p05-h1-fulfilled-required-for-checkin.ts`, `p09-s5-normal-exit-pre-arrival-tasks-terminal.ts`, `p12-advance-payment/p28-s5-advance-payment-reconciliation-required.ts`, `p14-cancellation/*` + `p35-*` (S5 cancel), `p18-credit-extension-ceiling/p44-credit-ceiling-proximity-check.ts`, `p19-deficient-condition/p48-*`, `p22-no-show/p56-*`, `p25-handoff/p63-*`, `p27-work-order/p67-s5-work-order-todos-complete-for-checkin.ts`, `p06-guest-identity/p16-guest-physically-present-s5-to-s6.ts`, `p13-billing-model/p31-folio-provisional-required-s5-to-s6.ts` |
| **Cat 07 Domain** | `services/domain/pre-arrival-service.ts`, `services/domain/room-assignment-service.ts`, `services/domain/handoff-service.ts`, `services/domain/communication-service.ts` (`dispatchPreArrivalOutboundTx`), `services/application/no-show-service.ts`, `services/application/cancellation-service.ts` (`cancelEntryAtS5`), `services/domain/entry-service.ts` (façade re-exports) |
| **Cat 07 Application** | `services/application/no-show-service.ts`, `services/application/cancellation-service.ts` |
| **Cat 08** | `workers/w4-pre-arrival-window-activation-worker.ts`, `workers/w5-no-show-cutoff-worker.ts`, `workers/w23-room-readiness-sla-worker.ts`, `workers/w37-night-audit-stay-night-worker.ts`, `workers/w1-stage-dwell-monitor.ts` (generic per current stage + dwell record), `workers/runner.ts`; `lib/schedule-s5-dwell-warning-monitor.ts` |
| **Cat 10** | `routes/reservations/router.ts` (progress S5→S6, pre-arrival task patch, room assignment, credit ceiling Tier-2 ack); `routes/handoffs/router.ts` (H1 accept / fulfil); `routes/no-show/router.ts`; `routes/cancellations/router.ts` (S5 cancel) |
| **Cat 12** | `prisma/seed.ts` + `requireActiveConfigValue` keys used by S5 paths: e.g. `preArrival.windowDays`, `noShow.cutoffWindowMinutes`, `handoff.H1.checklist`, `creditCeiling.proximityThresholds`, `housekeeping.sla.readinessWindowMinutes`, `stageDwell.thresholds` (**S5** row), `nightAudit.schedule`, `handoff.H1.autoFulfil.enabled` |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts` (`progressStageRequestSchema`, `patchPreArrivalTaskRequestSchema`, `createRoomAssignmentRequestSchema`); `dtos/10-no-show/request-schemas.ts`; `dtos/09-cancellations/request-schemas.ts`; `dtos/11-handoffs/request-schemas.ts` |
| **Cat 15** | `middleware/auth.ts` — `requireActorLevel` on routes (L1 vs L2 for no-show / S5 cancel / Tier-2 ack) |

---

## 3. Policy inventory (SIG-S5 §4)

Legend: **OK** = primary path wired · **PARTIAL** = narrow slice or different layering vs full Part 5 narrative · **MISSING** = not found

| Policy | Role at S5 | Status | Primary implementation |
|--------|------------|--------|------------------------|
| **1** | Availability / room assignment | **PARTIAL** | `room-assignment-service.ts` + `p01-s5-room-assignment-eligibility-gates.ts`, `p01-assigned-room-physical-readiness-for-arrival.ts` — no separate `AvailabilityService` / dual-model query engine as in SIG narrative |
| **5** | H1 custodian transfer | **OK** | `handoff-service.acceptHandoff()` + `routes/handoffs/router.ts` |
| **9** | Pre-arrival window | **OK** | `w4-pre-arrival-window-activation-worker.ts` + `pre-arrival-service.initialiseTasks()` |
| **28** | Advance payment reconciliation | **PARTIAL/OK** | `pre-arrival-service.reconcileAdvancePayments()` on **PAYMENT_RECONCILIATION** task complete + `p28-s5-advance-payment-reconciliation-required.ts`; manual/FOM path remains `POST /folios/:id/advance-payment/reconcile` |
| **35** | Cancellation at S5 | **OK** | `cancellation-service.cancelEntryAtS5` + `routes/cancellations/router.ts` + `p35-*` |
| **44** | Credit ceiling proximity | **PARTIAL** | `pre-arrival-service.evaluateCreditCeiling()` + `CreditCeilingThresholdEvent` + `p44-credit-ceiling-proximity-check.ts` for S5→S6 Tier 2; `engines/credit-ceiling-monitor-engine.ts` is a thin synchronous helper, not full SIG `CreditCeilingResult` |
| **48** | DEFICIENT assignment | **OK** | `p48-deficient-room-assignment-decision.ts` + `room-assignment-service.assignRoom()` |
| **52** | Comm. acknowledgement | **PARTIAL/OK** | `dispatchPreArrivalOutboundTx` + **W22** when completing **PRE_ARRIVAL_COMMUNICATION**; `CommunicationType.PRE_ARRIVAL_REMINDER` |
| **56** | No-show determination | **PARTIAL** | `services/application/no-show-service.ts` + `p56-*` + `w5-no-show-cutoff-worker.ts` — defer / reactivate / cutoff paths partially implemented |
| **57** | No-show folio financial | **PARTIAL** | `w5` Sub-path 2b + `no-show-service` / folio updates — full S9-equivalent chain per SIG may be **PARTIAL** |
| **59** | Night audit timers at S5 | **PARTIAL/OK** | `pre-arrival-service.registerNightAuditTimers()` on **NIGHT_AUDIT_TIMER_REGISTRATION** task complete + **W37** (`NIGHT_AUDIT_STAY_NIGHT_W37`) per stay-night (informational); posting remains **W6** at S7 |
| **63** | Handoff lifecycle | **OK** | `handoff-service` accept / fulfil / reject + `p63-handoff-service-state-guards.ts` / `p63-handoff-lifecycle-gates.ts` |
| **67** | Work orders | **PARTIAL/OK** | `p67-s5-work-order-todos-complete-for-checkin.ts` on S5→S6 for **CONFERENCE** / **GROUP**; broader work-order lifecycle remains Part 6 depth |
| **69** | Session / PIN | **PARTIAL** | `middleware/auth.ts` |
| **71** | Processing lock TTL | **PARTIAL** | `p71-*` + `s1-processing-lock-service.ts` — not enumerated as S5 route pre-gate in SIG sense |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **CreditCeilingMonitorEngine** | **PARTIAL** | `engines/credit-ceiling-monitor-engine.ts` (advisory-only helper); Tier 1/2 behaviour largely in `pre-arrival-service.evaluateCreditCeiling` |
| **RoomAssignmentSuggestionEngine** | **PARTIAL** | `engines/room-assignment-suggestion-engine.ts` — invoked from **W23** on breach |
| **TimerEngine** | **PARTIAL** | `getTimerEngine`, `timer-management-service`; pg-boss names suffixed (`_W4`, `_W5`, `_W23`, `_W37`, …) vs SIG literals |
| **ReEntryConsequenceEngine** | **PARTIAL** | Re-entry paths (e.g. `reEnterS6ToS1`) live in `entry-lifecycle-state-machine.ts` — not exhaustively mapped here |
| **PricingPipelineEngine** | **N/A at S5** | SIG §5.5 — must not run at S5 (guard via architecture; no dedicated runtime assert in matrix) |

---

## 5. Services (SIG §6)

| SIG name | Status | Repo |
|----------|--------|------|
| **EntryService.progressStage (S5→S6)** | **PARTIAL/OK** | `entry-service.ts` → `progressStageS5ToS6` in `entry-lifecycle-state-machine.ts`; `routes/reservations/router.ts` |
| **HandoffService.accept / fulfil** | **OK** | `handoff-service.ts`, `routes/handoffs/router.ts` |
| **PreArrivalService** | **PARTIAL/OK** | `pre-arrival-service.ts` — `initialiseTasks`, `updatePreArrivalTask`, `evaluateCreditCeiling`, `acknowledgeCreditCeilingTier2`, **`reconcileAdvancePayments`**, **`registerNightAuditTimers`**, **`sendPreArrivalReminderOutbound`**, `listStayNightIsoDates` |
| **RoomAssignmentService.assignRoom** | **OK** | `room-assignment-service.ts`, `POST …/room-assignments` |
| **NoShowService.determineNoShow** | **PARTIAL** | `services/application/no-show-service.ts`, `routes/no-show/router.ts` |
| **CancellationService (S5)** | **OK** | `cancellation-service.cancelEntryAtS5` |
| **PaymentService** | **PARTIAL** | Payment / folio services used upstream; S5-specific `getPaymentStatus` surface not singled out here |

---

## 6. Workers & timers (SIG §7)

| Worker | Status | Notes |
|--------|--------|-------|
| **W1** | **PARTIAL/OK** | `w1-stage-dwell-monitor.ts` + **`schedule-s5-dwell-warning-monitor.ts`** scheduled from **W4** after S5 activation |
| **W4** | **OK** | `w4-pre-arrival-window-activation-worker.ts`; S4→S5 tx; seeds tasks; **`scheduleS5StageDwellWarningMonitor`**; schedules **W5**; optional H1 auto-accept |
| **W5** | **PARTIAL** | `w5-no-show-cutoff-worker.ts` — cutoff marker + Sub-path 2b auto path; full FOM-only determination matrix vs SIG |
| **W23** | **PARTIAL** | `w23-room-readiness-sla-worker.ts` + suggestions on breach |
| **W37** | **PARTIAL/OK** | `w37-night-audit-stay-night-worker.ts` — stay-night informational countdown (Policy **59** slice) |
| **W20** | **N/A** | Entry expiry — catalogue / other stages |
| **W34 cancel** | **OK** | Cancelled on S4→S5 in **W4** transaction (per SIG transfer of responsibility) |

Timer / job codes (representative): `PRE_ARRIVAL_COUNTDOWN_W4`, `NO_SHOW_CUTOFF_W5`, `AWAITING_WRITTEN_CONFIRMATION_W5`, `ROOM_READINESS_SLA_W23`, `NIGHT_AUDIT_STAY_NIGHT_W37`, `ACKNOWLEDGEMENT_WINDOW_W22`.

---

## 7. Routes (SIG §8)

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /handoffs/:id/accept` | **OK** | `routes/handoffs/router.ts` |
| `POST /handoffs/:id/fulfil` | **OK** | `routes/handoffs/router.ts` |
| `POST /entries/:id/room-assignments` | **OK** | `routes/reservations/router.ts` (SIG **COR-002** — derived route) |
| `PATCH /pre-arrival-tasks/:id` | **OK** | `routes/reservations/router.ts` (**COR-002**) |
| `POST /entries/:id/no-show` | **OK** | `routes/no-show/router.ts` |
| `POST /entries/:id/progress-stage` (target **S6**) | **OK** | `routes/reservations/router.ts` → `progressStageS5ToS6` |
| `POST /entries/:id/cancel` (S5, L2+) | **OK** | `routes/cancellations/router.ts` |
| `POST /entries/:id/credit-ceiling-tier2-ack` | **OK** | Extension for Policy 44 Tier 2 — `routes/reservations/router.ts` (L2) |

---

## 8. Configuration keys (SIG §9)

Blocking vs non-blocking per SIG §9.1–9.2: several keys are **read** via `requireActiveConfigValue` on the hot path; a formal **`S5_READINESS`** startup aggregate is **not** implemented as a named gate in code reviewed for this matrix.

**Observed in S5 flows:** `preArrival.windowDays`, `noShow.cutoffWindowMinutes`, `handoff.H1.checklist`, `acknowledgement.windowPerType` (incl. **`preArrival`** ack seconds), `preArrival.communicationTemplates` (optional `reminder` key), `creditCeiling.proximityThresholds`, `housekeeping.sla.readinessWindowMinutes` (room SLA), `stageDwell.thresholds` (incl. **S5**), `nightAudit.schedule`, `advancePayment.thresholds`, `handoff.H1.autoFulfil.enabled`, `ownership.s4.sameTeamAutoFulfilH1` (H1 seeding at S4/S5 edge).

**Follow-up seeding / enforcement:** SIG lists e.g. `roomAssignment.priorityRules`, `noShow.awaitingConfirmationWindowMinutes`, `noShow.penaltyStructure`, `deficientCondition.resolutionDeadlineHours`, `expiry.s5.noShowContactWindowMinutes` — verify presence in `prisma/seed.ts` and enforcement sites.

---

## 9. State machines (SIG §3)

| Machine | Status | Repo |
|---------|--------|------|
| **Entry S5 / S5→S6** | **PARTIAL/OK** | `entry-lifecycle-state-machine.progressStageS5ToS6` implements ordered guards aligned with SIG §1.5 / §8.6; **Policy 67** work-order todo gate for conference/group |
| **H1 CREATED→ACCEPTED→FULFILLED** | **OK** | `handoff-service` + policies |
| **No-show sub-states** | **PARTIAL** | `noShowCutoffReachedAt` on `Entry`, timers, `NoShowDeterminationRecord` — compare to SIG §3.2 |
| **Folio PROVISIONAL at S5** | **PARTIAL/OK** | `p31-folio-provisional-required-s5-to-s6.ts` on exit |

---

## 10. DTOs (Cat 13)

| DTO area | Repo |
|----------|------|
| Progress stage (incl. S5→S6, guest presence) | `dtos/06-reservations/request-schemas.ts` — `progressStageRequestSchema` |
| Pre-arrival task patch | `dtos/06-reservations/request-schemas.ts` — `patchPreArrivalTaskRequestSchema` |
| Room assignment | `dtos/06-reservations/request-schemas.ts` — `createRoomAssignmentRequestSchema`, `deficientAckSchema` |
| No-show determination | `dtos/10-no-show/request-schemas.ts` |
| S5 cancel | `dtos/09-cancellations/request-schemas.ts` — `cancelS5EntryRequestSchema` |
| Handoff accept / fulfil | `dtos/11-handoffs/request-schemas.ts` |

---

## 11. Acceptance criteria snapshot (SIG §10)

| ID | Theme | Status (codebase) |
|----|--------|-------------------|
| **AC-S5-001** – **006** | Schema / enums (`PreArrivalTask`, `RoomAssignment`, `NoShowDeterminationRecord`, folio no-show fields, `PreArrivalTaskType` nine values) | **PASS** — verify Prisma `schema.prisma` |
| **AC-S5-007** – **010**, **011** – **023** | State machine, H1, room, tasks, credit, S5→S6 | **PARTIAL** — core gates in `progressStageS5ToS6`; some flows need test harness |
| **AC-S5-024** | No pricing engine at S5 | **PARTIAL** — policy-by-construction; add trace/assertion if required |
| **AC-S5-025** – **031** | No-show authority, contact log, immutability, OTA, cutoff ordering | **PARTIAL** — see `no-show-service` + `w5` |
| **AC-S5-032** – **034** | W4 / W5 / W23 idempotency & breach behaviour | **PARTIAL** — W4 uses trace idempotency; confirm full AC coverage in tests |
| **AC-S5-035** – **037** | Config / IP boundary | **035–036:** exercise `requireActiveConfigValue` paths; **037:** SIG document meta |

---

## 12. Session findings (from SIG preamble)

| ID | Note |
|----|------|
| **SIG-S5-COR-001** | `NoShowDeterminationRecord` — confirm Part 2 / Prisma model parity with production schema policy |
| **SIG-S5-COR-002** | Room assignment & pre-arrival task routes documented in SIG as derived from Part 6 — implemented under **`routes/reservations/router.ts`**; Part 9 backfill still relevant for documentation alignment |

---

## 13. Follow-ups

- **Policy 28** — optional structured **reconciliation flag** rows (vs trace-only discrepancy) and L2-only override route distinct from folio reconcile.
- **Policy 52** — multi-touch **preArrival.communicationSchedule** (1-week / 1-day / day-of) not yet implemented; current slice dispatches on **PRE_ARRIVAL_COMMUNICATION** task completion.
- **Policy 59** — **W37** is informational; align naming with SIG “countdown” vs **W6** posting when tightening Part 8 catalogue.
- **Policy 67** — extend to **CATERING** / other use types if Canon requires; add explicit work-order seed linkage for E2E.
- **Prisma** — run **`npx prisma migrate dev`** (or **`db push`**) after pulling `CommunicationType.PRE_ARRIVAL_REMINDER`; if **`prisma generate`** hits `EPERM` on Windows, retry after closing processes locking `query_engine-windows.dll.node`.

---

## 14. Locked decisions (SIG § Deliberation)

| ID | Implementation note |
|----|---------------------|
| **D-SIG-S5-001** | Per SIG deliberation register — proceed; S3→X engine correction out of S5 scope |
