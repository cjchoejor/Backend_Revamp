# S6 Check‑in flowchart coverage vs automated tests

This document compares what the **Layer 03B deep‑dive → 3b.3 “S6 · Check‑In & Stay Initiation — operational flow”** flowchart in `LEGPHEL_Implementation_Reference_v1_1.html` describes, versus what our automated S6 tests actually execute:

- **Test report**: `Documentation/S6-test-report.md`
- **Test runner**: `back_end/scripts/s6-acceptance-tests.ts`

It answers: **which flowchart nodes/branches are tested** and **which are not**.

---

## Flowchart sections and coverage

### 1) Entry routes
Flowchart shows three entry routes:
- **Forward from S5 (standard)** (H1 fulfilled, guest present, room ready)
- **Walk‑in compressed path** (S1–S5 compressed, S5 auto‑fulfilled, no H1)
- **Re‑entry from S7 (compressed)** (room change, guest composition change)

**Tested**
- **Forward from S5 (standard)**: the S6 test script explicitly runs a full S5 readiness sequence over HTTP (`progressS5ToS6()`), then proceeds to S6 assertions. See `s6-acceptance-tests.ts` setup block `SETUP-S5->S6`.

**Not tested**
- Walk‑in compressed path (explicitly listed as not covered in `S6-test-report.md`).
- S7→S6 re‑entry compressed path.

---

### 2) Atomic check‑in transaction begins (`CheckInService.checkIn`)
Flowchart emphasises **single atomic transaction**: all S6 changes commit or roll back together.

**Tested**
- **Indirectly**, via the happy‑path S6→S7 test which asserts multiple state changes that are executed in one transaction (folio LIVE, room OCCUPIED, handoffs, etc.). This is captured in report section **AC-S6-027/005/010/012**.

**Not tested**
- A true “rollback/atomicity” fault‑injection test (e.g., force a failure mid‑transaction and assert no partial writes). Not present in this repo slice.

---

### 3) Identity verification decision (4 verification paths)
Flowchart lists 4 paths, each must write a verification event:
- FIRST_TIME (document captured → `GuestIdentityDocument`)
- RETURNING_VALID (no re‑capture)
- RETURNING_EXPIRED (soft flag; not hard block)
- VIP (alternate mechanism, still must write verification event)

**Tested**
- **FIRST_TIME** creates `GuestIdentityDocument` and retention math checks (report: **AC-S6-001**).
- **Exit gate blocks if identity not verified** (report: **AC-S6-028**) by clearing `GuestProfile.identityVerifiedAt` then attempting completion.

**Not tested**
- Explicit RETURNING_VALID path behaviour (no doc created; verification event only).
- Explicit RETURNING_EXPIRED path behaviour (“soft flag, no hard block”).
- VIP verification path itself (the suite uses VIP mostly to test missing VIP routing config; it does not assert the verification event semantics beyond that).
- “Every path writes verification event” as a dedicated assertion. We store verification fields on `guest_profiles` and optionally identity docs; we do not persist a separate “TraceEvent” in this slice.

Database tables involved (Prisma `@@map`):
- `guest_profiles` (`identity_verified_at`, `identity_verified_by`, `identity_verification_path`)
- `guest_identity_documents` (`guest_profile_id`, `document_type`, `document_number`, `captured_at`, `retention_period`, `retention_expires_at`)
- `configuration_entries` for `identity.documentTypes`, `identity.retentionPeriodDays` (config gates)

---

### 4) VIP tier decision → VIP arrival notification before key issuance
Flowchart branch:
- If VIP tier: write `VIPArrivalNotificationEvent` **before** key issuance; requires routing config

**Tested**
- **Config gate**: missing `vipNotification.routingPerTier` blocks VIP completion (report: **AC-S6-034**).

**Not tested**
- Positive VIP path: that a `vip_arrival_notification_events` row is created and that it occurs before keys issuance fields are set.
- Any ordering/trace enforcement (“before key issuance”)—no trace layer exists in this slice.

Database tables:
- `vip_arrival_notification_events`
- `configuration_entries` (`vipNotification.routingPerTier`)
- `entries` (`keys_issued_at`, `keys_issued_count`, `keys_issued_by`)

---

### 5) Folio conversion PROVISIONAL → LIVE (irreversible)
Flowchart node:
- `FolioService.convertToLive` is irreversible; populate `convertedToLiveAt`, `convertedBy`

**Tested**
- Happy path asserts `folios.state = LIVE` and fields set (report: part of **AC-S6-027/005/010/012**).

**Not tested**
- Explicit negative test that LIVE never reverts to PROVISIONAL (flowchart says forbidden under any re-entry).
- TraceEvent requirements mentioned in flowchart (“FOLIO_CONVERTED_TO_LIVE TraceEvent”) are not present in this repo slice.

Database:
- `folios.state`, `folios.converted_to_live_at`, `folios.converted_by`

---

### 6) Inventory claim CONFIRMED → OCCUPIED + RoomClaimStateEvent
Flowchart node:
- `rooms.current_claim_state`: CONFIRMED → OCCUPIED
- `room_claim_state_events` written, atomic with folio conversion

**Tested**
- Happy path asserts room claim becomes OCCUPIED and an event exists (report: **AC-S6-010** within **AC-S6-027/005/010/012**).

**Not tested**
- Negative tests for forbidden claim transitions (not present in S6 suite).

Database:
- `rooms.current_claim_state`
- `room_claim_state_events.from_state`, `to_state`, `room_id`, `entry_id`, `actor_id`

---

### 7) Key issuance (keyCount > 0) + registration confirmed
Flowchart:
- keys issued must follow verification (non‑VIP)
- registration completion is required for S6 exit

**Tested**
- Happy path includes `transitionData.keyCount = 2` and `registrationConfirmed = true`, and `entries.keysIssued*` / `entries.registrationCompleted*` are set by the service (visible in `GET /entries/:id` output; the test report focuses on stage transitions + core side effects).

**Not tested**
- Negative test: `keyCount = 0` blocking.
- Negative test: `registrationConfirmed = false` blocking.
- Ordering rule “must follow verification” (not asserted).

Database:
- `entries.keys_issued_at`, `entries.keys_issued_count`, `entries.keys_issued_by`
- `entries.registration_completed_at`, `entries.registration_completed_by`

---

### 8) Handoff transitions: H1 closes, H2/H3 created + W25 timers
Flowchart:
- H1: FULFILLED → CLOSED
- Create H2 and H3 in CREATED with W25 acceptance timers (`slaDeadlineAt`)

**Tested**
- Happy path asserts H1 becomes CLOSED and H2/H3 exist (report: **AC-S6-012** within **AC-S6-027/005/010/012**).

**Not tested**
- W25 timer behaviour / SLA deadlines (`handoff_records.sla_deadline_at`) — explicitly out of scope in report.
- “Complete content requirements” for H2/H3 checklist payload beyond minimal fields.
- DEFICIENT-specific requirement: “H2 references condition & deadline” is not asserted.

Database:
- `handoff_records` (`handoff_type`, `state`, `closed_at`, `checklist_content`, `sla_deadline_at`, `stage_context`)

---

### 9) Exit gate S6 → S7 (8 conditions)
Flowchart’s S6 exit guard conditions:
1) identity verified & event recorded
2) room OCCUPIED
3) folio LIVE
4) keys issued
5) H2 CREATED+
6) H3 CREATED+
7) registration complete
8) VIP notification (if VIP)

**Tested**
- Identity verified gate (blocked case): **AC-S6-028**
- Room readiness gate (blocked case): **AC-S6-011** (room set DIRTY)
- Integrated happy path that results in S7 with folio LIVE, room OCCUPIED, handoffs: **AC-S6-027/005/010/012**
- VIP config gate: **AC-S6-034**

**Not tested**
- Individual negative tests for keys/registration/H2/H3 gates.
- Positive VIP notification event.
- S6→S1 re-entry (room change at check-in) shown as a branch on the diagram — explicitly not covered in report.

---

## Summary: tested vs not tested (high-signal)

### ✅ Covered well by automated S6 suite
- Standard S5→S6 entry route (setup via HTTP)
- FIRST_TIME identity doc capture + retention calculation
- Identity-not-verified blocks exit
- Room-not-ready blocks completion
- Integrated happy-path completion writes: folio LIVE, room OCCUPIED, claim-state event, H1 closed, H2/H3 created
- Missing configuration gates for identity docs and VIP routing

### ⚠️ Present in the flowchart but not covered (or only indirectly covered)
- Walk-in compressed path
- S7→S6 re-entry compressed path
- RETURNING_VALID / RETURNING_EXPIRED explicit path assertions
- VIP positive path (VIPArrivalNotificationEvent creation & ordering)
- W25 acceptance timers (`slaDeadlineAt`) on H2/H3
- Fine-grained exit-gate negative tests for keys issued, H2/H3 presence, registration confirmed
- S6→S1 re-entry (room change at check-in)

