# LEGPHEL PMS — Stage Implementation Guideline
## S1: Inquiry & Configuration

**Document ID:** SIG-S1
**Version:** 1.2
**Status:** DRAFT
**Derived from:** DEV-SPEC-001 (Parts 2, 3, 4, 5, 6, 8, 9, 12, 13 — REV1/REV2/REV3 where applicable)
**Canon version:** v2.5

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Initial generation. Derived from DEV-SPEC-001 against Canon v2.5. Three findings deliberated and resolved in session: Policy 4 active stage corrected to S1 and S4; `RevalidationDeltaRecord` confirmed as persisted model and added to schema section; `stage_dwell_thresholds` locked as single composite configKey replacing two placeholder keys. Locked by Architect. |
| 1.1 | 13 Apr 2026 | Claude (AI Architectural Partner) | **LOCKED** | Amendment pass following independent review (MOM-ARCH-2026-017). Seven architectural decisions (A-1 through A-7) deliberated and locked by Architect. Six mechanical amendments (B-1 through B-6) applied. Key changes: `AvailabilityService.selectOption()` and `PATCH /availability/configurations/:id/select` added (A-1); `parkedIndividually` field added to Entry model and propagated through §3.3, §6.1, §6.2 (A-2); all config key names converted to dotted notation with Part 2-REV1 §2.17.3 as canonical registry (A-3); Section 4 scope note added (A-4); §6.5 SpaceAllocationService added for CONFERENCE and CATERING entries (A-5); Policy 14 added to §6.3 enforcement points (B-5); staleness authorship clarified as W1-triggered (B-6); `revalidationDelta` DTO flattened to match model (B-3); Section 9 header note directing to Part 12 §12.3.1 (B-4). Locked by Architect per MOM-ARCH-2026-018. |
| 1.2 | 13 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | S3→S1 re-entry context additions. Per MOM-ARCH-2026-020 Section 4 (Q3) and SIG-S5-PRE-007: §1 entry routes, §2 schema context, §6 services, §10 acceptance criteria all updated with S3→S1 re-entry behaviour. No existing v1.1 content modified. |

---

## Source Documents

All source files were loaded using the `view` tool before writing began. Writing did not commence until all sources were confirmed loaded.

| Source | File | Key sections read |
|---|---|---|
| S1 Stage Charter | `Canon_Block5_S1_S2_REV2_2.md` | §42.1–42.19 full |
| State Machine | `DEV-SPEC-001-Part3.md` | §3.1, §3.2 (Entry Lifecycle), §3.17 (ProcessingLock) |
| Engines | `DEV-SPEC-001-Part4.md` | §4.2 (PricingPipelineEngine), §4.3 (AvailabilityEngine) |
| Policies | `DEV-SPEC-001-Part5-REV1.md` | Policies 1, 2, 3, 4, 6, 12, 19, 69, 71, 72 |
| Services | `DEV-SPEC-001-Part6-REV1.md` | §6.5.2 InquiryService, §6.5.3 EntryService, §6.5.5 AvailabilityService, §6.5.13 ProcessingLockService |
| Workers | `DEV-SPEC-001-Part8.md` | W1 StageDwellMonitor, W16 ProcessingLockExpiryWorker, W20 EntryExpiryWorker |
| Routes | `DEV-SPEC-001-Part9-REV1.md` | §9.4.2 Session/Auth, §9.4.3 Inquiries, §9.4.4 Entries, §9.4.5 Availability, §9.4.19 Processing Locks |
| Schema | `DEV-SPEC-001-Part2-REV1.md` | Inquiry, Entry, Segment, AvailabilityConfiguration, Room, Space, ProcessingLockRecord, StageDwellRecord, GuestProfile, TraceEvent, ConfigurationEntry |
| Configuration | `DEV-SPEC-001-Part12.md` | §12.2 configuration surface catalogue, §12.3.1 S1 Readiness table |
| Acceptance Gates | `DEV-SPEC-001-Part13.md` | §13.2 Schema Gate, §13.3 State Machine Gate, §13.4 Engine Gate, §13.5 Policy Gate, §13.6 Service Gate, §13.7 Worker Gate, §13.8 Controller Gate |

**Note on REV1 files:** `DEV-SPEC-001-Part2-REV1.md`, `Part5-REV1.md`, `Part6-REV1.md`, and `Part9-REV1.md` are the corrected versions per MOM-ARCH-2026-016. These were used in preference to the unversioned originals throughout.

---

## Table of Contents

1. [Stage Identity](#section-1--stage-identity)
2. [Schema Models Active at S1](#section-2--schema-models-active-at-s1)
3. [State Machine at S1](#section-3--state-machine-at-s1)
4. [Policies Enforced at S1](#section-4--policies-enforced-at-s1)
5. [Engines Invoked at S1](#section-5--engines-invoked-at-s1)
6. [Services Active at S1](#section-6--services-active-at-s1)
7. [Workers Active at S1](#section-7--workers-active-at-s1)
8. [API Routes at S1](#section-8--api-routes-at-s1)
9. [Configuration Keys at S1](#section-9--configuration-keys-at-s1)
10. [Acceptance Criteria](#section-10--acceptance-criteria)

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 1 (S1) — Inquiry & Configuration**

### 1.2 Stage Purpose

Stage 1 exists to capture a guest's or agent's initial requirements, explore available inventory options, and produce one or more persisted availability configurations representing the options explored — without making any commercial commitment, claiming inventory, or promising a final rate. S1 ends when the system holds a structured record of what the guest wants, at least one validated availability configuration, a selected preferred configuration, captured contact details, and enough operational context that any staff member can continue without repeating the exploratory process. The system has made no commercial commitment, no inventory claim, and no financial promise when S1 is correctly completed.

### 1.3 Entry Routes

An entry arrives at S1 through one of four routes.

**New inquiry intake.** A guest, agent, corporate coordinator, or other source initiates contact. A staff member creates an inquiry and its first entry. The entry begins in `(ACTIVE, S1)`.

**Additional entry on existing inquiry.** The same guest or agent adds a new date range or use type to an existing inquiry. A new entry is created under the same inquiry parent and begins in `(ACTIVE, S1)` independently. It does not inherit the status of its siblings.

**Re-entry from a later stage.** An entry that has progressed past S1 returns because the guest wants to reconfigure. A new `Segment` is created. The entry enters `(ACTIVE, S1)` within the new segment. All prior segment data is preserved as read-only reference. Re-entry to S1 is possible from S2 through S8 depending on the change type and required authority.

**Walk-in compressed intake.** A walk-in guest triggers a compressed lifecycle. S1 is still the starting stage, but intake is compressed to capture essentials for immediate occupancy. Walk-in handling is subject to the cross-stage walk-in compression mechanism; the walk-in rate plan must be configured before this path is operational.

**Re-entry from S3 — fundamental reconfiguration.** An entry at S3 returns to S1 when the guest requires a fundamental change — room type or date range change — that necessitates a fresh availability search. Authority is FOM (L2+) minimum. On this transition:

- `EntryService.createSegment()` creates a new segment. The prior segment is sealed in the same transaction.
- `ReEntryConsequenceEngine.compute()` is invoked with transition type S3→S1. Three consequences execute in the same transaction as the segment seal: `HOLD_RELEASED`, `FOLIO_CONTINUES`, `INVOICES_SUPERSEDED`.
- The prior `CommittedHold` is released — inventory returns to `FREE` before the new S1 search runs. `HoldService.releaseOnReEntry()` executes this with `releaseReason: REENTRY_S3_TO_S1`.
- All `PROVISIONAL` and `DISPATCHED` invoices on the Entry-level folio transition to `SUPERSEDED`. `FolioService.supersedePendingInvoices()` executes this. W22 and W34 timers for each superseded invoice are cancelled in the same transaction.
- The Entry-level provisional folio already exists and persists — S1 does not create a folio. When this new segment reaches S3, `FolioService.getOrCreate()` returns the existing folio.
- Prior `AvailabilityConfiguration` records from the sealed segment are read-only context — they do not seed or constrain the new S1 search.
- Guest profile, preferences, and special requests from all prior segments are available as read-only context — surfaced to staff during the new S1 availability search.
- Park history from the prior segment is carried forward as `TraceEvent` context — the `parkedIndividually` field responsibility is unaffected by the re-entry.

### 1.4 Exit Condition

S1→S2 transition requires all of the following to be true. Every guard is evaluated in sequence; failure at any guard raises a `StageGateBlockedError` identifying the specific unsatisfied condition.

1. A created `Entry` record exists with all mandatory fields populated: guest identity (`guestProfileId`), source channel, `useType` (`EntryUseType`), date range (or event date/time block for conference use type), guest count, and custodian assignment. `otaSource` flag set to `true` if the source channel is OTA.
2. At least one `AvailabilityConfiguration` record has been created and persisted for this entry.
3. A preferred configuration has been selected (`optionSelected` is not null on the selected `AvailabilityConfiguration`). If any room in the preferred configuration carries an unresolved DEFICIENT flag, the booking staff member's explicit acknowledgement of that flag must be recorded (`deficientAcknowledgements` populated on the configuration record).
4. The preferred configuration is not stale. If `AvailabilityConfiguration.isStale = true` on the selected configuration, revalidation is required before exit is permitted.
5. Primary contact details are captured on the `GuestProfile` linked to the inquiry.
6. For corporate or government source channels: corporate context (client reference, coordinator) is recorded.
7. For conference use type: hall selection with seating configuration is recorded and attendee count validated against space capacity.
8. For apartment use type: duration is recorded and an applicable duration-based rate tier is identifiable from the rate plan registry.
9. No active duplicate detection flag is unresolved — the operator must have merged, acknowledged, or dismissed the conflicting record with a recorded reason.
10. No unresolved maintenance conflict exists on the selected configuration's room or space.
11. Authority satisfied: the acting user is at minimum `ActorLevel.FRONT_DESK` (Custodian).

S1→S3 (S2 auto-fulfilled path) applies when the guest accepts a standard package rate without negotiation. Guard conditions are identical except S2 is recorded as auto-fulfilled with a `TraceEvent` recording its passage. Authority requirement is the same.

### 1.5 Governing Actors

| Role | Actor Level | Authority at S1 |
|---|---|---|
| Receptionist / Reservations | `ActorLevel.FRONT_DESK` (L1) | Creates inquiry, creates entry, executes availability search, selects preferred configuration, parks/unparks, assigns custodian within standard rules |
| Front Office Manager | `ActorLevel.FOM` (L2) | All L1 actions; resolves custodian escalation when no assignment rule resolves; handles ambiguous duplicate detection match |
| General Manager | `ActorLevel.GM` (L3) | All L2 actions; required for re-entry to S1 from S4 or later under specific re-entry triggers |
| Admin | `ActorLevel.ADMIN` (L4) | Configuration only; not an operational actor at S1 |

### 1.6 Forbidden Actions at S1

The following must not occur during S1. Each is an architectural violation if implemented.

- **No folio creation.** No `Folio` record may exist for an entry in S1. Folio creation belongs to S3.
- **No hold of any kind.** Neither speculative nor committed holds may be placed at S1. `SpeculativeHold` and `CommittedHold` records may not be created. Hold placement is a S2-only action.
- **No payment collection or recording.** No `PaymentRecord` may be created. No payment event of any kind.
- **No final pricing commitment.** Rate references at S1 are indicative only. No rate may be communicated as final, committed, or quotation-grade. The `PricingPipelineEngine` is not the primary engine at S1; indicative rate display is informational only.
- **No quotation document.** Formal quotation generation belongs to S2. Informal summaries may be shared verbally; a formal `Quotation` record may not be created at S1.
- **No bypassing availability search.** A configuration may not be selected without at least one `AvailabilityEngine.query()` having been executed. Selecting a room from memory or assumption, without a persisted `AvailabilityConfiguration` record, is forbidden.
- **No silent OTA_SOURCE omission.** For OTA-sourced entries, the `otaSource` flag must be set at creation. It cannot be added retrospectively after S1 exit.

---

## Section 2 — Schema Models Active at S1

The following Prisma models are read or written during S1 operations. Mutation rules state what can and cannot change at S1. The full schema with all models and relations is in Part 2.

---

### 2.1 Inquiry

**Access at S1:** Created and written. `id` and `guestProfileId` are immutable from creation.

```prisma
model Inquiry {
  id                 String    @id @default(uuid())
  // inquiry_id is immutable once created — no re-parenting, no inquiry merge
  referenceNumber    String    @unique
  guestProfileId     String
  sourceChannel      String    // DIRECT | OTA | CORPORATE | WALK_IN | AGENT
  defaultCustodianId String    // actor_id of assigned custodian — set by Policy 3
  notes              String?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  createdBy          String    // actor_id — NOT NULL

  // Derived inquiry state (aggregate of entry states) is computed, not stored

  guestProfile       GuestProfile  @relation(fields: [guestProfileId], references: [id])
  entries            Entry[]

  @@map("inquiries")
}
```

**S1 mutation rule:** Create at S1. Custodian and contacts updatable while active. `id`, `guestProfileId`, and all `Entry.inquiryId` links are immutable after creation — no re-parenting between inquiries.

---

### 2.2 Entry

**Access at S1:** Created and written. `useType` and `otaSource` (once set true) are immutable.

```prisma
model Entry {
  id                   String          @id @default(uuid())
  inquiryId            String
  // inquiryId is immutable — no re-parenting between inquiries
  segmentNumber        Int             @default(1)
  useType              EntryUseType    // immutable after creation
  status               EntryStatus     @default(ACTIVE)
  currentStage         Stage           @default(S1)
  checkInDate          DateTime?
  checkOutDate         DateTime?
  guestCount           Int?
  otaSource            Boolean         @default(false)
  // otaSource is immutable once set at S1 — no actor may unset
  groupBillingMode     GroupBillingMode?
  parkedAt             DateTime?       // null when not parked
  parkedBy             String?         // actor_id who placed the park
  parkedIndividually   Boolean         @default(false) // true when entry was individually parked before an inquiry-level park cascade; read by InquiryService.unpark() to determine unpark eligibility
  createdAt            DateTime        @default(now())
  updatedAt            DateTime        @updatedAt
  createdBy            String          // actor_id — NOT NULL
  version              Int             @default(1)   // optimistic lock field — locked addition per B4-001 (MOM-ARCH-2026-016); not yet present in Part 2-REV1; will be added in Part 2 REV2
  closedAt             DateTime?
  closedBy             String?

  inquiry              Inquiry         @relation(fields: [inquiryId], references: [id])
  segments             Segment[]
  availabilityConfigs  AvailabilityConfiguration[]
  stageDwellRecords    StageDwellRecord[]

  @@map("entries")
}
```

**S1 mutation rule:** Created at S1 with `useType` set and immutable. Provisional fields (`checkInDate`, `checkOutDate`, `guestCount`) may be updated during S1. `otaSource` set at creation and immutable thereafter. Stage progression written only by `EntryService.progressStage()`.

---

### 2.3 Segment

**Access at S1:** Created (Segment 1) at entry creation. Written on re-entry events.

```prisma
model Segment {
  id              String    @id @default(uuid())
  entryId         String
  segmentNumber   Int
  // Previous segments are read-only; only current segment's stage is editable
  stage           Stage
  startedAt       DateTime  @default(now())
  sealedAt        DateTime? // null until superseded or entry closes
  sealedBy        String?
  notes           String?
  createdBy       String    // actor_id — NOT NULL

  entry           Entry     @relation(fields: [entryId], references: [id])
  quotations      Quotation[]
  communications  CommunicationRecord[]

  @@unique([entryId, segmentNumber])
  @@map("segments")
}
```

**S1 mutation rule:** Created at S1 (Segment 1). Only the current segment's current stage is editable. Prior segments are read-only once sealed. A new segment is created on each re-entry event — not by updating the existing segment.

---

### 2.4 AvailabilityConfiguration

**Access at S1:** Created on each availability search. Written when staleness is detected or preferred configuration is selected. Sealed on S1 exit in the same transaction as the stage transition.

```prisma
model AvailabilityConfiguration {
  id                          String    @id @default(uuid())
  entryId                     String
  searchCriteria              Json      // structured search parameters
  optionSelected              Json?     // selected inventory option — null until operator selects
  isStale                     Boolean   @default(false)
  stalenessAt                 DateTime? // when staleness was detected by StageDwellMonitor
  deficientAcknowledgements   Json?     // array of acknowledged DEFICIENT conditions
  sealedAt                    DateTime? // sealed on S1 exit; recallable with revalidation
  createdAt                   DateTime  @default(now())
  createdBy                   String    // actor_id — NOT NULL

  entry                       Entry     @relation(fields: [entryId], references: [id])

  // Mutation rule: editable during S1; DEFICIENT acknowledgements recorded during S1;
  // sealed on S1 exit in same transaction as stage transition.
  @@map("availability_configurations")
}
```

**S1 mutation rule:** Editable during S1. Sealed on S1 exit. Stale configurations (`isStale = true`) require revalidation before they can be used as S1 exit evidence.

---

### 2.5 GuestProfile

**Access at S1:** Created for new guests or read to link an existing profile. Read throughout S1 for preference pre-population and indicative pricing context.

```prisma
model GuestProfile {
  id                    String    @id @default(uuid())
  firstName             String
  lastName              String
  email                 String?
  phone                 String?
  nationality           String?
  vipTier               String?   // configurable VIP tier classification
  clientTier            String?   // STANDARD | CAUTION | RESTRICTED | PREFERRED
  preferences           Json?     // structured preference object
  behaviouralFlags      Json?
  observationQueue      Json?
  stayHistorySummary    Json?     // derived summary — not primary operational state
  isActive              Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  createdBy             String    // actor_id — NOT NULL

  identityDocuments     GuestIdentityDocument[]
  tierChangeEvents      GuestTierChangeEvent[]
  inquiries             Inquiry[]

  @@map("guest_profiles")
}
```

**S1 mutation rule:** May be created at S1 for a new guest. Existing profiles are read at S1; not mutated unless capturing a new contact method. The `Inquiry.guestProfileId` reference is immutable once established.

---

### 2.6 Room

**Access at S1:** Read only — by `AvailabilityService` via `AvailabilityEngine`. Not written at S1.

```prisma
model Room {
  id                         String                @id @default(uuid())
  roomNumber                 String                @unique
  roomTypeId                 String
  floorNumber                Int?
  capacity                   Int
  currentClaimState          InventoryClaimState   @default(FREE)
  // Claim state evaluated against date range; this field reflects current resolved state

  // Model 2 — Physical state fields
  isDeficient                Boolean               @default(false)
  deficientConditionCategory DeficientConditionCategory?
  deficientSince             DateTime?
  deficientDeadline          DateTime?
  isUnderMaintenance         Boolean               @default(false)
  maintenanceDeadline        DateTime?
  cleansing_ritual_completed Boolean               @default(false)
  isBlocked                  Boolean               @default(false)
  blockedReason              String?
  createdAt                  DateTime              @default(now())
  updatedAt                  DateTime              @updatedAt

  roomType                   RoomType              @relation(fields: [roomTypeId], references: [id])
  claimStateEvents           RoomClaimStateEvent[]
  deficientConditionRecords  DeficientConditionRecord[]

  @@map("rooms")
}
```

**S1 mutation rule:** Not written at S1. Claim state changes begin at S3 through governed hold placement. Physical state changes occur outside normal booking flow.

---

### 2.7 Space

**Access at S1:** Read only — by `AvailabilityService` for conference and catering use types. Not written at S1.

```prisma
model Space {
  id                    String    @id @default(uuid())
  spaceName             String    @unique
  spaceType             String    // HALL | BOARDROOM | OUTDOOR | etc.
  defaultCapacity       Int
  seatingConfigurations Json      // array of {configName, capacity}
  expansionLinks        Json?     // linked space IDs for combined configurations
  isAvailable           Boolean   @default(true)
  isEventInProgress     Boolean   @default(false)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  spaceAllocations      SpaceAllocation[]

  @@map("spaces")
}
```

**S1 mutation rule:** Not written at S1. Read-only inputs to the availability query.

---

### 2.8 ProcessingLockRecord

**Access at S1:** Created when any channel actor identifies a specific inventory configuration. Transitions to EXPIRED (by W16) or RELEASED (on booking completion before TTL).

```prisma
model ProcessingLockRecord {
  // Transient concurrency record for inventory selection during booking workflow
  id                  String                @id @default(uuid())
  actorId             String                // NOT NULL
  channel             String                // EMAIL_AI | WHATSAPP_AI | FRONT_DESK | PHONE
  inventoryReference  String                // Room.id or Space.id
  placedAt            DateTime              @default(now())
  ttlSeconds          Int
  expiresAt           DateTime
  status              ProcessingLockStatus  @default(ACTIVE)
  expiredAt           DateTime?             // populated on EXPIRED
  releasedAt          DateTime?             // populated on RELEASED
  revalidationCount   Int                   @default(0)
  // Reconfirmation creates a NEW record — does not extend this one
  pgBossJobId         String?               // pg-boss expiry job ID — registered at placement
  createdAt           DateTime              @default(now())

  revalidationDeltas  RevalidationDeltaRecord[]

  // Mutation rule: ACTIVE → EXPIRED (unconditional at TTL — no heartbeat, no renewal)
  // or ACTIVE → RELEASED. Expiry event permanently logged. EXPIRED record preserved.
  @@map("processing_lock_records")
}
```

**S1 mutation rule:** ACTIVE → EXPIRED at TTL (unconditional, handled by W16). ACTIVE → RELEASED on booking completion before TTL. The EXPIRED record is never overwritten or deleted. Reconfirmation creates a new `ProcessingLockRecord`.

---

### 2.9 RevalidationDeltaRecord

**Access at S1:** Created by `ProcessingLockService.reconfirm()` in the reconfirmation transaction. Immutable from creation.

```prisma
model RevalidationDeltaRecord {
  id                     String               @id @default(uuid())
  processingLockId       String               // FK to the NEW ProcessingLockRecord
  availabilityChanged    Boolean
  deficientStatusChanged Boolean
  pricingChanged         Boolean
  availabilityDelta      Json?                // prior vs current availability state
  deficientDelta         Json?                // prior vs current DEFICIENT record
  pricingDelta           Json?                // prior vs current resolved rate
  createdAt              DateTime             @default(now())
  createdBy              String               // actorId — operator who triggered reconfirmation

  processingLock         ProcessingLockRecord @relation(fields: [processingLockId], references: [id])

  // Mutation rule: immutable from creation. Written once in the reconfirmation
  // transaction. Point-in-time snapshot of what changed during the TTL window.
  @@map("revalidation_delta_records")
}
```

**S1 mutation rule:** Immutable from creation. Written once per reconfirmation cycle in the same transaction as the new `ProcessingLockRecord`.

---

### 2.10 StageDwellRecord

**Access at S1:** Created when entry enters S1. Written by `StageDwellMonitor` (W1) throughout the dwell period.

```prisma
model StageDwellRecord {
  id              String          @id @default(uuid())
  entryId         String
  stage           Stage
  enteredAt       DateTime
  lastActiveAt    DateTime
  exitedAt        DateTime?
  dwellSeconds    Int?            // computed on exit
  mode            StageDwellMode  @default(ACTIVE)
  warningFiredAt  DateTime?
  criticalFiredAt DateTime?
  escalatedAt     DateTime?
  createdAt       DateTime        @default(now())

  entry           Entry           @relation(fields: [entryId], references: [id])

  @@index([entryId, stage])
  @@map("stage_dwell_records")
}
```

**S1 mutation rule:** Created at S1 entry. Mode transitions written by `StageDwellMonitor`. `exitedAt` and `dwellSeconds` populated in the S1→S2 transition transaction.

---

### 2.11 TraceEvent

**Access at S1:** Append-only. Written in the same Prisma transaction as every state change. Never updated or deleted under any circumstance.

```prisma
model TraceEvent {
  // Append-only. No UPDATE. No DELETE. Ever.
  id              String    @id @default(uuid())
  eventType       String    // canonical event type name from the event catalogue
  actorId         String    // NOT NULL — always a specific actor (L0–L4 or EXT)
  actorLevel      ActorLevel
  entityType      String    // NOT NULL — canonical record type name
  entityId        String    // NOT NULL
  operation       String    // CREATE | UPDATE | SEAL | CLOSE | TRANSITION | etc.
  payload         Json      // structured payload — never freeform string
  timestamp       DateTime  // caller-set explicitly — never Date.now() inside engine
  stageContext    Stage?    // stage at time of event
  segmentContext  String?   // Segment.id if applicable
  correlationId   String?   // links events in a chain
  inquiryId       String?   // top-level anchor for cross-record queries
  entryId         String?   // operational record anchor
  createdAt       DateTime  @default(now())

  // No relations — TraceEvent is a sink. References entity IDs as plain strings
  // to avoid cascading referential constraints on closed or archived records.

  @@index([entityType, entityId])
  @@index([correlationId])
  @@index([actorId])
  @@index([timestamp])
  @@index([inquiryId])
  @@map("trace_events")
}
```

**S1 mutation rule:** Append-only. Every S1 state machine transition emits a `TraceEvent` in the same transaction as the state change. If the transaction rolls back, the trace event rolls back with it. `AuditService.emit()` is the sole write path — services do not write `TraceEvent` records directly.

---

### 2.12 ConfigurationEntry

**Access at S1:** Read by services and workers at runtime using a date-range query. Not written by operational code.

```prisma
model ConfigurationEntry {
  id              String    @id @default(uuid())
  configKey       String    // canonical configuration key
  configValue     Json      // structured value — type depends on configKey
  effectiveFrom   DateTime
  effectiveTo     DateTime? // null = currently active
  setBy           String    // actor_id — ADMIN level required — NOT NULL
  setAt           DateTime
  notes           String?
  createdAt       DateTime  @default(now())

  @@index([configKey, effectiveFrom])
  // Mutation rule: not edited in place. A new ConfigurationEntry row is created
  // when a value changes — the prior row's effectiveTo is set. Admin-level write only.
  @@map("configuration_entries")
}
```

**S1 mutation rule:** Read-only at runtime. Admin Console writes only. Date-range query (`effectiveFrom <= now AND (effectiveTo IS NULL OR effectiveTo > now)`) is always used — not a simple `findFirst` by key alone.

---

### 2.13 Re-Entry Context from S3→S1

When an entry re-enters S1 from S3, the following models from the prior segment are available as read-only context. The new segment does not inherit mutable ownership of these records.

- **AvailabilityConfiguration** — prior segment's configurations are sealed (`sealedAt` populated). They are read-only reference for staff context during the new S1 search. They are not inputs to `AvailabilityEngine.query()` on the new segment.
- **CommittedHold** — prior segment's hold has been released to `FREE` by `HoldService.releaseOnReEntry()` before the new S1 search runs. The hold record remains visible in history with state `RELEASED` and `releaseReason: REENTRY_S3_TO_S1`.
- **Invoice** — prior segment's invoices are in `SUPERSEDED` state. They are visible in folio history. They do not count toward advance payment thresholds on the new segment.
- **Folio** — the Entry-level folio exists and is in `PROVISIONAL` state. It carries `PaymentRecord` entries from prior segments. S1 does not create, modify, or close the folio. When the new segment reaches S3, `FolioService.getOrCreate()` returns this existing folio — no new folio is created.

The new segment creates its own `AvailabilityConfiguration` records at S1 search. These are independent of the prior segment's configurations.

---

## Section 3 — State Machine at S1

### 3.1 Entry Status Transitions Valid During S1

The `Entry` state is a composite of `Entry.status` and `Entry.currentStage`. The valid composite states at S1 are:

| Composite State | Meaning |
|---|---|
| `(ACTIVE, S1)` | Entry is actively in S1 — the normal operating state |
| `(PARKED, S1)` | Entry has been explicitly parked while at S1 — a governed temporary hold |
| `(EXPIRED, —)` | Terminal state — entry exceeded the expiry threshold; not reversible |

Transitions during S1:

| From | To | Trigger | Authority | Guard |
|---|---|---|---|---|
| `(ACTIVE, S1)` | `(ACTIVE, S2)` | Operator invokes S1→S2 progression | Custodian (L1+) | All S1 exit evidence present; preferred configuration not stale; no unresolved open loops |
| `(ACTIVE, S1)` | `(ACTIVE, S3)` | S2 auto-fulfilment — guest accepts package rate without negotiation | Custodian (L1+) | Same as S1→S2 plus S2 auto-fulfilment condition met; S2 recorded as auto-fulfilled in `TraceEvent` |
| `(ACTIVE, S1)` | `(PARKED, S1)` | Entry-level park placed by operator | L1+ | `Entry.status` is `ACTIVE` |
| `(PARKED, S1)` | `(ACTIVE, S1)` | Entry-level unpark | L1+ | `Entry.status` is `PARKED`; park provenance check (see §3.4) |
| `(ACTIVE, S1)` | `(EXPIRED, —)` | `EntryExpiryWorker` fires | System | TTL threshold reached; `Entry.status` not already terminal |

**Guard failure behaviour:** Any transition that fails a guard raises `StageGateBlockedError` identifying the specific unsatisfied condition, the stage, and whether an override path is available.

### 3.2 Guard Conditions for S1→S2 Exit

All five transition guards are evaluated in sequence. A failure at any guard stops evaluation.

1. **Source state match.** `Entry.currentStage = S1` and `Entry.status = ACTIVE`.
2. **Exit evidence present.** All mandatory fields populated; at least one `AvailabilityConfiguration` with `optionSelected` not null; preferred configuration not stale; DEFICIENT acknowledgements recorded where required; primary contact captured; use-type-specific requirements satisfied (conference: hall + seating; apartment: duration recorded).
3. **Open loops closed.** No unresolved duplicate detection flag; no unresolved maintenance conflict on selected configuration's room or space.
4. **Authority satisfied.** Acting user holds at minimum `ActorLevel.FRONT_DESK`.
5. **State machine guard returns VALID.** The state machine guard function evaluates the entry's current system state and returns `VALID`.

### 3.3 Parking Mechanics at S1

**Entry-level park:** Entry transitions independently from `(ACTIVE, S1)` to `(PARKED, S1)`. Sibling entries and the parent `Inquiry` are not affected. `Entry.parkedAt`, `Entry.parkedBy`, and `Entry.parkedIndividually` (set to `true`) are populated.

**Inquiry-level park:** Cascades to all active non-terminal entries under the inquiry. Each entry in `(ACTIVE, Sn)` transitions to `(PARKED, Sn)`. Entries already in `(PARKED, Sn)` — indicated by `Entry.parkedIndividually = true` — retain their individual park record and are not doubly-parked.

**Inquiry-level unpark:** Does NOT unpark entries that were individually parked before the inquiry-level park was placed. The system evaluates `Entry.parkedIndividually` per entry to determine unpark eligibility. Only entries where `parkedIndividually = false` (parked solely as a consequence of the inquiry-level cascade) are transitioned back to `(ACTIVE, Sn)`.

**Park provenance requirement:** `Entry.parkedIndividually` is the provenance field. It is set to `true` by `EntryService.park()` when an individual entry-level park is placed. It is read by `InquiryService.unpark()` to determine which entries the inquiry-level unpark may reverse. Entries where `parkedIndividually = true` are left parked — their individual park was placed for a separate reason and is not governed by the inquiry-level unpark operation.

### 3.4 Expiry Path at S1

The expiry path applies to entries that remain at S1 beyond the configured expiry threshold without progressing to S2 or S3.

1. `EntryExpiryWorker` (`ENTRY_EXPIRY` pg-boss job) fires when the configured expiry threshold is reached.
2. Worker reads `Entry.status`. If already `EXPIRED`, `CANCELLED`, or `CLOSED`, worker exits without action (idempotency).
3. Worker transitions `Entry.status → EntryStatus.EXPIRED`, sets `Entry.closedAt` and `Entry.closedBy = "SYSTEM"`.
4. `TraceEvent` with `eventType = 'ENTRY.EXPIRED'` is emitted in the same transaction.
5. `EntryStatus.EXPIRED` is a terminal state. It cannot be reversed under any circumstance.

The parked entry expiry path follows the same worker and the same terminal outcome. A parked entry that exceeds its park-expiry threshold is expired by the same worker.

### 3.5 Re-Entry Mechanics to S1

When an entry that has progressed past S1 returns to S1 (e.g., date change request from S2, configuration error from S5), the following occurs:

1. A new `Segment` record is created (`segmentNumber` incremented on the `Entry`).
2. The prior segment is sealed (`Segment.sealedAt` and `Segment.sealedBy` populated) — it becomes read-only.
3. `ReEntryConsequenceEngine.compute()` is invoked by `EntryService` to compute the consequence payload for the new segment (resetting timers, folio adjustments if applicable, handoff updates).
4. The entry enters `(ACTIVE, S1)` within the new segment.
5. Prior segment data remains accessible as read-only reference throughout the re-entry lifecycle.

Re-entry triggers and required authority levels at S1:

| Re-entering From | Trigger | Authority Required |
|---|---|---|
| S2 | Date or room type change | Custodian (L1+) or FOM (L2+) |
| S3 | Fundamental reconfiguration of room/space | FOM (L2+) |
| S4 | Date change post-confirmation | FOM (L2+) |
| S5 | Configuration error requiring re-search | FOM (L2+) |
| S6 | Room change required at check-in | Front desk (L1+) / FOM (L2+) |
| S7 | Room change during stay (Room Change mode) | Front desk (L1+); FOM (L2+) for rate delta |

For re-entry from S4 or later to S1, the entry carries into the new S1 segment: all prior segment data as read-only context, the re-entry trigger and reason, the current state of any live folio (read-only reference), current inventory claims, and any active disputes or service recovery records. The re-entry context determines which S1 actions are compressed or auto-fulfilled versus which require fresh configuration.

---

## Section 4 — Policies Enforced at S1

This section covers the primary business-gate policies enforced at S1. Processing lock, OTA validation, session, and AI-path policies are specified at their enforcement points in Sections 6 and 7 respectively.

### Policy 1 — Availability Query Policy

- **Active at:** S1 (availability search); S5 (room assignment); re-entry revalidation points
- **Trigger condition:** Operator requests an availability search; `AvailabilityService.query()` is called
- **Enforcement point:** `AvailabilityService.query()` — evaluated before `AvailabilityEngine.query()` is invoked; result passed to caller with DEFICIENT flags annotated per Policy 2
- **Decision type:** APPROVED (results returned with full availability state including both Model 1 claim state and Model 2 physical state) | DENIED (invalid query parameters — missing required fields)
- **Hardcoded behaviour:** The query must combine Model 1 (claim state) and Model 2 (physical state). Results from either model alone are not a valid availability answer. A room that is physically BLOCKED or UNDER_MAINTENANCE with a deadline within the requested range is always flagged as a conflict, regardless of configurable physical state settings. The OTA_SOURCE flag on the entry affects claim state evaluation through shadow inventory visibility rules.
- **Configurable parameters:** Shadow inventory visibility rules (whether shadow inventory appears in results, per channel and agent tier); configurable set of bookable physical states (floor is hardcoded: BLOCKED and UNDER_MAINTENANCE with deadline in range are always conflicts regardless of this setting); staleness window for availability configurations

---

### Policy 2 — DEFICIENT Condition Surface Policy

- **Active at:** S1 (availability search results)
- **Trigger condition:** `AvailabilityEngine.query()` returns results; `AvailabilityService.query()` post-query annotation step executes
- **Enforcement point:** `AvailabilityService.query()` — DEFICIENT flags annotated onto search results before results are returned to the caller; no write operation occurs at this annotation step; the `AvailabilityConfiguration` write occurs separately when the configuration is persisted
- **Decision type:** Enforcement rule — every room with an active `DeficientConditionRecord` is flagged in the result. Flagged rooms remain visible and selectable. This policy governs annotation, not selection. Selection is governed at S5 by Policy 48.
- **Hardcoded behaviour:** DEFICIENT flags are always annotated on search results. They are never suppressed, regardless of actor level or any configuration setting. Before a DEFICIENT-flagged room may be included in the preferred configuration at S1, the booking staff member must explicitly acknowledge the DEFICIENT condition. The acknowledgement is recorded in `AvailabilityConfiguration.deficientAcknowledgements`. An unacknowledged DEFICIENT flag on a room in the preferred configuration blocks S1 exit.
- **Configurable parameters:** `DeficientConditionCategory` values that are active and annotated in results

---

### Policy 3 — Initial Custodian Assignment Policy

- **Active at:** S1 (inquiry and entry creation)
- **Trigger condition:** `InquiryService.create()` is called; custodian assignment is evaluated immediately after inquiry creation
- **Enforcement point:** `InquiryService.create()` → `InquiryService.assignCustodian()`
- **Decision type:** APPROVED (custodian assigned per configured ownership assignment rules) | ESCALATE(`ActorLevel.FOM`) (no assignment rule resolves — FOM must assign manually)
- **Hardcoded behaviour:** Every inquiry and entry must have a custodian at the moment of creation. No inquiry or entry may exist without a custodian assigned. If the escalation path is triggered, the custodian field must remain unset until FOM explicitly assigns — the system does not auto-assign a default when no rule resolves.
- **Configurable parameters:** Ownership assignment rules per channel (manual, channel-based, round-robin); default custodian per channel type — from `ConfigurationEntry` with key `ownership_assignment_rules`

---

### Policy 4 — Custodian Reassignment Policy

- **Active at:** S1, S4
- **Trigger condition:** `InquiryService.assignCustodian()` is called for a reassignment (not initial creation); `EntryService.reassignCustodian()` is called
- **Enforcement point:** `InquiryService.assignCustodian()` and `EntryService.reassignCustodian()` — policy evaluated before custodian field is updated; reassignment event recorded
- **Decision type:** APPROVED (`ActorLevel.FRONT_DESK` for standard reassignment) | ESCALATE(`ActorLevel.FOM`) (high-value or conference entries per configured threshold)
- **Hardcoded behaviour:** Every custodian change produces an immutable attribution event. Retrospective attribution change is forbidden — the historical custodian record is preserved even after a reassignment. The new custodian does not overwrite the prior record; the history is additive.
- **Configurable parameters:** High-value entry threshold above which FOM authority is required for reassignment


---

### Policy 6 — Inquiry Expiry Policy

- **Active at:** S1 (idle inquiry timer)
- **Trigger condition:** The configured S1 entry expiry timer fires. `EntryExpiryWorker` is the enforcement actor — this policy is not request-time evaluated.
- **Enforcement point:** `EntryExpiryWorker` (timer-fired) calls `EntryService.expireEntry()`. The expiry event is recorded; `Entry.status` is set to `EntryStatus.EXPIRED`.
- **Decision type:** Enforcement event — when the governed timer fires, the entry transitions to `EntryStatus.EXPIRED`. No actor may approve continuation without creating a new inquiry.
- **Hardcoded behaviour:** Expiry is always a governed event with a permanent record. Silent expiry — expiry without a `TraceEvent` and audit record — is forbidden. `EntryStatus.EXPIRED` is a terminal state; it cannot be reversed under any circumstance or by any authority level.
- **Configurable parameters:** Expiry threshold duration for S1 entries — from `ConfigurationEntry` with key `entry_expiry_threshold` (duration per entry type); warning threshold offset (duration before hard expiry at which a warning event fires)

---

### Policy 12 — Duplicate Inquiry and Entry Creation Gate Policy

- **Active at:** S1 (inquiry and entry creation)
- **Trigger condition:** `InquiryService.create()` is called; duplicate check runs before the inquiry record is written
- **Enforcement point:** `InquiryService.create()` — `DuplicateDetectionService.checkAtCreation()` is called before the inquiry record is persisted
- **Decision type:** APPROVED (no duplicate detected) | DENIED (confirmed duplicate match — creation is blocked; the operator is shown the conflicting record) | ESCALATE(`ActorLevel.FOM`) (ambiguous match requiring judgement)
- **Hardcoded behaviour:** The duplicate check runs on every inquiry creation without exception. A confirmed duplicate match is a hard block — it is not a warning that can be dismissed by a standard operator without FOM involvement. The operator is shown the conflicting record and must explicitly resolve (merge with the existing inquiry, proceed with acknowledgement, or dismiss with recorded reason) before creation proceeds.
- **Configurable parameters:** Match threshold (exact vs. fuzzy identity matching rules); OTA reference matching rules

---

### Policy 19 — Rate Plan Resolution Policy (Indicative at S1)

- **Active at:** S2 (primary — quotation creation). Referenced at S1 in indicative context only.
- **Trigger condition at S1:** Indicative rate display during availability configuration selection. The `PricingPipelineEngine` may be called at S1 to produce an indicative rate reference for display purposes only — it is not the basis for any quotation or commitment.
- **Enforcement point:** S1 indicative rate display does not create a `Quotation` record. The policy's primary enforcement point (`QuotationService.createQuotation()`) does not fire at S1. If `PricingPipelineEngine.resolve()` is called at S1 for indicative display, its output is informational only and must not be stored as a rate commitment.
- **Decision type:** APPROVED (rate resolved; `PricingResult` returned) | DENIED (no applicable rate plan exists; `MissingConfigurationError`)
- **Hardcoded behaviour:** Rate plan priority order is invariant at all stages: individual-level agreements → promotional → tier → channel → rack. This order cannot be altered by configuration at S1 or any other stage. Deterrent rate auto-assignment (CAUTION/RESTRICTED tier guests) applies at S1 if the engine is invoked — the guest is never informed.
- **Configurable parameters:** All rate values within rate plans; MSR per rate plan; deterrent rate value; season boundaries; applicable rate plan types per source channel and client tier
- **S1 constraint:** No rate presented at S1 may be communicated as final, committed, or quotation-grade. The forbidden act "communicating any rate as final or committed" applies unconditionally at S1.

---

### Policy 69 — Session Management and PIN Authentication Policy

- **Active at:** All stages (S1 through S9)
- **Trigger condition:** Any session boundary event — PIN switch, idle auto-lock threshold reached, manual lock initiated, hard logout threshold reached
- **Enforcement point:** `SessionService` — all session transitions governed; `SessionEventRecord` created on every session event
- **Decision type:** Enforcement rule — no session event is silent. Every session boundary produces a permanent `SessionEventRecord`. Attribution enforcement: every record written within a session carries the identity of the authenticated actor at the time of writing.
- **Hardcoded behaviour:** Shared credentials are forbidden — this is a schema-level design constraint, not a policy override. Retrospective attribution change is structurally forbidden — the actor recorded on a transaction cannot be corrected after the fact. Every session event produces a permanent `SessionEventRecord`. The four governed session events are: PIN_SWITCH (outgoing actor suspended, incoming actor authenticates via PIN, both actor identities and timestamp recorded), IDLE_AUTO_LOCK (`SessionStatus.IDLE_LOCKED`), MANUAL_LOCK (`SessionStatus.MANUALLY_LOCKED`), HARD_LOGOUT (`SessionStatus.HARD_LOGGED_OUT`; session terminated).
- **Configurable parameters:** Idle lock threshold per role; hard logout threshold per role; manual lock availability per role — from `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` (configured via the session management configuration surface)

---

## Section 5 — Engines Invoked at S1

### 5.1 AvailabilityEngine

**Purpose:** Queries the two-model inventory architecture to produce a structured availability result for a given date range, room type, and booking context. This is the primary engine at S1. It is invoked on every availability search and on stale configuration recall.

**Primary method signature:**
```typescript
AvailabilityEngine.query(input: AvailabilityInput): AvailabilityResult
```

**Which service calls it and under what condition:**

`AvailabilityService.query()` calls `AvailabilityEngine.query()` on every availability search request. `AvailabilityService.recallConfiguration()` also calls the engine when a stale configuration is recalled and requires revalidation. The engine is also called during `ProcessingLockService.reconfirm()` as part of the revalidation check at new lock placement.

**Input contract (S1-relevant fields):**

```typescript
interface AvailabilityInput {
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId?: string;        // null returns all room types
  spaceId?: string;           // for conference/catering space search
  guestCount: number;
  useType: EntryUseType;
  otaSource: boolean;         // Entry.otaSource — affects shadow inventory visibility
  guestTier: string;
  agentTier?: string;
  shadowInventoryRules: ShadowInventoryRule[];    // resolved by calling service from ConfigurationEntry
  bookablePhysicalStates: InventoryClaimState[];  // resolved by calling service from ConfigurationEntry
  rooms: RoomAvailabilityRecord[];                // resolved by calling service from DB
  spaces: SpaceAvailabilityRecord[];              // resolved by calling service from DB
  currentTimestamp: Date;     // explicit — engine does not call Date.now() internally
}
```

The calling service (`AvailabilityService`) is responsible for resolving all data dependencies from the database before calling the engine. The engine does not query the database.

**Output contract:**

```typescript
interface AvailabilityResult {
  availableRooms: AvailableRoomEntry[];
  unavailableRooms: UnavailableRoomEntry[];
  deficientRooms: DeficientRoomEntry[];          // available but DEFICIENT — requires acknowledgement
  maintenanceConflicts: MaintenanceConflictEntry[];
  searchTimestamp: Date;
  isRevalidationRequired: boolean;               // true if recalled configuration was stale
}
```

**What the service does with the output at S1:**

1. `AvailabilityService` receives the `AvailabilityResult`.
2. Policy 2 annotation step runs: rooms in `deficientRooms` are annotated with their DEFICIENT condition category and description before results are returned to the caller.
3. The service persists a new `AvailabilityConfiguration` record capturing the `searchCriteria` and the full result set.
4. Results (including DEFICIENT annotations) are returned to the calling controller.
5. The service does not acknowledge DEFICIENT flags — acknowledgement is an operator action with actor attribution recorded in `AvailabilityConfiguration.deficientAcknowledgements`.

**Hardcoded vs configurable separation:**

| Behaviour | Type |
|---|---|
| Two-model evaluation is always concurrent (Model 1 + Model 2) | Hardcoded |
| DEFICIENT flag always surfaces in results — never suppressed | Hardcoded |
| Maintenance conflicts always detected and returned | Hardcoded |
| Staleness always flagged — stale configuration never silently used | Hardcoded |
| OTA_SOURCE flag read from entry and passed to engine | Hardcoded |
| Shadow inventory visibility rules (per channel, agent tier) | Configurable |
| Bookable physical states set | Configurable (floor is hardcoded: BLOCKED and MAINTENANCE within range are always conflicts) |
| DEFICIENT condition categories surfaced | Configurable |
| Staleness window for availability configurations | Configurable (from `ConfigurationEntry`) |

**What the engine does not do at S1:**

- Does not write `AvailabilityConfiguration`. The calling service creates the configuration record.
- Does not acknowledge DEFICIENT flags. Acknowledgement is a service-level action with actor attribution.
- Does not enforce shadow inventory as a hard block — it returns visibility-filtered results per injected rules; the calling service applies the visibility.
- Does not read from the database. All room and space records, shadow inventory rules, and bookable physical states are injected by the calling service.

---

### 5.2 PricingPipelineEngine (Indicative at S1)

**Purpose:** Resolves the applicable rate plan for a given booking context, applies discounts or overrides within governed bounds, validates against the Minimum Sell Rate, and produces the authoritative pricing basis. At S1, this engine may be invoked for indicative rate display only. It is not the quotation engine at S1 — that invocation belongs to S2 (`QuotationService.createQuotation()`).

**Primary method signature:**
```typescript
PricingPipelineEngine.resolve(input: PricingInput): PricingResult
```

**Which service calls it and under what condition at S1:**

If indicative rate information is surfaced during S1 availability configuration (to help staff present a rate range to the guest), the calling service may invoke `PricingPipelineEngine.resolve()` with available booking context. This invocation is informational only. Its output must not be stored as a `Quotation` record, must not be communicated to the guest as a committed rate, and does not satisfy the Policy 19 enforcement obligation (which fires at `QuotationService.createQuotation()` in S2).

At `ProcessingLockService.reconfirm()`, the engine is also called as part of the revalidation check — pricing is re-verified at the moment a new lock is placed after expiry. This is the other S1-adjacent invocation of the engine.

**Input contract:** See Part 4 §4.2.4 for the full `PricingInput` interface. At S1 indicative context, the calling service injects all required fields — the engine does not query the database.

**Output contract:** See Part 4 §4.2.5 for the full `PricingResult` interface. At S1, the service acts on the output for display purposes only. The `isDeterrentRateApplied` field must not be surfaced in any guest-facing communication if `true`.

**Hardcoded vs configurable separation:**

| Behaviour | Type |
|---|---|
| Rate plan priority order: individual → promotional → tier → channel → rack | Hardcoded |
| Deterrent rate auto-assignment for CAUTION/RESTRICTED guest tiers | Hardcoded |
| MSR validation: resolved rate must be ≥ MSR | Hardcoded |
| Override margin enforcement boundary | Hardcoded |
| All rate values within rate plans | Configurable |
| MSR per rate plan | Configurable |
| Discount thresholds per authority level | Configurable |
| Season calendar boundaries | Configurable |
| Override margin per rate plan | Configurable |

**S1 constraint:** The output of a PricingPipelineEngine call at S1 is informational. The engine output is the basis for quotation at S2 — not at S1. Storing the S1 indicative output in a `Quotation` record or communicating it to the guest as a committed rate are both forbidden acts at S1.

---

## Section 6 — Services Active at S1

### 6.1 InquiryService

**Primary entity:** `Inquiry`

**Methods active at S1:**

#### `InquiryService.create(input)`

Creates the `Inquiry` record. This is the entry point for all new S1 intake.

- **What it does:** Creates the `Inquiry` record with guest profile reference, source channel, and initial custodian assignment. Emits `INQUIRY.CREATED` trace event in the same transaction.
- **Policies invoked:** Policy 12 (Duplicate Detection) — runs `DuplicateDetectionService.checkAtCreation()` before the inquiry record is written; Policy 3 (Initial Custodian Assignment) — `assignCustodian()` called immediately after inquiry creation; Policy 15 (Guest Identity Capture) — validates field completeness and OTA_SOURCE flag enforcement.
- **Engines called:** None.
- **Models read:** `GuestProfile` (to link existing profile or confirm new profile created), `ConfigurationEntry` (ownership assignment rules)
- **Models written:** `Inquiry` (new record), `TraceEvent` (`INQUIRY.CREATED`)
- **Transaction scope:** `Inquiry` creation + `TraceEvent` emission execute within a single `prisma.$transaction`.
- **Error conditions:** `PolicyGateBlockedError` if duplicate is detected; `MissingConfigurationError` if no ownership assignment rule resolves and FOM escalation is triggered but no FOM actor is available to assign; `ValidationError` if required identity fields are missing.

#### `InquiryService.assignCustodian(inquiryId, newCustodianId, actorId)`

Reassigns the custodian on an existing inquiry.

- **What it does:** Evaluates Policy 4 (Custodian Reassignment), updates `Inquiry.defaultCustodianId`, records an immutable attribution event.
- **Policies invoked:** Policy 3 (if initial assignment is being fulfilled after escalation); Policy 4 (Custodian Reassignment) for all reassignment calls.
- **Models written:** `Inquiry` (custodian field updated), `TraceEvent` (custodian reassignment attribution event).
- **Transaction scope:** Custodian field update + `TraceEvent` in single transaction.

#### `InquiryService.park(inquiryId, reason, actorId)`

Places an inquiry-level park that cascades to all active non-terminal entries.

- **What it does:** For each active non-terminal child entry where `Entry.parkedIndividually = false`: sets `Entry.status = PARKED`, `Entry.parkedAt`, and `Entry.parkedBy`. Entries where `Entry.parkedIndividually = true` are already individually parked — their status is left unchanged and they are not doubly-parked. Emits a `TraceEvent` per affected entry.
- **Policies invoked:** None.
- **Models written:** Affected `Entry` records (status, parkedAt, parkedBy — only entries where `parkedIndividually = false`), `TraceEvent` per affected entry.

#### `InquiryService.unpark(inquiryId, actorId)`

Reverses an inquiry-level park — does not unpark entries that were individually parked before the inquiry-level park.

- **What it does:** Reads `Entry.parkedIndividually` for each child entry in `PARKED` status. Only entries where `parkedIndividually = false` are eligible for unpark — these were parked solely by the inquiry-level cascade. Transitions eligible entries to `(ACTIVE, Sn)`, clears `parkedAt` and `parkedBy`. Entries where `parkedIndividually = true` remain `(PARKED, Sn)` — their individual park is not governed by the inquiry-level unpark.
- **Models written:** Eligible `Entry` records (status cleared, parkedAt/parkedBy cleared — only entries where `parkedIndividually = false`), `TraceEvent` per eligible entry.

#### `InquiryService.get(inquiryId)` / `InquiryService.list(filters)`

Read-only retrieval. The derived inquiry state (aggregate of entry states) is computed at query time — it is not stored as a primary operational field.

#### DuplicateDetectionService — called within `InquiryService.create()`

`DuplicateDetectionService` is not a standalone S1 service and does not have its own section. It is a dependency called internally by `InquiryService.create()` and is documented here.

**What it does:** `DuplicateDetectionService.checkAtCreation()` is called before the `Inquiry` record is written. It evaluates the incoming guest identity fields and proposed dates against existing active inquiries and entries to detect overlap.

**Models read (read-only — writes nothing):**
- `Inquiry`: identity fields (`guestProfileId`, `sourceChannel`, OTA reference if applicable) of existing active inquiries for the same guest identity
- `Entry`: `status`, `checkInDate`, `checkOutDate` of child entries under candidate duplicate inquiries — to evaluate date overlap
- `ConfigurationEntry`: duplicate detection thresholds (exact vs. fuzzy identity matching rules; OTA reference matching rules)

**Returns:** A detection flag to the calling `InquiryService`. Three possible outcomes: no duplicate detected (APPROVED — creation proceeds); confirmed duplicate match (DENIED — creation blocked; conflicting record surfaced to operator); ambiguous match (ESCALATE — FOM judgement required).

**Writes nothing.** All state changes resulting from duplicate detection — recording the operator's resolution choice, creating the inquiry after acknowledgement, merging inquiries — are `InquiryService`'s responsibility, not `DuplicateDetectionService`'s.

**Three staff resolution paths** (all owned by `InquiryService`, not `DuplicateDetectionService`):
1. Merge with the existing inquiry — operator selects the prior inquiry as the canonical record; new entry is created under it
2. Proceed with acknowledgement — operator records that they have reviewed the conflict and are proceeding; reason is mandatory
3. Dismiss with recorded reason — operator records that the match is not a true duplicate; reason is mandatory

An unresolved duplicate flag (where the operator has not chosen one of the three paths) blocks S1 exit. This is enforced as an open loop guard in the S1→S2 state machine transition.

---

### 6.2 EntryService

**Primary entity:** `Entry`, `Segment`

**Methods active at S1:**

#### `EntryService.create(input)`

Creates the `Entry` record and the first `Segment` (Segment 1).

- **What it does:** Creates the `Entry` with `useType` set and immutable, `currentStage = S1`, `status = ACTIVE`, `segmentNumber = 1`. Sets `otaSource = true` if the source channel is OTA. Creates Segment 1. Emits `ENTRY.CREATED` trace event.
- **Policies invoked:** Policy 15 (Guest Identity Capture) — OTA_SOURCE flag enforcement and field completeness; Policy 64 (Group Detection) — evaluates whether guest count triggers group classification.
- **Engines called:** None at creation.
- **Models written:** `Entry` (new), `Segment` (Segment 1), `TraceEvent` (`ENTRY.CREATED`).
- **Transaction scope:** `Entry` + `Segment` + `TraceEvent` in single transaction.
- **Error conditions:** `NotFoundError` if inquiry not found; `PolicyGateBlockedError` if group detection blocks; `ValidationError` for missing required fields.

#### `EntryService.progressStage(entryId, targetStage, transitionData, actorId)`

Advances the entry through stage transitions. At S1, this method handles the S1→S2 and S1→S3 transitions.

- **What it does:** Invokes the state machine transition guard defined in Part 3. Does not re-implement the guard — it calls the transition function and handles the result. On successful S1 exit: seals the preferred `AvailabilityConfiguration` (`sealedAt` populated), creates `StageDwellRecord.exitedAt`, advances `Entry.currentStage` to the target stage, emits stage transition trace event.
- **Policies invoked:** Guards for S1→S2 are evaluated within the state machine transition function; the service does not inline guard logic.
- **Models written:** `Entry` (`currentStage` updated), `AvailabilityConfiguration` (`sealedAt` populated for preferred config), `StageDwellRecord` (`exitedAt`, `dwellSeconds`), `TraceEvent` (`ENTRY.STAGE_TRANSITION`).
- **Transaction scope:** All writes above in single `prisma.$transaction`.
- **Error conditions:** `StageGateBlockedError` if any guard condition is unsatisfied; `StateTransitionError` if entry is not in expected source state.

#### `EntryService.park(entryId, reason, actorId)` / `EntryService.unpark(entryId, actorId)`

Entry-level park and unpark. Independent of inquiry-level cascade.

- **What it does (park):** Sets `Entry.status = PARKED`, `Entry.parkedAt`, `Entry.parkedBy`, and `Entry.parkedIndividually = true`. The `parkedIndividually` flag is the provenance marker read by `InquiryService.unpark()` to determine that this entry must not be reversed by an inquiry-level unpark. Emits trace event.
- **What it does (unpark):** Clears `Entry.status`, `Entry.parkedAt`, `Entry.parkedBy`, and resets `Entry.parkedIndividually = false`. Emits trace event.
- **Policies invoked:** None.
- **Models written:** `Entry` (status, parkedAt, parkedBy, parkedIndividually), `TraceEvent`.

#### `EntryService.expireEntry(entryId)`

Called by `EntryExpiryWorker`. Sets `Entry.status = EXPIRED` as a terminal transition.

- **What it does:** Transitions `Entry.status → EntryStatus.EXPIRED`. Sets `Entry.closedAt` and `Entry.closedBy = "SYSTEM"`. Emits `ENTRY.EXPIRED` trace event.
- **Policies invoked:** Policy 6 (Inquiry Expiry) — this is the enforcement point for timer-governed expiry.
- **Models written:** `Entry` (status, closedAt, closedBy), `TraceEvent` (`ENTRY.EXPIRED`).
- **Transaction scope:** State change + `TraceEvent` in single transaction.

#### `EntryService.searchAvailability(entryId, searchParams, actorId)`

Delegates to `AvailabilityService`. Entry-level wrapper that passes the entry's booking context.

- **What it does:** Resolves the entry's context (channel, guest tier, OTA_SOURCE, date range) and delegates to `AvailabilityService.query()`.
- **Policies invoked:** Policy 1 (Availability Query) — delegated to `AvailabilityService.query()`.
- **Engines called:** Delegation to `AvailabilityEngine.query()` occurs inside `AvailabilityService`.
- **Selection is a separate operation:** This method performs a search and persists an `AvailabilityConfiguration`. It does not set `optionSelected`. Preferred configuration selection is a distinct operation handled by `AvailabilityService.selectOption()` — called explicitly by the operator after reviewing search results.

#### `EntryService.createSegment(entryId, reEntryReason, actorId)` — S3→S1 re-entry

Called when a governed S3→S1 re-entry transition creates a new segment on an existing entry.

- **What it does:** Creates a new `Segment` record for the new S1 passage. Seals the prior segment (`Segment.sealedAt` and `Segment.sealedBy` populated) in the same transaction. Calls `ReEntryConsequenceEngine.compute()` with transition type S3→S1. The engine returns three consequences: `HOLD_RELEASED`, `FOLIO_CONTINUES`, `INVOICES_SUPERSEDED`. All three consequences are executed in the same transaction as the segment seal:
  - `HoldService.releaseOnReEntry(holdId, actorId, S3_TO_S1)` — releases the prior `CommittedHold`, transitions inventory from `COMMITTED_HELD` to `FREE`, emits `HOLD.RELEASED_ON_REENTRY` TraceEvent with `releaseReason: REENTRY_S3_TO_S1`.
  - `FolioService.supersedePendingInvoices(entryId, segmentId, actorId)` — transitions all `PROVISIONAL` and `DISPATCHED` invoices on the Entry-level folio to `SUPERSEDED`, emits `INVOICE.SUPERSEDED` TraceEvent per invoice, cancels W22 and W34 timers for each superseded invoice, creates `CommunicationRecord` noting PI supersession for guest notification.
  - Folio continues — no folio action required at S1; `FolioService.getOrCreate()` at the new S3 passage will return the existing Entry-level folio.
- **Authority required:** FOM (L2+) minimum.
- **Models read:** `Entry` (current state, currentStage, status), prior `Segment` (segmentNumber, stage, sealedAt), `CommittedHold` (state must be PLACED), `Invoice` (state IN [CREATED, DISPATCHED] on Entry-level folio), `Folio` (entryId).
- **Models written:** `Segment` (new record), prior `Segment` (sealedAt, sealedBy), `CommittedHold` (state → RELEASED), `Invoice` (state → SUPERSEDED per matched invoice), `RoomClaimStateEvent` (COMMITTED_HELD → FREE), `CommunicationRecord`, `TraceEvent` (SEGMENT.CREATED, HOLD.RELEASED_ON_REENTRY, INVOICE.SUPERSEDED per invoice).
- **Timer cancellations:** W22 (`ACKNOWLEDGEMENT_WINDOW`) and W34 (`ADVANCE_PAYMENT_FOLLOW_UP`) timers for each superseded invoice — cancelled in the same transaction.
- **Transaction scope:** Segment creation + prior segment seal + hold release + invoice supersession + timer cancellations + all TraceEvents — single `prisma.$transaction`. Partial execution is a structural defect.
- **Error conditions:** `StateTransitionError` if entry is not at S3; `AuthorizationError` if acting user is below FOM (L2); `NotFoundError` if no CommittedHold exists in PLACED state.

---

### 6.3 AvailabilityService

**Primary entity:** `AvailabilityConfiguration`, `Room` (claim state and physical state, read-only at S1)

**Methods active at S1:**

#### `AvailabilityService.query(input, actorId)`

The primary availability search method. Called for every new availability search at S1.

- **What it does:** Enforces Policy 1 (validates query parameters). Enforces Policy 14 (Shadow Inventory Visibility) — filters shadow inventory rooms from results based on the requesting actor's level and the configured visibility rules before results are returned. Resolves all data dependencies from the database (rooms, spaces, shadow inventory rules, bookable physical states, current timestamp). Calls `AvailabilityEngine.query()` with the resolved input. Receives `AvailabilityResult`. Runs Policy 2 annotation step (annotates DEFICIENT flags onto results). Persists a new `AvailabilityConfiguration` record capturing the search criteria and result set. Returns annotated results to the caller.
- **Policies invoked:** Policy 1 (Availability Query) — before engine call; Policy 14 (Shadow Inventory Visibility) — shadow inventory filter applied before results returned; Policy 2 (DEFICIENT Condition Surface) — post-query annotation step.
- **Engines called:** `AvailabilityEngine.query(input: AvailabilityInput): AvailabilityResult`
- **Models read:** `Room` (all fields in `RoomAvailabilityRecord`), `Space`, `DeficientConditionRecord` (for DEFICIENT annotation), `ConfigurationEntry` (shadow inventory rules, bookable physical states, staleness window)
- **Models written:** `AvailabilityConfiguration` (new record per search)
- **Transaction scope:** `AvailabilityConfiguration` creation is a single write — it does not require the broader state machine transaction because no state change is occurring.
- **Error conditions:** `ValidationError` if query parameters missing; `MissingConfigurationError` if shadow inventory rules or bookable states are not configured.
- **Conference and catering entries:** For entries with `useType = CONFERENCE` or `useType = CATERING`, `SpaceAllocationService.allocate()` is called after `AvailabilityEngine.query()` returns results. This creates a `SpaceAllocation` record in `QUOTED` state for the searched space. See §6.x SpaceAllocationService for the full S1 footprint.

#### `AvailabilityService.selectOption(configId, optionData, actorId)`

Marks a specific inventory option as the preferred selection on an existing `AvailabilityConfiguration`. This is a standalone explicit operation — it does not trigger stage progression.

- **What it does:** Reads the existing `AvailabilityConfiguration`. Validates that the configuration is not stale (`isStale` must be `false` — a stale configuration must be recalled and revalidated before it can be selected). Validates that the selected option is present in the configuration's result set. If the selected room carries an active `DeficientConditionRecord`, validates that a corresponding acknowledgement is recorded in `deficientAcknowledgements` before writing. Writes `optionSelected` with the chosen inventory option. Emits `CONFIGURATION_SELECTED` trace event.
- **Policies invoked:** None — selection is a governed write operation with its own validation rules enforced directly by this method.
- **Models read:** `AvailabilityConfiguration` (result set, staleness state, existing acknowledgements), `DeficientConditionRecord` (if selected room is DEFICIENT)
- **Models written:** `AvailabilityConfiguration` (`optionSelected` populated), `TraceEvent` (`CONFIGURATION_SELECTED`)
- **Transaction scope:** `optionSelected` write + `TraceEvent` in single transaction.
- **Error conditions:** `ValidationError` if configuration is stale; `ValidationError` if selected option is not in the configuration's result set; `ValidationError` if selected room is DEFICIENT and acknowledgement is not recorded; `NotFoundError` if configuration does not exist.

#### `AvailabilityService.getConfiguration(configId)` / `AvailabilityService.recallConfiguration(configId)`

Read and recall of existing configurations.

- **What it does (recall):** Reads the existing `AvailabilityConfiguration`. If `isStale = true`, re-runs `AvailabilityEngine.query()` against current system state to revalidate. Returns the revalidated result with `isRevalidationRequired = true` in the engine output.
- **Staleness note:** `AvailabilityConfiguration.isStale` and `stalenessAt` are written by this service when called by `StageDwellMonitor` (W1) on TTL expiry — not on a self-managed timer. The service does not schedule or manage its own staleness timer. W1 is the sole trigger for staleness writes. Stale configurations are recallable but require revalidation before they can be used as exit evidence.
- **Policies invoked (recall):** Policy 1, Policy 2.
- **Engines called (recall):** `AvailabilityEngine.query()`.

#### AvailabilityService — search behaviour on S3→S1 re-entry

When `AvailabilityService.query()` is called on a new segment created by S3→S1 re-entry, the search runs against clean inventory. The prior `CommittedHold` has already been released by `HoldService.releaseOnReEntry()` in the same transaction as the segment seal — no phantom holds from the prior segment distort results.

The service is aware that:
- A provisional folio already exists on this Entry — advance payments already received are visible via the folio's `PaymentRecord` entries. This is informational context for staff; it does not affect the availability search result.
- Prior `AvailabilityConfiguration` records from sealed segments are recallable as context but do not seed the new search. The new search creates its own `AvailabilityConfiguration` records from fresh `AvailabilityEngine.query()` output.
- The search result presents inventory availability as of current state — the prior hold is in `RELEASED` state and does not appear as `COMMITTED_HELD` inventory.

---

### 6.4 ProcessingLockService

**Primary entity:** `ProcessingLockRecord`

**Methods active at S1:**

#### `ProcessingLockService.placeLock(inventoryReference, channel, entryContext, actorId)`

Places a processing lock on an inventory item when a channel actor begins evaluating that inventory configuration.

- **What it does:** Checks for existing locks on the same inventory configuration (Policy 72 — Priority Queue). Creates a new `ProcessingLockRecord` with `status = ACTIVE`. Reads the TTL for the actor's channel from `ConfigurationEntry`. Registers the `PROCESSING_LOCK_TTL` pg-boss job with the expiry timestamp. If a prior lock exists on the same inventory, the new lock is created and the second actor receives an informational notification (not an error — the lock informs; it does not block). Emits `PROCESSING_LOCK.PLACED` trace event.
- **Policies invoked:** Policy 71 (Processing Lock TTL) — governs lock creation, TTL registration, expiry mechanics; Policy 72 (Priority Queue) — prior lock check before new lock creation.
- **Engines called:** None at lock placement.
- **Models written:** `ProcessingLockRecord` (new), `TraceEvent` (`PROCESSING_LOCK.PLACED`)
- **Transaction scope:** `ProcessingLockRecord` creation + pg-boss job registration + `TraceEvent` in single transaction.
- **Error conditions:** `MissingConfigurationError` if TTL configuration for the channel is absent.

#### `ProcessingLockService.reconfirm(expiredLockId, actorId)`

Called when an operator wants to reconfirm after their lock has expired.

- **What it does:** Reads the EXPIRED lock record (`ProcessingLockRecord.status` must be `EXPIRED` — cannot reconfirm an ACTIVE or RELEASED lock). Creates a new `ProcessingLockRecord` (new `id`, new TTL, `revalidationCount` incremented). Triggers revalidation check at the moment of new lock placement: calls `AvailabilityEngine.query()` to check current availability state; re-checks `DeficientConditionRecord` status for the target room; calls `PricingPipelineEngine.resolve()` to re-verify pricing. Creates a `RevalidationDeltaRecord` attached to the new lock showing what changed during the TTL window. Returns the new lock record and the revalidation delta to the caller.
- **Policies invoked:** Policy 71 (TTL — new lock placement); Policy 72 (Priority Queue — check for prior locks on same inventory); Policy 1 (Availability Query — revalidation re-runs availability check); Policy 19 (Rate Plan Resolution — pricing re-verified).
- **Engines called:** `AvailabilityEngine.query()` and `PricingPipelineEngine.resolve()`.
- **Models written:** `ProcessingLockRecord` (new record), `RevalidationDeltaRecord`, `TraceEvent`.
- **Error conditions:** `StateTransitionError` if the referenced lock is not in `EXPIRED` state.


#### `ProcessingLockService.expireLock(lockId)` — called by `ProcessingLockExpiryWorker`

Called by the worker on TTL expiry. Sets `ProcessingLockRecord.status = EXPIRED`. Dispatches the mandatory operator notification. Does not handle reconfirmation.

#### `ProcessingLockService.status(lockId)`

Read-only retrieval of the current lock status.

---

### 6.5 SpaceAllocationService

**Primary entity:** `SpaceAllocation`

**S1 footprint only.** This section covers only what SpaceAllocationService does at S1. The full lifecycle (hold transitions at S2/S3, lock at S4, release on completion or cancellation) is specified in Part 6-REV2 §6.5.12.

**Applicable entry types:** `useType = CONFERENCE` or `useType = CATERING` only. Accommodation and apartment entries do not invoke SpaceAllocationService at S1.

**Methods active at S1:**

#### `SpaceAllocationService.allocate(spaceId, entryId, eventDateBlock, actorId)`

Called by `AvailabilityService.query()` immediately after `AvailabilityEngine.query()` returns results for a CONFERENCE or CATERING entry.

- **What it does:** Checks the turnaround buffer for the requested space — verifies no adjacent event occupies the space within the required buffer window. If the buffer check passes, creates a `SpaceAllocation` record in `QUOTED` state for the searched space and time block. If the buffer check fails, surfaces a shortage detection condition — does not silently proceed.
- **Policies invoked:** Policy 67 (Work Order Lifecycle, space component) — governs allocation creation and release.
- **Models read:** `SpaceAllocation` (adjacent event check for turnaround buffer)
- **Models written:** `SpaceAllocation` (new record, `QUOTED` state)
- **Transaction scope:** `SpaceAllocation` creation is part of the same write as `AvailabilityConfiguration` creation — both are committed together or neither is committed.
- **Error conditions:** Shortage detection condition surfaced if turnaround buffer conflict exists; `ValidationError` if space or event date block is invalid.

**S1 mutation rule:** `SpaceAllocation` created at S1 in `QUOTED` state. No hold is placed at S1 — QUOTED is an informational claim only. Transition to hold states begins at S2.

---

### 6.6 Infrastructure Services Called at S1

Infrastructure services provide foundational mechanical capabilities. They contain no business rules, invoke no policies, and call no engines. Domain and application services call them. They may not import domain or application services.

Four infrastructure services are called during S1 operations.

---

#### SessionService

**Purpose:** Manages session lifecycle, PIN-based fast user switching, and attribution enforcement across all terminals.

**S1-relevant methods:**

`SessionService.authenticate(pin, terminalId)` — validates PIN (hashed comparison), creates `SessionRecord` with `status = ACTIVE`, creates `SessionEventRecord` for the login event. Every authenticated session at a terminal is individually tracked. No shared or group credentials — `SessionRecord.userId` is always an individual staff member.

`SessionService.switchUser(outgoingActorId, incomingPin, terminalId)` — PIN switch between staff members at the same terminal. Both actor identities and the terminal ID are recorded in a `SessionEventRecord` with `eventType = PIN_SWITCH`.

`SessionService.idleLock(sessionId)` — triggered by the idle threshold timer. Sets `SessionRecord.status = IDLE_LOCKED`. Creates `SessionEventRecord` with `eventType = IDLE_AUTO_LOCK`.

`SessionService.manualLock(sessionId, actorId)` — one-action manual lock by the staff member. Sets `SessionRecord.status = MANUALLY_LOCKED`. Creates `SessionEventRecord` with `eventType = MANUAL_LOCK`.

`SessionService.hardLogout(sessionId)` — triggered when the hard logout threshold is reached. Sets `SessionRecord.status = HARD_LOGGED_OUT`. Creates `SessionEventRecord` with `eventType = HARD_LOGOUT`.

**Attribution invariant:** The `actorId` recorded on every model write during a session is the authenticated actor at the time of the write. No "on behalf of" mechanism exists. No retrospective attribution change is possible.

---

#### TimerManagementService

**Purpose:** The single interface through which all services and workers register, cancel, and query timers. No service calls pg-boss directly — all timer operations go through this service.

**S1-relevant methods:**

`TimerManagementService.register(timerType, entityReference, entityType, stageContext, firesAt, warningAt?, criticalAt?, payload?)` — creates a `TimerRecord` and registers the pg-boss job. Called at S1 by:
- `EntryService.create()` — registers the `ENTRY_EXPIRY` timer for the new entry
- `EntryService.unpark()` — re-registers the `ENTRY_EXPIRY` timer after unparking
- `ProcessingLockService.placeLock()` — registers the `PROCESSING_LOCK_TTL` timer
- `StageDwellMonitor` — registers `STAGE_DWELL_MONITOR` on stage entry

`TimerManagementService.cancel(timerRecordId, reason, actorId)` — cancels an active timer and its pg-boss job. Called when an entry parks (pauses expiry timer) or when a processing lock is released before TTL.

`TimerManagementService.status(timerRecordId)` — read-only; returns the current `TimerRecord` and its latest `TimerEvent`.

**Rule:** Every timer type used must come from the timer registry in Part 4. No timer type may be invented in a service.

---

#### NotificationService

**Purpose:** Manages the four-tier notification escalation model for all system-generated notifications requiring human attention.

| Tier | Recipient | Delivery |
|---|---|---|
| 1 | Assigned staff / front desk | In-app notification |
| 2 | FOM | In-app + WhatsApp alert |
| 3 | GM | In-app + WhatsApp alert |
| 4 | Architect (operational escalation) | Email |

**S1-relevant method:**

`NotificationService.dispatch(recipientActorLevel, notificationType, payload, correlationId)` — dispatches a notification to the appropriate tier. All dispatch routes through pg-boss jobs — notifications are non-critical and dispatched after the primary database transaction commits, never within it.

`NotificationService.dispatchOperatorExpiry(processingLockId)` — specific handler for processing lock expiry. Dispatches the hardcoded governance text to the operator: *"Your inventory hold has expired — please reconfirm availability before proceeding."* This text is not configurable.

**At S1, NotificationService is called by:**
- `ProcessingLockExpiryWorker` (W16) — on lock TTL expiry, dispatches the operator expiry notification (Tier 1)
- `StageDwellMonitor` (W1) — on critical threshold, dispatches FOM escalation (Tier 2)

---

#### AuditService

**Purpose:** Canonical trace event emission interface. All services call `AuditService` to emit `TraceEvent` records rather than writing them directly — this ensures the trace event structure is applied consistently and all required fields are validated as non-null before the record is written.

**S1-relevant methods:**

`AuditService.emit(eventPayload)` — validates the payload (all required fields non-null), writes the `TraceEvent` record. Called **within the Prisma transaction context** for critical events — the calling service passes the Prisma transaction client so the trace event is part of the same transaction as the state change. Used for all S1 state transitions.

`AuditService.emitAsync(eventPayload)` — called **after** transaction commit for non-critical events. Dispatches as a pg-boss job. Used for informational audit annotations that do not record state changes.

`AuditService.query(entityId, entityType, fromDate?, toDate?)` — read-only audit reconstruction query. Returns ordered `TraceEvent` records for the specified entity and time range.

**At S1, every state machine transition emits via `AuditService.emit()` within the same transaction.** Non-state-change events (e.g., access log events, informational annotations) emit via `AuditService.emitAsync()` after commit.

---

## Section 7 — Workers Active at S1

### 7.1 Worker 1 — StageDwellMonitor

**Worker number:** W1
**Governed stage(s):** S1 through S9 (ambient monitoring; relevant here for the S1 phase)
**pg-boss job type name:** `STAGE_DWELL_MONITOR`

**Trigger condition:** Activated when an entry enters S1. The `TimerEngine` registers a `STAGE_DWELL_MONITOR` timer at the moment of stage entry. Warning and critical thresholds are mode-dependent (ACTIVE, IDLE, PARKED).

**S1-specific sub-behaviour — Availability staleness:** When an `AvailabilityConfiguration` record associated with this S1 entry exceeds the configured staleness window without a recall or progression event, `StageDwellMonitor` marks the configuration as stale (`isStale = true`, `stalenessAt` set). This is a phase annotation within the same `StageDwellRecord`. No separate worker runs for availability staleness — it is handled within this worker's dwell evaluation loop.

**Models read:**
- `Entry`: `currentStage`, `status`, `parkedAt`
- `StageDwellRecord`: `mode`, `warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `enteredAt`
- `AvailabilityConfiguration`: `isStale`, `stalenessAt`, `sealedAt`
- `ConfigurationEntry`: dwell warning threshold (per stage per mode), dwell critical threshold (per stage per mode), FOM escalation threshold (per stage per mode), staleness window

**Models written:**
- `StageDwellRecord`: `warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `mode`
- `AvailabilityConfiguration`: `isStale`, `stalenessAt`
- `TraceEvent`: `STAGE_DWELL.WARNING_FIRED`, `STAGE_DWELL.CRITICAL_FIRED`, `STAGE_DWELL.FOM_ESCALATED`, `STAGE_DWELL.AVAILABILITY_STALENESS_MARKED`

**Idempotency strategy:** Before emitting a warning or critical event, the worker inspects `StageDwellRecord.warningFiredAt` and `StageDwellRecord.criticalFiredAt` respectively. If the corresponding timestamp is already set for this stage and this entry, the worker skips that phase without error. Idempotency is keyed on `(entryId, stage, event_phase)`.

**Hardcoded behaviour:** Warning fires before critical. Critical fires before FOM escalation. The sequence `warn → critical → escalate` is invariant and cannot be reordered by configuration.

**Configurable parameters:** Warning threshold duration per stage per mode; critical threshold duration per stage per mode; FOM escalation threshold per stage per mode; staleness window for availability configurations — all from `ConfigurationEntry`.

**Failure behaviour:** A `StageDwellMonitor` failure does not affect the governed entry's operational state — the entry continues its lifecycle. The DLQ alert carries the entry ID and stage for operations team remediation.

---

### 7.2 Worker 16 — ProcessingLockExpiryWorker

**Worker number:** W16
**Governed stage(s):** Cross-stage — fires on any processing lock TTL expiry regardless of entry stage. Primarily encountered at S1 where inventory evaluation occurs during availability configuration.
**pg-boss job type name:** `PROCESSING_LOCK_TTL`

**Trigger condition:** Registered at lock placement (`ProcessingLockRecord` creation via `ProcessingLockService.placeLock()`). Fires unconditionally at `ProcessingLockRecord.expiresAt`. No heartbeat or renewal mechanism exists — the TTL is unconditional.

**Models read:**
- `ProcessingLockRecord`: `status`, `actorId`, `inventoryReference`, `expiresAt`

**Models written:**
- `ProcessingLockRecord`: `status → ProcessingLockStatus.EXPIRED`, `expiredAt`
- `TraceEvent`: `PROCESSING_LOCK.EXPIRED` (carries `lockId`, `actorId`, `inventoryReference`, `expiredAt`, `channel`; attributed to `ActorLevel.SYSTEM`)

**Idempotency strategy:** Before executing expiry, the worker reads `ProcessingLockRecord.status`. If `status = EXPIRED` or `status = RELEASED`, the lock is already resolved — skip. Worker logs a skip event and exits without error. Idempotency is keyed on `ProcessingLockRecord.id`.

**Hardcoded behaviour:** TTL expiry transitions `ProcessingLockRecord.status` to `ProcessingLockStatus.EXPIRED`. Expiry does not affect `InventoryClaimState` — processing locks are awareness mechanisms, not commercial holds. Silent expiry is forbidden — the transition event is always recorded. The operator expiry notification text is governance language: *"Your inventory hold has expired — please reconfirm availability before proceeding."* This text is not configurable marketing copy. Reconfirmation creates a new `ProcessingLockRecord` — this worker does not handle reconfirmation (that is `ProcessingLockService.reconfirm()`).

**Configurable parameters:** Lock TTL per channel (EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE) and per engagement type — from `ConfigurationEntry` with key `processing_lock_ttl_per_channel`. The TTL is read from `ProcessingLockRecord.ttlSeconds` at registration time; it is not re-read at fire time.

**Failure behaviour:** Standard DLQ. A failed expiry that leaves the lock in `ACTIVE` state past its TTL is a data integrity issue — the lock would appear active but be commercially meaningless. DLQ alert fires; operations team manually transitions the lock to `EXPIRED` and notifies the operator.

---

### 7.3 Worker 20 — EntryExpiryWorker

**Worker number:** W20
**Governed stage(s):** S1 (primary); also fires for parked entries with expiry configured
**pg-boss job type name:** `ENTRY_EXPIRY`

**Trigger condition:** Registered at entry creation or unparking. Fires when the configured entry expiry timer reaches its threshold without the entry progressing past S1.

**Models read:**
- `Entry`: `status`, `currentStage`, `createdAt`, `parkedAt`

**Models written:**
- `Entry`: `status → EntryStatus.EXPIRED`, `closedAt`, `closedBy = "SYSTEM"`
- `TraceEvent`: `ENTRY.EXPIRY_WARNING` (at warning threshold), `ENTRY.EXPIRED` (on state transition to EXPIRED)

**Idempotency strategy:** Before executing expiry, the worker reads `Entry.status`. If `status = EntryStatus.EXPIRED`, `EntryStatus.CANCELLED`, or `EntryStatus.CLOSED`, the entry is already in a terminal state — skip. Worker exits without error. Idempotency is keyed on `Entry.id`.

**Hardcoded behaviour:** `EntryStatus.EXPIRED` is a terminal state — it cannot be reversed by any actor at any authority level. Expiry is always a governed event with a permanent record. Silent expiry is forbidden. The transition event is always recorded in the same transaction as the status change.

**Configurable parameters:**
- `entry_expiry_threshold`: Expiry threshold duration per entry type — from `ConfigurationEntry`
- Warning threshold offset: Duration before hard expiry at which `ENTRY.EXPIRY_WARNING` fires — from `ConfigurationEntry`

**Failure behaviour:** Standard DLQ alert. Entry remains in its current state until the failure is resolved and the job is re-dispatched. Idempotency guard prevents double-expiry on retry.

---

### 7.4 Worker 7 — OTAEmailParserWorker

**Worker number:** W7
**Governed stage(s):** Cross-stage — runs continuously. Included in SIG-S1 because OTA is a declared S1 entry route and this worker is the mechanism through which OTA bookings arrive at S1. Without it, OTA entries never reach `InquiryService.create()`.
**pg-boss job type name:** `OTA_EMAIL_PARSER_POLL`

**Trigger condition:** Recurring pg-boss poll job. Polls the dedicated OTA IMAP inbox at a configurable interval (default 5 minutes). Each poll cycle is a separate job execution.

**What it does at S1:** Parses each inbound OTA email. Where AI confidence meets the configured threshold, produces an `AiDraftRecord` for human review. When approved, the resulting action feeds `InquiryService.create()` with `otaSource = true`. Where confidence is below threshold, escalates directly to human review — a staff member reads the email and manually creates the inquiry. The OTA_SOURCE flag on the resulting entry is always set regardless of whether the path was AI-assisted or manual.

**Models read:**
- `CommunicationRecord`: idempotency check by `messageId` (external message ID from IMAP provider)
- `ConfigurationEntry`: AI confidence thresholds per intent category; trust level per action category
- `PolicyRegistry`: AI Trust Level Policy parameters

**Models written:**
- `CommunicationRecord`: new record per email (`channel = EMAIL`, `direction = INBOUND`, `messageType`, `sendStatus`, `acknowledgementStatus`)
- `AiDraftRecord`: where draft is produced (`intentCategory`, `confidenceScore`, `draftContent`, `status = PENDING_REVIEW`, `reviewTtlExpiresAt`)
- `TraceEvent`: `OTA_EMAIL.RECEIVED`, `OTA_EMAIL.AI_DRAFT_CREATED`, `OTA_EMAIL.ESCALATED_TO_HUMAN`

**Idempotency strategy:** Before processing, checks whether a `CommunicationRecord` with `messageId = {external message ID}` already exists. If found, email is already ingested — skip and log. Idempotency is keyed on the external IMAP message ID.

**Hardcoded behaviour:** Every parsed email produces a `CommunicationRecord` regardless of AI classification outcome. AI confidence below threshold always escalates to human — no low-confidence draft is produced. The AI agent may not approve its own drafts — every draft requires a `HumanDecisionRecord` before the resulting action proceeds. Fallback to manual processing is always available and triggers automatically on below-threshold confidence.

**Configurable parameters:**
- `ota_email_poll_interval_seconds`: IMAP poll interval — from `ConfigurationEntry`
- AI confidence threshold per intent category — from `ConfigurationEntry`
- OTA inbox connection settings — from environment variables, not from `ConfigurationEntry`

**Policies enforced:** AI Trust Level Policy (Policy 73); AI Authority Boundary Policy (Policy 74); AI Escalation Policy (Policy 75).

**Failure behaviour:** Failed polls do not lose emails — emails remain in the IMAP inbox until the next successful poll. Repeated poll failures trigger a DLQ alert. Operations team checks the IMAP connection and re-dispatches manually.

---

## Section 8 — API Routes at S1

Each route entry includes the route table, full request DTO field definitions, and full response DTO field definitions. DTO names follow the convention `{Action}{Entity}RequestDTO` / `{Entity}ResponseDTO`.

### 8.1 Domain Group: Session and Authentication

All session routes are active at all stages. They are listed here because S1 is the first stage where a developer must implement them.

---

**POST /auth/authenticate** — Authenticate (Initial Login)

| Field | Value |
|---|---|
| Auth | `PIN` (pre-auth — JWT not required) |
| Service method | `SessionService.authenticate(pin, terminalId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError` (PIN invalid), `AppError` |

**Request — `AuthenticateRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `pin` | `string` | Required | Staff member PIN. Hashed before comparison — never stored in plaintext. |
| `terminalId` | `string` | Required | Identifier of the terminal being authenticated at. |

**Response — `SessionResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string (uuid)` | Created `SessionRecord.id`. |
| `userId` | `string (uuid)` | Authenticated `StaffUser.id`. |
| `actorLevel` | `enum: ActorLevel` | Actor level of the authenticated user. |
| `terminalId` | `string` | Terminal this session is bound to. |
| `authenticatedAt` | `string (iso-datetime)` | Session creation timestamp. |
| `jwtToken` | `string` | JWT token for subsequent authenticated requests. |

---

**POST /auth/switch** — PIN Switch

| Field | Value |
|---|---|
| Auth | `L1+` (outgoing actor's session must be active) |
| Service method | `SessionService.switchUser(outgoingActorId, incomingPin, terminalId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError` (incoming PIN invalid), `AppError` |

**Request — `PinSwitchRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `outgoingActorId` | `string (uuid)` | Required | `StaffUser.id` of the staff member stepping away. |
| `incomingPin` | `string` | Required | PIN of the staff member taking over. |
| `terminalId` | `string` | Required | Terminal identifier. |

**Response — `SessionResponseDTO`** (same shape as authenticate response, reflecting the new actor's session)

---

**POST /auth/lock** — Manual Lock

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `SessionService.manualLock(sessionId, actorId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |

**Request — `ManualLockRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | `string (uuid)` | Required | The active `SessionRecord.id` to lock. |
| `actorId` | `string (uuid)` | Required | The staff member initiating the lock. |

**Response — `SessionStatusResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string (uuid)` | Session identifier. |
| `status` | `enum: SessionStatus` | `MANUALLY_LOCKED` after this call. |
| `manuallyLockedAt` | `string (iso-datetime)` | When the lock was applied. |

---

**POST /auth/logout** — Hard Logout

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `SessionService.hardLogout(sessionId)` |
| Policies | Policy 69 — Session Management and PIN Authentication Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |

**Request — `LogoutRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | `string (uuid)` | Required | The `SessionRecord.id` to terminate. |

**Response — `SessionStatusResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string (uuid)` | Session identifier. |
| `status` | `enum: SessionStatus` | `HARD_LOGGED_OUT` after this call. |
| `hardLoggedOutAt` | `string (iso-datetime)` | When the session was terminated. |

---

### 8.2 Domain Group: Inquiries

---

**POST /inquiries** — Create Inquiry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `InquiryService.create()` |
| Policies | Policy 3 — Initial Custodian Assignment Policy; Policy 12 — Duplicate Inquiry and Entry Creation Gate Policy; Policy 15 — Guest Identity Capture Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `PolicyGateBlockedError` (duplicate detected), `MissingConfigurationError` (no custodian rule resolves), `AppError` |

**Request — `CreateInquiryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `guestProfileId` | `string (uuid)` | Required | The existing or newly created guest profile to link. |
| `sourceChannel` | `string` | Required | `DIRECT` \| `OTA` \| `CORPORATE` \| `WALK_IN` \| `AGENT`. |
| `notes` | `string?` | Optional | Initial inquiry context notes. Max 2000 characters. |

**Response — `InquiryResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Inquiry identifier. |
| `referenceNumber` | `string` | Human-readable reference (e.g., `INQ-001`). |
| `guestProfileId` | `string (uuid)` | Linked guest profile. |
| `sourceChannel` | `string` | Channel of origin. |
| `defaultCustodianId` | `string (uuid)` | Current assigned custodian. |
| `notes` | `string?` | Inquiry notes. |
| `derivedStatus` | `string` | Computed aggregate of child entry states. Not stored — computed at read time. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `updatedAt` | `string (iso-datetime)` | Last update timestamp. |
| `createdBy` | `string (uuid)` | Actor who created the inquiry. |

---

**GET /inquiries** — List Inquiries

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `InquiryService.list()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes (cursor-based) |

**Request — `ListInquiriesRequestDTO`** *(query parameters)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Opaque pagination cursor from prior response `meta.nextCursor`. Absent on first page. |
| `limit` | `integer?` | Optional | Records per page. Default 20, maximum 100. |
| `status` | `string?` | Optional | Filter by derived inquiry status. |
| `custodianId` | `string (uuid)?` | Optional | Filter by assigned custodian. |
| `guestProfileId` | `string (uuid)?` | Optional | Filter by guest profile. |

**Response — `InquiryListResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `items` | `array: InquiryResponseDTO` | Page of inquiry records. |
| `meta.nextCursor` | `string?` | Cursor for the next page. Null if last page. |
| `meta.total` | `integer` | Total matching records. |

---

**GET /inquiries/:id** — Get Inquiry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `InquiryService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Request — `GetInquiryRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `Inquiry.id` — extracted from path. |

**Response — `InquiryResponseDTO`** (same shape as Create response)

---

**POST /inquiries/:id/park** — Park Inquiry (Inquiry-Level Park)

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `InquiryService.park()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

**Request — `ParkInquiryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |
| `reason` | `string` | Required | Reason for parking. Max 500 characters. |

**Response — `InquiryStatusResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Inquiry identifier. |
| `referenceNumber` | `string` | Inquiry reference. |
| `derivedStatus` | `string` | Updated computed status. |
| `parkedAt` | `string (iso-datetime)?` | When inquiry was parked. |
| `parkedBy` | `string (uuid)?` | Actor who parked. |

---

**POST /inquiries/:id/unpark** — Unpark Inquiry (Inquiry-Level Unpark)

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `InquiryService.unpark()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

**Request — `UnparkInquiryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |

**Response — `InquiryStatusResponseDTO`** (same shape as Park response; `parkedAt` and `parkedBy` will be null after unpark)

---

**POST /inquiries/:id/assign-custodian** — Assign Custodian

| Field | Value |
|---|---|
| Auth | `L1+` (L2+ for high-value entries per Policy 4) |
| Service method | `InquiryService.assignCustodian()` |
| Policies | Policy 3 — Initial Custodian Assignment Policy; Policy 4 — Custodian Reassignment Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |

**Request — `AssignCustodianRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |
| `newCustodianId` | `string (uuid)` | Required | `StaffUser.id` of the staff member to assign. |

**Response — `InquiryResponseDTO`** (same shape as Create response, with updated `defaultCustodianId`)

---

### 8.3 Domain Group: Entries

---

**POST /entries** — Create Entry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `EntryService.create()` |
| Policies | Policy 15 — Guest Identity Capture Policy; Policy 64 — Group Detection Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError` (inquiry not found), `PolicyGateBlockedError`, `AppError` |

**Request — `CreateEntryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `inquiryId` | `string (uuid)` | Required | The inquiry this entry belongs to. |
| `useType` | `enum: EntryUseType` | Required | `ACCOMMODATION` \| `CONFERENCE` \| `APARTMENT` \| `CATERING` \| `GROUP`. Immutable after creation. |
| `checkInDate` | `string (iso-date)?` | Optional | Provisional check-in. Required for ACCOMMODATION at S1 exit. |
| `checkOutDate` | `string (iso-date)?` | Optional | Provisional check-out. Must be after `checkInDate` if provided. |
| `guestCount` | `integer?` | Optional | Provisional guest count. Minimum 1 if provided. |
| `otaSource` | `boolean?` | Optional | Set `true` if booking originates from OTA channel. Immutable once set. Defaults to `false`. |

**Response — `EntryResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Entry identifier. |
| `inquiryId` | `string (uuid)` | Parent inquiry. |
| `segmentNumber` | `integer` | Current segment number (1 for new entries). |
| `useType` | `enum: EntryUseType` | Use type — immutable. |
| `status` | `enum: EntryStatus` | `ACTIVE` at creation. |
| `currentStage` | `enum: Stage` | `S1` at creation. |
| `checkInDate` | `string (iso-date)?` | Provisional check-in date. |
| `checkOutDate` | `string (iso-date)?` | Provisional check-out date. |
| `guestCount` | `integer?` | Provisional guest count. |
| `otaSource` | `boolean` | OTA source flag. |
| `parkedAt` | `string (iso-datetime)?` | Populated when entry is parked. |
| `parkedBy` | `string (uuid)?` | Actor who parked. |
| `version` | `integer` | Optimistic lock version. Include in subsequent update requests. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `createdBy` | `string (uuid)` | Creating actor. |

---

**GET /entries** — List Entries

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `EntryService.list()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `AppError` |
| Pagination | Yes (cursor-based) |

**Request — `ListEntriesRequestDTO`** *(query parameters)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `inquiryId` | `string (uuid)?` | Optional | Filter by parent inquiry. |
| `stage` | `enum: Stage?` | Optional | Filter by current stage. |
| `status` | `enum: EntryStatus?` | Optional | Filter by status. |
| `useType` | `enum: EntryUseType?` | Optional | Filter by use type. |
| `custodianId` | `string (uuid)?` | Optional | Filter by assigned custodian. |

**Response — `EntryListResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `items` | `array: EntryResponseDTO` | Page of entry records. |
| `meta.nextCursor` | `string?` | Cursor for next page. |
| `meta.total` | `integer` | Total matching records. |

---

**GET /entries/:id** — Get Entry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `EntryService.get()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Request — `GetEntryRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `Entry.id`. |

**Response — `EntryDetailResponseDTO`** (all `EntryResponseDTO` fields plus):

| Field | Type | Notes |
|---|---|---|
| `segments` | `array` | All segments: `{ id, segmentNumber, stage, startedAt, sealedAt }`. |
| `availabilityConfigurations` | `array` | All configurations: `{ id, isStale, stalenessAt, sealedAt, optionSelected }`. |
| `currentSegment` | `object` | The active segment record. |

---

**POST /entries/:id/progress-stage** — Progress Stage (S1→S2 or S1→S3)

| Field | Value |
|---|---|
| Auth | `L1+` (L2+ for re-entry from S4+ per state machine authority) |
| Service method | `EntryService.progressStage()` |
| Policies | State machine guard conditions evaluated within the transition function |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |

**Request — `ProgressStageRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `targetStage` | `enum: Stage` | Required | Target stage: `S2` or `S3` (S2 auto-fulfilled). |
| `transitionData` | `object?` | Optional | Additional data required for the transition (e.g., selected configuration ID for S1→S2). |
| `version` | `integer` | Required | Current `Entry.version` — optimistic lock guard. |

Note: `StageGateBlockedError` response body includes `blockedCondition` (the specific unsatisfied guard), `stage`, and `overrideAvailable` (boolean).

**Response — `EntryResponseDTO`** (updated stage reflected)

---

**POST /entries/:id/park** — Park Entry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `EntryService.park()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

**Request — `ParkEntryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `reason` | `string` | Required | Reason for parking. Max 500 characters. |

**Response — `EntryStatusResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Entry identifier. |
| `status` | `enum: EntryStatus` | `PARKED` after this call. |
| `parkedAt` | `string (iso-datetime)` | When the park was applied. |
| `parkedBy` | `string (uuid)` | Actor who placed the park. |

---

**POST /entries/:id/unpark** — Unpark Entry

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `EntryService.unpark()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

**Request — `UnparkEntryRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |

**Response — `EntryStatusResponseDTO`** (`status` will be `ACTIVE`; `parkedAt` and `parkedBy` cleared)

---

**POST /entries/:id/reassign-custodian** — Reassign Custodian on Entry

| Field | Value |
|---|---|
| Auth | `L1+` (L2+ for high-value entries per Policy 4) |
| Service method | `EntryService.reassignCustodian()` |
| Policies | Policy 4 — Custodian Reassignment Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |

**Request — `ReassignCustodianRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `newCustodianId` | `string (uuid)` | Required | `StaffUser.id` of the incoming custodian. |
| `reason` | `string` | Required | Mandatory reason for reassignment. |

**Response — `EntryResponseDTO`** (updated with new custodian reflected in the related inquiry)

---

### 8.4 Domain Group: Availability

---

**POST /availability/search** — Availability Search

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `AvailabilityService.query()` |
| Policies | Policy 1 — Availability Query Policy; Policy 2 — DEFICIENT Condition Surface Policy; Policy 14 — Shadow Inventory Visibility Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError`, `AppError` |

**Request — `AvailabilitySearchRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | The entry for which availability is being searched. |
| `checkInDate` | `string (iso-date)` | Required | Requested check-in date. |
| `checkOutDate` | `string (iso-date)` | Required | Requested check-out. Must be after `checkInDate`. |
| `guestCount` | `integer` | Required | Number of guests. Minimum 1. |
| `useType` | `enum: EntryUseType` | Required | Use type of the entry. |
| `roomTypeId` | `string (uuid)?` | Optional | Filter to a specific room type. Null returns all types. |
| `spaceId` | `string (uuid)?` | Optional | Space identifier for CONFERENCE or CATERING use type. |
| `deficientAcknowledgements` | `array?` | Optional | `[{ deficientConditionId: string (uuid), acknowledged: boolean }]`. Records explicit acknowledgement of a known DEFICIENT condition on a candidate room. Required before a DEFICIENT room may be included in the preferred configuration. |

**Response — `AvailabilityResultResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `configurationId` | `string (uuid)` | The `AvailabilityConfiguration.id` created for this search. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `queriedAt` | `string (iso-datetime)` | When the search was executed. |
| `isStale` | `boolean` | Always `false` for a new search. |
| `results` | `array` | Available inventory options. Each item: `{ inventoryId: string, inventoryType: 'ROOM' \| 'SPACE', roomNumber?: string, claimState: enum:InventoryClaimState, isDeficient: boolean, deficientCategory?: enum:DeficientConditionCategory, deficientDescription?: string, pricingIndicative: { rateAmount: decimal, currency: string, taxModel: enum:TaxModel } }` |
| `unavailableRooms` | `array` | Rooms that could not be offered: `{ inventoryId, unavailabilityReason: 'CLAIMED' \| 'MAINTENANCE_CONFLICT' \| 'BLOCKED' \| 'PHYSICAL_NOT_READY' }` |
| `maintenanceConflicts` | `array` | Rooms with maintenance deadlines within requested range: `{ inventoryId, maintenanceDeadline: iso-datetime }` |

---

**GET /availability/configurations/:id** — Get Availability Configuration

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `AvailabilityService.getConfiguration()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Request — `GetAvailabilityConfigRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `AvailabilityConfiguration.id`. |

**Response — `AvailabilityConfigResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Configuration identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `searchCriteria` | `object` | The search parameters captured at creation. |
| `optionSelected` | `object?` | The inventory option selected, if any. Null if no preferred configuration set yet. |
| `isStale` | `boolean` | Whether staleness has been detected. |
| `stalenessAt` | `string (iso-datetime)?` | When staleness was detected. |
| `deficientAcknowledgements` | `array?` | Recorded DEFICIENT acknowledgements for this configuration. |
| `sealedAt` | `string (iso-datetime)?` | When sealed on S1 exit. Null during S1. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

**POST /availability/configurations/:id/recall** — Recall Stale Availability Configuration

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `AvailabilityService.recallConfiguration()` |
| Policies | Policy 1 — Availability Query Policy; Policy 2 — DEFICIENT Condition Surface Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `MissingConfigurationError`, `AppError` |

**Request — `RecallAvailabilityConfigRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `AvailabilityConfiguration.id` — must be a stale configuration (`isStale = true`). |

**Response — `AvailabilityResultResponseDTO`** (same shape as search response; `isStale` will be `true`; `isRevalidationRequired` field indicates revalidation was run)

---

**PATCH /availability/configurations/:id/select** — Select Preferred Configuration

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `AvailabilityService.selectOption()` |
| Policies | None — validation enforced directly by service method |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Request — `SelectAvailabilityConfigRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AvailabilityConfiguration.id`. |
| `selectedOption` | `object` | Required | The inventory option being selected from the configuration's result set. Must match an option returned in the original search results. |
| `deficientAcknowledgements` | `array?` | Conditional | Required if selected room carries an active `DeficientConditionRecord`. `[{ deficientConditionId: string (uuid), acknowledged: boolean }]`. |

**Response — `AvailabilityConfigResponseDTO`** (same shape as GET response; `optionSelected` now populated)

---

### 8.5 Domain Group: Processing Locks

---

**POST /processing-locks** — Place Processing Lock

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `ProcessingLockService.placeLock()` |
| Policies | Policy 71 — Processing Lock TTL Policy; Policy 72 — Processing Lock Priority Queue Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `MissingConfigurationError` (TTL not configured for channel), `AppError` |

**Request — `PlaceProcessingLockRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `inventoryReference` | `string (uuid)` | Required | `Room.id` or `Space.id` of the inventory being locked. |
| `channel` | `string` | Required | `EMAIL_AI` \| `WHATSAPP_AI` \| `FRONT_DESK` \| `PHONE`. |
| `entryContext` | `object?` | Optional | `{ entryId: string (uuid), segmentId?: string (uuid) }` — links the lock to an active entry workflow. |

Note: If a prior lock exists on the same inventory, the service places the new lock and returns `200 OK` with `meta.priorityNotice` populated. The second actor is not blocked.

**Response — `ProcessingLockResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Processing lock record identifier. |
| `actorId` | `string (uuid)` | Actor who placed the lock. |
| `channel` | `string` | Channel processor. |
| `inventoryReference` | `string (uuid)` | Locked inventory identifier. |
| `placedAt` | `string (iso-datetime)` | When the lock was placed. |
| `ttlSeconds` | `integer` | TTL in seconds. |
| `expiresAt` | `string (iso-datetime)` | Hard expiry time. No heartbeat or renewal. |
| `status` | `enum: ProcessingLockStatus` | `ACTIVE` at creation. |
| `revalidationCount` | `integer` | Number of reconfirmations. `0` at creation. |

---

**POST /processing-locks/:id/reconfirm** — Reconfirm (Triggers Revalidation)

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `ProcessingLockService.reconfirm()` |
| Policies | Policy 71 — Processing Lock TTL Policy; Policy 72 — Processing Lock Priority Queue Policy; Policy 1 — Availability Query Policy; Policy 19 — Rate Plan Resolution Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (lock not EXPIRED), `MissingConfigurationError`, `AppError` |

**Request — `ReconfirmProcessingLockRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: the EXPIRED `ProcessingLockRecord.id`. Must be in `EXPIRED` status — `ACTIVE` or `RELEASED` locks cannot be reconfirmed. |

**Response — `ProcessingLockReconfirmResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `newLock` | `object: ProcessingLockResponseDTO` | The newly created lock record with new TTL and incremented `revalidationCount`. |
| `previousLockId` | `string (uuid)` | The expired lock's ID — preserved, not deleted. |
| `revalidationDelta` | `object` | What changed during the TTL window: `{ availabilityChanged: boolean, deficientStatusChanged: boolean, pricingChanged: boolean, availabilityDelta?: object, deficientDelta?: object, pricingDelta?: object }`. Fields mirror `RevalidationDeltaRecord` directly — no transformation required at the service layer. |

---

**GET /processing-locks/:id** — Check Processing Lock Status

| Field | Value |
|---|---|
| Auth | `L1+` |
| Service method | `ProcessingLockService.status()` |
| Policies | None |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `AppError` |

**Request — `GetProcessingLockRequestDTO`** *(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `ProcessingLockRecord.id`. |

**Response — `ProcessingLockResponseDTO`** (same shape as Place response; `expiredAt` or `releasedAt` populated if no longer ACTIVE)

---

## Section 9 — Configuration Keys at S1

The following configuration keys are read at runtime during S1 operations. All values are read from `ConfigurationEntry` using a date-range query that returns the row active at the time of the operation. Key names follow the dotted notation convention established in Part 2-REV1 §2.17.3, which is the canonical key registry. Keys marked as "Part 2 backfill" are pending addition to Part 2-REV1 §2.17.3 in the coordinated backfill session.

> **Note:** This section covers `ConfigurationEntry` keys read during S1 runtime operations. The complete S1 readiness picture — including registry surfaces, staff configuration, room and space inventory, rate plans, and all other surfaces that must be configured before S1 is operational — is specified in Part 12 §12.3.1 (`S1_READINESS`). A developer seeding a new environment should consult Part 12 §12.3.1 as the authoritative readiness checklist.

| Config Key | Type | Default | Read By | Missing Behaviour |
|---|---|---|---|---|
| `ownership.assignmentRules` | `Json` (array of rule objects) | None — must be configured | `InquiryService.create()` via Policy 3 | `MissingConfigurationError` raised; custodian cannot be assigned; S1 intake is blocked | *(Part 2 backfill)* |
| `expiry.s1.defaultTtlSeconds` | `Json` (duration per entry type) | None — must be configured | `EntryExpiryWorker` (W20) at job registration | If absent, `TimerEngine` cannot schedule the expiry job; entry sits without expiry governance — ungoverned entries accumulate indefinitely |
| `processingLock.ttl.perChannel` | `Json` (TTL in seconds per channel: EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE) | None — all four channel entries must be present | `ProcessingLockService.placeLock()` | `MissingConfigurationError` raised for the relevant channel; processing lock cannot be placed for that channel | *(Part 2 backfill)* |
| `availability.shadowInventory.visibilityRules` | `Json` (visibility rules per actor level and agent tier) | None — must be configured | `AvailabilityService.query()` via `AvailabilityEngine` input | `MissingConfigurationError`; availability search cannot execute without visibility rules | *(Part 2 backfill)* |
| `availability.bookablePhysicalStates` | `Json` (array of `InventoryClaimState` values) | Configurable floor exists (BLOCKED and MAINTENANCE with deadline in range are always conflicts) | `AvailabilityService.query()` | If absent, service uses the hardcoded floor only; configurable expansion of bookable states is unavailable | *(Part 2 backfill)* |
| `availability.staleness.ttlSeconds` | `Int` (seconds) | None — must be configured | `StageDwellMonitor` (W1) | If absent, staleness detection cannot fire; configurations remain perpetually fresh — staleness governance disabled for S1 entries |
| `stageDwell.thresholds` | `Json` (composite — all stages × all dwell modes × warning/critical/escalation thresholds in seconds) | None — must be configured; all nine stages and all three dwell modes must be present | `StageDwellMonitor` (W1) | If absent or incomplete, the worker cannot resolve thresholds for the uncovered stage/mode combination; warning, critical, and FOM escalation phases cannot fire for that combination — entries in those states accumulate without dwell governance | *(Part 2 backfill)* |
| `deficientCondition.categories` | `Json` (array of category codes and labels) | At least one must be active | `AvailabilityService.query()` (Policy 2 annotation step) | `MissingConfigurationError`; DEFICIENT condition records cannot be raised; DEFICIENT annotation cannot categorise results | *(Part 2 backfill)* |
| `ota.sourceFlagConfig` | `Json` (source identifier to OTA_SOURCE flag mappings) | None — must be configured | `EntryService.create()` via Policy 15 | If absent, OTA source classification cannot execute; OTA_SOURCE flag cannot be reliably set at intake | *(Part 2 backfill)* |
| Session thresholds | Managed via `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` per role — not a `ConfigurationEntry` key. Corresponding Part 2-REV1 keys: `session.idle.fom.thresholdSeconds`, `session.idle.frontDesk.thresholdSeconds`, `session.hardLogout.fom.thresholdSeconds`, `session.hardLogout.frontDesk.thresholdSeconds` | None — must be configured per role | `SessionService` (Policy 69) | Terminals operate without governed session control; session boundaries are unenforced |
| `availability.walkIn.ratePlanId` | `String` (rate plan ID designated as walk-in) | None — must be configured if walk-in is enabled | `AvailabilityService.query()` / indicative pricing for walk-in path | Walk-in rate presentation unavailable; walk-in guests cannot receive indicative rate at S1 | *(Part 2 backfill)* |

---

## Section 10 — Acceptance Criteria

The following are testable pass/fail assertions for S1. All must pass for S1 to be declared correctly implemented. These are derived from the acceptance gate structure in Part 13.

---

### 10.1 Schema Correctness

**AC-S1-001:** A migration from scratch produces a database containing the following tables with the following columns as defined in Part 2: `inquiries`, `entries`, `segments`, `availability_configurations`, `rooms`, `spaces`, `processing_lock_records`, `stage_dwell_records`, `guest_profiles`, `trace_events`, `configuration_entries`. **PASS** = migration runs clean with zero errors and all columns present. **FAIL** = migration error or missing column.

**AC-S1-002:** `Entry.otaSource` defaults to `false` and is set immutably at creation. A test that creates an entry with `otaSource = true`, then attempts to update `Entry.otaSource` to `false` after creation, must be rejected by the service layer. **PASS** = update rejected. **FAIL** = update succeeds.

**AC-S1-003:** `Entry.useType` is set at creation and immutable. A test that attempts to update `Entry.useType` after creation must be rejected. **PASS** = update rejected. **FAIL** = update succeeds.

**AC-S1-004:** `AvailabilityConfiguration.sealedAt` is null during S1 and is populated in the same transaction as the S1→S2 stage transition on the linked entry. **PASS** = both updates occur atomically. **FAIL** = either update is absent or they occur in separate transactions.

**AC-S1-005:** `TraceEvent` records are append-only. A test that attempts to UPDATE or DELETE any row in `trace_events` must fail at the database layer. **PASS** = operation rejected. **FAIL** = operation succeeds.

---

### 10.2 Policy Enforcement

**AC-S1-006:** Policy 12 (Duplicate Detection) runs on every call to `InquiryService.create()` regardless of call path (HTTP, worker, direct). A direct call to `InquiryService.create()` bypassing the controller with a known-duplicate input must return a `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = inquiry created without policy evaluation.

**AC-S1-007:** Policy 3 (Initial Custodian Assignment) runs immediately after inquiry creation. An inquiry must never exist in the database without a `defaultCustodianId` value. A test that creates an inquiry with no matching ownership assignment rule configured must return `MissingConfigurationError` and must not persist the inquiry. **PASS** = no partial inquiry created; error returned. **FAIL** = inquiry persisted without custodian.

**AC-S1-008:** Policy 2 (DEFICIENT Condition Surface) annotates DEFICIENT flags on every availability search result where a room's `isDeficient = true`. The annotation is present regardless of actor level. A test that searches for a room with `isDeficient = true` at admin level must still return the DEFICIENT annotation. **PASS** = annotation present for all actor levels. **FAIL** = annotation absent for any actor level.

**AC-S1-009:** An unacknowledged DEFICIENT flag on the preferred configuration's room blocks S1 exit. A test that attempts `EntryService.progressStage()` from S1 to S2 with a preferred configuration containing a DEFICIENT room and empty `deficientAcknowledgements` must raise `StageGateBlockedError`. **PASS** = transition blocked. **FAIL** = transition succeeds.

**AC-S1-010:** `EntryStatus.EXPIRED` is terminal and irreversible. A test that calls `EntryService.unpark()` or `EntryService.progressStage()` on an entry with `status = EXPIRED` must raise `StateTransitionError`. **PASS** = error returned. **FAIL** = operation succeeds.

---

### 10.3 Engine Behaviour

**AC-S1-011:** `AvailabilityEngine.query()` is testable in isolation — no database connection, no service context, no running infrastructure. A unit test that constructs an `AvailabilityInput` directly and calls the engine must produce an `AvailabilityResult`. **PASS** = test executes without infrastructure. **FAIL** = engine requires service container or DB to run.

**AC-S1-012:** A room with `isDeficient = true` in the `AvailabilityInput.rooms` array always appears in `AvailabilityResult.deficientRooms`, never in `availableRooms`, regardless of what the calling service passes as `bookablePhysicalStates`. **PASS** = deficient room in deficientRooms only. **FAIL** = deficient room appears in availableRooms under any configuration.

**AC-S1-013:** `AvailabilityEngine.query()` with identical inputs always produces identical output (determinism). A test that calls the engine twice with the same input must produce the same result both times. **PASS** = outputs are identical. **FAIL** = outputs differ.

**AC-S1-014:** `PricingPipelineEngine.resolve()` rate plan priority order (individual → promotional → tier → channel → rack) cannot be altered by any configuration parameter. A test that supplies all five rate plan types as eligible simultaneously must always select the individual rate plan. **PASS** = individual selected regardless of other inputs. **FAIL** = any configuration variation changes the selection order.

---

### 10.4 Worker Registration

**AC-S1-015:** `EntryExpiryWorker` (W20) is registered with pg-boss for the `ENTRY_EXPIRY` job type. A test that creates an entry and inspects the pg-boss job queue must find a scheduled `ENTRY_EXPIRY` job for that entry's ID. **PASS** = job found in queue. **FAIL** = job absent.

**AC-S1-016:** `ProcessingLockExpiryWorker` (W16) fires on the `PROCESSING_LOCK_TTL` job type. A test that places a processing lock, advances time past the TTL, and runs the worker must result in `ProcessingLockRecord.status = EXPIRED` and a `PROCESSING_LOCK.EXPIRED` trace event. **PASS** = status EXPIRED and trace event present. **FAIL** = either absent.

**AC-S1-017:** `StageDwellMonitor` (W1) idempotency: running the worker twice for the same `(entryId, stage, event_phase)` with the first run having completed successfully produces no duplicate trace events. `StageDwellRecord.warningFiredAt` is set only once. **PASS** = no duplicate events; timestamp set once. **FAIL** = duplicate events or multiple timestamps.

**AC-S1-018:** `EntryExpiryWorker` (W20) is idempotent: running the worker twice for the same `Entry.id` where the first run set `status = EXPIRED` must produce no state change and no duplicate trace event on the second run. **PASS** = second run skips cleanly. **FAIL** = second run produces an additional state change or trace event.

---

### 10.5 Route Availability

**AC-S1-019:** All routes listed in Section 8 respond with typed error envelopes on failure — no raw objects, naked arrays, or unstructured error messages. A test that triggers each error condition (ValidationError, NotFoundError, PolicyGateBlockedError, etc.) on each S1 route must receive a response conforming to the standard error envelope defined in Part 9 §9.3.1. **PASS** = all error responses conform to envelope. **FAIL** = any route returns unstructured error.

**AC-S1-020:** `POST /inquiries` with a confirmed-duplicate guest identity returns `PolicyGateBlockedError` with the conflicting record reference in the error context. **PASS** = error with context. **FAIL** = inquiry created or error without context.

**AC-S1-021:** `POST /processing-locks` with a second actor targeting the same inventory configuration as an existing active lock returns `200 OK` with `meta.priorityNotice` populated — not an error. **PASS** = second lock created, priorityNotice present. **FAIL** = error returned or priorityNotice absent.

---

### 10.6 Configuration Completeness

**AC-S1-022:** All surfaces listed in the S1 Readiness table (Section 9 and Part 12 §12.3.1) are present before S1 is declared operational. A system with any missing surface from the S1_READINESS group must return `MissingConfigurationError` on the relevant S1 operation. **PASS** = every missing surface produces a typed configuration error. **FAIL** = any missing surface is silently swallowed or causes an unhandled exception.

**AC-S1-023:** `ConfigurationEntry` is read with a date-range query (active at current timestamp) — not a simple `findFirst` by key only. A test that seeds two `ConfigurationEntry` rows for the same `configKey` with non-overlapping date ranges and queries at a specific timestamp must return only the row active at that timestamp. **PASS** = correct row returned. **FAIL** = wrong row returned or both rows returned.

---

### 10.7 Forbidden Action Prevention

**AC-S1-024:** No `Folio` record may be created for an entry in `(ACTIVE, S1)`. A test that calls `FolioService.createProvisionalFolio()` for an entry with `currentStage = S1` must be rejected with a `StageGateBlockedError` or equivalent prohibition. **PASS** = creation rejected. **FAIL** = folio created.

**AC-S1-025:** No `SpeculativeHold` or `CommittedHold` record may be created for an entry in `(ACTIVE, S1)`. A test that calls `HoldService.placeSpeculativeHold()` for an entry with `currentStage = S1` must be rejected. **PASS** = creation rejected. **FAIL** = hold created.

**AC-S1-026:** No `PaymentRecord` may be created at S1. A test that calls any payment recording service method for an entry with `currentStage = S1` must be rejected. **PASS** = creation rejected. **FAIL** = payment record created.

**AC-S1-027:** S1→S2 transition is blocked when no `AvailabilityConfiguration` has been created for the entry (no availability search executed). A test that calls `EntryService.progressStage()` on a freshly created entry with no `AvailabilityConfiguration` records must raise `StageGateBlockedError`. **PASS** = transition blocked. **FAIL** = transition succeeds.

**AC-S1-028:** S1→S2 transition is blocked when the selected configuration is stale (`isStale = true`). A test that marks the preferred configuration as stale and then calls `EntryService.progressStage()` must raise `StageGateBlockedError`. **PASS** = transition blocked. **FAIL** = transition succeeds.

---

### 10.8 S3→S1 Re-Entry Behaviour

**AC-S1-029:** On S3→S1 back-flow: the prior `CommittedHold` transitions to `RELEASED` state in the same transaction as the segment seal. A test that executes `EntryService.createSegment()` with S3→S1 re-entry and inspects the prior hold must find `CommittedHold.state = RELEASED`. No `COMMITTED_HELD` inventory remains from the sealed segment. **PASS** = hold RELEASED in same transaction. **FAIL** = hold remains PLACED or release occurs in a separate transaction.

**AC-S1-030:** On S3→S1 back-flow: all `PROVISIONAL` and `DISPATCHED` invoices on the Entry-level folio transition to `SUPERSEDED` state in the same transaction as the segment seal. **PASS** = all matched invoices in SUPERSEDED state. **FAIL** = any matched invoice remains in PROVISIONAL or DISPATCHED state.

**AC-S1-031:** On S3→S1 back-flow: a `HOLD.RELEASED_ON_REENTRY` TraceEvent is emitted with `releaseReason: REENTRY_S3_TO_S1` in the same transaction. **PASS** = TraceEvent present with correct releaseReason. **FAIL** = TraceEvent absent or wrong releaseReason.

**AC-S1-032:** On S3→S1 back-flow: an `INVOICE.SUPERSEDED` TraceEvent is emitted per superseded invoice. **PASS** = one TraceEvent per invoice with correct payload. **FAIL** = missing TraceEvent for any superseded invoice.

**AC-S1-033:** On S3→S1 back-flow: W22 (`ACKNOWLEDGEMENT_WINDOW`) and W34 (`ADVANCE_PAYMENT_FOLLOW_UP`) timers for superseded invoices are cancelled in the same transaction as the segment seal. **PASS** = timers cancelled. **FAIL** = any timer remains active after segment seal.

**AC-S1-034:** On S3→S1 back-flow: a new `AvailabilityService.query()` search runs against clean inventory — the prior hold does not appear in `COMMITTED_HELD` state. A test that executes S3→S1 re-entry and then calls `AvailabilityService.query()` for the same room must find the room in `FREE` state. **PASS** = room available as FREE. **FAIL** = room appears as COMMITTED_HELD.

**AC-S1-035:** On S3→S1 re-entry: `FolioService.getOrCreate()` at the new S3 passage returns the existing Entry-level folio — does not create a new folio. A test that executes S1→S2→S3→S1→S2→S3 and inspects folio records must find exactly one provisional folio for the entry. **PASS** = single folio. **FAIL** = multiple folios.

**AC-S1-036:** On S3→S1 re-entry: Entry-level folio `PaymentRecord` entries from prior segments are visible and count toward the advance payment threshold on the new S3 passage. A test that records a payment in the first S3 passage, executes S3→S1→S2→S3 re-entry, and inspects `FolioService.getOrCreate()` output must find the prior payment record visible on the folio. **PASS** = prior payment visible. **FAIL** = prior payment absent or on a different folio.

---

*SIG-S1 v1.2 — DRAFT*
*Prepared by: Claude (AI Architectural Partner)*
*Derived from DEV-SPEC-001 Parts 2, 3, 4, 5, 6, 8, 9, 12, 13 (REV1/REV2/REV3 where applicable) — Canon v2.5*
*S3→S1 re-entry additions per MOM-ARCH-2026-020 and SIG-S5-PRE-007*
