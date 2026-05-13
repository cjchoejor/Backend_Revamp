# SIG-S6 v1.0 ↔ Codebase ↔ DEV-SPEC finalization ↔ Atlas

**Purpose:** Cross-check `docs/SIG-S6-v1_0.md` against `back_end/src`, map SIG artefacts to **`DEV-SPEC finalization/`** paths, and record **where work lands** per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html** (Cat 02 schema, Cat 03 state machines, Cat 05 engines, Cat 06 policies, Cat 07 services, Cat 08 workers, Cat 10 routes, Cat 12 configuration, Cat 13 DTOs).

**Note:** SIG-S6 header marks **DRAFT — Pending Architect confirmation**; this matrix inventories the repo as implemented, not locked Canon text.

**Generated:** 2026-05-12 (S6 alignment / matrix pass)

---

## 0. Implementation delta (this pass)

| Change | Status | Files |
|--------|--------|-------|
| **SIG-S6 codebase matrix** (this document) | **DONE** | `Documentation_V2/SIG-S6-v1_0-codebase-matrix.md` |
| **VIP at commencement (SIG §6.1 step 4)** | **DONE** | `services/domain/vip-arrival-notification-service.ts`, `state-machines/entry-lifecycle-state-machine.ts` (`progressStageS5ToS6`), `services/domain/check-in-service.ts` (p52 verify only) |
| **W14 registered + timer queue** | **DONE** | `workers/w14-vip-arrival-notification-worker.ts`, `workers/runner.ts`, `lib/timer-engine.ts` |
| **S6 dwell warning schedule + seed S6 thresholds** | **DONE** | `lib/schedule-s6-dwell-warning-monitor.ts`, `prisma/seed.ts` (`stageDwell.thresholds.S6`, `acknowledgement.windowPerType.vipArrival`) |
| **Cancel W23 on S5→S6** | **DONE** | `services/domain/room-assignment-service.ts` (`cancelScheduledRoomReadinessSlaForEntry`) |
| **`TraceEvent` folio LIVE naming (AC-S6-005)** | **DONE** | `services/domain/folio-service.ts` (`FOLIO_CONVERTED_TO_LIVE`) |
| **Policy 35 post-check-in early departure** | **DONE** | `services/application/cancellation-service.ts` (`cancelEntryEarlyDepartureAfterCheckIn`), `routes/cancellations/router.ts` (`POST …/cancel-early-departure`), `p01-entry-progression-stage-gates.ts`, `p35-cancellation-penalty-from-commitment.ts` |
| **Prisma `CommunicationType.VIP_ARRIVAL_NOTIFICATION`** | **DONE** | `prisma/schema.prisma` + migration `prisma/migrations/20260512120000_add_vip_arrival_notification_comm_type/migration.sql` |
| **S6 acceptance script alignment** | **DONE** | `scripts/s6-acceptance-tests.ts` (VIP AC-021/023 S5→S6 path; AC-034 at commencement; folio-service import) |

---

## 1. SIG “Source Confirmation Table” → `DEV-SPEC finalization/`

| SIG cites | Closest match under `DEV-SPEC finalization/` |
|-----------|-----------------------------------------------|
| Part 2 Schema | `DEV-SPEC finalization/DEV-SPEC Part 2/DEV-SPEC-001-Part2.md` (see **COR-001** `VIPArrivalNotificationEvent` in SIG preamble) |
| Part 3 State machines | `DEV-SPEC finalization/DEV-SPEC Part 3/DEV-SPEC-001-Part3.md` |
| Part 4 Engines | `DEV-SPEC finalization/DEV-SPEC Part 4/DEV-SPEC-001-Part4.md` |
| Part 5 Policies (16, 17, 29, 31, 35, 49, 52, 63, 69, 71) | `DEV-SPEC finalization/DEV-SPEC Part 5/DEV-SPEC-001-Part5.md` |
| Part 6 Services | `DEV-SPEC finalization/DEV-SPEC Part 6/DEV-SPEC-001-Part6.md` (see **COR-002** `convertToLive` naming in SIG) |
| Part 8 Workers | `DEV-SPEC finalization/DEV-SPEC Part 8/DEV-SPEC-001-Part8.md` |
| Part 9 Routes | `DEV-SPEC finalization/DEV-SPEC Part 9/DEV-SPEC-001-Part9.md` |
| Part 12 Configuration | `DEV-SPEC finalization/DEV-SPEC Part 12/DEV-SPEC-001-Part12.md` |
| Part 13 Acceptance | `DEV-SPEC finalization/DEV-SPEC Part 13/DEV-SPEC-001-Part13.md` |

---

## 2. Atlas placement (S6-heavy)

Per **BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html**, S6 artefacts map as follows (paths under `back_end/src/` unless noted).

| Atlas category | S6 artefacts in repo |
|----------------|----------------------|
| **Cat 02** | Prisma: `Entry`, `GuestProfile`, `GuestIdentityDocument`, `VIPArrivalNotificationEvent` (model), `Folio`, `FolioLine`, `HandoffRecord` (H1/H2/H3), `Room`, `RoomAssignment`, `RoomClaimStateEvent`, `PreArrivalTask`, `Reservation`, `StageDwellRecord`, `TraceEvent`, `CommunicationRecord` |
| **Cat 03** | `state-machines/entry-lifecycle-state-machine.ts` — **`progressStageS5ToS6`** (guest present → **S6**), **`progressStageS6ToS7`** (delegates to check-in), **`reEnterS6ToS1`** (S6→S1 re-entry); `state-machines/index.ts` re-exports |
| **Cat 05** | `lib/timer-engine.ts` (**W25** H2/H3 acceptance, **W23** S5–S6); `engines/room-assignment-suggestion-engine.ts` (S6-eligible); **PricingPipelineEngine** — **N/A** at S6 per SIG §5.3 |
| **Cat 06** | `p01-room-assignment-and-physical-ready-s6-checkin.ts`, `p01-entry-progression-stage-gates.ts`, `p05-h1-eligible-for-s6-checkin-completion.ts`, `p16-identity-verified-before-checkin-completion.ts`, `p16-checkin-completion-ceremony-gates.ts`, `p16-guest-physically-present-s5-to-s6.ts` (S5→S6 edge), `p12-advance-payment/p29-advance-payment-reconciled-before-checkin-completion.ts`, `p13-billing-model/p31-folio-provisional-before-checkin-completion.ts` (+ live charge context policies), `p19-deficient-condition/p49-deficient-carry-into-h2.ts`, `p20-communication-acknowledgement-tracking/p52-vip-arrival-notification-recorded-for-checkin.ts`, `p25-handoff/p63-handoff-lifecycle-gates.ts`, `p14-cancellation/*` (S6 cancel if routed) |
| **Cat 07 Domain** | `services/domain/check-in-service.ts` (`completeCheckInToS7`), `services/domain/vip-arrival-notification-service.ts` (VIP commencement), `services/domain/folio-service.ts` (`convertToLive`), `services/domain/handoff-service.ts` (H2/H4 paths; H2 content + **p49**), `services/domain/pre-arrival-service.ts` (walk-in compressed waive path), `services/domain/entry-service.ts` (re-exports), guest profile identity slice under `services/domain/` / `routes/guest-profiles` |
| **Cat 08** | `workers/w1-stage-dwell-monitor.ts`, `workers/w25-handoff-acceptance-worker.ts`, `workers/w23-room-readiness-sla-worker.ts`, `workers/w14-vip-arrival-notification-worker.ts` (idempotent audit follow-up; scheduled after VIP S5→S6), `workers/runner.ts` |
| **Cat 10** | `routes/reservations/router.ts` (`POST …/progress-stage` → **S6** / **S7**); `routes/guest-profiles/router.ts` (`POST /guest-profiles/:id/verify-identity`); `routes/handoffs/router.ts`; `routes/cancellations/router.ts` (`POST …/cancel` S5; **`POST …/cancel-early-departure`** S7 / Policy 35) |
| **Cat 12** | `prisma/seed.ts`: `identity.*`, `vipNotification.routingPerTier`, `handoff.H2`/`H3` checklists, `acknowledgement.windowPerType` (**h2**, **h3**, **vipArrival**), `advancePayment.thresholds`, `billingModel.availablePerSource`, `stageDwell.thresholds` (**includes S6**), `cancellation.policyTiers` (**postCheckInEarlyDeparturePenaltyAmount**) |
| **Cat 13** | `dtos/06-reservations/request-schemas.ts` (`progressStageRequestSchema`, `transitionData` keys); `dtos/14-guest-profiles/request-schemas.ts` (`verifyGuestIdentityRequestSchema`); `dtos/11-handoffs/request-schemas.ts` |
| **Cat 15** | `middleware/auth.ts` — `requireActorLevel` on check-in and identity routes |

---

## 3. Policy inventory (SIG-S6 §4)

Legend: **OK** = primary path wired · **PARTIAL** = narrow slice vs full Part 5 / SIG narrative · **MISSING** = not found

| Policy | Role at S6 | Status | Primary implementation |
|--------|------------|--------|------------------------|
| **16** | Guest identity verification | **PARTIAL/OK** | `POST /guest-profiles/:id/verify-identity` + `enforceIdentityVerifiedBeforeCheckInCompletion`; full `GuestIdentityDocument` / retention paths vs AC-S6-001 depth not fully audited here |
| **17** | Guest data capture governance | **PARTIAL** | Identity route + config `identity.*`; explicit Policy 17 checklist vs Part 5 narrative **PARTIAL** |
| **29** | Advance payment at check-in completion | **OK** | `p29-advance-payment-reconciled-before-checkin-completion.ts` in `check-in-service.completeCheckInToS7` |
| **31** | Billing model / folio LIVE | **PARTIAL/OK** | `folio-service.convertToLive()` + trace `FOLIO.CONVERTED_TO_LIVE` (SIG AC text uses `FOLIO_CONVERTED_TO_LIVE` — naming delta); `p31-folio-provisional-before-checkin-completion.ts` |
| **35** | Cancellation (early departure) | **PARTIAL/OK** | `cancelEntryEarlyDepartureAfterCheckIn` + `POST /entries/:id/cancel-early-departure` (L2); penalty via `postCheckInEarlyDeparturePenaltyAmount` / `sameDayPenaltyAmount`; full S9-equivalent financial closure per SIG narrative not implemented |
| **49** | DEFICIENT → H2 | **OK** | `p49-deficient-carry-into-h2.ts` + `handoff-service` H2 creation (`deficientConditionStatus`) |
| **52** | VIP / comm acknowledgement | **PARTIAL/OK** | VIP issuance at **S5→S6** in `vip-arrival-notification-service.ts` + per-role **`CommunicationType.VIP_ARRIVAL_NOTIFICATION`** + **W22**; **W14** audit follow-up |
| **63** | Handoff lifecycle | **OK** | `p63-handoff-lifecycle-gates.ts`, H2/H3 + **W25** timers in `check-in-service` / `handoff-service` |
| **69** | Session / PIN | **PARTIAL** | `middleware/auth.ts` |
| **71** | Processing lock TTL | **PARTIAL** | `p71-*` — S6 re-entry (`reEnterS6ToS1`) may touch locks; not exhaustively mapped |

---

## 4. Engines (SIG §5)

| Engine | Status | Repo |
|--------|--------|------|
| **TimerEngine** | **PARTIAL** | `getTimerEngine` — **W25** on H2/H3 creation in `check-in-service`; job names suffixed vs SIG literals |
| **ReEntryConsequenceEngine** | **PARTIAL** | `reEnterS6ToS1` in `entry-lifecycle-state-machine.ts` |
| **PricingPipelineEngine** | **N/A at S6** | SIG §5.3 — must not be invoked (no dedicated runtime trace assert in repo) |

---

## 5. Services (SIG §6)

| SIG name | Status | Repo |
|----------|--------|------|
| **CheckInService** (complete check-in → S7) | **PARTIAL/OK** | `check-in-service.completeCheckInToS7` — identity, folio provisional, advance reconciled, room ready, H1/walk-in, H2/H3, keys, registration, VIP notifications, folio LIVE, room OCCUPIED, dwell |
| **FolioService.convertToLive** | **OK** | `folio-service.convertToLive` (tx-scoped); SIG **COR-002** notes Part 6 naming drift — repo uses **`convertToLive`** |
| **HandoffService** (H2/H3, accept/reject) | **PARTIAL/OK** | `handoff-service.ts`, `routes/handoffs/router.ts` |
| **EntryService.progressStage** | **PARTIAL/OK** | `entry-service.ts` → `progressStageS6ToS7`; S6 **entry** via `progressStageS5ToS6` |
| **RoomAssignmentService** | **PARTIAL** | S6 uses assignment from S5; `reEnterS6ToS1` / compressed paths in lifecycle |
| **GuestProfileService / identity** | **PARTIAL** | Implemented via guest-profiles router + services (exact `recordVerification` name may differ) |

---

## 6. Workers & timers (SIG §7)

| Worker | Status | Notes |
|--------|--------|-------|
| **W1** | **PARTIAL/OK** | `w1-stage-dwell-monitor.ts` — **`scheduleS6StageDwellWarningMonitor`** after **S5→S6**; seed includes **S6** thresholds |
| **W25** | **OK** | `w25-handoff-acceptance-worker.ts` — H2/H3 acceptance SLA; registered from `check-in-service` |
| **W23** | **PARTIAL/OK** | `w23-room-readiness-sla-worker.ts` — S5 and **S6** |
| **W14** | **OK** | `w14-vip-arrival-notification-worker.ts` — audit `NOTIFICATION.VIP_ARRIVAL_W14_PROCESSED`; scheduled ~1.5s after VIP **S5→S6** |
| Timer codes | — | e.g. `H2_H3_ACCEPTANCE_W25`, `ROOM_READINESS_SLA_W23` |

---

## 7. Routes (SIG §8)

| SIG surface | Status | Repo |
|-------------|--------|------|
| Progress to **S6** (initiate check-in / enter S6) | **OK** | `POST /entries/:id/progress-stage` `targetStage: "S6"` → `progressStageS5ToS6` (`routes/reservations/router.ts`) |
| Complete check-in → **S7** | **OK** | `POST …/progress-stage` `targetStage: "S7"` + `transitionData.keyCount`, `registrationConfirmed` → `progressStageS6ToS7` |
| **Verify guest identity** | **OK** | `POST /guest-profiles/:id/verify-identity` (`routes/guest-profiles/router.ts`) |
| Handoff accept / fulfil / reject (H2/H3) | **OK** | `routes/handoffs/router.ts` |
| Cancellation at S6 / S7 | **PARTIAL/OK** | `POST /entries/:id/cancel-early-departure` (L2) — **S7** + LIVE folio per SIG “post check-in” |

---

## 8. Configuration keys (SIG §9)

SIG §9.1 lists **S6_READINESS** blocking keys. Repo reads many via `requireActiveConfigValue` on check-in paths, including **`identity.documentTypes`**, **`identity.retentionPeriodDays`**, **`vipNotification.routingPerTier`**, **`handoff.H2`/`H3` checklists**, **`acknowledgement.windowPerType`** (h2/h3), **`advancePayment.thresholds`**, **`billingModel.availablePerSource`**.

**Gap:** `stageDwell.thresholds` seed object in `prisma/seed.ts` currently spans **S1–S5**; add **S6** (and later stages) for parity with SIG and W1 behaviour at S6.

---

## 9. State machines (SIG §3)

| Machine | Status | Repo |
|---------|--------|------|
| **Entry S5→S6** | **PARTIAL/OK** | `progressStageS5ToS6` — physical presence, H1, room, tasks, folio provisional, advance reconciliation, credit Tier 2 |
| **Entry S6→S7** | **PARTIAL/OK** | `completeCheckInToS7` — full ceremony per SIG §1.5 exit list |
| **Folio PROVISIONAL→LIVE** | **PARTIAL/OK** | `folio-service.convertToLive` inside same transaction as check-in completion slice |
| **Room CONFIRMED→OCCUPIED** | **PARTIAL/OK** | `check-in-service` transaction — `RoomClaimStateEvent` |
| **H1 FULFILLED / walk-in** | **PARTIAL/OK** | `p05-h1-eligible-for-s6-checkin-completion.ts`; walk-in compressed path in `check-in-service` |
| **H2 / H3** | **PARTIAL/OK** | Created in check-in tx with W25; **p49** on DEFICIENT |

---

## 10. DTOs (Cat 13)

| DTO area | Repo |
|----------|------|
| Progress stage S6 / S7 | `dtos/06-reservations/request-schemas.ts` — `progressStageRequestSchema`, `transitionDataSchema` |
| Verify identity | `dtos/14-guest-profiles/request-schemas.ts` — `verifyGuestIdentityRequestSchema` |
| Handoffs | `dtos/11-handoffs/request-schemas.ts` (accept / fulfil / reject payloads) |

---

## 11. Acceptance criteria snapshot (SIG §10)

| ID range | Theme | Status (codebase) |
|----------|--------|---------------------|
| **AC-S6-001** – **004** | Identity paths | **PARTIAL** — verify route exists; full AC automation not asserted in this matrix |
| **AC-S6-005** – **009** | Folio LIVE / no pricing | **PARTIAL/OK** | `convertToLive` + trace **`FOLIO_CONVERTED_TO_LIVE`**; no dedicated pricing-engine spy |
| **AC-S6-010** – **011** | Room OCCUPIED / ready | **PARTIAL/OK** | Guards + claim transition in check-in flow |
| **AC-S6-012** – **014** | H1 closure / walk-in | **PARTIAL/OK** | Implemented in `check-in-service` transaction paths |
| **AC-S6-015** – **020** | H2/H3 / W25 / reject | **PARTIAL** — core creation + W25; idempotency / FOM reject alerts need test confirmation |
| VIP notification ACs | **PARTIAL** | DB model + in-tx writes; **W14** stub |

---

## 12. Session findings (from SIG preamble)

| ID | Note |
|----|------|
| **SIG-S6-COR-001** | `VIPArrivalNotificationEvent` — confirm Prisma model vs Part 2 backfill |
| **SIG-S6-COR-002** | `FolioService.convertToLive` — repo implements **`folio-service.convertToLive`**; Part 6 naming alignment queued in SIG |

---

## 13. Follow-ups

- After Architect locks SIG-S6, re-diff policy list vs Part 5 §72 S6 column.
- Deepen **S7 early departure** flow: folio settlement hooks, inventory edge cases, and automated tests for `POST /entries/:id/cancel-early-departure`.

---

## 14. Deliberation (SIG register)

| ID | Implementation note |
|----|---------------------|
| **D-SIG-S6-001** / **COR-001** | VIP arrival record — mid-session derivation per SIG |
| **D-SIG-S6-002** / **COR-002** | **`convertToLive`** canonical in this repo |
| **D-SIG-S6-003** | Walk-in compressed S5 — reflected in `check-in-service` walk-in branch |
