# LEGPHEL PMS — Stage Implementation Guideline
## S2: Negotiation & Quotation

**Document ID:** SIG-S2
**Version:** 1.3
**Derived from:** DEV-SPEC-001 (Parts 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13 — REV1/REV2/REV3 where applicable)
**Architect:** Dhendup Cheten, Fuzzy Automation
**Status:** DRAFT

---

## Version History

| Version | Date | Author | Status | Summary |
|---|---|---|---|---|
| 1.0 | 13 Apr 2026 | Claude (AI Architectural Partner) | Superseded | Initial generation. Derived from DEV-SPEC-001 against Canon v2.5 with SIG-S1-v1_1 as prior SIG reference. |
| 1.2 | 13 Apr 2026 | Claude (AI Architectural Partner) | **LOCKED** | Pre-lock amendment pass following S1↔S2 continuity review. Three gaps resolved: SIG-S2-COR-001 — `AvailabilityConfiguration` added to §2.8 and `QuotationService.createQuotation()` models-read list; SIG-S2-COR-002 — W20 `EntryExpiryWorker` added as §7.6; SIG-S2-COR-003 — S2→S1 back-flow added to §1.3, §3.1, and §6.3. All recorded in MASTER-CORRECTION-LOG v1.2. Locked by Architect 13 April 2026. |
| 1.3 | 13 Apr 2026 | Claude (AI Architectural Partner) | DRAFT | S3→S2 re-entry context additions. Per MOM-ARCH-2026-020 Section 4 (Q1) and SIG-S5-PRE-008: §1 entry routes, §2 schema context, §6 services, §10 acceptance criteria all updated with S3→S2 re-entry behaviour. No existing v1.2 content modified. |

---

## Source Confirmation Table

| # | Source | File | Key Sections Read |
|---|---|---|---|
| 1 | Prior SIG decisions | SIG-S1-v1_1.md | Version history; all 10 sections; locked decisions A-1 through A-7, B-1 through B-6 |
| 2 | Master Correction Log | MASTER-CORRECTION-LOG.md | Sections 1–5; BF-SVC-001/002 status confirmed |
| 3 | S2 Stage Charter | Canon_Block5_S1_S2_REV2_2.md | §43.1–43.19 full; use type variations |
| 4 | Canon Matrices | Canon_Block11_Matrices_Governance_Appendices_REV2_2.md | §72–76A — Stage-to-Policy, Stage-to-Config, Stage-to-Record, Stage-to-Timer/Worker, Transition Matrix |
| 5 | Document Identity | DEV-SPEC-001-Part1.md | §1.1–1.6 full — zero-gap standard, forbidden patterns, error taxonomy, vocabulary registry |
| 6 | Schema | DEV-SPEC-001-Part2-REV1.md | Entry, Quotation, SpeculativeHold, CommunicationRecord, StageDwellRecord, TraceEvent, ConfigurationEntry models; §2.17.3 config key table |
| 7 | State Machine | DEV-SPEC-001-Part3.md | §3.2 Entry Lifecycle; §3.5 Hold State Machine; §3.6 Inventory Claim State Machine; §3.14 Quotation State Machine |
| 8 | Engines | DEV-SPEC-001-Part4.md | §4.2 PricingPipelineEngine full; §4.10 TimerEngine full — registry and registration contract |
| 9 | Policies | DEV-SPEC-001-Part5-REV1.md | Policies 7, 19, 23, 25, 37, 52, 65, 71 |
| 10 | Services | DEV-SPEC-001-Part6-REV2.md | §6.5.3 EntryService; §6.5.16 QuotationService; §6.5.17 HoldService |
| 11 | Workers | DEV-SPEC-001-Part8.md | W1 StageDwellMonitor; W2 SpeculativeHoldExpiryWorker; W15 QuotationExpiryWorker; W22 AcknowledgementWindowWorker |
| 12 | Routes | DEV-SPEC-001-Part9-REV1.md | §9.4.6 Quotations and Holds |
| 13 | Integration Interfaces | DEV-SPEC-001-Part11.md | §11.1–11.3 EmailInterface, WhatsAppInterface; §11.8 DocumentGenerationInterface |
| 14 | Configuration | DEV-SPEC-001-Part12.md | §12.3.1 S2 Readiness table; all S2 config surfaces |
| 15 | Acceptance Gates | DEV-SPEC-001-Part13.md | §13.2–13.8; factory defaults table |

---

## Section 1 — Stage Identity

### 1.1 Stage Name and Code

**Stage 2 (S2) — Negotiation & Quotation**

### 1.2 Stage Purpose

Stage 2 exists to shape the commercial terms of an engagement — rates, discounts, inclusions, and special conditions — and to produce one or more formal quotations that the guest or agent may evaluate and accept. When S2 is correctly completed, the system holds at least one formally accepted quotation with documented commercial terms, a complete version history showing all quotation rounds, a discount governance record for any discounts applied, and a clear commercial basis ready to carry into reservation setup. Where a speculative hold was placed, the hold is recorded with its approval basis, governing timer, and risk documentation. Stage 2 does not confirm the reservation, does not lock inventory beyond speculative hold, does not create a folio, and does not collect payment. Its output is agreed commercial terms, acknowledged and preserved.

### 1.3 Entry Routes

**Forward from S1.** An entry arrives from S1 with a selected preferred availability configuration. The guest or agent wants to negotiate terms, or the selected configuration requires pricing that is not covered by a standard package rate. S2 becomes the commercial shaping stage.

**S2 auto-fulfilment (S1→S2→S3 compressed).** If the guest accepts a standard package rate without negotiation, S2 is auto-fulfilled. The system records that S2 was completed with the package rate accepted and no negotiation occurred, and the entry proceeds directly to S3. Auto-fulfilment is evidence-driven — the system verifies that the selected configuration matches a standard package rate with no modification required. The state machine sees a valid S1→S2→S3 transition. A `TraceEvent` records the auto-fulfilment passage.

**Re-entry from S3 or later.** S2 accepts re-entry from: S3 (payment renegotiation — FOM authority), S4 (rate change post-confirmation — FOM/GM authority), S7 (rate revision during stay, meal plan change, full renegotiation — GM for rate; FOM for inclusions), S8 (rate dispute at checkout — FOM/GM authority), and any stage under Complaint Resolution mode (FOM/GM depending on adjustment). Each re-entry creates a new segment. Prior segment data is preserved as read-only.

**Re-entry from S3 — rate renegotiation.** An entry at S3 returns to S2 when the guest or agent requires commercial term changes — rate renegotiation, discount adjustment, or inclusion modification — that cannot be resolved within S3's payment and commitment scope. The room type and dates are unchanged; it is the commercial terms that are being reconsidered. Authority is FOM (L2+) minimum. On this transition:

- `EntryService.createSegment()` creates a new segment. The prior segment is sealed in the same transaction.
- `ReEntryConsequenceEngine.compute()` is invoked with transition type S3→S2. Two consequences execute in the same transaction as the segment seal: `HOLD_RETAINED`, `FOLIO_CONTINUES`.
- The prior `CommittedHold` is **retained** — it remains in `PLACED` state on the sealed prior segment with its expiry timer still running. This is fundamentally different from S3→S1 where the hold is released. The hold's existing `expiresAt` serves as the natural renegotiation deadline. FOM must see the remaining hold window duration before beginning renegotiation — the urgency of renegotiation is directly tied to hold expiry.
- If the hold expires before renegotiation concludes, inventory is released and a new committed hold must be placed when the new segment returns to S3. Staff must be aware of this risk at the point of S3→S2 exit. `AvailabilityService` must run a fresh check at S3 entry on the new segment if the prior hold has expired.
- Existing proforma invoices on the Entry-level folio are **not superseded** on S3→S2. The dates and room type are unchanged, so the PIs remain broadly representative. This is a key asymmetry with S3→S1 where PIs are superseded because the commercial basis is fundamentally changing.
- The Entry-level provisional folio already exists — all prior `PaymentRecord` entries are visible. Prior payment status and PIs are read-only context on the same folio. `QuotationService` surfaces this to FOM during the renegotiation.
- Prior `AvailabilityConfiguration` from the sealed segment is recalled as context — the new quotation builds on the same room type and dates established in the prior segment's S1 passage.
- Prior `Quotation` records from the sealed segment are read-only context — FOM may start from prior commercial terms or renegotiate from scratch; either path is valid.

**Conference with existing contract.** If contract detection at S1 identified a pre-determined rate plan, S2 becomes a confirmation step — contracted terms are presented for review and acceptance. No negotiation round is required unless the client requests modifications beyond the contract coverage.

**Re-entry to S1.** If the guest requests a date change or room type change while the entry is at S2, this constitutes a reconfiguration that requires a fresh availability search — it cannot be resolved within S2's commercial shaping scope. The entry exits S2 and returns to S1 via the segment mechanism: a new `Segment` is created, the prior segment (including all `Quotation` records and the sealed `AvailabilityConfiguration`) is sealed as read-only, `ReEntryConsequenceEngine.compute()` is invoked, and the entry enters `(ACTIVE, S1)` within the new segment. All prior segment data remains accessible as read-only reference. Authority required: `ActorLevel.FRONT_DESK` (L1+) for standard date or room type change; `ActorLevel.FOM` (L2+) where the change has commercial significance or affects a committed negotiation position. Full re-entry mechanics are specified in SIG-S1 §1.3 and §3.5.

### 1.4 Exit Condition

The S2→S3 transition requires all of the following to be true. Guards are evaluated in sequence. Failure at any guard raises `StageGateBlockedError` identifying the specific unsatisfied condition.

1. At least one `Quotation` record exists in `QuotationState.ACCEPTED` for the current entry and current segment.
2. The accepted quotation's validity has not lapsed — if `Quotation.validUntil` has passed, the quotation must be revalidated before S2 exit is permitted. Revalidation re-runs the `PricingPipelineEngine` against current state and issues a new quotation version.
3. The discount approval chain is complete — any discount applied to the accepted quotation has a corresponding approval `TraceEvent` at the required authority level. An unapproved discount blocks exit.
4. If a `SpeculativeHold` was placed during S2: the hold is in `HoldState.PLACED` or `HoldState.UPGRADED` state, and if FOM approval was required for the hold (volume threshold exceeded), that approval is recorded.
5. An unacknowledged quotation that has exceeded the configured acknowledgement response window requires documented resolution before exit: a recorded verbal acceptance, a written acceptance event, or a custodian decision to proceed with a recorded reason. Within the response window, the open loop is an ambient notice only — it does not block exit.
6. No active duplicate detection flag is unresolved (carries forward from S1 entry creation guard).
7. The acting user is at minimum `ActorLevel.FRONT_DESK` (L1).

### 1.5 Governing Actors

| Role | Actor Level | Authority at S2 |
|---|---|---|
| Receptionist / Reservations | `ActorLevel.FRONT_DESK` (L1) | Creates quotations; sends quotations; records guest acceptance; applies discounts within configured front desk threshold; parks and unparks entries; places speculative holds within standard threshold |
| Front Office Manager | `ActorLevel.FOM` (L2) | All L1 actions; approves discounts exceeding front desk threshold; approves speculative holds exceeding volume threshold; releases speculative holds; adjudicates unacknowledged quotation open loops at exit |
| General Manager | `ActorLevel.GM` (L3) | All L2 actions; approves discounts exceeding FOM authority band; approves rates below MSR; approves FOC entitlement on group quotations |
| Admin | `ActorLevel.ADMIN` (L4) | Configuration only — not an operational actor at S2 |

**Note on speculative hold authority:** Policy 25 governs approval thresholds. A route accepting `L1+` does not mean L1 authority is always sufficient — the service evaluates whether the requested hold volume or commercial significance exceeds the front desk threshold, in which case FOM escalation is required before the hold record is created.

### 1.6 Forbidden Actions at S2

The following must not occur during S2. Each is an architectural violation if implemented.

**No committed hold.** Only speculative holds are permitted at S2. A `CommittedHold` record may not be created at S2. Committed holds require the commercial justification that comes with S3 reservation setup.

**No folio creation.** No `Folio` record may exist for an entry in S2. Folio creation belongs to S3.

**No payment collection or recording.** No `PaymentRecord` may be created at S2. No payment event of any kind.

**No billing model fixation.** The billing model is fixed at S3. No billing model may be set, selected, or communicated as final at S2.

**No confirmation language.** A quotation may say "upon acceptance and payment, this will be confirmed." It may not say "your reservation is confirmed," "your booking is secured," or any language that constitutes a commercial confirmation. Confirmation belongs to S4.

**No bypassing the PricingPipelineEngine.** Every rate in every quotation is resolved through the engine. Manual rate entry that circumvents the engine's resolution logic is forbidden. If a rate outside the engine's output is needed, it is processed as a discount or override with the appropriate approval chain.

**No verbal rate promises outside the quotation system.** Every quotation sent to a guest or agent must be a system-generated document with a tracked communication event. Verbal rate promises that bypass the quotation system create untrackable commitments and are forbidden.

**No room-specific assignment promises.** S2 may discuss room types and categories but may not promise a specific room number. Room assignment is S5's responsibility.

---

## Section 2 — Schema Models Active at S2

The following models are read or written during S2 operations. Only fields touched during S2 are called out. The full schema with all fields and relations is in Part 2.

**On negotiation history and discount governance:** The quotation version chain — each new quotation version superseding the prior — is the negotiation round record. Q-001 superseded by Q-002, superseded by Q-003 is the complete negotiation history. Discount approvals are captured as `TraceEvent` records emitted in the same transaction as `QuotationService.applyDiscount()`. No separate NegotiationRecord or DiscountApprovalRecord model exists or is required.

---

### 2.1 Entry

**Access at S2:** Read and written. Stage progression and park state are the primary write operations.

**S2-relevant fields:**

```prisma
model Entry {
  id                   String          @id @default(uuid())
  inquiryId            String          // immutable — no re-parenting
  segmentNumber        Int             // incremented on re-entry
  useType              EntryUseType    // immutable after creation — GROUP triggers group quotation path
  status               EntryStatus     // ACTIVE | PARKED at S2; no terminal transitions at S2 via staff action
  currentStage         Stage           // S2 while in this stage; updated to S3 on exit
  checkInDate          DateTime?
  checkOutDate         DateTime?
  guestCount           Int?
  otaSource            Boolean         // immutable — read at S2 for pricing context
  groupBillingMode     GroupBillingMode? // set on GROUP entries; governs billing split at later stages
  parkedAt             DateTime?
  parkedBy             String?
  parkedIndividually   Boolean         @default(false) // governs unpark eligibility on inquiry-level unpark
  version              Int             @default(1)     // optimistic lock field — not yet in Part 2-REV1; will be added in Part 2 REV2
  createdAt            DateTime
  updatedAt            DateTime
  createdBy            String
}
```

**S2 mutation rule:** `currentStage` updated from S2 to S3 on exit (in the same transaction as `StageDwellRecord.exitedAt`). `status` may transition between ACTIVE and PARKED via park/unpark operations. No other fields are written at S2 by staff action. `version` is incremented on every `Entry` update for optimistic locking.

---

### 2.2 Quotation

**Access at S2:** Created and written. The primary S2 entity.

**S2-relevant fields:**

```prisma
model Quotation {
  id              String          @id @default(uuid())
  entryId         String          // immutable
  segmentId       String          // immutable — links to the current segment
  versionNumber   Int             @default(1)     // 1 for Q-001; increments per new version
  referenceNumber String          // e.g., Q-001, Q-002 — human-readable
  state           QuotationState  @default(DRAFT)
  // DRAFT: editable; SENT: sealed; ACCEPTED: sealed; SUPERSEDED: sealed; EXPIRED: sealed
  commercialTerms Json            // rate, inclusions, discount basis, special conditions, FOC allocation for group
  totalAmount     Decimal         @db.Decimal(15,2)
  currency        String          @default("BTN")
  validUntil      DateTime?       // populated on send; governs validity timer
  sentAt          DateTime?       // populated on send; triggers QUOTATION_VALIDITY and QUOTATION_ACK_TRACKER timers
  sentTo          String?         // recipient reference
  supersededById  String?         // ID of the quotation that superseded this version
  supersededAt    DateTime?
  expiredAt       DateTime?       // populated by QuotationExpiryWorker
  acceptedAt      DateTime?       // populated on guest acceptance
  acceptedBy      String?         // actor_id of the staff member recording acceptance
  folioId         String?         // linked at S3 for financial narrative traceability
  createdAt       DateTime
  createdBy       String          // actor_id — NOT NULL
}
```

**S2 mutation rule:** DRAFT is editable until sent. Send seals the quotation — no further in-place edits to a sent quotation. Creating a new version transitions the prior version to SUPERSEDED in the same transaction. All versions are sealed on S2 exit regardless of their individual state. An ACCEPTED quotation is the basis for S2→S3 progression.

**Timer obligations (set on send):**
- `QUOTATION_VALIDITY` timer registered via `TimerEngine.register()` — fires at `validUntil`; dispatches to `QuotationExpiryWorker` (W15).
- `QUOTATION_ACK_TRACKER` timer registered via `TimerEngine.register()` — fires when the acknowledgement response window expires; dispatches to `QuotationAckWorker`.

**Timer cancellation obligations:**

| Event | Cancel QUOTATION_VALIDITY timer | Cancel QUOTATION_ACK_TRACKER timer |
|---|---|---|
| Quotation accepted | Yes — validity monitoring no longer needed | Yes — acceptance closes the ack loop |
| Quotation superseded (new version created) | Yes — prior version no longer active | Yes — prior version no longer active |
| Validity timer fires (quotation expires) | Already fired | Yes — moot; cancel if still running |
| Ack tracker fires (response window exceeded) | No — validity still live | Already fired |

Both cancellation calls are part of the same service transaction as the triggering event.

---

### 2.3 SpeculativeHold

**Access at S2:** Created and written. Optional — only if a speculative hold is placed.

**S2-relevant fields:**

```prisma
model SpeculativeHold {
  id            String    @id @default(uuid())
  entryId       String
  segmentId     String
  roomId        String?   // null for space-based holds (conference/catering)
  spaceId       String?   // null for room-based holds
  state         HoldState @default(PLACED)
  // PLACED: active; RELEASED: released by expiry or staff action; UPGRADED: converted to CommittedHold at S3
  placedAt      DateTime
  placedBy      String    // FOM or GM actor_id — NOT NULL; L1 may place within threshold
  ttlSeconds    Int       // set at placement from speculativeHold.placementThresholds configuration
  expiresAt     DateTime  // absolute timestamp — drives the SPECULATIVE_HOLD_EXPIRY timer
  releasedAt    DateTime? // populated on RELEASED
  releasedBy    String?   // actor_id or SYSTEM
  releaseReason String?   // EXPIRY | CANCELLATION | UPGRADED
  upgradedToId  String?   // CommittedHold.id — populated on UPGRADED at S3
  notes         String?
  createdAt     DateTime
}
```

**S2 mutation rule:** Created on hold placement. `notes` and timer extension (within authority) are editable while PLACED. Release is a governed event — silent expiry without a permanent audit record is a forbidden pattern. `SPECULATIVE_HOLD_EXPIRY` timer registered via `TimerEngine.register()` at hold placement; fires at `expiresAt`; dispatches to `SpeculativeHoldExpiryWorker` (W2). On UPGRADED (at S3): `SpeculativeHold.state → UPGRADED`, `upgradedToId` populated, `SPECULATIVE_HOLD_EXPIRY` timer cancelled.

---

### 2.4 CommunicationRecord

**Access at S2:** Created on quotation send and on any other outbound or inbound communication during S2. Immutable from creation.

**S2-relevant fields:**

```prisma
model CommunicationRecord {
  id                        String                @id @default(uuid())
  entryId                   String?
  segmentId                 String?
  inquiryId                 String?
  channel                   CommunicationChannel  // EMAIL | WHATSAPP
  messageType               MessageType           @default(STANDARD)
  messageId                 String?               // external provider message ID — idempotency key
  threadId                  String?
  inReplyToId               String?
  linkedStage               Stage?                // S2 when created at S2
  contentSummary            String                // summary only — full content stored via FileStorageInterface
  sendStatus                SendStatus            @default(DRAFT)
  acknowledgementStatus     AcknowledgementStatus @default(PENDING)
  // PENDING: awaiting response; RECEIVED: guest acknowledged; TIMED_OUT: window expired without acknowledgement
  acknowledgementReceivedAt DateTime?
  acknowledgementTimeoutAt  DateTime?             // absolute timestamp for the ACKNOWLEDGEMENT_WINDOW timer
  isSuperseded              Boolean               @default(false)
  direction                 String                // INBOUND | OUTBOUND
  actorId                   String                // sender or SYSTEM — NOT NULL
  createdAt                 DateTime
}
```

**S2 mutation rule:** Immutable from creation. A correction or follow-up produces a new `CommunicationRecord`. The `ACKNOWLEDGEMENT_WINDOW` timer (`AcknowledgementWindowWorker` — W22) is registered via `TimerEngine.register()` when an outbound quotation communication is dispatched via `CommunicationService.send()`. On acknowledgement received, `acknowledgementStatus → RECEIVED` and the timer is cancelled. On timer fire, `acknowledgementStatus → TIMED_OUT`.

**Document generation at S2:** When a quotation is sent, `DocumentGenerationInterface.generate(DocumentType.QUOTATION_DOCUMENT, input)` is called before dispatch. The generated document is stored via `FileStorageInterface` and linked to this `CommunicationRecord`. The `storageReference` from the result is included as an attachment in the outbound send call.

---

### 2.5 StageDwellRecord

**Access at S2:** Created on S2 entry. Written by `StageDwellMonitor` (W1) throughout the dwell period. Sealed on S2 exit.

**S2-relevant fields:**

```prisma
model StageDwellRecord {
  id              String          @id @default(uuid())
  entryId         String
  stage           Stage           // S2
  enteredAt       DateTime        // populated on S2 entry
  lastActiveAt    DateTime
  exitedAt        DateTime?       // populated in the S2→S3 transition transaction
  dwellSeconds    Int?            // computed on exit
  mode            StageDwellMode  @default(ACTIVE)
  warningFiredAt  DateTime?
  criticalFiredAt DateTime?
  escalatedAt     DateTime?
  createdAt       DateTime
}
```

**S2 mutation rule:** Created when entry enters S2. Mode transitions written by `StageDwellMonitor`. `exitedAt` and `dwellSeconds` populated in the S2→S3 transition transaction. S2 dwell thresholds are mode-dependent — Normal Booking mode tolerates extended negotiation; Complaint Resolution mode has tighter thresholds. Factory defaults: S2 idle warning at 4 hours; S2 idle critical at 8 hours (both mode-dependent).

---

### 2.6 TraceEvent

**Access at S2:** Append-only. Written in the same Prisma transaction as every state change. Never updated or deleted under any circumstance.

```prisma
model TraceEvent {
  id              String    @id @default(uuid())
  eventType       String    // canonical event type name
  actorId         String    // NOT NULL — specific actor or SYSTEM
  actorLevel      ActorLevel
  entityType      String    // NOT NULL
  entityId        String    // NOT NULL
  operation       String    // CREATE | UPDATE | SEAL | TRANSITION | RELEASE | EXPIRE | etc.
  payload         Json      // structured — never freeform string
  timestamp       DateTime  // caller-set explicitly — never Date.now() inside engine or worker
  stageContext    Stage?    // S2
  segmentContext  String?
  correlationId   String?
  inquiryId       String?
  entryId         String?
  createdAt       DateTime
}
```

**S2 mutation rule:** Append-only. Every S2 state change, every policy enforcement event, every timer fire, and every worker action emits a `TraceEvent` in the same transaction as the change. `AuditService.emit()` is the sole write path — services and workers do not write `TraceEvent` records directly.

---

### 2.7 ConfigurationEntry

**Access at S2:** Read by services and workers at runtime using a date-range query. Not written by operational code.

```prisma
model ConfigurationEntry {
  id            String    @id @default(uuid())
  configKey     String    // canonical dotted-notation key
  configValue   Json
  effectiveFrom DateTime
  effectiveTo   DateTime? // null = currently active
  setBy         String    // ADMIN level — NOT NULL
  setAt         DateTime
  notes         String?
  createdAt     DateTime

  @@index([configKey, effectiveFrom])
}
```

**S2 mutation rule:** Read-only at runtime. Admin Console writes only. Always queried with date-range filter: `effectiveFrom <= now AND (effectiveTo IS NULL OR effectiveTo > now)`. Never queried with a simple `findFirst` by key alone.

---

### 2.8 AvailabilityConfiguration

**Access at S2:** Read-only. Sealed at S1 exit — `sealedAt` is populated in the same transaction as the S1→S2 stage transition and the record is immutable from that point forward.

**Role at S2:** The preferred configuration (where `optionSelected` is not null) is the primary handoff artifact from S1. It provides the `roomTypeId` that `QuotationService.createQuotation()` injects into `PricingPipelineEngine.resolve()` via `PricingInput`. No quotation can be created without a resolved `roomTypeId`, and no `roomTypeId` exists on the `Entry` model directly — it is sourced exclusively from the sealed preferred `AvailabilityConfiguration`.

**S2-relevant fields:**

```prisma
model AvailabilityConfiguration {
  id              String    @id @default(uuid())
  entryId         String    // links to the entry
  segmentId       String    // links to the current segment
  optionSelected  Boolean   @default(false)  // true on the preferred configuration
  sealedAt        DateTime? // populated at S1→S2 transition — immutable thereafter
  isStale         Boolean   @default(false)  // read at S2 to detect a configuration that became stale before sealing
  searchCriteria  Json      // the query used to produce this configuration — includes roomTypeId
  resultSnapshot  Json      // the availability result at time of search
  deficientAcknowledgements Json? // staff acknowledgements of DEFICIENT flags
  createdAt       DateTime
  createdBy       String
}
```

**S2 mutation rule:** No writes at S2. The configuration is sealed on S1 exit. If the guest requests a room type or date change during S2, this constitutes a S2→S1 re-entry (new segment); the prior configuration remains sealed in the prior segment and a new `AvailabilityConfiguration` is created in the new S1 segment.

**Consumption pattern at S2:** `QuotationService.createQuotation()` reads the entry's preferred `AvailabilityConfiguration` (where `optionSelected = true` and `segmentId` matches the current segment) to extract `searchCriteria.roomTypeId` for injection into `PricingInput`. This read occurs before `PricingPipelineEngine.resolve()` is called.

---

### 2.9 Re-Entry Context from S3→S2

On S3→S2 re-entry, the following are available as read-only context from the prior segment:

- **CommittedHold** — the prior segment's committed hold remains in `PLACED` state with its expiry timer running. It is not released on S3→S2. The hold's `expiresAt` is the primary urgency signal for FOM — renegotiation must conclude before this deadline or inventory is lost. The `CommittedHold` record is on the prior (sealed) segment; the new segment does not own it but must surface its `expiresAt` to the FOM as renegotiation context.
- **Folio** — the Entry-level provisional folio is in `PROVISIONAL` state with all prior `PaymentRecord` entries and proforma invoices intact. PIs are not superseded on S3→S2 (unlike S3→S1). The total advance payments already received (sum of `PaymentRecord` entries with `paymentDirection = 'IN'` on the Entry-level folio) are surfaced to FOM during renegotiation. If the total already meets or exceeds the new quotation's advance payment threshold, the advance payment condition is pre-satisfied for the new S3 passage.
- **Quotation** — the prior segment's quotation records are sealed and read-only. They serve as the starting context for renegotiation — FOM may reference prior commercial terms, discount history, and negotiation rounds when shaping new terms.
- **AvailabilityConfiguration** — the prior segment's sealed preferred configuration provides the room type and date context that carries into the new quotation. Since S3→S2 does not involve room type or date changes, this configuration remains the reference for pricing.

When the new segment creates a quotation via `QuotationService.createQuotation()`, the service reads the prior hold's `expiresAt` and the existing folio's payment status and surfaces both in the quotation creation context.

When the new segment reaches S3, `FolioService.getOrCreate()` returns the existing Entry-level folio — no new folio is created. If the prior hold is still in `PLACED` state at S3 entry, `HoldService` checks for the active prior-segment hold before placing a new one — the existing hold is upgraded rather than duplicated.

---

## Section 3 — State Machine at S2

### 3.1 Entry Status Transitions at S2

The `Entry` state is a composite of `Entry.status` and `Entry.currentStage`. Valid composite states during S2:

| Composite State | Meaning |
|---|---|
| `(ACTIVE, S2)` | Entry is actively in S2 — normal operating state |
| `(PARKED, S2)` | Entry has been parked while at S2 — governed temporary hold; quotation may be in-flight |
| `(EXPIRED, —)` | Terminal — entry exceeded expiry threshold; not reversible |

**S2 transitions:**

| From | To | Trigger | Authority | Guard |
|---|---|---|---|---|
| `(ACTIVE, S1)` | `(ACTIVE, S2)` | S1→S2 stage progression | L1+ | All S1 exit evidence present |
| `(ACTIVE, S2)` | `(ACTIVE, S3)` | S2→S3 stage progression | L1+ | All S2 exit evidence present per §1.4 |
| `(ACTIVE, S1)` | `(ACTIVE, S3)` | S2 auto-fulfilment | L1+ | Package rate accepted without negotiation; `TraceEvent` records S2 auto-fulfilled passage |
| `(ACTIVE, S2)` | `(PARKED, S2)` | Entry-level park | L1+ | `Entry.status = ACTIVE` |
| `(PARKED, S2)` | `(ACTIVE, S2)` | Entry-level unpark | L1+ | Park provenance check — see §3.3 |
| `(ACTIVE, S2)` | `(EXPIRED, —)` | `EntryExpiryWorker` fires | SYSTEM | TTL threshold reached |
| `(ACTIVE, S2)` | `(ACTIVE, S1, new segment)` | Date or room type reconfiguration request | L1+ / L2+ | `ReEntryConsequenceEngine.compute()` called; new `Segment` created; prior segment sealed; see SIG-S1 §3.5 |

**Guard failure behaviour:** Any guard failure raises `StageGateBlockedError` identifying the specific unsatisfied condition, the stage, and whether an override path is available.

### 3.2 Guard Conditions for S2→S3 Exit

All conditions evaluated in sequence. First failure stops evaluation and surfaces a typed `StageGateBlockedError`.

1. **Source state match.** `Entry.currentStage = S2` and `Entry.status = ACTIVE`.
2. **Accepted quotation exists.** At least one `Quotation` in `QuotationState.ACCEPTED` exists for the current entry and current segment.
3. **Accepted quotation not expired.** `Quotation.validUntil` has not lapsed. If lapsed: the quotation must be revalidated — `PricingPipelineEngine` re-run, new quotation version issued and accepted — before exit is permitted.
4. **Discount approval chain complete.** Every discount applied to the accepted quotation has a corresponding approval `TraceEvent` at the required authority level. An unapproved discount blocks exit unconditionally.
5. **Speculative hold in valid state.** If a `SpeculativeHold` was placed: `state = PLACED` or `state = UPGRADED`. A speculative hold whose FOM approval was requested but not yet granted blocks exit.
6. **Acknowledgement open loop resolved if window exceeded.** If the accepted quotation's `CommunicationRecord` has `acknowledgementStatus = TIMED_OUT` (window exceeded without guest response), a resolution record must exist — verbal acceptance, written acceptance, or custodian decision to proceed with recorded reason. Within the window, open loop is ambient notice only.
7. **Actor authority.** Acting user is at minimum `ActorLevel.FRONT_DESK` (L1).

### 3.3 Parking Mechanics at S2

**Entry-level park.** `Entry.status → PARKED`. `Entry.parkedAt`, `Entry.parkedBy`, and `Entry.parkedIndividually = true` are set. A `TraceEvent` is emitted. The park does not affect any in-flight quotation — the quotation's validity timer continues to run. Staff must monitor quotation expiry while the entry is parked.

**Entry-level unpark.** Clears `Entry.status`, `Entry.parkedAt`, `Entry.parkedBy`, and resets `Entry.parkedIndividually = false`. A `TraceEvent` is emitted.

**Inquiry-level park cascade.** Cascades to all active non-terminal entries where `Entry.parkedIndividually = false`. Entries already individually parked are not doubly-parked.

**Inquiry-level unpark.** Does not unpark entries where `Entry.parkedIndividually = true`. Only entries parked as a consequence of the inquiry-level cascade are eligible for inquiry-level unpark. An entry that was individually parked before the inquiry cascade remains `(PARKED, S2)` after inquiry-level unpark.

**S2-specific context:** A quotation may be in-flight (SENT, awaiting guest response) when an entry is parked at S2. The quotation validity timer continues independently of the park state. If the quotation expires while the entry is parked, staff must issue a new quotation on unpark before S2 exit is possible.

### 3.4 Quotation State Machine

**Model:** `Quotation` | **State field:** `Quotation.state: QuotationState`

```
enum QuotationState {
  DRAFT
  SENT
  ACCEPTED
  SUPERSEDED
  EXPIRED
}
```

**Transitions:**

| From | To | Trigger | Authority | Guards / Notes |
|---|---|---|---|---|
| — | DRAFT | Quotation created | L1+ | Entry must be in `(ACTIVE, S2)` |
| DRAFT | SENT | `QuotationService.sendQuotation()` | L1+ | Document generated; `CommunicationRecord` created; QUOTATION_VALIDITY and QUOTATION_ACK_TRACKER timers registered; quotation sealed — no further in-place edits |
| SENT | ACCEPTED | `QuotationService.acceptQuotation()` | L1+ | Guest acceptance recorded; QUOTATION_VALIDITY and QUOTATION_ACK_TRACKER timers cancelled in same transaction; `acceptedAt` and `acceptedBy` populated |
| DRAFT | SUPERSEDED | New quotation version created | L1+ | Prior version sealed; `supersededById` populated; QUOTATION_VALIDITY and QUOTATION_ACK_TRACKER timers on prior version cancelled if set |
| SENT | SUPERSEDED | New version created after sending | L1+ | Prior version sealed; QUOTATION_VALIDITY and QUOTATION_ACK_TRACKER timers on prior version cancelled |
| SENT | EXPIRED | `QuotationExpiryWorker` (W15) fires at `validUntil` | SYSTEM | `Quotation.state → EXPIRED`; `expiredAt` populated; QUOTATION_ACK_TRACKER timer cancelled if still running |

**Versioning:** All versions are preserved and read-only once superseded. The active quotation is the non-SUPERSEDED, non-EXPIRED version. If all versions are SUPERSEDED or EXPIRED, a new quotation must be created. An EXPIRED quotation is recallable with revalidation — `PricingPipelineEngine` re-run, new version issued.

**Sealing on S2 exit:** All quotation versions for the current segment are sealed in the same transaction as the S2→S3 stage transition. After sealing they remain readable but cannot be edited.

### 3.5 Speculative Hold State Machine

**Model:** `SpeculativeHold` | **State field:** `SpeculativeHold.state: HoldState`

```
enum HoldState {
  PLACED     // active; timer running
  RELEASED   // released by expiry or explicit staff action — permanent
  UPGRADED   // converted to CommittedHold at S3 — permanent
}
```

**Transitions:**

| From | To | Trigger | Authority | Notes |
|---|---|---|---|---|
| — | PLACED | `HoldService.placeSpeculativeHold()` | L1+ (L2+ if volume threshold exceeded) | `Room.currentClaimState → SPECULATIVELY_HELD`; `RoomClaimStateEvent` written; `SPECULATIVE_HOLD_EXPIRY` timer registered |
| PLACED | RELEASED | `SpeculativeHoldExpiryWorker` (W2) fires | SYSTEM | Timer expiry; inventory → FREE; `RoomClaimStateEvent` written; staff alerted |
| PLACED | RELEASED | `HoldService.releaseSpeculativeHold()` | L2+ | Explicit staff cancellation; `releaseReason = CANCELLATION`; `RoomClaimStateEvent` written; `SPECULATIVE_HOLD_EXPIRY` timer cancelled |
| PLACED | UPGRADED | `HoldService.placeCommittedHold()` at S3 | L1+ | New `CommittedHold` created; `SpeculativeHold.state → UPGRADED`; `upgradedToId` populated; `SPECULATIVE_HOLD_EXPIRY` timer cancelled; inventory → COMMITTED_HELD |

**All releases are governed events.** Silent expiry — where a hold lapses without a permanent `RoomClaimStateEvent` and `TraceEvent` — is a forbidden pattern.

**Inventory claim state transitions at S2:**

| Inventory Claim State Change | Trigger |
|---|---|
| FREE → QUOTED | Quotation issued covering this room for the date range |
| FREE → SPECULATIVELY_HELD | Speculative hold placed |
| QUOTED → SPECULATIVELY_HELD | Speculative hold placed over existing QUOTED claim |
| SPECULATIVELY_HELD → FREE | Hold released (expiry or explicit cancellation) |

The QUOTED → SPECULATIVELY_HELD displacement evaluates the configurable displacement threshold. Below the threshold, displacement proceeds. Above the threshold, FOM or GM approval is required before the displacement takes effect.

### 3.6 Re-Entry Mechanics at S2

When an entry returns to S2 from a later stage:

1. A new `Segment` is created. `Entry.segmentNumber` is incremented. `ReEntryConsequenceEngine.compute()` is invoked on segment creation.
2. The prior segment is sealed and read-only. All prior quotation versions within that segment remain queryable as historical reference.
3. The entry enters `(ACTIVE, S2)` within the new segment. S2 operations commence fresh within the new segment context.
4. Any `SpeculativeHold` from a prior segment is not automatically inherited — the re-entry context determines whether a hold must be placed again.
5. Any in-flight `Quotation` from a prior segment in `QuotationState.SENT` is sealed as part of the segment seal — it does not carry its validity timer into the new segment.

---

## Section 4 — Policies Enforced at S2

### Policy 7 — Quotation Validity Policy

- **Trigger condition:** A `Quotation` is sent (`QuotationService.sendQuotation()`). The validity window begins at `sentAt`.
- **Enforcement point:** `QuotationExpiryWorker` (W15) — timer-fired; calls `QuotationService.expire()`; `Quotation.state → EXPIRED`; `expiredAt` populated; `QUOTATION_ACK_TRACKER` timer cancelled if still running; operator notified.
- **Decision type:** Enforcement event — when the validity timer fires, the state transition is unconditional.
- **Hardcoded behaviour:** An EXPIRED quotation cannot be used as the basis for S2→S3 exit without explicit revalidation. Revalidation re-runs `PricingPipelineEngine.resolve()` against current state before a new quotation version is issued. Expiry is always a governed event with a permanent `TraceEvent`.
- **Configurable parameters:** Quotation validity window — from `ConfigurationEntry` with key `expiry.s2.quotationValidityDays`. Factory default: 48 hours from send.

---

### Policy 19 — Rate Plan Resolution Policy (Primary at S2)

- **Trigger condition:** `QuotationService.createQuotation()` or `QuotationService.createGroupQuotation()` is called. Rate must be resolved before the quotation record is written.
- **Enforcement point:** `QuotationService.createQuotation()` and `QuotationService.createGroupQuotation()` — `PricingPipelineEngine.resolve()` is invoked before the `Quotation` record is written. The engine result determines the quoted rate. No quotation may be created without a resolved rate.
- **Decision type:** APPROVED (rate resolved; `PricingResult` returned; quotation written) | DENIED (no applicable rate plan; `MissingConfigurationError`).
- **Hardcoded behaviour:** Rate plan priority order is invariant: individual-level agreements → promotional → tier → channel → rack. This order cannot be altered by configuration. Deterrent rate auto-assignment for CAUTION/RESTRICTED guest tiers applies silently — the rate plan type `DETERRENT` must not be surfaced in any guest-facing communication. MSR validation: the resolved rate must be ≥ MSR. If the resolved rate falls below MSR after any discount or override, the engine returns `belowMsr: true` and GM approval is required before the quotation can be issued.
- **Configurable parameters:** All rate values within rate plans; MSR per rate plan; deterrent rate value; season calendar boundaries; discount thresholds per authority level; override margin per rate plan (stored on `RatePlan` model, not `ConfigurationEntry`); group volume bands and rate multipliers.

---

### Policy 23 — Discount Approval Policy

- **Trigger condition:** `QuotationService.applyDiscount()` is called.
- **Enforcement point:** `QuotationService.applyDiscount()` — policy evaluated before discount is applied to quotation; escalation approval `TraceEvent` recorded before discount is written.
- **Decision type:** APPROVED (`ActorLevel.FRONT_DESK` within configured front desk threshold) | ESCALATE(`ActorLevel.FOM`) (discount exceeds front desk threshold but within FOM authority band) | ESCALATE(`ActorLevel.GM`) (discount exceeds FOM authority band).
- **Hardcoded behaviour:** The discount approval chain must be complete before the quotation is sent. A quotation containing an unapproved discount is not a valid quotation for S2→S3 exit. The approval event is immutable — it cannot be retrospectively revoked.
- **Configurable parameters:** Discount thresholds per authority level — from `ConfigurationEntry` with keys `discount.fom.maxPercentage` and `discount.gm.maxPercentage`.

---

### Policy 25 — Speculative Hold Placement Policy

- **Trigger condition:** `HoldService.placeSpeculativeHold()` is called.
- **Enforcement point:** `HoldService.placeSpeculativeHold()` — policy evaluated before `SpeculativeHold` record is created and `Room.currentClaimState` is updated; hold timer registered with `TimerEngine.register()` on APPROVED.
- **Decision type:** APPROVED (inventory available; policy conditions met; `SpeculativeHold` created) | DENIED (inventory not available; claim state blocks hold) | ESCALATE(`ActorLevel.FOM`) (hold request exceeds front desk authority — volume or commercial significance threshold exceeded).
- **Hardcoded behaviour:** A speculative hold does not guarantee inventory. It sets `InventoryClaimState.SPECULATIVELY_HELD` and starts a governed timer. A speculative hold may not be placed at S1 — hold placement is a S2 action only. Escalation to FOM is triggered by the placement policy threshold, not by the route auth level — the route accepts L1+ but the service evaluates the threshold.
- **Configurable parameters:** Speculative hold placement thresholds — from `ConfigurationEntry` with key `speculativeHold.placementThresholds` (Json: volume thresholds per authority level, maximum concurrent holds per source type, escalation rules).

---

### Policy 37 — FOC Entitlement Calculation Policy (Group path only)

- **Active condition:** Entry `useType = GROUP` or guest count triggers group classification. This policy fires on the group quotation path only. It does not fire for non-group quotations.
- **Trigger condition:** `QuotationService.createGroupQuotation()` is called.
- **Enforcement point:** `QuotationService.createGroupQuotation()` — calls `FOCValidationEngine.validate()` to evaluate entitlement before FOC rooms are included in the quotation. If `FOCValidationResult.isValid = false`, the quotation is not created.
- **Decision type:** APPROVED (entitlement calculated; FOC rooms determined; GM approval required before inclusion) | DENIED (group size below minimum FOC threshold) | ESCALATE(`ActorLevel.GM`) (FOC allocation requires GM approval before inclusion in quotation).
- **Hardcoded behaviour:** FOC room rate must be above MSR — FOC does not override the MSR floor. GM approval must be recorded before FOC allocation is confirmed and included in the quotation.
- **Configurable parameters:** FOC entitlement formula (per-N-rooms, or per contract terms); seasonality restrictions on FOC; FOC configuration per rate plan — from `ConfigurationEntry` with key `foc.configuration`.

---

### Policy 52 — Communication Acknowledgement Tracking Policy

- **Trigger condition:** `CommunicationService.send()` dispatches an outbound quotation communication.
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on outbound send; `TimerEngine.register()` called for both `ACKNOWLEDGEMENT_WINDOW` (W22) and, where applicable, the quotation-specific ack timer; `CommunicationRecord.acknowledgementStatus` initialised to `PENDING`.
- **Decision type:** Enforcement rule — every outbound communication that requires acknowledgement opens a tracked loop. The loop closes on: explicit acknowledgement received (`AcknowledgementStatus.RECEIVED`), or governed timeout (`AcknowledgementStatus.TIMED_OUT`).
- **Hardcoded behaviour:** Every governed outbound communication has a tracked acknowledgement state — PENDING, RECEIVED, or TIMED_OUT. There is no governed outbound communication without an acknowledgement state. `TIMED_OUT` is recorded as a permanent flag on the communication record — non-acknowledgement is a visible open item, never silently discarded.
- **Configurable parameters:** Acknowledgement window per communication type — from `ConfigurationEntry` with key `acknowledgement.windowPerType` (Json: object keyed by communication type identifier with window duration in seconds). For quotation type: factory default 24 hours.

---

### Policy 65 — Group Rate Application Policy (Group path only)

- **Active condition:** Entry `useType = GROUP` or guest count triggers group classification.
- **Trigger condition:** `QuotationService.createGroupQuotation()` is called.
- **Enforcement point:** `QuotationService.createGroupQuotation()` — calls `PricingPipelineEngine.resolve()` with group context; group volume band applied in rate resolution; Policy 37 (FOC entitlement) initiated.
- **Decision type:** APPROVED (group rate resolved; volume band applied) | ESCALATE(`ActorLevel.FOM`) (group rate requires FOM approval for non-standard commercial terms).
- **Hardcoded behaviour:** Group rate resolution follows the same invariant priority order as individual bookings — individual agreements → promotional → tier → channel → rack. Group volume bands are applied within the engine — they do not override the priority order.
- **Configurable parameters:** Group size volume bands and associated rate multipliers; group rate discounts within configured limits — from rate plan registry.

---

### Policy 71 — Processing Lock TTL Policy

- **Active at S2:** Processing locks may be in place from S1 (inventory selection during availability configuration). The lock TTL policy carries through to S2 — any active lock at the start of S2 may expire during S2 operations.
- **Trigger condition:** `ProcessingLockService.placeLock()` called at any stage where inventory is being selected; `ProcessingLockExpiryWorker` (W16) fires at TTL expiry.
- **Enforcement point:** `ProcessingLockService.placeLock()` — `ProcessingLockRecord` created; `TimerEngine.register()` called for TTL. `ProcessingLockExpiryWorker` (W16, cross-stage) transitions `ProcessingLockRecord.status → EXPIRED` and dispatches expiry notification.
- **Hardcoded behaviour:** A processing lock is not a commercial hold — it does not alter `Room.currentClaimState`. Silent expiry is forbidden. No heartbeat or renewal mechanism — TTL is unconditional. Expiry notification text is governance language, hardcoded: "Your inventory hold has expired — please reconfirm availability before proceeding." Reconfirmation creates a new `ProcessingLockRecord`; a `RevalidationDeltaRecord` is created capturing what changed during the TTL window.
- **Configurable parameters:** Lock TTL per channel — from `ConfigurationEntry` with key `processingLock.ttl.perChannel` (Json: EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE — all four must be present).

---

## Section 5 — Engines Invoked at S2

### 5.1 PricingPipelineEngine

**Purpose:** Resolves the applicable rate plan for a given booking context, applies discounts or overrides within governed bounds, validates the resolved rate against the Minimum Sell Rate (MSR), and produces the authoritative pricing basis for the quotation. It is the sole mechanism through which a rate is determined at S2. Manual rate entry that bypasses this engine is a forbidden pattern.

**Primary method signature:**
```typescript
PricingPipelineEngine.resolve(input: PricingInput): PricingResult
```

**Which service calls it and under what condition:**

`QuotationService.createQuotation()` calls `PricingPipelineEngine.resolve()` before the `Quotation` record is written. The engine result (`PricingResult.resolvedNightlyRate`, `PricingResult.effectiveRate`, `PricingResult.resolvedRatePlanId`) is stored in `Quotation.commercialTerms`. No quotation may be written without a resolved rate.

`QuotationService.createGroupQuotation()` calls the engine with group context (`groupSize` populated) — group volume bands are evaluated within the engine. Policy 65 and Policy 37 are applied within this invocation chain.

`QuotationService.applyDiscount()` re-calls the engine with `requestedDiscount` populated to validate whether the discount falls within the calling actor's authority bounds and above MSR.

**Input contract (S2-relevant fields):**
```typescript
interface PricingInput {
  guestTier: string;
  isDeficientTier: boolean;           // true for CAUTION/RESTRICTED — triggers deterrent rate path
  sourceChannel: string;              // from Entry.sourceChannel
  agentId?: string;
  corporateClientId?: string;
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId: string;
  groupSize?: number;                 // populated for GROUP use type
  useType: EntryUseType;
  applicableRatePlans: RatePlanSummary[];   // resolved by calling service from DB — engine does not query
  seasonCalendar: SeasonCalendarEntry[];    // resolved by calling service from DB
  requestedDiscount?: {
    discountAmount: Decimal;
    requestingActorLevel: ActorLevel;
    discountThresholds: DiscountThreshold[];
  };
  fomOverrideRate?: Decimal;
  currentTimestamp: Date;             // explicit — engine never calls Date.now()
}
```

**Output contract (S2-relevant fields):**
```typescript
interface PricingResult {
  resolvedRatePlanId: string;
  resolvedRatePlanType: RatePlanType;
  resolvedNightlyRate: Decimal;
  effectiveRate: Decimal;             // post-discount/override, pre-tax
  discountApplied: Decimal;
  discountWithinAuthorityBounds: boolean;
  overrideApplied: Decimal;
  belowMsr: boolean;                  // true: GM approval required before quotation is issued
  msrValue: Decimal;
  overrideExceedsMargin: boolean;
  isDeterrentRateApplied: boolean;    // must never be surfaced in guest-facing content if true
  appliedGroupBand: GroupSizeBand | null;
  resolutionPath: PricingResolutionStep[];
}
```

**What the calling service does with the output:**
- Stores `resolvedRatePlanId`, `resolvedNightlyRate`, `effectiveRate`, and `discountApplied` in `Quotation.commercialTerms`.
- If `belowMsr: true`: blocks quotation creation; surfaces `PolicyGateBlockedError` requiring GM approval before re-calling.
- If `overrideExceedsMargin: true`: blocks quotation creation; surfaces `PolicyGateBlockedError` requiring GM approval.
- If `isDeterrentRateApplied: true`: records internally; does not surface the rate plan type in any guest-facing content.

**Hardcoded vs configurable:**

| Behaviour | Type |
|---|---|
| Rate plan priority order: individual → promotional → tier → channel → rack | Hardcoded |
| Deterrent rate auto-assignment for CAUTION/RESTRICTED tiers | Hardcoded |
| MSR validation: resolved rate must be ≥ MSR | Hardcoded |
| Override margin enforcement boundary | Hardcoded |
| All rate values within rate plans | Configurable |
| MSR per rate plan | Configurable |
| Discount thresholds per authority level | Configurable |
| Override margin per rate plan | Configurable (on `RatePlan` model) |
| Group volume bands | Configurable |
| Season calendar boundaries | Configurable |

**What the engine does not do:**
- Does not persist the resolved rate — the calling service writes the `Quotation`.
- Does not emit `TraceEvent` records.
- Does not trigger approval chains — it returns `belowMsr: true` or `overrideExceedsMargin: true`; the service handles escalation.
- Does not read from the database — all rate plans, seasons, and thresholds are injected by the calling service.

**Re-call constraint:** The engine is called at quotation creation and on each negotiation round (discount or override request). It is not re-called at S3 — the S2-resolved rate is carried forward in the accepted quotation's `commercialTerms`. The engine is not re-called at S4 — the rate is frozen from the accepted quotation into `Reservation.frozenRate` at confirmation.

---

### 5.2 TimerEngine

**Purpose:** The governance backbone for all time-governed events at S2. Registers, tracks, and fires governed timers by dispatching pg-boss jobs to the appropriate worker. Does not execute expiry actions itself — delegates to workers.

**Primary method signatures:**
```typescript
TimerEngine.register(input: TimerRegistrationInput): TimerRegistration
TimerEngine.cancel(timerRecordId: string, actorId: string, reason: string): void
```

**S2 timer types registered by this engine:**

| Timer Type Key | Activation | Worker Dispatched | Registered by |
|---|---|---|---|
| `QUOTATION_VALIDITY` | Quotation sent | `QuotationExpiryWorker` (W15) | `QuotationService.sendQuotation()` |
| `QUOTATION_ACK_TRACKER` | Quotation sent | `QuotationAckWorker` | `QuotationService.sendQuotation()` |
| `SPECULATIVE_HOLD_EXPIRY` | Speculative hold placed | `SpeculativeHoldExpiryWorker` (W2) | `HoldService.placeSpeculativeHold()` |
| `ACKNOWLEDGEMENT_WINDOW` | Outbound communication sent | `AcknowledgementWindowWorker` (W22) | `CommunicationService.send()` |
| `STAGE_DWELL_MONITOR` | Entry enters S2 | `StageDwellMonitor` (W1) | `EntryService.progressStage()` on S1→S2 |

**Registration contract:**
```typescript
interface TimerRegistrationInput {
  timerType: string;          // key from registry above
  entityReference: string;    // ID of the governed entity
  entityType: string;
  stageContext?: Stage;       // S2
  firesAt: Date;              // absolute timestamp — not relative duration
  warningAt?: Date;
  criticalAt?: Date;
  payload?: Record<string, unknown>;
  actorId: string;            // SYSTEM actor for system-initiated timers
}
```

**Infrastructure:** All timer jobs persisted in pg-boss's job table. `TimerRecord.pgBossJobId` links the PMS record to the pg-boss job. Timer accuracy is within one polling interval — exact-second precision not guaranteed. pg-boss failure recovery: if the application restarts while a timer is in flight, pg-boss recovers the job state on restart — no timer is silently lost.

**Silent expiry prohibition:** No timer may expire without producing a permanent `TimerEvent` and a worker-emitted `TraceEvent`. A silent expiry — where a timer fires and an entity transitions to a new state without audit records — is a forbidden pattern.

---

## Section 6 — Services Active at S2

### 6.1 QuotationService

**Primary entity:** `Quotation`

**Methods active at S2:**

---

#### `QuotationService.createQuotation(input, actorId)`

Creates a `Quotation` in `DRAFT` state for a standard (non-group) entry.

- **What it does:** Resolves all data dependencies from the database (rate plans, season calendar, discount thresholds) and injects them into `PricingPipelineEngine.resolve()`. On successful resolution, creates the `Quotation` record with `state = DRAFT`, `commercialTerms` populated from `PricingResult`, `versionNumber` set (1 for first version; incremented for subsequent versions). Emits `QUOTATION.CREATED` trace event.
- **Policies invoked:** Policy 19 (Rate Plan Resolution) — `PricingPipelineEngine.resolve()` called before record is written; Policy 23 (Discount Approval) — if `requestedDiscount` is supplied, discount authority is validated before the quotation is written.
- **Engines called:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult` — called before record is written; result stored in `Quotation.commercialTerms`.
- **Models read:** `ConfigurationEntry` (rate plans, season calendar, discount thresholds, MSR values); `GuestProfile` (tier, for deterrent rate evaluation); `Entry` (useType, channel, dates, guestCount); `AvailabilityConfiguration` (preferred configuration for current segment — reads `searchCriteria.roomTypeId` for injection into `PricingInput`).
- **Models written:** `Quotation` (new, DRAFT state); `TraceEvent` (`QUOTATION.CREATED`).
- **Transaction scope:** `Quotation` creation + `TraceEvent` in single `prisma.$transaction`.
- **Error conditions:** `PolicyGateBlockedError` (discount escalation not satisfied; rate below MSR; override exceeds margin); `MissingConfigurationError` (no applicable rate plan; rate plan configuration absent); `StateTransitionError` (entry not in `(ACTIVE, S2)` or `(ACTIVE, S1)` for auto-fulfilment path); `ValidationError` (missing required fields).

---

#### `QuotationService.createGroupQuotation(input, actorId)`

Creates a `Quotation` in `DRAFT` state for a GROUP entry, including group rate resolution and FOC entitlement calculation.

- **What it does:** Identical to `createQuotation()` but with group context: `PricingInput.groupSize` populated; group volume bands evaluated by the engine. After rate resolution, calls `FOCValidationEngine.validate()` to evaluate FOC entitlement (Policy 37). If FOC validation fails (`FOCValidationResult.isValid = false`), quotation creation is blocked. If FOC validation passes, `Quotation.commercialTerms` includes FOC allocation alongside the rate resolution. GM approval for FOC inclusion is required before the quotation is sent (not before DRAFT is created).
- **Policies invoked:** Policy 19 (Rate Plan Resolution); Policy 23 (Discount Approval — if discount requested); Policy 37 (FOC Entitlement Calculation); Policy 65 (Group Rate Application).
- **Engines called:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult` — group context; `FOCValidationEngine.validate(input: FOCValidationInput): FOCValidationResult` — called after rate resolution; failure blocks quotation creation.
- **Models written:** `Quotation` (new, DRAFT state with group commercialTerms including FOC allocation); `TraceEvent` (`QUOTATION.GROUP_CREATED`).
- **Transaction scope:** Same as `createQuotation()`.
- **Error conditions:** Same as `createQuotation()` plus `PolicyGateBlockedError` (FOC validation failed — group quotation cannot be created with invalid FOC allocation).

---

#### `QuotationService.applyDiscount(quotationId, discountInput, actorId)`

Applies a discount to a DRAFT quotation, enforcing the approval chain.

- **What it does:** Reads the quotation (must be in DRAFT state). Re-calls `PricingPipelineEngine.resolve()` with `requestedDiscount` populated. Evaluates `PricingResult.discountWithinAuthorityBounds`. If within the calling actor's authority: updates `Quotation.commercialTerms` with the discounted rate; emits `QUOTATION.DISCOUNT_APPLIED` trace event. If escalation required: returns `PolicyGateBlockedError` identifying the required authority level; quotation is not updated until the escalation approval `TraceEvent` is separately recorded.
- **Policies invoked:** Policy 23 (Discount Approval).
- **Engines called:** `PricingPipelineEngine.resolve()` with discount context — validates authority bounds and MSR floor.
- **Models written (on approval):** `Quotation` (`commercialTerms` updated with discounted rate); `TraceEvent` (`QUOTATION.DISCOUNT_APPLIED`, carrying discount amount, authority level, and approval basis).
- **Transaction scope:** `Quotation` update + `TraceEvent` in single transaction.
- **Error conditions:** `StateTransitionError` (quotation not in DRAFT state — discounts may not be applied to sent quotations); `PolicyGateBlockedError` (discount exceeds authority; rate below MSR after discount).

---

#### `QuotationService.sendQuotation(quotationId, channelInput, actorId)`

Sends a DRAFT quotation to the guest or agent, sealing it and starting validity and acknowledgement timers.

- **What it does:** Validates that all discounts on the quotation have approved `TraceEvent` records (complete approval chain). Calls `DocumentGenerationInterface.generate(DocumentType.QUOTATION_DOCUMENT, input)` to generate the quotation document. Calls `CommunicationService.send()` to dispatch the document via the appropriate channel (`EmailInterface.sendOutbound()` or `WhatsAppInterface.sendOutbound()`). On successful dispatch: transitions `Quotation.state → SENT`; populates `Quotation.sentAt`, `Quotation.sentTo`, `Quotation.validUntil`; creates `CommunicationRecord`. Registers two timers via `TimerEngine.register()` in the same transaction: `QUOTATION_VALIDITY` (fires at `validUntil`) and `QUOTATION_ACK_TRACKER` (fires at `sentAt` + `acknowledgement.windowPerType.quotation`). Emits `QUOTATION.SENT` trace event. Policy 52 (Communication Acknowledgement Tracking) — the `ACKNOWLEDGEMENT_WINDOW` timer for the `CommunicationRecord` is registered by `CommunicationService.send()`.
- **Policies invoked:** Policy 52 (Communication Acknowledgement Tracking) — delegated to `CommunicationService.send()`.
- **Engines called:** None directly — `DocumentGenerationInterface` and `CommunicationService` are invoked.
- **Models written:** `Quotation` (state, sentAt, sentTo, validUntil); `CommunicationRecord` (new); `TimerRecord` (two new records: QUOTATION_VALIDITY, QUOTATION_ACK_TRACKER); `TraceEvent` (`QUOTATION.SENT`).
- **Transaction scope:** `Quotation` state update + `CommunicationRecord` creation + `TimerRecord` registrations + `TraceEvent` in single `prisma.$transaction`. Timer cancellation obligations: both timers must be cancelled in the same transaction if a subsequent event closes them (acceptance, supersession, expiry — see Section 3.4 timer cancellation matrix).
- **Error conditions:** `StateTransitionError` (quotation not in DRAFT state); `PolicyGateBlockedError` (unapproved discount on quotation — send blocked until approval chain is complete); `MissingConfigurationError` (quotation template not configured; communication channel not configured).

---

#### `QuotationService.acceptQuotation(quotationId, actorId)`

Records guest acceptance of a SENT quotation, closing ack and validity timers.

- **What it does:** Transitions `Quotation.state → ACCEPTED`. Populates `Quotation.acceptedAt` and `Quotation.acceptedBy`. Cancels the `QUOTATION_VALIDITY` timer via `TimerEngine.cancel()`. Cancels the `QUOTATION_ACK_TRACKER` timer via `TimerEngine.cancel()`. Updates the associated `CommunicationRecord.acknowledgementStatus → RECEIVED`. Emits `QUOTATION.ACCEPTED` trace event.
- **Policies invoked:** None — acceptance is a state transition governed by Part 3 §3.14 guard conditions.
- **Engines called:** None.
- **Models written:** `Quotation` (state, acceptedAt, acceptedBy); `CommunicationRecord` (acknowledgementStatus → RECEIVED, acknowledgementReceivedAt); `TimerRecord` (two cancellations: QUOTATION_VALIDITY, QUOTATION_ACK_TRACKER); `TraceEvent` (`QUOTATION.ACCEPTED`).
- **Transaction scope:** All writes above in single `prisma.$transaction`. Timer cancellations are part of the same transaction — if the transaction rolls back, timers remain active.
- **Error conditions:** `StateTransitionError` (quotation not in SENT state — only SENT quotations may be accepted).

---

#### `QuotationService.createQuotation()` — supersession side effect

When a new quotation version is created for an entry that already has a DRAFT or SENT quotation for the current segment, the prior version is superseded in the same transaction.

- **What it does (supersession path):** Transitions the prior version `Quotation.state → SUPERSEDED`. Populates `Quotation.supersededAt` and `Quotation.supersededById` on the prior version. If the prior version was SENT (timers running): cancels the `QUOTATION_VALIDITY` timer and the `QUOTATION_ACK_TRACKER` timer via `TimerEngine.cancel()` in the same transaction. Emits `QUOTATION.SUPERSEDED` trace event on the prior version.
- **Transaction scope:** Prior version state update + timer cancellations + new version creation + all `TraceEvent` records in single `prisma.$transaction`.

---

#### `QuotationService.expire(quotationId)`

Called by `QuotationExpiryWorker` (W15) when the validity timer fires. Not a staff-initiated method.

- **What it does:** Transitions `Quotation.state → EXPIRED`. Populates `Quotation.expiredAt`. Cancels the `QUOTATION_ACK_TRACKER` timer if still running via `TimerEngine.cancel()`. Notifies the custodian. Emits `QUOTATION.EXPIRED` trace event.
- **Models written:** `Quotation` (state, expiredAt); `TimerRecord` (QUOTATION_ACK_TRACKER cancellation if still running); `TraceEvent` (`QUOTATION.EXPIRY_WARNING` before expiry, `QUOTATION.EXPIRED` on transition).
- **Transaction scope:** State update + ack tracker cancellation + `TraceEvent` in single transaction.

---

#### `QuotationService.createQuotation()` — re-entry from S3 context

When creating a quotation on a segment that re-entered from S3 back-flow (S3→S2 rate renegotiation), the service operates with additional context that must be surfaced to the FOM during the renegotiation:

- **Prior CommittedHold awareness.** The prior segment's `CommittedHold` is in `PLACED` state with its expiry timer running. The service reads the prior segment's hold `expiresAt` and surfaces it in the quotation context as a renegotiation deadline. The FOM must see how much hold window remains before committing to a new commercial position. If the hold has already expired by the time the quotation is created, the service notes this — a fresh committed hold will be required when the new segment reaches S3, and `AvailabilityService` must run a fresh check at that point.
- **Existing folio payment status.** The Entry-level folio's total advance payments already received (sum of `PaymentRecord` entries with `paymentDirection = 'IN'` on the Entry-level folio) are surfaced in the quotation context. If the total already meets or exceeds the new quotation's advance payment threshold, the advance payment condition is pre-satisfied for the new S3 passage — the FOM should know this during renegotiation as it affects the commercial dynamics.
- **Prior commercial terms.** The prior segment's quotation records (sealed, read-only) are recallable as context. The FOM may start from the prior segment's accepted commercial terms or renegotiate from scratch — either path is valid. The service does not enforce a starting point; it surfaces prior terms as reference.
- **Models read (additional to standard):** `CommittedHold` (prior segment's — `state`, `expiresAt`); `Folio` (Entry-level — `PaymentRecord` entries with `paymentDirection = 'IN'`); `Quotation` (prior segment's — sealed `commercialTerms` for reference).
- **No new policies invoked.** The re-entry context is informational — it does not alter the quotation creation or pricing logic. The `PricingPipelineEngine` is called with the same contract as standard quotation creation. Renegotiation-specific decisions (e.g., whether to honour the prior rate, apply a different discount) are FOM judgment calls within the standard Policy 23 approval chain.

---

### 6.2 HoldService (S2 methods — speculative hold only)

**Primary entity at S2:** `SpeculativeHold`

Note: `HoldService.placeCommittedHold()` is an S3 method. It is not active at S2 and is not documented here.

---

#### `HoldService.placeSpeculativeHold(input, actorId)`

Places a speculative hold on inventory for the current entry.

- **What it does:** Evaluates Policy 25 (Speculative Hold Placement) — checks inventory availability (`Room.currentClaimState` must be FREE or QUOTED), evaluates whether the requesting actor's level satisfies the placement threshold, and raises escalation if the hold volume or commercial significance exceeds the front desk threshold. On APPROVED: creates `SpeculativeHold` record with `state = PLACED`; transitions `Room.currentClaimState → SPECULATIVELY_HELD`; writes `RoomClaimStateEvent`; registers `SPECULATIVE_HOLD_EXPIRY` timer via `TimerEngine.register()` with `firesAt = now + ttlSeconds`. `ttlSeconds` is read from `speculativeHold.placementThresholds` configuration at placement time and stored on the `SpeculativeHold` record. Emits `SPECULATIVE_HOLD.PLACED` trace event.
- **Policies invoked:** Policy 25 (Speculative Hold Placement).
- **Engines called:** None.
- **Models read:** `Room` (`currentClaimState`); `ConfigurationEntry` (`speculativeHold.placementThresholds`).
- **Models written:** `SpeculativeHold` (new, PLACED state); `Room` (`currentClaimState → SPECULATIVELY_HELD`); `RoomClaimStateEvent` (new, immutable); `TimerRecord` (SPECULATIVE_HOLD_EXPIRY); `TraceEvent` (`SPECULATIVE_HOLD.PLACED`).
- **Transaction scope:** All writes above in single `prisma.$transaction`. If any write fails, the hold is not placed and the room claim state does not change.
- **Error conditions:** `PolicyGateBlockedError` (inventory not available; volume threshold requires FOM escalation); `MissingConfigurationError` (speculative hold thresholds not configured); `AuthorizationError` (escalation required and calling actor insufficient).

---

#### `HoldService.releaseSpeculativeHold(holdId, reason, actorId)`

Explicitly releases an active speculative hold by staff action. Requires L2+ authority.

- **What it does:** Validates that the `SpeculativeHold` is in `PLACED` state. Transitions `SpeculativeHold.state → RELEASED`. Populates `releasedAt`, `releasedBy`, and `releaseReason = CANCELLATION`. Transitions `Room.currentClaimState → FREE`. Writes `RoomClaimStateEvent`. Cancels the `SPECULATIVE_HOLD_EXPIRY` timer via `TimerEngine.cancel()`. Emits `SPECULATIVE_HOLD.RELEASED` trace event with release reason, actor identity, and timestamp.
- **Policies invoked:** Policy 25 (Speculative Hold Placement — the expiry consequence clause also governs explicit release as a governed event).
- **Engines called:** None.
- **Models written:** `SpeculativeHold` (state, releasedAt, releasedBy, releaseReason); `Room` (`currentClaimState → FREE`); `RoomClaimStateEvent` (new, immutable); `TimerRecord` (SPECULATIVE_HOLD_EXPIRY cancellation); `TraceEvent` (`SPECULATIVE_HOLD.RELEASED`).
- **Transaction scope:** All writes above in single `prisma.$transaction`. Release is atomic — if the transaction rolls back, the hold remains PLACED and the timer remains active.
- **Error conditions:** `StateTransitionError` (hold not in PLACED state — cannot release an already RELEASED or UPGRADED hold); `AuthorizationError` (actor below L2+ minimum).

---

### 6.3 EntryService (S2 methods)

**Primary entity:** `Entry`, `Segment`

---

#### `EntryService.progressStage(entryId, targetStage, transitionData, actorId)` — S2→S3

Advances the entry from S2 to S3 after all exit evidence is satisfied.

- **What it does:** Invokes the state machine transition guard defined in Part 3 §3.2 — does not re-implement the guard. On successful S2→S3 exit: seals all `Quotation` records for the current segment (`sealedAt` populated on each); populates `StageDwellRecord.exitedAt` and `StageDwellRecord.dwellSeconds`; advances `Entry.currentStage → S3`; increments `Entry.version`; emits `ENTRY.STAGE_TRANSITION` trace event.
- **Policies invoked:** Guards for S2→S3 are evaluated within the state machine transition function — the service does not inline guard logic.
- **Models written:** `Entry` (`currentStage`, `version`, `updatedAt`); `Quotation` (all segment versions — `sealedAt`); `StageDwellRecord` (`exitedAt`, `dwellSeconds`); `TraceEvent` (`ENTRY.STAGE_TRANSITION`).
- **Transaction scope:** All writes above in single `prisma.$transaction`.
- **Error conditions:** `StageGateBlockedError` (any S2 exit guard condition unsatisfied — see Section 3.2); `StateTransitionError` (entry not in expected source state); `ConcurrentEditingError` (Entry.version conflict — optimistic lock mismatch).

**Note on S2→S1 re-entry:** When `targetStage = S1` (re-entry triggered by date or room type reconfiguration request), this method handles a different write consequence set: creates a new `Segment` record (`segmentNumber` incremented), seals the prior segment (`Segment.sealedAt`, `Segment.sealedBy`), calls `ReEntryConsequenceEngine.compute()` to produce the consequence payload, advances `Entry.currentStage → S1` within the new segment, and registers a fresh `STAGE_DWELL_MONITOR` timer for the new S1 dwell. All `Quotation` records and the sealed `AvailabilityConfiguration` in the prior segment are preserved as read-only. Full re-entry mechanics: SIG-S1 §3.5.

---

#### `EntryService.park(entryId, reason, actorId)` / `EntryService.unpark(entryId, actorId)`

Entry-level park and unpark, independent of inquiry-level cascade.

- **Park:** Sets `Entry.status = PARKED`, `Entry.parkedAt`, `Entry.parkedBy`, `Entry.parkedIndividually = true`. Emits `ENTRY.PARKED` trace event. Does not affect any in-flight quotation or its timers.
- **Unpark:** Clears `Entry.status`, `Entry.parkedAt`, `Entry.parkedBy`. Resets `Entry.parkedIndividually = false`. Emits `ENTRY.UNPARKED` trace event.
- **Policies invoked:** None.
- **Models written:** `Entry` (status, parkedAt, parkedBy, parkedIndividually); `TraceEvent`.
- **Transaction scope:** Single `prisma.$transaction` per operation.

---

## Section 7 — Workers Active at S2

### 7.1 Worker 2 — SpeculativeHoldExpiryWorker

**Governed stage(s):** S2
**Trigger condition:** Registered at hold placement. Fires when `SpeculativeHold.expiresAt` is reached without RELEASED or UPGRADED transition.
**pg-boss job type name:** `SPECULATIVE_HOLD_EXPIRY`

**What it does:**
1. Reads `SpeculativeHold.state`. If `state = RELEASED` or `state = UPGRADED` — hold already resolved; emit skip event (`SPECULATIVE_HOLD.EXPIRY_SKIP`) and exit without error. Idempotency key: `SpeculativeHold.id`.
2. Transitions `SpeculativeHold.state → RELEASED`. Populates `releasedAt`, `releasedBy = SYSTEM`, `releaseReason = EXPIRY`.
3. Transitions `Room.currentClaimState → FREE`.
4. Writes `RoomClaimStateEvent` (immutable).
5. Emits `SPECULATIVE_HOLD.EXPIRY_TRIGGERED` trace event carrying `holdId`, `entryId`, `roomId` (if applicable), `spaceId` (if applicable), `expiresAt`.
6. Dispatches staff alert notification.

**Models read:** `SpeculativeHold` (`state`, `expiresAt`, `entryId`, `roomId`, `spaceId`); `Room` (`currentClaimState`); `ConfigurationEntry` (alert routing).
**Models written:** `SpeculativeHold` (state, releasedAt, releasedBy, releaseReason); `Room` (`currentClaimState → FREE`); `RoomClaimStateEvent`; `TraceEvent`.

**Critical atomicity requirement:** `SpeculativeHold` state update and `RoomClaimStateEvent` creation must be wrapped in a single database transaction. If the state update succeeds but the `RoomClaimStateEvent` fails, the idempotency check on retry will detect `state = RELEASED` and skip — leaving the room claim state inconsistent. Atomicity prevents this.

**Hardcoded behaviour:** Expiry is always a governed event. Silent expiry is forbidden. Inventory does not silently return to FREE — the release event and reason are permanently recorded.
**Configurable parameters:** Speculative hold TTL — set at placement time from `speculativeHold.placementThresholds`; stored on `SpeculativeHold.ttlSeconds`; not re-read at fire time.
**Failure behaviour:** Standard DLQ alert. Hold remains in PLACED state until re-dispatch resolves the failure. Idempotency guard prevents double-release on retry.

---

### 7.2 Worker 15 — QuotationExpiryWorker

**Governed stage(s):** S2
**Trigger condition:** Registered when a quotation is sent. Fires when `Quotation.validUntil` is reached.
**pg-boss job type name:** `QUOTATION_VALIDITY`

**What it does:**
1. Reads `Quotation.state`. If `state = EXPIRED`, `ACCEPTED`, or `SUPERSEDED` — quotation already resolved; emit skip event and exit. Idempotency key: `Quotation.id`.
2. Emits `QUOTATION.EXPIRY_WARNING` trace event at approaching-expiry threshold (warning phase fires before the full expiry).
3. Transitions `Quotation.state → EXPIRED`. Populates `Quotation.expiredAt`.
4. Cancels the `QUOTATION_ACK_TRACKER` timer via `TimerEngine.cancel()` if still running (the ack tracker is moot once the quotation has expired).
5. Emits `QUOTATION.EXPIRED` trace event.
6. Notifies the custodian.

**Models read:** `Quotation` (`state`, `validUntil`, `sentAt`, `entryId`).
**Models written:** `Quotation` (state, expiredAt); `TimerRecord` (QUOTATION_ACK_TRACKER cancellation); `TraceEvent` (`QUOTATION.EXPIRY_WARNING`, `QUOTATION.EXPIRED`).

**Hardcoded behaviour:** An EXPIRED quotation cannot be used as the basis for S2→S3 exit without explicit revalidation. Expiry is a governed event — silent expiry is forbidden.
**Configurable parameters:** Quotation validity window — from `ConfigurationEntry` key `expiry.s2.quotationValidityDays` (used at registration time to compute `firesAt`; not re-read at fire time). Warning threshold offset — from same configuration.
**Failure behaviour:** Standard DLQ alert. Quotation remains in SENT state until re-dispatch resolves. Idempotency guard prevents double-expiry on retry.

---

### 7.3 Worker 34 — QuotationAckWorker *(New — correction log entry SIG-S2-COR-004)*

**Governed stage(s):** S2
**Trigger condition:** Registered when a quotation is sent. Fires when the acknowledgement response window expires without `CommunicationRecord.acknowledgementStatus = RECEIVED`.
**pg-boss job type name:** `QUOTATION_ACK_TRACKER`

**What it does:**
1. Reads `CommunicationRecord.acknowledgementStatus` for the outbound quotation communication. If `acknowledgementStatus = RECEIVED` — guest has already acknowledged; emit skip event and exit. Idempotency key: `CommunicationRecord.id`.
2. If `Quotation.state = ACCEPTED`, `EXPIRED`, or `SUPERSEDED` — quotation is no longer live; emit skip event and exit.
3. Surfaces an open-loop flag on the entry's custodian dashboard as an actionable item: the quotation has been sent but the guest has not acknowledged within the configured window.
4. Emits `QUOTATION.ACK_OPEN_LOOP_FLAGGED` trace event carrying `quotationId`, `communicationRecordId`, `entryId`, `windowExceededAt`.
5. If the window is significantly exceeded (configurable escalation threshold): escalates to FOM. Emits `QUOTATION.ACK_FOM_ESCALATED` trace event.

**Separation from validity timer:** This worker fires independently of `QuotationExpiryWorker` (W15). The acknowledgement response window (factory default: 24 hours) is shorter than the validity window (factory default: 48 hours). This worker fires at hour 24 regardless of whether the validity timer has fired. The quotation remains commercially valid between hours 24 and 48 — the ack open loop is an operational prompt, not a commercial deadline.

**Models read:** `CommunicationRecord` (`acknowledgementStatus`, `entryId`); `Quotation` (`state`).
**Models written:** `TraceEvent` (`QUOTATION.ACK_OPEN_LOOP_FLAGGED`, `QUOTATION.ACK_FOM_ESCALATED`).

**Hardcoded behaviour:** Non-acknowledgement of a sent quotation is always surfaced as a visible open item. It is not silently absorbed. The open loop does not block S2→S3 exit within the window — it becomes a soft block requiring documented resolution only after the window is exceeded.
**Configurable parameters:** Acknowledgement response window — from `ConfigurationEntry` key `acknowledgement.windowPerType` (Json: `{ "quotation": <seconds> }`). Factory default: 86400 seconds (24 hours). FOM escalation threshold — from same key or a sub-key per implementation.
**Failure behaviour:** Standard DLQ alert. Open loop flag is not surfaced until re-dispatch resolves. Idempotency guard prevents duplicate flagging on retry.

---

### 7.4 Worker 22 — AcknowledgementWindowWorker

**Governed stage(s):** S2–S9 (cross-stage)
**Trigger condition:** Registered by `CommunicationService.send()` when any outbound communication requiring acknowledgement is dispatched. Fires when the window expires without `CommunicationRecord.acknowledgementStatus = RECEIVED`.
**pg-boss job type name:** `ACKNOWLEDGEMENT_WINDOW`

**What it does:**
1. Reads `CommunicationRecord.acknowledgementStatus`. If `RECEIVED` or `TIMED_OUT` — loop already resolved; emit skip event and exit. Idempotency key: `CommunicationRecord.id`.
2. Transitions `CommunicationRecord.acknowledgementStatus → TIMED_OUT`.
3. Emits `ACKNOWLEDGEMENT.WINDOW_EXPIRED` trace event.
4. Surfaces the open loop to the responsible actor for the relevant stage.
5. If the window is significantly exceeded: escalates to FOM. Emits `ACKNOWLEDGEMENT.FOM_ESCALATED`.
6. **S4 sub-behaviour:** When the timer fires for a `CommunicationRecord` at `stageContext = S4` (confirmation voucher sent), the worker treats the open loop as a confirmation acknowledgement tracker event. Consequence: an open loop requiring documented resolution at S4 exit, surfaced to FOM if significantly exceeded. Handled by filtering `stageContext` within the same worker execution.

**Distinction from QuotationAckWorker:** This worker governs the general communication-level acknowledgement window for any outbound governed communication. `QuotationAckWorker` governs the quotation-specific acknowledgement tracker (registered at quotation send, fires earlier). Both operate independently. At S2, both may be active simultaneously for a sent quotation.

**Models read:** `CommunicationRecord` (`acknowledgementStatus`, `acknowledgementTimeoutAt`, `stageContext`, `entryId`).
**Models written:** `CommunicationRecord` (`acknowledgementStatus → TIMED_OUT`); `TraceEvent` (`ACKNOWLEDGEMENT.WINDOW_EXPIRED`, `ACKNOWLEDGEMENT.CONFIRMATION_OPEN_LOOP` [S4], `ACKNOWLEDGEMENT.FOM_ESCALATED`).
**Configurable parameters:** Acknowledgement window per communication type — from `ConfigurationEntry` key `acknowledgement.windowPerType`; FOM escalation threshold — from same key.
**Failure behaviour:** Standard DLQ alert.

---

### 7.5 Worker 1 — StageDwellMonitor (S2 phase)

**Governed stage(s):** S1–S9 (cross-stage; S2 phase documented here)
**Trigger condition:** Entry enters S2. `STAGE_DWELL_MONITOR` timer registered by `EntryService.progressStage()` on the S1→S2 transition.
**pg-boss job type name:** `STAGE_DWELL_MONITOR`

**What it does at S2:** Monitors how long the entry has been in S2. Fires at mode-dependent warning and critical thresholds. On warning threshold: emits `STAGE_DWELL.S2_WARNING` trace event; updates `StageDwellRecord.warningFiredAt`; notifies custodian. On critical threshold: emits `STAGE_DWELL.S2_CRITICAL` trace event; updates `StageDwellRecord.criticalFiredAt`; escalates to FOM.

**S2 threshold context:** S2 dwell thresholds are mode-dependent. Normal Booking mode may tolerate extended negotiation (days). Complaint Resolution mode has tighter thresholds. Factory defaults: S2 idle warning at 4 hours; S2 idle critical at 8 hours. These defaults apply to Normal Booking mode; other modes read from `stageDwell.thresholds` configuration.

**Models read:** `Entry` (`currentStage`, `status`); `StageDwellRecord` (`enteredAt`, `mode`); `ConfigurationEntry` (`stageDwell.thresholds`).
**Models written:** `StageDwellRecord` (`warningFiredAt`, `criticalFiredAt`, `escalatedAt`, `lastActiveAt`); `TraceEvent`.
**Configurable parameters:** All stage × mode × threshold values — from `ConfigurationEntry` key `stageDwell.thresholds` (Json: all nine stages × all dwell modes × warning/critical/escalation thresholds in seconds).
**Failure behaviour:** Standard DLQ alert. Dwell monitoring gap is flagged; entry remains in current state.

---

### 7.6 Worker 20 — EntryExpiryWorker (cross-stage, active at S2)

**Governed stage(s):** S1–S9 (cross-stage; registered at S1, remains active throughout entry lifecycle)
**Trigger condition:** Registered at S1 entry creation. Fires when the entry's expiry TTL threshold is reached without the entry having progressed to a terminal or later stage.
**pg-boss job type name:** `ENTRY_EXPIRY`

**Relevance at S2:** An entry that stalls at S2 — for example, a parked entry where the guest goes silent and no quotation is accepted within the expiry window — will be transitioned to `(EXPIRED, —)` by this worker. This is the governing mechanism behind the `(ACTIVE, S2) → (EXPIRED, —)` and `(PARKED, S2) → (EXPIRED, —)` transitions in §3.1. The worker fires regardless of the entry's current stage; it reads `Entry.status` and acts if the entry is not already in a terminal state.

**Idempotency:** If the worker fires and finds `Entry.status = EXPIRED`, `CANCELLED`, or `CLOSED`, it emits a skip event and exits without further action. Second-run safety is guaranteed.

**Full specification:** SIG-S1 §7.3. No new behaviour at S2 — the worker operates identically across all stages.

---

## Section 8 — API Routes at S2

All routes follow the standard response envelope:
- Success: `{ success: true, data: <typed payload> }`
- Error: `{ success: false, error: { type: string, code: string, message: string, context: object }, requestId: string }`

Every route passes through `authMiddleware` (PIN/JWT session validation) then `validationMiddleware` (DTO schema validation) before the controller handler executes. Controllers are thin adapters — no business logic in the controller body.

---

### Route: Create Quotation

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/quotations` |
| Auth | `L1+` |
| Service method | `QuotationService.createQuotation()` (standard) or `QuotationService.createGroupQuotation()` (GROUP useType) — controller delegates based on `Entry.useType` |
| Policies | Policy 19 — Rate Plan Resolution Policy; Policy 23 — Discount Approval Policy (if discount requested); Policy 37 — FOC Entitlement Calculation Policy (GROUP useType only); Policy 65 — Group Rate Application Policy (GROUP useType only) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (discount escalation not satisfied; rate below MSR; FOC validation failed), `MissingConfigurationError` (no rate plan; template absent), `StateTransitionError` (entry not in S2), `AppError` |

**Request — `CreateQuotationRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Extracted from path parameter `:id` |
| `checkInDate` | `string (iso-date)` | Required | Booking date — used for rate plan and season evaluation |
| `checkOutDate` | `string (iso-date)` | Required | |
| `roomTypeId` | `string (uuid)` | Required | Room type being quoted |
| `requestedDiscount` | `object?` | Optional | If present: `{ discountAmount: Decimal, discountBasis: string }` |
| `fomOverrideRate` | `Decimal?` | Optional | FOM-proposed rate override; only valid when actorLevel ≥ L2 |
| `notes` | `string?` | Optional | Internal notes on quotation context. Max 2000 chars. |

**Response — `QuotationResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Quotation identifier |
| `referenceNumber` | `string` | e.g., Q-001 |
| `versionNumber` | `integer` | 1 for first version |
| `state` | `enum: QuotationState` | DRAFT on creation |
| `commercialTerms` | `object` | Resolved rate, inclusions, discount basis, FOC allocation (group only) |
| `totalAmount` | `Decimal` | Total quoted amount |
| `currency` | `string` | BTN |
| `createdAt` | `string (iso-datetime)` | |
| `createdBy` | `string (uuid)` | Actor who created the quotation |

---

### Route: Send Quotation

| Field | Value |
|---|---|
| Method + Path | `POST /quotations/:id/send` |
| Auth | `L1+` |
| Service method | `QuotationService.sendQuotation()` |
| Policies | Policy 52 — Communication Acknowledgement Tracking Policy (delegated to `CommunicationService.send()`) |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (quotation not in DRAFT), `PolicyGateBlockedError` (unapproved discount on quotation), `MissingConfigurationError` (template not configured; channel not configured), `AppError` |

**Request — `SendQuotationRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Quotation identifier — extracted from path |
| `channel` | `enum: CommunicationChannel` | Required | `EMAIL` or `WHATSAPP` |
| `recipientAddress` | `string` | Required | Email address or WhatsApp number (E.164 format) |
| `threadId` | `string?` | Optional | For threading continuity on WhatsApp |

**Response — `QuotationResponseDTO`** (same shape as Create; state will be SENT)

---

### Route: Accept Quotation

| Field | Value |
|---|---|
| Method + Path | `POST /quotations/:id/accept` |
| Auth | `L1+` |
| Service method | `QuotationService.acceptQuotation()` |
| Policies | None — acceptance is a state transition; guards are in the state machine |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `StateTransitionError` (quotation not in SENT state), `AppError` |

**Request — `AcceptQuotationRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Quotation identifier — extracted from path |
| `acceptanceMethod` | `string` | Required | `WRITTEN` (communication record) or `VERBAL` (staff records on guest's behalf) |
| `verbatimNote` | `string?` | Optional | Required when `acceptanceMethod = VERBAL` — staff records exact words or context of guest's verbal acceptance |

**Response — `QuotationResponseDTO`** (state will be ACCEPTED)

---

### Route: Place Speculative Hold

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/holds/speculative` |
| Auth | `L1+` (service evaluates whether FOM escalation is required per Policy 25 volume thresholds) |
| Service method | `HoldService.placeSpeculativeHold()` |
| Policies | Policy 25 — Speculative Hold Placement Policy |
| Error responses | `ValidationError`, `AuthorizationError`, `NotFoundError`, `PolicyGateBlockedError` (inventory not available; volume threshold requires FOM escalation), `MissingConfigurationError` (speculative hold thresholds not configured), `AppError` |

**Request — `PlaceSpeculativeHoldRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Extracted from path parameter `:id` |
| `roomId` | `string (uuid)?` | Conditional | Required for accommodation and apartment holds |
| `spaceId` | `string (uuid)?` | Conditional | Required for conference/catering space holds |
| `ttlSeconds` | `integer` | Required | Requested TTL in seconds; evaluated against `speculativeHold.placementThresholds` configuration |
| `commercialBasis` | `string` | Required | Documented reason for placing the hold |
| `notes` | `string?` | Optional | Operational notes |

**Response — `SpeculativeHoldResponseDTO`**

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Hold identifier |
| `state` | `enum: HoldState` | PLACED on creation |
| `roomId` | `string (uuid)?` | |
| `spaceId` | `string (uuid)?` | |
| `placedAt` | `string (iso-datetime)` | |
| `expiresAt` | `string (iso-datetime)` | Absolute expiry timestamp |
| `placedBy` | `string (uuid)` | Actor who placed the hold |

---

### Route: Release Speculative Hold *(New — correction log entry SIG-S2-COR-008)*

| Field | Value |
|---|---|
| Method + Path | `POST /entries/:id/holds/speculative/:holdId/release` |
| Auth | `L2+` — FOM authority required for explicit staff-initiated release |
| Service method | `HoldService.releaseSpeculativeHold()` |
| Policies | Policy 25 — Speculative Hold Placement Policy (release consequence clause) |
| Error responses | `ValidationError`, `AuthorizationError` (actor below L2+), `NotFoundError`, `StateTransitionError` (hold not in PLACED state), `AppError` |

**Request — `ReleaseSpeculativeHoldRequestDTO`**

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Extracted from path parameter `:id` |
| `holdId` | `string (uuid)` | Required | Extracted from path parameter `:holdId` |
| `releaseReason` | `string` | Required | Documented reason for explicit release — mandatory for audit trail |

**Response — `SpeculativeHoldResponseDTO`** (state will be RELEASED)

---

## Section 9 — Configuration Keys at S2

All keys queried with date-range filter: `effectiveFrom <= now AND (effectiveTo IS NULL OR effectiveTo > now)`. Never queried with a simple `findFirst` by key alone. A missing required key raises `MissingConfigurationError` identifying the exact key and the operation that cannot proceed.

| configKey | Type | Default | Read by | Missing behaviour |
|---|---|---|---|---|
| `expiry.s2.quotationValidityDays` | Integer | 2 (48 hours) | `QuotationService.sendQuotation()` — used to compute `validUntil` at send time; `TimerEngine.register()` — used to compute `firesAt` for QUOTATION_VALIDITY timer | `MissingConfigurationError` — quotation send is blocked |
| `expiry.s2.speculativeHoldTtlSeconds` | Integer | 900 (15 minutes) | `HoldService.placeSpeculativeHold()` — used as default TTL if actor does not specify; `TimerEngine.register()` — used to compute `firesAt` for SPECULATIVE_HOLD_EXPIRY timer | `MissingConfigurationError` — speculative hold placement is blocked |
| `discount.fom.maxPercentage` | Decimal | No factory default — must be configured | `QuotationService.applyDiscount()` — injected into `PricingPipelineEngine` as FOM discount threshold | `MissingConfigurationError` — discount application blocked; quotation creation with discount blocked |
| `discount.gm.maxPercentage` | Decimal | No factory default — must be configured | `QuotationService.applyDiscount()` — injected into `PricingPipelineEngine` as GM discount threshold | `MissingConfigurationError` — discount application blocked |
| `speculativeHold.placementThresholds` | Json | No factory default — must be configured before S2 is live | `HoldService.placeSpeculativeHold()` — evaluates volume thresholds, maximum concurrent holds per source type, escalation rules per authority level | `MissingConfigurationError` — speculative hold placement blocked entirely |
| `acknowledgement.windowPerType` | Json | No factory default — must be configured | `CommunicationService.send()` — reads window for `quotation` type to compute `acknowledgementTimeoutAt`; `TimerEngine.register()` — for ACKNOWLEDGEMENT_WINDOW and QUOTATION_ACK_TRACKER timers; `QuotationAckWorker` — reads escalation threshold | `MissingConfigurationError` — quotation send blocked (acknowledgement window required before communication is dispatched) |

**Key value structures:**

`speculativeHold.placementThresholds` — Json structure:
```json
{
  "thresholds": [
    { "maxRooms": 5, "authorityRequired": "FRONT_DESK", "maxConcurrentHolds": 3 },
    { "maxRooms": 15, "authorityRequired": "FOM", "maxConcurrentHolds": 10 },
    { "maxRooms": null, "authorityRequired": "GM", "maxConcurrentHolds": null }
  ]
}
```

`acknowledgement.windowPerType` — Json structure:
```json
{
  "quotation": 86400,
  "pi": 86400,
  "voucher": 172800,
  "preArrival": 86400,
  "amendment": 43200,
  "cancellation": 43200,
  "invoice": 604800
}
```
All values in seconds. All types must be present before any stage that sends the corresponding communication type is live.

**Part 12 surface alignment note:** Part 12 §12.3.1 S2 Readiness table uses flat key names (`expiry_defaults`, `discount_thresholds`, `speculative_hold_thresholds`, `acknowledgement_window_per_type`). These are surface-level names in the Admin Console catalogue. The SIG carries dotted notation throughout as per the canonical key registry in Part 2-REV1 §2.17.3 and the MC-013 conversion. Part 12 must be updated in the revision pass — see correction log entries.

---

## Section 10 — Acceptance Criteria

All assertions must pass for S2 to be considered correctly implemented. Written as pass/fail checks.

### Schema Correctness

1. **Quotation state enum complete:** The `QuotationState` enum contains exactly: DRAFT, SENT, ACCEPTED, SUPERSEDED, EXPIRED — no additional states, no missing states.
2. **Quotation fields present:** `Quotation` model contains all required S2 fields: `versionNumber`, `referenceNumber`, `state`, `commercialTerms` (Json), `totalAmount`, `validUntil`, `sentAt`, `sentTo`, `supersededById`, `supersededAt`, `expiredAt`, `acceptedAt`, `acceptedBy`.
3. **SpeculativeHold state enum correct:** `HoldState` contains: PLACED, RELEASED, UPGRADED (CONFIRMED is on CommittedHold — not duplicated here incorrectly).
4. **SpeculativeHold fields present:** `ttlSeconds`, `expiresAt`, `releasedAt`, `releasedBy`, `releaseReason`, `upgradedToId` all present.
5. **CommunicationRecord acknowledgement fields present:** `acknowledgementStatus`, `acknowledgementReceivedAt`, `acknowledgementTimeoutAt` all present with correct types.
6. **No NegotiationRecord model exists.** The quotation version chain serves this purpose. A NegotiationRecord model is an architectural violation.
7. **No DiscountApprovalRecord model exists.** The TraceEvent audit chain from `QuotationService.applyDiscount()` serves this purpose.
8. **Config keys present in ConfigurationEntry table:** All six S2 config keys (`expiry.s2.quotationValidityDays`, `expiry.s2.speculativeHoldTtlSeconds`, `discount.fom.maxPercentage`, `discount.gm.maxPercentage`, `speculativeHold.placementThresholds`, `acknowledgement.windowPerType`) are seeded before S2 is declared live.

### Policy Enforcement

9. **Rate resolved before quotation written:** Calling `POST /entries/:id/quotations` without a valid rate plan in the database raises `MissingConfigurationError`. No `Quotation` record is created.
10. **Unapproved discount blocks send:** Calling `POST /quotations/:id/send` on a quotation with an unapproved discount (no approval TraceEvent at required authority level) raises `PolicyGateBlockedError`. The quotation state does not change.
11. **Discount below front desk threshold: no escalation required.** Calling `QuotationService.applyDiscount()` with a discount at or below `discount.fom.maxPercentage` succeeds at L1 authority without raising a `PolicyGateBlockedError`.
12. **Discount above FOM threshold: GM escalation required.** Calling `QuotationService.applyDiscount()` with a discount above `discount.gm.maxPercentage` raises `PolicyGateBlockedError` specifying GM authority required.
13. **Speculative hold volume threshold enforced:** Placing a speculative hold at L1 for a room count exceeding the configured L1 threshold raises `PolicyGateBlockedError` specifying FOM authority required.
14. **Policy 38 not enforced at S2.** `QuotationService.createGroupQuotation()` does not call `FOCValidationEngine.validate()` with the S3 committed-hold validation context. Policy 38 is S3 only.

### Engine Behaviour

15. **PricingPipelineEngine called at quotation creation:** Creating a quotation without a resolved rate in `commercialTerms` is not possible — the engine is always called before the record is written.
16. **Deterrent rate not surfaced:** For a guest with CAUTION or RESTRICTED tier, the `PricingResult.isDeterrentRateApplied = true` field is never included in `QuotationResponseDTO` or in any guest-facing communication content.
17. **MSR violation surfaced correctly:** When the engine resolves a rate below MSR, `PolicyGateBlockedError` is raised with `blockingCondition` identifying MSR breach and `requiredActorLevel = GM`.

### Worker Registration and Behaviour

18. **QuotationExpiryWorker (W15) registered on send:** Sending a quotation causes a `QUOTATION_VALIDITY` pg-boss job to be registered with `firesAt = sentAt + (expiry.s2.quotationValidityDays * 86400)`. Double-registration does not occur — if a timer is already registered for this quotation, the existing registration is cancelled before the new one is created.
19. **QuotationAckWorker registered on send:** Sending a quotation causes a `QUOTATION_ACK_TRACKER` pg-boss job to be registered with `firesAt = sentAt + acknowledgement.windowPerType.quotation`. This fires independently of and before the validity timer (quotation ack window < validity window by design).
20. **Both timers cancelled on acceptance:** Accepting a quotation causes both the `QUOTATION_VALIDITY` and `QUOTATION_ACK_TRACKER` pg-boss jobs to be cancelled in the same transaction as the `Quotation.state → ACCEPTED` transition. After acceptance, neither timer fires.
21. **Both timers cancelled on supersession:** Creating a new quotation version causes both timers for the prior version (if in SENT state) to be cancelled in the same transaction as the prior version's `Quotation.state → SUPERSEDED` transition.
22. **Ack tracker cancelled on expiry:** When W15 transitions a quotation to EXPIRED, the `QUOTATION_ACK_TRACKER` timer is cancelled in the same transaction if still running.
23. **SpeculativeHoldExpiryWorker idempotent:** Running `SpeculativeHoldExpiryWorker` twice on the same `SpeculativeHold.id` where the first run completed successfully produces no duplicate state transitions, no duplicate `RoomClaimStateEvent`, and no duplicate `TraceEvent`. The second run emits a skip event and exits.
24. **SpeculativeHoldExpiryWorker atomic:** The `SpeculativeHold` state update and `RoomClaimStateEvent` creation are wrapped in a single database transaction. Both succeed or both roll back.
25. **AcknowledgementWindowWorker idempotent:** Running W22 twice on the same `CommunicationRecord.id` produces no duplicate `acknowledgementStatus` transition and no duplicate `TraceEvent`.

### Route Availability

26. **Five S2 routes registered:** `POST /entries/:id/quotations`, `POST /quotations/:id/send`, `POST /quotations/:id/accept`, `POST /entries/:id/holds/speculative`, `POST /entries/:id/holds/speculative/:holdId/release` — all registered with auth and validation middleware, all returning the standard response envelope.
27. **Hold release route requires L2+:** Calling `POST /entries/:id/holds/speculative/:holdId/release` with an L1 session token returns `AuthorizationError`.
28. **Hold release route idempotent on state check:** Calling the release route for a `SpeculativeHold` already in RELEASED or UPGRADED state returns `StateTransitionError` — the hold's state does not change.

### Configuration Completeness

29. **S2 declared live only when all six config keys present:** The S2 readiness check (`S2_READINESS`) fails if any of the six keys listed in Section 9 are absent from the `ConfigurationEntry` table with a current effective date range.

### Forbidden Action Prevention

30. **No committed hold at S2:** Calling `HoldService.placeCommittedHold()` from any S2 code path raises `StateTransitionError` — committed holds require S3 context.
31. **No folio creation at S2:** No `Folio` record is created for an entry in S2. Any code path that calls `FolioService` from S2 for folio creation is an architectural violation.
32. **No payment recording at S2:** No `PaymentRecord` is created at S2. Any route or service that creates a payment record from S2 context is an architectural violation.
33. **No room-specific promise:** No field on any S2 model stores a specific room assignment. The accepted quotation's `commercialTerms` may reference room type but not room number.
34. **No confirmation language in quotation:** Quotation content does not contain the words "confirmed," "secured," or equivalent language that constitutes a commercial confirmation. This is a content governance constraint — the system generates quotation documents from templates that must be reviewed for compliance.

### Quotation Versioning

35. **Supersession preserves all versions:** After a Q-002 supersedes Q-001, both records are queryable. Q-001 has `state = SUPERSEDED` and `supersededById = Q-002.id`. Q-001's `commercialTerms` are unmodified.
36. **S2 exit seals all versions:** After the S2→S3 transition, all `Quotation` records for the current segment have `sealedAt` populated. No quotation for the current segment may be edited after S2 exit.

### Speculative Hold State Machine

37. **PLACED→RELEASED on timer:** When `SpeculativeHoldExpiryWorker` fires, `SpeculativeHold.state → RELEASED`, `Room.currentClaimState → FREE`, `RoomClaimStateEvent` written, `TraceEvent` written, staff alerted.
38. **PLACED→RELEASED on staff action:** When `POST /entries/:id/holds/speculative/:holdId/release` is called by L2+, `SpeculativeHold.state → RELEASED`, `Room.currentClaimState → FREE`, `RoomClaimStateEvent` written, `TraceEvent` written, SPECULATIVE_HOLD_EXPIRY timer cancelled.

### Acknowledgement Tracking

39. **Open loop surfaced within window:** A sent quotation with no guest response has `CommunicationRecord.acknowledgementStatus = PENDING`. This surfaces as a visible open item on the custodian dashboard — it does not block S2→S3 exit while within the response window.
40. **S2 exit requires resolution when window exceeded:** Attempting S2→S3 exit when a sent quotation's `CommunicationRecord.acknowledgementStatus = TIMED_OUT` (window exceeded without response) raises `StageGateBlockedError` unless a resolution record exists — verbal acceptance TraceEvent, written acceptance, or custodian decision record.

---

### S3→S2 Re-Entry Behaviour

**AC-S2-041:** On S3→S2 back-flow: the prior `CommittedHold` remains in `PLACED` state — no `HOLD.RELEASED` or `HOLD.EXPIRED` event is emitted at the point of S3→S2 exit. A test that executes `EntryService.createSegment()` with S3→S2 re-entry and inspects the prior hold must find `CommittedHold.state = PLACED` with `expiresAt` still in the future (assuming the hold has not naturally expired). **PASS** = hold remains PLACED; no release event emitted. **FAIL** = hold released or any release-type TraceEvent emitted at S3→S2 transition.

**AC-S2-042:** On S3→S2 back-flow: all proforma invoices on the Entry-level folio remain in their existing state (`PROVISIONAL` or `DISPATCHED`) — no `SUPERSEDED` transition occurs. A test that executes S3→S2 re-entry and inspects the folio's invoices must find all PIs in their pre-transition state. **PASS** = all PI states unchanged. **FAIL** = any PI transitioned to SUPERSEDED.

**AC-S2-043:** On S3→S2 re-entry: `QuotationService.createQuotation()` surfaces the prior segment's `CommittedHold.expiresAt` as renegotiation deadline context. A test that executes S3→S2 re-entry and calls `createQuotation()` must find the prior hold's `expiresAt` accessible in the quotation creation context. **PASS** = `expiresAt` surfaced. **FAIL** = prior hold context absent from quotation creation.

**AC-S2-044:** On S3→S2 re-entry: the existing Entry-level folio's payment total (sum of `PaymentRecord` entries with `paymentDirection = 'IN'`) is visible and counted toward the advance payment threshold for the new S3 passage. A test that records a payment in the first S3 passage, executes S3→S2→S3 re-entry, and inspects the folio at the new S3 must find the prior payment record visible and counted. **PASS** = prior payment visible and counted. **FAIL** = prior payment absent or not counted.

**AC-S2-045:** On S3→S2 re-entry: if the prior segment's `CommittedHold` expires during S2 renegotiation, the new segment's S3 entry places a fresh committed hold — the system does not attempt to upgrade or extend an expired hold. A test that executes S3→S2 re-entry, advances time past the prior hold's `expiresAt`, and then progresses the new segment to S3 must result in a new `CommittedHold` being placed (not an upgrade of the expired hold) with a fresh `AvailabilityService` check confirming inventory availability. **PASS** = new hold placed after fresh availability check. **FAIL** = system attempts to upgrade expired hold or skips availability check.

---


---

*SIG-S2 v1.3 — DRAFT*
*Prepared by: Claude (AI Architectural Partner)*
*Derived from DEV-SPEC-001 Parts 1, 2, 3, 4, 5, 6, 8, 9, 11, 12, 13 (REV1/REV2/REV3 where applicable) — Canon v2.5*
*S3→S2 re-entry additions per MOM-ARCH-2026-020 and SIG-S5-PRE-008*
