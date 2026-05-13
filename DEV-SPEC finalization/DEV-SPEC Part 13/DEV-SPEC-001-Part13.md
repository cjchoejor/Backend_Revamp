# LEGPHEL PMS — DEV-SPEC-001
# Part 13 — Acceptance Gates and Appendices A–D
# §13.1 through §13.9 + Appendices A–D

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 13 — Acceptance Gates and Appendices A–D |
| Version | 1.0-DRAFT |
| Date | 08 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§13.1–13.9, Appendices A–D); Canon_Block11 (§71, §72, §74, §76, §76A, §81, §82); CANON-V2.3-CHANGESET.md (REV-B11-V23-12); DEV-SPEC-001-Part2.md (§2.1); DEV-SPEC-001-Part3.md (§§3.1–3.2, gate summary); DEV-SPEC-001-Part4.md (§4.1, gate summary); DEV-SPEC-001-Part5.md (§5.2.34); DEV-SPEC-001-Part6.md (§§6.1–6.2); DEV-SPEC-001-Part8.md (§§8.1–8.2 header); DEV-SPEC-001-Part9.md (§9.1); DEV-SPEC-001-Part11.md (§11.1) |

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 13 — Acceptance Gates and Appendices A–D (Final Gate) |
| Sections covered | §13.1 through §13.9; Appendices A–D |
| Nature | Verification surface — all assertions derived from Parts 2–12 and their Canon sources |
| Previous gate | Gate 12 — Admin Console Configuration Surfaces |
| Status | DRAFT — nothing is locked until Architect confirms |

---

## Gate 13 Source Declaration

The following sources were loaded for this gate:

| Source | Purpose |
|---|---|
| DEV-SPEC-001_ToC_FINAL.md §§13.1–13.9, Appendices A–D | Content requirements for all gate sections and appendices |
| Canon Block 11 §71 | Record mutation rules — Schema Gate (§13.2) assertion derivation |
| Canon Block 11 §72 | Stage-to-policy matrix — Policy Gate (§13.5) assertion derivation |
| Canon Block 11 §74 | Stage-to-record matrix — Schema Gate (§13.2) record type completeness |
| Canon Block 11 §76 | Stage-to-timer/worker matrix — Worker Gate (§13.7) assertion derivation |
| Canon Block 11 §76A | Stage Transition Matrix — State Machine Gate (§13.3) assertion derivation |
| Canon Block 11 §81 | Reporting Outputs Catalogue — Appendix D primary source |
| Canon Block 11 §82 | Realisation obligations — Service Gate (§13.6) assertion derivation |
| CANON-V2.3-CHANGESET.md REV-B11-V23-12 | GM dispute gate override report — v2.3 addition to §81; Appendix D |
| DEV-SPEC-001-Part2.md §2.1 | Schema audit field declarations; NOT NULL constraints; enum values |
| DEV-SPEC-001-Part3.md §3.1–§3.2 + gate summary | State machine design principles; gate completeness statement |
| DEV-SPEC-001-Part4.md §4.1 + gate completeness statement | Engine design principles; 12-engine completeness statement |
| DEV-SPEC-001-Part5.md §5.2.34 | Policy Catalogue Summary — authoritative 77-policy list |
| DEV-SPEC-001-Part6.md §§6.1–6.2 | Service design principles; transaction management doctrine |
| DEV-SPEC-001-Part8.md §§8.1–8.2 header | Worker design principles; catalogue header |
| DEV-SPEC-001-Part9.md §9.1 | Controller design principles; response envelope standard |
| DEV-SPEC-001-Part11.md §11.1 | Integration design principles; interface abstraction doctrine |

---

## §13.1 — Acceptance Gate Philosophy

Three governing rules, stated as implementation requirements, apply to every acceptance gate in this part.

### 13.1.1 A Gate Is a Testable Assertion

A gate is a testable assertion, not a review opinion. Each gate assertion in this part is expressible as a pass/fail check against the codebase. If a gate assertion cannot be expressed as a unit test, integration test, or verification script against the codebase, the assertion is not a gate — it is a note. Gate assertions that are notes must be rewritten as tests before they may be treated as acceptance criteria.

The form of a gate assertion is: given a defined input or codebase state, the verification produces a binary outcome — pass or fail. There is no partial pass. There is no "substantially compliant." Either the assertion holds against the entire codebase in scope, or it fails and the failure is recorded with the specific location and item that caused it.

### 13.1.2 Bypass of a Gate Is an Architectural Failure

A gate that has been skipped, simulated, or satisfied by assertion rather than by test constitutes an architectural failure for the delivery unit it governs. Gate results are recorded, not assumed. A delivery that has not been verified against the gate that governs it is not a completed delivery.

The permitted responses to a failing gate are: fix the defect and re-run the gate; or escalate to the Architect for a deliberated exception with a recorded rationale and a documented remediation commitment. There is no path by which a gate is declared passing while the assertion that defines it is known to be failing.

### 13.1.3 Gate Sequence Is Dependency-Driven

The gates in this part are ordered by dependency. A gate that depends on a passing upstream gate may not be declared passing while the upstream gate is failing.

The dependency order is:

1. **Schema Gate (§13.2)** — no dependency on other gates; this gate is the foundation for all others.
2. **State Machine Gate (§13.3)** — depends on Schema Gate. State machines are implemented against schema models. A schema that is failing means state machine model references are unverified.
3. **Engine Gate (§13.4)** — depends on Schema Gate. Engines receive schema-typed inputs.
4. **Policy Gate (§13.5)** — depends on Schema Gate and Engine Gate. Policies invoke engines and act on schema-typed records.
5. **Service Gate (§13.6)** — depends on Schema Gate, Engine Gate, and Policy Gate. Services orchestrate across all three.
6. **Worker Gate (§13.7)** — depends on Schema Gate and Service Gate. Workers call services against schema-persisted records.
7. **Controller Gate (§13.8)** — depends on Service Gate. Controllers invoke services and return typed responses.
8. **Integration Gate (§13.9)** — depends on Service Gate. Integration interfaces are called by services and workers.

No gate may be declared passing while a gate it depends on is failing.

---

## §13.2 — Schema Gate

The Schema Gate verifies that the Prisma schema defined in Part 2 correctly represents every record type required by the stage-to-record matrix, enforces all mandatory constraints, and supports every operation permitted per stage. All six assertions must pass for the Schema Gate to be declared passing.

### 13.2.1 Assertion 1 — All Record Types Present

**What this assertion checks:** Every record type listed in the stage-to-record matrix (Part 2 §2.1.3 derivation reference, sourced from the authoritative matrix) has a corresponding Prisma model definition in the Part 2 schema.

**Record types that must be present as Prisma models:** Inquiry, Entry, Segment, AvailabilityConfiguration, Quotation, SpeculativeHold, CommittedHold, Reservation, Folio (with status variants covering provisional, live, and NO_SHOW_CLOSED), Invoice, PaymentRecord, CreditNote, CommercialAdjustmentEntry, CommissionDueRecord, CreditExtensionCeilingRecord, CreditCeilingThresholdEvent, DeficientConditionRecord, OtaConflictOverbookingRecord, NoShowDeterminationRecord, VIPArrivalNotificationEvent, WorkOrder, WorkOrderToDoItem, DisputeRecord, ServiceRecoveryRecord, HandoffRecord, CommunicationRecord, GuestProfile, SpaceAllocation, EquipmentAllocation, IncidentRecord, NightAuditRecord, ProcessingLockRecord (v2.4 §70A), AiDraftRecord (v2.4 §70B), VoiceNoteRecord (v2.4 §70C), DisputeGateOverrideRecord (v2.3), SessionEventRecord (v2.5).

**Why it matters:** A missing model means any service, state machine, or worker that operates on that record type has no schema anchor. Compile-time type errors will occur at best; silent runtime failures at worst.

**What constitutes a failure:** Any record type in the list above that cannot be located as a Prisma model definition (`model RecordName { ... }`) in the schema is a Schema Gate failure. The failure is reported as: record type name, stage(s) at which it is created per the matrix, and which Part 6 service is responsible for creating it.

**Verification method:** Enumerate every model name from the list above. For each name, perform a direct string search for `model <RecordName>` in the compiled schema file. Every name must produce a match.

### 13.2.2 Assertion 2 — NOT NULL on All Audit Fields

**What this assertion checks:** Every model that carries audit fields — specifically `actorId`, `entityId`, `operation`, `timestamp`, and their structural equivalents on `TraceEvent` and any model-specific audit record — has those fields declared without the nullable `?` marker, enforcing `NOT NULL` at the database constraint level.

**Why it matters:** A trace event row with a null actor is a structural defect, not a recoverable data problem. An audit trail that permits null actors cannot be used for point-in-time reconstruction or for governance reporting. The NOT NULL constraint is the only mechanism that guarantees audit field completeness without relying on service-layer enforcement alone.

**What constitutes a failure:** Any field in `TraceEvent`, `AuditEvent`, or equivalent audit record model that is declared with `?` nullable marker on `actorId`, `entityId`, `operation`, or `timestamp` is a Schema Gate failure. The failure is reported as: model name, field name, and the NOT NULL obligation it violates.

**Verification method:** In the compiled schema file, locate every model whose name contains "Event", "Trace", "Audit", or "Log", or whose purpose is explicitly audit or event recording. For each such model, inspect every field in the set {actorId, entityId, operation, timestamp} or equivalent. Any field with a `?` suffix is a failure.

### 13.2.3 Assertion 3 — Mutation Rules Derivable from Schema

**What this assertion checks:** For each record type that is immutable from creation per the mutation rules, the schema must not expose a direct update path that would permit general mutation of that record.

**Immutable-from-creation record types and the schema constraint required:**

| Record Type | Mutation Rule | Required Schema Constraint |
|---|---|---|
| PaymentRecord | Not editable; not amendable; immutable from creation | No `updatedAt` field; no writable status field that permits general mutation |
| CommissionDueRecord | Not editable; immutable from creation | No `updatedAt` field; no editable fields after CREATE |
| CreditExtensionCeilingRecord | Not editable; immutable from creation | No `updatedAt` field; original record preserved when ceiling revised |
| NoShowDeterminationRecord | Not editable; immutable from creation | No `updatedAt` field; no status field allowing mutation |
| VIPArrivalNotificationEvent | Not editable; immutable from creation | No `updatedAt` field |
| SessionEventRecord | Not editable; immutable from creation | No `updatedAt` field |
| Invoice (after dispatch) | Not editable after dispatch; corrections via credit note | `dispatchedAt` field present; status field sealed at dispatch |
| Folio (NO_SHOW_CLOSED) | Not editable after creation in this state | Status field has no transition out of NO_SHOW_CLOSED |
| CommunicationRecord | Not editable; corrections require new communication | No `updatedAt` field; no writable content fields after CREATE |
| NightAuditRecord | Not editable; post-audit corrections are new-date entries | No `updatedAt` field |
| CreditCeilingThresholdEvent | Not editable | No `updatedAt` field |

**Why it matters:** Mutation rules that are enforced only at the service layer can be bypassed by direct Prisma client calls, by workers operating outside the normal service chain, or by database-level administrative access. Schema-level enforcement provides a structural guarantee that survives service-layer evolution.

**What constitutes a failure:** An immutable-from-creation record type that has an `updatedAt @updatedAt` field in its Prisma model definition, or a writable status field that permits general record mutation, is a Schema Gate failure for this assertion.

**Verification method:** For each record type in the table above, inspect the Prisma model definition. Confirm absence of `updatedAt @updatedAt`. For models with a status field, confirm that the status enum has no transition values that would permit general mutation (only terminal or append states are permitted).

### 13.2.4 Assertion 4 — Stage-to-Record Matrix Operations Supported

**What this assertion checks:** For each non-empty cell in the stage-to-record matrix (C / R / U / Close / Seal per stage per record type), the schema must support that operation structurally.

**Requirements per operation type:**

- **Create (C):** The model must exist and must have all required fields for the creating stage with appropriate defaults or non-nullable constraints. A required field with no default and no `@default()` attribute cannot be created without explicitly supplying a value — the schema must reflect this constraint correctly.
- **Update (U):** The model must have at least one field that is structurally writable for the governed update operations at that stage. "Governed write" means the field is mutable in the Prisma schema (not declared as auto-generated or system-set-only).
- **Close / terminal state (Close):** The model must have a status or state field with a terminal value (e.g., `CLOSED`, `EXPIRED`, `CANCELLED`, `RESOLVED`) corresponding to the terminal transition for that record type.
- **Seal (Seal):** The model must have a mechanism to record the sealed state — either a boolean `isSealed` field, a sealed status enum value, or the absence of any writable fields after the sealing event.

**Why it matters:** A schema that cannot support the operation a stage requires forces service-layer workarounds that circumvent the stated architecture. Service-layer workarounds are not visible to the Schema Gate and therefore cannot be audited.

**What constitutes a failure:** A non-empty matrix cell whose operation cannot be structurally supported by the current schema model definition is a Schema Gate failure. The failure is reported as: stage, record type, operation type, and the structural gap in the model.

**Verification method:** For each non-empty cell in the stage-to-record matrix, confirm the corresponding structural requirement as listed above against the Part 2 Prisma model definitions.

### 13.2.5 Assertion 5 — Clean Migration

**What this assertion checks:** Running `prisma migrate dev` against the schema as defined in Part 2, from a clean database state, produces a migration with no errors and no conflicts.

**Why it matters:** A schema that cannot produce a clean migration is not a deployable schema. No downstream gate assertion can be verified against a schema that fails at the migration level.

**What constitutes a failure:** Any error output from `prisma migrate dev` — including: type validation errors, relation field mismatches, missing relation scalar fields, duplicate model names, undefined enum values, or any other Prisma schema validation failure — is a Schema Gate failure for this assertion. A migration that produces warnings only (not errors) is not a failure; warnings must be documented.

**Verification method:** Execute `prisma migrate dev --name acceptance-gate-schema-check` against the Part 2 schema on a clean PostgreSQL database. Inspect the output for any line prefixed with `Error:`. Zero errors = pass.

### 13.2.6 Assertion 6 — G3-001 Gap Verified (NoShowDeterminationRecord)

**What this assertion checks:** The `NoShowDeterminationRecord` Prisma model is confirmed present in the Part 2 schema. This model was flagged as potentially absent in the Gate 3 Category 1 clarification request G3-001.

**Why it matters:** The No-Show Determination state machine (Part 3 §3.16) depends on this model as its schema anchor. The no-show worker (Part 8) creates records of this type. Its absence means the no-show determination pathway — from the S5 no-show cutoff through FOM determination to folio closure — has no persisted determination record. This is a functional gap, not a cosmetic one.

**What constitutes a failure:** If `model NoShowDeterminationRecord` cannot be located in the Part 2 schema, this assertion fails. The Schema Gate may not be declared passing until the model is added to the schema and a clean migration is produced. This is a blocking gap requiring a schema addition before Gate 13 can be certified.

**Verification method:** Perform a direct string search for `model NoShowDeterminationRecord` in the compiled Part 2 schema file. A match constitutes a pass for this assertion. Absence constitutes a failure; a schema backfill is required and must be recorded in the Backfill Registry.

---

## §13.3 — State Machine Gate

The State Machine Gate verifies that all seventeen state machines are implemented correctly, that all transitions are testable, that the stage transition matrix is fully covered by implemented guards, and that all five transition guards are enforced on every transition. All four assertions must pass for the State Machine Gate to be declared passing.

### 13.3.1 Assertion 1 — All 17 State Machines Present

**What this assertion checks:** The seventeen state machines defined in Part 3 §§3.2–3.17 (including the §3.11.4 VOICE_NOTE sub-type state machine, counted separately in the Part 3 self-declaration as the 17th machine) are all present as implemented state machine modules.

**The 17 state machines and their primary models:**

| # | Section | State Machine | Primary Model |
|---|---|---|---|
| 1 | §3.2 | Entry Lifecycle | `Entry` |
| 2 | §3.3 | Folio | `Folio` |
| 3 | §3.4 | Dispute | `DisputeRecord` |
| 4 | §3.5 | Hold (Speculative and Committed) | `SpeculativeHold`, `CommittedHold` |
| 5 | §3.6 | Inventory Claim | `Room` (`currentClaimState`), `RoomClaimStateEvent` |
| 6 | §3.7 | Room Physical | `Room` (physical state fields) |
| 7 | §3.8 | Space Physical | `Space` |
| 8 | §3.9 | Handoff | `HandoffRecord` |
| 9 | §3.10 | Invoice | `Invoice` |
| 10 | §3.11 | Communication Record (Standard) | `CommunicationRecord` |
| 11 | §3.11.4 | Communication Record (VOICE_NOTE sub-type) | `CommunicationRecord` (voiceNote variant) |
| 12 | §3.12 | Work Order / To-Do | `WorkOrder`, `WorkOrderToDoItem` |
| 13 | §3.13 | AI Draft | `AiDraftRecord` |
| 14 | §3.14 | Quotation | `Quotation` |
| 15 | §3.15 | DEFICIENT Condition | `DeficientConditionRecord` |
| 16 | §3.16 | No-Show Determination | `Folio` (closure path), `NoShowDeterminationRecord` |
| 17 | §3.17 | ProcessingLock | `ProcessingLockRecord` |

**Why it matters:** An absent state machine module means the governed entity has no enforcement point for its lifecycle transitions. Service code operating on that entity without a state machine guard is unconstrained — any state can be written at any time.

**What constitutes a failure:** Any state machine in the table above that does not correspond to an implemented module with named states, named transitions, and named guard functions is a State Machine Gate failure. The failure is reported as: state machine name, corresponding Part 3 section, and the missing implementation artifact.

**Verification method:** For each row in the table above, locate the corresponding state machine module in the codebase. Confirm that the module exports: (a) a named states object or enum, (b) a named transitions object or set of transition functions, (c) a set of guard functions with names corresponding to the transition conditions declared in Part 3. All three must be present for the machine to be counted as implemented.

### 13.3.2 Assertion 2 — Transitions Testable in Both Directions

**What this assertion checks:** For every named transition in every state machine, the transition is testable in both directions:

- **(a) Satisfied path:** Calling the transition function with all guards satisfied produces a successful state change on the governing Prisma model.
- **(b) Unsatisfied path:** Calling the transition function with any single guard unsatisfied — with all other guards satisfied — produces a typed `StageGateBlockedError` identifying the specific unsatisfied guard.

**Why it matters:** A transition that only fails with a generic error or an uncaught exception is not a governed transition — it is an uncontrolled failure. A `StageGateBlockedError` identifies what was missing, who would need to supply it, and what the escalation path is. This is the structured rejection path that makes the audit trail interpretable.

**What constitutes a failure:** A transition implementation that: (i) silently ignores a failed guard and proceeds with the state change, (ii) returns a generic `Error` or `undefined` instead of a typed `StageGateBlockedError`, or (iii) throws an unhandled exception on guard failure, is a State Machine Gate failure. The failure is reported as: state machine name, transition name, and the direction in which the test fails.

**Verification method:** For each transition in each state machine, write or execute a test that: (a) constructs a state with all guards satisfied and confirms a successful state change; (b) for each guard in the transition, constructs a state with that single guard unsatisfied and confirms a `StageGateBlockedError` identifying that guard by name. Every transition must pass both assertions.

### 13.3.3 Assertion 3 — Stage Transition Matrix Coverage Complete

**What this assertion checks:** Every transition row in the Stage Transition Matrix (Forward Transitions, Auto-Fulfilment Transitions, Re-Entry Transitions, Terminal Transitions) has a corresponding guard implemented in the state machines.

**Coverage required by transition category:**

- **Forward transitions (10 rows):** S1→S2, S1→S3 (auto-fulfilled), S2→S3, S3→S4, S4→S5, S5→S6, S5→TERMINAL (no-show path), S6→S7, S7→S8, S8→S9 — all must have corresponding guards in the Entry Lifecycle state machine (§3.2).
- **Auto-fulfilment transitions (4 rows):** S2 skip (package rate), S4→S5 immediate (same/next-day arrival), S5 walk-in (real-time compressed), H1 auto-fulfil (same-team) — all must have corresponding auto-fulfilment handlers with audit record production.
- **Re-entry transitions (15 rows):** S2→S1, S3→S1, S3→S2, S4→S1, S4→S2, S4→S3, S5→S1, S6→S1, S7→S1, S7→S2, S7→S3, S7→S4, S8→S7, S8→S2, Any→S2 (complaint resolution) — all must have corresponding guard functions with authority checks matching the matrix.
- **Terminal transitions (10 rows):** Entry CLOSED, Entry CANCELLED, Entry EXPIRED, Dispute RESOLVED, Dispute CLOSED, Folio (Provisional) NO_SHOW_CLOSED, AWAITING_WRITTEN_CONFIRMATION→finalised, Speculative Hold RELEASED, Committed Hold CONFIRMED, Committed Hold RELEASED — all must have corresponding terminal guard functions.

**Why it matters:** A transition in the matrix with no corresponding guard is an unguarded path into that target stage. Any actor — or any system call — can trigger that transition without going through the five-guard sequence, bypassing the authority check and the exit evidence requirement.

**What constitutes a failure:** Any transition row in the matrix that cannot be mapped to a named guard function in the implemented state machines is a State Machine Gate failure. The failure is reported as: transition source stage, target stage/terminal state, and the missing guard function.

**Verification method:** Produce a mapping table of every transition row in the matrix against its corresponding guard function name and state machine module. Every row must have a match. Any unmapped row is a failure.

### 13.3.4 Assertion 4 — All Five Transition Guards Present

**What this assertion checks:** Every state machine transition enforces all five guards in sequence per the Transition Guard Summary:

1. Entry is in the expected source stage or status.
2. All exit evidence for the source stage is present and verified.
3. All open loops that block exit are closed, or are overridden with recorded authority.
4. The acting user holds the required authority for this transition.
5. The state machine transition guard function returns VALID.

**Why it matters:** The five-guard sequence is the enforcement architecture. An implementation that omits Guard 1 can apply a transition to an entity already in the target stage, producing a silent duplicate transition. An implementation that omits Guard 3 allows entities with open loops (unaccepted handoffs, unresolved disputes, unacknowledged communications) to advance. An implementation that omits Guard 4 allows any actor to perform transitions reserved for FOM or GM authority.

**What constitutes a failure:** A transition implementation that: omits any of the five guards entirely; evaluates guards out of sequence (e.g., checking authority before checking source stage); or implements Guard 3 without requiring recorded override authority for loop bypass, is a State Machine Gate failure. The failure is reported as: state machine name, transition name, and the specific guard that is absent or incorrectly sequenced.

**Verification method:** For each state machine module, inspect the transition function implementation. Confirm that the function body contains: (1) a source state check before any other guard evaluation; (2) an exit evidence check immediately following the source state check; (3) an open loop check that either confirms all loops closed or requires a recorded override record for each open loop; (4) an authority check against the actor's `ActorLevel`; and (5) a final VALID/INVALID evaluation before proceeding with the state change.

---

## §13.4 — Engine Gate

The Engine Gate verifies that all twelve engines are testable in isolation, that the hardcoded/configurable separation is verifiable for each engine, that the PricingPipelineEngine rate plan priority order is invariant, and that the NightAuditEngine idempotency guard is verifiable by double-run. All four assertions must pass for the Engine Gate to be declared passing.

### 13.4.1 Assertion 1 — All 12 Engines Testable in Isolation

**What this assertion checks:** Each of the twelve engines specified in Part 4 (§§4.2–4.12 per Part 4 self-declaration) is testable as a standalone unit without requiring a live database connection, a live service context, a running pg-boss instance, or any external API call.

**The 12 engines:**

| # | Engine | Primary Method |
|---|---|---|
| 1 | PricingPipelineEngine | `resolve(input: PricingInput): PricingResult` |
| 2 | AvailabilityEngine | `query(input: AvailabilityInput): AvailabilityResult` |
| 3 | TaxEngine | `calculate(input: TaxInput): TaxResult` |
| 4 | OverbookingDetectionEngine | `detect(input: OverbookingInput): OverbookingResult` |
| 5 | DisputeGateEngine | `canProgressStage(input: DisputeGateInput): DisputeGateResult` |
| 6 | FOCValidationEngine | `validate(input: FocValidationInput): FocValidationResult` |
| 7 | CreditCeilingMonitorEngine | `evaluate(input: CreditCeilingInput): CreditCeilingResult` |
| 8 | NightAuditEngine | `runAudit(input: NightAuditInput): NightAuditResult` |
| 9 | TimerEngine | `register(input: TimerRegistrationInput): TimerRegistration` |
| 10 | ReEntryConsequenceEngine | `compute(input: ReEntryInput): ReEntryConsequencePayload` |
| 11 | RoomAssignmentSuggestionEngine | `suggest(input: RoomSuggestionInput): RoomSuggestionResult` |
| 12 | (Engine 12 per §4.12 — Part 4 gate completeness statement) | Per Part 4 §4.12 |

**Why it matters:** An engine that requires a live database connection or a service context to be tested is an engine that has violated the engine/service boundary. Such an engine cannot be unit tested in isolation, meaning its computation logic is not independently verifiable. A defect in such an engine can only be detected through integration testing, which runs later and costs more.

**What constitutes a failure:** An engine that requires — at test construction time — a database connection string, a Prisma client instance, a running pg-boss connection, or any network-connected service, is an Engine Gate failure. The failure is reported as: engine name and the dependency that prevents isolation.

**Verification method:** For each engine, construct a test that: (a) instantiates the engine class directly with statically defined input values; (b) calls the engine's primary method; (c) asserts the output matches the expected typed result. The test must pass in a CI environment with no database or network connectivity. If the test fails or cannot be written, the engine has violated the isolation requirement.

### 13.4.2 Assertion 2 — Hardcoded vs Configurable Separation Verifiable

**What this assertion checks:** For every engine, the separation between hardcoded behaviours and configurable parameters (as declared in each engine's §4.x hardcoded/configurable subsection in Part 4) is verifiable by test:

- **(a) Configurable parameter test:** Changing a configuration parameter value in the engine input changes the engine output in the expected direction.
- **(b) Hardcoded behaviour test:** The hardcoded behaviour produces the same output regardless of what configuration values are present in the input.

**Why it matters:** An engine where a "hardcoded behaviour" can be altered by changing a configuration parameter is an engine where business-critical logic is inadvertently exposed to configuration. This makes the system auditable only when configuration is at specific values — which is not auditable at all. The hardcoded/configurable boundary is the guarantee that core business rules are invariant regardless of how the system is configured.

**What constitutes a failure:** An engine where a configuration parameter change alters the output of a declared hardcoded behaviour is an Engine Gate failure. The failure is reported as: engine name, hardcoded behaviour that was altered, and the configuration parameter that altered it.

**Verification method:** For each engine: (a) construct a test that changes only a configurable parameter and confirms the output changes accordingly — this verifies that the parameter is wired correctly; (b) construct a test that attempts to alter a hardcoded behaviour by changing configuration values and confirms the output does not change — this verifies that the hardcoded behaviour is truly hardcoded.

### 13.4.3 Assertion 3 — PricingPipelineEngine Rate Plan Priority Order Is Invariant

**What this assertion checks:** The rate plan priority order within PricingPipelineEngine — individual > promotional > tier > channel > rack — is hardcoded and cannot be altered by any configuration parameter.

**Why it matters:** The rate plan priority order is the deterministic rule that governs which rate applies when multiple rate plans are eligible for a booking. If this order were configurable, the rate calculation outcome could change at runtime based on configuration state, making pricing non-deterministic from an audit perspective. The priority order is hardcoded precisely to prevent this.

**What constitutes a failure:** A test that changes only configuration values supplied to PricingPipelineEngine and produces a rate plan resolution in an order other than individual > promotional > tier > channel > rack is an Engine Gate failure for this assertion. Alternatively, any configuration key whose documented purpose is to alter this priority order is a failure, regardless of whether it is actively used.

**Verification method:** Construct a test input that makes multiple rate plans eligible simultaneously (individual, promotional, tier, channel, rack all eligible). Run the engine with different configuration values and confirm that the selected rate plan is always the individual rate. Then construct a case where only promotional, tier, channel, and rack rates are eligible and confirm the promotional rate is always selected. No configuration variation should change this ordering.

### 13.4.4 Assertion 4 — NightAuditEngine Idempotency Guard Verifiable by Double-Run

**What this assertion checks:** Running the NightAuditEngine twice for the same audit date, with the first run having completed successfully, produces the same output and creates no duplicate effects — no duplicate charge postings, no duplicate night audit records, no duplicate anomaly records.

**Why it matters:** The night audit runs once per operating day. If it runs twice — due to a retry, a crash-recovery re-dispatch, or an operator error — and produces duplicate charge postings, the folio financial state becomes incorrect. The idempotency guard is the mechanism that prevents duplicate execution from producing duplicate effects.

**What constitutes a failure:** A double-run test that produces: (a) a second `NightAuditRecord` for the same operating date, (b) a second `FolioLine` for the same `(operatingDate, entryId)` combination, or (c) any other duplicate record or event for the same operating date, is an Engine Gate failure for this assertion.

**Verification method:** Construct a test that: (a) runs NightAuditEngine for a defined operating date and confirms the expected output; (b) runs NightAuditEngine again for the same operating date without clearing the persisted state; (c) confirms that the database contains exactly one `NightAuditRecord` for the date, exactly one charge posting per `(operatingDate, entryId)` combination, and that the second run's output is identical to the first run's output. The idempotency guard must detect the completed first run and exit cleanly on the second run.

---

## §13.5 — Policy Gate

The Policy Gate verifies that all 77 policies are callable directly, that direct policy invocation still triggers enforcement, and that every policy class in the stage-to-policy matrix has a named enforcement point in the policy catalogue. All three assertions must pass for the Policy Gate to be declared passing.

### 13.5.1 Assertion 1 — All 77 Policies Callable Directly

**What this assertion checks:** Each of the 77 policies in the Part 5 policy catalogue (§5.2.1 through §5.2.33 plus the §5.2.34 catalogue summary) is implemented as a callable policy function that can be invoked directly — bypassing the service layer and the controller layer — and still produces a governed enforcement result.

**Why it matters:** A policy that can only be reached through the controller or service stack is a policy that is not independently testable. If the policy lives inside a service method and cannot be invoked standalone, then testing the policy requires running the entire service stack, which conflates policy correctness with service orchestration correctness. The two must be independently verifiable.

**What constitutes a failure:** A policy whose implementation is inlined in a service method body (rather than exported as a standalone callable function) and that cannot be invoked directly without instantiating the service class is a Policy Gate failure. The failure is reported as: policy name (from §5.2.34 catalogue), policy group, and the service method in which it is embedded.

**Verification method:** For each policy in the §5.2.34 catalogue, locate the policy's implementation. Confirm that the implementation is exported as a standalone function or class with a primary evaluation method (e.g., `evaluate()`, `enforce()`, `check()`). Write a test that imports the policy directly and invokes it with a defined input. If the test cannot be written without also importing a service class, the policy fails this assertion.

### 13.5.2 Assertion 2 — Direct Policy Call Still Triggers Enforcement

**What this assertion checks:** Calling a policy function directly — without controller or service mediation — produces the same enforcement result as calling it through the full stack.

**Why it matters:** A policy that enforces correctly only when called through the service stack may be relying on middleware preprocessing, service-layer state injection, or HTTP context that is not available in direct invocation. Such a policy is conditionally enforced — enforced in production via the UI, potentially unenforced in automated jobs, bulk operations, or test environments that bypass the service layer.

**What constitutes a failure:** A policy that returns a different result (APPROVED where it should return DENIED, or vice versa) when called directly versus when called through the service stack with identical input is a Policy Gate failure. The failure is reported as: policy name, input scenario, and the discrepancy in enforcement result between direct invocation and service-stack invocation.

**Verification method:** For each policy, construct the canonical "should be denied" scenario. Invoke the policy directly and confirm it returns DENIED (or ESCALATE). Then invoke the same policy through the service stack with the same input. Confirm the service stack enforces the same DENIED result. Both must agree.

### 13.5.3 Assertion 3 — Every Policy Class in Stage-to-Policy Matrix Has a Named Enforcement Point

**What this assertion checks:** For every policy class row in the stage-to-policy matrix with a non-empty cell at any stage, at least one named policy in the Part 5 catalogue (§5.2.34) has a declared enforcement point at that stage for that policy class.

**Policy classes and required coverage:**

| Policy Class | Stages with active cells | Coverage requirement |
|---|---|---|
| Availability | S1, S5 | Policies 1, 2 (S1); Policy 1 (S5) |
| Ownership / custodian assignment | S1, S4, S5 | Policies 3, 4, 5 |
| Expiry / parking | S1, S2, S3, S5, S7, S9 | Policies 6, 7, 8, 9, 10, 11 |
| Duplicate detection | S1, S4 | Policies 12, 13 |
| Shadow inventory | S1 | Policy 14 |
| Guest identity | S1, S6 | Policies 15, 16 |
| Guest data governance | S6, S9 | Policies 17, 18 |
| Pricing / rate plan | S2, S4, S7, S8 | Policies 19, 20, 21, 22 |
| Discount | S2, S7 | Policies 23, 24 |
| Speculative hold | S2 | Policy 25 |
| Committed hold | S3 | Policy 26 |
| Advance payment | S3, S5, S6 | Policies 27, 28, 29 |
| Billing model | S3, S6, S7, S8 | Policies 30, 31, 32, 33 |
| Cancellation | S3, S4, S5, S6, S7 | Policies 34, 35, 36 |
| FOC | S2, S3, S4 | Policies 37, 38, 39 |
| Confirmation authority | S4 | Policy 40 |
| Overbooking | S4 | Policy 41 |
| Credit extension ceiling | S3, S4, S5, S7, S8 | Policies 42, 43, 44, 45, 46 |
| DEFICIENT condition | S1, S5, S6, S7, S8 | Policies 47, 48, 49, 50, 51 |
| Communication / ack tracking | S2–S9 | Policy 52 |
| Service recovery / dispute | S7, S8, S9 | Policies 53, 54, 55 |
| No-show | S5 | Policies 56, 57 |
| Room change | S7 | Policy 58 |
| Night audit | S5, S7, S8, S9 | Policies 59, 60, 61, 62 |
| Handoff | S4–S9 | Policy 63 |
| Group FOC / billing | S1, S2, S3, S4, S7, S8, S9 | Policies 64, 65, 66 |
| Work order | S1, S3, S4, S5, S7, S8 | Policy 67 |
| Commission production | S9 | Policy 68 |
| Session management | All stages | Policy 69 |
| Feedback | S9 | Policy 70 |

Additional policy classes covered by §§70A–70C additions: Processing Lock (Policies 71, 72), AI Agent (Policies 73, 74, 75), Voice Note (Policies 76, 77).

**Why it matters:** A policy class in the matrix with a non-empty cell and no corresponding enforcement point in the catalogue means that the business obligation that cell represents is unimplemented. The matrix cell is not aspirational — it states a governing obligation that the system must fulfil.

**What constitutes a failure:** A policy class row in the matrix with a non-empty cell for a given stage, and no named policy in the §5.2.34 catalogue with a declared enforcement point at that stage for that class, is a Policy Gate failure. The failure is reported as: policy class, stage, matrix cell content, and the absence of a corresponding catalogue entry.

**Verification method:** For each non-empty cell in the stage-to-policy matrix, identify the row (policy class) and column (stage). Search the §5.2.34 catalogue for a policy whose `Group` matches the policy class and whose `Stage(s)` includes the stage. A match constitutes coverage. Any cell without a match is a failure.

---

## §13.6 — Service Gate

The Service Gate verifies that no service method contains inline business rules, that no service method uses direct SQL, and that critical trace events are emitted within the same transaction as their governing state change. All three assertions must pass for the Service Gate to be declared passing.

### 13.6.1 Assertion 1 — No Inline Business Rules in Services

**What this assertion checks:** No service method body contains a conditional that evaluates a business rule inline — without invoking the governing policy or engine.

**Patterns that constitute inline business rule evaluation:**

- A conditional that compares a discount percentage against a threshold to determine whether approval is needed, without calling the Discount Approval Policy.
- A conditional that checks whether an actor's `ActorLevel` permits a specific action, without calling the Confirmation Authority Policy or equivalent.
- A conditional that computes a payment amount or applies a tax rate calculation inline, without calling TaxEngine.
- A conditional that evaluates whether a FOC entitlement threshold is met, without calling FOCValidationEngine.
- A conditional that determines whether a no-show determination is valid, without calling the No-Show Detection Policy.

**Why it matters:** Business rules inline in services are not testable independently. They are not counted in the policy catalogue. They are not enforced when the service is called from a worker, a bulk operation, or a test environment. Each inline business rule is a governance gap that exists in exactly one code path and is invisible to every other code path that performs the same operation.

**What constitutes a failure:** Any `if` / `else` conditional in a service method body that: (a) is not a Prisma query parameter construction, (b) is not a function call to a named policy or engine, and (c) evaluates a business condition (approval threshold, authority level, financial limit, FOC entitlement, stage eligibility) inline, is a Service Gate failure. The failure is reported as: service name, method name, and the inline rule that should be delegated to a policy or engine.

**Verification method:** Static code analysis of all files in the services directory. For each function in each service class, inspect every `if` conditional. Classify each as: (a) input validation/null check — not a business rule; (b) policy or engine invocation result check — permitted; (c) inline business condition — failure. The classification must be made against the policy catalogue (Part 5 §5.2.34) and the engine list (Part 4 §4.1.5). Any conditional not matching (a) or (b) is a failure candidate.

### 13.6.2 Assertion 2 — No Direct SQL

**What this assertion checks:** No service method uses a raw SQL query or a Prisma `$queryRaw` / `$executeRaw` call. All database access in the service layer passes through Prisma model methods.

**Why it matters:** Direct SQL bypasses Prisma's type system, meaning the result set is untyped. Untyped result sets cannot be verified by TypeScript compilation. Direct SQL also bypasses any Prisma middleware that enforces audit, logging, or row-level filtering. A service that uses direct SQL has a code path that is invisible to every Prisma-level control.

**What constitutes a failure:** Any occurrence of `$queryRaw`, `$executeRaw`, or a raw SQL string (identified by `SELECT`, `INSERT`, `UPDATE`, `DELETE` keywords in string literals or tagged template literals) within any file in the services directory is a Service Gate failure. The failure is reported as: file name, line number, and the raw SQL pattern found.

**Verification method:** Execute a codebase search using the following patterns against all files under `src/services/` (or equivalent):
- Pattern 1: `\$queryRaw` — Prisma raw query method
- Pattern 2: `\$executeRaw` — Prisma raw execute method
- Pattern 3: `sql\`` — tagged template SQL literals
- Pattern 4: `"SELECT` or `'SELECT` — raw SQL string

Zero matches across all four patterns = pass. Any match = failure requiring immediate investigation.

### 13.6.3 Assertion 3 — Trace Events in Same Transaction as State Change

**What this assertion checks:** For every governed state change that emits a critical trace event (as classified in Part 6 §6.3.2 critical event classification), the trace event write and the state change write execute within the same Prisma `$transaction` block. If the transaction rolls back, the trace event rolls back with it.

**Critical event categories for which this assertion applies:**

- Stage transition events (Entry advancing from any stage to the next)
- Folio state change events (provisional → live, live → sealed, no-show closed)
- Dispute state change events
- Processing lock state change events (ACTIVE → EXPIRED, ACTIVE → RELEASED)
- No-show determination events
- Terminal state transitions (CLOSED, CANCELLED, EXPIRED, RESOLVED)
- Night audit charge posting events

**Why it matters:** A trace event emitted outside the transaction — via a fire-and-forget call, via an `await` outside the transaction block, or via a deferred asynchronous event — is a trace event that can exist without its corresponding state change (if the state change transaction rolled back) or can be absent while the state change exists (if the event emission failed after the transaction committed). Both failure modes corrupt the audit trail.

**What constitutes a failure:** A service method that: (a) updates a governed entity state using `prisma.entity.update()` outside a `$transaction` block, with a trace event emitted after; (b) emits a critical trace event using `AuditService.emitAsync()` or equivalent fire-and-forget; or (c) emits a critical trace event in a `setTimeout` or equivalent deferred call, is a Service Gate failure. The failure is reported as: service name, method name, state change type, and the transactional gap.

**Verification method:** For each critical event category listed above, identify the service method responsible for that state change. Inspect the method body for the presence of a `prisma.$transaction(async (tx) => { ... })` block that contains both the state change write and the trace event write. Confirm that: (a) the state change uses the transaction client `tx`, not the top-level `prisma` client; and (b) the trace event uses the same transaction client `tx`.

---

## §13.7 — Worker Gate

The Worker Gate verifies that all 33 workers are idempotent, that all workers produce audit events on action taken, and that pg-boss integration is verified for all workers. All three assertions must pass for the Worker Gate to be declared passing.

### 13.7.1 Assertion 1 — All 33 Workers Idempotent by Double-Run

**What this assertion checks:** For each of the 33 workers defined in Part 8 (Workers 1–33), running the worker job twice for the same trigger input — with the first run having completed successfully — produces no duplicate effects.

**Prohibited duplicate effects per second run:**
- No duplicate state transitions (entity already in target state must not produce a second transition)
- No duplicate audit events (second run that takes no action must not emit a duplicate action event)
- No duplicate charge postings (second run of a charge-posting worker must not create a second folio line)
- No duplicate communication dispatches (second run of a notification worker must not dispatch a second notification)

**Why it matters:** Workers are dispatched by pg-boss and may be retried on failure. A crash between job execution and job completion acknowledgement causes pg-boss to re-dispatch the job. If the worker is not idempotent, the retry produces a duplicate effect — a duplicate charge, a duplicate notification, a second state transition that the state machine would reject but only after some records were written. The idempotency guard prevents this.

**What constitutes a failure:** A double-run test that produces any of the prohibited duplicate effects listed above is a Worker Gate failure. The failure is reported as: worker name (as listed in Part 8 §8.2), worker number, idempotency strategy declared in Part 8, and the duplicate effect produced.

**Verification method:** For each worker, construct a test that: (a) executes the worker's job handler with a defined input and confirms the expected output; (b) executes the worker's job handler again with the same input, without resetting the persisted state from the first run; (c) confirms that the database state after the second run is identical to the database state after the first run, and that no additional records, events, or side effects were produced by the second run.

### 13.7.2 Assertion 2 — All Workers Producing Audit Events on Action Taken

**What this assertion checks:** For each worker, when the worker takes a governed action (state transition, release, expiry, escalation, notification dispatch), it emits at least one typed audit event as declared in its Part 8 catalogue entry (`Audit event emitted` field).

**Additional requirement for skipped runs:** Workers that skip — because the action is already completed — must emit a skip event rather than exiting silently. A worker that exits without emitting any event (on either action taken or action skipped) violates the silent-expiry prohibition stated in Part 8 §8.1.4.

**Why it matters:** A worker action without an audit event is invisible to the governance and reporting layer. The dispute and service recovery report, the worker dwell time and SLA compliance report, and the audit trail query all depend on worker-emitted events. A silent worker is a worker whose actions cannot be reconstructed in post-hoc audit review.

**What constitutes a failure:** A worker run that: (a) takes a governed action and produces no `TraceEvent` record, or (b) skips because the action is already complete and produces no skip-type `TraceEvent` record, is a Worker Gate failure. The failure is reported as: worker name, worker number, action taken (or skipped), and the missing event type.

**Verification method:** For each worker, execute a test run that triggers the worker's primary action path. Query the `TraceEvent` table (or equivalent) for events produced by that worker run. Confirm that at least one event is present with the `eventType` declared in the worker's Part 8 `Audit event emitted` field and with `actorLevel: SYSTEM`. Then execute a run where the action is already complete. Confirm that a skip event is emitted.

### 13.7.3 Assertion 3 — pg-boss Integration Verified

**What this assertion checks:** Each worker's job type name (as declared in its Part 8 `pg-boss job type name` field) is registered with pg-boss at application startup, is schedulable, executes when its trigger condition is met, and routes to the dead-letter queue correctly on failure after maximum retries.

**Verification scope:**
- **Job registration:** At application startup, each worker's `jobType` string is registered with pg-boss using `boss.work(jobType, handler)` or equivalent. Unregistered job types cause silent job accumulation in the pg-boss queue without execution.
- **Job execution:** A job of each registered type, when enqueued with a valid payload, is picked up and executed by the corresponding worker handler within the configured polling interval.
- **Dead-letter routing:** A job that fails after the configured maximum retry count is moved to the dead-letter queue and triggers the configured alert. The dead-letter record carries: job type, job ID, governed entity ID, failure reason, and timestamp of DLQ entry.

**Why it matters:** A worker whose job type is not registered is a worker that never runs. Jobs accumulate silently in the queue. Timers fire, pg-boss enqueues jobs, but nothing handles them. The governed action never occurs — no expiry, no escalation, no night audit — and no error is raised because the job was validly enqueued. This failure mode is invisible without explicit registration verification.

**What constitutes a failure:** A worker whose `jobType` string cannot be found in the pg-boss registration calls at application startup is a Worker Gate failure. A worker whose job, when enqueued with a valid payload, is not executed within the configured polling window (typically 1 minute) in a test environment is also a Worker Gate failure. The failure is reported as: worker name, job type name, and the registration or execution gap.

**Verification method:** At application startup, pg-boss should log all registered job types. Verify that the log contains every job type name from the Part 8 catalogue. Then, for a representative sample of workers (minimum: the five highest-frequency workers), construct an integration test that enqueues a job and confirms execution within the polling window. For dead-letter behaviour: configure a worker to always fail, enqueue a job, exhaust retries, and confirm the job enters the dead-letter queue with the required metadata.

---

## §13.8 — Controller Gate

The Controller Gate verifies that all controllers are thin adapters, that all endpoints follow the response envelope standard, and that all endpoints pass through auth and validation middleware. All three assertions must pass for the Controller Gate to be declared passing.

### 13.8.1 Assertion 1 — All Controllers Are Thin Adapters Only

**What this assertion checks:** No controller method contains business logic. The only permitted operations in a controller method are:

1. Extract and validate the request payload using the DTO schema (through the validation middleware that has already executed before the controller handler).
2. Call exactly one service method with the extracted parameters.
3. Map the service response to the standard response envelope.

**Patterns that constitute a violation:**

- A controller method that calls two or more service methods for a single request.
- A controller method that contains a conditional that is not purely request parameter extraction or response format selection.
- A controller method that performs any data transformation beyond DTO-to-service-parameter mapping.
- A controller method that contains a `try/catch` block that alters business behaviour (catching a specific error and responding with a different action rather than returning an error envelope).

**Why it matters:** Business logic in controllers is not enforced when the service is called directly (from workers, bulk operations, or tests). A controller that contains an authority check that should be in the service layer means that worker-dispatched calls — which bypass the controller — bypass the authority check. The thin adapter doctrine is the guarantee that every code path into the service layer is equally governed.

**What constitutes a failure:** Any controller method that calls more than one service method, contains a non-envelope-mapping conditional, or performs data transformation beyond parameter extraction is a Controller Gate failure. The failure is reported as: controller name, route method, and the business logic that must be moved to the service layer.

**Verification method:** For each controller class, inspect every method body. Count service method calls per controller method — any count above one is a failure. Inspect every conditional — any conditional not matching input null-check or error-envelope mapping is a failure. Confirm that no financial calculation, authority check, state machine evaluation, or policy invocation appears in the controller body.

### 13.8.2 Assertion 2 — All Endpoints Follow the Response Envelope Standard

**What this assertion checks:** Every endpoint declared in Part 9 produces responses in the standard response envelope format:

- **Success responses:** `{ success: true, data: <typed payload> }` — no naked payload, no array at the top level, no service object returned directly.
- **Error responses:** `{ success: false, error: { code: string, message: string, details?: unknown } }` — no naked error message, no raw exception object, no stack trace in the response body.

**Why it matters:** An inconsistent response shape means API consumers — whether a frontend client or an integration partner — cannot reliably distinguish success from failure. A naked payload without `success: true` cannot be distinguished from an error payload that happens to look like a successful response. The envelope is the structural guarantee that every API response is machine-parseable by its shape alone.

**What constitutes a failure:** An endpoint that returns: (a) a raw object without the `success` field; (b) a bare array; (c) a string or number as the response body; or (d) an error object without the `error.code` and `error.message` fields, is a Controller Gate failure. The failure is reported as: route path, HTTP method, and the non-conforming response shape.

**Verification method:** For a representative sample of routes (minimum: all routes that produce both success and error responses), execute integration tests that: (a) call the route with valid input and confirm the response body matches `{ success: true, data: <any> }`; (b) call the route with input that triggers an error and confirm the response body matches `{ success: false, error: { code: <string>, message: <string> } }`. Any test that reveals a non-conforming shape is a failure.

### 13.8.3 Assertion 3 — All Endpoints Pass Through Auth and Validation Middleware

**What this assertion checks:** Every route registered in Part 9 passes through both the authentication middleware (PIN/JWT session validation) and the request validation middleware (DTO schema validation) before the controller handler executes. Both middleware must execute in order: auth before validation; validation before controller handler.

**Why it matters:** A route registered without auth middleware is a route that accepts unauthenticated requests. Any caller — including an attacker — can invoke the service method without being a known actor. The audit trail for that invocation has no actor identity. A route registered without validation middleware accepts unvalidated input, which can produce undefined behaviour in the service layer when required fields are missing or have unexpected types.

**What constitutes a failure:** A route registration in Part 9 that does not explicitly include both `authMiddleware` and `validationMiddleware` in its middleware chain, in that order, is a Controller Gate failure. The failure is reported as: route path, HTTP method, and the middleware that is absent from the chain.

**Verification method:** Inspect the route registration for every route declared in Part 9 §9.4. For each registration, confirm that the middleware chain includes both auth and validation middleware explicitly. Then execute a test that: (a) calls the route without a session token and confirms `401 Unauthorized`; (b) calls the route with a valid session token but with an invalid request body (missing required field) and confirms `400 Bad Request` with a validation error envelope. Both must behave as expected for every declared route.

---

## §13.9 — Integration Gate

The Integration Gate verifies that all eight integration interfaces are abstracted, that interface contracts match service expectations, and that the FULL_AUTO scope boundary is enforced at the AI Agent interface level. All three assertions must pass for the Integration Gate to be declared passing.

### 13.9.1 Assertion 1 — All 8 Integration Interfaces Abstracted

**What this assertion checks:** No service, worker, or engine imports or calls an infrastructure SDK directly. All calls to external infrastructure pass through the named interface layer defined in Part 11.

**The 8 integration interfaces and their abstracted provider:**

| Interface | Part 11 Section | Provider Abstracted |
|---|---|---|
| EmailInterface | §11.2 | SES / outbound and inbound email; OTA inbox monitoring |
| WhatsAppInterface | §11.3 | BSP (Business Solution Provider) API |
| AiAgentInterface | §11.4 | LLM API (provider-agnostic) |
| FileStorageInterface | §11.5 | Cloud file storage (S3 or equivalent) |
| PhoneLogInterface | §11.6 | Phone log ingestion and call record management |
| FinancialExportInterface | §11.7 | Accounting system financial export |
| DocumentGenerationInterface | §11.8 | Document generation (PDF reports, invoices) |
| (Interface 8 per §11.8 or additional) | §11.x | Per Part 11 §§11.2–11.9 count |

**Why it matters:** A service that imports `@aws-sdk/client-ses` directly is a service whose email dispatch cannot be tested without a live AWS connection. A service that calls a BSP API endpoint directly is a service whose WhatsApp dispatch cannot be tested without a live BSP account. Every direct SDK import is a testing and portability constraint that cannot be resolved without refactoring.

**What constitutes a failure:** Any file in the services, workers, or engines directories that contains a direct import of an infrastructure SDK (`@aws-sdk/client-ses`, a BSP SDK, an OpenAI or equivalent LLM SDK, `aws-sdk`, a storage SDK) is an Integration Gate failure. The failure is reported as: file path, import statement, and the interface that should be used instead.

**Verification method:** Execute a codebase search for known SDK package names in all files under `src/services/`, `src/workers/`, and `src/engines/`:
- `@aws-sdk/` — AWS SDK imports
- `openai` / `anthropic` / `claude` — LLM SDK imports
- Any BSP-specific SDK package name
- Any storage SDK package name

Zero matches in services, workers, or engines = pass. Any match in those directories = failure.

### 13.9.2 Assertion 2 — Interface Contracts Match Service Expectations

**What this assertion checks:** The input and output types that services pass to and receive from each integration interface match the contracts declared in Part 11. TypeScript compilation with strict mode enabled produces no type errors at any integration interface call site.

**Why it matters:** A type mismatch between the calling service and the interface contract means the service is passing a value that the interface does not expect, or consuming a value that the interface does not return. In a dynamically typed language this produces runtime errors. In TypeScript, strict mode compilation catches this at build time — but only if the interface contract is typed correctly and the service call site is typed against the interface.

**What constitutes a failure:** A TypeScript compilation error — in strict mode — at any call site where a service or worker calls an integration interface method is an Integration Gate failure. The failure is reported as: interface name, method name, service or worker file, and the type error message from the TypeScript compiler.

**Verification method:** Run `tsc --strict --noEmit` against the full codebase. Filter the output for type errors occurring in files that import from the integration interface layer. Any type error at an interface call site is a failure.

### 13.9.3 Assertion 3 — FULL_AUTO Scope Boundary Enforced at AI Agent Interface Level

**What this assertion checks:** The AI Agent interface (Part 11 §11.4) enforces the FULL_AUTO scope boundary: actions classified as outside FULL_AUTO scope are not dispatched to the AI agent for autonomous execution, even when the trust level is set to `FULL_AUTO` for the relevant action category.

**The boundary must be enforced at the interface layer itself.** Service-layer enforcement alone is insufficient. A service that checks the FULL_AUTO boundary before calling the interface is correct, but if the interface itself does not enforce the boundary, then a future service that bypasses the check — or a worker that calls the interface directly — can dispatch an out-of-scope action.

**Why it matters:** The FULL_AUTO scope boundary defines what the AI agent may and may not do autonomously. An action outside FULL_AUTO scope — financial commitments above threshold, authority-level actions, irreversible operational changes — dispatched to the AI agent for autonomous execution is an architectural and governance violation regardless of how the trust level is configured.

**What constitutes a failure:** A test that calls the AI Agent interface directly with an out-of-scope action type and a trust level of `FULL_AUTO`, and that produces a dispatched action rather than a typed `FullAutoScopeBoundaryViolationError`, is an Integration Gate failure. The failure is reported as: action type, trust level, and the boundary violation that was not caught.

**Verification method:** Construct a test that: (a) identifies at least three action types that are classified as outside FULL_AUTO scope per Part 11 §11.4; (b) calls the AiAgentInterface directly with each action type and trust level `FULL_AUTO`; (c) confirms that each call produces a `FullAutoScopeBoundaryViolationError` (or equivalent typed boundary error) and does not dispatch the action to the LLM API. Additionally, confirm that the error carries: the action type, the trust level, and the reason the action is outside scope.

---

## Appendix A — Canon-to-Spec Cross-Reference

This appendix maps every major DEV-SPEC obligation to its source: Canon section, MOM decision, or Actor-Authority Matrix entry. Its purpose is to support audit reconstruction and to provide a single navigable reference for tracing any obligation in the specification back to its governing authority.

### A.1 — Schema Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 2 §2.1.1 | Append-only doctrine — no destructive edit of committed records | §71 (Record Mutation and Layering Rules) | — | Record type mutation rules derived per §71 rows |
| Part 2 §2.1.1 | NOT NULL on all audit fields | §82 (Realisation Obligations — Audit) | — | Stated as structural guarantee |
| Part 2 §2.1.1 | Prisma as source of truth; no raw SQL DDL | §82 (Realisation Obligations — Services) | MOM-ARCH-2026-013 (ORM locked: Prisma) | Infrastructure decision locked |
| Part 2 §2.1.3 | All record types present per stage-to-record matrix | §74 (Stage-to-Record Matrix) | — | Full matrix reproduced in §2.1.3 derivation reference |
| Part 2 §2.1–§2.20 | §71 mutation rules annotated on each model | §71 (Record Mutation Rules) | — | Applied as model-level annotations throughout Part 2 |
| Part 2 §2.x | ProcessingLockRecord model | §70A (Processing Lock) | MOM-ARCH-2026-010 | v2.4 canonical addition |
| Part 2 §2.x | AiDraftRecord model | §70B (AI Agent) | MOM-ARCH-2026-010 | v2.4 canonical addition |
| Part 2 §2.x | VoiceNoteRecord model | §70C (Voice Note) | MOM-ARCH-2026-010 | v2.4 canonical addition |
| Part 2 §2.x | DisputeGateOverrideRecord model | §53 (M.8 dispute gate override sub-clause) | MOM-ARCH-2026-010 (REV-B9-V23-01) | v2.3 canonical addition |
| Part 2 §2.x | SessionEventRecord model | §70A (Session Event) | CANON-V2.5-CHANGESET | v2.5 canonical addition |
| §13.2 — Schema Gate | Schema Gate assertions | §71, §74 | — | Gate derives from Canon §71 (mutation rules), §74 (record matrix) |

### A.2 — State Machine Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 3 §3.1.2 | Five-guard sequence on every transition | §76A (Transition Guard Summary) | — | Derived verbatim from §76A |
| Part 3 §3.1.3 | P1 Doctrine — no bypass, only escalation | §82 (Realisation Obligations) | — | Stated as structural requirement |
| Part 3 §3.2–§3.17 | All stage-level transition guards | §76A (Stage Transition Matrix — all four tables) | — | Derived without modification or inference per §76A preamble |
| Part 3 §3.2 | AWAITING_WRITTEN_CONFIRMATION path | §76 (No-show cutoff timer row) | — | B2-005 + B9-005 closure |
| Part 3 §3.2 | Entry → CLOSED commission-due guard conditionality | §71 (Commission-Due Record — S9 row, footnote 1) | — | B11-001 closure — conditional applied in §3.2.5 |
| Part 3 §3.5 | Speculative and committed hold state machines | §76A (Terminal Transitions — hold rows) | — | |
| Part 3 §3.13 | AI agent self-approval absolute prohibition | §70B (AI Agent — FULL_AUTO scope boundary) | MOM-ARCH-2026-010 | No trust level override |
| Part 3 §3.16 | NoShowDeterminationRecord schema anchor | §74 (No-Show Determination Record — S5: C, S9: R) | — | G3-001 open item |
| §13.3 — State Machine Gate | State Machine Gate assertions | §76A (Stage Transition Matrix) | — | Gate derives from §76A transition and guard tables |

### A.3 — Engine Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 4 §4.1.2 | Hardcoded vs configurable separation | §82 (Realisation Obligations — Engines) | — | P-NEW-E doctrine cited in §82 |
| Part 4 §4.2 | PricingPipelineEngine — rate plan priority order invariant | §82 | — | Hardcoded behaviour per §4.2 |
| Part 4 §4.9 | NightAuditEngine — idempotency guard | §82 (Realisation Obligations — Workers) | — | Double-run must be safe |
| Part 4 §4.10 | TimerEngine — timer registry | §76 (Stage-to-Timer/Worker Matrix) | — | All timer entries from §76 |
| Part 4 §4.11 | ReEntryConsequenceEngine — re-entry consequences | §76A (Re-Entry Transitions) | — | Derived from §76A re-entry table |
| §13.4 — Engine Gate | Engine Gate assertions | §82 | — | |

### A.4 — Policy Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 5 §§5.2.1–5.2.33 + §5.2.34 | 77 named policies | §72 (Stage-to-Policy Matrix); §§70A–70C | — | Complete policy catalogue |
| Part 5 §5.2.34 | Policies 71–77 (§70A/70B/70C) | §70A, §70B, §70C | MOM-ARCH-2026-010 | v2.4 canonical additions |
| §13.5 — Policy Gate | Policy Gate assertions | §72 | — | Every §72 class must have named enforcement point |

### A.5 — Service Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 6 §6.1.2 | No inline business rules; no direct SQL | §82 (Realisation Obligations — Services) | — | Structural guarantee |
| Part 6 §6.1.5 | Trace events in same transaction as state change | §82 (Realisation Obligations — Eventing) | — | P7 doctrine |
| Part 6 §6.2 | Transaction management doctrine | §82 | — | |
| Part 6 §6.5.11–§6.5.12 | GuestProfileService; SpaceAllocationService | §74 (Guest Profile, Space Allocation rows) | MOM-ARCH-2026-015 (P5 closure) | P5 closed at Gate 6 |
| Part 6 §6.6.2 | Amendment routing — Model C hybrid | §76A (Re-Entry Transitions) | MOM-ARCH-2026-015 (B9-001 closure) | Amendment algorithm resolved |
| §13.6 — Service Gate | Service Gate assertions | §82 | — | |

### A.6 — Worker Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 8 §8.1.2 | All workers idempotent | §82 (Realisation Obligations — Workers) | — | |
| Part 8 §8.1.3 | pg-boss integration | — | MOM-ARCH-2026-013 (pg-boss locked) | Infrastructure decision locked |
| Part 8 §8.1.4 | Audit event on every worker action | §82 | — | Silent-expiry prohibition |
| Part 8 §8.2 (Workers 1–33) | Worker catalogue — all workers | §76 (Stage-to-Timer/Worker Matrix) | — | §76 matrix is the authoritative worker source |
| §13.7 — Worker Gate | Worker Gate assertions | §76, §82 | — | |

### A.7 — Controller Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 9 §9.1.1 | Controllers are thin adapters only | §82 (Realisation Obligations — Services) | — | Separation of concerns |
| Part 9 §9.1.2 | Response envelope standard | — | Part 1 §1.x (controlled vocabulary) | Envelope standard from Part 1 |
| Part 9 §9.1.3 | Auth and validation middleware on every route | §82 (Authentication and Attribution) | — | |
| §13.8 — Controller Gate | Controller Gate assertions | §82 | — | |

### A.8 — Integration Obligations

| DEV-SPEC Reference | Obligation | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Part 11 §11.1.1 | All infrastructure access through interface layer | §82 (Realisation Obligations) | — | |
| Part 11 §11.4 | FULL_AUTO scope boundary | §70B (AI Agent — FULL_AUTO scope clarification) | MOM-ARCH-2026-010 (REV-B10-V23-02) | v2.3 canonical addition |
| §13.9 — Integration Gate | Integration Gate assertions | §82; §70B | — | |

### A.9 — Infrastructure Decisions

| DEV-SPEC Reference | Decision | Canon Source | MOM / Decision | Notes |
|---|---|---|---|---|
| Throughout Part 2 | ORM: Prisma (locked) | — | MOM-ARCH-2026-013 | Prisma selected over Sequelize |
| Throughout Part 8 | Job queue: pg-boss (locked) | — | MOM-ARCH-2026-013 | pg-boss selected over BullMQ |
| Part 6 §6.6.2 | Amendment routing: Model C hybrid (locked) | §76A (Re-Entry Transitions) | MOM-ARCH-2026-015 | B9-001 resolved |
| Part 11 §11.4 | AI actor identity (locked) | §70B | MOM-ARCH-2026-015 (OI-014-01) | AI actor identity governance |

### A.10 — Actor-Authority Matrix

The Actor-Authority Matrix (ACTOR-AUTHORITY-MATRIX-LOCKED.md) is a companion document to DEV-SPEC-001. Key authority decisions traced here:

| Authority Decision | Gate / Section | Notes |
|---|---|---|
| FOM confirmation authority for conference/high-value | Part 3 §3.2 (S4→S5 guard), Part 5 Policy 40 | Actor-Authority Matrix row: FOM — S4 confirmation |
| GM dispute gate override | Part 3 §3.2 (S7→S8 and S8→S9 dispute gate), DisputeGateOverrideRecord | v2.3 addition; MOM-ARCH-2026-010 |
| FOM early departure authority | Part 5 Policy 36 | Actor-Authority Matrix row: FOM — S7 early departure |
| GM authority for re-entry to S2 from S4 (rate change) | Part 3 §3.2 (Re-entry table) | Per §76A re-entry authority column |

### A.11 — Category 1 Open Clarification Requests

Items that remain open from writing gates and require Architect decision before the corresponding gate assertion can be fully certified:

| ID | Source Gate | Item | Status | Gate Impact |
|---|---|---|---|---|
| G3-001 | Gate 3 | `NoShowDeterminationRecord` Prisma model presence in schema — §3.16 requires this model as its schema anchor. If absent from Part 2, §13.2 Assertion 6 fails and the Schema Gate cannot be certified. | Open — verify against Part 2 schema. If absent, schema backfill required before Schema Gate certification. | §13.2 Assertion 6 (blocking) |
| G3-002 | Gate 3 | Space physical state machine (§3.8) — SETUP_IN_PROGRESS and BREAKDOWN_IN_PROGRESS phases derived from ToC reference to §68; §68 was not a declared Gate 3 source. If §68 defines additional space states or guards, §3.8 requires revision. | Open — requires Architect confirmation on §68 scope before §3.8 can be certified complete. | §13.3 Assertion 1 (blocking if §3.8 is incomplete) |

---

## Appendix B — Spec Ambiguity Register

This appendix carries all architectural ambiguities and deferred decisions accumulated across all writing gates. Items in this register do not block Gate 13 unless explicitly noted. They require Architect deliberation before the affected section can be declared locked.

### Register

| ID | Source | Nature | Status | Resolution Path |
|---|---|---|---|---|
| B4-001 | Gate 4 / Part 9 §9.2.3 | **Concurrent editing doctrine.** `version Int @default(1)` needed on `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem` in Part 2. The §9.2.3 concurrent editing middleware section is incomplete — optimistic locking mechanism is referenced but not fully specified. | Open — not blocking Gate 13. Requires dedicated Architect decision session. Targets Part 2 (four models) and Part 9 §9.2.3. | Architect decision session; Part 2 backfill for four models; Part 9 §9.2.3 completion |
| B9-003 | Gate 9 | **S9-equivalent processing for cancelled entries with pending refunds.** Entries that reach a cancelled state with outstanding refund obligations require a processing path equivalent to S9 settlement. The routing and worker assignment for this path have not been specified. | Open — not blocking Gate 13. Requires dedicated Architect decision session. | Architect decision session; potential new worker or service method addition |
| B2-005 + B9-005 | Gates 2 and 9 | **AWAITING_WRITTEN_CONFIRMATION state machine completeness.** These items raised a concern about the completeness of the AWAITING_WRITTEN_CONFIRMATION state handling in the entry lifecycle. This state is addressed in Part 3 §3.2 and the corresponding no-show determination path in §3.16. | Verify: inspect Part 3 §3.2 for explicit AWAITING_WRITTEN_CONFIRMATION state definition, guard conditions, and timer-governed exit paths. If §3.2 addresses both the verbal-claim entry into this state and the timer-governed no-show finalisation exit, items are resolved. If any path is absent, item remains open. |
| B3-001 | Gate 3 | **QUOTED displacement threshold.** Configurable threshold governing when a quotation in QUOTED status triggers a displacement warning as it approaches expiry. Deferred to Appendix C as a seed data placeholder item. | Deferred to Appendix C (seed data item). Placeholder default: 48 hours before expiry triggers displacement warning. Architect must review before go-live. |
| B11-001 | Gate 11 | **Entry → CLOSED terminal condition commission-due guard.** The conditional language for the commission-due record creation guard was applied in §3.2.5 — the guard fires only when a commission rate is configured on the agent profile. | Verify: inspect Part 3 §3.2.5 for the conditional commission-due guard statement. If §3.2.5 explicitly states the commission rate configuration condition as a guard on terminal CLOSED status, item is resolved. If absent, §3.2.5 requires revision. |
| B5-001 | Gate 5 | **Discount thresholds per authority level.** Authority-banded discount thresholds (e.g., 0–5% Reception, 5–15% FOM, 15–30% GM, 30%+ Director) were specified as required in the Discount Approval Policy (Policy 23) but the specific threshold values were not declared in the policy. Deferred to Appendix C as placeholder defaults. | Deferred to Appendix C. Placeholder values only — Architect must confirm before go-live. |
| B6-001 | Gate 6 | **Credit ceiling authority thresholds per client tier.** Per-tier credit ceiling defaults (Individual, Corporate, Government) required for CreditCeilingMandatorySetPolicy (Policy 42) but specific values not declared. Deferred to Appendix C. | Deferred to Appendix C. Placeholder values only — Architect must confirm before go-live. |
| B9-002 | Gate 9 | **Rate override margin per rate plan.** The permitted override margin for each rate plan type (standard, promotional) is required by the Mid-Stay Rate Amendment Policy (Policy 21) but specific values not declared. Deferred to Appendix C. | Deferred to Appendix C. Placeholder values only — Architect must confirm before go-live. |

**Confirmed resolved — do not re-open:**

| ID | Resolution |
|---|---|
| B9-001 | Amendment path routing algorithm — resolved at Gate 6 (MOM-ARCH-2026-015). Model C hybrid applied in Part 6 §6.6.2. Do not carry forward. |

---

## Appendix C — Seed Data Specification

### Purpose

The Admin Console ships with seeded defaults for all configurable surfaces. This appendix specifies those defaults so that:

- The system passes the §12.3 readiness check on first startup after seeding.
- Administrators can see which values are factory defaults (per the non-intrusive indicator doctrine declared in Part 12).
- Developers have a concrete target for the initial database seeding script.

Values marked **[PLACEHOLDER — ARCHITECT REVIEW REQUIRED]** are provisional. They must be reviewed and confirmed by the Architect before the system is used in production. Their purpose is to ensure the Admin Console is functional from first startup, not to set operational policy.

### Seed Data Table

| Surface (canonical name) | Seeded Default Value | Notes |
|---|---|---|
| **Entry / Inquiry expiry** | | |
| Inquiry expiry threshold | 72 hours from last activity | Configurable; factory default |
| Entry park-expiry threshold | 30 days from park date | Configurable; factory default |
| **Quotation validity** | | |
| Quotation validity window | 48 hours from send | Configurable; factory default |
| Quotation acknowledgement response window | 24 hours from send | Configurable; factory default |
| QUOTED displacement warning threshold | 48 hours before expiry | **[PLACEHOLDER — B3-001 — ARCHITECT REVIEW REQUIRED]** |
| **Hold expiry** | | |
| Speculative hold TTL | 15 minutes | Configurable; factory default |
| Committed hold expiry window | 24 hours from placement | Configurable; factory default |
| **Processing lock** | | |
| Processing lock TTL — Walk-in channel | 15 minutes | Per §70A doctrine |
| Processing lock TTL — OTA channel | 15 minutes | Per §70A doctrine |
| Processing lock TTL — Direct phone channel | 15 minutes | Per §70A doctrine |
| Processing lock TTL — Agent channel | 15 minutes | Per §70A doctrine |
| **Voice note SLA** | | |
| Voice note review SLA — Operating hours (all stages) | 30 minutes | Per §70C doctrine |
| Voice note review SLA — After hours (all stages) | Next operating day first hour | Per §70C doctrine |
| **Session management** | | |
| Idle lock threshold — Front Desk role | 10 minutes | Configurable; factory default |
| Idle lock threshold — FOM role | 15 minutes | Configurable; factory default |
| Idle lock threshold — GM role | 20 minutes | Configurable; factory default |
| Hard logout threshold — Front Desk role | 8 hours | Configurable; factory default |
| Hard logout threshold — FOM role | 12 hours | Configurable; factory default |
| Hard logout threshold — GM role | 12 hours | Configurable; factory default |
| PIN length (all roles) | 6 digits | Configurable; factory default |
| **Dwell time thresholds (StageDwellMonitor)** | | |
| S1 idle warning threshold | 2 hours | Mode-dependent; factory default for standard booking mode |
| S1 idle critical threshold | 4 hours | Mode-dependent; factory default |
| S2 idle warning threshold | 4 hours | Mode-dependent; factory default |
| S2 idle critical threshold | 8 hours | Mode-dependent; factory default |
| S4 idle warning threshold | 24 hours (pre-arrival period threshold) | Timer-driven; factory default |
| S7 night audit completion deadline | 23:00 operating day | Configurable; factory default |
| S8 checkout overdue threshold | 2 hours past checkout time | Configurable; factory default |
| **Night audit** | | |
| Night audit scheduled time | 23:00 (daily) | Configurable; factory default |
| Night audit PARTIAL run escalation window | 30 minutes after scheduled time | Configurable; factory default |
| **Pre-arrival** | | |
| Pre-arrival window opening | 48 hours before arrival date | Configurable; factory default |
| Room readiness SLA | 2 hours before confirmed arrival time | Configurable; factory default |
| **Dispute and service recovery** | | |
| Dispute time-to-first-response target | 30 minutes | Configurable; factory default |
| Dispute time-to-resolution target | 24 hours | Configurable; factory default |
| Dispute SLA escalation window | 4 hours past time-to-first-response | Configurable; factory default |
| **Credit ceiling** | | |
| Credit ceiling proximity notification threshold | 75% | Per §70A doctrine and credit ceiling policy |
| Credit ceiling FOM interruption threshold | 90% | Per credit ceiling active monitoring policy |
| Credit ceiling Individual client default | BTN 50,000 | **[PLACEHOLDER — B6-001 — ARCHITECT REVIEW REQUIRED]** |
| Credit ceiling Corporate client default | BTN 200,000 | **[PLACEHOLDER — B6-001 — ARCHITECT REVIEW REQUIRED]** |
| Credit ceiling Government client default | BTN 500,000 | **[PLACEHOLDER — B6-001 — ARCHITECT REVIEW REQUIRED]** |
| **Discount authority thresholds** | | |
| Discount band — Reception authority | 0% to 5% | **[PLACEHOLDER — B5-001 — ARCHITECT REVIEW REQUIRED]** |
| Discount band — FOM authority | 5% to 15% | **[PLACEHOLDER — B5-001 — ARCHITECT REVIEW REQUIRED]** |
| Discount band — GM authority | 15% to 30% | **[PLACEHOLDER — B5-001 — ARCHITECT REVIEW REQUIRED]** |
| Discount band — Director authority | 30% and above | **[PLACEHOLDER — B5-001 — ARCHITECT REVIEW REQUIRED]** |
| **Rate override margins** | | |
| Rate override margin — Standard rate plans | 10% | **[PLACEHOLDER — B9-002 — ARCHITECT REVIEW REQUIRED]** |
| Rate override margin — Promotional rate plans | 5% | **[PLACEHOLDER — B9-002 — ARCHITECT REVIEW REQUIRED]** |
| **Feedback solicitation** | | |
| Feedback solicitation delay after checkout | 2 hours | Configurable; factory default |
| **FOM override frequency tracking** | | |
| FOM override frequency tracking window | 30 days (rolling) | Per §76 timer matrix |
| FOM override frequency alert threshold | 5 overrides in window | Configurable; factory default |
| **OTA notification open loop** | | |
| OTA notification loop closure window | 48 hours | Configurable; factory default |
| **Commission-due RATE_MISSING escalation** | | |
| Commission RATE_MISSING resolution window | 7 days | Configurable; factory default |
| **Equipment return** | | |
| Equipment return deadline alert lead time | 2 hours | Configurable; factory default |
| **Lost and found** | | |
| Lost and found retention period | 90 days | Configurable; factory default |
| **Maintenance and blocked room** | | |
| Maintenance expected_ready_at alert lead time | 24 hours | Configurable; factory default |
| Blocked room unblock_date alert lead time | 24 hours | Configurable; factory default |

### Predefined Modes — Seeded Configuration

The eight predefined modes are seeded as factory configuration. Each mode's stage route and auto-fulfilment conditions are seeded per the Part 12 §12.2.5 mode configuration surface specification and the Part 3 state machine definitions.

| Mode Name | Primary Stage Route | Auto-Fulfilment Conditions | Notes |
|---|---|---|---|
| New Booking | S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9 | S2 skip on package rate acceptance; S4→S5 immediate on same/next-day confirmation | Standard forward progression |
| Room Change | S7 → S1 (compressed) → S7 | Compressed re-entry at S1; inventory reassignment; no rate change if same tier | Room Change mode trigger |
| Rate Revision | S7 → S2 (rate renegotiation) or S7 folio adjustment | Full renegotiation = new segment; simpler paths = folio adjustment only | Per §76A re-entry authority column |
| Date Extension | S7 → S4 (date re-confirmation) | FOM/GM authority required for date extension re-confirmation | New segment required |
| Early Departure / Cancellation | S7 → terminal (early departure) | GM authority for early departure at S7; folio financial residue governed | Per Part 5 Policy 36 |
| Billing Model Change | S7 → S3 (billing model change) | GM authority for billing model change during stay | New segment dependent on nature |
| Guest Composition Change | S7 → S1 (room change mode) | Front Desk authority for room change; FOM for rate delta | Treated as Room Change sub-mode |
| Complaint Resolution / Goodwill | Any → S2 (complaint resolution) | FOM/GM authority depending on adjustment value | Complaint Resolution mode |

---

## Appendix D — Reporting Specification

### Doctrine

All reports are derived from governed operational data. No report creates or modifies operational records. A report is a read-only projection of existing records. Report specifications define: report name, report category, data sources (Prisma models and fields), filter parameters available, output format, and access authority (which actor levels may generate the report).

A report that writes to any operational table is an architectural violation. Reports are read operations only.

### Daily Operational Reports

---

**Report D-01: Night Audit Report**

| Field | Value |
|---|---|
| Category | Daily Operational |
| Purpose | Financial summary for the operating date, with anomaly section for missing expected charges |
| Data sources | `NightAuditRecord`, `FolioLine` (filtered by `lineDate`), `Entry` (active at operating date), `NightAuditAnomaly` (if modelled separately) |
| Key fields | Operating date; total charge postings by category; total revenue by room type and rate plan; any entries with expected charges not posted (anomaly section); run status (COMPLETE / PARTIAL) |
| Filter parameters | Operating date (required); run status |
| Output format | Structured tabular report with financial summary section and anomaly section (empty if no anomalies) |
| Access authority | FOM, GM, Admin |
| Notes | PARTIAL run status surfaced prominently. Anomaly section must list every entry where an expected charge was not posted, with reason where determinable. |

---

**Report D-02: Occupancy Report**

| Field | Value |
|---|---|
| Category | Daily Operational |
| Purpose | Current occupancy and forecast occupancy |
| Data sources | `Entry` (currentStage, arrivalDate, departureDate), `Room` (currentClaimState), `Reservation` |
| Key fields | Current occupied rooms; current vacant rooms; forecast arrivals by date (next 30 days); forecast departures by date; occupancy percentage |
| Filter parameters | Date range (defaults to today + 30 days); room type |
| Output format | Summary counts with date-range breakdown table |
| Access authority | Front Desk, FOM, GM |

---

**Report D-03: Arrival / Departure Report**

| Field | Value |
|---|---|
| Category | Daily Operational |
| Purpose | Today's expected arrivals and departures with status |
| Data sources | `Entry` (arrivalDate, departureDate, currentStage), `GuestProfile`, `Reservation`, `HandoffRecord` |
| Key fields | Guest name; room; expected arrival/departure time; current stage; H1 handoff status; pre-arrival task completion status |
| Filter parameters | Date (defaults to today); stage filter |
| Output format | Tabular list, sortable by expected time |
| Access authority | Front Desk, FOM, GM |

---

**Report D-04: Housekeeping Assignment Report**

| Field | Value |
|---|---|
| Category | Daily Operational |
| Purpose | Room states, priority queue, and DEFICIENT condition queue for housekeeping |
| Data sources | `Room` (physicalState), `DeficientConditionRecord`, `HandoffRecord` (H2), `WorkOrder`, `WorkOrderToDoItem` |
| Key fields | Room number; physical state; DEFICIENT flag and condition description; assigned housekeeping staff; priority (DEFICIENT rooms first, then standard); work orders pending |
| Filter parameters | Room type; physical state; DEFICIENT flag |
| Output format | Priority-sorted tabular list; DEFICIENT condition queue surfaced at top |
| Access authority | Front Desk, FOM, GM |
| Notes | DEFICIENT condition queue shows conditions with resolution deadline. Rooms with conditions approaching deadline surfaced prominently. |

---

**Report D-05: Pre-Arrival Readiness Report**

| Field | Value |
|---|---|
| Category | Daily Operational |
| Purpose | Pending pre-arrival tasks per expected arrival within the pre-arrival window |
| Data sources | `Entry` (currentStage S4/S5, arrivalDate), `HandoffRecord` (H1), `Reservation`, `GuestProfile`, `WorkOrderToDoItem` |
| Key fields | Guest name; arrival date/time; room; pending tasks (advance payment reconciliation, H1 acceptance status, VIP prep, DEFICIENT condition acknowledgement); pre-arrival completion percentage |
| Filter parameters | Arrival date range (defaults to today + pre-arrival window); completion status |
| Output format | Tabular list by arrival date, with pending task breakdown per entry |
| Access authority | Front Desk, FOM, GM |

---

### Financial Reports

---

**Report D-06: Revenue Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Revenue breakdown by room type, source channel, rate plan, and period |
| Data sources | `FolioLine` (revenue lines), `Entry`, `Segment`, `Reservation`, `RatePlanRecord` (or equivalent) |
| Key fields | Total revenue; breakdown by room type; breakdown by source channel; breakdown by rate plan type; comparison to prior period (if prior period selected) |
| Filter parameters | Date range (required); room type; rate plan type; source channel |
| Output format | Summary with breakdown tables; exportable |
| Access authority | FOM, GM, Admin |

---

**Report D-07: Outstanding Payments Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Aging analysis of outstanding payment obligations by source and client tier |
| Data sources | `PaymentRecord`, `Invoice` (outstanding status), `GuestProfile`, `Entry` (currentStage S9) |
| Key fields | Guest / client name; invoice amount; outstanding amount; days outstanding (aging buckets: 0–30, 31–60, 61–90, 90+); client tier; source channel |
| Filter parameters | Aging bucket; client tier; source channel; date range |
| Output format | Aging tabular report, sortable by days outstanding |
| Access authority | FOM, GM, Admin |

---

**Report D-08: Commission-Due Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Commission-due record status by engagement and agent |
| Data sources | `CommissionDueRecord`, `GuestProfile` (agent), `Entry`, `Invoice` |
| Key fields | Agent name; engagement ID; commission calculated; commission settled; settlement status; RATE_MISSING flag (prominently surfaced) |
| Filter parameters | Agent; settlement status; date range; RATE_MISSING filter |
| Output format | Tabular list by agent, with settlement status summary |
| Access authority | FOM, GM, Admin |
| Activation condition | Report is empty/inactive when no agent profiles have a commission rate configured. Report activates automatically when at least one commission rate is configured on any agent profile. Activation state is shown in the report header. |

---

**Report D-09: FOC Utilisation Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | FOC entitlement utilisation per client per period vs entitlement |
| Data sources | `Entry`, `FolioLine` (FOC lines), `GuestProfile` (client tier and entitlement) |
| Key fields | Client name; tier; FOC entitlement (rooms, F&B, packages); FOC utilised (rooms, F&B, packages); utilisation percentage; entitlement remaining |
| Filter parameters | Date range; client tier; client name |
| Output format | Tabular entitlement vs utilisation; per-client breakdown |
| Access authority | FOM, GM, Admin |

---

**Report D-10: GST / BST Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Tax collected, remitted, and reconciliation summary |
| Data sources | `FolioLine` (tax lines), `Invoice`, `PaymentRecord` |
| Key fields | Total tax collected by category; total tax remitted; reconciliation delta; breakdown by tax type (GST, BST) |
| Filter parameters | Date range (required); tax type |
| Output format | Reconciliation summary with itemised detail |
| Access authority | GM, Admin |

---

**Report D-11: Commercial Adjustment Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | All GM-level commercial adjustments with reasons |
| Data sources | `CommercialAdjustmentEntry`, `Entry`, `TraceEvent` (actor attribution) |
| Key fields | Adjustment date; actor (GM); entry ID; guest name; adjustment type; adjustment amount; reason (mandatory); approved by |
| Filter parameters | Date range; actor; adjustment type |
| Output format | Tabular list with mandatory reason column |
| Access authority | GM, Admin |

---

**Report D-12: Periodic Billing Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Apartment-mode cycle settlement summary |
| Data sources | `Entry` (APARTMENT use type), `FolioLine` (periodic settlement lines), `Invoice` (periodic) |
| Key fields | Apartment/guest name; billing cycle; charges posted in cycle; settlement amount; settlement status; outstanding balance |
| Filter parameters | Date range; billing cycle; settlement status |
| Output format | Tabular per-cycle breakdown |
| Access authority | FOM, GM, Admin |

---

**Report D-13: Credit Ceiling Utilisation Report**

| Field | Value |
|---|---|
| Category | Financial |
| Purpose | Engagements where credit ceiling was monitored, threshold events, and final balance vs ceiling |
| Data sources | `CreditExtensionCeilingRecord`, `CreditCeilingThresholdEvent`, `Entry`, `GuestProfile` |
| Key fields | Guest / client name; ceiling amount; 75% threshold event (date, balance); 90% threshold event (date, balance); final balance; final balance vs ceiling; ceiling breach indicator |
| Filter parameters | Date range; ceiling breach status; client tier |
| Output format | Tabular list with threshold event timeline per entry |
| Access authority | FOM, GM, Admin |

---

### Management Reports

---

**Report D-14: Agent Performance Report**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Revenue, volume, payment discipline, and tier movement per agent |
| Data sources | `Entry`, `GuestProfile` (agent), `CommissionDueRecord`, `PaymentRecord` |
| Key fields | Agent name; engagement count; total revenue; commission earned; commission collected; payment discipline score; tier changes in period |
| Filter parameters | Date range; agent; tier |
| Output format | Tabular per-agent summary |
| Access authority | FOM, GM, Admin |

---

**Report D-15: Overbooking History**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Frequency, cause, resolution, and cost of overbooking events |
| Data sources | `OtaConflictOverbookingRecord`, `Entry`, `TraceEvent` |
| Key fields | Date; cause (DELIBERATE vs OTA_CONFLICT); room type; resolution action; resolution cost (relocation, FOC, compensation); resolution time |
| Filter parameters | Date range; cause type |
| Output format | Tabular list with cost summary |
| Access authority | FOM, GM, Admin |

---

**Report D-16: Dispute and Service Recovery Report**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Frequency, category, resolution time, and compensation cost of disputes and service recovery events |
| Data sources | `DisputeRecord`, `ServiceRecoveryRecord`, `FolioLine` (compensation lines), `TraceEvent` |
| Key fields | Date; dispute/recovery category; stage at opening; resolution time; resolution type; compensation cost; actor (FOM/GM) who resolved |
| Filter parameters | Date range; category; stage; resolution type |
| Output format | Tabular list with category summary and average resolution time |
| Access authority | FOM, GM, Admin |

---

**Report D-17: No-Show Report**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Frequency, financial impact, source, and folio disposition of no-show events |
| Data sources | `NoShowDeterminationRecord`, `Folio` (NO_SHOW_CLOSED status), `PaymentRecord`, `Entry` |
| Key fields | Date; guest name; source channel; no-show determination actor (FOM); advance payment collected; penalty applied; refund owed; folio status |
| Filter parameters | Date range; source channel; folio disposition |
| Output format | Tabular list with financial impact summary |
| Access authority | FOM, GM, Admin |

---

**Report D-18: Dwell Time and SLA Compliance**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Time spent per stage, per mode, and SLA compliance rates |
| Data sources | `TraceEvent` (stage transition events), `Entry`, `Segment` |
| Key fields | Stage; mode; average dwell time; median dwell time; SLA threshold; SLA compliance rate; escalation rate |
| Filter parameters | Date range; stage; mode; use type |
| Output format | Summary table with per-stage breakdown; SLA compliance percentage |
| Access authority | FOM, GM, Admin |

---

**Report D-19: Cancellation Report**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Frequency, stage, financial impact, and source of cancellation events |
| Data sources | `Entry` (CANCELLED status), `FolioLine` (cancellation penalty lines), `TraceEvent` |
| Key fields | Date; stage at cancellation; source channel; cancellation reason; penalty applied; refund owed; net financial impact |
| Filter parameters | Date range; stage; source channel |
| Output format | Tabular list with financial impact summary |
| Access authority | FOM, GM, Admin |

---

**Report D-20: Group Booking Summary**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | Size, revenue, FOC utilisation, and billing split summary for group bookings |
| Data sources | `Entry` (GROUP use type), `FolioLine`, `GuestProfile` (group leader), `CommissionDueRecord` |
| Key fields | Group name; size; rooms; revenue; FOC entitlement and utilisation; billing split (individual vs master vs split); commission-due status |
| Filter parameters | Date range; group size |
| Output format | Tabular per-group summary |
| Access authority | FOM, GM, Admin |

---

**Report D-21: DEFICIENT Condition Report**

| Field | Value |
|---|---|
| Category | Management |
| Purpose | DEFICIENT conditions detected, resolution time, unresolved at checkout rate, and guest compensation incidents |
| Data sources | `DeficientConditionRecord`, `Room`, `TraceEvent`, `FolioLine` (compensation lines where DEFICIENT-related) |
| Key fields | Room; condition description; detection date; resolution date; resolution time; resolved before checkout (yes/no); guest compensation (amount and type) |
| Filter parameters | Date range; room; resolution status |
| Output format | Tabular list with summary statistics (average resolution time, unresolved at checkout rate, total compensation cost) |
| Access authority | FOM, GM, Admin |

---

### Governance Reports

---

**Report D-22: Audit Trail Query**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Point-in-time audit trail query per entity, actor, or date range |
| Data sources | `TraceEvent` (primary), all operational models (for entity resolution) |
| Key fields | Timestamp; actor (name and level); entity type; entity ID; operation; event type; payload summary; stage context |
| Filter parameters | Entity type and ID; actor (name or level); date range; event type; operation |
| Output format | Chronological event list, filterable; exportable |
| Access authority | GM, Admin |
| Notes | Read-only query surface. No export of personally identifiable data beyond what is required for audit interpretation. |

---

**Report D-23: Escalation Frequency Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Frequency analysis of escalated controls — which controls are escalated most often |
| Data sources | `TraceEvent` (ESCALATE operation events), policy enforcement events |
| Key fields | Control name (policy or guard); escalation count; escalation rate vs invocation rate; most common escalation actor level; most recent escalation date |
| Filter parameters | Date range; policy class; actor level |
| Output format | Ranked list by escalation frequency with percentage breakdown |
| Access authority | GM, Admin |

---

**Report D-24: Configuration Change Log**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | What was changed, by whom, and when — for all Admin Console configuration surfaces |
| Data sources | `ConfigurationEntry` (change history), `TraceEvent` (configuration change events), actor registry |
| Key fields | Change timestamp; surface (canonical name); field changed; old value; new value; actor (Admin level); reason (if required by surface) |
| Filter parameters | Date range; surface; actor |
| Output format | Chronological change log; exportable |
| Access authority | GM, Admin |

---

**Report D-25: Shift Handover Completeness Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Shift handover completion status and outstanding items |
| Data sources | `HandoffRecord`, `TraceEvent` (shift-change events), `Entry` (open at shift change) |
| Key fields | Shift date; outgoing actor; incoming actor; open entries at shift change; handover accepted (yes/no); outstanding items not transferred |
| Filter parameters | Date range; actor |
| Output format | Per-shift summary with outstanding item list |
| Access authority | FOM, GM, Admin |

---

**Report D-26: Communication Acknowledgement Status Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Acknowledgement status of all material communications |
| Data sources | `CommunicationRecord`, `TraceEvent` (acknowledgement events) |
| Key fields | Communication date; type (quotation, confirmation, amendment, PI); recipient; acknowledgement status; acknowledgement timestamp (or TIMED_OUT timestamp); open loop flag |
| Filter parameters | Date range; communication type; acknowledgement status |
| Output format | Tabular list with open-loop communications surfaced at top |
| Access authority | Front Desk, FOM, GM, Admin |

---

**Report D-27: FOM Override Frequency Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Dispute gate override frequency per FOM actor, with pattern flagging |
| Data sources | `DisputeGateOverrideRecord`, `TraceEvent` (override events) |
| Key fields | FOM actor name; override date; target stage (S7→S8 or S8→S9); override reason; override count in rolling period; pattern flag (threshold exceeded indicator) |
| Filter parameters | Date range; FOM actor; target stage |
| Output format | Per-actor override history with rolling frequency summary and pattern flag |
| Access authority | GM, Admin |
| Notes | Pattern flagging threshold configurable (factory default: 5 overrides in 30-day rolling window). |

---

**Report D-28: Session Management Event Log**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Idle lock events, hard logout events, and manual lock events by role |
| Data sources | `SessionEventRecord`, actor registry |
| Key fields | Event timestamp; actor; role; event type (IDLE_LOCK, HARD_LOGOUT, MANUAL_LOCK, PIN_REAUTH); terminal or workstation ID |
| Filter parameters | Date range; actor; event type; role |
| Output format | Chronological event log; filterable |
| Access authority | GM, Admin |

---

**Report D-29: AI Audit Supplement Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | Daily AI audit observations with confidence levels, FOM/GM review status, and pattern discovery log |
| Data sources | `AiDraftRecord`, `TraceEvent` (AI actor events), review status records |
| Key fields | Observation date; observation type; confidence level; review status (addressed / dismissed with reason / escalated); reviewed by (FOM or GM); pattern discovery entries (observations that led to new hardcoded audit rules) |
| Filter parameters | Date range; confidence level; review status; observation type |
| Output format | Daily observation list with review status column; pattern discovery log section |
| Access authority | FOM, GM |
| Notes | Pattern discovery log is append-only. Observations that escalated to new hardcoded audit rules are marked with the rule they contributed to. |

---

**Report D-30: GM Dispute Gate Override Report**

| Field | Value |
|---|---|
| Category | Governance |
| Purpose | All DisputeGateOverrideRecord entries by actor, target stage, reason, and date range — with frequency, stage distribution, and reason pattern analysis for Architect and GM governance review |
| Data sources | `DisputeGateOverrideRecord`, `TraceEvent` (override events), actor registry |
| Key fields | Override date; actor (FOM who exercised override); entry ID; guest name; target stage (S7→S8 or S8→S9); override reason (mandatory, recorded at time of override); dispute state at time of override; outcome (entry resolved / still active / escalated to GM) |
| Filter parameters | Date range; actor; target stage; reason pattern (text search) |
| Output format | Tabular entry list with summary section: frequency by period, stage distribution (S7→S8 vs S8→S9 split), reason category analysis, actor breakdown |
| Access authority | GM, Admin |
| Notes | v2.3 addition (REV-B11-V23-12). Primary source: `DisputeGateOverrideRecord`. This report specifically supports GM governance review and Architect pattern analysis. Reason patterns should be groupable for trend analysis. |

---

## Backfill Registry

The following items require backfill to prior DEV-SPEC parts before the corresponding gate assertions can be fully certified. Items in this registry are carried forward from prior gates and from the open items identified at Gate 13.

| # | Category | Target Part | Target Section | Change Required | Blocking? |
|---|---|---|---|---|---|
| P4 | A — Non-blocking additive | DEV-SPEC-001-Part2.md | §2.17.3 | Add `ai.correctionLog.maximumSize` configuration key to the AI configuration surface. This is an additive change to an existing section. | No — additive; Schema Gate (§13.2) cannot be fully certified until this key is added and the migration is re-run. |
| B4-001 | B — Requires Architect decision | DEV-SPEC-001-Part2.md; DEV-SPEC-001-Part9.md | Part 2: `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem` models; Part 9 §9.2.3 | Add `version Int @default(1)` to the four named models for optimistic locking. Complete the §9.2.3 concurrent editing middleware section with the full optimistic lock mechanism. | Does not block Gate 13. Requires Architect deliberation before implementation. |

**Confirmed resolved — not carried:**

| Item | Resolution |
|---|---|
| P5 | Closed at Gate 6 (MOM-ARCH-2026-015). GuestProfileService (§6.5.11) and SpaceAllocationService (§6.5.12) written and locked. |
| B9-001 | Closed at Gate 6 (MOM-ARCH-2026-015). Amendment routing Model C hybrid applied in §6.6.2. |

---

*Prepared by Claude (AI Architectural Partner)*
*Gate 13 — Acceptance Gates and Appendices A–D (Final Gate)*
*08 April 2026*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until Architect confirms.*
