# S7 Live stay flowchart coverage vs automated tests

This document compares what the **Layer 03C deep‑dive → 3c.1 “S7 · Stay / Event Management — operational flow”** flowchart in `LEGPHEL_Implementation_Reference_v1_1.html` describes, versus what our automated S7 tests actually execute:

- **Test report**: `Documentation/S7-test-report.md`
- **Test runner**: `back_end/scripts/s7-acceptance-tests.ts`

It answers: **which flowchart nodes/branches are tested** and **which are not**.

---

## Flowchart sections and coverage

### 1) Entry routes
Flowchart shows multiple routes:
- **Forward from S6 (standard)** (folio LIVE, room OCCUPIED, H2+H3 accepted)
- Returns from re-entry paths: S7→S1 (room change), S7→S2/S3/S4 (amendments), and S8→S7 (additional charge, no new segment)

**Tested**
- **“Already in S7”** assumption: the seed creates an entry directly at `Entry.currentStage = S7`, and tests operate on it.

**Not tested**
- The exact “forward from S6” prerequisites (H2/H3 acceptance) — our seed creates H4 and a minimal state; it does not model H2/H3 acceptance states for S7 entry.
- Return from S8→S7 path.
- Return from S7→S2/S3/S4 amendment loops.

---

### 2) Continuous live loop header
Flowchart emphasises S7 is **continuous** with repeated daily operations.

**Tested**
- **Night audit idempotency** demonstrates repeated operation semantics for the same operating date (AC-S7-05 idempotency).

**Not tested**
- Multi-day loop orchestration, timer scheduling, or any persistent “daily cycle” runner beyond calling the endpoint twice.

---

### 3) Charge posting pipeline (`FolioService.postCharge`)
Flowchart indicates:
1) Tax engine per charge
2) FolioLine written immutably
3) Credit ceiling monitor evaluation
Also: “offsetting line only” for corrections; no phantom charges.

**Tested**
- **Immutability**: charge creates a `folio_lines` row; corrections create a second row (AC-S7-01, AC-S7-02).
- **Sealed date rule**: after a COMPLETE night audit, backdated posting to that operating date is forbidden (AC-S7-03).

**Not tested**
- Tax engine calculation (not implemented in this slice).
- “Every line anchored to operational event” (no event model in this slice).
- 75%/90%/100% credit ceiling notification semantics:
  - The flowchart describes advisory vs active interruption vs soft gate; the S7 suite does not assert those notification tiers.
  - The code currently writes `credit_ceiling_threshold_events` opportunistically, but tests do not verify 75/90/100 behaviours.
- “ROOM_CHARGE always posts through at 100%+” (the rule exists in design; tests do not exercise a 100% ceiling scenario with mandatory room charge vs non-mandatory charge).

---

### 4) Nightly audit cycle (`NightAuditEngine.runAudit`)
Flowchart indicates:
- Room charges posted
- `night_audit_records` written and immutable (`@unique(operatingDate)`)
- Missing expected charges create `night_audit_anomalies` (never auto-post)
- Idempotent double-run does not duplicate

**Tested**
- Night audit creates a record (AC-S7-05).
- Missing expected F&B charge produces anomaly (AC-S7-04).
- Idempotent re-run does not duplicate folio lines (AC-S7-05-idempotent).

**Not tested**
- PARTIAL vs FAILED run statuses and escalation behaviours (flowchart implies governance; the S7 suite only exercises COMPLETE).

---

### 5) Post-audit seal
Flowchart callout: once audit COMPLETE exists for an operating date, posting to that date is forbidden.

**Tested**
- Covered directly by AC-S7-03 (posting on sealed operating date returns `StateTransitionError` with `SEALED_AUDIT_DATE`).

---

### 6) Amendment required? → re-entry paths
Flowchart: in-stay amendments route through re-entry:
- S7→S1 room change (new segment)
- S7→S2 rate/meal plan
- S7→S3 billing/payment
- S7→S4 date extension
No in-place edits.

**Tested**
- **Not covered by S7 acceptance tests**.

Notes:
- The backend includes an implementation for **room change re-entry** (`POST /entries/:id/amend` with `amendmentType=ROOM_CHANGE`) which creates a new segment and moves to S1, but the S7 test suite currently does not execute it.

---

### 7) DEFICIENT conditions and disputes (concurrent)
Flowchart indicates:
- DEFICIENT records are resolved additively (do not overwrite detection)
- Dispute state machine
- “DEFICIENT final status required at S8 entry”

**Tested**
- Dispute flow is covered enough to enforce the **S7→S8 dispute gate** with GM override (AC-S7-17, AC-S7-18, AC-S7-19).

**Not tested**
- Deficient condition resolution additive writes (housekeeping resolution event).
- The S7→S8 “DEFICIENT final status must be RESOLVED/UNRESOLVED” gate is present in `progressStageS7ToS8`, but the S7 test suite does not create a malformed deficient record to assert the blocking condition.
- Detailed dispute lifecycle beyond OPEN + override (IN_PROGRESS, RESOLVED paths).

---

### 8) Final-night audit COMPLETE before exit
Flowchart: final stay night audit must be COMPLETE before exiting S7.

**Tested**
- Indirectly: the test runs night audit for the expected last operating night (based on seed checkout) before attempting S7→S8, so the “audit COMPLETE” precondition is satisfied.

**Not tested**
- Negative case: attempting S7→S8 without audit COMPLETE returning `StageGateBlockedError` with `NIGHT_AUDIT_NOT_COMPLETE`.

---

### 9) H4 initiate + final charge sweep
Flowchart: create H4 + final sweep of charges; same-day departure auto-fulfills H4.

**Tested**
- H4 existence is assumed by seed and asserted in script setup (H4 must exist).

**Not tested**
- H4 creation route (the seed inserts an H4 row; tests do not call an API to create it).
- Same-day departure auto-fulfilment behaviour.
- “Final charge sweep” semantics (posting all known charges before exit).

---

### 10) Dispute gate + GM override
Flowchart: dispute gate can block; GM override available only at S7→S8.

**Tested**
- Open dispute blocks S7→S8 with `PolicyGateBlockedError` (AC-S7-17).
- GM override creation unblocks (AC-S7-18).
- Override not allowed for S9 target stage (AC-S7-19).

---

### 11) Exit gate S7 → S8 (5 conditions)
Flowchart S7 exit guard conditions:
1) final-night audit COMPLETE
2) all known charges posted
3) H4 initiated
4) DEFICIENT final status RESOLVED/UNRESOLVED
5) dispute gate clear/override

**Tested**
- (1) satisfied by setup night audit; not tested as negative case.
- (3) satisfied by seed; not tested via API creation.
- (5) tested explicitly (block then GM override).

**Not tested**
- (2) “all known charges posted” as a formal gate (not asserted).
- (4) DEFICIENT final status gate as a negative/positive case.
- Full set of negative tests for each exit condition.

---

## Summary: tested vs not tested (high-signal)

### ✅ Covered well by automated S7 suite
- Charge posting immutability (append-only folio lines) and correction via offsetting line
- Sealed night audit date blocks backdated posting
- Night audit: record write, anomaly write, idempotency
- Dispute gate blocks S7→S8 until GM override; override scope restriction (not for S9)
- Optimistic lock `version` required for S7→S8

### ⚠️ Present in the flowchart but not covered (or only indirectly covered)
- Tax engine / pricing pipeline and event anchoring for charges
- Credit ceiling tiered notifications + hard rules around mandatory room charges at 100%+
- Amendments via re-entry (S7→S1/S2/S3/S4) exercised end-to-end
- DEFICIENT resolution additive events + S7→S8 deficient-gate negative case
- H4 creation endpoint + same-day auto-fulfilment
- Final charge sweep gate
- Return-from-S8→S7 path

