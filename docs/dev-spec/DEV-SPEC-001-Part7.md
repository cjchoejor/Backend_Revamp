# LEGPHEL PMS — DEV-SPEC-001
# Part 7 — Models
# §7.1 through §7.2

**Document:** DEV-SPEC-001-Part7.md
**Status:** DRAFT — awaiting Architect review and lock confirmation
**Canon version:** v2.5
**Authority:** MOM-ARCH-2026-015
**Gate:** Gate 7 — Models
**Date:** 07 April 2026
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 7 — Models |
| Sections covered | §7.1 through §7.2 |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (Part 7 content requirements); DEV-SPEC-001-Part2.md (LOCKED — primary and nearly exclusive source; all 96 Prisma models); DEV-SPEC-001-Part6.md (LOCKED — service access patterns from which query specifications are derived) |
| Schema reference | DEV-SPEC-001-Part2.md (LOCKED) — all model names, @@map values, indexed fields, and mutation rule annotations are derived from Part 2; no model is defined or redefined here |
| Service reference | DEV-SPEC-001-Part6.md (LOCKED) — query specifications are demand-driven from service access patterns; every query spec in §7.2 exists because a specific service method requires that access pattern |
| Status | DRAFT — nothing is locked until Architect confirms |
| Previous gate | Gate 6 — Services (LOCKED, pending Architect confirmation) |
| Depends on | Parts 1–6 LOCKED; infrastructure decisions locked (pg-boss, Prisma) |
| Model count | 96 (matching the 96 @@map tables confirmed in Part 2) |

---

## §7.1 — Model Design Principles

### 7.1.1 What a Model Is

A model is the persistence layer for a single Prisma schema table. Every model in this system corresponds 1:1 with a Prisma model definition in Part 2. There are no models that do not have a corresponding `@@map` table in Part 2, and there are no Part 2 tables without a corresponding model entry in §7.2.

Models do not contain business logic. A model does not evaluate a policy, compute a derived value, apply a mutation rule, or enforce a state machine guard. Models provide structured access to the database — query specifications for common read patterns and the correct Prisma Client method calls for writes. All business logic that governs what may be written, when, and by whom lives in services, policies, engines, and state machines, not here.

### 7.1.2 Prisma Client Is the Only Database Access Mechanism

Every database interaction in the model layer uses Prisma Client methods. No raw SQL, no `$queryRaw`, no `$executeRaw`, no ORM bypass of any kind. The Prisma schema (Part 2) is the authoritative schema definition; Prisma Client is the authoritative database access mechanism. Prisma's generated type safety is a correctness guarantee — calling model methods with incorrect types is a compile-time error, not a runtime surprise.

### 7.1.3 Query Specifications Are Demand-Driven

The query specifications in §7.2 are not invented. Each specification exists because a specific service method in Part 6 requires that access pattern. The derivation path is: Part 6 service method needs a read pattern → Part 7 model carries the query specification that delivers it.

Query specifications in §7.2 are expressed as named method patterns (for example, `findById`, `findByEntry`, `findActive`) with their Prisma Client implementation. These are the method signatures the service layer calls against the model. No service method constructs its own Prisma query logic outside the model layer.

### 7.1.4 Mutation Rules Are Annotations, Not Re-Derivations

Every model entry in §7.2 carries a mutation rule annotation. These annotations are one-line restatements of the §71 mutation rules already defined in Part 2. They are not derived independently here — Part 2 is the source of truth. The annotations exist in Part 7 to give the service gate writer and code generator a local reference point without requiring a lookup into Part 2 for every model. If a mutation rule annotation in Part 7 conflicts with Part 2, Part 2 governs.

### 7.1.5 Indexed Fields

Each model entry identifies indexed fields. These are either:

- Fields that already carry `@@index` in the Part 2 Prisma schema (confirmed by reading Part 2 at gate), or
- Fields that should carry an index based on the Part 6 service access patterns (a query spec that filters or sorts on a field without an existing index is a candidate for an index recommendation, surfaced here for the Architect to confirm at migration time).

Prisma's `@@index` directive is the mechanism. No raw DDL index creation outside the migration toolchain.

### 7.1.6 Import Direction

Models are imported by services. Models do not import services, policies, engines, or state machines. The import direction is strictly downward:

```
Services → Models → Prisma Client → PostgreSQL
```

A model file that imports a service file is an architectural violation regardless of whether the build tool tolerates the circular dependency.

### 7.1.7 No Layer Skipping

Controllers do not call Prisma Client directly. Workers do not call Prisma Client directly. The model layer is the single point of access to the database for all code above it. Code that bypasses the model layer — constructing Prisma queries in a controller, a worker, or a service method that should be invoking a named model query — is an architectural violation.

---

## §7.2 — Model Catalogue

One entry per schema table. 96 entries total, matching the 96 `@@map` tables confirmed in Part 2. Entries are ordered by Part 2 section to support systematic verification.

Each entry carries:
- **Model name** — the Prisma model name from Part 2
- **Table** — the `@@map` value from Part 2
- **Query specifications** — named access patterns derived from Part 6 service needs
- **Indexed fields** — existing `@@index` from Part 2, plus any service-derived candidates marked `[candidate]`
- **Mutation rule** — one-line annotation derived from Part 2 §71

---

### 7.2.1 Lifecycle Entities

---

#### InquiryModel

**Model name:** `Inquiry`
**Table:** `inquiries`

**Query specifications:**

`findById(id: string): Promise<Inquiry | null>`
```javascript
prisma.inquiry.findUnique({ where: { id } })
```
Used by: `InquiryService` for custodian assignment, derived state computation, parking cascade evaluation.

`findByReferenceNumber(referenceNumber: string): Promise<Inquiry | null>`
```javascript
prisma.inquiry.findUnique({ where: { referenceNumber } })
```
Used by: `InquiryService.create()` duplicate detection (Policy 8); lookup by external reference.

`findByGuestProfile(guestProfileId: string): Promise<Inquiry[]>`
```javascript
prisma.inquiry.findMany({ where: { guestProfileId }, orderBy: { createdAt: 'desc' } })
```
Used by: `GuestProfileService` stay history aggregation; duplicate detection at S4.

`findActiveByGuestProfile(guestProfileId: string): Promise<Inquiry[]>`
```javascript
prisma.inquiry.findMany({
  where: { guestProfileId, entries: { some: { status: { not: { in: ['EXPIRED', 'CANCELLED', 'CLOSED'] } } } } },
  include: { entries: true }
})
```
Used by: `InquiryService` duplicate detection (Policy 8) — checks for active non-terminal entries before creating a new inquiry.

`findWithEntries(id: string): Promise<Inquiry & { entries: Entry[] } | null>`
```javascript
prisma.inquiry.findUnique({ where: { id }, include: { entries: true } })
```
Used by: `InquiryService` parking cascade; derived inquiry state computation (aggregate of entry states).

**Indexed fields:**
- `guestProfileId` — `[candidate]` — `findByGuestProfile` and `findActiveByGuestProfile` filter on this field; high-frequency at scale
- `referenceNumber` — covered by `@unique` constraint (no separate index needed)

**Mutation rule:** Created at S1; custodian and contact fields editable while active; sealed when all child entries reach terminal state; archived on closure.

---

#### EntryModel

**Model name:** `Entry`
**Table:** `entries`

**Query specifications:**

`findById(id: string): Promise<Entry | null>`
```javascript
prisma.entry.findUnique({ where: { id } })
```
Used by: `EntryService` stage progression, parking, mutation enforcement; `CancellationService`, `NoShowService`, `AmendmentService`.

`findByIdWithSegments(id: string): Promise<Entry & { segments: Segment[] } | null>`
```javascript
prisma.entry.findUnique({ where: { id }, include: { segments: { orderBy: { segmentNumber: 'asc' } } } })
```
Used by: `EntryService` re-entry consequence computation; `AmendmentService` Path 3 new segment creation.

`findByInquiry(inquiryId: string): Promise<Entry[]>`
```javascript
prisma.entry.findMany({ where: { inquiryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `InquiryService` parking cascade; derived inquiry state computation.

`findActiveByInquiry(inquiryId: string): Promise<Entry[]>`
```javascript
prisma.entry.findMany({
  where: { inquiryId, status: { not: { in: ['EXPIRED', 'CANCELLED', 'CLOSED'] } } }
})
```
Used by: `InquiryService` cascade operations on non-terminal entries.

`findByStage(stage: Stage): Promise<Entry[]>`
```javascript
prisma.entry.findMany({ where: { currentStage: stage, status: 'ACTIVE' } })
```
Used by: `NightAuditService` — assembles all active entries per stage for audit processing; `StageDwellMonitor` worker.

`findActiveAtStage(stage: Stage): Promise<Entry[]>`
```javascript
prisma.entry.findMany({ where: { currentStage: stage, status: 'ACTIVE' }, include: { reservation: true, folios: true } })
```
Used by: `NightAuditService.runNightAudit()` — assembles the night audit input from all in-house entries.

`findParked(): Promise<Entry[]>`
```javascript
prisma.entry.findMany({ where: { status: 'PARKED' } })
```
Used by: `EntryService` — park review worker; periodic unpark eligibility assessment.

**Indexed fields:**
- `inquiryId` — `[candidate]` — `findByInquiry` and `findActiveByInquiry` filter on this field; fundamental join path
- `currentStage` — `[candidate]` — `findByStage` and `findActiveAtStage` filter on this field; night audit assembles all entries by stage
- `status` — `[candidate]` — filter companion to `currentStage`; compound index `(currentStage, status)` is the recommended form

**Mutation rule:** Created at S1; provisional fields editable until commitment boundary at S4; new segment on re-entry; stage artifacts seal per stage exit rules; archived at S9 closure.

---

#### SegmentModel

**Model name:** `Segment`
**Table:** `segments`

**Query specifications:**

`findById(id: string): Promise<Segment | null>`
```javascript
prisma.segment.findUnique({ where: { id } })
```
Used by: `EntryService`, `CommunicationService` — direct segment reference.

`findCurrentByEntry(entryId: string): Promise<Segment | null>`
```javascript
prisma.segment.findFirst({
  where: { entryId, sealedAt: null },
  orderBy: { segmentNumber: 'desc' }
})
```
Used by: `EntryService` — current segment for mutation operations; any service needing the active segment context.

`findAllByEntry(entryId: string): Promise<Segment[]>`
```javascript
prisma.segment.findMany({ where: { entryId }, orderBy: { segmentNumber: 'asc' } })
```
Used by: `EntryService` full history; `AmendmentService` Path 3 segment reconstruction.

`findByEntryAndNumber(entryId: string, segmentNumber: number): Promise<Segment | null>`
```javascript
prisma.segment.findUnique({ where: { entryId_segmentNumber: { entryId, segmentNumber } } })
```
Used by: `EntryService` — covered by the `@@unique([entryId, segmentNumber])` constraint.

**Indexed fields:**
- `entryId` — covered by the `@@unique([entryId, segmentNumber])` composite constraint; that index also serves range queries by entry
- `sealedAt` — `[candidate]` — `findCurrentByEntry` filters on `sealedAt: null` to identify the unsealed (current) segment

**Mutation rule:** Created at S1 (Segment 1) and on each re-entry; only current (unsealed) segment's current stage is editable; sealed when superseded by a new segment or when entry closes.

---

#### AvailabilityConfigurationModel

**Model name:** `AvailabilityConfiguration`
**Table:** `availability_configurations`

**Query specifications:**

`findById(id: string): Promise<AvailabilityConfiguration | null>`
```javascript
prisma.availabilityConfiguration.findUnique({ where: { id } })
```
Used by: `AvailabilityService` configuration recall; staleness revalidation.

`findByEntry(entryId: string): Promise<AvailabilityConfiguration[]>`
```javascript
prisma.availabilityConfiguration.findMany({ where: { entryId }, orderBy: { createdAt: 'desc' } })
```
Used by: `AvailabilityService` — all configurations for an entry across all S1 explorations.

`findCurrentByEntry(entryId: string): Promise<AvailabilityConfiguration | null>`
```javascript
prisma.availabilityConfiguration.findFirst({
  where: { entryId, sealedAt: null },
  orderBy: { createdAt: 'desc' }
})
```
Used by: `AvailabilityService` — unsealed (active) configuration for an entry.

`findStaleByEntry(entryId: string): Promise<AvailabilityConfiguration[]>`
```javascript
prisma.availabilityConfiguration.findMany({ where: { entryId, isStale: true } })
```
Used by: `AvailabilityService` — stale configurations requiring revalidation before recall.

**Indexed fields:**
- `entryId` — `[candidate]` — all query specs filter on `entryId`; entry is the primary anchor

**Mutation rule:** Created at S1; editable during S1 including DEFICIENT acknowledgements; sealed on S1 exit; recallable with revalidation after staleness.

---

#### FollowUpTaskRecordModel

**Model name:** `FollowUpTaskRecord`
**Table:** `follow_up_task_records`

**Query specifications:**

`findById(id: string): Promise<FollowUpTaskRecord | null>`
```javascript
prisma.followUpTaskRecord.findUnique({ where: { id } })
```
Used by: FOM follow-up handler — direct lookup before status mutation (assignment, completion).

`findByEntry(entryId: string): Promise<FollowUpTaskRecord[]>`
```javascript
prisma.followUpTaskRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `S9Service` — surfaces follow-up history per entry; `AuditService` — closure audit chain.

`findOpenByAssignee(assignedTo: string): Promise<FollowUpTaskRecord[]>`
```javascript
prisma.followUpTaskRecord.findMany({ where: { assignedTo, completedAt: null }, orderBy: { dueAt: 'asc' } })
```
Used by: FOM dashboard — open follow-ups for the current actor, ordered by `dueAt`.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Created at S9 closure for CONFERENCE and GROUP entries. `completedAt`/`completedBy`/`notes` mutable until completion; entry FK is immutable. No amendment path after completion.

---

#### AmendmentEventRecordModel

**Model name:** `AmendmentEventRecord`
**Table:** `amendment_event_records`

**Query specifications:**

`findById(id: string): Promise<AmendmentEventRecord | null>`
```javascript
prisma.amendmentEventRecord.findUnique({ where: { id } })
```
Used by: `AmendmentService` — direct lookup; `AuditService` — drill-down on a specific amendment event.

`findByEntry(entryId: string): Promise<AmendmentEventRecord[]>`
```javascript
prisma.amendmentEventRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `AmendmentService` — full amendment chain for an entry; `AuditService` — Path 1/2/3 amendment audit per Part 6 §6.6.2.

`findBySegment(segmentId: string): Promise<AmendmentEventRecord[]>`
```javascript
prisma.amendmentEventRecord.findMany({ where: { segmentId }, orderBy: { createdAt: 'asc' } })
```
Used by: `AmendmentService` — segment-scoped amendments (relevant on re-entry transitions where multiple segments accumulate distinct amendment histories).

**Indexed fields:**
- `entryId` — `[candidate]`
- `segmentId` — `[candidate]`

**Mutation rule:** Immutable from creation. Amendment history is permanently readable — corrections add new events rather than mutating existing ones.

---

### 7.2.2 Inventory

---

#### RoomModel

**Model name:** `Room`
**Table:** `rooms`

**Query specifications:**

`findById(id: string): Promise<Room | null>`
```javascript
prisma.room.findUnique({ where: { id } })
```
Used by: `AvailabilityService`, `HandoffService` (H2 DEFICIENT status), `IncidentService` (room block).

`findByRoomNumber(roomNumber: string): Promise<Room | null>`
```javascript
prisma.room.findUnique({ where: { roomNumber } })
```
Used by: `AvailabilityService` direct room lookup.

`findAllWithClaimState(): Promise<Room[]>`
```javascript
prisma.room.findMany({ include: { roomType: true } })
```
Used by: `AvailabilityEngine` — full inventory snapshot for availability query.

`findDeficient(): Promise<Room[]>`
```javascript
prisma.room.findMany({ where: { isDeficient: true } })
```
Used by: `AvailabilityService` — annotates availability results with DEFICIENT flags (Policy 2); housekeeping report.

`findByClaimState(claimState: InventoryClaimState): Promise<Room[]>`
```javascript
prisma.room.findMany({ where: { currentClaimState: claimState } })
```
Used by: `AvailabilityEngine` — inventory state assembly per claim state band.

`findByRoomType(roomTypeId: string): Promise<Room[]>`
```javascript
prisma.room.findMany({ where: { roomTypeId } })
```
Used by: `AvailabilityEngine` — type-filtered availability queries.

**Indexed fields:**
- `roomNumber` — covered by `@unique` constraint
- `currentClaimState` — `[candidate]` — `findByClaimState` and availability assembly filter on this field; critical for inventory engine performance
- `isDeficient` — `[candidate]` — `findDeficient` filters on this field; surfaced on every availability query

**Mutation rule:** Physical state fields (isDeficient, isUnderMaintenance, isBlocked) updated via service layer on governed state transitions; claim state field updated via `AvailabilityService` on claim state transitions; full claim state history in `RoomClaimStateEvent`.

---

#### RoomTypeModel

**Model name:** `RoomType`
**Table:** `room_types`

**Query specifications:**

`findById(id: string): Promise<RoomType | null>`
```javascript
prisma.roomType.findUnique({ where: { id } })
```
Used by: `AvailabilityEngine` type resolution.

`findByName(name: string): Promise<RoomType | null>`
```javascript
prisma.roomType.findUnique({ where: { name } })
```
Used by: Admin Console configuration reads.

`findAll(): Promise<RoomType[]>`
```javascript
prisma.roomType.findMany({ where: { } })
```
Used by: `AvailabilityEngine` — full room type catalogue for pricing pipeline.

`findWithRatePlans(id: string): Promise<RoomType & { ratePlans: RatePlan[] } | null>`
```javascript
prisma.roomType.findUnique({ where: { id }, include: { ratePlans: true } })
```
Used by: `PricingPipelineEngine` — rate plan eligibility per room type.

**Indexed fields:**
- `name` — covered by `@unique` constraint

**Mutation rule:** Configuration record; editable via Admin Console only; operational services read but do not write this table.

---

#### RoomClaimStateEventModel

**Model name:** `RoomClaimStateEvent`
**Table:** `room_claim_state_events`

**Query specifications:**

`findByRoom(roomId: string): Promise<RoomClaimStateEvent[]>`
```javascript
prisma.roomClaimStateEvent.findMany({ where: { roomId }, orderBy: { effectiveFrom: 'asc' } })
```
Used by: `AuditService` — full claim state history for a room; inventory audit reconstruction.

`findByRoomAndDateRange(roomId: string, from: Date, to: Date): Promise<RoomClaimStateEvent[]>`
```javascript
prisma.roomClaimStateEvent.findMany({
  where: { roomId, effectiveFrom: { gte: from }, effectiveTo: { lte: to } }
})
```
Used by: `AvailabilityEngine` — date-range claim state evaluation (Model 1 — claim state is evaluated against a date range, not point-in-time).

`findByEntry(entryId: string): Promise<RoomClaimStateEvent[]>`
```javascript
prisma.roomClaimStateEvent.findMany({ where: { entryId }, orderBy: { effectiveFrom: 'asc' } })
```
Used by: `AuditService` — all claim state events anchored to an entry.

**Indexed fields:**
- `roomId` — `[candidate]` — all query specs filter on `roomId`; high-frequency join in availability resolution
- `effectiveFrom` — `[candidate]` — date-range query; compound index `(roomId, effectiveFrom)` is the recommended form
- `entryId` — `[candidate]` — `findByEntry` access pattern for entry-level audit

**Mutation rule:** Immutable from creation; append-only audit record of every claim state transition on a room.

---

#### DeficientConditionRecordModel

**Model name:** `DeficientConditionRecord`
**Table:** `deficient_condition_records`

**Query specifications:**

`findById(id: string): Promise<DeficientConditionRecord | null>`
```javascript
prisma.deficientConditionRecord.findUnique({ where: { id } })
```
Used by: `AvailabilityService` (Policy 2 annotation), `HandoffService` H2 DEFICIENT status.

`findActiveByRoom(roomId: string): Promise<DeficientConditionRecord[]>`
```javascript
prisma.deficientConditionRecord.findMany({ where: { roomId, status: 'UNRESOLVED' } })
```
Used by: `AvailabilityService` — every availability query annotates DEFICIENT rooms per Policy 2; `HandoffService` H2 inclusion.

`findByRoom(roomId: string): Promise<DeficientConditionRecord[]>`
```javascript
prisma.deficientConditionRecord.findMany({ where: { roomId }, orderBy: { detectedAt: 'desc' } })
```
Used by: `AuditService` — full DEFICIENT history for a room; housekeeping and DEFICIENT condition reports.

`findOverdue(): Promise<DeficientConditionRecord[]>`
```javascript
prisma.deficientConditionRecord.findMany({
  where: { status: 'UNRESOLVED', resolutionDeadline: { lt: new Date() } }
})
```
Used by: `DeficientConditionDeadlineWorker` — fires `DEFICIENT_RESOLUTION_DEADLINE_BREACHED` exception event.

**Indexed fields:**
- `roomId` — `[candidate]` — all query specs filter on `roomId`
- `status` — `[candidate]` — compound index `(roomId, status)` serves the critical `findActiveByRoom` path
- `resolutionDeadline` — `[candidate]` — `findOverdue` filters on deadline; worker fires on this index

**Mutation rule:** Additive resolution layer only — the resolution event is added to the record; the original detection data is not amended.

---

#### OtaConflictOverbookingRecordModel

**Model name:** `OtaConflictOverbookingRecord`
**Table:** `ota_conflict_overbooking_records`

**Query specifications:**

`findById(id: string): Promise<OtaConflictOverbookingRecord | null>`
```javascript
prisma.otaConflictOverbookingRecord.findUnique({ where: { id } })
```
Used by: `ReservationService` — overbooking detection result handling.

`findByEntry(entryId: string): Promise<OtaConflictOverbookingRecord | null>`
```javascript
prisma.otaConflictOverbookingRecord.findUnique({ where: { entryId } })
```
Used by: `ReservationService` — each entry has at most one overbooking record (`@unique` on `entryId`).

`findOpenOtaNotificationLoops(): Promise<OtaConflictOverbookingRecord[]>`
```javascript
prisma.otaConflictOverbookingRecord.findMany({
  where: { otaNotificationStatus: 'OPEN' }
})
```
Used by: `AuditService` — overbooking history report; outstanding OTA notification obligations.

**Indexed fields:**
- `entryId` — covered by `@unique` constraint

**Mutation rule:** OTA notification loop status updated via additive loop-closure events only; `triggerType` is immutable once set — OTA_CONFLICT cannot be reclassified as DELIBERATE; sealed when all loops closed.

---

#### SpaceModel

**Model name:** `Space`
**Table:** `spaces`

**Query specifications:**

`findById(id: string): Promise<Space | null>`
```javascript
prisma.space.findUnique({ where: { id } })
```
Used by: `SpaceAllocationService` — space selection for conference/event engagements.

`findByName(spaceName: string): Promise<Space | null>`
```javascript
prisma.space.findUnique({ where: { spaceName } })
```
Used by: Admin Console; `SpaceAllocationService` lookup.

`findAvailable(): Promise<Space[]>`
```javascript
prisma.space.findMany({ where: { isAvailable: true, isEventInProgress: false } })
```
Used by: `AvailabilityEngine` — space availability query for CONFERENCE and CATERING use types.

**Indexed fields:**
- `spaceName` — covered by `@unique` constraint
- `isAvailable` — `[candidate]` — `findAvailable` filter; compound index `(isAvailable, isEventInProgress)` recommended

**Mutation rule:** Configuration record; `isAvailable` and `isEventInProgress` updated by `SpaceAllocationService` on allocation and release; Admin Console manages structural space definitions.

---

#### SpaceAllocationModel

**Model name:** `SpaceAllocation`
**Table:** `space_allocations`

**Query specifications:**

`findById(id: string): Promise<SpaceAllocation | null>`
```javascript
prisma.spaceAllocation.findUnique({ where: { id } })
```
Used by: `SpaceAllocationService` — allocation lifecycle management.

`findByEntry(entryId: string): Promise<SpaceAllocation[]>`
```javascript
prisma.spaceAllocation.findMany({ where: { entryId }, orderBy: { fromDateTime: 'asc' } })
```
Used by: `SpaceAllocationService` — all allocations for an entry; `AmendmentService` downstream consequence processing.

`findActiveBySpace(spaceId: string): Promise<SpaceAllocation[]>`
```javascript
prisma.spaceAllocation.findMany({ where: { spaceId, status: 'ACTIVE' } })
```
Used by: `SpaceAllocationService` — turnaround buffer check before creating a new allocation; conflict detection.

`findBySpaceAndDateRange(spaceId: string, from: Date, to: Date): Promise<SpaceAllocation[]>`
```javascript
prisma.spaceAllocation.findMany({
  where: { spaceId, status: 'ACTIVE', fromDateTime: { lt: to }, toDateTime: { gt: from } }
})
```
Used by: `SpaceAllocationService` — overlap detection for booking window and turnaround buffer enforcement.

**Indexed fields:**
- `entryId` — `[candidate]` — `findByEntry` filter
- `spaceId` — `[candidate]` — `findActiveBySpace` and `findBySpaceAndDateRange` filter; compound index `(spaceId, status)` recommended
- `fromDateTime`, `toDateTime` — `[candidate]` — date-range overlap queries; compound index `(spaceId, fromDateTime, toDateTime)` is the recommended form

**Mutation rule:** Created at S1 through S4; status updated through lifecycle (ACTIVE → RELEASED | CANCELLED); released on event completion or cancellation.

---

#### EquipmentAllocationModel

**Model name:** `EquipmentAllocation`
**Table:** `equipment_allocations`

**Query specifications:**

`findById(id: string): Promise<EquipmentAllocation | null>`
```javascript
prisma.equipmentAllocation.findUnique({ where: { id } })
```
Used by: `SpaceAllocationService` — lifecycle management.

`findByEntry(entryId: string): Promise<EquipmentAllocation[]>`
```javascript
prisma.equipmentAllocation.findMany({ where: { entryId } })
```
Used by: `SpaceAllocationService` — all equipment allocations for an entry; `AmendmentService` downstream consequence.

`findPendingReturn(): Promise<EquipmentAllocation[]>`
```javascript
prisma.equipmentAllocation.findMany({
  where: { returnConfirmedAt: null, status: 'ALLOCATED', toDateTime: { lt: new Date() } }
})
```
Used by: `EquipmentReturnWorker` — identifies allocations past their return deadline without a return confirmation.

**Indexed fields:**
- `entryId` — `[candidate]` — `findByEntry` filter
- `toDateTime` — `[candidate]` — `findPendingReturn` filter; `EQUIPMENT_RETURN` timer fires against this field

**Mutation rule:** Created at S1–S5; `returnConfirmedAt` and `returnConfirmedBy` set on return confirmation; released after return confirmed.

---

#### AssetAllocationModel

**Model name:** `AssetAllocation`
**Table:** `asset_allocations`

**Query specifications:**

`findById(id: string): Promise<AssetAllocation | null>`
```javascript
prisma.assetAllocation.findUnique({ where: { id } })
```
Used by: `SpaceAllocationService`.

`findByEntry(entryId: string): Promise<AssetAllocation[]>`
```javascript
prisma.assetAllocation.findMany({ where: { entryId } })
```
Used by: `SpaceAllocationService` — all asset allocations for an entry.

`findPendingReturn(): Promise<AssetAllocation[]>`
```javascript
prisma.assetAllocation.findMany({
  where: { returnConfirmedAt: null, status: 'ALLOCATED', toDate: { lt: new Date() } }
})
```
Used by: `AssetReturnWorker` — identifies assets past return date without confirmation.

**Indexed fields:**
- `entryId` — `[candidate]`
- `toDate` — `[candidate]` — return deadline filter

**Mutation rule:** Created at S3–S5; `returnConfirmedAt` set on confirmed return; status updated to reflect return.

---

#### SourcingRecordModel

**Model name:** `SourcingRecord`
**Table:** `sourcing_records`

**Query specifications:**

`findById(id: string): Promise<SourcingRecord | null>`
```javascript
prisma.sourcingRecord.findUnique({ where: { id } })
```
Used by: `SpaceAllocationService`.

`findByEntry(entryId: string): Promise<SourcingRecord[]>`
```javascript
prisma.sourcingRecord.findMany({ where: { entryId } })
```
Used by: `SpaceAllocationService` — all sourcing records for an entry; cost reconciliation at S9.

`findPendingReconciliation(): Promise<SourcingRecord[]>`
```javascript
prisma.sourcingRecord.findMany({ where: { costReconciledAt: null, status: 'ACTIVE' } })
```
Used by: `SpaceAllocationService` — outstanding cost reconciliation obligations.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Created at S3–S5; `returnConfirmedAt` and `costReconciledAt` set on closure; status transitions to closed on full reconciliation.

---

#### RoomAssignmentModel

**Model name:** `RoomAssignment`
**Table:** `room_assignments`

**Query specifications:**

`findById(id: string): Promise<RoomAssignment | null>`
```javascript
prisma.roomAssignment.findUnique({ where: { id } })
```
Used by: `S5Service` — direct lookup before status mutation.

`findByEntry(entryId: string): Promise<RoomAssignment[]>`
```javascript
prisma.roomAssignment.findMany({ where: { entryId }, orderBy: { createdAt: 'desc' } })
```
Used by: `S5Service.assignRoom()` — reassignment history; `AuditService` — assignment-chain audit.

`findCurrentByEntry(entryId: string): Promise<RoomAssignment | null>`
```javascript
prisma.roomAssignment.findFirst({ where: { entryId }, orderBy: { createdAt: 'desc' } })
```
Used by: `S5Service`, `S6Service`, `S7Service` — current assignment lookup; the most-recent assignment per entry wins.

**Indexed fields:**
- `entryId` + `createdAt` — compound (covers `findByEntry`, `findCurrentByEntry`)
- `roomId` — `[candidate]`

**Mutation rule:** Immutable from creation. Reassignment to a different room creates a new `RoomAssignment` — the prior is not edited. DEFICIENT-acknowledgement fields populated at assignment time when applicable.

---

#### RoomInspectionRecordModel

**Model name:** `RoomInspectionRecord`
**Table:** `room_inspection_records`

**Query specifications:**

`findById(id: string): Promise<RoomInspectionRecord | null>`
```javascript
prisma.roomInspectionRecord.findUnique({ where: { id } })
```
Used by: `S8Service` — direct lookup; `PostCheckoutInspectionWorker` — anchor reference.

`findByEntry(entryId: string): Promise<RoomInspectionRecord[]>`
```javascript
prisma.roomInspectionRecord.findMany({ where: { entryId }, orderBy: { inspectedAt: 'asc' } })
```
Used by: `S8Service` — full inspection history per entry (re-stays generate multiple records via segment scoping).

`findBySegment(entryId: string, segmentId: string): Promise<RoomInspectionRecord | null>`
```javascript
prisma.roomInspectionRecord.findFirst({ where: { entryId, segmentId } })
```
Used by: `S8Service` — segment-specific inspection lookup (one inspection per stay segment).

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. Damage findings produce a new `DeficientConditionRecord`; the inspection record itself is not edited.

---

#### KeyReturnRecordModel

**Model name:** `KeyReturnRecord`
**Table:** `key_return_records`

**Query specifications:**

`findById(id: string): Promise<KeyReturnRecord | null>`
```javascript
prisma.keyReturnRecord.findUnique({ where: { id } })
```
Used by: `S8Service` — direct lookup.

`findByEntry(entryId: string): Promise<KeyReturnRecord[]>`
```javascript
prisma.keyReturnRecord.findMany({ where: { entryId }, orderBy: { returnedAt: 'asc' } })
```
Used by: `S8Service` — key-return history per entry; reconciliation audit.

`findUnreconciledByRoom(roomId: string): Promise<KeyReturnRecord[]>`
```javascript
prisma.keyReturnRecord.findMany({ where: { roomId, countReconciled: false }, orderBy: { returnedAt: 'desc' } })
```
Used by: `AuditService` — outstanding key-reconciliation discrepancies per room for FOM review.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. Reconciliation note required when issued and returned counts differ; not amendable.

---

### 7.2.3 Financial

---

#### FolioModel

**Model name:** `Folio`
**Table:** `folios`

**Query specifications:**

`findById(id: string): Promise<Folio | null>`
```javascript
prisma.folio.findUnique({ where: { id } })
```
Used by: `FolioService`, `NightAuditService`, `NoShowService`.

`findByEntry(entryId: string): Promise<Folio[]>`
```javascript
prisma.folio.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `FolioService` — an entry may have one Provisional and one Live folio across its lifecycle; returns both for full financial context.

`findProvisionalByEntry(entryId: string): Promise<Folio | null>`
```javascript
prisma.folio.findFirst({ where: { entryId, state: 'PROVISIONAL' } })
```
Used by: `FolioService` at S3 — restricted mutation enforcement (PIs and advance payments only).

`findLiveByEntry(entryId: string): Promise<Folio | null>`
```javascript
prisma.folio.findFirst({ where: { entryId, state: 'LIVE' } })
```
Used by: `FolioService` at S6–S9 — charge posting, credit notes, adjustment entries.

`findWithLines(id: string): Promise<Folio & { folioLines: FolioLine[] } | null>`
```javascript
prisma.folio.findUnique({ where: { id }, include: { folioLines: { orderBy: { createdAt: 'asc' } } } })
```
Used by: `FolioService` financial summary; `NightAuditEngine` input assembly.

**Indexed fields:**
- `entryId` — `[candidate]` — all query specs filter on `entryId`; fundamental financial join
- `state` — `[candidate]` — compound index `(entryId, state)` serves `findProvisionalByEntry` and `findLiveByEntry`

**Mutation rule:** Provisional folio: restricted to PIs and payment records only; converts to Live at S6 or closes as NO_SHOW_CLOSED; Live folio: append-only charge lines; sealed at S9 closure; post-closure Level 2/3 additive layers permitted.

---

#### FolioLineModel

**Model name:** `FolioLine`
**Table:** `folio_lines`

**Query specifications:**

`findById(id: string): Promise<FolioLine | null>`
```javascript
prisma.folioLine.findUnique({ where: { id } })
```
Used by: `FolioService` — credit note creation references the original line.

`findByFolio(folioId: string): Promise<FolioLine[]>`
```javascript
prisma.folioLine.findMany({ where: { folioId }, orderBy: { createdAt: 'asc' } })
```
Used by: `FolioService` financial summary; invoice assembly.

`findByFolioAndDate(folioId: string, chargeDate: Date): Promise<FolioLine[]>`
```javascript
prisma.folioLine.findMany({ where: { folioId, chargeDate: { gte: startOfDay(chargeDate), lt: endOfDay(chargeDate) } } })
```
Used by: `NightAuditService` idempotency guard — checks for existing charge on a given date before re-posting.

`findByNightAuditRecord(nightAuditRecordId: string): Promise<FolioLine[]>`
```javascript
prisma.folioLine.findMany({ where: { nightAuditRecordId } })
```
Used by: `NightAuditService` — all charges posted under a specific audit run.

**Indexed fields:**
- `folioId` — `[candidate]` — all query specs filter on `folioId`
- `chargeDate` — `[candidate]` — idempotency guard filters on date; compound index `(folioId, chargeDate)` recommended
- `nightAuditRecordId` — `[candidate]` — `findByNightAuditRecord` filter

**Mutation rule:** Immutable from creation. No UPDATE path. Corrections are additive only — a new `CreditNote` or `CommercialAdjustmentEntry`, never an edit of this record.

---

#### InvoiceModel

**Model name:** `Invoice`
**Table:** `invoices`

**Query specifications:**

`findById(id: string): Promise<Invoice | null>`
```javascript
prisma.invoice.findUnique({ where: { id } })
```
Used by: `FolioService` invoice lifecycle management.

`findByInvoiceNumber(invoiceNumber: string): Promise<Invoice | null>`
```javascript
prisma.invoice.findUnique({ where: { invoiceNumber } })
```
Used by: `FolioService` lookup by external reference number.

`findByFolio(folioId: string): Promise<Invoice[]>`
```javascript
prisma.invoice.findMany({ where: { folioId }, orderBy: { versionNumber: 'asc' } })
```
Used by: `FolioService` — full invoice version history; proforma versioning.

`findByEntry(entryId: string): Promise<Invoice[]>`
```javascript
prisma.invoice.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `FolioService` — entry-level invoice history; S9 final invoice assembly.

**Indexed fields:**
- `invoiceNumber` — covered by `@unique` constraint
- `folioId` — `[candidate]` — `findByFolio` filter
- `entryId` — `[candidate]` — `findByEntry` filter

**Mutation rule:** Not editable after dispatch; superseded versions preserved; correction via credit note or adjustment — original never edited; sealed on dispatch.

---

#### PaymentRecordModel

**Model name:** `PaymentRecord`
**Table:** `payment_records`

**Query specifications:**

`findById(id: string): Promise<PaymentRecord | null>`
```javascript
prisma.paymentRecord.findUnique({ where: { id } })
```
Used by: `FolioService`.

`findByFolio(folioId: string): Promise<PaymentRecord[]>`
```javascript
prisma.paymentRecord.findMany({ where: { folioId }, orderBy: { receivedAt: 'asc' } })
```
Used by: `FolioService` financial reconciliation; outstanding payment report.

`findByEntry(entryId: string): Promise<PaymentRecord[]>`
```javascript
prisma.paymentRecord.findMany({ where: { entryId }, orderBy: { receivedAt: 'asc' } })
```
Used by: `NoShowService` — advance payment lookup for penalty calculation.

`findByInvoice(invoiceId: string): Promise<PaymentRecord[]>`
```javascript
prisma.paymentRecord.findMany({ where: { invoiceId } })
```
Used by: `FolioService` invoice-level payment matching.

**Indexed fields:**
- `folioId` — `[candidate]`
- `entryId` — `[candidate]`
- `invoiceId` — `[candidate]`

**Mutation rule:** Immutable from creation. Not amendable. A refund is a new `PaymentRecord` with `paymentDirection = 'OUT'` — not a reversal of this record.

---

#### CreditNoteModel

**Model name:** `CreditNote`
**Table:** `credit_notes`

**Query specifications:**

`findById(id: string): Promise<CreditNote | null>`
```javascript
prisma.creditNote.findUnique({ where: { id } })
```
Used by: `FolioService`.

`findByFolio(folioId: string): Promise<CreditNote[]>`
```javascript
prisma.creditNote.findMany({ where: { folioId }, orderBy: { issuedAt: 'asc' } })
```
Used by: `FolioService` — full credit note history for folio financial summary.

`findByFolioLine(folioLineId: string): Promise<CreditNote[]>`
```javascript
prisma.creditNote.findMany({ where: { folioLineId } })
```
Used by: `FolioService` — all credit notes that offset a specific charge line.

**Indexed fields:**
- `folioId` — `[candidate]`
- `folioLineId` — `[candidate]`

**Mutation rule:** Immutable from creation.

---

#### CommercialAdjustmentEntryModel

**Model name:** `CommercialAdjustmentEntry`
**Table:** `commercial_adjustment_entries`

**Query specifications:**

`findById(id: string): Promise<CommercialAdjustmentEntry | null>`
```javascript
prisma.commercialAdjustmentEntry.findUnique({ where: { id } })
```
Used by: `FolioService` post-closure Level 3 GM adjustments.

`findByFolio(folioId: string): Promise<CommercialAdjustmentEntry[]>`
```javascript
prisma.commercialAdjustmentEntry.findMany({ where: { folioId }, orderBy: { authorisedAt: 'asc' } })
```
Used by: `FolioService` — all GM post-closure adjustments for a folio; commercial adjustment report.

**Indexed fields:**
- `folioId` — `[candidate]`

**Mutation rule:** Immutable from creation. GM authority only; not delegatable.

---

#### CommissionDueRecordModel

**Model name:** `CommissionDueRecord`
**Table:** `commission_due_records`

**Query specifications:**

`findById(id: string): Promise<CommissionDueRecord | null>`
```javascript
prisma.commissionDueRecord.findUnique({ where: { id } })
```
Used by: `FolioService` at S9 closure.

`findByEntry(entryId: string): Promise<CommissionDueRecord | null>`
```javascript
prisma.commissionDueRecord.findFirst({ where: { entryId } })
```
Used by: `FolioService` idempotency guard — confirms whether a commission-due record has already been created for this entry before creating one.

`findPendingByAgent(agentProfileId: string): Promise<CommissionDueRecord[]>`
```javascript
prisma.commissionDueRecord.findMany({ where: { agentProfileId, status: 'PENDING' } })
```
Used by: `AuditService` — commission-due report; outstanding commission obligations per agent.

**Indexed fields:**
- `entryId` — `[candidate]` — idempotency guard; `findByEntry` access
- `agentProfileId` — `[candidate]` — `findPendingByAgent` filter; compound index `(agentProfileId, status)` recommended

**Mutation rule:** Immutable from creation. Not amendable. Correction requires Level 3 additive entry. Produced only when agent profile has `commissionRate` configured.

---

#### CreditExtensionCeilingRecordModel

**Model name:** `CreditExtensionCeilingRecord`
**Table:** `credit_extension_ceiling_records`

**Query specifications:**

`findById(id: string): Promise<CreditExtensionCeilingRecord | null>`
```javascript
prisma.creditExtensionCeilingRecord.findUnique({ where: { id } })
```
Used by: `ReservationService` — ceiling carry into commitment snapshot (Policy 43).

`findByFolio(folioId: string): Promise<CreditExtensionCeilingRecord | null>`
```javascript
prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId } })
```
Used by: `FolioService`, `CreditCeilingMonitorEngine` — each folio has at most one active ceiling record (`@unique` on `folioId`).

`findWithThresholdEvents(id: string): Promise<CreditExtensionCeilingRecord & { thresholdEvents: CreditCeilingThresholdEvent[] } | null>`
```javascript
prisma.creditExtensionCeilingRecord.findUnique({ where: { id }, include: { thresholdEvents: { orderBy: { crossedAt: 'asc' } } } })
```
Used by: `CreditCeilingMonitorEngine` — full threshold crossing history for ceiling evaluation.

**Indexed fields:**
- `folioId` — covered by `@unique` constraint

**Mutation rule:** Immutable from creation. Ceiling revision creates a new record — original preserved.

---

#### CreditCeilingThresholdEventModel

**Model name:** `CreditCeilingThresholdEvent`
**Table:** `credit_ceiling_threshold_events`

**Query specifications:**

`findById(id: string): Promise<CreditCeilingThresholdEvent | null>`
```javascript
prisma.creditCeilingThresholdEvent.findUnique({ where: { id } })
```

`findByCeilingRecord(ceilingRecordId: string): Promise<CreditCeilingThresholdEvent[]>`
```javascript
prisma.creditCeilingThresholdEvent.findMany({ where: { ceilingRecordId }, orderBy: { crossedAt: 'asc' } })
```
Used by: `CreditCeilingMonitorEngine` — checks which thresholds have already been crossed before emitting a new alert (prevents duplicate threshold events).

`findByEntry(entryId: string): Promise<CreditCeilingThresholdEvent[]>`
```javascript
prisma.creditCeilingThresholdEvent.findMany({ where: { entryId }, orderBy: { crossedAt: 'asc' } })
```
Used by: `AuditService` — credit ceiling utilisation report.

**Indexed fields:**
- `ceilingRecordId` — `[candidate]`
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. Append-only threshold crossing record.

---

#### NoShowDeterminationRecordModel

**Model name:** `NoShowDeterminationRecord`
**Table:** `no_show_determination_records`

**Query specifications:**

`findById(id: string): Promise<NoShowDeterminationRecord | null>`
```javascript
prisma.noShowDeterminationRecord.findUnique({ where: { id } })
```
Used by: `NoShowService` — direct lookup; `FolioService` — operational anchor reference for the no-show penalty FolioLine and `NO_SHOW_CLOSED` folio closure.

`findByEntry(entryId: string): Promise<NoShowDeterminationRecord | null>`
```javascript
prisma.noShowDeterminationRecord.findUnique({ where: { entryId } })
```
Used by: `NoShowService.determineNoShow()` — idempotency guard: if a record already exists for this entry, the worker exits without re-applying the determination. `entryId` has `@unique` constraint — one determination per entry lifecycle.

`findByFolio(folioId: string): Promise<NoShowDeterminationRecord | null>`
```javascript
prisma.noShowDeterminationRecord.findFirst({ where: { folioId } })
```
Used by: `FolioService` — resolves the determination record that drove a `NO_SHOW_CLOSED` folio closure, for audit and penalty/refund reconciliation paths.

**Indexed fields:**
- `entryId` — covered by `@unique` constraint
- `folioId` — `[candidate]` (queried by FolioService for closure-driven lookups)

**Mutation rule:** Immutable from creation. Created by FOM at S5 on no-show determination. Not amendable. One record per entry lifecycle enforced at schema level by `@unique` on `entryId`. Anchors the no-show penalty FolioLine and the `NO_SHOW_CLOSED` folio closure. Readable at S9 for post-closure audit.

---

#### WriteOffRecordModel

**Model name:** `WriteOffRecord`
**Table:** `write_off_records`

**Query specifications:**

`findById(id: string): Promise<WriteOffRecord | null>`
```javascript
prisma.writeOffRecord.findUnique({ where: { id } })
```
Used by: `FolioService` — direct lookup; `AuditService` — write-off audit anchor.

`findByFolio(folioId: string): Promise<WriteOffRecord[]>`
```javascript
prisma.writeOffRecord.findMany({ where: { folioId }, orderBy: { createdAt: 'asc' } })
```
Used by: `FolioService` — full write-off history per folio.

`findByEntry(entryId: string): Promise<WriteOffRecord[]>`
```javascript
prisma.writeOffRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'desc' } })
```
Used by: `AuditService` — entry-level write-off chain.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. GM authority enforced at the service layer. Reversal (rare) is a new adjustment entry on the folio — the `WriteOffRecord` itself is not edited.

---

#### BillingModelTransitionRecordModel

**Model name:** `BillingModelTransitionRecord`
**Table:** `billing_model_transition_records`

**Query specifications:**

`findById(id: string): Promise<BillingModelTransitionRecord | null>`
```javascript
prisma.billingModelTransitionRecord.findUnique({ where: { id } })
```
Used by: `FolioService` — direct lookup.

`findByFolio(folioId: string): Promise<BillingModelTransitionRecord[]>`
```javascript
prisma.billingModelTransitionRecord.findMany({ where: { folioId }, orderBy: { effectiveFrom: 'asc' } })
```
Used by: `FolioService` — full billing-model transition history; `AuditService` — Policy 30/31/32 audit chain.

`findBySegment(segmentId: string): Promise<BillingModelTransitionRecord[]>`
```javascript
prisma.billingModelTransitionRecord.findMany({ where: { segmentId }, orderBy: { effectiveFrom: 'asc' } })
```
Used by: `FolioService` — segment-scoped transitions for re-entry analysis.

**Indexed fields:**
- `folioId` — `[candidate]`
- `segmentId` — `[candidate]`

**Mutation rule:** Immutable from creation. Initial S3 fixation has `fromModel = null`; transitions at S7 carry the prior value. FOM minimum authority enforced at the service layer.

---

#### CancellationDisclosureRecordModel

**Model name:** `CancellationDisclosureRecord`
**Table:** `cancellation_disclosure_records`

**Query specifications:**

`findById(id: string): Promise<CancellationDisclosureRecord | null>`
```javascript
prisma.cancellationDisclosureRecord.findUnique({ where: { id } })
```
Used by: `ReservationService` — direct lookup at S4 commitment validation.

`findByEntry(entryId: string): Promise<CancellationDisclosureRecord[]>`
```javascript
prisma.cancellationDisclosureRecord.findMany({ where: { entryId }, orderBy: { disclosedAt: 'asc' } })
```
Used by: `ReservationService` — full disclosure chain (re-disclosure on amended terms creates new records).

`findLatestByEntry(entryId: string): Promise<CancellationDisclosureRecord | null>`
```javascript
prisma.cancellationDisclosureRecord.findFirst({ where: { entryId }, orderBy: { disclosedAt: 'desc' } })
```
Used by: `ReservationService` — current effective disclosure; `S5Service`, `NoShowService` — terms reference at no-show penalty calculation.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. Re-disclosure (amended terms) creates a new record; prior is preserved. Created before committed hold placement at S3; `noShowTreatmentStatement` is mandatory.

---

### 7.2.4 Rate and Pricing

---

#### RatePlanModel

**Model name:** `RatePlan`
**Table:** `rate_plan_registry`

**Query specifications:**

`findById(id: string): Promise<RatePlan | null>`
```javascript
prisma.ratePlan.findUnique({ where: { id } })
```
Used by: `PricingPipelineEngine` — rate plan resolution.

`findByName(name: string): Promise<RatePlan | null>`
```javascript
prisma.ratePlan.findUnique({ where: { name } })
```
Used by: Admin Console rate plan management.

`findActive(): Promise<RatePlan[]>`
```javascript
prisma.ratePlan.findMany({ where: { isActive: true, validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] } })
```
Used by: `PricingPipelineEngine` — all currently active rate plans for priority resolution.

`findActiveByType(ratePlanType: RatePlanType): Promise<RatePlan[]>`
```javascript
prisma.ratePlan.findMany({ where: { isActive: true, ratePlanType } })
```
Used by: `PricingPipelineEngine` — type-band resolution in priority order (Individual → Promotional → Tier → Channel → Rack).

`findWithSeasonCalendars(id: string): Promise<RatePlan & { seasonCalendars: SeasonCalendar[] } | null>`
```javascript
prisma.ratePlan.findUnique({ where: { id }, include: { seasonCalendars: true } })
```
Used by: `PricingPipelineEngine` — seasonal multiplier resolution.

**Indexed fields:**
- `name` — covered by `@unique` constraint
- `ratePlanType` — `[candidate]` — `findActiveByType` filter; compound index `(ratePlanType, isActive)` recommended
- `isActive` — `[candidate]` — `findActive` filter

**Mutation rule:** Editable via Admin Console; rate plan validity period and active flag configurable; operational services read but do not write this table.

---

#### SeasonCalendarModel

**Model name:** `SeasonCalendar`
**Table:** `season_calendar`

**Query specifications:**

`findById(id: string): Promise<SeasonCalendar | null>`
```javascript
prisma.seasonCalendar.findUnique({ where: { id } })
```

`findByRatePlan(ratePlanId: string): Promise<SeasonCalendar[]>`
```javascript
prisma.seasonCalendar.findMany({ where: { ratePlanId }, orderBy: { fromDate: 'asc' } })
```
Used by: `PricingPipelineEngine` — seasonal multiplier lookup.

`findActiveForDate(ratePlanId: string, date: Date): Promise<SeasonCalendar | null>`
```javascript
prisma.seasonCalendar.findFirst({
  where: { ratePlanId, fromDate: { lte: date }, toDate: { gte: date } }
})
```
Used by: `PricingPipelineEngine` — per-night rate calculation.

**Indexed fields:**
- `ratePlanId` — `[candidate]`
- `fromDate`, `toDate` — `[candidate]` — date containment queries; compound index `(ratePlanId, fromDate, toDate)` recommended

**Mutation rule:** Configuration record; managed via Admin Console.

---

#### PackageRegistryModel

**Model name:** `PackageRegistry`
**Table:** `package_registry`

**Query specifications:**

`findById(id: string): Promise<PackageRegistry | null>`
```javascript
prisma.packageRegistry.findUnique({ where: { id } })
```

`findByName(name: string): Promise<PackageRegistry | null>`
```javascript
prisma.packageRegistry.findUnique({ where: { name } })
```

`findActiveWithInclusions(): Promise<(PackageRegistry & { inclusions: PackageInclusion[] })[]>`
```javascript
prisma.packageRegistry.findMany({ where: { isActive: true }, include: { inclusions: true } })
```
Used by: `PricingPipelineEngine` — package inclusion resolution for pricing.

**Indexed fields:**
- `name` — covered by `@unique` constraint

**Mutation rule:** Configuration record; managed via Admin Console.

---

#### PackageInclusionModel

**Model name:** `PackageInclusion`
**Table:** `package_inclusions`

**Query specifications:**

`findById(id: string): Promise<PackageInclusion | null>`
```javascript
prisma.packageInclusion.findUnique({ where: { id } })
```

`findByPackage(packageId: string): Promise<PackageInclusion[]>`
```javascript
prisma.packageInclusion.findMany({ where: { packageId } })
```
Used by: `PricingPipelineEngine` — inclusions for a selected package.

**Indexed fields:**
- `packageId` — `[candidate]`

**Mutation rule:** Configuration record; managed via Admin Console.

---

#### FocConfigurationModel

**Model name:** `FocConfiguration`
**Table:** `foc_configurations`

**Query specifications:**

`findById(id: string): Promise<FocConfiguration | null>`
```javascript
prisma.focConfiguration.findUnique({ where: { id } })
```

`findActiveByRatePlan(ratePlanId: string): Promise<FocConfiguration | null>`
```javascript
prisma.focConfiguration.findFirst({ where: { ratePlanId, isActive: true } })
```
Used by: `FOCValidationEngine` — FOC eligibility resolution for a given rate plan.

**Indexed fields:**
- `ratePlanId` — `[candidate]`

**Mutation rule:** Configuration record; managed via Admin Console.

---

### 7.2.5 Profiles

---

#### GuestProfileModel

**Model name:** `GuestProfile`
**Table:** `guest_profiles`

**Query specifications:**

`findById(id: string): Promise<GuestProfile | null>`
```javascript
prisma.guestProfile.findUnique({ where: { id } })
```
Used by: `GuestProfileService`, `InquiryService`, `AIAgentApprovalService` context assembly.

`findByEmail(email: string): Promise<GuestProfile[]>`
```javascript
prisma.guestProfile.findMany({ where: { email } })
```
Used by: `GuestProfileService` deduplication at S1.

`findByPhone(phone: string): Promise<GuestProfile[]>`
```javascript
prisma.guestProfile.findMany({ where: { phone } })
```
Used by: `GuestProfileService` deduplication at S1.

`findWithIdentityDocuments(id: string): Promise<GuestProfile & { identityDocuments: GuestIdentityDocument[] } | null>`
```javascript
prisma.guestProfile.findUnique({ where: { id }, include: { identityDocuments: true } })
```
Used by: `GuestProfileService.verifyIdentity()` at S6 (Policy 16).

`findWithTierHistory(id: string): Promise<GuestProfile & { tierChangeEvents: GuestTierChangeEvent[] } | null>`
```javascript
prisma.guestProfile.findUnique({ where: { id }, include: { tierChangeEvents: { orderBy: { changedAt: 'asc' } } } })
```
Used by: `GuestProfileService` — tier history; deterrent rate assignment check.

**Indexed fields:**
- `email` — `[candidate]` — deduplication filter; nullable but frequently queried
- `phone` — `[candidate]` — deduplication filter
- `clientTier` — `[candidate]` — deterrent rate assignment check filters on tier

**Mutation rule:** Living record; editable fields (contact info, preferences) updated directly; tier changes produce layered `GuestTierChangeEvent` records, not direct field edits; never fully sealed.

---

#### GuestIdentityDocumentModel

**Model name:** `GuestIdentityDocument`
**Table:** `guest_identity_documents`

**Query specifications:**

`findById(id: string): Promise<GuestIdentityDocument | null>`
```javascript
prisma.guestIdentityDocument.findUnique({ where: { id } })
```

`findByGuestProfile(guestProfileId: string): Promise<GuestIdentityDocument[]>`
```javascript
prisma.guestIdentityDocument.findMany({ where: { guestProfileId }, orderBy: { capturedAt: 'desc' } })
```
Used by: `GuestProfileService.verifyIdentity()` at S6.

`findExpiredRetention(): Promise<GuestIdentityDocument[]>`
```javascript
prisma.guestIdentityDocument.findMany({ where: { retentionExpiresAt: { lt: new Date() } } })
```
Used by: `IdentityDocumentRetentionWorker` — governs data deletion at configured retention boundary (Policy 17).

**Indexed fields:**
- `guestProfileId` — `[candidate]`
- `retentionExpiresAt` — `[candidate]` — retention worker filter

**Mutation rule:** Immutable from creation. Retention period is configurable — never hardcoded. Deletion at retention boundary is governed by Policy 17 and executed by the retention worker.

---

#### GuestTierChangeEventModel

**Model name:** `GuestTierChangeEvent`
**Table:** `guest_tier_change_events`

**Query specifications:**

`findById(id: string): Promise<GuestTierChangeEvent | null>`
```javascript
prisma.guestTierChangeEvent.findUnique({ where: { id } })
```

`findByGuestProfile(guestProfileId: string): Promise<GuestTierChangeEvent[]>`
```javascript
prisma.guestTierChangeEvent.findMany({ where: { guestProfileId }, orderBy: { changedAt: 'asc' } })
```
Used by: `GuestProfileService` — full tier history for a guest.

**Indexed fields:**
- `guestProfileId` — `[candidate]`

**Mutation rule:** Immutable from creation. Tier changes are layered events — not direct edits to `GuestProfile.clientTier`.

---

#### AgentProfileModel

**Model name:** `AgentProfile`
**Table:** `agent_profiles`

**Query specifications:**

`findById(id: string): Promise<AgentProfile | null>`
```javascript
prisma.agentProfile.findUnique({ where: { id } })
```
Used by: `GuestProfileService`, `PricingPipelineEngine` (rate eligibility), `FolioService` (commission rate check).

`findActive(): Promise<AgentProfile[]>`
```javascript
prisma.agentProfile.findMany({ where: { isActive: true } })
```
Used by: Admin Console; agent performance report.

`findByAgencyName(agencyName: string): Promise<AgentProfile | null>`
```javascript
prisma.agentProfile.findFirst({ where: { agencyName } })
```
Used by: `GuestProfileService` deduplication.

**Indexed fields:**
- `agencyName` — `[candidate]` — deduplication lookup

**Mutation rule:** Living record; editable fields (contact info, rate eligibility, commission configuration) updated directly; never fully sealed.

---

#### CorporateProfileModel

**Model name:** `CorporateProfile`
**Table:** `corporate_profiles`

**Query specifications:**

`findById(id: string): Promise<CorporateProfile | null>`
```javascript
prisma.corporateProfile.findUnique({ where: { id } })
```
Used by: `GuestProfileService`, `PricingPipelineEngine` (corporate rate agreements), `FolioService` (credit ceiling check).

`findActive(): Promise<CorporateProfile[]>`
```javascript
prisma.corporateProfile.findMany({ where: { isActive: true } })
```

`findByCompanyName(companyName: string): Promise<CorporateProfile | null>`
```javascript
prisma.corporateProfile.findFirst({ where: { companyName } })
```
Used by: `GuestProfileService` deduplication.

**Indexed fields:**
- `companyName` — `[candidate]`

**Mutation rule:** Living record; editable fields updated directly; never fully sealed.

---

### 7.2.6 Communication and AI

---

#### CommunicationRecordModel

**Model name:** `CommunicationRecord`
**Table:** `communication_records`

**Query specifications:**

`findById(id: string): Promise<CommunicationRecord | null>`
```javascript
prisma.communicationRecord.findUnique({ where: { id } })
```
Used by: `CommunicationService`, `VoiceNoteRoutingService`, `AIAgentApprovalService`.

`findByEntry(entryId: string): Promise<CommunicationRecord[]>`
```javascript
prisma.communicationRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `CommunicationService` threading; `AIAgentApprovalService` context assembly.

`findBySegment(segmentId: string): Promise<CommunicationRecord[]>`
```javascript
prisma.communicationRecord.findMany({ where: { segmentId }, orderBy: { createdAt: 'asc' } })
```
Used by: `CommunicationService` — segment-scoped communication history.

`findByInquiry(inquiryId: string): Promise<CommunicationRecord[]>`
```javascript
prisma.communicationRecord.findMany({ where: { inquiryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `CommunicationService` — inquiry-level communication thread.

`findPendingAcknowledgements(): Promise<CommunicationRecord[]>`
```javascript
prisma.communicationRecord.findMany({
  where: { acknowledgementStatus: 'PENDING', direction: 'OUTBOUND', acknowledgementTimeoutAt: { lt: new Date() } }
})
```
Used by: `AcknowledgementTimeoutWorker` — fires `ACKNOWLEDGEMENT_TIMEOUT` event.

`findPendingVoiceNoteReviews(): Promise<CommunicationRecord[]>`
```javascript
prisma.communicationRecord.findMany({
  where: { messageType: 'VOICE_NOTE', voiceNoteSlaBreach: false, acknowledgementStatus: 'PENDING' }
})
```
Used by: `VoiceNoteSlaWorker` — checks open voice notes approaching SLA breach.

**Indexed fields:**
- `entryId` — `[candidate]`
- `segmentId` — `[candidate]`
- `inquiryId` — `[candidate]`
- `acknowledgementStatus` — `[candidate]` — compound index `(acknowledgementStatus, direction)` for `findPendingAcknowledgements`
- `messageType` — `[candidate]` — compound index `(messageType, acknowledgementStatus)` for voice note worker

**Mutation rule:** Immutable from creation. Not editable. Not amendable. A correction or follow-up produces a new `CommunicationRecord`.

---

#### AiDraftRecordModel

**Model name:** `AiDraftRecord`
**Table:** `ai_draft_records`

**Query specifications:**

`findById(id: string): Promise<AiDraftRecord | null>`
```javascript
prisma.aiDraftRecord.findUnique({ where: { id } })
```
Used by: `AIAgentApprovalService`, `CommunicationService.send()` — verifies human decision before outbound send.

`findByInboundMessage(inboundMessageId: string): Promise<AiDraftRecord[]>`
```javascript
prisma.aiDraftRecord.findMany({ where: { inboundMessageId }, orderBy: { createdAt: 'desc' } })
```
Used by: `AIAgentApprovalService` — all drafts produced for a given inbound message.

`findPendingReview(): Promise<AiDraftRecord[]>`
```javascript
prisma.aiDraftRecord.findMany({ where: { status: 'PENDING_REVIEW' } })
```
Used by: `AiDraftReviewTtlWorker` — identifies drafts in PENDING_REVIEW state; fires `AI_DRAFT_REVIEW_TTL_EXCEEDED` when review window exceeded.

`findPendingReviewByTtl(): Promise<AiDraftRecord[]>`
```javascript
prisma.aiDraftRecord.findMany({
  where: { status: 'PENDING_REVIEW', reviewTtlExpiresAt: { lt: new Date() } }
})
```
Used by: `AiDraftReviewTtlWorker` — drafts whose review TTL has expired.

**Indexed fields:**
- `inboundMessageId` — `[candidate]`
- `status` — `[candidate]` — compound index `(status, reviewTtlExpiresAt)` for TTL worker
- `entryId` — `[candidate]` — entry-level AI draft lookups

**Mutation rule:** Immutable from creation. The AI agent may not approve its own draft — a human `HumanDecisionRecord` is mandatory before outbound send.

---

#### HumanDecisionRecordModel

**Model name:** `HumanDecisionRecord`
**Table:** `human_decision_records`

**Query specifications:**

`findById(id: string): Promise<HumanDecisionRecord | null>`
```javascript
prisma.humanDecisionRecord.findUnique({ where: { id } })
```
Used by: `CommunicationService.send()` — second-layer enforcement that human approval exists before outbound send.

`findByAiDraft(aiDraftId: string): Promise<HumanDecisionRecord | null>`
```javascript
prisma.humanDecisionRecord.findFirst({ where: { aiDraftRecord: { some: { id: aiDraftId } } } })
```
Used by: `CommunicationService.send()` — confirms that a decision exists for the given draft before permitting send.

`findByActor(actorId: string): Promise<HumanDecisionRecord[]>`
```javascript
prisma.humanDecisionRecord.findMany({ where: { actorId }, orderBy: { decidedAt: 'desc' } })
```
Used by: `AuditService` — AI audit supplement report; human decision attribution.

**Indexed fields:**
- `actorId` — `[candidate]`
- `decidedAt` — `[candidate]`

**Mutation rule:** Immutable from creation. Actor must be a human actor — AI actor identity is forbidden on this record.

---

#### CorrectionRecordModel

**Model name:** `CorrectionRecord`
**Table:** `correction_records`

**Query specifications:**

`findById(id: string): Promise<CorrectionRecord | null>`
```javascript
prisma.correctionRecord.findUnique({ where: { id } })
```

`findByActorAndCategory(actorId: string, intentCategory: string): Promise<CorrectionRecord[]>`
```javascript
prisma.correctionRecord.findMany({ where: { actorId, intentCategory }, orderBy: { aggregatedAt: 'desc' } })
```
Used by: `AIAgentApprovalService` — pattern rule registry input; correction frequency per actor per intent category.

`findByPeriod(from: Date, to: Date): Promise<CorrectionRecord[]>`
```javascript
prisma.correctionRecord.findMany({
  where: { periodFrom: { gte: from }, periodTo: { lte: to } }
})
```
Used by: `AuditService` — AI audit supplement report; correction pattern analysis for FOM/GM review.

**Indexed fields:**
- `actorId` — `[candidate]`
- `intentCategory` — `[candidate]` — compound index `(actorId, intentCategory)` for pattern lookup
- `periodFrom`, `periodTo` — `[candidate]` — period filter for reporting

**Mutation rule:** Immutable from creation. Per-actor, per-intent-category aggregation record produced by the correction log aggregation worker.

---

#### AiAuditSupplementRecordModel

**Model name:** `AiAuditSupplementRecord`
**Table:** `ai_audit_supplement_records`

**Query specifications:**

`findById(id: string): Promise<AiAuditSupplementRecord | null>`
```javascript
prisma.aiAuditSupplementRecord.findUnique({ where: { id } })
```

`findByNightAuditRecord(nightAuditRecordId: string): Promise<AiAuditSupplementRecord | null>`
```javascript
prisma.aiAuditSupplementRecord.findUnique({ where: { nightAuditRecordId } })
```
Used by: `NightAuditService` — after night audit completes, attaches AI supplement; one supplement per audit (`@unique` on `nightAuditRecordId`).

`findPendingFomReview(): Promise<AiAuditSupplementRecord[]>`
```javascript
prisma.aiAuditSupplementRecord.findMany({ where: { fomReviewStatus: 'PENDING' } })
```
Used by: `AuditService` — AI audit supplement report; FOM review queue.

**Indexed fields:**
- `nightAuditRecordId` — covered by `@unique` constraint
- `fomReviewStatus` — `[candidate]` — FOM review queue filter

**Mutation rule:** Immutable from creation. Generated as a `TrustLevel.FULL_AUTO` internal SYSTEM action — no human approval required for supplement generation (it is an internal observation, not an outbound communication).

---

#### StaffListeningSummaryRecordModel

**Model name:** `StaffListeningSummaryRecord`
**Table:** `staff_listening_summary_records`

**Query specifications:**

`findById(id: string): Promise<StaffListeningSummaryRecord | null>`
```javascript
prisma.staffListeningSummaryRecord.findUnique({ where: { id } })
```
Used by: `CommunicationService.completeVoiceNoteReview()` — verifies summary exists before marking review complete.

`findByVoiceNote(voiceNoteCommunicationId: string): Promise<StaffListeningSummaryRecord[]>`
```javascript
prisma.staffListeningSummaryRecord.findMany({ where: { voiceNoteCommunicationId }, orderBy: { reviewedAt: 'asc' } })
```
Used by: `VoiceNoteRoutingService` — confirms required structured summary fields have been written before status transition.

**Indexed fields:**
- `voiceNoteCommunicationId` — `[candidate]`
- `staffActorId` — `[candidate]` — actor-level audit

**Mutation rule:** Immutable from creation. Output of human staff review of a voice note — staff actor only; AI actor is excluded from this record type.

---

#### VIPArrivalNotificationEventModel

**Model name:** `VIPArrivalNotificationEvent`
**Table:** `vip_arrival_notification_events`

**Query specifications:**

`findById(id: string): Promise<VIPArrivalNotificationEvent | null>`
```javascript
prisma.vIPArrivalNotificationEvent.findUnique({ where: { id } })
```
Used by: `VipArrivalNotificationWorker` — direct lookup; `AuditService` — notification audit anchor.

`findByEntry(entryId: string): Promise<VIPArrivalNotificationEvent[]>`
```javascript
prisma.vIPArrivalNotificationEvent.findMany({ where: { entryId }, orderBy: { checkInInitiatedAt: 'asc' } })
```
Used by: `S5Service`, `S6Service` — VIP notification history per entry; re-stays may generate multiple events.

`findByGuestProfile(guestProfileId: string): Promise<VIPArrivalNotificationEvent[]>`
```javascript
prisma.vIPArrivalNotificationEvent.findMany({ where: { guestProfileId }, orderBy: { checkInInitiatedAt: 'desc' } })
```
Used by: `GuestProfileService` — VIP touchpoint history across all stays for relationship audit.

**Indexed fields:**
- `entryId` — `[candidate]`

**Mutation rule:** Immutable from creation. Recipient distribution governed by `vip_notification_routing_configs`; dispatch is a parallel concern — this record is the audit anchor for the notification event itself.

---

### 7.2.7 Work Orders

---

#### WorkOrderModel

**Model name:** `WorkOrder`
**Table:** `work_orders`

**Query specifications:**

`findById(id: string): Promise<WorkOrder | null>`
```javascript
prisma.workOrder.findUnique({ where: { id } })
```
Used by: `WorkOrderService`.

`findByEntry(entryId: string): Promise<WorkOrder[]>`
```javascript
prisma.workOrder.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `WorkOrderService` — all work orders for an entry; `AmendmentService` downstream consequence processing.

`findOpenByEntry(entryId: string): Promise<WorkOrder[]>`
```javascript
prisma.workOrder.findMany({ where: { entryId, status: 'OPEN' } })
```
Used by: `WorkOrderService` — S8 closure check; open work orders must be closed or have all items cancelled before S8 exit.

**Indexed fields:**
- `entryId` — `[candidate]` — all query specs filter on `entryId`

**Mutation rule:** Amendments layered throughout lifecycle via `WorkOrderAmendmentEvent` — every change is a new layer; the work order record itself updates its `version` counter; sealed on S8 closure.

---

#### WorkOrderAmendmentEventModel

**Model name:** `WorkOrderAmendmentEvent`
**Table:** `work_order_amendment_events`

**Query specifications:**

`findById(id: string): Promise<WorkOrderAmendmentEvent | null>`
```javascript
prisma.workOrderAmendmentEvent.findUnique({ where: { id } })
```

`findByWorkOrder(workOrderId: string): Promise<WorkOrderAmendmentEvent[]>`
```javascript
prisma.workOrderAmendmentEvent.findMany({ where: { workOrderId }, orderBy: { amendedAt: 'asc' } })
```
Used by: `WorkOrderService` — full amendment history for a work order; audit reconstruction.

**Indexed fields:**
- `workOrderId` — `[candidate]`

**Mutation rule:** Immutable from creation. Append-only amendment event.

---

#### WorkOrderToDoItemModel

**Model name:** `WorkOrderToDoItem`
**Table:** `work_order_todo_items`

**Query specifications:**

`findById(id: string): Promise<WorkOrderToDoItem | null>`
```javascript
prisma.workOrderToDoItem.findUnique({ where: { id } })
```
Used by: `WorkOrderService` status transitions.

`findByWorkOrder(workOrderId: string): Promise<WorkOrderToDoItem[]>`
```javascript
prisma.workOrderToDoItem.findMany({ where: { workOrderId }, orderBy: { createdAt: 'asc' } })
```
Used by: `WorkOrderService` — all items for a work order; S8 closure completeness check.

`findOpenByWorkOrder(workOrderId: string): Promise<WorkOrderToDoItem[]>`
```javascript
prisma.workOrderToDoItem.findMany({ where: { workOrderId, status: { in: ['PENDING', 'IN_PROGRESS'] } } })
```
Used by: `WorkOrderService` — S8 gate check; no open items may exist at work order closure.

**Indexed fields:**
- `workOrderId` — `[candidate]` — all query specs filter on `workOrderId`
- `status` — `[candidate]` — compound index `(workOrderId, status)` for open-item check

**Mutation rule:** Status transitions (PENDING → IN_PROGRESS → COMPLETED | CANCELLED) via service layer; completion evidence required; cancellation reason mandatory.

---

#### WorkOrderConsumptionRecordModel

**Model name:** `WorkOrderConsumptionRecord`
**Table:** `work_order_consumption_records`

**Query specifications:**

`findById(id: string): Promise<WorkOrderConsumptionRecord | null>`
```javascript
prisma.workOrderConsumptionRecord.findUnique({ where: { id } })
```

`findByWorkOrder(workOrderId: string): Promise<WorkOrderConsumptionRecord[]>`
```javascript
prisma.workOrderConsumptionRecord.findMany({ where: { workOrderId }, orderBy: { recordedAt: 'asc' } })
```
Used by: `WorkOrderService` — over-allocation detection; consumption reconciliation.

**Indexed fields:**
- `workOrderId` — `[candidate]`

**Mutation rule:** Immutable from creation. Over-allocation requires explicit acknowledgement event — not auto-permitted.

---

#### PreArrivalTaskModel

**Model name:** `PreArrivalTask`
**Table:** `pre_arrival_tasks`

**Query specifications:**

`findById(id: string): Promise<PreArrivalTask | null>`
```javascript
prisma.preArrivalTask.findUnique({ where: { id } })
```
Used by: `S5Service.updatePreArrivalTask()` — direct lookup before status mutation.

`findByEntry(entryId: string): Promise<PreArrivalTask[]>`
```javascript
prisma.preArrivalTask.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `S5Service` — pre-arrival readiness checklist for an entry; `PreArrivalService` — task aggregation for the operator view.

`findOpenByEntry(entryId: string): Promise<PreArrivalTask[]>`
```javascript
prisma.preArrivalTask.findMany({ where: { entryId, status: { in: ['PENDING', 'IN_PROGRESS'] } } })
```
Used by: `S5Service` — open-task count for stage-progression gates (S5 → S6 readiness check).

`findByTaskTypeAndSource(entryId: string, taskType: PreArrivalTaskType, sourceRecordId: string | null): Promise<PreArrivalTask | null>`
```javascript
prisma.preArrivalTask.findFirst({ where: { entryId, taskType, sourceRecordId } })
```
Used by: `S5Service.initialisePreArrivalTasks()` — idempotency guard; prevents duplicate task creation when the same seed runs multiple times.

**Indexed fields:**
- `entryId` — `[candidate]` — covered by compound `(entryId, status)` from schema
- `status` — included in compound above

**Mutation rule:** Status transitions through PENDING → IN_PROGRESS → COMPLETED | WAIVED. Waiver requires `waivedReason` + `waivedBy`. No amendment path — corrections create new tasks rather than mutating existing ones.

---

### 7.2.8 Dispute and Service Recovery

---

#### DisputeRecordModel

**Model name:** `DisputeRecord`
**Table:** `dispute_records`

**Query specifications:**

`findById(id: string): Promise<DisputeRecord | null>`
```javascript
prisma.disputeRecord.findUnique({ where: { id } })
```
Used by: `DisputeService`, `AmendmentService`, `DisputeGateEngine`.

`findByEntry(entryId: string): Promise<DisputeRecord[]>`
```javascript
prisma.disputeRecord.findMany({ where: { entryId }, orderBy: { detectedAt: 'asc' } })
```
Used by: `DisputeService`, `DisputeGateEngine` — all disputes anchored to an entry.

`findActiveByEntry(entryId: string): Promise<DisputeRecord[]>`
```javascript
prisma.disputeRecord.findMany({
  where: { entryId, state: { in: ['OPEN', 'IN_PROGRESS', 'REOPENED'] } }
})
```
Used by: `DisputeGateEngine.canProgressStage()` — the presence of any active dispute is evaluated before stage gate clearance at S7→S8.

`findWithResolutionBundles(id: string): Promise<DisputeRecord & { resolutionBundles: ResolutionBundle[] } | null>`
```javascript
prisma.disputeRecord.findUnique({ where: { id }, include: { resolutionBundles: { include: { items: true } } } })
```
Used by: `DisputeService` — full resolution bundle history; escalation path.

**Indexed fields:**
- `entryId` — `[candidate]` — all query specs filter on `entryId`
- `state` — `[candidate]` — compound index `(entryId, state)` for `findActiveByEntry`; the DisputeGateEngine calls this on every stage gate evaluation

**Mutation rule:** Status transitions through lifecycle; resolution attempts layered additively; sealed on RESOLVED or CLOSED. `DISPUTE_EXHAUSTED` is not a valid state and must never be created.

---

#### ServiceRecoveryRecordModel

**Model name:** `ServiceRecoveryRecord`
**Table:** `service_recovery_records`

**Query specifications:**

`findById(id: string): Promise<ServiceRecoveryRecord | null>`
```javascript
prisma.serviceRecoveryRecord.findUnique({ where: { id } })
```

`findByEntry(entryId: string): Promise<ServiceRecoveryRecord[]>`
```javascript
prisma.serviceRecoveryRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `DisputeService` — dispute and service recovery report.

`findByDispute(disputeId: string): Promise<ServiceRecoveryRecord | null>`
```javascript
prisma.serviceRecoveryRecord.findUnique({ where: { disputeId } })
```
Used by: `DisputeService` — linked service recovery for a given dispute (`@unique` on `disputeId`).

**Indexed fields:**
- `entryId` — `[candidate]`
- `disputeId` — covered by `@unique` constraint

**Mutation rule:** Cannot be suppressed once created. Permanent record. Status transitions (OPEN → CLOSED) permitted.

---

#### DisputeGateOverrideRecordModel

**Model name:** `DisputeGateOverrideRecord`
**Table:** `dispute_gate_override_records`

**Query specifications:**

`findById(id: string): Promise<DisputeGateOverrideRecord | null>`
```javascript
prisma.disputeGateOverrideRecord.findUnique({ where: { id } })
```

`findByDispute(disputeId: string): Promise<DisputeGateOverrideRecord[]>`
```javascript
prisma.disputeGateOverrideRecord.findMany({ where: { disputeId }, orderBy: { overrideAt: 'asc' } })
```
Used by: `DisputeService` — all GM overrides for a given dispute; governance report input.

`findByActor(actorId: string): Promise<DisputeGateOverrideRecord[]>`
```javascript
prisma.disputeGateOverrideRecord.findMany({ where: { actorId }, orderBy: { overrideAt: 'desc' } })
```
Used by: `AuditService` — GM dispute gate override governance report (all overrides by actor, target stage, reason, and date range).

`findByDateRange(from: Date, to: Date): Promise<DisputeGateOverrideRecord[]>`
```javascript
prisma.disputeGateOverrideRecord.findMany({
  where: { overrideAt: { gte: from, lte: to } }
})
```
Used by: `AuditService` — governance report date-range filter.

**Indexed fields:**
- `disputeId` — `[candidate]`
- `actorId` — `[candidate]`
- `overrideAt` — `[candidate]` — date-range governance report; compound index `(actorId, overrideAt)` recommended

**Mutation rule:** Immutable from creation. Independently queryable — not an attribute on `DisputeRecord`. Override NOT available at S8→S9 if dispute is OPEN or IN_PROGRESS.

---

#### ResolutionBundleModel

**Model name:** `ResolutionBundle`
**Table:** `resolution_bundles`

**Query specifications:**

`findById(id: string): Promise<ResolutionBundle | null>`
```javascript
prisma.resolutionBundle.findUnique({ where: { id } })
```
Used by: `DisputeService`.

`findByDispute(disputeId: string): Promise<ResolutionBundle[]>`
```javascript
prisma.resolutionBundle.findMany({ where: { disputeId }, orderBy: { approvedAt: 'asc' } })
```
Used by: `DisputeService` — all bundles for a dispute; if terms change, a new bundle is created and all versions are preserved.

`findOpenByDispute(disputeId: string): Promise<ResolutionBundle | null>`
```javascript
prisma.resolutionBundle.findFirst({ where: { disputeId, status: 'OPEN' } })
```
Used by: `DisputeService` — active bundle (at most one OPEN bundle per dispute at any time).

`findWithItems(id: string): Promise<ResolutionBundle & { items: ResolutionBundleItem[] } | null>`
```javascript
prisma.resolutionBundle.findUnique({ where: { id }, include: { items: true } })
```
Used by: `DisputeService` — execution status of all items in a bundle.

**Indexed fields:**
- `disputeId` — `[candidate]` — all query specs filter on `disputeId`; compound index `(disputeId, status)` for `findOpenByDispute`

**Mutation rule:** Items updated via additive execution events only — not direct field edits on existing items. If terms change, a new bundle is created — original preserved.

---

#### ResolutionBundleItemModel

**Model name:** `ResolutionBundleItem`
**Table:** `resolution_bundle_items`

**Query specifications:**

`findById(id: string): Promise<ResolutionBundleItem | null>`
```javascript
prisma.resolutionBundleItem.findUnique({ where: { id } })
```

`findByBundle(bundleId: string): Promise<ResolutionBundleItem[]>`
```javascript
prisma.resolutionBundleItem.findMany({ where: { bundleId }, orderBy: { createdAt: 'asc' } })
```
Used by: `DisputeService` — item execution status within a bundle.

`findPendingByBundle(bundleId: string): Promise<ResolutionBundleItem[]>`
```javascript
prisma.resolutionBundleItem.findMany({ where: { bundleId, status: 'COMMITTED' } })
```
Used by: `DisputeService` — checks whether all items are executed or cancelled before sealing the bundle.

**Indexed fields:**
- `bundleId` — `[candidate]` — all query specs filter on `bundleId`

**Mutation rule:** Status transitions (COMMITTED → EXECUTED | CANCELLED) via additive execution events. Field edits on an existing item are not permitted — new bundle required if terms change.

---

### 7.2.9 Handoffs and Quotations

---

#### HandoffRecordModel

**Model name:** `HandoffRecord`
**Table:** `handoff_records`

**Query specifications:**

`findById(id: string): Promise<HandoffRecord | null>`
```javascript
prisma.handoffRecord.findUnique({ where: { id } })
```
Used by: `HandoffService`, `AmendmentService` downstream consequence processing.

`findByEntry(entryId: string): Promise<HandoffRecord[]>`
```javascript
prisma.handoffRecord.findMany({ where: { entryId }, orderBy: { createdAt: 'asc' } })
```
Used by: `HandoffService` — all handoffs for an entry across all stages.

`findActiveByEntry(entryId: string): Promise<HandoffRecord[]>`
```javascript
prisma.handoffRecord.findMany({
  where: { entryId, state: { in: ['CREATED', 'ASSIGNED', 'ACCEPTED'] } }
})
```
Used by: `HandoffService`, `AmendmentService` — open handoffs requiring update when entry details change.

`findByType(handoffType: HandoffType): Promise<HandoffRecord[]>`
```javascript
prisma.handoffRecord.findMany({ where: { handoffType }, orderBy: { createdAt: 'desc' } })
```
Used by: `AuditService` — shift handover completeness report.

`findOverdueSla(): Promise<HandoffRecord[]>`
```javascript
prisma.handoffRecord.findMany({
  where: { state: { in: ['CREATED', 'ASSIGNED'] }, slaDeadlineAt: { lt: new Date() } }
})
```
Used by: `HandoffSlaWorker` — fires `HANDOFF_REJECTED` or escalation event on SLA breach.

**Indexed fields:**
- `entryId` — `[candidate]` — all primary query specs filter on `entryId`
- `state` — `[candidate]` — compound index `(entryId, state)` for `findActiveByEntry`
- `slaDeadlineAt` — `[candidate]` — SLA worker filter
- `handoffType` — `[candidate]` — report filter

**Mutation rule:** Status transitions (CREATED → ASSIGNED → ACCEPTED → FULFILLED → CLOSED); REJECTED produces new routing — original record preserved; sealed on fulfilment and closure.

---

#### QuotationModel

**Model name:** `Quotation`
**Table:** `quotations`

**Query specifications:**

`findById(id: string): Promise<Quotation | null>`
```javascript
prisma.quotation.findUnique({ where: { id } })
```
Used by: `ReservationService`, `CommunicationService` — quotation dispatch.

`findByEntry(entryId: string): Promise<Quotation[]>`
```javascript
prisma.quotation.findMany({ where: { entryId }, orderBy: { versionNumber: 'asc' } })
```
Used by: `ReservationService` — full version history; supersession chain.

`findCurrentByEntry(entryId: string): Promise<Quotation | null>`
```javascript
prisma.quotation.findFirst({
  where: { entryId, supersededById: null, state: { not: 'EXPIRED' } },
  orderBy: { versionNumber: 'desc' }
})
```
Used by: `ReservationService` — current (non-superseded, non-expired) quotation.

`findBySegment(segmentId: string): Promise<Quotation[]>`
```javascript
prisma.quotation.findMany({ where: { segmentId }, orderBy: { versionNumber: 'asc' } })
```
Used by: `ReservationService` — segment-scoped quotation history.

**Indexed fields:**
- `entryId` — `[candidate]`
- `segmentId` — `[candidate]`
- `state` — `[candidate]` — compound index `(entryId, state)` for current-quotation lookup

**Mutation rule:** Draft editable until sent; new version supersedes prior; sealed on send; all versions sealed on S2 exit.

---

#### SpeculativeHoldModel

**Model name:** `SpeculativeHold`
**Table:** `speculative_holds`

**Query specifications:**

`findById(id: string): Promise<SpeculativeHold | null>`
```javascript
prisma.speculativeHold.findUnique({ where: { id } })
```
Used by: `ReservationService`, `AvailabilityService`.

`findActiveByEntry(entryId: string): Promise<SpeculativeHold | null>`
```javascript
prisma.speculativeHold.findFirst({ where: { entryId, state: 'PLACED' } })
```
Used by: `ReservationService` — active speculative hold for an entry.

`findActiveByRoom(roomId: string): Promise<SpeculativeHold[]>`
```javascript
prisma.speculativeHold.findMany({ where: { roomId, state: 'PLACED' } })
```
Used by: `AvailabilityEngine` — active holds on a room for claim state resolution.

`findExpired(): Promise<SpeculativeHold[]>`
```javascript
prisma.speculativeHold.findMany({ where: { state: 'PLACED', expiresAt: { lt: new Date() } } })
```
Used by: `SpeculativeHoldExpiryWorker` — holds past TTL requiring governed release.

**Indexed fields:**
- `entryId` — `[candidate]`
- `roomId` — `[candidate]` — `findActiveByRoom` filter; compound index `(roomId, state)` recommended
- `expiresAt` — `[candidate]` — expiry worker filter; compound index `(state, expiresAt)` recommended

**Mutation rule:** Timer and notes editable while active; release is a governed event — not silent; expiry produces a trace event regardless of hold state.

---

#### CommittedHoldModel

**Model name:** `CommittedHold`
**Table:** `committed_holds`

**Query specifications:**

`findById(id: string): Promise<CommittedHold | null>`
```javascript
prisma.committedHold.findUnique({ where: { id } })
```

`findActiveByEntry(entryId: string): Promise<CommittedHold | null>`
```javascript
prisma.committedHold.findFirst({ where: { entryId, state: 'PLACED' } })
```
Used by: `ReservationService` — committed hold at S3 for confirmation.

`findActiveByRoom(roomId: string): Promise<CommittedHold[]>`
```javascript
prisma.committedHold.findMany({ where: { roomId, state: 'PLACED' } })
```
Used by: `AvailabilityEngine` — active committed holds for claim state resolution.

`findExpired(): Promise<CommittedHold[]>`
```javascript
prisma.committedHold.findMany({ where: { state: 'PLACED', expiresAt: { lt: new Date() } } })
```
Used by: `CommittedHoldExpiryWorker`.

**Indexed fields:**
- `entryId` — `[candidate]`
- `roomId` — `[candidate]` — compound index `(roomId, state)` recommended
- `expiresAt` — `[candidate]` — compound index `(state, expiresAt)` recommended

**Mutation rule:** Timer and notes editable while PLACED; confirmed at S4; released on cancellation; all transitions are governed events with trace records.

---

#### ReservationModel

**Model name:** `Reservation`
**Table:** `reservations`

**Query specifications:**

`findById(id: string): Promise<Reservation | null>`
```javascript
prisma.reservation.findUnique({ where: { id } })
```
Used by: `ReservationService`, `NightAuditService` input assembly, `DisputeService`.

`findByEntry(entryId: string): Promise<Reservation | null>`
```javascript
prisma.reservation.findUnique({ where: { entryId } })
```
Used by: All services that need the commitment snapshot — `entryId` has `@unique` constraint; one reservation per entry.

`findCheckingInToday(date: Date): Promise<Reservation[]>`
```javascript
prisma.reservation.findMany({
  where: { frozenCheckInDate: { gte: startOfDay(date), lt: endOfDay(date) }, sealedAt: null }
})
```
Used by: `NightAuditService` — arrival report; pre-arrival readiness; pre-arrival communication scheduling.

`findCheckingOutToday(date: Date): Promise<Reservation[]>`
```javascript
prisma.reservation.findMany({
  where: { frozenCheckOutDate: { gte: startOfDay(date), lt: endOfDay(date) } }
})
```
Used by: `NightAuditService` — departure report; checkout deadline worker.

**Indexed fields:**
- `entryId` — covered by `@unique` constraint
- `frozenCheckInDate` — `[candidate]` — arrival report; pre-arrival worker filter
- `frozenCheckOutDate` — `[candidate]` — departure report; checkout worker filter

**Mutation rule:** Not directly editable after creation. Any change after S4 requires a new Segment with a new Reservation — the commitment snapshot is frozen at creation. In-place editing of this record after S4 exit is the most dangerous architectural violation in the system.

---

### 7.2.10 Night Audit

---

#### NightAuditRecordModel

**Model name:** `NightAuditRecord`
**Table:** `night_audit_records`

**Query specifications:**

`findById(id: string): Promise<NightAuditRecord | null>`
```javascript
prisma.nightAuditRecord.findUnique({ where: { id } })
```
Used by: `NightAuditService`, `AuditService`.

`findByOperatingDate(operatingDate: Date): Promise<NightAuditRecord | null>`
```javascript
prisma.nightAuditRecord.findUnique({ where: { operatingDate } })
```
Used by: `NightAuditService` — idempotency guard; checks for existing COMPLETE record before re-running. `operatingDate` has `@unique` constraint.

`findByDateRange(from: Date, to: Date): Promise<NightAuditRecord[]>`
```javascript
prisma.nightAuditRecord.findMany({ where: { operatingDate: { gte: from, lte: to } }, orderBy: { operatingDate: 'asc' } })
```
Used by: `AuditService` — night audit report; revenue report date range.

`findWithAnomalies(id: string): Promise<NightAuditRecord & { anomalies: NightAuditAnomaly[] } | null>`
```javascript
prisma.nightAuditRecord.findUnique({ where: { id }, include: { anomalies: { where: { resolvedAt: null } } } })
```
Used by: `NightAuditService` — unresolved anomaly queue for FOM review.

**Indexed fields:**
- `operatingDate` — covered by `@unique` constraint

**Mutation rule:** Immutable from creation. Not editable. Not amendable. One record per operating date. Post-audit corrections are new-date entries.

---

#### NightAuditAnomalyModel

**Model name:** `NightAuditAnomaly`
**Table:** `night_audit_anomalies`

**Query specifications:**

`findById(id: string): Promise<NightAuditAnomaly | null>`
```javascript
prisma.nightAuditAnomaly.findUnique({ where: { id } })
```

`findByNightAudit(nightAuditId: string): Promise<NightAuditAnomaly[]>`
```javascript
prisma.nightAuditAnomaly.findMany({ where: { nightAuditId } })
```
Used by: `NightAuditService` — all anomalies for a given audit run.

`findUnresolvedByEntry(entryId: string): Promise<NightAuditAnomaly[]>`
```javascript
prisma.nightAuditAnomaly.findMany({ where: { entryId, resolvedAt: null } })
```
Used by: `NightAuditService` — unresolved anomalies per entry; FOM review queue.

`findAuditExceptions(): Promise<NightAuditAnomaly[]>`
```javascript
prisma.nightAuditAnomaly.findMany({ where: { auditExceptionFlag: true, resolvedAt: null } })
```
Used by: `NightAuditService` — entries that could not be processed even through recovery re-run; FOM escalation.

**Indexed fields:**
- `nightAuditId` — `[candidate]`
- `entryId` — `[candidate]`
- `resolvedAt` — `[candidate]` — unresolved filter; compound index `(entryId, resolvedAt)` recommended

**Mutation rule:** Immutable from creation. `resolvedAt` and `resolvedBy` set on FOM resolution — these are additive fields, not amendments to the original anomaly detection data.

---

### 7.2.11 Timers and Processing Lock

---

#### TimerRecordModel

**Model name:** `TimerRecord`
**Table:** `timer_records`

**Query specifications:**

`findById(id: string): Promise<TimerRecord | null>`
```javascript
prisma.timerRecord.findUnique({ where: { id } })
```
Used by: `TimerManagementService`, all timer-aware workers.

`findActiveByEntity(entityType: string, entityReference: string): Promise<TimerRecord[]>`
```javascript
prisma.timerRecord.findMany({ where: { entityType, entityReference, status: 'ACTIVE' } })
```
Used by: `TimerManagementService` — active timers for a governed entity; used to cancel or update timers on state change.

`findFiredByEntity(entityType: string, entityReference: string): Promise<TimerRecord[]>`
```javascript
prisma.timerRecord.findMany({ where: { entityType, entityReference, status: 'FIRED' } })
```
Used by: Workers — idempotency guard: if a `FIRED` record already exists for this entity and timer type, the worker exits without re-processing.

`findByPgBossJob(pgBossJobId: string): Promise<TimerRecord | null>`
```javascript
prisma.timerRecord.findFirst({ where: { pgBossJobId } })
```
Used by: Worker handlers that receive a pg-boss job ID and need to look up the governing `TimerRecord`.

**Indexed fields:**
- `entityType` — `[candidate]` — compound index `(entityType, entityReference, status)` recommended for `findActiveByEntity` and `findFiredByEntity`
- `entityReference` — included in the compound above
- `status` — included in the compound above
- `pgBossJobId` — `[candidate]` — `findByPgBossJob` lookup

**Mutation rule:** Created on timer activation; status transitions (ACTIVE → FIRED | CANCELLED); `firedAt` and `cancelledAt` set on respective transitions.

---

#### TimerEventModel

**Model name:** `TimerEvent`
**Table:** `timer_events`

**Query specifications:**

`findById(id: string): Promise<TimerEvent | null>`
```javascript
prisma.timerEvent.findUnique({ where: { id } })
```

`findByTimerRecord(timerRecordId: string): Promise<TimerEvent[]>`
```javascript
prisma.timerEvent.findMany({ where: { timerRecordId }, orderBy: { firedAt: 'asc' } })
```
Used by: `AuditService` — full timer event history (WARNING, CRITICAL, FIRED, CANCELLED) for a governed entity.

**Indexed fields:**
- `timerRecordId` — `[candidate]`

**Mutation rule:** Immutable from creation. Append-only timer event record.

---

#### ProcessingLockRecordModel

**Model name:** `ProcessingLockRecord`
**Table:** `processing_lock_records`

**Query specifications:**

`findById(id: string): Promise<ProcessingLockRecord | null>`
```javascript
prisma.processingLockRecord.findUnique({ where: { id } })
```
Used by: `ProcessingLockService`, `ProcessingLockExpiryWorker`.

`findActiveByInventory(inventoryReference: string): Promise<ProcessingLockRecord[]>`
```javascript
prisma.processingLockRecord.findMany({ where: { inventoryReference, status: 'ACTIVE' } })
```
Used by: `ProcessingLockService.placeLock()` — prior lock check (Policy 72); if an active lock exists on the same inventory, the second actor receives an informational notification.

`findExpired(): Promise<ProcessingLockRecord[]>`
```javascript
prisma.processingLockRecord.findMany({ where: { status: 'ACTIVE', expiresAt: { lt: new Date() } } })
```
Used by: `ProcessingLockExpiryWorker` — identifies locks past TTL requiring hard expiry. Note: pg-boss also fires the expiry job; this query serves the worker's confirmation check.

`findByActor(actorId: string): Promise<ProcessingLockRecord[]>`
```javascript
prisma.processingLockRecord.findMany({ where: { actorId }, orderBy: { placedAt: 'desc' } })
```
Used by: `AuditService` — actor-level processing lock history.

**Indexed fields:**
- `inventoryReference` — `[candidate]` — `findActiveByInventory` filter; compound index `(inventoryReference, status)` recommended
- `status` — `[candidate]` — compound index `(status, expiresAt)` for expiry worker
- `expiresAt` — included in the compound above
- `actorId` — `[candidate]`

**Mutation rule:** ACTIVE → EXPIRED (unconditional at TTL — hard expiry, no heartbeat or renewal) or ACTIVE → RELEASED (booking completed). Expiry event permanently logged even though the lock is transient. Reconfirmation creates a new `ProcessingLockRecord` — does not extend this one.

---

#### RevalidationDeltaRecordModel

**Model name:** `RevalidationDeltaRecord`
**Table:** `revalidation_delta_records`

**Query specifications:**

`findById(id: string): Promise<RevalidationDeltaRecord | null>`
```javascript
prisma.revalidationDeltaRecord.findUnique({ where: { id } })
```
Used by: `ProcessingLockService` — direct lookup; `AuditService` — operator audit trail for reconfirmation events ("what did the system show when this lock was reconfirmed?").

`findByLock(processingLockId: string): Promise<RevalidationDeltaRecord[]>`
```javascript
prisma.revalidationDeltaRecord.findMany({ where: { processingLockId }, orderBy: { createdAt: 'asc' } })
```
Used by: `ProcessingLockService.reconfirm()` return-path projection — surfaces the delta to the operator before the new lock's TTL begins. Returned ordered by `createdAt` to support repeat-reconfirmation histories.

`findByActor(actorId: string): Promise<RevalidationDeltaRecord[]>`
```javascript
prisma.revalidationDeltaRecord.findMany({ where: { createdBy: actorId }, orderBy: { createdAt: 'desc' } })
```
Used by: `AuditService` — actor-level reconfirmation history; supports dispute/audit cases ("show me every revalidation outcome this operator saw").

**Indexed fields:**
- `processingLockId` — `[candidate]` — covers `findByLock`; FK-driven
- `createdBy` — `[candidate]` — covers `findByActor`
- `createdAt` — included in compound `(createdBy, createdAt)` for actor history

**Mutation rule:** Immutable from creation. Created by `ProcessingLockService.reconfirm()` in the same transaction as the new `ProcessingLockRecord`. Not amendable. Anchors to the new lock (channel-agnostic — front-desk and phone reconfirmations carry the same record even when no draft communication exists).

---

### 7.2.12 Session and Attribution

---

#### StaffUserModel

**Model name:** `StaffUser`
**Table:** `staff_users`

**Query specifications:**

`findById(id: string): Promise<StaffUser | null>`
```javascript
prisma.staffUser.findUnique({ where: { id } })
```
Used by: `SessionManagementService` authentication; attribution lookup on all actor-id references.

`findByUsername(username: string): Promise<StaffUser | null>`
```javascript
prisma.staffUser.findUnique({ where: { username } })
```
Used by: `SessionManagementService` login.

`findActive(): Promise<StaffUser[]>`
```javascript
prisma.staffUser.findMany({ where: { isActive: true } })
```
Used by: Admin Console; notification routing.

`findByActorLevel(actorLevel: ActorLevel): Promise<StaffUser[]>`
```javascript
prisma.staffUser.findMany({ where: { actorLevel, isActive: true } })
```
Used by: `NotificationService` — tier recipient resolution (FOM level, GM level).

**Indexed fields:**
- `username` — covered by `@unique` constraint
- `actorLevel` — `[candidate]` — `findByActorLevel` filter; compound index `(actorLevel, isActive)` recommended

**Mutation rule:** Editable via Admin Console (display name, active status, threshold configuration); PIN is hashed — never stored in plaintext; no shared credentials, no group accounts.

---

#### SessionRecordModel

**Model name:** `SessionRecord`
**Table:** `session_records`

**Query specifications:**

`findById(id: string): Promise<SessionRecord | null>`
```javascript
prisma.sessionRecord.findUnique({ where: { id } })
```
Used by: `SessionManagementService`.

`findActiveByUser(userId: string): Promise<SessionRecord | null>`
```javascript
prisma.sessionRecord.findFirst({ where: { userId, status: 'ACTIVE' } })
```
Used by: `SessionManagementService` — confirms active session before permitting actions; idle lock check.

`findByUserAndTerminal(userId: string, terminalId: string): Promise<SessionRecord | null>`
```javascript
prisma.sessionRecord.findFirst({ where: { userId, terminalId, status: 'ACTIVE' } })
```
Used by: `SessionManagementService` — terminal isolation; Terminal 1 session does not affect Terminal 2.

**Indexed fields:**
- `userId` — `[candidate]` — compound index `(userId, status)` for `findActiveByUser`
- `terminalId` — `[candidate]` — compound index `(userId, terminalId)` for terminal isolation query

**Mutation rule:** Session status transitions (ACTIVE → IDLE_LOCKED → MANUALLY_LOCKED → HARD_LOGGED_OUT); each boundary event produces an immutable `SessionEventRecord`.

---

#### SessionEventRecordModel

**Model name:** `SessionEventRecord`
**Table:** `session_event_records`

**Query specifications:**

`findById(id: string): Promise<SessionEventRecord | null>`
```javascript
prisma.sessionEventRecord.findUnique({ where: { id } })
```

`findByActor(actorId: string): Promise<SessionEventRecord[]>`
```javascript
prisma.sessionEventRecord.findMany({ where: { actorId }, orderBy: { timestamp: 'asc' } })
```
Used by: `AuditService` — session management event log per actor.

`findBySession(sessionRecordId: string): Promise<SessionEventRecord[]>`
```javascript
prisma.sessionEventRecord.findMany({ where: { sessionRecordId }, orderBy: { timestamp: 'asc' } })
```
Used by: `AuditService` — all events within a session boundary.

`findByTerminal(terminalIdentifier: string): Promise<SessionEventRecord[]>`
```javascript
prisma.sessionEventRecord.findMany({ where: { terminalIdentifier }, orderBy: { timestamp: 'desc' } })
```
Used by: `AuditService` — terminal-level session event history.

`findByEventType(eventType: SessionEventType): Promise<SessionEventRecord[]>`
```javascript
prisma.sessionEventRecord.findMany({ where: { eventType }, orderBy: { timestamp: 'desc' } })
```
Used by: `AuditService` — PIN switch frequency analysis; hard logout pattern review.

**Indexed fields:**
- `actorId` — `[candidate]`
- `sessionRecordId` — `[candidate]`
- `terminalIdentifier` — `[candidate]`
- `timestamp` — `[candidate]` — temporal ordering across all query specs
- `eventType` — `[candidate]`

**Mutation rule:** Create-only. No fields are editable after creation. No amendment path. A corrected or superseding session event is a new record — original preserved. Immutable from creation; sealed at creation. Archived with the associated staff user record.

---

#### DutySessionModel

**Model name:** `DutySession`
**Table:** `duty_sessions`

**Query specifications:**

`findById(id: string): Promise<DutySession | null>`
```javascript
prisma.dutySession.findUnique({ where: { id } })
```

`findActiveByUser(userId: string): Promise<DutySession | null>`
```javascript
prisma.dutySession.findFirst({ where: { userId, shiftEndedAt: null } })
```
Used by: `SessionManagementService` — current duty session for shift handover.

`findByUser(userId: string): Promise<DutySession[]>`
```javascript
prisma.dutySession.findMany({ where: { userId }, orderBy: { shiftStartedAt: 'desc' } })
```
Used by: `AuditService` — shift attribution history.

**Indexed fields:**
- `userId` — `[candidate]`
- `shiftEndedAt` — `[candidate]` — `findActiveByUser` filters on `shiftEndedAt: null`

**Mutation rule:** `shiftEndedAt`, `handoverNotes`, and `handoverTo` set on shift end — these are the only editable fields; `shiftStartedAt` and attribution fields are immutable from creation.

---

### 7.2.13 Audit and Trace

---

#### TraceEventModel

**Model name:** `TraceEvent`
**Table:** `trace_events`

**Query specifications:**

`findById(id: string): Promise<TraceEvent | null>`
```javascript
prisma.traceEvent.findUnique({ where: { id } })
```

`findByEntity(entityType: string, entityId: string): Promise<TraceEvent[]>`
```javascript
prisma.traceEvent.findMany({ where: { entityType, entityId }, orderBy: { timestamp: 'asc' } })
```
Used by: `AuditService.query()` — primary audit reconstruction surface; from trace events alone, every question in the Audit Reconstruction Map must be answerable.

`findByEntityAndDateRange(entityType: string, entityId: string, from: Date, to: Date): Promise<TraceEvent[]>`
```javascript
prisma.traceEvent.findMany({
  where: { entityType, entityId, timestamp: { gte: from, lte: to } },
  orderBy: { timestamp: 'asc' }
})
```
Used by: `AuditService.query()` — date-scoped audit reconstruction.

`findByCorrelation(correlationId: string): Promise<TraceEvent[]>`
```javascript
prisma.traceEvent.findMany({ where: { correlationId }, orderBy: { timestamp: 'asc' } })
```
Used by: `AuditService` — chain reconstruction: inbound message → AI classification → draft → human decision → outbound send.

`findByActor(actorId: string, from?: Date, to?: Date): Promise<TraceEvent[]>`
```javascript
prisma.traceEvent.findMany({
  where: { actorId, ...(from && to ? { timestamp: { gte: from, lte: to } } : {}) },
  orderBy: { timestamp: 'asc' }
})
```
Used by: `AuditService` — actor-level audit trail query.

`findByInquiry(inquiryId: string): Promise<TraceEvent[]>`
```javascript
prisma.traceEvent.findMany({ where: { inquiryId }, orderBy: { timestamp: 'asc' } })
```
Used by: `AuditService` — top-level inquiry audit trail across all child records.

**Indexed fields (confirmed from Part 2 §2.15 @@index directives):**
- `(entityType, entityId)` — `@@index([entityType, entityId])` — present in Part 2
- `correlationId` — `@@index([correlationId])` — present in Part 2
- `actorId` — `@@index([actorId])` — present in Part 2
- `timestamp` — `@@index([timestamp])` — present in Part 2
- `inquiryId` — `@@index([inquiryId])` — present in Part 2

**Mutation rule:** Append-only. No UPDATE. No DELETE. Ever. NOT NULL enforced at the database level on `actorId`, `entityId`, `operation`, and `timestamp`. A trace event row with any of these four fields null is a structural defect — not a recoverable data problem.

---

### 7.2.14 Configuration Tables

---

#### ConfigurationEntryModel

**Model name:** `ConfigurationEntry`
**Table:** `configuration_entries`

**Query specifications:**

`findById(id: string): Promise<ConfigurationEntry | null>`
```javascript
prisma.configurationEntry.findUnique({ where: { id } })
```

`findActiveByKey(configKey: string): Promise<ConfigurationEntry | null>`
```javascript
prisma.configurationEntry.findFirst({
  where: { configKey, effectiveTo: null },
  orderBy: { effectiveFrom: 'desc' }
})
```
Used by: All services that read configuration at runtime — every configurable threshold, authority band, and timer value is read through this query. Engines and services call this pattern to retrieve the currently active value for a configuration key.

`findByKeyAndDate(configKey: string, asOf: Date): Promise<ConfigurationEntry | null>`
```javascript
prisma.configurationEntry.findFirst({
  where: { configKey, effectiveFrom: { lte: asOf }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }] },
  orderBy: { effectiveFrom: 'desc' }
})
```
Used by: `AuditService` — temporal audit capability: determines exactly what configuration value was active at a given historical timestamp.

**Indexed fields (confirmed from Part 2 §2.16 @@index directive):**
- `(configKey, effectiveFrom)` — `@@index([configKey, effectiveFrom])` — present in Part 2

**Mutation rule:** Not edited in place. When configuration changes, a new `ConfigurationEntry` is created with updated `effectiveFrom`; the prior entry's `effectiveTo` is set. ADMIN actor level required for all writes.

---

#### PolicyRegistryModel

**Model name:** `PolicyRegistry`
**Table:** `policy_registry`

**Query specifications:**

`findById(id: string): Promise<PolicyRegistry | null>`
```javascript
prisma.policyRegistry.findUnique({ where: { id } })
```

`findByPolicyId(policyId: string): Promise<PolicyRegistry | null>`
```javascript
prisma.policyRegistry.findUnique({ where: { policyId } })
```
Used by: Policy layer — each named policy from §72 has a `policyId` that maps to its `PolicyRegistry` entry containing runtime parameters.

`findActiveByClass(policyClass: string): Promise<PolicyRegistry | null>`
```javascript
prisma.policyRegistry.findFirst({ where: { policyClass, isActive: true }, orderBy: { effectiveFrom: 'desc' } })
```
Used by: Policy layer — canonical policy class name lookup.

**Indexed fields:**
- `policyId` — covered by `@unique` constraint

**Mutation rule:** Not edited in place. Policy revision increments version and creates a new record — `effectiveFrom` updated; prior version preserved.

---

#### RoomTypeRegistryModel

**Model name:** `RoomTypeRegistry`
**Table:** `room_type_registry`

**Query specifications:**

`findById(id: string): Promise<RoomTypeRegistry | null>`
```javascript
prisma.roomTypeRegistry.findUnique({ where: { id } })
```

`findByName(name: string): Promise<RoomTypeRegistry | null>`
```javascript
prisma.roomTypeRegistry.findUnique({ where: { name } })
```

`findActive(): Promise<RoomTypeRegistry[]>`
```javascript
prisma.roomTypeRegistry.findMany({ where: { isActive: true } })
```
Used by: `AvailabilityEngine`, Admin Console reads.

**Indexed fields:**
- `name` — covered by `@unique` constraint

**Mutation rule:** Managed via Admin Console only; operational services read but do not write this table.

---

#### CancellationPolicyRegistryModel

**Model name:** `CancellationPolicyRegistry`
**Table:** `cancellation_policy_registry`

**Query specifications:**

`findById(id: string): Promise<CancellationPolicyRegistry | null>`
```javascript
prisma.cancellationPolicyRegistry.findUnique({ where: { id } })
```

`findByName(name: string): Promise<CancellationPolicyRegistry | null>`
```javascript
prisma.cancellationPolicyRegistry.findUnique({ where: { name } })
```

`findActive(): Promise<CancellationPolicyRegistry[]>`
```javascript
prisma.cancellationPolicyRegistry.findMany({ where: { isActive: true } })
```
Used by: `CancellationService` penalty calculation; `ReservationService` — carried into commitment snapshot.

**Indexed fields:**
- `name` — covered by `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### HandoffChecklistTemplateModel

**Model name:** `HandoffChecklistTemplate`
**Table:** `handoff_checklist_templates`

**Query specifications:**

`findById(id: string): Promise<HandoffChecklistTemplate | null>`
```javascript
prisma.handoffChecklistTemplate.findUnique({ where: { id } })
```

`findActiveByType(handoffType: HandoffType): Promise<HandoffChecklistTemplate | null>`
```javascript
prisma.handoffChecklistTemplate.findFirst({
  where: { handoffType, isActive: true },
  orderBy: { version: 'desc' }
})
```
Used by: `HandoffService.create()` — retrieves the current checklist template for the given handoff type when creating a new handoff.

**Indexed fields:**
- `(handoffType, version)` — covered by `@@unique([handoffType, version])` composite constraint

**Mutation rule:** Managed via Admin Console; version incremented on change; operational services read but do not write this table.

---

#### WorkOrderTemplateModel

**Model name:** `WorkOrderTemplate`
**Table:** `work_order_templates`

**Query specifications:**

`findById(id: string): Promise<WorkOrderTemplate | null>`
```javascript
prisma.workOrderTemplate.findUnique({ where: { id } })
```

`findActiveByUseType(useType: EntryUseType): Promise<WorkOrderTemplate[]>`
```javascript
prisma.workOrderTemplate.findMany({ where: { useType, isActive: true } })
```
Used by: `WorkOrderService.create()` — pre-populates to-do items from template for the entry use type.

**Indexed fields:**
- `useType` — `[candidate]`

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### CommunicationTemplateModel

**Model name:** `CommunicationTemplate`
**Table:** `communication_templates`

**Query specifications:**

`findById(id: string): Promise<CommunicationTemplate | null>`
```javascript
prisma.communicationTemplate.findUnique({ where: { id } })
```

`findActiveByTypeAndChannel(templateType: string, channel: CommunicationChannel): Promise<CommunicationTemplate | null>`
```javascript
prisma.communicationTemplate.findFirst({ where: { templateType, channel, isActive: true } })
```
Used by: `CommunicationService.send()` — resolves the correct template (subject line prefix, body template) for each outbound communication type and channel.

**Indexed fields:**
- `channel` — `[candidate]` — compound index `(templateType, channel, isActive)` recommended for `findActiveByTypeAndChannel`
- `templateType` — included in compound above

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### InvoiceTemplateModel

**Model name:** `InvoiceTemplate`
**Table:** `invoice_templates`

**Query specifications:**

`findById(id: string): Promise<InvoiceTemplate | null>`
```javascript
prisma.invoiceTemplate.findUnique({ where: { id } })
```

`findActiveByType(invoiceType: InvoiceType): Promise<InvoiceTemplate | null>`
```javascript
prisma.invoiceTemplate.findFirst({ where: { invoiceType, isActive: true } })
```
Used by: `FolioService` — invoice generation at S3 (proforma) and S8/S9 (final, post-stay).

**Indexed fields:**
- `invoiceType` — `[candidate]`

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### FeedbackSurveyTemplateModel

**Model name:** `FeedbackSurveyTemplate`
**Table:** `feedback_survey_templates`

**Query specifications:**

`findById(id: string): Promise<FeedbackSurveyTemplate | null>`
```javascript
prisma.feedbackSurveyTemplate.findUnique({ where: { id } })
```

`findActive(): Promise<FeedbackSurveyTemplate[]>`
```javascript
prisma.feedbackSurveyTemplate.findMany({ where: { isActive: true } })
```
Used by: `CommunicationService` — post-departure feedback survey dispatch at S9.

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### VipNotificationRoutingConfigModel

**Model name:** `VipNotificationRoutingConfig`
**Table:** `vip_notification_routing_configs`

**Query specifications:**

`findById(id: string): Promise<VipNotificationRoutingConfig | null>`
```javascript
prisma.vipNotificationRoutingConfig.findUnique({ where: { id } })
```

`findActiveByTier(vipTier: string): Promise<VipNotificationRoutingConfig | null>`
```javascript
prisma.vipNotificationRoutingConfig.findFirst({ where: { vipTier, isActive: true } })
```
Used by: `NotificationService` — VIP arrival notification dispatch at S6 commencement; resolves which staff roles and actor IDs to notify for a given VIP tier.

**Indexed fields:**
- `vipTier` — `[candidate]`

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### HotelProfileModel

**Model name:** `HotelProfile`
**Table:** `hotel_profile`

**Query specifications:**

`findCurrent(): Promise<HotelProfile | null>`
```javascript
prisma.hotelProfile.findFirst({ orderBy: { version: 'desc' } })
```
Used by: every operational service that needs hotel identity context (invoicing, communications, audit headers); the most-recent version row is the authoritative profile.

**Indexed fields:** none required — single-row table accessed by latest-version.

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Updates are layered via version increment.

---

#### DepartmentModel

**Model name:** `Department`
**Table:** `departments`

**Query specifications:**

`findByCode(departmentCode: string): Promise<Department | null>`
```javascript
prisma.department.findUnique({ where: { departmentCode } })
```
Used by: `AuthService` — department-code resolution when constructing staff session context; `HandoffService` — department-routed handoff dispatch.

`findActive(): Promise<Department[]>`
```javascript
prisma.department.findMany({ where: { isActive: true }, orderBy: { departmentName: 'asc' } })
```
Used by: Admin Console listing; staff-user assignment flows.

**Indexed fields:**
- `departmentCode` — covered by `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Departments are not deleted — `isActive` flips false to retire.

---

#### RoleModel

**Model name:** `Role`
**Table:** `roles`

**Query specifications:**

`findByCode(roleCode: string): Promise<Role | null>`
```javascript
prisma.role.findUnique({ where: { roleCode } })
```
Used by: `AuthService` — role resolution at PIN login; determines `ActorLevel` for the session.

`findActive(): Promise<Role[]>`
```javascript
prisma.role.findMany({ where: { isActive: true }, orderBy: { roleName: 'asc' } })
```
Used by: Admin Console role-assignment flows.

**Indexed fields:**
- `roleCode` — covered by `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Predefined roles cannot have `isPredefined` flipped.

---

#### RolePermissionMappingModel

**Model name:** `RolePermissionMapping`
**Table:** `role_permission_mappings`

**Query specifications:**

`findByRole(roleId: string): Promise<RolePermissionMapping[]>`
```javascript
prisma.rolePermissionMapping.findMany({ where: { roleId, isGranted: true } })
```
Used by: `AuthService` — permission-set materialisation for an authenticated actor; the resulting permission keys back all authorisation gates.

`findGranted(roleId: string, permissionKey: string): Promise<RolePermissionMapping | null>`
```javascript
prisma.rolePermissionMapping.findUnique({ where: { roleId_permissionKey: { roleId, permissionKey } } })
```
Used by: `AuthService` — point check for a specific permission on the current actor's role.

**Indexed fields:**
- `(roleId, permissionKey)` — covered by composite `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table.

---

#### RoleSessionConfigModel

**Model name:** `RoleSessionConfig`
**Table:** `role_session_configs`

**Query specifications:**

`findByRole(roleId: string): Promise<RoleSessionConfig | null>`
```javascript
prisma.roleSessionConfig.findUnique({ where: { roleId } })
```
Used by: `SessionService` — per-role idle-lock and hard-logout thresholds at session establishment.

**Indexed fields:**
- `roleId` — covered by `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. One config per role enforced at the schema level.

---

#### AiActorIdentityModel

**Model name:** `AiActorIdentity`
**Table:** `ai_actor_identity`

**Query specifications:**

`findCurrent(): Promise<AiActorIdentity | null>`
```javascript
prisma.aiActorIdentity.findFirst({ where: { isActive: true }, orderBy: { version: 'desc' } })
```
Used by: `AIAgentApprovalService`, `CommunicationService` — resolves the active AI actor identity for binding `actorId` on AI-originated trace events and drafts.

**Indexed fields:** none required — single active row accessed by latest-version filter.

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Layered via version increment — prior versions preserved so historical AI actions remain attributable to the version active at the time.

---

#### ModeConfigurationModel

**Model name:** `ModeConfiguration`
**Table:** `mode_configurations`

**Query specifications:**

`findActiveByKey(modeKey: string): Promise<ModeConfiguration | null>`
```javascript
prisma.modeConfiguration.findFirst({ where: { modeKey, isActive: true }, orderBy: { version: 'desc' } })
```
Used by: stage-route resolution at session establishment; feature-dependency gates at service invocation.

`findActive(): Promise<ModeConfiguration[]>`
```javascript
prisma.modeConfiguration.findMany({ where: { isActive: true }, orderBy: { modeName: 'asc' } })
```
Used by: Admin Console listing; mode-switch dialogs.

**Indexed fields:**
- `(modeKey, version)` — covered by composite `@unique` constraint

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Mode revisions add a new version row — prior versions preserved.

---

#### CommunicationChannelConfigModel

**Model name:** `CommunicationChannelConfig`
**Table:** `communication_channel_configs`

**Query specifications:**

`findActiveByChannel(channelType: string): Promise<CommunicationChannelConfig[]>`
```javascript
prisma.communicationChannelConfig.findMany({ where: { channelType, isActive: true }, orderBy: { version: 'desc' } })
```
Used by: `CommunicationService` — resolves which channel-connection config to use for outbound message dispatch on a given channel.

`findById(id: string): Promise<CommunicationChannelConfig | null>`
```javascript
prisma.communicationChannelConfig.findUnique({ where: { id } })
```
Used by: Admin Console — direct lookup; `AuditService` — channel-rotation audit.

**Indexed fields:**
- `channelType` — `[candidate]`

**Mutation rule:** Managed via Admin Console; operational services read but do not write this table. Credentials encrypted at rest; rotation increments version — prior versions preserved for audit.

---

### 7.2.15 Analytics

---

#### StageDwellRecordModel

**Model name:** `StageDwellRecord`
**Table:** `stage_dwell_records`

**Query specifications:**

`findById(id: string): Promise<StageDwellRecord | null>`
```javascript
prisma.stageDwellRecord.findUnique({ where: { id } })
```

`findByEntry(entryId: string): Promise<StageDwellRecord[]>`
```javascript
prisma.stageDwellRecord.findMany({ where: { entryId }, orderBy: { enteredAt: 'asc' } })
```
Used by: `StageDwellMonitor` — full dwell history for an entry.

`findActiveByEntry(entryId: string, stage: Stage): Promise<StageDwellRecord | null>`
```javascript
prisma.stageDwellRecord.findFirst({ where: { entryId, stage, exitedAt: null } })
```
Used by: `StageDwellMonitor` — active (non-exited) dwell record for the current stage; worker updates `lastActiveAt`, `warningFiredAt`, `criticalFiredAt`.

`findByDateRange(from: Date, to: Date): Promise<StageDwellRecord[]>`
```javascript
prisma.stageDwellRecord.findMany({ where: { enteredAt: { gte: from }, exitedAt: { lte: to } } })
```
Used by: `AuditService` — dwell time and SLA compliance report.

**Indexed fields (confirmed from Part 2 §2.18 @@index directive):**
- `(entryId, stage)` — `@@index([entryId, stage])` — present in Part 2

**Mutation rule:** `lastActiveAt`, `exitedAt`, `dwellSeconds`, `warningFiredAt`, `criticalFiredAt`, `escalatedAt` are updated by the `StageDwellMonitor` worker as dwell progresses; `enteredAt` and `entryId` are immutable from creation.

---

### 7.2.16 Incident

---

#### IncidentRecordModel

**Model name:** `IncidentRecord`
**Table:** `incident_records`

**Query specifications:**

`findById(id: string): Promise<IncidentRecord | null>`
```javascript
prisma.incidentRecord.findUnique({ where: { id } })
```
Used by: `IncidentService`, `AuditService`.

`findByEntry(entryId: string): Promise<IncidentRecord[]>`
```javascript
prisma.incidentRecord.findMany({ where: { entryId }, orderBy: { reportedAt: 'desc' } })
```
Used by: `IncidentService` — all incidents anchored to an entry.

`findByRoom(roomId: string): Promise<IncidentRecord[]>`
```javascript
prisma.incidentRecord.findMany({ where: { roomId }, orderBy: { reportedAt: 'desc' } })
```
Used by: `IncidentService` — all incidents for a room; DEATH/SECURITY block verification before room return to service.

`findOpen(): Promise<IncidentRecord[]>`
```javascript
prisma.incidentRecord.findMany({ where: { resolutionStatus: 'OPEN' } })
```
Used by: `AuditService` — active incident queue; may remain open for legal reasons.

**Indexed fields:**
- `entryId` — `[candidate]`
- `roomId` — `[candidate]`
- `resolutionStatus` — `[candidate]`

**Mutation rule:** Status transitions (OPEN → CLOSED) permitted; may remain open for legal reasons; `closedAt`, `closedBy`, and `closureNotes` set on closure. Detection data is not amended.

---

#### LostAndFoundRecordModel

**Model name:** `LostAndFoundRecord`
**Table:** `lost_and_found_records`

**Query specifications:**

`findById(id: string): Promise<LostAndFoundRecord | null>`
```javascript
prisma.lostAndFoundRecord.findUnique({ where: { id } })
```
Used by: `IncidentService`.

`findHeld(): Promise<LostAndFoundRecord[]>`
```javascript
prisma.lostAndFoundRecord.findMany({ where: { returnStatus: 'HELD' }, orderBy: { foundAt: 'asc' } })
```
Used by: `IncidentService` — all items currently held; pending return or disposal.

`findRetentionExpired(): Promise<LostAndFoundRecord[]>`
```javascript
prisma.lostAndFoundRecord.findMany({
  where: { returnStatus: 'HELD', retentionExpiresAt: { lt: new Date() } }
})
```
Used by: `LostAndFoundRetentionWorker` — items whose configurable retention period has elapsed; triggers governed disposal.

**Indexed fields:**
- `returnStatus` — `[candidate]` — compound index `(returnStatus, retentionExpiresAt)` for retention worker
- `retentionExpiresAt` — included in the compound above

**Mutation rule:** Status transitions (HELD → RETURNED | DISPOSED) via service layer; `returnedAt`, `disposedAt`, and respective closure fields set on transition; `foundAt` and detection data are immutable from creation.

---

## Self-Check Protocol

The following self-check must be run on the written file before presenting to the Architect. It is source-grounded — each step reads from files, not from memory.

**Step 1 — Load written file.** Use the `view` tool to read this file in chunks.

**Step 2 — Count models.** Count model entries in §7.2. Target: 96. Any deviation from 96 is a finding.

**Step 3 — Confirm v2.3/v2.4/v2.5 additions.** Verify presence of: `AiDraftRecordModel`, `HumanDecisionRecordModel`, `CorrectionRecordModel`, `AiAuditSupplementRecordModel`, `StaffListeningSummaryRecordModel`, `DisputeGateOverrideRecordModel`, `ResolutionBundleModel`, `ProcessingLockRecordModel`.

**Step 4 — Check query specifications against Part 6.** For each service in Part 6 §§6.5–6.7, confirm the corresponding model carries a query specification that supports the service's database access pattern.

**Step 5 — Vocabulary check.** Search for "Engagement" — confirm any instance is plain English, not conflation with "Inquiry". Search for "Sequelize", "raw SQL" — none should appear.

**Step 6 — IP boundary check.** Search for DOSS principle numbers (P1, P3, P6, etc.) and FAC references. None should appear.

**Findings are presented to Architect before any corrections are applied.**

---

## Category 1 Clarification Requests (Gate 7)

No Category 1 clarification requests surfaced at Gate 7. All query specifications were derivable from the declared sources (Part 2 schema and Part 6 service access patterns). No Canon block was required beyond what Part 2 already carries.

---

## Open Items Carried Through Gate 7

| ID | Item | Status |
|---|---|---|
| OI-014-03 | Gate 8 writer must load §70B as declared source — correction log maximum size | Carried forward; no action at Gate 7 |
| OI-014-04 | Gate 11 writer must load §70B as declared source — LLM API connection configuration | Carried forward; no action at Gate 7 |

---

*End of DEV-SPEC-001-Part7.md*
*Prepared by Claude (AI Architectural Partner)*
*Gate 7 — Models*
*07 April 2026*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until the Architect confirms.*
