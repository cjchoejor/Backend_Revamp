# LEGPHEL PMS — Stage Implementation Guideline
## S4: Confirmation & Ownership

**Document ID:** SIG-S4
**Version:** 2.0
**Derived from:** DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT — Pending Architect confirmation
**Nothing in this document is locked until the Architect confirms.**

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Initial generation. Six findings surfaced (SIG-S4-COR-001 through SIG-S4-COR-006). Two deliberated and locked by Architect: D-01 (H1 at S4 — Option A); D-02 (TraceEvent for ownership — no distinct model). Four mechanical corrections queued. |
| 1.2 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Corrections applied. Locked by Architect 13 April 2026. Dependency language remained on frozenBillingModel (TraceEvent fallback) and CancellationDisclosureRecord ("if available") due to unresolved S3 schema gaps at that time. |
| 2.0 | 14 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | Full regeneration from corrected source documents. Part 2 REV2-FINAL and Part 6 REV3 locked. All dependency language eliminated: frozenBillingModel sourced from BillingModelTransitionRecord (no TraceEvent fallback); CancellationDisclosureRecord loaded unconditionally (no "if available"). GAP-S4-001 through GAP-S4-005 absorbed as positive assertions. S3 v2.0 handoff state carried. Zero-gap document. |

---

## Source Confirmation Table

| # | Source | File | Key Sections Read |
|---|---|---|---|
| 1 | Prior SIG S1 v1.2 | SIG-S1-v1_2.md | Version history; locked decisions A-1–A-7, B-1–B-6; S3→S1 re-entry additions |
| 2 | Prior SIG S2 v1.3 | SIG-S2-v1_3.md | Version history; §1.4 exit condition; §2.2 Quotation commercialTerms |
| 3 | Prior SIG S3 v2.0 | SIG-S3-v2_0.md | Full — §1.3–1.7, §2 schema, §3 state machine, §6 services, §9 config keys |
| 4 | Master Correction Log v1.6 | MASTER-CORRECTION-LOG-v1_6.md | Full — all PENDING items targeting S4 confirmed |
| 5 | System Overview | DEV-SPEC-001-Part0.md | §0.1–§0.8 |
| 6 | S4 Stage Charter | Canon_Block6_S3_S4_REV2_2.md | §45.1–§45.19 full; use type variations (S4) |
| 7 | Canon Matrices | Canon_Block11_Matrices_Governance_Appendices_REV2_2.md | §72–§76A; §79 S4 readiness map |
| 8 | Schema | DEV-SPEC-001-Part2-REV2-FINAL.md | All S4-active models; §2.17.3 configuration key table |
| 9 | State Machine | DEV-SPEC-001-Part3.md | §3.2 Entry Lifecycle; §3.5 Hold (PLACED→CONFIRMED); §3.6 Inventory Claim (COMMITTED_HELD→CONFIRMED) |
| 10 | Engines | DEV-SPEC-001-Part4.md | §4.5 OverbookingDetectionEngine; §4.7 FOCValidationEngine; §4.10 TimerEngine; §4.11 ReEntryConsequenceEngine |
| 11 | Policies | DEV-SPEC-001-Part5-REV2.md | Policies 4, 9, 13, 20, 35, 39, 40, 41, 42, 43, 52, 63, 66, 67, 69, 71 |
| 12 | Services | DEV-SPEC-001-Part6-REV3.md | §6.5.6 ReservationService; §6.5.3 EntryService; §6.5.8 HandoffService; §6.5.17 HoldService (confirmCommittedHold()) |
| 13 | Workers | DEV-SPEC-001-Part8.md | W1 StageDwellMonitor; W3 CommittedHoldExpiryWorker; W4 PreArrivalWindowActivationWorker; W20 EntryExpiryWorker; W22 AcknowledgementWindowWorker |
| 14 | Routes | DEV-SPEC-001-Part9-REV1.md | §9.4.7 Confirm Reservation; Get Reservation; Progress Stage |
| 15 | Integration | DEV-SPEC-001-Part11.md | EmailInterface; WhatsAppInterface; DocumentGenerationInterface (CONFIRMATION_VOUCHER) |
| 16 | Configuration | DEV-SPEC-001-Part12.md | §12.3.2 S4_READINESS table |
| 17 | Acceptance Gates | DEV-SPEC-001-Part13.md | S4 assertion coverage across all gates |

---

## Locked Architectural Decisions Carried Forward

**D-01 — H1 HandoffRecord creation timing (Option A — LOCKED)**
H1 is created at S4 within `ReservationService.confirm()` via `HandoffService.create()`. Creation is part of the S4 confirmation transaction. `handoff.H1.checklist` is a blocking S4_READINESS surface.

**D-02 — Ownership assignment mechanism (TraceEvent — LOCKED)**
Operational ownership assignment at S4 is recorded via a `TraceEvent` with `eventType = OWNERSHIP_ASSIGNED`. No distinct `OwnershipAssignmentRecord` model is required.

---

## Table of Contents

1. [Stage Identity](#section-1--stage-identity)
2. [Schema Models Active at S4](#section-2--schema-models-active-at-s4)
3. [State Machine at S4](#section-3--state-machine-at-s4)
4. [Policies Enforced at S4](#section-4--policies-enforced-at-s4)
5. [Engines Invoked at S4](#section-5--engines-invoked-at-s4)
6. [Services Active at S4](#section-6--services-active-at-s4)
7. [Workers Active at S4](#section-7--workers-active-at-s4)
8. [API Routes at S4](#section-8--api-routes-at-s4)
9. [Configuration Keys at S4](#section-9--configuration-keys-at-s4)
10. [Acceptance Criteria](#section-10--acceptance-criteria)

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 4 (S4) — Confirmation & Ownership**

### 1.2 Stage Purpose

Stage 4 exists to formally confirm the reservation, freeze all commercial terms as a binding commitment snapshot, lock the inventory by transitioning it from COMMITTED_HELD to CONFIRMED, assign operational ownership, and produce the confirmation evidence (voucher) that the guest or agent receives. S4 is the commitment boundary — everything before it is preparation; everything after it is execution of the promise made here.

If S4 is completed correctly, the system holds: a confirmed reservation with frozen commercial terms (including credit ceiling if applicable); inventory locked in CONFIRMED state; a confirmation voucher generated and communicated to the guest or agent with an active acknowledgement tracker; operational ownership formally assigned; a correctly typed overbooking record if overbooking was detected; and a complete traceable decision history from S1 through S4. The entry is ready for pre-arrival preparation at S5.

### 1.3 Entry Routes

**Forward from S3.** The entry has a committed hold, a provisional folio with billing model fixed, a satisfied advance payment condition (or approved credit extension with ceiling), disclosed cancellation terms, and resolved guest and contact details. All S3 exit conditions are met. S4 receives a fully prepared entry ready for the confirmation decision. The exact handoff state from S3 is documented in §1.4.

**Re-entry from S5 or later.** A configuration change, rate amendment, or billing adjustment that has passed through S1/S2/S3 re-entry now reaches S4 for re-confirmation. The new segment's S4 produces an amended confirmation with updated terms. Prior confirmation vouchers are superseded but preserved. The original S4 confirmation in the prior segment remains read-only.

**Re-entry from S4→S3→S4 (billing model change or payment renegotiation).** The entry left S4, returned to S3 for billing model adjustment or additional payment arrangement, and re-enters S4. A new Reservation record is created at this S4 passage. The prior Reservation from the first S4 passage is read-only history. The folio is the same Entry-level folio — it persists through all segments.

**Re-entry from S7→S3→S4 (billing model change during stay).** The folio is LIVE (not PROVISIONAL) — it was converted at S6. The Reservation snapshot is still created from the current folio state and the latest `BillingModelTransitionRecord`. S4 confirmation works the same regardless of folio state — it creates a snapshot, not a modification.

**Re-entry from S3→S2→S3→S4 (rate renegotiation round-trip).** The `CommittedHold` may be the original from the first S3 passage (retained during S3→S2, still active) or a new one placed at the second S3 (if the original expired during renegotiation). S4 confirms whichever `CommittedHold` is in PLACED state on the current segment.

### 1.4 S4 Starting State

When an entry enters S4, the following state is expected. This is the complete handoff from a correctly completed S3.

**Always present:**

- `CommittedHold` in `HoldState.PLACED` with active `COMMITTED_HOLD_EXPIRY` timer
- `Folio` in `FolioState.PROVISIONAL` (first-pass) or `FolioState.LIVE` (post-S6 re-entry) with `billingModel` populated
- At least one `Invoice` of type `PROFORMA` (unless contracted corporate deferred billing)
- Advance payment condition satisfied: `PaymentRecord` total meets threshold OR `CreditExtensionCeilingRecord` exists with non-null `ceilingAmount`
- `BillingModelTransitionRecord` on the folio for the current segment
- `CancellationDisclosureRecord` with `noShowTreatmentStatement` populated
- Primary guest and contact details resolved on `GuestProfile`
- `StageDwellRecord` for S3 with exit evidence
- `StageDwellRecord` for S4 with `enteredAt` populated
- `STAGE_DWELL_MONITOR` timer registered for this entry at S4

**Conditionally present:**

- `SpeculativeHold` in `HoldState.UPGRADED` with `upgradedToId` pointing to the `CommittedHold` (only if speculative hold was placed at S2) — this is historical context only; the speculative hold is not touched at S4
- FOC validation passed with GM approval recorded (GROUP/CONFERENCE with FOC rooms)
- Payment milestone schedule configured (CORPORATE/CONFERENCE)
- Coordinator confirmed with authority scope (GROUP and CONFERENCE)

### 1.5 Exit Conditions

The S4→S5 transition requires all of the following to be true. Guards are evaluated in sequence. Failure at any guard raises `StageGateBlockedError` identifying the specific unsatisfied condition.

1. A `Reservation` record exists with a complete commitment snapshot: all frozen fields populated (`frozenRate`, `frozenRatePlanId`, `frozenInclusions`, `frozenCancellationTerms`, `frozenBillingModel`, `frozenCheckInDate`, `frozenCheckOutDate`, `frozenGuestCount`, `creditCeilingIfExtended` if applicable).
2. `CommittedHold.state = HoldState.CONFIRMED` — inventory is in `InventoryClaimState.CONFIRMED`.
3. A confirmation voucher has been generated via `DocumentGenerationInterface.generate(CONFIRMATION_VOUCHER, ...)`.
4. The confirmation voucher has been communicated to the guest or agent with a tracked `CommunicationRecord` (non-null `dispatchedAt`).
5. An `ACKNOWLEDGEMENT_WINDOW` timer is registered for the confirmation voucher communication.
6. If overbooking was detected: `OtaConflictOverbookingRecord` exists with `gmApprovalActorId` populated, `triggerType` set (DELIBERATE or OTA_CONFLICT), and `mitigationPlanStatus` not `OPEN`.
7. If multi-booking detection fired: FOM acknowledgement recorded via `TraceEvent` confirming the engagements are genuinely separate.
8. For CONFERENCE entries: FOM verification complete — hall confirmed, seating confirmed, F&B confirmed against work order, special requests reviewed.
9. Operational ownership assigned — `TraceEvent` with `eventType = OWNERSHIP_ASSIGNED` exists for this entry and segment (D-02).
10. H1 `HandoffRecord` created (D-01) — `handoffType = H1`, `stageContext = S4`. Auto-fulfilled if reservations and front desk are the same team (`isAutoFulfilled = true`).
11. The confirmation acknowledgement tracker must be active (timer started). An unacknowledged confirmation within the response window is not a blocker. An unacknowledged confirmation that has already exceeded the response window at S4 exit requires documented resolution — a follow-up task with specific resolution timeline recorded by the custodian.
12. Authority satisfied: at minimum `ActorLevel.FRONT_DESK` (Custodian). Conference and high-value entries require `ActorLevel.FOM` per confirmation authority thresholds.

S4→S5 activation is governed by the `PRE_ARRIVAL_COUNTDOWN` timer. When the pre-arrival window opens, `PreArrivalWindowActivationWorker` (W4) fires and transitions the entry to S5. If arrival is same-day or next-day at the time of S4 confirmation, the timer fires immediately and S5 activates in compressed mode.

### 1.6 Governing Actors

| Role | Actor Level | Authority at S4 |
|---|---|---|
| Receptionist / Reservations | `ActorLevel.FRONT_DESK` (L1) | Confirms standard entries; generates and dispatches confirmation voucher; records ownership assignment |
| Front Office Manager | `ActorLevel.FOM` (L2) | All L1 actions; confirms high-value and conference entries; approves multi-booking overlap; verifies conference completeness (hall, F&B, special requests); resolves unacknowledged confirmation open loops |
| General Manager | `ActorLevel.GM` (L3) | All L2 actions; approves overbooking (mandatory for all overbooking regardless of trigger type); FOC re-verification final authority |
| Admin | `ActorLevel.ADMIN` (L4) | Configuration only; not an operational actor at S4 |

### 1.7 Forbidden Actions at S4

The following must not occur during S4. Each is an architectural violation if implemented.

- **No modifying commercial terms without re-entry.** Once S4 freezes the terms, any change to rate, inclusions, billing model, or dates requires formal amendment through the re-entry mechanism — creating a new segment and passing through the relevant earlier stages. In-place editing of frozen terms is forbidden.
- **No skipping the commitment snapshot.** The system must create a denormalised copy of all commitment terms at the moment of confirmation. Storing only a reference to the current rate plan configuration is forbidden — it would cause the commitment to silently change when the rate plan is later updated.
- **No room-specific assignment.** S4 confirms the reservation at the room type and category level. Specific room assignment is an S5/S6 decision that depends on physical room state and readiness.
- **No sending the guest a live folio.** The folio at S4 is still provisional (or LIVE on re-entry, but not guest-facing in either case). The guest receives the confirmation voucher.
- **No confirming without complete S3 exit evidence.** If any S3 exit condition is unsatisfied, S4 must not proceed.
- **No confirming without communicating.** A confirmation that exists in the system but was never delivered to the guest or agent is operationally incomplete. The system must not permit S4 exit without a tracked communication event.
- **No setting overbooking trigger type as DELIBERATE when OTA_SOURCE flag is present.** If the overbooking involves an OTA-sourced entry, the trigger type must be `OTA_CONFLICT`. Manual override to `DELIBERATE` is forbidden.
- **No issuing a second confirmation for the same segment.** One confirmation per segment. If terms change, a new segment produces a new amended confirmation.
- **No releasing confirmed inventory without cancellation.** Confirmed inventory may not be released to FREE without a governed cancellation event or a governed re-entry that produces a new segment.
- **No calling PricingPipelineEngine at S4.** The frozen rate is the S2-resolved rate carried forward. `PricingPipelineEngine` is not invoked at S4 unless a re-entry from a later stage has occurred and re-entry routed through S2.

---

## Section 2 — Schema Models Active at S4

The following Prisma models are read or written during S4 operations. Only fields relevant to S4 are called out. The full schema with all models and relations is in Part 2 REV2-FINAL.

---

### 2.1 Reservation (Created)

**Access at S4:** Created. The primary S4 entity. Immutable from creation.

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
  creditCeilingIfExtended Decimal?  @db.Decimal(15,2)
  confirmedAt             DateTime
  confirmedBy             String    // actor_id — NOT NULL
  confirmationVoucherSent Boolean   @default(false)
  sealedAt                DateTime?
  createdAt               DateTime  @default(now())
}
```

**S4 mutation rule:** Immutable from creation. In-place editing of this record after S4 exit is the most dangerous architectural violation in the system. Any change after S4 requires a new segment with a new Reservation.

**Frozen field sourcing — definitive:**

| Frozen Field | Source |
|---|---|
| `frozenRate` | Accepted `Quotation.commercialTerms.rate` on the current segment |
| `frozenRatePlanId` | Accepted `Quotation.commercialTerms.ratePlanId` on the current segment |
| `frozenInclusions` | Accepted `Quotation.commercialTerms.inclusions` on the current segment |
| `frozenCancellationTerms` | `CancellationDisclosureRecord.disclosedTerms` for this entry and segment |
| `frozenBillingModel` | Latest `BillingModelTransitionRecord` on the Entry-level folio, ordered by `createdAt DESC`, take `toModel` |
| `frozenCheckInDate` | `Entry.checkInDate` |
| `frozenCheckOutDate` | `Entry.checkOutDate` |
| `frozenGuestCount` | `Entry.guestCount` |
| `creditCeilingIfExtended` | `CreditExtensionCeilingRecord.ceilingAmount` (null if no credit extended) |

---

### 2.2 Entry (Updated)

**Access at S4:** Read and written. Stage progression is the primary write operation.

```prisma
model Entry {
  id                   String          @id @default(uuid())
  inquiryId            String
  segmentNumber        Int
  useType              EntryUseType    // immutable after creation
  status               EntryStatus
  currentStage         Stage
  checkInDate          DateTime?
  checkOutDate         DateTime?
  guestCount           Int?
  otaSource            Boolean         @default(false)   // immutable once set
  groupBillingMode     GroupBillingMode?
  parkedAt             DateTime?
  parkedBy             String?
  parkedIndividually   Boolean         @default(false)
  createdAt            DateTime
  updatedAt            DateTime
  createdBy            String
  version              Int             @default(1)
  closedAt             DateTime?
  closedBy             String?
}
```

**S4 mutation rule:** `currentStage` updated from S4 to S5 on forward exit — via `EntryService.progressStage()` triggered by `PreArrivalWindowActivationWorker` (W4). `status` may transition between ACTIVE and PARKED via park/unpark operations. `version` incremented on every update. No other fields are written at S4 by staff action.

---

### 2.3 CommittedHold (Updated)

**Access at S4:** Updated at confirmation — state transition from PLACED to CONFIRMED.

```prisma
model CommittedHold {
  id              String    @id @default(uuid())
  entryId         String
  segmentId       String
  roomId          String?
  spaceId         String?
  state           HoldState @default(PLACED)
  placedAt        DateTime
  placedBy        String
  commercialJustification String
  ttlSeconds      Int
  expiresAt       DateTime
  confirmedAt     DateTime?
  confirmedBy     String?
  releasedAt      DateTime?
  releasedBy      String?
  releaseReason   String?
  createdAt       DateTime
}
```

**S4 mutation rule:** State transitions PLACED → CONFIRMED at S4 confirmation. `confirmedAt` and `confirmedBy` populated. The `COMMITTED_HOLD_EXPIRY` timer is cancelled in the same transaction. No other field edits at S4.

---

### 2.4 HandoffRecord (Created)

**Access at S4:** Created — H1 handoff.

```prisma
model HandoffRecord {
  id                    String        @id @default(uuid())
  entryId               String
  handoffType           HandoffType
  state                 HandoffState  @default(CREATED)
  fromRole              String
  fromActorId           String
  toRole                String
  toActorId             String?
  checklistContent      Json
  deficientConditionStatus String?
  fulfilmentEvidence    Json?
  assignedAt            DateTime?
  acceptedAt            DateTime?
  acceptedBy            String?
  fulfilledAt           DateTime?
  fulfilledBy           String?
  closedAt              DateTime?
  rejectedAt            DateTime?
  rejectedBy            String?
  rejectionReason       String?
  escalatedAt           DateTime?
  slaDeadlineAt         DateTime?
  isAutoFulfilled       Boolean       @default(false)
  createdAt             DateTime      @default(now())
  createdBy             String
  stageContext           Stage
}
```

**S4 mutation rule:** Created at S4 with `handoffType = H1`, `stageContext = S4`. If reservations and front desk are the same team, `isAutoFulfilled = true` — acceptance event is still recorded for audit. H1 carries: complete reservation context, guest profile, confirmed terms, special requests, payment status, arrival details, credit ceiling if applicable, OTA_SOURCE flag, and any active overbooking status.

---

### 2.5 OtaConflictOverbookingRecord (Conditionally Created)

**Access at S4:** Created if overbooking detected.

```prisma
model OtaConflictOverbookingRecord {
  id                        String                @id @default(uuid())
  entryId                   String                @unique
  triggerType               OverbookingTriggerType
  otaNotificationStatus     String                @default("OPEN")
  otaNotificationClosedAt   DateTime?
  mitigationPlanStatus      String                @default("OPEN")
  mitigationPlanClosedAt    DateTime?
  gmApprovalActorId         String
  gmApprovalAt              DateTime
  createdAt                 DateTime              @default(now())
  createdBy                 String
}
```

**S4 mutation rule:** Created at S4 if `OverbookingDetectionEngine.detect()` returns `overbookingDetected: true`. `triggerType` is immutable once set — OTA_CONFLICT cannot be reclassified as DELIBERATE. GM approval is mandatory before the record is written. `otaNotificationStatus` and `mitigationPlanStatus` are updated during the overbooking resolution lifecycle (post-S4).

---

### 2.6 CancellationDisclosureRecord (Read)

**Access at S4:** Read — loaded unconditionally at step 1 of the confirm() execution sequence.

```prisma
model CancellationDisclosureRecord {
  id                       String    @id @default(uuid())
  entryId                  String
  segmentId                String
  folioId                  String?
  cancellationPolicyId     String
  disclosedTerms           Json
  noShowTreatmentStatement String
  disclosedAt              DateTime
  disclosedBy              String
  guestAcknowledged        Boolean   @default(false)
  acknowledgementMethod    String?
  createdAt                DateTime  @default(now())
}
```

**S4 mutation rule:** Immutable — created at S3, read at S4. Its existence is a mandatory S4 entry condition. `disclosedTerms` populates `Reservation.frozenCancellationTerms`. A missing `CancellationDisclosureRecord` at S4 entry raises a `PolicyGateBlockedError` — S4 cannot proceed.

---

### 2.7 BillingModelTransitionRecord (Read)

**Access at S4:** Read — queried to populate `Reservation.frozenBillingModel`.

```prisma
model BillingModelTransitionRecord {
  id              String    @id @default(uuid())
  folioId         String
  segmentId       String
  fromModel       String?
  toModel         String
  authorisedBy    String
  authorityBasis  String
  reason          String
  effectiveFrom   DateTime  @default(now())
  createdAt       DateTime  @default(now())
}
```

**S4 mutation rule:** Not written at S4. Read-only. The query is: `BillingModelTransitionRecord` where `folioId = entry.folio.id`, ordered by `createdAt DESC`, take the first record's `toModel`. This is the authoritative source for `frozenBillingModel` — not `Folio.billingModel` directly.

---

### 2.8 Supporting Models

The following models are read or written at S4 in supporting roles:

**Folio** — read for financial summary context (advance payment status, billing model). Not written at S4. The folio remains in its current state (PROVISIONAL on first pass; LIVE on post-S6 re-entry). S4 does not convert, close, or modify the folio.

**CreditExtensionCeilingRecord** — read if present. `ceilingAmount` populates `Reservation.creditCeilingIfExtended`. Null if no credit was extended at S3.

**Quotation** — read. The accepted quotation's `commercialTerms` fields populate the Reservation's frozen rate, inclusions, and rate plan reference.

**StageDwellRecord** — created on S4 entry; tracks dwell time within S4. Written by `StageDwellMonitor` (W1).

**TraceEvent** — immutable event records written on every governed action at S4: confirmation, hold confirmation, voucher dispatch, ownership assignment, overbooking detection, timer registration, timer cancellation.

**CommunicationRecord** — created on confirmation voucher dispatch. Tracks acknowledgement state (`PENDING`, `RECEIVED`, `TIMED_OUT`).

**ConfigurationEntry** — read for all S4 configuration parameters (confirmation authority thresholds, overbooking limits, OTA conflict rules, cancellation penalty tiers, ownership assignment rules, acknowledgement window, FOC configuration). Managed via the Admin Console.

**Room** — `currentClaimState` updated from `COMMITTED_HELD` to `CONFIRMED` on hold confirmation.

**RoomClaimStateEvent** — immutable audit record written on every `Room.currentClaimState` change at S4.

**WorkOrder** — read and verified at S4 for CONFERENCE and GROUP entries. FOM verifies work order items (F&B, equipment, special requests) before confirmation.

---

## Section 3 — State Machine at S4

### 3.1 Entry Lifecycle at S4

**Entry state during S4:** `(ACTIVE, S4)` or `(PARKED, S4)`.

**Forward transition:**

| From | To | Guard | Authority |
|---|---|---|---|
| S4 | S5 | All §1.5 exit conditions satisfied | Custodian; FOM for conference/high-value |

S4→S5 is triggered by `PreArrivalWindowActivationWorker` (W4) when the `PRE_ARRIVAL_COUNTDOWN` timer fires. For same-day or next-day arrivals, the timer fires immediately on S4 confirmation.

**Re-entry transitions from S4:**

| From | To | Trigger | Authority | New Segment |
|---|---|---|---|---|
| S4 | S1 | Date change post-confirmation | FOM | Yes |
| S4 | S2 | Rate change post-confirmation | FOM/GM | Yes |
| S4 | S3 | Billing model change; payment renegotiation | FOM/GM | Yes |

All re-entry transitions create a new `Segment` via `EntryService.createSegment()`. The prior segment is sealed. `ReEntryConsequenceEngine.compute()` is invoked to determine hold and folio consequences.

### 3.2 CommittedHold State Machine at S4

| From | To | Trigger | Notes |
|---|---|---|---|
| PLACED | CONFIRMED | S4 confirmation event | `HoldService.confirmCommittedHold()` — atomic with Reservation creation |

The PLACED→CONFIRMED transition is the sole hold state change at S4. The `COMMITTED_HOLD_EXPIRY` timer is cancelled in the same transaction. If the hold expired before S4 confirmation (state already RELEASED), the entry cannot proceed — the hold must be replaced by returning to S3.

### 3.3 Folio State Machine at S4

No folio state change occurs at S4. The folio remains in its current state:

- **PROVISIONAL** on first pass from S3 — no conversion at S4.
- **LIVE** on re-entry from post-S6 stages (S7→S3→S4) — already converted at S6.

S4 reads the folio for financial context but does not modify it.

### 3.4 Inventory Claim State Machine at S4

| From | To | Trigger | Notes |
|---|---|---|---|
| COMMITTED_HELD | CONFIRMED | S4 confirmation event | Inventory secured at confirmation |

The COMMITTED_HELD→CONFIRMED transition occurs on `Room.currentClaimState` in the same transaction as `CommittedHold.state` → CONFIRMED. A `RoomClaimStateEvent` is written as the immutable audit record.

---

## Section 4 — Policies Enforced at S4

The following policies are active at S4, derived from the Stage-to-Policy Matrix (S4 column) cross-referenced with policy definitions.

---

**Policy 4 — Custodian Reassignment Policy**

- **Active at S4:** Ownership reassignment at confirmation
- **Enforcement point:** `ReservationService.confirm()` — ownership assignment logic determines whether custodian changes from S1–S3 custodian to a confirmed-reservation owner
- **Decision:** The operational owner may remain the same or transfer to a designated reservations owner. The assignment is recorded via `TraceEvent` with `eventType = OWNERSHIP_ASSIGNED` (D-02).
- **Hardcoded:** Ownership assignment is a recorded event — not silent.
- **Configurable:** Ownership assignment rules via `ownership.assignmentRules`

---

**Policy 9 — Pre-Arrival Period Policy**

- **Active at S4:** Pre-arrival countdown registration
- **Enforcement point:** `ReservationService.confirm()` — registers `PRE_ARRIVAL_COUNTDOWN` timer via `TimerEngine.register()` on successful confirmation; `PreArrivalWindowActivationWorker` (W4) fires the S4→S5 transition
- **Hardcoded:** Same-day or next-day arrival at S4 confirmation time causes immediate activation. Compressed mode does not skip pre-arrival obligations — it compresses them to real-time verification.
- **Configurable:** Pre-arrival window duration in days

---

**Policy 13 — Multi-Booking Detection Policy**

- **Active at S4:** Confirmation
- **Enforcement point:** `ReservationService.confirm()` — multi-booking check runs before confirmation event is written; checks for overlapping confirmed bookings for the same guest identity
- **Decision:** APPROVED (no overlap) | ESCALATE(`ActorLevel.FOM`) (overlapping confirmed bookings detected — simultaneous stay requires FOM explicit acknowledgement)
- **Hardcoded:** Overlapping confirmed reservations for the same guest identity require explicit FOM acknowledgement. Auto-confirmation of overlapping reservations is forbidden.
- **Configurable:** Date overlap threshold (exact overlap vs. overlap with configured buffer)

---

**Policy 20 — Commitment Rate Freeze Policy**

- **Active at S4:** Reservation confirmation
- **Enforcement point:** `ReservationService.confirm()` — rate freeze applied before confirmation event is written
- **Decision:** APPROVED (S2-resolved rate frozen into `Reservation.frozenRate`) | DENIED (no valid S2-resolved rate exists)
- **Hardcoded:** The commitment snapshot rate is the S2-resolved rate. `PricingPipelineEngine.resolve()` is NOT called at S4 unless a re-entry has occurred and re-entry routed through S2. In-place modification of the commitment snapshot after S4 exit is absolutely prohibited.
- **Configurable:** None — the freeze is a system invariant.

---

**Policy 35 — Cancellation Penalty Enforcement Policy**

- **Active at S4:** Cancellation enforcement
- **Enforcement point:** `CancellationService.cancel()` — if the guest cancels between S3 exit and S4 confirmation, the disclosed cancellation penalty (from `CancellationDisclosureRecord`) applies per the penalty tier structure
- **Hardcoded:** Penalty application follows the tier structure disclosed at S3. The penalty cannot exceed the advance payment collected.
- **Configurable:** Cancellation penalty tiers via `cancellation.policyTiers`

---

**Policy 39 — FOC Verification Policy**

- **Active at S4:** Re-verification at confirmation (GROUP and CONFERENCE with FOC rooms)
- **Enforcement point:** `ReservationService.confirm()` — calls `FOCValidationEngine.validate()` with current MSR and seasonality configuration (not S3 values); if `isValid: false`, confirmation is blocked — FOC must be stripped or renegotiated
- **Engine delegation:** `FOCValidationEngine.validate(input: FocValidationInput): FocValidationResult`
- **Hardcoded:** FOC validation is re-run at S4 using current configuration — it is not assumed valid because it passed at S3. GM approval is always required.
- **Configurable:** FOC configuration via `foc.configuration`

---

**Policy 40 — Confirmation Authority Policy**

- **Active at S4:** Reservation confirmation
- **Enforcement point:** `ReservationService.confirm()` — authority check runs before confirmation event is written; the authority level of the confirming actor is recorded on the confirmation event
- **Decision:** APPROVED (`ActorLevel.FRONT_DESK` — standard entries) | ESCALATE(`ActorLevel.FOM`) (high-value entries, conference, or event use type)
- **Hardcoded:** Conference and event use type entries always require FOM authority. The FOM must be the session actor at confirmation time — pre-approval by an absent FOM is not valid.
- **Configurable:** High-value threshold via confirmation authority thresholds configuration

---

**Policy 41 — Overbooking Detection and Trigger Typing Policy**

- **Active at S4:** Reservation confirmation and OTA booking verification
- **Enforcement point:** `ReservationService.confirm()` — calls `OverbookingDetectionEngine.detect()` before confirmation event is written; if `overbookingDetected: true`, confirmation halts; GM approval required
- **Engine delegation:** `OverbookingDetectionEngine.detect(input: OverbookingInput): OverbookingResult`
- **Decision:** APPROVED (no overbooking) | ESCALATE(`ActorLevel.GM`) (overbooking detected — GM approval required; `OtaConflictOverbookingRecord` created with trigger type)
- **Hardcoded:** OTA_SOURCE flag determines trigger type: `Entry.otaSource = true` → `OTA_CONFLICT`; `Entry.otaSource = false` → `DELIBERATE`. OTA_CONFLICT is immutable once set. Setting DELIBERATE when OTA_SOURCE is present is a forbidden act. OTA_CONFLICT creates an additional open loop for OTA platform notification.
- **Configurable:** Overbooking approval limits via `overbooking.maxAllowedRooms`; OTA_CONFLICT trigger rules via OTA conflict trigger rules configuration

---

**Policy 42 — Credit Ceiling Mandatory Set Policy**

- **Active at S4:** Confirmation snapshot verification
- **Enforcement point:** `ReservationService.confirm()` — verifies that if credit was extended at S3 (no advance payment), a `CreditExtensionCeilingRecord` exists with non-null `ceilingAmount` before confirmation proceeds
- **Hardcoded:** Confirmation cannot proceed if credit was extended without a ceiling. The ceiling is a mandatory component of the commitment snapshot.

---

**Policy 43 — Credit Ceiling Commitment Snapshot Carry Policy**

- **Active at S4:** Confirmation snapshot
- **Enforcement point:** `ReservationService.confirm()` — `CreditExtensionCeilingRecord.ceilingAmount` denormalised into `Reservation.creditCeilingIfExtended`
- **Hardcoded:** The ceiling in the commitment snapshot governs S5–S8 monitoring. In-place modification after S4 exit is forbidden. Null if no credit was extended.

---

**Policy 52 — Communication Acknowledgement Tracking Policy**

- **Active at S4:** Voucher sent
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on voucher dispatch; `TimerEngine.register()` called for `ACKNOWLEDGEMENT_WINDOW`; `AcknowledgementWindowWorker` (W22) transitions to `TIMED_OUT` on window expiry
- **Decision:** Enforcement rule — confirmation voucher dispatch opens a tracked acknowledgement loop
- **Hardcoded:** Every governed communication has a tracked acknowledgement state. Timed-out acknowledgements are recorded as visible flags.
- **OTA auto-fulfilment (fourth loop-close condition):** For entries where `Entry.otaSource = true` and OTA booking reference is present, the `CONFIRMATION_ACK_TRACKER` loop is auto-fulfilled on voucher dispatch. No W22 timer is registered for such entries. The OTA channel serves as the acknowledgement medium.
- **Configurable:** Acknowledgement window per type via `acknowledgement.windowPerType`

---

**Policy 63 — Handoff Lifecycle Policy**

- **Active at S4:** H1 created
- **Enforcement point:** `HandoffService.create()` — H1 created within `ReservationService.confirm()` (D-01); auto-fulfilment applies when reservations and front desk are the same team — acceptance event recorded regardless
- **Decision:** H1 created at S4; acceptance occurs at S5. Checklist content populated from `HandoffChecklistTemplate` for H1 type.
- **Hardcoded:** Every handoff produces an audit event including auto-fulfilments.
- **Configurable:** H1 checklist content via `HandoffChecklistTemplate` registry

---

**Policy 66 — Group FOC and Billing Split Policy**

- **Active at S4:** FOC verify (group context)
- **Enforcement point:** `ReservationService.confirm()` — for GROUP entries, FOC verification at S4 applies in the group billing context; billing split configuration from S3 is carried into the commitment snapshot
- **Hardcoded:** FOC rooms in a group booking are subject to the same S4 re-verification as individual FOC rooms (Policy 39). Group billing mode (`CONSOLIDATED`, `INDIVIDUAL`, `SPLIT`) is frozen in the commitment.

---

**Policy 67 — Work Order Lifecycle Policy**

- **Active at S4:** Read and verify
- **Enforcement point:** `ReservationService.confirm()` — for CONFERENCE and GROUP entries with work orders, FOM verifies work order items (F&B, equipment, special requests) as part of the conference verification gate before confirmation proceeds
- **Hardcoded:** Work order verification is a mandatory part of FOM conference verification. An unverified work order for a conference entry blocks S4 exit.

---

**Policy 69 — Session Management and PIN Authentication Policy**

- **Active at S4:** PIN authentication on every staff action
- **Enforcement point:** Middleware layer — session validation before any S4 operation
- **Hardcoded:** No credential sharing. Individual attribution on every action.

---

**Policy 71 — Processing Lock TTL Policy**

- **Active at S4:** Processing lock on inventory during confirmation
- **Enforcement point:** `ProcessingLockService` — TTL enforced via `ProcessingLockExpiryWorker`; an active processing lock on inventory in the committed hold blocks S4 confirmation
- **Hardcoded:** Lock expires unconditionally at TTL. No heartbeat or renewal.

---

## Section 5 — Engines Invoked at S4

### 5.1 OverbookingDetectionEngine

**Invocation point:** `ReservationService.confirm()` — called before the confirmation event is written.

**Purpose:** Determines whether confirming this reservation creates an overbooking condition (commitments exceeding physical inventory for the date range) and sets the trigger type.

**Input:** `OverbookingInput` — entryId, otaSource flag, roomTypeId, requested date range, existing confirmed claims for the room type, physical inventory count, overbooking approval limit (from `overbooking.maxAllowedRooms`), OTA conflict trigger rules (from OTA conflict trigger rules configuration), `isOtaVerificationClick` flag.

**Output:** `OverbookingResult` — `overbookingDetected: boolean`, `triggerType` (DELIBERATE | OTA_CONFLICT | null), `overbookedCount`, `conflictingClaims`, `requiresGmApproval` (true if any overbooking), `requiresOtaPlatformNotification` (true if OTA_CONFLICT), `mitigationPlanRequired` (true if detected), `exceedsApprovalLimit`.

**S4 behaviour:** If `overbookingDetected: true`, confirmation halts. The calling service initiates the GM approval workflow. Only after GM approval is recorded does the confirmation flow resume. The engine is not called again after GM approval. The calling service creates the `OtaConflictOverbookingRecord` after receiving a positive detection result — the engine does not create it.

**PricingPipelineEngine is NOT called at S4.** The frozen rate is the S2-resolved rate. `PricingPipelineEngine.resolve()` is not invoked at S4 unless re-entry routed through S2.

### 5.2 FOCValidationEngine

**Invocation point:** `ReservationService.confirm()` — GROUP and CONFERENCE entries with FOC rooms only.

**Purpose:** Re-verifies FOC room allocation at S4 using current MSR and seasonality configuration. Validates three mandatory checks: MSR check, seasonality check, entitlement check.

**Input:** `FocValidationInput` — entryId, roomTypeId, date range, applicable rack rate, applicable MSR, group size, existing FOC allocations, entitlement formula (from `foc.configuration`), season restrictions.

**Output:** `FocValidationResult` — `isValid: boolean`, per-check pass/fail, `requiresGmApproval: true` (always), failure reasons, entitlement remaining.

**S4 behaviour:** Called with current MSR and seasonality configuration — not S3 values. Configuration may have changed between S3 and S4. If `isValid: false`, confirmation is blocked — FOC must be stripped from the hold or renegotiated before confirmation can proceed.

### 5.3 TimerEngine

**Timer registrations at S4:**

| Timer Type | Registration Point | Fires At | Dispatches To |
|---|---|---|---|
| `STAGE_DWELL_MONITOR` | Entry enters S4 | Mode-dependent threshold | `StageDwellMonitor` (W1) |
| `PRE_ARRIVAL_COUNTDOWN` | `ReservationService.confirm()` | Pre-arrival window opens relative to arrival date | `PreArrivalWindowActivationWorker` (W4) |
| `ACKNOWLEDGEMENT_WINDOW` | `CommunicationService.send()` on voucher dispatch | Configured window per type | `AcknowledgementWindowWorker` (W22) |

**Timer cancellations at S4:**

| Timer Cancelled | Cancellation Point | Service |
|---|---|---|
| `COMMITTED_HOLD_EXPIRY` | S4 confirmation — atomic with CONFIRMED state transition | `HoldService.confirmCommittedHold()` |

**Immediate fire:** If arrival is same-day or next-day at S4 confirmation time, `PRE_ARRIVAL_COUNTDOWN` fires immediately. S5 activates in compressed mode.

**OTA auto-fulfilment:** For entries where `Entry.otaSource = true` and OTA booking reference is present, `ACKNOWLEDGEMENT_WINDOW` timer is NOT registered for the confirmation voucher. The OTA channel serves as the acknowledgement medium.

---

## Section 6 — Services Active at S4

### 6.1 ReservationService

**S4 responsibilities:** Creates the `Reservation` record (commitment snapshot); manages overbooking detection; manages FOC re-verification; manages ownership assignment; creates H1 handoff; generates and dispatches confirmation voucher.

**Method: `ReservationService.confirm(entryId, actorId)`**

Execution sequence (all steps within one database transaction unless noted):

1. **Load CancellationDisclosureRecord.** Query by entryId and current segmentId. If not found, raise `PolicyGateBlockedError`. This record is unconditionally required — no "if available" logic.

2. **Load BillingModelTransitionRecord.** Query `BillingModelTransitionRecord` where `folioId = entry.folio.id`, ordered by `createdAt DESC`, take first record's `toModel`. This is `frozenBillingModel`.

3. **Load accepted Quotation.** Query `Quotation` where `entryId` and `segmentId` and `state = ACCEPTED`. Extract `commercialTerms` for frozen fields.

4. **Load CreditExtensionCeilingRecord** (if present). Query by folioId. If found, `creditCeilingIfExtended = ceilingAmount`. If not found, `creditCeilingIfExtended = null`.

5. **Authority check (Policy 40).** Validate that `actorId` has sufficient authority for the entry's use type and value. Conference entries require FOM. High-value entries require FOM per configured threshold.

6. **Multi-booking detection (Policy 13).** Check for overlapping confirmed bookings for the same guest identity. If detected, require FOM acknowledgement before proceeding.

7. **Overbooking detection (Policy 41).** Call `OverbookingDetectionEngine.detect()`. If `overbookingDetected: true`: halt; initiate GM approval workflow; resume only after GM approval recorded. Create `OtaConflictOverbookingRecord` with correct `triggerType`.

8. **FOC re-verification (Policy 39).** For GROUP and CONFERENCE entries with FOC rooms: call `FOCValidationEngine.validate()` with current configuration. If `isValid: false`, block confirmation. GM approval required after validation passes.

9. **Conference verification (Policy 67).** For CONFERENCE entries: verify FOM has completed hall, seating, F&B, and special requests review. If verification incomplete, block.

10. **Create Reservation record.** Populate all frozen fields per §2.1 sourcing table. This record is immutable from creation.

11. **Confirm committed hold.** Call `HoldService.confirmCommittedHold(holdId, actorId)`. This transitions `CommittedHold.state → CONFIRMED`, writes `RoomClaimStateEvent`, cancels `COMMITTED_HOLD_EXPIRY` timer, and emits `TraceEvent`. All in the same transaction.

12. **Assign ownership (D-02).** Determine ownership per `ownership.assignmentRules`. Emit `TraceEvent` with `eventType = OWNERSHIP_ASSIGNED`, carrying the assigned actor and authority basis.

13. **Create H1 HandoffRecord (D-01).** Call `HandoffService.create()` with `handoffType = H1`, `stageContext = S4`. Populate `checklistContent` from the active `HandoffChecklistTemplate` for H1. If reservations and front desk are the same team, set `isAutoFulfilled = true`.

14. **Generate confirmation voucher.** Call `DocumentGenerationInterface.generate(CONFIRMATION_VOUCHER, input)`. The voucher contains: reservation reference, guest name, dates, room type and count, confirmed rate, inclusions, payment status, cancellation terms, special conditions, and credit ceiling if applicable.

15. **Dispatch confirmation communication.** Call `CommunicationService.send()` with the voucher. This creates a `CommunicationRecord`, dispatches via `EmailInterface.sendOutbound()` and/or `WhatsAppInterface.sendOutbound()`, and registers the `ACKNOWLEDGEMENT_WINDOW` timer. For OTA-sourced entries, the acknowledgement is auto-fulfilled on dispatch — no timer registered.

16. **Register pre-arrival countdown.** Call `TimerEngine.register()` with `PRE_ARRIVAL_COUNTDOWN`. If arrival is same-day or next-day, timer fires immediately.

17. **Emit confirmation TraceEvent.** `RESERVATION.CONFIRMED` carrying entryId, segmentId, reservationId, confirmedBy, confirmedAt, authority basis.

**Atomicity:** Steps 10, 11, 12, 13, and 17 are in the same database transaction. Partial commit is a structural defect — all five writes or none. Steps 14–16 (document generation, communication dispatch, timer registration) may execute after the transaction commits but must complete before S4 exit is reported as successful.

**Models read:** `Entry`, `Quotation` (ACCEPTED), `CancellationDisclosureRecord`, `BillingModelTransitionRecord`, `CreditExtensionCeilingRecord`, `Folio`, `CommittedHold`, `GuestProfile`, `WorkOrder` (CONFERENCE/GROUP), `ConfigurationEntry` (authority thresholds, overbooking limits, OTA conflict rules, FOC config, ownership rules, acknowledgement window)

**Models written:** `Reservation` (created), `CommittedHold` (CONFIRMED), `Room.currentClaimState` (CONFIRMED), `RoomClaimStateEvent`, `HandoffRecord` (H1), `CommunicationRecord`, `TraceEvent` (multiple)

### 6.2 EntryService

**S4 responsibilities:** Manages stage progression to S5 (triggered by W4); creates segments on re-entry from S4.

**Method: `EntryService.progressStage(entryId, targetStage, actorId)`**

At S4, this is called by `PreArrivalWindowActivationWorker` (W4) with `targetStage = S5`. The entry transitions from `(ACTIVE, S4)` to `(ACTIVE, S5)`. `StageDwellRecord` for S4 gets `exitedAt` populated. New `StageDwellRecord` for S5 created.

**Method: `EntryService.createSegment(entryId, reEntryReason, actorId)`**

Called on governed re-entry from S4 to S1, S2, or S3. Creates a new `Segment`, seals the prior segment, invokes `ReEntryConsequenceEngine.compute()` with the transition type, and executes consequences in the same transaction.

### 6.3 HoldService

**S4 responsibility:** Confirms the committed hold.

**Method: `HoldService.confirmCommittedHold(holdId, actorId)`**

Called by `ReservationService.confirm()` at S4. Must execute in the same transaction as `Reservation` record creation.

- Input: `holdId` (CommittedHold.id), `actorId` (confirming actor — must match ReservationService caller)
- Pre-condition: `CommittedHold.state` must be `PLACED`. If state is RELEASED (hold expired), method throws — confirmation cannot proceed.
- Models written: `CommittedHold` (`state → CONFIRMED`; `confirmedAt` and `confirmedBy` populated); `RoomClaimStateEvent` (COMMITTED_HELD → CONFIRMED); `TraceEvent`
- Timer cancellation: `COMMITTED_HOLD_EXPIRY` (W3) timer cancelled via `TimerEngine` in the same transaction
- Atomicity: this method is part of the S4 confirmation transaction — `Reservation` creation, `HoldService.confirmCommittedHold()`, `COMMITTED_HOLD_EXPIRY` cancellation, and H1 creation are all in one transaction. Partial commit is a structural defect.
- Forbidden: calling this method outside of `ReservationService.confirm()`; confirming a hold not in PLACED state; confirming without cancelling the expiry timer in the same transaction

### 6.4 HandoffService

**S4 responsibility:** Creates the H1 handoff record.

**Method: `HandoffService.create(entryId, handoffType, fromRole, fromActorId, toRole, checklistContent, stageContext)`**

Called by `ReservationService.confirm()` with `handoffType = H1`, `stageContext = S4`. If the sending and receiving roles are the same team (configurable per property), `isAutoFulfilled = true` — the handoff infrastructure records the event for audit even when no inter-team transfer occurs.

H1 carries: complete reservation context, guest profile, confirmed terms, special requests, payment status, arrival details, credit ceiling if applicable, OTA_SOURCE flag, and any active overbooking status.

### 6.5 CommunicationService

**S4 responsibility:** Dispatches confirmation voucher; opens acknowledgement loop.

Called by `ReservationService.confirm()` after voucher generation. Creates a `CommunicationRecord` with `stageContext = S4`. Dispatches via `EmailInterface.sendOutbound()` and/or `WhatsAppInterface.sendOutbound()` per the guest's configured channel preferences. Registers `ACKNOWLEDGEMENT_WINDOW` timer via `TimerEngine.register()`.

For OTA-sourced entries (`Entry.otaSource = true`): the acknowledgement is auto-fulfilled on dispatch. `CommunicationRecord.acknowledgementStatus` set to `RECEIVED` immediately. No W22 timer registered.

---

## Section 7 — Workers Active at S4

### 7.1 StageDwellMonitor (W1)

**Governed stage:** S4 (among all stages)

**S4 behaviour:** Monitors dwell time within S4. If the entry sits in S4 without confirmation, the committed hold from S3 continues running its own expiry timer. If the hold expires before S4 confirmation, the worker alerts — the entry may need to return to S3 for a new hold.

**Timer type:** `STAGE_DWELL_MONITOR`

**Registered at:** Entry enters S4

**Models read:** `Entry`, `StageDwellRecord`
**Models written:** `StageDwellRecord` (dwell phase annotations), `TraceEvent`

### 7.2 CommittedHoldExpiryWorker (W3)

**Governed stage:** S3–S4

**S4 behaviour:** The committed hold timer continues running from S3 into S4 until it is either cancelled (at S4 confirmation) or fires (hold expired before confirmation). If the timer fires at S4:

- `CommittedHold.state → RELEASED`; `releaseReason = 'EXPIRY'`
- `Room.currentClaimState → FREE`
- `RoomClaimStateEvent` written
- FOM escalated immediately (high-severity event)
- Entry cannot confirm — the hold is gone

**Idempotency:** Before release, reads `CommittedHold.state`. If RELEASED or CONFIRMED, skips.

**Timer type:** `COMMITTED_HOLD_EXPIRY`

### 7.3 PreArrivalWindowActivationWorker (W4)

**Governed stage:** S4→S5

**S4 behaviour:** Registered at S4 confirmation via `TimerEngine.register()` with `PRE_ARRIVAL_COUNTDOWN`. Fires when the pre-arrival window opens. Calls `EntryService.progressStage()` with `targetStage = S5`.

**Immediate activation:** If arrival is same-day or next-day at S4 confirmation time, fires immediately. S5 activates in compressed mode — obligations are not skipped, they are compressed to real-time verification.

**Idempotency:** Before executing, reads `Entry.currentStage`. If not S4, skips. Also checks for existing `PRE_ARRIVAL.ACTIVATION_FIRED` TraceEvent for this entry and segment.

**Timer type:** `PRE_ARRIVAL_COUNTDOWN`

**Models read:** `Entry`, `Reservation`, `TimerRecord`
**Models written:** `Entry` (`currentStage → S5`), `TraceEvent`

### 7.4 AcknowledgementWindowWorker (W22)

**Governed stage:** S2–S9 (cross-stage)

**S4 behaviour (confirmation acknowledgement tracker):** When the timer fires for a `CommunicationRecord` with `stageContext = S4`, the worker treats the open loop as a confirmation acknowledgement tracker event. The consequence is an open loop requiring documented resolution at S4 exit. If the window is significantly exceeded, FOM is escalated.

**OTA auto-fulfilment:** Not registered for OTA-sourced entries — the acknowledgement is auto-fulfilled on dispatch.

**Idempotency:** Before executing `TIMED_OUT` transition, reads `CommunicationRecord.acknowledgementStatus`. If already RECEIVED or TIMED_OUT, skips.

**Timer type:** `ACKNOWLEDGEMENT_WINDOW`

**Models read:** `CommunicationRecord`
**Models written:** `CommunicationRecord` (`acknowledgementStatus → TIMED_OUT`), `TraceEvent`

### 7.5 EntryExpiryWorker (W20)

**Governed stage:** S1 (primary)

**S4 relevance:** The S1 entry expiry timer does not apply at S4 — it is cancelled or superseded when the entry progresses past S1. W20 is not active at S4 for entries that have reached this stage. Listed here for completeness as it appears in the worker catalogue referenced at source loading.

---

## Section 8 — API Routes at S4

### 8.1 Confirm Reservation (S4 primary route)

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/confirm` |
| Auth | `L1+` (L2+ for conference and high-value per Policy 40) |
| Request DTO | `ConfirmReservationRequestDTO` |
| Response DTO | `ReservationResponseDTO` |
| Service method | `ReservationService.confirm()` |
| Policies | Policy 4, 13, 20, 39, 40, 41, 42, 43, 52, 63, 66, 67 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError`, `PolicyGateBlockedError`, `OverbookingDetectedError`, `MissingConfigurationError`, `AppError` |
| Pagination | No |

**Request DTO — `ConfirmReservationRequestDTO`:**

| Field | Type | Req | Notes |
|---|---|---|---|
| `version` | integer | Required | Current `Entry.version` — optimistic lock guard |

**Response DTO — `ReservationResponseDTO`:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Reservation ID |
| `entryId` | string | |
| `segmentId` | string | |
| `frozenRate` | decimal | |
| `frozenRatePlanId` | string | |
| `frozenInclusions` | object | |
| `frozenCancellationTerms` | object | |
| `frozenBillingModel` | string | |
| `frozenCheckInDate` | datetime | |
| `frozenCheckOutDate` | datetime | |
| `frozenGuestCount` | integer | |
| `creditCeilingIfExtended` | decimal? | null if no credit extended |
| `confirmedAt` | datetime | |
| `confirmedBy` | string | |
| `confirmationVoucherSent` | boolean | |
| `handoffId` | string | H1 HandoffRecord ID |
| `overbookingRecordId` | string? | null if no overbooking |

### 8.2 Get Reservation

| Field | Value |
|---|---|
| Method + Path | `GET /reservations/:id` |
| Auth | `L1+` |
| Request DTO | `GetReservationRequestDTO` (path param: id) |
| Response DTO | `ReservationResponseDTO` |
| Service method | `ReservationService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |
| Pagination | No |

### 8.3 Progress Stage (S4→S5)

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` (path param: id; body: `targetStage = S5`, `version`) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | Policy 9 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError`, `AppError` |
| Pagination | No |

**Note:** S4→S5 is typically triggered by `PreArrivalWindowActivationWorker` (W4), not by direct API call. The route is available for manual progression in exceptional cases (e.g., compressed same-day arrivals where immediate progression is needed).

**Request DTO — `ProgressStageRequestDTO`:**

| Field | Type | Req | Notes |
|---|---|---|---|
| `targetStage` | string | Required | Must be `S5` for forward progression from S4 |
| `version` | integer | Required | Current `Entry.version` — optimistic lock guard |

### 8.4 Handoff Routes (H1 lifecycle)

| Route | Method + Path | Auth | Service method |
|---|---|---|---|
| List handoffs | `GET /handoffs` | L1+ | `HandoffService.list()` |
| Get handoff | `GET /handoffs/:id` | L1+ | `HandoffService.get()` |
| Accept handoff | `POST /handoffs/:id/accept` | L1+ | `HandoffService.accept()` |
| Fulfil handoff | `POST /handoffs/:id/fulfil` | L1+ | `HandoffService.fulfil()` |
| Reject handoff | `POST /handoffs/:id/reject` | L2+ | `HandoffService.reject()` |

H1 is created within `ReservationService.confirm()` — no separate creation route. H1 acceptance occurs at S5 when the receiving team acknowledges the handoff.

---

## Section 9 — Configuration Keys at S4

All configuration surfaces that must be present before S4 is considered live. Missing any blocking surface produces a `MissingConfigurationError` identifying the exact missing surface.

### 9.1 ConfigurationEntry Keys (from §2.17.3)

| configKey | Type | Blocking | Consequence if Missing |
|---|---|---|---|
| `overbooking.maxAllowedRooms` | Integer | Yes | Overbooking detection cannot execute — limit values not defined |
| `cancellation.policyTiers` | Json | Yes | Cancellation terms cannot be presented at confirmation |
| `foc.configuration` | Json | Yes | FOC re-verification (Policy 39) cannot execute at S4 confirmation — GROUP/CONFERENCE entries with FOC rooms will be blocked |
| `acknowledgement.windowPerType` | Json | Yes | Confirmation acknowledgement timeout cannot be scheduled |
| `ownership.assignmentRules` | Json | Yes | Custodian assignment at confirmation unavailable |
| `stageDwell.thresholds` | Json | Yes | Dwell monitoring at S4 unavailable (cross-stage) |

### 9.2 Registry Table Surfaces

| Registry Table | Required State | Blocking | Consequence if Missing |
|---|---|---|---|
| `CommunicationTemplate` (templateType = `CONFIRMATION`) | At least one active template | Yes | Confirmation voucher dispatch unavailable |
| `HandoffChecklistTemplate` (handoffType = `H1`) | At least one active template | Yes | H1 handoff creation blocked — checklist not defined |

### 9.3 Configuration Surfaces Not Yet in §2.17.3

The following surfaces are required by §79 (S4 readiness map) and referenced in Part 4 engine specifications, but do not have corresponding dotted-notation keys in §2.17.3. They are registered as new MCL items for the consolidated revision pass.

| Surface | Expected Key | Source Reference | MCL Status |
|---|---|---|---|
| Confirmation authority thresholds | `confirmation.authorityThresholds` | §79 S4 readiness; Policy 40 | New — to be added to §2.17.3 |
| OTA_CONFLICT trigger rules | `overbooking.otaConflictRules` | §79 S4 readiness; Part 4 §4.5.3 | New — to be added to §2.17.3 |

Until these keys are registered in §2.17.3, the developer should implement readiness checks against these surfaces using the expected key names above — they will be formally registered in the consolidated revision pass.

---

## Section 10 — Acceptance Criteria

### 10.1 Reservation Commitment Snapshot

**AC-S4-001:** On `ReservationService.confirm()`, a `Reservation` record is created with all frozen fields populated from the correct sources per §2.1 sourcing table. `frozenBillingModel` is populated from the latest `BillingModelTransitionRecord.toModel` on the Entry-level folio ordered by `createdAt DESC` — NOT from a TraceEvent fallback, NOT from `Folio.billingModel` directly. **PASS** = all fields populated from correct sources. **FAIL** = any field sourced incorrectly or missing.

**AC-S4-002:** `Reservation.frozenCancellationTerms` is populated from `CancellationDisclosureRecord.disclosedTerms`. The `CancellationDisclosureRecord` is loaded unconditionally at step 1 of `confirm()` — if not found, `PolicyGateBlockedError` is raised. **PASS** = record loaded unconditionally; error raised if absent. **FAIL** = conditional "if available" logic or silent null assignment.

**AC-S4-003:** `Reservation.creditCeilingIfExtended` is populated from `CreditExtensionCeilingRecord.ceilingAmount` if credit was extended. NULL if no credit extended. **PASS** = correct population. **FAIL** = always null or always populated regardless of credit extension status.

**AC-S4-004:** The `Reservation` record is immutable after creation. A test that attempts to update any frozen field directly after creation must be rejected by the application layer. **PASS** = update rejected. **FAIL** = frozen field modified.

### 10.2 Hold Confirmation Atomicity

**AC-S4-005:** `HoldService.confirmCommittedHold()` executes in the same transaction as `Reservation` creation, `COMMITTED_HOLD_EXPIRY` timer cancellation, and H1 `HandoffRecord` creation. A test that induces a failure after `CommittedHold.state → CONFIRMED` but before `Reservation` creation must result in a full rollback — hold remains PLACED. **PASS** = all four writes succeed or all roll back. **FAIL** = partial commit (hold CONFIRMED without Reservation).

**AC-S4-006:** After successful confirmation, `CommittedHold.state = CONFIRMED`, `Room.currentClaimState = CONFIRMED`, and the `COMMITTED_HOLD_EXPIRY` timer is cancelled. A test that checks timer status after confirmation must find the timer cancelled or completed. **PASS** = all three conditions met. **FAIL** = any condition unmet.

**AC-S4-007:** If `CommittedHold.state` is RELEASED (expired before confirmation), `HoldService.confirmCommittedHold()` throws. Confirmation cannot proceed. **PASS** = error thrown. **FAIL** = confirmation proceeds on expired hold.

### 10.3 Overbooking Detection

**AC-S4-008:** When confirming creates an overbooking condition, `OverbookingDetectionEngine.detect()` returns `overbookingDetected: true` and confirmation halts until GM approval is recorded. **PASS** = confirmation blocked; GM approval required. **FAIL** = confirmation proceeds without GM approval.

**AC-S4-009:** For an OTA-sourced entry (`Entry.otaSource = true`) that creates an overbooking condition, `triggerType` is set to `OTA_CONFLICT`. A test that passes `otaSource = true` to the engine must receive `triggerType: OTA_CONFLICT` regardless of other inputs. **PASS** = OTA_CONFLICT. **FAIL** = DELIBERATE or null.

**AC-S4-010:** `OtaConflictOverbookingRecord.triggerType` is immutable once set. A test that attempts to update `triggerType` from OTA_CONFLICT to DELIBERATE must be rejected. **PASS** = update rejected. **FAIL** = trigger type changed.

**AC-S4-011:** OTA_CONFLICT creates two open loops: `otaNotificationStatus: OPEN` and `mitigationPlanStatus: OPEN`. Both must be present on the record at creation. **PASS** = both OPEN. **FAIL** = either missing or pre-closed.

### 10.4 FOC Verification

**AC-S4-012:** For a GROUP entry with FOC rooms, `FOCValidationEngine.validate()` is called at S4 with current MSR and seasonality configuration. If validation fails, confirmation is blocked. **PASS** = validation called with current config; failure blocks confirmation. **FAIL** = validation skipped or uses S3-era config.

### 10.5 Multi-Booking Detection

**AC-S4-013:** When confirming creates an overlapping reservation for the same guest identity, the system requires FOM acknowledgement before confirmation proceeds. **PASS** = FOM acknowledgement required. **FAIL** = auto-confirmation.

### 10.6 Confirmation Communication

**AC-S4-014:** On successful confirmation, a confirmation voucher is generated via `DocumentGenerationInterface.generate(CONFIRMATION_VOUCHER, ...)` and dispatched to the guest or agent with a tracked `CommunicationRecord`. **PASS** = voucher generated, dispatched, CommunicationRecord created. **FAIL** = any step missing.

**AC-S4-015:** An `ACKNOWLEDGEMENT_WINDOW` timer is registered for the confirmation voucher communication. If the window expires without acknowledgement, `AcknowledgementWindowWorker` (W22) transitions `CommunicationRecord.acknowledgementStatus` to `TIMED_OUT`. **PASS** = timer registered; TIMED_OUT on expiry. **FAIL** = no timer or silent expiry.

**AC-S4-016:** For OTA-sourced entries (`Entry.otaSource = true`), the acknowledgement loop is auto-fulfilled on voucher dispatch. No W22 timer is registered. `CommunicationRecord.acknowledgementStatus` is set to `RECEIVED` immediately. **PASS** = auto-fulfilled; no timer. **FAIL** = timer registered for OTA entry or status remains PENDING.

### 10.7 Ownership and Handoff

**AC-S4-017:** On confirmation, a `TraceEvent` with `eventType = OWNERSHIP_ASSIGNED` is emitted carrying the assigned actor. **PASS** = TraceEvent present. **FAIL** = no ownership assignment event.

**AC-S4-018:** On confirmation, an H1 `HandoffRecord` is created with `handoffType = H1`, `stageContext = S4`. If reservations and front desk are the same team, `isAutoFulfilled = true`. **PASS** = H1 created with correct fields. **FAIL** = H1 missing or incorrect handoff type.

### 10.8 Pre-Arrival Countdown

**AC-S4-019:** On confirmation, `PRE_ARRIVAL_COUNTDOWN` timer is registered via `TimerEngine.register()`. When the timer fires, `PreArrivalWindowActivationWorker` (W4) transitions the entry to S5. **PASS** = timer registered; S5 activated on fire. **FAIL** = no timer or S5 not activated.

**AC-S4-020:** For same-day or next-day arrivals at S4 confirmation time, the `PRE_ARRIVAL_COUNTDOWN` timer fires immediately. S5 activates in compressed mode. **PASS** = immediate fire; compressed mode flag set. **FAIL** = timer scheduled for future date.

### 10.9 Configuration Readiness

**AC-S4-021:** If any blocking S4_READINESS surface is missing (§9.1 and §9.2), `ReservationService.confirm()` raises `MissingConfigurationError` identifying the specific missing surface. **PASS** = specific error raised. **FAIL** = generic error or confirmation proceeds.

### 10.10 Forbidden Action Prevention

**AC-S4-022:** `PricingPipelineEngine.resolve()` is NOT called during `ReservationService.confirm()` on a standard forward path from S3. A test that instruments the engine and calls confirm on a standard path must find zero engine invocations. **PASS** = no engine call. **FAIL** = engine invoked.

**AC-S4-023:** Setting `OtaConflictOverbookingRecord.triggerType` to `DELIBERATE` when `Entry.otaSource = true` is rejected. **PASS** = rejected. **FAIL** = DELIBERATE set on OTA entry.

**AC-S4-024:** No second `Reservation` record may be created for the same entry and segment. A test that calls `ReservationService.confirm()` twice for the same entry and segment must find the second call rejected. **PASS** = second call rejected. **FAIL** = duplicate Reservation created.

### 10.11 Re-Entry Behaviour

**AC-S4-025:** On S4→S3 back-flow (billing model change): `EntryService.createSegment()` creates a new segment, seals the prior segment. The prior `Reservation` from the first S4 passage is preserved as read-only. **PASS** = new segment created; prior Reservation untouched. **FAIL** = prior Reservation modified or no new segment.

**AC-S4-026:** On re-entry to S4 from a prior S4→S3→S4 round-trip, a new `Reservation` record is created. The prior Reservation is read-only history. The single Entry-level folio persists — no duplicate folio. **PASS** = new Reservation; single folio. **FAIL** = prior Reservation updated or multiple folios.

---

*SIG-S4 v2.0 — DRAFT*
*Prepared by: Claude (AI Architectural Partner)*
*Derived from DEV-SPEC-001 Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13 — Canon v2.5*
*Zero-gap document. All dependency language eliminated. All GAP-S4-001 through GAP-S4-005 absorbed.*
