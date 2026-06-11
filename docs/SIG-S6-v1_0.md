# LEGPHEL PMS — Stage Implementation Guideline
## S6: Check-In & Stay/Event Initiation

**Document ID:** SIG-S6
**Version:** 1.0
**Derived from:** DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)
**Prior SIGs referenced:** SIG-S5 v1.0
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT — Pending Architect confirmation
**Nothing in this document is locked until the Architect confirms.**

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 14 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | Initial generation. SIG-S6-COR-001 surfaced: `VIPArrivalNotificationEvent` Prisma model absent from Part 2 REV2-FINAL — schema derived from Part 6 REV3 trace event catalogue and Canon §47.10; Part 2 backfill required. SIG-S6-COR-002 surfaced: `FolioService.convertToLive()` has no standalone method specification in Part 6 REV3; naming inconsistency with `activateBillingModel()` in FolioService §6.5.4; contract derived from CheckInService §6.5.20 references, Part 3 folio state machine, and Part 2 Folio model; Part 6 backfill required. |

---

## Deliberation Register

| ID | Item | Ruling | Recorded |
|---|---|---|---|
| D-SIG-S6-001 | VIPArrivalNotificationEvent schema gap — mid-session derivation vs. Part 2 backfill first | Mid-session derivation accepted. SIG-S6-COR-001 registered. MCL backfill queued. | 14 Apr 2026 |
| D-SIG-S6-002 | FolioService.convertToLive() absence — mid-session derivation acceptable | Mid-session derivation accepted. SIG-S6-COR-002 registered. MCL backfill queued. | 14 Apr 2026 |
| D-SIG-S6-003 | Walk-in path S5 auto-fulfilment scope — Architect override vs. Canon derivation | No Architect override. Canon §47.3 derivation is the correct path. | 14 Apr 2026 |

---

## Session Findings Register

| ID | Type | Description | Status |
|---|---|---|---|
| SIG-S6-COR-001 | NEW-CONTENT | `VIPArrivalNotificationEvent` Prisma model absent from Part 2 REV2-FINAL. Model is required by Part 13 acceptance gates and referenced in the stage-to-record matrix as created at S6 for VIP-tier guests. No `model VIPArrivalNotificationEvent { ... }` block exists in the schema. Schema derived from Part 6 REV3 trace event catalogue (`VIP_ARRIVAL_NOTIFICATION_ISSUED`) and Canon §47.10 records affected section. SIG-S6 §2.4 carries the derived schema. Part 2 backfill required. | PENDING — Part 2 backfill |
| SIG-S6-COR-002 | NEW-CONTENT | `FolioService.convertToLive()` has no standalone method specification in Part 6 REV3. FolioService §6.5.4 uses the name `activateBillingModel()` while CheckInService §6.5.20 and Policy 31 use `convertToLive()`. The canonical name is `convertToLive()` per Policy 31 enforcement point declaration. Contract derived from CheckInService §6.5.20 references, Part 3 §3.3 folio state machine, and Part 2 Folio model fields. SIG-S6 §6.2 carries the full derived method specification. Part 6 backfill required. | PENDING — Part 6 backfill |

---

## Source Confirmation Table

| # | Source | File | Key Sections Read |
|---|---|---|---|
| 1 | Prior SIG S5 v1.0 | SIG-S5-v1_0.md | Full — §1.4 S5 starting state; §1.5 exit conditions; §2 all models; §3 state machine; §6 services; §7 workers; §9 config keys; §10 acceptance criteria |
| 2 | Master Correction Log v1.8 | MASTER-CORRECTION-LOG-v1_8.md | Section 5 — all PENDING items; MC-010, MC-011, MC-013, SIG-S4-COR-005, SIG-S4-COR-006 confirmed PENDING, absorbed as positive assertions |
| 3 | System Overview | DEV-SPEC-001-Part0.md | §0.1–§0.8 full |
| 4 | S6 Stage Charter | Canon_Block7_S5_S6_REV2_2.md | §47.1–§47.19 full; use type variations (Conference S6, Apartment S6, Catering S6) |
| 5 | Canon Matrices | Canon_Block11_Matrices_Governance_Appendices_REV2_2.md | §72 S6 policy column; §73 S6 config column; §74 S6 record column; §75 H2 and H3 handoff matrix rows; §76 S6 timer/worker rows; §76A S6 transition rows; §79 S6 readiness map |
| 6 | Schema | DEV-SPEC-001-Part2-REV2-FINAL.md | Full — all S6 models confirmed; VIPArrivalNotificationEvent confirmed absent (SIG-S6-COR-001); FolioService.convertToLive() absence confirmed (SIG-S6-COR-002) |
| 7 | State Machine | DEV-SPEC-001-Part3.md | §3.2 Entry; §3.3 Folio; §3.6 Inventory Claim; §3.7 Room Physical State; §3.9 Handoff |
| 8 | Engines | DEV-SPEC-001-Part4.md | §4.10 TimerEngine; §4.11 ReEntryConsequenceEngine |
| 9 | Policies | DEV-SPEC-001-Part5-REV2.md | Policies 16, 17, 29, 31, 35, 49, 52, 63, 69, 71 — all S6-active per §72 S6 column |
| 10 | Services | DEV-SPEC-001-Part6-REV3.md | §6.5.4 FolioService; §6.5.20 CheckInService; §6.5.21 CheckOutService (context); §6.5.8 HandoffService; §6.5.19 RoomAssignmentService; §6.5.3 EntryService; VIP_ARRIVAL_NOTIFICATION_ISSUED trace event confirmed |
| 11 | Workers | DEV-SPEC-001-Part8.md | W1 StageDwellMonitor; W23 RoomReadinessSLAWorker; W25 HandoffAcceptanceWorker |
| 12 | Routes | DEV-SPEC-001-Part9-REV1.md | progress-stage route; verify-identity route; handoff accept/fulfil/reject routes; cancellation route |
| 13 | Integration | DEV-SPEC-001-Part11.md | EmailInterface; WhatsAppInterface; DocumentGenerationInterface |
| 14 | Configuration | DEV-SPEC-001-Part12.md | §12.3.4 S6_READINESS surface table |
| 15 | Acceptance Gates | DEV-SPEC-001-Part13.md | S6 assertions — schema cross-reference; VIPArrivalNotificationEvent confirmed required |

---

## Table of Contents

1. [Stage Identity](#section-1--stage-identity)
2. [Schema Models Active at S6](#section-2--schema-models-active-at-s6)
3. [State Machine at S6](#section-3--state-machine-at-s6)
4. [Policies Enforced at S6](#section-4--policies-enforced-at-s6)
5. [Engines Invoked at S6](#section-5--engines-invoked-at-s6)
6. [Services Active at S6](#section-6--services-active-at-s6)
7. [Workers Active at S6](#section-7--workers-active-at-s6)
8. [API Routes at S6](#section-8--api-routes-at-s6)
9. [Configuration Keys at S6](#section-9--configuration-keys-at-s6)
10. [Acceptance Criteria](#section-10--acceptance-criteria)

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 6 (S6) — Check-In & Stay/Event Initiation**

### 1.2 Stage Purpose

Stage 6 is the commitment execution stage. Everything before it is preparation; S6 is where the hotel physically receives the guest and formally initiates the stay. The provisional folio converts to live — an irreversible, audited event. The room becomes occupied. H2 and H3 create the hotel's service obligations to housekeeping and F&B for the duration of the stay. From this point forward the system governs a live stay, not a pre-arrival preparation sequence.

S6 is also the moment at which identity is confirmed, data governance applies from first capture, and every operational department that serves this guest — front desk, housekeeping, F&B — receives the information they need through the governed handoff mechanism.

### 1.3 Entry Routes

**Forward from S5 (standard path).** Pre-arrival preparation is complete. The assigned room is verified as physically ready. All pre-arrival tasks are in COMPLETE or WAIVED status. Advance payment is reconciled. H1 is in FULFILLED state. The guest has arrived at the property and is physically present at the front desk. The S5→S6 guard has been satisfied in full.

**Walk-in compressed path.** A walk-in guest arrives at the front desk without a prior booking. S1 through S4 processing has occurred in a compressed flow — room identified, commercial terms set, committed hold placed, provisional folio created, billing model fixed, reservation created in compressed sequence. S5 is auto-fulfilled because the guest is physically present and room readiness is verified in real time at the moment of check-in initiation.

On the walk-in path, the following S5 obligations are compressed to real-time verification within the check-in sequence: room physical state check (AVAILABLE_CLEAN or AVAILABLE_INSPECTED confirmed at the moment of check-in, not before); advance payment balance verification (executed as a real-time check within CheckInService rather than a prior reconciliation task); and DEFICIENT flag acknowledgement (if the assigned room carries a DEFICIENT condition, the acknowledgement is captured within the check-in workflow). Pre-arrival communication, site visit, late-arrival meal coordination, and other task-type obligations that require prior-day scheduling are auto-fulfilled on the walk-in path — there is no prior-day window in which they could have been executed. The PreArrivalTask checklist is seeded and immediately auto-fulfilled with `waivedReason: WALK_IN_COMPRESSED` on all time-dependent task types.

There is no H1 handoff on the walk-in path. H1 is a reservations-to-front-desk handoff; a walk-in has no reservations stage. The S5 auto-fulfilment mechanism records that this path has no H1 obligation rather than creating and immediately closing a phantom H1.

S5 is not skipped on the walk-in path. It is auto-fulfilled because the guest's physical presence satisfies the core S5 condition. The audit trail records S5 passage.

**Re-entry from S7 (compressed).** Guest composition change during stay (new guest added to the room requiring registration and identity verification) or room change during stay where the new room requires re-initiation of H2. S6 on re-entry is compressed to only the specific re-verification needed — not a full repeat of the check-in ceremony. A new segment is created. A new RoomAssignment record is created for room changes. Identity verification is re-run for newly added guests.

### 1.4 S6 Starting State

When an entry enters S6 through the standard path from S5, the following state is expected. This is the complete handoff from a correctly completed S5.

**Always present:**

- `Entry.currentStage = S6`; `Entry.status = ACTIVE`
- `Reservation` record exists with all frozen commercial terms — rate, inclusions, billing model, cancellation terms are locked; these terms govern the entire stay and cannot be changed in-place
- `CommittedHold.state = CONFIRMED`; `Room.currentClaimState = CONFIRMED` — inventory is locked to this entry
- `Folio` in `FolioState.PROVISIONAL` with `billingModel` non-null (fixed at S3); no live charges have been posted; advance payment records and proforma invoices may be present
- `HandoffRecord` H1 in `HandoffState.FULFILLED` — the reservations-to-front-desk obligation is evidenced; FULFILLED, not merely ACCEPTED
- All `PreArrivalTask` records in `TaskStatus.COMPLETE` or `TaskStatus.WAIVED`; no record remains in PENDING
- `RoomAssignment` record exists; the assigned room has been verified as physically ready; `deficientAtAssignment` is populated truthfully
- `StageDwellRecord` for S6 with `enteredAt` populated; `STAGE_DWELL_MONITOR` timer registered
- Guest physically present at the front desk

**Conditionally present:**

- `DeficientConditionRecord` with `deficientAtAssignment = true` on the `RoomAssignment` record — if the room carried a DEFICIENT flag at the time of S5 assignment; `acknowledgementActorId` and `acknowledgementAt` are populated
- `CreditExtensionCeilingRecord` on the folio — if credit was extended at S3; proximity status has been evaluated at S5
- Outstanding advance payment balance — if the full expected amount was not collected before check-in; collection may occur at S6

**Walk-in path variant:** S6 starting state on the walk-in path has no prior RoomAssignment from S5 — room is assigned in real time. H1 is absent — the walk-in compressed path records this as a no-H1 path. PreArrivalTask checklist is auto-fulfilled. All other state elements apply.

### 1.5 Exit Conditions

**Single exit path — S6 → S7 (check-in complete, stay initiated).** All of the following must be true. Guards evaluated in sequence by `EntryService.progressStage()`. Failure raises `StageGateBlockedError` identifying the specific unsatisfied condition.

1. Guest identity has been verified and a verification event is recorded on `GuestProfile`. A `GuestIdentityDocument` record exists (first-time guest) or the existing profile has been confirmed (returning guest with valid ID). A verification event is written on every path including the VIP path.
2. `Room.currentClaimState = OCCUPIED`. The `RoomClaimStateEvent` recording the CONFIRMED→OCCUPIED transition has been written.
3. `Folio.state = LIVE`. The folio has converted from PROVISIONAL through the explicit `FolioService.convertToLive()` path. `convertedToLiveAt` and `convertedBy` are populated. The billing model is active.
4. Key issuance event has been recorded. Key count is non-zero.
5. `HandoffRecord` H2 exists in `HandoffState.CREATED` or later (ASSIGNED, ACCEPTED). Created in the same transaction as check-in commencement. Acceptance timer W25 is registered.
6. `HandoffRecord` H3 exists in `HandoffState.CREATED` or later. Created in the same transaction as H2. Acceptance timer W25 is registered.
7. Guest registration is complete. All mandatory registration fields are captured or confirmed for returning guests.
8. For VIP-tier guests: a `VIPArrivalNotificationEvent` record has been created and the notification has been dispatched to the configured staff roles.

There is no terminal path at S6. Every S6 completion routes to S7.

### 1.6 Stage Owner

The front desk custodian who completes check-in owns the entry through S7 (Stay Management). For standard stays, this is the front desk team managing the active stay. For conference engagements, the front desk team retains entry ownership even where a conference liaison relationship exists — the liaison is an operational relationship, not an ownership transfer.

FOM holds escalation authority throughout S6: identity verification failures requiring governed deferral, room readiness issues at the moment of guest arrival, folio conversion blocks, H2 or H3 rejection requiring rerouting, and any governed override of check-in operational actions.

### 1.7 Governing Actors

| Role | Authority Level | Authority at S6 |
|---|---|---|
| Front Desk / Reservations (Custodian) | L1 | Identity verification; key issuance; room assignment confirmation; H2 and H3 creation; registration completion; check-in initiation and completion |
| Front Office Manager | L2 | All L1 actions; governed deferral of identity verification; DEFICIENT room confirmation at check-in; H2 or H3 rejection rerouting; folio conversion block resolution; VIP protocol decisions |
| General Manager | L3 | All L2 actions; any GM-authority escalation within S6 |
| System Actor | L0 (equivalent) | VIP arrival notification dispatch; H2/H3 acceptance timer registration; stage dwell monitoring |

### 1.8 Forbidden Acts at S6

**Posting charges before folio conversion.** The folio is PROVISIONAL until `FolioService.convertToLive()` executes. No room charges, F&B charges, or service charges may be posted against the folio at S6 before conversion. The folio accepts only payment records in the pre-conversion window.

**Calling `PricingPipelineEngine.resolve()` at S6.** The rate is frozen at S4. Rate resolution is a pre-commitment action. Any S6 code path that calls `PricingPipelineEngine.resolve()` is an architectural violation. The frozen rate from the Reservation commitment snapshot is the operative rate throughout the stay.

**Issuing keys before identity verification for non-VIP guests.** Keys grant physical access to the room. Identity verification must precede key issuance on every non-VIP path. The VIP path substitutes verification mechanism, not key issuance timing.

**Creating H2 without carrying the DEFICIENT condition.** If the assigned room has an unresolved DEFICIENT condition, H2 must explicitly reference the condition description and resolution deadline. A H2 created without this content when the room has an active DEFICIENT flag is an incomplete handoff and a governance failure.

**Reverting the folio to PROVISIONAL after conversion.** Once `Folio.state = LIVE`, the folio never reverts to PROVISIONAL under any path — re-entry, amendment, rate change, or any other mechanism. A LIVE folio cannot be un-converted.

**Checking in a guest to a room that is not in a valid ready state.** The room must be in `AVAILABLE_CLEAN` or `AVAILABLE_INSPECTED` physical state at the moment of check-in. Checking in against a DEPARTED_DIRTY, UNDER_MAINTENANCE, or BLOCKED room is forbidden.

**Issuing the VIP arrival notification after check-in completes.** The notification must be issued at check-in commencement — before key issuance, before the guest reaches the room. A notification issued after check-in completion is operationally useless because the VIP has already been received without staff preparation.

**Changing commercial terms.** Rate, inclusions, and cancellation terms are frozen at S4. A rate dispute at check-in routes to re-entry through the amendment mechanism — it is not resolved by in-place edit at S6.

---

## Section 2 — Schema Models Active at S6

The following Prisma models are read or written during S6 operations. The full schema with all models is in Part 2 REV2-FINAL.

---

### 2.1 Entry

**Access at S6:** Read and written. Stage progression is the primary write operation.

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
  otaSource            Boolean         @default(false)
  groupBillingMode     GroupBillingMode?
  parkedAt             DateTime?
  parkedBy             String?
  parkedIndividually   Boolean         @default(false)
  version              Int             @default(1)
  createdAt            DateTime        @default(now())
  createdBy            String
  updatedAt            DateTime        @updatedAt
}
```

**S6 write operations:** `currentStage` transitions S5→S6 on check-in initiation and S6→S7 on check-in completion. `version` incremented on every state-changing write. No other Entry fields are written at S6 — commercial terms are frozen.

**Mutation rules at S6:** `Entry.currentStage` is the only field written at S6 progression events. In-place editing of commercial terms (`checkInDate`, `checkOutDate`, `guestCount`) after S4 exit is the forbidden pattern.

---

### 2.2 GuestProfile

**Access at S6:** Read and written. Identity verification event is written at S6. The verification event is immutable from creation.

```prisma
model GuestProfile {
  id                    String    @id @default(uuid())
  firstName             String
  lastName              String
  email                 String?
  phone                 String?
  nationality           String?
  vipTier               String?
  clientTier            String?
  preferences           Json?
  behaviouralFlags      Json?
  observationQueue      Json?
  stayHistorySummary    Json?
  isActive              Boolean   @default(true)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  createdBy             String
}
```

**S6 operations:**

- **First-time guest:** `GuestProfile` is created or confirmed; identity document captured via `GuestIdentityDocument` record.
- **Returning guest — valid ID:** existing `GuestProfile` read and displayed to front desk; identity confirmed without re-entry of documents; a verification event is written on the profile recording the confirmation actor, document type, and timestamp.
- **Returning guest — expired ID:** existing profile read; system surfaces a soft flag to front desk noting ID expiry; no hard block; verification event written recording the expired-ID path.
- **VIP guest:** identity confirmed through the booking relationship; no counter-level document verification; a verification event is still written on the profile recording the VIP-path confirmation, actor, and timestamp. The verification event is mandatory on this path — VIP verification is an alternative verification mechanism, not a skip.

**Data governance:** the `GuestProfile.updatedAt` field reflects the verification event write. The profile itself is not re-created — the verification event is an additive write via `GuestProfileService.recordVerification()`, which is the only governed write path for identity verification events.

---

### 2.3 GuestIdentityDocument

**Access at S6:** Created for first-time guests and returning guests with expired ID. Read for returning guests with valid ID.

```prisma
model GuestIdentityDocument {
  id                String    @id @default(uuid())
  guestProfileId    String
  documentType      String
  documentNumber    String
  issuingCountry    String?
  expiryDate        DateTime?
  capturedAt        DateTime
  capturedBy        String
  retentionPeriod   Int
  retentionExpiresAt DateTime
  createdAt         DateTime  @default(now())
}
```

**Document types — Bhutanese nationals:** CID copy, passport, MRSTA, driver license, road permit, NDI. **Document types — foreign nationals:** passport, voter card, Aadhar card. All accepted document types are configured in `identity.documentTypes` — the configuration surface governs which types are active.

**Data governance applies from the moment of capture.** The `retentionPeriod` is populated from `identity.retentionPeriodDays` at the time of capture — it is not set retroactively. `retentionExpiresAt` is computed from `capturedAt + retentionPeriod (days)` and persisted on the record. The access rules (front desk for operational purposes, FOM for dispute purposes, GM for governance) apply from creation. The capture event is immutable — `capturedAt`, `capturedBy`, and `documentType` cannot be corrected after the fact; a new document record is created if a correction is needed.

For apartment tenants with long stay durations, `retentionExpiresAt` may be extended to cover the full tenancy period plus the configured retention window — this is determined by configuration at the time of capture.

**Mutation rules:** immutable from creation. Document data is written only through `GuestProfileService.recordVerification()`. No direct writes to document fields from any other code path are permitted.

---

### 2.4 VIPArrivalNotificationEvent

**SIG-S6-COR-001 — Schema derived from Part 6 REV3 trace event catalogue and Canon stage charter records-affected section. Part 2 backfill required. Developer implements from this specification.**

**Access at S6:** Created at check-in commencement for VIP-tier guests. Immutable from creation.

```prisma
model VIPArrivalNotificationEvent {
  id                      String    @id @default(uuid())
  entryId                 String
  guestProfileId          String
  roomNumber              String
  vipTier                 String
  // tier classification from GuestProfile.vipTier at time of notification
  preferences             Json?
  // snapshot of relevant guest preferences at time of notification
  specialNotes            String?
  // any special notes populated from the reservation or guest profile
  checkInInitiatedAt      DateTime
  // timestamp of check-in commencement — NOT check-in completion
  recipientRoles          Json
  // array of role identifiers that received the notification
  // populated from vipNotification.routingPerTier configuration at time of dispatch
  notificationDispatchedAt DateTime @default(now())
  createdAt               DateTime  @default(now())
  createdBy               String
  // actor_id of front desk custodian initiating check-in

  entry                   Entry     @relation(fields: [entryId], references: [id])

  // Mutation rule: immutable from creation.
  // Created only for VIP-tier guests at check-in commencement.
  // One record per check-in commencement event — re-entry creates a new record.
  @@map("vip_arrival_notification_events")
}
```

**Timing is critical:** this record is created and the notification dispatched before key issuance and before the guest reaches the room. A `VIPArrivalNotificationEvent` with `checkInInitiatedAt` later than `keyIssuedAt` is a governance violation. The notification content carries a preferences snapshot — not a reference to the live profile — because the notification is a point-in-time communication.

---

### 2.5 Folio

**Access at S6:** The central S6 write operation. Converted from PROVISIONAL to LIVE through `FolioService.convertToLive()`.

```prisma
model Folio {
  id                    String      @id @default(uuid())
  entryId               String
  state                 FolioState  @default(PROVISIONAL)
  convertedToLiveAt     DateTime?
  // populated by FolioService.convertToLive() — null until S6 conversion
  convertedBy           String?
  // actor_id of front desk custodian at time of conversion
  closedAt              DateTime?
  closedBy              String?
  noShowPenaltyAmount   Decimal?    @db.Decimal(15,2)
  noShowAdvancePaymentAmount Decimal? @db.Decimal(15,2)
  noShowNetPosition     Decimal?    @db.Decimal(15,2)
  noShowFomDetermination String?
  postClosureAccessLevel PostClosureAccessLevel?
  billingModel          String?
  // non-null from S3 fixation onward; validated non-null by FolioService.convertToLive()
  createdAt             DateTime    @default(now())
  createdBy             String
}
```

**The PROVISIONAL→LIVE conversion is an explicit, audited, irreversible event — not a flag change.** `FolioService.convertToLive()` is the sole authoritative path. No other code path may transition `FolioState` from PROVISIONAL to LIVE. The conversion populates `convertedToLiveAt` and `convertedBy` in the same transaction that activates the billing model. An immutable `TraceEvent` with `eventType = FOLIO_CONVERTED_TO_LIVE` is emitted carrying the entryId, folioId, actorId, and conversion timestamp. This trace event is the permanent evidence of the conversion moment.

**The folio never reverts to PROVISIONAL after conversion.** Re-entry after S6, amendment, rate change, and billing model change are all handled through additive folio lines and new segment paths — never by reverting the folio state.

**`FolioState.NO_SHOW_CLOSED` is a read-only context at S6.** This terminal state results from a prior S5 no-show determination on a previous segment. If a no-show was determined and the guest later arrives for a new booking, the new segment has its own fresh folio in PROVISIONAL state. The prior NO_SHOW_CLOSED folio is read-only context — S6 does not write to it.

**Mutation rules at S6:** `Folio.state` transitions PROVISIONAL→LIVE via `FolioService.convertToLive()`. `convertedToLiveAt` and `convertedBy` are populated. `billingModel` is read and validated non-null — it was fixed at S3. No other folio fields are written at S6.

---

### 2.6 FolioLine

**Access at S6:** Read only at S6 (developer context). No FolioLine records are written at S6.

```prisma
model FolioLine {
  id              String    @id @default(uuid())
  folioId         String
  lineType        String    // ROOM_CHARGE | F_AND_B | SERVICE | PENALTY | OTHER
  description     String
  amount          Decimal   @db.Decimal(15,2)
  currency        String    @default("BTN")
  taxAmount       Decimal   @db.Decimal(15,2) @default(0)
  taxModel        TaxModel
  taxRate         Decimal   @db.Decimal(5,4)
  chargeDate      DateTime
  stage           Stage
  nightAuditRecordId String?
  postedBy        String
  createdAt       DateTime  @default(now())
}
```

**Developer awareness — S6 activates FolioLine as the charge vehicle.** The folio conversion at S6 is the moment FolioLine becomes operative. Before conversion, no FolioLine may be written against the folio. After conversion, S7 begins posting room charges, F&B charges, and service charges as FolioLine records via night audit and manual charge posting. The developer must understand this model becomes active at S6 conversion even though S6 itself does not write FolioLines.

**Mutation rules:** immutable from creation. Corrections via `CreditNote` or `CommercialAdjustmentEntry` — original FolioLine records are never edited.

---

### 2.7 HandoffRecord

**Access at S6:** Three distinct operations — H1 closure, H2 creation, H3 creation.

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
  // H2-specific: carries DEFICIENT condition description and resolution deadline
  // if the assigned room has an active DEFICIENT condition at check-in.
  // A H2 where this field is null when the room has an active DEFICIENT condition
  // is an incomplete handoff.
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
  stageContext          Stage
}
```

**H1 at S6 — FULFILLED → CLOSED:** H1 was created at S4 and fulfilled at S5. At S6 check-in commencement, `HandoffService.closeH1()` transitions H1 to `HandoffState.CLOSED`. `closedAt` is populated. The reservations-to-front-desk obligation is formally discharged. This transition happens at check-in commencement — before key issuance.

**H2 at S6 — CREATED:** `HandoffService.createH2()` creates the Front Desk → Housekeeping handoff. H2 `checklistContent` must include: room number, guest profile reference, special housekeeping requests, bed configuration, expected stay duration, VIP treatment protocol if applicable, and stayover cleaning schedule. If the assigned room has an active DEFICIENT condition at the time of check-in: `deficientConditionStatus` is mandatory and must carry the condition description and resolution deadline. A H2 without this content when the room has an unresolved DEFICIENT condition is a governance failure — housekeeping must not be unaware of a known room deficiency at the moment they take room responsibility. The W25 acceptance timer is registered in the same transaction as H2 creation.

**H3 at S6 — CREATED:** `HandoffService.createH3()` creates the Front Desk → F&B handoff. H3 `checklistContent` must include: guest profile reference, room number, meal plan details, dietary requirements, package inclusion specifics (which meals are included, which tea/snack options apply, quantity entitlements), guest count, stay duration, and cuisine preferences from the preference hierarchy. For Legphel specifically, the agent-level cuisine preference (Indian cuisine default for return-leg travel agent guests) surfaces through H3 as a kitchen preparation note. The W25 acceptance timer is registered in the same transaction as H3 creation.

**`HandoffState.REJECTED` requires FOM rerouting.** There is no silent rejection. A rejected H2 or H3 produces a new routing event — FOM is alerted and the handoff is rerouted.

---

### 2.8 Room

**Access at S6:** Written. `currentClaimState` transitions CONFIRMED→OCCUPIED atomically with check-in completion. `RoomClaimStateEvent` written in the same transaction.

```prisma
model Room {
  id                   String              @id @default(uuid())
  roomNumber           String              @unique
  roomTypeId           String
  currentClaimState    InventoryClaimState @default(FREE)
  isDeficient          Boolean             @default(false)
  deficientSince       DateTime?
  isBlocked            Boolean             @default(false)
  blockedReason        String?
  isUnderMaintenance   Boolean             @default(false)
  maintenanceDeadline  DateTime?
  cleansing_ritual_completed Boolean       @default(false)
  createdAt            DateTime            @default(now())
}
```

**S6 write:** `currentClaimState` CONFIRMED→OCCUPIED. This transition is atomic with folio conversion — both occur within the same check-in completion transaction. The `RoomClaimStateEvent` is written in that same transaction.

**DEFICIENT flag at S6:** `Room.isDeficient` is read at check-in to determine H2 content requirements. It is not cleared at S6 — DEFICIENT conditions carry through the stay and are tracked by housekeeping under H2 responsibility until resolved or until checkout inspection at S8.

**Required room state at check-in:** the room must be in `AVAILABLE_CLEAN` or `AVAILABLE_INSPECTED` logical physical state. If the room transitioned to DEPARTED_DIRTY or UNDER_MAINTENANCE between the S5 assignment and S6 guest arrival (another guest's checkout made the room dirty, or a maintenance issue was discovered), check-in is blocked and alternatives are surfaced.

---

### 2.9 RoomAssignment

**Access at S6:** Read from S5 (confirmation path). Written if room change occurs at S6 (new RoomAssignment record — not an update to the S5 record).

```prisma
model RoomAssignment {
  id                      String    @id @default(uuid())
  entryId                 String
  roomId                  String
  assignedAt              DateTime
  assignedBy              String
  deficientAtAssignment   Boolean   @default(false)
  deficientConditionRecordId String?
  acknowledgementActorId  String?
  acknowledgementAt       DateTime?
  decisionTaken           String?
  notes                   String?
  createdAt               DateTime  @default(now())
}
```

**Room change at S6 is a governed event.** If the guest requests a different room after seeing the assigned room, or a last-minute physical issue is discovered between S5 assignment and S6 arrival, the change is handled by creating a new `RoomAssignment` record — not by editing the S5 record. The S5 `RoomAssignment` record is preserved as an immutable historical record. The new S6 `RoomAssignment` is the operative assignment. The DEFICIENT flag status at the time of the S6 assignment must be recorded truthfully.

**Mutation rules:** immutable from creation. The assignment captures the state at a point in time — which room, which condition, who decided.

---

### 2.10 RoomClaimStateEvent

**Access at S6:** Created. Produced by every `Room.currentClaimState` change.

```prisma
model RoomClaimStateEvent {
  id              String              @id @default(uuid())
  roomId          String
  entryId         String?
  fromState       InventoryClaimState
  toState         InventoryClaimState
  actorId         String
  reason          String?
  effectiveFrom   DateTime
  effectiveTo     DateTime?
  createdAt       DateTime            @default(now())
}
```

**S6 write:** one `RoomClaimStateEvent` is created recording `fromState = CONFIRMED`, `toState = OCCUPIED`, with `entryId`, `actorId`, and `effectiveFrom` populated. This record is immutable and constitutes the audit evidence of room occupancy initiation.

---

### 2.11 StageDwellRecord, TraceEvent, CommunicationRecord, ConfigurationEntry

**StageDwellRecord** — written on S6 entry (`enteredAt`); `exitedAt` populated on S6→S7 transition; `dwellSeconds` computed on exit. W1 monitors this record throughout S6.

**TraceEvent** — immutable event log entries written at every governed action during S6: check-in initiation, identity verification, folio conversion (`FOLIO_CONVERTED_TO_LIVE`), room claim state transition, H1 closure, H2 creation, H3 creation, VIP arrival notification dispatch, key issuance, registration completion, S6→S7 transition. Every trace event carries `actorId`, `entryId`, `eventType`, `stage = S6`, and `createdAt`.

**CommunicationRecord** — written when the VIP arrival notification is dispatched to each configured staff role. One `CommunicationRecord` per recipient role. `acknowledgementStatus` governs whether the notification was acknowledged per Policy 52.

**ConfigurationEntry** — read throughout S6 for: identity document types, retention period, VIP notification routing, H2 and H3 checklists, advance payment thresholds, billing model availability, acknowledgement window per type.

---

## Section 3 — State Machine at S6

### 3.1 Entry State Machine

**State field:** `Entry.currentStage`

**S5 → S6 (check-in initiation):**

- Guard: `Entry.currentStage = S5`; room assigned and physically ready; advance payment reconciled; all pre-arrival tasks COMPLETE or WAIVED; H1 in FULFILLED state; guest physically present at front desk; DEFICIENT flag acknowledged if applicable
- Authority: Custodian (front desk) L1+
- On transition: `Entry.currentStage = S5 → S6`; `StageDwellRecord.enteredAt` populated for S6; `STAGE_DWELL_MONITOR` timer registered; W25 registered on H2 and H3 creation in the same workflow

**S6 → S7 (check-in completion):**

- Guard: identity verified and verification event recorded; `Room.currentClaimState = OCCUPIED`; `Folio.state = LIVE`; billing model activated; key issuance event recorded; H2 created (CREATED or later); H3 created (CREATED or later); registration complete; VIP notification issued (if VIP-tier guest)
- Authority: Custodian (front desk) L1+
- On transition: `Entry.currentStage = S6 → S7`; `StageDwellRecord.exitedAt` populated for S6; `dwellSeconds` computed; `TraceEvent` emitted for check-in completion

**S6 → S1 (re-entry — room change at check-in):**

- Trigger: room change required at check-in — guest preference after seeing assigned room or last-minute physical issue
- Authority: Front desk / FOM
- New segment created. `ReEntryConsequenceEngine` processes consequences. Compressed — only the room change and re-check-in obligations are re-run on the new segment.

### 3.2 Folio State Machine

**State field:** `Folio.state`

The central S6 state event is the PROVISIONAL→LIVE conversion.

**PROVISIONAL → LIVE:**

- Trigger: `FolioService.convertToLive(entryId, folioId, actorId)` called by `CheckInService.checkIn()`
- Authority: System (on check-in commencement event, initiated by Custodian)
- Guard: identity verified; folio conversion prerequisites satisfied; `Folio.billingModel` non-null; `Folio.state = PROVISIONAL`
- On transition: `Folio.state → LIVE`; `convertedToLiveAt = now()`; `convertedBy = actorId`; billing model activated in the same transaction; `TraceEvent` emitted (`FOLIO_CONVERTED_TO_LIVE`)
- **This transition is explicit, audited, and irreversible.** The folio never reverts to PROVISIONAL after conversion.

**FolioState.NO_SHOW_CLOSED — read-only context only:** this terminal state from a prior S5 no-show determination is visible as historical context on the entry's prior segment folio. S6 does not write to a NO_SHOW_CLOSED folio. The current segment's folio begins in PROVISIONAL state regardless of prior segment history.

### 3.3 Inventory Claim State Machine

**State field:** `Room.currentClaimState`

**CONFIRMED → OCCUPIED:**

- Trigger: S6 check-in completion
- Guard: folio converted to live; room physically occupied; all S6 exit guards satisfied
- On transition: `Room.currentClaimState = CONFIRMED → OCCUPIED`; `RoomClaimStateEvent` produced carrying `fromState = CONFIRMED`, `toState = OCCUPIED`, `entryId`, `actorId`, `effectiveFrom`
- This transition is atomic with folio conversion in the same check-in completion transaction

**Forbidden:** `OCCUPIED → DEPARTED_CLEAN` direct transition. A room leaving OCCUPIED state must pass through DEPARTED_DIRTY. Housekeeping action is the mandatory intermediate step.

### 3.4 Handoff State Machine — H1, H2, H3

**State field:** `HandoffRecord.state`

**H1 — FULFILLED → CLOSED (at check-in commencement):**

- Trigger: `HandoffService.closeH1()` called at check-in commencement
- `HandoffRecord.state → CLOSED`; `closedAt` populated; `TraceEvent` emitted
- The reservations-to-front-desk obligation is formally discharged at guest arrival
- H1 closure happens at check-in commencement — before key issuance, before S6→S7 transition

**H2 — CREATED → ASSIGNED → ACCEPTED (lifecycle):**

- `HandoffService.createH2()` creates H2 in CREATED state
- W25 acceptance timer registered in the same transaction as H2 creation — `slaDeadlineAt` populated from `acknowledgement.windowPerType` configuration
- ASSIGNED: H2 routed to housekeeping team; visibility established
- ACCEPTED: explicit acceptance event by housekeeping actor — acceptance is a governed state transition requiring an explicit action; visibility alone is not acceptance
- ESCALATED: if acceptance window expires without explicit housekeeping acknowledgement, W25 fires, FOM is alerted, `HandoffRecord.state → ESCALATED`; ESCALATED is not terminal — housekeeping management continues
- REJECTED: blocking condition at receiving party; rejection reason recorded; new routing event produced; FOM reroutes; REJECTED is not terminal

**H3 — CREATED → ASSIGNED → ACCEPTED (lifecycle):**

- Same pattern as H2; `HandoffService.createH3()` creates H3 in CREATED state
- W25 acceptance timer registered in the same transaction as H3 creation
- F&B team is the receiving party; F&B acceptance is the governed state transition

---

## Section 4 — Policies Enforced at S6

### Policy 16 — Guest Identity Verification

- **Active at S6:** check-in identity verification gate
- **Decision:** APPROVED (document verified and recorded per the governed procedure) | DENIED (required document not presented or not accepted document type)
- **Enforcement point:** `CheckInService.checkIn()` → `GuestProfileService.recordVerification()` — identity verification gate enforced before check-in can advance; verification event recorded with actor identity, document type, and timestamp
- **Four verification paths — all mandatory:** (1) first-time guest: document captured, `GuestIdentityDocument` record created, verification event written; (2) returning guest with valid ID: profile confirmed, no re-capture, verification event written recording confirmation; (3) returning guest with expired ID: soft flag surfaced to front desk, no hard block, verification event written recording expired-ID path; (4) VIP guest: identity confirmed through booking relationship, no counter-level document check, verification event written recording VIP-path confirmation
- **Hardcoded:** identity verification is a mandatory S6 gate. Check-in cannot complete without a recorded verification event on every path including the VIP path. Keys cannot be issued before the verification event is recorded for non-VIP guests.
- **Configurable:** accepted identity document types (per `identity.documentTypes` configuration surface)

---

### Policy 17 — Guest Data Capture Governance

- **Active at S6:** identity document capture at check-in
- **Decision:** enforcement rule — document data is captured only through the governed capture procedure. Ungoverned capture (free-text notes containing document data, photos stored outside the governed attachment model) is detected and rejected.
- **Enforcement point:** `GuestProfileService.recordVerification()` — the only write path for identity document data; `GuestIdentityDocument` record created with `retentionPeriod` from configuration at time of capture; `retentionExpiresAt` computed and persisted immediately
- **Hardcoded:** the retention window and access rules apply from the moment of capture — not retroactively. Direct writes to document fields from any code path other than `GuestProfileService.recordVerification()` are forbidden.
- **Configurable:** retention period duration (per `identity.retentionPeriodDays` configuration surface)

---

### Policy 29 — Advance Payment Balance Verification

- **Active at S6:** final advance payment balance check before folio converts
- **Decision:** APPROVED (advance payments correctly applied; reconciliation flags resolved) | BLOCKED (unresolved reconciliation flags from S5 present; folio conversion blocked until resolved or FOM acknowledges)
- **Enforcement point:** `CheckInService.checkIn()` — advance payment balance verification executes before `FolioService.convertToLive()` is called; unresolved S5 reconciliation flags block folio conversion
- **Hardcoded:** folio conversion requires advance payment balance confirmed. An unresolved advance payment flag cannot be silently ignored at check-in.
- **Configurable:** advance payment thresholds per source channel and client tier (per `advancePayment.thresholds` configuration surface)

---

### Policy 31 — Billing Model Activation

- **Active at S6:** folio converts from PROVISIONAL to LIVE
- **Decision:** enforcement rule — at check-in completion, `FolioState` transitions from PROVISIONAL to LIVE and the billing model activates. Billing model activation is atomic with folio conversion.
- **Enforcement point:** `CheckInService.checkIn()` → `FolioService.convertToLive()` — billing model activation is part of the folio conversion transaction; the two cannot be separated
- **Hardcoded:** billing model activation cannot precede check-in completion. A LIVE folio cannot exist before S6. A LIVE folio without an active billing model is a structural defect.
- **Configurable:** none — activation is triggered by check-in completion; not configurable

---

### Policy 35 — Cancellation Enforcement

- **Active at S6:** post-check-in cancellation (early departure from the moment of check-in)
- **Decision:** APPROVED (`ActorLevel.FOM` — cancellation processed with penalty applied per the disclosed tier) | ESCALATE (`ActorLevel.GM`) — penalty waiver requested beyond FOM authority
- **Enforcement point:** `CancellationService.processCancel()` — penalty calculated and posted to the now-live folio; `EntryStatus → CANCELLED`; historical records preserved; S9-equivalent financial closure triggered
- **Hardcoded:** cancellation at S6 sets `EntryStatus.CANCELLED` — terminal. The folio is LIVE at this point; cancellation consequences are posted as FolioLine entries. All operational history is preserved.
- **Configurable:** cancellation penalty tiers; penalty waiver authority thresholds

---

### Policy 49 — DEFICIENT Carry into H2

- **Active at S6:** H2 handoff creation at check-in
- **Decision:** enforcement rule — H2 must explicitly reference any active DEFICIENT condition on the assigned room. `HandoffRecord.deficientConditionStatus` is mandatory when `Room.isDeficient = true`.
- **Enforcement point:** `HandoffService.createH2()` — DEFICIENT flag status is read from the room at H2 creation; if `isDeficient = true`, `deficientConditionStatus` is populated with the condition description and resolution deadline; H2 creation is blocked if this field is omitted when required
- **Hardcoded:** DEFICIENT conditions are not silently cleared at check-in. A DEFICIENT room does not become an untracked DEFICIENT room because the guest has checked in — the condition is formally transferred to housekeeping through H2.
- **Configurable:** none — DEFICIENT carry is a mandatory handoff element

---

### Policy 52 — Communication Acknowledgement Tracking

- **Active at S6:** VIP arrival notification dispatch; any pre-arrival communication acknowledgement loops that close at guest arrival
- **Decision:** enforcement rule — every outbound communication that requires acknowledgement opens an acknowledgement loop. Four loop-close conditions:
  1. **Explicit acknowledgement:** staff role acknowledges the VIP notification through the governed channel
  2. **Implicit acknowledgement:** the guest's physical arrival at S6 closes any pre-arrival communication acknowledgement loops that were open from S5 (pre-arrival outbound communications)
  3. **Governed timeout:** `AcknowledgementStatus.TIMED_OUT` recorded when the window expires without acknowledgement; non-acknowledgement is a visible flag, not a silent state
  4. **OTA auto-fulfilment:** for entries where `Entry.otaSource = true`, the confirmation voucher acknowledgement loop is auto-fulfilled on voucher dispatch; no `AcknowledgementWindowWorker` timer is registered for OTA-sourced entries on the voucher acknowledgement loop — the OTA channel serves as the acknowledgement medium
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on outbound send; `TimerEngine.register()` called for acknowledgement window; W22 fires on timeout
- **Hardcoded:** every governed communication has a tracked acknowledgement state. There is no communication without an acknowledgement state.
- **Configurable:** acknowledgement window per communication type (per `acknowledgement.windowPerType` configuration surface)

---

### Policy 63 — Handoff Lifecycle

- **Active at S6:** H2 and H3 creation; H1 closure; mandatory audit event on every handoff state transition
- **Decision:** enforcement rule — every handoff state transition is a governed event. H2 and H3 are both mandatory at S6 — neither may be omitted or deferred. H1 must be CLOSED at S6 commencement.
- **Enforcement point:** `HandoffService.closeH1()`, `HandoffService.createH2()`, `HandoffService.createH3()`, W25 on acceptance window expiry
- **Hardcoded:** H2 and H3 are mandatory. `HandoffState.REJECTED` requires FOM rerouting — no silent rejection. Every handoff state transition produces an immutable audit event including auto-fulfilments.
- **Configurable:** H2 and H3 checklist content (per `handoff.H2.checklist` and `handoff.H3.checklist` configuration surfaces); acceptance window (per `acknowledgement.windowPerType`)

---

### Policy 69 — Session Management and PIN Authentication

- **Active at S6:** all staff actions throughout check-in
- **Enforcement point:** `SessionService` — PIN switch, idle auto-lock, manual lock, and hard logout all governed; `SessionEventRecord` created on every session event; every record written within a session carries the authenticated actor's identity
- **Hardcoded:** shared credentials forbidden. Retrospective attribution change is structurally forbidden.
- **Configurable:** idle lock threshold per role; hard logout threshold per role (per `session.*` configuration surfaces)

---

### Policy 71 — Processing Lock TTL

- **Active at S6:** inventory selection during room change at check-in (S6→S1 re-entry path)
- **Enforcement point:** `ProcessingLockService.placeLock()` — `ProcessingLockRecord` created with `ProcessingLockStatus.ACTIVE`; TTL timer registered; unconditional expiry on TTL — no heartbeat or renewal
- **Hardcoded:** silent expiry is forbidden. TTL is unconditional. A processing lock is not a commercial hold — it does not alter `InventoryClaimState`.
- **Configurable:** lock TTL per channel (per `processingLock.ttl.perChannel` configuration surface)

---

## Section 5 — Engines Invoked at S6

### 5.1 TimerEngine

**S6 timer registrations:**

- `STAGE_DWELL_MONITOR` — registered on S6 entry; W1 monitors dwell time; cancelled on S6→S7 transition when `StageDwellRecord.exitedAt` is populated
- `H2_H3_ACCEPTANCE` — registered on H2 creation and again on H3 creation in the same transaction as the handoff record write; W25 fires when acceptance window expires without housekeeping or F&B acknowledgement; `slaDeadlineAt` on `HandoffRecord` is populated at registration

**S6 timer cancellations:**

- `ROOM_READINESS_SLA` — if a room readiness SLA timer from S5 (W23) is still active at the time of check-in commencement (guest arrived and room was ready), the timer is cancelled in the same transaction as the check-in initiation
- `STAGE_DWELL_MONITOR` — cancelled on S6 exit to S7

**Timer registration is atomic:** `STAGE_DWELL_MONITOR` and `H2_H3_ACCEPTANCE` timers are registered within the same database transaction as the records they govern. A `HandoffRecord` must never exist without a corresponding active acceptance timer. A `StageDwellRecord.enteredAt` without a corresponding active dwell timer is a structural defect.

### 5.2 ReEntryConsequenceEngine

**Invoked on:** S6→S1 re-entry (room change at check-in)

**S6→S1 consequence row:**

- **Timer cancellations:** `ROOM_READINESS_SLA` timer for the original room cancelled; `H2_H3_ACCEPTANCE` timers for H2 and H3 created on the original assignment cancelled
- **Folio consequences:** folio continues on the same Entry-level folio; a room change adjustment FolioLine is written if applicable; billing model remains active — the folio does not revert to PROVISIONAL
- **Handoff consequences:** H2 and H3 created for the original room are withdrawn — `HandoffRecord.state → CANCELLED` with reason `REENTRY_S6_TO_S1`; H2 and H3 will be re-created when the new segment returns to S6 after room re-selection
- **Inventory consequences:** original room transitions from CONFIRMED→OCCUPIED back to CONFIRMED→FREE via a governed release event; the new room begins the readiness and assignment path on the new segment
- **New segment:** a new `Segment` record is created; `EntryService.createSegment()` handles the re-entry; `Entry.segmentNumber` incremented

### 5.3 PricingPipelineEngine — NOT Invoked at S6

`PricingPipelineEngine.resolve()` is not called at S6. The rate is the frozen commitment snapshot rate from the `Reservation` record fixed at S4. The billing model activation at S6 is an activation event — not a pricing event. Any S6 code path that calls `PricingPipelineEngine.resolve()` is an architectural violation. The pricing engine is frozen from the moment of S4 confirmation through checkout.

---

## Section 6 — Services Active at S6

### 6.1 CheckInService.checkIn(entryId, actorId)

Primary S6 service method. Invoked via `POST /entries/:id/progress-stage` with `targetStage = S6`. There is no dedicated check-in route. The full execution sequence:

1. **Identity verification (Policy 16):** `GuestProfileService.recordVerification()` called. Verification path determined from guest profile (`vipTier`, returning-guest status, ID expiry status). Verification event written. For non-VIP guests: method blocks until verification event is confirmed written. For VIP guests: VIP-path verification event written, then execution continues immediately.

2. **Advance payment balance verification (Policy 29):** outstanding advance payment reconciliation flags from S5 evaluated. If unresolved flags exist, `StageGateBlockedError` raised with `blockingCondition: 'ADVANCE_PAYMENT_UNRECONCILED'`. FOM must resolve or acknowledge before check-in can continue.

3. **Room readiness confirmed:** `Room.currentClaimState` and physical state evaluated in real time. Room must be in `AVAILABLE_CLEAN` or `AVAILABLE_INSPECTED` state. If not: `StageGateBlockedError` raised with `blockingCondition: 'ROOM_NOT_READY'`; W23 surfaces alternative rooms to FOM.

4. **VIP arrival notification issued (for VIP-tier guests only — at this point, before key issuance):** `vipTier` read from `GuestProfile`. If non-null and tier is active: `VIPArrivalNotificationEvent` record created; notification content assembled (guest name, room number, tier classification, preferences snapshot, special notes, `checkInInitiatedAt = now()`); notification dispatched to each configured staff role per `vipNotification.routingPerTier`; one `CommunicationRecord` per recipient role written. This step executes before step 5 (folio conversion) — the notification timing requirement is at commencement, not at completion.

5. **Folio conversion (Policy 31):** `FolioService.convertToLive(entryId, folioId, actorId)` called. `Folio.state PROVISIONAL→LIVE`; `convertedToLiveAt` and `convertedBy` populated; billing model activated; `TraceEvent(FOLIO_CONVERTED_TO_LIVE)` emitted. Atomic — folio state change and billing model activation in one transaction. Partial commit is a structural defect.

6. **H1 closure:** `HandoffService.closeH1(h1HandoffId, actorId)` called. `HandoffRecord.state → CLOSED`; `closedAt` populated; `TraceEvent` emitted. The reservations-to-front-desk obligation is formally discharged. On the walk-in path: no H1 exists — this step is skipped; the walk-in no-H1 status is recorded as a `TraceEvent`.

7. **H2 created:** `HandoffService.createH2(entryId, actorId, h2Content)` called. `h2Content` includes: room number, guest profile reference, special housekeeping requests, bed configuration, expected stay duration, VIP treatment protocol if applicable, stayover cleaning schedule, and — if `Room.isDeficient = true` — the DEFICIENT condition description and resolution deadline in `deficientConditionStatus`. W25 acceptance timer registered in same transaction. `slaDeadlineAt` populated from `acknowledgement.windowPerType` for H2 type.

8. **H3 created:** `HandoffService.createH3(entryId, actorId, h3Content)` called. `h3Content` includes: guest profile reference, room number, meal plan details, dietary requirements, package inclusion specifics (meals included, tea/snack options, quantity entitlements), guest count, stay duration, cuisine preferences from preference hierarchy. W25 acceptance timer registered in same transaction.

9. **Room claim state transitioned:** `Room.currentClaimState CONFIRMED→OCCUPIED`. `RoomClaimStateEvent` written. Atomic with check-in completion event.

10. **Key issuance event recorded:** key count and issuance event written as a `TraceEvent`. For non-VIP guests, key issuance executes only after the identity verification event from step 1 has been confirmed written.

11. **Registration completed:** all registration fields captured or confirmed for returning guests. Registration is an immutable point-in-time snapshot of guest details at check-in.

12. **For non-VIP guests — escort completion event recorded:** `TraceEvent` written confirming guest directed to room and luggage coordinated.

All guards in steps 1–3 are evaluated before any state-changing write. Failure at any guard raises `StageGateBlockedError` identifying the specific unsatisfied condition. The execution sequence above is the authoritative order — steps do not execute out of sequence.

**Walk-in path:** `CheckInService.checkIn()` detects the walk-in path from the absence of a prior S5 `PreArrivalTask` completion record and the presence of a walk-in compressed-path flag on the entry. Steps 1–12 execute normally with these differences: step 6 (H1 closure) is skipped and recorded as a no-H1 `TraceEvent`; room readiness in step 3 is the primary readiness verification (no prior S5 readiness check exists); advance payment verification in step 2 evaluates the compressed-flow payment records from the walk-in S1→S3→S4 sequence.

### 6.2 FolioService.convertToLive(entryId, folioId, actorId)

**SIG-S6-COR-002 — Method contract derived. Part 6 backfill required. Developer implements from this specification.**

The sole authoritative path for transitioning `FolioState` from PROVISIONAL to LIVE. No other code path may create or transition a folio to LIVE state. Called exclusively by `CheckInService.checkIn()`.

**Models read:** `Folio` (state must be PROVISIONAL; `billingModel` must be non-null)

**Models written:** `Folio` (`state → LIVE`; `convertedToLiveAt = now()`; `convertedBy = actorId`); `TraceEvent` (`FOLIO_CONVERTED_TO_LIVE` — carries `entryId`, `folioId`, `actorId`, `convertedAt`, `billingModel`)

**Execution:**
1. Read `Folio` by `folioId`. Assert `Folio.state = PROVISIONAL` — if not, raise `StateTransitionError` (folio already converted or closed).
2. Assert `Folio.billingModel` is non-null — if null, raise `MissingConfigurationError` (billing model was not fixed at S3).
3. Assert `Folio.entryId = entryId` — if not, raise `ValidationError` (folio does not belong to this entry).
4. In a single atomic transaction: set `Folio.state = LIVE`; set `convertedToLiveAt = now()`; set `convertedBy = actorId`; emit `TraceEvent(FOLIO_CONVERTED_TO_LIVE)`.
5. Return the updated `Folio` record.

**Atomicity:** folio state change and billing model activation are a single transaction. The billing model is already recorded on `Folio.billingModel` from S3 fixation — activation means the folio state transitions to LIVE with that model as the operative model. There is no separate billing model write at step 4 — the billingModel field was already set at S3; the LIVE state is what activates it.

**Forbidden:** calling this method from any code path other than `CheckInService.checkIn()`. Creating a LIVE folio through a direct `Folio.create()` call. Calling this method when `Folio.state ≠ PROVISIONAL`.

### 6.3 HandoffService — S6 Operations

**HandoffService.closeH1(handoffId, actorId)**

Transitions H1 from FULFILLED to CLOSED at check-in commencement.

- Models read: `HandoffRecord` (state must be FULFILLED; `handoffType` must be H1)
- Models written: `HandoffRecord` (`state → CLOSED`; `closedAt = now()`); `TraceEvent` (`HANDOFF.H1_CLOSED` carrying `handoffId`, `entryId`, `actorId`)
- Forbidden: calling closeH1 when H1 is not in FULFILLED state; skipping H1 closure at check-in commencement

**HandoffService.createH2(entryId, actorId, h2Content)**

Creates H2 handoff. `h2Content` carries: `roomNumber`, `guestProfileId`, `specialHousekeepingRequests`, `bedConfiguration`, `expectedStayDuration`, `vipTreatmentProtocol` (if applicable), `deficientConditionStatus` (mandatory if `Room.isDeficient = true` — condition description and resolution deadline), `stayoverCleaningSchedule`.

- Models written: `HandoffRecord` (state = CREATED, `handoffType = H2`, `stageContext = S6`, `checklistContent = h2Content`); `TimerRecord` (`H2_H3_ACCEPTANCE` timer via `TimerEngine.register()`); `HandoffRecord.slaDeadlineAt` populated
- Forbidden: creating H2 with `deficientConditionStatus = null` when `Room.isDeficient = true`; creating H2 without registering the W25 acceptance timer in the same transaction

**HandoffService.createH3(entryId, actorId, h3Content)**

Creates H3 handoff. `h3Content` carries: `guestProfileId`, `roomNumber`, `mealPlan`, `dietaryRequirements`, `packageInclusions` (meals included, tea/snack options, quantity entitlements), `guestCount`, `stayDuration`, `cuisinePreferences` (from preference hierarchy).

- Models written: `HandoffRecord` (state = CREATED, `handoffType = H3`, `stageContext = S6`, `checklistContent = h3Content`); `TimerRecord` (`H2_H3_ACCEPTANCE` timer via `TimerEngine.register()`); `HandoffRecord.slaDeadlineAt` populated
- Forbidden: creating H3 without complete meal plan and dietary content; creating H3 without registering the W25 acceptance timer in the same transaction

### 6.4 EntryService — S6 Stage Progression

**EntryService.progressStage(entryId, targetStage, actorId, transitionData)**

Handles both S5→S6 (check-in initiation) and S6→S7 (check-in completion) transitions.

On `targetStage = S6`: evaluates S5 exit guards (room assigned and physically ready; advance payment reconciled; all tasks COMPLETE or WAIVED; H1 FULFILLED; guest physically present). Delegates to `CheckInService.checkIn()`. Creates new `StageDwellRecord` for S6. Registers `STAGE_DWELL_MONITOR` timer.

On `targetStage = S7`: evaluates S6 exit guards in sequence (identity verified; room OCCUPIED; folio LIVE; billing model active; keys issued; H2 created; H3 created; registration complete; VIP notification issued if VIP-tier). If all guards satisfied: `Entry.currentStage = S6 → S7`; `StageDwellRecord.exitedAt` populated for S6; `TraceEvent` emitted for check-in completion.

**S6→S1 re-entry:** `EntryService.createSegment()` on room change at check-in. New segment created. `ReEntryConsequenceEngine` processes consequences per §5.2 above.

### 6.5 RoomAssignmentService — S6 Operations

**Standard path (confirmation):** S5 `RoomAssignment` record read and confirmed. Room physical state verified as AVAILABLE_CLEAN or AVAILABLE_INSPECTED in real time.

**Room change path at S6:** `RoomAssignmentService.assignRoom(entryId, roomId, actorId, notes, deficientAcknowledgement)` called for the new room. Creates a new `RoomAssignment` record — not an update to the S5 record. The S5 `RoomAssignment` is preserved as immutable historical record. If the new room carries a DEFICIENT flag: `deficientAcknowledgement` payload is mandatory; `deficientAtAssignment = true`; `deficientConditionRecordId` populated; `acknowledgementActorId` and `acknowledgementAt` recorded.

### 6.6 VIP Arrival Notification Dispatch

**Invocation point:** step 4 of `CheckInService.checkIn()` — before folio conversion, before key issuance. This is the commencement notification — its value is in its timing.

**Execution:**
1. Read `GuestProfile.vipTier` for the entry.
2. If `vipTier` is non-null and active: read `vipNotification.routingPerTier` configuration for this tier.
3. Create `VIPArrivalNotificationEvent` record (schema per §2.4).
4. For each staff role in the routing configuration: `CommunicationService.send()` called with notification content; one `CommunicationRecord` written per recipient; acknowledgement loop opened.
5. Emit `TraceEvent(VIP_ARRIVAL_NOTIFICATION_ISSUED)` carrying `entryId`, `guestProfileId`, `vipTier`, `recipientRoles`, `checkInInitiatedAt`.

**Non-VIP path:** no `VIPArrivalNotificationEvent` created. An escort completion `TraceEvent` is written at the end of check-in confirming the guest has been directed to their room and luggage coordinated.

---

## Section 7 — Workers Active at S6

### Worker 1 — StageDwellMonitor (W1)

**Governed stages:** S1 through S9

**S6 role:** registered on S6 entry; monitors dwell time throughout the check-in process; fires if check-in stalls (guest arrived but identity not yet verified, or room not ready, or any guard condition blocking check-in completion).

**pg-boss job type:** `STAGE_DWELL_MONITOR`

**Idempotency:** before emitting warning or critical events, inspects `StageDwellRecord.warningFiredAt` and `StageDwellRecord.criticalFiredAt`. If the corresponding timestamp is already set for this stage and this entry, the worker skips that phase without error. Idempotency keyed on `(entryId, stage, event_phase)`.

**Configuration:** `stageDwell.thresholds` — all nine stages × all three modes × warning/critical/escalation thresholds; all values must be present.

**Models read:** `Entry` (`currentStage`, `status`), `StageDwellRecord` (`mode`, `warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `enteredAt`), `ConfigurationEntry`

**Models written:** `StageDwellRecord` (`warningFiredAt`, `criticalFiredAt`, `escalatedAt`), `TraceEvent`

**Audit events:** `STAGE_DWELL.WARNING_FIRED`, `STAGE_DWELL.CRITICAL_FIRED`, `STAGE_DWELL.FOM_ESCALATED` — all attributed to `ActorLevel.SYSTEM`.

---

### Worker 25 — HandoffAcceptanceWorker (W25)

**Governed stages:** S6 (primary)

**Trigger:** registered when H2 and H3 handoffs are created at check-in. Fires when the configured acceptance window expires without the receiving party accepting the handoff.

**pg-boss job type:** `H2_H3_ACCEPTANCE`

**Idempotency:** before dispatching alerts, reads `HandoffRecord.state`. If `state = HandoffState.ACCEPTED`, `HandoffState.FULFILLED`, or `HandoffState.CLOSED`, the handoff is resolved — skip. Idempotency keyed on `(HandoffRecord.id, event_phase)`.

**On expiry:** `HandoffRecord.state → ESCALATED`; FOM alerted; `TraceEvent(HANDOFF.ACCEPTANCE_WINDOW_EXPIRED)` emitted; `TraceEvent(HANDOFF.FOM_ALERTED)` emitted. ESCALATED is not terminal — housekeeping or F&B management continues under FOM oversight.

**Configuration:** `acknowledgement.windowPerType` — the H2 and H3 acceptance window is read from this configuration surface. If this key is absent, W25 cannot register the acceptance timer on handoff creation — `MissingConfigurationError` raised at H2/H3 creation time. This is a blocking condition for S6_READINESS.

**Models read:** `HandoffRecord` (`state`, `handoffType`, `toRole`, `slaDeadlineAt`, `entryId`)

**Models written:** `TraceEvent` (`HANDOFF.ACCEPTANCE_WINDOW_EXPIRED`, `HANDOFF.FOM_ALERTED`)

**Policies enforced:** Policy 63 — Handoff Lifecycle Policy.

**Audit events:** `HANDOFF.ACCEPTANCE_WINDOW_EXPIRED`, `HANDOFF.FOM_ALERTED`.

---

### Worker 23 — RoomReadinessSLAWorker (W23)

**Governed stages:** S5–S6

**S6 role:** relevant at S6 if the assigned room transitions to DEPARTED_DIRTY or UNDER_MAINTENANCE between the S5 assignment and the S6 guest arrival. Surfaces alternative rooms to FOM as informational content — no assignment is created by the worker.

**pg-boss job type:** `ROOM_READINESS_SLA`

**Idempotency:** before dispatching SLA events, checks whether the room has transitioned to a ready state or the entry has progressed past S6. If room is ready or entry has checked in, skip. Idempotency keyed on `(roomId, entryId, event_phase)`.

**On breach:** `RoomAssignmentSuggestionEngine.suggest()` invoked; suggestion output surfaced to FOM as informational content; no `RoomAssignment` record created by the worker; FOM acts on suggestions through the normal assignment path.

**Configuration:** `room.readiness.slaWindow` (dotted form — MC-010 absorbed)

**Models read:** `Room` (`currentClaimState`, `isDeficient`, `roomNumber`), `Entry` (`currentStage`), `Reservation` (`frozenCheckInDate`)

**Models written:** `TraceEvent` (`ROOM_READINESS_SLA.WARNING_FIRED`, `ROOM_READINESS_SLA.BREACHED`, `ROOM_READINESS_SLA.FOM_ALERTED`)

**Engines invoked:** `RoomAssignmentSuggestionEngine.suggest(input: RoomSuggestionInput): RoomSuggestionResult`

---

## Section 8 — API Routes at S6

### 8.1 Initiate Check-In — Progress Stage to S6

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` — `targetStage` (string, required: "S6"), `transitionData` (object, required: `guestPresentConfirmation` boolean), `version` (integer, required — MC-011 absorbed) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` → `CheckInService.checkIn()` |
| Policies | Policy 16 (Guest Identity Verification); Policy 17 (Guest Data Capture Governance); Policy 29 (Advance Payment Balance Verification); Policy 31 (Billing Model Activation); Policy 63 (Handoff Lifecycle) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (`blockingCondition` identifies the specific unsatisfied guard), `PolicyGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |

Notes: The `version` field is required on every `ProgressStageRequestDTO`. Optimistic locking — if the submitted `version` does not match `Entry.version` in the database, a `StateTransitionError` is returned. The check-in initiation guard sequence is evaluated before any state-changing write executes.

---

### 8.2 Complete Check-In — Progress Stage to S7

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/progress-stage` |
| Auth | `L1+` |
| Request DTO | `ProgressStageRequestDTO` — `targetStage` (string, required: "S7"), `transitionData` (object: `keyCount` integer required, `registrationConfirmed` boolean required), `version` (integer, required) |
| Response DTO | `EntryResponseDTO` |
| Service method | `EntryService.progressStage()` |
| Policies | Policy 16 (identity verified guard); Policy 31 (folio LIVE guard); Policy 63 (H2 and H3 created guard) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StageGateBlockedError` (identifying which of the 8 S6 exit guards is unsatisfied), `PolicyGateBlockedError`, `StateTransitionError`, `MissingConfigurationError`, `AppError` |

Notes: `version` is required. All eight S6 exit guards are evaluated in sequence before `Entry.currentStage` transitions to S7. The first unsatisfied guard produces a `StageGateBlockedError` with `blockingCondition` identifying the specific guard. The guard sequence terminates on first failure — it does not accumulate all failures.

---

### 8.3 Verify Guest Identity

| Field | Value |
|---|---|
| Method + Path | `POST /guest-profiles/:id/verify-identity` |
| Auth | `L1+` |
| Request DTO | `VerifyIdentityRequestDTO` — path param: guestProfileId; body: `documentType` (string, required), `documentNumber` (string, required for first-time guests), `capturedBy` (string, required — actor_id), `entryId` (string, required), `verificationPath` (string, required: FIRST_TIME \| RETURNING_VALID \| RETURNING_EXPIRED \| VIP) |
| Response DTO | `IdentityVerificationResponseDTO` |
| Service method | `GuestProfileService.recordVerification()` |
| Policies | Policy 16 — Guest Identity Verification; Policy 17 — Guest Data Capture Governance |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (document type not accepted per configuration; required fields missing for path), `AppError` |

Notes: the `verificationPath` field determines which verification logic executes. All four paths produce a verification event — the VIP path does not skip event creation. `GuestIdentityDocument` is created only on the FIRST_TIME and RETURNING_EXPIRED paths.

---

### 8.4 Accept Handoff (H2 and H3)

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/accept` |
| Auth | `L1+` |
| Request DTO | `AcceptHandoffRequestDTO` — path param: handoffId; body: `checklistCompletion` (object, required — checklist items with completion status) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.accept()` |
| Policies | Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (checklist incomplete — mandatory items not marked complete), `StateTransitionError` (handoff not in a state that accepts this transition), `AppError` |

Notes: used by housekeeping to accept H2 and by F&B team to accept H3. Checklist completion must include all mandatory checklist items. On successful acceptance, `HandoffRecord.state → ACCEPTED`; `acceptedAt` and `acceptedBy` populated; `TraceEvent` emitted; W25 timer cancelled if acceptance occurs before expiry.

---

### 8.5 Reject Handoff

| Field | Value |
|---|---|
| Method + Path | `POST /handoffs/:id/reject` |
| Auth | `L1+` |
| Request DTO | `RejectHandoffRequestDTO` — path param: handoffId; body: `rejectionReason` (string, required) |
| Response DTO | `HandoffResponseDTO` |
| Service method | `HandoffService.reject()` |
| Policies | Policy 63 — Handoff Lifecycle Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError`, `AppError` |

Notes: rejection is not a terminal state. `HandoffRecord.state → REJECTED`; `rejectedAt`, `rejectedBy`, `rejectionReason` populated; FOM is alerted for rerouting; new routing event produced. There is no silent rejection.

---

### 8.6 Cancellation at S6 (Early Departure)

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/cancel` |
| Auth | `L2+` (FOM minimum; GM for penalty waiver beyond FOM authority) |
| Request DTO | `CancelEntryRequestDTO` — path param: id; body: `reason` (string, required), `penaltyWaiver` (boolean, optional — requires GM authority) |
| Response DTO | `EntryStatusResponseDTO` |
| Service method | `CancellationService.processCancel()` |
| Policies | Policy 35 — Cancellation Enforcement |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError`, `AppError` |

Notes: at S6 the folio is LIVE. Cancellation at this stage posts a cancellation penalty as a `FolioLine` against the live folio. `EntryStatus → CANCELLED`. S9-equivalent financial closure triggered.

---

## Section 9 — Configuration Keys at S6

All keys in dotted notation. MC-013 and SIG-S4-COR-006 absorbed as positive assertions — all flat key names from Part 12 are converted here.

| Config Key | Type | Description | Blocking for S6_READINESS |
|---|---|---|---|
| `identity.documentTypes` | Json | Accepted identity document types per nationality. Array of objects: `{ documentTypeCode, documentTypeName, applicableNationalities (array or "ALL"), isActive }`. At least one active entry required. | **Blocking** — identity verification cannot proceed; check-in cannot complete |
| `identity.retentionPeriodDays` | Json | Retention period in days by document type. Object keyed by document type code. Value: days as integer. Applied at moment of capture to compute `retentionExpiresAt`. | **Blocking** — data governance cannot enforce without this; `GuestIdentityDocument` creation raises `MissingConfigurationError` |
| `vipNotification.routingPerTier` | Json | Staff roles to notify per VIP tier. Object keyed by tier classification; value: array of role identifiers. At least one active tier routing required. | **Blocking** — VIP arrival notifications cannot be dispatched; `VIPArrivalNotificationEvent` creation raises `MissingConfigurationError` |
| `handoff.H2.checklist` | Json | Checklist items required for H2 acceptance by housekeeping. Array of objects: `{ itemCode, description, isMandatory }`. | **Blocking** — H2 acceptance blocked; `HandoffService.accept()` raises `MissingConfigurationError` |
| `handoff.H3.checklist` | Json | Checklist items required for H3 acceptance by F&B team. Array of objects: `{ itemCode, description, isMandatory }`. | **Blocking** — H3 acceptance blocked; `HandoffService.accept()` raises `MissingConfigurationError` |
| `advancePayment.thresholds` | Json | Required advance payment per source channel and client tier. Shared with S3 and S5. Used at S6 for final balance verification before folio conversion. | **Blocking** — check-in payment threshold validation unavailable; Policy 29 enforcement raises `MissingConfigurationError` |
| `billingModel.availablePerSource` | Json | Valid billing models per source channel. At least one active entry required. Used to validate `Folio.billingModel` is a recognised active model before conversion. | **Blocking** — folio conversion cannot proceed without a valid billing model |
| `acknowledgement.windowPerType` | Json | Acknowledgement window in seconds per communication type. Must include H2 and H3 handoff acceptance window entries. Missing means W25 cannot register acceptance timer on H2/H3 creation. | **Blocking** — W25 cannot register; H2 and H3 creation raises `MissingConfigurationError`; handoff acceptance SLA governance is non-functional |
| `stageDwell.thresholds` | Json | All nine stages × three dwell modes × warning/critical/escalation thresholds. S6 thresholds govern check-in dwell monitoring. | Non-blocking for operational flow — W1 monitoring is degraded; FOM escalation unavailable |
| `session.idle.frontDesk.thresholdSeconds` | Integer | Idle lock threshold for FRONT_DESK role. | Non-blocking — session management continues with system default |
| `session.hardLogout.frontDesk.thresholdSeconds` | Integer | Hard logout threshold for FRONT_DESK role. | Non-blocking |
| `cancellation.policyTiers` | Json | Cancellation penalty tiers. Active at S6 for post-check-in cancellation (Policy 35). | Non-blocking for check-in — blocking only if cancellation is attempted at S6 |
| `processingLock.ttl.perChannel` | Json | Processing lock TTL per channel. Active at S6 on re-entry path for room change. | Non-blocking for standard check-in — blocking only if S6→S1 re-entry occurs |
| `room.readiness.slaWindow` | Integer | Room readiness SLA window in seconds. Used by W23 to monitor room readiness between S5 assignment and S6 arrival. | Non-blocking — W23 monitoring degraded if absent |

---

## Section 10 — Acceptance Criteria

### 10.1 Identity Verification

**AC-S6-001:** First-time guest identity verification. A test that calls `POST /guest-profiles/:id/verify-identity` with `verificationPath = FIRST_TIME` and valid document data verifies: (a) `GuestIdentityDocument` record created; (b) `capturedAt`, `capturedBy`, `retentionPeriod`, `retentionExpiresAt` all populated; (c) `retentionExpiresAt = capturedAt + retentionPeriod days`. **PASS** = all three confirmed. **FAIL** = any absent or miscalculated.

**AC-S6-002:** VIP-path verification event is mandatory. A test that proceeds through the VIP check-in path verifies a verification event is written on `GuestProfile` with `verificationPath = VIP`, even though no `GuestIdentityDocument` is created. **PASS** = verification event present. **FAIL** = no verification event on VIP path.

**AC-S6-003:** Key issuance blocked before identity verification for non-VIP guests. A test that attempts to record key issuance before `GuestProfileService.recordVerification()` has been called returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = keys issued without prior verification event.

**AC-S6-004:** Returning guest with expired ID — soft flag only. A test that calls `POST /guest-profiles/:id/verify-identity` with `verificationPath = RETURNING_EXPIRED` verifies: (a) a soft flag is surfaced to the front desk actor; (b) check-in is not hard-blocked; (c) a verification event is written recording the expired-ID path. **PASS** = flag surfaced, no hard block, event written. **FAIL** = hard block applied or no event written.

---

### 10.2 Folio Conversion

**AC-S6-005:** Folio PROVISIONAL→LIVE is an explicit audited event. A test that completes check-in verifies: (a) `Folio.state = LIVE`; (b) `convertedToLiveAt` is non-null; (c) `convertedBy` is non-null; (d) an immutable `TraceEvent` with `eventType = FOLIO_CONVERTED_TO_LIVE` exists carrying `folioId`, `actorId`, and timestamp. **PASS** = all four confirmed. **FAIL** = any absent.

**AC-S6-006:** Folio conversion is atomic with billing model activation. A test that simulates a failure mid-transaction after `Folio.state → LIVE` but before the `TraceEvent` write verifies the transaction rolls back — `Folio.state` returns to PROVISIONAL. **PASS** = rollback confirmed; no partial LIVE state persists. **FAIL** = partial state persists.

**AC-S6-007:** LIVE folio never reverts to PROVISIONAL. A test that attempts any code path to set `Folio.state = PROVISIONAL` after conversion is rejected with `StateTransitionError`. **PASS** = error returned. **FAIL** = folio reverted.

**AC-S6-008:** FolioService.convertToLive() is the sole conversion path. A test that attempts to create a LIVE folio via a direct `Folio.create()` call with `state = LIVE` is rejected. **PASS** = rejected. **FAIL** = LIVE folio created without the governed conversion path.

**AC-S6-009:** PricingPipelineEngine.resolve() is not called at any point during S6. A test tracing all service calls during a complete S6 check-in flow verifies no invocation of the pricing engine. **PASS** = no pricing engine call. **FAIL** = pricing engine called at S6.

---

### 10.3 Room State

**AC-S6-010:** Room CONFIRMED→OCCUPIED is atomic with check-in completion. A test that completes check-in verifies: (a) `Room.currentClaimState = OCCUPIED`; (b) a `RoomClaimStateEvent` exists with `fromState = CONFIRMED`, `toState = OCCUPIED`, `entryId`, `actorId`, and `effectiveFrom` populated. **PASS** = both confirmed. **FAIL** = either absent or RoomClaimStateEvent missing.

**AC-S6-011:** Check-in blocked if room not in valid ready state. A test that calls `POST /entries/:id/progress-stage` with `targetStage = S6` when the assigned room is in DEPARTED_DIRTY state returns `StageGateBlockedError` with `blockingCondition: 'ROOM_NOT_READY'`. **PASS** = error returned. **FAIL** = check-in proceeds with unready room.

---

### 10.4 H1 Closure

**AC-S6-012:** H1 transitions FULFILLED→CLOSED at check-in commencement. A test that completes check-in verifies: (a) `HandoffRecord` H1 has `state = CLOSED`; (b) `closedAt` is non-null; (c) a `TraceEvent(HANDOFF.H1_CLOSED)` exists. **PASS** = all three confirmed. **FAIL** = any absent.

**AC-S6-013:** H1 closure happens at check-in commencement — before check-in completion. A test verifies H1 is CLOSED before `Entry.currentStage` transitions to S7. **PASS** = H1 CLOSED before S7 transition. **FAIL** = H1 still open when S7 entered.

**AC-S6-014:** Walk-in path has no H1. A test that completes a walk-in check-in verifies: (a) no `HandoffRecord` with `handoffType = H1` exists for the entry; (b) a `TraceEvent` recording the no-H1 walk-in path exists. **PASS** = both confirmed. **FAIL** = phantom H1 created on walk-in path.

---

### 10.5 H2 and H3 Handoffs

**AC-S6-015:** H2 created with complete content including DEFICIENT carry. For a DEFICIENT-flagged room, a test that completes check-in verifies: (a) `HandoffRecord` H2 exists; (b) `deficientConditionStatus` is non-null and carries the condition description and resolution deadline; (c) W25 acceptance timer is registered (`HandoffRecord.slaDeadlineAt` non-null). **PASS** = all three confirmed. **FAIL** = any absent.

**AC-S6-016:** H2 creation blocked if DEFICIENT condition present but deficientConditionStatus omitted. A test that calls `HandoffService.createH2()` with `deficientConditionStatus = null` when `Room.isDeficient = true` returns `PolicyGateBlockedError`. **PASS** = error returned. **FAIL** = incomplete H2 created.

**AC-S6-017:** H3 created with complete F&B obligation content. A test that completes check-in verifies: (a) `HandoffRecord` H3 exists; (b) `checklistContent` includes `mealPlan`, `dietaryRequirements`, `packageInclusions`, `guestCount`, `stayDuration`, `cuisinePreferences`; (c) W25 acceptance timer is registered. **PASS** = all three confirmed. **FAIL** = any absent.

**AC-S6-018:** Both H2 and H3 are mandatory. A test that attempts to complete check-in (S6→S7) without H2 created returns `StageGateBlockedError`. A separate test that attempts to complete check-in without H3 created returns `StageGateBlockedError`. **PASS** = both errors returned. **FAIL** = either transition succeeds without both handoffs created.

**AC-S6-019:** W25 HandoffAcceptanceWorker idempotency. A test that fires the `H2_H3_ACCEPTANCE` job twice for the same `HandoffRecord.id` where `HandoffRecord.state = ACCEPTED` verifies the second execution skips without emitting a duplicate alert. Idempotency keyed on `(HandoffRecord.id, event_phase)`. **PASS** = skip on second fire. **FAIL** = duplicate alert emitted.

**AC-S6-020:** HandoffState.REJECTED requires FOM rerouting. A test that calls `POST /handoffs/:id/reject` on an H2 verifies: (a) `HandoffRecord.state → REJECTED`; (b) FOM is alerted; (c) a new routing event is produced. There is no silent rejection. **PASS** = all three confirmed. **FAIL** = silent rejection with no FOM alert.

---

### 10.6 VIP Arrival Notification

**AC-S6-021:** VIP notification issued at commencement — not after check-in completion. A test that traces the S6 execution sequence verifies `VIPArrivalNotificationEvent.checkInInitiatedAt` is earlier than the `TraceEvent(CHECK_IN_COMPLETE)` timestamp. **PASS** = commencement timestamp precedes completion. **FAIL** = notification issued after check-in completion.

**AC-S6-022:** VIPArrivalNotificationEvent is immutable from creation. A test that attempts to update any field on an existing `VIPArrivalNotificationEvent` record is rejected. **PASS** = update rejected. **FAIL** = update applied.

**AC-S6-023:** VIP notification content correctness. A test that completes a VIP check-in verifies `VIPArrivalNotificationEvent` carries: `guestProfileId`, `roomNumber`, `vipTier`, `preferences` (snapshot), `checkInInitiatedAt`, `recipientRoles` (per `vipNotification.routingPerTier`). **PASS** = all fields populated. **FAIL** = any absent.

**AC-S6-024:** Non-VIP path produces no VIPArrivalNotificationEvent. A test that completes a non-VIP check-in verifies no `VIPArrivalNotificationEvent` record exists for the entry, but an escort completion `TraceEvent` does exist. **PASS** = no notification event; escort event present. **FAIL** = notification event created for non-VIP guest.

---

### 10.7 Walk-In Path

**AC-S6-025:** Walk-in S5 auto-fulfilment recorded. A test that completes a walk-in check-in verifies: (a) S5 passage is recorded in the audit trail; (b) all time-dependent PreArrivalTask records are in WAIVED status with `waivedReason = 'WALK_IN_COMPRESSED'`; (c) no phantom H1 HandoffRecord exists. **PASS** = all three confirmed. **FAIL** = any failed.

**AC-S6-026:** Walk-in room readiness verified in real time. A test that initiates a walk-in check-in for a room in DEPARTED_DIRTY state returns `StageGateBlockedError` with `blockingCondition: 'ROOM_NOT_READY'`. **PASS** = error returned. **FAIL** = check-in proceeds with unready room on walk-in path.

---

### 10.8 Normal Exit — S6 → S7

**AC-S6-027:** Complete normal exit path. A test that satisfies all S6 exit conditions calls `POST /entries/:id/progress-stage` with `targetStage = S7` and verifies: (a) `Entry.currentStage → S7`; (b) `StageDwellRecord.exitedAt` populated for S6; (c) `dwellSeconds` computed. **PASS** = stage progressed. **FAIL** = any exit condition gate failure or stage not updated.

**AC-S6-028:** S6 exit blocked if identity not verified. A test that calls `POST /entries/:id/progress-stage` with `targetStage = S7` without a prior verification event on `GuestProfile` returns `StageGateBlockedError` with `blockingCondition: 'IDENTITY_NOT_VERIFIED'`. **PASS** = error returned. **FAIL** = transition proceeds.

**AC-S6-029:** S6 exit blocked if folio not LIVE. A test that calls `POST /entries/:id/progress-stage` with `targetStage = S7` with `Folio.state = PROVISIONAL` returns `StageGateBlockedError` with `blockingCondition: 'FOLIO_NOT_CONVERTED'`. **PASS** = error returned. **FAIL** = transition proceeds.

**AC-S6-030:** S6 exit blocked if VIP notification not issued for VIP guest. A test for a VIP-tier guest that calls `POST /entries/:id/progress-stage` with `targetStage = S7` without a prior `VIPArrivalNotificationEvent` returns `StageGateBlockedError` with `blockingCondition: 'VIP_NOTIFICATION_NOT_ISSUED'`. **PASS** = error returned. **FAIL** = transition proceeds without notification.

---

### 10.9 Workers

**AC-S6-031:** W1 StageDwellMonitor idempotency at S6. A test that fires `STAGE_DWELL_MONITOR` twice for the same entry at S6 where `StageDwellRecord.warningFiredAt` is already set verifies the second execution skips the warning phase without error. Idempotency keyed on `(entryId, stage, event_phase)`. **PASS** = skip on second fire. **FAIL** = duplicate warning emitted.

**AC-S6-032:** W23 RoomReadinessSLAWorker skips when entry has checked in. A test that fires `ROOM_READINESS_SLA` for an entry already in S7 verifies the worker skips processing. **PASS** = skip confirmed. **FAIL** = SLA alerts emitted for checked-in entry.

---

### 10.10 Configuration

**AC-S6-033:** Missing `identity.documentTypes` raises `MissingConfigurationError`. A test that calls `POST /guest-profiles/:id/verify-identity` when `identity.documentTypes` is not configured returns `MissingConfigurationError`. **PASS** = error raised. **FAIL** = identity verification proceeds without configuration.

**AC-S6-034:** Missing `vipNotification.routingPerTier` raises `MissingConfigurationError` at VIP notification dispatch. A test with a VIP-tier guest where `vipNotification.routingPerTier` is not configured returns `MissingConfigurationError` when check-in initiates. **PASS** = error raised. **FAIL** = check-in proceeds with no routing configuration.

**AC-S6-035:** Missing `acknowledgement.windowPerType` raises `MissingConfigurationError` at H2/H3 creation. A test that calls `HandoffService.createH2()` when `acknowledgement.windowPerType` is not configured returns `MissingConfigurationError`. **PASS** = error raised. **FAIL** = H2 created without acceptance timer registration.

---

### 10.11 Re-Entry

**AC-S6-036:** S6→S1 re-entry (room change at check-in). A test that triggers room change at check-in verifies: (a) new `Segment` record created; (b) original H2 and H3 `HandoffRecord` states → CANCELLED with reason `REENTRY_S6_TO_S1`; (c) original room `currentClaimState` released via governed event; (d) `H2_H3_ACCEPTANCE` timers for original handoffs cancelled. **PASS** = all four confirmed. **FAIL** = any absent.

---

### 10.12 IP Boundary

**AC-S6-037:** This document contains no Canon section references (no `§47`, `§72`, `§79`, or similar), no DOSS principle numbers, and no FAC references in any body text. **PASS** = grep for `§[0-9]`, `DOSS`, `FAC` returns no body text matches. **FAIL** = any match found.

---

## Self-Check Results

The following self-check was performed against the session brief's 16-item checklist before presentation.

| # | Check | Result |
|---|---|---|
| 1 | Section count — exactly 10 sections, no Section 11 | PASS — Sections 1–10 present; no Section 11 |
| 2 | IP boundary — no "Canon", "DOSS", "FAC", or `§`-style section references in body text | PASS — no such references in body text |
| 3 | Vocabulary — no "Engagement" used as Inquiry synonym | PASS |
| 4 | Config key notation — dotted notation throughout; no underscore in config key names in body | PASS — all keys in dotted notation; W23 flat key converted |
| 5 | Gap marker scan — no `[GAP-`, `FINDING-`, `PENDING-` markers in body | PASS — SIG-S6-COR-001 and COR-002 are in the findings register, not as inline gap markers |
| 6 | Fallback language scan — no "until correction", "if available", "pending schema" | PASS — derived schemas are stated as positive assertions |
| 7 | Folio PROVISIONAL→LIVE — described as explicit audited event in Sections 2, 3, and 6; `FolioService.convertToLive()` named as sole path; folio never reverts | PASS — §2.5, §3.2, §6.2 all explicit; sole-path rule stated in §1.8 and §6.2 |
| 8 | H2 DEFICIENT carry — explicit in Sections 2, 4, 6, and 10 | PASS — §2.7 (H2 description), §4 (Policy 49), §6.3 (HandoffService.createH2), §10.5 (AC-S6-015, AC-S6-016) |
| 9 | H1 closure FULFILLED→CLOSED — present in Sections 3 and 6 | PASS — §3.4 (H1 state machine), §6.1 step 6 (CheckInService sequence), §6.3 (HandoffService.closeH1) |
| 10 | PricingPipelineEngine NOT called — explicit in Section 5 | PASS — §5.3 dedicated; §1.8 forbidden acts |
| 11 | VIP notification at commencement — in Sections 2 and 6 | PASS — §2.4 (timing stated), §6.1 step 4 (before folio conversion), §6.6 (VIP notification dispatch) |
| 12 | Walk-in path — documented in Sections 1 and 6 | PASS — §1.3 entry routes (walk-in path full description), §6.1 (walk-in variant in CheckInService) |
| 13 | `version` field — in all ProgressStageRequestDTO instances in Section 8 | PASS — §8.1 and §8.2 both include `version` field with MC-011 absorbed note |
| 14 | W1 and W25 — both in Section 7 with idempotency keys documented | PASS — §7 W1 idempotency keyed on `(entryId, stage, event_phase)`; W25 idempotency keyed on `(HandoffRecord.id, event_phase)` |
| 15 | OTA ack fourth loop-close condition — in Policy 52 in Section 4 | PASS — §4 Policy 52: four loop-close conditions listed including OTA auto-fulfilment |
| 16 | Version header, version history, and footer all consistent — v1.0 | PASS |

---

*SIG-S6 v1.0*
*Derived from DEV-SPEC-001 (Parts 0, 2 REV2-FINAL, 3, 4, 5 REV2, 6 REV3, 8, 9 REV1, 11, 12, 13)*
*Architect: Dhendup Cheten, Fuzzy Automation*
*14 April 2026*
