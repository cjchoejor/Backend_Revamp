# LEGPHEL PMS — Stage Implementation Guideline
## S3: Reservation Setup

**Document ID:** SIG-S3
**Version:** 2.0
**Derived from:** DEV-SPEC-001 (Parts 0, 2 REV2, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT — Pending Architect confirmation
**Nothing in this document is locked until the Architect confirms.**

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Initial generation. Six findings surfaced (SIG-S3-COR-001 through SIG-S3-COR-006). Self-check pass corrected three items before lock. |
| 1.1 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Self-check corrections applied. Locked by Architect 13 April 2026. SIG-S3-ADDENDUM-001 produced separately for W34 resolution. |
| 2.0 | 13 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | Full regeneration from corrected source documents. Part 2 REV2-FINAL and Part 6 REV3 locked. All MOM-ARCH-2026-020 decisions absorbed (Q1–Q4). W34 ADDENDUM-001 integrated. All gap markers, finding markers, and fallback language eliminated. Zero-gap document. |

---

## Source Confirmation Table

| # | Source | File | Key Sections Read |
|---|---|---|---|
| 1 | Prior SIG S1 v1.2 | SIG-S1-v1_2.md | Version history; S3→S1 re-entry additions (§1.3, §2.13, §6, §10.8) |
| 2 | Prior SIG S2 v1.3 | SIG-S2-v1_3.md | Version history; S3→S2 re-entry additions (§1.3, §2.9, §6); §2.2 Quotation commercialTerms; §3.4 Quotation state machine |
| 3 | Master Correction Log v1.6 | MASTER-CORRECTION-LOG-v1_6.md | Full document — all sections; Part 2 REV2 and Part 6 REV3 items confirmed APPLIED |
| 4 | System Overview | DEV-SPEC-001-Part0.md | §0.1–§0.8 |
| 5 | S3 Stage Charter | Canon_Block6_S3_S4_REV2_2.md | §44.1–§44.19 full |
| 6 | Canon Matrices | Canon_Block11_Matrices_Governance_Appendices_REV2_2.md | §72 Stage-to-Policy; §73 Stage-to-Config; §74 Stage-to-Record; §76 Stage-to-Timer/Worker; §76A Transition Matrix; §79 S3 readiness map |
| 7 | Schema | DEV-SPEC-001-Part2-REV2-FINAL.md | All S3-active models and enums; §2.17.3 configuration key table |
| 8 | State Machine | DEV-SPEC-001-Part3.md | §3.2 Entry Lifecycle; §3.3 Folio; §3.5 Hold (committed); §3.6 Inventory Claim |
| 9 | Engines | DEV-SPEC-001-Part4.md | §4.7 FOCValidationEngine; §4.10 TimerEngine; §4.11 ReEntryConsequenceEngine |
| 10 | Policies | DEV-SPEC-001-Part5-REV2.md | Policies 8, 27, 28, 30, 34, 38, 42, 52, 69, 71 |
| 11 | Services | DEV-SPEC-001-Part6-REV3.md | Full — EntryService, FolioService, HoldService, PaymentService, CancellationService, AvailabilityService, ReservationService |
| 12 | Workers | DEV-SPEC-001-Part8.md | W1 StageDwellMonitor; W3 CommittedHoldExpiryWorker; W22 AcknowledgementWindowWorker |
| 13 | SIG-S3-ADDENDUM-001 | SIG-S3-ADDENDUM-001.md | Full — W34 AdvancePaymentFollowUpWorker complete specification |
| 14 | Routes | DEV-SPEC-001-Part9-REV1.md | S3 routes: committed hold, folio, payment, invoice, cancellation |
| 15 | Integration | DEV-SPEC-001-Part11.md | §11.2 EmailInterface; §11.3 WhatsAppInterface; §11.8 DocumentGenerationInterface |
| 16 | Configuration | DEV-SPEC-001-Part12.md | §12.3.1 S3_READINESS table |
| 17 | Acceptance Gates | DEV-SPEC-001-Part13.md | S3 assertion coverage across all gates |

---

## Table of Contents

1. [Stage Identity](#section-1--stage-identity)
2. [Schema Models Active at S3](#section-2--schema-models-active-at-s3)
3. [State Machine at S3](#section-3--state-machine-at-s3)
4. [Policies Enforced at S3](#section-4--policies-enforced-at-s3)
5. [Engines Invoked at S3](#section-5--engines-invoked-at-s3)
6. [Services Active at S3](#section-6--services-active-at-s3)
7. [Workers Active at S3](#section-7--workers-active-at-s3)
8. [API Routes at S3](#section-8--api-routes-at-s3)
9. [Configuration Keys at S3](#section-9--configuration-keys-at-s3)
10. [Acceptance Criteria](#section-10--acceptance-criteria)

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 3 (S3) — Reservation Setup**

### 1.2 Stage Purpose

Stage 3 exists to prepare the operational and financial foundations for a confirmed reservation — placing a committed inventory hold, establishing the provisional folio, initiating advance payment collection, fixing the billing model, and resolving primary guest and contact information — without yet crossing the confirmation boundary.

If S3 is completed correctly, the system holds: a committed inventory hold on the selected rooms or spaces; a provisional folio with any proforma invoices issued and advance payments recorded; a fixed billing model as the initial commitment (guest-pay, direct-bill, or tour operator voucher); resolved primary guest and contact details; disclosed cancellation terms including no-show financial treatment; and a complete carry-forward of the agreed commercial terms from S2. The entry is operationally ready for confirmation but has not yet been confirmed.

S3 does not confirm the reservation. It does not freeze commercial terms. It does not lock inventory beyond a committed hold with expiry. It does not create any confirmation voucher.

### 1.3 Entry Routes

**Forward from S2.** The entry has an accepted quotation. The commercial terms are agreed. The entry is ready for operational setup before confirmation. S3 receives: the accepted quotation with agreed `commercialTerms`, the selected availability configuration, the entry's full context (guest profile, source channel, contacts, use type, dates, composition), any speculative hold already in place (from S2, to be upgraded to committed), and any special conditions negotiated.

**Forward from S1 (S2 auto-fulfilled).** The guest accepted a standard package rate without negotiation. S2 was auto-fulfilled — recorded as completed with a `TraceEvent` noting its passage. The entry carries the package rate as the accepted commercial basis and proceeds directly to S3. Guard conditions for S3 entry are identical to the S2 forward path.

**Re-entry from S4 or S7.** The transition matrix authorises two direct re-entry paths into S3: S4→S3 (billing model change or payment renegotiation post-confirmation, FOM/GM authority) and S7→S3 (billing model change during stay or additional payment arrangement, GM for billing model / FOM for payment). Entries from other stages may arrive at S3 through multi-hop re-entry paths (e.g., S5→S1→S2→S3). Each re-entry creates a new segment via `EntryService.createSegment()`.

**Re-entry from S3→S2 back-flow — rate renegotiation completed.** An entry that exited S3 to S2 for commercial term renegotiation returns to S3 with a new accepted quotation. On this re-entry path:

- The prior `CommittedHold` was **retained** on the sealed segment — it remained in `PLACED` state with its expiry timer running during S2 renegotiation. `HoldService` checks for an active prior-segment hold before placing a new one. If the prior hold has expired during renegotiation, a fresh `AvailabilityService` check runs and a new committed hold must be placed.
- The Entry-level provisional folio already exists and persists. `FolioService.getOrCreate()` returns the existing folio — no new folio created. All prior `PaymentRecord` entries are visible. Existing proforma invoices were **not superseded** on S3→S2 exit — dates and room type were unchanged.
- `FOLIO.REENTRY_CONTINUATION` TraceEvent is emitted when `FolioService.getOrCreate()` finds the existing folio.
- `BillingModelTransitionRecord` is created if the billing model changes on this re-entry passage (fromModel populated from current `Folio.billingModel`; toModel set to the new value).

**Re-entry from S3→S1 back-flow — fundamental reconfiguration completed.** An entry that exited S3 to S1 for a room type or date range change returns to S3 after completing a fresh S1 search and S2 negotiation (or S2 auto-fulfilment). On this re-entry path:

- The prior `CommittedHold` was **released** on the S3→S1 exit — inventory returned to `FREE` in the same transaction as the segment seal. `HoldService.releaseOnReEntry()` executed this with `releaseReason: REENTRY_S3_TO_S1`. A new committed hold must be placed at this S3 passage.
- All `PROVISIONAL` and `DISPATCHED` invoices on the Entry-level folio were **superseded** to `InvoiceState.SUPERSEDED` on S3→S1 exit. W22 and W34 timers for those invoices were cancelled.
- The Entry-level provisional folio already exists and persists. `FolioService.getOrCreate()` returns the existing folio. Prior `PaymentRecord` entries from previous segments are visible and count toward the advance payment threshold.
- New proforma invoices are generated at this S3 passage based on the new commercial terms.

### 1.4 S3 Starting State

When an entry enters S3, the following state is expected:

- `Entry.currentStage = S3`; `Entry.status = ACTIVE`
- An accepted `Quotation` exists (state = `ACCEPTED`) on the current segment — or the S2 auto-fulfilment path was recorded with a package rate as the commercial basis
- If a `SpeculativeHold` was placed during S2, it exists in `HoldState.PLACED` with inventory in `SPECULATIVELY_HELD` state, eligible for upgrade to `CommittedHold` at hold placement
- `StageDwellRecord` created for S3 with `enteredAt` populated
- `STAGE_DWELL_MONITOR` timer registered via `TimerEngine.register()` for this entry at S3

### 1.5 Exit Conditions

The S3→S4 transition requires all of the following to be true. Guards are evaluated in sequence. Failure at any guard raises `StageGateBlockedError` identifying the specific unsatisfied condition.

1. A `CommittedHold` exists in `HoldState.PLACED` for the entry's selected rooms or spaces for the date range.
2. A `Folio` exists in `FolioState.PROVISIONAL` linked to the entry, with `billingModel` populated (non-null).
3. At least one `Invoice` of type `PROFORMA` has been generated on the folio (unless the billing model permits deferred billing without PI — applicable to contracted corporate clients).
4. The advance payment condition is satisfied: either total `PaymentRecord` entries with `paymentDirection = 'IN'` on the folio meet the configured threshold for the entry's source channel and client tier, or a `CreditExtensionCeilingRecord` exists for this folio with a non-null `ceilingAmount`.
5. A `BillingModelTransitionRecord` exists on the folio for the current segment with the initial billing model fixation (fromModel: null for first S3 passage; fromModel populated for re-entry).
6. A `CancellationDisclosureRecord` exists for the entry and current segment with `noShowTreatmentStatement` populated (non-null, non-empty).
7. Primary guest and contact details are resolved on the `GuestProfile` linked to the inquiry.
8. For GROUP and CONFERENCE entries with FOC rooms in the committed hold: `FOCValidationEngine.validate()` returns `isValid: true` and GM approval is recorded.
9. For CORPORATE and CONFERENCE entries with payment milestones: milestone schedule is configured with Timer Engine entries for each milestone.
10. For GROUP and CONFERENCE entries: coordinator formally confirmed with authority scope recorded.
11. No active `ProcessingLockRecord` with `status = ACTIVE` on any inventory item in the committed hold.
12. Authority satisfied: the acting user is at minimum `ActorLevel.FRONT_DESK` (Custodian). High-value entries may require `ActorLevel.FOM`.

### 1.6 Governing Actors

| Role | Actor Level | Authority at S3 |
|---|---|---|
| Receptionist / Reservations | `ActorLevel.FRONT_DESK` (L1) | Places committed hold; creates folio; records payment; issues PI; fixes billing model; records cancellation disclosure; initiates cancellation (S1–S3) |
| Front Office Manager | `ActorLevel.FOM` (L2) | All L1 actions; approves credit extension with ceiling; approves FOC inclusion after engine validation (delegates to GM); extends committed hold; initiates S3→S2 back-flow; initiates S3→S1 back-flow |
| General Manager | `ActorLevel.GM` (L3) | All L2 actions; approves FOC rooms after FOCValidationEngine passes; approves credit ceiling above FOM threshold |
| Admin | `ActorLevel.ADMIN` (L4) | Configuration only; not an operational actor at S3 |

### 1.7 Forbidden Actions at S3

The following must not occur during S3. Each is an architectural violation if implemented.

- **No reservation confirmation.** No confirmation voucher, confirmation reference, or confirmation-grade communication may be produced. Confirmation belongs to S4.
- **No inventory lock.** S3 places a committed hold — it does not lock inventory. A hold is a strong claim with expiry; a lock (at S4) is a confirmed commitment with frozen terms.
- **No rate freezing.** Commercial terms are agreed (from S2) but not yet frozen. If the underlying rate plan changes between S3 and S4, the system surfaces this at S4's confirmation verification.
- **No room-specific assignment.** S3 deals with room types and categories, not specific room numbers. Room assignment is an S5/S6 responsibility.
- **No live folio creation.** The folio at S3 is provisional. It does not convert to live until S6. Posting room charges, F&B charges, or service charges to a provisional folio is forbidden.
- **No skipping billing model fixation.** The entry must not leave S3 without a fixed billing model recorded as the initial commitment.
- **No credit extension without ceiling.** A credit extension approval that does not include a defined ceiling amount is a structurally incomplete approval. The system blocks the approval record creation.
- **No communicating hold as confirmation.** Telling the guest "your rooms are held" is operationally true. Telling them "your reservation is confirmed" is not.
- **No duplicate folio creation on re-entry.** `FolioService.getOrCreate()` is the sole entry point for provisional folio creation. No code path may create a second provisional folio for the same entry.

---

## Section 2 — Schema Models Active at S3

The following Prisma models are read or written during S3 operations. Only fields relevant to S3 are called out. The full schema with all models and relations is in Part 2 REV2-FINAL.

---

### 2.1 Entry

**Access at S3:** Read and written. Stage progression and park state are the primary write operations.

```prisma
model Entry {
  id                   String          @id @default(uuid())
  inquiryId            String          // immutable — no re-parenting
  segmentNumber        Int             @default(1)
  useType              EntryUseType    // immutable after creation
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

**S3 mutation rule:** `currentStage` updated from S3 to S4 on forward exit; to S2 or S1 on back-flow exit — all via `EntryService.progressStage()`. `status` may transition between ACTIVE and PARKED. `version` incremented on every update. No other fields are written at S3 by staff action.

---

### 2.2 Segment

**Access at S3:** Read (current segment context). Created on re-entry events.

```prisma
model Segment {
  id              String    @id @default(uuid())
  entryId         String
  segmentNumber   Int
  stage           Stage
  startedAt       DateTime  @default(now())
  sealedAt        DateTime?
  sealedBy        String?
  notes           String?
  createdBy       String    // actor_id — NOT NULL

  billingModelTransitions BillingModelTransitionRecord[]

  @@unique([entryId, segmentNumber])
}
```

**S3 mutation rule:** Prior segments are read-only once sealed. A new segment is created on each re-entry event — not by updating the existing segment. Only the current segment's current stage is editable.

---

### 2.3 CommittedHold

**Access at S3:** Created at committed hold placement. State transitions at S4 (CONFIRMED) or on expiry/release (RELEASED).

```prisma
model CommittedHold {
  id              String    @id @default(uuid())
  entryId         String
  segmentId       String
  roomId          String?
  spaceId         String?
  state           HoldState @default(PLACED)
  placedAt        DateTime
  placedBy        String    // actor_id — NOT NULL
  commercialJustification String
  ttlSeconds      Int
  expiresAt       DateTime
  confirmedAt     DateTime?
  confirmedBy     String?
  releasedAt      DateTime?
  releasedBy      String?
  releaseReason   String?
  createdAt       DateTime  @default(now())
}
```

**S3 mutation rule:** Created at S3 in `PLACED` state. No direct field edits after creation. State transitions: `PLACED → CONFIRMED` (at S4), `PLACED → RELEASED` (expiry, cancellation, or governed S3→S1 re-entry release). The `COMMITTED_HOLD_EXPIRY` timer is registered at placement.

---

### 2.4 Folio

**Access at S3:** Created (first S3 passage) or retrieved (re-entry) via `FolioService.getOrCreate()`. Written: `billingModel` field populated at billing model fixation.

```prisma
model Folio {
  id                    String      @id @default(uuid())
  entryId               String
  state                 FolioState  @default(PROVISIONAL)
  convertedToLiveAt     DateTime?
  convertedBy           String?
  closedAt              DateTime?
  closedBy              String?
  noShowPenaltyAmount   Decimal?    @db.Decimal(15,2)
  noShowAdvancePaymentAmount Decimal? @db.Decimal(15,2)
  noShowNetPosition     Decimal?    @db.Decimal(15,2)
  noShowFomDetermination String?
  postClosureAccessLevel PostClosureAccessLevel?
  billingModel          String?     // non-null from S3 fixation onward
  createdAt             DateTime    @default(now())
  createdBy             String      // actor_id — NOT NULL
}
```

**S3 mutation rule:** One provisional folio per Entry lifecycle. Created at first S3 passage. Persists through all segments. `FolioService.getOrCreate()` is the sole creation entry point — no duplicate folio creation on re-entry. Restricted to PIs and payment records only — no live charges. `billingModel` set at initial fixation; full transition history in `BillingModelTransitionRecord`.

---

### 2.5 BillingModelTransitionRecord

**Access at S3:** Created at billing model fixation.

```prisma
model BillingModelTransitionRecord {
  id              String    @id @default(uuid())
  folioId         String
  segmentId       String
  fromModel       String?   // null on initial S3 fixation
  toModel         String    // new/initial billing model
  authorisedBy    String    // actor_id — FOM minimum
  authorityBasis  String
  reason          String    // mandatory recorded reason
  effectiveFrom   DateTime  @default(now())
  createdAt       DateTime  @default(now())
}
```

**S3 mutation rule:** Immutable from creation. First record at S3 initial fixation has `fromModel: null`. Subsequent records on re-entry carry the transition (fromModel populated from current `Folio.billingModel` before update).

---

### 2.6 Invoice

**Access at S3:** Created (proforma invoices). State transitions on dispatch and on S3→S1 supersession.

```prisma
model Invoice {
  id              String        @id @default(uuid())
  folioId         String
  entryId         String
  invoiceType     InvoiceType   // PROFORMA at S3
  state           InvoiceState  @default(CREATED)
  invoiceNumber   String        @unique
  totalAmount     Decimal       @db.Decimal(15,2)
  currency        String        @default("BTN")
  taxAmount       Decimal       @db.Decimal(15,2)
  issuedAt        DateTime?
  dispatchedAt    DateTime?
  dispatchedTo    String?
  reconciledAt    DateTime?
  supersededById  String?
  versionNumber   Int           @default(1)
  createdAt       DateTime      @default(now())
  createdBy       String        // actor_id — NOT NULL
}
```

**S3 mutation rule:** Not editable after dispatch — credit note or adjustment only. `InvoiceState` values at S3: `CREATED` (generated), `DISPATCHED` (sent to guest/agent), `SUPERSEDED` (two uses: earlier proforma version superseded by new version; or governed S3→S1 re-entry supersession).

---

### 2.7 PaymentRecord

**Access at S3:** Created when advance payment is received.

```prisma
model PaymentRecord {
  id                     String    @id @default(uuid())
  folioId                String
  invoiceId              String?
  entryId                String
  amount                 Decimal   @db.Decimal(15,2)
  currency               String    @default("BTN")
  foreignCurrencyAmount  Decimal?  @db.Decimal(15,2)
  btnEquivalent          Decimal?  @db.Decimal(15,2)
  exchangeRate           Decimal?  @db.Decimal(10,6)
  paymentMethod          String    // CASH | CARD | BANK_TRANSFER | CREDIT_ACCOUNT
  paymentDirection       String    @default("IN")
  matchingOutcome        String?
  receivedAt             DateTime
  recordedBy             String    // actor_id — NOT NULL
  stage                  Stage
  createdAt              DateTime  @default(now())
}
```

**S3 mutation rule:** Immutable from creation. Refund is a new `PaymentRecord` with `paymentDirection = 'OUT'` — not a reversal of the original record. All PaymentRecords with `paymentDirection = 'IN'` on the Entry-level folio are visible across all segments and count toward the advance payment threshold.

---

### 2.8 CancellationDisclosureRecord

**Access at S3:** Created before committed hold placement.

```prisma
model CancellationDisclosureRecord {
  id                       String    @id @default(uuid())
  entryId                  String
  segmentId                String
  folioId                  String?
  cancellationPolicyId     String
  disclosedTerms           Json
  noShowTreatmentStatement String    // mandatory — record cannot be created without this
  disclosedAt              DateTime
  disclosedBy              String    // actor_id — NOT NULL
  guestAcknowledged        Boolean   @default(false)
  acknowledgementMethod    String?   // VERBAL | WRITTEN | WHATSAPP | EMAIL
  createdAt                DateTime  @default(now())
}
```

**S3 mutation rule:** Immutable from creation. The committed hold route enforces presence of this record as a pre-condition. A missing disclosure record produces a `PolicyGateBlockedError` at the hold placement boundary. Disclosure without `noShowTreatmentStatement` is an incomplete disclosure — the record must not be created.

---

### 2.9 CreditExtensionCeilingRecord

**Access at S3:** Created when FOM approves credit extension with mandatory ceiling amount.

```prisma
model CreditExtensionCeilingRecord {
  id              String    @id @default(uuid())
  folioId         String    @unique
  entryId         String
  ceilingAmount   Decimal   @db.Decimal(15,2)
  currency        String    @default("BTN")
  approvedBy      String    // actor_id with FOM or GM authority — NOT NULL
  approvedAt      DateTime
  reason          String
  createdAt       DateTime  @default(now())
}
```

**S3 mutation rule:** Immutable from creation. A credit extension without a ceiling amount is a structurally forbidden approval — the system blocks creation. Ceiling revision adds a new record — the original is preserved.

---

### 2.10 SpeculativeHold (Upgrade Path)

**Access at S3:** Written (upgrade path only — when upgrading from S2 speculative hold to committed hold).

```prisma
model SpeculativeHold {
  id              String    @id @default(uuid())
  entryId         String
  segmentId       String
  roomId          String?
  spaceId         String?
  state           HoldState @default(PLACED)
  placedAt        DateTime
  placedBy        String    // actor_id — NOT NULL
  approvalBasis   String
  ttlSeconds      Int
  expiresAt       DateTime
  releasedAt      DateTime?
  releasedBy      String?
  releaseReason   String?
  upgradedToId    String?   // CommittedHold.id — populated on upgrade
  createdAt       DateTime  @default(now())
}
```

**S3 mutation rule:** Not created at S3 — creation is S2 only. At S3, the upgrade path writes two fields: `state` (PLACED → UPGRADED) and `upgradedToId` (populated with the new `CommittedHold.id`). The `SPECULATIVE_HOLD_EXPIRY` timer is cancelled in the same transaction as the upgrade. If no speculative hold exists from S2, this model is not touched at S3.

---

### 2.11 Supporting Models

The following models are read or written at S3 in supporting roles:

**StageDwellRecord** — created on S3 entry; tracks dwell time and warning/critical/escalation events within S3. Written by `StageDwellMonitor` (W1).

**TraceEvent** — immutable event records written on every governed action at S3: hold placement, payment receipt, PI dispatch, billing model fixation, cancellation disclosure, re-entry consequence execution, timer registration, timer cancellation.

**ConfigurationEntry** — read for all S3 configuration parameters (advance payment thresholds, committed hold TTL, billing model availability, cancellation penalty tiers, FOC configuration, proforma invoice templates, credit ceiling thresholds, payment milestone templates, acknowledgement window settings). Managed via the Admin Console.

**WorkOrder** — optionally created at S3 for engagement types with service obligations (conference, group with package, catering). Carries F&B configurations, special requests, and coordinator-confirmed service details.

**CommunicationRecord** — created on PI dispatch and cancellation disclosure communication. Tracks acknowledgement state (`PENDING`, `RECEIVED`, `TIMED_OUT`).

**RoomClaimStateEvent** — immutable audit record written on every `Room.currentClaimState` change triggered by S3 hold operations.

**Room** — `currentClaimState` updated from `SPECULATIVELY_HELD` or `FREE` to `COMMITTED_HELD` on hold placement.

**GuestProfile** — read for client tier (advance payment threshold lookup, credit extension eligibility). Primary contact details confirmed at S3.

---

## Section 3 — State Machine at S3

### 3.1 Entry Status Transitions at S3

**Model:** `Entry` | **State fields:** `Entry.status: EntryStatus`, `Entry.currentStage: Stage`

The entry is in `(ACTIVE, S3)` during normal S3 operations. The following transitions are valid:

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| (ACTIVE, S3) | (ACTIVE, S4) | All S3 exit conditions satisfied | Custodian or FOM (high-value) | Forward progression to confirmation |
| (ACTIVE, S3) | (ACTIVE, S2) | Payment renegotiation requiring rate change | FOM | S3→S2 back-flow; new segment created |
| (ACTIVE, S3) | (ACTIVE, S1) | Fundamental reconfiguration of room/space | FOM | S3→S1 back-flow; new segment created |
| (ACTIVE, S3) | (PARKED, S3) | Park operation | Custodian | Entry parked; dwell mode changes to PARKED |
| (PARKED, S3) | (ACTIVE, S3) | Unpark operation | Custodian | Entry resumed; dwell mode returns to ACTIVE |
| (ACTIVE, S3) | (CANCELLED) | Cancellation event | Custodian or FOM | Terminal state; financial residue governed |

**Forbidden transitions from S3:** Direct progression to S5 or later (must pass through S4). Direct progression to any terminal state other than CANCELLED (CLOSED and EXPIRED are not valid terminal transitions from S3).

### 3.2 CommittedHold State Machine

**Model:** `CommittedHold` | **State field:** `CommittedHold.state: HoldState`

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | PLACED | `HoldService.placeCommittedHold()` at S3 | Custodian or FOM | Inventory claim state → COMMITTED_HELD; `RoomClaimStateEvent` written; `COMMITTED_HOLD_EXPIRY` timer registered |
| PLACED | CONFIRMED | `HoldService.confirmCommittedHold()` at S4 | System (on S4 confirmation) | Claim state → CONFIRMED; `COMMITTED_HOLD_EXPIRY` timer cancelled |
| PLACED | RELEASED | `CommittedHoldExpiryWorker` (W3) fires | System | Timer expiry; inventory → FREE; FOM escalated; `RoomClaimStateEvent` written |
| PLACED | RELEASED | `CancellationService.cancel()` | FOM | Governed release; inventory → FREE; `RoomClaimStateEvent` written |
| PLACED | RELEASED | `HoldService.releaseOnReEntry()` on S3→S1 | FOM | Re-entry release; inventory → FREE; `releaseReason: REENTRY_S3_TO_S1`; `HOLD.RELEASED_ON_REENTRY` TraceEvent |

**S3→S2 back-flow:** Hold is **retained** in `PLACED` state. Expiry timer continues running. The hold is not released, not suspended, and not modified. Its `expiresAt` serves as the natural renegotiation deadline.

**S3→S1 back-flow:** Hold is **released** in the same transaction as the segment seal. Inventory returns to `FREE`. `HoldService.releaseOnReEntry()` is the method. This is a distinct release path from standard expiry — different TraceEvent type, different release reason.

### 3.3 Folio State Machine at S3

**Model:** `Folio` | **State field:** `Folio.state: FolioState`

The folio is `PROVISIONAL` throughout S3. The following operations are permitted on a provisional folio:

- Proforma invoice creation and dispatch
- Payment record creation (advance payments only)
- Billing model fixation (initial commitment)
- BillingModelTransitionRecord creation

The following operations are forbidden on a provisional folio:

- Room charges, F&B charges, service charges (live folio only — S6+)
- Folio conversion to `LIVE` (S6 only)
- Settlement (S8 only)

**On re-entry:** The provisional folio persists through all segments. `FolioService.getOrCreate()` returns the existing folio. `FOLIO.REENTRY_CONTINUATION` TraceEvent is emitted.

**On re-entry from S6 or later (S7→S3):** The folio is `LIVE`, not `PROVISIONAL` — it was converted at S6. S3 operates on the LIVE folio as an adjustment layer. The provisional folio restrictions (no room charges, no settlement) do not apply because those are S3 stage constraints, not folio state constraints — S3 does not post room charges regardless of folio state. `FolioService.getOrCreate()` is not called on this path — the existing LIVE folio is accessed directly by entryId.

### 3.4 Inventory Claim State Machine at S3

**Model:** `Room` | **State field:** `Room.currentClaimState: InventoryClaimState`

| From | To | Trigger | Notes |
|---|---|---|---|
| FREE | COMMITTED_HELD | `HoldService.placeCommittedHold()` | Direct committed hold from available inventory |
| SPECULATIVELY_HELD | COMMITTED_HELD | `HoldService.placeCommittedHold()` (upgrade) | Speculative hold from S2 upgrades to committed; `SpeculativeHold.state → UPGRADED` |
| COMMITTED_HELD | FREE | `CommittedHoldExpiryWorker` (W3) | Timer expiry governed release |
| COMMITTED_HELD | FREE | `HoldService.releaseOnReEntry()` | S3→S1 back-flow release |
| COMMITTED_HELD | FREE | `CancellationService.cancel()` | Cancellation release |

Every claim state change produces an immutable `RoomClaimStateEvent` record.

### 3.5 Invoice State Machine at S3

**Model:** `Invoice` | **State field:** `Invoice.state: InvoiceState`

| From | To | Trigger | Notes |
|---|---|---|---|
| — | CREATED | `FolioService.issueInvoice()` | PI generated from provisional folio |
| CREATED | DISPATCHED | PI sent to guest/agent | `dispatchedAt` populated; `ACKNOWLEDGEMENT_WINDOW` and `ADVANCE_PAYMENT_FOLLOW_UP` timers registered |
| CREATED/DISPATCHED | SUPERSEDED | New PI version created | Earlier version superseded by new version |
| CREATED/DISPATCHED | SUPERSEDED | `FolioService.supersedePendingInvoices()` | S3→S1 back-flow — all pending PIs superseded |

**S3→S2 back-flow:** PIs are **not superseded**. Dates and room type are unchanged — PIs remain broadly representative.

**S3→S1 back-flow:** PIs are **superseded**. `FolioService.supersedePendingInvoices()` transitions all `CREATED` and `DISPATCHED` invoices to `SUPERSEDED`. `INVOICE.SUPERSEDED` TraceEvent per invoice. W22 and W34 timers cancelled per invoice.

---

## Section 4 — Policies Enforced at S3

The following policies are active at S3 per the Stage-to-Policy matrix. Each policy is listed with its enforcement point in the S3 service layer.

---

**Policy 8 — Committed Hold Expiry Policy**

- **Active at S3:** Committed hold in place
- **Enforcement point:** `CommittedHoldExpiryWorker` (W3, timer-fired) — calls `HoldService.expireCommittedHold()`
- **Decision:** If the committed hold expires before S4 confirmation, `HoldState → RELEASED`; inventory returns to `FREE`; operator notified with explicit message; FOM escalated immediately.
- **Configurable:** Committed hold duration via `expiry.s3.committedHoldTtlSeconds`

---

**Policy 26 — Committed Hold Placement Policy**

- **Active at S3:** Committed hold placement on selected inventory
- **Enforcement point:** `HoldService.placeCommittedHold()` — inventory availability verified, authority checked, claim state transition executed
- **Decision:** APPROVED (inventory available for date range; actor has authority; claim state transition valid) | DENIED (inventory not available; claim state conflict) | ESCALATE(FOM) (volume or commercial significance threshold exceeded)
- **Hardcoded:** Every committed hold produces a `RoomClaimStateEvent`. Silent inventory claims — where a hold is placed without a permanent audit record — are forbidden.
- **Configurable:** None at the placement decision level — placement authority is per actor level.

---

**Policy 27 — Advance Payment Collection Policy**

- **Active at S3:** Advance payment collected as hold condition
- **Enforcement point:** `FolioService.recordPayment()` at `POST /folios/:id/payments` — policy evaluated before `PaymentRecord` is written; advance payment must meet minimum threshold
- **Decision:** APPROVED (payment meets minimum) | DENIED (below minimum — credit extension path required) | ESCALATE(FOM) for waiver
- **Hardcoded:** Advance payment at S3 implies the no-show doctrine applies
- **Configurable:** Advance payment minimum percentage via `advancePayment.thresholds`

---

**Policy 30 — Billing Model Initial Fix Policy**

- **Active at S3:** Billing model selected and fixed at hold placement
- **Enforcement point:** `FolioService.fixBillingModel()` at S3 — billing model validated and fixed before folio record is updated
- **Decision:** APPROVED (billing model available for this entry) | DENIED (not available) | ESCALATE(FOM)
- **Hardcoded:** Billing model fixed at S3 as initial commitment. Change after S3 requires a re-entry (new segment).
- **Configurable:** Billing model availability per use type via `billingModel.availablePerSource`

---

**Policy 34 — Cancellation Terms Disclosure Policy**

- **Active at S3:** Cancellation terms disclosed before committed hold
- **Enforcement point:** `CancellationService.recordDisclosure()` — disclosure event required as pre-condition for `HoldService.placeCommittedHold()`
- **Decision:** Enforcement rule — cancellation terms including no-show treatment must be disclosed before committed hold is placed
- **Hardcoded:** No-show doctrine included in disclosed terms. Committed hold without prior disclosure is an architectural violation.
- **Configurable:** Cancellation penalty tier structure via `cancellation.policyTiers`

---

**Policy 38 — FOC Validation Policy**

- **Active at S3:** Committed hold includes FOC rooms (GROUP/CONFERENCE entries)
- **Enforcement point:** `HoldService.placeCommittedHold()` — calls `FOCValidationEngine.validate()` before FOC rooms are included in the hold
- **Decision:** APPROVED (all three checks pass: MSR met, seasonality allows, entitlement confirmed) | DENIED (any check fails — hold creation blocked)
- **Hardcoded:** All three checks mandatory. GM approval required after validation passes.
- **Configurable:** FOC entitlement formula and seasonality restrictions via `foc.configuration`

---

**Policy 42 — Credit Ceiling Mandatory Set Policy**

- **Active at S3:** Committed hold placement when advance payment is not collected
- **Enforcement point:** `PaymentService.recordCreditExtensionApproval()` — ceilingAmount mandatory enforced before any write; also enforced at `HoldService.placeCommittedHold()` — credit ceiling record required as pre-condition when advance payment is not satisfied
- **Decision:** APPROVED (FOM approves ceiling; `CreditExtensionCeilingRecord` created) | DENIED (no ceiling — hold cannot proceed)
- **Hardcoded:** Credit extension without ceiling is structurally forbidden.
- **Configurable:** Credit ceiling threshold bands per client tier via `creditCeiling.clientTier.thresholds`

---

**Policy 52 — Communication Acknowledgement Tracking Policy**

- **Active at S3:** PI sent
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on PI dispatch; `TimerEngine.register()` called for `ACKNOWLEDGEMENT_WINDOW`; `AcknowledgementWindowWorker` (W22) transitions to `TIMED_OUT` on window expiry
- **Decision:** Enforcement rule — every PI dispatch opens a tracked acknowledgement loop
- **Hardcoded:** Every governed communication has a tracked acknowledgement state (`PENDING`, `RECEIVED`, `TIMED_OUT`).
- **Configurable:** Acknowledgement window per type via `acknowledgement.windowPerType`

---

**Policy 69 — Session Management and PIN Authentication Policy**

- **Active at S3:** PIN authentication on every staff action
- **Enforcement point:** Middleware layer — session validation before any S3 operation
- **Hardcoded:** No credential sharing. Individual attribution on every action.

---

**Policy 71 — Processing Lock TTL Policy**

- **Active at S3:** Processing lock on inventory selection
- **Enforcement point:** `ProcessingLockService` — TTL enforced via `ProcessingLockExpiryWorker`
- **Hardcoded:** Lock expires unconditionally at TTL. No heartbeat or renewal.

---

## Section 5 — Engines Invoked at S3

### 5.1 FOCValidationEngine

**Invocation point:** `HoldService.placeCommittedHold()` — GROUP and CONFERENCE entries with FOC rooms only.

**Purpose:** Validates FOC room allocation against three mandatory checks: MSR check (FOC room rate above applicable MSR), seasonality check (FOC permitted in current season), entitlement check (group size supports FOC allocation per entitlement formula).

**Input:** `FocValidationInput` — entryId, roomTypeId, date range, applicable rack rate, applicable MSR, group size, existing FOC allocations, entitlement formula (from `foc.configuration`), season restrictions.

**Output:** `FocValidationResult` — `isValid: boolean` (true only if all three checks pass), per-check pass/fail, `requiresGmApproval: true` (always), failure reasons, entitlement remaining.

**S3 behaviour:** If `isValid: false`, committed hold creation is blocked — the FOC room cannot be included. If `isValid: true`, GM approval is required before the hold is written. The engine does not record GM approval — the calling service does.

### 5.2 ReEntryConsequenceEngine

**Invocation point:** `EntryService.createSegment()` — called on every re-entry that creates a new segment.

**Purpose:** Computes the consequence payload for the re-entry event. The calling service executes each consequence action within the same transaction as the segment seal.

**S3→S2 consequence payload:**
- **Timer consequences:** Cancel `COMMITTED_HOLD_EXPIRY` timer — not applicable; the hold is retained with its timer still running.
- **Hold consequences:** `HOLD_RETAINED` — committed hold remains in `PLACED` state on the sealed segment. Expiry timer continues.
- **Folio consequences:** `FOLIO_CONTINUES` — Entry-level provisional folio persists. No state change to invoices. Prior payment records visible.
- **Inventory consequences:** No inventory change — `COMMITTED_HELD` state persists.

**S3→S1 consequence payload:**
- **Timer consequences:** Cancel `COMMITTED_HOLD_EXPIRY`, `ACKNOWLEDGEMENT_WINDOW` (W22) per invoice, `ADVANCE_PAYMENT_FOLLOW_UP` (W34) per invoice, `PAYMENT_MILESTONE` (if configured).
- **Hold consequences:** `HOLD_RELEASED` — committed hold released to `FREE` via `HoldService.releaseOnReEntry()`. `HOLD.RELEASED_ON_REENTRY` TraceEvent with `releaseReason: REENTRY_S3_TO_S1`.
- **Folio consequences:** `FOLIO_CONTINUES` — Entry-level provisional folio persists. `INVOICES_SUPERSEDED` — all `CREATED` and `DISPATCHED` invoices transition to `SUPERSEDED` via `FolioService.supersedePendingInvoices()`. `INVOICE.SUPERSEDED` TraceEvent per invoice. Guest notified.
- **Inventory consequences:** `COMMITTED_HELD → FREE` — room returns to available inventory.

**Critical distinction:** S3→S2 and S3→S1 produce fundamentally different consequences. A developer must not conflate these paths.

### 5.3 TimerEngine

**Invocation points at S3:**

| Timer Type | Registration Point | Fires At | Dispatches To |
|---|---|---|---|
| `STAGE_DWELL_MONITOR` | Entry enters S3 | Mode-dependent threshold | `StageDwellWorker` (W1) |
| `COMMITTED_HOLD_EXPIRY` | `HoldService.placeCommittedHold()` | `placedAt + ttlSeconds` | `CommittedHoldExpiryWorker` (W3) |
| `ACKNOWLEDGEMENT_WINDOW` | `CommunicationService.send()` on PI dispatch | Configured window per type | `AcknowledgementWindowWorker` (W22) |
| `ADVANCE_PAYMENT_FOLLOW_UP` | `FolioService.issueInvoice()` on PI dispatch | `dispatchedAt + advancePayment.followUpWindowSeconds` | `AdvancePaymentFollowUpWorker` (W34) |
| `PAYMENT_MILESTONE` | Milestone configured (CORPORATE/CONFERENCE) | Milestone due date | `PaymentMilestoneWorker` |

**Timer cancellation obligations at S3:**

| Cancellation Trigger | Timer(s) Cancelled | Service that Cancels |
|---|---|---|
| Speculative hold upgrade to committed | `SPECULATIVE_HOLD_EXPIRY` | `HoldService.placeCommittedHold()` (upgrade path only) |
| Payment threshold met | `ADVANCE_PAYMENT_FOLLOW_UP` (W34) | `FolioService.recordPayment()` |
| Credit extension approved | `ADVANCE_PAYMENT_FOLLOW_UP` (W34) | `PaymentService.recordCreditExtensionApproval()` |
| Entry cancellation | `ADVANCE_PAYMENT_FOLLOW_UP` (W34) | `CancellationService.cancel()` |
| Entry progression to S5 | `ADVANCE_PAYMENT_FOLLOW_UP` (W34) | `EntryService.progressStage()` |
| S3→S1 back-flow | `COMMITTED_HOLD_EXPIRY`, `ACKNOWLEDGEMENT_WINDOW` per invoice, `ADVANCE_PAYMENT_FOLLOW_UP` per invoice, `PAYMENT_MILESTONE` (if configured) | `EntryService.createSegment()` consequence execution |
| S4 confirmation | `COMMITTED_HOLD_EXPIRY` | `HoldService.confirmCommittedHold()` |

---

## Section 6 — Services Active at S3

### 6.1 EntryService

**S3 responsibilities:** Manages stage progression; creates segments on re-entry; invokes `ReEntryConsequenceEngine.compute()` on segment creation.

**Method: `EntryService.createSegment(entryId, reEntryReason, actorId)`**

Called when a governed S3→S2 or S3→S1 re-entry transition creates a new segment.

- Models read: `Entry` (current state), prior `Segment`
- Models written: `Segment` (new record), prior `Segment` (sealedAt and sealedBy populated), `TraceEvent` (SEGMENT.CREATED)
- Consequence routing: calls `ReEntryConsequenceEngine.compute()` with transition type; executes each consequence in the same transaction
- Atomicity: segment creation, prior segment seal, and all consequence execution are in the same transaction

**W34 timer cancellation on S4→S5 progression:** When `EntryService.progressStage()` is called with `targetStage = S5`, cancel the `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer in the same transaction as the stage transition write.

### 6.2 HoldService

**S3 responsibilities:** Places committed holds; releases holds on re-entry; manages hold expiry.

**Method: `HoldService.placeCommittedHold()`**

- Pre-conditions verified before hold creation:
  1. `CancellationDisclosureRecord` exists for this entry and segment (Policy 34)
  2. Advance payment condition satisfied (`PaymentService.evaluateAdvancePaymentCondition()`) OR `CreditExtensionCeilingRecord` exists (Policy 42)
  3. For GROUP use type: `FOCValidationEngine.validate()` returns `isValid: true` with GM approval recorded (Policy 38)
- Models written: `CommittedHold` (PLACED), `RoomClaimStateEvent`, `TraceEvent`
- Timer registration: `COMMITTED_HOLD_EXPIRY` timer registered via `TimerEngine.register()` with `firesAt = now + ttlSeconds`
- If upgrading from S2 speculative hold: `SpeculativeHold.state → UPGRADED`; `upgradedToId` populated; `SPECULATIVE_HOLD_EXPIRY` timer cancelled

**Method: `HoldService.releaseOnReEntry(holdId, actorId, reEntryType)`**

Called exclusively on S3→S1 transition. Must execute in the same transaction as prior segment seal and `FolioService.supersedePendingInvoices()`.

- Input: holdId, actorId, reEntryType (must be `S3_TO_S1` — rejects any other value)
- Models written: `CommittedHold` (state → RELEASED; releasedAt, releasedBy populated); `RoomClaimStateEvent` (COMMITTED_HELD → FREE); `TraceEvent` (HOLD.RELEASED_ON_REENTRY with `releaseReason: REENTRY_S3_TO_S1`)
- Forbidden: calling this on S3→S2 transitions — hold is retained on S3→S2

### 6.3 FolioService

**S3 responsibilities:** Creates or retrieves provisional folio; records payments; issues proforma invoices; fixes billing model; supersedes PIs on S3→S1.

**Method: `FolioService.getOrCreate(entryId, segmentId, actorId)`**

- If provisional folio exists: emits `FOLIO.REENTRY_CONTINUATION` TraceEvent; returns existing folio
- If not found: creates new `Folio` (PROVISIONAL, billingModel null until fixBillingModel() is called); emits `FOLIO.CREATED` TraceEvent; returns new folio
- Forbidden: creating a duplicate provisional folio for the same entryId
- **Post-S6 re-entry (S7→S3):** `getOrCreate()` is not called on this path. The existing LIVE folio is accessed directly by entryId. S3 operations (recordPayment, fixBillingModel, issueInvoice) operate on the LIVE folio as an adjustment layer. **Part 6 REV3 gap noted:** `getOrCreate()` state filter checks PROVISIONAL only — does not handle the LIVE folio case. Logged for corrections register.

**Method: `FolioService.recordPayment()`**

- Creates `PaymentRecord` on the provisional folio
- Policy 27 evaluated before `PaymentRecord` is written
- After writing: evaluates total received against `advancePayment.thresholds`. If threshold met or exceeded, cancels `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer in the same transaction

**Method: `FolioService.fixBillingModel()`**

- Validates billing model availability per `billingModel.availablePerSource` for this entry's use type and source channel (Policy 30)
- Updates `Folio.billingModel`
- Creates `BillingModelTransitionRecord` (fromModel: null on initial fixation; fromModel populated on re-entry)

**Method: `FolioService.issueInvoice()`**

- Creates `Invoice` (PROFORMA type) on the provisional folio
- On dispatch: registers `ACKNOWLEDGEMENT_WINDOW` timer and `ADVANCE_PAYMENT_FOLLOW_UP` timer independently; both in the same transaction as the dispatch event

**Method: `FolioService.supersedePendingInvoices(entryId, segmentId, actorId)`**

Called exclusively on S3→S1 transition. Same transaction as segment seal and `HoldService.releaseOnReEntry()`.

- Transitions all `CREATED` and `DISPATCHED` invoices on the Entry-level folio to `SUPERSEDED`
- Emits `INVOICE.SUPERSEDED` TraceEvent per invoice
- Creates `CommunicationRecord` noting PI supersession for guest notification
- Cancels `ACKNOWLEDGEMENT_WINDOW` (W22) and `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timers per superseded invoice
- Forbidden: calling on S3→S2 transitions

### 6.4 PaymentService

**S3 responsibilities:** Evaluates advance payment condition; records credit extension approval with mandatory ceiling.

**Method: `PaymentService.evaluateAdvancePaymentCondition(entryId, folioId)`**

- Reads all `PaymentRecord` records on the folio with `paymentDirection = 'IN'`; sums total received
- Reads applicable threshold from `advancePayment.thresholds` keyed by source channel and client tier
- Returns `{ satisfied, totalReceived, requiredAmount, shortfall }`
- Called by `HoldService.placeCommittedHold()` before hold creation

**Method: `PaymentService.recordCreditExtensionApproval(entryId, folioId, ceilingAmount, approvedBy, reason)`**

- Enforces Policy 42: if `ceilingAmount` is null or zero, throws `PolicyGateBlockedError`
- Validates `approvedBy` carries at least `ActorLevel.FOM` authority
- Creates `CreditExtensionCeilingRecord`
- Cancels `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer in the same transaction — credit extension satisfies the advance payment condition
- Writes `TraceEvent`

**Method: `PaymentService.getPaymentStatus(entryId, folioId)`**

- Returns `{ totalReceived, requiredAmount, shortfall, satisfied, creditExtensionActive, ceilingAmount }`
- Used by stage progression guard and API response

### 6.5 CancellationService

**S3 responsibilities:** Records cancellation terms disclosure; processes entry cancellation.

**Method: `CancellationService.recordDisclosure(entryId, segmentId, folioId, policyId, actorId)`**

- Reads applicable cancellation policy from `CancellationPolicyRegistry` keyed by `policyId`
- Populates `disclosedTerms` as structured snapshot of cancellation tiers at time of disclosure
- Populates `noShowTreatmentStatement` — mandatory; disclosure without no-show treatment throws `PolicyGateBlockedError` with `blockingCondition: 'MISSING_NO_SHOW_TREATMENT'`
- Creates `CancellationDisclosureRecord`; writes `TraceEvent`
- Forbidden: creating this record with null or empty `noShowTreatmentStatement`; creating after committed hold is already placed for this segment

**Method: `CancellationService.cancel(entryId, reason, actorId)`**

- At S3: `ActorLevel.FRONT_DESK` or `ActorLevel.FOM` authority required
- Calculates cancellation penalty per applicable tier
- Releases inventory (claim state → FREE)
- Cancels `ADVANCE_PAYMENT_FOLLOW_UP` (W34) timer in the same transaction
- Transitions entry to `CANCELLED` terminal state

---

## Section 7 — Workers Active at S3

### 7.1 Worker 1 — StageDwellMonitor

**Governed stage(s):** S1–S9 (S3 phase)

**pg-boss job type:** `STAGE_DWELL_MONITOR`

**Trigger:** Registered when entry enters S3. Warning and critical thresholds are mode-dependent (ACTIVE, IDLE, PARKED).

**S3 behaviour:** Monitors dwell time at S3. Warning fires first, then critical, then FOM escalation. Sequence is invariant. Mode transitions tracked on `StageDwellRecord`.

**Models written:** `StageDwellRecord` (warningFiredAt, criticalFiredAt, escalatedAt, mode); `TraceEvent`

**Idempotency:** Keyed on `(entryId, stage, event_phase)`. If timestamp already set for this phase, skip.

### 7.2 Worker 3 — CommittedHoldExpiryWorker

**Governed stage(s):** S3–S4

**pg-boss job type:** `COMMITTED_HOLD_EXPIRY`

**Trigger:** Registered at committed hold placement. Fires when TTL expires without S4 confirmation.

**S3 behaviour:** Transitions `CommittedHold.state` to `RELEASED`. Inventory transitions from `COMMITTED_HELD` to `FREE`. FOM escalated immediately. Staff alerted with explicit message identifying the expired hold.

**Models read:** `CommittedHold` (state, expiresAt, entryId, roomId), `Room` (currentClaimState)

**Models written:** `CommittedHold` (state → RELEASED; releasedAt, releasedBy = SYSTEM; releaseReason = 'EXPIRY'); `Room` (currentClaimState → FREE); `RoomClaimStateEvent`; `TraceEvent` (COMMITTED_HOLD.EXPIRY_TRIGGERED)

**Idempotency:** Reads `CommittedHold.state`. If already `RELEASED` or `CONFIRMED`, skip.

**Atomicity:** Hold state update and `RoomClaimStateEvent` creation must be in a single transaction.

### 7.3 Worker 22 — AcknowledgementWindowWorker

**Governed stage(s):** S2–S9 (S3 phase: PI acknowledgement)

**pg-boss job type:** `ACKNOWLEDGEMENT_WINDOW`

**Trigger:** Registered by `CommunicationService.send()` when a PI is dispatched. Fires when the acknowledgement window expires without `AcknowledgementStatus.RECEIVED` on the `CommunicationRecord`.

**S3 behaviour:** Transitions `CommunicationRecord.acknowledgementStatus` to `TIMED_OUT`. Non-acknowledgement becomes a visible flag on the entry. Escalates to FOM if window is significantly exceeded.

**Models read:** `CommunicationRecord` (acknowledgementStatus, stageContext, entryId)

**Models written:** `CommunicationRecord` (acknowledgementStatus → TIMED_OUT); `TraceEvent` (ACKNOWLEDGEMENT.WINDOW_EXPIRED, ACKNOWLEDGEMENT.FOM_ESCALATED)

**Idempotency:** Reads `acknowledgementStatus`. If already `RECEIVED` or `TIMED_OUT`, skip.

**Cancellation on S3→S1:** W22 timers for superseded invoices are cancelled by `FolioService.supersedePendingInvoices()` in the same transaction as the segment seal.

### 7.4 Worker 34 — AdvancePaymentFollowUpWorker

**Governed stage(s):** S3–S5

**pg-boss job type:** `ADVANCE_PAYMENT_FOLLOW_UP`

**Trigger:** Registered by `FolioService.issueInvoice()` when a proforma invoice is dispatched and the advance payment condition is not yet fully satisfied. Timer fires at `dispatchedAt + advancePayment.followUpWindowSeconds`. A second timer fires at `dispatchedAt + advancePayment.escalationWindowSeconds` for Tier 2 FOM escalation. Both registrations occur in the same transaction as the PI dispatch. Independent of W22 — a guest acknowledging the PI does not cancel the payment follow-up.

**S3 behaviour — two-tier alert model:**

- **Tier 1 (warning):** Ambient staff notice on the custodian dashboard — "Advance payment not received for Entry [ref]. Follow up required."
- **Tier 2 (escalation):** If the escalation window passes without payment recorded or credit extension approved, the item escalates to FOM as an active interruption.

**Condition check (evaluated at each fire):** Reads all `PaymentRecord` entries with `paymentDirection = 'IN'` on the Entry-level folio directly. Sums total received. Compares against `advancePayment.thresholds` for the entry's source channel and client tier. If total meets or exceeds threshold, or if `CreditExtensionCeilingRecord` exists, or if `Entry.currentStage` is S5 or later, or if `Entry.status` is `CANCELLED` or `EXPIRED` — worker skips and emits `ADVANCE_PAYMENT.FOLLOW_UP_SKIPPED_CONDITION_MET` TraceEvent.

**Models read:** `Folio`, `PaymentRecord` (sum of IN records on folio), `CreditExtensionCeilingRecord` (existence check), `Invoice`, `Entry` (currentStage, status, useType), `ConfigurationEntry` (thresholds and window configs)

**Models written:** `TraceEvent` only — `ADVANCE_PAYMENT.FOLLOW_UP_SENT` (Tier 1) | `ADVANCE_PAYMENT.ESCALATED_TO_FOM` (Tier 2) | `ADVANCE_PAYMENT.FOLLOW_UP_SKIPPED_CONDITION_MET` (skip)

**Idempotency:** Keyed on `(entryId, invoiceId, alert_tier)`. If matching `TraceEvent` already exists, skip.

**Hardcoded:** Worker alerts only — does not collect payment, does not modify any financial record, does not extend or revoke credit.

**Four cancellation triggers:**

| Trigger | Service | Reason |
|---|---|---|
| Payment threshold met | `FolioService.recordPayment()` | Advance payment condition met |
| Credit extension approved | `PaymentService.recordCreditExtensionApproval()` | Payment condition governed by approved credit |
| Entry cancellation | `CancellationService.cancel()` | Entry terminal — follow-up moot |
| Entry progression to S5 | `EntryService.progressStage()` | Reconciliation transfers to S5 |

If a second `ADVANCE_PAYMENT_FOLLOW_UP` timer was registered for Tier 2 escalation, both timers must be cancelled in the same operation.

---

## Section 8 — API Routes at S3

### 8.1 CommittedHold Routes

**Place Committed Hold**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/holds/committed` |
| Auth | `L1+` |
| Request DTO | `PlaceCommittedHoldRequestDTO` |
| Response DTO | `CommittedHoldResponseDTO` |
| Service method | `HoldService.placeCommittedHold()` |
| Policies | Policy 26, Policy 27, Policy 30, Policy 34, Policy 38 (GROUP), Policy 42 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (advance payment not satisfied; FOC validation failed; no cancellation disclosure; no credit ceiling), `MissingConfigurationError`, `StageGateBlockedError` |

### 8.2 Folio Routes

**Get Folio**

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id` |
| Auth | `L1+` |
| Service method | `FolioService.getFolio()` |

**Record Advance Payment**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/payments` |
| Auth | `L1+` |
| Request DTO | `RecordPaymentRequestDTO` |
| Response DTO | `PaymentRecordResponseDTO` |
| Service method | `FolioService.recordPayment()` |
| Policies | Policy 27 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `StateTransitionError` |

**Issue Proforma Invoice**

| Field | Value |
|---|---|
| Method + Path | `POST /folios/:id/invoices` |
| Auth | `L1+` |
| Request DTO | `IssueInvoiceRequestDTO` |
| Response DTO | `InvoiceResponseDTO` |
| Service method | `FolioService.issueInvoice()` |
| Policies | Policy 52 |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` |

**List Invoices for Folio**

| Field | Value |
|---|---|
| Method + Path | `GET /folios/:id/invoices` |
| Auth | `L1+` |
| Service method | `FolioService.listInvoices()` |

### 8.3 Payment Service Routes

**Get Payment Status**

| Field | Value |
|---|---|
| Method + Path | `GET /entries/:id/payment-status` |
| Auth | `L1+` |
| Service method | `PaymentService.getPaymentStatus()` |

**Record Credit Extension Approval**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/credit-extension` |
| Auth | `L2+` (FOM minimum) |
| Request DTO | `RecordCreditExtensionRequestDTO` — must include `ceilingAmount` (mandatory) |
| Response DTO | `CreditExtensionCeilingResponseDTO` |
| Service method | `PaymentService.recordCreditExtensionApproval()` |
| Policies | Policy 42 |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyGateBlockedError` (missing ceiling amount) |

### 8.4 CancellationDisclosure Route

**Record Cancellation Disclosure**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/disclosures/cancellation` |
| Auth | `L1+` |
| Request DTO | `RecordCancellationDisclosureRequestDTO` — must include `noShowTreatmentStatement` (mandatory) |
| Response DTO | `CancellationDisclosureResponseDTO` |
| Service method | `CancellationService.recordDisclosure()` |
| Policies | Policy 34 |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyGateBlockedError` (missing no-show treatment statement) |

### 8.5 Stage Progression Routes

**Forward Progression S3→S4**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` with `targetStage = S4` |
| Auth | `L1+` (Custodian; FOM for high-value) |
| Service method | `EntryService.progressStage()` |
| Guards | All §1.5 exit conditions evaluated in sequence |
| Error responses | `StageGateBlockedError` (identifying specific unsatisfied condition), `ValidationError`, `AuthorizationError` |

**Initiate S3→S2 Back-Flow**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` with `targetStage = S2` |
| Auth | `L2+` (FOM minimum) |
| Service method | `EntryService.progressStage()` → `EntryService.createSegment()` |
| Consequence | New segment created; `ReEntryConsequenceEngine` computes S3→S2 payload; hold retained; folio continues |

**Initiate S3→S1 Back-Flow**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` with `targetStage = S1` |
| Auth | `L2+` (FOM minimum) |
| Service method | `EntryService.progressStage()` → `EntryService.createSegment()` |
| Consequence | New segment created; `ReEntryConsequenceEngine` computes S3→S1 payload; hold released; PIs superseded; folio continues |

### 8.6 Cancellation Route

**Cancel Entry**

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/cancel` |
| Auth | `L1+` (Custodian at S3) |
| Service method | `CancellationService.cancel()` |
| Policies | Policy 35 |

---

## Section 9 — Configuration Keys at S3

All S3 configuration keys use dotted notation. These keys must be present in `ConfigurationEntry` before S3 is live. Missing keys produce `MissingConfigurationError` at the relevant enforcement point.

### Blocking for S3_READINESS

| configKey | Type | Description |
|---|---|---|
| `advancePayment.thresholds` | Json | Required advance payment per source channel and client tier |
| `expiry.s3.committedHoldTtlSeconds` | Integer | Committed hold timer duration in seconds |
| `billingModel.availablePerSource` | Json | Valid billing models per source channel and use type |
| `cancellation.policyTiers` | Json | Cancellation penalty tiers by stage, timing, source, tier |
| `foc.configuration` | Json | FOC entitlement formula and seasonality restrictions |
| `proformaInvoice.templates` | Json | PI template configuration per billing model |
| `creditCeiling.clientTier.thresholds` | Json | Credit extension ceiling thresholds per client tier — all tiers must be present |
| `paymentMilestone.scheduleTemplates` | Json | Milestone schedule templates for CORPORATE/CONFERENCE — blocking for those use types |
| `advancePayment.followUpWindowSeconds` | Integer | Seconds after PI dispatch before Tier 1 W34 alert fires |
| `advancePayment.escalationWindowSeconds` | Integer | Seconds after PI dispatch before Tier 2 FOM escalation — must exceed `followUpWindowSeconds` |
| `acknowledgement.windowPerType` | Json | Acknowledgement window in seconds per communication type — PI type entry required for W22 timer registration at PI dispatch |

### Non-Blocking (referenced at S3 but not S3_READINESS gated)

| configKey | Type | Description |
|---|---|---|
| `paymentMilestone.warningOffsetDays` | Integer | Days before each milestone deadline that reminder fires |
| `creditCeiling.proximityThresholds` | Json | Threshold percentages (75, 90, 100) for S5–S8 monitoring — set at S3 but consumed later |
| `stageDwell.thresholds` | Json | All stages × all dwell modes × warning/critical/escalation thresholds |

---

## Section 10 — Acceptance Criteria

Minimum 40 testable pass/fail assertions covering all S3 operational requirements.

---

### 10.1 Schema

**AC-S3-001:** `CommittedHold` model exists with all fields from §2.3. `state` field uses `HoldState` enum. **PASS** = model present with correct fields. **FAIL** = model absent or fields missing.

**AC-S3-002:** `Folio` model includes `billingModel String?` field. Non-null from S3 fixation onward. **PASS** = field present, nullable. **FAIL** = field absent.

**AC-S3-003:** `BillingModelTransitionRecord` model exists with `fromModel String?` (null on initial fixation), `toModel String`, `segmentId`, `folioId`. Immutable from creation. **PASS** = model present with correct fields. **FAIL** = model absent.

**AC-S3-004:** `CancellationDisclosureRecord` model exists with `noShowTreatmentStatement String` (mandatory). **PASS** = model present, field non-nullable by enforcement. **FAIL** = model absent or field nullable without enforcement.

**AC-S3-005:** `CreditExtensionCeilingRecord` model exists with `ceilingAmount Decimal` (mandatory). `folioId` is unique. **PASS** = model present, ceiling mandatory. **FAIL** = model absent or ceiling optional.

**AC-S3-006:** `InvoiceState` enum includes `SUPERSEDED` value. **PASS** = value present. **FAIL** = value absent.

**AC-S3-007:** `PaymentRecord.paymentDirection` field exists with values `IN` and `OUT`. **PASS** = field present with both values. **FAIL** = field absent or incomplete.

### 10.2 Policy Enforcement

**AC-S3-008:** Policy 27 is enforced at `FolioService.recordPayment()`. A test that calls `POST /folios/:id/payments` with an amount below the configured threshold returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = payment recorded below threshold.

**AC-S3-009:** Policy 30 is enforced at `FolioService.fixBillingModel()`. A test that attempts to fix a billing model not available for the entry's source channel returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = billing model fixed despite unavailability.

**AC-S3-010:** Policy 34 is enforced at `HoldService.placeCommittedHold()`. A test that calls `POST /entries/:id/holds/committed` without a prior `CancellationDisclosureRecord` for this segment returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = hold placed without disclosure.

**AC-S3-011:** Policy 38 is enforced for GROUP entries at `HoldService.placeCommittedHold()`. A test that includes an FOC room where `FOCValidationEngine.validate()` returns `isValid: false` blocks hold creation. **PASS** = hold blocked. **FAIL** = hold placed with invalid FOC.

**AC-S3-012:** Policy 42 is enforced at `PaymentService.recordCreditExtensionApproval()`. A test that calls the method with `ceilingAmount = null` throws `PolicyGateBlockedError`. **PASS** = error thrown. **FAIL** = record created without ceiling.

**AC-S3-013:** Policy 52 is enforced at PI dispatch. A test that dispatches a PI creates a `CommunicationRecord` with `acknowledgementStatus = PENDING` and registers an `ACKNOWLEDGEMENT_WINDOW` timer. **PASS** = both present. **FAIL** = either missing.

**AC-S3-049:** Policy 26 is enforced at `HoldService.placeCommittedHold()`. A test that attempts to place a committed hold on inventory that is not in `FREE` or `SPECULATIVELY_HELD` state returns `PolicyGateBlockedError`. **PASS** = hold blocked on unavailable inventory. **FAIL** = hold placed on occupied or confirmed inventory.

### 10.3 Engine

**AC-S3-014:** `FOCValidationEngine.validate()` is called at `HoldService.placeCommittedHold()` for GROUP use type entries with FOC rooms. A test with a group below minimum FOC threshold returns `isValid: false`. **PASS** = validation fails. **FAIL** = validation passes.

**AC-S3-015:** `ReEntryConsequenceEngine.compute()` is called by `EntryService.createSegment()`. A test that creates a segment with S3→S2 transition receives `HOLD_RETAINED` in the payload. **PASS** = HOLD_RETAINED present. **FAIL** = hold released.

**AC-S3-016:** `ReEntryConsequenceEngine.compute()` with S3→S1 transition returns `HOLD_RELEASED`, `FOLIO_CONTINUES`, `INVOICES_SUPERSEDED`. **PASS** = all three consequences present. **FAIL** = any missing.

**AC-S3-017:** `TimerEngine.register()` is called at committed hold placement with type `COMMITTED_HOLD_EXPIRY`. **PASS** = timer registered. **FAIL** = no timer.

### 10.4 Worker

**AC-S3-018:** W3 `CommittedHoldExpiryWorker` fires when committed hold TTL expires. `CommittedHold.state → RELEASED`; inventory → FREE; FOM escalated. **PASS** = hold released, FOM alerted. **FAIL** = hold persists or silent expiry.

**AC-S3-019:** W3 idempotency: if `CommittedHold.state` is already `RELEASED` or `CONFIRMED`, worker skips without error. **PASS** = skip event logged. **FAIL** = error or duplicate release.

**AC-S3-020:** W22 `AcknowledgementWindowWorker` fires when PI acknowledgement window expires. `CommunicationRecord.acknowledgementStatus → TIMED_OUT`. **PASS** = status updated. **FAIL** = status unchanged.

**AC-S3-021:** W34 `AdvancePaymentFollowUpWorker` fires at Tier 1 window. Staff notice emitted. **PASS** = `ADVANCE_PAYMENT.FOLLOW_UP_SENT` TraceEvent. **FAIL** = no trace event.

**AC-S3-022:** W34 fires but advance payment condition already satisfied. Worker skips. **PASS** = `ADVANCE_PAYMENT.FOLLOW_UP_SKIPPED_CONDITION_MET` TraceEvent. **FAIL** = alert sent despite condition met.

**AC-S3-023:** W34 Tier 2 fires. FOM escalation emitted. **PASS** = `ADVANCE_PAYMENT.ESCALATED_TO_FOM` TraceEvent. **FAIL** = no escalation.

**AC-S3-024:** W34 timer cancelled when `FolioService.recordPayment()` records a payment that meets the threshold. **PASS** = timer cancelled in same transaction. **FAIL** = timer persists.

**AC-S3-025:** W34 timer cancelled when `PaymentService.recordCreditExtensionApproval()` creates a ceiling record. **PASS** = timer cancelled in same transaction. **FAIL** = timer persists.

**AC-S3-026:** W34 condition check reads `PaymentRecord` entries with `paymentDirection = 'IN'` on the Entry-level folio directly. No `carriedForwardPayment` field. **PASS** = folio-direct read. **FAIL** = any chain-walking or phantom field reference.

**AC-S3-051:** On speculative hold upgrade to committed: `SPECULATIVE_HOLD_EXPIRY` timer is cancelled in the same transaction as the committed hold creation. A test that upgrades a speculative hold inspects the timer state — timer must be cancelled. **PASS** = timer cancelled in same transaction. **FAIL** = timer persists or cancelled in separate transaction.

### 10.5 State Machine

**AC-S3-027:** S3→S4 forward transition requires all exit conditions (§1.5). A test that attempts progression without a committed hold returns `StageGateBlockedError`. **PASS** = blocked. **FAIL** = progressed.

**AC-S3-028:** S3→S4 forward transition requires a `CancellationDisclosureRecord` with `noShowTreatmentStatement`. A test that attempts progression without the disclosure returns `StageGateBlockedError`. **PASS** = blocked. **FAIL** = progressed.

**AC-S3-029:** S3→S2 back-flow creates a new segment. Prior segment is sealed. Hold is retained in PLACED state. **PASS** = new segment, sealed prior, hold PLACED. **FAIL** = any condition violated.

**AC-S3-030:** S3→S1 back-flow creates a new segment. Hold released to FREE. PIs superseded. Folio continues. **PASS** = all four conditions met. **FAIL** = any violated.

**AC-S3-031:** Forbidden transition S3→S5 (direct) is rejected. **PASS** = `StageGateBlockedError`. **FAIL** = transition accepted.

**AC-S3-032:** Inventory claim state transitions from `SPECULATIVELY_HELD` to `COMMITTED_HELD` on hold upgrade from S2. **PASS** = correct transition with `RoomClaimStateEvent`. **FAIL** = incorrect transition.

**AC-S3-050:** On speculative hold upgrade: `SpeculativeHold.state` transitions to `UPGRADED` and `upgradedToId` is populated with the new `CommittedHold.id` in the same transaction as the committed hold creation. **PASS** = state UPGRADED, upgradedToId matches new hold. **FAIL** = state unchanged or upgradedToId null.

### 10.6 Route

**AC-S3-033:** `POST /entries/:id/holds/committed` returns 201 on successful committed hold placement with all pre-conditions satisfied. **PASS** = 201 with `CommittedHoldResponseDTO`. **FAIL** = error.

**AC-S3-034:** `POST /folios/:id/payments` returns 201 on successful payment recording. **PASS** = 201 with `PaymentRecordResponseDTO`. **FAIL** = error.

**AC-S3-035:** `POST /entries/:id/disclosures/cancellation` returns 201 on successful disclosure recording with `noShowTreatmentStatement` provided. **PASS** = 201. **FAIL** = error.

**AC-S3-036:** `POST /entries/:id/disclosures/cancellation` returns 400 when `noShowTreatmentStatement` is null or empty. **PASS** = `PolicyGateBlockedError`. **FAIL** = record created.

### 10.7 Configuration

**AC-S3-037:** S3 operations fail with `MissingConfigurationError` when any S3_READINESS blocking surface is absent. A test that removes `advancePayment.thresholds` from `ConfigurationEntry` and calls `HoldService.placeCommittedHold()` returns `MissingConfigurationError`. **PASS** = error with specific surface name. **FAIL** = operation proceeds.

**AC-S3-038:** `advancePayment.followUpWindowSeconds` is blocking for S3_READINESS. A test that removes this key and dispatches a PI returns `MissingConfigurationError`. **PASS** = error. **FAIL** = PI dispatched without timer.

### 10.8 Forbidden Actions

**AC-S3-039:** Posting a room charge (`FolioLine` with `lineType = 'ROOM_CHARGE'`) to a `PROVISIONAL` folio is rejected. **PASS** = error. **FAIL** = charge posted.

**AC-S3-040:** Creating a `Reservation` record at S3 is rejected — confirmation belongs to S4. **PASS** = error. **FAIL** = reservation created.

**AC-S3-041:** Credit extension approval with `ceilingAmount = 0` is rejected. **PASS** = `PolicyGateBlockedError`. **FAIL** = record created with zero ceiling.

### 10.9 Re-Entry Scenarios

**AC-S3-042:** On S3→S2 re-entry followed by return to S3: `FolioService.getOrCreate()` returns the existing Entry-level folio. A test that executes S1→S2→S3→S2→S3 inspects folio count — must be exactly one. **PASS** = single folio. **FAIL** = multiple folios.

**AC-S3-043:** On S3→S1 re-entry: `HOLD.RELEASED_ON_REENTRY` TraceEvent is emitted with `releaseReason: REENTRY_S3_TO_S1`. **PASS** = TraceEvent present with correct reason. **FAIL** = absent or wrong reason.

**AC-S3-044:** On S3→S1 re-entry: `INVOICE.SUPERSEDED` TraceEvent is emitted per superseded invoice. **PASS** = one TraceEvent per invoice. **FAIL** = missing for any invoice.

**AC-S3-045:** On S3→S1 re-entry: W22 and W34 timers for superseded invoices are cancelled in the same transaction as the segment seal. **PASS** = timers cancelled. **FAIL** = any timer active after seal.

**AC-S3-046:** On S3→S1 re-entry: prior `PaymentRecord` entries from sealed segments are visible on the Entry-level folio and count toward the advance payment threshold at the new S3 passage. A test that records a payment in the first S3 passage, executes S3→S1→S2→S3 re-entry, and evaluates `PaymentService.evaluateAdvancePaymentCondition()` must find the prior payment. **PASS** = prior payment counted. **FAIL** = prior payment absent.

**AC-S3-047:** On S3→S2 re-entry: committed hold remains in `PLACED` state. If hold has not expired, no new hold placement is needed. A test that executes S3→S2→S3 where the hold has not expired verifies `CommittedHold.state = PLACED` on the prior segment. **PASS** = hold PLACED. **FAIL** = hold released.

**AC-S3-048:** `BillingModelTransitionRecord` is created at initial S3 fixation with `fromModel: null`. On re-entry with billing model change, a new record is created with `fromModel` populated from the current `Folio.billingModel`. **PASS** = correct records. **FAIL** = missing or incorrect fromModel.

---

*SIG-S3 v2.0 — DRAFT*
*Derived from DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)*
*Authority: MOM-ARCH-2026-020, SIG-S3-ADDENDUM-001, MASTER-CORRECTION-LOG v1.6*
*Architect: Dhendup Cheten, Fuzzy Automation*
*13 April 2026*
