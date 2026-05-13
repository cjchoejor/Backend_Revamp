# SIG-S7 v1.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S7-v1_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 02 schema, Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Note:** SIG-S7 header marks **DRAFT — pending Architect review and lock**; this matrix inventories the repo as implemented, not locked Canon text.

**Generated:** 2026-05-12 (S7 alignment / matrix pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **SIG-S7 codebase matrix** (this document) | **DONE** | `Documentation_V2/SIG-S7-v1_0-codebase-matrix.md` |
| **S7 dwell** — `stageDwell.thresholds.S7` + schedule after S6→S7 | **DONE** | `prisma/seed.ts`, `lib/schedule-s7-dwell-warning-monitor.ts`, `check-in-service.ts` |
| **S7→S8 obligations surrogate** — unresolved `NightAuditAnomaly` for entry | **DONE** | `p60-unresolved-night-audit-anomalies-for-s7-to-s8.ts`, `entry-lifecycle-state-machine.ts` |
| **Disputes** — `POST /disputes`, `PATCH /disputes/:id`, close at **L3** | **DONE** | `routes/disputes/router.ts`, `s7-dispute-service.ts`, `dtos/12-disputes/request-schemas.ts` |
| **Night audit GET** | **DONE** | `GET /night-audit/operating-date/:operatingDate` — `routes/night-audit/router.ts`, `s7-night-audit-service.ts`, DTO param schema |
| **Dispute gate** — single engine path for S8 | **DONE** | `engines/dispute-gate-engine.ts` + `canProgressToS8` delegates |
| **Tax on charges** — optional `billing.salesTaxRate` | **DONE** | `s7-folio-lines-service.ts`, `prisma/seed.ts` |
| **Work order amend** — `POST /work-orders/:id/amend` | **DONE** | `s7-work-order-service.amendWorkOrder`, `routes/work-orders/router.ts`, `dtos/13-work-orders/request-schemas.ts` |
| **W27** — `DISPUTE_SLA_W27` on dispute open; cancel on close/resolve | **DONE** | `lib/schedule-dispute-sla-w27.ts`, `s7-dispute-service.ts`, `prisma/seed.ts` (`dispute.sla`) |
| **Operator naming (S7 vs S6 re-entry)** | **DONE** | Matrix **§15** table |

*The table in §0 lists new/changed modules in this alignment pass; the inventory below includes the full S7-related surface.*

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` (see **SIG-S7-COR-001** — `AmendmentEventRecord`; **implemented** in repo `prisma/schema.prisma`) |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (10, 21, 24, 32, 36, 45, 50, 52, 53, 54, 58, 60, 63, 66, 67; routes also cite 33, 55, 59) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S7-heavy)

Per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html**, S7 artefacts map as follows (paths under `back_end/src/` unless noted).

| Atlas category | S7 artefacts in repo |
|----------------|----------------------|
| **Cat 02** | Prisma: `Entry`, `Segment`, `Reservation`, `Folio`, `FolioLine`, `NightAuditRecord`, `NightAuditAnomaly`, `CreditCeilingThresholdEvent`, `DeficientConditionRecord`, `HandoffRecord` (H2/H3/H4), `Room`, `RoomAssignment`, `RoomClaimStateEvent`, `DisputeRecord`, `DisputeGateOverrideRecord`, `WorkOrder`, `WorkOrderToDoItem`, `WorkOrderConsumptionRecord`, `WorkOrderAmendmentEvent`, `AmendmentEventRecord`, `StageDwellRecord`, `TraceEvent`, `TimerRecord` |
| **Cat 03** | `state-machines/entry-lifecycle-state-machine.ts` — **`progressStageS7ToS8`** (S7→S8 exit; H4 same-day auto-path; DEFICIENT terminal at exit); **`reEnterS6ToS1`** (S6→S1; distinct from SIG **S7→S1** room-change narrative — see **§15**); `state-machines/s8-s9-state-machine.ts` (S8/S9); `state-machines/index.ts` re-exports |
| **Cat 05** | `engines/night-audit-engine.ts` (planner **stub**; real logic in `s7-night-audit-service.ts`); `engines/tax-engine.ts` — **`calculateTax`** used from `postCharge` when `billing.salesTaxRate` &gt; 0; `engines/credit-ceiling-monitor-engine.ts` (thin `evaluateCreditCeiling` helper); `engines/dispute-gate-engine.ts` (`canProgressStage` — **S7→S8** and **S8→S9**); `lib/timer-engine.ts` (**W6**, **W10**, **W12**, **W18**, **W21**, **W26**, **W27**, **W29**, **W32**, **W1**) |
| **Cat 06** | `p01-s7-exit-room-and-checkout-gates.ts`, `p01-entry-progression-stage-gates.ts`, `p13-billing-model/p31-folio-live-charge-and-night-audit-context.ts`, `p18-credit-extension-ceiling/p45-credit-ceiling-charge-posting-gate.ts`, `p19-deficient-condition/p51-deficient-final-status-before-s7-to-s8.ts`, `p21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`, `p24-night-audit/p60-unresolved-night-audit-anomalies-for-s7-to-s8.ts`, `p24-night-audit/p61-charge-date-not-sealed-by-complete-night-audit.ts`, `p24-night-audit/p61-night-audit-complete-before-s7-to-s8.ts`, `p25-handoff/p63-handoff-lifecycle-gates.ts` (H4 gate) |
| **Cat 07 Domain** | `services/domain/s7-folio-lines-service.ts` (`postCharge`, `correctCharge`, `postCreditNote`), `services/domain/s7-dispute-service.ts`, `lib/schedule-dispute-sla-w27.ts` (W27 registration), `services/domain/s7-work-order-service.ts`, `services/domain/handoff-service.ts` (`createH4`, …), `services/domain/entry-service.ts` (re-exports), `services/infrastructure/next-day-timer-service.ts` |
| **Cat 07 Application** | `services/application/s7-night-audit-service.ts` (`runNightAudit`), `services/application/s7-amendment-service.ts` (`createAmendmentEvent`, `roomChangeReEntryToS1`) |
| **Cat 08** | `workers/w1-stage-dwell-monitor.ts`, `workers/w6-night-audit-worker.ts`, `workers/w10-deficient-resolution-deadline-worker.ts`, `workers/w12-credit-ceiling-monitoring-worker.ts`, `workers/w18-ai-audit-supplement-worker.ts`, `workers/w21-payment-milestone-worker.ts`, `workers/w26-checkout-time-worker.ts`, `workers/w27-dispute-sla-worker.ts` (**`DISPUTE_SLA_W27`** jobs from dispute open), `workers/w29-equipment-return-worker.ts`, `workers/w32-fom-override-frequency-worker.ts`, `workers/runner.ts` |
| **Cat 10** | `routes/reservations/router.ts` (`POST …/progress-stage` **S7→S8**); `routes/folios/router.ts` (`POST /folios/:id/charges`, corrections, credit notes, payments, …); `routes/night-audit/router.ts` (`GET /night-audit/operating-date/:operatingDate`, `POST /night-audit/run`); `routes/amendments/router.ts` (`POST /entries/:id/amend`, `POST …/s7-room-change/re-enter-s1`); `routes/disputes/router.ts` (`POST /disputes`, `POST /disputes/open`, `PATCH /disputes/:id`, `…/close`, `…/gate-override`); `routes/handoffs/router.ts` (`POST /entries/:id/handoffs/h4`); `routes/work-orders/router.ts` (create, todos, consumption, **`POST /work-orders/:id/amend`**, close) |
| **Cat 12** | `prisma/seed.ts` + `requireActiveConfigValue`: e.g. `nightAudit.*`, `billing.salesTaxRate`, **`dispute.sla`** (W27), `creditCeiling.proximityThresholds`, `stageDwell.thresholds` (includes **S7**), `paymentMilestone.scheduleTemplates`, `handoff.H4.checklist`, … |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts` (`progressStageRequestSchema`, `version`); `dtos/07-folios/request-schemas.ts` (`postFolioChargesBodySchema`, corrections, …); `dtos/08-amendments/request-schemas.ts`; `dtos/12-disputes/request-schemas.ts`; `dtos/13-work-orders/request-schemas.ts`; `dtos/15-night-audit/request-schemas.ts` |
| **Cat 15** | `middleware/auth.js` — `requireActorLevel` on folio, night audit, amendments, disputes, handoffs, work orders |

---

## 3. Policy inventory (SIG-S7 §4.1)

Legend: **OK** = primary path wired · **PARTIAL** = narrow slice or different layering vs SIG · **MISSING** = not found

| Policy | Role at S7 | Status | Primary implementation |
|--------|------------|--------|------------------------|
| **10** | Checkout due / late checkout | **PARTIAL** | `workers/w26-checkout-time-worker.ts` + seed `property.checkoutTime` — full open-task / grace narrative vs SIG **PARTIAL** |
| **21** | Mid-stay rate amendment | **PARTIAL** | `s7-amendment-service.ts` + `routes/amendments/router.ts` — Path 3 / full `PricingPipelineEngine` re-run depth **PARTIAL** |
| **24** | Mid-stay discount | **PARTIAL** | Amendment event + authority fields in DTO/service slice — discount-specific Policy 24 depth **PARTIAL** |
| **32** | Billing model mid-stay | **PARTIAL** | Amendment / folio paths — dedicated `BillingModelTransitionRecord` flow per SIG **PARTIAL** |
| **36** | Early departure (GM) | **PARTIAL** | `cancelEntryEarlyDepartureAfterCheckIn` addresses post-check-in exit; SIG §8.7 dedicated early-departure route vs `POST /entries/:id/cancel-early-departure` alignment **PARTIAL** |
| **45** | Credit ceiling monitoring | **PARTIAL/OK** | `p45-credit-ceiling-charge-posting-gate.ts`, `s7-folio-lines-service.postCharge` (mandatory `ROOM_CHARGE` bypass, soft gate + L2 bypass flags), `CreditCeilingThresholdEvent` + **W12** schedule; full **CreditCeilingMonitorEngine** result model vs SIG **PARTIAL** |
| **50** | DEFICIENT resolution | **PARTIAL/OK** | `p51-*`, `w10-deficient-resolution-deadline-worker.ts`, S7→S8 exit updates `DEFICIENT_UNRESOLVED_AT_CHECKOUT` |
| **52** | Communication acknowledgement | **PARTIAL** | W22 patterns elsewhere; S7 amendment comm loops per SIG not fully enumerated |
| **53** | Active dispute management | **PARTIAL/OK** | `s7-dispute-service` open / progress / close / gate override; **`PATCH /disputes/:id`** |
| **54** | Dispute gate S7→S8 | **OK** | `dispute-gate-engine.canProgressStage` (S8) + **p54** + `s7-dispute-service.canProgressToS8` (delegates) + `POST /disputes/:id/gate-override` |
| **58** | Room change mode | **PARTIAL/OK** | `s7-amendment-service.roomChangeReEntryToS1` + `entry-lifecycle-state-machine.reEnterS6ToS1` / dedicated amend route — SIG **S7→S1** naming vs **S6→S1** re-entry in code **PARTIAL** |
| **60** | Night audit posting & completeness | **PARTIAL/OK** | `s7-night-audit-service.runNightAudit`, **W6**, `NightAuditAnomaly` for missing F&B expectation; **p60** blocks S7→S8 on unresolved anomalies for entry; **NightAuditEngine** pure planner **stub**; PARTIAL FOM escalation vs SIG narrative **PARTIAL** |
| **63** | Handoff lifecycle (H4) | **PARTIAL/OK** | `p63-handoff-lifecycle-gates.ts`, `handoff-service.createH4`, same-day H4 auto in `progressStageS7ToS8` |
| **66** | Group FOC / billing split | **PARTIAL** | Schema / `GroupBillingMode`; S7-specific enforcement slice not singled out |
| **67** | Work order lifecycle | **PARTIAL/OK** | `s7-work-order-service.amendWorkOrder` → **`WorkOrderAmendmentEvent`** + **`POST /work-orders/:id/amend`**; full SIG work-order engine depth **PARTIAL** |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **NightAuditEngine** | **PARTIAL** | `engines/night-audit-engine.ts` — stub `planNightAudit`; **`s7-night-audit-service.runNightAudit`** implements posting + anomalies |
| **TaxEngine** | **PARTIAL/OK** | `engines/tax-engine.ts` — **`calculateTax`** used from **`postCharge`** when `billing.salesTaxRate` &gt; 0 (extra **`OTHER`** tax line) |
| **CreditCeilingMonitorEngine** | **PARTIAL** | `engines/credit-ceiling-monitor-engine.ts` — minimal advisory helper; charge gating inlined in **p45** + `postCharge` |
| **DisputeGateEngine** | **OK** | `dispute-gate-engine.canProgressStage` — **S8** (override-aware) and **S9** (hard block); **`s7-dispute-service.canProgressToS8`** delegates for S7→S8 |
| **PricingPipelineEngine** | **PARTIAL** | Invoked on amendment Path 3 per SIG; repo amendment path depth varies — treat as **PARTIAL** |
| **ReEntryConsequenceEngine** | **PARTIAL** | SIG §3.3 — explicit engine module not found; consequences inlined in **amendment** / **reEntry** flows |

---

## 5. Services (SIG §6)

| SIG / narrative | Status | Repo |
|-----------------|--------|------|
| **FolioService.postCharge** | **PARTIAL/OK** | `s7-folio-lines-service.postCharge` + `POST /folios/:id/charges` (optional **`billing.salesTaxRate`** tax line) |
| **NightAuditService.runNightAudit** | **PARTIAL/OK** | `s7-night-audit-service.ts` — **`runNightAudit`**, **`getNightAuditRecordByOperatingDate`** |
| **AmendmentService** | **PARTIAL/OK** | `s7-amendment-service.ts` (`createAmendmentEvent`, `roomChangeReEntryToS1`) |
| **DisputeService** | **PARTIAL/OK** | `s7-dispute-service.ts` — open (**W27** timer registration via `schedule-dispute-sla-w27`) / progress / close (cancels W27) / gate override / `canProgressToS8` |
| **HandoffService (H4)** | **PARTIAL/OK** | `handoff-service.createH4`, `routes/handoffs/router.ts` |
| **EntryService.progressStage (S7→S8)** | **PARTIAL/OK** | `entry-service.ts` → `progressStageS7ToS8` |
| **WorkOrderService** | **PARTIAL/OK** | `s7-work-order-service.ts` — create / todos / consumption / **`amendWorkOrder`** / close |

---

## 6. Workers & timers (SIG §7)

| Worker | Status | Notes |
|--------|--------|-------|
| **W1** | **PARTIAL/OK** | `STAGE_DWELL_MONITOR` + **`scheduleS7StageDwellWarningMonitor`** after S6→S7; seed **`stageDwell.thresholds.S7`** |
| **W6** | **OK** | `w6-night-audit-worker.ts` → `runNightAudit` |
| **W10** | **PARTIAL/OK** | `w10-deficient-resolution-deadline-worker.ts` |
| **W12** | **PARTIAL/OK** | Scheduled from `postCharge` threshold writes + worker handler |
| **W18** | **PARTIAL** | `w18-ai-audit-supplement-worker.ts` — coupling to post–night-audit dispatch vs SIG **PARTIAL** |
| **W21** | **PARTIAL** | `w21-payment-milestone-worker.ts` |
| **W26** | **PARTIAL** | `w26-checkout-time-worker.ts` |
| **W27** | **PARTIAL/OK** | `w27-dispute-sla-worker.ts` + **`lib/schedule-dispute-sla-w27.ts`** registers **`DISPUTE_SLA_W27`** on open (`dispute.sla`); cancels on close/resolve — full SLA policy depth vs SIG **PARTIAL** |
| **W29** | **PARTIAL** | `w29-equipment-return-worker.ts` |
| **W32** | **PARTIAL/OK** | `gate-override` schedules `FOM_OVERRIDE_FREQUENCY_W32` (best-effort) |

---

## 7. Routes (SIG §8) — path deltas

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /entries/:id/progress-stage` (S7→S8) | **OK** | `routes/reservations/router.ts` — `targetStage: "S8"`; **`version`** required (Zod + service) |
| `POST /folios/:id/charges` | **OK** | `routes/folios/router.ts` — S7 live folio + S9 post-stay branch |
| `POST /night-audit/run` | **OK** | `routes/night-audit/router.ts` |
| `GET /night-audit/:date` | **PARTIAL/OK** | Implemented as **`GET /night-audit/operating-date/:operatingDate`** (YYYY-MM-DD) to avoid colliding with `…/run` |
| `POST /entries/:id/amend` | **OK** | `routes/amendments/router.ts` |
| `POST /disputes` | **OK** | `POST /disputes` and alias **`POST /disputes/open`** |
| `PATCH /disputes/:id` | **OK** | `progressDisputeRequestSchema` → `s7-dispute-service.progressDispute` |
| `POST /disputes/:id/close` | **OK** | **`requireActorLevel("L3")`** |
| `POST /disputes/:id/gate-override` | **OK** | **L3** + `createDisputeGateOverrideRequestSchema` |
| H4 initiation | **OK** | `POST /entries/:id/handoffs/h4` |
| Work order amend | **OK** | **`POST /work-orders/:id/amend`** → `WorkOrderAmendmentEvent` (`s7-work-order-service.amendWorkOrder`) |

---

## 8. S7→S8 exit guards vs SIG §1.3 / §3.2

| SIG exit condition | Status | Repo |
|--------------------|--------|------|
| Night audit complete for **final** stay night | **PARTIAL/OK** | `p61-night-audit-complete-before-s7-to-s8.ts` + lookup by **`operatingDate = checkoutDate − 1 day UTC`** |
| **All known charges posted** | **PARTIAL/OK** | **Surrogate:** `p60` — no **`NightAuditAnomaly`** with `entryId` and `resolvedAt: null`; literal “all charges” scan not implemented |
| H4 initiated (or same-day auto) | **PARTIAL/OK** | `p63-handoff-lifecycle-gates.ts` + auto-create branch in `progressStageS7ToS8` |
| DEFICIENT final status | **OK** | `p51-deficient-final-status-before-s7-to-s8.ts` + exit `updateMany` |
| Dispute gate | **OK** | `dispute-gate-engine.canProgressStage` (S8) + **p54**; `s7-dispute-service.canProgressToS8` delegates |
| Occupied room + checkout date | **OK** | `p01-s7-exit-room-and-checkout-gates.ts` |

---

## 9. Configuration keys (SIG §9)

SIG §9 lists dotted keys (`nightAudit.schedule`, `stageDwell.thresholds.s7.*`, `dispute.sla.*`, …). Repo uses nested `stageDwell.thresholds` JSON (**includes S7**), `billing.salesTaxRate`, and related keys in `prisma/seed.ts`.

---

## 10. State machines (SIG §3)

| Machine | Status | Repo |
|---------|--------|------|
| **(ACTIVE, S7)** steady state | **OK** | `Entry.currentStage = S7` after check-in completion |
| **S7→S8** | **PARTIAL/OK** | `progressStageS7ToS8` transaction |
| **S7→S1 room change** | **PARTIAL/OK** | `s7-amendment-service.roomChangeReEntryToS1` — **segment `sealedAt`** + new segment + **`OCCUPIED` → `DEPARTED_DIRTY`** on old room (`RoomClaimStateEvent`); compare with **`reEnterS6ToS1`** (S6 path) for naming/docs |
| **S8→S7** additional charge | **PARTIAL** | Not verified in this pass |
| **FolioLine immutability** | **OK** | Prisma create-only posting; `correctCharge` / offsetting patterns in `s7-folio-lines-service` |

---

## 11. DTOs (Cat 13)

| Area | Repo |
|------|------|
| Progress S8 | `dtos/06-reservations/request-schemas.ts` |
| Folio charges / corrections | `dtos/07-folios/request-schemas.ts` |
| Amendments | `dtos/08-amendments/request-schemas.ts` |
| Disputes | `dtos/12-disputes/request-schemas.ts` |
| Work orders | `dtos/13-work-orders/request-schemas.ts` (incl. **`amendWorkOrderRequestSchema`**) |
| Night audit run | `dtos/15-night-audit/request-schemas.ts` |

---

## 12. Acceptance criteria snapshot (SIG §10)

| ID range | Theme | Status (codebase) |
|----------|--------|---------------------|
| **AC-S7-01–03** | Folio line immutability / sealed dates | **PARTIAL/OK** — posting + `p61` seal gate; architectural “no UPDATE” is convention + Prisma usage |
| **AC-S7-04–07** | Night audit / anomalies / idempotency / timers | **PARTIAL** — core run + anomalies + `recalculateNextDayTimers`; FOM escalation / full engine split **PARTIAL** |
| **AC-S7-08–11** | Credit ceiling engine responses | **PARTIAL** — threshold events + W12 + posting gate; SIG-specific engine response enum **PARTIAL** |
| **AC-S7-12–16** | DEFICIENT / H4 | **PARTIAL/OK** |
| **AC-S7-17–19** | Dispute override | **PARTIAL/OK** — override record + S9 rejection in **p54** |
| **AC-S7-20–24** | Room change / re-entry engine | **PARTIAL** |
| **AC-S7-25** | Optimistic lock `version` | **OK** |
| **AC-S7-26** | W34/W35 not at S7 | **N/A** (convention check) |

---

## 13. Session findings (from SIG preamble)

| ID | Note |
|----|------|
| **SIG-S7-COR-001** | `AmendmentEventRecord` — SIG noted Part 2 gap; **repo has** `model AmendmentEventRecord` and `s7-amendment-service` / seed delete — treat COR as **addressed in codebase**; DEV-SPEC Part 2 backfill may still be desired for documentation parity |

---

## 14. Follow-ups

- **None** tracked here for SIG-S7 matrix vs current repo; deeper SIG gaps (e.g. Policy **10/21/24** full narratives) remain **PARTIAL** in inventory tables above.

---

## 15. Deliberation (SIG register)

| ID | Implementation note |
|----|---------------------|
| **SIG-S7-COR-001** | `AmendmentEventRecord` present in Prisma; SIG draft “absent” note superseded for implementation tracking |
| **D-S7-reentry** | `roomChangeReEntryToS1` seals prior segment and moves old room to **DEPARTED_DIRTY**; **`reEnterS6ToS1`** is the S6→S1 compressed path — keep docs distinct |

### Operator naming: which “re-entry” API?

| Operator intent | HTTP / code path | Stage movement |
|-----------------|------------------|----------------|
| Desk **cancel / re-open** before check-in completion (compressed path) | `reEnterS6ToS1` in `entry-lifecycle-state-machine` | **S6 → S1** |
| **Mid-stay room change** (SIG narrative often “S7→S1”) | `POST …/s7-room-change/re-enter-s1` → `roomChangeReEntryToS1` | New segment; prior segment sealed; old room **DEPARTED_DIRTY** |
| Normal in-stay progression | e.g. `POST …/progress-stage` **S7→S8** | **S7 → S8** |
