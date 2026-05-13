# SIG-S3 v2.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S3-v2_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Last updated:** 2026-05-12 (gap-closure pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| S2→S3 transition: provisional folio in same tx + **STAGE_DWELL_MONITOR** for S3 | **DONE** | `state-machines/s2-s3-state-machine.ts`, `services/domain/s3-folio-service.ts`, `lib/schedule-s3-dwell-warning-monitor.ts` |
| Seed: **S3** row under `stageDwell.thresholds` + SIG-S3 config keys | **DONE** | `back_end/prisma/seed.ts` (`advancePayment.thresholds`, `expiry.s3.committedHoldTtlSeconds`, `stageDwell.thresholds.S3`) |
| **FolioService** façade: `getOrCreateProvisionalFolio`, billing/PI helper, **S6** `convertToLive`, **`recordPayment`**, **`issueInvoice`**, **`supersedePendingInvoices`**, **`getFolio`**, **`listInvoices`** | **DONE** | `services/domain/folio-service.ts`, `s3-folio-service.ts`, `s3-reservation-setup-service.ts`, `routes/folios/router.ts` |
| **HoldService** façade: S3 `placeCommittedHold`, `releaseOnReEntry` | **DONE** | `services/domain/hold-service.ts`, `s3-hold-service.ts` |
| **PaymentService** façade: **`getPaymentStatus`**, advance payment + credit extension + shared **W34** cancel helper | **DONE** | `services/domain/payment-service.ts`, `s3-payment-service.ts` |
| **CancellationService** façade: disclosure + SIG alias **`recordDisclosure`** | **DONE** | `services/domain/cancellation-service.ts`, `s3-cancellation-disclosure-service.ts` |
| **`POST /entries/:id/progress-stage`** with **`targetStage: "S4"`** → same as confirm | **DONE** | `routes/reservations/router.ts`, `dtos/06-reservations/request-schemas.ts` |
| S3→S2 / S3→S1 back-flow APIs | **PARTIAL** | `s3-reentry-state-machine.ts` — invoice supersede + timer cancels centralized in `s3-folio-service.supersedePendingInvoicesTx` (incl. **PAYMENT_MILESTONE_W21** cancel on S3→S1) |
| Policy **8** slice + **W3** hook | **DONE** | `policies/11-committed-hold/p08-committed-hold-expiry-policy-slice.ts`, `workers/w3-committed-hold-expiry-worker.ts` |
| Policy **27** inbound payment at S3 | **DONE** | `policies/12-advance-payment/p27-advance-payment-inbound-record-at-s3.ts`, `recordPayment` |
| **W34** skip condition vs threshold | **DONE** | `workers/w34-advance-payment-follow-up-worker.ts` |

---

Same convention as **SIG-S1 / SIG-S2** matrices: finalized specs live under **`DEV-SPEC finalization/`** (space in folder name). SIG **`-REV1` / `-REV2`** suffixes may not appear on filenames.

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (8, 26–30, 34, 38, 42, 52, 69, 71) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |
| SIG-S3-ADDENDUM-001 (W34) | `docs/SIG-S3-ADDENDUM-001.md` (if present under `docs/`) |

---

## 2. Atlas placement (S3-heavy)

| Atlas category | S3 artefacts in repo |
|----------------|---------------------|
| **Cat 03** | `state-machines/s2-s3-state-machine.ts` (S2→S3), `state-machines/s3-reentry-state-machine.ts` (S3 back-flow segments) |
| **Cat 05** | `engines/foc-validation-engine.ts`, `engines/re-entry-consequence-engine.ts`, `engines/timer-engine.ts` (via `getTimerEngine` / timer records) |
| **Cat 06** | `policies/11-committed-hold/p26-*`, `policies/12-advance-payment/p27-*`, `policies/13-billing-model/p30-*`, `policies/13-billing-model/p31-*`, `policies/14-cancellation/p34-*`, `policies/15-foc/p38-*`, `policies/18-credit-extension-ceiling/p42-*`, `policies/20-communication-acknowledgement-tracking/p52-*` (subset), `policies/31-processing-lock/p71-*`, `policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts` |
| **Cat 07 Domain** | `s3-hold-service.ts`, `s3-folio-service.ts`, `s3-payment-service.ts`, `s3-reservation-setup-service.ts`, `s3-cancellation-disclosure-service.ts`, `s3-reentry-service.ts`, `s3-use-type-service.ts`, façades `hold-service.ts`, `folio-service.ts`, `payment-service.ts`, `cancellation-service.ts` |
| **Cat 07 Infrastructure** | `services/infrastructure/timer-management-service.ts`, communication paths used for PI / ack |
| **Cat 08** | `workers/w1-stage-dwell-monitor.ts`, `workers/w3-committed-hold-expiry-worker.ts`, `workers/w22-acknowledgement-window-worker.ts`, `workers/w34-advance-payment-follow-up-worker.ts`, registration in `workers/runner.ts` |
| **Cat 10** | `routes/reservations/router.ts` (S2→S3, committed hold, S3 re-entry, confirm S4), `routes/folios/router.ts` (payments, payment-status, credit-extension, invoices list/dispatch), `routes/cancellations/router.ts` (cancellation disclosure) |
| **Cat 12** | `prisma/seed.ts` / `ConfigurationEntry`: `advancePayment.thresholds`, `expiry.s3.committedHoldTtlSeconds`, `billingModel.availablePerSource`, `stageDwell.thresholds` (**S3** row) |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts`, `dtos/07-folios/request-schemas.ts` |

---

## 3. Policy inventory (SIG-S3 §4)

Legend: **OK** = wired for primary path · **PARTIAL** = stub, narrow path, or naming/shape differs from SIG · **MISSING** = not found

| Policy | Role at S3 | Primary implementation |
|--------|------------|-------------------------|
| **8** | Committed hold expiry (W3) | **OK** | `p08-committed-hold-expiry-policy-slice.ts`, `w3-committed-hold-expiry-worker.ts` |
| **26** | Committed hold placement | **OK** | `p26-committed-hold-inventory-availability.ts`, `p26-committed-hold-release-on-reentry-requires-fom.ts`, `s3-hold-service.ts` |
| **27** | Advance payment collection | **PARTIAL/OK** | `p27-advance-payment-inbound-record-at-s3.ts`, `p27-advance-payment-reconciliation.ts`, `s3-folio-service.recordPayment`, `s3-payment-service.ts` |
| **30** | Billing model initial fix | **OK** | `p30-billing-model-allowlist-from-config.ts`, `ensureProvisionalFolioAndBillingModel` in `s3-reservation-setup-service.ts` |
| **34** | Cancellation disclosure before hold | **OK** | `p34-cancellation-terms-disclosure-required.ts`, `p34-no-show-treatment-statement-required.ts`, `s3-cancellation-disclosure-service.ts` |
| **38** | FOC validation (GROUP/CONFERENCE) | **PARTIAL** | `p38-foc-validation-for-committed-hold.ts`, `p38-foc-gm-approval-authority.ts`, `engines/foc-validation-engine.ts` — depth vs Part 4/6 |
| **42** | Credit ceiling mandatory | **OK** | `p42-credit-ceiling-mandatory-set.ts`, `p42-advance-payment-or-credit-extension-required.ts`, `recordCreditExtensionApproval` |
| **52** | PI acknowledgement loop | **PARTIAL** | `w22-acknowledgement-window-worker.ts`, dispatch flows; PI-specific **`p52-*`** files skew toward quotation/S2 naming — verify PI dispatch registers ack timers end-to-end |
| **69** | Session / PIN | **PARTIAL** | `middleware/auth.ts`, `routes/session-and-authentication/router.ts` |
| **71** | Processing lock TTL | **PARTIAL** | `p71-processing-lock-ttl.ts`, `p71-processing-lock-expired-for-reconfirm.ts`, processing-lock routes/services — not all S3 exit guards wired per SIG §1.5 item 11 |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **FOCValidationEngine** | **PARTIAL** | `engines/foc-validation-engine.ts`; invoked from `s3-hold-service` / policies |
| **ReEntryConsequenceEngine** | **PARTIAL** | `engines/re-entry-consequence-engine.ts` + `s3-reentry-service.ts` / `s3-reentry-state-machine.ts` — compare timer cancel + invoice supersede lists to SIG §5.2 |
| **TimerEngine** | **PARTIAL** | `getTimerEngine`, `timerRecord`, pg-boss job names (e.g. worker uses **`COMMITTED_HOLD_EXPIRY_W3`** vs SIG literal `COMMITTED_HOLD_EXPIRY`) |

---

## 5. Services (SIG §6)

| SIG name | Status | Repo |
|----------|--------|------|
| **EntryService** (`createSegment`, `progressStage`, S3→S4 guards) | **PARTIAL** | `progress-stage` with **`targetStage: "S4"`** now calls **`confirmReservation`** (same as **`POST /entries/:id/confirm`**). `createSegment` / unified façade still scattered across lifecycle modules. |
| **HoldService** | **PARTIAL/OK** | `s3-hold-service.ts`, `hold-service.ts` |
| **FolioService** | **PARTIAL/OK** | `s3-folio-service.ts`, `s3-reservation-setup-service.ts`, `folio-service.ts` — **`recordPayment`**, **`issueInvoice`**, **`supersedePendingInvoices`**, **`getFolio`**, **`listInvoices`**, `getOrCreateProvisionalFolio`; dispatch remains **`s9-service.dispatchInvoice`**. |
| **PaymentService** | **PARTIAL/OK** | `s3-payment-service.ts`, `payment-service.ts` — includes **`getPaymentStatus`** |
| **CancellationService** | **PARTIAL/OK** | `s3-cancellation-disclosure-service.ts`, `cancellation-service.ts` (`recordCancellationDisclosure`, **`recordDisclosure`** alias); full **`cancel()`** narrative still in broader cancellation modules |

---

## 6. Workers & timers (SIG §7)

| Worker / timer | Status | Notes |
|----------------|--------|-------|
| **W1** Stage dwell | **OK** | `w1-stage-dwell-monitor.ts`; S3 first fire via `lib/schedule-s3-dwell-warning-monitor.ts` after S2→S3 |
| **W3** Committed hold expiry | **OK** | `w3-committed-hold-expiry-worker.ts`; scheduled from `s3-hold-service` |
| **W22** Ack window | **PARTIAL** | `w22-acknowledgement-window-worker.ts` — confirm PI path registers same timer type SIG names |
| **W34** Advance payment follow-up | **OK** | `w34-advance-payment-follow-up-worker.ts` — skip uses threshold + credit; dual-tier still scheduled from `s9-service.dispatchInvoice` |

---

## 7. Routes (SIG §8)

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /entries/:id/holds/committed` | **OK** | `routes/reservations/router.ts` |
| `GET /folios/:id` | **OK** | `routes/folios/router.ts` → `s8-settlement-service.getFolio` (also exported from `folio-service` façade) |
| `POST /folios/:id/payments` | **OK** | `s3-folio-service.recordPayment` |
| `POST /folios/:id/invoices` | **OK** | `s3-folio-service.issueInvoice` (DRAFT PI; dispatch still `POST /invoices/:id/dispatch`) |
| `GET /folios/:id/invoices` | **OK** | `routes/folios/router.ts` |
| `GET /entries/:id/payment-status` | **OK** | `getPaymentStatus` via `s3-payment-service` |
| `POST /entries/:id/credit-extension` | **OK** | `routes/folios/router.ts` |
| `POST /entries/:id/disclosures/cancellation` | **OK** | `routes/cancellations/router.ts` |
| `POST /entries/:id/progress-stage` → S4 | **OK** | Delegates to **`s4-confirmation-service.confirmReservation`** (same as **`POST /entries/:id/confirm`**) |
| `POST /entries/:id/progress-stage` → S2 / S1 | **PARTIAL** | Dedicated re-entry endpoints on `reservations/router.ts` (see `s3ReEntryService`) |
| `POST /entries/:id/cancel` | **PARTIAL** | `routes/cancellations/router.ts` — confirm path matches SIG auth matrix |

---

## 8. Configuration keys (SIG §9)

Minimal seeded set: **`advancePayment.thresholds`**, **`expiry.s3.committedHoldTtlSeconds`**, **`billingModel.availablePerSource`** (used by `ensureProvisionalFolioAndBillingModel` when present), **`stageDwell.thresholds.S3`**.

---

## 9. Follow-ups (narrower scope)

- **`EntryService`** naming consolidation (`createSegment` / `progressStage` as single façade) vs scattered lifecycle modules.
- **S3→S1** — confirm every SIG timer type is cancelled (audit against `supersedePendingInvoicesTx` + `releaseOnReEntry`).
- **Policy 52** — add PI-specific `p52-*` if quotation-oriented modules are insufficient for audits.
- **Policy 71** — wire full S3 exit guard §1.5 item 11 (active processing lock on committed-hold inventory) into S4 readiness if not already enforced in `p40-s4-confirmation-readiness-gates`.

---

## 10. State machines (explicit modules)

| Transition | Module |
|------------|--------|
| S2 → S3 | `state-machines/s2-s3-state-machine.ts` |
| S3 → S2 / S3 → S1 | `state-machines/s3-reentry-state-machine.ts` (with `s3-reentry-service.ts`) |
