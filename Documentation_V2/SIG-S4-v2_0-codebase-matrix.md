# SIG-S4 v2.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S4-v2_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Generated:** 2026-05-12 (S4 alignment pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **S4 dwell (W1)** — schedule first `STAGE_DWELL_MONITOR` after successful confirmation | **DONE** | `lib/schedule-s4-dwell-warning-monitor.ts`, `services/domain/s4-confirmation-service.ts` |
| **S3 dwell exit** — seal open **S3** `StageDwellRecord` when entering **S4** | **DONE** | `s4-confirmation-service.ts` |
| **`HoldService.confirmCommittedHold`** slice — hold confirm + room claim + **W3** cancel in one tx | **DONE** | `s3-hold-service.confirmCommittedHoldTx`, `hold-service.ts` (`confirmCommittedHold` alias) |
| **Reservation snapshot order** — `Reservation` create then `confirmCommittedHoldTx` (SIG §6.1 ordering) | **DONE** | `s4-confirmation-service.ts` |
| **Policy 42 slice** — advance payment / credit must be satisfied immediately before confirm tx | **DONE** | `evaluateAdvancePaymentCondition` + `PolicyGateBlockedError` in `s4-confirmation-service.ts` |
| **Confirmation voucher document** stub (`CONFIRMATION_VOUCHER`) | **DONE** | `services/infrastructure/document-generation-service.ts` (`generateConfirmationVoucher`) |
| **ReservationService** façade (`confirm` alias) | **DONE** | `services/domain/reservation-service.ts` |
| Seed **`stageDwell.thresholds.S4`**, **`confirmation.document.templateKey`**, **`ownership.assignmentRules`** | **DONE** | `prisma/seed.ts` |
| Seed **`ownership.s4.sameTeamAutoFulfilH1`** | **DONE** | `prisma/seed.ts` |
| **Policy 20 + governed voucher + H1 tx helpers + W4 reservation gate** | **DONE** | `p20-commitment-rate-freeze-at-s4.ts`, `communication-service.ts` (`dispatchConfirmationVoucherTx`), `handoff-service.ts` (`createH1AtS4ConfirmationTx`), `s4-confirmation-service.ts`, `w4-pre-arrival-window-activation-worker.ts`, `p01-reservation-snapshot-required-for-s5-activation.ts` |

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (4, 9, 13, 20, 35, 39, 40, 41, 42, 43, 52, 63, 66, 67, 69, 71) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S4-heavy)

| Atlas category | S4 artefacts in repo |
|----------------|---------------------|
| **Cat 03** | `s4-confirmation-service.ts` (orchestrates S3→S4 commit); `entry-lifecycle-state-machine.ts` / workers for **S4→S5** |
| **Cat 05** | `engines/overbooking-detection-engine.ts`, `engines/foc-validation-engine.ts` (via policies), `engines/re-entry-consequence-engine.ts` (re-entry paths) |
| **Cat 06** | `p01-reservation-snapshot-required-for-s5-activation.ts`, `p13-multi-booking-ack-required.ts`, `p20-commitment-rate-freeze-at-s4.ts`, `p34-*`, `p39-*`, `p40-*`, `p41-*`, `p42-*`, `p52-*` (subset), `p63-*`, `p67-*`, `p71-*`, `policies/27-work-order/*` |
| **Cat 07 Domain** | `s4-confirmation-service.ts`, `s3-hold-service.ts` (`confirmCommittedHoldTx`), `reservation-service.ts`, `handoff-service.ts`, `pre-arrival-service.ts` |
| **Cat 07 Infrastructure** | `document-generation-service.ts`, `timer-management-service.ts` |
| **Cat 08** | `w1-stage-dwell-monitor.ts`, `w3-committed-hold-expiry-worker.ts`, `w4-pre-arrival-window-activation-worker.ts`, `w22-acknowledgement-window-worker.ts`, `workers/runner.ts` |
| **Cat 10** | `routes/reservations/router.ts` (`POST /entries/:id/confirm`, `POST …/progress-stage` → **S4**) |
| **Cat 12** | `prisma/seed.ts`: `handoff.H1.checklist`, `acknowledgement.windowPerType`, `confirmation.authorityThresholds`, `overbooking.*`, `preArrival.windowDays`, `stageDwell.thresholds.S4`, `confirmation.document.templateKey`, `ownership.assignmentRules` |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts` (`confirmReservationRequestSchema`) |

---

## 3. Policy inventory (SIG-S4 §4)

Legend: **OK** = primary path wired · **PARTIAL** = narrow slice vs full Part 5 narrative · **MISSING** = not found

| Policy | Role at S4 | Primary implementation |
|--------|------------|-------------------------|
| **4** | Ownership assignment | **PARTIAL** | `OWNERSHIP_ASSIGNED` trace in `s4-confirmation-service.ts`; rules config `ownership.assignmentRules` seeded — full rule engine TBD |
| **9** | Pre-arrival countdown | **OK** | `PRE_ARRIVAL_COUNTDOWN_W4` schedule in `s4-confirmation-service.ts`; `w4-pre-arrival-window-activation-worker.ts` |
| **13** | Multi-booking | **OK** | `p13-multi-booking-ack-required.ts` + reservation router trace hooks |
| **20** | Rate freeze / no repricing at S4 | **OK** | `p20-commitment-rate-freeze-at-s4.ts` + `Reservation.frozenRate` from accepted quotation in `s4-confirmation-service.ts` |
| **35** | Cancellation penalty | **PARTIAL** | Cancellation services/routes — S4 confirm path does not re-derive penalty |
| **39** | FOC re-verify | **OK** | `p39-foc-reverify-before-confirmation.ts`, `engines/foc-validation-engine.ts` (depth **PARTIAL**) |
| **40** | Confirmation authority | **OK** | `p40-confirmation-authority.ts`, `p40-s4-confirmation-readiness-gates.ts` |
| **41** | Overbooking + GM | **PARTIAL** | `p41-overbooking-requires-gm-mitigation.ts`, `engines/overbooking-detection-engine.ts` (minimal counting slice) |
| **42** | Credit ceiling | **OK** | `evaluateAdvancePaymentCondition` gate + `creditCeilingIfExtended` on `Reservation` |
| **43** | Ceiling in snapshot | **OK** | `Reservation.creditCeilingIfExtended` in `s4-confirmation-service.ts` |
| **52** | Voucher ack / OTA auto | **OK** | `CommunicationRecord` + **W22** when not OTA; OTA `RECEIVED` skip timer |
| **63** | H1 handoff | **OK** | `HandoffRecord` H1 in confirm tx (D-01) |
| **66** | Group FOC / billing split | **PARTIAL** | Group FOC path via **39**; explicit **group billing mode** freeze on `Reservation` not fully denormalised |
| **67** | Conference verification | **OK** | `p67-conference-verification-required.ts` |
| **69** | Session / PIN | **PARTIAL** | `middleware/auth.ts` |
| **71** | Processing lock | **PARTIAL** | `p71-*` — not wired as explicit S4 confirm pre-gate in this slice |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **OverbookingDetectionEngine** | **PARTIAL** | `engines/overbooking-detection-engine.ts` |
| **FOCValidationEngine** | **PARTIAL** | `engines/foc-validation-engine.ts` + `p39` |
| **TimerEngine** | **PARTIAL** | `getTimerEngine` + `timerRecord`; job names include `_W3` / `_W4` / `_W22` suffixes vs SIG literals |

---

## 5. Services (SIG §6)

| SIG name | Status | Repo |
|----------|--------|------|
| **ReservationService.confirm** | **PARTIAL/OK** | `s4-confirmation-service.confirmReservation`, `reservation-service.ts` (`confirm` alias) |
| **HoldService.confirmCommittedHold** | **OK** | `s3-hold-service.confirmCommittedHoldTx`, `hold-service.ts` |
| **HandoffService.create (H1)** | **OK** | `createH1AtS4ConfirmationTx` in `handoff-service.ts` (called from `s4-confirmation-service.ts`) |
| **CommunicationService.send** | **OK** | `dispatchConfirmationVoucherTx` in `communication-service.ts` (confirm path + **W22** timer) |
| **EntryService** (S4→S5) | **PARTIAL** | W4 + lifecycle modules — not a single `EntryService` export |

---

## 6. Workers & timers (SIG §7)

| Worker | Status | Notes |
|--------|--------|-------|
| **W1** | **OK** | `scheduleS4StageDwellWarningMonitor` after confirm |
| **W3** | **OK** | Cancelled in `confirmCommittedHoldTx` on successful confirm |
| **W4** | **OK** | Scheduled from confirm; `w4-pre-arrival-window-activation-worker.ts` + `p01-reservation-snapshot-required-for-s5-activation.ts` before S4→S5 |
| **W22** | **OK** | Non-OTA confirmation voucher ack timer |
| **W20** | **N/A** | SIG lists for catalogue completeness — not active at S4 for progressed entries |

---

## 7. Routes (SIG §8)

| SIG surface | Status | Repo |
|-------------|--------|------|
| `POST /entries/:id/confirm` | **OK** | `routes/reservations/router.ts` → `reservation-service.confirmReservation` |
| `POST /entries/:id/progress-stage` → S4 | **OK** | `reservation-service.confirmReservation` |
| Get reservation / progress S5 | **PARTIAL** | Additional GET routes per Part 9 may be partial vs SIG tables |

---

## 8. Configuration keys (SIG §9)

Seeded / used in this slice: **`confirmation.authorityThresholds`**, **`handoff.H1.checklist`**, **`acknowledgement.windowPerType`** (`voucher`), **`preArrival.windowDays`**, **`overbooking.maxAllowedRooms`**, **`overbooking.otaConflictRules`**, **`stageDwell.thresholds.S4`**, **`confirmation.document.templateKey`**, **`ownership.assignmentRules`**, **`ownership.s4.sameTeamAutoFulfilH1`**.

---

## 9. Follow-ups

- **Policy 41** — extend `detectOverbooking` / mitigation with inventory-aware detection + `OtaConflictOverbookingRecord` lifecycle per Part 4.
- **S4→S5 exit guards** — extend `w4` with remaining SIG §1.5 items (e.g. voucher ack resolution rules) beyond reservation snapshot.
- **`document-generation-service`** — replace voucher stub with rendered **CONFIRMATION_VOUCHER** artefact + durable storage.

---

## 10. Locked decisions (SIG § preamble)

| ID | Implementation |
|----|----------------|
| **D-01 H1 at S4** | `createH1AtS4ConfirmationTx` in confirm transaction; optional `ownership.s4.sameTeamAutoFulfilH1` → `isAutoFulfilled` |
| **D-02 Ownership** | `TraceEvent` `OWNERSHIP_ASSIGNED` in same transaction |
