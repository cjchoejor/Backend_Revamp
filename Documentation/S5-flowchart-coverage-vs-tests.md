# S5 Pre‑arrival flowchart coverage vs automated tests

This document compares what the **Layer 03B deep‑dive → 3b.2 “S5 · Pre‑Arrival / Pre‑Event — operational flow”** flowchart in `LEGPHEL_Implementation_Reference_v1_1.html` describes, versus what our automated S5 tests actually execute:

- **Test report**: `Documentation/S5-test-report.md`
- **Test runner**: `back_end/scripts/s5-acceptance-tests.ts`

It answers: **which flowchart nodes/branches are tested** and **which are not**.

---

## Flowchart sections and coverage

### 1) Entry routes (top row)
Flowchart shows three entry routes into S5:
- **Forward from S4 (standard)** via `PRE_ARRIVAL_COUNTDOWN` → **W4 activates S5**
- **Forward from S4 · compressed** (same/next‑day arrival)
- **Re‑entry from S6+ (compressed)** (readiness re‑verification only)

**Tested**
- **Partially (only “S5 already active” assumption)**: our S5 tests operate on entries that are already seeded at `Entry.currentStage = S5`.

**Not tested**
- **W4 timer firing + activation path** (creating tasks at activation time, cancelling W34 in same transaction, registering dwell timers).
- **Compressed forward path** (immediate timer fire).
- **Re‑entry from S6+ into S5** (compressed readiness re‑verification).

Why: this repo slice does not implement a timer engine / worker dispatcher (W4/W34/W1), so tests can’t trigger those entry routes end‑to‑end.

---

### 2) Checklist initialisation
Flowchart node:
- `PreArrivalService.initialiseChecklist()` creates **all PreArrivalTask rows** with `status = PENDING`
- Notes timers: **W5** (no‑show cutoff), **W1** (stage dwell monitor), **W34** cancelled

**Tested**
- **PreArrivalTask gate behaviour**, not the initialization moment:
  - Pending tasks block exit (S5→S6) (reported as **AC-S5-018**).

**Not tested**
- The **initialisation operation itself** (the exact moment tasks are created and seeded from S1/S3/S4 sources).
- Confirmation that **“9 task types”** are created (see next section).
- W1/W5/W34 registrations/cancellation.

Database objects involved in the flowchart (not directly asserted by tests):
- `pre_arrival_tasks` (`entry_id`, `task_type`, `status`, `created_at`, …)
- `configuration_entries` (to seed checklist types, if that becomes config‑driven later)

---

### 3) Parallel “9 task types” (PENDING → COMPLETE / WAIVED)
Flowchart lists 9 task types:
- PAYMENT_RECONCILIATION
- CREDIT_CEILING_CHECK (only if credit extended)
- NIGHT_AUDIT_TIMER_REGISTRATION
- BED_CONFIGURATION_CHANGE
- PRE_ARRIVAL_COMMUNICATION
- SPECIAL_REQUEST_FULFILMENT
- LATE_ARRIVAL_MEAL_COORDINATION
- SITE_VISIT (conference only)
- UNIT_READINESS_VERIFICATION (apartment only)

**Tested**
- **Status transitions and gating** (generic, not per-task semantics):
  - **WAIVE requires `waivedReason`** (reported as **AC-S5-019**).
  - **Any task still PENDING blocks S5→S6** (reported as **AC-S5-018**).
  - **Happy path completes remaining tasks** using `PATCH /pre-arrival-tasks/:id { action: COMPLETE }` (setup + **AC-S5-023**).

**Not tested**
- Verification that **all 9 task types exist** at S5 activation.
  - Our seed creates **3 tasks** for the leisure entry (`PAYMENT_RECONCILIATION`, `NIGHT_AUDIT_TIMER_REGISTRATION`, `PRE_ARRIVAL_COMMUNICATION`).
- Task‑specific behaviours implied by the flowchart:
  - Housekeeping work order creation for `BED_CONFIGURATION_CHANGE`
  - F&B coordination handoff or task outputs for `LATE_ARRIVAL_MEAL_COORDINATION`
  - Conference / apartment conditional tasks
- WAIVE metadata completeness:
  - flowchart note implies **“WAIVED requires waivedReason & waivedBy”**
  - tests only assert `waivedReason` is required; they do **not** assert presence/persistence of `waivedBy` for waive operations.

Database tables / columns:
- `pre_arrival_tasks.status`, `pre_arrival_tasks.waived_reason`, `pre_arrival_tasks.waived_by`, `pre_arrival_tasks.completed_at`, `pre_arrival_tasks.completed_by`

---

### 4) Room assignment
Flowchart node:
- `RoomAssignmentService.assignRoom`
- Room must be in one of:
  - `AVAILABLE_CLEAN`
  - `AVAILABLE_INSPECTED`
  - `UNDER_MAINTENANCE` *with a valid schedule/ready time*
- If room is **DEFICIENT**, acknowledgement fields are mandatory
- Side branch: **W23 ROOM_READINESS_SLA** registered only if room not yet ready

**Tested**
- DEFICIENT acknowledgement required (reported as **AC-S5-014**)
- UNDER_MAINTENANCE without schedule blocked (reported as **AC-S5-016**)
- DEFICIENT assignment preserves `deficientConditionRecordId` even after later resolution (reported as **AC-S5-015**)

**Not tested**
- Explicit acceptance of `AVAILABLE_INSPECTED` as assignable (only clean room is used as the normal assignment).
- UNDER_MAINTENANCE “ready ok” path where `expectedReadyAt <= arrival` is allowed (S5→S6 gate checks this; S5 tests don’t isolate it as a dedicated case).
- **W23 registration behaviour** (no timer engine / SLA worker in this slice).

Database tables / columns:
- `room_assignments.room_id`, `room_assignments.deficient_at_assignment`, `room_assignments.deficient_condition_record_id`, `room_assignments.acknowledgement_actor_id`, `room_assignments.acknowledgement_at`
- `rooms.physical_state`, `rooms.expected_ready_at`
- `deficient_condition_records.status`, `deficient_condition_records.resolved_at`, `deficient_condition_records.resolved_by`

---

### 5) W5 fired? (no‑show cutoff) and no‑show subprocess
Flowchart decision diamond:
- “**W5 fired?** no‑show cutoff”
- If YES: enters **no‑show subprocess** (still `ACTIVE, S5`):
  - `NO_SHOW_PENDING`
  - `→ AWAITING_WRITTEN_CONFIRMATION` (FOM defers)
  - `→ NO_SHOW_DETERMINED` (FOM decides)
  - Terminal path: Folio `NO_SHOW_CLOSED` → S9‑equivalent terminal

**Tested**
The automated tests cover several governance rules around the **no‑show decision**:
- **Authority**: L1 forbidden, L2 required (reported as **AC-S5-025**)
- **Cutoff required** (reported as **AC-S5-031**) using `Entry.noShowCutoffReachedAt`
- **Contact attempts required** (reported as **AC-S5-026**)
- **Penalty capped** at total advance payment (reported as **AC-S5-028**)
- **Missing configuration** blocks no‑show: `noShow.cutoffWindowMinutes` (reported as **AC-S5-035**)

These tests hit `POST /entries/:id/no-show` and then validate outcomes via returned JSON and direct DB reads (for penalty capping).

**Not tested**
- **DEFER path** (`determinationPath = "DEFER"`) leading to `Entry.awaitingWrittenConfirmationActive = true`.
- **REACTIVATE path** (`determinationPath = "REACTIVATE"`) clearing `awaitingWrittenConfirmationActive` and resetting cutoff.
- Verifying that after a no‑show decision:
  - `folios.state` becomes `NO_SHOW_CLOSED`
  - `folios.closed_at/closed_by` are set
  - `entries.current_stage` moves to `TERMINAL`
  - `no_show_determination_records` row is written
  These writes exist in the implementation (`back_end/src/services/no-show-service.ts`), but the report does not explicitly list them as asserted checks.

Database tables / columns involved by the implementation:
- `entries.no_show_cutoff_reached_at`
- `entries.awaiting_written_confirmation_active`
- `no_show_determination_records.entry_id`, `...contact_attempt_log`, `...decision_reason`, `...created_by`
- `folios.state`, `folios.no_show_penalty_amount`, `folios.no_show_advance_payment_amount`, `folios.no_show_net_position`, `folios.no_show_fom_determination`, `folios.closed_at`, `folios.closed_by`
- `payment_records` may get an **OUT** refund row when net is positive

---

### 6) Readiness guard chain + S5→S6 exit guard
Flowchart shows:
1) all tasks COMPLETE/WAIVED
2) advance payment reconciled
3) credit ceiling 90%+ requires FOM ack
4) H1 progression CREATED→ACCEPTED→FULFILLED
Plus guest presence condition

Exit guard lists 8 conditions (sequenced):
1) H1 FULFILLED
2) RoomAssignment ready
3) DEFICIENT decisions documented
4) all tasks done
5) advance payment reconciled
6) credit ceiling proximity if active
7) no-show cutoff not fired (or FOM reactivated)
8) guest physically present

**Tested (directly or indirectly)**
- **H1 must be FULFILLED** to progress (reported as **AC-S5-011**)
- **Task pending blocks** (reported as **AC-S5-018**)
- **Credit ceiling 90% gate** blocks until FOM ack (reported as **AC-S5-022**)
- **Happy path** S5→S6 succeeds when gates are satisfied (reported as **AC-S5-023**)
- **Guest physically present** is always sent as `guestPhysicallyPresent: true` in progress calls; the test suite does not include a “false/omitted” case as a dedicated assertion.

**Not tested**
- Dedicated negative test for **guestPhysicallyPresent = false** causing `GUEST_NOT_PRESENT`.
- Dedicated tests for “advance payment reconciled” gate (progress requires `Folio.advancePaymentReconciliationComplete = true`; seed generally sets this true, but we don’t run a case where it’s false).
- Dedicated tests for condition (7): when W5 has fired / no‑show pending status exists, does S5→S6 block unless reactivated? (not covered).
- Dedicated tests for “room not ready but expectedReadyAt <= arrival ok” nuance (see section 4).
- The **S5→S1 re‑entry** path shown on the diagram (“config error · FOM”) is not implemented/tested in this slice.

Database tables / columns involved:
- `handoff_records.state` (H1)
- `room_assignments` + `rooms.physical_state/expected_ready_at`
- `pre_arrival_tasks.status`
- `folios.advance_payment_reconciliation_complete`
- `entries.credit_ceiling_tier2_acknowledged_at` (FOM ack)
- `entries.current_stage` updated to S6 on success

---

## Summary: tested vs not tested (high-signal)

### ✅ Covered well by the automated S5 suite
- H1 accept checklist gating and H1 fulfil transition guards
- DEFICIENT assignment acknowledgement gating + deficient record linkage preservation
- UNDER_MAINTENANCE missing schedule rejection
- “Any pending pre-arrival task blocks S5→S6” + WAIVE requires reason
- Credit ceiling Tier‑2 (90%) acknowledgement gate
- No-show authority, cutoff reached, contact attempts required, penalty cap
- Missing config behaviours (`handoff.H1.checklist`, `noShow.cutoffWindowMinutes`)

### ⚠️ Present in the S5 flowchart but **not** covered (or only indirectly covered)
- W4/W5/W1/W23/W34 timer/worker behaviours (activation, SLA, dwell monitoring, cancellation)
- Full “9 task types” checklist creation and per-task semantics (most are absent from seed + tests)
- No-show DEFER/REACTIVATE sub-paths (`awaitingWrittenConfirmationActive`)
- Explicit assertions for post no-show terminal writes (folio closure/state, entry terminal stage, determination record)
- Guest-present negative case
- “Advance payment reconciled” negative case
- “No-show cutoff fired blocks exit unless reactivated” gate
- S5→S1 re-entry route (“config error · FOM”)

