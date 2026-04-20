# LEGPHEL PMS — Stage Implementation Guideline
## S7 — Stay / Event Management

**Document ID:** SIG-S7
**Version:** 1.0
**Date:** 15 April 2026
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT — pending Architect review and lock
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Stage | S7 — Stay / Event Management |
| SIG version | 1.0 (first generation — no prior SIG-S7) |
| Canon version | v2.5 |
| DEV-SPEC authority | MOM-ARCH-2026-013; MOM-ARCH-2026-016; MOM-ARCH-2026-020 |
| Sources loaded | Canon Block 8 §48 full; SIG-S6-v1_0.md; ACTOR-AUTHORITY-MATRIX-LOCKED.md; DEV-SPEC-001-Part3.md; DEV-SPEC-001-Part4.md; DEV-SPEC-001-Part5-REV2.md; DEV-SPEC-001-Part2-REV2-FINAL.md; DEV-SPEC-001-Part6-REV3.md; DEV-SPEC-001-Part8.md; DEV-SPEC-001-Part9-REV1.md; DEV-SPEC-001-Part12.md; MASTER-CORRECTION-LOG-v2_0.md |
| MCL PENDING items absorbed | MC-010 (dotted notation — workers); MC-011 (version field in ProgressStageRequestDTO); MC-013 (dotted notation — config keys); SIG-S4-COR-005 (Policy 52 fourth loop-close condition) |
| Schema finding | SIG-S7-COR-001 — `AmendmentEventRecord` absent from Part 2; schema derived from Part 6 REV3 and carried in §2.9 below |
| Sections | §§1–10 |

---

## §1 — Stage Identity

### 1.1 Name and Purpose

**Stage:** S7 — Stay / Event Management

S7 governs the live stay or event from the moment of check-in completion through to the initiation of checkout. Every charge is posted here. Every modification goes through the amendment mechanism here. Every service failure is recorded here. Every night of the stay is financially closed here. S7 is the stage where the hotel runs the stay — continuously, on a daily basis, from check-in to the final pre-checkout coordination.

S7 is not a one-time transition event. Required actions occur daily and on-event throughout the entire duration of the stay. The stage exits only when the financial record is complete, H4 has been initiated, and all DEFICIENT conditions have a final status recorded.

### 1.2 Entry Routes

**Forward from S6.** Check-in is complete. Room is OCCUPIED. Folio is LIVE. H2 and H3 are accepted. The five S6 exit guards have been satisfied. The stay has begun.

**Return from S7→S1 (room change).** An entry that exited S7 to action a room change through S1 (and compressed through S2/S3/S4 as applicable) returns to S7 in the new segment with the new room assignment applied, the folio adjusted with a rate delta layer, the old room transitioned to DEPARTED_DIRTY, the new room OCCUPIED, and H2 refreshed. The stay continues in the new segment.

**Return from S7→S2 (rate revision / renegotiation).** An entry that exited S7 for a rate revision or meal plan change through S2 returns to S7 with the amendment applied. For simple folio adjustments (Path 2), no new segment is created; for full renegotiation (Path 3), a new segment carries the revised terms. In either case, prior charges are immutable and the stay continues.

**Return from S7→S3 (billing model change / additional payment).** An entry that exited S7 for a billing model change or additional payment arrangement through S3 returns to S7 with the new billing configuration applied. The folio accumulates the change; prior posted charges are preserved.

**Return from S7→S4 (date extension).** An entry that exited S7 for date extension re-confirmation through S4 returns to S7 with the extended checkout date, the inventory claim extended to the new checkout date, and the checkout timer recalculated.

**Return from S8→S7 (additional charge discovered).** An entry returned from S8 to post an additional charge discovered after checkout initiation. No new segment is created on this path. The charge is posted and the entry re-progresses to S8.

### 1.3 Exit Conditions (S7→S8)

All five conditions must be satisfied before the S7→S8 transition may proceed. A failure on any condition produces `StageGateBlockedError` identifying the specific unsatisfied condition.

| Exit condition | Description |
|---|---|
| Night audit complete for final stay night | `NightAuditRecord` with `runStatus = COMPLETE` must exist for the final operating night. A missing night audit for any stay day blocks S7 exit unconditionally — the financial record must be complete before checkout is governed. |
| All known charges posted | All pending charge lines must be posted to the live folio. No open charge obligations. |
| H4 initiated | `HandoffRecord` of type H4 must be in CREATED or ACCEPTED state (or auto-fulfilled for same-day departures). H4 is the pre-checkout coordination handoff from front desk to housekeeping and F&B. |
| DEFICIENT condition final status recorded | Every `DeficientConditionRecord` associated with the occupied room must carry a final status — either `status = "RESOLVED"` or `status = "UNRESOLVED"`. A DEFICIENT condition with no final status recorded blocks S7 exit. Neither RESOLVED nor UNRESOLVED is acceptable as a silent omission — both are explicit outcomes. |
| Dispute gate returns CLEAR or BLOCKED_WITH_OVERRIDE_AVAILABLE | `DisputeGateEngine.canProgressStage()` must not return `BLOCKED`. If any dispute is configured as blocking for S8 entry, S7 cannot exit until that dispute is addressed or a GM override is recorded. Disputes not configured as blocking carry into S8 and S9 without blocking exit. |

### 1.4 Governing Actors

| Role | Authority level | S7 scope |
|---|---|---|
| Front desk custodian | L1 | Charge posting; H4 initiation; stage progression (standard) |
| FOM | L2 | Amendment authority (inclusion changes; mid-stay discount up to threshold); credit ceiling acknowledgement; dispute management; DEFICIENT escalation review; night audit anomaly review; override on BLOCKED_WITH_OVERRIDE_AVAILABLE dispute gate |
| GM | L3 | Rate changes during stay; full renegotiation; early departure; billing model change; dispute gate override with recorded reason; post-ceiling-100% non-mandatory charge authorisation |

### 1.5 Forbidden Actions at S7

**Silently changing the committed rate.** Rate changes during stay must go through the amendment mechanism — running the appropriate approval chain and producing a new segment or folio adjustment layer. A direct field edit to the rate is an architectural violation.

**Posting charges without an operational anchor.** Every folio line must reference an operational event — a night of occupancy, an F&B consumption event, a service delivery event. The sole exception is the commercial adjustment entry explicitly recorded with GM authority. Phantom charges with no operational basis are a forbidden pattern.

**Modifying sealed folio lines.** FolioLine records are immutable after posting. Corrections are expressed as new offsetting lines — never as edits to the original.

**Bypassing night audit.** Night audit is mandatory for every operating day of the stay. A day without a COMPLETE audit record is an open gap in the financial authority chain.

**Posting non-mandatory charges at or above 100% credit ceiling without FOM acknowledgement.** Once the ceiling threshold is reached, non-mandatory charge posting without a recorded FOM acknowledgement event is a financial control failure.

**Room change as a field update.** A room change is not a direct edit to the room assignment field. It is a governed lifecycle event that creates a new segment, adjusts the folio, updates inventory claim state, and refreshes H2. A room change implemented as a field edit is an architectural violation.

**Extending the stay without availability verification.** A date extension must verify that the room is available for the extended dates in inventory claim state before the extension is confirmed.

---

## §2 — Schema Models Active at S7

### 2.1 Schema Overview

S7 creates folio charge lines, night audit records, DEFICIENT condition resolution events, dispute records, work order consumption records, credit ceiling threshold events, amendment event records, and the H4 handoff. The following models are created or updated at S7.

### 2.2 FolioLine

**Model:** `FolioLine` (Part 2 §2.7)
**Stage relevance:** Created at S7 on every charge posting event — room charges, F&B, service, and other chargeable items.

**Mutation rules:**
- `FolioLine` records are **immutable from creation**. No `UPDATE` path exists. No field may be changed after the record is written.
- Corrections to posted charges are expressed as new offsetting `FolioLine` records (credit lines) or `CreditNote` records — never as edits to the original line.
- Every `FolioLine` created at S7 carries `stage = S7` and a `postedBy` actor reference.
- `nightAuditRecordId` is populated for lines created by night audit; null for lines posted at point of service.
- `FolioLine.lineType` values active at S7: `ROOM_CHARGE` (night audit), `F_AND_B` (point of service), `SERVICE` (point of service or night audit), `OTHER` (miscellaneous chargeable items).

**Key constraint:** A `FolioLine` with `chargeDate` matching a past operating date for which a `NightAuditRecord` with `runStatus = COMPLETE` exists is sealed — post-audit manual posting to a sealed date is forbidden. Catch-up postings carry the original audit date as `referenceDate` and the actual posting date as `transactionDate`.

### 2.3 NightAuditRecord

**Model:** `NightAuditRecord` (Part 2 §2.12)
**Stage relevance:** One created per operating day for all active in-stay entries.

**Mutation rules:**
- `NightAuditRecord` is **immutable from creation**. Once written with any `runStatus`, the record is sealed. No amendment or override of its content is permitted.
- A `PARTIAL` status record is a governed exception state — it identifies `entriesNotProcessed` and triggers immediate FOM escalation. The partial record is not deleted on re-run; the re-run produces a separate COMPLETE record covering the previously unprocessed entries.
- `NightAuditRecord.operatingDate` is `@unique` — only one record per operating date is created.

**`NightAuditRunStatus` enum values:** `COMPLETE` | `PARTIAL` | `FAILED`

### 2.4 NightAuditAnomaly

**Model:** `NightAuditAnomaly` (Part 2 §2.12)
**Stage relevance:** Created during night audit runs when an expected charge is missing or an entry cannot be processed.

**Mutation rules:**
- Immutable from creation.
- `anomalyType` values: `MISSING_EXPECTED_CHARGE` (expected charge absent from folio for the operating date per rate plan configuration) | `AUDIT_EXCEPTION` (entry could not be processed during the audit run).
- A `MISSING_EXPECTED_CHARGE` anomaly does not trigger automatic backposting. It surfaces to FOM for review. FOM determines whether to approve a catch-up posting or record the reason for non-posting.
- `resolvedAt` and `resolvedBy` are populated by the service layer when FOM acts on the anomaly. The original anomaly record is not deleted.

### 2.5 CreditCeilingThresholdEvent

**Model:** `CreditCeilingThresholdEvent` (Part 2 §2.7)
**Stage relevance:** Created at S7 when the outstanding balance crosses a threshold tier (75%, 90%, or 100% of the approved credit extension ceiling).

**Mutation rules:**
- Immutable from creation.
- Created by the service layer (not the engine) when `CreditCeilingMonitorEngine.evaluate()` returns `thresholdCrossed: true`.
- Threshold-crossing events are permanent records — they are not cleared or removed when the balance subsequently decreases.
- One event record per threshold crossing. If the same threshold is crossed multiple times within the stay (e.g., balance drops below 75% and rises again), each crossing produces a separate event.
- The ceiling accumulates from the first charge posted at S6 conversion through to settlement at S8. It does not reset during the stay.

### 2.6 DeficientConditionRecord

**Model:** `DeficientConditionRecord` (Part 2 §2.4; Part 3 §3.15)
**Stage relevance:** Created at S5 (detection); updated at S7 (resolution or UNRESOLVED status on checkout).

**Mutation rules at S7:**
- `DeficientConditionRecord` created at S5 is updated at S7 when resolution occurs. The resolution is an additive layered event: `resolvedAt`, `resolvedBy`, and `resolutionNotes` fields are populated on the existing record. The original detection fields (`description`, `category`, `detectedAt`, `detectedBy`, `resolutionDeadline`) are preserved without modification.
- When a DEFICIENT condition is resolved: `status → "RESOLVED"` and `Room.isDeficient → false`.
- When checkout occurs with `status = "UNRESOLVED"`: the condition transitions to `DEFICIENT_UNRESOLVED_AT_CHECKOUT`. This state is permanent. A post-checkout resolution attempt creates a new `ServiceRecoveryRecord`; the DEFICIENT_UNRESOLVED_AT_CHECKOUT record is not amended.
- A DEFICIENT condition with no final status recorded at S7 exit blocks the S7→S8 transition.

### 2.7 HandoffRecord — H4

**Model:** `HandoffRecord` (Part 2 §2.6; Part 3 §3.9)
**Stage relevance:** H4 is created at S7 as the pre-checkout coordination handoff. H2 and H3 (created at S6) are updated at S7 when room or meal plan changes occur.

**H4 creation — mutation rules:**
- H4 is created by `HandoffService.create()` at S7 when the expected checkout date approaches. `HandoffRecord.handoffType = H4`.
- H4 fulfilment evidence requirement: housekeeping and F&B confirmation that charges are posted, services accounted for, damage assessment complete, and DEFICIENT condition final status reported.
- H4 is auto-fulfilled for same-day departures: `HandoffRecord.isAutoFulfilled = true`; system records the event for audit.
- H4 initiated (CREATED or ACCEPTED state, or auto-fulfilled) is a required S7 exit condition.

**H2 and H3 updates during S7 — mutation rules:**
- H2 and H3 represent ongoing obligations throughout the stay, not one-time events at S6.
- When a room change occurs at S7, the prior H2 is withdrawn and a new H2 is created for the new room on the new segment.
- When a meal plan changes at S7, H3 is updated via `HandoffService` to reflect the revised F&B obligation.
- When a DEFICIENT condition is resolved, `HandoffRecord.deficientConditionStatus` on H2 is updated with the resolution event.
- All handoff updates produce immutable audit events.

### 2.8 DisputeRecord, ServiceRecoveryRecord, DisputeGateOverrideRecord

**Models:** `DisputeRecord`, `ServiceRecoveryRecord`, `DisputeGateOverrideRecord` (Part 2 §2.9)
**Stage relevance:** All three may be created at S7. `DisputeGateOverrideRecord` is specific to S7→S8.

**Mutation rules:**
- `DisputeRecord`: created on guest complaint or detected service failure; status transitions through OPEN → IN_PROGRESS → RESOLVED | CLOSED → REOPENED lifecycle. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.
- `ServiceRecoveryRecord`: cannot be suppressed once created. A detected service failure at S7 always produces a `ServiceRecoveryRecord`. Front desk intake of a service failure must be completable in under 30 seconds with the guest present.
- `DisputeGateOverrideRecord`: immutable from creation. Created by the service layer (not the engine) when GM invokes the override at the S7→S8 dispute gate. Override is available at S7→S8 (`BLOCKED_WITH_OVERRIDE_AVAILABLE` — GM override with mandatory free-text reason). Override is **not** available at S8→S9 when a dispute is OPEN or IN_PROGRESS.

### 2.9 WorkOrder, WorkOrderToDoItem, WorkOrderConsumptionRecord, WorkOrderAmendmentEvent

**Models:** `WorkOrder`, `WorkOrderToDoItem`, `WorkOrderConsumptionRecord`, `WorkOrderAmendmentEvent` (Part 2 §2.8)
**Stage relevance:** Conference and group engagements. `WorkOrderConsumptionRecord` records are created at S7 as services are delivered. `WorkOrderAmendmentEvent` records are created as coordinator-initiated changes are recorded.

**Mutation rules:**
- `WorkOrder`: amendments are layered events throughout S7 — every change produces a `WorkOrderAmendmentEvent` record. The work order never enters an "edited" state; it accumulates amendment layers.
- `WorkOrderToDoItem`: status transitions PENDING → IN_PROGRESS → COMPLETED | CANCELLED with a recorded reason on cancellation.
- `WorkOrderConsumptionRecord`: immutable from creation. Created each time a service delivery event is logged against the work order allocation. When `isOverAllocation = true`, `overAllocationAcknowledgedBy` and `overAllocationAcknowledgedAt` are required before the record may be created.

### 2.10 AmendmentEventRecord — Schema Finding SIG-S7-COR-001

**Finding:** `AmendmentEventRecord` is referenced in Part 6 REV3 §6.6.2 `AmendmentService` (Path 1 handler and Path 2 handler each create an `AmendmentEventRecord`) and `AmendmentPath` enum exists in Part 2 REV2-FINAL (§2 enum block, line 400), but no `model AmendmentEventRecord { ... }` Prisma block exists anywhere in Part 2 REV2-FINAL. The model is absent from the schema.

**Action per session brief §5:** Schema derived from Part 6 REV3 service descriptions below. No gap marker inserted. Developer implements from this derived spec. Part 2 backfill required.

**Derived schema:**

```prisma
model AmendmentEventRecord {
  id              String        @id @default(uuid())
  entryId         String
  segmentId       String
  amendmentPath   AmendmentPath // PATH_1 | PATH_2 | PATH_3
  amendmentType   String
  // RATE_CHANGE | INCLUSION_CHANGE | DATE_EXTENSION | BILLING_MODEL_CHANGE |
  // ROOM_CHANGE | MEAL_PLAN_CHANGE | DISCOUNT | OTHER
  requestedBy     String        // actor_id — NOT NULL; FOM minimum for PATH_2; GM for rate
  authorisedBy    String        // actor_id — may differ from requestedBy on escalation
  authorityBasis  String        // FRONT_DESK | FOM | GM | SYSTEM
  reason          String        // mandatory — purpose of amendment
  priorTermsRef   String?       // reference to the prior segment or folio line being amended
  newTermsSummary String        // human-readable description of the applied change
  folioLineId     String?       // FolioLine created as a consequence of this amendment
  stageAtAmendment Stage        // S7 for in-stay amendments
  createdAt       DateTime      @default(now())

  entry           Entry         @relation(fields: [entryId], references: [id])
  segment         Segment       @relation(fields: [segmentId], references: [id])

  // Mutation rule: immutable from creation. Amendment history is permanently readable.
  // One record per amendment event — not one per segment.
  @@map("amendment_event_records")
}
```

**SIG-S7-COR-001** — Part 2 REV2-FINAL backfill required. Add `model AmendmentEventRecord` as defined above. Add `amendmentEventRecords AmendmentEventRecord[]` back-relation to `Entry` and `Segment` models.

---

## §3 — State Machine at S7

### 3.1 Entry State at S7

An entry is in `(ACTIVE, S7)` throughout the live stay. The composite state is `Entry.status = ACTIVE` and `Entry.currentStage = S7`.

Re-entry paths that create a new segment increment `Entry.segmentNumber`. The prior segment is sealed (`Segment.sealedAt` populated in the same transaction as the new segment creation). For S8→S7 (additional charge posting), no new segment is created.

### 3.2 S7→S8 Transition Guard

Derived from §76A without modification.

| Guard | Condition | Failure outcome |
|---|---|---|
| Source state match | `Entry.status = ACTIVE` AND `Entry.currentStage = S7` | `StageGateBlockedError` |
| Night audit complete | `NightAuditRecord` with `operatingDate = final stay night` AND `runStatus = COMPLETE` exists | `StageGateBlockedError` — missing night audit; audit must be completed before checkout may proceed |
| All known charges posted | No open charge obligations on the live folio | `StageGateBlockedError` |
| H4 initiated | `HandoffRecord` of type H4 in CREATED, ACCEPTED, or FULFILLED state — or `isAutoFulfilled = true` | `StageGateBlockedError` — H4 not initiated; pre-checkout coordination not started |
| DEFICIENT condition final status recorded | All `DeficientConditionRecord` records for the occupied room carry `status = "RESOLVED"` or `status = "UNRESOLVED"` (not null, not empty) | `StageGateBlockedError` — DEFICIENT condition without final status; must record RESOLVED or UNRESOLVED before exit |
| Dispute gate | `DisputeGateEngine.canProgressStage(entryId, S8)` returns `CLEAR` or `BLOCKED_WITH_OVERRIDE_AVAILABLE` | `StageGateBlockedError` — dispute configured as blocking and no override path; dispute must be addressed |
| Authority satisfied | Actor holds `L1+` authority | `AuthorizationError` |

**Override path for dispute gate:** When the engine returns `BLOCKED_WITH_OVERRIDE_AVAILABLE`, GM may invoke the override via `POST /disputes/:id/gate-override`. The service layer creates a `DisputeGateOverrideRecord` (immutable from creation) before the transition proceeds. The override does not remove the dispute from history.

### 3.3 Re-Entry Transitions from S7

All re-entry transitions that create a new segment invoke `ReEntryConsequenceEngine.compute()` before the segment write is committed. Consequence execution is part of the same transaction as segment creation.

| Re-entry | Trigger | Segment created | Consequence highlights |
|---|---|---|---|
| S7→S1 | Room change during stay | Yes | Old room OCCUPIED → DEPARTED_DIRTY; new room begins readiness path; H2 withdrawn (old room) and re-created (new room); folio receives rate delta adjustment layer; `STAGE_DWELL_MONITOR` timer cancelled |
| S7→S2 | Rate revision; meal plan change; full renegotiation | Yes (full renegotiation — Path 3); folio adjustment only (Path 2) | No inventory change; no hold change; H3 updated if meal plan changes; prior charges immutable |
| S7→S3 | Billing model change; additional payment arrangement | Depends on nature | New billing configuration record; folio adjustment; no hold change |
| S7→S4 | Date extension re-confirmation | Yes | Inventory claim extended to new checkout date; new `CHECKOUT_TIME` timer registered |
| S8→S7 | Additional charge discovered after checkout initiation | No new segment | `CHECKOUT_TIME` timer cancelled; H4 returns to IN_PROGRESS; charge posted; entry re-progresses to S8 |

### 3.4 FolioLine Posting Transition

A LIVE folio (`FolioState.LIVE`) accepts charge postings throughout S7. The posting sequence is:

1. Service layer calls `FolioService.postCharge()` with charge details.
2. `TaxEngine.calculate()` is invoked per charge before the `FolioLine` record is written.
3. `FolioLine` is written (immutable from creation).
4. For credit-ceiling-monitored entries, `CreditCeilingMonitorEngine.evaluate()` is called immediately after the `FolioLine` write. If `chargeBlockedPendingAcknowledgement: true` is returned (100% soft gate, non-mandatory charge), the charge posting must not proceed without a prior FOM acknowledgement event. The engine is called before the block is lifted; the service layer enforces the gate.
5. If `thresholdCrossed: true` is returned, the service layer writes a `CreditCeilingThresholdEvent` record.

`FolioState.LIVE` does not revert to `PROVISIONAL` under any amendment path. All in-stay amendments accumulate on the live folio via new lines and adjustment records.

### 3.5 Inventory Claim State — Room Change at S7

| From | To | Trigger |
|---|---|---|
| OCCUPIED (old room) | DEPARTED_DIRTY | Room change mode: new segment created; old room released as part of S7→S1 re-entry consequence |
| readiness path (new room) | OCCUPIED | New room confirmed through S1→S2→S3→S4 compressed path; check-in applied to new room |

The `OCCUPIED → DEPARTED_CLEAN` direct transition is the forbidden pattern. The old room must pass through DEPARTED_DIRTY before housekeeping can transition it to DEPARTED_CLEAN.

### 3.6 Dispute State Machine at S7

Active from creation through S7 into S8 and S9.

| From | To | Trigger | Authority |
|---|---|---|---|
| — | OPEN | Guest or staff files dispute | L1+ |
| OPEN | IN_PROGRESS | Hotel response commenced; first response event recorded | L2 (FOM) |
| IN_PROGRESS | RESOLVED | Guest accepts resolution | Guest + FOM management |
| IN_PROGRESS | CLOSED | GM formally closes with recorded reason | L3 (GM) |
| CLOSED | REOPENED | Dispute re-opened with mandatory reason | L2+ |
| REOPENED | IN_PROGRESS | Re-engagement commenced | L2 |

**S7→S8 gate:** `DisputeGateEngine.canProgressStage(entryId, S8)` evaluates all disputes. Returns `CLEAR` (proceed), `BLOCKED_WITH_OVERRIDE_AVAILABLE` (GM override path available), or `BLOCKED` (if configuration specifies no override). On `BLOCKED_WITH_OVERRIDE_AVAILABLE`, the service layer creates `DisputeGateOverrideRecord` on GM override before transition proceeds.

### 3.7 DEFICIENT Condition State Machine at S7

| From | To | Trigger |
|---|---|---|
| DEFICIENT_OPEN (`status = "UNRESOLVED"` during stay) | DEFICIENT_RESOLVED (`status = "RESOLVED"`) | Housekeeping posts resolution event with description, responsible actor, and timestamp; `Room.isDeficient → false`; resolution fields layered additively on original record |
| DEFICIENT_OPEN | DEFICIENT_UNRESOLVED_AT_CHECKOUT (`status = "UNRESOLVED"` at checkout) | S7 exit occurs with `status = "UNRESOLVED"` still recorded |

**Permanence:** `DEFICIENT_UNRESOLVED_AT_CHECKOUT` is a permanent state on the stay record. No post-checkout path removes or amends this. The condition is surfaced to the S8 room inspector.

### 3.8 HandoffRecord H4 Lifecycle

| From | To | Trigger |
|---|---|---|
| — | CREATED | `HandoffService.create()` called at pre-checkout initiation | 
| CREATED | ASSIGNED | Routing to housekeeping and F&B |
| ASSIGNED | ACCEPTED | Explicit acceptance by housekeeping and F&B |
| ACCEPTED | FULFILLED | Fulfilment evidence recorded: charges posted, room inspection status, damage assessment complete or governed-deferred |
| Any active | ESCALATED | SLA deadline breached |

Auto-fulfilment: for same-day departures, H4 is auto-fulfilled. `HandoffRecord.isAutoFulfilled = true`. Audit event recorded.

### 3.9 WorkOrder Amendment Lifecycle at S7

Every coordinator-initiated change during an event is recorded as a `WorkOrderAmendmentEvent`. The work order accumulates amendment layers throughout S7. The work order is closed at S8 when all to-do items are COMPLETED or CANCELLED with recorded reason.

---

## §4 — Policy Envelope

### 4.1 Policies Active at S7

The following policies are active during S7. Enforcement points are the service methods named in §6 below.

---

**Policy 10 — Checkout Due Policy**
Active at S7. When the checkout timer fires, front desk is prompted. If checkout is not initiated within the late checkout grace window, FOM is notified. The timer does not block the guest — it creates a governed open task.

---

**Policy 21 — Mid-Stay Rate Amendment Policy**
Active at S7. Rate changes during stay require GM authority beyond the FOM override margin. Every mid-stay rate amendment produces a new segment. Rate cannot be revised below MSR regardless of authority level. The amendment mechanism enforces the approval chain before the folio adjustment is written.

---

**Policy 24 — Mid-Stay Discount Policy**
Active at S7. Mid-stay discounts always produce an `AmendmentEventRecord`. Folio lines for discounts cannot be posted without a prior approval event. FOM authority governs within configured threshold; GM authority for amounts beyond that threshold.

---

**Policy 32 — Billing Model Mid-Stay Transition Policy**
Active at S7. Mid-stay billing model changes require FOM authority at minimum; GM authority for changes constituting full renegotiation. Every billing model change produces a `BillingModelTransitionRecord`. The original billing model from S3 fixation remains permanently visible in the ordered record set.

---

**Policy 36 — Early Departure Policy**
Active at S7. Early departure requires GM authority. Shortened stay charges are calculated against the original commitment snapshot. The rate is not retrospectively renegotiated as a condition of early departure.

---

**Policy 45 — Credit Ceiling Active Monitoring Policy**
Active at S7 on every charge posting event and every night audit cycle. `CreditCeilingMonitorEngine.evaluate()` is called per charge and per night audit cycle. Three threshold responses: 75% advisory FOM dashboard notice; 90% non-dismissible FOM active interruption; 100% soft gate on non-mandatory charges. Night audit mandatory room charges (`ROOM_CHARGE` lineType) continue posting regardless of ceiling status. Non-mandatory charges at or above 100% require FOM acknowledgement before posting.

The 100% soft gate cannot be bypassed by operational staff. The mandatory room charge exception is hardcoded — no configuration overrides it.

---

**Policy 50 — DEFICIENT Resolution Tracking Policy**
Active at S7. If the resolution deadline fires without a resolution event, FOM is escalated. DEFICIENT conditions do not expire silently. Resolution is additive on the original record — the original condition is preserved.

---

**Policy 52 — Communication Acknowledgement Tracking Policy**
Active at S7 for amendment communications and any other outbound communications during the stay. Every governed communication opens an acknowledgement loop. The loop closes through one of four mechanisms:
1. Explicit acknowledgement received from recipient (`acknowledgementStatus = RECEIVED`).
2. Guest physically arrives — closing pre-arrival loops (this path is S5/S6 specific; at S7 all pre-arrival loops are already closed).
3. Governed timeout (`acknowledgementStatus = TIMED_OUT`) — TIMED_OUT is recorded as a permanent flag; non-acknowledgement becomes a visible flag on the entry.
4. OTA auto-fulfilment: for entries where `Entry.otaSource = true` and an OTA booking reference is present, the CONFIRMATION_ACK_TRACKER loop is auto-fulfilled on voucher dispatch. No `AcknowledgementWindowWorker` timer is registered for such entries — the OTA channel serves as the acknowledgement medium.

---

**Policy 53 — Active Dispute Management Policy**
Active at S7. An open dispute during S7 creates a mandatory FOM tracking obligation. Resolution bundle items are tracked to execution. `DISPUTE_EXHAUSTED` is not a valid dispute state — a dispute is either RESOLVED (guest accepted) or CLOSED (GM formal closure with recorded reason).

---

**Policy 54 — Dispute Gate Stage Progression Policy**
Active at S7→S8. `DisputeGateEngine.canProgressStage()` must be called on every S7→S8 progression. BLOCKED_WITH_OVERRIDE_AVAILABLE requires GM override with mandatory free-text reason and `DisputeGateOverrideRecord` creation. At S8→S9, override is not available.

---

**Policy 58 — Room Change Mode Trigger Policy**
Active at S7. Room change always creates a new segment. Prior segment is sealed on room change mode exit. Front desk authority for same-rate equivalent room changes; FOM authority for rate delta; GM authority for rate increase beyond FOM threshold.

---

**Policy 60 — Night Audit Charge Posting and Completeness Policy**
Active at S7 on every night audit cycle. `NightAuditEngine.runAudit()` is invoked; room charges posted per commitment snapshot; completeness check run against expected charges configuration. Missing expected charges produce `NightAuditAnomaly` records for FOM review — they are never auto-posted. Night audit is idempotent — a double-run for the same operating date does not produce duplicate charges.

---

**Policy 63 — Handoff Lifecycle Policy**
Active at S7 for H4 (created here) and H2/H3 updates. H4 completion is a mandatory S7→S8 gate condition. All handoff state transitions produce immutable audit events including auto-fulfilments.

---

**Policy 66 — Group FOC and Billing Split Policy**
Active at S7 for group entries — billing split activation during stay. Billing mode change mid-stay requires FOM authority. Group billing split follows the `GroupBillingMode` set at S3 — cannot be changed after S4 confirmation without a new segment.

---

**Policy 67 — Work Order Lifecycle Policy**
Active at S7 for conference and group engagements — consumption tracking. Every work order amendment at S7 is a layered event. In-stay to-do items tracked to COMPLETED or CANCELLED with reason.

---

### 4.2 Key Policy Invariants at S7

The following invariants apply unconditionally throughout S7 and cannot be overridden by configuration or operational authority:

- Night audit mandatory room charges continue posting regardless of credit ceiling status.
- `OCCUPIED → DEPARTED_CLEAN` direct transition is forbidden — room change always passes through DEPARTED_DIRTY.
- `DISPUTE_EXHAUSTED` is not a valid `DisputeState`.
- A room change implemented as a field edit rather than a governed segment creation is an architectural violation.
- A `FolioLine` once created is never edited — corrections are new offsetting lines only.

---

## §5 — Engines at S7

### 5.1 NightAuditEngine

**Engine:** `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult` (Part 4 §4.9)

**Purpose at S7:** Processes all active in-stay entries for a given operating date — posting daily room charges per each entry's commitment snapshot, running occupancy reconciliation, and performing the missing expected charges completeness check.

**Hardcoded behaviours active at S7:**
- Room charge amounts are derived from `Reservation.frozenRate` (commitment snapshot) — the engine never re-resolves the rate from the current rate plan. If the current rate plan has changed since S4, night audit uses the frozen rate.
- Idempotency guard: before processing any entry, the engine checks for a `FolioLine` with `chargeDate = operatingDate AND lineType = 'ROOM_CHARGE' AND nightAuditRecordId IS NOT NULL` on the live folio. If found, the entry is skipped. This prevents double-posting on re-run.
- Missing expected charges are never auto-posted. They are flagged as `NightAuditAnomaly` records with `anomalyType = 'MISSING_EXPECTED_CHARGE'` for FOM review.
- Entry processing failure produces `PARTIAL` run status — it does not halt the entire audit. Remaining entries continue to be processed.

**Configurable parameters relevant to S7:**
- `night_audit_schedule` — trigger type (automated schedule or staff-initiated).
- `night_audit_expected_charges_rules` — which charges are expected per rate plan; completeness check logic is hardcoded, the rules are configurable.
- `night_audit_anomaly_thresholds` — anomaly detection thresholds beyond missing expected charges.
- `night_audit_mandatory_charge_types` — extends the mandatory charge type set beyond the baseline `ROOM_CHARGE`.

**What the engine does not do:** Does not write any records. Does not call TaxEngine or CreditCeilingMonitorEngine. Does not send notifications. These are all calling service responsibilities.

### 5.2 CreditCeilingMonitorEngine

**Engine:** `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult` (Part 4 §4.8)

**Purpose at S7:** Evaluates the current outstanding balance against the credit extension ceiling on every charge posting event and every night audit cycle. Returns the active threshold tier and the required response.

**Hardcoded behaviours active at S7:**

| Threshold | Response |
|---|---|
| Below 75% | `response: 'NONE'` — no action |
| 75% reached | `response: 'ADVISORY'` — ambient FOM dashboard notice |
| 90% reached | `response: 'ACTIVE_INTERRUPTION'` — non-dismissible FOM notification requiring acknowledgement |
| 100% reached | `response: 'SOFT_GATE'` — FOM acknowledgement required before each non-mandatory charge posts |

- Night audit mandatory room charges (`ROOM_CHARGE`) always continue posting regardless of ceiling status — `chargeBlockedPendingAcknowledgement` is always `false` for mandatory charges, regardless of utilisation percentage.
- Threshold-crossing events are permanent records. If `thresholdCrossed: true`, the calling service writes a `CreditCeilingThresholdEvent`.
- The engine is called on every `FolioLine` create and after every night audit charge posting loop. Neither trigger is optional.

**What the engine does not do:** Does not write `CreditCeilingThresholdEvent`. Does not send notifications. Does not calculate the outstanding balance — it is injected by the calling service from the live folio.

### 5.3 DisputeGateEngine

**Engine:** `DisputeGateEngine.canProgressStage(input: DisputeGateInput): DisputeGateResult` (Part 4 §4.6)

**Purpose at S7:** Evaluates whether any active dispute blocks the S7→S8 transition.

**Return values at S7→S8:**
- `CLEAR` — no disputes configured as blocking; transition may proceed.
- `BLOCKED_WITH_OVERRIDE_AVAILABLE` — at least one dispute is configured as blocking; GM override path available. Service layer creates `DisputeGateOverrideRecord` on GM approval before transition proceeds.
- `BLOCKED` — dispute configured as blocking and no override available for this specific configuration.

**Hardcoded behaviour:** The engine returns the gate result. The service layer (not the engine) creates the `DisputeGateOverrideRecord` when GM exercises the override. The engine is not called again after the override record is written — the record is the authorised override evidence.

**What the engine does not do:** Does not resolve or close disputes. Does not create override records. Does not track FOM override frequency.

### 5.4 AmendmentEngine (via AmendmentService)

**Engine invocation:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult` (Part 4 §4.2)

**Purpose at S7:** Invoked by `AmendmentService.amend()` on Path 3 (full renegotiation) when a new rate plan is being applied. Not called for Path 1 or Path 2 folio adjustments where no rate plan change occurs.

**Path routing at S7:**

| Amendment type | Path | Authority |
|---|---|---|
| Simple cost addition | Path 1 — FolioLine addition with FOM confirmation | L1+ (FOM within threshold) |
| Rate or inclusion change (commercial amendment) | Path 2 — FolioLine with adjustment; amendment chain complete | L2 (FOM within override margin); L3 (GM for full rate change) |
| Full renegotiation — new segment | Path 3 — new segment; PricingPipelineEngine re-run; amended voucher generated | L3 (GM) for rate; L2 (FOM) for inclusions |
| Date change or room change post-S4 | System-locked to Path 3 | Re-entry required; new segment mandatory |
| Billing model change | System-locked to Path 2 minimum; FOM authority at every stage | L2 minimum |

### 5.5 ReEntryConsequenceEngine (S7→X rows)

**Engine:** `ReEntryConsequenceEngine.compute(input: ReEntryInput): ReEntryConsequencePayload` (Part 4 §4.11)

**S7→X consequence rows active at this stage:**

| Re-entry | Timer consequences | Folio consequences | Hold consequences | Handoff consequences | Inventory consequences |
|---|---|---|---|---|---|
| S7→S1 | Cancel `STAGE_DWELL_MONITOR` for current stage | Folio adjustment layer for rate delta; prior charges immutable | New segment holds new room assignment | Withdraw H2 (old room); re-create on new segment return | Old room: OCCUPIED → DEPARTED_DIRTY; new room begins readiness path |
| S7→S2 | None (stay is live; dwell continues) | Rate revision tracked as amendment layer; prior charges immutable | No hold change | No handoff change unless meal plan changes (H3 update) | No inventory change |
| S7→S3 | None | Billing model change produces new billing configuration record | No hold change | No handoff change | No inventory change |
| S7→S4 | None | Date extension: folio extended for new checkout date | No hold change | New `CHECKOUT_TIME` timer registered | Inventory claim extended to new checkout date |
| S8→S7 | Cancel `CHECKOUT_TIME` | No folio change — return to S7 for additional charge posting | No hold change | H4 returns to IN_PROGRESS | Room remains in checkout process |

---

## §6 — Services at S7

### 6.1 FolioService — postCharge and postAdjustment

**Service:** `FolioService` (Part 6 §6.5.4)

**Method: `FolioService.postCharge(folioId, chargeDetails, actorId)`**

The primary charge posting path at S7 for non-night-audit charges (F&B point of service, service delivery, miscellaneous). Also used by `NightAuditService` for room charge lines.

Execution sequence:
1. Validates `Folio.state = LIVE`. Rejects with `StateTransitionError` if not LIVE.
2. Validates the proposed charge date is not sealed by a past `NightAuditRecord` with `runStatus = COMPLETE`. If sealed, rejects with `StateTransitionError`.
3. Calls `TaxEngine.calculate(input: TaxInput): TaxResult` for the charge amount.
4. Writes `FolioLine` (immutable from creation) in the same transaction as the trace event.
5. For credit-ceiling-monitored entries, calls `CreditCeilingMonitorEngine.evaluate()` with the updated outstanding balance. If `chargeBlockedPendingAcknowledgement: true`, the charge must not have been posted without a prior FOM acknowledgement event — the block is enforced before the FolioLine write, not after.
6. If `thresholdCrossed: true`, writes `CreditCeilingThresholdEvent` and dispatches `CreditCeilingMonitoringWorker` (W12) notification via pg-boss.
7. Emits `CHARGE_POSTED` trace event.

**Policy enforcement points:** Policy 45 (Credit Ceiling Active Monitoring); Policy 60 (Night Audit Charge Posting — audit seal check).

**Forbidden acts enforced:** Posting to a non-LIVE folio; posting to a sealed audit date; posting a non-mandatory charge above 100% ceiling without FOM acknowledgement event on record.

**Method: `FolioService.postAdjustment(folioId, adjustmentDetails, actorId)`**

Posts a commercial adjustment or credit note offsetting an existing `FolioLine`. Used for corrections, service recovery compensation, and GM-level commercial adjustments.

- Creates a new `FolioLine` with a negative amount. The original line is never modified.
- Requires `AmendmentEventRecord` creation in the same transaction for governed amendments.
- For mid-stay discount applications, authority is verified per Policy 24 before the adjustment line is written.

### 6.2 NightAuditService

**Service:** `NightAuditService` (Part 6 §6.6.5)

**Method: `NightAuditService.runNightAudit(operatingDate, actorId)`**

The orchestrator of the nightly financial authority event. Called by `NightAuditWorker` (W6) on schedule or staff-triggered via `POST /night-audit/run`.

Execution sequence:
1. Idempotency guard: checks for `NightAuditRecord` with `operatingDate = today` and `runStatus = COMPLETE`. If found, exits.
2. Assembles `NightAuditInput` — all active S7 entries, their commitment snapshots, folio states, configuration values from `ConfigurationEntry` at runtime.
3. Calls `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult`.
4. Processes results — one Prisma transaction per entry:
   - Calls `TaxEngine.calculate()` per charge before writing `FolioLine`.
   - Calls `CreditCeilingMonitorEngine.evaluate()` after each `FolioLine` write for ceiling-monitored entries.
   - Writes `NightAuditAnomaly` per `MISSING_EXPECTED_CHARGE` or `AUDIT_EXCEPTION` anomaly.
   - `MISSING_EXPECTED_CHARGE` anomalies are surfaced to FOM for review — not auto-posted.
5. Writes `NightAuditRecord` (one per operating date, immutable from creation).
6. On `PARTIAL` run: escalates to FOM via `NotificationService`. Identifies `entriesNotProcessed`.
7. Generates AI Audit Supplement: passes `NightAuditResult.auditSupplementInputData` to `AIAgentApprovalService.generateAuditSupplement()`. AI supplement generation is a SYSTEM action — `TrustLevel.FULL_AUTO` applies; no human approval required (internal system action, not an outbound communication).
8. After `NightAuditRecord` written with `runStatus = COMPLETE`: calls `TimerManagementService.recalculateNextDayTimers(operatingDate)`.

**Forbidden acts enforced:** Modifying a sealed `NightAuditRecord`; posting charges for a past operating day into a sealed audit record; skipping night audit for an operating day with active stays.

### 6.3 EntryService — progressStage and createSegment

**Service:** `EntryService` (Part 6 §6.5.3)

**Method: `EntryService.progressStage(entryId, targetStage, transitionData, actorId)`**

At S7→S8: evaluates all five exit guards. Calls `DisputeGateEngine.canProgressStage()`. If gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` and GM has not recorded a `DisputeGateOverrideRecord`, blocks the transition. On satisfaction of all guards, transitions `Entry.currentStage → S8`, emits trace event.

**Method: `EntryService.createSegment(entryId, reEntryReason, actorId)`**

Called on all re-entry transitions that create a new segment (S7→S1, S7→S2 full renegotiation, S7→S3, S7→S4). Seals the prior segment and creates the new segment in a single transaction. Calls `ReEntryConsequenceEngine.compute()` and executes each consequence action within the same transaction. Partial segment creation (segment written without prior segment sealed, or without consequence execution) is a structural defect.

### 6.4 HandoffService — H4 creation and H2/H3 updates

**Service:** `HandoffService` (Part 6 §6.5.8)

**Method: `HandoffService.create(handoffType: H4, entryId, actorId)`**

Creates the H4 pre-checkout coordination `HandoffRecord` at S7 when the expected checkout date approaches. H4 carries: charges posted status, services accounted for confirmation, damage assessment readiness, DEFICIENT condition final status from housekeeping.

For same-day departures: `HandoffRecord.isAutoFulfilled = true` is set. The auto-fulfilment is a governed event with an audit record.

**H2 and H3 updates:** When room changes occur at S7, `HandoffService` withdraws the prior H2 `HandoffRecord` (transitions to SUPERSEDED or CLOSED with reason) and creates a new H2 for the new room on the new segment. When meal plan changes occur, H3 `HandoffRecord` is updated via a fulfilment evidence update that replaces the F&B obligation with the revised plan. All updates produce immutable audit events.

**Policy enforcement:** Policy 63 (Handoff Lifecycle) — all state transitions and auto-fulfilments produce audit events.

### 6.5 DisputeService

**Service:** `DisputeService` (Part 6 §6.5.9)

**Methods active at S7:** `DisputeService.open()`, `DisputeService.progress()`, `DisputeService.close()`, `DisputeService.reopen()`, `DisputeService.createResolutionBundle()`, `DisputeService.evaluateStageGate()`, `DisputeService.createGateOverride()`.

**Service recovery intake:** Service failures during S7 trigger the service recovery framework. `DisputeService.open()` (for guest-reported failures) or `DisputeService` via a hotel-detected failure path (for staff-observed failures) creates the `ServiceRecoveryRecord`. Front desk intake must be completable in under 30 seconds with the guest present — this is a capacity constraint, not a database constraint.

**Gate evaluation:** `DisputeService.evaluateStageGate()` calls `DisputeGateEngine.canProgressStage()` at S7→S8. When GM exercises the override, `DisputeService.createGateOverride()` creates the `DisputeGateOverrideRecord` with GM actor identity, timestamp, mandatory free-text reason, dispute reference, target stage, and gate return value. The record is immutable from creation.

**FOM override frequency:** `FomOverrideFrequencyWorker` (W32, cross-stage) monitors the rolling period pattern — it is not a concern of `DisputeService` but is triggered by the `DisputeGateOverrideRecord` creation.

**Policy enforcement:** Policy 53 (Active Dispute Management); Policy 54 (Dispute Gate Stage Progression); Policy 55 (Dispute Closure — at S9).

### 6.6 WorkOrderService

**Service:** `WorkOrderService` (Part 6 §6.5.10)

**Methods active at S7:** `WorkOrderService.amend()`, `WorkOrderService.createToDoItem()`, `WorkOrderService.updateToDoItem()`.

**Consumption tracking:** Each service delivery event at S7 (meal served, equipment set up, room serviced) is recorded as a `WorkOrderConsumptionRecord` via `WorkOrderService`. When `consumedQuantity > allocatedQuantity`, `isOverAllocation = true` — coordinator acknowledgement is required before the over-allocation is posted as an additional charge. `overAllocationAcknowledgedBy` and `overAllocationAcknowledgedAt` are required fields in this case.

**Coordinator governance:** Coordinator-initiated changes during the event are recorded as `WorkOrderAmendmentEvent` records. Coordinators do not have direct system access — staff record their instructions as system events.

**Policy enforcement:** Policy 67 (Work Order Lifecycle — consume at S7).

### 6.7 AmendmentService

**Service:** `AmendmentService` (Part 6 §6.6.2)

**Method: `AmendmentService.amend(entryId, amendmentType, path, actorId, reason)`**

The universal amendment mechanism for all mid-stay commercial modifications — rate changes, inclusion changes, date extensions, meal plan adjustments, and other commercial modifications.

- Path selection: system-locked paths for date changes and room changes (Path 3 mandatory); actor-selects for other amendment types (system presents options with contextual guidance; enforces authority for selected path; does not silently reroute).
- Path 1 handler: creates `FolioLine` via `FolioService`; creates `AmendmentEventRecord`; notifies guest if terms affected via `CommunicationService`.
- Path 2 handler: validates authority chain; creates `FolioLine` with adjustment; creates `AmendmentEventRecord`; updates affected timers via `TimerManagementService` if date, room, or billing affected.
- Path 3 handler: creates new segment via `EntryService.createSegment()`; marks prior confirmation SUPERSEDED; re-runs S2 pricing logic by invoking `PricingPipelineEngine.resolve()`; generates amended confirmation voucher; dispatches via `CommunicationService`.
- Billing model change: FOM authority required at every stage. Mandatory recorded reason. Invokes `FolioService.changeBillingModel()`. Creates immutable `BillingModelTransitionRecord`.

**Forbidden acts enforced:** Silent mutation of any committed field; rate change without `PricingPipelineEngine` re-run on Path 3; guest notification of changed terms without system-generated amended document; billing model change without FOM authority and recorded reason.

**Policy enforcement:** Policy 21 (Mid-Stay Rate Amendment); Policy 24 (Mid-Stay Discount); Policy 32 (Billing Model Mid-Stay Transition).

---

## §7 — Workers at S7

### W1 — StageDwellMonitor

**Trigger at S7:** Registered when the entry enters S7. Fires at configured warning and critical dwell thresholds if the entry remains in S7 without checkout progression.

**Behaviour at S7:** Three dwell modes: `ACTIVE` (progressing), `IDLE` (no recent activity), `PARKED` (explicitly parked). Warning → critical → FOM escalation in invariant sequence. Idempotency keyed on `(entryId, S7, event_phase)`.

**pg-boss job type:** `STAGE_DWELL_MONITOR`

**Configuration (dotted notation per MC-010):**
- `stageDwell.thresholds.s7.active.warningMinutes` — warning threshold for ACTIVE mode at S7
- `stageDwell.thresholds.s7.idle.criticalMinutes` — critical threshold for IDLE mode
- `stageDwell.thresholds.s7.escalation.fomThresholdMinutes` — FOM escalation threshold

**Models read:** `Entry` (`currentStage`, `status`, `parkedAt`), `StageDwellRecord`, `ConfigurationEntry`
**Models written:** `StageDwellRecord` (`warningFiredAt`, `criticalFiredAt`, `escalatedAt`), `TraceEvent`

**Timer registration/cancellation:** `STAGE_DWELL_MONITOR` timer registered at S7 entry. Cancelled on S7→S8 transition by the re-entry consequence engine (for S7→X re-entries) or by `EntryService.progressStage()` on S7→S8.

---

### W6 — NightAuditWorker

**Trigger at S7:** Scheduled recurring pg-boss job firing at configured night audit time for each operating night; or staff-triggered via `POST /night-audit/run`.

**Behaviour at S7:** Calls `NightAuditService.runNightAudit(operatingDate, actorId)` for all active in-stay entries. Idempotency enforced by engine's hardcoded guard (FolioLine presence check) and by service-level `NightAuditRecord` check. `PARTIAL` run status escalated to FOM immediately. Re-run is safe due to idempotency guard. AI Audit Supplement generation dispatched after COMPLETE run via `AIAuditSupplementWorker` (W18).

**pg-boss job type:** `NIGHT_AUDIT_SCHEDULE`

**Configuration (dotted notation):**
- `nightAudit.schedule` — trigger type (SCHEDULED | MANUAL)
- `nightAudit.expectedChargesRules` — completeness check rules per rate plan
- `nightAudit.anomalyThresholds` — anomaly detection thresholds
- `nightAudit.mandatoryChargeTypes` — mandatory charge type classification for credit ceiling

**Models read:** `Entry`, `Reservation`, `Folio`, `FolioLine`, `CreditExtensionCeilingRecord`, `ConfigurationEntry`, `NightAuditRecord` (idempotency)
**Models written:** `NightAuditRecord`, `NightAuditAnomaly`, `FolioLine` (ROOM_CHARGE per entry), `CreditCeilingThresholdEvent` (if threshold crossed), `TraceEvent`

**Engines invoked:** `NightAuditEngine.runAudit()`, `TaxEngine.calculate()`, `CreditCeilingMonitorEngine.evaluate()`

**Failure/dead-letter:** If run fails mid-execution, `NightAuditRecord` with `PARTIAL` status is written. DLQ entry triggers immediate FOM and operations alert — night audit failure is a financial-authority incident.

---

### W10 — DEFICIENTResolutionDeadlineWorker

**Trigger at S7:** Registered at S5 when a DEFICIENT flag is set on an assigned room. Fires at warning threshold (approaching deadline — housekeeping reminder dispatched) and at deadline breach (FOM escalated).

**Behaviour at S7:** Before dispatching, reads `DeficientConditionRecord.status`. If `status = "RESOLVED"`, condition is cleared — skip and log. Idempotency keyed on `(DeficientConditionRecord.id, event_phase)`.

**pg-boss job type:** `DEFICIENT_RESOLUTION_DEADLINE`

**Configuration (dotted notation):**
- `deficientCondition.resolutionDeadlineHours` — resolution deadline duration from flag creation
- `deficientCondition.warningOffsetHours` — warning offset before deadline

**Models read:** `DeficientConditionRecord` (`status`, `resolutionDeadline`, `roomId`), `Room` (`roomNumber`), `Entry` (`currentStage`)
**Models written:** `TraceEvent` (`DEFICIENT_RESOLUTION.WARNING_FIRED`, `DEFICIENT_RESOLUTION.DEADLINE_BREACHED`, `DEFICIENT_RESOLUTION.FOM_ESCALATED`)

**Policies enforced:** DEFICIENT Resolution Tracking Policy (Policy 50).

---

### W12 — CreditCeilingMonitoringWorker

**Trigger at S7:** Registered at S3 when credit extension is approved. Fires after `CreditCeilingThresholdEvent` records are written by `FolioService.postCharge()` or `NightAuditService` — the worker dispatches notifications based on those records.

**Behaviour at S7:** Before dispatching, reads `CreditCeilingThresholdEvent.thresholdPercentage`. If notification `TraceEvent` for same `(entryId, thresholdPercentage)` combination already exists, skip. Idempotency keyed on `(entryId, thresholdPercentage)`.

**pg-boss job type:** `CREDIT_CEILING_MONITORING`

**Configuration (dotted notation):**
- `creditCeiling.thresholds.advisory` — 75% (default)
- `creditCeiling.thresholds.activeInterruption` — 90% (default)
- `creditCeiling.thresholds.softGate` — 100% (default)
- `nightAudit.mandatoryChargeTypes` — mandatory charge classification

**Models read:** `CreditCeilingThresholdEvent`, `CreditExtensionCeilingRecord`, `Entry`
**Models written:** `TraceEvent` (`CREDIT_CEILING.ADVISORY_75`, `CREDIT_CEILING.FOM_INTERRUPTION_90`, `CREDIT_CEILING.SOFT_GATE_100`)

**Engines invoked:** `CreditCeilingMonitorEngine.evaluate()` — invoked transitively through `FolioService.postCharge()` and `NightAuditService`.

**Policies enforced:** Credit Ceiling Active Monitoring Policy (Policy 45).

**Failure:** 90% and 100% threshold notification failures are high-priority DLQ alerts.

---

### W21 — PaymentMilestoneWorker

**Trigger at S7:** Registered at S4 confirmation for CORPORATE and CONFERENCE entries with milestone billing schedules. Fires at each configured milestone due date during the stay.

**Behaviour at S7:** Checks whether the milestone payment has been received against the current folio balance. If received, skips. If not received, dispatches follow-up communication and escalates to FOM. Idempotency keyed on `(entryId, milestone_index, event_phase)`.

**pg-boss job type:** `PAYMENT_MILESTONE`

**Configuration (dotted notation per MC-010):**
- `paymentMilestone.scheduleTemplates` — milestone schedule per engagement type
- `paymentMilestone.warningOffsetDays` — warning offset before each milestone deadline (replaces flat key `payment_milestone_warning_offset`)

**Models read:** `Reservation`, `Folio`, `PaymentRecord`, `Entry`
**Models written:** `CommunicationRecord`, `TraceEvent`

**Policies enforced:** Post-Stay Payment Follow-Up Policy (Policy 11) in relation to outstanding milestone balances.

---

### W26 — CheckoutTimeWorker

**Trigger at S7:** Registered by `TimerEngine` as part of nightly timer recalculation after night audit completes. Fires when the checkout time for an in-stay entry is reached.

**Behaviour at S7:** Checks `Entry.currentStage`. If not S7 (checkout already underway or complete), skip. If checkout has not been initiated, dispatches prompt to front desk. If late checkout grace window expires without S7→S8 progression, escalates to FOM. Idempotency keyed on `(entryId, checkout_date, event_phase)`.

**pg-boss job type:** `CHECKOUT_TIME`

**Configuration (dotted notation):**
- `property.checkoutTime` — standard property checkout time
- `property.lateCheckoutGraceWindow` — late checkout grace duration

**Models read:** `Entry` (`currentStage`, `checkOutDate`), `Reservation` (`frozenCheckOutDate`)
**Models written:** `TraceEvent` (`CHECKOUT.TIME_REACHED`, `CHECKOUT.LATE_CHECKOUT_GRACE_EXPIRED`, `CHECKOUT.FOM_ESCALATED`)

**Policies enforced:** Checkout Due Policy (Policy 10).

**Timer cancellation:** `CHECKOUT_TIME` timer is cancelled on S8→S7 return (additional charge posting path) by the re-entry consequence engine. Re-registered when the entry re-progresses to S8.

---

### W27 — DisputeSLAWorker

**Trigger at S7:** Registered when a `DisputeRecord` is created (`DisputeState.OPEN`). Fires at time-to-first-response target and time-to-resolution target. For `ResolutionBundleItem` records, fires when a commitment deadline is approaching or breached.

**Sub-behaviour — Resolution execution:** When a `ResolutionBundle` is approved, each `ResolutionBundleItem` with a `commitmentDeadline` registers a deadline timer within this worker. Approaching deadline: warning to FOM. Deadline breach: open-loop flagged, FOM escalated.

**Behaviour at S7:** Before dispatching SLA events, reads `DisputeRecord.state`. If RESOLVED or CLOSED, skip. Idempotency keyed on `(DisputeRecord.id, SLA_phase)`. `DISPUTE_EXHAUSTED` is not a valid state — this worker never creates or transitions toward it.

**pg-boss job types:** `DISPUTE_SLA` (primary); `RESOLUTION_EXECUTION` (sub-behaviour)

**Configuration (dotted notation):**
- `dispute.sla.firstResponseMinutes` — time-to-first-response target
- `dispute.sla.resolutionDays` — time-to-resolution target
- `dispute.escalation.routing` — escalation routing per dispute category

**Models read:** `DisputeRecord` (`state`, `detectedAt`, `failureCategory`), `ResolutionBundle`, `ResolutionBundleItem`
**Models written:** `TraceEvent` (`DISPUTE_SLA.FIRST_RESPONSE_APPROACHING`, `DISPUTE_SLA.FIRST_RESPONSE_BREACHED`, `DISPUTE_SLA.RESOLUTION_SLA_APPROACHING`, `DISPUTE_SLA.RESOLUTION_SLA_BREACHED`, `RESOLUTION_EXECUTION.DEADLINE_APPROACHING`, `RESOLUTION_EXECUTION.DEADLINE_BREACHED`, `RESOLUTION_EXECUTION.FOM_ESCALATED`)

**Policies enforced:** Active Dispute Management Policy (Policy 53); Dispute Gate Stage Progression Policy (Policy 54) — SLA monitoring creates conditions that determine whether gate blocks.

**Failure:** Breach notification failures are high-priority DLQ alerts given the stage-gate consequence of unresolved disputes.

---

### W29 — EquipmentReturnWorker

**Trigger at S7:** Registered when equipment or assets are allocated to an event at `EquipmentAllocation` or `AssetAllocation` creation. Fires at return deadline approaching threshold and at breach.

**Behaviour at S7:** Reads `EquipmentAllocation.returnConfirmedAt`. If return confirmed, skip. Idempotency keyed on `(allocationId, event_phase)`. On breach: FOM alerted; sourcing record annotated via `TraceEvent`.

**pg-boss job type:** `EQUIPMENT_RETURN`

**Configuration (dotted notation):**
- `equipment.returnWarningOffsetHours` — warning offset before return deadline

**Models read:** `EquipmentAllocation` (`returnConfirmedAt`, `toDateTime`), `AssetAllocation` (`returnConfirmedAt`, `toDate`)
**Models written:** `TraceEvent` (`EQUIPMENT_RETURN.DEADLINE_APPROACHING`, `EQUIPMENT_RETURN.DEADLINE_BREACHED`, `EQUIPMENT_RETURN.FOM_ALERTED`)

**Policies enforced:** Work Order Lifecycle Policy (Policy 67) — equipment and sourcing tracking at S7–S9.

---

## §8 — API Routes at S7

### 8.1 Stage Progression Route

**Route: Progress Stage (S7→S8)**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | Policy 33 (Billing Model Settlement); Policy 54 (Dispute Gate Stage Progression); Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (night audit missing; DEFICIENT no final status; H4 not initiated), `PolicyGateBlockedError` (dispute gate blocked) |
| Pagination | No |

**ProgressStageRequestDTO fields at S7→S8 (MC-011 applied):**

| Field | Type | Required | Notes |
|---|---|---|---|
| `targetStage` | `string` | Required | Must be `"S8"` for S7→S8 progression |
| `transitionData` | `object` | Required | Stage-specific transition payload |
| `version` | `integer` | Required | Current `Entry.version` — optimistic lock guard. Per B4-001 decision (MOM-ARCH-2026-016). |

---

### 8.2 Charge Posting Route

**Route: Post Charge to Live Folio**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/charges` |
| Auth | `L1+` |
| Request DTO | `PostChargeRequestDTO` |
| Response DTO | `FolioLineResponseDTO` |
| Service method | `FolioService.postCharge()` |
| Policies | Policy 45 (Credit Ceiling Active Monitoring); Policy 60 (Night Audit Charge Posting — audit seal check) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (folio not LIVE; sealed audit date), `PolicyGateBlockedError` (credit ceiling 100% gate — FOM acknowledgement required) |
| Pagination | No |

---

### 8.3 Night Audit Routes

**Route: Trigger Night Audit**

| Field | Value |
|---|---|
| Method + Path | `POST /night-audit/run` |
| Auth | `L2+` |
| Request DTO | `RunNightAuditRequestDTO` (body: operatingDate) |
| Response DTO | `NightAuditResponseDTO` |
| Service method | `NightAuditService.runNightAudit()` |
| Policies | Policy 59 (Night Audit Countdown); Policy 60 (Night Audit Charge Posting and Completeness) |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

Night audit is primarily timer-fired by W6. This endpoint enables staff-triggered execution. Idempotency guard prevents double-execution. Rate limiting applies.

**Route: Get Night Audit Record**

| Field | Value |
|---|---|
| Method + Path | `GET /night-audit/:date` |
| Auth | `L2+` |
| Request DTO | `GetNightAuditRequestDTO` (path param: date in ISO format YYYY-MM-DD) |
| Response DTO | `NightAuditDetailResponseDTO` |
| Service method | `NightAuditService.getRecord()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

---

### 8.4 Amendment Route

**Route: Initiate Amendment**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/amend` |
| Auth | `L2+` (Path 1: L2+; Path 2: L2+ or L3 per Policy 21; Path 3: L3 for rate; L2+ for inclusions) |
| Request DTO | `AmendmentRequestDTO` |
| Response DTO | `AmendmentResponseDTO` |
| Service method | `AmendmentService.amend()` |
| Policies | Policy 21 (Mid-Stay Rate Amendment); Policy 24 (Mid-Stay Discount); Policy 32 (Billing Model Mid-Stay Transition) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (rate below MSR; authority insufficient), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 8.5 Dispute Routes

**Route: Open Dispute**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes` |
| Auth | `L1+` |
| Request DTO | `OpenDisputeRequestDTO` |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.open()` |
| Policies | Policy 53 (Active Dispute Management) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

**Route: Progress Dispute**

| Field | Value |
|---|---|
| Method + Path | `PATCH /disputes/:id` |
| Auth | `L2+` |
| Request DTO | `ProgressDisputeRequestDTO` |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.progress()` |
| Policies | Policy 53 (Active Dispute Management) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

**Route: Close Dispute**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/close` |
| Auth | `L3` |
| Request DTO | `CloseDisputeRequestDTO` (body: closureReason — mandatory) |
| Response DTO | `DisputeResponseDTO` |
| Service method | `DisputeService.close()` |
| Policies | Policy 55 (Dispute Closure) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (closure reason missing), `AppError` |
| Pagination | No |

**Route: Dispute Gate Override (S7→S8)**

| Field | Value |
|---|---|
| Method + Path | `POST /disputes/:id/gate-override` |
| Auth | `L3` |
| Request DTO | `DisputeGateOverrideRequestDTO` (body: freeTextReason — mandatory; targetStage) |
| Response DTO | `DisputeGateOverrideResponseDTO` |
| Service method | `DisputeService.createGateOverride()` |
| Policies | Policy 54 (Dispute Gate Stage Progression) |
| Error responses | `ValidationError`, `AuthorizationError` (actor not GM), `NotFoundError`, `PolicyGateBlockedError` (gate does not return BLOCKED_WITH_OVERRIDE_AVAILABLE; override not available at S8→S9), `AppError` |
| Pagination | No |

This endpoint is valid only when the dispute gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` at S7→S8. At S8→S9 the gate returns `BLOCKED` — a request to this endpoint at S8→S9 is rejected with `PolicyGateBlockedError`. Free-text reason is mandatory; absent or empty reason is rejected.

---

### 8.6 Work Order Routes

**Route: Amend Work Order**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders/:id/amend` |
| Auth | `L1+` |
| Request DTO | `AmendWorkOrderRequestDTO` |
| Response DTO | `WorkOrderResponseDTO` |
| Service method | `WorkOrderService.amend()` |
| Policies | Policy 67 (Work Order Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (work order not OPEN), `AppError` |
| Pagination | No |

**Route: Create To-Do Item**

| Field | Value |
|---|---|
| Method + Path | `POST /work-orders/:id/todo-items` |
| Auth | `L1+` |
| Request DTO | `CreateToDoItemRequestDTO` |
| Response DTO | `WorkOrderToDoItemResponseDTO` |
| Service method | `WorkOrderService.createToDoItem()` |
| Policies | Policy 67 (Work Order Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

**Route: Update To-Do Item**

| Field | Value |
|---|---|
| Method + Path | `PATCH /work-orders/:id/todo-items/:itemId` |
| Auth | `L1+` (cancellation requires L2+) |
| Request DTO | `UpdateToDoItemRequestDTO` |
| Response DTO | `WorkOrderToDoItemResponseDTO` |
| Service method | `WorkOrderService.updateToDoItem()` |
| Policies | Policy 67 (Work Order Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 8.7 Handoff Routes

**Route: Accept Handoff (H4)**

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/accept` |
| Auth | `L1+` |
| Request DTO | `AcceptHandoffRequestDTO` (path param: id; body: checklistCompletion) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.accept()` |
| Policies | Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (checklist incomplete), `StateTransitionError`, `AppError` |
| Pagination | No |

**Route: Fulfil Handoff (H4)**

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/fulfil` |
| Auth | `L1+` |
| Request DTO | `FulfilHandoffRequestDTO` (path param: id; body: fulfilmentEvidence) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.fulfil()` |
| Policies | Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (fulfilment evidence incomplete), `StateTransitionError`, `AppError` |
| Pagination | No |

---

### 8.8 Credit Note Route

**Route: Add Credit Note to Live Folio**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/credit-notes` |
| Auth | `L2+` |
| Request DTO | `AddCreditNoteRequestDTO` |
| Response DTO | `CreditNoteResponseDTO` |
| Service method | `FolioService.addCreditNote()` |
| Policies | Policy 24 (Mid-Stay Discount) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |
| Pagination | No |

---

### 8.9 Cancellation Route (Early Departure)

**Route: Cancel Entry (Early Departure at S7)**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/cancel` |
| Auth | `L3` (GM authority required for S7 early departure per Policy 36) |
| Request DTO | `CancelEntryRequestDTO` |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `CancellationService.cancel()` |
| Policies | Policy 34 (Cancellation Terms Disclosure); Policy 36 (Early Departure) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `StateTransitionError`, `AppError` |
| Pagination | No |

---

## §9 — Configuration Keys at S7

### 9.1 S7_READINESS Stage Group

Stage group identifier: `S7_READINESS`

At startup, the system validates all surfaces in this group. A missing or invalid surface raises `MissingConfigurationError` identifying the surface, the `S7_READINESS` group, and the operational consequence. The validation collects all failures before returning — it does not halt on the first failure.

| Configuration surface (dotted notation — MC-013 applied) | Consequence if absent |
|---|---|
| `nightAudit.schedule` | Night audit cannot execute — schedule not defined; `NightAuditSchedulerWorker` cannot register jobs |
| `nightAudit.expectedChargesRules` | Night audit completeness validation cannot execute — expected charge rules not defined; all stays produce `AUDIT_EXCEPTION` anomalies instead of completeness checks |
| `handoff.H4.checklist` | H4 handoff acceptance blocked — `HandoffService.create()` raises `MissingConfigurationError`; pre-checkout coordination cannot proceed |
| `discount.thresholds` | Amendment discount authority validation at S7 unavailable — mid-stay discount approval bands not defined |
| `billingModel.availablePerSource` | Billing model change during stay unavailable — no billing models defined for mid-stay transition |
| `dispute.gateFunction.config` | Dispute gate cannot evaluate — function parameters not defined; S7→S8 progression cannot be governed |
| `creditCeiling.clientTier.thresholds` | Credit ceiling monitoring at S7 unavailable — threshold percentages not defined; ceiling enforcement non-functional |
| `deficientCondition.resolutionDeadlineHours` | DEFICIENT SLA monitoring during stay cannot execute — DEFICIENTResolutionDeadlineWorker (W10) cannot register timers |
| `expiry.s7.defaultTtlSeconds` | Timer Engine cannot schedule S7 dwell events — dwell threshold durations not configured |

### 9.2 Additional Configuration Keys Active at S7

The following keys are not S7_READINESS blocking surfaces but are read by S7 services and workers at runtime. Their absence at runtime raises `MissingConfigurationError` and halts the specific operation.

| Key (dotted notation) | Reader | Consequence if absent at runtime |
|---|---|---|
| `nightAudit.anomalyThresholds` | `NightAuditService` | Anomaly detection limited to MISSING_EXPECTED_CHARGE; broader threshold detection non-functional |
| `nightAudit.mandatoryChargeTypes` | `FolioService`, `NightAuditService`, W12 | Credit ceiling mandatory charge classification falls back to baseline `ROOM_CHARGE` only |
| `creditCeiling.clientTier.thresholds` | W12, `FolioService` | Credit ceiling monitoring non-functional at runtime; all charges proceed without ceiling check |
| `stageDwell.thresholds.s7.*` | W1 | S7 dwell warnings and FOM escalations cannot fire |
| `paymentMilestone.warningOffsetDays` | W21 | Payment milestone warnings cannot be scheduled (replaces flat key `payment_milestone_warning_offset` per MC-010) |
| `property.checkoutTime` | W26 | Checkout time prompts cannot fire |
| `property.lateCheckoutGraceWindow` | W26 | Late checkout FOM escalation cannot be scheduled |
| `dispute.sla.firstResponseMinutes` | W27 | Dispute first-response SLA monitoring non-functional |
| `dispute.sla.resolutionDays` | W27 | Dispute resolution SLA monitoring non-functional |
| `equipment.returnWarningOffsetHours` | W29 | Equipment return warning cannot be dispatched |
| `acknowledgement.windowPerType` | W25 (H4 acceptance), `CommunicationService` | H4 acceptance timer cannot be registered; amendment communication acknowledgement timeout cannot be scheduled |

### 9.3 Blocking vs Non-Blocking Consequences

**Blocking (hard gate):** `nightAudit.schedule`, `nightAudit.expectedChargesRules`, `handoff.H4.checklist`, `dispute.gateFunction.config`, `creditCeiling.clientTier.thresholds`, `deficientCondition.resolutionDeadlineHours` — absent surfaces in this group cause `MissingConfigurationError` at S7 activation, preventing S7 from going live.

**Non-blocking (runtime degradation):** All keys in §9.2 — absent surfaces are detected at the moment the specific operation is attempted and halt only that operation. They do not prevent S7 from being live.

---

## §10 — Acceptance Criteria

The following assertions must be verified before SIG-S7 is considered implementation-complete. Each assertion is testable without live infrastructure where stated.

### 10.1 Folio Line Immutability

- [AC-S7-01] A `FolioLine` created by `FolioService.postCharge()` carries no UPDATE path in the Prisma service layer. Any attempt to modify a `FolioLine` field after creation raises an architectural defect flag in code review.
- [AC-S7-02] A correction to a posted charge creates a new `FolioLine` with a negative amount. The original `FolioLine` is unchanged.
- [AC-S7-03] Attempting to post a charge with `chargeDate` matching a past operating date that has a `NightAuditRecord` with `runStatus = COMPLETE` returns `StateTransitionError` with `blockingCondition: 'SEALED_AUDIT_DATE'`.

### 10.2 Night Audit Completeness Check

- [AC-S7-04] Running `NightAuditEngine.runAudit()` for an operating date where an entry's rate plan has an expected daily F&B charge that did not post produces a `NightAuditAnomaly` with `anomalyType = 'MISSING_EXPECTED_CHARGE'` for that entry. The missing charge is not posted automatically.
- [AC-S7-05] Running the night audit twice for the same operating date (idempotency re-run) produces no additional `FolioLine` records for entries already processed. The second run's `NightAuditRecord` reflects the previously processed entries as already-processed.
- [AC-S7-06] A `NightAuditRecord` with `runStatus = PARTIAL` is written when one entry cannot be processed. The record identifies the unprocessed entry in `entriesNotProcessed`. FOM is escalated via `NotificationService`.
- [AC-S7-07] After `NightAuditService.runNightAudit()` completes with `runStatus = COMPLETE`, `TimerManagementService.recalculateNextDayTimers()` is called.

### 10.3 Credit Ceiling Enforcement at All Three Thresholds

- [AC-S7-08] When `CreditCeilingMonitorEngine.evaluate()` returns `response = 'ADVISORY'` (75% threshold), `CreditCeilingThresholdEvent` is written and W12 dispatches a FOM dashboard notice.
- [AC-S7-09] When `response = 'ACTIVE_INTERRUPTION'` (90% threshold), FOM receives a non-dismissible interruption notification. The workflow does not continue until FOM acknowledges.
- [AC-S7-10] When `response = 'SOFT_GATE'` (100% threshold) and `chargeBlockedPendingAcknowledgement = true`, the non-mandatory charge is not posted until a FOM acknowledgement event is recorded. The attempt to post without acknowledgement returns `PolicyGateBlockedError`.
- [AC-S7-11] When `response = 'SOFT_GATE'` (100% threshold) and the charge is `lineType = 'ROOM_CHARGE'` (night audit mandatory), `chargeBlockedPendingAcknowledgement = false` — the charge posts without FOM acknowledgement. This is hardcoded and not overridable by configuration.

### 10.4 DEFICIENT Resolution Exit Gate

- [AC-S7-12] Attempting `EntryService.progressStage(entryId, S8)` when any `DeficientConditionRecord` for the occupied room has `status` that is neither `"RESOLVED"` nor `"UNRESOLVED"` (null, empty, or absent) returns `StageGateBlockedError` with `blockingCondition: 'DEFICIENT_NO_FINAL_STATUS'`.
- [AC-S7-13] When a DEFICIENT condition is resolved during S7 (housekeeping posts resolution event), `DeficientConditionRecord.status → "RESOLVED"`, `resolvedAt` and `resolvedBy` are populated additively. The original detection fields are unchanged.
- [AC-S7-14] When S7 exits with a DEFICIENT condition in `status = "UNRESOLVED"`, the condition carries into S8 with `DEFICIENT_UNRESOLVED_AT_CHECKOUT` state. The S8 room inspection record must reference this condition.

### 10.5 H4 Exit Gate

- [AC-S7-15] Attempting `EntryService.progressStage(entryId, S8)` when no H4 `HandoffRecord` exists in CREATED, ACCEPTED, FULFILLED, or auto-fulfilled state returns `StageGateBlockedError` with `blockingCondition: 'H4_NOT_INITIATED'`.
- [AC-S7-16] For same-day departures, H4 is auto-fulfilled with `HandoffRecord.isAutoFulfilled = true`. The auto-fulfilment produces an immutable audit event.

### 10.6 Dispute Gate

- [AC-S7-17] When `DisputeGateEngine.canProgressStage(entryId, S8)` returns `BLOCKED_WITH_OVERRIDE_AVAILABLE`, `EntryService.progressStage()` blocks the transition until a `DisputeGateOverrideRecord` with GM actor identity and mandatory free-text reason is created via `POST /disputes/:id/gate-override`.
- [AC-S7-18] A `DisputeGateOverrideRecord` is immutable from creation. No UPDATE path exists.
- [AC-S7-19] Calling `POST /disputes/:id/gate-override` with `targetStage = S9` returns `PolicyGateBlockedError` — override is not available at S8→S9.

### 10.7 Amendment Segment Creation

- [AC-S7-20] A room change during stay (S7→S1 re-entry) creates a new `Segment` record, seals the prior `Segment.sealedAt` in the same transaction, and transitions the old room from OCCUPIED to DEPARTED_DIRTY. These three writes are atomic — any partial commit is a structural defect.
- [AC-S7-21] An attempt to process a room change by directly editing the room assignment field (without `EntryService.createSegment()`) is rejected by the service layer as a forbidden pattern.
- [AC-S7-22] `ReEntryConsequenceEngine.compute()` is called before the segment write is committed for all S7→X re-entries. The consequence payload is executed in the same transaction. If any consequence action fails, the entire segment creation rolls back.

### 10.8 Room Change Inventory Transitions

- [AC-S7-23] On S7→S1 room change re-entry, the old room's `Room.currentClaimState` transitions from OCCUPIED to DEPARTED_DIRTY in the same transaction as the new segment creation. A `RoomClaimStateEvent` is written for this transition.
- [AC-S7-24] The `OCCUPIED → DEPARTED_CLEAN` direct transition is rejected with an architectural defect flag. Housekeeping action (DEPARTED_DIRTY → DEPARTED_CLEAN) is the mandatory intermediate step.

### 10.9 ProgressStageRequestDTO version field

- [AC-S7-25] The `POST /entries/:id/progress-stage` route for S7→S8 includes `version: integer` as a required field in `ProgressStageRequestDTO`. A request without `version` is rejected with `ValidationError`. This is the optimistic lock guard per B4-001.

### 10.10 Worker Numbering

- [AC-S7-26] W34 references in this document refer to `AdvancePaymentFollowUpWorker`. W35 refers to `QuotationAckWorker`. These assignments are locked by Architect (14 April 2026). No worker in S7 is numbered W34 or W35 — both are not active at S7; this assertion confirms the numbering convention is not confused.

---

## SIG-S7-COR-001 — Finding Register

**ID:** SIG-S7-COR-001
**Discovered in:** SIG-S7 v1.0 generation session, 2026-04-15
**Type:** NEW-CONTENT
**Target:** DEV-SPEC-001-Part2-REV2-FINAL.md — missing `model AmendmentEventRecord` Prisma block
**Context:** `AmendmentEventRecord` is referenced in Part 6 REV3 §6.6.2 `AmendmentService` Path 1 and Path 2 handlers (each creates an `AmendmentEventRecord`). The `AmendmentPath` enum exists in Part 2 (line 400). However, no `model AmendmentEventRecord { ... }` Prisma block exists anywhere in Part 2 REV2-FINAL. The model is absent from the schema, leaving the Path 1 and Path 2 handlers without a schema anchor.
**SIG-S7 carries:** Derived schema specification in §2.10 above. Developer can implement from SIG-S7 §2.10.
**Required change:** Add `model AmendmentEventRecord { ... }` to Part 2 REV2-FINAL as derived in §2.10. Add back-relations `amendmentEventRecords AmendmentEventRecord[]` to `Entry` and `Segment` models. Register this in the consolidated revision pass.
**Status:** `PENDING`

---

## Self-Check Results

| Check | Result |
|---|---|
| No gap markers (`[GAP-`, `FINDING-`, `PENDING-`) in body | ✅ Zero instances |
| No fallback language ("until correction", "if available", "pending schema") | ✅ Zero instances |
| No Canon provenance (`§48`, `Canon`, `DOSS`, `FAC`) | ✅ Zero instances |
| No flat config key names (`_threshold`, `_rules`, `_config`, `_ttl` as standalone keys) | ✅ All keys in dotted notation per MC-013 and MC-010 |
| `version` field in ProgressStageRequestDTO | ✅ Present in §8.1 S7→S8 route |
| DEFICIENT exit gate in §1 exit conditions | ✅ Present — "DEFICIENT condition with no final status recorded blocks S7 exit" |
| Night audit exit gate in §1 exit conditions | ✅ Present — "A missing night audit for any stay day blocks S7 exit unconditionally" |
| FolioLine immutability in §2 | ✅ Present — "FolioLine records are immutable after posting" |
| Credit ceiling 100% mandatory charge exception | ✅ Present in §4.1 Policy 45 and §5.2 engine spec — mandatory room charges post regardless of ceiling |
| Worker W34/W35 numbering | ✅ AC-S7-26 confirms W34 = AdvancePaymentFollowUpWorker; W35 = QuotationAckWorker; neither active at S7 |
| Schema gap found and registered | ✅ SIG-S7-COR-001 registered; derived schema carried in §2.10 |

---

*SIG-S7 v1.0 — Produced 15 April 2026*
*Prepared by Claude (AI Architectural Partner)*
*Source-grounded from 12 declared source files*
*Pending review and lock by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until the Architect confirms.*
