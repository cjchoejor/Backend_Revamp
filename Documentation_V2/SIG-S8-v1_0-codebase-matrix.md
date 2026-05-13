# SIG-S8 v1.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S8-v1_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **`BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`** (Cat 02 schema, Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Note:** SIG-S8 header is **LOCKED** (Architect, 15 April 2026). This matrix inventories the **repo as implemented**; gaps vs Canon are called out explicitly.

**Generated:** 2026-05-12 (S8 matrix pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **SIG-S8 codebase matrix** (this document) | **DONE** | `Documentation_V2/SIG-S8-v1_0-codebase-matrix.md` |
| **Settlement gates** — Policy **46** (credit ceiling FOM ack) + **61** (stay-night night-audit completeness + optional `nightAuditFomAcknowledgementRef`) + **22** (approved amendment chain; **ROOM_CHARGE** sum vs frozen when no amendments) | **DONE** | `policies/.../p46-*.ts`, `policies/.../p61-*.ts`, `policies/13-billing-model/p22-settlement-rate-basis.ts`, `services/domain/s8-settlement-service.ts`, `dtos/07-folios/request-schemas.ts` |
| **S8→S9 “unposted charges” surrogate** — **p62** COMPLETE-audit nights require **ROOM_CHARGE**; **F_AND_B** when `frozenInclusions.dailyFAndBExpected` | **DONE** | `policies/24-night-audit/p62-room-charge-present-for-complete-audit-s8-to-s9.ts` (`listStayChargeGapsForCompleteAuditStayNightsS8ToS9`), `lib/collect-s8-to-s9-read-failures.ts` |
| **S8→S9 multi-gate response** — **`StageGatesBlockedError`** with `details.failures[]` | **DONE** | `lib/errors.ts`, `lib/collect-s8-to-s9-read-failures.ts`, `state-machines/s8-s9-state-machine.ts` |
| **S8→S9** — optimistic lock **`StateTransitionError`**, unresolved night-audit anomaly gate, **W8** when folio **OUTSTANDING** | **DONE** | `state-machines/s8-s9-state-machine.ts`, `policies/.../p60-unresolved-night-audit-anomalies-for-s7-to-s8.ts` (`enforceNoUnresolvedNightAuditAnomaliesForS8ToS9`), `lib/schedule-payment-followup-w8.ts`, `services/domain/s9-service.ts` (refactor to shared scheduler) |
| **HTTP** — key return + room inspection on **`entries`**, **`GET /disputes/:id`** | **DONE** | `routes/entries/router.ts`, `dtos/03-entries/request-schemas.ts`, `routes/disputes/router.ts`, `services/domain/s7-dispute-service.ts` (`getDispute`) |
| **S8 re-entry** — **`progress-stage`** `S8→S7` / `S8→S2` (L2+ for S2), **`CHECKOUT_TIME_W26`** cancel, consequences trace, H4 reopen, segment on S2 | **DONE** | `services/domain/s8-re-entry-service.ts`, `lib/cancel-entry-timers-by-code.ts`, `engines/re-entry-consequence-engine.ts`, `routes/reservations/router.ts`, `dtos/06-reservations/request-schemas.ts` (`transitionData.reEntryReason`), `services/domain/entry-service.ts` re-exports |

**Remaining vs SIG (not in this pass):** fuller “all charge types / provisional ledger” unposted scan beyond **p62**; structured amendment **rate deltas** (numeric reconciliation when amendments exist); optional UX polish (e.g. stable ordering of **`details.failures`**).

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` (see **SIG-S8-COR-001/002** — `RoomInspectionRecord`, `KeyReturnRecord`; **implemented** in repo `prisma/schema.prisma`) |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (22, 33, 36, 46, 51, 54, 61, 63, 66; actors cite 10, 52) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S8-heavy)

Per **`BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`**, S8 artefacts map as follows (paths under `back_end/src/` unless noted).

| Atlas category | S8 artefacts in repo |
|----------------|----------------------|
| **Cat 02** | Prisma: `Entry`, `Folio` (`LIVE` / `SETTLED` / `OUTSTANDING`), `FolioLine`, `PaymentRecord`, `Invoice`, `HandoffRecord` (H4/H5), `Room`, `RoomAssignment`, `RoomClaimStateEvent`, `KeyReturnRecord`, `RoomInspectionRecord`, `DeficientConditionRecord`, `DisputeRecord`, `DisputeGateOverrideRecord`, `StageDwellRecord`, `TraceEvent`, `TimerRecord` |
| **Cat 03** | `state-machines/s8-s9-state-machine.ts` — **`progressStageS8ToS9`** (folio terminal, keys, room **DEPARTED_DIRTY**, inspection, H4/H5, dispute gate, night-audit anomaly gate, **p62** room-charge surrogate, **W8** if **OUTSTANDING**); `state-machines/entry-lifecycle-state-machine.ts` — **`progressStageS7ToS8`**; `state-machines/index.ts` re-exports |
| **Cat 05** | `engines/dispute-gate-engine.ts` (**S8→S9** `BLOCKED` on open disputes; **S7→S8** override path); `engines/tax-engine.ts` (used from **`s7-folio-lines-service.postCharge`** for in-stay/final-morning lines — same posting path at S8); `engines/credit-ceiling-monitor-engine.ts` (monitoring slice; settlement ceiling enforcement is **`p46`** in **`initiateSettlement`**); `engines/re-entry-consequence-engine.ts` (**`REENTRY.CONSEQUENCES_COMPUTED`** for S8→S7 / S8→S2); `lib/timer-engine.ts` (**W9**, **W24**, **W26**, **W27**, **W32** queue names); `lib/cancel-entry-timers-by-code.ts`; `lib/schedule-payment-followup-w8.ts` |
| **Cat 06** | `p01-entry-at-s8-for-checkout-progression.ts`, `p01-s8-checkout-room-occupied-gate.ts`, `p01-s8-to-s9-room-and-keys-gates.ts`, `p13-billing-model/p22-settlement-rate-basis.ts`, `p13-billing-model/p31-folio-live-required-for-s8-settlement.ts`, `p13-billing-model/p33-folio-state-allows-s8-to-s9-progression.ts`, `p13-billing-model/p33-billing-model-confirmation-match.ts`, `p13-billing-model/p33-billing-model-settlement-method-compatibility.ts`, `p13-billing-model/p46-credit-ceiling-final-settlement.ts`, `p19-deficient-condition/p51-deficient-inspection-review.ts`, `p19-deficient-condition/p51-room-inspection-exists-for-s8-to-s9.ts`, `p21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`, `p24-night-audit/p60-unresolved-night-audit-anomalies-for-s7-to-s8.ts` (incl. **S8→S9** gate), `p24-night-audit/p61-night-audits-complete-for-stay-before-settlement.ts`, `p24-night-audit/p62-room-charge-present-for-complete-audit-s8-to-s9.ts`, `p25-handoff/p63-handoff-lifecycle-gates.ts` |
| **Cat 07 Domain** | `services/domain/s8-checkout-service.ts` (`recordKeyReturn`, `recordInspection`, `completeCheckoutPhysicalDeparture`, H4/H5 helpers, dispute gate helper); `services/domain/s8-settlement-service.ts` (`initiateSettlement`, `getFolio`); `services/domain/s8-re-entry-service.ts` (**`reEnterS8ToS7`**, **`reEnterS8ToS2`**); `services/domain/s7-folio-lines-service.ts` (charges at S8 via folio route); `services/domain/handoff-service.ts` (`fulfilHandoff`, `createH4`, …); `services/domain/s7-dispute-service.ts` (lifecycle + W27 timers + **`getDispute`**); `services/domain/entry-service.ts` (re-exports stage helpers + S8 re-entry) |
| **Cat 07 Application** | (none S8-exclusive; night audit run remains **`s7-night-audit-service`**) |
| **Cat 08** | `workers/w9-post-checkout-inspection-worker.ts`, `workers/w24-housekeeping-sla-worker.ts`, `workers/w26-checkout-time-worker.ts`, `workers/w27-dispute-sla-worker.ts`, `workers/w32-fom-override-frequency-worker.ts` (wrapper) + `workers/w33-fom-override-frequency-worker.ts` (implementation; SIG **W33** numbering), `workers/w8-payment-follow-up-worker.ts` (**`PAYMENT_FOLLOW_UP_W8`** from **S8→S9** when folio **OUTSTANDING** + idempotent schedule at **S9 closure**), `workers/runner.ts` |
| **Cat 10** | `routes/reservations/router.ts` — **`POST /entries/:id/progress-stage`** (S9, **S8→S7**, **S8→S2**); `routes/entries/router.ts` — **`POST /.../key-return`**, **`POST /.../room-inspection`**; `routes/folios/router.ts` — **`POST /folios/:id/settle`**, **`GET /folios/:id`**, charges/corrections/invoices; `routes/handoffs/router.ts` — **`POST /handoffs/:id/fulfil`**, **`POST /entries/:id/handoffs/h4`**; `routes/disputes/router.ts` — **`GET /disputes/:id`**, open / progress / close / gate-override |
| **Cat 12** | `prisma/seed.ts` + `requireActiveConfigValue`: `housekeeping.sla.windowMinutes`, `inspection.postCheckout.windowDays`, `property.checkoutTime`, `invoice.templates.final`, `handoff.H4.checklist`, `handoff.H5.checklist`, `billingModel.availablePerSource`, `fomOverride.frequency`, `dispute.sla`, … |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts` (`progressStageRequestSchema`, `transitionData.reEntryReason`); `dtos/07-folios/request-schemas.ts` (`initiateSettlementRequestSchema`, **`nightAuditFomAcknowledgementRef`**, …); `dtos/03-entries/request-schemas.ts` (**`recordKeyReturnRequestSchema`**, **`recordRoomInspectionRequestSchema`**); `dtos/11-handoffs/request-schemas.ts` (`fulfilHandoffRequestSchema`, …); `dtos/12-disputes/request-schemas.ts` |
| **Cat 15** | `middleware/auth.js` — `requireActorLevel` on reservations, folios, handoffs, disputes |

---

## 3. Policy inventory (SIG-S8 §4.1)

Legend: **OK** = primary path wired · **PARTIAL** = narrow slice or different layering vs SIG · **MISSING** = not found in repo for S8

| Policy | Role at S8 | Status | Primary implementation |
|--------|------------|--------|------------------------|
| **10** | Checkout due / late checkout | **PARTIAL** | `workers/w26-checkout-time-worker.ts` + `property.checkoutTime` / grace seed — full open-task narrative **PARTIAL** |
| **22** | Settlement rate | **PARTIAL/OK** | **`p22-settlement-rate-basis.ts`** + **`initiateSettlement`** — approved amendment chain (`authorisedBy` / `authorityBasis`); when **no** amendments, **ROOM_CHARGE** sum for stay nights vs `frozenRate × nights` within **2%** tolerance |
| **33** | Billing model settlement | **PARTIAL/OK** | `p33-billing-model-*`, `s8-settlement-service.initiateSettlement` — guest pay / direct bill / voucher branches + **`p33-folio-state-allows-s8-to-s9-progression`**; auto-SETTLED with unresolved balance guard **OK** for governed path; full Policy 33 depth **PARTIAL** |
| **36** | Early departure | **PARTIAL** | Compressed S7→S8 path in **`progressStageS7ToS8`**; S8 settlement-specific early-departure **PARTIAL** |
| **46** | Credit ceiling final balance | **OK** | **`p46-credit-ceiling-final-settlement.ts`** + **`initiateSettlement`** (`fomAcknowledgementRef` / prior tier-2 ack on **`Entry`**) |
| **51** | DEFICIENT inspection review | **PARTIAL/OK** | `p51-deficient-inspection-review.ts` + **`recordInspection`**; **`p51-room-inspection-exists-for-s8-to-s9`**; `DeficientConditionRecord.finalStatus` writes at S7→S8 exit in **`entry-lifecycle-state-machine`** — full checkout **`CheckOutService.checkOut()`** bundle vs split services **PARTIAL** |
| **54** | Dispute gate | **OK** | `dispute-gate-engine.canProgressStage` + **`enforceDisputeGateClearForS8ToS9`**; **`p54`** S9 override rejection |
| **61** | Night audit overdue at checkout | **PARTIAL/OK** | **`p61`** + **`findIncompleteStayNightAuditDatesUtc`** in **`initiateSettlement`** (optional **`nightAuditFomAcknowledgementRef`**); **S8→S9** adds unresolved **night-audit anomaly** gate (**`enforceNoUnresolvedNightAuditAnomaliesForS8ToS9`**); “unposted charges” scan still **MISSING** |
| **63** | Handoff lifecycle (H4/H5) | **PARTIAL/OK** | **`p63-handoff-lifecycle-gates`**, **`handoff-service.fulfilHandoff`**, **`buildOrAutoFulfilH5`** — H4 evidence depth vs SIG §10.6 **PARTIAL** |
| **66** | Group FOC / billing split | **PARTIAL** | Schema / group modes; S8 settlement reconciliation **PARTIAL** |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **DisputeGateEngine** | **OK** | `engines/dispute-gate-engine.ts` — S9 path **`BLOCKED`** without override; aligns with SIG §3.3 |
| **TaxEngine** | **PARTIAL/OK** | `engines/tax-engine.ts` — used from **`s7-folio-lines-service.postCharge`** when `billing.salesTaxRate` &gt; 0 (charges at S8 use same route) |
| **CreditCeilingMonitorEngine** | **PARTIAL** | `engines/credit-ceiling-monitor-engine.ts` — operational monitor; **final balance** ceiling enforcement is **`p46`** in **`initiateSettlement`** |
| **ReEntryConsequenceEngine** | **PARTIAL/OK** | `engines/re-entry-consequence-engine.ts` — trace + consequence tags; **`s8-re-entry-service`** performs H4 reopen, dwell, segment (S2), timer cancel **`CHECKOUT_TIME_W26`** |

---

## 5. Services (SIG §6)

| SIG / narrative | Status | Repo |
|-----------------|--------|------|
| **CheckOutService** (SIG) | **PARTIAL** | Responsibilities split: **`s8-checkout-service.ts`** (keys, inspection, physical departure, H4/H5 helpers) + **`s8-settlement-service.initiateSettlement`** (folio + payments + invoice + calls **`completeCheckoutPhysicalDeparture`**) + **`progressStageS8ToS9`** (stage write) |
| **FolioService.initiateSettlement** | **PARTIAL/OK** | `s8-settlement-service.ts` — **`POST /folios/:id/settle`** |
| **EntryService.progressStage (S8→S9)** | **PARTIAL/OK** | `routes/reservations/router.ts` → **`progressStageS8ToS9`**; version mismatch → **`StateTransitionError`** / **`OPTIMISTIC_LOCK_VERSION_MISMATCH`** |
| **HandoffService.fulfil / create** | **PARTIAL/OK** | `handoff-service.ts` + **`POST /handoffs/:id/fulfil`** |
| **DisputeService** | **PARTIAL/OK** | `s7-dispute-service.ts` + disputes router (**`GET /disputes/:id`**, progress, close) |

---

## 6. Workers & timers (SIG §7)

| Worker | SIG id | Status | Repo / notes |
|--------|--------|--------|--------------|
| **Post-checkout inspection** | W9 | **PARTIAL/OK** | `w9-post-checkout-inspection-worker.ts`; **`POST_CHECKOUT_INSPECTION_W9`** scheduled from **`recordInspection`** when `isDeferred`; timer code **`POST_CHECKOUT_INSPECTION_W9`** |
| **Housekeeping SLA** | W24 | **PARTIAL/OK** | `w24-housekeeping-sla-worker.ts`; **`HOUSEKEEPING_SLA_W24`** from **`completeCheckoutPhysicalDeparture`** |
| **Checkout time** | W26 | **PARTIAL** | `w26-checkout-time-worker.ts` |
| **Dispute SLA** | W27 | **PARTIAL** | `w27-dispute-sla-worker.ts` + `lib/schedule-dispute-sla-w27.ts` (opened at dispute create; S8 phase per SIG §7.4) |
| **FOM override frequency** | W33 (SIG) | **PARTIAL** | Implementation **`w33-fom-override-frequency-worker.ts`**; runner wires **`FOM_OVERRIDE_FREQUENCY_W32`** via **`w32-fom-override-frequency-worker.ts`** wrapper — numbering drift documented in wrapper |
| **Payment follow-up** | W8 | **PARTIAL/OK** | `w8-payment-follow-up-worker.ts`; **`PAYMENT_FOLLOW_UP_W8`** scheduled when folio is **OUTSTANDING** on **S8→S9** (**`schedule-payment-followup-w8.ts`**) and idempotently at **S9 closure** (**`s9-service.closeEntryAtS9`**) |

---

## 7. Routes (SIG §8) — path / behaviour deltas

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /entries/:id/progress-stage` (S8→S9, S8 re-entry) | **PARTIAL/OK** | `routes/reservations/router.ts` — **`version`** required for S8→S9 and S8 re-entry; **`S8→S7`**: `targetStage: "S7"` + `transitionData.reEntryReason`; **`S8→S2`**: `targetStage: "S2"` + reason + **L2+** actor |
| `POST /entries/:id/room-inspection` | **OK** | `routes/entries/router.ts` → **`s8-checkout-service.recordInspection`** + **`dtos/03-entries/recordRoomInspectionRequestSchema`** |
| `POST /entries/:id/key-return` | **OK** | `routes/entries/router.ts` → **`recordKeyReturn`** + **`recordKeyReturnRequestSchema`** |
| `POST /folios/:id/settle` | **PARTIAL/OK** | `routes/folios/router.ts` — **`initiateSettlement`** (+ **p46** / **p61**) then **`completeCheckoutPhysicalDeparture`** inside transaction |
| `POST /handoffs/:id/fulfil` | **OK** | `routes/handoffs/router.ts` |
| `GET /folios/:id` | **OK** | `routes/folios/router.ts` |
| `POST /folios/:id/invoices` | **PARTIAL** | Folio router exposes invoice flows; mapping to SIG §8.8 **PARTIAL** |
| `POST /disputes/:id/gate-override` (target S9) | **OK** | Rejected by **`p54`** / service — aligns with SIG §8.9 |
| Dispute progress/close (SIG §8.10 `PATCH`) | **PARTIAL** | Repo: **`PATCH /disputes/:id`** (progress); **`POST /disputes/:id/close`** (close) — not identical verb/path to SIG table |
| `GET /disputes/:id` | **OK** | `routes/disputes/router.ts` → **`s7-dispute-service.getDispute`** |

---

## 8. S8→S9 exit guards vs SIG §1.3 / §3.2

| SIG exit condition | Status | Repo |
|--------------------|--------|------|
| Folio **SETTLED** or **OUTSTANDING** | **OK** | `p33-folio-state-allows-s8-to-s9-progression.ts` + **`progressStageS8ToS9`** |
| **KeyReturnRecord** exists | **OK** | `p01-s8-to-s9-room-and-keys-gates.ts` + Prisma lookup |
| Room **DEPARTED_DIRTY** | **OK** | **`enforceRoomDepartedDirtyForS8ToS9`** (physical state after **`completeCheckoutPhysicalDeparture`**, typically via settle) |
| Inspection complete or deferred + W9 | **PARTIAL/OK** | **`RoomInspectionRecord`** row required; deferral schedules **W9** — SIG “deferral TraceEvent” nuance **PARTIAL** |
| No unresolved **night-audit anomalies** for this entry | **PARTIAL/OK** | **`enforceNoUnresolvedNightAuditAnomaliesForS8ToS9`** + Prisma count (`resolvedAt: null`, `entryId`) |
| No known unposted stay **ROOM_CHARGE** / **F_AND_B** (surrogate) | **PARTIAL/OK** | **`listStayChargeGapsForCompleteAuditStayNightsS8ToS9`** — COMPLETE audit nights require lines; F&B only when **`dailyFAndBExpected`** |
| No known unposted charges (full SIG scan) | **MISSING** | No generic “all charge types / provisional ledger” scan beyond **p62** |
| H5 created or auto-fulfilled | **PARTIAL/OK** | **`buildOrAutoFulfilH5`** + **`enforceH5PresentForS8ToS9`** |
| Dispute gate **CLEAR** for S9 | **OK** | **`ensureDisputeGateClearForS9`** |
| H4 fulfilled | **PARTIAL/OK** | **`ensureH4FulfilledOrAuto`** |

---

## 9. Configuration keys (SIG §9)

| Theme | Status | Repo |
|-------|--------|------|
| `inspection.postCheckout.windowDays` | **OK** | Seed + **`recordInspection`** |
| `housekeeping.sla.windowMinutes` | **OK** | Seed + **`completeCheckoutPhysicalDeparture`** |
| `property.checkoutTime` / late checkout | **PARTIAL** | Seeded for **W26**; full **S8_READINESS** startup group from SIG §9.1 **not** implemented as a single validator |
| `damage.rateList`, `dispute.gateFunction.config`, `creditCeiling.clientTier.thresholds` | **PARTIAL/MISSING** | Not all SIG §9.1 “blocking surfaces” validated at startup in this codebase slice |

---

## 10. State machines (SIG §3)

| Machine | Status | Repo |
|---------|--------|------|
| **(ACTIVE, S8)** steady state | **OK** | `Entry.currentStage = S8` after S7→S8 |
| **S8→S9** | **PARTIAL/OK** | **`progressStageS8ToS9`** — read gates via **`collectS8ToS9ReadOnlyFailures`** → **`StageGatesBlockedError`** (`details.failures`); **H5** build after clear; **W8** if **OUTSTANDING**; omits SIG “all charge types” full ledger scan |
| **Folio LIVE → SETTLED / OUTSTANDING** | **PARTIAL/OK** | **`initiateSettlement`** (+ **p46** / **p61** / **p22** gates) |
| **Room OCCUPIED → DEPARTED_DIRTY** | **PARTIAL/OK** | **`completeCheckoutPhysicalDeparture`** — tied to **settlement** transaction in current design (not a separate “checkout complete only” API) |
| **S8→S7 / S8→S2 re-entry** | **PARTIAL/OK** | **`POST /entries/:id/progress-stage`** when `currentStage === S8` + **`s8-re-entry-service`** (see §0) |

---

## 11. DTOs (Cat 13)

| Area | Repo |
|------|------|
| Progress S9 / S8 re-entry | `dtos/06-reservations/request-schemas.ts` |
| Settlement | `dtos/07-folios/request-schemas.ts` — **`initiateSettlementRequestSchema`** (incl. **`nightAuditFomAcknowledgementRef`**) |
| H4 / fulfil | `dtos/11-handoffs/request-schemas.ts` |
| Disputes | `dtos/12-disputes/request-schemas.ts` |
| Room inspection / key return | `dtos/03-entries/request-schemas.ts` — **`recordKeyReturnRequestSchema`**, **`recordRoomInspectionRequestSchema`** |

---

## 12. Acceptance criteria snapshot (SIG §10)

| ID range | Theme | Status (codebase) |
|----------|--------|---------------------|
| **AC-S8-01–03** | OCCUPIED→DEPARTED_DIRTY + W24 | **PARTIAL/OK** — transition + timer in **`completeCheckoutPhysicalDeparture`**; **ordering** ties to **`initiateSettlement`** |
| **AC-S8-04–05** | Inventory claim not released at S8 | **PARTIAL** — **DEPARTED_DIRTY** enforced; full reservation claim / reassign conflict tests **PARTIAL** |
| **AC-S8-06–09** | Settlement paths | **PARTIAL/OK** — guest pay / partial → OUTSTANDING / DIRECT_BILL / VOUCHER branches in **`initiateSettlement`**; **p22** / **p46** / **p61** gates |
| **AC-S8-10–13** | Dispute gate S8→S9 | **PARTIAL/OK** — engine + gate-override rejection for S9 |
| **AC-S8-14–16** | Inspection + DEFICIENT | **PARTIAL/OK** — service + **`p51-deficient-inspection-review`** |
| **AC-S8-17–18** | H4 fulfilment | **PARTIAL** | **`fulfilHandoff`** evidence rules vs SIG depth **PARTIAL** |
| **AC-S8-19–20** | H5 auto vs created | **PARTIAL/OK** | **`buildOrAutoFulfilH5`** + trace on auto |
| **AC-S8-21–22** | W33 FOM override frequency | **PARTIAL** | **W32/W33** worker split + schedule from gate-override |
| **AC-S8-23–24** | W9 deferral | **PARTIAL/OK** | Deferred inspection + **W9** worker |
| **AC-S8-25+** | Key return reconciliation | **PARTIAL/OK** | Service + **`POST /entries/:id/key-return`** |

---

## 13. Session findings (SIG preamble)

| ID | Note |
|----|------|
| **SIG-S8-COR-001** | **`RoomInspectionRecord`** — SIG noted Part 2 gap; **repo has** Prisma model + **`recordInspection`** |
| **SIG-S8-COR-002** | **`KeyReturnRecord`** — SIG noted Part 2 gap; **repo has** Prisma model + **`recordKeyReturn`** |

---

## 14. Follow-ups

- Broader **unposted charge** inventory (non-**ROOM_CHARGE** / non-**F_AND_B**, provisional / draft lines) beyond **p62**.
- Structured **amendment rate deltas** so Policy **22** can reconcile totals when `AmendmentEventRecord` is non-empty.

---

## 15. Deliberation (SIG register)

| ID | Implementation note |
|----|---------------------|
| **SIG-S8-COR-001 / COR-002** | Treat as **implemented in repo** for tracking; DEV-SPEC Part 2 parity may still be desired for documentation |
| **Settlement vs physical checkout** | In this slice, **`completeCheckoutPhysicalDeparture`** runs inside **`initiateSettlement`** — operators typically **settle** before calling **`progress-stage` → S9**; document ordering for integrators |
| **Worker W32 vs W33** | SIG **W33** FOM override frequency ↔ code **`w33-fom-override-frequency-worker.ts`** + runner queue **`FOM_OVERRIDE_FREQUENCY_W32`** via **`w32-...` wrapper** |
