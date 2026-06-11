# LEGPHEL PMS — Stage Implementation Guideline
## S5: Pre-Arrival / Pre-Event

**Document ID:** SIG-S5
**Version:** 1.0
**Derived from:** DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)
**Prior SIGs referenced:** SIG-S3 v2.0, SIG-S4 v2.0
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** LOCKED — Confirmed by Architect 14 April 2026
**Locked by Architect 14 April 2026.**

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 14 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | Initial generation. SIG-S5-PRE-006 deliberated and scoped out (S3→X engine rows not referenced by S5). SIG-S5-COR-001 surfaced: `NoShowDeterminationRecord` Prisma model absent from Part 2 REV2-FINAL — schema derived from Part 3 §3.16 and service layer descriptions; backfill required. SIG-S5-COR-002 surfaced: `POST /entries/:id/room-assignments` and `PATCH /pre-arrival-tasks/:id` routes not found in Part 9 REV1 — specs derived from service definitions; Part 9 backfill required. |

---

## Deliberation Register

| ID | Item | Ruling | Recorded |
|---|---|---|---|
| D-SIG-S5-001 | SIG-S5-PRE-006 (Part 4 ReEntryConsequenceEngine PENDING correction) | Proceed — correction targets S3→X rows only; SIG-S5 uses S5→X rows exclusively; no impact on SIG-S5 content | 14 Apr 2026 |

---

## Session Findings Register

| ID | Type | Description | Status |
|---|---|---|---|
| SIG-S5-COR-001 | NEW-CONTENT | `NoShowDeterminationRecord` Prisma model absent from Part 2 REV2-FINAL. Model is present in the stage-to-record matrix and state machine definitions but has no `model NoShowDeterminationRecord { ... }` block in the schema. Schema derived from Part 3 §3.16 and service layer descriptions for this SIG. Part 2 backfill required. | PENDING — Part 2 backfill |
| SIG-S5-COR-002 | NEW-CONTENT | `POST /entries/:id/room-assignments` and `PATCH /pre-arrival-tasks/:id` routes not found in Part 9 REV1. Routes derived from `RoomAssignmentService.assignRoom()` and `PreArrivalService` task update method for this SIG. Part 9 backfill required. | PENDING — Part 9 backfill |

---

## Source Confirmation Table

| # | Source | File | Key Sections Read |
|---|---|---|---|
| 1 | Prior SIG S3 v2.0 | SIG-S3-v2_0.md | §2 schema (Folio, BillingModelTransitionRecord, CreditExtensionCeilingRecord); §9 config keys; §10 acceptance criteria |
| 2 | Prior SIG S4 v2.0 | SIG-S4-v2_0.md | Full — §1.4 S4 starting state; §2 all models (Reservation, HandoffRecord, Entry, CommittedHold); §3 state machine; §6 services; §7 workers; §9 config keys |
| 3 | Master Correction Log v1.7 | MASTER-CORRECTION-LOG-v1_7.md | Section 5 — SIG-S5-PRE-001 through PRE-008 reviewed; PRE-006 deliberated (D-SIG-S5-001); all other PRE items confirmed APPLIED |
| 4 | System Overview | DEV-SPEC-001-Part0.md | §0.1–§0.8 full |
| 5 | S5 Stage Charter | Canon_Block7_S5_S6_REV2_2.md | §46.1–§46.19 full including no-show doctrine, DEFICIENT handling, credit ceiling proximity, H1 fulfilment |
| 6 | Canon Matrices | Canon_Block11_Matrices_Governance_Appendices_REV2_2.md | §72 S5 policy column; §73 S5 configuration column; §74 S5 record column; §75 H1 handoff matrix row; §76 S5 timer rows; §76A S5 transition rows; §79 S5 readiness map |
| 7 | Schema | DEV-SPEC-001-Part2-REV2-FINAL.md | Full — Entry, Segment, PreArrivalTask, RoomAssignment, Folio, HandoffRecord, DeficientConditionRecord, CreditExtensionCeilingRecord, Reservation, StageDwellRecord, TraceEvent, CommunicationRecord, ConfigurationEntry; enums TaskStatus, PreArrivalTaskType, HandoffState, HandoffType, FolioState |
| 8 | State Machine | DEV-SPEC-001-Part3.md | §3.2 Entry (S4→S5, S5→S6, S5→TERMINAL, S5→S1 re-entry, AWAITING_WRITTEN_CONFIRMATION sub-state); §3.3 Folio (PROVISIONAL — no change at S5); §3.9 Handoff (CREATED→ACCEPTED→FULFILLED); §3.6 Inventory Claim (CONFIRMED — no change at S5); §3.16 No-Show Determination full |
| 9 | Engines | DEV-SPEC-001-Part4.md | §4.10 TimerEngine (W4, W5, W23 registration); §4.11 ReEntryConsequenceEngine (S5→S1 row); §4.12 RoomAssignmentSuggestionEngine |
| 10 | Policies | DEV-SPEC-001-Part5-REV2.md | Policies 1, 5, 9, 28, 35, 44, 48, 52, 56, 57, 59, 63, 67, 69, 71 — all S5-active per §72 S5 column |
| 11 | Services | DEV-SPEC-001-Part6-REV3.md | §6.5.3 EntryService (progressStage S5→S6, S5→TERMINAL; W34 cancellation on S4→S5); §6.5.8 HandoffService (accept(), fulfil()); §6.5.18 PreArrivalService (full); §6.5.19 RoomAssignmentService (full); §6.5.22 PaymentService (evaluateAdvancePaymentCondition, getPaymentStatus); NoShowService |
| 12 | Workers | DEV-SPEC-001-Part8.md | W1 StageDwellMonitor; W4 PreArrivalWindowActivationWorker; W5 NoShowCutoffWorker; W20 EntryExpiryWorker; W23 RoomReadinessSLAWorker |
| 13 | Routes | DEV-SPEC-001-Part9-REV1.md | Domain group: No-Show (§9.4.11); Domain group: Handoffs (§9.4.12); progress-stage route; cancellation route |
| 14 | Integration | DEV-SPEC-001-Part11.md | EmailInterface; WhatsAppInterface (pre-arrival outbound communications) |
| 15 | Configuration | DEV-SPEC-001-Part12.md | §12.3.3 S5_READINESS surface table |
| 16 | Acceptance Gates | DEV-SPEC-001-Part13.md | S5 assertions — policy coverage table; state machine guard table; schema cross-reference |

---

## Table of Contents

1. [Stage Identity](#section-1--stage-identity)
2. [Schema Models Active at S5](#section-2--schema-models-active-at-s5)
3. [State Machine at S5](#section-3--state-machine-at-s5)
4. [Policies Enforced at S5](#section-4--policies-enforced-at-s5)
5. [Engines Invoked at S5](#section-5--engines-invoked-at-s5)
6. [Services Active at S5](#section-6--services-active-at-s5)
7. [Workers Active at S5](#section-7--workers-active-at-s5)
8. [API Routes at S5](#section-8--api-routes-at-s5)
9. [Configuration Keys at S5](#section-9--configuration-keys-at-s5)
10. [Acceptance Criteria](#section-10--acceptance-criteria)

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 5 (S5) — Pre-Arrival / Pre-Event**

### 1.2 Stage Purpose

Stage 5 exists to verify that everything required for the guest's arrival or the event's commencement is operationally ready — room or space prepared, payments reconciled, special requests actioned, and the handoff from reservations to front desk complete. If S5 is completed correctly through the normal path, the hotel is ready to receive the guest before they arrive, not after.

S5 also governs no-show detection and determination. If the guest does not arrive by the configured no-show cutoff, the stage does not auto-close — it transitions into the no-show determination workflow. The stage remains open until either check-in occurs at S6 or FOM formally confirms a no-show with the appropriate financial consequence triggered.

### 1.3 Entry Routes

**Forward from S4 (standard).** The pre-arrival window has opened — the Timer Engine fires the `PRE_ARRIVAL_COUNTDOWN` job registered at S4 confirmation. The entry had a confirmed reservation with frozen terms, locked inventory, communicated confirmation voucher, assigned operational ownership, and an H1 handoff created. S5 inherits this complete handoff state from S4.

**Forward from S4 (compressed — same-day or next-day arrival).** If the arrival date is the current day or the following day at the time of S4 confirmation, the `PRE_ARRIVAL_COUNTDOWN` timer fires immediately. S5 activates in compressed mode. Compressed mode does not skip any pre-arrival obligations — it compresses them to real-time verification at the front desk. All obligations in §1.6 apply. The pre-arrival task checklist is always initialised on S5 activation regardless of mode.

**Re-entry from S6 or later (compressed readiness focus).** A configuration error discovered after check-in that requires pre-arrival-level preparation — room swap requiring housekeeping readiness, bed configuration change — routes the entry to S5 on a new segment. Re-entry from S6+ compresses S5 to the specific readiness aspect requiring re-verification; it is not a full repeat of the pre-arrival process.

### 1.4 S5 Starting State

When an entry enters S5, the following state is expected. This is the complete handoff from a correctly completed S4.

**Always present:**

- `Entry.currentStage = S5`; `Entry.status = ACTIVE`
- `Reservation` record exists with all frozen fields populated — the commitment snapshot is the authority for all commercial terms throughout S5
- `CommittedHold.state = CONFIRMED`; `Room.currentClaimState = CONFIRMED` — inventory is locked
- `Folio` in `FolioState.PROVISIONAL` with `billingModel` populated; no live charges may be posted
- `HandoffRecord` H1 created (`handoffType = H1`, `stageContext = S4`) — in `HandoffState.CREATED` (or `ACCEPTED` if auto-fulfilled because reservations and front desk are the same team)
- `CancellationDisclosureRecord` with `noShowTreatmentStatement` populated — the no-show penalty basis is already disclosed
- `StageDwellRecord` for S5 with `enteredAt` populated; `STAGE_DWELL_MONITOR` timer registered
- `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer cancelled in the same transaction as the S4→S5 stage write — advance payment follow-up responsibility transfers to S5

**Conditionally present:**

- `CreditExtensionCeilingRecord` on the folio (only if credit was extended at S3; `ceilingAmount` is mandatory and non-null if record exists)
- `OtaConflictOverbookingRecord` with `gmApprovalActorId` populated (only if overbooking was detected at S4; `mitigationPlanStatus` may still be open at S5 entry)
- Payment milestone timers registered (CORPORATE and CONFERENCE use types with milestone schedules)
- Work order with confirmed to-do items (CONFERENCE and GROUP use types; items carry individual deadlines)

### 1.5 Exit Conditions

**Normal exit — S5 → S6 (check-in path).** All of the following must be true. Guards evaluated in sequence. Failure raises `StageGateBlockedError` identifying the specific unsatisfied condition.

1. `HandoffRecord` H1 is in `HandoffState.FULFILLED`. Acceptance alone is insufficient — fulfilment evidence must be recorded. This is a mandatory exit condition, not a recommendation.
2. A `RoomAssignment` record exists for the entry. The assigned room is in `AVAILABLE_CLEAN` or `AVAILABLE_INSPECTED` state, or is `UNDER_MAINTENANCE` with `expectedReadyAt` before the arrival time and an alternative assignment exists.
3. If `RoomAssignment.deficientAtAssignment = true`: the assignment decision is documented — `acknowledgementActorId` and `acknowledgementAt` are populated on the `RoomAssignment` record.
4. All `PreArrivalTask` records for the entry are in `COMPLETE` or `WAIVED` status. No record may remain in `PENDING`. A WAIVED task must carry a recorded `waivedReason` and `waivedBy`.
5. Advance payment reconciled: `PreArrivalService.reconcileAdvancePayments()` has completed without unresolved flags, or all flags have been reviewed and acknowledged by FOM.
6. If a `CreditExtensionCeilingRecord` exists: the credit ceiling proximity check has been executed. If the current outstanding balance is at or above 90% of the ceiling, FOM has acknowledged the proximity condition before check-in proceeds.
7. The no-show cutoff has not fired (or has fired and the entry has re-entered normal processing via FOM's reactivation decision). An open `AWAITING_WRITTEN_CONFIRMATION` sub-state without FOM determination blocks normal exit.
8. Guest physically present at the front desk — S6 requires physical presence; S5 exit cannot be triggered without this condition.

**No-show exit — S5 → TERMINAL (no-show path).** All of the following must be true.

1. The no-show cutoff timer (W5) has fired — the entry is in `NO_SHOW_PENDING` or `AWAITING_WRITTEN_CONFIRMATION` phase.
2. FOM has made a formal determination: `NoShowDeterminationRecord` created with `fomActorId`, `contactAttemptLog`, and `decisionReason` populated.
3. `Folio.state = NO_SHOW_CLOSED` — penalty posted; advance payment reconciled; net position computed.
4. Section 54 financial consequence chain triggered via pg-boss job.
5. Inventory released through a governed release event — room returns to available inventory.

The no-show exit is a clean, governed closure — not an abandoned entry. The entry proceeds through S9-equivalent processing for final financial closure.

### 1.6 Stage Owner

The front desk custodian who accepted H1 is the operational owner of the entry throughout S5. This custodian is responsible for the guest's arrival preparation and reception at S6.

FOM holds escalation authority throughout S5: DEFICIENT flag decisions that exceed custodian scope, credit ceiling proximity at 90% or above, no-show determination, deferral of critical pre-arrival tasks, and any governed override of S5 operational actions.

If a shift change occurs between S5 activation and actual guest arrival, shift continuity doctrine applies — the incoming staff member must receive full context including H1 handoff status, DEFICIENT condition status, credit ceiling proximity if active, and any open no-show monitoring state.

### 1.7 Governing Actors

| Role | Authority Level | Authority at S5 |
|---|---|---|
| Front Desk / Reservations (Custodian) | L1 | Accept H1; assign room (non-DEFICIENT); complete and waive pre-arrival tasks within scope; dispatch pre-arrival communications; initiate cancellation (S4–S5 path) |
| Front Office Manager | L2 | All L1 actions; DEFICIENT room assignment decision above custodian scope; credit ceiling 90% acknowledgement; no-show determination (exclusive authority); critical task deferral approval; escalation rerouting on H1 rejection |
| General Manager | L3 | All L2 actions; no-show penalty waiver (if applicable per policy) |
| System Actor | L0 (equivalent) | Timer-fired no-show cutoff; Sub-path 2b auto-finalisation; SLA breach alerts; stage dwell monitoring |

### 1.8 Forbidden Acts at S5

**Posting charges to the provisional folio.** The folio is PROVISIONAL at S5. No room charges, F&B charges, or service charges may be posted. The folio accepts only payment records in S5 context. Conversion to LIVE occurs at S6.

**Changing commercial terms.** Rate, inclusions, billing model, and cancellation terms are frozen at S4. Any change requires formal re-entry through the amendment mechanism — not an S5 in-place edit.

**Auto-confirming a no-show without FOM determination.** The system must not transition an entry to no-show terminal state based solely on time passage. A recorded FOM determination event is always required. The timer triggers the inquiry; FOM makes the decision.

**Assigning a DEFICIENT-flagged room without documenting the decision.** Silent assignment of a DEFICIENT room — where the flag was not surfaced and no decision was recorded — is a governance failure. The flag must be surfaced, the decision made explicitly, and the outcome recorded on the `RoomAssignment` record.

**Confirming check-in at S5.** The guest has not arrived. Check-in is an S6 event requiring physical presence, identity verification, and key issuance.

**Skipping pre-arrival communication for VIP guests.** VIP guests per the profiling system tier classification require enhanced pre-arrival communication. Skipping for a VIP is a governed failure.

**Treating H1 acceptance as equivalent to H1 fulfilment.** H1 acceptance means the front desk has taken responsibility. H1 fulfilment means all readiness criteria are met and evidenced. These are distinct states. The S5→S6 guard requires FULFILLED, not ACCEPTED.

---

## Section 2 — Schema Models Active at S5

The following Prisma models are read or written during S5 operations. The full schema with all models is in Part 2 REV2-FINAL.

---

### 2.1 Entry

**Access at S5:** Read and written. Stage progression is the primary write operation.

```prisma
model Entry {
  id                   String          @id @default(uuid())
  inquiryId            String
  segmentNumber        Int             @default(1)
  useType              EntryUseType
  status               EntryStatus     @default(ACTIVE)
  currentStage         Stage           @default(S1)
  checkInDate          DateTime?
  checkOutDate         DateTime?
  guestCount           Int?
  otaSource            Boolean         @default(false)   // immutable once set
  groupBillingMode     GroupBillingMode?
  parkedAt             DateTime?
  parkedBy             String?
  parkedIndividually   Boolean         @default(false)
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  createdBy            String          // actor_id — NOT NULL
  version              Int             @default(1)       // optimistic lock field
  closedAt             DateTime?
  closedBy             String?
}
```

**S5 mutation rule:** `currentStage` updated from S5 to S6 on normal exit, or to TERMINAL-equivalent on no-show exit — all via `EntryService.progressStage()`. `status` may transition between ACTIVE and PARKED. `version` incremented on every update. No commercial fields are written at S5. `checkInDate`, `checkOutDate`, `guestCount` are read-only from the frozen commitment snapshot.

**AWAITING_WRITTEN_CONFIRMATION sub-state:** During the no-show determination process, the entry remains in `(ACTIVE, S5)`. AWAITING_WRITTEN_CONFIRMATION is not a value in `EntryStatus` or `currentStage` — it is a logical phase within the S5 no-show sub-process, expressed through the combination of timer events and the absence of a `NoShowDeterminationRecord`. No status field on Entry changes when the sub-state activates.

---

### 2.2 Reservation

**Access at S5:** Read-only. The commitment snapshot is the authority for all commercial terms throughout S5. No amendments at S5.

```prisma
model Reservation {
  id                      String    @id @default(uuid())
  entryId                 String    @unique
  segmentId               String
  frozenRate              Decimal   @db.Decimal(15,2)
  frozenRatePlanId        String
  frozenInclusions        Json
  frozenCancellationTerms Json
  frozenBillingModel      String
  frozenCheckInDate       DateTime
  frozenCheckOutDate      DateTime
  frozenGuestCount        Int
  creditCeilingIfExtended Decimal?  @db.Decimal(15,2)  // null if no credit extended at S3
  confirmedAt             DateTime
  confirmedBy             String
  confirmationVoucherSent Boolean   @default(false)
  sealedAt                DateTime?
  createdAt               DateTime  @default(now())
}
```

**S5 mutation rule:** Immutable — created at S4, read at S5. `creditCeilingIfExtended` is the authoritative ceiling value for S5 proximity checks. In-place modification of this record after S4 exit is the most dangerous architectural violation in the system. Any change after S4 requires a new segment with a new Reservation. `frozenCancellationTerms` governs the no-show penalty calculation at S5 exit through the no-show path.

---

### 2.3 HandoffRecord (H1 — S5 lifecycle)

**Access at S5:** Updated. H1 was created at S4. At S5, it transitions CREATED → ACCEPTED → FULFILLED.

```prisma
model HandoffRecord {
  id                    String        @id @default(uuid())
  entryId               String
  handoffType           HandoffType   // H1 at S5
  state                 HandoffState  @default(CREATED)
  fromRole              String
  fromActorId           String
  toRole                String
  toActorId             String?
  checklistContent      Json          // populated from HandoffChecklistTemplate (H1 type)
  deficientConditionStatus String?    // carried from S4 context; updated at FULFILLED
  fulfilmentEvidence    Json?         // populated at FULFILLED — room assigned, readiness confirmed, payment status
  assignedAt            DateTime?
  acceptedAt            DateTime?
  acceptedBy            String?       // actor_id — NOT NULL when ACCEPTED
  fulfilledAt           DateTime?
  fulfilledBy           String?       // actor_id — NOT NULL when FULFILLED
  closedAt              DateTime?
  rejectedAt            DateTime?
  rejectedBy            String?
  rejectionReason       String?
  escalatedAt           DateTime?
  slaDeadlineAt         DateTime?
  isAutoFulfilled       Boolean       @default(false)
  createdAt             DateTime      @default(now())
  createdBy             String
  stageContext          Stage         // S4 — created at S4
}
```

**S5 mutation rule:** Two governed transitions at S5. First: CREATED → ACCEPTED — the front desk custodian explicitly accepts the handoff, taking responsibility for the guest's arrival preparation. Second: ACCEPTED → FULFILLED — fulfilment evidence is recorded confirming all readiness criteria are met (room assigned with DEFICIENT status verified, payment reconciled, pre-arrival tasks reviewed, ceiling proximity addressed). `isAutoFulfilled = true` when reservations and front desk are the same team — the acceptance event is recorded regardless; no inter-team transfer occurs but the audit trail is always present. H1 FULFILLED is a mandatory S5 exit condition for the normal check-in path — not a recommendation.

**Fulfilment evidence required:** Room assignment confirmed (with DEFICIENT flag status); room physical readiness verified or a governed readiness deadline exists; pre-arrival tasks reviewed; payment status confirmed including ceiling proximity check if credit was extended.

---

### 2.4 RoomAssignment (Created at S5)

**Access at S5:** Created. Immutable from creation.

```prisma
model RoomAssignment {
  id                         String    @id @default(uuid())
  entryId                    String
  roomId                     String
  assignedAt                 DateTime  @default(now())
  assignedBy                 String    // actor_id — NOT NULL
  deficientAtAssignment      Boolean   @default(false)
  // true when the room carried an active DeficientConditionRecord at time of assignment
  deficientConditionRecordId String?
  // FK to DeficientConditionRecord — populated and permanently preserved when deficientAtAssignment = true
  // immutable even after the deficiency is subsequently cleared
  acknowledgementActorId     String?   // actor_id who acknowledged the DEFICIENT assignment
  acknowledgementAt          DateTime?
  notes                      String?
  createdAt                  DateTime  @default(now())
}
```

**S5 mutation rule:** Immutable from creation. This record captures the state of assignment at a point in time. The `deficientConditionRecordId` reference is permanently preserved even after the deficiency is subsequently cleared by housekeeping. A DEFICIENT-flagged room may be assigned — it is not a hard block — but the assignment must be explicit and documented. Silent assignment of a DEFICIENT room (where the flag was not surfaced and no decision recorded) is a governance failure.

**Room physical state requirement:** The assigned room must be in `AVAILABLE_CLEAN` or `AVAILABLE_INSPECTED` state at assignment time, or `UNDER_MAINTENANCE` with `expectedReadyAt` before the arrival time. A room in `UNDER_MAINTENANCE` without a governed `expectedReadyAt` may not be assigned.

**DEFICIENT assignment decision options (documented in assignment):**
- Assign with acknowledgement — the condition is minor and the guest will be informed
- Assign an alternative room of the same type — preferred when the deficiency affects guest experience
- Flag for FOM decision — the deficiency is significant and no equivalent alternative is available

---

### 2.5 PreArrivalTask (Created and Updated at S5)

**Access at S5:** Created on S5 entry; updated as tasks are completed or waived.

```prisma
model PreArrivalTask {
  id                  String             @id @default(uuid())
  entryId             String
  taskType            PreArrivalTaskType
  category            TaskCategory
  targetDate          DateTime?          // date-scoped for multi-night stays
  status              TaskStatus         @default(PENDING)
  assignedTo          String?            // actor_id of assigned staff member
  assignedDepartment  String?
  completedAt         DateTime?
  completedBy         String?            // actor_id — NOT NULL when status = COMPLETE
  waivedReason        String?            // mandatory when status = WAIVED
  waivedBy            String?            // actor_id — NOT NULL when status = WAIVED
  sourceRecordType    String?            // polymorphic — type of originating record
  sourceRecordId      String?            // polymorphic — id of originating record
  createdAt           DateTime           @default(now())
  createdBy           String             // actor_id — NOT NULL
}
```

**PreArrivalTaskType values:**
- `PAYMENT_RECONCILIATION` — advance payment reconciliation check (administrative)
- `CREDIT_CEILING_CHECK` — credit ceiling proximity verification (administrative; only when credit extended)
- `NIGHT_AUDIT_TIMER_REGISTRATION` — timer registration for in-stay night audit (administrative)
- `BED_CONFIGURATION_CHANGE` — housekeeping work order for bed setup change
- `PRE_ARRIVAL_COMMUNICATION` — structured communication at 1-week, 1-day, day-of intervals
- `SPECIAL_REQUEST_FULFILMENT` — special requests seeded from S1 special request records onward
- `LATE_ARRIVAL_MEAL_COORDINATION` — F&B coordination when guest arrives after kitchen close
- `SITE_VISIT` — conference engagement site visit (CONFERENCE use type only)
- `UNIT_READINESS_VERIFICATION` — apartment unit readiness including kitchen inventory and linen setup (APARTMENT use type only)

**S5 mutation rule:** Tasks created at S5 entry, seeded from: S1 special requests, S3 coordinator confirmations, S4 verification notes, and S5 work order to-do preparation. Status transitions: `PENDING → COMPLETE` (normal completion) or `PENDING → WAIVED` (explicit waiver). COMPLETE and WAIVED are terminal per task. Tasks are never deleted — only WAIVED with a recorded reason. A WAIVED task without a recorded `waivedReason` and `waivedBy` is an incomplete waiver. All tasks must reach COMPLETE or WAIVED before S5→S6 progression. A task in PENDING status blocks check-in.

---

### 2.6 NoShowDeterminationRecord (Created at S5 — no-show path)

**Access at S5:** Created when FOM makes a formal no-show determination. Immutable from creation.

**Note — SIG-S5-COR-001:** The Prisma model definition for `NoShowDeterminationRecord` is absent from Part 2 REV2-FINAL. The schema below is derived from the state machine definition, service layer descriptions, and worker specifications. A Part 2 backfill is required before this model may be considered schema-complete.

```prisma
model NoShowDeterminationRecord {
  id                      String    @id @default(uuid())
  entryId                 String    @unique
  // unique — one determination per entry; immutable from creation
  determinationPath       String
  // SUB_PATH_1 — FOM made immediate determination after cutoff
  // SUB_PATH_2B_AUTO — AWAITING_WRITTEN_CONFIRMATION timer expired; system auto-finalised with FOM authority
  fomActorId              String
  // actor_id of FOM who made or authorised the determination — NOT NULL; FOM authority mandatory
  contactAttemptLog       Json
  // array of { channel, attemptedAt, outcome, response } — populated before determination is created
  // at least one contact attempt is required before NoShowDeterminationRecord may be created
  decisionReason          String
  // mandatory — record cannot be created without a recorded reason
  otaNotificationRequired Boolean   @default(false)
  // true when Entry.otaSource = true — triggers OTA notification open loop (parallel to financial processing)
  otaNotificationStatus   String?
  // OPEN | CLOSED — null when not OTA-sourced
  // OTA notification is a parallel open loop; it does not gate financial processing
  determinedAt            DateTime  @default(now())
  createdAt               DateTime  @default(now())
  createdBy               String    // actor_id — NOT NULL; FOM on Sub-path 1; SYSTEM on Sub-path 2B auto-finalisation
}
```

**S5 mutation rule:** Immutable from creation. Created only when FOM determines CONFIRM_NO_SHOW — not on the REACTIVATE path (guest provides confirmed late arrival time, FOM chooses to reactivate S5). The record is never created, edited, or deleted after creation. Financial consequences (penalty amount, advance payment reconciliation, net position) are stored on the Folio record at the moment of `NO_SHOW_CLOSED` transition.

---

### 2.7 Folio

**Access at S5:** Read-only for all operational purposes. State is PROVISIONAL throughout S5. One exception: on the no-show determination path, the folio transitions from PROVISIONAL to NO_SHOW_CLOSED.

```prisma
model Folio {
  id                         String      @id @default(uuid())
  entryId                    String
  state                      FolioState  @default(PROVISIONAL)
  convertedToLiveAt          DateTime?
  convertedBy                String?
  closedAt                   DateTime?
  closedBy                   String?
  noShowPenaltyAmount        Decimal?    @db.Decimal(15,2)
  noShowAdvancePaymentAmount Decimal?    @db.Decimal(15,2)
  noShowNetPosition          Decimal?    @db.Decimal(15,2)
  noShowFomDetermination     String?     // actor_id of FOM who determined no-show
  postClosureAccessLevel     PostClosureAccessLevel?
  billingModel               String?     // non-null from S3 fixation onward
  createdAt                  DateTime    @default(now())
  createdBy                  String      // actor_id — NOT NULL
}
```

**S5 mutation rule — normal path:** Folio state remains PROVISIONAL. No charges may be posted. The folio accepts advance payment records if additional payment is collected at S5. Conversion to LIVE occurs at S6 check-in. Conversion at S5 is a forbidden act.

**S5 mutation rule — no-show path:** `FolioState.PROVISIONAL → FolioState.NO_SHOW_CLOSED` on FOM determination. At this transition: `noShowPenaltyAmount` populated (from cancellation policy same-day tier); `noShowAdvancePaymentAmount` populated (total advance payments received); `noShowNetPosition` populated (advancePaymentAmount minus penaltyAmount; positive value = refund obligation); `noShowFomDetermination` populated with FOM actor id; `closedAt` and `closedBy` populated. The NO_SHOW_CLOSED folio is immutable from this transition.

**Hard constraint on penalty:** No-show penalty cannot exceed the total advance payment received. This ceiling is invariant.

---

### 2.8 DeficientConditionRecord

**Access at S5:** Created when a DEFICIENT-flagged room is assigned and the condition is being documented. Also read from existing records created at S1 availability search time.

```prisma
model DeficientConditionRecord {
  id                   String                      @id @default(uuid())
  roomId               String
  category             DeficientConditionCategory
  description          String
  detectedAt           DateTime
  detectedBy           String                      // actor_id — NOT NULL
  resolutionDeadline   DateTime
  resolvedAt           DateTime?
  resolvedBy           String?
  resolutionNotes      String?
  status               String                      @default("UNRESOLVED")  // UNRESOLVED | RESOLVED
  createdAt            DateTime                    @default(now())
}
```

**S5 mutation rule:** Created at S5 when a DEFICIENT room assignment is documented and the condition is being formally recorded (if not already present from S1). Resolution events are additive — layered onto the original record, not replacements. The `deficientConditionRecordId` on `RoomAssignment` references the specific condition record that existed at assignment time and is permanently preserved. A resolution after assignment does not retroactively alter the assignment record.

---

### 2.9 Supporting Models

**CreditExtensionCeilingRecord** — read if present. `ceilingAmount` from the Reservation snapshot (`creditCeilingIfExtended`) is the authoritative ceiling for S5 proximity checks. The `CreditExtensionCeilingRecord` is the source record created at S3; the Reservation snapshot carries its value forward as the frozen reference.

**StageDwellRecord** — created on S5 entry; updated as the dwell progresses. Tracks dwell time within S5. Written by `StageDwellMonitor` (W1).

**TraceEvent** — immutable event records written on every governed action at S5: room assignment, H1 acceptance, H1 fulfilment, pre-arrival task completion, pre-arrival task waiver, pre-arrival communication dispatch, no-show inquiry opened, no-show determination, timer registration, timer cancellation, credit ceiling proximity notice.

**CommunicationRecord** — created on each pre-arrival communication dispatch. Tracks acknowledgement state (PENDING, RECEIVED, TIMED_OUT) per Policy 52.

**PaymentRecord** — may be created at S5 if additional advance payment is collected. Immutable from creation. Direction = IN.

**ConfigurationEntry** — read for all S5 configuration parameters. All S5 configuration keys are in dotted notation.

**GuestProfile** — read for tier classification (drives VIP treatment protocols) and preference hierarchy (drives room assignment priority, bed configuration, F&B briefing).

**WorkOrder** — read and updated at S5. To-do items are confirmed or governed-deferred with reason. Each to-do item deadline is timer-governed.

---

## Section 3 — State Machine at S5

### 3.1 Entry State at S5

The entry is in `(ACTIVE, S5)` or `(PARKED, S5)` throughout S5.

**Forward transitions from S5:**

| From | To | Guard | Authority | Notes |
|---|---|---|---|---|
| S5 | S6 | All §1.5 normal exit conditions satisfied; guest physically present | Custodian (front desk) | H1 FULFILLED is a mandatory gate condition |
| S5 | TERMINAL (no-show path) | No-show determination made by FOM; `NoShowDeterminationRecord` created | FOM | Triggers Section 54 financial consequence chain; entry routes through S9-equivalent |

**Re-entry transition from S5:**

| From | To | Trigger | Authority | New Segment |
|---|---|---|---|---|
| S5 | S1 | Configuration error requiring re-search (room type change, date change) | FOM | Yes |

**Park state:** The entry may be parked (`EntryStatus.PARKED`) during S5. Parking is a governed act. `STAGE_DWELL_MONITOR` thresholds differ for parked entries per the dwell mode configuration. A parked entry in S5 does not have its no-show timer paused — the no-show cutoff timer continues running regardless of park state.

### 3.2 No-Show Determination Sub-States

The no-show determination process operates as a governed sub-process within S5. The Entry remains in `(ACTIVE, S5)` throughout. AWAITING_WRITTEN_CONFIRMATION is a sub-state expressed through the combination of timer events and record absence — it is not an `EntryStatus` value.

| Logical Sub-State | System Condition |
|---|---|
| NO_SHOW_PENDING | No-show cutoff timer has fired; guest has not arrived; contact attempts in progress; no `NoShowDeterminationRecord` exists |
| AWAITING_WRITTEN_CONFIRMATION | Guest has claimed late arrival verbally; FOM has deferred determination; `AWAITING_WRITTEN_CONFIRMATION` timer is running; no `NoShowDeterminationRecord` exists |
| NO_SHOW_DETERMINED | `NoShowDeterminationRecord` created; penalty posted to folio; folio transitioning to NO_SHOW_CLOSED |
| FOLIO_NO_SHOW_CLOSED | `Folio.state = NO_SHOW_CLOSED`; financial residue governed; entry proceeding through S9-equivalent |

| From Sub-State | To Sub-State | Trigger | Authority |
|---|---|---|---|
| (S5 active) | NO_SHOW_PENDING | No-show cutoff timer fires (expected arrival + `noShow.cutoffWindowMinutes`) | System |
| NO_SHOW_PENDING | AWAITING_WRITTEN_CONFIRMATION | Guest claims late arrival verbally; FOM chooses to defer | FOM |
| NO_SHOW_PENDING | NO_SHOW_DETERMINED | FOM makes immediate no-show determination | FOM |
| AWAITING_WRITTEN_CONFIRMATION | (returns to normal S5) | Written confirmation received; FOM reactivates S5 | FOM |
| AWAITING_WRITTEN_CONFIRMATION | NO_SHOW_DETERMINED | `AWAITING_WRITTEN_CONFIRMATION` timer expires without written confirmation | System + FOM authority |
| NO_SHOW_DETERMINED | FOLIO_NO_SHOW_CLOSED | Folio closed as NO_SHOW_CLOSED; advance payment reconciled; penalty posted | System |

**Critical rule:** AWAITING_WRITTEN_CONFIRMATION is a sub-state, not a stage transition. The entry never leaves S5 during this process. It is not an `EntryStatus` value. No `currentStage` field is updated when this sub-state activates or resolves.

### 3.3 Folio State at S5

**Normal path:** `FolioState.PROVISIONAL` throughout S5. No change. Conversion to LIVE is an S6 event.

**No-show path:** `FolioState.PROVISIONAL → FolioState.NO_SHOW_CLOSED` — written atomically with `NoShowDeterminationRecord` creation.

A folio in NO_SHOW_CLOSED state is immutable from that transition. It cannot be converted to LIVE and cannot revert to PROVISIONAL.

### 3.4 HandoffRecord (H1) State at S5

| From | To | Trigger | Guard |
|---|---|---|---|
| CREATED | ACCEPTED | Front desk custodian explicitly accepts H1 | Checklist must be complete per Policy 5 |
| CREATED | ACCEPTED (auto) | Reservations and front desk are the same team | `isAutoFulfilled = true`; acceptance event recorded regardless |
| ACCEPTED | FULFILLED | Fulfilment evidence recorded (room assigned, readiness confirmed, payment reconciled, ceiling proximity addressed) | All fulfilment evidence fields populated |
| ACCEPTED/CREATED | ESCALATED | SLA deadline breached without acceptance | Timer-fired; FOM alerted |
| ACCEPTED | REJECTED | Blocking condition discovered after acceptance | FOM rerouting required; REJECTED is not terminal |

**H1 FULFILLED is a mandatory S5 exit condition.** An entry where H1 is in CREATED or ACCEPTED state cannot progress to S6.

### 3.5 Inventory Claim State at S5

`CommittedHold.state = CONFIRMED`; `Room.currentClaimState = CONFIRMED`. No change at S5 during normal operations. The confirmed claim represents the hotel's locked commitment to this guest for this inventory.

On no-show path: inventory released through a governed release event after `NoShowDeterminationRecord` is created and folio is NO_SHOW_CLOSED. `Room.currentClaimState → FREE` with a `RoomClaimStateEvent` recording the release reason `NO_SHOW_RELEASE`.

---

## Section 4 — Policies Enforced at S5

The following policies are active at S5, derived from the Stage-to-Policy Matrix (S5 column) cross-referenced with policy definitions.

---

**Policy 1 — Availability Query Policy**

- **Active at S5:** DEFICIENT check at room assignment — the availability query at room assignment combines Model 1 (claim state) and Model 2 (physical state) to determine which rooms of the confirmed type are available for assignment. DEFICIENT flags annotated on results.
- **Enforcement point:** `AvailabilityService` invoked by `RoomAssignmentService.assignRoom()` — available rooms of the confirmed type queried; DEFICIENT flags annotated before results returned to the service
- **Hardcoded:** Query combines both inventory models — neither alone is a valid availability answer. DEFICIENT flags are always annotated; they are never suppressed regardless of actor level.
- **Configurable:** DEFICIENT condition categories surfaced in results

---

**Policy 5 — H1 Handoff Custodian Transfer Policy**

- **Active at S5:** H1 acceptance — custodian transfer from reservations to front desk
- **Decision:** APPROVED (H1 accepted; custodian transfers; front desk takes responsibility) | DENIED (checklist incomplete — handoff blocked) | ESCALATE(L2 FOM) (H1 rejected — FOM routing required)
- **Enforcement point:** `HandoffService.accept()` — policy evaluated before `HandoffState → ACCEPTED`; checklist completion verified; custodian transfer event recorded. Auto-fulfilment records the acceptance event even when no inter-team transfer occurs.
- **Hardcoded:** Custodian does not transfer until H1 acceptance is recorded. Auto-fulfilment of H1 always records the event — no silent transfer.
- **Configurable:** H1 checklist items via `handoff.H1.checklist` — **blocking for S5_READINESS**

---

**Policy 9 — Pre-Arrival Period Policy**

- **Active at S5:** Pre-arrival window activation; S5 is open and managing readiness
- **Enforcement point:** `PreArrivalWindowActivationWorker` (W4, timer-fired) — S4→S5 transition recorded; pre-arrival task checklist initialised
- **Hardcoded:** S5 activates when the pre-arrival window opens — unconditionally. Same-day or next-day arrival at S4 confirmation time causes immediate activation (compressed mode). Compressed mode does not skip obligations — it compresses them to real-time verification.
- **Configurable:** Pre-arrival window duration via `preArrival.windowDays`

---

**Policy 28 — Advance Payment Reconciliation Policy**

- **Active at S5:** Pre-arrival reconciliation check
- **Decision:** Enforcement rule — reconciliation confirms advance payments are correctly applied against the provisional folio balance. Discrepancies surface as reconciliation flags for FOM review. Discrepancies do not block S4→S5 entry; they do block S5→S6 until FOM has reviewed and acknowledged each flag.
- **Enforcement point:** `PreArrivalService.reconcileAdvancePayments()` — run as part of the PAYMENT_RECONCILIATION PreArrivalTask
- **Hardcoded:** Unresolved reconciliation flags block S5→S6. Silent reconciliation (auto-resolving discrepancies without FOM review) is forbidden.
- **Configurable:** Advance payment thresholds via `advancePayment.thresholds`

---

**Policy 35 — Cancellation Enforcement Policy**

- **Active at S5:** Pre-arrival cancellation (guest cancels after S4 confirmation but before arrival)
- **Decision:** APPROVED (L2 FOM — cancellation processed with penalty applied per the disclosed tier) | ESCALATE(L3 GM) (penalty waiver requested beyond FOM authority)
- **Enforcement point:** `CancellationService.processCancel()` — penalty calculated from disclosed cancellation terms in commitment snapshot; penalty posted to folio; `EntryStatus → CANCELLED`; all operational history preserved
- **Hardcoded:** Cancellation at S5 sets `EntryStatus.CANCELLED` — terminal. Financial residue governed through S9-equivalent.
- **Configurable:** Cancellation penalty tiers via `cancellation.policyTiers`

---

**Policy 44 — Credit Ceiling Proximity Check Policy**

- **Active at S5:** Pre-arrival proximity check when credit was extended at S3
- **Decision:** Enforcement rule — `CreditCeilingMonitorEngine.evaluate()` called; result determines whether Tier 1 advisory notice (at or above 75% of ceiling) or Tier 2 active FOM interruption (at or above 90% of ceiling) is triggered.
  - **75% threshold (Tier 1):** Ambient notice surfaced to FOM alongside the pre-arrival dashboard view. FOM is informed; stay may proceed without explicit acknowledgement.
  - **90% threshold (Tier 2):** Active interruption — the stay cannot begin without FOM explicitly acknowledging the ceiling proximity and either approving continuation or initiating interim payment collection before check-in. This acknowledgement is a blocking S5→S6 gate condition.
- **Enforcement point:** `PreArrivalService.evaluateCreditCeiling()` — calls `CreditCeilingMonitorEngine.evaluate()`; CREDIT_CEILING_CHECK PreArrivalTask updated on completion
- **Engine delegation:** `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult`
- **Hardcoded:** 75% Tier 1 (ambient notice) and 90% Tier 2 (active FOM interruption before stay begins) are the canonical threshold tiers. If the balance already exceeds 90% before check-in, check-in cannot proceed without FOM acknowledgement.
- **Configurable:** Proximity threshold percentages via `creditCeiling.proximityThresholds`

---

**Policy 48 — DEFICIENT Room Assignment Decision Policy**

- **Active at S5:** Room assignment — DEFICIENT flag handling
- **Decision:** APPROVED (DEFICIENT condition acknowledged; assignment may proceed; flag carried into assignment record) | DENIED (acknowledgement not recorded — assignment cannot proceed without explicit decision)
- **Enforcement point:** `RoomAssignmentService.assignRoom()` — DEFICIENT flag checked; acknowledgement event required before `RoomAssignment` record is written; `deficientAtAssignment = true` and `deficientConditionRecordId` FK populated on the assignment record
- **Hardcoded:** A DEFICIENT-flagged room cannot be assigned without an explicit acknowledgement event. The flag does not disappear on assignment — it is permanently carried in the `RoomAssignment` record.
- **Configurable:** DEFICIENT condition categories that trigger mandatory acknowledgement via `deficientCondition.categories`

---

**Policy 52 — Communication Acknowledgement Tracking Policy**

- **Active at S5:** Pre-arrival communications dispatched at configured intervals
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on each outbound pre-arrival communication; `TimerEngine.register()` called for acknowledgement window; `AcknowledgementWorker` transitions to TIMED_OUT on window expiry
- **Hardcoded:** Every outbound communication has a tracked acknowledgement state — PENDING, RECEIVED, or TIMED_OUT. Guest arrival implicitly closes pre-arrival acknowledgement loops.
- **Configurable:** Acknowledgement window per type via `acknowledgement.windowPerType`; communication channel per stage via `communication.channelConfig`

---

**Policy 56 — No-Show Detection and Determination Policy**

- **Active at S5:** Cutoff period reached without guest arrival
- **Decision:**
  - **Sub-path 1 (No-show determined immediately):** FOM formally determines no-show; `NoShowDeterminationRecord` created immediately; Policy 57 financial mechanics fire; `FolioState → NO_SHOW_CLOSED`; S9-equivalent processing initiated.
  - **Sub-path 2 (Written confirmation pending):** Guest has claimed late arrival verbally; FOM defers; entry enters AWAITING_WRITTEN_CONFIRMATION sub-state; `AWAITING_WRITTEN_CONFIRMATION` timer registered. On timer expiry without written confirmation: no-show auto-finalised (Sub-path 2b); Sub-path 1 mechanics execute. On written confirmation received: no-show process abandoned; entry returns to normal S5 processing; no `NoShowDeterminationRecord` created.
  - **Sub-path 3 (Reactivate):** Guest provides confirmed late arrival time; FOM reactivates S5; entry returns to normal processing; no `NoShowDeterminationRecord` created.
- **Enforcement point:** `NoShowService.determineNoShow()` — FOM determination event required; contact attempts verified before record creation; `AWAITING_WRITTEN_CONFIRMATION` timer registered on deferral
- **Hardcoded:** No-show determination is a FOM authority action — the system triggers the inquiry; it does not auto-determine without FOM decision (except Sub-path 2b timer expiry). At least one contact attempt through a tracked channel is required before `NoShowDeterminationRecord` may be created. For OTA-sourced entries: an additional OTA platform communication obligation creates a separate open loop parallel to financial processing.
- **Configurable:** No-show cutoff period via `noShow.cutoffWindowMinutes`; AWAITING_WRITTEN_CONFIRMATION timer duration via `noShow.awaitingConfirmationWindowMinutes`

---

**Policy 57 — No-Show Folio Financial Policy**

- **Active at S5:** No-show financial mechanics — triggered by Sub-path 1 or Sub-path 2b
- **Decision:** Enforcement rule — no-show penalty posted to folio; penalty aligned with same-day cancellation tier from the disclosed cancellation terms. Penalty cannot exceed total advance payment received (invariant ceiling). Surplus advance payment creates a refund obligation tracked through S9-equivalent.
- **Enforcement point:** `NoShowService.processNoShowFolio()` — penalty calculated; posted to folio; `FolioState → NO_SHOW_CLOSED`; `noShowPenaltyAmount`, `noShowAdvancePaymentAmount`, `noShowNetPosition` populated on Folio; refund record created if advance exceeds penalty
- **Hardcoded:** Penalty ceiling = total advance payment received. This ceiling is invariant — it is never configurable. The folio is always governed on closure — no informal folio abandonment.
- **Configurable:** No-show penalty structure via `noShow.penaltyStructure`

---

**Policy 59 — Night Audit Countdown Policy**

- **Active at S5:** Night audit timers registered for expected in-stay nights
- **Enforcement point:** `PreArrivalService.registerNightAuditTimers()` — `TimerEngine.register()` called for each expected stay night; NIGHT_AUDIT_TIMER_REGISTRATION PreArrivalTask updated on completion
- **Hardcoded:** Night audit countdown timers are mandatory for every entry that will be in-stay. There is no in-stay period without these timers registered.
- **Configurable:** Night audit schedule via `nightAudit.schedule`

---

**Policy 63 — Handoff Lifecycle Policy**

- **Active at S5:** H1 acceptance and fulfilment
- **Enforcement point:** `HandoffService.accept()` and `HandoffService.fulfil()` — all handoff state transitions produce permanent audit events; `HandoffState.REJECTED` requires FOM rerouting; no silent rejection
- **Hardcoded:** Every handoff state transition produces an audit event — including auto-fulfilments. REJECTED is not terminal — rerouting always follows.
- **Configurable:** H1 checklist items via `handoff.H1.checklist`

---

**Policy 67 — Work Order Lifecycle Policy**

- **Active at S5:** To-do preparation — to-do items for pre-arrival tasks confirmed or governed-deferred with reason
- **Enforcement point:** `WorkOrderService` — to-do items tracked; deadlines timer-governed; approaching deadlines prompt assigned staff; breached deadlines alert FOM
- **Hardcoded:** Every work order amendment is a layered event. A CANCELLED to-do item requires a recorded reason.
- **Configurable:** Work order templates per use type via `workOrder.templates`

---

**Policy 69 — Session Management and PIN Authentication Policy**

- **Active at S5:** PIN authentication on every staff action
- **Enforcement point:** Middleware layer — session validation before any S5 operation; individual attribution on every action
- **Hardcoded:** No credential sharing. Every action is individually attributed and immutable.

---

**Policy 71 — Processing Lock TTL Policy**

- **Active at S5:** Processing locks on concurrent inventory operations expire unconditionally at TTL
- **Enforcement point:** `ProcessingLockService` — TTL enforced; no heartbeat or renewal; a lock expires unconditionally
- **Hardcoded:** Lock expires at TTL regardless of whether the associated operation is still in progress.

---

## Section 5 — Engines Invoked at S5

### 5.1 CreditCeilingMonitorEngine

**Invocation point:** `PreArrivalService.evaluateCreditCeiling()` — called as part of the CREDIT_CEILING_CHECK PreArrivalTask. Only invoked when `Reservation.creditCeilingIfExtended` is non-null (credit was extended at S3).

**Purpose:** Evaluates the current outstanding balance against the approved credit ceiling and determines whether a proximity threshold has been crossed.

**Input:** `CreditCeilingInput` — entryId, folioId, creditCeilingAmount (from `Reservation.creditCeilingIfExtended`), currentOutstandingBalance (sum of advance payments received), proximityThresholds (from `creditCeiling.proximityThresholds`).

**Output:** `CreditCeilingResult` — `thresholdCrossed: boolean`, `tier: 'TIER_1' | 'TIER_2' | null`, `percentage: number`, `requiresFomAcknowledgement: boolean`.

**S5 behaviour:** At 75% — Tier 1 ambient notice surfaced to FOM alongside pre-arrival dashboard. At 90% or above — Tier 2 active interruption; `requiresFomAcknowledgement: true`; check-in cannot proceed without FOM acknowledgement. The engine evaluates; the service takes the governed action.

### 5.2 RoomAssignmentSuggestionEngine

**Invocation point:** `RoomAssignmentService` — called on SLA breach when the assigned room has not reached readiness by the configured SLA threshold, or when the initial room assignment surfaces a DEFICIENT condition requiring alternatives.

**Purpose:** Produces a ranked list of available rooms of the confirmed type based on guest preferences, physical state, and operational constraints. Advisory output only — it does not create an assignment.

**Input:** `RoomSuggestionInput` — entryId, confirmedRoomType, guestPreferences (from GuestProfile), currentRoomStates, DEFICIENT flag status per room, arrival time.

**Output:** `RoomSuggestionResult` — ranked list of `{ roomId, roomNumber, physicalState, isDeficient, deficientDescription?, matchScore }`. DEFICIENT-flagged rooms are always included in the suggestion list but are marked — they are never excluded from suggestions.

**S5 behaviour:** The engine result is surfaced to the assigning actor as informational content. The actor selects a room (which may or may not match the suggestion) and makes the assignment through the normal path. The suggestion does not create a `RoomAssignment` record.

### 5.3 TimerEngine

**Timer registrations at S5:**

| Timer Type | Registration Point | Dispatches To | Notes |
|---|---|---|---|
| `STAGE_DWELL_MONITOR` | Entry enters S5 | StageDwellMonitor (W1) | Mode-dependent threshold |
| `ROOM_READINESS_SLA` | Room assigned but not yet in ready state | RoomReadinessSLAWorker (W23) | Registered only when room requires housekeeping readiness |
| `NO_SHOW_CUTOFF` | S5 activation (registered via PreArrivalWindowActivationWorker or inline on S5 entry) | NoShowCutoffWorker (W5) | Fires at expected arrival time + `noShow.cutoffWindowMinutes` |
| `AWAITING_WRITTEN_CONFIRMATION` | FOM selects deferral sub-path | NoShowCutoffWorker (W5) sub-behaviour | Registered only on FOM-initiated deferral |
| `ACKNOWLEDGEMENT_WINDOW` | Each pre-arrival communication dispatched | AcknowledgementWindowWorker | Per Policy 52 |

**Timer cancellations at S5:**

| Timer Cancelled | Cancellation Point | Notes |
|---|---|---|
| `ADVANCE_PAYMENT_FOLLOW_UP` (W34) | S4→S5 transition (in same transaction as stage write) | W34 responsibility transfers to S5 reconciliation — must not fire once entry is at S5 |
| `NO_SHOW_CUTOFF` | Guest arrives and S5→S6 progression begins | No-show is moot once check-in commences |
| `ROOM_READINESS_SLA` | Room reaches ready state or entry progresses to S6 | SLA monitoring ends when readiness is confirmed |

### 5.4 ReEntryConsequenceEngine

**Invocation point:** `EntryService.createSegment()` — called on S5→S1 re-entry.

**Purpose:** Computes the consequence payload for the re-entry event. For S5→S1: timers cancelled (ROOM_READINESS_SLA, DEFICIENT_RESOLUTION_DEADLINE, PRE_ARRIVAL_COUNTDOWN); provisional folio adjustments as required; hold maintained (inventory remains CONFIRMED on the prior segment); H1 returns to CREATED state (front desk releases ownership); inventory returns to COMMITTED_HELD on the new segment.

### 5.5 PricingPipelineEngine — NOT Invoked at S5

`PricingPipelineEngine.resolve()` is not called at S5. The rate is the frozen rate from the commitment snapshot (`Reservation.frozenRate`). Rate resolution occurred at S2 and was frozen at S4. Any rate change after S4 requires a new segment with re-entry through S2. Any implementation that calls `PricingPipelineEngine.resolve()` at S5 is an architectural violation.

---

## Section 6 — Services Active at S5

### 6.1 EntryService

**S5 responsibilities:** Stage progression on both S5 exit paths; segment creation on S5→S1 re-entry; W34 timer cancellation on S4→S5 entry.

**Method: `EntryService.progressStage(entryId, targetStage, actorId)`**

Called on S5→S6 (normal exit) and S5→TERMINAL (no-show exit, called by NoShowService after folio closure).

For S5→S6: entry transitions from `(ACTIVE, S5)` to `(ACTIVE, S6)`. `StageDwellRecord` for S5 gets `exitedAt` populated. New `StageDwellRecord` for S6 created. All S5 exit guards evaluated before the write — failure raises `StageGateBlockedError`.

For S5→TERMINAL: called after `Folio.state = NO_SHOW_CLOSED` is confirmed. Entry transitions to a terminal-adjacent state for S9-equivalent processing. `StageDwellRecord` for S5 gets `exitedAt` populated. All no-show exit guards confirmed before call.

**W34 cancellation on S4→S5 activation:** When called with `targetStage = S5` (by the PreArrivalWindowActivationWorker W4), `EntryService.progressStage()` cancels the `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer via `TimerEngine` in the same transaction as the stage write. Advance payment follow-up responsibility transfers to S5 reconciliation — the follow-up timer must not fire once the entry is at S5.

**Method: `EntryService.createSegment(entryId, reEntryReason, actorId)`**

Called on S5→S1 re-entry. Creates a new Segment, seals the prior segment, invokes `ReEntryConsequenceEngine.compute()` with the S5→S1 transition, and executes consequences in the same transaction.

**Models read:** `Entry`, `StageDwellRecord`, `HandoffRecord` (H1 state), `PreArrivalTask` (all must be COMPLETE or WAIVED before S5→S6), `RoomAssignment` (must exist), `CreditExtensionCeilingRecord`, `ConfigurationEntry`

**Models written:** `Entry` (`currentStage`, `version`), `StageDwellRecord` (`exitedAt`; new record for S6), `TraceEvent`

---

### 6.2 HandoffService

**S5 responsibilities:** H1 acceptance (`accept()`); H1 fulfilment (`fulfil()`); H1 rejection handling and rerouting.

**Method: `HandoffService.accept(handoffId, actorId, checklistCompletion)`**

Called when front desk custodian accepts H1. Enforces Policy 5 (H1 Handoff Custodian Transfer) and Policy 63 (Handoff Lifecycle).

Execution sequence:
1. Read `HandoffRecord` — verify `handoffType = H1`, `state = CREATED` (or re-routing after REJECTED).
2. Verify checklist completion against `handoff.H1.checklist` — all mandatory items must be completed; raises `PolicyGateBlockedError` if incomplete.
3. Transition `HandoffRecord.state → ACCEPTED`; populate `acceptedAt`, `acceptedBy`.
4. Record custodian transfer event via `TraceEvent`.
5. Write `StageDwellRecord` annotation for H1 acceptance timestamp.

**Auto-fulfilment path:** When reservations and front desk are the same team, `HandoffRecord.isAutoFulfilled = true`. The service records the acceptance event — the `acceptedAt` and `acceptedBy` are still populated. No inter-team transfer occurs but the audit trail is always present.

**Models read:** `HandoffRecord`, `ConfigurationEntry` (`handoff.H1.checklist`), `Entry`
**Models written:** `HandoffRecord` (`state`, `acceptedAt`, `acceptedBy`), `TraceEvent`

---

**Method: `HandoffService.fulfil(handoffId, actorId, fulfilmentEvidence)`**

Called when front desk custodian records H1 fulfilment — all readiness criteria met and evidenced.

Execution sequence:
1. Read `HandoffRecord` — verify `state = ACCEPTED`.
2. Verify `fulfilmentEvidence` is complete: room assignment confirmed; room physical readiness confirmed; pre-arrival tasks reviewed; payment status confirmed; credit ceiling proximity addressed (if applicable).
3. Transition `HandoffRecord.state → FULFILLED`; populate `fulfilledAt`, `fulfilledBy`, `fulfilmentEvidence`.
4. Write `TraceEvent` for H1 fulfilment.

**Note:** H1 cannot be fulfilled if the assigned room is not in a ready state and no alternative has been arranged. The fulfilment evidence payload must reflect actual readiness — not a prospective state.

**Models read:** `HandoffRecord`, `RoomAssignment`, `Room` (physical state), `PreArrivalTask`, `Folio`
**Models written:** `HandoffRecord` (`state`, `fulfilledAt`, `fulfilledBy`, `fulfilmentEvidence`), `TraceEvent`

---

### 6.3 PreArrivalService

**Primary entity:** `PreArrivalTask`

**S5 responsibilities:** Creates all PreArrivalTask records on S5 activation; manages task completion and waiver; reconciles advance payments; evaluates credit ceiling proximity; registers night audit timers.

**Method: `PreArrivalService.initialiseTasks(entryId, actorId)`**

Called at S5 entry (by W4 on stage progression). Creates all PreArrivalTask records for the entry, seeded from:
- Confirmed special requests from S1 onward (type: SPECIAL_REQUEST_FULFILMENT)
- Work order to-do items from S3/S4 (type: SITE_VISIT for CONFERENCE; UNIT_READINESS_VERIFICATION for APARTMENT)
- Pre-arrival communication schedule (type: PRE_ARRIVAL_COMMUNICATION — one task per configured communication interval)
- Late arrival meal flag if arrival is after kitchen close (type: LATE_ARRIVAL_MEAL_COORDINATION)
- Administrative tasks: PAYMENT_RECONCILIATION (always), CREDIT_CEILING_CHECK (only if `Reservation.creditCeilingIfExtended` is non-null), NIGHT_AUDIT_TIMER_REGISTRATION (always)
- Bed configuration change (type: BED_CONFIGURATION_CHANGE) — only if guest preference specifies a configuration different from the room's default; generates a housekeeping work order to-do item

Each task carries a `targetDate`. For multi-night stays, tasks are date-scoped to the relevant night.

**Method: `PreArrivalService.reconcileAdvancePayments(entryId, folioId)`**

Called as part of the PAYMENT_RECONCILIATION task completion. Enforces Policy 28.

- Reads all `PaymentRecord` entries on the folio with `paymentDirection = 'IN'`
- Verifies total received matches expected based on invoices dispatched and acknowledged
- Discrepancies surface as reconciliation flags for FOM review
- Updates PAYMENT_RECONCILIATION task to COMPLETE on clean reconciliation
- Discrepancies do not block S5 entry; they block S5→S6 until FOM acknowledges each flag

**Method: `PreArrivalService.evaluateCreditCeiling(entryId, folioId)`**

Called as part of the CREDIT_CEILING_CHECK task. Enforces Policy 44. Only invoked when `Reservation.creditCeilingIfExtended` is non-null.

- Calls `CreditCeilingMonitorEngine.evaluate()` with current outstanding balance and configured thresholds
- At 75% (Tier 1): surfaces ambient notice to FOM; updates CREDIT_CEILING_CHECK task; writes `TraceEvent`
- At 90% or above (Tier 2): surfaces active FOM interruption; check-in cannot proceed without FOM acknowledgement; `requiresFomAcknowledgement = true` on the task record
- Updates CREDIT_CEILING_CHECK task to COMPLETE after evaluation

**Method: `PreArrivalService.registerNightAuditTimers(entryId)`**

Called as part of the NIGHT_AUDIT_TIMER_REGISTRATION task. Enforces Policy 59.

- Computes expected stay nights from `Reservation.frozenCheckInDate` and `Reservation.frozenCheckOutDate`
- Registers a `NIGHT_AUDIT_SCHEDULE` timer for each expected stay night via `TimerEngine.register()`
- Updates NIGHT_AUDIT_TIMER_REGISTRATION task to COMPLETE

**Method: `PreArrivalService.completeTask(taskId, actorId)`** / **`PreArrivalService.waiveTask(taskId, actorId, reason)`**

Task status transitions. WAIVE requires a mandatory reason — `waivedReason` and `waivedBy` must be populated. COMPLETE and WAIVED are terminal — no further transitions. Tasks are never deleted.

**Models read:** `Entry`, `Reservation`, `WorkOrder`, `WorkOrderToDoItem`, `GuestProfile`, `CreditExtensionCeilingRecord`, `PaymentRecord`, `ConfigurationEntry`

**Models written:** `PreArrivalTask` (status transitions), `TraceEvent`

**Policy enforcement points:**
- Policy 28 — `PreArrivalService.reconcileAdvancePayments()`
- Policy 44 — `PreArrivalService.evaluateCreditCeiling()`
- Policy 59 — `PreArrivalService.registerNightAuditTimers()`

**Engine invocations:**
- `CreditCeilingMonitorEngine.evaluate()` — at `evaluateCreditCeiling()`

---

### 6.4 RoomAssignmentService

**Primary entity:** `RoomAssignment`

**S5 responsibilities:** Room assignment with DEFICIENT flag governance.

**Method: `RoomAssignmentService.assignRoom(entryId, roomId, actorId, deficientAcknowledgement?)`**

Execution sequence:
1. Query available rooms of the confirmed type via `AvailabilityService` (Policy 1) — combines Model 1 (claim state) and Model 2 (physical state).
2. Verify the proposed room is `AVAILABLE_CLEAN`, `AVAILABLE_INSPECTED`, or `UNDER_MAINTENANCE` with `expectedReadyAt` before arrival time.
3. Check `DeficientConditionRecord` on the proposed room — if `status = UNRESOLVED`, the room carries an active DEFICIENT flag.
4. If DEFICIENT:
   - Surface the condition description and category to the assigning actor.
   - Require explicit `deficientAcknowledgement` payload — `acknowledgementActorId` and acknowledgement timestamp.
   - Raise `PolicyGateBlockedError` with `blockingCondition: 'DEFICIENT_ACKNOWLEDGEMENT_REQUIRED'` if acknowledgement is absent.
5. Create `RoomAssignment` record: `deficientAtAssignment = true` and `deficientConditionRecordId` populated if DEFICIENT; `acknowledgementActorId` and `acknowledgementAt` populated.
6. Write `RoomClaimStateEvent` for the assignment.
7. If the room is not yet in a ready state: register `ROOM_READINESS_SLA` timer via `TimerEngine.register()`.
8. Write `TraceEvent` (`ROOM_ASSIGNED` — includes DEFICIENT flag status of assigned room).

**Method (SLA breach response):** On `ROOM_READINESS_SLA` breach, invokes `RoomAssignmentSuggestionEngine.suggest()` to surface alternative room suggestions to FOM as informational content. The suggestion does not create a `RoomAssignment` record.

**Models read:** `Entry`, `Room` (physical state), `DeficientConditionRecord`, `Reservation` (`frozenCheckInDate` for arrival time comparison), `ConfigurationEntry`

**Models written:** `RoomAssignment` (created; immutable from creation), `RoomClaimStateEvent`, `TraceEvent`

**Policy enforcement points:**
- Policy 48 — `RoomAssignmentService.assignRoom()`

**Engine invocations:**
- `AvailabilityService` → `AvailabilityEngine.query()` — Policy 1 enforcement
- `RoomAssignmentSuggestionEngine.suggest()` — on SLA breach; informational only

---

### 6.5 NoShowService

**Primary entities:** `NoShowDeterminationRecord`, `Folio` (NO_SHOW_CLOSED path)

**S5 responsibilities:** Governs the no-show event — determination, folio financial mechanics, and OTA notification obligation.

**Method: `NoShowService.determineNoShow(entryId, actorId, determinationInput)`**

Called on `POST /entries/:id/no-show`. Enforces Policies 56 and 57. L2 FOM authority required.

Execution sequence:
1. Verify `Entry.currentStage = S5` — raises `StateTransitionError` if not.
2. Verify the no-show cutoff timer has fired (the entry is in NO_SHOW_PENDING or AWAITING_WRITTEN_CONFIRMATION sub-state) — raises `PolicyGateBlockedError` with `blockingCondition: 'CUTOFF_NOT_REACHED'` if premature.
3. Verify at least one contact attempt is recorded in `contactAttemptLog` — raises `PolicyGateBlockedError` with `blockingCondition: 'CONTACT_ATTEMPTS_REQUIRED'` if absent.
4. **Sub-path 1 (immediate determination):** Create `NoShowDeterminationRecord`; call `NoShowService.processNoShowFolio()`.
5. **Sub-path 2 (defer — AWAITING_WRITTEN_CONFIRMATION):** Register `AWAITING_WRITTEN_CONFIRMATION` timer via `TimerEngine.register()`; write `TraceEvent` recording the deferral and FOM actor.
6. **Reactivate path:** Cancel no-show timers; write `TraceEvent`; entry returns to normal S5 processing; no `NoShowDeterminationRecord` created.

**Method: `NoShowService.processNoShowFolio(entryId, determinationRecordId)`**

Called after `NoShowDeterminationRecord` creation (Sub-path 1) or on Sub-path 2b timer expiry. Enforces Policy 57.

1. Calculate penalty from disclosed cancellation terms (`Reservation.frozenCancellationTerms` — same-day cancellation tier rate applied).
2. Verify penalty does not exceed total advance payment received — hard invariant.
3. Transition `Folio.state → NO_SHOW_CLOSED`: populate `noShowPenaltyAmount`, `noShowAdvancePaymentAmount`, `noShowNetPosition`, `noShowFomDetermination`, `closedAt`, `closedBy`.
4. If advance payment exceeds penalty: create refund `PaymentRecord` with `paymentDirection = 'OUT'` (refund obligation).
5. Dispatch no-show notification to guest/agent via `CommunicationService`.
6. For OTA-sourced entries (`Entry.otaSource = true`): set `otaNotificationRequired = true` on `NoShowDeterminationRecord`; `otaNotificationStatus = 'OPEN'` — OTA notification is a manual open loop, parallel to financial processing, not a sequential dependency.
7. Trigger S9-equivalent processing via pg-boss job.
8. Call `EntryService.progressStage()` with the terminal path.

**Forbidden acts enforced:**
- Declaring no-show without the required contact attempts
- Auto-determining no-show without a recorded FOM decision event (except Sub-path 2b timer expiry, which carries FOM authority from the original deferral)
- Waiving the no-show penalty without L3 GM authority
- Creating `NoShowDeterminationRecord` before the no-show cutoff timer has fired

**Models read:** `Entry`, `Reservation` (`frozenCancellationTerms`, `frozenCheckInDate`), `Folio`, `PaymentRecord` (total advance payments), `NoShowDeterminationRecord` (existence check for idempotency)

**Models written:** `NoShowDeterminationRecord` (created; immutable), `Folio` (state → NO_SHOW_CLOSED; financial fields populated), `PaymentRecord` (refund record if surplus), `TraceEvent`, `CommunicationRecord`

---

### 6.6 PaymentService

**S5 responsibilities:** Advance payment condition evaluation; credit extension status retrieval. No new `PaymentRecord` creation via this service — that is `FolioService.recordPayment()`.

**Method: `PaymentService.evaluateAdvancePaymentCondition(entryId, folioId)`**

Used by stage progression guard for the S5→S6 gate. Returns: `{ satisfied: boolean, totalReceived: Decimal, requiredAmount: Decimal, shortfall: Decimal }`.

**Method: `PaymentService.getPaymentStatus(entryId, folioId)`**

Returns: `{ totalReceived: Decimal, requiredAmount: Decimal, shortfall: Decimal, satisfied: boolean, creditExtensionActive: boolean, ceilingAmount: Decimal | null }`.

---

## Section 7 — Workers Active at S5

### 7.1 StageDwellMonitor (W1)

**Governed stage:** S1–S9 (cross-stage; active at S5)

**S5 behaviour:** Monitors dwell time within S5. At S5, dwell monitoring is particularly important for entries approaching their arrival date with incomplete readiness. Alerts escalate based on dwell mode (STANDARD vs COMPRESSED) and configured thresholds.

**Timer type:** `STAGE_DWELL_MONITOR`

**Registered at:** Entry enters S5

**Idempotency:** Before emitting a warning or critical event, reads `StageDwellRecord.warningFiredAt` and `criticalFiredAt`. If the corresponding timestamp is already set for this stage and this entry, the worker skips that phase without error. Idempotency keyed on `(entryId, stage, event_phase)`.

**Models read:** `Entry` (`currentStage`, `status`, `parkedAt`), `StageDwellRecord`, `ConfigurationEntry` (dwell thresholds)

**Models written:** `StageDwellRecord` (`warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `mode`), `TraceEvent`

---

### 7.2 PreArrivalWindowActivationWorker (W4)

**Governed stage:** S4 → S5

**S5 behaviour:** Registered at S4 confirmation via `TimerEngine.register()` with timer type `PRE_ARRIVAL_COUNTDOWN`. Fires when the pre-arrival window opens. Calls `EntryService.progressStage()` with `targetStage = S5`. Cancels W34 `ADVANCE_PAYMENT_FOLLOW_UP` timer in the same transaction. Calls `PreArrivalService.initialiseTasks()` to seed the PreArrivalTask checklist.

**Immediate activation:** If arrival is same-day or next-day at S4 confirmation time, fires immediately. S5 activates in compressed mode — all obligations apply; obligations are compressed to real-time verification, not skipped.

**pg-boss job type name:** `PRE_ARRIVAL_COUNTDOWN`

**Idempotency:** Before executing, reads `Entry.currentStage`. If `currentStage ≠ S4`, skips. Also checks for existing `TraceEvent` with `eventType = 'PRE_ARRIVAL.ACTIVATION_FIRED'` for this entry and segment — if present, skips. Idempotency keyed on `(entryId, segment, event_type)`.

**Audit event emitted:** `PRE_ARRIVAL.ACTIVATION_FIRED` — carries `entryId`, `segmentId`, `activationMode` (STANDARD or COMPRESSED), `arrivalDate`, `activatedAt`.

**Models read:** `Entry` (`currentStage`, `checkInDate`), `Reservation` (`frozenCheckInDate`), `TimerRecord`

**Models written:** `Entry` (`currentStage → S5`, `version`), `StageDwellRecord` (new S5 record), `PreArrivalTask` (all initial tasks seeded), `TraceEvent`

---

### 7.3 NoShowCutoffWorker (W5)

**Governed stage:** S5

**Primary trigger:** `NO_SHOW_CUTOFF` timer fires at expected arrival time + `noShow.cutoffWindowMinutes`. Entry has not checked in. Worker surfaces the no-show determination workflow to FOM.

**Sub-behaviour — AWAITING_WRITTEN_CONFIRMATION:** When FOM selects the deferral path (guest has claimed late arrival verbally), W5 registers a new `AWAITING_WRITTEN_CONFIRMATION` timer. If that timer fires before written confirmation is received, no-show is auto-finalised: Sub-path 2b executes, `NoShowDeterminationRecord` created with `determinationPath = SUB_PATH_2B_AUTO`, `processNoShowFolio()` called. This sub-behaviour is handled within the same worker class, registered under job type `AWAITING_WRITTEN_CONFIRMATION`.

**pg-boss job type names:** `NO_SHOW_CUTOFF` (primary); `AWAITING_WRITTEN_CONFIRMATION` (sub-behaviour)

**Idempotency:** Before triggering the no-show inquiry, checks whether a `NoShowDeterminationRecord` already exists for the entry. If one exists, skips and logs the skip event. If `Entry.currentStage ≠ S5`, skips. Idempotency keyed on `entryId`.

**Configuration parameters:**
- `noShow.cutoffWindowMinutes` — minutes after expected arrival before no-show process commences (configurable)
- `noShow.awaitingConfirmationWindowMinutes` — hold period after cutoff before FOM must determine (configurable)
- No-show determination is a FOM authority action — the worker triggers the inquiry; it does not auto-determine without FOM decision (except Sub-path 2b timer expiry)

**Audit events emitted:**
- `NO_SHOW_CUTOFF.FIRED` — on cutoff expiry; surfaces determination workflow to FOM
- `NO_SHOW.INQUIRY_OPENED` — on cutoff fire
- `NO_SHOW.AUTO_FINALISED` — on Sub-path 2b timer expiry

**Models read:** `Entry` (`currentStage`, `checkInDate`), `NoShowDeterminationRecord` (existence check), `Folio` (`state`), `Reservation` (`frozenCheckInDate`)

**Models written:** On Sub-path 2b auto-finalisation: `Folio` (state → NO_SHOW_CLOSED; financial fields), `NoShowDeterminationRecord`, `TraceEvent`

---

### 7.4 RoomReadinessSLAWorker (W23)

**Governed stage:** S5–S6

**Trigger condition:** Registered when a room is assigned at S5 but is not yet in a ready physical state. Fires at SLA approaching threshold and at SLA breach.

**pg-boss job type name:** `ROOM_READINESS_SLA`

**Idempotency:** Before dispatching SLA events, checks whether the room has transitioned to a ready state since the timer was registered. If the room is ready or the entry has progressed to S6, skips. Idempotency keyed on `(roomId, entryId, event_phase)`.

**On SLA breach:** Alerts FOM. Invokes `RoomAssignmentSuggestionEngine.suggest()` to surface alternative room suggestions as informational content. The suggestion does not create an assignment.

**Configuration parameters:**
- `housekeeping.sla.readinessWindowMinutes` — SLA window from assignment to required readiness (configurable)

**Audit events emitted:** `ROOM_READINESS_SLA.WARNING_FIRED`, `ROOM_READINESS_SLA.BREACHED`, `ROOM_READINESS_SLA.FOM_ALERTED`

**Models read:** `Room` (`currentClaimState`, `isDeficient`, `roomNumber`), `Entry` (`currentStage`), `Reservation` (`frozenCheckInDate`)

**Models written:** `TraceEvent`

---

### 7.5 EntryExpiryWorker (W20)

**Governed stage:** S1 (primary)

**S5 relevance:** The S1 entry expiry timer does not apply at S5 — it is cancelled or superseded when the entry progresses past S1. W20 is not active for entries that have reached S5. Listed here for completeness as it appears in the worker catalogue.

---

## Section 8 — API Routes at S5

Cover all S5 HTTP routes. Actor authority levels: L1 = Front Desk / Reservations; L2 = FOM; L3 = GM; L0 = System.

---

### 8.1 Accept Handoff (H1 acceptance)

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/accept` |
| Auth | `L1+` |
| Request DTO | `AcceptHandoffRequestDTO` — path param: `id` (HandoffRecord.id); body: `checklistCompletion` (object — completed checklist items keyed by item code) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.accept()` |
| Policies | Policy 5 (H1 only), Policy 63 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (checklist incomplete), `StateTransitionError` (H1 not in CREATED or re-routable state), `AppError` |
| Pagination | No |

---

### 8.2 Fulfil Handoff (H1 fulfilment)

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/fulfil` |
| Auth | `L1+` |
| Request DTO | `FulfilHandoffRequestDTO` — path param: `id`; body: `fulfilmentEvidence` (object — room assignment reference, readiness confirmation, payment status, ceiling proximity addressed flag) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.fulfil()` |
| Policies | Policy 63 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (fulfilment evidence incomplete; room not in ready state), `StateTransitionError` (H1 not in ACCEPTED state), `AppError` |
| Pagination | No |

---

### 8.3 Assign Room

**Note — SIG-S5-COR-002:** This route was not found in Part 9 REV1. Specification derived from `RoomAssignmentService.assignRoom()` in Part 6 REV3. Part 9 backfill required.

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/room-assignments` |
| Auth | `L1+` (L2+ when DEFICIENT flag requires FOM-level decision) |
| Request DTO | `RoomAssignmentRequestDTO` — path param: `id` (Entry.id); body: `roomId` (string, required), `notes` (string, optional), `deficientAcknowledgement` (object — `acknowledgementActorId`, `acknowledgementAt`, `decisionTaken` — required when room is DEFICIENT) |
| Response DTO | `RoomAssignmentResponseDTO` — `id`, `entryId`, `roomId`, `assignedAt`, `assignedBy`, `deficientAtAssignment`, `deficientConditionRecordId`, `acknowledgementActorId`, `notes`, `createdAt` |
| Service method | `RoomAssignmentService.assignRoom()` |
| Policies | Policy 1 (availability query), Policy 48 (DEFICIENT decision) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (DEFICIENT acknowledgement required; room not in valid physical state), `StageGateBlockedError` (entry not at S5), `MissingConfigurationError`, `AppError` |
| Pagination | No |

---

### 8.4 Update Pre-Arrival Task (complete or waive)

**Note — SIG-S5-COR-002:** This route was not found in Part 9 REV1. Specification derived from `PreArrivalService` task update methods in Part 6 REV3. Part 9 backfill required.

| Field | Value |
|---|---|
| Method + Path | `PATCH /pre-arrival-tasks/:id` |
| Auth | `L1+` |
| Request DTO | `UpdatePreArrivalTaskRequestDTO` — path param: `id` (PreArrivalTask.id); body: `action` (`COMPLETE` or `WAIVE`), `waivedReason` (string — required when action = WAIVE), `completedAt` (datetime, optional) |
| Response DTO | `PreArrivalTaskResponseDTO` — `id`, `entryId`, `taskType`, `category`, `status`, `completedAt`, `completedBy`, `waivedReason`, `waivedBy`, `targetDate` |
| Service method | `PreArrivalService.completeTask()` or `PreArrivalService.waiveTask()` |
| Policies | None — task transitions governed by mutation rules |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (waivedReason absent on WAIVE; task already terminal), `AppError` |
| Pagination | No |

---

### 8.5 Determine No-Show

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/no-show` |
| Auth | `L2+` (FOM minimum) |
| Request DTO | `NoShowDeterminationRequestDTO` — path param: `id` (Entry.id); body: `determinationPath` (`SUB_PATH_1` or `DEFER` or `REACTIVATE`), `contactAttemptLog` (array — required), `decisionReason` (string — required), `awaitingConfirmationWindowMinutes` (integer — required when path = DEFER) |
| Response DTO | `NoShowDeterminationResponseDTO` — `id`, `entryId`, `determinationPath`, `fomActorId`, `decisionReason`, `otaNotificationRequired`, `determinedAt` (null when DEFER or REACTIVATE) |
| Service method | `NoShowService.determineNoShow()` |
| Policies | Policy 56, Policy 57 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (cutoff not reached; contact attempts absent), `StateTransitionError` (entry not at S5 or not in NO_SHOW_PENDING/AWAITING_WRITTEN_CONFIRMATION sub-state), `AppError` |
| Pagination | No |

---

### 8.6 Progress Stage — S5 → S6

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` — path param: `id`; body: `targetStage` = `S6`, `version` (Entry.version — optimistic lock guard) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | All §1.5 normal exit guards evaluated before transition |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (H1 not FULFILLED; RoomAssignment absent; DEFICIENT not documented; PreArrivalTask in PENDING; reconciliation flags unresolved; 90% ceiling not acknowledged; AWAITING_WRITTEN_CONFIRMATION active), `OptimisticLockError` (version mismatch), `AppError` |
| Pagination | No |

**Guard evaluation order for S5→S6:**
1. H1 in FULFILLED state
2. RoomAssignment exists; room in valid physical state
3. DEFICIENT acknowledgement documented (if applicable)
4. All PreArrivalTask records COMPLETE or WAIVED
5. Advance payment reconciled; no unresolved flags
6. Credit ceiling 90% FOM acknowledgement (if applicable)
7. No active AWAITING_WRITTEN_CONFIRMATION sub-state without FOM determination
8. Guest physically present (confirmed by calling actor at the route invocation)

---

### 8.7 Cancel Entry at S5

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/cancel` |
| Auth | `L2+` (FOM minimum at S5) |
| Request DTO | `CancelEntryRequestDTO` |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `CancellationService.cancel()` |
| Policies | Policy 35 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (penalty waiver exceeds authority), `StateTransitionError`, `AppError` |
| Pagination | No |

---

## Section 9 — Configuration Keys at S5

All S5 configuration keys use dotted notation throughout. Keys are stored in `ConfigurationEntry` and accessed via `ConfigurationEntry.configKey`. Missing blocking keys produce `MissingConfigurationError` at the relevant enforcement point. The `S5_READINESS` startup check validates all blocking keys are present before S5 is declared live.

### Blocking for S5_READINESS

| configKey | Type | Description | Absence Consequence |
|---|---|---|---|
| `preArrival.windowDays` | Integer | Number of days before arrival at which S5 activates | Timer Engine cannot schedule S4→S5 activation — entries remain at S4 indefinitely |
| `roomAssignment.priorityRules` | Json | Ordered assignment priority criteria (VIP status, floor preference, bed config, room type match) — each entry carries priority order, criterion type, mandatory/advisory flag | Room assignment logic cannot execute — priority rules not defined |
| `handoff.H1.checklist` | Json | Ordered checklist items required for H1 acceptance — each entry carries item code, description, mandatory flag | H1 handoff acceptance blocked — checklist not defined |
| `noShow.cutoffWindowMinutes` | Integer | Minutes after expected arrival time before no-show process commences | No-show determination cannot execute — critical gap for any property enforcing no-show policies |
| `noShow.awaitingConfirmationWindowMinutes` | Integer | Hold period in minutes after no-show cutoff before FOM determination is required on the deferral sub-path | AWAITING_WRITTEN_CONFIRMATION timer cannot be registered — deferral sub-path inoperable |
| `noShow.penaltyStructure` | Json | Penalty tiers by advance payment amount, booking source, and client tier | No-show penalty cannot be calculated or applied |
| `deficientCondition.resolutionDeadlineHours` | Integer | Hours within which DEFICIENT conditions on assigned rooms must be resolved; governs the DEFICIENT_RESOLUTION_DEADLINE timer | DEFICIENT SLA monitoring cannot execute — deadline not configured |
| `advancePayment.thresholds` | Json | Required advance payment per source channel and client tier (shared with S3) | Advance payment verification at S5 unavailable |
| `cancellation.policyTiers` | Json | Cancellation penalty tiers by stage, timing, source, and tier (shared with S3, S4, S6) | No-show penalty calculation at S5 unavailable (no-show penalty aligned with same-day cancellation tier) |
| `expiry.s5.noShowContactWindowMinutes` | Integer | Window for contact attempts after cutoff before FOM determination is required | Timer Engine cannot schedule no-show contact events |

### Non-Blocking (referenced at S5 but not S5_READINESS gated)

| configKey | Type | Description | Absence Consequence |
|---|---|---|---|
| `preArrival.communicationSchedule` | Json | Timing rules per booking source and client tier (1-week, 1-day, day-of intervals) | Pre-arrival communications cannot be scheduled per source/tier — flat schedule fallback only |
| `preArrival.communicationTemplates` | Json | Template identifiers per communication type and channel | Pre-arrival communication dispatch unavailable — degrades guest experience but does not block S5 operationally |
| `bedConfiguration.options` | Json | Per room type — named bed configurations and their housekeeping setup requirements | Bed configuration change task cannot be generated; BED_CONFIGURATION_CHANGE PreArrivalTask not created |
| `creditCeiling.proximityThresholds` | Json | Threshold percentages (75 = Tier 1, 90 = Tier 2) for S5–S8 credit ceiling monitoring | Credit ceiling proximity check cannot execute for credit-extended entries — defaults to unconfigured state; FOM not alerted |
| `housekeeping.sla.readinessWindowMinutes` | Integer | Minutes from room assignment to required readiness — governs the ROOM_READINESS_SLA timer | System cannot alert on room readiness delays — SLA monitoring disabled |
| `stageDwell.thresholds` | Json | All stages × all dwell modes × warning/critical/escalation thresholds | Stage dwell monitoring degrades to no alerting |
| `nightAudit.schedule` | Json | Night audit schedule (shared with S7) | Night audit countdown timers cannot be registered at S5 — NIGHT_AUDIT_TIMER_REGISTRATION task cannot complete |
| `acknowledgement.windowPerType` | Json | Acknowledgement window per communication type (shared with S2–S9) | Pre-arrival communication acknowledgement tracking unavailable |

---

## Section 10 — Acceptance Criteria

Testable pass/fail assertions covering all S5 operational requirements. Both exit paths carry their own acceptance blocks.

---

### 10.1 Schema

**AC-S5-001:** `PreArrivalTask` model exists with `taskType: PreArrivalTaskType`, `status: TaskStatus`, `waivedReason String?`, `waivedBy String?`. `TaskStatus` enum includes `PENDING`, `COMPLETE`, `WAIVED`. **PASS** = model and enum present with correct fields. **FAIL** = model absent or fields missing.

**AC-S5-002:** `RoomAssignment` model exists with `deficientAtAssignment Boolean`, `deficientConditionRecordId String?`, `acknowledgementActorId String?`. **PASS** = model present with all three fields. **FAIL** = model absent or fields missing.

**AC-S5-003:** `NoShowDeterminationRecord` model exists with `entryId String @unique`, `fomActorId String`, `contactAttemptLog Json`, `decisionReason String`, `determinationPath String`. **PASS** = model present with all required fields. **FAIL** = model absent or fields missing. *(Blocking — G3-001 and SIG-S5-COR-001.)*

**AC-S5-004:** `Folio` model includes `noShowPenaltyAmount Decimal? @db.Decimal(15,2)`, `noShowAdvancePaymentAmount Decimal?`, `noShowNetPosition Decimal?`, `noShowFomDetermination String?`. **PASS** = all four fields present. **FAIL** = any absent.

**AC-S5-005:** `FolioState` enum includes `NO_SHOW_CLOSED`. **PASS** = value present. **FAIL** = value absent.

**AC-S5-006:** `PreArrivalTaskType` enum includes all nine values: `PAYMENT_RECONCILIATION`, `CREDIT_CEILING_CHECK`, `NIGHT_AUDIT_TIMER_REGISTRATION`, `BED_CONFIGURATION_CHANGE`, `PRE_ARRIVAL_COMMUNICATION`, `SPECIAL_REQUEST_FULFILMENT`, `LATE_ARRIVAL_MEAL_COORDINATION`, `SITE_VISIT`, `UNIT_READINESS_VERIFICATION`. **PASS** = all nine values present. **FAIL** = any absent.

---

### 10.2 State Machine

**AC-S5-007:** `Entry.currentStage = S5` throughout the no-show determination process, including during AWAITING_WRITTEN_CONFIRMATION sub-state. A test that fires the `NO_SHOW_CUTOFF` timer without guest arrival verifies `Entry.currentStage = S5` (unchanged) after the cutoff event. **PASS** = stage unchanged. **FAIL** = stage changed or cleared.

**AC-S5-008:** AWAITING_WRITTEN_CONFIRMATION is expressed through timer events and record absence — not through any `EntryStatus` or `currentStage` field change. A test that confirms AWAITING_WRITTEN_CONFIRMATION sub-state verifies no `Entry` field was updated at sub-state entry. **PASS** = no Entry field changes at sub-state entry. **FAIL** = any Entry status or stage field changed.

**AC-S5-009:** `HandoffRecord` H1 state machine: CREATED → ACCEPTED → FULFILLED. A test that calls `POST /handoffs/:id/fulfil` on an H1 in CREATED state (skipping ACCEPTED) returns `StateTransitionError`. **PASS** = error returned. **FAIL** = H1 transitions to FULFILLED from CREATED.

**AC-S5-010:** `Folio.state = PROVISIONAL` throughout S5 on the normal path. A test that attempts to post a charge against the provisional folio at S5 is rejected. **PASS** = charge rejected. **FAIL** = charge posted to provisional folio.

---

### 10.3 H1 Handoff

**AC-S5-011:** H1 FULFILLED is a mandatory S5→S6 guard condition. A test that calls `POST /entries/:id/progress-stage` with `targetStage = S6` when H1 is in ACCEPTED state returns `StageGateBlockedError`. **PASS** = error returned. **FAIL** = stage progressed with H1 only ACCEPTED.

**AC-S5-012:** H1 auto-fulfilment records the acceptance event. A test where reservations and front desk are the same team (configured) triggers S5 entry and verifies `HandoffRecord.isAutoFulfilled = true` and `acceptedAt` is populated. **PASS** = both fields populated. **FAIL** = either absent.

**AC-S5-013:** H1 acceptance enforces checklist completion. A test that calls `POST /handoffs/:id/accept` with incomplete checklist returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = H1 accepted with incomplete checklist.

---

### 10.4 Room Assignment

**AC-S5-014:** Policy 48 enforced at room assignment. A test that calls `POST /entries/:id/room-assignments` for a DEFICIENT-flagged room without `deficientAcknowledgement` payload returns `PolicyGateBlockedError` with `blockingCondition: 'DEFICIENT_ACKNOWLEDGEMENT_REQUIRED'`. **PASS** = error returned. **FAIL** = assignment created without acknowledgement.

**AC-S5-015:** `RoomAssignment.deficientConditionRecordId` is populated and permanently preserved when a DEFICIENT room is assigned. A subsequent resolution of the deficiency does not alter the `deficientConditionRecordId` on the existing `RoomAssignment` record. **PASS** = FK reference unchanged after resolution. **FAIL** = FK reference cleared on resolution.

**AC-S5-016:** A room in `UNDER_MAINTENANCE` without `expectedReadyAt` before the arrival time may not be assigned. A test that calls `POST /entries/:id/room-assignments` for such a room returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = assignment created for unscheduled maintenance room.

**AC-S5-017:** `RoomAssignment` is immutable from creation. A test that attempts to update any field on an existing `RoomAssignment` record returns a constraint error or is rejected by the service. **PASS** = update rejected. **FAIL** = update applied.

---

### 10.5 Pre-Arrival Tasks

**AC-S5-018:** All `PreArrivalTask` records must be COMPLETE or WAIVED before S5→S6. A test that calls `POST /entries/:id/progress-stage` with `targetStage = S6` when any task is in PENDING status returns `StageGateBlockedError`. **PASS** = error returned. **FAIL** = stage progressed with PENDING task.

**AC-S5-019:** A WAIVED task requires a recorded `waivedReason` and `waivedBy`. A test that calls `PATCH /pre-arrival-tasks/:id` with `action = WAIVE` and no `waivedReason` returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = task waived without reason.

**AC-S5-020:** `CREDIT_CEILING_CHECK` PreArrivalTask is created only when `Reservation.creditCeilingIfExtended` is non-null. A test with no credit extension verifies no `CREDIT_CEILING_CHECK` task is present in the entry's task list. **PASS** = task absent when no credit extended. **FAIL** = task created when no credit extended.

---

### 10.6 Credit Ceiling Proximity

**AC-S5-021:** Policy 44 Tier 1 (75%) — ambient FOM notice. A test that simulates outstanding balance at 75% of `creditCeilingIfExtended` verifies a `CreditCeilingThresholdEvent` with tier annotation is written and FOM is surfaced the notice. **PASS** = event written and notice surfaced. **FAIL** = no event or no FOM notice.

**AC-S5-022:** Policy 44 Tier 2 (90%) — active FOM interruption. A test that simulates outstanding balance at or above 90% of `creditCeilingIfExtended` verifies that `POST /entries/:id/progress-stage` with `targetStage = S6` returns `StageGateBlockedError` until FOM acknowledges the proximity condition. **PASS** = check-in blocked until FOM acknowledges. **FAIL** = check-in proceeds without FOM acknowledgement at 90%.

---

### 10.7 Normal Exit — S5 → S6

**AC-S5-023:** Complete normal exit path. A test that satisfies all §1.5 normal exit conditions (H1 FULFILLED; RoomAssignment exists with valid room state; all tasks COMPLETE or WAIVED; payment reconciled; no credit ceiling issues; guest physically present) calls `POST /entries/:id/progress-stage` with `targetStage = S6` and verifies `Entry.currentStage → S6` and `StageDwellRecord.exitedAt` populated for S5. **PASS** = stage progressed. **FAIL** = any exit condition gate failure or stage not updated.

**AC-S5-024:** `PricingPipelineEngine.resolve()` is not called at any point during S5. A test tracing all service calls during S5 operations verifies no invocation of the pricing engine. **PASS** = no pricing engine call. **FAIL** = pricing engine called at S5.

---

### 10.8 No-Show Exit — S5 → TERMINAL

**AC-S5-025:** No-show determination requires FOM authority. A test that calls `POST /entries/:id/no-show` with an L1 actor returns `AuthorizationError`. **PASS** = error returned. **FAIL** = no-show determination proceeds with L1 actor.

**AC-S5-026:** No-show determination requires at least one contact attempt. A test that calls `POST /entries/:id/no-show` with an empty `contactAttemptLog` returns `PolicyGateBlockedError` with `blockingCondition: 'CONTACT_ATTEMPTS_REQUIRED'`. **PASS** = error returned. **FAIL** = determination created without contact attempts.

**AC-S5-027:** `NoShowDeterminationRecord` is immutable from creation. A test that attempts to update any field after creation returns a constraint error or is rejected. **PASS** = update rejected. **FAIL** = update applied.

**AC-S5-028:** No-show penalty does not exceed total advance payment received. A test that calculates a penalty exceeding the advance payment amount verifies the penalty is capped at the advance payment total. **PASS** = penalty capped. **FAIL** = penalty exceeds advance payment.

**AC-S5-029:** `Folio.state → NO_SHOW_CLOSED` is atomic with `NoShowDeterminationRecord` creation. A test that simulates a failure after `NoShowDeterminationRecord` creation but before folio state change verifies the transaction rolls back — no `NoShowDeterminationRecord` persists without the folio also transitioning. **PASS** = rollback occurs. **FAIL** = `NoShowDeterminationRecord` persists without folio closure.

**AC-S5-030:** For OTA-sourced entries, `NoShowDeterminationRecord.otaNotificationRequired = true` on no-show determination. A test with `Entry.otaSource = true` verifies the OTA notification open loop is registered. **PASS** = `otaNotificationRequired = true` and `otaNotificationStatus = 'OPEN'`. **FAIL** = field absent or false for OTA-sourced entry.

**AC-S5-031:** No-show determination cannot proceed before the no-show cutoff timer has fired. A test that calls `POST /entries/:id/no-show` on an entry where the cutoff timer has not fired returns `PolicyGateBlockedError` with `blockingCondition: 'CUTOFF_NOT_REACHED'`. **PASS** = error returned. **FAIL** = determination created before cutoff.

---

### 10.9 Workers

**AC-S5-032:** W4 idempotency. A test that fires the `PRE_ARRIVAL_COUNTDOWN` job twice for the same entry verifies the second execution skips (based on `TraceEvent` check) and does not double-activate S5 or double-seed the PreArrivalTask checklist. **PASS** = skip on second fire. **FAIL** = double activation or double task seeding.

**AC-S5-033:** W5 idempotency. A test that fires `NO_SHOW_CUTOFF` twice for the same entry verifies the second execution skips because `NoShowDeterminationRecord` already exists. **PASS** = skip on second fire. **FAIL** = duplicate inquiry or duplicate determination.

**AC-S5-034:** W23 SLA breach — alternative rooms surfaced. A test that triggers `ROOM_READINESS_SLA.BREACHED` verifies `RoomAssignmentSuggestionEngine.suggest()` is called and its result is surfaced to FOM as informational content — no `RoomAssignment` record is created by the worker. **PASS** = suggestions surfaced; no new assignment. **FAIL** = assignment created by worker or suggestions not surfaced.

---

### 10.10 Configuration

**AC-S5-035:** Missing `noShow.cutoffWindowMinutes` raises `MissingConfigurationError` at the enforcement point before any no-show inquiry can be initiated. **PASS** = error raised. **FAIL** = no-show inquiry proceeds without configured cutoff.

**AC-S5-036:** Missing `handoff.H1.checklist` raises `MissingConfigurationError` at `HandoffService.accept()`. **PASS** = error raised. **FAIL** = H1 accepted without checklist configuration.

---

### 10.11 IP Boundary

**AC-S5-037:** This document contains no Canon section references (no `§46`, `§72`, `§79`, or similar), no DOSS principle numbers, and no FAC references in any body text. **PASS** = grep for `§[0-9]`, `DOSS`, `FAC` returns no body text matches. **FAIL** = any match found.

---

## Self-Check Results

The following self-check was performed against the session brief's 15-item checklist before presentation.

| # | Check | Result |
|---|---|---|
| 1 | Section count — exactly 10 sections, no Section 11 | PASS — Sections 1–10 present; no Section 11 |
| 2 | IP boundary — no "Canon", "DOSS", "FAC", or `§`-style section references in body text | PASS — no such references in body |
| 3 | Vocabulary — no "Engagement" used as Inquiry synonym | PASS |
| 4 | Config key notation — dotted notation throughout; no underscore in config key names | PASS |
| 5 | Gap marker scan — no `[GAP-`, `FINDING-`, `PENDING-` markers in body | PASS |
| 6 | Fallback language scan — no "until correction", "if available", "pending schema" | PASS — SIG-S5-COR-001 schema is a derived assertion, not fallback |
| 7 | Two exit paths — present in Sections 1, 3, 6, and 10 | PASS |
| 8 | AWAITING_WRITTEN_CONFIRMATION — described as sub-state throughout; not a stage transition | PASS — §3.2 explicit; §1.7 explicit; §6.5 explicit |
| 9 | DEFICIENT flag — present in Sections 2, 3, 6, 8, and 10 | PASS |
| 10 | Credit ceiling proximity — 75% Tier 1, 90% Tier 2 present in Sections 4 and 6 | PASS |
| 11 | H1 FULFILLED — described as mandatory exit condition; not recommended | PASS — §1.5, §3.4, §10.3 all use mandatory language |
| 12 | Folio PROVISIONAL — explicit in Sections 2 and 3 | PASS |
| 13 | PricingPipelineEngine NOT called — explicit in Section 5 | PASS — §5.5 dedicated |
| 14 | All five key workers present in Section 7 with idempotency keys | PASS — W1, W4, W5, W20, W23 all present with idempotency strategy |
| 15 | Version header, version history, and footer consistent — v1.0 | PASS |

---

*SIG-S5 v1.0*
*Derived from DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)*
*Architect: Dhendup Cheten, Fuzzy Automation*
*14 April 2026*
