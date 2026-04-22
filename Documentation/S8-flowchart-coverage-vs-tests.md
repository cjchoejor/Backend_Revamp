# S8 Checkout flowchart coverage vs automated tests

This document compares what the **Layer 03C deep‑dive → 3c.2 “S8 · Checkout & Settlement — operational flow”** flowchart in `LEGPHEL_Implementation_Reference_v1_1.html` describes, versus what our automated S8 tests actually execute:

- **Test report**: `Documentation/S8-test-report.md`
- **Test runner**: `back_end/scripts/s8-acceptance-tests.ts`

It answers: **which flowchart nodes/branches are tested** and **which are not**.

---

## Flowchart sections and coverage

### 1) Entry routes
Flowchart entry routes:
- **Forward from S7 (standard)** — all S7 exit guards satisfied
- **Early departure** — compressed S7→S8 (GM authority)
- **Re-entry S8→S7** — additional charge, no new segment
- **Re-entry S8→S2** — rate dispute, full renegotiation

**Tested**
- **Forward from S7 (standard)**: the S8 test script progresses a seeded S7 entry to S8 using `POST /entries/:id/progress-stage` with `targetStage="S8"` after ensuring the final-night audit is COMPLETE (setup step `SETUP-S7->S8`).

**Not tested**
- Early departure compressed entry (GM authority).
- Re-entry S8→S7 to post additional charges, and then re-progress to S8.
- Re-entry S8→S2 for renegotiation.

---

### 2) Checkout begins (`CheckOutService.checkOut` departure transaction)
Flowchart emphasises the departure as an **atomic transaction** that rolls back on guard failure.

**Tested**
- **Indirectly**: our suite validates multiple effects that are intended to be coupled to checkout/settlement flows (e.g., settlement → room becomes `DEPARTED_DIRTY` + W24 timer).

**Not tested**
- A true rollback/atomicity fault injection test (e.g., force failure mid-write and assert no partial commits).

---

### 3) “Folio compile + H4 reconcile”
Flowchart:
- Bill must reflect H4 returns (housekeeping + F&B)
- H4 progresses `ACCEPTED → FULFILLED` with evidence
- Presenting unreconciled bill is forbidden

**Tested**
- H4 fulfilment evidence completeness is tested:
  - **AC-S8-17** confirms incomplete evidence is rejected with `H4_FULFILMENT_EVIDENCE_INCOMPLETE`
  - `SETUP-H4-FULFIL` fulfils H4 with complete evidence

**Not tested**
- Explicit “compile bill vs H4 returns” reconciliation logic (no bill compilation engine exists in this slice).
- A dedicated “present unreconciled bill forbidden” API (not present as a route).

---

### 4) Decision: “Unposted charges remain?” (re-entry S8→S7)
Flowchart:
- If YES: return to S7 to post charges (FOM authority), cancel CHECKOUT_TIME, set H4 to IN_PROGRESS

**Tested**
- Not explicitly tested.

**Not tested**
- The re-entry S8→S7 path and its side effects (timer cancellation, H4 in-progress).
- “Known unposted charge blocks settlement” as a hard guard (our S8 slice does not model “known but unposted” charge obligations yet).

---

### 5) Settlement (`FolioService.initiateSettlement`)
Flowchart:
- Executes per billing model (guest-pay / direct-bill / voucher)
- Outcomes: `Folio.state → SETTLED` OR `OUTSTANDING`
- “Auto-SETTLED with balance remaining” is forbidden

**Tested**
- **Guest-pay SETTLED** path:
  - **AC-S8-06** calls `POST /folios/:id/settle` with `settlementMethod=CASH` and asserts `Folio.state = SETTLED`.

**Not tested**
- **Partial payment → OUTSTANDING** path (flowchart notes W8 at S9).
- **Direct-bill → OUTSTANDING + invoice dispatched**.
- **Voucher settlement path**.
- Forbidden pattern: attempting to force SETTLED with a remaining balance.

---

### 6) Key return (`KeyReturnRecord`)
Flowchart:
- `countReconciled = true` or discrepancy governed by reconciliation note

**Tested**
- **AC-S8-25**: discrepancy note required (ValidationError if missing)
- **AC-S8-26**: discrepancy with reconciliationNote is accepted and should satisfy exit gate

---

### 7) Inspection decision: complete now vs defer (W9)
Flowchart:
- Deferral requires explicit event + W9 timer; silent deferral forbidden
- Window controlled by `inspection.postCheckout.windowDays`

**Tested**
- **AC-S8-14** creates an inspection record with `isDeferred=true` and asserts `deficientFlagStatus` is present
- **AC-S8-23** confirms W9 timer exists after deferral
- **AC-S8-15**: rejects `deficientFlagStatus=NOT_APPLICABLE` when unresolved deficient exists

**Not tested**
- “Complete now” inspection path (non-deferred) as a dedicated positive assertion.
- W9 lapse/expiry behaviour and FOM escalation (“lapsed” state on the flowchart side panel).
- Explicit “silent deferral forbidden” via a separate deferral event model (we model deferral as `RoomInspectionRecord.isDeferred=true` + timer).

---

### 8) Room transition: `OCCUPIED → DEPARTED_DIRTY` (never DEPARTED_CLEAN)
Flowchart:
- Mandatory path to `DEPARTED_DIRTY`
- W24 housekeeping SLA timer registered
- Inventory claim remains CONFIRMED; release is S9’s action

**Tested**
- **AC-S8-01**: room becomes `DEPARTED_DIRTY` after settlement flow
- **AC-S8-03**: W24 timer is registered (`timer_records.timer_code = HOUSEKEEPING_SLA_W24`)

**Not tested**
- Forbidden `OCCUPIED → DEPARTED_CLEAN` attempt returning `INVALID_ROOM_STATE_TRANSITION`.
- Assertion that reservation-level claim remains CONFIRMED (the system models claim state on `rooms.currentClaimState`; “reservation claim remains CONFIRMED” is not separately represented in this slice).

---

### 9) H5 create or auto-fulfil
Flowchart:
- Residual obligations → H5 CREATED
- Clean settlement → H5 auto-fulfilled

**Tested**
- **Indirectly**: the final progression `S8->S9` depends on H5 creation being satisfied by the service (otherwise it would block).

**Not tested**
- Dedicated assertions for:
  - OUTSTANDING produces H5 CREATED with outstanding basis payload
  - SETTLED with no residual obligations produces H5 auto-fulfilled

---

### 10) S8→S9 exit guard (7 conditions, dispute gate has NO override)
Flowchart exit conditions:
1) folio SETTLED/OUTSTANDING
2) keys returned
3) room DEPARTED_DIRTY
4) inspection complete or deferred (W9)
5) no unposted charges
6) H5 created/auto
7) dispute gate CLEAR only (BLOCKED has no override)

**Tested**
- **DISPUTE gate (no override)**:
  - **AC-S8-11**: open dispute blocks S8→S9 with `StageGateBlockedError` `DISPUTE_GATE_BLOCKED`
  - **AC-S8-12**: attempting `targetStage=S9` gate override is rejected
  - **AC-S8-13-setup**: GM closes dispute
- **Successful S8→S9** after satisfying settlement + key return + inspection + H4 fulfil + dispute clear (`S8->S9`)

**Not tested**
- “No unposted charges” as a separately enforced condition (no “known-unposted-charge” model in this slice).
- Dedicated negative tests for each individual exit gate (e.g., missing key return blocks with `KEY_RETURN_NOT_RECORDED`, etc.).

---

## Summary: tested vs not tested (high-signal)

### ✅ Covered well by automated S8 suite
- Forward entry S7→S8 setup
- Key return discrepancy governance
- Inspection governance with W9 deferral timer and DEFICIENT flag requirements
- Guest-pay settlement to SETTLED
- Physical departure room transition to DEPARTED_DIRTY + W24 timer registration
- H4 fulfilment evidence completeness
- Dispute gate at S8→S9 is BLOCKED with **no override**, and GM closure clears the gate
- End-to-end S8→S9 progression when prerequisites are satisfied

### ⚠️ Present in the flowchart but not covered (or only indirectly covered)
- Early departure compressed entry route (GM)
- Re-entry S8→S7 (additional charges) and S8→S2 (renegotiation)
- “Unposted charges remain?” decision logic and its enforcement
- Direct-bill and voucher settlement paths; partial payment OUTSTANDING path
- Forbidden room transition `OCCUPIED → DEPARTED_CLEAN` negative test
- W9 expiry/lapse behaviour and FOM escalation
- Explicit assertions for H5 auto-fulfil vs created payload details

