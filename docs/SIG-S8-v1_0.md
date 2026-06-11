# SIG-S8 — Stage 8: Checkout & Settlement
## Stage Implementation Guideline

**Document ID:** SIG-S8
**Version:** 1.0
**Date:** 15 April 2026
**Architect:** Dhendup Cheten, Fuzzy Automation
**Project:** LEGPHEL PMS
**Status:** LOCKED — Architect: Dhendup Cheten, Fuzzy Automation, 15 April 2026

---

## Document Control

| Field | Value |
|---|---|
| SIG version | 1.0 |
| Produced by | AI Architectural Partner (Claude, Anthropic) |
| Source files loaded | Block 8 — S8 charter full; SIG-S7-v1_0.md §§1.3, 2, 3, 6; ACTOR-AUTHORITY-MATRIX-LOCKED.md S8 rows; DEV-SPEC-001-Part3.md; DEV-SPEC-001-Part4.md; DEV-SPEC-001-Part5-REV2.md; DEV-SPEC-001-Part2-REV2-FINAL.md; DEV-SPEC-001-Part6-REV3.md; DEV-SPEC-001-Part8.md; DEV-SPEC-001-Part9-REV1.md; DEV-SPEC-001-Part12.md; MASTER-CORRECTION-LOG-v2_1.md |
| MCL version | v2.1 |
| Prerequisites | SIG-S7 v1.0 locked; MCL v2.1 locked |

**Schema findings registered in this document:**

| Finding ID | Model | Status |
|---|---|---|
| SIG-S8-COR-001 | `RoomInspectionRecord` absent from Part 2 REV2-FINAL | Derived in §2.4; Part 2 backfill required |
| SIG-S8-COR-002 | `KeyReturnRecord` absent from Part 2 REV2-FINAL | Derived in §2.5; Part 2 backfill required |

**MCL PENDING items absorbed as positive assertions:** MC-010 (dotted notation in worker descriptions), MC-011 (`version` field in `ProgressStageRequestDTO`), MC-013 (dotted notation in config keys).

---

## §1 — Stage Identity

### 1.1 Name and Purpose

**Stage name:** Checkout & Settlement
**Stage code:** S8

S8 governs the guest's departure. The folio is compiled, verified against housekeeping and F&B returns, and presented for settlement. Settlement executes according to the applicable billing model. The room is inspected, keys are returned, and the room physical state transitions to DEPARTED_DIRTY for housekeeping turnover. All operational residue — unsettled balances, outstanding invoices, unresolved disputes, post-stay obligations — is either resolved at S8 or explicitly transferred forward through H5. The stage exits only when the financial record is settled or governed-outstanding, the room is DEPARTED_DIRTY, and H5 is created or auto-fulfilled.

### 1.2 Entry Routes

| Route | Entry condition | Mode |
|---|---|---|
| Forward from S7 | Night audit complete for final stay night; all known charges posted; H4 initiated (CREATED, ACCEPTED, or auto-fulfilled); DEFICIENT condition final status recorded on all active flags; dispute gate returns CLEAR or BLOCKED_WITH_OVERRIDE_AVAILABLE | Standard |
| Early departure | Guest departs before confirmed checkout date; night audit complete for all nights already stayed; Early Departure mode compresses S7→S8 transition; charges for unstayed nights governed by cancellation/early departure policy against commitment snapshot | Early Departure mode |
| Re-entry from S8→S7 | Additional charge discovered after S8 initiation; FOM authority; entry returns to S7 for charge posting; no new segment created; CHECKOUT_TIME timer cancelled; H4 returns to IN_PROGRESS | Re-entry |
| Re-entry from S8→S2 | Rate dispute at checkout requiring full renegotiation; FOM/GM authority; new segment created; folio revision pending; CHECKOUT_TIME timer cancelled; H4 returns to IN_PROGRESS; inventory remains DEPARTED_DIRTY pending resolution | Re-entry |

### 1.3 Exit Conditions (S8→S9)

All conditions must be satisfied before the S8→S9 transition may proceed. A failure on any condition produces `StageGateBlockedError` identifying the specific unsatisfied condition.

| Exit condition | Description |
|---|---|
| Folio settled or governed-outstanding | `FolioState` must be `SETTLED` or `OUTSTANDING`. A folio in `LIVE` state blocks S8 exit unconditionally. |
| Keys returned | `KeyReturnRecord` must exist for the entry with `countReconciled = true` or a recorded reconciliation note for count discrepancy. |
| Room DEPARTED_DIRTY | `Room.currentClaimState = DEPARTED_DIRTY`. The room must have transitioned from OCCUPIED through DEPARTED_DIRTY — the direct OCCUPIED→DEPARTED_CLEAN transition is the forbidden pattern. |
| Room inspection complete or governed-deferred | A `RoomInspectionRecord` with `deficientFlagStatus` written must exist, or inspection must be explicitly deferred with a post-checkout deferral event recorded and W9 timer registered. Silence is not a valid deferral. |
| All final charges posted | No known charge obligations may remain unposted at settlement. If the hotel knows about a charge, it must be posted before folio settlement. |
| H5 created or auto-fulfilled | `HandoffRecord` of type H5 must be in CREATED state (with residual obligations) or auto-fulfilled (`isAutoFulfilled = true`). |
| Dispute gate returns CLEAR | `DisputeGateEngine.canProgressStage(entryId, S9)` must return `CLEAR`. If any dispute is OPEN or IN_PROGRESS, the engine returns `BLOCKED` — no override is available at S8→S9. The dispute must reach RESOLVED or CLOSED (GM authority with recorded reason) before S9 entry is permitted. |

### 1.4 Governing Actors

| Role | Authority level | S8 scope |
|---|---|---|
| Front desk custodian | L1 | Folio compilation and verification; folio presentation; settlement execution (all billing models); key return recording; room inspection coordination; H5 creation trigger |
| FOM | L2 | UNRESOLVED DEFICIENT condition review before any damage charge against guest; charge waivers and discount authority per amendment authority policy; rate dispute requiring renegotiation; overdue night audit acknowledgement at checkout; credit ceiling excess acknowledgement |
| GM | L3 | Dispute closure (CLOSED state with recorded reason) enabling S8→S9 exit; rate dispute renegotiation authorisation at S8→S2 re-entry; early departure authorisation |
| System | L0 | Room physical state transition to DEPARTED_DIRTY on checkout completion; H5 auto-fulfilment; W33 FOM override frequency pattern detection and GM ambient notice |

### 1.5 Forbidden Actions at S8

**Modifying sealed folio lines.** FolioLine records are immutable after posting. Corrections are expressed as new offsetting lines — never as edits to the original record.

**Waiving charges without authority.** Charge waivers and discounts at checkout require the authority level defined in the amendment authority policy. Front desk cannot unilaterally remove charges. The service recovery framework governs compensation.

**Releasing the room from CONFIRMED inventory claim.** The room transitions to DEPARTED_DIRTY (physical state) at checkout. The `InventoryClaimState` remains CONFIRMED until S9 formally closes the reservation. DEPARTED_DIRTY is a physical state change only — not a claim release. A room in DEPARTED_DIRTY may not be reassigned without first completing S9 closure and claim release.

**Presenting a bill that has not been reconciled with housekeeping and F&B.** The bill must reflect the hotel's complete knowledge of what the guest consumed and owes. A bill not verified against H4 returns from housekeeping and F&B is an unreconciled bill and may not be presented.

**Settling a bill with known unposted charges.** If the hotel knows about a charge that has not been posted, settlement must wait. Post-settling and then posting the charge as a post-stay item when it could have been included at checkout is operationally forbidden.

**Allowing departure with a BLOCKED dispute without override record.** If the dispute gate returns BLOCKED_WITH_OVERRIDE_AVAILABLE at any S8 sub-gate, departure cannot proceed without a recorded `DisputeGateOverrideRecord`. At S8→S9 specifically, the gate returns BLOCKED (no override available) — departure is categorically blocked until the dispute reaches RESOLVED or CLOSED.

**Skipping room inspection entirely.** Room inspection may be deferred to the post-checkout window if the guest is departing urgently, but it may not be skipped. Deferral requires explicit invocation — a deferral event recorded and W9 timer registered. Silence is not a valid deferral.

**Treating an UNRESOLVED DEFICIENT condition as the guest's problem without FOM review.** A DEFICIENT condition present from the start of the stay represents a hotel-side service failure. Automatically assessing damage against a guest for a room that carried a pre-existing DEFICIENT condition, without FOM review of the inspection record, is forbidden.

**OCCUPIED→DEPARTED_CLEAN direct transition.** The room must pass through DEPARTED_DIRTY. Housekeeping action is the mandatory intermediate step. A room transitioning from OCCUPIED directly to DEPARTED_CLEAN is a state integrity violation.

---

## §2 — Schema Models Active at S8

### 2.1 Schema Overview

S8 reads the live folio with all posted charges, the commitment snapshot, all payment history, H4 returns, dispute records, DEFICIENT condition records, and the credit extension ceiling. It creates: the settlement record (expressed through `FolioState` transition + `PaymentRecord`), the final invoice, the room inspection record, the key return record, the H5 handoff, and FOM override records where applicable. The `FolioLine` model may receive final-morning charge postings before settlement.

The following models are created, updated, or read at S8.

### 2.2 FolioLine — Final-Morning Charge Posting

**Model:** `FolioLine` (Part 2 §2.4)
**Stage relevance:** Final-morning charges (breakfast, last-minute services) are posted to the live folio before settlement. The same postCharge mechanics from S7 apply.

**Mutation rules:**
- `FolioLine` records are immutable from creation. All final-morning charge lines are created before `FolioService.initiateSettlement()` is called.
- Every charge posting invokes `TaxEngine.calculate()` before writing the line.
- For credit-ceiling-monitored entries, `CreditCeilingMonitorEngine.evaluate()` is called after each `FolioLine` write.
- Post-settlement charge posting via FolioLine is forbidden for charges that were known before settlement.

### 2.3 Folio and FolioState Transitions

**Model:** `Folio` (Part 2 §2.4; Part 3 §3.3)
**Stage relevance:** The folio transitions from `LIVE` to a terminal state at S8. Two terminal paths are available.

**FolioState transitions at S8:**

| From | To | Trigger | Guard |
|---|---|---|---|
| `LIVE` | `SETTLED` | Settlement event — all charges cleared; payment received or invoice dispatched covering full balance | `FolioService.initiateSettlement()` — Policy 22, Policy 33, Policy 46 all pass; no outstanding balance |
| `LIVE` | `OUTSTANDING` | Governed-outstanding determination — balance remains; partial payment recorded; remainder explicitly governed as S9 follow-up | `FolioService.initiateSettlement()` — outstanding balance confirmed; `PolicyGateBlockedError` does NOT fire; `OUTSTANDING` is the governed path for residual balances |

**Settlement record note:** Settlement is not expressed as a separate `SettlementRecord` model in Part 2 REV2-FINAL. Settlement is expressed through the `FolioState` transition event (`LIVE → SETTLED` or `LIVE → OUTSTANDING`), the associated `PaymentRecord` records, and the `TraceEvent` with type `SETTLEMENT_EVENT`. No separate settlement model exists. The `TraceEvent` carries: entryId, folioId, settlementMethod, billingModel, totalSettled, outstandingAmount (if any), actorId, and timestamp.

**Mutation rules:**
- `Folio.state` transitions are performed exclusively by `FolioService.initiateSettlement()`. No other code path may produce this transition.
- Once `SETTLED` or `OUTSTANDING`, the folio is sealed. Post-closure access operates through additive layers only (Level 2 FOM additive; Level 3 GM corrections).
- `LIVE → PROVISIONAL` reversion is the forbidden pattern and must never be implemented at any stage.

### 2.4 RoomInspectionRecord — SIG-S8-COR-001

**Finding:** `RoomInspectionRecord` is referenced in the S8 stage charter records section and in Policy 51 (Part 5 REV2), but no `model RoomInspectionRecord { ... }` Prisma block exists in Part 2 REV2-FINAL. The model is absent from the schema.

**Action:** Schema derived from CheckOutService spec (Part 6 REV3 §6.5.21), Policy 51 (Part 5 REV2), and S8 charter obligations. Derived spec carried below. Developer implements from this derived spec. Part 2 backfill required.

**Derived schema:**

```prisma
model RoomInspectionRecord {
  id                    String    @id @default(uuid())
  entryId               String
  roomId                String
  segmentId             String

  inspectedBy           String    // actorId — housekeeping actor performing inspection
  inspectedAt           DateTime  // when inspection was performed

  isDeferred            Boolean   @default(false)
  // true = post-checkout deferral; false = pre-departure inspection
  // deferral requires explicit invocation and W9 timer registration

  deficientFlagStatus   String
  // Values: RESOLVED | UNRESOLVED_AT_CHECKOUT | NOT_APPLICABLE
  // Mandatory regardless of whether inspection is pre- or post-checkout.
  // DEFICIENT_UNRESOLVED_AT_CHECKOUT is a permanent state on the stay record —
  // cannot be retroactively resolved after checkout.

  deficientConditionId  String?   // FK → DeficientConditionRecord.id if applicable
  inspectorAssessment   String?
  // Required when deficientFlagStatus = UNRESOLVED_AT_CHECKOUT:
  // inspector records whether condition warrants charge reduction (service recovery)
  // or damage assessment against hotel; whether condition was sufficiently disclosed

  damageFound           Boolean   @default(false)
  damageNotes           String?   // description of damage found (if damageFound = true)

  createdAt             DateTime  @default(now())

  entry                 Entry     @relation(fields: [entryId], references: [id])
  room                  Room      @relation(fields: [roomId], references: [id])

  // Mutation rule: immutable from creation. The inspection record including
  // DEFICIENT flag status is sealed on write. Corrections require a post-closure
  // additive record under FOM authority.
  @@map("room_inspection_records")
}
```

**SIG-S8-COR-001** — Part 2 REV2-FINAL backfill required. Add `model RoomInspectionRecord` as defined above. Add `roomInspectionRecords RoomInspectionRecord[]` back-relation to `Entry` and `Room` models.

### 2.5 KeyReturnRecord — SIG-S8-COR-002

**Finding:** `KeyReturnRecord` is referenced in the S8 stage charter records section but no `model KeyReturnRecord { ... }` Prisma block exists in Part 2 REV2-FINAL. The model is absent from the schema.

**Action:** Schema derived from CheckOutService spec (Part 6 REV3 §6.5.21) and S8 charter obligations. Derived spec carried below. Developer implements from this derived spec. Part 2 backfill required.

**Derived schema:**

```prisma
model KeyReturnRecord {
  id                   String   @id @default(uuid())
  entryId              String
  roomId               String

  receivedBy           String   // actorId — front desk actor receiving keys
  returnedAt           DateTime

  keyCountIssued       Int      // count from key issuance record at S6
  keyCountReturned     Int      // count of keys physically returned at checkout
  countReconciled      Boolean
  // true = counts match; false = discrepancy; reconciliation note required when false

  reconciliationNote   String?
  // Required when countReconciled = false.
  // Documents the discrepancy and the governed resolution
  // (e.g., guest states lost key; charge assessed per damage rate list).

  createdAt            DateTime @default(now())

  entry                Entry    @relation(fields: [entryId], references: [id])
  room                 Room     @relation(fields: [roomId], references: [id])

  // Mutation rule: immutable from creation.
  @@map("key_return_records")
}
```

**SIG-S8-COR-002** — Part 2 REV2-FINAL backfill required. Add `model KeyReturnRecord` as defined above. Add `keyReturnRecords KeyReturnRecord[]` back-relation to `Entry` and `Room` models.

### 2.6 PaymentRecord

**Model:** `PaymentRecord` (Part 2 §2.4)
**Stage relevance:** Payment records are created at S8 for guest-pay settlement. For direct-bill and voucher paths, payment records are created when payment is received post-departure (S9).

**Mutation rules:**
- `PaymentRecord` is immutable from creation. No update or amendment path exists.
- A refund is a new `PaymentRecord` with `paymentDirection = OUT` — not a reversal of the original record.
- `PaymentRecord` creation is owned exclusively by `FolioService.recordPayment()`. No other code path may write payment records.
- For cash payments: counterfeit verification must be completed before the payment record is written. The payment record carries a `verificationEvent` reference.
- For mobile payments: proof of payment screenshot with verified date and time is recorded. The payment record carries the verification reference.

### 2.7 Invoice

**Model:** `Invoice` (Part 2; Part 3 §3.10)
**Stage relevance:** The final invoice is generated and dispatched at S8 for direct-bill and voucher billing models. For guest-pay, a final invoice is issued after settlement for record purposes.

**Mutation rules:**
- `Invoice.invoiceType = FINAL` for checkout invoices. Proforma invoices issued at earlier stages that are superseded by the final invoice transition to `InvoiceState.SUPERSEDED`.
- `Invoice` records are not editable after dispatch. Post-settlement corrections are credit notes or adjustment entries — never modifications to the issued invoice.
- For government entities: the invoice follows the government payment portal process. `Invoice.state` transitions to `DISPATCHED` upon submission to the portal; `PAYMENT_TRACKED` on payment receipt.

### 2.8 HandoffRecord — H4 Completion and H5 Creation

**Model:** `HandoffRecord` (Part 2 §2.6; Part 3 §3.9)
**Stage relevance:** H4 is fulfilled at S8. H5 is created at S8 exit.

**H4 completion — mutation rules:**
- H4 fulfils when housekeeping and F&B confirm their pre-checkout status: all charges posted, room inspection status recorded, damage assessment complete or explicitly deferred, DEFICIENT condition final status reported.
- `HandoffService.fulfil()` writes the fulfilment evidence. `HandoffRecord.state` transitions to FULFILLED.
- H4 fulfilment is a mandatory S8 exit condition — an unfulfilled H4 blocks checkout unless explicitly deferred under the early departure compression path.

**H5 creation — mutation rules:**
- H5 is created by `HandoffService.create()` at S8 exit for entries with outstanding financial obligations: unsettled balance (`FolioState.OUTSTANDING`), pending invoice payment, commission settlement obligation, or post-stay charge expectation.
- H5 carries: the complete folio reference, the settlement record (TraceEvent), the outstanding amount and its basis, active dispute records (if any), and the credit extension ceiling final status.
- `HandoffRecord.handoffType = H5`.
- When settlement is complete and no residual obligations exist, H5 auto-fulfils: `HandoffRecord.isAutoFulfilled = true`; a `TraceEvent` with type `HANDOFF.AUTO_FULFILLED` is produced. The audit record exists in every case.

### 2.9 DeficientConditionRecord — Final Status Write

**Model:** `DeficientConditionRecord` (Part 2; Part 3 §3.7; SIG-S7 §2.6)
**Stage relevance:** `DeficientConditionRecord.finalStatus` is written at S8 room inspection. This is a mandatory write before the S8→S9 transition.

**Mutation rules:**
- `DeficientConditionRecord.finalStatus` is written by `CheckOutService.checkOut()` as the enforcement point for Policy 51.
- If the condition was RESOLVED during S7: `finalStatus = "RESOLVED"` with the resolution event reference.
- If the condition remains UNRESOLVED at checkout: `finalStatus = "UNRESOLVED_AT_CHECKOUT"`. This is a permanent state on the stay record — it cannot be retroactively resolved after checkout.
- The inspector's assessment (recorded in `RoomInspectionRecord.inspectorAssessment`) determines whether the UNRESOLVED condition warrants a charge reduction as service recovery or a damage assessment against the hotel.
- Charging the guest for damage attributed to an UNRESOLVED DEFICIENT condition without FOM review is forbidden. FOM reviews the `RoomInspectionRecord.inspectorAssessment` before any such charge proceeds.
- `finalStatus` on `DeficientConditionRecord` is immutable once written.

### 2.10 DisputeRecord and DisputeGateOverrideRecord

**Models:** `DisputeRecord`, `DisputeGateOverrideRecord` (Part 2 §2.9; Part 3 §3.4)
**Stage relevance:** Disputes active from S7 continue through S8. `DisputeGateOverrideRecord` may be created during S8 (at sub-gates before S8→S9). At S8→S9, no override record may authorise passage of an unresolved dispute.

**Mutation rules:**
- `DisputeRecord` status transitions through the standard lifecycle: OPEN → IN_PROGRESS → RESOLVED | CLOSED. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.
- GM authority (L3) is required for CLOSED state. A guest who declines all offered resolutions reaches CLOSED with mandatory recorded reason.
- `DisputeGateOverrideRecord` is immutable from creation. It is produced by the service layer — not the engine — when GM invokes the override at a sub-gate during S8. Created with: GM actor identity, override reason (mandatory free-text), dispute reference, target stage, gate return value, and timestamp.
- No `DisputeGateOverrideRecord` may be created for an S8→S9 attempt. The engine returns `BLOCKED` at S8→S9 for any OPEN or IN_PROGRESS dispute. A request to create an override record at S8→S9 is rejected with `PolicyGateBlockedError`.

### 2.11 WorkOrder — Closure at S8

**Model:** `WorkOrder`, `WorkOrderToDoItem` (Part 2 §2.8; SIG-S7 §2.9)
**Stage relevance:** Conference and group engagements. The work order closes at S8 when all to-do items are COMPLETED or CANCELLED with recorded reason.

**Mutation rules:**
- `WorkOrder.state` transitions to CLOSED at S8. Closure requires all `WorkOrderToDoItem` records to be in COMPLETED or CANCELLED state. A `closureNote` is mandatory.
- `WorkOrderToDoItem` in CANCELLED state requires a recorded reason before the work order may close.
- `WorkOrderConsumptionRecord` records created during S7 are read at S8 for final billing reconciliation. No new consumption records are created at S8 unless a final service delivery event occurs.

---

## §3 — State Machine at S8

### 3.1 Entry State at S8

On entry to S8, the system holds:
- `Entry.currentStage = S8`
- `Folio.state = LIVE` (all charges posted through night audit; all known charges reconciled)
- `Room.currentClaimState = OCCUPIED` (transitioning to DEPARTED_DIRTY at checkout completion)
- `HandoffRecord` H4 in CREATED, ACCEPTED, or auto-fulfilled state
- All `DeficientConditionRecord` records on the room carry a final status (RESOLVED or UNRESOLVED — per S7 exit condition)
- `DisputeRecord` records: any status; gate evaluation at S8→S9 determines the blocking condition

### 3.2 S8→S9 Transition Guard

| Guard condition | Blocking model | Consequence if not satisfied |
|---|---|---|
| `Folio.state IN [SETTLED, OUTSTANDING]` | `Folio` | `StageGateBlockedError`: `blockingCondition: 'FOLIO_NOT_SETTLED'` |
| `KeyReturnRecord` exists for entry | `KeyReturnRecord` | `StageGateBlockedError`: `blockingCondition: 'KEY_RETURN_NOT_RECORDED'` |
| `Room.currentClaimState = DEPARTED_DIRTY` | `Room` | `StageGateBlockedError`: `blockingCondition: 'ROOM_NOT_DEPARTED_DIRTY'` |
| `RoomInspectionRecord` exists (or deferral event + W9 registered) | `RoomInspectionRecord` / `TraceEvent` | `StageGateBlockedError`: `blockingCondition: 'INSPECTION_NOT_COMPLETE_OR_DEFERRED'` |
| No known unposted charges | `FolioLine` / `TraceEvent` | `StageGateBlockedError`: `blockingCondition: 'UNPOSTED_CHARGES_REMAIN'` |
| `HandoffRecord` H5 in CREATED or auto-fulfilled | `HandoffRecord` | `StageGateBlockedError`: `blockingCondition: 'H5_NOT_CREATED'` |
| `DisputeGateEngine.canProgressStage(entryId, S9) = CLEAR` | `DisputeRecord` | `StageGateBlockedError`: `blockingCondition: 'DISPUTE_GATE_BLOCKED'`; no override path available at this gate |

### 3.3 Dispute Gate at S8→S9 — BLOCKED Invariant

`DisputeGateEngine.canProgressStage(entryId, S9)` evaluates all disputes on the entry. If any dispute is in `OPEN` or `IN_PROGRESS` state, the engine **always returns `BLOCKED`** — not `BLOCKED_WITH_OVERRIDE_AVAILABLE`. This is hardcoded in the engine and is not overridable by configuration, authority level, or any runtime parameter. There is no override path at S8→S9 when a dispute is unresolved.

A dispute must reach `RESOLVED` (guest accepts resolution, FOM manages) or `CLOSED` (GM formally closes with mandatory recorded reason) before S9 entry is permitted. This is categorically different from the S7→S8 gate, which returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` and permits a GM override. At S8→S9, GM's role is to close the dispute — not to override the gate.

FOM override frequency tracking (W33, §7.5) applies to S8 sub-gate overrides — not to the S8→S9 gate, which has no override path.

### 3.4 Inventory Claim State — OCCUPIED→DEPARTED_DIRTY Mandate

**The `OCCUPIED → DEPARTED_DIRTY` transition is mandatory at checkout.** The `OCCUPIED → DEPARTED_CLEAN` direct transition is the forbidden pattern.

| From | To | Trigger | Authority |
|---|---|---|---|
| OCCUPIED | DEPARTED_DIRTY | Checkout completion — `CheckOutService.checkOut()` executes room physical state transition | L0 (system, on all S8 exit guards satisfied) |
| DEPARTED_DIRTY | DEPARTED_CLEAN | Housekeeping completion action — housekeeping actor records completion event | L1 (housekeeping) |

**Inventory claim state does NOT change at S8.** `Room.currentClaimState` transitions at the physical state level (`OCCUPIED → DEPARTED_DIRTY`) but `InventoryClaimState` at the reservation level remains `CONFIRMED` until S9 formally closes the reservation and releases the claim. A room in `DEPARTED_DIRTY` may not be reassigned. The claim state transition is a S9 action.

The housekeeping SLA timer (W24, `HOUSEKEEPING_SLA`) is registered by `TimerEngine` on `DEPARTED_DIRTY` transition. The room must reach `DEPARTED_CLEAN` within the configured SLA window.

### 3.5 Folio State Machine at S8

| From | To | Trigger | Guard |
|---|---|---|---|
| LIVE | SETTLED | Settlement event — full balance cleared | `FolioService.initiateSettlement()` — billing model compatibility verified; rate basis validated; credit ceiling check passed or FOM acknowledgement recorded |
| LIVE | OUTSTANDING | Governed-outstanding determination | `FolioService.initiateSettlement()` — outstanding balance confirmed; `FolioState.OUTSTANDING` is the governed terminal path; `PaymentFollowUpWorker` (W8) activates at S9 on OUTSTANDING folio |

`FolioState.LIVE → PROVISIONAL` reversion is the forbidden pattern at all stages.

### 3.6 H4 Fulfilment and H5 Creation Lifecycle

| Transition | Trigger | Guard |
|---|---|---|
| H4: ACCEPTED → FULFILLED | Housekeeping and F&B confirm pre-checkout status | Fulfilment evidence: charges posted, room inspection status, damage assessment complete or governed-deferred, DEFICIENT flag final status reported |
| H5: created | S8 exit with residual financial obligations | `HandoffRecord.handoffType = H5`; carries folio ref, settlement record, outstanding amount, active disputes, credit ceiling final status |
| H5: auto-fulfilled | S8 exit with no residual obligations | `HandoffRecord.isAutoFulfilled = true`; `TraceEvent` produced; audit record always present |
| H5: CREATED → CLOSED | S9 closure — all post-departure accounting complete | S9 action; H5 governs the inter-team transfer of residual obligations |

### 3.7 Re-Entry Transitions from S8

| Re-entry | Trigger | Segment | Consequence highlights |
|---|---|---|---|
| S8→S7 | Additional charge discovered after checkout initiation | No new segment | `CHECKOUT_TIME` timer cancelled; H4 returns to IN_PROGRESS; entry re-progresses to S8 after charge posting |
| S8→S2 | Rate dispute requiring full renegotiation | Yes | `CHECKOUT_TIME` timer cancelled; H4 returns to IN_PROGRESS; dispute framework activates; inventory remains DEPARTED_DIRTY pending resolution |

---

## §4 — Policy Envelope

### 4.1 Policies Active at S8

---

**Policy 22 — Settlement Rate Policy**

Active at S8 on `FolioService.initiateSettlement()`. Settlement applies the frozen rate and all approved amendments. No rate adjustment is permitted at settlement without a prior amendment approval event on record. Rate basis is validated against `Reservation.frozenRate` and the ordered `AmendmentEventRecord` set before settlement proceeds. Configurable: none — the settlement rate basis is invariant once amendments are approved.

---

**Policy 33 — Billing Model Settlement Policy**

Active at S8 on `FolioService.initiateSettlement()`. Settlement method must be compatible with the active billing model. Settlement closes the folio to `FolioState.SETTLED` or `FolioState.OUTSTANDING` depending on whether all balances are resolved.

Three billing model settlement paths:

- **Guest-pay:** Guest pays the outstanding balance at checkout. Accepted modes: cash, mobile payment (BHIM, UPI, Mbob, Mpay), bank transfer, other configured methods. For cash: counterfeit verification applies before payment record creation. For mobile payment: proof of payment screenshot with verified date and time is recorded. For insufficient funds: three governed options — alternative payment mode, partial payment with remainder becoming `FolioState.OUTSTANDING`, or holding items of equivalent value as security (governed, not informal). Foreign currency payments: conversion applies at the configured authoritative source; both foreign currency amount and BTN equivalent are recorded.

- **Direct-bill (corporate/government):** Invoice generated and dispatched. Folio enters `FolioState.OUTSTANDING` — not SETTLED at checkout. For government entities: invoice follows the government payment portal process. H5 is created with the outstanding invoice reference.

- **Tour operator voucher:** Folio reconciled against voucher terms. Agent is billed for the difference between voucher coverage and actual charges. Invoice generated for agent.

Hardcoded: auto-closing an outstanding balance to SETTLED without payment is forbidden. A folio with an unresolved balance must transition to `OUTSTANDING`, not SETTLED. Configurable: available settlement methods per billing model availability configuration surface.

---

**Policy 36 — Early Departure Policy**

Active at S8 via the Early Departure entry route. GM authority required. Shortened stay charges calculated against the original commitment snapshot — the rate is not retrospectively renegotiated as a condition of early departure. Configurable: early departure penalty terms per rate plan.

---

**Policy 46 — Credit Ceiling Final Balance Policy**

Active at S8 on `FolioService.initiateSettlement()`. Final folio balance is checked against the approved credit extension ceiling from the commitment snapshot. If the balance exceeds the approved ceiling, FOM must explicitly acknowledge the excess before settlement proceeds. A FOM acknowledgement event is recorded. Settlement without this event when ceiling is exceeded is forbidden. Configurable: none — the ceiling is the approved ceiling from the commitment snapshot.

---

**Policy 51 — DEFICIENT Inspection Review Policy**

Active at S8 on `CheckOutService.checkOut()`. Room inspection must record DEFICIENT condition final status on all active `DeficientConditionRecord` records on the room. If the condition was UNRESOLVED at S7 exit, `DEFICIENT_UNRESOLVED_AT_CHECKOUT` is set permanently on the record. `DEFICIENT_UNRESOLVED_AT_CHECKOUT` cannot be retroactively resolved after checkout — post-checkout corrections require a post-closure additive record under appropriate authority. Configurable: none — inspection review is a mandatory enforcement at S8.

---

**Policy 54 — Dispute Gate Stage Progression Policy**

Active at S8 on `DisputeService.evaluateStageGate()` → `DisputeGateEngine.canProgressStage()`.

At S8→S9: engine always returns `BLOCKED` when any dispute is OPEN or IN_PROGRESS. No override path. No configuration parameter overrides this behaviour. This is the hardcoded S8→S9 exception defined in Part 4 §4.6.2.

At any S8 sub-gate (where BLOCKED_WITH_OVERRIDE_AVAILABLE may apply): GM override path is available. `DisputeGateOverrideRecord` is created by the service layer on GM override with mandatory free-text reason. The override frequency is tracked by W33.

Configurable: which dispute `DisputeFailureCategory` values block which stage progressions (per `dispute.gateFunction.config`). The S8→S9 BLOCKED invariant is hardcoded regardless of this configuration.

---

**Policy 61 — Night Audit Overdue Detection Policy**

Active at S8 on `CheckOutService.checkOut()`. All stay nights must have a `NightAuditRecord` with `runStatus = COMPLETE` before checkout proceeds. If any stay night has `NightAuditRunStatus.PARTIAL` or no audit record, checkout is blocked until FOM explicitly acknowledges the overdue audit condition. FOM acknowledgement event is recorded for each overdue night. Silent bypass of a missing night audit record is forbidden. Configurable: none — overdue detection is a system invariant.

---

**Policy 63 — Handoff Lifecycle Policy**

Active at S8 on `HandoffService.fulfil()` (H4) and `HandoffService.create()` (H5). H4 completion is a mandatory S8 action. H5 is created at S8 exit for entries with residual obligations; auto-fulfilled if none. Every handoff — including auto-fulfilments — produces an immutable audit event. A handoff never recorded is an audit gap. Configurable: H4 and H5 handoff checklists (per `handoff.H4.checklist` and `handoff.H5.checklist` configuration surfaces).

---

**Policy 66 — Group FOC and Billing Split Policy (S8 phase)**

Active at S8 for group engagements. Settlement reconciles the group folio against the group billing mode (`CONSOLIDATED`, `INDIVIDUAL`, or `SPLIT`). All FOC rooms confirmed on the folio as zero-value lines. Complimentary coordinator room for conference engagements confirmed on folio as zero-value line before settlement. Last-minute additions posted before folio closes.

---

### 4.2 Key Policy Invariants at S8

- Settlement without posting all known charges is forbidden (Policy 33).
- Settlement rate is the frozen rate plus approved amendments only (Policy 22).
- A folio with a residual balance must become OUTSTANDING — not SETTLED (Policy 33 hardcoded).
- DEFICIENT flag final status must appear in the room inspection record regardless of inspection timing — pre- or post-checkout (Policy 51).
- Charging the guest for damage in a room with an UNRESOLVED DEFICIENT condition without FOM review is forbidden (Actor Authority Matrix S8 FORBIDDEN row).
- Dispute gate at S8→S9 is BLOCKED when any dispute is OPEN or IN_PROGRESS — no override is available at this gate under any circumstance (Policy 54; Part 4 §4.6.2 hardcoded behaviour).
- OCCUPIED→DEPARTED_DIRTY is the mandatory path. OCCUPIED→DEPARTED_CLEAN direct transition is the forbidden pattern.
- Inventory claim state does not release at S8. DEPARTED_DIRTY is a physical state change only.

---

## §5 — Engines at S8

### 5.1 DisputeGateEngine

**Method:** `DisputeGateEngine.canProgressStage(input: DisputeGateInput): DisputeGateResult`

**S8→S9 BLOCKED invariant — explicit statement:**

When `DisputeGateEngine.canProgressStage()` is called with `toStage = S9` and any dispute on the entry is in `OPEN` or `IN_PROGRESS` state, the engine **always returns `BLOCKED`**. It does not return `BLOCKED_WITH_OVERRIDE_AVAILABLE`. There is no override path. `DisputeGateResult.overrideAvailable` is always `false` for this gate. This is hardcoded and is not overridable by configuration, by authority level, or by any runtime parameter. A dispute must reach `RESOLVED` or `CLOSED` (GM authority with mandatory recorded reason) before S9 entry is permitted.

This is categorically different from the S7→S8 gate, which returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` and permits a GM-authorised override. The S8→S9 gate does not have this path.

**S8 sub-gates (where applicable):**

Where `DisputeGateEngine.canProgressStage()` is evaluated during S8 operations (not at the S8→S9 progression), the engine may return `BLOCKED_WITH_OVERRIDE_AVAILABLE`. In this case, GM may exercise the override path. The service layer creates `DisputeGateOverrideRecord`. The engine does not create this record.

**Engine does not:**
- Resolve or close disputes.
- Create override records.
- Track FOM override frequency (that is W33's responsibility).
- Evaluate folio or payment state.

**Invocation context at S8:**

| Invocation point | Input | Expected outcome if clear |
|---|---|---|
| S8→S9 stage progression guard | `fromStage: S8`, `toStage: S9`, all active disputes | `CLEAR` — all disputes RESOLVED or CLOSED |

### 5.2 ReEntryConsequenceEngine — S8 Rows

**Method:** `ReEntryConsequenceEngine.compute(input: ReEntryInput): ReEntryConsequencePayload`

Called when an S8 re-entry is initiated. The consequence payload is returned before the segment write is committed (for S8→S2). For S8→S7 (no new segment), the consequence actions are executed directly within the same transaction as the stage reversion.

| Originating Stage | Target Stage | Timer Consequences | Folio Consequences | Hold Consequences | Handoff Consequences | Inventory Consequences |
|---|---|---|---|---|---|---|
| S8 | S7 | Cancel: `CHECKOUT_TIME` | No folio change — return to S7 for additional charge posting | No hold change | H4 returns to IN_PROGRESS | Room remains in checkout process |
| S8 | S2 | Cancel: `CHECKOUT_TIME` | Rate disputed; folio revision pending | No hold change | H4 returns to IN_PROGRESS; dispute framework activates | Inventory remains DEPARTED_DIRTY pending resolution |

---

## §6 — Services at S8

### 6.1 CheckOutService

**Primary entity:** `Entry` (S8→S9 status transition); `Room` (physical state → DEPARTED_DIRTY)

**Responsibilities:**
- Reviews all `DeficientConditionRecord` records on the occupied room at checkout. Enforces Policy 51: writes `DeficientConditionRecord.finalStatus` on each record before checkout proceeds. An open DEFICIENT condition without a final status blocks checkout unless a governed-deferred inspection path is explicitly invoked.
- Verifies night audit charge posting completeness. Enforces Policy 61: all stay nights must have `NightAuditRecord.runStatus = COMPLETE`. Overdue nights block checkout until FOM provides explicit acknowledgement with reason.
- Triggers folio settlement by delegating to `FolioService.initiateSettlement()`. `CheckOutService` initiates; `FolioService` owns the `FolioState` transition. Policy 22, Policy 33, and Policy 46 are all enforced within `FolioService.initiateSettlement()`.
- Coordinates room inspection recording: creates or reads `RoomInspectionRecord` before S8→S9 guard evaluation. If inspection is deferred, records the deferral event and registers W9 timer.
- Coordinates key return recording: creates `KeyReturnRecord` with count reconciliation before S8→S9 guard evaluation.
- Triggers H5 creation by signalling `HandoffService.create()`. `HandoffService` owns `HandoffRecord` creation; `CheckOutService` initiates the trigger.
- Guards the S8→S9 transition: all seven exit conditions must be satisfied (§3.2). No partial transitions.
- Transitions `Room.currentClaimState` to `DEPARTED_DIRTY` on checkout completion. Registers `HOUSEKEEPING_SLA` (W24) timer via `TimerEngine` in the same transaction.
- Writes `TraceEvent` with type `CHECKOUT_COMPLETED` carrying: entryId, roomId, folioId, settlementMethod, keyReturnRecordId, inspectionRecordId, H5HandoffId, actorId, completedAt.

**Policy enforcement points:**
- Policy 51 (DEFICIENT Inspection Review) — `CheckOutService.checkOut()`
- Policy 61 (Night Audit Overdue Detection) — `CheckOutService.checkOut()`

**Mutation rules enforced:**
- `Entry`: stage transitions from S8 to S9 only when all guard conditions are satisfied; no partial transitions.
- `Room`: physical state transitions to DEPARTED_DIRTY at checkout; the DEPARTED_DIRTY state is immutable until housekeeping completes the turnover cycle.
- `DeficientConditionRecord`: `finalStatus` written at checkout inspection review; immutable once written.

### 6.2 FolioService — initiateSettlement

**Method:** `FolioService.initiateSettlement(folioId, settlementData, actorId)`

- Validates billing model compatibility: the settlement method in `settlementData` must be compatible with the active billing model on the folio. If incompatible, raises `PolicyGateBlockedError` with `blockingPolicy: 'BILLING_MODEL_SETTLEMENT_POLICY'`.
- Validates rate basis: settlement rate derived from `Reservation.frozenRate` and the ordered set of approved `AmendmentEventRecord` records. No additional rate adjustments at settlement without a prior amendment approval event.
- Checks credit ceiling (Policy 46): if the final balance exceeds the approved `CreditExtensionCeilingRecord.ceilingAmount`, raises `PolicyGateBlockedError` with `blockingCondition: 'CEILING_EXCEEDED_FOM_ACKNOWLEDGEMENT_REQUIRED'` unless a prior FOM acknowledgement event is recorded for this settlement.
- Creates `PaymentRecord` for guest-pay paths within the same transaction as the folio state transition.
- Transitions `Folio.state`: to `SETTLED` if full balance is cleared; to `OUTSTANDING` if a residual balance is governed-outstanding.
- Generates and dispatches the final invoice via `FolioService.issueInvoice()` for direct-bill and voucher paths.
- Writes `TraceEvent` with type `SETTLEMENT_EVENT` carrying: entryId, folioId, settlementMethod, billingModel, totalSettled, outstandingAmount, actorId, settledAt.

**Forbidden:** transitioning a folio with an unresolved balance to `SETTLED` — the governed terminal path for residual balances is `OUTSTANDING`.

### 6.3 EntryService — progressStage and createSegment

**Method: EntryService.progressStage(entryId, targetStage, transitionData, actorId)**

- Calls `DisputeService.evaluateStageGate()` as the first guard before any stage transition write. At S8→S9, if the gate returns `BLOCKED`, raises `StageGateBlockedError` — no override path is available.
- Evaluates all six remaining exit conditions (§3.2) in sequence. Collects all failures before raising — the guard does not halt on the first failure.
- Calls `CheckOutService.checkOut()` to execute all S8 checkout obligations within the same transaction as the stage write.
- Writes `Entry.currentStage = S9` on success.
- Includes `version` field in the request for optimistic lock guard: the client's `Entry.version` must match the current database value. Version mismatch raises `StateTransitionError` with `blockingCondition: 'OPTIMISTIC_LOCK_VERSION_MISMATCH'`.

**Method: EntryService.createSegment(entryId, reEntryReason, actorId)**

Called for S8→S2 re-entry. Calls `ReEntryConsequenceEngine.compute()` before segment write is committed. Consequence execution (timer cancellation, handoff updates) is part of the same transaction as segment creation. For S8→S7, no new segment is created — stage reversion and consequence execution occur within a single transaction.

### 6.4 HandoffService — H4 Fulfilment and H5 Creation

**Method: HandoffService.fulfil(handoffId, fulfilmentEvidence, actorId)**

- Validates fulfilment evidence for H4: charges posted, room inspection status recorded (or deferral event recorded), damage assessment complete or governed-deferred, DEFICIENT flag final status reported.
- Transitions `HandoffRecord.state` to FULFILLED.
- Produces immutable audit event. An H4 that is never recorded as FULFILLED is an audit gap.

**Method: HandoffService.create(entryId, handoffType, content, actorId)**

Called by `CheckOutService` to create H5. Handoff type is H5. Content carries: folio reference, settlement TraceEvent reference, outstanding amount and basis, active dispute references, credit ceiling final status.

- Where front desk and accounts are the same team: `HandoffRecord.isAutoFulfilled = true`; `TraceEvent` with `HANDOFF.AUTO_FULFILLED` is produced. The audit infrastructure record is always present regardless of auto-fulfilment.
- H5 transitions through CREATED → ASSIGNED → ACCEPTED → FULFILLED → CLOSED at S9.

### 6.5 DisputeService — Stage Gate Evaluation at S8→S9

**Method: DisputeService.evaluateStageGate(entryId, fromStage, toStage)**

Invokes `DisputeGateEngine.canProgressStage(input)` with all active disputes on the entry injected. For S8→S9:
- If result is `CLEAR`: proceeds; no gate action.
- If result is `BLOCKED`: raises `StageGateBlockedError` with `blockingCondition: 'DISPUTE_GATE_BLOCKED'` and the list of blocking disputes. No override path is offered or created. The error message explicitly states that the dispute must reach RESOLVED or CLOSED before S9 entry is permitted.

The `BLOCKED_WITH_OVERRIDE_AVAILABLE` return value is never produced by the engine at S8→S9. `DisputeService` does not create a `DisputeGateOverrideRecord` for S8→S9 under any circumstance.

### 6.6 ReservationService — Commitment Snapshot Read at Settlement

`ReservationService.getCommitmentSnapshot(entryId)` is called by `FolioService.initiateSettlement()` to read the frozen rate and credit ceiling for settlement validation. This is a read-only operation at S8. The commitment snapshot is sealed — it cannot be modified after S4 exit without a new segment.

---

## §7 — Workers at S8

### 7.1 W9 — PostCheckoutInspectionReminderWorker

**pg-boss job type:** `POST_CHECKOUT_INSPECTION`
**Governed stages:** S8–S9

**Trigger:** Registered when inspection is explicitly deferred at checkout. A deferral event is recorded and this worker is registered in the same transaction. The worker fires when the configured post-checkout inspection window expires without a `RoomInspectionRecord` being created for the entry.

**Idempotency:** Before dispatching, the worker checks `TraceEvent` for `POST_CHECKOUT_INSPECTION.INSPECTION_COMPLETED` for the entry since deferral. If inspection has been completed, skip. Keyed on `(entryId, deferral timestamp)`.

**On expiry:** Two outcomes are surfaced to FOM — charges posted as post-stay if damage is later identified, or inspection lapses permanently with a recorded lapse event. The worker surfaces both to FOM and does not choose.

**Configuration keys (dotted notation — MC-013 applied):**

| Key | Reader | Effect if absent |
|---|---|---|
| `inspection.postCheckout.windowDays` | W9 | Post-checkout deferral window cannot be scheduled; timer cannot be registered |

**Models written:** `TraceEvent` (`POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED`, `POST_CHECKOUT_INSPECTION.FOM_ALERTED`)

**Failure behaviour:** Standard pg-boss retry. Dead-letter on exhaustion — medium priority given S9 financial consequence of uninspected room.

### 7.2 W24 — HousekeepingSLAWorker

**pg-boss job type:** `HOUSEKEEPING_SLA`
**Governed stages:** S8

**Trigger:** Registered when `Room.currentClaimState` transitions to `DEPARTED_DIRTY` at checkout. `CheckOutService.checkOut()` registers this timer within the same transaction as the DEPARTED_DIRTY transition. Fires at SLA approaching threshold and at SLA breach.

**Idempotency:** Before dispatching SLA events, checks `Room.currentClaimState`. If room has already progressed past DEPARTED_DIRTY (e.g., to DEPARTED_CLEAN), housekeeping has completed — skip. Keyed on `(roomId, departed_dirty event timestamp, event phase)`.

**On SLA approach:** Housekeeping reminder dispatched. **On SLA breach:** FOM alerted. The worker does not transition room state — housekeeping service methods own that transition.

**Configuration keys (dotted notation — MC-013 applied):**

| Key | Reader | Effect if absent |
|---|---|---|
| `housekeeping.sla.windowMinutes` | W24 | Housekeeping SLA timer cannot be scheduled |
| `housekeeping.sla.warningOffsetMinutes` | W24 | Warning cannot fire; breach fires without advance notice |

**Models written:** `TraceEvent` (`HOUSEKEEPING_SLA.WARNING_FIRED`, `HOUSEKEEPING_SLA.BREACHED`, `HOUSEKEEPING_SLA.FOM_ALERTED`)

**Failure behaviour:** Standard. High-priority DLQ given the operational cost of DEPARTED_DIRTY rooms exceeding SLA.

### 7.3 W26 — CheckoutTimeWorker (S8 phase)

**pg-boss job type:** `CHECKOUT_TIME`
**Governed stages:** S8

**Trigger:** Registered by `TimerEngine` as part of the nightly timer recalculation after night audit completes. The timer fires when the standard checkout time for an in-stay entry is reached. S8 phase: the entry has already initiated checkout or checkout time has passed without S8 initiation.

**Idempotency:** Checks `Entry.currentStage`. If entry has progressed to S9 (checkout complete) or is cancelled, skip. If CHECKOUT_TIME was cancelled by a re-entry event (S8→S7, S8→S2), the worker reads `TraceEvent` to confirm cancellation before dispatching. Keyed on `(entryId, checkout date, event phase)`.

**On checkout time reached:** Front desk is prompted with checkout task. **On late checkout grace window expiry:** FOM is notified with escalation event. Checkout time event does not block the guest — it creates a managed open task.

**Configuration keys (dotted notation — MC-013 applied):**

| Key | Reader | Effect if absent |
|---|---|---|
| `property.checkoutTime` | W26 | Checkout time prompts cannot fire; timer cannot be registered |
| `property.lateCheckoutGraceWindow` | W26 | Late checkout FOM escalation cannot be scheduled |

**Models written:** `TraceEvent` (`CHECKOUT.TIME_REACHED`, `CHECKOUT.LATE_CHECKOUT_GRACE_EXPIRED`, `CHECKOUT.FOM_ESCALATED`)

**Policies enforced:** Checkout Due Policy (Policy 10).

**Failure behaviour:** Standard.

### 7.4 W27 — DisputeSLAWorker (S8 phase)

**pg-boss job type:** `DISPUTE_SLA` (primary); `RESOLUTION_EXECUTION` (sub-behaviour)
**Governed stages:** S7–S9; relevant at S8 for in-flight disputes approaching the S8→S9 gate

**S8 relevance:** Disputes created at S7 that are still OPEN or IN_PROGRESS at S8 are governed by this worker through S8. The SLA monitoring creates the conditions that determine whether the dispute gate will block S8→S9. A dispute that breaches its resolution SLA at S8 blocks S8→S9 exit unless GM closes it.

**Idempotency:** Before dispatching, reads `DisputeRecord.state`. If RESOLVED or CLOSED, skip. For `ResolutionBundleItem` monitoring, checks `ResolutionBundleItem.status` — if EXECUTED or CANCELLED, skip. Keyed on `(DisputeRecord.id, SLA phase)` and `(ResolutionBundleItem.id, deadline phase)`.

**Sub-behaviour — Resolution execution:** When a `ResolutionBundle` is approved, each `ResolutionBundleItem` with a `commitmentDeadline` registers a deadline timer within this worker. On deadline approach: FOM warning dispatched. On deadline breach: open-loop flagged; FOM escalated.

**Hardcoded:** `DISPUTE_EXHAUSTED` is not a valid state. This worker never produces that state transition. Dispute SLA monitoring escalates — it does not close disputes.

**Configuration keys (dotted notation — MC-013 applied):**

| Key | Reader | Effect if absent |
|---|---|---|
| `dispute.sla.firstResponseMinutes` | W27 | First-response SLA monitoring non-functional |
| `dispute.sla.resolutionDays` | W27 | Resolution SLA monitoring non-functional |

**Models written:** `TraceEvent` (`DISPUTE_SLA.FIRST_RESPONSE_APPROACHING`, `DISPUTE_SLA.FIRST_RESPONSE_BREACHED`, `DISPUTE_SLA.RESOLUTION_SLA_APPROACHING`, `DISPUTE_SLA.RESOLUTION_SLA_BREACHED`, `RESOLUTION_EXECUTION.DEADLINE_APPROACHING`, `RESOLUTION_EXECUTION.DEADLINE_BREACHED`, `RESOLUTION_EXECUTION.FOM_ESCALATED`)

**Failure behaviour:** Standard. Breach notification failures are high-priority DLQ alerts given the stage-gate consequence of unresolved disputes.

### 7.5 W33 — FOMOverrideFrequencyWorker

**pg-boss job type:** `FOM_OVERRIDE_FREQUENCY_WINDOW`
**Governed stages:** S8

**Trigger:** Runs on a rolling-period schedule (configurable default: 30 days). On each cycle, the worker counts `DisputeGateOverrideRecord` records attributed to each FOM actor within the rolling window and compares against the configured threshold. This covers overrides exercised at S8 sub-gates (BLOCKED_WITH_OVERRIDE_AVAILABLE path). Note: no overrides are recorded at S8→S9 because the engine returns BLOCKED at that gate with no override path — W33 cannot count what does not exist at S8→S9.

**Idempotency:** Before dispatching a GM ambient awareness notice, checks `TraceEvent` for `FOM_OVERRIDE_FREQUENCY.NOTICE_SENT` within the current rolling window. If a notice has already been dispatched for this window, skip. Keyed on `(rolling window start date)`.

**Behaviour:** The notice is an ambient awareness mechanism — not a hard block. FOM is not blocked from performing future overrides. No disciplinary record is created. GM receives the pattern for review. High override frequency may indicate gate miscalibration, a systematically unresolved dispute class, or operational pressure to clear checkouts quickly. GM's review decision or non-decision is recorded as a `TraceEvent`.

**Configuration keys (dotted notation — MC-013 applied):**

| Key | Reader | Effect if absent |
|---|---|---|
| `fomOverride.frequencyWindow.days` | W33 | Rolling window cannot be computed; worker cannot execute |
| `fomOverride.maxFrequency` | W33 | Threshold cannot be evaluated; GM notice cannot be triggered |

**Models read:** `DisputeGateOverrideRecord` (`actorId`, `overrideAt`, `targetStage`) — filtered to FOM actor level within the rolling window

**Models written:** `TraceEvent` (`FOM_OVERRIDE_FREQUENCY.THRESHOLD_EXCEEDED`, `FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT`)

**Failure behaviour:** Standard. Low-priority DLQ.

---

## §8 — API Routes at S8

All S8 routes are served by the Node.js/Express backend. Authentication is token-based with `ActorLevel` derived from the authenticated session.

---

### 8.1 Stage Progression — S8→S9

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` → `CheckOutService.checkOut()` |
| Policies | Policy 22 (Settlement Rate); Policy 33 (Billing Model Settlement); Policy 46 (Credit Ceiling Final Balance); Policy 51 (DEFICIENT Inspection Review); Policy 61 (Night Audit Overdue Detection); Policy 54 (Dispute Gate — S8→S9 BLOCKED invariant); Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (folio not settled; keys not returned; room not DEPARTED_DIRTY; inspection not complete or deferred; unposted charges remain; H5 not created; dispute gate BLOCKED — no override available at S8→S9), `PolicyGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |

**Request DTO — `ProgressStageRequestDTO`:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `targetStage` | `Stage` | Required | Must be `S9` for forward progression |
| `version` | `integer` | Required | Current `Entry.version` — optimistic lock guard per B4-001 |
| `transitionData` | `object` | Optional | Carries settlement method, billing model confirmation, and any other transition context |

**Notes:** Dispute gate override is explicitly NOT available at S8→S9. If any dispute is OPEN or IN_PROGRESS, `StageGateBlockedError` is raised with `blockingCondition: 'DISPUTE_GATE_BLOCKED'`. The error payload names the blocking disputes. The only resolution is GM closing the dispute via `PATCH /disputes/:id` with CLOSED state before re-attempting stage progression.

---

### 8.2 Folio Settlement

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/settle` |
| Auth | `L1+` |
| Request DTO | `InitiateSettlementRequestDTO` |
| Response DTO | `FolioResponseDTO` |
| Service method | `FolioService.initiateSettlement()` |
| Policies | Policy 22 (Settlement Rate); Policy 33 (Billing Model Settlement); Policy 46 (Credit Ceiling Final Balance) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (folio not LIVE), `PolicyGateBlockedError` (balance exceeds credit ceiling — FOM acknowledgement required; settlement method incompatible with billing model), `AppError` |

**Request DTO — `InitiateSettlementRequestDTO`:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `settlementMethod` | `string` | Required | `CASH` \| `MOBILE_PAYMENT` \| `BANK_TRANSFER` \| `DIRECT_BILL` \| `VOUCHER` \| other configured method |
| `billingModelConfirmation` | `string` | Required | Active billing model — must match `Folio.billingModel` |
| `paymentVerificationRef` | `string` | Conditional | Required for cash (counterfeit verification reference) and mobile payment (screenshot reference) |
| `partialAmount` | `Decimal` | Optional | If partial payment — remainder becomes OUTSTANDING |
| `fomAcknowledgementRef` | `string` | Conditional | Required if balance exceeds approved credit ceiling |

---

### 8.3 Room Inspection Record

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/room-inspection` |
| Auth | `L1+` (housekeeping actor) |
| Request DTO | `RoomInspectionRequestDTO` |
| Response DTO | `RoomInspectionResponseDTO` |
| Service method | `CheckOutService.recordInspection()` |
| Policies | Policy 51 (DEFICIENT Inspection Review) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (entry not at S8), `PolicyGateBlockedError` (deficientFlagStatus missing when active DEFICIENT conditions exist), `AppError` |

**Request DTO — `RoomInspectionRequestDTO`:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `isDeferred` | `boolean` | Required | `false` = pre-departure; `true` = post-checkout deferral |
| `deficientFlagStatus` | `string` | Required | `RESOLVED` \| `UNRESOLVED_AT_CHECKOUT` \| `NOT_APPLICABLE`. Mandatory regardless of `isDeferred` value. |
| `deficientConditionId` | `string` | Conditional | Required when deficientFlagStatus ≠ NOT_APPLICABLE |
| `inspectorAssessment` | `string` | Conditional | Required when deficientFlagStatus = UNRESOLVED_AT_CHECKOUT |
| `damageFound` | `boolean` | Required | Whether damage was discovered |
| `damageNotes` | `string` | Conditional | Required when damageFound = true |

---

### 8.4 Key Return Record

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/key-return` |
| Auth | `L1+` |
| Request DTO | `KeyReturnRequestDTO` |
| Response DTO | `KeyReturnResponseDTO` |
| Service method | `CheckOutService.recordKeyReturn()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (entry not at S8), `AppError` |

**Request DTO — `KeyReturnRequestDTO`:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `keyCountReturned` | `integer` | Required | Number of keys physically returned |
| `reconciliationNote` | `string` | Conditional | Required when `keyCountReturned ≠ Entry.keyCountIssued` — documents discrepancy and governed resolution |

---

### 8.5 H4 Fulfilment

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/fulfil` |
| Auth | `L1+` |
| Request DTO | `FulfilHandoffRequestDTO` (body: `fulfilmentEvidence`) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.fulfil()` |
| Policies | Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (fulfilment evidence incomplete), `StateTransitionError`, `AppError` |

---

### 8.6 H5 Creation

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs` |
| Auth | `L1+` (system-initiated via `CheckOutService`) |
| Request DTO | `CreateHandoffRequestDTO` (body: `handoffType: H5`, content) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.create()` |
| Policies | Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Note:** H5 is typically created by `CheckOutService` as part of the checkout transaction, not by a discrete operator-initiated call. A direct operator call to this route is permitted for exceptional paths (e.g., late discovery of a residual obligation after checkout completion).

---

### 8.7 Folio Get

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id` |
| Auth | `L1+` |
| Request DTO | `GetFolioRequestDTO` (path param: id) |
| Response DTO | `FolioResponseDTO` |
| Service method | `FolioService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

---

### 8.8 Invoice Issuance

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `IssueInvoiceRequestDTO` |
| Response DTO | `InvoiceResponseDTO` |
| Service method | `FolioService.issueInvoice()` |
| Policies | Policy 52 (Communication Acknowledgement Tracking) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

---

### 8.9 Dispute Gate Override — Explicitly NOT Available at S8→S9

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/gate-override` |
| Auth | `L3` (GM) |
| Availability at S8→S9 | **NOT AVAILABLE.** This endpoint is only valid when the dispute gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` — which applies at S7→S8 only. At S8→S9, the engine returns `BLOCKED` (no override path). A call to this endpoint citing S9 as the target stage is rejected with `PolicyGateBlockedError`. |
| Request DTO | `DisputeGateOverrideRequestDTO` (body: `freeTextReason` — mandatory; `targetStage`) |
| Service method | `DisputeService.createGateOverride()` |
| Error responses | `PolicyGateBlockedError` (gate does not return BLOCKED_WITH_OVERRIDE_AVAILABLE at S8→S9; override not available), `AuthorizationError`, `NotFoundError`, `AppError` |

---

### 8.10 Dispute Management Routes (S8 phase)

Disputes active at S8 are managed through the standard dispute routes:

| Action | Method + Path | Auth | Service method |
|---|---|---|---|
| Progress dispute (IN_PROGRESS) | `PATCH /disputes/:id` | `L2+` | `DisputeService.progress()` |
| Close dispute (CLOSED — GM) | `PATCH /disputes/:id` | `L3` | `DisputeService.close()` |
| Get dispute | `GET /disputes/:id` | `L1+` | `DisputeService.get()` |

Closing a dispute at CLOSED state (GM authority, mandatory recorded reason) is the mechanism by which the S8→S9 dispute gate is cleared for disputes that cannot be resolved through guest acceptance.

---

## §9 — Configuration Keys at S8

### 9.1 S8_READINESS Stage Group

**Stage group identifier:** `S8_READINESS`

At startup, the system validates all surfaces in this group. A missing or invalid surface raises `MissingConfigurationError` identifying the surface, the `S8_READINESS` group, and the operational consequence. The validation collects all failures before returning — it does not halt on the first failure.

| Configuration surface (dotted notation — MC-013 applied) | Consequence if absent |
|---|---|
| `property.checkoutTime` | Checkout time compliance checks cannot execute; standard checkout time not defined; W26 cannot register timers |
| `damage.rateList` (≥ 1 active entry) | Damage charge posting unavailable — no damage rate catalogue; `MissingConfigurationError` raised on damage charge attempt |
| `dispute.gateFunction.config` | Dispute gate at S8 unavailable — gate configuration parameters not defined; the S8→S9 BLOCKED invariant still applies (hardcoded) but gate function evaluation cannot proceed |
| `fomOverride.maxFrequency` | FOM override pattern visibility cannot execute — threshold not defined; W33 cannot evaluate |
| `fomOverride.frequencyWindow.days` | FOM override rolling window cannot be computed — W33 cannot execute |
| `invoice.templates.final` (≥ 1 active) | Final invoice generation unavailable — settlement requiring invoice dispatch cannot complete |
| `handoff.H5.checklist` | H5 handoff acceptance blocked at S9; H5 creation proceeds but fulfilment evidence validation cannot execute |
| `billingModel.availablePerSource` (≥ 1 active) | Settlement routing unavailable — billing model not defined |
| `creditCeiling.clientTier.thresholds` | Credit ceiling final balance check at S8 unavailable — ceiling enforcement non-functional at settlement |

### 9.2 Additional Configuration Keys Active at S8

The following keys are not S8_READINESS blocking surfaces but are read by S8 services and workers at runtime. Their absence at runtime raises `MissingConfigurationError` and halts the specific operation.

| Key (dotted notation) | Reader | Consequence if absent at runtime |
|---|---|---|
| `property.lateCheckoutGraceWindow` | W26 | Late checkout FOM escalation cannot be scheduled |
| `dispute.sla.firstResponseMinutes` | W27 | Dispute first-response SLA monitoring non-functional |
| `dispute.sla.resolutionDays` | W27 | Dispute resolution SLA monitoring non-functional |
| `housekeeping.sla.windowMinutes` | W24 | Housekeeping SLA timer cannot be scheduled on DEPARTED_DIRTY transition |
| `housekeeping.sla.warningOffsetMinutes` | W24 | SLA warning cannot fire |
| `inspection.postCheckout.windowDays` | W9 | Post-checkout inspection deferral window cannot be scheduled; W9 cannot register timer |
| `acknowledgement.windowPerType` | `HandoffService`, `CommunicationService` | H5 acceptance timer cannot be registered; settlement communication acknowledgement timeouts cannot be scheduled |
| `cancellation.policyTiers` | `AmendmentService` | Early departure penalty calculation cannot execute |

### 9.3 Blocking vs Non-Blocking Consequences

**Blocking (hard gate — S8_READINESS):** `property.checkoutTime`, `damage.rateList`, `dispute.gateFunction.config`, `fomOverride.maxFrequency`, `fomOverride.frequencyWindow.days`, `invoice.templates.final`, `billingModel.availablePerSource`, `creditCeiling.clientTier.thresholds` — absent surfaces at S8 activation raise `MissingConfigurationError` and prevent S8 from going live.

**Non-blocking (runtime degradation):** All keys in §9.2 — absent surfaces are detected at the moment the specific operation is attempted and halt only that operation. They do not prevent S8 from being live.

---

## §10 — Acceptance Criteria

The following assertions must be verified before SIG-S8 is considered implementation-complete. Each assertion is testable without live infrastructure where stated.

### 10.1 OCCUPIED→DEPARTED_DIRTY Mandatory Path

- [AC-S8-01] A checkout completion event on an entry with `Room.currentClaimState = OCCUPIED` produces `Room.currentClaimState = DEPARTED_DIRTY`. No other state is produced.
- [AC-S8-02] A direct `OCCUPIED → DEPARTED_CLEAN` transition has no code path in `CheckOutService` or any downstream service. Any attempt produces `StateTransitionError` with `blockingCondition: 'INVALID_ROOM_STATE_TRANSITION'`.
- [AC-S8-03] `HOUSEKEEPING_SLA` (W24) timer is registered within the same transaction as the DEPARTED_DIRTY write. A committed DEPARTED_DIRTY event without a corresponding timer registration is a test failure.

### 10.2 Inventory Claim State NOT Released at S8

- [AC-S8-04] After `CheckOutService.checkOut()` completes with `Room.currentClaimState = DEPARTED_DIRTY`, the `InventoryClaimState` at the reservation level remains `CONFIRMED`. No transition to `FREE` or any other claim state occurs at S8.
- [AC-S8-05] An attempt to place a new reservation hold on a room in DEPARTED_DIRTY state raises an availability conflict error — the room is not bookable while the claim state is CONFIRMED.

### 10.3 Folio Settlement — Three Billing Model Paths

- [AC-S8-06] **Guest-pay path:** `FolioService.initiateSettlement()` called with `settlementMethod = CASH` and a valid counterfeit verification reference produces `FolioState.SETTLED` when `totalSettled >= outstandingBalance`. `PaymentRecord` is created with `paymentDirection = IN` and the verification reference.
- [AC-S8-07] **Partial payment path:** `FolioService.initiateSettlement()` called with `partialAmount < outstandingBalance` produces `FolioState.OUTSTANDING`. The remainder is recorded as the governed-outstanding amount. `PaymentFollowUpWorker` (W8) is scheduled at S9 closure.
- [AC-S8-08] **Direct-bill path:** `FolioService.initiateSettlement()` called with `settlementMethod = DIRECT_BILL` produces `FolioState.OUTSTANDING` and creates a `FINAL` invoice in `DISPATCHED` state. The folio does not transition to SETTLED at checkout.
- [AC-S8-09] **Tour operator voucher path:** `FolioService.initiateSettlement()` called with `settlementMethod = VOUCHER` reconciles voucher coverage against actual charges. Agent billing invoice is created for the difference. `FolioState` transitions per the balance resolution.

### 10.4 Dispute Gate S8→S9 BLOCKED Invariant

- [AC-S8-10] `DisputeGateEngine.canProgressStage(entryId, S9)` returns `BLOCKED` when any `DisputeRecord` on the entry is in `OPEN` or `IN_PROGRESS` state. The result object carries `overrideAvailable: false`.
- [AC-S8-11] `EntryService.progressStage()` called with `targetStage = S9` when the dispute gate returns `BLOCKED` raises `StageGateBlockedError` with `blockingCondition: 'DISPUTE_GATE_BLOCKED'`. No `DisputeGateOverrideRecord` is created.
- [AC-S8-12] A call to `POST /disputes/:id/gate-override` with `targetStage = S9` is rejected with `PolicyGateBlockedError` regardless of the calling actor's authority level.
- [AC-S8-13] After GM closes a dispute via `DisputeService.close()` with mandatory recorded reason, `DisputeGateEngine.canProgressStage(entryId, S9)` returns `CLEAR` (assuming no other open disputes). Stage progression succeeds.

### 10.5 DEFICIENT Flag Status in Inspection Record

- [AC-S8-14] A `RoomInspectionRecord` created by `CheckOutService.recordInspection()` always carries a non-null `deficientFlagStatus` field. A record without this field fails schema validation.
- [AC-S8-15] When the entry's room has an active `DeficientConditionRecord` with `status = UNRESOLVED` at S8, a `RoomInspectionRecord` created with `deficientFlagStatus = NOT_APPLICABLE` is rejected with `PolicyGateBlockedError`.
- [AC-S8-16] A `DeficientConditionRecord.finalStatus = UNRESOLVED_AT_CHECKOUT` set at S8 remains unchanged at S9 closure. No post-closure path overwrites this value directly.

### 10.6 H4 Fulfilment Evidence

- [AC-S8-17] `HandoffService.fulfil()` called on an H4 `HandoffRecord` without a fully populated `fulfilmentEvidence` object (missing any of: charges-posted confirmation, room inspection status, damage assessment status, DEFICIENT flag final status) raises `PolicyGateBlockedError` with `blockingCondition: 'H4_FULFILMENT_EVIDENCE_INCOMPLETE'`.
- [AC-S8-18] An S8→S9 progression attempt where H4 is not in FULFILLED or auto-fulfilled state raises `StageGateBlockedError`.

### 10.7 H5 Creation vs Auto-Fulfilment

- [AC-S8-19] An entry with `FolioState.OUTSTANDING` at S8→S9 produces a `HandoffRecord` with `handoffType = H5`, `state = CREATED`, and `isAutoFulfilled = false`. The H5 carries the outstanding amount and basis.
- [AC-S8-20] An entry with `FolioState.SETTLED` and no active disputes or commission obligations at S8→S9 produces a `HandoffRecord` with `handoffType = H5` and `isAutoFulfilled = true`. A `TraceEvent` with type `HANDOFF.AUTO_FULFILLED` is produced. The audit record is present.

### 10.8 FOM Override Frequency Tracking

- [AC-S8-21] `FOMOverrideFrequencyWorker` (W33) counts `DisputeGateOverrideRecord` records within the configured rolling window and compares against `fomOverride.maxFrequency`. When threshold is exceeded, a `TraceEvent` with type `FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT` is produced. No `PolicyGateBlockedError` is raised — the mechanism is an ambient awareness notice, not a hard block.
- [AC-S8-22] After W33 dispatches a GM notice, a subsequent FOM override within the same rolling window is not blocked. The worker's next cycle records the notice again if the threshold is still exceeded.

### 10.9 Post-Checkout Inspection Deferral Timer

- [AC-S8-23] A `RoomInspectionRequestDTO` submitted with `isDeferred = true` causes `CheckOutService.recordInspection()` to register a `POST_CHECKOUT_INSPECTION` (W9) timer within the same transaction. A deferral event without a corresponding timer registration is a test failure.
- [AC-S8-24] When W9 fires after the configured `inspection.postCheckout.windowDays` window, a `TraceEvent` with type `POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED` is produced and FOM is alerted. The entry is not automatically blocked from S9 by the expiry — it surfaces the outcome options to FOM.

### 10.10 Key Return and Count Reconciliation

- [AC-S8-25] A `KeyReturnRequestDTO` submitted with `keyCountReturned < Entry.keyCountIssued` without a `reconciliationNote` is rejected with `ValidationError`.
- [AC-S8-26] A `KeyReturnRecord` with `countReconciled = false` and a populated `reconciliationNote` satisfies the S8→S9 exit condition for key return. The S8→S9 guard does not require `countReconciled = true` — it requires a `KeyReturnRecord` to exist with the discrepancy governed.

---

*SIG-S8 v1.0 — Produced 15 April 2026*
*Locked by Architect: Dhendup Cheten, Fuzzy Automation, 15 April 2026*
