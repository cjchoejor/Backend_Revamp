# Stage 03 (S3) — Audit report

- **Doc**: `SIG-S3-v2_0.md` + `LEGPHEL_Implementation_Reference_v1_1.html` (Layer 03a · S3 reservation setup flow)
- **Scope**: stage identity, schema models, engines, services, workers/timers, API routes, configuration keys, acceptance criteria, scenario tests.
- **Generated**: 2026-05-07

---

## 0) Completion status (DONE / PARTIAL / NOT DONE)

- **DONE**: Provisional folio creation + billing model fixation (`BillingModelTransitionRecord`)
- **DONE**: Cancellation disclosure requirement before committed hold
- **DONE**: Advance payment threshold evaluation + reconciliation; credit extension with mandatory ceiling (L2+)
- **DONE**: Committed hold placement with W3 expiry + inventory claim events
- **DONE**: PI dispatch opens acknowledgement loop (W22) and schedules W34 follow-up when unpaid
- **DONE**: Use-type branches implemented (GROUP/CONFERENCE FOC validation + GM approval; coordinator confirmation; payment milestone scheduling → W21)
- **DONE**: Re-entry consequences implemented as first-class routes (S3→S2 retain hold; S3→S1 release hold + supersede PIs + cancel W22/W34)

---

## 1) Implemented map (high-signal)

### 1.1 Services
- `back_end/src/services/s3-reservation-setup-service.ts`
  - `ensureProvisionalFolioAndBillingModel()`: creates/returns PROVISIONAL folio, fixes billing model, writes `BillingModelTransitionRecord`, creates a draft PI
  - `progressS2ToS3()`: S2→S3 stage progression guards (accepted quotation etc.)
- `back_end/src/services/s3-cancellation-disclosure-service.ts`
  - `recordCancellationDisclosure()`: persists `CancellationDisclosureRecord` with mandatory `noShowTreatmentStatement`
- `back_end/src/services/s3-payment-service.ts`
  - `evaluateAdvancePaymentCondition()`, `markAdvancePaymentReconciled()`, `recordCreditExtensionApproval()`
- `back_end/src/services/s3-hold-service.ts`
  - `placeCommittedHold()`: enforces disclosure + payment/credit, upgrades speculative hold, schedules W3 timer, writes `RoomClaimStateEvent`

### 1.2 Workers / timers active at S3
- `W3` `COMMITTED_HOLD_EXPIRY_W3` → `back_end/src/workers/w3-committed-hold-expiry-worker.ts`
- `W22` `ACKNOWLEDGEMENT_WINDOW_W22` → `back_end/src/workers/w22-acknowledgement-window-worker.ts`
- `W34` `ADVANCE_PAYMENT_FOLLOW_UP_W34` → `back_end/src/workers/w34-advance-payment-follow-up-worker.ts`
- `W21` `PAYMENT_MILESTONE_W21` → `back_end/src/workers/w21-payment-milestone-worker.ts`

### 1.3 Routes (all under `/api` in `back_end/src/routes/s5-routes.ts`)
- `POST /entries/:id/folio/provisional`
- `POST /entries/:id/disclosures/cancellation`
- `POST /folios/:id/payments`
- `POST /folios/:id/advance-payment/reconcile`
- `POST /entries/:id/credit-extension` (L2+)
- `POST /entries/:id/holds/committed`
- `POST /entries/:id/re-entry/s2` (L2+)
- `POST /entries/:id/re-entry/s1` (L2+)
- `POST /entries/:id/foc/gm-approve` (L3)
- `POST /entries/:id/coordinator/confirm`
- `POST /entries/:id/payment-milestones/schedule`
- `POST /invoices/:id/dispatch`
- `POST /admin/enqueue` (L4 dev helper)

---

## 2) Scenario tests executed

See `Documentation_V2/Stage_03/README.md` for pass totals.

- `scenario_01_happy_path_s3.md`
- `scenario_02_hold_requires_disclosure.md`
- `scenario_03_hold_requires_payment_or_credit.md`
- `scenario_04_credit_extension_rules.md`
- `scenario_05_w3_committed_hold_expiry.md`
- `scenario_06_w34_follow_up_unpaid.md`
- `scenario_07_foc_requires_gm.md`
- `scenario_08_coordinator_confirm.md`
- `scenario_09_payment_milestones_w21.md`
- `scenario_10_reentry_s3_to_s2_retain_hold.md`
- `scenario_11_reentry_s3_to_s1_release_and_supersede.md`

---

## 3) Gaps / architectural notes

- **PI commType semantics**: the code opens a governed W22 ack loop on PI dispatch by creating a `CommunicationRecord`, but it reuses an existing `CommunicationType` value (to avoid Prisma client regeneration EPERM issues on Windows). Properly, the enum should include a dedicated PI/proforma type.
- **FOCValidationEngine**: implemented as `back_end/src/engines/foc-validation-engine.ts` (config-driven minimal entitlement model + mandatory GM approval).
- **Re-entry asymmetry**: implemented via `back_end/src/services/s3-reentry-service.ts` and routes; consequences are also recorded via `REENTRY.CONSEQUENCES_COMPUTED` trace payload.

