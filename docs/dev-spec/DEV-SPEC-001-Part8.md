# LEGPHEL PMS — DEV-SPEC-001
# Part 8 — Workers
# §8.1 through §8.2

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 8 — Workers |
| Version | 1.0 |
| Date | 08 April 2026 |
| Status | LOCKED — MOM-ARCH-2026-016 |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§8.1–8.2); Canon Block 11 §76; Canon Block 10 §70B; DEV-SPEC-001-Part1.md; DEV-SPEC-001-Part2.md; DEV-SPEC-001-Part4.md; DEV-SPEC-001-Part5.md |

---

## Gate 8 Source Declaration

| Source | Role in this gate |
|---|---|
| ToC §§8.1–8.2 | Content requirements for both sections |
| Canon Block 11 §76 | Primary enumeration — Stage-to-Timer/Worker Matrix; authoritative source for all timers and associated worker obligations |
| Canon Block 10 §70B | OI-014-03 carry-forward — correction log maximum size for `CorrectionLogAggregationWorker` |
| DEV-SPEC-001-Part1.md | System actor identity (`L0 / SYSTEM`); locked technology stack (pg-boss, Prisma); actor level registry |
| DEV-SPEC-001-Part2.md | Exact Prisma model names and field names that workers read and write |
| DEV-SPEC-001-Part4.md | Engine method signatures that workers invoke (TimerEngine, NightAuditEngine, CreditCeilingMonitorEngine, TaxEngine); timer registry and fire sequence |
| DEV-SPEC-001-Part5.md | Exact policy names that workers enforce |

---

## Gate 8 Pre-Write Analysis

### §76 Entry Count

Canon §76 contains **33 distinct timer/worker entries** (lines 293–325 of Block 11).

### Promotion Decisions

The following §76 entries require a standalone worker decision. Entries not listed are sub-behaviours folded into an existing worker.

| §76 Entry | Decision | Justification |
|---|---|---|
| Entry expiry | **Promote → EntryExpiryWorker** | Distinct terminal-state action against an Entry record; unique trigger and consequence; TimerEngine registry confirms `ENTRY_EXPIRY` type dispatching to `EntryExpiryWorker` |
| Availability staleness | **Sub-behaviour of StageDwellMonitor** | Staleness detection fires within the dwell-monitoring context for the same entry; no independent lifecycle; StageDwellMonitor logs the staleness event as a dwell phase annotation |
| Quotation acknowledgement tracker | **Sub-behaviour of QuotationExpiryWorker** | Both govern the same S2 quotation and the same timer chain; the ack-tracker fires as the warning phase of the quotation validity timer on the same entity; merged as a pre-expiry alert within QuotationExpiryWorker |
| Payment milestone | **Promote → PaymentMilestoneWorker** | Distinct trigger (milestone configured per entry), distinct escalation path per payment milestone policy; TimerEngine registry confirms `PAYMENT_MILESTONE` type |
| Acknowledgement window (S2–S9) | **Promote → AcknowledgementWindowWorker** | Cross-stage, distinct trigger (material communication sent), distinct `CommunicationRecord` state transition; TimerEngine confirms `ACKNOWLEDGEMENT_WINDOW` type dispatching to `AcknowledgementTimeoutWorker` |
| Confirmation acknowledgement tracker (S4) | **Sub-behaviour of AcknowledgementWindowWorker** | S4-specific variant of the same acknowledgement window pattern; handled within AcknowledgementWindowWorker by filtering on `stageContext = S4` |
| Room readiness SLA | **Promote → RoomReadinessSLAWorker** | Distinct SLA type with distinct FOM escalation and alternative-room surfacing; TimerEngine confirms `ROOM_READINESS_SLA` type |
| Housekeeping SLA | **Promote → HousekeepingSLAWorker** | Distinct SLA type on a distinct lifecycle event (DEPARTED_DIRTY state); TimerEngine confirms `HOUSEKEEPING_SLA` type |
| H2/H3 acceptance | **Promote → HandoffAcceptanceWorker** | Distinct handoff infrastructure event; governed by Handoff Lifecycle Policy; TimerEngine confirms `H2_H3_ACCEPTANCE` type |
| Checkout time | **Promote → CheckoutTimeWorker** | Distinct timer type with late-checkout consequence path; TimerEngine confirms `CHECKOUT_TIME` type |
| Dispute SLA | **Promote → DisputeSLAWorker** | Distinct SLA framework with time-to-first-response and time-to-resolution targets; TimerEngine confirms `DISPUTE_SLA` type |
| Resolution execution | **Sub-behaviour of DisputeSLAWorker** | Resolution execution deadline is part of the dispute resolution lifecycle; governed within DisputeSLAWorker as a ResolutionBundleItem deadline phase alongside the parent dispute SLA |
| AWAITING_WRITTEN_CONFIRMATION | **Sub-behaviour of NoShowCutoffWorker** | Fired only after NoShowCutoffWorker triggers the verbal late-arrival claim path; Sub-path 2 of No-Show Detection and Determination Policy; continuation of the same no-show lifecycle |
| Feedback solicitation | **Promote → FeedbackSolicitationWorker** | Distinct trigger (checkout complete), distinct output (dual-channel survey + platform links); TimerEngine confirms `FEEDBACK_SOLICITATION` type |
| Equipment return | **Promote → EquipmentReturnWorker** | Distinct equipment lifecycle; separate from room operations; TimerEngine confirms `EQUIPMENT_RETURN` type |
| Lost & found retention | **Promote → LostFoundRetentionWorker** | Distinct LostAndFoundRecord lifecycle; TimerEngine confirms `LOST_FOUND_RETENTION` type |
| Maintenance expected_ready_at | **Promote → MaintenanceReadyAtWorker** | Distinct Room model state (UNDER_MAINTENANCE) with FOM alert and conflict detection on affected bookings; TimerEngine confirms `MAINTENANCE_EXPECTED_READY_AT` type |
| Blocked room unblock_date | **Promote → BlockedRoomUnblockWorker** | Separate Room model state (isBlocked) with distinct FOM alert path; TimerEngine confirms `BLOCKED_ROOM_UNBLOCK_DATE` type |
| FOM override frequency window | **Promote → FOMOverrideFrequencyWorker** | Distinct rolling-period monitoring of override patterns; produces GM ambient awareness notice; TimerEngine confirms `FOM_OVERRIDE_FREQUENCY_WINDOW` type |

### OI-014-03 Confirmation

`CorrectionLogAggregationWorker` is included in §8.2 as item 19. §70B M.7 (Configuration Dependencies) lists `correction log maximum size` as a configuration dependency of the AI Communication Agent. §70B M.10 (Timers / Workers Involved) identifies `Correction log aggregation — periodic analysis of correction rates per intent category for threshold tuning` as the governing worker obligation. The configKey `ai.correctionLog.maximumSize` is carried into the worker as the configurable parameter governing aggregation behaviour.

### Final Worker Count

18 pre-confirmed (ToC §8.2) + 1 (OI-014-03: `CorrectionLogAggregationWorker`) + 14 promoted from §76 = **33 standalone workers**.

---

## §8.1 — Worker Design Principles

### 8.1.1 What a Worker Is

A worker is a pg-boss–registered job handler that executes a governed time-driven or event-driven action. Workers are not scheduled independently — they are dispatched by the TimerEngine when a registered timer fires, or registered directly with pg-boss as periodic/recurring jobs. Workers do not compute. They orchestrate: they call services, which call policies and engines, which produce typed outputs that the service layer acts on.

This boundary is non-negotiable. A worker that contains business logic, policy evaluation, or direct engine computation has violated the architectural separation between the orchestration layer (workers + services) and the computation layer (engines + policies). Business logic in workers is an architectural defect.

### 8.1.2 Idempotency

Every worker is idempotent. A worker that runs twice on the same job must produce the same result as a worker that ran once. The idempotency strategy is stated per worker in §8.2. The general pattern is: before executing any action, the worker checks whether the action has already been applied. If the effect is already in the correct terminal state, the worker logs a skip event and exits without error.

"Already done" is never determined by the pg-boss job status alone — it is determined by inspecting the governed record in the database. pg-boss job states are infrastructure metadata; domain record states are the truth.

Double-execution producing duplicate records, duplicate charges, or duplicate events is a worker-level architectural defect.

### 8.1.3 pg-boss Integration

Every worker registers its job type with pg-boss using a canonical `jobType` string. pg-boss provides:

- **Durable scheduling** — job state survives application restarts.
- **Configurable retry with backoff** — failed jobs are retried up to a configured maximum retry count. The retry schedule uses exponential backoff unless stated otherwise per worker.
- **Dead-letter queue** — after the configured maximum retry count is exhausted, the job enters the dead-letter queue and triggers an alert to the operations team.
- **Deduplication** — where a `singletonKey` is supplied at job registration, pg-boss prevents duplicate job enqueue for the same governed entity within the singleton window.

Workers do not manage their own scheduling independently of pg-boss. No worker creates a `setTimeout`, `setInterval`, or any Node.js timer that operates outside pg-boss.

### 8.1.4 Audit Event Production

Every worker action emits at least one audit event as a `TraceEvent` record. The trace event carries:

- `eventType` — canonical event type name from the §77 event catalogue.
- `actorId` — the system actor identifier (see §8.1.5).
- `actorLevel` — `ActorLevel.SYSTEM`.
- `entityType` — the canonical record type name from Part 2 §1.6.19.
- `entityId` — the ID of the governed record.
- `operation` — one of: `CREATE`, `UPDATE`, `SEAL`, `CLOSE`, `TRANSITION`, `SKIP`, `ESCALATE`.
- `payload` — structured JSON payload (never freeform string).
- `timestamp` — explicit timestamp; workers do not rely on `@default(now())` for audit events.
- `stageContext` — the stage at time of action, where applicable.

A worker that transitions a record from an active state to a terminal state without emitting a `TraceEvent` is violating the silent-expiry prohibition.

### 8.1.5 System Actor Attribution

All worker actions are attributed to the system actor. The system actor identity is:

- **Actor level:** `ActorLevel.SYSTEM` (`L0`)
- **Actor identifier:** the canonical `SYSTEM` actor identifier as registered in the actor registry (Part 1 §1.6.4)

No worker uses a human actor's identity. No worker impersonates or acts on behalf of a named human actor. Attribution is unconditional — there is no "triggered by human, executed by system" attribution model. The system actor is the attributed actor for every worker-produced record and event.

### 8.1.6 Failure and Dead-Letter Behaviour

The standard failure and dead-letter behaviour for all workers unless stated otherwise in the individual worker entry:

1. On job failure, pg-boss retries with exponential backoff up to the configured maximum retry count.
2. After maximum retries are exhausted, pg-boss moves the job to the dead-letter queue.
3. Dead-letter queue entry triggers an alert (via the system notification mechanism) to operations. The alert carries: the job type, the job ID, the governed entity ID, the failure reason from the last attempt, and the timestamp of DLQ entry.
4. The worker does not attempt self-recovery from the dead-letter queue — dead-letter jobs require manual review and re-dispatch by an authorised operator.
5. Every failed attempt that reached the execution phase (i.e., the worker handler was invoked) produces a `TraceEvent` with `operation: 'SKIP'` or `operation: 'ERROR'` as appropriate, so the failure chain is auditable.

---

## §8.2 — Worker Catalogue

The catalogue entries below cover all 33 standalone workers. Each entry states the mandatory fields from the ToC content requirements: worker name, governed stage(s), trigger condition, idempotency strategy, pg-boss job type name, configuration parameters (hardcoded vs configurable), models read/written (exact names from Part 2), engines invoked (exact method signatures from Part 4), policies enforced (exact names from Part 5), audit event emitted, and failure/dead-letter behaviour.

Sub-behaviours noted in §8.1 pre-write analysis are documented within the relevant parent worker entry rather than as standalone entries.

---

### Worker 1 — StageDwellMonitor

**Governed stage(s):** S1 through S9

**Trigger condition:** Activated when an entry enters a stage. The TimerEngine registers a `STAGE_DWELL_MONITOR` timer at the moment of stage entry. Warning and critical thresholds are mode-dependent. Three dwell modes govern threshold behaviour: `ACTIVE` (entry is actively progressing), `IDLE` (no recent activity), `PARKED` (entry explicitly parked). Idle and critical thresholds differ between modes.

**Sub-behaviour — Availability staleness:** When an `AvailabilityConfiguration` record associated with an S1 or S2 entry exceeds the configured staleness window without a recall or progression event, StageDwellMonitor marks the configuration as stale (`isStale = true`, `stalenessAt` set). This is logged as a dwell phase annotation within the same `StageDwellRecord`. No separate worker runs for availability staleness — it is a phase within StageDwellMonitor's dwell evaluation loop.

**Idempotency strategy:** Before emitting a warning or critical event, the worker inspects `StageDwellRecord.warningFiredAt` and `StageDwellRecord.criticalFiredAt` respectively. If the corresponding timestamp is already set for this stage and this entry, the worker skips that phase without error. Idempotency is keyed on `(entryId, stage, event_phase)`.

**pg-boss job type name:** `STAGE_DWELL_MONITOR`

**Configuration parameters:**

- *Hardcoded:* Warning fires before critical. Critical fires before FOM escalation. FOM escalation fires only after critical threshold. The sequence `warn → critical → escalate` is invariant.
- *Configurable:* Warning threshold duration per stage per mode (from `ConfigurationEntry`); critical threshold duration per stage per mode (from `ConfigurationEntry`); FOM escalation threshold per stage per mode (from `ConfigurationEntry`); staleness window for availability configurations (from `ConfigurationEntry`).

**Models read:** `Entry` (`currentStage`, `status`, `parkedAt`), `StageDwellRecord` (`mode`, `warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `enteredAt`), `AvailabilityConfiguration` (`isStale`, `stalenessAt`, `sealedAt`), `ConfigurationEntry` (dwell thresholds)

**Models written:** `StageDwellRecord` (`warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `mode`), `AvailabilityConfiguration` (`isStale`, `stalenessAt`), `TraceEvent`

**Engines invoked:** None. Dwell monitoring is threshold comparison against elapsed time; no engine computation is required.

**Policies enforced:** None at enforcement-point level. StageDwellMonitor is an ambient monitoring worker; policy enforcement is the domain of the services it calls to dispatch notifications and escalations.

**Audit event emitted:** `STAGE_DWELL.WARNING_FIRED` (on warning threshold), `STAGE_DWELL.CRITICAL_FIRED` (on critical threshold), `STAGE_DWELL.FOM_ESCALATED` (on FOM escalation), `STAGE_DWELL.AVAILABILITY_STALENESS_MARKED` (on staleness annotation). All attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard. A dwell monitor failure does not affect the governed entry's operational state — the entry continues its lifecycle. The DLQ alert carries the entry ID and stage.

---

### Worker 2 — SpeculativeHoldExpiryWorker

**Governed stage(s):** S2

**Trigger condition:** Registered at hold placement. Fires when the speculative hold TTL expires (`SpeculativeHold.expiresAt` reached without S4 confirmation or explicit release or upgrade to committed hold).

**Idempotency strategy:** Before executing release, the worker reads `SpeculativeHold.state`. If `state = HoldState.RELEASED` or `state = HoldState.UPGRADED` or `state = HoldState.CONFIRMED`, the hold is already no longer active. The worker logs a skip event (`SPECULATIVE_HOLD.EXPIRY_SKIP`) and exits without error. Idempotency is keyed on `SpeculativeHold.id`.

**pg-boss job type name:** `SPECULATIVE_HOLD_EXPIRY`

**Configuration parameters:**

- *Hardcoded:* Expiry of a speculative hold does not silently release inventory. The release is always a governed event with a permanent record. Release reason is set to `EXPIRY`. The inventory claim state transitions from `InventoryClaimState.SPECULATIVELY_HELD` to `InventoryClaimState.FREE`. Staff are alerted on release.
- *Configurable:* Speculative hold TTL (configured at hold placement time by the placing actor; read from `SpeculativeHold.ttlSeconds` at invocation — not re-read from configuration tables).

**Models read:** `SpeculativeHold` (`state`, `expiresAt`, `entryId`, `roomId`, `spaceId`), `Room` (`currentClaimState`), `ConfigurationEntry` (staff alert routing)

**Models written:** `SpeculativeHold` (`state → HoldState.RELEASED`, `releasedAt`, `releasedBy = SYSTEM actor`, `releaseReason = 'EXPIRY'`), `Room` (`currentClaimState → InventoryClaimState.FREE`), `RoomClaimStateEvent` (new record for the FREE transition), `TraceEvent`

**Engines invoked:** None.

**Policies enforced:** Speculative Hold Placement Policy (Policy 25) — the expiry enforces the timer-governed consequence of speculative hold TTL expiry; inventory release is the governed consequence.

**Audit event emitted:** `SPECULATIVE_HOLD.EXPIRY_TRIGGERED` — carries `holdId`, `entryId`, `roomId` (if applicable), `spaceId` (if applicable), `expiresAt`.

**Failure / dead-letter behaviour:** Standard. If the worker fails after the `SpeculativeHold` state has been updated but before the `RoomClaimStateEvent` is written, the idempotency check on re-run detects `state = RELEASED` and skips, leaving the room claim state inconsistent. This is a data integrity seam. Implementations must wrap the `SpeculativeHold` state update and the `RoomClaimStateEvent` creation in a single database transaction to ensure atomicity.

---

### Worker 3 — CommittedHoldExpiryWorker

**Governed stage(s):** S3–S4

**Trigger condition:** Registered at hold placement. Fires when the committed hold TTL expires without S4 confirmation.

**Idempotency strategy:** Before executing release, the worker reads `CommittedHold.state`. If `state = HoldState.RELEASED` or `state = HoldState.CONFIRMED`, the hold is no longer active. The worker logs a skip event and exits without error. Idempotency is keyed on `CommittedHold.id`.

**pg-boss job type name:** `COMMITTED_HOLD_EXPIRY`

**Configuration parameters:**

- *Hardcoded:* Expiry transitions `CommittedHold.state` to `HoldState.RELEASED`. Inventory transitions from `InventoryClaimState.COMMITTED_HELD` to `InventoryClaimState.FREE`. FOM is escalated immediately on expiry (committed hold expiry is higher-severity than speculative hold expiry). Release reason is permanently recorded.
- *Configurable:* Committed hold TTL per engagement configuration (read from `CommittedHold.ttlSeconds` at invocation).

**Models read:** `CommittedHold` (`state`, `expiresAt`, `entryId`, `roomId`, `spaceId`), `Room` (`currentClaimState`)

**Models written:** `CommittedHold` (`state → HoldState.RELEASED`, `releasedAt`, `releasedBy = SYSTEM actor`, `releaseReason = 'EXPIRY'`), `Room` (`currentClaimState → InventoryClaimState.FREE`), `RoomClaimStateEvent`, `TraceEvent`

**Engines invoked:** None.

**Policies enforced:** Committed Hold Expiry Policy (Policy 8).

**Audit event emitted:** `COMMITTED_HOLD.EXPIRY_TRIGGERED` — carries `holdId`, `entryId`, `roomId` (if applicable), `expiresAt`.

**Failure / dead-letter behaviour:** Standard. Atomicity requirement identical to SpeculativeHoldExpiryWorker: state update and `RoomClaimStateEvent` creation must be wrapped in a single transaction.

---

### Worker 4 — PreArrivalWindowActivationWorker

**Governed stage(s):** S4 → S5

**Trigger condition:** Registered at S4 confirmation via `TimerEngine.register()` with timer type `PRE_ARRIVAL_COUNTDOWN`. Fires when the configured pre-arrival window opens relative to arrival date. If arrival is same-day or next-day at the time of S4 confirmation, `TimerEngine` fires immediately and S5 activates in compressed mode.

**Idempotency strategy:** Before executing the S4→S5 transition, the worker reads `Entry.currentStage`. If `currentStage ≠ S4`, the entry has already progressed past S4 (or has been cancelled/expired). The worker logs a skip event and exits. Idempotency is keyed on `(entryId, segment transition event)` — if a `TraceEvent` with `eventType = 'PRE_ARRIVAL.ACTIVATION_FIRED'` already exists for this entry and segment, the worker skips.

**pg-boss job type name:** `PRE_ARRIVAL_COUNTDOWN`

**Configuration parameters:**

- *Hardcoded:* Same-day or next-day arrival at S4 confirmation time causes immediate activation (compressed mode). Compressed mode does not skip any pre-arrival obligations — it compresses them into real-time verification. The pre-arrival task checklist is always initialised on activation.
- *Configurable:* Pre-arrival window duration in days (from `ConfigurationEntry` with key `pre_arrival_window_days`).

**Models read:** `Entry` (`currentStage`, `checkInDate`), `Reservation` (`frozenCheckInDate`), `TimerRecord` (`status`)

**Models written:** `Entry` (`currentStage → S5`), `Segment` (stage updated), `TraceEvent`

**Engines invoked:** None. The transition itself is a service call; the timing of when the timer was registered uses `TimerEngine.register(input: TimerRegistrationInput): TimerRegistration` (invoked at S4 confirmation by the service layer, not by this worker at fire time).

**Policies enforced:** Pre-Arrival Period Policy (Policy 9).

**Audit event emitted:** `PRE_ARRIVAL.ACTIVATION_FIRED` — carries `entryId`, `segmentId`, `activationMode` (`STANDARD` or `COMPRESSED`), `arrivalDate`, `activatedAt`.

**Failure / dead-letter behaviour:** Standard. A failed activation leaves the entry at S4. The DLQ alert is high-priority when arrival date is within 24 hours.

---

### Worker 5 — NoShowCutoffWorker

**Governed stage(s):** S5

**Trigger condition:** Fires when the no-show cutoff period expires (expected arrival time reached without a check-in event or verbal late-arrival claim).

**Sub-behaviour — AWAITING_WRITTEN_CONFIRMATION:** When the FOM selects Sub-path 2 of the No-Show Detection and Determination Policy (guest claims late arrival verbally), `NoShowCutoffWorker` registers a new `AWAITING_WRITTEN_CONFIRMATION` timer via `TimerEngine.register()`. If that timer fires before written confirmation is received, the no-show is finalised automatically by the worker — Sub-path 1 financial mechanics execute at that point. This sub-behaviour is handled within the same worker class as a second job handler registered under job type `AWAITING_WRITTEN_CONFIRMATION`.

**Idempotency strategy:** Before triggering the no-show inquiry, the worker checks whether a `NoShowDeterminationRecord` already exists for the entry. If one exists, the worker skips and logs the skip event. Additionally, if `Entry.currentStage ≠ S5`, the worker skips. Idempotency is keyed on `entryId`.

**pg-boss job type name:** `NO_SHOW_CUTOFF` (primary); `AWAITING_WRITTEN_CONFIRMATION` (sub-behaviour)

**Configuration parameters:**

- *Hardcoded:* No-show determination is a FOM authority action — the worker triggers the inquiry and surfaces the no-show workflow; it does not auto-determine the no-show. Auto-determination occurs only on `AWAITING_WRITTEN_CONFIRMATION` timer expiry (Sub-path 2b). FOM must initiate Sub-path 2 explicitly; the system does not auto-enter `AWAITING_WRITTEN_CONFIRMATION` state.
- *Configurable:* No-show cutoff period (from `ConfigurationEntry` with key `no_show_cutoff_period`); `AWAITING_WRITTEN_CONFIRMATION` timer duration (from `ConfigurationEntry` with key `awaiting_written_confirmation_ttl`); contact attempt window.

**Models read:** `Entry` (`currentStage`, `checkInDate`), `NoShowDeterminationRecord` (existence check), `Folio` (`state`), `Reservation` (`frozenCheckInDate`, `noShowFomDetermination`)

**Models written:** On cutoff fire: `TraceEvent` (`NO_SHOW_CUTOFF.FIRED`). On Sub-path 2 auto-finalisation: `Folio` (`state → FolioState.NO_SHOW_CLOSED`, `noShowPenaltyAmount`, `noShowNetPosition`, `noShowFomDetermination`), `NoShowDeterminationRecord`, `TraceEvent`.

**Engines invoked:** None.

**Policies enforced:** No-Show Detection and Determination Policy (Policy 56); No-Show Folio Financial Policy (Policy 57) — applied on Sub-path 2b auto-finalisation.

**Audit event emitted:** `NO_SHOW_CUTOFF.FIRED` (on cutoff expiry). `NO_SHOW.AUTO_FINALISED` (on Sub-path 2b timer expiry). `NO_SHOW.INQUIRY_OPENED` (on cutoff fire — surfaces the determination workflow to FOM).

**Failure / dead-letter behaviour:** Standard. DLQ alert is high-priority for entries where arrival date has passed.

---

### Worker 6 — NightAuditWorker

**Governed stage(s):** S7 (every operating night for all active in-stay entries)

**Trigger condition:** Scheduled trigger via pg-boss recurring job or staff-initiated trigger. Job type `NIGHT_AUDIT_SCHEDULE`. Must complete before the next operating day.

**Idempotency strategy:** Idempotency is enforced by `NightAuditEngine.runAudit()` itself via the hardcoded idempotency guard: before processing any entry, the engine checks whether a `FolioLine` with `chargeDate = operatingDate AND lineType = 'ROOM_CHARGE' AND nightAuditRecordId IS NOT NULL` already exists on the entry's live folio. If such a line exists, the entry is skipped for charge posting and recorded in `NightAuditRecord.entriesFullyProcessed` as already-processed. This allows a failed audit run to be re-run safely. Additionally, the worker checks whether a `NightAuditRecord` with `operatingDate = today` already exists and `runStatus = COMPLETE` — if so, the entire run is skipped.

**pg-boss job type name:** `NIGHT_AUDIT_SCHEDULE`

**Configuration parameters:**

- *Hardcoded:* Audit processes entries in sequence. Entry failure produces `PARTIAL` status — it does not halt the run. Room charge amounts derived from `Reservation.frozenRate` (commitment snapshot) — the engine never re-resolves the rate. Missing expected charges are flagged as `NightAuditAnomaly` records and never auto-posted. `NightAuditRecord` is immutable from creation — no modification after the run completes. `PARTIAL` run status is immediately escalated to FOM. AI Audit Supplement generation is a separate service call made by `NightAuditService` after the engine completes — the worker triggers both steps sequentially.
- *Configurable:* Night audit schedule trigger type (scheduled or manual) — from `ConfigurationEntry` with key `night_audit_schedule`; anomaly detection thresholds — from `ConfigurationEntry` with key `night_audit_anomaly_thresholds`; expected charges completeness rules per rate plan — from `ConfigurationEntry` with key `night_audit_expected_charges_rules`; mandatory charge types for credit ceiling monitoring — from `ConfigurationEntry` with key `night_audit_mandatory_charge_types`.

**Models read:** `Entry` (`currentStage`, `status`), `Reservation` (`frozenRate`, `frozenRatePlanId`, `frozenCheckInDate`, `frozenCheckOutDate`, `creditCeilingIfExtended`), `Folio` (`state`, `folioLines`), `FolioLine` (`chargeDate`, `lineType`, `nightAuditRecordId`), `CreditExtensionCeilingRecord` (`ceilingAmount`), `ConfigurationEntry` (audit configuration keys), `NightAuditRecord` (idempotency check)

**Models written:** `NightAuditRecord` (new record per operating date — `runStatus`, `chargeSummary`, `occupancySummary`, `anomalyCount`, `runCompletedAt`), `NightAuditAnomaly` (one per missing expected charge or audit exception), `FolioLine` (new ROOM_CHARGE line per in-stay entry — immutable from creation), `CreditCeilingThresholdEvent` (if threshold crossed during charge posting cycle), `TraceEvent`

**Engines invoked:**
- `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult` — primary audit run
- `TaxEngine.calculate(input: TaxInput): TaxResult` — per charge before folio line is written
- `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult` — per charge for ceiling-monitored entries; also after the full charge posting loop

**Policies enforced:** Night Audit Charge Posting and Completeness Policy (Policy 60); Credit Ceiling Active Monitoring Policy (Policy 45) — applied during charge posting for credit-extended entries.

**Audit event emitted:** `NIGHT_AUDIT.RUN_STARTED`, `NIGHT_AUDIT.RUN_COMPLETE` (with `runStatus`), `NIGHT_AUDIT.ENTRY_PROCESSED` (per entry), `NIGHT_AUDIT.ENTRY_SKIPPED` (idempotency skip), `NIGHT_AUDIT.ANOMALY_FLAGGED` (per anomaly). All attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** If the run fails mid-execution (after some entries have been processed), a `NightAuditRecord` with `runStatus: PARTIAL` is written. The partial record identifies `entriesNotProcessed`. Re-run is safe due to idempotency guard. DLQ entry triggers immediate FOM and operations alert — night audit failure is a financial-authority incident.

---

### Worker 7 — OTAEmailParserWorker

**Governed stage(s):** Cross-stage (operates regardless of entry stage)

**Trigger condition:** Recurring pg-boss poll job. Polls the dedicated OTA IMAP inbox at a configurable interval (default 5 minutes). Each poll cycle is a separate job execution.

**Idempotency strategy:** Before processing an inbound email, the worker checks whether a `CommunicationRecord` with `messageId = {external message ID from IMAP}` already exists. If it does, the email has already been ingested — skip and log. Idempotency is keyed on the external message ID from the IMAP provider.

**pg-boss job type name:** `OTA_EMAIL_PARSER_POLL`

**Configuration parameters:**

- *Hardcoded:* Every parsed email produces a `CommunicationRecord` regardless of AI classification outcome. If AI confidence is below the configured threshold, the email is escalated to human review (escalation record created; AI draft is not produced). Parsing success rate is tracked per OTA source in the audit trail. The AI agent may not approve its own drafts — every draft requires a `HumanDecisionRecord`. Fallback to manual processing (no AI draft produced) is always an available path and is triggered automatically on below-threshold confidence.
- *Configurable:* IMAP poll interval (from `ConfigurationEntry` with key `ota_email_poll_interval_seconds`); AI confidence threshold per intent category (from `ConfigurationEntry`); OTA inbox configuration (connection settings from environment — not from `ConfigurationEntry`); OTA parsing success rate tracking per source.

**Models read:** `CommunicationRecord` (idempotency check by `messageId`), `ConfigurationEntry` (confidence thresholds, trust level per action category), `PolicyRegistry` (AI Trust Level Policy parameters)

**Models written:** `CommunicationRecord` (new record per email — `channel = EMAIL`, `direction = INBOUND`, `messageType`, `sendStatus`, `acknowledgementStatus`), `AiDraftRecord` (where draft is produced — `intentCategory`, `confidenceScore`, `draftContent`, `status = PENDING_REVIEW`, `reviewTtlExpiresAt`), `TraceEvent`

**Engines invoked:** None directly. The AI LLM call is made through the `AIAgentService` (external LLM API per Part 1 §1.8.6), not through an engine defined in Part 4.

**Policies enforced:** AI Trust Level Policy (Policy 73); AI Authority Boundary Policy (Policy 74); AI Escalation Policy (Policy 75).

**Audit event emitted:** `OTA_EMAIL.RECEIVED` (carries `otaSource` in structured payload — enables per-OTA success rate derivation via TraceEvent aggregate queries), `OTA_EMAIL.AI_DRAFT_CREATED`, `OTA_EMAIL.ESCALATED_TO_HUMAN` (on below-threshold confidence). All attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard. Failed polls do not lose emails — the emails remain in the IMAP inbox until the next successful poll. If a poll cycle fails repeatedly, DLQ entry triggers alert. Operations team checks the IMAP connection and re-dispatches manually.

---

### Worker 8 — PaymentFollowUpWorker

**Governed stage(s):** S9

**Trigger condition:** Registered at invoice dispatch for entries with `FolioState.OUTSTANDING`. Fires at each configured reminder interval in the follow-up sequence.

**Idempotency strategy:** Before dispatching a follow-up communication, the worker checks whether the `Invoice` is still in a state requiring follow-up (`InvoiceState` must not be `RECONCILED`). It also checks whether a follow-up communication for the current interval has already been sent by inspecting `TraceEvent` records for `eventType = 'PAYMENT_FOLLOW_UP.INTERVAL_SENT'` for this entry and interval number. If already sent, skip.

**pg-boss job type name:** `PAYMENT_FOLLOW_UP`

**Configuration parameters:**

- *Hardcoded:* Follow-up communications are dispatched only for entries with `FolioState.OUTSTANDING`. Entries with `FolioState.SETTLED` are never sent follow-up communications. Outstanding balances may not be automatically closed, written off, or marked settled by this worker — write-off requires GM authority and a mandatory recorded reason. The worker escalates; it does not resolve.
- *Configurable:* Follow-up interval sequence (number of intervals, duration between intervals) — from `ConfigurationEntry` with key `payment_follow_up_intervals`; escalation path configuration (staff → FOM → GM) — from `ConfigurationEntry`; follow-up communication template — from `CommunicationTemplate`.

**Models read:** `Folio` (`state`, `entryId`), `Invoice` (`state`, `totalAmount`, `dispatchedTo`), `Entry` (`currentStage`), `GuestProfile` (contact details), `CommunicationTemplate`, `TraceEvent` (idempotency check)

**Models written:** `CommunicationRecord` (new outbound follow-up per interval), `TraceEvent` (`PAYMENT_FOLLOW_UP.INTERVAL_SENT`, `PAYMENT_FOLLOW_UP.ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Post-Stay Payment Follow-Up Policy (Policy 11).

**Audit event emitted:** `PAYMENT_FOLLOW_UP.INTERVAL_SENT` (per reminder dispatched), `PAYMENT_FOLLOW_UP.ESCALATED` (on escalation to FOM or GM), `PAYMENT_FOLLOW_UP.SEQUENCE_EXHAUSTED` (when all configured intervals have fired without settlement). All attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 9 — PostCheckoutInspectionReminderWorker

**Governed stage(s):** S8–S9

**Trigger condition:** Registered when inspection is deferred at checkout. Fires when the inspection deferral window expires without an inspection record being created.

**Idempotency strategy:** Before dispatching the reminder, the worker checks whether a post-inspection record has been created for the entry since deferral. If inspection has been completed, the worker skips. Idempotency is keyed on `entryId` and the absence of a completed inspection `TraceEvent`.

**pg-boss job type name:** `POST_CHECKOUT_INSPECTION`

**Configuration parameters:**

- *Hardcoded:* Inspection window expiry without inspection produces a FOM alert. If the window expires without a subsequent inspection, the folio consequence is one of two outcomes: charges posted as post-stay if damage is later identified, or inspection lapses permanently with a recorded lapse event. The worker surfaces both outcomes to FOM — it does not choose.
- *Configurable:* Inspection deferral window duration — from `ConfigurationEntry` with key `post_checkout_inspection_window`.

**Models read:** `Entry` (`currentStage`, `closedAt`), `Folio` (`state`), `TraceEvent` (inspection completion check)

**Models written:** `TraceEvent` (`POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED`, `POST_CHECKOUT_INSPECTION.FOM_ALERTED`)

**Engines invoked:** None.

**Policies enforced:** None directly (the inspection itself is governed by §§8.7–8.8 of Stage 8 obligations; this worker governs the SLA around that obligation).

**Audit event emitted:** `POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED`, `POST_CHECKOUT_INSPECTION.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 10 — DEFICIENTResolutionDeadlineWorker

**Governed stage(s):** S5–S7

**Trigger condition:** Registered when a DEFICIENT flag is set on an occupied or assigned room. Fires at warning threshold (approaching deadline) and at deadline breach. At warning: housekeeping reminder dispatched. At breach: FOM escalated.

**Idempotency strategy:** Before dispatching a warning or escalation, the worker reads `DeficientConditionRecord.status`. If `status = 'RESOLVED'`, the condition has been cleared — skip and log. For warning events, checks `TraceEvent` for existing `DEFICIENT_RESOLUTION.WARNING_FIRED` for this record. Idempotency is keyed on `DeficientConditionRecord.id` and event phase.

**pg-boss job type name:** `DEFICIENT_RESOLUTION_DEADLINE`

**Configuration parameters:**

- *Hardcoded:* Deadline breach always escalates to FOM. Resolved conditions are never escalated retroactively. The DEFICIENT flag is cleared only by a governed resolution event — not by the worker.
- *Configurable:* Resolution deadline duration from flag creation (from `ConfigurationEntry` with key `deficient_resolution_deadline_hours`); warning threshold offset from deadline (from `ConfigurationEntry`).

**Models read:** `DeficientConditionRecord` (`status`, `resolutionDeadline`, `roomId`), `Room` (`roomNumber`), `Entry` (`currentStage`)

**Models written:** `TraceEvent` (`DEFICIENT_RESOLUTION.WARNING_FIRED`, `DEFICIENT_RESOLUTION.DEADLINE_BREACHED`, `DEFICIENT_RESOLUTION.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** DEFICIENT Resolution Tracking Policy (Policy 50).

**Audit event emitted:** `DEFICIENT_RESOLUTION.WARNING_FIRED` (approaching deadline), `DEFICIENT_RESOLUTION.DEADLINE_BREACHED` (on breach), `DEFICIENT_RESOLUTION.FOM_ESCALATED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 11 — CommissionDueRateMissingEscalationWorker

**Governed stage(s):** S9

**Trigger condition:** Registered when a `CommissionDueRecord` is created with `status = CommissionDueStatus.RATE_MISSING`. This worker only registers when a commission-due record is produced (i.e., when a commission rate is configured on the agent profile — per §76 footnote 2). If no commission rate is configured, no commission-due record is produced and this worker never registers.

**Idempotency strategy:** Before escalating, the worker reads `CommissionDueRecord.status`. If `status = CommissionDueStatus.SETTLED` (rate was configured and commission was settled), skip. If escalation `TraceEvent` already exists for this record, skip. Idempotency is keyed on `CommissionDueRecord.id` and escalation phase.

**pg-boss job type name:** `COMMISSION_RATE_MISSING_ESCALATION`

**Configuration parameters:**

- *Hardcoded:* This worker registers only when a `CommissionDueRecord` with `RATE_MISSING` status is produced. It does not run on `PENDING` or `SETTLED` records. S9 closure is not blocked by a `RATE_MISSING` record (the seam is an activation flag, not a block) unless the entry is a group entry — per §1.9.3 group closure rules, `RATE_MISSING` on a group commission-due record does block group closure.
- *Configurable:* Resolution window duration before first escalation (from `ConfigurationEntry` with key `commission_rate_missing_resolution_window`); GM notification threshold (from `ConfigurationEntry`).

**Models read:** `CommissionDueRecord` (`status`, `agentProfileId`, `entryId`), `AgentProfile` (`commissionRate`), `Entry` (`currentStage`)

**Models written:** `TraceEvent` (`COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED`, `COMMISSION_DUE.GM_NOTIFIED`)

**Engines invoked:** None.

**Policies enforced:** Commission-Due Record Creation Policy (Policy 68).

**Audit event emitted:** `COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED` (at resolution window expiry without rate being configured), `COMMISSION_DUE.GM_NOTIFIED` (at second escalation threshold).

**Failure / dead-letter behaviour:** Standard.

---

### Worker 12 — CreditCeilingMonitoringWorker

**Governed stage(s):** S5–S8

**Trigger condition:** Registered at S3 when credit extension is approved and `CreditExtensionCeilingRecord` is created. The worker monitors threshold events during charge posting and the night audit cycle. In practice, threshold-crossing is detected by `CreditCeilingMonitorEngine.evaluate()` called from `FolioService.postCharge()` and `NightAuditService` — the worker fires to dispatch the governed notification after a `CreditCeilingThresholdEvent` record is written.

**Idempotency strategy:** Before dispatching a threshold notification, the worker reads `CreditCeilingThresholdEvent.thresholdPercentage` for the entry. If a notification `TraceEvent` for the same `(entryId, thresholdPercentage)` combination already exists, skip. Idempotency is keyed on `(entryId, thresholdPercentage)`.

**pg-boss job type name:** `CREDIT_CEILING_MONITORING`

**Configuration parameters:**

- *Hardcoded:* 75% threshold → advisory notification. 90% threshold → FOM active interruption (FOM must acknowledge before the workflow continues). 100% threshold → soft gate on non-mandatory charges. The progression sequence `75 → 90 → 100` is invariant. Threshold-crossing events are permanent records — they are not cleared when the balance subsequently decreases. The 100% soft gate cannot be bypassed by operational staff.
- *Configurable:* Threshold percentages (75%, 90%, 100% are the defaults — per credit extension ceiling thresholds configuration surface; from `ConfigurationEntry`); mandatory charge type classification (from `ConfigurationEntry` with key `night_audit_mandatory_charge_types`).

**Models read:** `CreditCeilingThresholdEvent` (`thresholdPercentage`, `balanceAtCrossing`, `ceilingRecordId`), `CreditExtensionCeilingRecord` (`ceilingAmount`, `entryId`), `Entry` (`currentStage`)

**Models written:** `TraceEvent` (`CREDIT_CEILING.ADVISORY_75`, `CREDIT_CEILING.FOM_INTERRUPTION_90`, `CREDIT_CEILING.SOFT_GATE_100`)

**Engines invoked:** `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult` — invoked transitively through `FolioService.postCharge()` and `NightAuditService`; the worker dispatches notifications based on `CreditCeilingThresholdEvent` records written as a result of engine evaluation.

**Policies enforced:** Credit Ceiling Active Monitoring Policy (Policy 45).

**Audit event emitted:** `CREDIT_CEILING.ADVISORY_75`, `CREDIT_CEILING.FOM_INTERRUPTION_90`, `CREDIT_CEILING.SOFT_GATE_100`. All attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard. 90% and 100% threshold notification failures are high-priority DLQ alerts.

---

### Worker 13 — RelocationExternalHandshakeWorker

**Governed stage(s):** S4–S5

**Trigger condition:** Registered when an OTA_CONFLICT overbooking is confirmed and a relocation decision is recorded. Fires when the OTA notification open loop exceeds the configured window without closure.

**Idempotency strategy:** Before escalating, the worker reads `OtaConflictOverbookingRecord.otaNotificationStatus` and `mitigationPlanStatus`. If both are `CLOSED`, all loops are resolved — skip. If escalation `TraceEvent` already exists for the current period, skip. Idempotency is keyed on `OtaConflictOverbookingRecord.id` and the open-loop event phase.

**pg-boss job type name:** `OTA_NOTIFICATION_OPEN_LOOP`

**Configuration parameters:**

- *Hardcoded:* `OTA_CONFLICT` trigger type is immutable — this worker never reclassifies an `OTA_CONFLICT` record as `DELIBERATE`. FOM is escalated when the configured window is exceeded. GM is notified if the loop remains open past the GM notification threshold.
- *Configurable:* Configured open-loop closure window (from `ConfigurationEntry` with key `ota_notification_open_loop_window`); GM notification threshold (from `ConfigurationEntry`).

**Models read:** `OtaConflictOverbookingRecord` (`triggerType`, `otaNotificationStatus`, `mitigationPlanStatus`, `entryId`), `Entry` (`currentStage`)

**Models written:** `TraceEvent` (`OTA_CONFLICT.LOOP_EXCEEDED`, `OTA_CONFLICT.FOM_ESCALATED`, `OTA_CONFLICT.GM_NOTIFIED`)

**Engines invoked:** None.

**Policies enforced:** Overbooking Detection and Trigger Typing Policy (Policy 41) — specifically the OTA_CONFLICT open-loop tracking obligation.

**Audit event emitted:** `OTA_CONFLICT.LOOP_EXCEEDED`, `OTA_CONFLICT.FOM_ESCALATED`, `OTA_CONFLICT.GM_NOTIFIED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 14 — VIPArrivalNotificationWorker

**Governed stage(s):** S6

**Trigger condition:** Registered at S6 commencement (check-in initiation). Fires when `GuestProfile.vipTier` is set (non-null, non-empty) at the time of check-in. The worker evaluates VIP tier at fire time — not at registration time.

**Idempotency strategy:** Before dispatching notifications, the worker checks `TraceEvent` for existing `VIP_ARRIVAL.NOTIFICATION_SENT` for this entry at this S6 commencement event. If already sent, skip. Idempotency is keyed on `(entryId, S6 commencement event timestamp)`.

**pg-boss job type name:** `VIP_ARRIVAL_NOTIFICATION`

**Configuration parameters:**

- *Hardcoded:* Notification is dispatched only for guests with a non-null `vipTier` on `GuestProfile`. Non-VIP entries do not trigger this worker (checked at registration time and re-confirmed at fire time). The notification targets configured staff roles — not all staff.
- *Configurable:* VIP tier classification (from `GuestProfile.vipTier` — set by staff at profiling time); staff roles to notify per VIP tier (from `VipNotificationRoutingConfig`); specific actor IDs to always notify (from `VipNotificationRoutingConfig.notifyActorIds`).

**Models read:** `GuestProfile` (`vipTier`), `VipNotificationRoutingConfig` (`notifyRoles`, `notifyActorIds`, `vipTier`), `Entry` (`currentStage`), `Reservation` (`frozenCheckInDate`)

**Models written:** `TraceEvent` (`VIP_ARRIVAL.NOTIFICATION_SENT` — carries `entryId`, `vipTier`, `notifiedRoles`, `notifiedActorIds`, `notifiedAt`)

**Engines invoked:** None.

**Policies enforced:** None. VIP notification is an operational convenience action, not a policy gate.

**Audit event emitted:** `VIP_ARRIVAL.NOTIFICATION_SENT`.

**Failure / dead-letter behaviour:** Standard. VIP notification failure is medium-priority — DLQ alert fires but does not block check-in progression.

---

### Worker 15 — QuotationExpiryWorker

**Governed stage(s):** S2

**Trigger condition:** Registered when a quotation is sent (`QuotationState.SENT`). Fires when the quotation validity window expires.

**Sub-behaviour — Quotation acknowledgement tracking:** The quotation acknowledgement tracker (§76 entry: "Quotation acknowledgement tracker") is handled within QuotationExpiryWorker. Before the quotation reaches its expiry timestamp, the worker fires a warning event at the approaching-expiry threshold. At this point it also checks whether the guest has acknowledged receipt of the quotation (`CommunicationRecord.acknowledgementStatus` on the outbound quotation communication). If unacknowledged, an open-loop flag is surfaced as an actionable item. If the window significantly exceeds the response window without acknowledgement, FOM is escalated. These events fire as pre-expiry phases within the same worker execution chain.

**Idempotency strategy:** Before executing expiry, the worker reads `Quotation.state`. If `state = QuotationState.EXPIRED`, `QuotationState.ACCEPTED`, or `QuotationState.SUPERSEDED`, the quotation is no longer active — skip. Idempotency is keyed on `Quotation.id`.

**pg-boss job type name:** `QUOTATION_VALIDITY`

**Configuration parameters:**

- *Hardcoded:* An expired quotation transitions to `QuotationState.EXPIRED`. An expired quotation cannot be used as the basis for S3 progression without explicit revalidation. Revalidation re-runs pricing against current state before a new quotation version is issued. Expiry is always a governed event with a permanent record.
- *Configurable:* Quotation validity window (from `ConfigurationEntry` with key `quotation_validity_window`); acknowledgement response window (from `ConfigurationEntry` with key `quotation_ack_response_window`); escalation threshold.

**Models read:** `Quotation` (`state`, `validUntil`, `sentAt`, `entryId`), `CommunicationRecord` (`acknowledgementStatus` — for ack-tracker sub-behaviour)

**Models written:** `Quotation` (`state → QuotationState.EXPIRED`, `expiredAt`), `TraceEvent` (`QUOTATION.EXPIRY_WARNING`, `QUOTATION.ACK_OPEN_LOOP_FLAGGED`, `QUOTATION.EXPIRED`, `QUOTATION.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Quotation Validity Policy (Policy 7).

**Audit event emitted:** `QUOTATION.EXPIRY_WARNING` (approaching expiry), `QUOTATION.ACK_OPEN_LOOP_FLAGGED` (unacknowledged at approaching-expiry threshold), `QUOTATION.EXPIRED` (on state transition), `QUOTATION.FOM_ESCALATED` (if ack window significantly exceeded).

**Failure / dead-letter behaviour:** Standard.

---

### Worker 16 — ProcessingLockExpiryWorker

**Governed stage(s):** Cross-stage (fires on any processing lock TTL expiry regardless of entry stage)

**Trigger condition:** Registered at lock placement (`ProcessingLockRecord` creation). Fires unconditionally at `ProcessingLockRecord.expiresAt`. No heartbeat or renewal mechanism exists — the TTL is unconditional.

**Idempotency strategy:** Before executing expiry, the worker reads `ProcessingLockRecord.status`. If `status = ProcessingLockStatus.EXPIRED` or `status = ProcessingLockStatus.RELEASED`, the lock is already resolved — skip. Idempotency is keyed on `ProcessingLockRecord.id`.

**pg-boss job type name:** `PROCESSING_LOCK_TTL`

**Configuration parameters:**

- *Hardcoded:* TTL expiry transitions `ProcessingLockRecord.status` to `ProcessingLockStatus.EXPIRED`. Expiry does not affect `InventoryClaimState` — processing locks are awareness mechanisms, not commercial holds. The operator expiry notification text is governance language, hardcoded: *"Your inventory hold has expired — please reconfirm availability before proceeding."* This text is not configurable marketing copy. Expiry event is permanently logged — silent expiry is forbidden. Reconfirmation creates a new `ProcessingLockRecord` — this worker does not handle reconfirmation.
- *Configurable:* Lock TTL per channel (email AI, WhatsApp AI, front desk, phone) and per engagement type — from `ConfigurationEntry` (lock TTL configuration surface per §70A M.7). The TTL is read from `ProcessingLockRecord.ttlSeconds` at registration time; it is not re-read at fire time.

**Models read:** `ProcessingLockRecord` (`status`, `actorId`, `inventoryReference`, `expiresAt`)

**Models written:** `ProcessingLockRecord` (`status → ProcessingLockStatus.EXPIRED`, `expiredAt`), `TraceEvent` (`PROCESSING_LOCK.EXPIRED`)

**Engines invoked:** None.

**Policies enforced:** Processing Lock TTL Policy (Policy 71).

**Audit event emitted:** `PROCESSING_LOCK.EXPIRED` — carries `lockId`, `actorId`, `inventoryReference`, `expiredAt`, `channel`. Attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard. A failed expiry that leaves the lock in `ACTIVE` state past its TTL is a data integrity issue; the lock would appear active but be commercially meaningless. DLQ alert fires; operations team manually transitions the lock to `EXPIRED` and notifies the operator.

---

### Worker 17 — VoiceNoteSLAWorker

**Governed stage(s):** Cross-stage (fires on any voice note SLA event regardless of entry stage)

**Trigger condition:** Registered when a `CommunicationRecord` with `messageType = MessageType.VOICE_NOTE` is received (`VoiceNoteRoutingService` calls `TimerEngine.register()` at receipt). Fires at SLA warning threshold (approaching SLA expiry) and at SLA breach (SLA exceeded without a `StaffListeningSummaryRecord` logged).

**Idempotency strategy:** Before dispatching SLA events, the worker checks `CommunicationRecord.voiceNoteSlaBreach` and `voiceNoteSlaBreakedAt`. If SLA breach is already recorded, skip. For warning events, checks `TraceEvent` for existing `VOICE_NOTE_SLA.WARNING_FIRED` for this record. Idempotency is keyed on `CommunicationRecord.id` and event phase.

**pg-boss job type name:** `VOICE_NOTE_SLA`

**Configuration parameters:**

- *Hardcoded:* SLA breach always escalates to FOM. AI agent is categorically blocked from processing voice note content — this is a routing-layer block, not a runtime check at the worker level. The worker does not attempt to route the voice note to AI processing under any circumstance. The SLA timer is always registered at receipt.
- *Configurable:* Voice note review SLA window (default 30 minutes during operating hours) — from `ConfigurationEntry` with key `voice_note_review_sla_window`; escalation routing for overdue voice notes (from `ConfigurationEntry`).

**Models read:** `CommunicationRecord` (`messageType`, `voiceNoteSlaBreach`, `voiceNoteSlaBreakedAt`, `voiceNoteFomEscalated`, `entryId`), `StaffListeningSummaryRecord` (existence check for completed review)

**Models written:** `CommunicationRecord` (`voiceNoteSlaBreakedAt`, `voiceNoteSlaBreach = true`, `voiceNoteFomEscalated = true`), `TraceEvent` (`VOICE_NOTE_SLA.WARNING_FIRED`, `VOICE_NOTE_SLA.BREACH_DETECTED`, `VOICE_NOTE_SLA.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Voice Note Review SLA Policy (Policy 77); Voice Note Routing Policy (Policy 76) — specifically the SLA monitoring obligation.

**Audit event emitted:** `VOICE_NOTE_SLA.WARNING_FIRED` (approaching SLA), `VOICE_NOTE_SLA.BREACH_DETECTED` (SLA exceeded), `VOICE_NOTE_SLA.FOM_ESCALATED`.

**Failure / dead-letter behaviour:** Standard. Breach notification failures are high-priority DLQ alerts.

---

### Worker 18 — AIAuditSupplementWorker

**Governed stage(s):** Nightly (runs after `NightAuditWorker` completes for the operating date)

**Trigger condition:** Dispatched by `NightAuditService` after `NightAuditEngine.runAudit()` completes and the `NightAuditRecord` is written. The worker receives the `nightAuditRecordId` in its job payload.

**Idempotency strategy:** Before generating the AI Audit Supplement, the worker checks whether an `AiAuditSupplementRecord` with `nightAuditRecordId = {id}` already exists. If it does, the supplement has already been generated — skip. Idempotency is keyed on `nightAuditRecordId`.

**pg-boss job type name:** `AI_AUDIT_SUPPLEMENT`

**Configuration parameters:**

- *Hardcoded:* One `AiAuditSupplementRecord` per `NightAuditRecord`. The supplement is immutable from creation. AI Audit Supplement generation is always a post-audit step — it never precedes the completion of the main night audit run. The engine produces structured data input; the actual AI observations are generated by the LLM API call made through `AIAgentService`. The worker does not call the engine for observation generation — observations come from the LLM.
- *Configurable:* LLM API connection configuration (Part 11 integration interface — not configurable at worker level).

**Models read:** `NightAuditRecord` (`nightAuditRecordId`, `chargeSummary`, `occupancySummary`, `anomalyCount`, `anomalies`), `AiAuditSupplementRecord` (idempotency check), `AiDraftRecord` (correction rate data for the night's communications), `HumanDecisionRecord` (edit/reject events for the night)

**Models written:** `AiAuditSupplementRecord` (new record — `nightAuditRecordId`, `aiObservations`, `confidenceLevelDistribution`, `patternDiscoveryLog`, `fomReviewStatus = 'PENDING'`), `TraceEvent` (`AI_AUDIT_SUPPLEMENT.CREATED`)

**Engines invoked:** None. The AI supplement is generated via the external LLM API through `AIAgentService` (Part 11 integration interface). The structured data input is assembled by the worker from the `NightAuditRecord` and related records.

**Policies enforced:** Night Audit Charge Posting and Completeness Policy (Policy 60) — specifically the AI Audit Supplement attachment obligation.

**Audit event emitted:** `AI_AUDIT_SUPPLEMENT.CREATED` — carries `nightAuditRecordId`, `operatingDate`, `observationCount`. `AI_AUDIT_SUPPLEMENT.SKIPPED` (idempotency skip).

**Failure / dead-letter behaviour:** Standard. A failed supplement generation does not invalidate the `NightAuditRecord` — night audit is complete without the supplement. The supplement is an enhancement. DLQ alert fires; operations team may manually re-dispatch the supplement generation job.

---

### Worker 19 — CorrectionLogAggregationWorker *(OI-014-03)*

**Governed stage(s):** Cross-stage (operates independently of entry stage)

**Trigger condition:** Recurring pg-boss job. Fires on a configurable periodic schedule (default: daily). Each cycle analyses `HumanDecisionRecord` events (edit-and-approve and reject decisions) over the configured aggregation period to compute correction rates per intent category.

**Idempotency strategy:** Before aggregating, the worker checks whether a `CorrectionRecord` for the current aggregation period (`periodFrom`, `periodTo`) and the current `intentCategory` already exists. If it does, the aggregation has already been completed for this period — skip. Idempotency is keyed on `(intentCategory, periodFrom, periodTo)`.

**pg-boss job type name:** `CORRECTION_LOG_AGGREGATION`

**Configuration parameters:**

- *Hardcoded:* Aggregation covers all intent categories present in `AiDraftRecord` records for the aggregation period. Correction rate is computed as `(edit_and_approve_count + reject_count) / total_draft_count` per intent category. `CorrectionRecord` is immutable from creation.
- *Configurable:* Aggregation period (daily by default — from `ConfigurationEntry` with key `correction_log_aggregation_period`); **correction log maximum size** — maximum number of raw `HumanDecisionRecord` entries retained in the rolling correction log before older entries are excluded from aggregation (from `ConfigurationEntry` with key `ai.correctionLog.maximumSize`). This parameter is the OI-014-03 carry-forward from §70B M.7 (Configuration Dependencies: `correction log maximum size`). If the number of decision records in the aggregation window exceeds the configured maximum, the worker processes only the most recent entries — older records fall outside the aggregation window for threshold tuning purposes.

**Models read:** `AiDraftRecord` (`intentCategory`, `status`, `confidenceScore`, `createdAt`), `HumanDecisionRecord` (`decisionType`, `aiDraftId`, `decidedAt`), `CorrectionRecord` (idempotency check by `intentCategory` + period)

**Models written:** `CorrectionRecord` (new record per intent category per period — `actorId = SYSTEM actor`, `intentCategory`, `correctionCount`, `aggregatedAt`, `periodFrom`, `periodTo`), `TraceEvent` (`CORRECTION_LOG.AGGREGATION_COMPLETE`)

**Engines invoked:** None.

**Policies enforced:** AI Trust Level Policy (Policy 73) — specifically the correction rate monitoring obligation that feeds threshold tuning inputs.

**Audit event emitted:** `CORRECTION_LOG.AGGREGATION_COMPLETE` — carries `periodFrom`, `periodTo`, `intentCategoriesProcessed`, `totalCorrectionsFound`. Attributed to `ActorLevel.SYSTEM`.

**Failure / dead-letter behaviour:** Standard. Failed aggregation is low-priority — the next scheduled run will cover the missed period (the period overlap is handled by the idempotency key). DLQ alert fires but does not require immediate remediation.

---

### Worker 20 — EntryExpiryWorker

**Governed stage(s):** S1 (primary); also fires for parked entries with expiry configured

**Trigger condition:** Registered at entry creation or unparking. Fires when the configured entry expiry timer reaches its threshold without the entry progressing past S1.

**Idempotency strategy:** Before executing expiry, the worker reads `Entry.status`. If `status = EntryStatus.EXPIRED`, `EntryStatus.CANCELLED`, or `EntryStatus.CLOSED`, the entry is already in a terminal state — skip. Idempotency is keyed on `Entry.id`.

**pg-boss job type name:** `ENTRY_EXPIRY`

**Configuration parameters:**

- *Hardcoded:* `EntryStatus.EXPIRED` is a terminal state — it cannot be reversed. Expiry is always a governed event with a permanent record. Silent expiry is forbidden.
- *Configurable:* Entry expiry threshold duration per entry type (from `ConfigurationEntry` with key `entry_expiry_threshold`); warning threshold offset (from `ConfigurationEntry`).

**Models read:** `Entry` (`status`, `currentStage`, `createdAt`, `parkedAt`)

**Models written:** `Entry` (`status → EntryStatus.EXPIRED`, `closedAt`, `closedBy = SYSTEM actor`), `TraceEvent` (`ENTRY.EXPIRY_WARNING`, `ENTRY.EXPIRED`)

**Engines invoked:** None.

**Policies enforced:** Inquiry Expiry Policy (Policy 6).

**Audit event emitted:** `ENTRY.EXPIRY_WARNING` (at warning threshold), `ENTRY.EXPIRED` (on state transition to EXPIRED).

**Failure / dead-letter behaviour:** Standard.

---

### Worker 21 — PaymentMilestoneWorker

**Governed stage(s):** S3–S7 (corporate/conference use types with milestone payment schedules)

**Trigger condition:** Registered at S3 when a milestone payment schedule is configured on the provisional folio. Fires at warning threshold (approaching milestone deadline) and at milestone breach (deadline missed without payment recorded).

**Idempotency strategy:** Before dispatching a milestone escalation, the worker checks whether the milestone payment has been recorded (`PaymentRecord` exists for this milestone amount and date range) or whether a prior escalation `TraceEvent` for this milestone already exists. If the milestone is already resolved, skip. Idempotency is keyed on `(entryId, milestoneIndex, escalation phase)`.

**pg-boss job type name:** `PAYMENT_MILESTONE`

**Configuration parameters:**

- *Hardcoded:* Milestone deadlines are fixed at S3 and recorded in the provisional folio payment schedule. A missed milestone triggers escalation per the payment milestone policy — the worker escalates; it does not adjust, waive, or reschedule the milestone.
- *Configurable:* Milestone payment schedule (configured at S3 — read from `Folio` payment schedule structure at fire time); escalation routing (from `ConfigurationEntry`); warning offset before milestone deadline (from `ConfigurationEntry` with key `payment_milestone_warning_offset`).

**Models read:** `Folio` (`state`, `entryId`, payment schedule metadata), `PaymentRecord` (milestone fulfilment check), `Entry` (`currentStage`, `useType`), `TraceEvent` (idempotency check)

**Models written:** `TraceEvent` (`PAYMENT_MILESTONE.APPROACHING_WARNING`, `PAYMENT_MILESTONE.DEADLINE_MISSED`, `PAYMENT_MILESTONE.ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Advance Payment Collection Policy (Policy 27) — specifically the milestone tracking obligation for corporate/conference engagements.

**Audit event emitted:** `PAYMENT_MILESTONE.APPROACHING_WARNING`, `PAYMENT_MILESTONE.DEADLINE_MISSED`, `PAYMENT_MILESTONE.ESCALATED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 22 — AcknowledgementWindowWorker

**Governed stage(s):** S2–S9 (cross-stage; fires on any material communication that opens an acknowledgement loop)

**Trigger condition:** Registered by `CommunicationService.send()` when an outbound communication is dispatched with a required acknowledgement (`TimerEngine.register()` is called for the `ACKNOWLEDGEMENT_WINDOW` timer type). Fires when the window expires without `AcknowledgementStatus.RECEIVED` being set on the outbound `CommunicationRecord`.

**Sub-behaviour — Confirmation acknowledgement tracker (S4):** When the timer fires for a `CommunicationRecord` at `stageContext = S4` (confirmation voucher sent), the worker treats the open loop as a confirmation acknowledgement tracker event — the consequence is an open loop requiring documented resolution at S4 exit, surfaced to FOM if the window is significantly exceeded. This sub-behaviour is handled by filtering `stageContext` within the same worker execution.

**Idempotency strategy:** Before executing the `TIMED_OUT` transition, the worker reads `CommunicationRecord.acknowledgementStatus`. If `acknowledgementStatus = AcknowledgementStatus.RECEIVED` or `acknowledgementStatus = AcknowledgementStatus.TIMED_OUT`, the loop is already resolved — skip. Idempotency is keyed on `CommunicationRecord.id`.

**pg-boss job type name:** `ACKNOWLEDGEMENT_WINDOW`

**Configuration parameters:**

- *Hardcoded:* Every governed communication has a tracked acknowledgement state — `PENDING`, `RECEIVED`, or `TIMED_OUT`. There is no communication without an acknowledgement state. `TIMED_OUT` is recorded as a flag on the communication record. Non-acknowledgement is a visible flag on the entry for the relevant stage.
- *Configurable:* Acknowledgement window per communication type (from `ConfigurationEntry` — acknowledgement window per type configuration surface); FOM escalation threshold for significantly exceeded windows (from `ConfigurationEntry`).

**Models read:** `CommunicationRecord` (`acknowledgementStatus`, `acknowledgementTimeoutAt`, `stageContext`, `entryId`)

**Models written:** `CommunicationRecord` (`acknowledgementStatus → AcknowledgementStatus.TIMED_OUT`), `TraceEvent` (`ACKNOWLEDGEMENT.WINDOW_EXPIRED`, `ACKNOWLEDGEMENT.CONFIRMATION_OPEN_LOOP` [S4 sub-behaviour], `ACKNOWLEDGEMENT.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Communication Acknowledgement Tracking Policy (Policy 52).

**Audit event emitted:** `ACKNOWLEDGEMENT.WINDOW_EXPIRED`, `ACKNOWLEDGEMENT.CONFIRMATION_OPEN_LOOP` (S4 confirmation voucher sub-behaviour), `ACKNOWLEDGEMENT.FOM_ESCALATED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 23 — RoomReadinessSLAWorker

**Governed stage(s):** S5–S6

**Trigger condition:** Registered when a room is assigned at S5 but is not yet in a ready physical state. Fires at SLA approaching threshold and at SLA breach.

**Idempotency strategy:** Before dispatching SLA events, the worker checks whether the room has transitioned to a ready state (Room `currentClaimState` progressed past assignment, or the entry has progressed to S6) since the timer was registered. If the room is ready or the entry has checked in, skip. Idempotency is keyed on `(roomId, entryId, event phase)`.

**pg-boss job type name:** `ROOM_READINESS_SLA`

**Configuration parameters:**

- *Hardcoded:* SLA breach alerts FOM with alternative room suggestions surfaced. Alternative room surfacing is not assignment — it is informational output to the FOM surface.
- *Configurable:* Room readiness SLA window (from `ConfigurationEntry` with key `room_readiness_sla_window`); warning threshold offset (from `ConfigurationEntry`).

**Models read:** `Room` (`currentClaimState`, `isDeficient`, `roomNumber`), `Entry` (`currentStage`), `Reservation` (`frozenCheckInDate`)

**Models written:** `TraceEvent` (`ROOM_READINESS_SLA.WARNING_FIRED`, `ROOM_READINESS_SLA.BREACHED`, `ROOM_READINESS_SLA.FOM_ALERTED`)

**Engines invoked:** `RoomAssignmentSuggestionEngine.suggest(input: RoomSuggestionInput): RoomSuggestionResult` — invoked to generate alternative room suggestions on SLA breach. The suggestion output is surfaced to FOM as informational content; it does not create an assignment.

**Policies enforced:** None directly. Room readiness SLA monitoring is an operational obligation; assignment and DEFICIENT governance are governed by their respective policies (Policies 48, 49).

**Audit event emitted:** `ROOM_READINESS_SLA.WARNING_FIRED`, `ROOM_READINESS_SLA.BREACHED`, `ROOM_READINESS_SLA.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 24 — HousekeepingSLAWorker

**Governed stage(s):** S8

**Trigger condition:** Registered when a room transitions to `InventoryClaimState.DEPARTED_DIRTY` at checkout. Fires at SLA approaching threshold and at SLA breach.

**Idempotency strategy:** Before dispatching SLA events, the worker checks whether the room's `currentClaimState` has already progressed past `DEPARTED_DIRTY` (e.g., to `DEPARTED_CLEAN` or a new hold state). If so, housekeeping has completed — skip. Idempotency is keyed on `(roomId, departed_dirty event timestamp, event phase)`.

**pg-boss job type name:** `HOUSEKEEPING_SLA`

**Configuration parameters:**

- *Hardcoded:* SLA breach alerts FOM. The room remains `DEPARTED_DIRTY` until housekeeping updates the physical state — the worker does not transition room state.
- *Configurable:* Housekeeping SLA window (from `ConfigurationEntry` with key `housekeeping_sla_window`); warning threshold offset (from `ConfigurationEntry`).

**Models read:** `Room` (`currentClaimState`, `roomNumber`)

**Models written:** `TraceEvent` (`HOUSEKEEPING_SLA.WARNING_FIRED`, `HOUSEKEEPING_SLA.BREACHED`, `HOUSEKEEPING_SLA.FOM_ALERTED`)

**Engines invoked:** None.

**Policies enforced:** None directly. Housekeeping SLA monitoring is an operational obligation; physical state transitions are governed by housekeeping service methods.

**Audit event emitted:** `HOUSEKEEPING_SLA.WARNING_FIRED`, `HOUSEKEEPING_SLA.BREACHED`, `HOUSEKEEPING_SLA.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 25 — HandoffAcceptanceWorker

**Governed stage(s):** S6

**Trigger condition:** Registered when H2 and H3 handoffs are created at check-in. Fires when the configured acceptance window expires without the receiving party accepting the handoff.

**Idempotency strategy:** Before dispatching alerts, the worker reads `HandoffRecord.state`. If `state = HandoffState.ACCEPTED`, `HandoffState.FULFILLED`, or `HandoffState.CLOSED`, the handoff is resolved — skip. Idempotency is keyed on `(HandoffRecord.id, event phase)`.

**pg-boss job type name:** `H2_H3_ACCEPTANCE`

**Configuration parameters:**

- *Hardcoded:* H2 and H3 are mandatory handoffs created at check-in — they cannot be omitted. `HandoffState.REJECTED` requires FOM rerouting. There is no silent rejection. Auto-fulfilment (where the sending and receiving teams are the same) records the acceptance event regardless — the audit trail is always present.
- *Configurable:* H2/H3 acceptance window (from `ConfigurationEntry` with key `handoff_acceptance_window`); escalation routing on timeout (from `ConfigurationEntry`).

**Models read:** `HandoffRecord` (`state`, `handoffType`, `toRole`, `slaDeadlineAt`, `entryId`)

**Models written:** `TraceEvent` (`HANDOFF.ACCEPTANCE_WINDOW_EXPIRED`, `HANDOFF.FOM_ALERTED`)

**Engines invoked:** None.

**Policies enforced:** Handoff Lifecycle Policy (Policy 63).

**Audit event emitted:** `HANDOFF.ACCEPTANCE_WINDOW_EXPIRED`, `HANDOFF.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 26 — CheckoutTimeWorker

**Governed stage(s):** S8

**Trigger condition:** Registered by `TimerEngine.register()` as part of the nightly timer recalculation after night audit completes (per §4.10.7). Fires when the checkout time for an in-stay entry is reached.

**Idempotency strategy:** Before dispatching checkout prompts, the worker checks whether the entry has already progressed to S8 completion (checkout event already recorded) or has been cancelled. If `Entry.currentStage ≠ S7` or S8 (i.e., checkout is already underway or complete), skip. Idempotency is keyed on `(entryId, checkout date, event phase)`.

**pg-boss job type name:** `CHECKOUT_TIME`

**Configuration parameters:**

- *Hardcoded:* Checkout time event does not block the guest — it creates an open task that must be resolved. Late checkout grace window expiry escalates to FOM. The late checkout mechanism is surfaced to front desk on checkout time fire.
- *Configurable:* Property checkout time (from `ConfigurationEntry` with key `property_checkout_time`); late checkout grace window (from `ConfigurationEntry` with key `late_checkout_grace_window`).

**Models read:** `Entry` (`currentStage`, `checkOutDate`), `Reservation` (`frozenCheckOutDate`)

**Models written:** `TraceEvent` (`CHECKOUT.TIME_REACHED`, `CHECKOUT.LATE_CHECKOUT_GRACE_EXPIRED`, `CHECKOUT.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Checkout Due Policy (Policy 10).

**Audit event emitted:** `CHECKOUT.TIME_REACHED`, `CHECKOUT.LATE_CHECKOUT_GRACE_EXPIRED`, `CHECKOUT.FOM_ESCALATED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 27 — DisputeSLAWorker

**Governed stage(s):** S7–S9

**Trigger condition:** Registered when a `DisputeRecord` is created (`DisputeState.OPEN`). Fires at time-to-first-response target (FOM must have made initial contact with the dispute) and at time-to-resolution target. For `ResolutionBundleItem` records, fires when a commitment deadline is approaching or has passed.

**Sub-behaviour — Resolution execution:** When a `ResolutionBundle` is approved, each `ResolutionBundleItem` with a `commitmentDeadline` registers a deadline timer within this worker. On deadline approach: approaching-deadline warning dispatched to FOM. On deadline breach: open-loop flagged, FOM escalated. Resolution execution deadline monitoring is handled as a phase within DisputeSLAWorker because the resolution execution lifecycle is inseparable from the parent dispute SLA.

**Idempotency strategy:** Before dispatching SLA events, the worker reads `DisputeRecord.state`. If `state = DisputeState.RESOLVED` or `DisputeState.CLOSED`, the dispute is terminal — skip. For `ResolutionBundleItem` monitoring, checks `ResolutionBundleItem.status` — if `EXECUTED` or `CANCELLED`, skip. Idempotency is keyed on `(DisputeRecord.id, SLA phase)` and `(ResolutionBundleItem.id, deadline phase)` respectively.

**pg-boss job type name:** `DISPUTE_SLA` (primary); `RESOLUTION_EXECUTION` (sub-behaviour)

**Configuration parameters:**

- *Hardcoded:* `DISPUTE_EXHAUSTED` is not a valid `DisputeState` — this worker never creates such a record or transitions a dispute to that state. Dispute SLA monitoring does not close disputes — it escalates. Only FOM (RESOLVED path) or GM (CLOSED path with recorded reason) may close a dispute.
- *Configurable:* Time-to-first-response target (from `ConfigurationEntry` with key `dispute_first_response_sla`); time-to-resolution target (from `ConfigurationEntry` with key `dispute_resolution_sla`); escalation routing per dispute category (from `ConfigurationEntry`).

**Models read:** `DisputeRecord` (`state`, `detectedAt`, `entryId`, `failureCategory`), `ResolutionBundle` (`status`), `ResolutionBundleItem` (`status`, `commitmentDeadline`)

**Models written:** `TraceEvent` (`DISPUTE_SLA.FIRST_RESPONSE_APPROACHING`, `DISPUTE_SLA.FIRST_RESPONSE_BREACHED`, `DISPUTE_SLA.RESOLUTION_SLA_APPROACHING`, `DISPUTE_SLA.RESOLUTION_SLA_BREACHED`, `RESOLUTION_EXECUTION.DEADLINE_APPROACHING`, `RESOLUTION_EXECUTION.DEADLINE_BREACHED`, `RESOLUTION_EXECUTION.FOM_ESCALATED`)

**Engines invoked:** None.

**Policies enforced:** Active Dispute Management Policy (Policy 53); Dispute Gate Stage Progression Policy (Policy 54) — the SLA monitoring creates the conditions that determine whether the gate will block.

**Audit event emitted:** `DISPUTE_SLA.FIRST_RESPONSE_APPROACHING`, `DISPUTE_SLA.FIRST_RESPONSE_BREACHED`, `DISPUTE_SLA.RESOLUTION_SLA_APPROACHING`, `DISPUTE_SLA.RESOLUTION_SLA_BREACHED`, `RESOLUTION_EXECUTION.DEADLINE_APPROACHING`, `RESOLUTION_EXECUTION.DEADLINE_BREACHED`.

**Failure / dead-letter behaviour:** Standard. Breach notification failures are high-priority DLQ alerts given the stage-gate consequence of unresolved disputes.

---

### Worker 28 — FeedbackSolicitationWorker

**Governed stage(s):** S9

**Trigger condition:** Registered at entry closure (`EntryStatus.CLOSED`). Fires after the configured post-checkout delay. Dispatches feedback solicitation through dual channel (EMAIL and WHATSAPP) and triggers online review platform encouragement.

**Idempotency strategy:** Before dispatching, the worker checks `TraceEvent` for existing `FEEDBACK.SOLICITATION_SENT` for this entry. If already sent, skip. Idempotency is keyed on `Entry.id`.

**pg-boss job type name:** `FEEDBACK_SOLICITATION`

**Configuration parameters:**

- *Hardcoded:* Feedback solicitation is dispatched only for entries with `EntryStatus.CLOSED`. Cancelled, expired, and no-show entries are not solicited. Both channels are attempted regardless of prior acknowledgement status on either channel.
- *Configurable:* Post-checkout delay duration (from `ConfigurationEntry` with key `feedback_solicitation_delay`); feedback survey templates (from `FeedbackSurveyTemplate`); online review platform links (from `ConfigurationEntry` with key `feedback_platform_links`); government portal submission configuration (from `ConfigurationEntry` with key `government_submission_config`).

**Models read:** `Entry` (`status`), `GuestProfile` (`email`, `phone`, `preferences`), `FeedbackSurveyTemplate` (active template for EMAIL and WHATSAPP channels)

**Models written:** `CommunicationRecord` (one per channel dispatched — `channel`, `direction = OUTBOUND`, `sendStatus`), `TraceEvent` (`FEEDBACK.SOLICITATION_SENT`)

**Engines invoked:** None.

**Policies enforced:** Feedback Solicitation Policy (Policy 70).

**Audit event emitted:** `FEEDBACK.SOLICITATION_SENT` — carries `entryId`, `channelsDispatched`, `surveyTemplateId`, `sentAt`.

**Failure / dead-letter behaviour:** Standard. Failed dispatch attempts retry per pg-boss backoff. DLQ entry is low-priority.

---

### Worker 29 — EquipmentReturnWorker

**Governed stage(s):** S7–S9

**Trigger condition:** Registered when equipment or assets are allocated to an event (at `EquipmentAllocation` or `AssetAllocation` creation). Fires at return deadline approaching threshold and at return deadline breach.

**Idempotency strategy:** Before dispatching alerts, the worker checks `EquipmentAllocation.returnConfirmedAt` (and `AssetAllocation.returnConfirmedAt`). If return is already confirmed, skip. Idempotency is keyed on `(allocationId, event phase)`.

**pg-boss job type name:** `EQUIPMENT_RETURN`

**Configuration parameters:**

- *Hardcoded:* Return deadline breach alerts FOM. The sourcing record is updated to reflect the overdue return status as a `TraceEvent` annotation — the worker does not directly write to `SourcingRecord` state. FOM handles sourcing record resolution.
- *Configurable:* Warning offset before return deadline (from `ConfigurationEntry` with key `equipment_return_warning_offset`); escalation routing (from `ConfigurationEntry`).

**Models read:** `EquipmentAllocation` (`returnConfirmedAt`, `toDateTime`, `entryId`, `spaceId`), `AssetAllocation` (`returnConfirmedAt`, `toDate`, `entryId`)

**Models written:** `TraceEvent` (`EQUIPMENT_RETURN.DEADLINE_APPROACHING`, `EQUIPMENT_RETURN.DEADLINE_BREACHED`, `EQUIPMENT_RETURN.FOM_ALERTED`)

**Engines invoked:** None.

**Policies enforced:** Work Order Lifecycle Policy (Policy 67) — specifically the equipment and sourcing tracking obligation at S7–S9.

**Audit event emitted:** `EQUIPMENT_RETURN.DEADLINE_APPROACHING`, `EQUIPMENT_RETURN.DEADLINE_BREACHED`, `EQUIPMENT_RETURN.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 30 — LostFoundRetentionWorker

**Governed stage(s):** S9+ (operates on `LostAndFoundRecord` records regardless of entry stage)

**Trigger condition:** Registered when a `LostAndFoundRecord` is created. Fires at retention period approaching threshold and at retention period expiry.

**Idempotency strategy:** Before executing disposal event, the worker reads `LostAndFoundRecord.returnStatus`. If `returnStatus = 'RETURNED'` or `returnStatus = 'DISPOSED'`, the item is already resolved — skip. Idempotency is keyed on `LostAndFoundRecord.id`.

**pg-boss job type name:** `LOST_FOUND_RETENTION`

**Configuration parameters:**

- *Hardcoded:* Retention period expiry triggers disposal per lost property policy. The worker does not physically dispose of the item — it records the disposal event and alerts responsible staff to execute physical disposal. Disposed items' records are retained permanently (records are never deleted).
- *Configurable:* Retention period duration (set at `LostAndFoundRecord.retentionExpiresAt` at creation time — read from `ConfigurationEntry` with key `lost_found_retention_period_days`); warning offset (from `ConfigurationEntry`).

**Models read:** `LostAndFoundRecord` (`returnStatus`, `retentionExpiresAt`, `description`, `guestProfileId`)

**Models written:** `LostAndFoundRecord` (`returnStatus → 'DISPOSED'`, `disposedAt`), `TraceEvent` (`LOST_FOUND.RETENTION_APPROACHING`, `LOST_FOUND.RETENTION_EXPIRED`, `LOST_FOUND.DISPOSAL_RECORDED`)

**Engines invoked:** None.

**Policies enforced:** None. Lost and found retention disposal follows the lost property policy as an operational obligation.

**Audit event emitted:** `LOST_FOUND.RETENTION_APPROACHING`, `LOST_FOUND.RETENTION_EXPIRED`, `LOST_FOUND.DISPOSAL_RECORDED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 31 — MaintenanceReadyAtWorker

**Governed stage(s):** Any (fires for any room in `InventoryClaimState.UNDER_MAINTENANCE` regardless of the stage of bookings associated with the room)

**Trigger condition:** Registered when a room enters `InventoryClaimState.UNDER_MAINTENANCE` and `Room.maintenanceDeadline` is set. Fires at approaching-ready-date threshold and at deadline breach.

**Idempotency strategy:** Before dispatching alerts, the worker reads `Room.isUnderMaintenance`. If `isUnderMaintenance = false` (room has been returned to service), skip. For approaching events, checks `TraceEvent` for existing `MAINTENANCE.READY_DATE_APPROACHING` for this room and maintenance instance. Idempotency is keyed on `(roomId, maintenanceDeadline, event phase)`.

**pg-boss job type name:** `MAINTENANCE_EXPECTED_READY_AT`

**Configuration parameters:**

- *Hardcoded:* Deadline breach alerts FOM with conflict detection on bookings affected by the maintenance delay. Conflict detection identifies entries in `InventoryClaimState.COMMITTED_HELD` or `CONFIRMED` for the affected room that now fall within the extended maintenance period. The worker surfaces conflicts as informational output — it does not cancel or re-route affected bookings.
- *Configurable:* Warning offset before maintenance ready date (from `ConfigurationEntry` with key `maintenance_ready_at_warning_offset`).

**Models read:** `Room` (`isUnderMaintenance`, `maintenanceDeadline`, `currentClaimState`, `roomNumber`), `CommittedHold` (conflict check — entries held for this room), `Reservation` (conflict check — confirmed entries for this room)

**Models written:** `TraceEvent` (`MAINTENANCE.READY_DATE_APPROACHING`, `MAINTENANCE.READY_DATE_BREACHED`, `MAINTENANCE.FOM_ALERTED`, `MAINTENANCE.CONFLICT_DETECTED`)

**Engines invoked:** None.

**Policies enforced:** None directly. Maintenance state governance is an operational room-management obligation.

**Audit event emitted:** `MAINTENANCE.READY_DATE_APPROACHING`, `MAINTENANCE.READY_DATE_BREACHED`, `MAINTENANCE.FOM_ALERTED`, `MAINTENANCE.CONFLICT_DETECTED` (per affected booking identified).

**Failure / dead-letter behaviour:** Standard.

---

### Worker 32 — BlockedRoomUnblockWorker

**Governed stage(s):** Any (fires for any room in `Room.isBlocked = true` with an unblock date configured)

**Trigger condition:** Registered when a room is set to `isBlocked = true` and an unblock date is configured. Fires at approaching-unblock-date threshold and when the unblock date passes.

**Idempotency strategy:** Before dispatching alerts, the worker reads `Room.isBlocked`. If `isBlocked = false`, the room has already been unblocked — skip. Idempotency is keyed on `(roomId, unblock event timestamp, event phase)`.

**pg-boss job type name:** `BLOCKED_ROOM_UNBLOCK_DATE`

**Configuration parameters:**

- *Hardcoded:* Unblock date passage alerts FOM. The worker does not automatically unblock the room — unblocking requires a governed unblock event with actor attribution. The alert informs FOM that the configured unblock date has passed and the room is available for return to service pending a governed unblock action.
- *Configurable:* Warning offset before unblock date (from `ConfigurationEntry` with key `blocked_room_unblock_warning_offset`).

**Models read:** `Room` (`isBlocked`, `blockedReason`, `roomNumber`)

**Models written:** `TraceEvent` (`BLOCKED_ROOM.UNBLOCK_DATE_APPROACHING`, `BLOCKED_ROOM.UNBLOCK_DATE_PASSED`, `BLOCKED_ROOM.FOM_ALERTED`)

**Engines invoked:** None.

**Policies enforced:** None directly. Room blocking and unblocking governance is an operational room-management obligation.

**Audit event emitted:** `BLOCKED_ROOM.UNBLOCK_DATE_APPROACHING`, `BLOCKED_ROOM.UNBLOCK_DATE_PASSED`, `BLOCKED_ROOM.FOM_ALERTED`.

**Failure / dead-letter behaviour:** Standard.

---

### Worker 33 — FOMOverrideFrequencyWorker

**Governed stage(s):** S8

**Trigger condition:** Registered with a rolling-period schedule (configurable default: 30 days). On each cycle, the worker counts FOM override events (`DisputeGateOverrideRecord` records) within the rolling window and compares against the configured threshold.

**Idempotency strategy:** Before dispatching a GM ambient awareness notice, the worker checks `TraceEvent` for existing `FOM_OVERRIDE_FREQUENCY.NOTICE_SENT` within the current rolling window. If a notice has already been dispatched for this window, skip. Idempotency is keyed on `(rolling window start date)`.

**pg-boss job type name:** `FOM_OVERRIDE_FREQUENCY_WINDOW`

**Configuration parameters:**

- *Hardcoded:* The notice is ambient awareness — it does not block FOM from performing future overrides. It does not create a disciplinary record. GM receives the notice for pattern awareness only.
- *Configurable:* Rolling window duration (configurable default 30 days — from `ConfigurationEntry` with key `fom_override_frequency_window_days`); override frequency threshold (from `ConfigurationEntry` with key `dispute_fom_override_max_frequency`).

**Models read:** `DisputeGateOverrideRecord` (`actorId`, `overrideAt`, `targetStage`) — filtered to FOM actor level within the rolling window

**Models written:** `TraceEvent` (`FOM_OVERRIDE_FREQUENCY.THRESHOLD_EXCEEDED`, `FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT`)

**Engines invoked:** None.

**Policies enforced:** None directly. Override frequency monitoring is an operational governance obligation derived from the rolling-period configuration in §76.

**Audit event emitted:** `FOM_OVERRIDE_FREQUENCY.THRESHOLD_EXCEEDED`, `FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT`.

**Failure / dead-letter behaviour:** Standard. Low-priority DLQ.

---

## Worker Catalogue Summary

| # | Worker Name | Stage(s) | pg-boss Job Type | Primary Trigger |
|---|---|---|---|---|
| 1 | StageDwellMonitor | S1–S9 | `STAGE_DWELL_MONITOR` | Entry enters stage |
| 2 | SpeculativeHoldExpiryWorker | S2 | `SPECULATIVE_HOLD_EXPIRY` | Speculative hold TTL expiry |
| 3 | CommittedHoldExpiryWorker | S3–S4 | `COMMITTED_HOLD_EXPIRY` | Committed hold TTL expiry |
| 4 | PreArrivalWindowActivationWorker | S4→S5 | `PRE_ARRIVAL_COUNTDOWN` | Pre-arrival window opens |
| 5 | NoShowCutoffWorker | S5 | `NO_SHOW_CUTOFF` | No-show cutoff expiry |
| 6 | NightAuditWorker | S7 | `NIGHT_AUDIT_SCHEDULE` | Scheduled nightly |
| 7 | OTAEmailParserWorker | Cross-stage | `OTA_EMAIL_PARSER_POLL` | IMAP poll (default 5 min) |
| 8 | PaymentFollowUpWorker | S9 | `PAYMENT_FOLLOW_UP` | Outstanding invoice; interval sequence |
| 9 | PostCheckoutInspectionReminderWorker | S8–S9 | `POST_CHECKOUT_INSPECTION` | Inspection window expiry |
| 10 | DEFICIENTResolutionDeadlineWorker | S5–S7 | `DEFICIENT_RESOLUTION_DEADLINE` | DEFICIENT deadline approach / breach |
| 11 | CommissionDueRateMissingEscalationWorker | S9 | `COMMISSION_RATE_MISSING_ESCALATION` | RATE_MISSING resolution window expiry |
| 12 | CreditCeilingMonitoringWorker | S5–S8 | `CREDIT_CEILING_MONITORING` | Threshold event from charge posting or night audit |
| 13 | RelocationExternalHandshakeWorker | S4–S5 | `OTA_NOTIFICATION_OPEN_LOOP` | OTA_CONFLICT open loop exceeds window |
| 14 | VIPArrivalNotificationWorker | S6 | `VIP_ARRIVAL_NOTIFICATION` | S6 commencement for VIP-tier guest |
| 15 | QuotationExpiryWorker | S2 | `QUOTATION_VALIDITY` | Quotation validity window expiry |
| 16 | ProcessingLockExpiryWorker | Cross-stage | `PROCESSING_LOCK_TTL` | Hard TTL expiry |
| 17 | VoiceNoteSLAWorker | Cross-stage | `VOICE_NOTE_SLA` | Voice note SLA approach / breach |
| 18 | AIAuditSupplementWorker | Nightly | `AI_AUDIT_SUPPLEMENT` | Post-NightAuditWorker completion |
| 19 | CorrectionLogAggregationWorker | Cross-stage | `CORRECTION_LOG_AGGREGATION` | Periodic (configurable schedule) |
| 20 | EntryExpiryWorker | S1 | `ENTRY_EXPIRY` | Entry expiry timer |
| 21 | PaymentMilestoneWorker | S3–S7 | `PAYMENT_MILESTONE` | Milestone deadline approach / breach |
| 22 | AcknowledgementWindowWorker | S2–S9 | `ACKNOWLEDGEMENT_WINDOW` | Acknowledgement window expiry |
| 23 | RoomReadinessSLAWorker | S5–S6 | `ROOM_READINESS_SLA` | Room readiness SLA approach / breach |
| 24 | HousekeepingSLAWorker | S8 | `HOUSEKEEPING_SLA` | Housekeeping SLA approach / breach |
| 25 | HandoffAcceptanceWorker | S6 | `H2_H3_ACCEPTANCE` | H2/H3 acceptance window expiry |
| 26 | CheckoutTimeWorker | S8 | `CHECKOUT_TIME` | Checkout time reached |
| 27 | DisputeSLAWorker | S7–S9 | `DISPUTE_SLA` | Dispute SLA milestones |
| 28 | FeedbackSolicitationWorker | S9 | `FEEDBACK_SOLICITATION` | Post-checkout delay expired |
| 29 | EquipmentReturnWorker | S7–S9 | `EQUIPMENT_RETURN` | Return deadline approach / breach |
| 30 | LostFoundRetentionWorker | S9+ | `LOST_FOUND_RETENTION` | Retention period approach / expiry |
| 31 | MaintenanceReadyAtWorker | Any | `MAINTENANCE_EXPECTED_READY_AT` | Maintenance ready date approach / breach |
| 32 | BlockedRoomUnblockWorker | Any | `BLOCKED_ROOM_UNBLOCK_DATE` | Unblock date approach / passage |
| 33 | FOMOverrideFrequencyWorker | S8 | `FOM_OVERRIDE_FREQUENCY_WINDOW` | Rolling-period cycle |

**Sub-behaviours (not standalone) — documented within parent workers:**

| Sub-behaviour | Parent Worker | Justification |
|---|---|---|
| Availability staleness | StageDwellMonitor (W1) | Same entry, same monitoring context |
| Quotation acknowledgement tracker | QuotationExpiryWorker (W15) | Same entity, same timer chain |
| Confirmation acknowledgement tracker | AcknowledgementWindowWorker (W22) | Same pattern, stageContext filter |
| AWAITING_WRITTEN_CONFIRMATION | NoShowCutoffWorker (W5) | No-show lifecycle continuation |
| Resolution execution deadline | DisputeSLAWorker (W27) | Inseparable from parent dispute SLA |

---

## Gate 8 Clarification Log

All three items raised at draft time have been deliberated and closed in the Gate 8 review session.

| ID | Section | Resolution | Authority |
|---|---|---|---|
| G8-001 | §8.2 — all workers | **Closed — false gap.** The canonical `actorId` value for all worker-attributed records is the string `"SYSTEM"`, as defined in Part 1 §1.6.4 actor level identifier column (`L0 / SYSTEM`). No new decision required. All worker entries in this part that reference the system actor use `"SYSTEM"` as the `actorId` value. | Part 1 §1.6.4 — declared Gate 8 source |
| G8-002 | §8.2 / W19 CorrectionLogAggregationWorker | **Closed — Part 2 gap identified.** The configKey `ai.correctionLog.maximumSize` is confirmed as the canonical key name, following the dot-notation convention of the Part 2 §2.17.3 configuration key table. The key does not appear in Part 2 §2.17.3 — this is a Part 2 gap to be addressed at the next Part 2 amendment pass. The key name is locked for Part 8 purposes. See Backfill Registry entry P4. | Architect deliberation — Gate 8 review session |
| G8-003 | §8.2 / W7 OTAEmailParserWorker | **Closed — TraceEvent query is sufficient.** Per-OTA parsing success rate is tracked via `TraceEvent` records emitted by OTAEmailParserWorker, with `otaSource` carried in the structured `payload` field. No dedicated aggregate model is required. The Canon phrase "tracked per OTA" establishes a monitoring obligation, not a storage shape mandate. Success rate is derivable from TraceEvent aggregate queries on `eventType = 'OTA_EMAIL.RECEIVED'` filtered by `payload.otaSource`. | Architect deliberation — Gate 8 review session |

## Backfill Registry

Changes required to prior parts as a result of Gate 8 deliberations. To be applied in a dedicated backfill pass — nothing in this registry is locked until the Architect confirms the backfill.

| # | Target Document | Location | Change Required | Trigger |
|---|---|---|---|---|
| P4 | DEV-SPEC-001-Part2.md | §2.17.3 Configuration Keys table | Add row: `ai.correctionLog.maximumSize` / All / Integer / Maximum number of correction log entries analysed per aggregation cycle for AI confidence threshold tuning | G8-002 resolution — key was not registered at Gate 2 because §70B was not a declared Gate 2 source |

---

*End of DEV-SPEC-001-Part8.md*
*Gate 8 — Workers*
*Prepared by: Claude (AI Architectural Partner)*
*Date: 08 April 2026*
*Locked by: Dhendup Cheten, Architect, Fuzzy Automation*
*Lock authority: MOM-ARCH-2026-016*
