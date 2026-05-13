# LEGPHEL PMS — DEV-SPEC-001
# Part 6 — Services
# §6.1 through §6.7

**Document:** DEV-SPEC-001-Part6.md
**Status:** DRAFT — awaiting Architect review and lock confirmation
**Canon version:** v2.5
**Authority:** MOM-ARCH-2026-014
**Gate:** Gate 6 — Services
**Date:** 07 April 2026
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 6 — Services |
| Sections covered | §6.1 through §6.7 |
| Declared Canon sources | Canon Block 9 §§51–55, 62 (Amendment, Cancellation, Dispute, No-Show, Early/Late, Night Audit); Canon Block 10 §§56, 57, 58, 70A, 70B, 70C (Group Booking, Room Moves, Communication, Soft Processing Lock, AI Agent, Voice Note); Canon Block 11 §77 (Event Catalogue v2.2 + v2.3 REV-B11-V23-07 additions) |
| Schema reference | DEV-SPEC-001-Part2.md (LOCKED) — all Prisma model names, enum values, and field names; no model or enum redefined here |
| State machine reference | DEV-SPEC-001-Part3.md (LOCKED) — services invoke state machine transitions; guard logic lives in Part 3; not redefined here |
| Engine reference | DEV-SPEC-001-Part4.md (LOCKED) — engine names and method signatures; services invoke engines using exact signatures from Part 4 |
| Policy reference | DEV-SPEC-001-Part5.md (LOCKED) — every named policy has a declared enforcement point; service methods at those enforcement points must invoke the policy |
| ToC source | DEV-SPEC-001_ToC_FINAL.md (LOCKED) |
| Status | DRAFT — nothing is locked until Architect confirms |
| Previous gate | Gate 5 — Policies (LOCKED, pending Architect confirmation) |
| Depends on | Parts 1–5 LOCKED; Actor-Authority Matrix LOCKED; Canon v2.5 confirmed; Infrastructure decisions locked (pg-boss, Prisma) |

---

## Open Items Addressed at This Gate

| ID | Item | Resolution |
|---|---|---|
| OI-014-01 | Verify AI agent actor identity in Part 2 schema | Resolved. `ActorLevel.SYSTEM` (L0) is present in Part 2 §2.1.3. `AiDraftRecord.aiActorId` accepts the configured AI system actor identifier string. The AI agent is a SYSTEM actor, not a `StaffUser` — no foreign key to `StaffUser` is required or created. |
| OI-014-02 | Pattern rule registry as AIAgentApprovalService runtime configuration dependency (§70B M.7) | Addressed in §6.6 AIAgentApprovalService — pattern rule registry is a runtime configuration dependency loaded at service initialisation from the configuration tables. |

---

## Gate 6 Source Declaration

All sources loaded before writing began, in this order:

| Source | Scope |
|---|---|
| DEV-SPEC-001_ToC_FINAL.md | Part 6 §§6.1–6.7 content requirements |
| Canon Block 9 §§51–55, 62 | Amendment, Cancellation, Dispute, No-Show, Early/Late Check-In/Checkout, Night Audit |
| Canon Block 10 §§56, 57, 58, 70A, 70B, 70C | Group Booking, Room Moves, Communication, Soft Processing Lock, AI Agent, Voice Note |
| Canon Block 11 §77 | Event Catalogue (v2.2 base taxonomy) |
| CANON-V2.3-CHANGESET.md REV-B11-V23-07 | Event Catalogue v2.3 additions (§70A/70B/70C events + dispute gate override events) |
| Canon Block 11 §76 | Stage-to-Timer/Worker Matrix (timer registration in services) |
| DEV-SPEC-001-Part2.md | Schema reference — model names, enum values, mutation rules |
| DEV-SPEC-001-Part3.md | State machine reference — guard conditions; transition invocation patterns |
| DEV-SPEC-001-Part4.md | Engine reference — method signatures; what engines do not do (service responsibilities) |
| DEV-SPEC-001-Part5.md | Policy reference — 77 named policies and their enforcement points |

---

## §6.1 — Service Design Principles

### 6.1.1 What a Service Is

A service is an orchestration unit. It coordinates the actions of policies, engines, state machines, and models to fulfil a governed business operation. A service does not contain business logic inline — it invokes policies that evaluate the business logic and acts on their decisions. A service does not contain computation — it invokes engines that compute and acts on their results. A service does not write raw SQL — it writes records through Prisma model operations.

This boundary is the structural guarantee that makes the system testable and correct across every code path, including paths that bypass the UI or the controller layer.

### 6.1.2 Separation of Concerns — The Layer Chain

The layer chain is strictly ordered. No layer may skip another.

```
HTTP Request
    ↓
Controller (thin HTTP adapter — validates request shape, extracts parameters, invokes service)
    ↓
Service (orchestrates: invokes policies, invokes engines, invokes state machine transitions,
         writes records via Prisma, emits trace events, dispatches jobs via pg-boss)
    ↓
Policies (pure evaluators — input → APPROVED | DENIED | ESCALATE(ActorLevel))
Engines  (pure computation — input → typed result; no side effects)
State Machines (govern transitions — guard conditions defined in Part 3)
    ↓
Prisma Models (data persistence — no business logic; query specifications only)
    ↓
PostgreSQL
```

**Forbidden in every service method:**

- Inline business rule evaluation without invoking the governing policy
- Direct SQL or raw database queries — all database access through Prisma
- Computation that belongs in an engine — if a value must be calculated, the engine calculates it
- Re-implementing a state machine guard that is already defined in Part 3
- Calling another service from a domain service (domain services do not import application services)
- Creating side effects from within an engine call (engines have no side effects — side effects belong to the service that called the engine)

### 6.1.3 Import Direction Rules

The import direction rules from Part 1 §1.7 are reproduced here for the service layer:

| Service Class | May Import | May Not Import |
|---|---|---|
| Infrastructure services | Nothing above themselves | Domain services, application services |
| Domain services | Infrastructure services | Application services |
| Application services | Domain services, infrastructure services | Circular dependencies |

No service of any class may create a circular dependency. Any import that would produce a cycle is an architectural violation regardless of whether the build tool tolerates it.

### 6.1.4 Policy Enforcement Is Unconditional

Every named policy in Part 5 has a declared enforcement point. A service method that is the declared enforcement point for a policy **must** invoke that policy on every code path that reaches the service method, including:

- Calls from the controller via HTTP
- Calls from other services (intra-layer orchestration)
- Calls from workers (timer-fired operations)
- Direct calls in test environments (bypassing all middleware)

There is no code path that legitimately reaches the service layer and bypasses policy enforcement. A policy that is only triggered through a UI flow or through a specific middleware chain is an architectural defect.

### 6.1.5 Trace Events Are Synchronous and Transactional

Every state machine transition emits a `TraceEvent` in the same Prisma transaction as the state change. This is the §82 eventing doctrine. If the transaction rolls back, the trace event rolls back with it. There is no deferred, queued, or asynchronous trace event emission for state transitions.

The pattern:

```javascript
// CORRECT
await prisma.$transaction(async (tx) => {
  await tx.entry.update({ where: { id }, data: { currentStage: Stage.S2 } });
  await tx.traceEvent.create({ data: { eventType: 'STAGE_TRANSITION', ... } });
});

// FORBIDDEN — trace event outside the transaction
await prisma.entry.update(...);
await prisma.traceEvent.create(...); // emitted even if update fails or is rolled back
```

Non-state-change trace events (for example, audit annotations, access log events) may be emitted asynchronously after the transaction commits. Only events that record a state change are bound to the same transaction.

---

## §6.2 — Transaction Management and Consistency

### 6.2.1 Transaction Scope

Every service operation that combines a state change with a trace event must execute both within a single Prisma `$transaction`. The rule is simple: if the operation fails, nothing is committed — not the state change, not the trace event, not any intermediate record.

The following operations always execute within a single transaction:

- Stage transition (`Entry.currentStage` update) + `TraceEvent` emission
- Folio state change (`Folio.state` update) + `FolioLine` creation + `TraceEvent` emission
- Dispute state change + `TraceEvent` emission
- Processing lock status change + `TimerEvent` + `TraceEvent` emission
- No-show determination + folio closure (`NO_SHOW_CLOSED`) + penalty posting + `TraceEvent`
- Night audit charge posting per entry + `FolioLine` creation + anomaly records (one transaction per entry, executed sequentially across all entries — not one transaction for the entire audit)

### 6.2.2 Rollback Doctrine

A partial state change is an architectural defect. If any step within a transaction fails, all steps within that transaction must roll back. The service must not leave the system in a state where, for example, a `FolioLine` was written but the corresponding `TraceEvent` was not, or where an entry advanced to a new stage but the handoff creation failed.

The rollback doctrine is enforced by Prisma's `$transaction` implementation: a thrown error within the transaction callback triggers a full rollback. Service methods must not catch and suppress errors within the transaction callback.

If a multi-step operation requires work that cannot be rolled back (for example, sending an outbound email or SMS), that step must occur **after** the database transaction commits, never within it. The pattern: commit the system state record first; then dispatch the communication as a pg-boss job after commit; the job handles the outbound action and records its own result.

### 6.2.3 Idempotency Requirements

All operations that may be retried must be idempotent. The two primary sources of retry-eligible operations are:

**Timer-fired operations.** When a pg-boss job fires, the worker that handles it must check whether the operation has already been completed before applying it. The idempotency guard checks for the presence of the completion event or record. If found, the worker exits without applying the operation again. Example: the `NightAuditSchedulerWorker` checks for a completed `NightAuditRecord` for that operating date before proceeding.

**Worker-fired operations.** Workers that handle cascading effects from a primary operation (for example, `ProcessingLockExpiryWorker`, `NoShowCutoffWorker`) must check the current state of the governed entity before acting. If the entity has already transitioned beyond the state the worker expects, the worker exits cleanly.

**Idempotency key strategy per operation type:**

| Operation Type | Idempotency Key | Guard Check |
|---|---|---|
| Night audit charge posting | `(operatingDate, entryId)` | Presence of completed `FolioLine` with `lineDate = operatingDate` for entry |
| Night audit run | `operatingDate` | Presence of `NightAuditRecord` with `runStatus = COMPLETE` for date |
| Processing lock expiry notification | `processingLockId` | `ProcessingLockRecord.status = EXPIRED` already set |
| No-show determination | `(entryId, determinationDate)` | Presence of `NoShowDeterminationRecord` for entry |
| Timer fire | `timerRecordId` | `TimerRecord.status = FIRED` already set |
| Commission-due record creation | `entryId` | Presence of `CommissionDueRecord` for entry at S9 |
| Acknowledgement timeout | `communicationRecordId` | `CommunicationRecord.acknowledgementStatus = TIMED_OUT` already set |

### 6.2.4 Concurrency Controls

Where multiple service calls may race on the same entity (for example, two callers attempting to advance the same entry from S1 to S2 simultaneously), the Prisma `where` clause must be constructed to include the expected source state as a condition:

```javascript
const updated = await prisma.entry.updateMany({
  where: { id: entryId, currentStage: Stage.S1 }, // guard: only update if still at S1
  data: { currentStage: Stage.S2 },
});
if (updated.count === 0) {
  throw new StateTransitionError('Entry not in expected source stage S1');
}
```

This is not a substitute for state machine guard evaluation — it is a database-level safety net that prevents a race condition from silently corrupting state after the guard has passed.

---

## §6.3 — Event Dispatch Architecture

### 6.3.1 Event Bus Pattern

The system uses an internal event bus to decouple event emission from event handling. The event bus operates in two modes based on event criticality:

**Critical events** are emitted synchronously within the database transaction. They are trace events that record a state change. Their emission is governed by §6.2.1. If the transaction rolls back, the critical event record does not exist.

**Non-critical events** are emitted as pg-boss jobs after the database transaction commits. They represent downstream consequences of a state change — for example, dispatching a notification to FOM after a processing lock expires, or triggering a housekeeping SLA reminder after a handoff is created. These events are durable (pg-boss ensures they are not lost on restart) but are not part of the primary transaction.

The bus pattern:

```javascript
// In service layer after transaction commit:
await eventBus.emit('PROCESSING_LOCK_EXPIRED', {
  processingLockId,
  expiredAt,
  correlationId,
});

// Subscriber registered by NotificationService:
eventBus.on('PROCESSING_LOCK_EXPIRED', async (payload) => {
  await notificationService.dispatchOperatorExpiry(payload);
});
```

### 6.3.2 Critical vs Non-Critical Classification

| Event Category | Mode | Example |
|---|---|---|
| Stage transition trace events | Critical (in-tx) | `STAGE_S1_TO_S2`, `STAGE_S5_NO_SHOW_PATH` |
| Folio state change trace events | Critical (in-tx) | `FOLIO_CONVERTED_TO_LIVE`, `FOLIO_NO_SHOW_CLOSED` |
| Policy gate block events | Critical (in-tx) | `POLICY_GATE_BLOCKED` |
| Processing lock expiry | Non-critical (pg-boss job) | `PROCESSING_LOCK_EXPIRED` |
| Notification dispatch | Non-critical (pg-boss job) | `FOM_ESCALATION`, `OPERATOR_NOTIFICATION` |
| AI draft review TTL exceeded | Non-critical (pg-boss job) | `AI_DRAFT_TTL_EXCEEDED` |
| Voice note SLA breach | Non-critical (pg-boss job) | `VOICE_NOTE_SLA_BREACHED` |
| Night audit completion signal | Non-critical (pg-boss job) | `NIGHT_AUDIT_COMPLETED` |
| Correction log aggregation trigger | Non-critical (pg-boss job) | `CORRECTION_LOG_AGGREGATE` |

### 6.3.3 Payload Contract

Every event emitted through the bus carries a typed payload conforming to the `TraceEvent` structure from §77:

```typescript
interface EventPayload {
  eventType: string;        // from the Event Catalogue (§6.4)
  timestamp: Date;          // UTC; set by the emitting service; not by the subscriber
  actorId: string;          // L0 SYSTEM or human actor; NEVER null
  entityReference: string;  // primary entity ID (Entry.id, Folio.id, etc.)
  entityType: string;       // 'Entry' | 'Folio' | 'Dispute' | etc.
  stageContext?: Stage;     // current stage of the entity at time of event
  segmentId?: string;       // current segment ID where applicable
  correlationId: string;    // links events in a chain (e.g., inbound → draft → decision → send)
  payload?: Record<string, unknown>; // event-specific structured data
}
```

The `correlationId` is the mechanism for tracing the full chain of related events. The first event in a chain generates the `correlationId`; all downstream events in the same chain carry the same `correlationId`. For the AI communication chain, the `correlationId` links: inbound message receipt → AI classification → draft generation → human decision → outbound send.

### 6.3.4 Extension Point Contract

New event subscribers are registered without modifying existing service code. The extension mechanism:

```javascript
// Registration pattern — new subscriber added to the bus without touching the emitting service:
eventBus.on('STAGE_TRANSITION', newSubscriberHandler);

// Unregistration (e.g., for feature flags or conditional behaviour):
eventBus.off('STAGE_TRANSITION', handler);
```

A subscriber must never modify the event payload or throw an error that propagates to the emitting service. If a subscriber fails, its failure is logged and isolated — it does not roll back the primary operation that caused the event. This constraint ensures that adding a new subscriber cannot introduce a regression in existing behaviour.

### 6.3.5 Trace Event Structure in the Database

Critical trace events are written as `TraceEvent` records (Part 2 §2.15). The following fields are NOT NULL at the database level and must never be null in any code path:

- `actorId` — the authenticated actor who caused the event (L0 SYSTEM for automated events)
- `entityId` — the primary entity reference
- `operation` — the operation that caused this event
- `timestamp` — UTC timestamp at time of event

A trace event record with any of these four fields null is a structural defect, not a data quality issue. The schema constraint (NOT NULL) catches this at the database level; the service layer must ensure the values are populated before the transaction commits.

---

## §6.4 — Event Catalogue Reference

### 6.4.1 Purpose and Authority

This section is the implementation-facing reference for all events the system must capture. The primary source is Canon Block 11 §77 (Event Catalogue, v2.2) as extended by CANON-V2.3-CHANGESET REV-B11-V23-07 (§70A, §70B, §70C events and dispute gate override events). No event is defined here that does not have a §77 or REV-B11-V23-07 basis.

Every event in this catalogue carries the payload fields defined in §6.3.3. Every event that records a state change is emitted as a critical (in-transaction) trace event per §6.1.5. Other events are emitted as non-critical (post-commit) pg-boss jobs.

### 6.4.2 Human-Initiated Events

Human-initiated events are triggered by a human actor taking an explicit action in the system.

**Inquiry and entry lifecycle:**
- `INQUIRY_CREATED` — new inquiry created at S1
- `ENTRY_CREATED` — new entry created under an inquiry at S1
- `AVAILABILITY_SEARCHED` — availability search executed; includes DEFICIENT flag acknowledgement where applicable
- `CONFIGURATION_SELECTED` — guest or staff selects a preferred availability configuration

**Quotation and commercial:**
- `QUOTATION_CREATED` — quotation created at S2
- `QUOTATION_SENT` — quotation dispatched to guest or agent
- `QUOTATION_ACCEPTED` — guest or agent accepts quotation
- `HOLD_PLACED` — speculative or committed hold placed on inventory
- `RESERVATION_CONFIRMED` — reservation confirmed at S4; commitment snapshot frozen

**Check-in and stay:**
- `ROOM_ASSIGNED` — room assigned to entry; includes DEFICIENT flag status of assigned room
- `IDENTITY_VERIFIED` — guest identity verified at S6
- `CHECK_IN_COMPLETED` — guest checked in; folio converted to live; billing model activated
- `VIP_ARRIVAL_NOTIFICATION_ISSUED` — VIP arrival notification dispatched to configured staff roles at S6 commencement for VIP-tier guests
- `CHECKOUT_INITIATED` — checkout initiated at S8
- `CHECKOUT_COMPLETED` — guest departed; room transitions to DEPARTED_DIRTY

**Amendments and changes:**
- `AMENDMENT_REQUESTED` — amendment request initiated (any stage)
- `ROOM_CHANGE_INITIATED` — room change mode activated during S7
- `BILLING_MODEL_CHANGED` — billing model transition recorded; FOM authority and reason mandatory

**Parking and cancellation:**
- `ENTRY_PARKED` — entry parked; inventory suspended
- `ENTRY_UNPARKED` — entry unparked
- `CANCELLATION_REQUESTED` — cancellation request submitted

**Dispute and service recovery:**
- `DISPUTE_FILED` — formal dispute record created (any stage)
- `SERVICE_RECOVERY_INITIATED` — service recovery record created
- `ESCALATION_REQUESTED` — escalation to higher authority tier initiated
- `DISPUTE_GATE_OVERRIDE_INVOKED` — GM invokes override when gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE`; produces `DisputeGateOverrideRecord`

**Handoffs and coordination:**
- `HANDOFF_CREATED` — handoff created (H1–H5)
- `HANDOFF_ACCEPTED` — receiving party accepts handoff
- `HANDOFF_FULFILLED` — handoff obligations completed
- `COORDINATOR_AMENDMENT_RECORDED` — coordinator instruction recorded by staff (coordinators have no direct system access)
- `WORK_ORDER_TODO_COMPLETED` — individual work order to-do item marked complete

**Financial:**
- `PAYMENT_RECEIVED` — payment recorded
- `COMMISSION_DUE_RECORD_CREATED` — commission-due record created at S9 closure (configuration-activated)

**Miscellaneous:**
- `FEEDBACK_SUBMITTED` — guest or agent feedback submitted
- `NO_SHOW_DETERMINED` — FOM makes formal no-show determination
- `DEFICIENT_CONDITION_RESOLVED` — DEFICIENT flag on room resolved; resolution event posted
- `CREDIT_CEILING_THRESHOLD_ACKNOWLEDGED` — FOM acknowledges credit ceiling threshold alert

**AI processing (human-side):**
- `VOICE_NOTE_REVIEW_COMPLETED` — staff member completes voice note review; `CommunicationRecord` transitions from `VOICE_NOTE_UNPROCESSED` to `REVIEWED`
- `STAFF_LISTENING_SUMMARY_LOGGED` — structured `StaffListeningSummaryRecord` written by reviewing staff member
- `AI_DRAFT_APPROVED` — human actor approves AI draft without modification; `HumanDecisionRecord` created with `HumanDecisionType.APPROVE`
- `AI_DRAFT_EDITED_AND_APPROVED` — human actor edits and approves AI draft; `HumanDecisionRecord` created with `HumanDecisionType.EDIT_AND_APPROVE`; modified content recorded in `HumanDecisionRecord.finalContent`
- `AI_DRAFT_REJECTED` — human actor rejects AI draft; `HumanDecisionRecord` created with `HumanDecisionType.REJECT`; reason mandatory

### 6.4.3 System-Generated Events

System-generated events are triggered by automated system processes — the Timer Engine, workers, the night audit engine, and the AI communication agent acting as a SYSTEM actor.

**Stage and lifecycle:**
- `STAGE_TRANSITION` — entry advances from one stage to the next; every stage transition including auto-fulfilments
- `AUTO_FULFILMENT` — S2 auto-fulfilment (standard package rate accepted), S4→S5 immediate activation, walk-in S5 compression
- `ENTRY_EXPIRY` — entry reaches terminal EXPIRED state via expiry worker

**Timer events:**
- `TIMER_WARNING` — timer passes warning threshold
- `TIMER_CRITICAL` — timer passes critical threshold
- `TIMER_EXPIRY` — timer fires; entity transitions to post-expiry state

**Audit and monitoring:**
- `STAGE_DWELL_IDLE_DETECTED` — StageDwellMonitor detects idle state for an entry
- `NIGHT_AUDIT_COMPLETED` — night audit completes for operating date; completeness check results included
- `CHARGE_POSTED` — automated charge posting (room charge, package allocation) by night audit process
- `MAINTENANCE_CONFLICT_DETECTED` — room under maintenance has a booking conflict detected
- `DUPLICATE_DETECTED` — duplicate entry detection at S1 creation or S4 multi-booking check
- `SHIFT_BOUNDARY_CHECK_TRIGGERED` — shift boundary check fires

**Handoffs and notifications:**
- `H1_AUTO_FULFILLED` — H1 handoff auto-fulfilled when reservations and front desk are the same team
- `NOTIFICATION_DISPATCHED` — outbound notification dispatched (all four notification tiers)
- `ACKNOWLEDGEMENT_TIMEOUT` — outbound communication's acknowledgement window expires without acknowledgement received

**Overbooking:**
- `OVERBOOKING_DETECTED` — overbooking condition detected at S4; includes trigger type (`DELIBERATE` or `OTA_CONFLICT`)

**Financial and credit:**
- `CREDIT_CEILING_THRESHOLD_CROSSED` — credit ceiling monitoring records a threshold crossing (75%, 90%, or 100%)
- `DEFICIENT_RESOLUTION_DEADLINE_FIRED` — DEFICIENT condition resolution deadline reached

**Processing lock events (§70A):**
- `PROCESSING_LOCK_PLACED` — new `ProcessingLockRecord` created by any channel processor
- `PROCESSING_LOCK_EXPIRED` — processing lock TTL reached; `ProcessingLockRecord.status` set to `EXPIRED`; operator notification dispatched; processing context permanently logged
- `PROCESSING_LOCK_RELEASED` — processing lock released because booking was completed or rejected before TTL

**AI Communication Agent events (§70B):**
- `AI_INTENT_CLASSIFIED` — AI agent classifies intent of inbound message; `AiDraftRecord` created regardless of whether a draft is generated
- `AI_DRAFT_GENERATED` — AI agent generates a draft response; draft enters `PENDING_REVIEW` queue
- `AI_CONFIDENCE_BELOW_THRESHOLD` — AI confidence score falls below configured threshold for intent category; escalation triggered; no draft generated; human-routing record created
- `CORRECTION_LOG_AGGREGATION_COMPLETED` — periodic correction log aggregation worker completes; results surface to GM for threshold tuning

**Voice note events (§70C):**
- `VOICE_NOTE_RECEIVED` — inbound `CommunicationRecord` with `MessageType.VOICE_NOTE` detected; `VOICE_NOTE_UNPROCESSED` status set; SLA timer registered
- `VOICE_NOTE_SLA_APPROACHING` — voice note SLA timer warning fires; approaching-SLA notification dispatched to responsible staff
- `VOICE_NOTE_SLA_BREACHED` — voice note SLA timer critical threshold reached; `CommunicationRecord.voiceNoteSlaBreach` set to true; FOM escalation dispatched

### 6.4.4 Financial Events

Financial events record all financial activity in the system. Every financial event is immutable from creation.

- `FOLIO_CREATED_PROVISIONAL` — provisional folio created at S3
- `FOLIO_CONVERTED_TO_LIVE` — provisional folio converts to live at S6 check-in
- `FOLIO_CLOSED_NO_SHOW` — folio closed as `NO_SHOW_CLOSED` at no-show determination
- `CHARGE_POSTED` — charge posted to live folio (room charge, F&B, service, miscellaneous)
- `PAYMENT_RECORDED` — payment event recorded (advance, instalment, or final settlement)
- `PI_GENERATED` — proforma invoice generated at S3
- `INVOICE_GENERATED` — final invoice generated at S8/S9
- `CREDIT_NOTE_CREATED` — credit note created as an offset to a posted charge
- `COMMERCIAL_ADJUSTMENT_POSTED` — GM-level commercial adjustment entry posted at S9 Level 3 access
- `REFUND_PROCESSED` — refund executed (typically from no-show surplus or dispute resolution)
- `WRITE_OFF_RECORDED` — balance written off with authority and reason
- `SETTLEMENT_EVENT` — final settlement of folio balance
- `PAYMENT_MATCHING_EVENT` — payment matched to invoice line
- `NO_SHOW_PENALTY_POSTED` — penalty charge posted to provisional folio on no-show determination
- `COMMISSION_DUE_RECORD_CREATED` — commission-due record created at S9 closure for agent-mediated entry (configuration-activated; not produced when agent profile has no commission rate)

### 6.4.5 Exception Events

Exception events record conditions where the system detected a blocked, failed, or escalated state that requires human attention.

**Policy and state machine blocks:**
- `POLICY_GATE_BLOCKED` — policy evaluation returned `DENIED`; operation rejected; `PolicyGateBlockedError` raised
- `ESCALATION_INITIATED` — policy returned `ESCALATE(ActorLevel)`; escalation path opened
- `ESCALATION_APPROVED` — escalation approved by higher-authority actor; operation proceeds
- `ESCALATION_DENIED` — escalation denied by higher-authority actor; operation refused
- `STATE_MACHINE_TRANSITION_REJECTED` — state machine guard returned invalid; `StageGateBlockedError` raised
- `HANDOFF_REJECTED` — receiving party rejects handoff; new routing required

**No-show and overbooking:**
- `NO_SHOW_DETECTED` — no-show cutoff reached; contact attempts required before FOM determination
- `OVERBOOKING_APPROVED` — GM approves overbooking (DELIBERATE or OTA_CONFLICT) with mitigation plan
- `OVERBOOKING_REJECTED` — GM rejects overbooking request

**Financial alerts:**
- `CREDIT_CEILING_75_CROSSED` — advisory threshold crossed; FOM notified
- `CREDIT_CEILING_90_CROSSED` — non-dismissible FOM notification triggered
- `CREDIT_CEILING_100_GATE_ACTIVATED` — soft gate on non-mandatory charges activated; FOM acknowledgement required before non-mandatory charge posting
- `FOM_OVERRIDE_FREQUENCY_THRESHOLD_EXCEEDED` — rolling period override frequency threshold crossed; GM ambient awareness notice dispatched
- `DEFICIENT_RESOLUTION_DEADLINE_BREACHED` — DEFICIENT condition resolution deadline passed without resolution
- `NIGHT_AUDIT_PARTIAL_RUN` — night audit completed with `NightAuditRunStatus.PARTIAL`; FOM escalated; recovery re-run required

**Configuration:**
- `CONFIGURATION_FAILURE_DETECTED` — required configuration value missing at runtime; `MissingConfigurationError` raised

**Processing lock exceptions (§70A):**
- `PROCESSING_LOCK_TTL_EXPIRED_DURING_ACTIVE_WORKFLOW` — processing lock TTL expired while operator was actively working on a booking; explicit operator notification dispatched: *"Your inventory hold has expired — please reconfirm availability before proceeding."* Reconfirmation required; new lock placed on reconfirmation; revalidation check triggered

**Voice note exceptions (§70C):**
- `VOICE_NOTE_REVIEW_SLA_BREACHED` — voice note review SLA window elapsed without `REVIEWED` status; FOM escalated; `CommunicationRecord.voiceNoteFomEscalated` set to true

**AI draft exceptions (§70B):**
- `AI_DRAFT_REVIEW_TTL_EXCEEDED` — AI draft has been in `PENDING_REVIEW` state longer than the configured review window; FOM notified; draft remains pending — it does not auto-approve or auto-reject

**Dispute gate override (§53 + REV-B9-V23-01):**
- `DISPUTE_GATE_OVERRIDE_INVOKED` — GM invokes override on `BLOCKED_WITH_OVERRIDE_AVAILABLE` gate result; `DisputeGateOverrideRecord` created (GM actor, timestamp, free-text reason, dispute reference, target stage, gate return value at time of override)

### 6.4.6 Closure Events

Closure events record the terminal resolution of governed entities and processes.

- `ENTRY_CLOSED` — entry reaches terminal CLOSED state; all S9 obligations resolved
- `DISPUTE_RESOLVED` — dispute reaches RESOLVED terminal state; guest accepted resolution
- `DISPUTE_CLOSED` — dispute formally closed by GM with recorded reason
- `DISPUTE_REOPENED` — dispute reopened from CLOSED state by FOM or GM; mandatory reason
- `HANDOFF_CLOSED` — handoff obligations fulfilled and closed
- `WORK_ORDER_CLOSED` — work order closed at S8; all items fulfilled or explicitly cancelled
- `FOLIO_SEALED` — folio sealed at S9 closure (or immutable from creation for NO_SHOW_CLOSED folios)
- `NIGHT_AUDIT_SEALED` — night audit record sealed for operating date; immutable thereafter
- `INCIDENT_CLOSED` — incident record closed when resolved
- `RELOCATION_EXTERNAL_HANDSHAKE_LOOP_CLOSED` — both external handshake loops for a partner hotel relocation closed (partner hotel receipt confirmed AND rate differential settlement recorded)

---

## §6.5 — Domain Service Catalogue

### 6.5.1 Domain Service Design Contract

A domain service owns the lifecycle of its primary entity. It is responsible for:

- Enforcing the §71 mutation rules for its entity (what may be created, updated, amended, sealed, or archived at each stage)
- Invoking the governing policies at each operation's declared enforcement point
- Invoking engines where computation is required, acting on their results
- Invoking state machine transitions (defined in Part 3) — not re-implementing their guard logic
- Emitting trace events in the same transaction as state changes
- Writing all records through Prisma models only — no raw SQL, no direct database access

A domain service does not import another domain service. Cross-domain orchestration is an application service concern (§6.6).

---

### 6.5.2 InquiryService

**Primary entity:** `Inquiry`

**Responsibilities:**
- Creates the `Inquiry` record at S1. The `inquiry_id` is immutable from creation.
- Manages custodian assignment: assigns the initial custodian at inquiry creation; enforces the ownership assignment policy (Policy 6) at reassignment.
- Enforces the parking cascade: inquiry-level park cascades to all active non-terminal entries (sets `Entry.status = PARKED` for each); inquiry-level unpark does not unpark entries that were individually parked before the inquiry-level park was applied (each entry's `parkedBefore` flag is checked).
- Enforces the duplicate detection policy (Policy 8) at inquiry creation and before S4 confirmation.
- Computes derived inquiry state (aggregate of entry states) on demand — this is computed, not stored as a primary operational field.
- Emits trace events for all inquiry-level mutations in the same transaction.

**Mutation rules enforced (§71):**
- `Inquiry`: create at S1; update custodian and contacts while active; seal when all child entries reach terminal state; archive on closure.
- `inquiry_id` and `Entry.inquiryReference` are immutable after creation — no re-parenting between inquiries.

**Policy enforcement points in this service:**
- Policy 6 (Ownership / Custodian Assignment) — `InquiryService.assignCustodian()`
- Policy 8 (Duplicate Detection at Creation) — `InquiryService.create()`

---

### 6.5.3 EntryService

**Primary entity:** `Entry`, `Segment`

**Responsibilities:**
- Creates the `Entry` record at S1 with use type (`EntryUseType`) set and immutable thereafter.
- Creates the first `Segment` (Segment 1) at S1. Subsequent segments are created at re-entry events — one new segment per re-entry pass through the stages.
- Manages the entry's stage progression by invoking the state machine transition functions defined in Part 3. The transition guard logic is in Part 3 — `EntryService` calls the transition and handles the result; it does not re-implement the guard.
- Sets the `OTA_SOURCE` flag on the entry at S1 for OTA-sourced bookings. The flag is immutable once set — no code path may clear it.
- Manages entry parking and unparking (entry-level, distinct from inquiry-level cascade managed by `InquiryService`).
- Enforces the §74 stage-to-record matrix for entry records — only the operations permitted for the current stage are executed.
- Computes re-entry consequences by invoking `ReEntryConsequenceEngine.compute()` when a new segment is created at re-entry.

**Mutation rules enforced (§71):**
- `Entry`: create at S1; update provisional fields until commitment boundary; new segment on re-entry; stage artifacts seal per stage exit rules; close at S9.
- `Segment`: create at S1 (Segment 1) and on each re-entry; update only current segment's current stage; seal when superseded or entry closes.
- `OTA_SOURCE` flag: set at S1 if OTA-sourced; immutable thereafter.

**Policy enforcement points in this service:**
- Policy 1 (Availability Query) — `EntryService.searchAvailability()` (delegates to `AvailabilityService`)
- Policy 8 (Duplicate Detection at Multi-Booking) — `EntryService.confirmReservation()` at S4
- Policy 13 (Entry Expiry) — enforced by `EntryExpiryWorker`; `EntryService.expireEntry()` called by worker
- Policy 14 (Parking) — `EntryService.park()`, `EntryService.unpark()`

**Engine invocations in this service:**
- `ReEntryConsequenceEngine.compute(input: ReEntryInput): ReEntryConsequencePayload` — called on new segment creation; service acts on consequence payload (resetting timers, triggering folio adjustments, updating handoffs)

---

### 6.5.4 FolioService

**Primary entity:** `Folio` (Provisional, Live, NO_SHOW_CLOSED), `FolioLine`, `PaymentRecord`, `Invoice`, `CreditNote`

**Responsibilities:**
- Creates the `Folio` (Provisional) at S3.
- Manages restricted mutations on the provisional folio: only PIs and payment records may be added before S6 — no live charges, no speculative charge lines.
- Converts provisional folio to live at S6 check-in (within the S6 state machine transition transaction).
- Posts charge lines to the live folio at S7. Every charge posting invokes `TaxEngine.calculate()` to compute tax before writing the `FolioLine`. Every charge posting for ceiling-monitored entries invokes `CreditCeilingMonitorEngine.evaluate()` after writing the `FolioLine`.
- Handles folio closure via the `NO_SHOW_CLOSED` path (§6.6 NoShowService orchestrates; FolioService executes the financial mechanics within the transaction).
- Enforces the append-only doctrine: existing `FolioLine` records are never edited. Corrections add credit notes or adjustment lines.
- Enforces post-closure access levels (Level 1 read-only, Level 2 FOM additive, Level 3 GM corrections with own date).
- Manages invoice creation (proforma at S3, final at S8/S9) and dispatch lifecycle.

**Mutation rules enforced (§71):**
- `Folio (Provisional)`: create at S3; restricted to PIs and payment records only; converts to live at S6 or closes as NO_SHOW_CLOSED on no-show determination.
- `Folio (Live)`: create on S6 conversion; charges posted until settlement; adjustment lines and credit notes added (never edit original lines); sealed at S9 closure; Level 2/3 additive layers after closure.
- `Folio (NO_SHOW_CLOSED)`: created at S5 on no-show determination; immutable from creation.
- `PaymentRecord`: immutable from creation; no update or amendment path.
- `Invoice`: not editable after dispatch; credit note or adjustment — never edit original.

**Policy enforcement points in this service:**
- Policy 27 (Advance Payment Collection) — `FolioService.recordPayment()` at S3
- Policy 30 (Billing Model Initial Fix) — `FolioService.fixBillingModel()` at S3
- Policy 31 (Billing Model Activation) — `FolioService.activateBillingModel()` at S6
- Policy 32 (Billing Model Mid-Stay Transition) — `FolioService.changeBillingModel()` at S7 (FOM authority required)
- Policy 33 (Billing Model Settlement) — `FolioService.settleForlio()` at S8

**Engine invocations in this service:**
- `TaxEngine.calculate(input: TaxInput): TaxResult` — called per charge line before writing `FolioLine`
- `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult` — called per charge posting for ceiling-monitored entries at S7

---

### 6.5.5 AvailabilityService

**Primary entity:** `AvailabilityConfiguration`, `Room` (claim state and physical state)

**Responsibilities:**
- Executes availability queries by invoking `AvailabilityEngine.query()`. Never queries inventory directly without the engine.
- Persists `AvailabilityConfiguration` records from S1 exploration. Configurations are first-class entities — not ephemeral query results.
- Manages configuration staleness: sets `staleness_at` and `isStale = true` when the staleness timer fires. Stale configurations are recallable with revalidation.
- Handles configuration recall: when a stale configuration is recalled, invokes `AvailabilityEngine.query()` to revalidate against current system state before presenting results.
- Surfaces DEFICIENT flags in availability results per Policy 2 (DEFICIENT Condition Surface Policy). Every room with an active `DeficientConditionRecord` is flagged in the result set.

**Policy enforcement points in this service:**
- Policy 1 (Availability Query) — `AvailabilityService.query()` — invokes `AvailabilityEngine.query()` after policy evaluation
- Policy 2 (DEFICIENT Condition Surface) — `AvailabilityService.query()` — annotates results with DEFICIENT flag status

**Engine invocations in this service:**
- `AvailabilityEngine.query(input: AvailabilityInput): AvailabilityResult` — sole mechanism for inventory queries; result includes Model 1 (claim state) and Model 2 (physical state) for each candidate room

---

### 6.5.6 ReservationService

**Primary entity:** `Reservation` (commitment snapshot)

**Responsibilities:**
- Creates the `Reservation` record at S4. The commitment snapshot is frozen on creation — the confirmed rate plan, terms, inventory references, and credit ceiling (if credit extended) are denormalised into the reservation and become immutable.
- Manages credit ceiling: if credit is extended at S3, the ceiling is carried into the commitment snapshot at S4. Credit ceiling revisions add new `CreditExtensionCeilingRecord` — the original is preserved.
- Generates the confirmation voucher and triggers `CommunicationService.send()` to dispatch it.
- Manages the overbooking detection flow by invoking `OverbookingDetectionEngine.detect()` at S4 before confirming. The `OTA_SOURCE` flag on the entry informs trigger type classification.
- Manages the HandoffRecord (H1) creation at S4.

**Policy enforcement points in this service:**
- Policy 40 (Confirmation Authority) — `ReservationService.confirm()` at S4
- Policy 41 (Overbooking Detection and Trigger Typing) — `ReservationService.confirm()` — invokes `OverbookingDetectionEngine.detect()` before committing
- Policy 42 (Credit Ceiling Mandatory Set) — `ReservationService.confirm()` — verifies ceiling was set at S3 before proceeding
- Policy 43 (Credit Ceiling Commitment Snapshot Carry) — `ReservationService.confirm()` — denormalises ceiling into reservation

**Engine invocations in this service:**
- `OverbookingDetectionEngine.detect(input: OverbookingInput): OverbookingResult` — called before S4 confirmation; result determines whether OVERBOOKED condition exists and sets trigger type

---

### 6.5.7 IncidentService

**Primary entity:** `IncidentRecord`, `LostFoundRecord`

**Responsibilities:**
- Creates `IncidentRecord` with type (`IncidentType`), severity, location, involved parties, and actions taken.
- Manages room physical state transitions triggered by incidents — when a death or security incident requires the room to be secured, invokes the state machine transition to set room status to `BLOCKED` with the incident as the anchoring reason. The `cleansing_ritual_completed` flag is enforced before the room may return to service.
- Manages lost and found records: description, location found, guest association (nullable), return status, and `retention_expires_at` for Timer Engine monitoring.
- Enforces FOM escalation for major incidents (MEDICAL_MAJOR, SECURITY, DEATH, FIRE, OTHER requiring police involvement).
- Enforces non-disclosure by default — incident details may not be shared without GM authorisation.

**Policy enforcement points in this service:**
- Policy for incident classification and disclosure — `IncidentService.create()`, `IncidentService.disclose()`

---

### 6.5.8 HandoffService

**Primary entity:** `HandoffRecord`

**Responsibilities:**
- Creates handoff records (H1–H5) at their respective stage trigger points.
- Manages handoff state transitions: CREATED → ASSIGNED → ACCEPTED → FULFILLED → CLOSED. A REJECTED handoff produces new routing — the original record is preserved.
- Enforces auto-fulfilment when sending and receiving roles are the same team — the handoff infrastructure records the event for audit even when no inter-team transfer occurs.
- Monitors handoff acceptance SLA via the `H2_H3_ACCEPTANCE` timer registered with `TimerManagementService`.
- Includes DEFICIENT condition status in H2 for assigned rooms that carry an active `DeficientConditionRecord`.

**Policy enforcement points in this service:**
- Policy 63 (Handoff Lifecycle) — `HandoffService.create()`, `HandoffService.accept()`, `HandoffService.fulfil()`

---

### 6.5.9 DisputeService

**Primary entity:** `DisputeRecord`, `ServiceRecoveryRecord`, `ResolutionBundle`, `DisputeGateOverrideRecord`

**Responsibilities:**
- Creates `DisputeRecord` (formal guest or agent position) and `ServiceRecoveryRecord` (hotel's internal response to a detected failure) — these are distinct entities with distinct lifecycles.
- Manages dispute state lifecycle: OPEN → IN_PROGRESS → RESOLVED | CLOSED; REOPENED from CLOSED by FOM or GM with mandatory reason. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.
- Manages `ResolutionBundle` creation on GM or FOM approval (Tier 2 = FOM; Tier 3 = GM). Each bundle is an independently queryable record — it is not an attribute on the dispute record.
- Enforces dispute closure authority: GM authority required for CLOSED state. FOM manages the process; GM closes.
- Invokes `DisputeGateEngine.canProgressStage()` to evaluate stage progression blocking:
  - Returns `CLEAR` — stage transition may proceed
  - Returns `BLOCKED` — stage transition blocked; typed `StageGateBlockedError` raised
  - Returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` — GM override path available (except at S8→S9 where dispute must reach terminal state)
- When GM invokes the override path: creates `DisputeGateOverrideRecord` with GM actor identity, timestamp, mandatory free-text reason, dispute reference, target stage, and gate return value. The `DisputeGateOverrideRecord` is the source record for the GM dispute gate override governance report.
- Registers dispute SLA timer (`DISPUTE_SLA`) and resolution execution timer (`RESOLUTION_EXECUTION`) with `TimerManagementService`.

**Policy enforcement points in this service:**
- Policy 53 (Active Dispute Management) — `DisputeService.open()`, `DisputeService.progress()`
- Policy 54 (Dispute Gate Stage Progression) — `DisputeService.evaluateStageGate()` — invokes `DisputeGateEngine.canProgressStage()`
- Policy 55 (Dispute Closure) — `DisputeService.close()` — GM authority verified

**Engine invocations in this service:**
- `DisputeGateEngine.canProgressStage(input: DisputeGateInput): DisputeGateResult` — called at S7→S8 and S8→S9 transition evaluation points

---

### 6.5.10 WorkOrderService

**Primary entity:** `WorkOrder`, `WorkOrderToDoItem`

**Responsibilities:**
- Creates the `WorkOrder` between S1 and S3; lives through S8.
- Manages to-do item lifecycle: every amendment is an additive layer on the work order. Original items are preserved.
- Registers to-do deadline timers with `TimerManagementService` per item.
- Closes work order at S8 when all items are fulfilled or explicitly cancelled with recorded reason.
- Enforces the coordinator governance boundary: coordinator actions are recorded as system events by staff — coordinators have no direct system access.

**Policy enforcement points in this service:**
- Policy 67 (Work Order Lifecycle) — `WorkOrderService.create()`, `WorkOrderService.amend()`, `WorkOrderService.close()`

---

### 6.5.11 GuestProfileService

**Primary entity:** `GuestProfile`, `AgentProfile`, `CorporateProfile`

**Responsibilities:**
- Creates `GuestProfile`, `AgentProfile`, and `CorporateProfile` records on first contact. These are persistent identity records — they are never fully sealed. They evolve over time across all engagements.
- Updates editable fields (contact information, preferences, channel preference) on demand. Editable field updates are straightforward `UPDATE` operations — they do not require a new record.
- Manages tier changes as layered events: a tier change (for example, STANDARD → GOLD) is not a field update — it is a new `TierChangeEvent` record with actor, reason, effective date, and prior tier preserved. The tier history is permanently readable.
- Enforces guest data governance at S6 (Policy 16 — Guest Identity Verification and Data Capture) and at S9 (Policy 17 — Guest Data Retention and Deletion). S6 verification creates a `VerificationEvent` on the profile record; S9 retention/deletion follows the configured retention policy.
- Manages deduplication: duplicate detection at S1 creation checks for existing profiles by identity signal. When a duplicate is detected, it is surfaced to the staff member for resolution — not auto-merged. Post-creation re-wiring of records is not permitted (§22).
- Provides guest profile lookups that are injected into `ContextAssemblyService` inputs for the AI agent.

**Mutation rules enforced (§71):**
- `GuestProfile` / `AgentProfile` / `CorporateProfile`: create at first contact; update editable fields directly; tier changes produce layered `TierChangeEvent` records; never fully sealed — living record; archived independently from entry lifecycle.

**Policy enforcement points in this service:**
- Policy 16 (Guest Identity Verification) — `GuestProfileService.verifyIdentity()` at S6
- Policy 17 (Guest Data Governance and Retention) — `GuestProfileService.applyRetention()` at S9

---

### 6.5.12 SpaceAllocationService

**Primary entity:** `SpaceAllocation`, `EquipmentAllocation`, `AssetAllocation`, `SourcingRecord`

**Responsibilities:**
- Manages the space claim lifecycle for conference and event engagements. Space claims follow the same Model 1 claim state logic as rooms (QUOTED → SPECULATIVELY_HELD → COMMITTED_HELD → CONFIRMED → released) but applied to time blocks rather than date ranges.
- Creates `SpaceAllocation` at S1 search (QUOTED), transitions through hold states at S2/S3, locks at S4, and releases on event completion or cancellation.
- Manages `EquipmentAllocation` for movable resources assigned to a space/time block: creates at S1–S5, releases after event and return confirmed. Registers `EQUIPMENT_RETURN` timer with `TimerManagementService` when allocation is created.
- Manages `AssetAllocation` for hotel-owned items assigned to an engagement: creates at S3–S5, releases after event and return confirmed.
- Manages `SourcingRecord` for externally hired resources (decorators, hired furniture, equipment): creates at S3–S5, closes on return and cost reconciliation.
- Detects shortage conditions: if required equipment or space is unavailable, surfaces a shortage detection record rather than silently proceeding.
- Enforces the turnaround buffer between consecutive events for the same space — booking a space without checking the turnaround buffer is a forbidden pattern.
- Releases all space claims and equipment allocations on event completion or cancellation via state machine transitions.

**Mutation rules enforced (§71):**
- `SpaceAllocation`: create S1–S4; update through lifecycle; release on event completion or cancellation.
- `EquipmentAllocation`: create S1–S5; release after event and return confirmed.
- `AssetAllocation`: create S3–S5; release after event and return confirmed.
- `SourcingRecord`: create S3–S5; close on return and cost reconciliation.

**Policy enforcement points in this service:**
- Policy 67 (Work Order Lifecycle, space component) — `SpaceAllocationService.allocate()`, `SpaceAllocationService.release()`
- Turnaround buffer check — `SpaceAllocationService.allocate()` — checks for adjacent events before creating allocation

---

### 6.5.13 ProcessingLockService

**Primary entity:** `ProcessingLockRecord`

**Responsibilities:**
- Creates a `ProcessingLockRecord` when any channel processor (AI agent, front desk, phone) identifies a specific inventory configuration it intends to reference. Lock placement is channel-agnostic — the same mechanism governs all channels.
- The lock is an awareness mechanism. It does not block other actors from viewing inventory or continuing their workflow. Treating it as a blocking mechanism is a forbidden pattern.
- Checks for existing locks on the same inventory configuration before creating a new one (Policy 72 — Processing Lock Priority Queue Policy). If a prior lock exists, the new lock is created and the second actor receives an informational notification identifying the prior lock.
- Manages lock TTL via `TimerManagementService`: registers `PROCESSING_LOCK_TTL` timer at lock placement. Hard expiry at TTL — no heartbeat or renewal mechanism.
- On TTL expiry (handled by `ProcessingLockExpiryWorker`): sets `ProcessingLockRecord.status = EXPIRED`; logs the processing context permanently; dispatches the mandatory operator notification: *"Your inventory hold has expired — please reconfirm availability before proceeding."* This notification text is governance language — it is not configurable.
- On lock release (booking completed or rejected before TTL): sets `ProcessingLockRecord.status = RELEASED`.
- On reconfirmation after expiry: operator reconfirmation places a **new** `ProcessingLockRecord` (new `lock_id`; `revalidation_count` incremented on the new record). Reconfirmation triggers a revalidation check at the moment the new lock is placed: re-runs `AvailabilityEngine.query()` to check availability state, re-checks `DeficientConditionRecord` status for the target room, re-runs `PricingPipelineEngine.resolve()` to verify pricing. Results of revalidation are attached to the new lock record as a `RevalidationDeltaRecord`. If conditions changed during the TTL window, the operator is informed of the delta before proceeding.
- Manages the RELEASED path when a booking action completes within TTL.

**Policy enforcement points in this service:**
- Policy 71 (Processing Lock TTL Policy) — `ProcessingLockService.placeLock()`, `ProcessingLockService.expireLock()`, `ProcessingLockService.reconfirm()`
- Policy 72 (Processing Lock Priority Queue Policy) — `ProcessingLockService.placeLock()` — prior lock check runs before new lock creation

**Engine invocations at reconfirmation:**
- `AvailabilityEngine.query(input: AvailabilityInput): AvailabilityResult`
- `PricingPipelineEngine.resolve(input: PricingInput): PricingResult`

---

### 6.5.14 VoiceNoteRoutingService

**Primary entity:** `CommunicationRecord` (where `messageType = MessageType.VOICE_NOTE`)

**Responsibilities:**
- Detects inbound `CommunicationRecord` records with `MessageType.VOICE_NOTE` at the intake routing layer.
- Assigns `VOICE_NOTE_UNPROCESSED` status fields: sets `acknowledgementStatus = PENDING`, `voiceNoteSlaBreach = false`, `voiceNoteFomEscalated = false`.
- Registers the `VOICE_NOTE_SLA` timer with `TimerManagementService` immediately on receipt. The SLA timer fires per the configured voice note review SLA (default 30 minutes during operating hours; configurable per channel per Policy 77).
- Routes the voice note to the assigned staff member for the linked inquiry or entry. If the inquiry is unassigned, routes to any front desk staff. FOM handles escalation.
- **Blocks the AI agent at the routing layer.** The AI agent does not receive voice note content for classification, drafting, or action proposal. This is a routing-layer exclusion — not a runtime check inside the AI agent that the AI agent could fail to apply. The block is implemented as a condition in this service's routing logic, before any AI processing call is made.
- Manages the acknowledgement loop: the outbound acknowledgement loop for a voice note `CommunicationRecord` remains open (`acknowledgementStatus = PENDING`) until the reviewing staff member explicitly completes the review via `CommunicationService.completeVoiceNoteReview()`. If the voice note is a reply to a prior outbound communication that was itself awaiting acknowledgement, that outbound communication's `AcknowledgementStatus` also remains `PENDING` until the staff member confirms what the voice note said.
- Manages the REVIEWED path: status transition to `REVIEWED` requires that a `StaffListeningSummaryRecord` has been written with all required structured fields (caller intent, commitments mentioned, dates and numbers, language used, staff identity, timestamp). A status-only update without a logged summary is rejected.

**Policy enforcement points in this service:**
- Policy 76 (Voice Note Routing Policy) — `VoiceNoteRoutingService.route()` — AI block enforced here; SLA timer registered; staff routing assigned
- Policy 77 (Voice Note Review SLA Policy) — timer registration in `VoiceNoteRoutingService.route()`; SLA worker dispatch on timer fire; FOM escalation on breach

---

## §6.6 — Application Service Catalogue

### 6.6.1 Application Service Design Contract

An application service orchestrates a cross-entity business operation. It imports and invokes domain services and infrastructure services to fulfil a governed workflow. It does not own an entity's lifecycle — it orchestrates across entity-owning domain services. It applies the authority chain, enforces governed paths, and ensures all downstream consequences of the operation are processed before the operation is considered closed.

---

### 6.6.2 AmendmentService

**Purpose:** Orchestrates all amendment paths — the single governed mechanism for all post-decision changes to operational or commercial truth.

**Amendment paths (from §51 M.8, `AmendmentPath` enum in Part 2):**

`AmendmentPath.PATH_1` — **Simple folio amendment.** A cost addition with FOM confirmation. No new segment is created. A `FolioLine` is added directly to the live folio. Example: guest orders an extra service not in the package during S7.

`AmendmentPath.PATH_2` — **Commercial amendment.** A rate or inclusion change requiring the approval chain defined in the rate/amendment authority policy. Still a folio amendment — no new segment — but requires higher authority. Example: meal plan upgrade mid-stay.

`AmendmentPath.PATH_3` — **Full renegotiation.** The full S2 interface activates within the amendment panel. A new segment is created. The original confirmation is marked SUPERSEDED but preserved. Example: rate dispute during S7 where the guest demands a complete rate review.

**Amendment path routing — Model C (Hybrid):**

Path selection is a combination of system-locked rules (for amendment types where the Canon is explicit) and actor-governed selection (for the residual where the Canon leaves path choice to operational judgement).

| Amendment Condition | Path | Basis |
|---|---|---|
| Date change or room change post-S4 | **System-locked to Path 3** | Re-entry required; new segment mandatory (§51 M.8 — Canon explicit) |
| Billing model change (S2 onward) | **System-locked to Path 2 minimum** | Billing Model Change mode requires FOM authority at every stage (§51 M.8 REV-B9-01 — Canon explicit) |
| Rate change requiring `PricingPipelineEngine` re-run | **System recommends Path 2 or Path 3; actor selects between them** | System presents both options with contextual guidance on consequences; actor's interpretation of the guest's intent determines whether this is commercial amendment or full renegotiation |
| All other amendments | **Actor selects from applicable paths** | System presents available paths with contextual guidance; enforces authority for the selected path; does not override the selection |

For system-locked paths, `AmendmentService.amend()` validates the amendment type and rejects a caller-supplied path that conflicts with the locked rule. For actor-selected paths, `AmendmentService.amend()` accepts the supplied path and enforces the authority and consequences for that path. The service does not silently reroute an actor-selected path.

**Operations:**

- `AmendmentService.amend(entryId, amendmentType, path, actorId, reason)` — receives the amendment type and path from the caller. Validates authority per the amendment authority policy. Routes to the appropriate path handler.
- **Path 1 handler:** creates `FolioLine` via `FolioService`; creates `AmendmentEventRecord`; notifies guest if terms affected via `CommunicationService`.
- **Path 2 handler:** validates authority chain; creates `FolioLine` with adjustment; creates `AmendmentEventRecord`; updates affected timers via `TimerManagementService` if date, room, or billing affected.
- **Path 3 handler:** creates new segment via `EntryService`; marks prior confirmation SUPERSEDED; re-runs S2 pricing logic by invoking `PricingPipelineEngine.resolve()`; generates amended confirmation voucher; dispatches amended voucher via `CommunicationService`.
- **Billing model change path:** billing model changes at any stage from S2 onward follow the Billing Model Change mode within the amendment mechanism. FOM authority is required at every stage. Mandatory recorded reason. Invokes `FolioService.changeBillingModel()`. Creates immutable billing model transition event. The original billing model from S3 fixation remains permanently visible in the amendment history.
- Processes all downstream consequences before considering the amendment closed: folio adjustments, handoff updates (H2/H3 if housekeeping or F&B obligations changed), inventory state changes, timer recalculations.

**Policy enforcement points in this service:**
- Amendment authority policy (§51 M.6) — enforced at `AmendmentService.amend()` before path selection
- Policy 21 (Rate Override / Amendment) — invoked at Path 3 when a new rate plan is applied; `PricingPipelineEngine.resolve()` is called
- Policy 32 (Billing Model Mid-Stay Transition) — delegated to `FolioService.changeBillingModel()`

**Forbidden acts enforced:**
- Silent mutation of any committed field — all changes are additive amendment events; original terms are preserved
- Applying a rate change without re-running `PricingPipelineEngine` — Path 3 always invokes the engine
- Notifying the guest of changed terms without a system-generated amended document — `CommunicationService.send()` is called with the amended voucher
- Transitioning billing model without FOM authority and recorded reason — enforced before `FolioService.changeBillingModel()` is called

---

### 6.6.3 CancellationService

**Purpose:** Governs the termination of an entry before its natural lifecycle completion.

**Operations:**

- `CancellationService.cancel(entryId, reason, actorId)` — validates authority per stage:
  - S1–S3: `ActorLevel.FRONT_DESK` or `ActorLevel.FOM`
  - S4–S6: `ActorLevel.FOM` required
  - S7 (early departure): `ActorLevel.GM` required
  - S8–S9: `ActorLevel.FOM` or `ActorLevel.GM`
- Verifies cancellation penalty calculation and discloses it before executing the cancellation. Penalty is calculated per the cancellation penalty policy (configurable tiers by stage, timing relative to arrival, booking source, client tier).
- Invalidates the confirmation voucher for post-S4 cancellations; dispatches cancellation notice via `CommunicationService`.
- Releases inventory (transitions claim state toward FREE) via `AvailabilityService`.
- Handles advance payment: calculates penalty, applies retention, records refund obligation if surplus exists.
- Transitions entry to CANCELLED terminal state via `EntryService` state machine transition.
- Every cancellation produces a governed cancellation event with full attribution. No silent cancellation is possible.

**Policy enforcement points in this service:**
- Policy 34 (Cancellation Terms Disclosure) — enforced before execution
- Policy 35 (Cancellation Enforcement) — enforced at each stage-specific cancellation path
- Policy 36 (Early Departure) — enforced at S7 cancellation

**Forbidden acts enforced:**
- Cancellation without a recorded reason — mandatory field enforced before any database write
- Front desk cancelling a confirmed reservation without FOM authority — authority check at service entry

---

### 6.6.4 NoShowService

**Purpose:** Governs all aspects of the no-show event — determination, folio financial mechanics, and OTA notification obligation.

**Operations:**

`NoShowService.determineNoShow(entryId, actorId, reason)` — called by FOM after contact attempts are logged. Validates that the required contact attempts have been completed and recorded (count and method per Policy 56 configuration). Executes within a single transaction:

1. Creates `NoShowDeterminationRecord` (FOM actor, reason, timestamp — immutable from creation).
2. Invokes folio financial mechanics (§54 M.14):
   - Calculates applicable penalty from the commitment snapshot (same-day cancellation tier per disclosed cancellation policy). Penalty cannot exceed total advance payment received.
   - Posts penalty as a `FolioLine` on the provisional folio — charge references the `NoShowDeterminationRecord.id` as its operational anchor; FOM determination timestamp is the operational date (not backdated to expected arrival date).
   - Reconciles advance payment against penalty:
     - If advance equals penalty: folio balance is zero → closes as `FolioState.NO_SHOW_CLOSED` with SETTLED net position.
     - If advance exceeds penalty: surplus → creates refund record for the difference; folio enters refund-pending state; folio closes as `FolioState.NO_SHOW_CLOSED`.
     - If advance less than penalty (rare): shortfall posted as outstanding balance requiring S9 collection processing.
   - Closes folio as `FolioState.NO_SHOW_CLOSED` — a distinct closure type, not SETTLED, not OUTSTANDING, not CANCELLED. Folio is sealed (immutable) on closure.
3. Creates refund record if surplus refund owed, with: inquiry reference, guest payment reference from S3, refund amount, FOM authority, processing deadline (Timer Engine). Registers `PAYMENT_FOLLOW_UP` timer with `TimerManagementService` for refund tracking.
4. Dispatches no-show notification to guest or agent via `CommunicationService`.
5. Emits trace events within the same transaction.

**OTA notification open loop (§54 M.14 REV-B9-03):** For entries carrying the `OTA_SOURCE` flag, FOM's no-show determination carries an additional obligation. Until direct OTA API integration is established, OTA notification is a manual step — a staff member contacts the OTA platform through the established channel and records the notification as a `CommunicationRecord` with the OTA platform reference. This obligation is an open loop in the no-show closure record — it does not auto-close. FOM manually marks the OTA notification closed when confirmation of receipt is received. No-show financial processing is not gated on OTA notification — it proceeds independently. The OTA notification is a parallel open loop, not a sequential dependency.

**S9 closure path:** After folio closure as `NO_SHOW_CLOSED` and any refund processing, the entry proceeds to S9 via `EntryService` state machine transition for final record closure.

**Policy enforcement points in this service:**
- Policy 56 (No-Show Detection and Determination) — `NoShowService.determineNoShow()` — contact attempts verified before determination
- Policy 57 (No-Show Folio Financial) — financial mechanics executed within `NoShowService.determineNoShow()` transaction

**Forbidden acts enforced:**
- Declaring no-show without the required contact attempts — enforced before `NoShowDeterminationRecord` is created
- Releasing the room without FOM determination — room release only proceeds after determination record is created
- Waiving the no-show penalty without `ActorLevel.GM` authority — penalty waiver requires GM actor identity on the waiver record

---

### 6.6.5 NightAuditService

**Purpose:** Orchestrates the night audit — the daily financial authority event that reconciles the system's financial and occupancy truth at the close of each operating day.

**Operations:**

`NightAuditService.runNightAudit(operatingDate, actorId)` — called by `NightAuditSchedulerWorker` (scheduled or staff-triggered). Executes as follows:

1. Idempotency guard: checks for existing `NightAuditRecord` with `runStatus = COMPLETE` for `operatingDate`. If found, exits without re-processing.
2. Assembles `NightAuditInput` from the database: all active entries, their commitment snapshots, folio states, and configuration values. Configuration values are read from `ConfigurationEntry` at runtime — not hardcoded.
3. Calls `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult`.
4. Processes the result — one Prisma transaction per entry (sequential, not one transaction for the whole audit):
   - Writes `FolioLine` for each charge posted (calls `TaxEngine.calculate()` per charge before writing)
   - Calls `CreditCeilingMonitorEngine.evaluate()` after each `FolioLine` write for ceiling-monitored entries
   - Writes `NightAuditAnomaly` records per anomaly (including `MISSING_EXPECTED_CHARGE` anomalies for FOM review)
   - Sets `auditExceptionFlag = true` on entries that cannot be processed; escalates via `NotificationService`
5. Writes the `NightAuditRecord` (one per operating date, immutable once created) after all entries are processed.
6. Handles PARTIAL run: if any entries were not processed, the `NightAuditRecord.runStatus` is `NightAuditRunStatus.PARTIAL`. The PARTIAL record identifies which entries were processed and which were not (`entriesNotProcessed` list). FOM is escalated via `NotificationService`. No operating day may close with an unresolved PARTIAL run.
7. Recovery re-run: the re-run is idempotent — entries already processed (idempotency guard: presence of completed `FolioLine` with `lineDate = operatingDate`) are skipped. Only unprocessed entries are retried.
8. AUDIT_EXCEPTION escalation: entries that cannot be processed even through a recovery re-run are flagged as `AUDIT_EXCEPTION` with reason. FOM reviews, resolves the underlying condition, and triggers a manual catch-up posting. Manual catch-up postings carry the original audit date as `referenceDate` and the actual posting date as `transactionDate` — temporal integrity is preserved.
9. AI Audit Supplement: passes `NightAuditResult.auditSupplementInputData` to `AIAgentApprovalService.generateAuditSupplement()`. The AI generates the supplement; it does not require human approval (this is an internal SYSTEM action, not an outbound communication — `TrustLevel.FULL_AUTO` applies). The `AiAuditSupplementRecord` is created and attached to the `NightAuditRecord`.
10. After `NightAuditRecord` is written with `runStatus = COMPLETE`, calls `TimerManagementService.recalculateNextDayTimers(operatingDate)` — recalculates all next-day timers (pre-arrival countdowns, checkout deadlines, payment milestones, dispute SLAs, follow-up reminders).

**Policy enforcement points in this service:**
- Policy 59 (Night Audit Countdown) — managed by Timer Engine; `NightAuditService` responds to scheduled trigger
- Policy 60 (Night Audit Charge Posting and Completeness) — enforced within `NightAuditService.runNightAudit()` transaction; missing expected charges completeness check is part of the `NightAuditEngine` output
- Policy 61 (Night Audit Overdue Detection) — anomaly records for S8 entries produced in `NightAuditResult`
- Policy 62 (Night Audit Stale Record Detection) — anomaly records for S9 entries produced in `NightAuditResult`

**Engine invocations in this service:**
- `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult` — primary computation
- `TaxEngine.calculate(input: TaxInput): TaxResult` — called per charge line before writing `FolioLine`
- `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult` — called per charge posting for ceiling-monitored entries

**Forbidden acts enforced:**
- Modifying a sealed `NightAuditRecord` — the record is immutable from creation; no `UPDATE` path exists in this service
- Posting charges for a past operating day into the sealed audit record — corrections are current-date entries with a `referenceDate` field
- Skipping night audit for an operating day with active stays — the audit trigger is mandatory; absence is a `NIGHT_AUDIT_PARTIAL_RUN` exception
- Running night audit while operational transactions for the audit date are still in progress — the trigger mechanism checks for in-progress transactions before starting

---

### 6.6.6 AIAgentApprovalService

**Purpose:** Manages the human-in-the-loop approval gate for all AI Communication Agent operations — the mechanism by which every AI output receives a human decision before any governed action is executed.

**OI-014-01 Resolution:** The AI agent operates as a `ActorLevel.SYSTEM` (L0) actor. Its identity is the configured `aiActorId` string — a system constant set in the application configuration (not a `StaffUser` foreign key). Every `AiDraftRecord.aiActorId` carries this value.

**OI-014-02 Resolution:** The pattern rule registry (§70B M.7) is a runtime configuration dependency. `AIAgentApprovalService` loads the pattern rule registry from the configuration tables at service initialisation. The registry governs AI intent classification thresholds and correction log triggering rules. It is managed by GM through the Admin Console. It is not hardcoded in this service.

**Operations:**

`AIAgentApprovalService.processInbound(inboundCommunicationRecord)` — the entry point for all inbound communications routed to the AI agent.

1. Checks `MessageType`: if `MessageType.VOICE_NOTE`, this service must not receive the message — routing was already blocked by `VoiceNoteRoutingService`. If reached, throws `PolicyViolationError('Voice note reached AI processing — routing layer failure')`.
2. Invokes LLM API to classify intent (external LLM API call via the AI Agent integration interface defined in Part 11). Creates `AiDraftRecord` with `aiActorId` (SYSTEM), `intentCategory`, `confidenceScore`. The `AiDraftRecord` is created regardless of whether a draft is generated — the classification event is always recorded.
3. Evaluates confidence against configured threshold (Policy 75 — AI Escalation Policy):
   - **Below threshold:** creates escalation record; routes to FOM; emits `AI_CONFIDENCE_BELOW_THRESHOLD` event; exits without generating a draft.
   - **At or above threshold:** proceeds to draft generation.
4. Generates draft response (LLM API call). Populates `AiDraftRecord.draftContent`. Sets `AiDraftRecord.status = AiDraftStatus.PENDING_REVIEW`. Sets `reviewTtlExpiresAt` from configuration.
5. Registers `AI_DRAFT_REVIEW_TTL` timer with `TimerManagementService`.
6. Emits `AI_DRAFT_GENERATED` event. Draft enters the human review queue.

`AIAgentApprovalService.recordHumanDecision(draftId, decisionType, actorId, reason?, editedContent?)` — called when a human actor acts on a queued draft.

1. Validates that `actorId` is a human actor (`ActorLevel.FRONT_DESK`, `ActorLevel.FOM`, or `ActorLevel.GM`). If `actorId` matches `aiActorId`, throws `PolicyViolationError('AI agent may not approve its own draft')`. This is an absolute forbidden act.
2. Creates `HumanDecisionRecord` with: `aiDraftId`, `actorId` (human), `decisionType` (`HumanDecisionType.APPROVE | EDIT_AND_APPROVE | REJECT`), `reason` (mandatory on REJECT and EDIT_AND_APPROVE), `finalContent` (populated on EDIT_AND_APPROVE), `decidedAt`. Immutable from creation.
3. Cancels the `AI_DRAFT_REVIEW_TTL` timer via `TimerManagementService`.
4. **On APPROVE:** Sets `AiDraftRecord.status = AiDraftStatus.APPROVED`. Calls `CommunicationService.send()` with the approved draft content. `CommunicationService.send()` verifies that a `HumanDecisionRecord` with `APPROVE` or `EDIT_AND_APPROVE` exists before executing the send — this is a second-layer enforcement of Policy 74 (AI Authority Boundary Policy).
5. **On EDIT_AND_APPROVE:** Sets `AiDraftRecord.status = AiDraftStatus.EDITED_AND_APPROVED`. The `HumanDecisionRecord.finalContent` is the content actually sent. Creates `CorrectionRecord` if the edit changes the intent category interpretation. Calls `CommunicationService.send()` with `finalContent`.
6. **On REJECT:** Sets `AiDraftRecord.status = AiDraftStatus.REJECTED`. Human handles the response manually. The `AiDraftRecord` and `HumanDecisionRecord` are permanently preserved regardless of outcome.
7. The complete chain from inbound to outbound is reconstructable via the shared `correlationId`.

`AIAgentApprovalService.generateAuditSupplement(supplementInputData, nightAuditRecordId)` — called by `NightAuditService` after night audit completes.

1. This is an internal SYSTEM action — `TrustLevel.FULL_AUTO` applies. No human review is required.
2. Invokes LLM API with structured audit data. Creates `AiAuditSupplementRecord` attached to `NightAuditRecord`. The supplement is not an outbound communication — the FULL_AUTO scope applies here (§70B M.6 REV-B10-V23-02). Human review of the supplement's content is handled through the FOM review workflow for AI Audit Supplements; this service only creates the record.

**Traceability requirement:** The complete chain — inbound message → AI classification → draft generation → human decision → outbound send — must be reconstructable from records alone. The `correlationId` field links all events in the chain. No step in the chain is allowed to proceed without the prior step's record existing.

**Policy enforcement points in this service:**
- Policy 73 (AI Trust Level) — `AIAgentApprovalService.processInbound()` (trust level evaluated per action category); `generateAuditSupplement()` (FULL_AUTO scope applied)
- Policy 74 (AI Authority Boundary) — `AIAgentApprovalService.recordHumanDecision()` (AI self-approval check); `CommunicationService.send()` (second-layer enforcement that human decision record exists)
- Policy 75 (AI Escalation) — `AIAgentApprovalService.processInbound()` (confidence evaluation before draft generation)

**Forbidden acts enforced:**
- AI agent sending communication without human approval event — enforced at both `AIAgentApprovalService.recordHumanDecision()` and `CommunicationService.send()`
- AI agent approving its own drafts — enforced by actor identity check in `recordHumanDecision()`
- AI agent executing governed actions (stage transitions, rate overrides, payment waivers, FOC grants) without human approval — governed actions are created as proposals only; they are not executed by this service
- AI drafts sitting in review indefinitely — `AI_DRAFT_REVIEW_TTL` timer ensures FOM notification on TTL breach

---

## §6.7 — Infrastructure Service Catalogue

### 6.7.1 Infrastructure Service Design Contract

Infrastructure services provide foundational capabilities to domain and application services. They manage timers, sessions, communications, notifications, and audit emission. They do not own business entities, do not contain business rules, and do not invoke policies or engines — they execute mechanical operations on behalf of their callers.

Import rule: infrastructure services may not import domain or application services.

---

### 6.7.2 TimerManagementService

**Purpose:** The single interface through which all services register, cancel, and query timers. No service calls pg-boss or `TimerEngine` directly — all timer operations flow through this service.

**Operations:**

`TimerManagementService.register(timerType, entityReference, entityType, stageContext, firesAt, warningAt?, criticalAt?, payload?)` — creates a `TimerRecord` and registers the corresponding pg-boss job via `TimerEngine.register()`. Returns `TimerRegistration` (timerRecordId, pgBossJobId, registered, firesAt).

`TimerManagementService.cancel(timerRecordId, reason, actorId)` — cancels a `ACTIVE` timer: updates `TimerRecord.status = CANCELLED`; cancels the pg-boss job. Creates a `TimerEvent` recording the cancellation.

`TimerManagementService.status(timerRecordId)` — returns the current `TimerRecord` and its latest `TimerEvent`. Read-only.

`TimerManagementService.recalculateNextDayTimers(operatingDate)` — called by `NightAuditService` after audit completes. Recalculates all next-day timers: pre-arrival countdowns, checkout deadlines, payment milestones, dispute SLAs, follow-up reminders. Cancels stale timers; registers new timers for the next operating day.

**All timer types registered through this service are drawn from the timer registry in Part 4 §4.10.3.** No timer type may be invented in a service — every timer registration must use a `timerType` key from the registry.

**Engine invocation:**
- `TimerEngine.register(input: TimerRegistrationInput): TimerRegistration` — sole path for timer registration into pg-boss

---

### 6.7.3 SessionService

**Purpose:** Manages session lifecycle, PIN-based fast user switching, and attribution enforcement.

**Operations:**

`SessionService.authenticate(pin, terminalId)` — validates the staff member's PIN (hashed comparison). Creates `SessionRecord` with `status = ACTIVE`. Creates `SessionEventRecord` with `eventType = SessionEventType.PIN_SWITCH` (or initial login). The `SessionRecord.userId` is always an individual staff member — no shared or group credentials.

`SessionService.switchUser(outgoingActorId, incomingPin, terminalId)` — PIN switch between users at the same terminal. Creates `SessionEventRecord` with `eventType = SessionEventType.PIN_SWITCH`, `outgoingActorId`, `actorId` (incoming), `terminalId`, `trigger = SessionEventTrigger.MANUAL`. Both actor identities are recorded.

`SessionService.idleLock(sessionId)` — triggered by idle threshold timer. Updates `SessionRecord.status = IDLE_LOCKED`. Creates `SessionEventRecord` with `eventType = SessionEventType.IDLE_AUTO_LOCK`, `trigger = SessionEventTrigger.INACTIVITY`.

`SessionService.manualLock(sessionId, actorId)` — one-action manual lock. Updates `SessionRecord.status = MANUALLY_LOCKED`. Creates `SessionEventRecord` with `eventType = SessionEventType.MANUAL_LOCK`, `trigger = SessionEventTrigger.MANUAL`.

`SessionService.hardLogout(sessionId)` — triggered when the hard logout threshold is reached. Updates `SessionRecord.status = HARD_LOGGED_OUT`. Creates `SessionEventRecord` with `eventType = SessionEventType.HARD_LOGOUT`, `trigger = SessionEventTrigger.TIMER`.

**Attribution enforcement:** The `actorId` on every record written during a session is the authenticated user at the time of the action. No "on behalf of" mechanism exists. No retrospective attribution change is possible — `SessionEventRecord` is immutable from creation.

**Session isolation:** Terminal 1 session state does not affect Terminal 2. Each terminal manages its own `SessionRecord` independently.

---

### 6.7.4 CommunicationService

**Purpose:** Manages all outbound dispatch and inbound receipt of communications, communication threading, acknowledgement tracking, and voice note review completion.

**Operations:**

`CommunicationService.send(content, channel, entryId, actorId, correlationId?, aiDraftId?)` — outbound dispatch.

1. If `aiDraftId` is present: verifies that a `HumanDecisionRecord` with `HumanDecisionType.APPROVE` or `HumanDecisionType.EDIT_AND_APPROVE` exists for this draft before executing the send. If not found, throws `PolicyViolationError('AI communication requires human approval event — outbound send blocked')`. This is the second-layer enforcement of Policy 74.
2. Creates `CommunicationRecord` (immutable from creation).
3. Constructs subject line with appropriate prefix (QUOTATION, CONFIRMATION, AMENDED, CANCELLED) per channel conventions.
4. Dispatches via the appropriate infrastructure interface: Amazon SES for email outbound; WhatsApp BSP for WhatsApp. These are integration interface calls (Part 11) — not SDK calls from within this service.
5. Updates `CommunicationRecord.sendStatus` after dispatch confirmation.
6. Registers `ACKNOWLEDGEMENT_WINDOW` timer with `TimerManagementService` for communications requiring acknowledgement tracking.

`CommunicationService.receiveInbound(rawMessage, channel)` — inbound receipt.

1. Creates `CommunicationRecord` with `direction = 'INBOUND'`, `channel`, `messageType` (determined from message metadata).
2. If `messageType = MessageType.VOICE_NOTE`: routes to `VoiceNoteRoutingService.route()`. Does not route to AI processing.
3. If `messageType = MessageType.STANDARD`: routes to `AIAgentApprovalService.processInbound()`.
4. Handles email threading: matches to existing thread by `threadId` or `inReplyToId`.
5. Handles acknowledgement closure: if the inbound message is an explicit acknowledgement of a prior outbound, updates the outbound `CommunicationRecord.acknowledgementStatus = RECEIVED`.

`CommunicationService.completeVoiceNoteReview(communicationRecordId, summaryRecord, actorId)` — called when staff member completes voice note review.

1. Verifies that a `StaffListeningSummaryRecord` with all required structured fields has been written.
2. Updates `CommunicationRecord` to mark review complete (sets acknowledgement status to reflect reviewed state).
3. If the voice note was a reply to a prior outbound communication awaiting acknowledgement, that outbound's acknowledgement loop remains open — the staff member must explicitly close it by recording what the voice note said in relation to the prior outbound.

`CommunicationService.supersede(communicationRecordId, reason)` — marks a prior-segment communication as SUPERSEDED. Offers the user the option to send an invalidation notification; if the user declines, a mandatory reason is recorded.

**Forbidden acts enforced:**
- Sending material communications outside the system (they must route through this service)
- Deleting `CommunicationRecord` records — immutability enforced at schema level
- AI communications sent without a `HumanDecisionRecord` — second-layer check in `send()` when `aiDraftId` is present

---

### 6.7.5 NotificationService

**Purpose:** Manages the four-tier notification escalation model for all system-generated notifications requiring human attention.

**Notification tiers:**

| Tier | Recipient | Delivery | Example Trigger |
|---|---|---|---|
| Tier 1 | Assigned staff / front desk | In-app notification | Processing lock expiry notification to operator |
| Tier 2 | FOM | In-app + WhatsApp alert | Credit ceiling 90% threshold; voice note SLA breach; PARTIAL night audit run |
| Tier 3 | GM | In-app + WhatsApp alert | Credit ceiling 100% gate; AI draft TTL exceeded; audit exception escalation |
| Tier 4 | Architect (operational escalation) | Email | Configuration failure in production; unresolvable system state |

**Operations:**

`NotificationService.dispatch(recipientActorLevel, notificationType, payload, correlationId)` — dispatches a notification to the appropriate tier recipient. Selects delivery channel per tier configuration. Creates a notification event record for audit. All four tiers are configurable recipients — the tier structure is hardcoded, but the specific staff members in each tier are configured through the Admin Console.

`NotificationService.dispatchOperatorExpiry(processingLockId)` — specific handler for processing lock expiry. Dispatches the governed notification text to the operator who placed the lock: *"Your inventory hold has expired — please reconfirm availability before proceeding."* The notification text is hardcoded — it is governance language, not configurable.

**All notification dispatch routes through pg-boss jobs.** Notifications are non-critical events — they are dispatched after the primary database transaction commits, not within it. A failed notification dispatch does not roll back the operation that caused it. The pg-boss job is durable — if the notification fails on first attempt, pg-boss retries.

---

### 6.7.6 AuditService

**Purpose:** Provides the canonical trace event emission interface for all services. Services that need to emit trace events call `AuditService.emit()` rather than writing `TraceEvent` records directly. This ensures that the trace event structure (§6.3.3) is applied consistently and that all required fields (actorId, entityId, operation, timestamp) are validated as non-null before the record is written.

**Operations:**

`AuditService.emit(eventPayload: EventPayload)` — validates the payload (all required fields non-null), writes the `TraceEvent` record. This method is called within the Prisma transaction context when emitting critical events — the calling service passes the Prisma transaction client to ensure the trace event is part of the same transaction as the state change.

`AuditService.emitAsync(eventPayload: EventPayload)` — called after transaction commit for non-critical events. Dispatches as a pg-boss job. The job handler writes the `TraceEvent` record durably.

`AuditService.query(entityId, entityType, fromDate?, toDate?)` — read-only query for audit reconstruction. Returns ordered `TraceEvent` records for the specified entity and time range. This is the implementation surface for the §78 Audit Reconstruction Map — every question in §78 must be answerable from the records this query returns.

---

## Appendix A — Clarification Requests Surfaced at Gate 6

No unresolved clarification requests. B9-001 (amendment path routing algorithm) was deliberated and resolved in MOM-ARCH-2026-015 — the hybrid routing model (Model C) is applied in §6.6.2 above.

---

*End of Part 6 — Services*

*Prepared by Claude (AI Architectural Partner)*
*07 April 2026*
*Gate 6 — Services*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until the Architect confirms.*
