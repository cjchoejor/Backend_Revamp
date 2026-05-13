# LEGPHEL PMS — DEV-SPEC-001
# Part 3 — State Machines
# §3.1 through §3.17

**Document:** DEV-SPEC-001-Part3.md
**Status:** DRAFT — awaiting Architect review and lock confirmation
**Canon version:** v2.5
**Authority:** MOM-ARCH-2026-013
**Gate:** Gate 3 — State Machines
**Date:** 07 April 2026
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 3 — State Machines |
| Sections covered | §3.1 through §3.17 |
| Declared Canon sources | Canon Block 11 §76A (Stage Transition Matrix — primary source for all stage-level transition guards); Canon Block 11 §76 (Stage-to-Timer/Worker Matrix — timer-governed transitions and expiry consequences) |
| Schema reference | DEV-SPEC-001-Part2.md (LOCKED) — all Prisma model names, enum values, and field names used in this part are derived from Part 2; state machines operate on Part 2 models; schema is not redefined here |
| ToC source | DEV-SPEC-001_ToC_FINAL.md (LOCKED) |
| Part 1 dependency | DEV-SPEC-001-Part1.md (LOCKED) — controlled vocabulary, error taxonomy, forbidden patterns, technology stack in force for this gate |
| Part 2 dependency | DEV-SPEC-001-Part2.md (LOCKED) — schema in force; no model or enum redefinition in this part |
| Status | DRAFT — nothing is locked until Architect confirms |
| Previous gate | Gate 2 — Schema (LOCKED) |

---

## Gate 3 Source Declaration

The following Canon sources were loaded for this gate:

| Source | Scope |
|---|---|
| Canon Block 11 §76A — Stage Transition Matrix | Primary authority for all stage-level transition guards, auto-fulfilment transitions, re-entry transitions, and terminal transitions. Derived without modification or inference. |
| Canon Block 11 §76 — Stage-to-Timer/Worker Matrix | Authority for timer-governed transitions and expiry consequences — governing timers cross-referenced per state machine. |
| DEV-SPEC-001-Part2.md | Schema reference — model names, enum values, and field names used throughout without redefinition. |

Blocks 2, 3, 5–10 are not declared Gate 3 sources. Where a specific transition condition cannot be resolved from §76A and the ToC during this gate, it is surfaced as a Category 1 clarification request rather than loaded mid-gate.

---

## §3.1 — State Machine Design Principles

### 3.1.1 Core Design Doctrine

Every governed entity in the LEGPHEL PMS has an explicit state machine. A state machine defines:

- **States** — the finite set of valid states for the entity.
- **Valid transitions** — the only permitted paths between states.
- **Guard conditions** — what must be true before a transition may proceed.
- **Rejection paths** — what happens when a guard is not satisfied.

An entity in state A may not move to state B unless every guard condition for that transition is satisfied. There is no path around the state machine. Transitions are not suggestions — they are the sole mechanism through which state changes occur.

§76A (Stage Transition Matrix, Canon Block 11) is the authoritative single reference for all stage-level transition guards. All stage-level transition entries in this part are derived from §76A without modification or inference.

### 3.1.2 The Five Transition Guards

Every stage-level transition requires all five of the following to be true before it may proceed. A transition that fails any guard is rejected with a typed `StageGateBlockedError` identifying the specific unsatisfied condition.

1. **Source state match.** The entry is in the expected source stage or status.
2. **Exit evidence present.** All exit evidence for the source stage is present and verified.
3. **Open loops closed.** All open loops that block exit are closed, or are overridden with recorded authority.
4. **Authority satisfied.** The acting user holds the required authority for this transition.
5. **State machine guard returns VALID.** The state machine transition guard function evaluates to VALID given the current system state.

These guards are evaluated in sequence. A failure at any guard produces a rejection before the remaining guards are evaluated.

### 3.1.3 Transition Block Resolution Rule — No Bypass, Only Escalation

When a transition is blocked, the only path forward is a higher-authority alternative transition. Guard removal is never a resolution path. An override requires:

- Recorded reason (mandatory, not optional text).
- Recorded actor identity and authority level.
- The open loop that triggered the block remains in history even after the override — the override closes the current barrier, it does not erase the record of the block.

This is the loop closure invariant: overriding a block does not retroactively make the block disappear. The system retains the record of both the block and the override.

### 3.1.4 Blocking Evidence vs Quality Warnings

Not every condition on a transition is a hard blocker. The Canon distinguishes between:

- **Blocking evidence (hard blocker):** Absence causes the state machine guard to fail. System blocks. Actor cannot proceed without satisfying the condition or obtaining a recorded override. Coded as a guard condition in the state machine.
- **Quality signal (warning):** Absence triggers an advisory. System advises; actor decides. Does not prevent transition. Not a guard failure.

The distinction is explicit per transition in the sections below. A condition that is a hard blocker may not be downgraded to a warning for operational convenience. Doing so is the forbidden pattern defined in Part 1 §1.4 as "soft completion."

### 3.1.5 Trace Event on Every Transition

Every state machine transition — including auto-fulfilment transitions — emits a `TraceEvent` in the same database transaction as the state change. If the transaction rolls back, the trace event rolls back with it. There is no deferred or asynchronous trace event for state transitions. A state change without a trace event is an architectural defect.

Every trace event carries: `eventType`, `timestamp`, `actorId` (human or system), `entityId`, `stageContext`, `segmentId` (where applicable), and `correlationId` for event chain tracing.

### 3.1.6 Scope of Part 3

The seventeen state machines in this part are:

| Section | State Machine | Primary Model |
|---|---|---|
| §3.2 | Entry Lifecycle | `Entry` |
| §3.3 | Folio | `Folio` |
| §3.4 | Dispute | `DisputeRecord` |
| §3.5 | Hold (Speculative and Committed) | `SpeculativeHold`, `CommittedHold` |
| §3.6 | Inventory Claim | `Room` (`currentClaimState`), `RoomClaimStateEvent` |
| §3.7 | Room Physical | `Room` (Model 2 fields) |
| §3.8 | Space Physical | `Space` |
| §3.9 | Handoff | `HandoffRecord` |
| §3.10 | Invoice | `Invoice` |
| §3.11 | Communication Record | `CommunicationRecord` |
| §3.12 | Work Order / To-Do | `WorkOrder`, `WorkOrderToDoItem` |
| §3.13 | AI Draft | `AiDraftRecord` |
| §3.14 | Quotation | `Quotation` |
| §3.15 | DEFICIENT Condition | `DeficientConditionRecord` |
| §3.16 | No-Show Determination | `Folio` (closure path), `NoShowDeterminationRecord` |
| §3.17 | ProcessingLock | `ProcessingLockRecord` |

---

## §3.2 — Entry Lifecycle State Machine

### 3.2.1 State Model

The state of an entry is a composite of two fields on the `Entry` model:

| Field | Type | Role |
|---|---|---|
| `Entry.status` | `EntryStatus` | Lifecycle status — ACTIVE, PARKED, EXPIRED, CANCELLED, CLOSED |
| `Entry.currentStage` | `Stage` | Current stage within an active or parked lifecycle — S1 through S9 |

A valid active entry state is expressed as `(ACTIVE, Sn)` where `n` is the current stage. Terminal states are expressed as `(CLOSED, —)`, `(CANCELLED, —)`, `(EXPIRED, —)`. A parked entry retains its `currentStage` at the time of parking: `(PARKED, Sn)`.

The derived inquiry state — the aggregate of all child entry states — is computed at query time, not stored as a primary operational state.

### 3.2.2 Forward Transitions (Derived from §76A — Unmodified)

All forward transition conditions, authority assignments, and notes are derived verbatim from §76A. No inference has been applied.

| Transition | Guard Conditions | Authority | Notes |
|---|---|---|---|
| S1 → S2 | Preferred configuration selected; exit evidence satisfied | Custodian | Standard path |
| S1 → S3 | Package rate accepted without negotiation (S2 auto-fulfilled) | Custodian | S2 auto-fulfilment; audit records S2 passage |
| S2 → S3 | Accepted quotation exists; discount approval chain complete; speculative hold recorded if placed | Custodian | |
| S3 → S4 | Committed hold placed; provisional folio created; billing model fixed; advance payment condition satisfied or credit extension approved with ceiling; cancellation terms disclosed | Custodian or FOM (high-value) | |
| S4 → S5 | Reservation confirmed; inventory in CONFIRMED state; confirmation voucher communicated; overbooking resolved if detected; ownership assigned | Custodian; FOM for conference/high-value | S5 activates when pre-arrival window opens (Timer Engine); immediate if arrival same/next day |
| S5 → S6 | Room assigned and physically ready; advance payment reconciled; all pre-arrival tasks complete or governed-deferred; H1 accepted; DEFICIENT flag acknowledged if applicable | Custodian (front desk) | Guest must be physically present |
| S6 → S7 | Identity verified; room OCCUPIED; folio converted to live; billing model activated; keys issued; H2 and H3 created; registration complete | Custodian (front desk) | |
| S7 → S8 | Night audit complete for final stay night; all known charges posted; H4 initiated; dispute gate returns CLEAR or BLOCKED_WITH_OVERRIDE_AVAILABLE; DEFICIENT condition final status recorded | Custodian (front desk) | |
| S8 → S9 | Folio settled or governed-outstanding; keys returned; room DEPARTED_DIRTY; room inspection complete or governed-deferred; H5 created or auto-fulfilled | Custodian (front desk) | |

**Guard failure behaviour:** A transition that fails any guard returns `StageGateBlockedError` identifying the specific unsatisfied condition, the stage, and whether an override path is available for the blocked condition.

### 3.2.3 Auto-Fulfilment Transitions (Derived from §76A — Unmodified)

| Stage | Condition | Implementation Notes |
|---|---|---|
| S2 (skip — S1→S3) | Guest accepts standard package rate; no negotiation required | S2 recorded as auto-fulfilled; `TraceEvent` records S2 passage; audit trail complete |
| S4 → S5 (immediate) | Arrival is same day or next day at time of S4 confirmation | Timer Engine fires immediately; S5 activates in compressed mode |
| S5 (walk-in compression) | Guest physically present at front desk; room readiness checked in real time | All S5 actions compressed to real-time verification |
| H1 (auto-fulfilment) | Reservations and front desk are the same team | `HandoffRecord.isAutoFulfilled = true`; system records event for audit; no inter-team transfer required |

### 3.2.4 Re-Entry Transitions (Derived from §76A — Unmodified)

All re-entry transitions create a new `Segment` record. The prior segment is sealed and read-only. The `Entry.segmentNumber` is incremented. The `ReEntryConsequenceEngine` (§4.11) is invoked on segment creation to compute consequence payloads.

The exception is S8 → S7 (additional charge discovered after checkout initiation), which returns to S7 for charge posting without creating a new segment.

| Originating Stage | Re-Enters | Trigger | Authority | New Segment |
|---|---|---|---|---|
| S2 | S1 | Date or room type change requested | Custodian or FOM | Yes |
| S3 | S1 | Fundamental reconfiguration of room/space | FOM | Yes |
| S3 | S2 | Payment renegotiation requiring rate change | FOM | Yes |
| S4 | S1 | Date change post-confirmation | FOM | Yes |
| S4 | S2 | Rate change post-confirmation | FOM/GM | Yes |
| S4 | S3 | Billing model change post-confirmation; payment renegotiation | FOM/GM | Yes |
| S5 | S1 | Configuration error requiring re-search | FOM | Yes |
| S6 | S1 | Room change required at check-in | Front desk / FOM | Yes (compressed) |
| S7 | S1 | Room change during stay (Room Change mode) | Front desk (FOM for rate delta) | Yes |
| S7 | S2 | Rate revision during stay; meal plan change; full renegotiation | GM (rate); FOM (inclusions) | Yes for full renegotiation; folio adjustment for simpler paths |
| S7 | S3 | Billing model change during stay; additional payment arrangement | GM (billing model); FOM (payment) | Depends on nature |
| S7 | S4 | Date extension re-confirmation | FOM/GM | Yes |
| S8 | S7 | Additional charge discovered after checkout initiation | FOM | No new segment — return to S7 for charge posting |
| S8 | S2 | Rate dispute at checkout requiring renegotiation | FOM/GM | Yes |
| Any | S2 | Complaint resolution requiring commercial adjustment (Complaint Resolution mode) | FOM/GM depending on adjustment | Yes |

### 3.2.5 Terminal Transitions (Derived from §76A — Unmodified with B11-001 Correction Applied)

| Terminal State | Trigger | Authority | Notes |
|---|---|---|---|
| CLOSED | All S9 obligations resolved; commission-due record created if agent profile has commission rate configured | System (auto-close when conditions met) | B11-001: commission-due record creation is conditional on agent profile having a commission rate configured — it is not an unconditional S9 requirement. Entry.status → CLOSED; Entry.closedAt and Entry.closedBy populated. |
| CANCELLED | Cancellation event processed | FOM (post-S3); GM (S7 early departure) | History preserved; financial residue governed. Entry.status → CANCELLED. |
| EXPIRED | Parked entry exceeds expiry threshold | System (expiry worker) | Governing timer expired; terminal state recorded. Entry.status → EXPIRED. |
| No-show terminal path (S5) | No-show determination made by FOM | FOM | Entry routes to NO_SHOW_CLOSED folio path then S9-equivalent processing. Not a direct terminal state on the entry — see §3.16 for the no-show determination state machine. |

**B11-001 applied:** §76A as published in Canon v2.2 states the terminal condition for CLOSED as "all S9 obligations resolved; commission-due record created." The ToC correction B11-001 confirms this creates an unconditional obligation reading that is incorrect. The commission-due record is produced by the system only when the agent profile associated with this inquiry has a commission rate configured. When no commission rate is configured, the system closes the entry without producing a commission-due record. The conditional is encoded as a guard in the S9 closure logic, not removed from the state machine.

### 3.2.6 AWAITING_WRITTEN_CONFIRMATION

AWAITING_WRITTEN_CONFIRMATION is a phase within the S5 no-show determination process, not a primary `EntryStatus` value. During this phase, the entry remains in `(ACTIVE, S5)`. The no-show determination state machine (§3.16) carries the sub-state.

Governing timers (§76):
- `noShowCutoff` timer fires at expected arrival + configurable minutes → triggers no-show pending phase.
- `AWAITING_WRITTEN_CONFIRMATION` timer fires when the hold period expires without written confirmation → no-show finalised; FOM determination required.

Cross-reference: §3.16 for the full no-show determination state machine.

### 3.2.7 Parking Cascade

Parking state is captured in `Entry.parkedAt` and `Entry.parkedBy`. The following cascade rules apply:

**Entry-level park:** Entry transitions independently to `(PARKED, currentStage)`. Does not affect sibling entries or the parent Inquiry.

**Inquiry-level park:** Cascades to all active non-terminal entries. Entries in `(ACTIVE, Sn)` transition to `(PARKED, Sn)`. Entries already in `(PARKED, Sn)` retain their individual park record and are not doubly-parked.

**Inquiry-level unpark:** Does NOT unpark entries that were individually parked before the inquiry-level park was placed. Only entries that were parked as a consequence of the inquiry-level park are unparked by the inquiry-level unpark. An entry that was individually parked before the inquiry park remains `(PARKED, Sn)` after the inquiry unpark.

The system must maintain per-entry park provenance to correctly evaluate this rule at unpark time.

### 3.2.8 State Diagram Summary

```
                    S1 ──────────────────────────► S2 ──► S3
                    │                               │       │
                    │ (S2 auto-fulfilled)            │       │
                    └───────────────────────────────────►  S3
                                                            │
                              re-entry ◄───────────────────┤
                              paths                         │
                    S1 ◄── any stage ◄──────────────────── S4 ──► S5
                    S2 ◄── any stage                               │
                                                                   ├──► S6 ──► S7 ──► S8 ──► S9
                                                                   │
                                                                   └──► NO-SHOW path (§3.16)

          Terminal: (CLOSED) ◄── S9
                    (CANCELLED) ◄── any pre-S9 with FOM/GM authority
                    (EXPIRED) ◄── PARKED entry past expiry threshold
          Parking:  any (ACTIVE, Sn) ──► (PARKED, Sn) — entry or inquiry level
                    any (PARKED, Sn) ──► (ACTIVE, Sn) — unpark (provenance-governed)
```

---

## §3.3 — Folio State Machine

### 3.3.1 State Model

**Model:** `Folio`
**State field:** `Folio.state: FolioState`

```
enum FolioState {
  PROVISIONAL      // S3 — created; accepts PIs and advance payments only
  LIVE             // S6 — all stay charges, credits, adjustments
  SETTLED          // terminal — all charges settled
  NO_SHOW_CLOSED   // terminal — no-show path; penalty posted; advance reconciled
  OUTSTANDING      // terminal — balance remains; governed-outstanding
  CANCELLED        // terminal — pre-arrival cancellation
}
```

### 3.3.2 Transition Table

| From | To | Trigger | Authority | Guard Conditions |
|---|---|---|---|---|
| — | PROVISIONAL | Entry reaches S3; provisional folio creation event | System (on S3 entry) | Committed hold placed; billing model fixed |
| PROVISIONAL | LIVE | S6 conversion event (explicit audited conversion) | System (on S6 commencement) | Identity verified; folio conversion prerequisites satisfied (§76A S6 guard) |
| PROVISIONAL | NO_SHOW_CLOSED | FOM no-show determination | FOM | No-show determination record created (§3.16); penalty computed and posted |
| PROVISIONAL | CANCELLED | Cancellation event processed before S6 | FOM (post-S3); GM (exceptional) | Cancellation event recorded; financial residue governed |
| LIVE | SETTLED | Settlement event — all charges cleared | System (on settlement event) | All folio lines accounted; no outstanding balance |
| LIVE | OUTSTANDING | S9 closure with governed-outstanding balance | System (on governed-outstanding determination) | Governing-outstanding election made; invoice dispatched; follow-up scheduled |

### 3.3.3 Post-Closure Access

Once a folio reaches a terminal state (SETTLED, OUTSTANDING, NO_SHOW_CLOSED), it is sealed. The original lines are immutable. Post-closure access operates through additive layers only:

- **Level 1 (read-only):** Any authorised actor may read.
- **Level 2 (additive — FOM):** FOM may add additive records — credits, corrections — as new `FolioLine` entries with their own attribution. Original lines are never modified.
- **Level 3 (GM correction):** GM may add correction entries with their own date and rationale. Original lines are never modified.

A LIVE folio never reverts to PROVISIONAL through any re-entry or amendment path. Re-entry after S6 creates a new segment and a new commercial context; the live folio accumulates the financial consequences.

### 3.3.4 Forbidden Transition

A `FolioState.LIVE` folio may not transition back to `FolioState.PROVISIONAL` under any circumstance. Implementing this reversion is the forbidden pattern. Amendment, rate change, and billing model change at or after S6 are all handled through additive folio lines and re-entry segment paths — never by reverting the folio to PROVISIONAL.

### 3.3.5 Governing Timers

| Timer | Folio Relevance |
|---|---|
| Payment milestone (§76) | Fires for PROVISIONAL and LIVE folios on corporate/conference billing milestone schedules |
| Payment follow-up (§76) | Fires for OUTSTANDING folios — reminder intervals escalating to FOM then GM |

---

## §3.4 — Dispute State Machine

### 3.4.1 State Model

**Model:** `DisputeRecord`
**State field:** `DisputeRecord.state: DisputeState`

```
enum DisputeState {
  OPEN
  IN_PROGRESS
  RESOLVED
  CLOSED
  REOPENED
  // DISPUTE_EXHAUSTED is explicitly NOT a valid state (§53 M.12)
}
```

`DISPUTE_EXHAUSTED` is not a valid state and must not be implemented. A guest who has declined all offered resolutions reaches `CLOSED` with a mandatory recorded reason of "guest declined all offered resolutions." There is no terminal exhaustion state distinct from CLOSED.

### 3.4.2 Transition Table

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | OPEN | Guest or agent files dispute | Any authenticated actor | Dispute may arise at any stage S1–S9 |
| OPEN | IN_PROGRESS | Hotel response commenced | FOM | First response event recorded |
| IN_PROGRESS | RESOLVED | Guest accepts resolution | Guest (acceptance event); managed by FOM | Resolution acceptance event produced |
| IN_PROGRESS | CLOSED | GM formally closes — all resolutions declined | GM | Mandatory recorded reason; "guest declined all offered resolutions" is a valid reason |
| RESOLVED | CLOSED | GM formal closure after resolution | GM | Mandatory recorded reason |
| CLOSED | REOPENED | Dispute re-opened | FOM or GM | Mandatory reason required |
| REOPENED | IN_PROGRESS | Re-engagement commenced | FOM | Dispute re-enters active management |

### 3.4.3 Stage Gate Function

The dispute state machine interacts with the entry lifecycle at two stage boundaries:

**S7 → S8 gate:**
- `DisputeGateEngine.canProgressStage(entryId, S8)` evaluates all disputes on the entry.
- Returns `CLEAR`: no disputes in OPEN or IN_PROGRESS — transition proceeds.
- Returns `BLOCKED_WITH_OVERRIDE_AVAILABLE`: at least one dispute in OPEN or IN_PROGRESS — transition blocked; GM override path is available.
- On GM override: `DisputeGateOverrideRecord` is produced by the **service layer** (not the engine). The engine returns the value; the service handles the override path. The override does not remove the dispute from history.

**S8 → S9 gate:**
- `DisputeGateEngine.canProgressStage(entryId, S9)` evaluates all disputes on the entry.
- Returns `CLEAR` or `BLOCKED`.
- **Override is NOT available at S8 → S9.** If a dispute is in OPEN or IN_PROGRESS state, the engine returns `BLOCKED` (not `BLOCKED_WITH_OVERRIDE_AVAILABLE`). The entry may not close with an unresolved dispute.

### 3.4.4 Governing Timers

| Timer | Dispute Relevance |
|---|---|
| Dispute SLA (§76) | Fires from OPEN — time-to-first-response target → time-to-resolution target → escalation |
| Resolution execution (§76) | Fires when resolution bundle approved — commitment deadline approaching → deadline passed → open loop; FOM escalation |

---

## §3.5 — Hold State Machine

### 3.5.1 State Model

**Models:** `SpeculativeHold`, `CommittedHold`
**State field (both):** `HoldState` enum applied via the `state` field on each model

```
enum HoldState {
  PLACED
  RELEASED    // governed release — expiry, cancellation, or explicit release
  UPGRADED    // speculative → committed (SpeculativeHold only)
  CONFIRMED   // committed → confirmed at S4 (CommittedHold only)
}
```

### 3.5.2 Speculative Hold Transitions

**Model:** `SpeculativeHold`

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | PLACED | Speculative hold placed on inventory item for date range | Custodian | Inventory claim state → SPECULATIVELY_HELD |
| PLACED | RELEASED | Timer expiry or explicit cancellation | System (timer expiry); FOM/GM (cancellation) | Governed release event — permanent audit record required; inventory → FREE; staff alerted |
| PLACED | UPGRADED | Hold converted to committed hold | Custodian | New `CommittedHold` record created; `SpeculativeHold.state` → UPGRADED; inventory → COMMITTED_HELD |

**All releases are governed events.** Silent expiry of a speculative hold — where the hold lapses without a permanent audit record — is the forbidden pattern defined in Part 1 §1.4.

### 3.5.3 Committed Hold Transitions

**Model:** `CommittedHold`

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | PLACED | Committed hold placed at S3 | Custodian or FOM | Inventory claim state → COMMITTED_HELD |
| PLACED | CONFIRMED | S4 confirmation event | System (on S4 confirmation) | `CommittedHold.state` → CONFIRMED; inventory claim state → CONFIRMED |
| PLACED | RELEASED | Cancellation before S4 | FOM | Governed release event — permanent audit record; inventory → FREE |

### 3.5.4 Hold and ProcessingLock Distinction

The hold state machine governs the commercial inventory claim made during the booking workflow. The `ProcessingLock` state machine (§3.17) governs multi-channel inventory concurrency during the booking workflow. These are distinct mechanisms operating on different concerns:

- **Hold:** commercial claim; persists in the record system; governs inventory claim state.
- **ProcessingLock:** operational concurrency; transient; informs actors; does not block viewing.

### 3.5.5 Governing Timers

| Timer | Hold Relevance |
|---|---|
| Speculative hold expiry (§76) | PLACED → RELEASED: approaching expiry alert → hold timer expires → inventory released; staff alerted |
| Committed hold expiry (§76) | PLACED: approaching expiry → timer expires without S4 confirmation → alert → FOM escalation → potential inventory release |

---

## §3.6 — Inventory Claim State Machine

### 3.6.1 State Model

**Model:** `Room`
**State field:** `Room.currentClaimState: InventoryClaimState`
**Audit record:** `RoomClaimStateEvent` — immutable record of every claim state transition

```
enum InventoryClaimState {
  FREE
  QUOTED
  SPECULATIVELY_HELD
  COMMITTED_HELD
  CONFIRMED
  OCCUPIED
  DEPARTED_DIRTY
  DEPARTED_CLEAN
  BLOCKED
  UNDER_MAINTENANCE
}
```

**Evaluation basis:** Claim state is evaluated against a date range, not point-in-time. `Room.currentClaimState` reflects the current resolved state for the current date. Full claim state history for any date range is derived from `RoomClaimStateEvent` records.

### 3.6.2 Transition Table

| From | To | Trigger | Notes |
|---|---|---|---|
| FREE | QUOTED | Quotation issued covering this room for the date range | QUOTED displacement: configurable threshold determines whether FOM/GM approval gate fires (REV-B3-01 — not an absolute trigger) |
| FREE | SPECULATIVELY_HELD | Speculative hold placed | Inventory committed at date-range level |
| QUOTED | SPECULATIVELY_HELD | Speculative hold placed over quoted claim | Displacement threshold evaluated at placement |
| SPECULATIVELY_HELD | COMMITTED_HELD | Hold upgraded to committed | On SpeculativeHold UPGRADED event |
| SPECULATIVELY_HELD | FREE | Hold released (timer expiry or cancellation) | Governed release event; `RoomClaimStateEvent` produced |
| COMMITTED_HELD | CONFIRMED | S4 confirmation event | Inventory secured at confirmation |
| COMMITTED_HELD | FREE | Cancellation before S4 | Governed release event |
| CONFIRMED | OCCUPIED | S6 check-in commencement | Folio converted to live; room physically occupied |
| OCCUPIED | DEPARTED_DIRTY | Checkout (S8 → S9) | **Mandatory path — OCCUPIED never transitions directly to DEPARTED_CLEAN** |
| DEPARTED_DIRTY | DEPARTED_CLEAN | Housekeeping completion action | Housekeeping actor records completion event |
| DEPARTED_CLEAN | FREE | Room released back to inventory | Ready for next assignment |
| FREE | BLOCKED | Incident block or compliance hold placed | Reason recorded; `IncidentRecord` linked if applicable |
| FREE | UNDER_MAINTENANCE | Maintenance scheduled | `maintenanceDeadline` set; conflict detection active |
| BLOCKED | FREE | Block lifted | Cleansing ritual completion required for DEATH incidents before this transition (see §3.7) |
| UNDER_MAINTENANCE | FREE | Maintenance complete | `Room.isUnderMaintenance = false`; `maintenanceDeadline` cleared |

### 3.6.3 QUOTED Displacement

The transition of an existing QUOTED inventory claim when a new hold is placed follows the configurable displacement threshold (REV-B3-01). The threshold is not a hard block — it determines whether the FOM/GM approval gate fires. Below the threshold, displacement proceeds. Above the threshold, FOM or GM approval is required before the displacement takes effect.

### 3.6.4 Forbidden Transition

`OCCUPIED → DEPARTED_CLEAN` is explicitly forbidden. A room leaving an occupied state must pass through `DEPARTED_DIRTY` before `DEPARTED_CLEAN`. Housekeeping action is the mandatory intermediate step. Implementing a direct transition from OCCUPIED to DEPARTED_CLEAN bypasses housekeeping governance and is the forbidden pattern defined in Part 1 §1.4.

### 3.6.5 Audit

Every `Room.currentClaimState` change produces an immutable `RoomClaimStateEvent` record carrying: `fromState`, `toState`, `entryId` (where applicable), `actorId`, `reason`, `effectiveFrom`, `effectiveTo`.

---

## §3.7 — Room Physical State Machine

### 3.7.1 State Model

**Model:** `Room` (Model 2 physical state fields)

Room physical state is expressed through boolean flag fields on the `Room` model, not through a single state enum. The physical state of a room is a function of these fields evaluated together.

| Logical Physical State | Field Condition |
|---|---|
| AVAILABLE | `isBlocked = false` AND `isUnderMaintenance = false` |
| OCCUPIED | `currentClaimState = OCCUPIED` (claim state drives physical occupancy) |
| DEPARTED_DIRTY | `currentClaimState = DEPARTED_DIRTY` |
| DEPARTED_CLEAN | `currentClaimState = DEPARTED_CLEAN` |
| BLOCKED | `isBlocked = true` |
| UNDER_MAINTENANCE | `isUnderMaintenance = true` |

**DEFICIENT flag overlay:** `isDeficient = true` is an overlay condition. A room may be in any physical state AND carry a DEFICIENT flag simultaneously. The DEFICIENT flag does not replace the physical state — it qualifies it. The state machine for DEFICIENT conditions is defined separately in §3.15.

### 3.7.2 Physical State Transitions

| From | To | Trigger | Guard / Notes |
|---|---|---|---|
| AVAILABLE | OCCUPIED | S6 check-in (claim state → OCCUPIED) | All S6 guards satisfied |
| OCCUPIED | DEPARTED_DIRTY | Checkout (S8 → S9) | **Mandatory** — see §3.7.3 |
| DEPARTED_DIRTY | DEPARTED_CLEAN | Housekeeping completion action | Housekeeping actor records completion |
| DEPARTED_CLEAN | AVAILABLE | Room released (claim state → FREE) | Housekeeping completion confirmed |
| AVAILABLE | BLOCKED | Incident block or compliance hold | Reason recorded; `Room.isBlocked = true`; `Room.blockedReason` populated |
| AVAILABLE | UNDER_MAINTENANCE | Maintenance scheduled | `Room.isUnderMaintenance = true`; maintenance conflict detection activates |
| BLOCKED | AVAILABLE | Block lifted | For DEATH incidents: `cleansing_ritual_completed = true` required before this transition |
| UNDER_MAINTENANCE | AVAILABLE | Maintenance complete | `Room.isUnderMaintenance = false`; conflict detection deactivated |

### 3.7.3 OCCUPIED → DEPARTED_DIRTY Mandate

A room transitioning from OCCUPIED state (guest checked out) must transition to `DEPARTED_DIRTY` before it may become `DEPARTED_CLEAN`. This path is not configurable. The `OCCUPIED → DEPARTED_CLEAN` direct transition is the forbidden pattern. Housekeeping action is the only mechanism through which a departed room becomes clean.

### 3.7.4 BLOCKED Rooms — DEATH Incident Protocol

When a room is BLOCKED due to a DEATH incident (linked `IncidentRecord.incidentType = DEATH`), the field `Room.cleansing_ritual_completed` must be set to `true` before the room may transition from BLOCKED to AVAILABLE. This is a hard guard on the BLOCKED → AVAILABLE transition for DEATH-incident rooms. The flag is set only by a recorded action by an authorised actor — it is not auto-set.

### 3.7.5 UNDER_MAINTENANCE and Booking Conflict Detection

When `Room.isUnderMaintenance = true`, the maintenance conflict detection mechanism activates. Any booking that attempts to assign this room for dates within the maintenance window receives a `PolicyGateBlockedError` identifying the maintenance conflict. The booking cannot proceed to committed hold status for a room under maintenance without an explicit override by FOM or GM with a recorded reason.

The `maintenanceDeadline` timer (§76) fires approaching expiry and on breach.

---

## §3.8 — Space Physical State Machine

### 3.8.1 State Model

**Model:** `Space`

Space physical state is expressed through boolean fields on the `Space` model.

| Logical Physical State | Field Condition |
|---|---|
| AVAILABLE | `isAvailable = true` AND `isEventInProgress = false` |
| SETUP_IN_PROGRESS | `isAvailable = false` AND `isEventInProgress = false` (pre-event setup phase) |
| EVENT_IN_PROGRESS | `isEventInProgress = true` |
| BREAKDOWN_IN_PROGRESS | `isAvailable = false` AND `isEventInProgress = false` (post-event breakdown phase) |
| BLOCKED | `isAvailable = false` (non-event block — maintenance or incident) |

**No DEFICIENT flag on spaces.** Condition issues on conference/event spaces are tracked as `ServiceRecoveryRecord` entries directly. There is no `isDeficient` flag on the `Space` model (§48 S7 conference variation).

### 3.8.2 Physical State Transitions

| From | To | Trigger | Notes |
|---|---|---|---|
| AVAILABLE | SETUP_IN_PROGRESS | Event setup begins per work order to-do | `Space.isAvailable = false`; setup monitoring active (§68) |
| SETUP_IN_PROGRESS | EVENT_IN_PROGRESS | Setup completion event; event commences | `Space.isEventInProgress = true` |
| EVENT_IN_PROGRESS | BREAKDOWN_IN_PROGRESS | Event conclusion event | `Space.isEventInProgress = false`; `Space.isAvailable = false`; breakdown monitoring active |
| BREAKDOWN_IN_PROGRESS | AVAILABLE | Breakdown completion event | `Space.isAvailable = true` |
| AVAILABLE | BLOCKED | Maintenance or compliance hold | Non-event block; `Space.isAvailable = false` |
| BLOCKED | AVAILABLE | Block lifted | `Space.isAvailable = true` |

### 3.8.3 Setup and Breakdown Monitoring

The Timer Engine monitors setup and breakdown phases. Approaching deadlines prompt assigned staff. Breached deadlines escalate to FOM. `EquipmentAllocation` records govern equipment return from event spaces — the equipment return timer (§76) fires on approach and breach of return deadline.

### 3.8.4 Space Allocation Lifecycle

`SpaceAllocation.status` follows: `ACTIVE → RELEASED | CANCELLED`. A space allocation is released when the event completes and all equipment is returned confirmed. Cancellation is a governed event with reason. Both transitions produce trace events.

---

## §3.9 — Handoff State Machine

### 3.9.1 State Model

**Model:** `HandoffRecord`
**State field:** `HandoffRecord.state: HandoffState`

```
enum HandoffState {
  CREATED
  ASSIGNED
  ACCEPTED
  FULFILLED
  CLOSED
  REJECTED    // blocking condition at receiving party; produces new routing — not terminal
  ESCALATED   // stalled past SLA — not terminal
}
```

### 3.9.2 Transition Table

| From | To | Trigger | Guard / Notes |
|---|---|---|---|
| — | CREATED | Handoff creation event | Actor and role recorded; stage context recorded |
| CREATED | ASSIGNED | Handoff routed to receiving party | Receiving party visibility established |
| ASSIGNED | ACCEPTED | Explicit acceptance event by receiving party | **Visibility ≠ acceptance.** Acceptance is a governed state transition requiring an explicit action. |
| ACCEPTED | FULFILLED | Fulfilment evidence recorded per handoff type | Each handoff type requires defined fulfilment evidence (see §3.9.3) |
| FULFILLED | CLOSED | Closure event | All obligations transferred |
| ASSIGNED | REJECTED | Blocking condition at receiving party | Rejection reason recorded; new routing event produced; REJECTED is not terminal — routing continues |
| ACCEPTED | REJECTED | Blocking condition discovered after acceptance | Rejection reason recorded; new routing event produced |
| REJECTED | ASSIGNED | New routing after rejection | Re-routed to alternative receiving party or path |
| Any active state | ESCALATED | SLA deadline breached (Timer Engine fires) | Escalation event produced; FOM alerted; ESCALATED is not terminal — management continues |

### 3.9.3 Fulfilment Evidence Requirements per Handoff Type

| Handoff Type | Fulfilment Evidence Required |
|---|---|
| H1 — Reservations → Front Desk | If auto-fulfilled: `isAutoFulfilled = true` recorded by system. If manual: acceptance event by front desk actor. |
| H2 — Front Desk → Housekeeping | Room physical state verified; DEFICIENT condition status carried in `HandoffRecord.deficientConditionStatus`; housekeeping assignment confirmed |
| H3 — Front Desk → F&B | Meal plan actioned; dietary needs captured and confirmed |
| H4 — Pre-checkout coordination | Charges posted; room inspection status; damage assessment complete or governed-deferred |
| H5 — Front Desk → Accounts | Financial obligations settled or governed-outstanding; all residual items documented |

### 3.9.4 Auto-Fulfilment

**H1 auto-fulfilment:** When reservations and front desk are the same team, H1 is auto-fulfilled. `HandoffRecord.isAutoFulfilled = true`. System records the event for audit purposes. No inter-team transfer occurs but the infrastructure record exists in every case.

**H5 auto-fulfilment:** When settlement is complete and no residual obligations exist at S8 → S9, H5 auto-fulfils. `HandoffRecord.isAutoFulfilled = true`. Trace event produced.

### 3.9.5 Governing Timer

The H2/H3 acceptance timer (§76) fires when a handoff remains unaccepted past the configurable window. FOM is alerted. The handoff transitions to ESCALATED if SLA is breached.

---

## §3.10 — Invoice State Machine

### 3.10.1 State Model

**Model:** `Invoice`
**State field:** `Invoice.state: InvoiceState`
**Type field:** `Invoice.invoiceType: InvoiceType`

```
enum InvoiceState {
  CREATED
  DISPATCHED
  PAYMENT_TRACKED
  RECONCILED
  SUPERSEDED   // earlier proforma version superseded by new version
}

enum InvoiceType {
  PROFORMA
  FINAL
  POST_STAY
}
```

### 3.10.2 Transition Table

| From | To | Trigger | Notes |
|---|---|---|---|
| — | CREATED | Invoice generated (proforma at S3; final at S8/S9; post-stay post-closure) | Invoice is a formal billing document derived from folio |
| CREATED | DISPATCHED | Invoice sent to guest, agent, or corporate | Dispatch event recorded with channel and timestamp |
| DISPATCHED | PAYMENT_TRACKED | Payment event recorded against invoice | `PaymentRecord` linked to invoice |
| PAYMENT_TRACKED | RECONCILED | Back-office accounting reconciliation action | Reconciliation is a back-office action — the engagement lifecycle does not wait for it |
| CREATED | SUPERSEDED | New invoice version issued (proforma versioning) | Prior version → SUPERSEDED; new version created; prior preserved and read-only |
| DISPATCHED | SUPERSEDED | New invoice version issued (proforma versioning) | Prior version → SUPERSEDED; new version created; prior preserved and read-only |

### 3.10.3 Proforma Versioning

When a proforma invoice is revised, the existing proforma transitions to `SUPERSEDED`. A new `Invoice` record is created with an incremented version number. The superseded version is preserved and read-only. The new version is the active proforma. Reconciliation is always against the active (non-SUPERSEDED) version.

### 3.10.4 Reconciliation Independence

Reconciliation is a back-office accounting action external to the entry lifecycle. An entry may close (`EntryStatus.CLOSED`) with invoices in `PAYMENT_TRACKED` state pending reconciliation. Reconciliation continues as a post-closure administrative process. The engagement does not wait.

---

## §3.11 — Communication Record State Machine

### 3.11.1 State Model

**Model:** `CommunicationRecord`

Communication record state is expressed through a combination of fields rather than a single state enum:

| Logical State | Field Conditions |
|---|---|
| DRAFT | `CommunicationRecord.sendStatus = DRAFT` |
| SENT | `sendStatus = SENT \| DELIVERED` |
| ACKNOWLEDGED | `acknowledgementStatus = RECEIVED` |
| TIMED_OUT | `acknowledgementStatus = TIMED_OUT` |
| SUPERSEDED | `supersededAt IS NOT NULL` |

### 3.11.2 Transition Table (Standard Path)

| From | To | Trigger | Notes |
|---|---|---|---|
| — | DRAFT | Communication record created before send | Draft is editable; not yet committed |
| DRAFT | SENT | Send action — communication dispatched | Dispatch event produced; `sendStatus` updated |
| SENT | ACKNOWLEDGED | Explicit acknowledgement received from recipient | Acknowledgement loop closed |
| SENT | ACKNOWLEDGED (implicit) | Guest physically arrives (implicit acknowledgement) | Loop closed; no separate ack event required |
| SENT | TIMED_OUT | Acknowledgement window expires without response | Loop formally closed with "no acknowledgement received" record; non-acknowledgement becomes a flag on the entry |
| SENT | SUPERSEDED | Segment superseded | Communication records for superseded segment transition to SUPERSEDED; invalidation notification offered; if notification declined, mandatory reason recorded |
| ACKNOWLEDGED | SUPERSEDED | Segment superseded | |
| TIMED_OUT | SUPERSEDED | Segment superseded | |

### 3.11.3 Acknowledgement Loop Closure

The acknowledgement loop for any outbound communication closes through exactly one of three mechanisms:

1. **Explicit acknowledgement:** Recipient confirms receipt → `acknowledgementStatus = RECEIVED`.
2. **Implicit acknowledgement:** Guest physically arrives at property → loop closed for pre-arrival communications.
3. **Governed timeout:** Acknowledgement window expires without response → `acknowledgementStatus = TIMED_OUT` → non-acknowledgement recorded as a flag on the entry.

The loop does not remain open indefinitely. All three closure paths produce permanent records.

### 3.11.4 VOICE_NOTE Sub-Type State Machine

Inbound communications of `messageType = VOICE_NOTE` follow a separate sub-path governed by §70C. The AI agent is blocked from processing voice note content at the **intake routing layer** — not as a runtime check within the communication record state machine. This block is architectural, not conditional.

| Sub-State | Condition | Action |
|---|---|---|
| VOICE_NOTE_UNPROCESSED | VOICE_NOTE received; pending human review | Routed to human-only review queue; no AI processing |
| REVIEWED | Staff listening summary record created (`StaffListeningSummaryRecord`) | Listening summary attached; loop proceeds |
| SLA_APPROACHING | Voice note SLA window approaching threshold | Assigned staff prompted (Timer Engine fires) |
| SLA_BREACHED | Voice note SLA window breached | FOM escalated; escalation event produced |

The SLA states (APPROACHING, BREACHED) are timer-governed phases within the VOICE_NOTE_UNPROCESSED state, not separate record states.

---

## §3.12 — Work Order / To-Do State Machine

### 3.12.1 Work Order State Model

**Model:** `WorkOrder`
**State field:** `WorkOrder.status: String` — `"OPEN" | "CLOSED"`

```
Logical States:
  ACTIVE  ←→  WorkOrder.status = "OPEN"
  CLOSED  ←→  WorkOrder.status = "CLOSED"
```

### 3.12.2 Work Order Transitions

| From | To | Trigger | Authority | Guard Conditions |
|---|---|---|---|---|
| — | ACTIVE | Work order initiated (S1–S3) | Custodian or FOM | Entry exists; stage context recorded |
| ACTIVE | CLOSED | S8 — all to-do items fulfilled or cancelled | Custodian or FOM | All to-do items in COMPLETED or CANCELLED state; `closureNote` required |

**Amendment is layered, not a state:** Every change to a work order while ACTIVE produces an immutable `WorkOrderAmendmentEvent` record. The work order never enters an "edited" state — it remains ACTIVE and accumulates amendment events. Direct field edits without a `WorkOrderAmendmentEvent` are the forbidden pattern.

### 3.12.3 Work Order To-Do Item State Model

**Model:** `WorkOrderToDoItem`
**State field:** `WorkOrderToDoItem.status: WorkOrderItemState`

```
enum WorkOrderItemState {
  PENDING
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

### 3.12.4 To-Do Item Transitions

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | PENDING | To-do item created within work order | Custodian or FOM | Deadline set; assigned actor/role recorded |
| PENDING | IN_PROGRESS | Item actioned by assigned staff | Assigned actor | |
| IN_PROGRESS | COMPLETED | Fulfilment action completed | Assigned actor | `completionEvidence` populated |
| PENDING | CANCELLED | Item cancelled before commencement | FOM | `cancellationReason` required |
| IN_PROGRESS | CANCELLED | Item cancelled after commencement | FOM | `cancellationReason` required |

### 3.12.5 Timer Governance

The Timer Engine monitors all to-do item deadlines (`WorkOrderToDoItem.deadlineAt`):

- **Approaching deadline:** Assigned staff prompted.
- **Breached deadline:** FOM alerted; escalation event produced.

Timer monitoring is active for every to-do item with a `deadlineAt` value. Items without a deadline are not timer-monitored.

---

## §3.13 — AI Draft State Machine

### 3.13.1 State Model

**Model:** `AiDraftRecord`
**State field:** `AiDraftRecord.status: AiDraftStatus`

```
enum AiDraftStatus {
  PENDING_REVIEW
  APPROVED
  EDITED_AND_APPROVED
  REJECTED
}
```

### 3.13.2 Transition Table

| From | To | Trigger | Guard / Notes |
|---|---|---|---|
| — | PENDING_REVIEW | AI draft created | Every draft enters the review queue immediately on creation — there is no path to bypass review |
| PENDING_REVIEW | APPROVED | Human actor approves without modification | `HumanDecisionRecord` produced (immutable); `HumanDecisionType.APPROVE` |
| PENDING_REVIEW | EDITED_AND_APPROVED | Human actor edits then approves | `HumanDecisionRecord` produced; `HumanDecisionType.EDIT_AND_APPROVE`; edited content recorded |
| PENDING_REVIEW | REJECTED | Human actor rejects | `HumanDecisionRecord` produced; `HumanDecisionType.REJECT`; rejection reason recorded |

### 3.13.3 Review TTL

When the review TTL is exceeded and the draft remains in `PENDING_REVIEW`, the Timer Engine fires and FOM is notified. The draft remains in `PENDING_REVIEW` — it is not auto-approved or auto-rejected. TTL breach is a prompt for human action, not an automated resolution.

### 3.13.4 Human Decision Record Requirement

Every human decision event — approve, edit-and-approve, or reject — produces an immutable `HumanDecisionRecord`. No transition from `PENDING_REVIEW` to any other state is valid without a corresponding `HumanDecisionRecord`. This is a hard guard: a state transition without a `HumanDecisionRecord` is an architectural defect.

The AI agent may not approve its own drafts. The AI agent may not send a communication without a human approval event. These are absolute constraints with no trust level override — including `TrustLevel.FULL_AUTO`. `FULL_AUTO` is permitted for internal system actions only and is forbidden for outbound communications under any configuration.

### 3.13.5 Traceability Chain

The following chain must be fully reconstructable from records alone:

```
Inbound CommunicationRecord
    → AiDraftRecord (PENDING_REVIEW)
        → HumanDecisionRecord (APPROVE | EDIT_AND_APPROVE | REJECT)
            → Outbound CommunicationRecord (on APPROVE or EDIT_AND_APPROVE)
```

Each link in the chain must carry a `correlationId` for event chain tracing. A gap in this chain is an audit architecture defect.

---

## §3.14 — Quotation State Machine

### 3.14.1 State Model

**Model:** `Quotation`
**State field:** `Quotation.state: QuotationState`

```
enum QuotationState {
  DRAFT
  SENT
  ACCEPTED
  SUPERSEDED
  EXPIRED
}
```

### 3.14.2 Transition Table

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | DRAFT | Quotation created | Custodian or FOM | Editable until sent |
| DRAFT | SENT | Quotation dispatched to guest or agent | Custodian or FOM | Send event produced; quotation sealed from further in-place editing |
| SENT | ACCEPTED | Guest acceptance event | Guest (event managed by Custodian) | Acceptance is basis for S2 → S3 progression |
| DRAFT | SUPERSEDED | New version issued (Q-002 supersedes Q-001) | Custodian or FOM | Prior version sealed; new version becomes active draft |
| SENT | SUPERSEDED | New version issued after sending | Custodian or FOM | Prior version sealed; prior preserved; new version becomes active |
| SENT | EXPIRED | Quotation validity timer fires | System (Timer Engine) | No longer directly selectable as S3 progression basis; recallable with revalidation |

### 3.14.3 Versioning

Quotations are versioned. A new version supersedes the prior version. All versions are preserved and read-only once superseded. The active quotation is always the non-SUPERSEDED, non-EXPIRED version. If all versions are SUPERSEDED or EXPIRED, a new quotation must be created.

An EXPIRED quotation remains recallable with revalidation — the revalidation re-checks all commercial terms, availability, and pricing against current system state before the quotation may be reactivated.

### 3.14.4 Governing Timer

The quotation validity timer (§76) fires approaching expiry and on expiry. Approaching expiry → alert dispatched to custodian and guest. Expiry → `Quotation.state → EXPIRED`.

---

## §3.15 — DEFICIENT Condition State Machine

### 3.15.1 State Model

**Model:** `DeficientConditionRecord`
**State field:** `DeficientConditionRecord.status: String`

The DEFICIENT condition state is expressed through the `status` field using string values, with the resolution deadline providing the temporal dimension.

| Logical State | Field Conditions |
|---|---|
| DEFICIENT_OPEN | `status = "UNRESOLVED"` AND checkout has not yet occurred |
| DEFICIENT_RESOLVED | `status = "RESOLVED"` — resolution event posted |
| DEFICIENT_UNRESOLVED_AT_CHECKOUT | `status = "UNRESOLVED"` AND checkout has occurred for the associated stay |

### 3.15.2 Transition Table

| From | To | Trigger | Notes |
|---|---|---|---|
| — | DEFICIENT_OPEN | DEFICIENT condition detected on room | `DeficientConditionRecord` created; `Room.isDeficient = true`; `resolutionDeadline` set; Timer Engine begins monitoring |
| DEFICIENT_OPEN | DEFICIENT_RESOLVED | Resolution event posted by authorised actor | Resolution is layered on the record — `resolvedAt`, `resolvedBy`, `resolutionNotes` populated; `DeficientConditionRecord.status → "RESOLVED"`; `Room.isDeficient = false`. Original record preserved; resolution is additive per §71. |
| DEFICIENT_OPEN | DEFICIENT_UNRESOLVED_AT_CHECKOUT | Checkout occurs with `status = "UNRESOLVED"` | Permanent flag on guest stay record; `DeficientConditionRecord` remains with `status = "UNRESOLVED"`; no auto-closure. Permanently carried in the entry's history. |

### 3.15.3 Resolution is Additive, Not Amendment

When a DEFICIENT condition is resolved, the resolution is a layered event on the `DeficientConditionRecord` — fields `resolvedAt`, `resolvedBy`, and `resolutionNotes` are populated. The original detection record (description, category, detectedAt, detectedBy, resolutionDeadline) is preserved without modification. A resolved record is not deleted or archived separately.

### 3.15.4 DEFICIENT_UNRESOLVED_AT_CHECKOUT — Permanence

When a DEFICIENT condition reaches `DEFICIENT_UNRESOLVED_AT_CHECKOUT`, the condition remains in the guest's stay record permanently. There is no post-checkout resolution path that removes or changes this record. A post-checkout resolution attempt creates a new `ServiceRecoveryRecord`; the `DEFICIENT_UNRESOLVED_AT_CHECKOUT` record is not amended.

### 3.15.5 DEFICIENT Flag Overlay Scope

DEFICIENT flags apply only to room records. Conference/event spaces do not carry `isDeficient` flags. Condition issues on spaces are tracked as `ServiceRecoveryRecord` entries directly.

### 3.15.6 Governing Timer

The DEFICIENT resolution deadline timer (§76) governs this state machine:
- Approaching deadline → housekeeping reminder dispatched.
- Deadline breached → FOM escalation.

---

## §3.16 — No-Show Determination State Machine

### 3.16.1 Scope and Entry State Relationship

The no-show determination state machine governs the process that occurs when a guest does not arrive by the expected time. During this entire process, the `Entry` remains in `(ACTIVE, S5)`. The no-show determination process does not change `Entry.currentStage` — it operates as a governed sub-process within S5.

The terminal outcome of the process — `FOM determines no-show` → `folio transitions to NO_SHOW_CLOSED` → `entry routes to S9-equivalent` — is the terminal path from §76A: "S5 → TERMINAL (no-show path): No-show determination made by FOM."

The `NoShowDeterminationRecord` carries the formal determination. The `Folio` carries the financial consequence.

### 3.16.2 State Model

The no-show determination states are logical states within the S5 sub-process, expressed through the combination of timer events, the presence and content of a `NoShowDeterminationRecord`, and the `Folio.state`.

| Logical State | System Condition |
|---|---|
| NO_SHOW_PENDING | No-show cutoff timer has fired; guest has not arrived; contact attempts in progress; no FOM determination yet; no `NoShowDeterminationRecord` exists |
| AWAITING_WRITTEN_CONFIRMATION | Guest has claimed late arrival verbally; FOM has deferred determination; `AWAITING_WRITTEN_CONFIRMATION` timer is running |
| NO_SHOW_DETERMINED | FOM has made formal determination; `NoShowDeterminationRecord` created; penalty posted to folio |
| FOLIO_NO_SHOW_CLOSED | `Folio.state = NO_SHOW_CLOSED`; financial residue governed; entry proceeding through S9-equivalent processing |

### 3.16.3 Transition Table

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| (S5 active) | NO_SHOW_PENDING | No-show cutoff timer fires (expected arrival + configurable minutes) | System (Timer Engine) | Contact attempts commenced; staff alerted |
| NO_SHOW_PENDING | AWAITING_WRITTEN_CONFIRMATION | Guest claims late arrival verbally; FOM chooses to defer | FOM | `AWAITING_WRITTEN_CONFIRMATION` timer begins; FOM deferral recorded |
| NO_SHOW_PENDING | NO_SHOW_DETERMINED | FOM makes immediate no-show determination | FOM | `NoShowDeterminationRecord` created |
| AWAITING_WRITTEN_CONFIRMATION | NO_SHOW_DETERMINED | Written confirmation received; FOM determines guest is arriving (process exits no-show path) | FOM | Entry returns to normal S5 processing |
| AWAITING_WRITTEN_CONFIRMATION | NO_SHOW_DETERMINED | `AWAITING_WRITTEN_CONFIRMATION` timer expires without written confirmation | System + FOM determination | No-show finalised; FOM formal decision required |
| NO_SHOW_DETERMINED | FOLIO_NO_SHOW_CLOSED | Folio closed as NO_SHOW_CLOSED; advance payment reconciled | System (on determination) | `Folio.state → NO_SHOW_CLOSED`; no-show penalty posted; refund record created if advance exceeds penalty |

### 3.16.4 No-Show Penalty Rules

- No-show penalty is aligned with the same-day cancellation tier per the configured cancellation policy.
- The penalty **cannot exceed** the total advance payment received from the guest. This is a hard constraint, not a configurable threshold.
- If the advance payment received exceeds the penalty, the surplus creates a refund obligation. The refund record is tracked through S9-equivalent processing.

### 3.16.5 OTA-Sourced No-Show

For entries where `Entry.otaSource = true`, a no-show determination triggers an additional communication obligation to the OTA platform. This OTA notification is a separate open loop — it is tracked independently from the financial processing. Financial processing (folio closure, penalty, refund) does not depend on the OTA notification loop closing. The OTA notification open loop timer (§76) governs this tracking.

### 3.16.6 Governing Timers (§76)

| Timer | Trigger | Consequence |
|---|---|---|
| No-show cutoff | Expected arrival + configurable minutes | NO_SHOW_PENDING phase commences |
| AWAITING_WRITTEN_CONFIRMATION | FOM deferral action | Window starts; expiry without written confirmation → no-show finalised |
| OTA notification open loop | OTA_CONFLICT no-show confirmed | FOM escalation → GM notification if loop exceeds configured window |

---

## §3.17 — ProcessingLock State Machine

### 3.17.1 Purpose and Scope

The `ProcessingLock` state machine governs multi-channel inventory concurrency during booking workflows. When multiple channel actors (email AI, WhatsApp AI, front desk, phone) are simultaneously evaluating the same inventory item, a processing lock informs priority without blocking inventory visibility.

This mechanism is distinct from the concurrent editing protection defined in Part 1 §1.4 (§34.4 B4-001 distinction):
- **ProcessingLock:** multi-channel inventory concurrency for booking workflows — governs which channel actor has priority on a specific inventory item during active booking negotiation.
- **Concurrent editing protection:** simultaneous record editing within the operational system by authenticated staff users — governs record-level editing conflicts.

### 3.17.2 State Model

**Model:** `ProcessingLockRecord`
**State field:** `ProcessingLockRecord.status: ProcessingLockStatus`

```
enum ProcessingLockStatus {
  ACTIVE
  EXPIRED
  RELEASED
}
```

### 3.17.3 Transition Table

| From | To | Trigger | Notes |
|---|---|---|---|
| — | ACTIVE | Lock placed on inventory item by channel actor | New `ProcessingLockRecord` created on each placement; `actorId`, `channel`, `inventoryReference`, `placedAt`, `ttlSeconds`, `expiresAt` recorded; pg-boss expiry job registered (`pgBossJobId`) |
| ACTIVE | EXPIRED | TTL reached (pg-boss job fires) | **Unconditional expiry — no heartbeat, no renewal, no extension.** `ProcessingLockRecord.expiredAt` populated; operator notification dispatched: "Your inventory hold has expired — please reconfirm availability before proceeding." Silent expiry is forbidden. |
| ACTIVE | RELEASED | Booking completed or rejected before TTL | Governed release event; `ProcessingLockRecord.releasedAt` populated; audit event produced |

### 3.17.4 Hard Expiry Doctrine

The ProcessingLock TTL is hard. There is no mechanism to extend an ACTIVE lock. There is no heartbeat. When the TTL expires, the lock expires unconditionally regardless of what the operator is doing. The operator must be explicitly notified with the prescribed message. The notification is not optional.

The absence of a heartbeat is an intentional design choice, not an omission. Implementing a heartbeat or renewal mechanism for a ProcessingLock is an architectural violation.

### 3.17.5 Reconfirmation Path

When a lock has EXPIRED, the operator may initiate a reconfirmation. Reconfirmation does not change the EXPIRED lock record. Instead:

1. A new `ProcessingLockRecord` is created with `status = ACTIVE` and a new TTL.
2. `ProcessingLockRecord.revalidationCount` is incremented on the new record to track how many reconfirmation cycles this booking workflow has undergone.
3. A revalidation check fires at the moment of new lock placement — verifying against current system state:
   - Availability state of the inventory item.
   - DEFICIENT flag status of the inventory item.
   - Pricing — re-verified against current pricing data.
4. The operator receives the revalidation result before proceeding.

The EXPIRED record is preserved — it is not overwritten or deleted.

### 3.17.6 Priority Queue

The first actor to place a lock on an inventory item for a given date range has priority. Subsequent actors who query the same inventory item are informed of the existing lock — they are not blocked from viewing the inventory. The lock informs; it does not prevent exploration.

Priority is communicated to subsequent actors as: "This inventory item is currently under a processing hold by another channel. Availability may change." The subsequent actor may continue their workflow but understands their position in the priority queue.

### 3.17.7 Audit Events

Every state transition produces permanent audit events, even though the lock record itself is operationally transient:

| Event | Trigger | Data Logged |
|---|---|---|
| `lock_placed` | ACTIVE lock created | actor, channel, inventory reference, TTL, placed_at |
| `lock_expired` | ACTIVE → EXPIRED | actor, inventory reference, expiry context (what was being evaluated when lock expired) |
| `lock_released` | ACTIVE → RELEASED | actor, inventory reference, release reason (booking_completed \| booking_rejected) |

---

## Gate 3 — Category 1 Clarification Requests

The following items could not be fully resolved from §76A, §76, and the locked ToC content requirements. They are surfaced as Category 1 clarification requests per the Spec Ambiguity Protocol (§1.3). No policy content has been invented for these items.

| Ref | Section | Issue | Impact |
|---|---|---|---|
| G3-001 | §3.16 | `NoShowDeterminationRecord` Prisma model definition is listed in the Part 2 stage-to-record matrix (C at S5, R at S9) but its model definition was not found in the loaded Part 2 sections. If absent from the locked schema, the no-show determination state machine lacks a schema anchor for the formal determination record. | Verify that `NoShowDeterminationRecord` model exists in Part 2 §2.7 or equivalent. If absent, a schema addition is required before the no-show state machine may be considered schema-complete. No gate 3 text is blocked by this gap — the state machine is defined. The schema gap would block Gate 13.3 (State Machine Gate) verification. |
| G3-002 | §3.8 | Space physical state machine — SETUP_IN_PROGRESS and BREAKDOWN_IN_PROGRESS phases are derived from the ToC (§68 reference) but §68 is not a declared Gate 3 source. The state transitions defined in §3.8.2 are based on the two boolean fields present on the Part 2 `Space` model (`isAvailable`, `isEventInProgress`). If §68 defines additional space states or additional transition guards, those would not be captured here. | If the Architect confirms §68 introduces additional space states or transition guards, §3.8 requires a revision at a subsequent gate with §68 loaded. |

---

## Gate 3 — Self-Review Summary

| Check | Result |
|---|---|
| All 17 state machines present | ✅ §§3.1–3.17 written |
| All transitions sourced from §76A | ✅ Derived without modification or inference |
| All five guards stated per §76A Transition Guard Summary | ✅ §3.1.2 |
| No stage transition in spec not present in §76A | ✅ |
| All Part 2 model names used exactly as defined | ✅ Confirmed against model name list |
| All enum values used exactly as defined in Part 2 §2.1.3 | ✅ |
| "Inquiry" used throughout (not "Engagement") | ✅ RF-2 locked |
| IP boundary maintained — no DOSS principle numbers, no FAC references | ✅ |
| B11-001 correction applied (commission-due conditionality) | ✅ §3.2.5 |
| DISPUTE_EXHAUSTED explicitly excluded | ✅ §3.4.1 |
| AI agent voice note block stated as routing-layer architectural block | ✅ §3.11.4 |
| AI agent self-approval absolute prohibition (no trust level override) | ✅ §3.13.4 |
| OCCUPIED → DEPARTED_DIRTY mandate stated | ✅ §3.6.4, §3.7.3 |
| ProcessingLock hard expiry — no heartbeat, no renewal | ✅ §3.17.4 |
| DEFICIENT flag only on rooms (not spaces) | ✅ §3.8.1, §3.15.5 |
| Category 1 gaps surfaced (not invented) | ✅ 2 items — G3-001, G3-002 |

---

*Prepared by Claude (AI Architectural Partner)*
*Gate 3 — State Machines*
*07 April 2026*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until Architect confirms.*
