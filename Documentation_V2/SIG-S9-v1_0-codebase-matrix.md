# SIG-S9 v1.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S9-v1_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **`BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`** (Cat 02 schema, Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Note:** SIG-S9 header is **DRAFT — Pending Architect confirmation** (15 April 2026). Nothing in SIG-S9 is locked until Architect confirms. This matrix inventories the **repo as implemented**; gaps vs Canon are called out explicitly.

**Generated:** 2026-05-13 (S9 matrix pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **SIG-S9 codebase matrix** (this document) | **DONE** | `Documentation_V2/SIG-S9-v1_0-codebase-matrix.md` |
| **Loop Closure core** — `closeEntryAtS9`: disputes, drafts, gov/direct-bill payment matching, deferred inspection resolution, H5, equipment return, apartment deposit, no-show path, W28 timer (excl. NO_SHOW_CLOSED), guest retention timer (**Policy 18** / `GUEST_DATA_RETENTION_P18`), follow-up task (conference/group), commission due + W11 on **RATE_MISSING**, room **FREE**, **ENTRY_CLOSED** / **FOLIO_SEALED** traces | **DONE** (service) | `services/domain/s9-service.ts` |
| **HTTP — terminal close** — SIG **`POST /entries/:id/close`** | **DONE** | `routes/entries/router.ts` (`POST /entries/:id/close` → `s9Service.closeEntryAtS9`), `dtos/03-entries/request-schemas.ts` (`closeEntryRequestSchema`) |
| **Post-stay charges** — `postStayCharge`, notification **CommunicationRecord**, **`isPostStay`**, stay-window guard | **DONE** | `s9-service.postStayCharge`, `routes/folios/router.ts` (`POST /folios/:id/charges` when `Stage.S9`, `POST /folios/:id/post-stay-charges`), `policies/.../p33-s9-closure-invoice-payment-and-poststay-gates.ts` |
| **Write-off** — GM bands, **WRITTEN_OFF**, **WriteOffRecord** | **DONE** | `s9-service.writeOffOutstandingBalance`, `policies/13-billing-model/write-off-policy-constraints.ts`, `policies/13-billing-model/p33-folio-outstanding-for-write-off.ts`, `POST /folios/:id/write-off` |
| **Invoice payment events** — DISPATCHED → PAYMENT_TRACKED / RECONCILED | **DONE** | `s9-service.recordInvoicePaymentEvent`, `policies/13-billing-model/p33-invoice-payment-state-transitions.ts`, `POST /invoices/:id/record-payment-event` |
| **W8** — idempotent schedule at S8→S9 + closure | **DONE** | `lib/schedule-payment-followup-w8.ts`, `workers/w8-payment-follow-up-worker.ts`, `state-machines/s8-s9-state-machine.ts`, `s9-service.closeEntryAtS9` |
| **W28** — dual-channel feedback after delay | **DONE** | `workers/w28-feedback-solicitation-worker.ts`, timer **`FEEDBACK_SOLICITATION_W28`** from `closeEntryAtS9` |
| **W11** — commission **RATE_MISSING** escalation timer | **DONE** | `workers/w11-commission-rate-missing-worker.ts`, `maybeCreateCommissionDue` in `s9-service.ts` |
| **W30 Lost+Found retention (SIG)** — record + retention worker | **DONE** | Prisma: `schema.prisma` (`LostAndFoundRecord`, `LostFoundReturnStatus`), `services/domain/lost-found-service.ts`, `routes/incidents-and-lost-found/router.ts` (`POST /lost-found`), `workers/w30-lost-found-retention-worker.ts`, timer queue `LOST_FOUND_RETENTION_W30` |
| **Acceptance script** | **DONE** | `scripts/s9-acceptance-tests.ts`, `scripts/run-s9-acceptance-with-server.ts`, `package.json` (`test:s9`) |

**Remaining vs SIG (high level):** **`CommunicationService`** as a distinct façade (notifications inlined in services); **`GuestProfileService.applyRetention`** depth vs stub worker; folio **seal** model field if spec expects beyond **TraceEvent**.

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` — SIG-S9 findings **COR-001…COR-005** (follow-up task, **WRITTEN_OFF**, routes) align with schema/route backfill narrative |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (11, 18, 53–55, 57, 68, 70, …) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S9-heavy)

Per **`BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`**, S9 artefacts map as follows (paths under `back_end/src/` unless noted).

| Atlas category | S9 artefacts in repo |
|----------------|----------------------|
| **Cat 02** | Prisma: `Entry` (**CLOSED**, `closedAt`), `Folio` (**SETTLED**, **OUTSTANDING**, **WRITTEN_OFF**, **NO_SHOW_CLOSED**), `FolioLine` (`isPostStay`, `postedAt`), `Invoice` / `InvoiceState`, `PaymentRecord`, `WriteOffRecord`, `CreditNote`, `CommissionDueRecord`, `FollowUpTaskRecord`, `DisputeRecord`, `HandoffRecord` (H5 closure), `CommunicationRecord`, `EquipmentAllocation`, `NoShowDeterminationRecord`, `Room` (**FREE** at closure), `TimerRecord`, `TraceEvent` |
| **Cat 03** | `state-machines/s8-s9-state-machine.ts` — **entry into S9** (`progressStageS8ToS9`); terminal closure logic in **`services/domain/s9-service.ts`** (`closeEntryAtS9`) — **not** split into `state-machines/s9-closure-state-machine.ts` in repo |
| **Cat 05** | **`engines/dispute-gate-engine.ts`** — S8→S9 + dispute lifecycle; SIG §5 states no pricing/tax/night-audit engines at S9 — matches |
| **Cat 06** | `policies/01-availability/p01-entry-at-s9-for-closure.ts`, `p01-equipment-return-resolved-for-s9-closure.ts`, `policies/13-billing-model/p33-s9-closure-invoice-payment-and-poststay-gates.ts`, `p33-invoice-payment-state-transitions.ts`, `p33-folio-outstanding-for-write-off.ts`, `write-off-policy-constraints.ts`, `policies/19-deficient-condition/p51-s9-closure-inspection-resolution.ts`, `policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`, `policies/22-no-show/p56-no-show-determination-required-for-s9-closure.ts`, `policies/25-handoff/p63-handoff-lifecycle-gates.ts` (H5 closure) |
| **Cat 07 Domain** | **`services/domain/s9-service.ts`** — list/dispatch invoices, payment events, write-off, **closeEntryAtS9**, **postStayCharge**, no-show closure slice; **`services/domain/guest-profile-service.ts`** — retention/anonymisation (Policy 18 narrative); **`services/domain/s7-dispute-service.ts`** — dispute lifecycle; **`services/domain/handoff-service.ts`** — H5 fulfil path |
| **Cat 07 Application** | (none S9-exclusive folder in repo; orchestration lives in domain **`s9-service`**) |
| **Cat 08** | `workers/w8-payment-follow-up-worker.ts`, `workers/w9-post-checkout-inspection-worker.ts` (S8 carry-over), `workers/w11-commission-rate-missing-worker.ts`, `workers/w27-dispute-sla-worker.ts`, `workers/w28-feedback-solicitation-worker.ts`, `workers/w29-equipment-return-worker.ts`, `workers/w30-guest-data-retention-worker.ts` (**Policy 18** — note SIG **W30** name collision), `workers/runner.ts` |
| **Cat 10** | `routes/folios/router.ts` — **GET/POST** patterns for S9 (`/folios/:id/invoices`, `/invoices/:id/dispatch`, `/invoices/:id/record-payment-event`, `/folios/:id/write-off`, `/folios/:id/post-stay-charges`, `/folios/:id/charges` S9 branch); `routes/disputes/router.ts` — close dispute; `routes/handoffs/router.ts` — fulfil H5; `routes/reservations/router.ts` — **S8→S9** `progress-stage`; `routes/entries/router.ts` — **`POST /entries/:id/close`** |
| **Cat 12** | `requireActiveConfigValue` / seed: `feedback.solicitation.delaySeconds`, `followUp.deadlineDays`, `commission.rateMissing.resolutionSeconds`, `write_off_authority_thresholds` (via write-off policy), payment follow-up intervals (W8 scheduling elsewhere), etc. |
| **Cat 13** | `dtos/07-folios/request-schemas.ts` — `postStayChargeRequestSchema`, `writeOffOutstandingBalanceRequestSchema`, `recordInvoicePaymentEventRequestSchema`, `postFolioChargesBodySchema`, … |
| **Cat 15** | `middleware/auth.js` — `requireActorLevel` on folios (e.g. **L3** write-off, **L2** invoice payment event, **L2** post-stay) |

---

## 3. Policy inventory (SIG-S9 §4)

Legend: **OK** = wired in repo for S9 slice · **PARTIAL** = narrow slice / different layering · **MISSING** = not found

| Policy | Role at S9 | Status | Primary implementation |
|--------|------------|--------|------------------------|
| **11** | Post-stay payment follow-up (W8) | **PARTIAL/OK** | `schedule-payment-followup-w8.ts`, `w8-payment-follow-up-worker.ts`; full template escalation narrative **PARTIAL** |
| **18** | Guest data retention | **PARTIAL/OK** | `closeEntryAtS9` schedules **`GUEST_DATA_RETENTION_P18`**; **`w30-guest-data-retention-worker.ts`** (SIG worker index differs — see §6) |
| **53** | Active dispute management | **PARTIAL/OK** | `s7-dispute-service.ts`, `w27-dispute-sla-worker.ts` |
| **54** | Dispute gate (S8→S9 + closure) | **OK** | `p54-dispute-gate-stage-progression.ts`, `dispute-gate-engine.ts`, `ensureNoOpenDisputes` in **`closeEntryAtS9`** |
| **55** | Dispute closure | **PARTIAL/OK** | `POST /disputes/:id/close`, GM reason — aligns with SIG §8.9 shape |
| **57** | No-show financial closure | **PARTIAL/OK** | `p56-no-show-determination-required-for-s9-closure.ts`, `processNoShowS9IfNeeded` |
| **68** | Commission due | **PARTIAL/OK** | `maybeCreateCommissionDue` + **`CommissionDueRecord`**; W11 on **RATE_MISSING** |
| **70** | Feedback solicitation | **PARTIAL/OK** | `registerW28FeedbackTimer`, **`w28-feedback-solicitation-worker.ts`** (dual **CommunicationRecord** + trace) |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **DisputeGateEngine** | **OK** | `engines/dispute-gate-engine.ts` — used for stage progression; closure uses **`enforceNoOpenDisputesForS9Closure`** + DB probe |

SIG: *“No other engines are invoked at S9.”* — Repo avoids pricing/tax/night-audit in **`s9-service`** (consistent).

---

## 5. Services (SIG §6)

| SIG / narrative | Status | Repo |
|-----------------|--------|------|
| **EntryService.close** | **PARTIAL/OK** | **`closeEntryAtS9`** implements closure invariant slices; exposed via **`POST /entries/:id/close`** |
| **EntryService.progressStage (S8→S9)** | **PARTIAL/OK** | `state-machines/s8-s9-state-machine.ts` |
| **FolioService.postCharge / post-stay** | **PARTIAL/OK** | **`postStayCharge`** — requires **`isPostStay: true`** |
| **FolioService.recordPostStayPayment** (SIG name) | **PARTIAL/OK** | `POST /invoices/:id/record-payment-event` accepts SIG fields (optional) and can create a **PaymentRecord IN**, recompute ledger, and transition folio **OUTSTANDING→SETTLED** when balance reaches zero (`services/domain/s9-service.ts`) |
| **FolioService.writeOff** | **PARTIAL/OK** | **`writeOffOutstandingBalance`** |
| **HandoffService.fulfil** | **PARTIAL/OK** | `handoff-service.ts` + **`POST /handoffs/:id/fulfil`** |
| **DisputeService.evaluateStageGate** | **PARTIAL** | Closure uses **inline `ensureNoOpenDisputes`** vs named **`evaluateStageGate`** export |
| **NoShowService.processS9Closure** | **PARTIAL** | **`processNoShowS9IfNeeded`** inside **`closeEntryAtS9`** |
| **CommunicationService** (dual dispatch) | **PARTIAL** | Post-stay charge creates **`CommunicationRecord`** inline in **`postStayCharge`**; W28 creates rows in worker |
| **GuestProfileService.applyRetention** | **PARTIAL** | **`guest-profile-service.ts`** exists; **`w30-guest-data-retention-worker`** currently stub/trace oriented |

---

## 6. Workers & timers (SIG §7)

| Worker | SIG id | Status | Repo / notes |
|--------|--------|--------|----------------|
| **Payment follow-up** | W8 | **PARTIAL/OK** | `w8-payment-follow-up-worker.ts`, **`PAYMENT_FOLLOW_UP_W8`** |
| **Post-checkout inspection** | W9 | **PARTIAL/OK** | `w9-post-checkout-inspection-worker.ts` — S8 deferral carry-over |
| **Commission rate missing** | W11 | **PARTIAL/OK** | `w11-commission-rate-missing-worker.ts`; timer **`COMMISSION_RATE_MISSING_W11`** |
| **Dispute SLA** | W27 | **PARTIAL/OK** | `w27-dispute-sla-worker.ts` |
| **Feedback solicitation** | W28 | **PARTIAL/OK** | `w28-feedback-solicitation-worker.ts`, **`FEEDBACK_SOLICITATION_W28`** |
| **Equipment return** | W29 | **PARTIAL/OK** | `w29-equipment-return-worker.ts`; closure gate **`p01-equipment-return-resolved-for-s9-closure.ts`** |
| **Lost+found retention** | W30 | **OK** | `workers/w30-lost-found-retention-worker.ts` (timer **`LOST_FOUND_RETENTION_W30`**) + `LostAndFoundRecord` |
| **Guest data retention** | Policy 18 | **PARTIAL/OK** | `workers/w30-guest-data-retention-worker.ts` (timer **`GUEST_DATA_RETENTION_P18`**) — SIG labels this under Policy 18, not W30 |

---

## 7. Routes (SIG §8) — path / behaviour deltas

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /entries/:id/progress-stage` (S8→S9) | **PARTIAL/OK** | `routes/reservations/router.ts` |
| **`POST /entries/:id/close`** | **OK** | `routes/entries/router.ts` → `s9Service.closeEntryAtS9` (Auth: **L2+**) |
| `POST /folios/:id/charges` (post-stay at S9) | **PARTIAL/OK** | `routes/folios/router.ts` — S9 branch uses **`postStayCharge`**; **L1** blocked for S9 post-stay (**L2+**) |
| `POST /folios/:id/post-stay-charges` | **PARTIAL/OK** | Dedicated route **L2** |
| `POST /folios/:id/invoices` | **PARTIAL/OK** | Issues invoice via **`s3FolioService.issueInvoice`** (path overlaps S3/S9) |
| `GET /folios/:id/invoices` | **OK** | `s9Service.listInvoices` |
| **`POST /invoices/:id/record-payment-event`** | **OK** | Implemented — SIG-S9-COR-004 addressed in code |
| `POST /folios/:id/credit-notes` | **PARTIAL/OK** | **`s7-folio-lines-service.postCreditNote`** — not renamed **FolioService.addCreditNote** |
| **`POST /folios/:id/write-off`** | **OK** | Implemented — SIG-S9-COR-005 addressed in code |
| `POST /disputes/:id/close` | **PARTIAL/OK** | GM close + reason |
| `POST /handoffs/:id/fulfil` | **PARTIAL/OK** | H5 closure evidence |
| `GET /folios/:id` | **OK** | `s8-settlement-service.getFolio` |

---

## 8. Loop Closure invariant vs SIG §1.4 / §3.5

| SIG item | Status | Repo |
|----------|--------|------|
| Disputes terminal | **OK** | `ensureNoOpenDisputes` |
| Invoices dispatched | **OK** | `ensureInvoicesDispatched` |
| Payments matched | **PARTIAL/OK** | Gov **PAYMENT_TRACKED**; direct-bill unmatched IN gate |
| OUTSTANDING + W8 or write-off | **PARTIAL/OK** | `ensureOutstandingHasW8OrWrittenOff` |
| Deferred inspection resolved | **PARTIAL/OK** | `ensureInspectionResolved` + **W9** lapse trace |
| H5 not blocking | **OK** | `ensureH5NotOpen` |
| Equipment / apartment deposit | **PARTIAL/OK** | `ensureEquipmentReturnResolved`, `ensureApartmentDepositResolved` |
| No-show disposition | **PARTIAL/OK** | `processNoShowS9IfNeeded` |
| Commission + follow-up task + feedback timer + retention timer | **PARTIAL/OK** | Inside **`closeEntryAtS9`** transaction |

---

## 9. Configuration keys (SIG §9)

| Theme | Status | Repo |
|-------|--------|------|
| `feedback.solicitation.delaySeconds` | **OK** | **`registerW28FeedbackTimer`** |
| `followUp.deadlineDays` | **OK** | **`maybeCreateFollowUpTask`** |
| `commission.rateMissing.resolutionSeconds` | **OK** | **`maybeCreateCommissionDue`** W11 branch |
| Write-off thresholds | **PARTIAL/OK** | **`write-off-policy-constraints.ts`** |
| Full **S9_READINESS** startup group | **PARTIAL/OK** | Readiness probe: `GET /health/s9-readiness` uses `lib/s9-readiness.ts` (does not block generic `/health`) |

---

## 10. State machines (SIG §3)

| Machine | Status | Repo |
|---------|--------|------|
| **Entry ACTIVE @ S9 → CLOSED** | **PARTIAL/OK** | **`closeEntryAtS9`** |
| **Folio terminal transitions** | **PARTIAL/OK** | **`writeOffOutstandingBalance`**, settlement elsewhere (**S8**) |
| **Inventory FREE at closure** | **PARTIAL/OK** | **`Room.currentClaimState`** → **FREE** in **`closeEntryAtS9`** |

---

## 11. DTOs (Cat 13)

| Area | Repo |
|------|------|
| Folios / invoices / write-off / post-stay | `dtos/07-folios/request-schemas.ts` |
| Progress S9 | `dtos/06-reservations/request-schemas.ts` (shared with S8) |

---

## 12. Acceptance criteria snapshot (SIG §10)

| Theme | Status (codebase) |
|-------|-------------------|
| Schema (**AC-S9-001…007**) | **PARTIAL** — models exist; **`POST /entries/:id/close`** not wired blocks many end-to-end tests |
| Closure gates (**008…020**) | **PARTIAL** — logic in **`closeEntryAtS9`**; route gap |
| Commission / W11 (**021…025**) | **PARTIAL/OK** |
| W28 dual channel (**026…030**) | **PARTIAL/OK** — **`w28`** worker |
| Government payment (**031…032**) | **PARTIAL** |
| No-show (**033…035**) | **PARTIAL/OK** — **`processNoShowS9IfNeeded`** |
| Post-stay (**036…037**) | **PARTIAL/OK** — **`postStayCharge`** |
| Write-off (**038…041**) | **PARTIAL/OK** |
| Sealing (**042…045**) | **PARTIAL** — traces + immutability via Prisma extensions elsewhere |
| H5 (**046…047**) | **PARTIAL/OK** |

Script: **`back_end/scripts/s9-acceptance-tests.ts`** — align with **`npm run test:s9`** pattern when stabilised.

---

## 13. Session findings (SIG § Findings Register)

| ID | Repo note |
|----|-----------|
| **SIG-S9-COR-001** | **`FollowUpTaskRecord`** — **`maybeCreateFollowUpTask`** writes rows when schema present |
| **SIG-S9-COR-002** | **`FolioState.WRITTEN_OFF`** — **`writeOffOutstandingBalance`** sets state |
| **SIG-S9-COR-003** | **`POST /entries/:id/close`** — **service implemented**, **route missing** |
| **SIG-S9-COR-004** | **`POST /invoices/:id/record-payment-event`** — **implemented** |
| **SIG-S9-COR-005** | **`POST /folios/:id/write-off`** — **implemented** |

---

## 14. Follow-ups

- Wire **`closeEntryAtS9`** to **`POST /entries/:id/close`** (and **`CloseEntryRequestDTO`** / empty body per product).
- Reconcile SIG **W30** (**lost-found**) vs codebase **`w30`** (**guest retention**) — documentation / rename / split worker file.
- Optional: extract **`state-machines/s9-closure-state-machine.ts`** from **`s9-service`** for Atlas Cat 03 symmetry with S8.
- Expand **`s9-acceptance-tests`** + CI runner mirroring **`run-s8-acceptance-with-server.ts`**.

---

## 15. Deliberation

| Topic | Note |
|-------|------|
| **SIG draft status** | Treat matrix as **implementation inventory**, not Canon lock-in |
| **`recordInvoicePaymentEvent` vs folio balance** | SIG §6 describes payment matching bringing folio to **SETTLED** — confirm **`recomputeFolioOutstandingBalance`** integration if product requires it |
| **Worker numbering** | **W33** in S8 matrix ≠ **W28** here — always cite **timerCode** + file path in integrations |
