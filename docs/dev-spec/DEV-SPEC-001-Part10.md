# LEGPHEL PMS — DEV-SPEC-001
# Part 10 — DTOs
# §10.1 through §10.2

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 10 — DTOs |
| Version | 1.0-DRAFT |
| Date | 08 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§10.1–10.2); DEV-SPEC-001-Part9.md; DEV-SPEC-001-Part1.md; DEV-SPEC-001-Part2.md; DEV-SPEC-001-Part6.md |

---

## §10.1 — DTO Design Principles

### 10.1.1 DTOs Are Never Database Models

A DTO (Data Transfer Object) is a typed data transfer contract — nothing more. No DTO imports, extends, or wraps a Prisma model. No DTO definition references a Prisma model type. A DTO carries the fields needed at an API boundary; a Prisma model carries the full schema of a database record with all its constraints, relations, and internal fields. These are categorically different artefacts. Any DTO definition that includes a Prisma model reference is an architectural violation.

### 10.1.2 Naming Convention

**Convention in force: Part 9 established convention (Option B).**

Request DTOs follow the form `{Action}{Entity}RequestDTO` — for example `PlaceProcessingLockRequestDTO`, `CreateEntryRequestDTO`, `AcceptHandoffRequestDTO`.

Response DTOs follow the form `{Entity}ResponseDTO` or `{Entity}{Qualifier}ResponseDTO` — for example `InquiryResponseDTO`, `EntryDetailResponseDTO`, `ProcessingLockReconfirmResponseDTO`.

**NAMING-001 — Category 1 Clarification Request (Pending Architect Lock)**

> The ToC §10.1 specifies `{Entity}{Operation}DTO` (e.g., `ProcessingLockPlaceDTO`, `AIDraftDecisionDTO`). Part 9, written at Gate 9, established `{Action}{Entity}RequestDTO` / `{Entity}ResponseDTO`. Both are applied across their respective document. This gate has applied the Part 9 convention (Option B) throughout §10.2 to maintain consistency with the upstream route catalogue. If the Architect locks Option A (ToC convention), all DTO names in this part and all DTO references in Part 9 require an amendment pass. This item is registered in Appendix A as NAMING-001.

**ToC mandatory DTO name mapping.** The eight mandatory DTOs named in the ToC §10.2 map to Part 9-convention names as defined in this catalogue:

| ToC Name | Part 10 Name | Section |
|---|---|---|
| `ProcessingLockPlaceDTO` | `PlaceProcessingLockRequestDTO` | §10.2.18 |
| `ProcessingLockReconfirmDTO` | `ReconfirmProcessingLockRequestDTO` | §10.2.18 |
| `ProcessingLockStatusResponseDTO` | `ProcessingLockResponseDTO` | §10.2.18 |
| `AIDraftReviewQueueItemDTO` | `AiDraftReviewQueueItemDTO` | §10.2.19 |
| `AIDraftDecisionDTO` | `ApproveDraftRequestDTO` / `EditAndApproveDraftRequestDTO` / `RejectDraftRequestDTO` | §10.2.19 |
| `HumanDecisionRecordResponseDTO` | `HumanDecisionRecordResponseDTO` | §10.2.19 |
| `StaffListeningSummaryCreateDTO` | `StaffListeningSummaryRequestDTO` | §10.2.20 |
| `DisputeGateOverrideCreateDTO` | `DisputeGateOverrideRequestDTO` | §10.2.12 |

### 10.1.3 One DTO Per Boundary Per Operation

Every route in Part 9 §9.4 has exactly one Request DTO and exactly one Response DTO. Request DTOs are never reused as Response DTOs. Two routes that return the same shape may reference the same named Response DTO; two routes that accept different inputs always have distinct Request DTOs regardless of how similar the shapes appear. A single DTO definition may be referenced by multiple routes only for its Response DTO role — never across methods (a GET response DTO and a POST request DTO are never the same object).

### 10.1.4 Field-Level Definitions

Every DTO carries typed fields. The type notation used throughout §10.2 is:

| Notation | Meaning |
|---|---|
| `string` | Plain string |
| `string (uuid)` | UUID v4 string |
| `string (iso-date)` | ISO 8601 date `YYYY-MM-DD` |
| `string (iso-datetime)` | ISO 8601 datetime with timezone |
| `integer` | Integer number |
| `decimal` | Decimal number (financial fields — precision as in Prisma model) |
| `boolean` | Boolean |
| `enum: EnumName` | One of the named Prisma enum's values (Part 2 §2.1.3 is authoritative) |
| `object: DTOName` | Nested DTO — see definition in this catalogue |
| `array: DTOName` | Array of the named DTO |
| `string?` / `integer?` etc. | Optional field — may be absent from the request or null in the response |
| `object?` / `array?` | Optional nested object or array |

Enum field values must match the exact enum values defined in Part 2 §2.1.3. A request body containing an enum value not present in the Prisma schema is rejected by validation middleware before reaching the controller handler.

Validation rules stated per field:
- **Required** — the field must be present and non-null. Absent or null fails validation.
- **Optional** — the field may be absent or null. If present, the stated type constraint applies.
- **String length** — stated where the field carries a meaningful constraint.

### 10.1.5 No Business Logic in DTOs

A DTO is a pure data shape. A DTO that contains a method, a computed property, a conditional branch, or any runtime behaviour is an architectural violation. Computation belongs in the service and engine layers. Validation belongs in the validation middleware. A DTO is never called, never invoked, and never evaluated — it is only parsed and passed.

### 10.1.6 Validation Middleware Enforcement

The validation middleware defined in Part 9 §9.2.2 enforces every Request DTO's schema before the controller handler executes. The field definitions in §10.2 constitute the schema the validation middleware enforces. No controller handler may receive an unvalidated request. No additional field-level validation may be added inside the controller handler on fields already covered by the DTO schema.

A validation failure produces `ValidationError` with per-field detail: `{ field, value, constraint, message }`. Validation does not short-circuit on the first failure — all fields are evaluated and all failures are returned in a single error response.

### 10.1.7 Response DTOs Are Subsets — Never Full Records

Response DTOs are shaped from Prisma model fields but are subsets, not copies. A response DTO exposes only the fields the caller needs. Internal system fields, operational metadata not relevant to the caller, and any field that should not leave the service layer are excluded from response DTOs.

The following fields must never appear in any response DTO under any circumstance:

- `StaffUser.pin` — the hashed PIN. Never returned in any endpoint.
- Any field containing raw JWT token content — with one sole exception: `SessionResponseDTO` from the authentication endpoint must return the JWT token to establish the session. No other response DTO carries JWT content.
- Internal system configuration values (configuration table raw entries, environment variable values, infrastructure identifiers).
- IP addresses, infrastructure host identifiers, or internal system node references.
- `behaviouralFlags` and `observationQueue` on `GuestProfile` — internal profiling data not for general API exposure.
- `aiActorId` and `draftContent` raw fields are exposed only within the AI draft review queue where the human reviewer specifically needs them.

### 10.1.8 B4-001 Notation

B4-001 (concurrent editing mechanism) is unresolved. Affected Request DTOs are flagged with:

> `[B4-001 — Concurrent editing mechanism unresolved. If Candidate A (optimistic locking) is selected: add version: integer (required) to this DTO carrying the record's current version at time of read. Carry forward pending Architect decision.]`

No `version` field is added to any DTO in this draft. The flag identifies the DTOs that will require the field if Candidate A is selected.

---

## §10.2 — DTO Catalogue

DTOs are organised by domain group matching Part 9 §§9.4.2–9.4.21. Within each group, all Request DTOs are defined first, then all Response DTOs. This ordering enables mechanical completeness verification against the Part 9 route catalogue.

---

### 10.2.1 Domain Group: Session and Authentication

---

#### Request DTOs

**`AuthenticateRequestDTO`**
Route: `POST /auth/authenticate`

| Field | Type | Req | Notes |
|---|---|---|---|
| `pin` | `string` | Required | Staff PIN — 4–6 digits. Validated against hashed stored value by service. Never stored in request logs. |
| `terminalId` | `string` | Required | Terminal identifier string. Must match a terminal registered to the staff member. |

---

**`PinSwitchRequestDTO`**
Route: `POST /auth/switch`

| Field | Type | Req | Notes |
|---|---|---|---|
| `incomingPin` | `string` | Required | PIN of the staff member taking over the terminal session. |
| `terminalId` | `string` | Required | Terminal identifier. Must match the terminal of the current outgoing session. |

---

**`ManualLockRequestDTO`**
Route: `POST /auth/lock`

| Field | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | `string (uuid)` | Required | The session to be manually locked. Must match the authenticated session. |

---

**`LogoutRequestDTO`**
Route: `POST /auth/logout`

| Field | Type | Req | Notes |
|---|---|---|---|
| `sessionId` | `string (uuid)` | Required | The session to terminate. Must match the authenticated session. |

---

#### Response DTOs

**`SessionResponseDTO`**
Used by: `POST /auth/authenticate`, `POST /auth/switch`

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string (uuid)` | The newly created or continued session identifier. |
| `actorId` | `string (uuid)` | The authenticated staff member's `StaffUser.id`. |
| `actorLevel` | `enum: ActorLevel` | Authority level of the authenticated actor. |
| `terminalId` | `string` | Terminal identifier for this session. |
| `authenticatedAt` | `string (iso-datetime)` | Timestamp of authentication. |
| `status` | `enum: SessionStatus` | Current session status — `ACTIVE` on successful authentication. |
| `token` | `string` | JWT session token. **This is the sole response DTO permitted to carry JWT content.** No other response DTO in this catalogue may include a JWT field. |

---

**`SessionStatusResponseDTO`**
Used by: `POST /auth/lock`, `POST /auth/logout`

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string (uuid)` | Session identifier. |
| `actorId` | `string (uuid)` | Actor whose session was affected. |
| `status` | `enum: SessionStatus` | Updated session status. |
| `updatedAt` | `string (iso-datetime)` | Timestamp of the status change. |

---

### 10.2.2 Domain Group: Inquiries

---

#### Request DTOs

**`CreateInquiryRequestDTO`**
Route: `POST /inquiries`

| Field | Type | Req | Notes |
|---|---|---|---|
| `guestProfileId` | `string (uuid)` | Required | The existing or newly created guest profile to link. |
| `sourceChannel` | `string` | Required | Channel through which the inquiry arrived (e.g., `DIRECT`, `OTA`, `CORPORATE`, `WALK_IN`). |
| `notes` | `string?` | Optional | Initial inquiry context notes. Max 2000 characters. |

---

**`ListInquiriesRequestDTO`**
Route: `GET /inquiries`
*(query parameters)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Opaque pagination cursor from prior response `meta.nextCursor`. Absent on first page. |
| `limit` | `integer?` | Optional | Records per page. Default 20, maximum 100. |
| `status` | `string?` | Optional | Filter by derived inquiry status. |
| `custodianId` | `string (uuid)?` | Optional | Filter by assigned custodian. |
| `guestProfileId` | `string (uuid)?` | Optional | Filter by guest profile. |

---

**`GetInquiryRequestDTO`**
Route: `GET /inquiries/:id`
*(path parameter)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | `Inquiry.id` — extracted from path. |

---

**`ParkInquiryRequestDTO`**
Route: `POST /inquiries/:id/park`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |
| `reason` | `string` | Required | Reason for parking. Max 500 characters. |

---

**`UnparkInquiryRequestDTO`**
Route: `POST /inquiries/:id/unpark`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |

---

**`AssignCustodianRequestDTO`**
Route: `POST /inquiries/:id/assign-custodian`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Inquiry.id`. |
| `newCustodianId` | `string (uuid)` | Required | `StaffUser.id` of the staff member to assign as custodian. |

---

#### Response DTOs

**`InquiryResponseDTO`**
Used by: `POST /inquiries`, `GET /inquiries/:id`, `POST /inquiries/:id/assign-custodian`

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

**`InquiryListResponseDTO`**
Used by: `GET /inquiries`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: InquiryResponseDTO` | Page of inquiry records. Pagination meta in standard envelope `meta` field. |

---

**`InquiryStatusResponseDTO`**
Used by: `POST /inquiries/:id/park`, `POST /inquiries/:id/unpark`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Inquiry identifier. |
| `referenceNumber` | `string` | Inquiry reference. |
| `derivedStatus` | `string` | Updated computed status. |
| `parkedAt` | `string (iso-datetime)?` | Populated when inquiry was parked. Null when unparked. |
| `parkedBy` | `string (uuid)?` | Actor who parked the inquiry. |

---

### 10.2.3 Domain Group: Entries

---

#### Request DTOs

**`CreateEntryRequestDTO`**
Route: `POST /entries`

| Field | Type | Req | Notes |
|---|---|---|---|
| `inquiryId` | `string (uuid)` | Required | The inquiry this entry belongs to. |
| `useType` | `enum: EntryUseType` | Required | `ACCOMMODATION` \| `CONFERENCE` \| `APARTMENT` \| `CATERING` \| `GROUP`. Immutable after creation. |
| `checkInDate` | `string (iso-date)?` | Optional | Provisional check-in date. Required for ACCOMMODATION; optional for CONFERENCE/CATERING. |
| `checkOutDate` | `string (iso-date)?` | Optional | Provisional check-out date. |
| `guestCount` | `integer?` | Optional | Provisional guest count. |
| `otaSource` | `boolean?` | Optional | Set `true` if the booking originates from an OTA channel. Immutable once set. Defaults to `false`. |

---

**`ListEntriesRequestDTO`**
Route: `GET /entries`
*(query parameters)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `inquiryId` | `string (uuid)?` | Optional | Filter by parent inquiry. |
| `stage` | `enum: Stage?` | Optional | Filter by current stage (`S1`–`S9`). |
| `status` | `enum: EntryStatus?` | Optional | Filter by entry status. |
| `useType` | `enum: EntryUseType?` | Optional | Filter by use type. |
| `custodianId` | `string (uuid)?` | Optional | Filter by assigned custodian. |

---

**`GetEntryRequestDTO`**
Route: `GET /entries/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |

---

**`ProgressStageRequestDTO`**
Route: `POST /entries/:id/progress-stage`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `targetStage` | `enum: Stage` | Required | The stage to transition to. Must be the next valid stage per state machine. |
| `transitionData` | `object?` | Optional | Structured data specific to the transition type. Shape varies by target stage — validated by the service against the state machine guard requirements for that transition. |
| `version` | `integer` | Required | Current version of the `Entry` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `EntryResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `Entry` model field addition and Part 9 §9.2.3 mechanism section pending end session.]*

---

**`ParkEntryRequestDTO`**
Route: `POST /entries/:id/park`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `reason` | `string` | Required | Reason for parking. Max 500 characters. |

---

**`UnparkEntryRequestDTO`**
Route: `POST /entries/:id/unpark`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |

---

**`ReassignCustodianRequestDTO`**
Route: `POST /entries/:id/reassign-custodian`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `newCustodianId` | `string (uuid)` | Required | `StaffUser.id` of the incoming custodian. |
| `reason` | `string` | Required | Reason for reassignment. Mandatory field; service rejects absent or empty reason. |
| `version` | `integer` | Required | Current version of the `Entry` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `EntryResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `Entry` model field addition pending end session.]*

---

#### Response DTOs

**`EntryResponseDTO`**
Used by: `POST /entries`, `POST /entries/:id/progress-stage`, `POST /entries/:id/reassign-custodian`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Entry identifier. |
| `inquiryId` | `string (uuid)` | Parent inquiry. |
| `segmentNumber` | `integer` | Current segment number. Starts at 1; increments on re-entry. |
| `useType` | `enum: EntryUseType` | Entry use type — immutable after creation. |
| `status` | `enum: EntryStatus` | Current status (`ACTIVE`, `PARKED`, `EXPIRED`, `CANCELLED`, `CLOSED`). |
| `currentStage` | `enum: Stage` | Current stage (`S1`–`S9`). |
| `checkInDate` | `string (iso-date)?` | Provisional or confirmed check-in date. |
| `checkOutDate` | `string (iso-date)?` | Provisional or confirmed check-out date. |
| `guestCount` | `integer?` | Guest count. |
| `otaSource` | `boolean` | Whether this entry originated from an OTA channel. |
| `groupBillingMode` | `enum: GroupBillingMode?` | Active only for GROUP use type entries. |
| `parkedAt` | `string (iso-datetime)?` | When the entry was parked. Null when not parked. |
| `parkedBy` | `string (uuid)?` | Actor who parked the entry. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `updatedAt` | `string (iso-datetime)` | Last update timestamp. |
| `createdBy` | `string (uuid)` | Creating actor. |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp if entry has reached a terminal state. |
| `version` | `integer` | Current optimistic lock version. Callers must supply this value in write request DTOs for this entry. |

---

**`EntryDetailResponseDTO`**
Used by: `GET /entries/:id`

Includes all fields of `EntryResponseDTO` plus:

| Field | Type | Notes |
|---|---|---|
| `segments` | `array` | Summary list of all segments: `{ segmentId, segmentNumber, stage, startedAt, sealedAt }`. |
| `reservation` | `object?` | Reservation summary if exists: `{ id, frozenRate, frozenCheckInDate, frozenCheckOutDate, confirmedAt }`. |
| `activeDisputes` | `array` | Summary of disputes in `OPEN` or `IN_PROGRESS` state: `{ id, failureCategory, state, detectedAt }`. |
| `activeHandoffs` | `array` | Summary of handoffs not yet in `CLOSED` state: `{ id, handoffType, state, toRole }`. |

---

**`EntryListResponseDTO`**
Used by: `GET /entries`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: EntryResponseDTO` | Page of entry records. |

---

**`EntryStatusResponseDTO`**
Used by: `POST /entries/:id/park`, `POST /entries/:id/unpark`, `POST /entries/:id/cancel`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Entry identifier. |
| `status` | `enum: EntryStatus` | Updated entry status. |
| `currentStage` | `enum: Stage` | Current stage. |
| `parkedAt` | `string (iso-datetime)?` | Populated when entry is parked; null when active or cancelled. |

---

### 10.2.4 Domain Group: Availability

---

#### Request DTOs

**`AvailabilitySearchRequestDTO`**
Route: `POST /availability/search`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | The entry for which availability is being searched. |
| `checkInDate` | `string (iso-date)` | Required | Requested check-in date. |
| `checkOutDate` | `string (iso-date)` | Required | Requested check-out date. Must be after `checkInDate`. |
| `guestCount` | `integer` | Required | Number of guests. Minimum 1. |
| `useType` | `enum: EntryUseType` | Required | Use type of the entry. |
| `roomTypeId` | `string (uuid)?` | Optional | Filter results to a specific room type. |
| `deficientAcknowledgements` | `array?` | Optional | Array of `{ deficientConditionId, acknowledged: boolean }`. Records guest acknowledgement of known DEFICIENT conditions on a candidate room. |

---

**`GetAvailabilityConfigRequestDTO`**
Route: `GET /availability/configurations/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AvailabilityConfiguration.id`. |

---

**`RecallAvailabilityConfigRequestDTO`**
Route: `POST /availability/configurations/:id/recall`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AvailabilityConfiguration.id` — must be a stale configuration. |

---

#### Response DTOs

**`AvailabilityResultResponseDTO`**
Used by: `POST /availability/search`, `POST /availability/configurations/:id/recall`

| Field | Type | Notes |
|---|---|---|
| `configurationId` | `string (uuid)` | The `AvailabilityConfiguration.id` created or recalled. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `queriedAt` | `string (iso-datetime)` | When the search was executed. |
| `isStale` | `boolean` | Whether this configuration is stale. False for new searches. |
| `results` | `array` | Available inventory options: `{ inventoryId, inventoryType, roomNumber?, claimState: enum:InventoryClaimState, isDeficient: boolean, deficientCategory?: enum:DeficientConditionCategory, pricingIndicative: { rateAmount: decimal, currency: string, taxModel: enum:TaxModel } }`. |

---

**`AvailabilityConfigResponseDTO`**
Used by: `GET /availability/configurations/:id`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Configuration identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `searchCriteria` | `object` | The search parameters captured at creation. |
| `optionSelected` | `object?` | The inventory option the actor selected from results, if selected. |
| `isStale` | `boolean` | Whether this configuration has been marked stale. |
| `stalenessAt` | `string (iso-datetime)?` | When staleness was detected. |
| `sealedAt` | `string (iso-datetime)?` | When sealed on S1 exit. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

### 10.2.5 Domain Group: Quotations and Holds

*P5 note: QuotationService and HoldService are absent from Part 6. Request DTO field definitions below are derived from Part 2 model structures and Part 5 policy enforcement points. See P5 flag on each affected DTO.*

---

#### Request DTOs

**`CreateQuotationRequestDTO`**
Route: `POST /entries/:id/quotations`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: the entry for which the quotation is created. |
| `ratePlanId` | `string (uuid)` | Required | The rate plan selected for this quotation. Validated against availability configuration and pricing pipeline. |
| `roomId` | `string (uuid)?` | Optional | Specific room to quote (if availability has been narrowed to a specific unit). |
| `spaceId` | `string (uuid)?` | Optional | Space identifier for CONFERENCE use type. |
| `checkInDate` | `string (iso-date)` | Required | Check-in date for this quotation. |
| `checkOutDate` | `string (iso-date)` | Required | Check-out date for this quotation. Must be after `checkInDate`. |
| `guestCount` | `integer` | Required | Guest count for pricing computation. |
| `inclusions` | `array?` | Optional | Array of `{ packageId: string (uuid) }` for package inclusions. |
| `discountPercentage` | `decimal?` | Optional | Discount percentage requested. Subject to authority limits enforced by discount policy. |
| `validUntil` | `string (iso-datetime)?` | Optional | Quotation validity window. Service applies default from configuration if absent. |
| `notes` | `string?` | Optional | Free-text quotation notes. |

*[P5 — Part 6 service contract pending backfill for QuotationService. Field definitions derived from Part 2 Quotation model structure and Part 5 policy enforcement points (Policy 19 Rate Plan Resolution, Policy 23 Discount Approval, Policy 37 FOC Entitlement). Verification pass required after P5 backfill.]*

---

**`SendQuotationRequestDTO`**
Route: `POST /quotations/:id/send`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Quotation.id`. Must be in `DRAFT` state. |
| `channel` | `enum: CommunicationChannel` | Required | Channel to send through (`EMAIL` \| `WHATSAPP`). |
| `recipient` | `string` | Required | Email address or WhatsApp contact reference for the recipient. |

*[P5 — Part 6 service contract pending backfill for QuotationService. Field definitions derived from Part 2 Quotation model and Part 5 Policy 52 (Communication Acknowledgement Tracking). Verification pass required after P5 backfill.]*

---

**`AcceptQuotationRequestDTO`**
Route: `POST /quotations/:id/accept`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Quotation.id`. Must be in `SENT` state per state machine guard. |

*[P5 — Part 6 service contract pending backfill for QuotationService. Acceptance is a state transition — guard conditions are in Part 3 §3.14. Verification pass required after P5 backfill.]*

---

**`PlaceSpeculativeHoldRequestDTO`**
Route: `POST /entries/:id/holds/speculative`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: the entry for which the speculative hold is placed. |
| `roomId` | `string (uuid)?` | Optional | Room to hold. Required when use type is ACCOMMODATION. |
| `spaceId` | `string (uuid)?` | Optional | Space to hold. Required when use type is CONFERENCE. |
| `notes` | `string?` | Optional | Reason or context for the speculative hold. |

*[P5 — Part 6 service contract pending backfill for HoldService. Field definitions derived from Part 2 SpeculativeHold model and Part 5 Policy 25 (Speculative Hold Placement Policy). TTL is set from configuration by the service — not caller-supplied. Verification pass required after P5 backfill.]*

---

**`PlaceCommittedHoldRequestDTO`**
Route: `POST /entries/:id/holds/committed`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: the entry for which the committed hold is placed. |
| `roomId` | `string (uuid)?` | Optional | Room to hold. Required when use type is ACCOMMODATION. |
| `spaceId` | `string (uuid)?` | Optional | Space to hold. Required when use type is CONFERENCE. |
| `commercialJustification` | `string` | Required | Mandatory justification for the committed hold. Service rejects absent or empty value. |

*[P5 — Part 6 service contract pending backfill for HoldService. Field definitions derived from Part 2 CommittedHold model and Part 5 Policy 26 (Committed Hold Placement Policy), Policy 27 (Advance Payment Collection), Policy 30 (Billing Model Initial Fix), Policy 34 (Cancellation Terms Disclosure), Policy 38 (FOC Validation). Verification pass required after P5 backfill.]*

---

#### Response DTOs

**`QuotationResponseDTO`**
Used by: `POST /entries/:id/quotations`, `POST /quotations/:id/send`, `POST /quotations/:id/accept`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Quotation identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `segmentId` | `string (uuid)` | Active segment at time of creation. |
| `versionNumber` | `integer` | Quotation version. Starts at 1; increments on new version. |
| `referenceNumber` | `string` | Human-readable reference (e.g., `Q-001`). |
| `state` | `enum: QuotationState` | Current state (`DRAFT`, `SENT`, `ACCEPTED`, `SUPERSEDED`, `EXPIRED`). |
| `commercialTerms` | `object` | Structured commercial terms snapshot: rate, inclusions, cancellation policy. |
| `totalAmount` | `decimal` | Computed total amount in BTN. |
| `currency` | `string` | Always `BTN`. |
| `validUntil` | `string (iso-datetime)?` | Quotation validity window end. |
| `sentAt` | `string (iso-datetime)?` | When the quotation was dispatched. |
| `sentTo` | `string?` | Recipient reference. |
| `acceptedAt` | `string (iso-datetime)?` | When accepted. |
| `acceptedBy` | `string (uuid)?` | Actor who recorded acceptance. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `createdBy` | `string (uuid)` | Creating actor. |

*[P5 — Part 6 QuotationService contract pending backfill. Verification pass required.]*

---

**`SpeculativeHoldResponseDTO`**
Used by: `POST /entries/:id/holds/speculative`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Speculative hold identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `roomId` | `string (uuid)?` | Held room, if applicable. |
| `spaceId` | `string (uuid)?` | Held space, if applicable. |
| `state` | `enum: HoldState` | Hold state (`PLACED`, `RELEASED`, `UPGRADED`, `CONFIRMED`). |
| `placedAt` | `string (iso-datetime)` | When the hold was placed. |
| `placedBy` | `string (uuid)` | Actor who placed the hold. |
| `ttlSeconds` | `integer` | TTL of this hold in seconds (from configuration). |
| `expiresAt` | `string (iso-datetime)` | When the hold expires. |
| `notes` | `string?` | Notes. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

*[P5 — Part 6 HoldService contract pending backfill. Verification pass required.]*

---

**`CommittedHoldResponseDTO`**
Used by: `POST /entries/:id/holds/committed`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Committed hold identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `roomId` | `string (uuid)?` | Held room, if applicable. |
| `spaceId` | `string (uuid)?` | Held space, if applicable. |
| `state` | `enum: HoldState` | Hold state. |
| `placedAt` | `string (iso-datetime)` | When the hold was placed. |
| `placedBy` | `string (uuid)` | Actor who placed the hold. |
| `commercialJustification` | `string` | Justification recorded at placement. |
| `ttlSeconds` | `integer` | TTL in seconds. |
| `expiresAt` | `string (iso-datetime)` | Hold expiry. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

*[P5 — Part 6 HoldService contract pending backfill. Verification pass required.]*

---

### 10.2.6 Domain Group: Reservations

---

#### Request DTOs

**`ConfirmReservationRequestDTO`**
Route: `POST /entries/:id/confirm`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: `Entry.id`. Entry must be at S3 with a committed hold in place. |
| `availabilityConfigurationId` | `string (uuid)` | Required | The sealed availability configuration that anchors the commercial terms being confirmed. |
| `creditExtension` | `object?` | Optional | If credit is being extended: `{ ceilingAmount: decimal, reason: string }`. Triggers `CreditExtensionCeilingRecord` creation. Required if the billing model requires credit extension at S4. |
| `confirmationVoucherRecipient` | `string?` | Optional | Email or contact reference for confirmation voucher dispatch. If absent, service uses the contact on the guest profile. |

---

**`GetReservationRequestDTO`**
Route: `GET /reservations/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Reservation.id`. |

---

#### Response DTOs

**`ReservationResponseDTO`**
Used by: `POST /entries/:id/confirm`, `GET /reservations/:id`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Reservation (commitment snapshot) identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `segmentId` | `string (uuid)` | Segment at time of confirmation. |
| `frozenRate` | `decimal` | Frozen rate in BTN. Immutable from creation. |
| `frozenRatePlanId` | `string (uuid)` | Frozen rate plan reference. Immutable from creation. |
| `frozenInclusions` | `object` | Snapshot of package inclusions at S4. Immutable from creation. |
| `frozenCancellationTerms` | `object` | Cancellation policy snapshot at S4. Immutable from creation. |
| `frozenBillingModel` | `string` | Billing model locked at S4. Immutable from creation. |
| `frozenCheckInDate` | `string (iso-datetime)` | Confirmed check-in date. Immutable from creation. |
| `frozenCheckOutDate` | `string (iso-datetime)` | Confirmed check-out date. Immutable from creation. |
| `frozenGuestCount` | `integer` | Confirmed guest count. Immutable from creation. |
| `creditCeilingIfExtended` | `decimal?` | Credit ceiling if credit extended at S4. Null if no credit extended. |
| `confirmedAt` | `string (iso-datetime)` | Confirmation timestamp. |
| `confirmedBy` | `string (uuid)` | Confirming actor. |
| `confirmationVoucherSent` | `boolean` | Whether the confirmation voucher has been dispatched. |
| `sealedAt` | `string (iso-datetime)?` | When sealed at S9 closure. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

### 10.2.7 Domain Group: Folios

---

#### Request DTOs

**`GetFolioRequestDTO`**
Route: `GET /folios/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `Folio.id`. |

---

**`RecordPaymentRequestDTO`**
Route: `POST /folios/:id/payments`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. |
| `amount` | `decimal` | Required | Payment amount in BTN (or foreign currency — see below). Minimum 0.01. |
| `currency` | `string` | Required | Currency of the payment. `BTN` is authoritative. For foreign currency payments, carry the foreign currency code here and populate conversion fields. |
| `paymentMethod` | `string` | Required | `CASH` \| `CARD` \| `BANK_TRANSFER` \| `CREDIT_ACCOUNT`. |
| `receivedAt` | `string (iso-datetime)` | Required | When payment was received. Must not be backdated to before the folio's `createdAt`. |
| `foreignCurrencyAmount` | `decimal?` | Optional | Amount in foreign currency if payment was made in a non-BTN currency. |
| `btnEquivalent` | `decimal?` | Optional | BTN equivalent of foreign currency amount. Required if `foreignCurrencyAmount` is present. |
| `exchangeRate` | `decimal?` | Optional | Exchange rate applied. Required if `foreignCurrencyAmount` is present. |
| `invoiceId` | `string (uuid)?` | Optional | Invoice this payment is applied against, if applicable. |

---

**`PostChargeRequestDTO`**
Route: `POST /folios/:id/charges`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. Must be in `LIVE` state. |
| `lineType` | `string` | Required | Charge category: `ROOM_CHARGE` \| `F_AND_B` \| `SERVICE` \| `PENALTY` \| `OTHER`. |
| `description` | `string` | Required | Charge description. Max 500 characters. |
| `amount` | `decimal` | Required | Charge amount in BTN before tax. Minimum 0.01. |
| `chargeDate` | `string (iso-date)` | Required | Date the charge was incurred. Service validates this date has not been sealed by night audit. |

---

**`InitiateSettlementRequestDTO`**
Route: `POST /folios/:id/settle`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. Must be in `LIVE` state. |
| `settlementNotes` | `string?` | Optional | Notes for the settlement event. |
| `creditCeilingAcknowledgement` | `boolean?` | Optional | Required as `true` when the folio balance exceeds the credit ceiling — explicit FOM acknowledgement. Service enforces presence of this field when the ceiling gate is active. |

---

**`AddCreditNoteRequestDTO`**
Route: `POST /folios/:id/credit-notes`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. |
| `folioLineId` | `string (uuid)` | Required | The `FolioLine.id` being offset by this credit note. |
| `amount` | `decimal` | Required | Credit note amount in BTN. Must not exceed the amount of the referenced folio line. |
| `reason` | `string` | Required | Mandatory reason for the credit note. Max 500 characters. Service rejects absent or empty reason. |

---

**`IssueInvoiceRequestDTO`**
Route: `POST /folios/:id/invoices`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. |
| `invoiceType` | `enum: InvoiceType` | Required | `PROFORMA` \| `FINAL` \| `POST_STAY`. |
| `dispatchTo` | `string` | Required | Email address or contact reference for dispatch. |

---

**`ListInvoicesRequestDTO`**
Route: `GET /folios/:id/invoices`

| Field | Type | Req | Notes |
|---|---|---|---|
| `folioId` | `string (uuid)` | Required | Path param: `Folio.id`. |
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |

---

#### Response DTOs

**`FolioDetailResponseDTO`**
Used by: `GET /folios/:id`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Folio identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `state` | `enum: FolioState` | Current folio state. |
| `convertedToLiveAt` | `string (iso-datetime)?` | When provisional folio converted to live at S6. |
| `closedAt` | `string (iso-datetime)?` | When the folio was closed (any closure type). |
| `postClosureAccessLevel` | `enum: PostClosureAccessLevel?` | Post-closure access level if folio is sealed. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `createdBy` | `string (uuid)` | Creating actor. |
| `lines` | `array` | Folio lines: `{ id, lineType, description, amount, taxAmount, chargeDate, postedBy }`. |
| `payments` | `array` | Payment records: `{ id, amount, currency, paymentMethod, receivedAt, recordedBy }`. |
| `invoices` | `array` | Invoice summaries: `{ id, invoiceType, invoiceNumber, state, totalAmount, dispatchedAt }`. |

---

**`PaymentRecordResponseDTO`**
Used by: `POST /folios/:id/payments`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Payment record identifier. |
| `folioId` | `string (uuid)` | Folio this payment belongs to. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `amount` | `decimal` | Payment amount. |
| `currency` | `string` | Payment currency. |
| `foreignCurrencyAmount` | `decimal?` | Foreign currency amount if applicable. |
| `btnEquivalent` | `decimal?` | BTN equivalent if foreign currency. |
| `exchangeRate` | `decimal?` | Exchange rate applied. |
| `paymentMethod` | `string` | `CASH` \| `CARD` \| `BANK_TRANSFER` \| `CREDIT_ACCOUNT`. |
| `paymentDirection` | `string` | `IN` for received payments. `OUT` for refunds (new record). |
| `matchingOutcome` | `string?` | `FULL` \| `PARTIAL` \| `OVERPAYMENT` \| `FAILED`. Null if not yet matched. |
| `receivedAt` | `string (iso-datetime)` | When payment was received. |
| `recordedBy` | `string (uuid)` | Recording actor. |
| `stage` | `enum: Stage` | Stage context at time of recording. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

**`FolioLineResponseDTO`**
Used by: `POST /folios/:id/charges`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Folio line identifier. |
| `folioId` | `string (uuid)` | Parent folio. |
| `lineType` | `string` | Charge category. |
| `description` | `string` | Charge description. |
| `amount` | `decimal` | Charge amount before tax. |
| `taxAmount` | `decimal` | Computed tax amount. |
| `taxModel` | `enum: TaxModel` | `ADDITIVE` or `INCLUSIVE`. |
| `chargeDate` | `string (iso-datetime)` | Charge incurrence date. |
| `stage` | `enum: Stage` | Stage at time of posting. |
| `postedBy` | `string (uuid)` | Posting actor. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. Immutable from creation. |

---

**`FolioResponseDTO`**
Used by: `POST /folios/:id/settle`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Folio identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `state` | `enum: FolioState` | Updated folio state after settlement initiation. |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp if fully closed. |
| `closedBy` | `string (uuid)?` | Closing actor. |
| `createdAt` | `string (iso-datetime)` | Folio creation timestamp. |

---

**`CreditNoteResponseDTO`**
Used by: `POST /folios/:id/credit-notes`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Credit note identifier. |
| `folioId` | `string (uuid)` | Parent folio. |
| `folioLineId` | `string (uuid)` | Referenced folio line. |
| `amount` | `decimal` | Credit note amount. |
| `currency` | `string` | Currency (BTN). |
| `reason` | `string` | Recorded reason. |
| `authorityLevel` | `string` | `FOM` or `GM`. |
| `issuedBy` | `string (uuid)` | Issuing actor. |
| `issuedAt` | `string (iso-datetime)` | Issuance timestamp. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

**`InvoiceResponseDTO`**
Used by: `POST /folios/:id/invoices`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Invoice identifier. |
| `folioId` | `string (uuid)` | Parent folio. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `invoiceType` | `enum: InvoiceType` | `PROFORMA` \| `FINAL` \| `POST_STAY`. |
| `state` | `enum: InvoiceState` | Current invoice state. |
| `invoiceNumber` | `string` | Unique invoice number. |
| `totalAmount` | `decimal` | Invoice total including tax. |
| `currency` | `string` | Always `BTN`. |
| `taxAmount` | `decimal` | Tax component. |
| `issuedAt` | `string (iso-datetime)?` | Issue timestamp. |
| `dispatchedAt` | `string (iso-datetime)?` | Dispatch timestamp. |
| `dispatchedTo` | `string?` | Recipient reference. |
| `versionNumber` | `integer` | Invoice version (proforma versioning). |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

**`InvoiceListResponseDTO`**
Used by: `GET /folios/:id/invoices`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: InvoiceResponseDTO` | Page of invoice records. |

---

### 10.2.8 Domain Group: Amendments

---

#### Request DTOs

**`AmendmentRequestDTO`**
Route: `POST /entries/:id/amend`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `amendmentPath` | `enum: AmendmentPath` | Required | `PATH_1` \| `PATH_2` \| `PATH_3`. Service validates path selection against system-locked rules (date/room change = PATH_3 mandatory; billing model change = PATH_2 minimum). |
| `amendmentType` | `string` | Required | Nature of the amendment (e.g., `RATE_CHANGE`, `INCLUSION_CHANGE`, `DATE_CHANGE`, `ROOM_CHANGE`, `BILLING_MODEL_CHANGE`, `FOLIO_ADDITION`). Drives path lock validation and downstream consequences. |
| `reason` | `string` | Required | Mandatory reason for the amendment. Service rejects absent or empty reason. |
| `newRatePlanId` | `string (uuid)?` | Optional | For PATH_2 or PATH_3 rate changes. Required when `amendmentType = RATE_CHANGE`. |
| `newCheckInDate` | `string (iso-date)?` | Optional | For date changes (PATH_3). |
| `newCheckOutDate` | `string (iso-date)?` | Optional | For date changes (PATH_3). |
| `newBillingModel` | `enum: GroupBillingMode?` | Optional | For GROUP billing model changes. |
| `folioAdditionDetail` | `object?` | Optional | For PATH_1 folio additions: `{ lineType, description, amount, chargeDate }`. |
| `version` | `integer` | Required | Current version of the `Entry` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `EntryResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `Entry` model field addition pending end session.]*

---

#### Response DTOs

**`AmendmentResponseDTO`**
Used by: `POST /entries/:id/amend`

| Field | Type | Notes |
|---|---|---|
| `entryId` | `string (uuid)` | Amended entry. |
| `amendmentPath` | `enum: AmendmentPath` | Path applied. |
| `appliedAt` | `string (iso-datetime)` | When the amendment was executed. |
| `appliedBy` | `string (uuid)` | Applying actor. |
| `reason` | `string` | Recorded reason. |
| `newSegmentId` | `string (uuid)?` | New segment identifier created on PATH_3 (full renegotiation). Null for PATH_1/2. |
| `folioLineId` | `string (uuid)?` | New folio line created for PATH_1 (folio addition). Null for PATH_2/3. |

---

### 10.2.9 Domain Group: Cancellations

---

#### Request DTOs

**`CancelEntryRequestDTO`**
Route: `POST /entries/:id/cancel`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: `Entry.id`. |
| `reason` | `string` | Required | Cancellation reason. Mandatory at all stages. Service rejects absent or empty reason. |
| `penaltyWaiver` | `boolean?` | Optional | Request penalty waiver (`true`). If `true`, `penaltyWaiverReason` is required. Waiver beyond the actor's authority level escalates per policy. |
| `penaltyWaiverReason` | `string?` | Optional | Required when `penaltyWaiver = true`. Max 1000 characters. |

---

#### Response DTOs

**`EntryStatusResponseDTO`** — see §10.2.3. Reused without modification.

---

### 10.2.10 Domain Group: No-Show

---

#### Request DTOs

**`NoShowDeterminationRequestDTO`**
Route: `POST /entries/:id/no-show`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Path param: `Entry.id`. Entry must be at S5 with no-show conditions met per Policy 56. |
| `reason` | `string` | Required | FOM's determination reason. Service validates that the required contact attempts are recorded before accepting this request. |
| `penaltyWaiver` | `boolean?` | Optional | Request penalty waiver. Requires `ActorLevel.GM`. |
| `penaltyWaiverReason` | `string?` | Optional | Required when `penaltyWaiver = true`. |

---

#### Response DTOs

**`NoShowDeterminationResponseDTO`**
Used by: `POST /entries/:id/no-show`

| Field | Type | Notes |
|---|---|---|
| `entryId` | `string (uuid)` | Anchoring entry. |
| `determinationId` | `string (uuid)` | `NoShowDeterminationRecord.id` — immutable from creation. |
| `determinedBy` | `string (uuid)` | FOM actor who made the determination. |
| `determinedAt` | `string (iso-datetime)` | Determination timestamp. |
| `penaltyAmount` | `decimal` | Penalty posted to the provisional folio. |
| `advancePaymentAmount` | `decimal` | Total advance payment received. |
| `netPosition` | `decimal` | Net position after penalty deduction (positive = refund owed; negative = shortfall). |
| `refundRequired` | `boolean` | Whether a refund is owed (advance exceeded penalty). |
| `folioState` | `enum: FolioState` | Folio closure state — always `NO_SHOW_CLOSED`. |

---

### 10.2.11 Domain Group: Handoffs

---

#### Request DTOs

**`ListHandoffsRequestDTO`**
Route: `GET /handoffs`

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `entryId` | `string (uuid)?` | Optional | Filter by anchoring entry. |
| `type` | `enum: HandoffType?` | Optional | Filter by handoff type (`H1`–`H5`). |
| `state` | `enum: HandoffState?` | Optional | Filter by handoff state. |

---

**`GetHandoffRequestDTO`**
Route: `GET /handoffs/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `HandoffRecord.id`. |

---

**`AcceptHandoffRequestDTO`**
Route: `POST /handoffs/:id/accept`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `HandoffRecord.id`. Must be in `CREATED` or `ASSIGNED` state. |
| `checklistCompletion` | `object` | Required | Structured checklist completion object. Each checklist item key must carry a `completed: boolean` value. All required items must be `true`. Shape must match the `HandoffChecklistTemplate` for the handoff type. |

---

**`FulfilHandoffRequestDTO`**
Route: `POST /handoffs/:id/fulfil`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `HandoffRecord.id`. Must be in `ACCEPTED` state. |
| `fulfilmentEvidence` | `object` | Required | Structured evidence object confirming obligations were completed. Shape varies by handoff type. Service validates completeness per policy. |

---

**`RejectHandoffRequestDTO`**
Route: `POST /handoffs/:id/reject`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `HandoffRecord.id`. |
| `rejectionReason` | `string` | Required | Reason for rejection. Mandatory. Service rejects absent or empty reason. |

---

#### Response DTOs

**`HandoffListResponseDTO`**
Used by: `GET /handoffs`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: HandoffResponseDTO` | Page of handoff records. |

---

**`HandoffResponseDTO`**
Used by: `GET /handoffs/:id`, `POST /handoffs/:id/accept`, `POST /handoffs/:id/fulfil`, `POST /handoffs/:id/reject`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Handoff record identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `handoffType` | `enum: HandoffType` | `H1`–`H5`. |
| `state` | `enum: HandoffState` | Current handoff state. |
| `fromRole` | `string` | Sending role identifier. |
| `fromActorId` | `string (uuid)` | Sending actor. |
| `toRole` | `string` | Receiving role identifier. |
| `toActorId` | `string (uuid)?` | Directed to specific actor, if applicable. |
| `checklistContent` | `object` | Checklist fields per handoff type with completion status. |
| `deficientConditionStatus` | `string?` | H2-specific: DEFICIENT condition status of the assigned room. |
| `fulfilmentEvidence` | `object?` | Evidence provided on FULFILLED. |
| `assignedAt` | `string (iso-datetime)?` | Assignment timestamp. |
| `acceptedAt` | `string (iso-datetime)?` | Acceptance timestamp. |
| `acceptedBy` | `string (uuid)?` | Accepting actor. |
| `fulfilledAt` | `string (iso-datetime)?` | Fulfilment timestamp. |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp. |
| `rejectedAt` | `string (iso-datetime)?` | Rejection timestamp. |
| `rejectionReason` | `string?` | Rejection reason. |
| `escalatedAt` | `string (iso-datetime)?` | Escalation timestamp if SLA breached. |
| `slaDeadlineAt` | `string (iso-datetime)?` | SLA deadline. |
| `isAutoFulfilled` | `boolean` | Whether this handoff was auto-fulfilled. |
| `stageContext` | `enum: Stage` | Stage at time of handoff creation. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

### 10.2.12 Domain Group: Disputes

---

#### Request DTOs

**`OpenDisputeRequestDTO`**
Route: `POST /disputes`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Entry to which the dispute is anchored. |
| `failureCategory` | `enum: DisputeFailureCategory` | Required | `ROOM_CONDITION` \| `SERVICE_DELIVERY` \| `COMMUNICATION` \| `BILLING` \| `COMMERCIAL_TERMS` \| `OPERATIONAL_PROCESS`. |
| `description` | `string` | Required | Dispute description. Max 2000 characters. |
| `reservationId` | `string (uuid)?` | Optional | Reservation reference if dispute is post-S4. Nullable per model — disputes may arise pre-S4. |

---

**`GetDisputeRequestDTO`**
Route: `GET /disputes/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. |

---

**`ListDisputesRequestDTO`**
Route: `GET /disputes`

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `entryId` | `string (uuid)?` | Optional | Filter by anchoring entry. |
| `state` | `enum: DisputeState?` | Optional | Filter by dispute state. Note: `DISPUTE_EXHAUSTED` is not a valid filter value — it is not a valid state in this system. |

---

**`ProgressDisputeRequestDTO`**
Route: `PATCH /disputes/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. |
| `newState` | `enum: DisputeState` | Required | Target state. Valid transitions governed by state machine. `DISPUTE_EXHAUSTED` is never a valid target state. |
| `resolutionNote` | `string?` | Optional | Context note for the state transition. Required when transitioning to `RESOLVED`. |

---

**`CloseDisputeRequestDTO`**
Route: `POST /disputes/:id/close`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. |
| `closureReason` | `string` | Required | Mandatory closure reason. Service rejects absent or empty value. GM authority enforced by auth middleware. |

---

**`ReopenDisputeRequestDTO`**
Route: `POST /disputes/:id/reopen`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. Dispute must be in `CLOSED` state. |
| `reopenReason` | `string` | Required | Mandatory reopen reason. Service rejects absent or empty value. |

---

**`CreateResolutionBundleRequestDTO`**
Route: `POST /disputes/:id/resolution-bundles`

| Field | Type | Req | Notes |
|---|---|---|---|
| `disputeId` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. |
| `items` | `array` | Required | Array of resolution bundle items. Minimum 1 item. Each item: `{ actionType: enum:ResolutionBundleActionType, description?: string, commitmentDeadline?: string (iso-datetime) }`. |

---

**`DisputeGateOverrideRequestDTO`**
Route: `POST /disputes/:id/gate-override`
*(Maps to ToC `DisputeGateOverrideCreateDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `DisputeRecord.id`. |
| `freeTextReason` | `string` | Required | GM's mandatory free-text reason for the override. Service rejects absent or empty value. The `DisputeGateOverrideRecord` is immutable from creation. |
| `targetStage` | `enum: Stage` | Required | The stage the GM is authorising the entry to progress to (typically `S8`). |

Note: This endpoint is valid only when the dispute gate returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` at the S7→S8 transition. At S8→S9, the gate returns `BLOCKED` with no override path. Requests at S8→S9 are rejected with `PolicyGateBlockedError`.

---

#### Response DTOs

**`DisputeListResponseDTO`**
Used by: `GET /disputes`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: DisputeResponseDTO` | Page of dispute records. |

---

**`DisputeResponseDTO`**
Used by: `POST /disputes`, `GET /disputes/:id`, `PATCH /disputes/:id`, `POST /disputes/:id/close`, `POST /disputes/:id/reopen`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Dispute record identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `reservationId` | `string (uuid)?` | Linked reservation, if applicable. |
| `stageAtDetection` | `enum: Stage` | Stage when dispute was detected. |
| `failureCategory` | `enum: DisputeFailureCategory` | Failure category. |
| `state` | `enum: DisputeState` | Current dispute state. |
| `description` | `string` | Dispute description. |
| `detectedAt` | `string (iso-datetime)` | Detection timestamp. |
| `detectedBy` | `string (uuid)` | Detecting actor. |
| `resolvedAt` | `string (iso-datetime)?` | Resolution timestamp. |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp. |
| `closureReason` | `string?` | GM-recorded closure reason. |
| `reopenedAt` | `string (iso-datetime)?` | Reopen timestamp. |
| `reopenReason` | `string?` | Reopen reason. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

**`ResolutionBundleResponseDTO`**
Used by: `POST /disputes/:id/resolution-bundles`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Resolution bundle identifier. |
| `disputeId` | `string (uuid)` | Anchoring dispute. |
| `approvedBy` | `string (uuid)` | Actor who approved the bundle. |
| `approvedAt` | `string (iso-datetime)` | Approval timestamp. |
| `status` | `enum: ResolutionBundleStatus` | `OPEN` \| `SEALED`. |
| `sealedAt` | `string (iso-datetime)?` | When all items executed or cancelled. |
| `items` | `array` | Bundle items: `{ id, actionType: enum:ResolutionBundleActionType, description?, status: enum:ResolutionBundleItemStatus, commitmentDeadline?, executedAt?, cancelledAt?, cancellationReason? }`. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

**`DisputeGateOverrideResponseDTO`**
Used by: `POST /disputes/:id/gate-override`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | `DisputeGateOverrideRecord.id` — immutable from creation. |
| `disputeId` | `string (uuid)` | Referenced dispute. |
| `actorId` | `string (uuid)` | GM actor who invoked the override. |
| `freeTextReason` | `string` | Recorded override reason. |
| `targetStage` | `enum: Stage` | Authorised target stage. |
| `gateReturnValue` | `string` | Always `BLOCKED_WITH_OVERRIDE_AVAILABLE` — the gate value that was active at override time. |
| `overrideAt` | `string (iso-datetime)` | Override timestamp. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

### 10.2.13 Domain Group: Work Orders

---

#### Request DTOs

**`CreateWorkOrderRequestDTO`**
Route: `POST /work-orders`

| Field | Type | Req | Notes |
|---|---|---|---|
| `entryId` | `string (uuid)` | Required | Anchoring entry. |
| `title` | `string` | Required | Work order title. Max 200 characters. |
| `description` | `string?` | Optional | Extended description. Max 2000 characters. |

---

**`GetWorkOrderRequestDTO`**
Route: `GET /work-orders/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `WorkOrder.id`. |

---

**`AmendWorkOrderRequestDTO`**
Route: `POST /work-orders/:id/amend`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `WorkOrder.id`. Must be in `OPEN` status. |
| `title` | `string?` | Optional | Updated title. |
| `description` | `string?` | Optional | Updated description. |
| `amendmentNote` | `string` | Required | Reason for the amendment. Every amendment is a layered event — the note is mandatory. |
| `version` | `integer` | Required | Current version of the `WorkOrder` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `WorkOrderResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `WorkOrder` model already carries `version Int @default(1)` — no field addition required. Part 9 §9.2.3 mechanism section pending end session.]*

---

**`CloseWorkOrderRequestDTO`**
Route: `POST /work-orders/:id/close`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `WorkOrder.id`. Must be in `OPEN` status. Service validates all to-do items are `COMPLETED` or `CANCELLED` before closing. |
| `closureNote` | `string` | Required | Mandatory closure note. Service rejects absent or empty value. |

---

**`CreateToDoItemRequestDTO`**
Route: `POST /work-orders/:id/todo-items`

| Field | Type | Req | Notes |
|---|---|---|---|
| `workOrderId` | `string (uuid)` | Required | Path param: `WorkOrder.id`. Work order must be in `OPEN` status. |
| `title` | `string` | Required | To-do item title. Max 200 characters. |
| `description` | `string?` | Optional | Extended description. |
| `assignedToRole` | `string?` | Optional | Assigned role (e.g., `HOUSEKEEPING`, `F_AND_B`, `MAINTENANCE`). |
| `assignedToActorId` | `string (uuid)?` | Optional | Specific `StaffUser.id` if directed to an individual. |
| `deadlineAt` | `string (iso-datetime)?` | Optional | Item deadline. Registered with Timer Engine when provided. |

---

**`UpdateToDoItemRequestDTO`**
Route: `PATCH /work-orders/:id/todo-items/:itemId`

| Field | Type | Req | Notes |
|---|---|---|---|
| `workOrderId` | `string (uuid)` | Required | Path param: `WorkOrder.id`. |
| `itemId` | `string (uuid)` | Required | Path param: `WorkOrderToDoItem.id`. |
| `status` | `enum: WorkOrderItemState?` | Optional | Updated status: `IN_PROGRESS` \| `COMPLETED` \| `CANCELLED`. `PENDING` cannot be set via update (items start as `PENDING`). Cancellation requires `ActorLevel.FOM`. |
| `completionEvidence` | `string?` | Optional | Required when `status = COMPLETED`. Max 1000 characters. |
| `cancellationReason` | `string?` | Optional | Required when `status = CANCELLED`. Service rejects cancellation without reason. |
| `assignedToActorId` | `string (uuid)?` | Optional | Reassign to a different actor. |
| `version` | `integer` | Required | Current version of the `WorkOrderToDoItem` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `WorkOrderToDoItemResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `WorkOrderToDoItem` model field addition pending end session.]*

---

#### Response DTOs

**`WorkOrderResponseDTO`**
Used by: `POST /work-orders`, `POST /work-orders/:id/amend`, `POST /work-orders/:id/close`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Work order identifier. |
| `entryId` | `string (uuid)` | Anchoring entry. |
| `title` | `string` | Current title. |
| `description` | `string?` | Description. |
| `status` | `string` | `OPEN` or `CLOSED`. |
| `version` | `integer` | Current version (incremented on each amendment). |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp. |
| `closedBy` | `string (uuid)?` | Closing actor. |
| `closureNote` | `string?` | Closure note. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `createdBy` | `string (uuid)` | Creating actor. |
| `createdAtStage` | `enum: Stage` | Stage at which the work order was created. |
| `version` | `integer` | Current optimistic lock version. Callers must supply this value in write request DTOs for this work order. |

---

**`WorkOrderDetailResponseDTO`**
Used by: `GET /work-orders/:id`

Includes all fields of `WorkOrderResponseDTO` plus:

| Field | Type | Notes |
|---|---|---|
| `toDoItems` | `array: WorkOrderToDoItemResponseDTO` | All to-do items on this work order. |

---

**`WorkOrderToDoItemResponseDTO`**
Used by: `POST /work-orders/:id/todo-items`, `PATCH /work-orders/:id/todo-items/:itemId`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | To-do item identifier. |
| `workOrderId` | `string (uuid)` | Parent work order. |
| `title` | `string` | Item title. |
| `description` | `string?` | Item description. |
| `assignedToRole` | `string?` | Assigned role. |
| `assignedToActorId` | `string (uuid)?` | Assigned specific actor. |
| `deadlineAt` | `string (iso-datetime)?` | Item deadline. |
| `status` | `enum: WorkOrderItemState` | `PENDING` \| `IN_PROGRESS` \| `COMPLETED` \| `CANCELLED`. |
| `completionEvidence` | `string?` | Evidence recorded on completion. |
| `completedAt` | `string (iso-datetime)?` | Completion timestamp. |
| `cancelledAt` | `string (iso-datetime)?` | Cancellation timestamp. |
| `cancellationReason` | `string?` | Recorded cancellation reason. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `version` | `integer` | Current optimistic lock version. Callers must supply this value in `UpdateToDoItemRequestDTO`. |

---

### 10.2.14 Domain Group: Guest Profiles

---

#### Request DTOs

**`CreateGuestProfileRequestDTO`**
Route: `POST /guest-profiles`

| Field | Type | Req | Notes |
|---|---|---|---|
| `firstName` | `string` | Required | Guest first name. Max 100 characters. |
| `lastName` | `string` | Required | Guest last name. Max 100 characters. |
| `email` | `string?` | Optional | Email address. Must be valid email format if present. |
| `phone` | `string?` | Optional | Phone number in international format. |
| `nationality` | `string?` | Optional | Nationality — country code or plain text. |
| `preferences` | `object?` | Optional | Structured preference object (pillow type, dietary requirements, room preferences, etc.). |

Note: Duplicate detection (Policy 12) runs within the service on creation. If a potential duplicate is detected, the service surfaces the match for staff resolution — it does not auto-merge.

---

**`GetGuestProfileRequestDTO`**
Route: `GET /guest-profiles/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `GuestProfile.id`. |

---

**`SearchGuestProfilesRequestDTO`**
Route: `GET /guest-profiles`

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `search` | `string?` | Optional | Free-text search across name and contact fields. Minimum 2 characters. |
| `clientTier` | `string?` | Optional | Filter by client tier. |

---

**`UpdateGuestProfileRequestDTO`**
Route: `PATCH /guest-profiles/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `GuestProfile.id`. |
| `email` | `string?` | Optional | Updated email address. |
| `phone` | `string?` | Optional | Updated phone number. |
| `nationality` | `string?` | Optional | Updated nationality. |
| `preferences` | `object?` | Optional | Updated preferences. The service applies the submitted preferences object as a replacement — not a merge. Callers must submit the full preferences object. |
| `version` | `integer` | Required | Current version of the `GuestProfile` record at time of read. Service rejects the update if the record's current version does not match — throws `ConcurrentEditingError`. Sourced from `GuestProfileResponseDTO.version`. |

*[B4-001 resolved — Candidate A (optimistic locking) locked by Architect. Part 2 `GuestProfile` model field addition pending end session.]*

---

**`TierChangeRequestDTO`**
Route: `POST /guest-profiles/:id/tier-change`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `GuestProfile.id`. |
| `toTier` | `string` | Required | Target client tier (e.g., `STANDARD`, `PREFERRED`, `CAUTION`, `RESTRICTED`). |
| `reason` | `string` | Required | Mandatory reason for the tier change. A tier change is a layered event — the reason is part of the permanent `GuestTierChangeEvent` record. Service rejects absent or empty reason. |

---

**`VerifyIdentityRequestDTO`**
Route: `POST /guest-profiles/:id/verify-identity`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `GuestProfile.id`. |
| `documentType` | `string` | Required | `PASSPORT` \| `NATIONAL_ID` \| `DRIVING_LICENSE` \| `OTHER`. |
| `documentNumber` | `string` | Required | Document number. Max 50 characters. |
| `issuingCountry` | `string?` | Optional | Country code of issuing authority. |
| `expiryDate` | `string (iso-date)?` | Optional | Document expiry date. |
| `capturedBy` | `string (uuid)` | Required | `StaffUser.id` of the staff member capturing the document. |
| `entryId` | `string (uuid)` | Required | The entry at S6 for which verification is being recorded. |

---

#### Response DTOs

**`GuestProfileResponseDTO`**
Used by: `POST /guest-profiles`, `PATCH /guest-profiles/:id`, `POST /guest-profiles/:id/tier-change`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Guest profile identifier. |
| `firstName` | `string` | First name. |
| `lastName` | `string` | Last name. |
| `email` | `string?` | Email address. |
| `phone` | `string?` | Phone number. |
| `nationality` | `string?` | Nationality. |
| `vipTier` | `string?` | VIP tier classification. |
| `clientTier` | `string?` | Operational client tier. |
| `preferences` | `object?` | Preference object. |
| `isActive` | `boolean` | Whether the profile is active. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |
| `updatedAt` | `string (iso-datetime)` | Last update timestamp. |
| `version` | `integer` | Current optimistic lock version. Callers must supply this value in `UpdateGuestProfileRequestDTO`. |

Note: `behaviouralFlags`, `observationQueue`, and `stayHistorySummary` are excluded from this response DTO — these are internal system fields not for general API exposure.

---

**`GuestProfileDetailResponseDTO`**
Used by: `GET /guest-profiles/:id`

Includes all fields of `GuestProfileResponseDTO` plus:

| Field | Type | Notes |
|---|---|---|
| `identityDocuments` | `array` | Identity document summaries: `{ id, documentType, capturedAt, retentionExpiresAt }`. Does not include `documentNumber` — that field is restricted to the verification workflow. |
| `tierChangeEvents` | `array` | Tier change history: `{ id, fromTier, toTier, reason, changedAt, changedBy }`. |

---

**`GuestProfileListResponseDTO`**
Used by: `GET /guest-profiles`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: GuestProfileResponseDTO` | Page of guest profile records. |

---

**`IdentityVerificationResponseDTO`**
Used by: `POST /guest-profiles/:id/verify-identity`

| Field | Type | Notes |
|---|---|---|
| `guestProfileId` | `string (uuid)` | Guest profile. |
| `documentId` | `string (uuid)` | Created `GuestIdentityDocument.id`. |
| `documentType` | `string` | Verified document type. |
| `capturedAt` | `string (iso-datetime)` | Capture timestamp. |
| `capturedBy` | `string (uuid)` | Capturing staff actor. |
| `retentionExpiresAt` | `string (iso-datetime)` | When the document record retention expires per governance configuration. |

Note: `documentNumber` is not included in the response — it is captured and stored but not returned in API responses.

---

### 10.2.15 Domain Group: Night Audit

---

#### Request DTOs

**`RunNightAuditRequestDTO`**
Route: `POST /night-audit/run`

| Field | Type | Req | Notes |
|---|---|---|---|
| `operatingDate` | `string (iso-date)` | Required | The operating date for which the night audit is to be run. Service applies idempotency guard — if a completed audit record already exists for this date, the request exits without re-processing. |

---

**`GetNightAuditRequestDTO`**
Route: `GET /night-audit/:date`

| Field | Type | Req | Notes |
|---|---|---|---|
| `date` | `string (iso-date)` | Required | Path param: the operating date to retrieve. Format `YYYY-MM-DD`. |

---

#### Response DTOs

**`NightAuditResponseDTO`**
Used by: `POST /night-audit/run`

| Field | Type | Notes |
|---|---|---|
| `auditDate` | `string (iso-date)` | Operating date audited. |
| `runStatus` | `enum: NightAuditRunStatus` | `COMPLETE` \| `PARTIAL` \| `FAILED`. |
| `anomalyCount` | `integer` | Number of anomaly records produced. |
| `entriesProcessed` | `integer` | Number of entries successfully processed. |
| `entriesNotProcessed` | `integer` | Number of entries not processed (PARTIAL run). |
| `runCompletedAt` | `string (iso-datetime)` | When the audit run completed. |

---

**`NightAuditDetailResponseDTO`**
Used by: `GET /night-audit/:date`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | `NightAuditRecord.id`. |
| `operatingDate` | `string (iso-date)` | Operating date. |
| `runStatus` | `enum: NightAuditRunStatus` | Run status. |
| `chargeSummary` | `object` | Structured financial summary of charges posted. |
| `occupancySummary` | `object` | Occupancy counts for the operating date. |
| `anomalyCount` | `integer` | Anomaly count. |
| `pointOfFailure` | `string?` | Description of failure point for PARTIAL or FAILED runs. |
| `runCompletedAt` | `string (iso-datetime)` | Completion timestamp. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

### 10.2.16 Domain Group: Incidents and Lost & Found

---

#### Request DTOs

**`CreateIncidentRequestDTO`**
Route: `POST /incidents`

| Field | Type | Req | Notes |
|---|---|---|---|
| `incidentType` | `enum: IncidentType` | Required | `MEDICAL_MINOR` \| `MEDICAL_MAJOR` \| `SECURITY` \| `DEATH` \| `FIRE` \| `OTHER`. |
| `severity` | `enum: IncidentSeverity` | Required | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL`. |
| `location` | `string` | Required | Physical location where incident occurred. Max 200 characters. |
| `entryId` | `string (uuid)?` | Optional | Anchoring entry if the incident is associated with a guest stay. |
| `roomId` | `string (uuid)?` | Optional | Room where the incident occurred. |
| `involvedParties` | `array` | Required | Array of party description objects: `{ role: string, description: string }`. Minimum 1 item. |
| `actionsTaken` | `array` | Required | Array of action records: `{ action: string, actorId?: string (uuid), timestamp: string (iso-datetime) }`. |

---

**`CloseIncidentRequestDTO`**
Route: `POST /incidents/:id/close`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `IncidentRecord.id`. |
| `closureNotes` | `string` | Required | Closure notes. Mandatory. Max 2000 characters. |

---

**`ReportLostFoundRequestDTO`**
Route: `POST /lost-and-found`

| Field | Type | Req | Notes |
|---|---|---|---|
| `description` | `string` | Required | Description of the found item. Max 500 characters. |
| `locationFound` | `string` | Required | Where the item was found. Max 200 characters. |
| `foundAt` | `string (iso-datetime)` | Required | When the item was found. |
| `guestProfileId` | `string (uuid)?` | Optional | Guest profile if the item is attributable to a specific guest. Nullable per model. |
| `entryId` | `string (uuid)?` | Optional | Entry reference if linked to an active or recent stay. Nullable per model. |

---

#### Response DTOs

**`IncidentResponseDTO`**
Used by: `POST /incidents`, `POST /incidents/:id/close`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Incident record identifier. |
| `entryId` | `string (uuid)?` | Anchoring entry. |
| `roomId` | `string (uuid)?` | Affected room. |
| `incidentType` | `enum: IncidentType` | Incident type. |
| `severity` | `enum: IncidentSeverity` | Severity level. |
| `location` | `string` | Incident location. |
| `involvedParties` | `array` | Involved parties. |
| `actionsTaken` | `array` | Actions recorded. |
| `resolutionStatus` | `string` | `OPEN` or `CLOSED`. |
| `reportedAt` | `string (iso-datetime)` | When reported. |
| `reportedBy` | `string (uuid)` | Reporting actor. |
| `closedAt` | `string (iso-datetime)?` | Closure timestamp. |
| `closedBy` | `string (uuid)?` | Closing actor. |
| `closureNotes` | `string?` | Closure notes. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

**`LostFoundResponseDTO`**
Used by: `POST /lost-and-found`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Lost and found record identifier. |
| `description` | `string` | Item description. |
| `locationFound` | `string` | Where found. |
| `foundAt` | `string (iso-datetime)` | When found. |
| `foundBy` | `string (uuid)` | Finding actor. |
| `guestProfileId` | `string (uuid)?` | Linked guest profile. |
| `entryId` | `string (uuid)?` | Linked entry. |
| `returnStatus` | `string` | `HELD` \| `RETURNED` \| `DISPOSED`. |
| `retentionExpiresAt` | `string (iso-datetime)` | Retention expiry per governance configuration. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. |

---

### 10.2.17 Domain Group: Communications

---

#### Request DTOs

**`SendCommunicationRequestDTO`**
Route: `POST /communications`

| Field | Type | Req | Notes |
|---|---|---|---|
| `content` | `string` | Required | Communication content body. Max 5000 characters. |
| `channel` | `enum: CommunicationChannel` | Required | `EMAIL` \| `WHATSAPP`. |
| `entryId` | `string (uuid)?` | Optional | Anchoring entry if communication is linked to a specific engagement. |
| `inquiryId` | `string (uuid)?` | Optional | Anchoring inquiry if at inquiry level (not yet entry-level). |
| `subject` | `string?` | Optional | Subject line for EMAIL channel. Service applies prefix convention (QUOTATION / CONFIRMATION / AMENDED / CANCELLED) automatically. |
| `recipient` | `string` | Required | Email address or WhatsApp contact reference. |
| `aiDraftId` | `string (uuid)?` | Optional | Reference to the `AiDraftRecord.id` if this send follows AI draft approval. If present, the service verifies a `HumanDecisionRecord` with `APPROVE` or `EDIT_AND_APPROVE` decision exists before executing the send. |
| `inReplyToId` | `string (uuid)?` | Optional | `CommunicationRecord.id` this message replies to. |

---

**`InboundCommunicationWebhookDTO`**
Route: `POST /communications/inbound`

Note: This endpoint uses webhook HMAC signature validation, not staff PIN authentication. The HMAC signature is validated by a dedicated webhook middleware before the controller handler executes.

| Field | Type | Req | Notes |
|---|---|---|---|
| `channel` | `enum: CommunicationChannel` | Required | Channel from which the inbound message arrived. |
| `messageType` | `enum: MessageType` | Required | `STANDARD` \| `VOICE_NOTE`. |
| `rawPayload` | `object` | Required | Channel-specific raw payload from the channel provider (SES delivery notification, WhatsApp webhook body). Structured per channel provider format. |
| `messageId` | `string?` | Optional | External message ID from the channel provider, if available. |
| `threadId` | `string?` | Optional | Thread or conversation identifier from the channel provider. |

---

**`SupersedeCommunicationRequestDTO`**
Route: `POST /communications/:id/supersede`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `CommunicationRecord.id`. |
| `reason` | `string` | Required | Mandatory reason for supersession. Service rejects absent or empty reason. |
| `sendInvalidationNotification` | `boolean` | Required | Whether to send an invalidation notification to the original recipient. If `false`, the reason is recorded as the explicit decline of the notification. |

---

#### Response DTOs

**`CommunicationRecordResponseDTO`**
Used by: `POST /communications`, `POST /communications/:id/supersede`

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Communication record identifier. |
| `entryId` | `string (uuid)?` | Anchoring entry. |
| `inquiryId` | `string (uuid)?` | Anchoring inquiry. |
| `channel` | `enum: CommunicationChannel` | Communication channel. |
| `messageType` | `enum: MessageType` | Message type. |
| `contentSummary` | `string` | Content summary — not full content. |
| `sendStatus` | `enum: SendStatus` | Outbound send status. |
| `acknowledgementStatus` | `enum: AcknowledgementStatus` | Acknowledgement tracking status. |
| `direction` | `string` | `INBOUND` or `OUTBOUND`. |
| `isSuperseded` | `boolean` | Whether this record has been superseded. |
| `createdAt` | `string (iso-datetime)` | Creation timestamp. Immutable from creation. |
| `actorId` | `string (uuid)` | Actor who created the communication record. |

---

**`WebhookAcknowledgementResponseDTO`**
Used by: `POST /communications/inbound`

| Field | Type | Notes |
|---|---|---|
| `received` | `boolean` | Always `true` on successful receipt. |
| `messageId` | `string?` | Internal message identifier assigned. |
| `processedAt` | `string (iso-datetime)` | When the inbound message was processed. |

---

### 10.2.18 Domain Group: Processing Locks

*(ToC mandatory additions: `ProcessingLockPlaceDTO`, `ProcessingLockReconfirmDTO`, `ProcessingLockStatusResponseDTO` — defined here under Part 9 naming convention. See §10.1.2 for name mapping.)*

---

#### Request DTOs

**`PlaceProcessingLockRequestDTO`**
Route: `POST /processing-locks`
*(Maps to ToC `ProcessingLockPlaceDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `inventoryReference` | `string (uuid)` | Required | `Room.id` or `Space.id` of the inventory being locked. |
| `channel` | `string` | Required | Channel processor placing the lock: `EMAIL_AI` \| `WHATSAPP_AI` \| `FRONT_DESK` \| `PHONE`. |
| `entryContext` | `object?` | Optional | Context linking this lock to an active entry workflow: `{ entryId: string (uuid), segmentId?: string (uuid) }`. |

Note: If a prior lock exists on the same inventory configuration, the service places the new lock and returns `200 OK` with a `meta.priorityNotice` field informing the caller that another actor holds a prior lock. The second actor is not blocked.

---

**`ReconfirmProcessingLockRequestDTO`**
Route: `POST /processing-locks/:id/reconfirm`
*(Maps to ToC `ProcessingLockReconfirmDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: the EXPIRED `ProcessingLockRecord.id`. The record must be in `EXPIRED` status — reconfirmation of an `ACTIVE` or `RELEASED` lock is rejected with `StateTransitionError`. |

Note: Reconfirmation creates a new `ProcessingLockRecord`. The expired record is preserved. The response includes the new lock record and a `revalidationDelta` showing what changed during the TTL window.

---

**`GetProcessingLockRequestDTO`**
Route: `GET /processing-locks/:id`

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `ProcessingLockRecord.id`. |

---

#### Response DTOs

**`ProcessingLockResponseDTO`**
Used by: `POST /processing-locks`, `GET /processing-locks/:id`
*(Maps to ToC `ProcessingLockStatusResponseDTO` for the GET endpoint)*

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | Processing lock record identifier. |
| `actorId` | `string (uuid)` | Actor who placed the lock. |
| `channel` | `string` | Channel processor. |
| `inventoryReference` | `string (uuid)` | Locked inventory identifier. |
| `placedAt` | `string (iso-datetime)` | When the lock was placed. |
| `ttlSeconds` | `integer` | TTL of this lock in seconds (from configuration). |
| `expiresAt` | `string (iso-datetime)` | Hard expiry time. No heartbeat or renewal. |
| `status` | `enum: ProcessingLockStatus` | `ACTIVE` \| `EXPIRED` \| `RELEASED`. |
| `expiredAt` | `string (iso-datetime)?` | When the lock expired. |
| `releasedAt` | `string (iso-datetime)?` | When the lock was released (booking completed before TTL). |
| `revalidationCount` | `integer` | Number of reconfirmations. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

**`ProcessingLockReconfirmResponseDTO`**
Used by: `POST /processing-locks/:id/reconfirm`

| Field | Type | Notes |
|---|---|---|
| `newLock` | `object: ProcessingLockResponseDTO` | The newly created lock record. |
| `previousLockId` | `string (uuid)` | The expired lock record's ID (preserved, not deleted). |
| `revalidationDelta` | `object` | What changed during the TTL window: `{ availabilityChanged: boolean, pricingChanged: boolean, deficientStatusChanged: boolean, details: object }`. |

---

### 10.2.19 Domain Group: AI Agent — Draft Management

*(ToC mandatory additions: `AIDraftReviewQueueItemDTO`, `AIDraftDecisionDTO`, `HumanDecisionRecordResponseDTO` — defined here under Part 9 naming convention. See §10.1.2 for name mapping.)*

---

#### Request DTOs

**`ListAiDraftsRequestDTO`**
Route: `GET /ai-drafts`

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `status` | `enum: AiDraftStatus?` | Optional | Filter by draft status. Defaults to `PENDING_REVIEW` when absent. FOM may pass `APPROVED` or `REJECTED` for audit inspection. |

---

**`ApproveDraftRequestDTO`**
Route: `POST /ai-drafts/:id/approve`
*(One of three request DTOs that together map to ToC `AIDraftDecisionDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AiDraftRecord.id`. Must be in `PENDING_REVIEW` status. |

Note: The approval action carries no body fields — the path param alone identifies the draft. The service enforces that the calling actor is a human actor (not the AI system actor). The `HumanDecisionRecord` is created with `decisionType = APPROVE`.

---

**`EditAndApproveDraftRequestDTO`**
Route: `POST /ai-drafts/:id/edit-and-approve`
*(One of three request DTOs that together map to ToC `AIDraftDecisionDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AiDraftRecord.id`. Must be in `PENDING_REVIEW` status. |
| `editedContent` | `string` | Required | The human-edited content to send. Mandatory. Service rejects absent or empty value. Stored in `HumanDecisionRecord.finalContent` — this is the content actually sent. |
| `reason` | `string` | Required | Reason for the edit. Mandatory. Service rejects absent or empty value. A `CorrectionRecord` is created if the edit changes the intent category interpretation. |

---

**`RejectDraftRequestDTO`**
Route: `POST /ai-drafts/:id/reject`
*(One of three request DTOs that together map to ToC `AIDraftDecisionDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `AiDraftRecord.id`. Must be in `PENDING_REVIEW` status. |
| `reason` | `string` | Required | Rejection reason. Mandatory. Service rejects absent or empty value. After rejection, the human handles the response manually. No outbound communication is sent by the system. |

---

#### Response DTOs

**`AiDraftListResponseDTO`**
Used by: `GET /ai-drafts`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: AiDraftReviewQueueItemDTO` | Page of AI draft records awaiting review. |

---

**`AiDraftReviewQueueItemDTO`**
*(ToC mandatory addition: `AIDraftReviewQueueItemDTO` — the single-item shape within the list response and as the sub-DTO within decision responses)*

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | `AiDraftRecord.id`. |
| `inboundMessageId` | `string (uuid)` | The `CommunicationRecord.id` of the inbound message that triggered this draft. |
| `intentCategory` | `string` | Classified intent category from the AI agent. |
| `confidenceScore` | `decimal` | AI confidence score (0.0000–1.0000). |
| `draftContent` | `string` | The AI-generated draft content for human review. |
| `status` | `enum: AiDraftStatus` | `PENDING_REVIEW` \| `APPROVED` \| `EDITED_AND_APPROVED` \| `REJECTED`. |
| `reviewTtlExpiresAt` | `string (iso-datetime)` | When the review TTL fires (FOM notification threshold). Draft is not auto-approved or auto-rejected on TTL expiry — only escalated. |
| `entryId` | `string (uuid)?` | Linked entry if the inbound message was associated with an entry. |
| `createdAt` | `string (iso-datetime)` | When the draft was created. |

---

**`AiDraftDecisionResponseDTO`**
Used by: `POST /ai-drafts/:id/approve`, `POST /ai-drafts/:id/edit-and-approve`, `POST /ai-drafts/:id/reject`

| Field | Type | Notes |
|---|---|---|
| `draftId` | `string (uuid)` | The `AiDraftRecord.id` the decision was made on. |
| `decision` | `enum: HumanDecisionType` | `APPROVE` \| `EDIT_AND_APPROVE` \| `REJECT`. |
| `actorId` | `string (uuid)` | Human actor who made the decision. |
| `decidedAt` | `string (iso-datetime)` | Decision timestamp. |
| `humanDecision` | `object: HumanDecisionRecordResponseDTO` | The immutable `HumanDecisionRecord` created. |

---

**`HumanDecisionRecordResponseDTO`**
*(ToC mandatory addition: `HumanDecisionRecordResponseDTO` — included inline in `AiDraftDecisionResponseDTO` and available as a standalone shape)*

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | `HumanDecisionRecord.id`. Immutable from creation. |
| `aiDraftId` | `string (uuid)` | The draft this decision references. |
| `actorId` | `string (uuid)` | Human actor — never the AI system actor. |
| `decisionType` | `enum: HumanDecisionType` | `APPROVE` \| `EDIT_AND_APPROVE` \| `REJECT`. |
| `reason` | `string?` | Present on `EDIT_AND_APPROVE` and `REJECT`. Null on `APPROVE`. |
| `finalContent` | `string?` | The edited content actually sent. Present only on `EDIT_AND_APPROVE`. Null on `APPROVE` and `REJECT`. |
| `decidedAt` | `string (iso-datetime)` | When the human decision was made. |
| `createdAt` | `string (iso-datetime)` | Record creation timestamp. |

---

### 10.2.20 Domain Group: Voice Notes

*(ToC mandatory addition: `StaffListeningSummaryCreateDTO` — defined here as `StaffListeningSummaryRequestDTO` under Part 9 naming convention. See §10.1.2 for name mapping.)*

---

#### Request DTOs

**`ListUnprocessedVoiceNotesRequestDTO`**
Route: `GET /voice-notes/unprocessed`

| Field | Type | Req | Notes |
|---|---|---|---|
| `cursor` | `string?` | Optional | Pagination cursor. |
| `limit` | `integer?` | Optional | Default 20, max 100. |
| `entryId` | `string (uuid)?` | Optional | Filter to voice notes linked to a specific entry. |
| `slaBreachOnly` | `boolean?` | Optional | When `true`, returns only records where `voiceNoteSlaBreach = true` (FOM priority queue). |

---

**`StaffListeningSummaryRequestDTO`**
Route: `POST /voice-notes/:id/summary`
*(Maps to ToC `StaffListeningSummaryCreateDTO`)*

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | `string (uuid)` | Required | Path param: `CommunicationRecord.id` of the `VOICE_NOTE` record. Must have `VOICE_NOTE_UNPROCESSED` status. |
| `callerIntent` | `string` | Required | Structured summary of the caller's intent. Mandatory per Policy 76. Service rejects absent or empty value. |
| `commitmentsMentioned` | `string` | Required | Any commitments or promises mentioned in the voice note. Mandatory. If none, must explicitly state "None". |
| `datesAndNumbers` | `string` | Required | Dates, numbers, and quantities mentioned. Mandatory. If none, must explicitly state "None". |
| `languageUsed` | `string` | Required | Language of the voice note (e.g., `DZONGKHA`, `ENGLISH`, `HINDI`, `OTHER`). Mandatory. |
| `noActionRequired` | `boolean` | Required | Whether the voice note requires any follow-up action. If `true`, `noActionReason` is required. |
| `noActionReason` | `string?` | Optional | Required when `noActionRequired = true`. |
| `actionItems` | `array?` | Optional | Array of action item strings derived from the voice note. Each item: `string`, max 500 characters. Required when `noActionRequired = false`. |

Note: A summary submission without all required structured fields (`callerIntent`, `commitmentsMentioned`, `datesAndNumbers`, `languageUsed`) is rejected with `PolicyViolationError`. A status-only update without a logged summary is rejected.

---

#### Response DTOs

**`VoiceNoteListResponseDTO`**
Used by: `GET /voice-notes/unprocessed`

| Field | Type | Notes |
|---|---|---|
| `items` | `array: VoiceNoteItemDTO` | Page of unprocessed voice note records. |

---

**`VoiceNoteItemDTO`**
*(Sub-DTO for the voice note list response)*

| Field | Type | Notes |
|---|---|---|
| `id` | `string (uuid)` | `CommunicationRecord.id`. |
| `entryId` | `string (uuid)?` | Linked entry. |
| `channel` | `enum: CommunicationChannel` | Channel of receipt (`EMAIL` or `WHATSAPP`). |
| `contentSummary` | `string` | Brief summary of the communication record. |
| `voiceNoteSlaBreach` | `boolean` | Whether the SLA has been breached for this voice note. |
| `voiceNoteFomEscalated` | `boolean` | Whether FOM escalation has been triggered. |
| `createdAt` | `string (iso-datetime)` | When the voice note was received. |
| `actorId` | `string (uuid)` | Actor who received (routed) the voice note. |

---

**`VoiceNoteReviewResponseDTO`**
Used by: `POST /voice-notes/:id/summary`

| Field | Type | Notes |
|---|---|---|
| `communicationRecordId` | `string (uuid)` | The voice note `CommunicationRecord.id`. |
| `summaryId` | `string (uuid)` | Created `StaffListeningSummaryRecord.id`. |
| `reviewedAt` | `string (iso-datetime)` | When the review was completed. |
| `reviewedBy` | `string (uuid)` | Staff actor who completed the review. |
| `callerIntent` | `string` | Recorded caller intent. |
| `actionItems` | `array: string` | Recorded action items. |

---

## Appendix A — Category 1 Clarification Requests (Gate 10)

| ID | Section | Item | Status |
|---|---|---|---|
| NAMING-001 | §10.1.2 | **DTO naming convention conflict — CLOSED.** Architect locked Option B (retain Part 9 convention: `{Action}{Entity}RequestDTO` / `{Entity}ResponseDTO`). No amendment pass required. Parts 9 and 10 are consistent as written. ToC naming examples were illustrative — not a formally locked standard. | **Closed — MOM-ARCH-2026-016 session.** |
| B4-001 | Multiple §10.2 sections | **Concurrent editing mechanism — CLOSED (Part 10 portion).** Architect locked Candidate A (optimistic locking). `version: integer` field added to six request DTOs and four response DTOs in this part. Remaining actions in end session: (1) Part 2 — add `version Int @default(1)` to `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem` models (`WorkOrder` already carries this field); (2) Part 9 §9.2.3 — complete the blocked mechanism section with the Prisma `where` clause pattern and `ConcurrentEditingError` throwing condition. | **Part 10 closed. Parts 2 and 9 pending end session.** |

---

## Appendix B — Open Items Not Actioned at Gate 10

| Item | Status |
|---|---|
| B9-001 — Amendment routing algorithm (Path 1/2/3 classification) | Resolved in MOM-ARCH-2026-015 (Model C hybrid). Applied in Part 6 §6.6.2 and `AmendmentRequestDTO` §10.2.8. No further Gate 10 action required. |
| B9-003 — S9-equivalent processing for cancelled entries | Not a Gate 10 concern. No DTO exposes this path directly. |
| B2-005, B9-005 — AWAITING_WRITTEN_CONFIRMATION completeness | Not a Gate 10 concern. No DTO field depends on this sub-state. |
| B3-001 — QUOTED displacement threshold | Not a Gate 10 concern. |
| B11-001 — Commission-due guard at CLOSED | Not a Gate 10 concern. |

---

## Backfill Registry — Carry-Forward Items

### Doctrine

All backfill items are deferred to a single coordinated backfill session after all gates are complete. No gate is re-opened mid-sequence to action a backfill item. Backfill items are classified as:

- **Category A — Non-blocking.** Additions or corrections to already-written parts that no subsequent gate derives from.
- **Category B — Blocking.** Gaps that a subsequent gate actively derives from.

---

### Item Register

| # | Category | Target | Location | Change Required | Downstream Impact |
|---|---|---|---|---|---|
| P4 | A — Non-blocking | DEV-SPEC-001-Part2.md | §2.17.3 | Add configuration key: `ai.correctionLog.maximumSize` / All stages / Integer / Maximum number of correction log entries analysed per aggregation cycle for AI confidence threshold tuning | None. No gate derives from this field. No verification pass required. |
| P5 | B — Blocking | DEV-SPEC-001-Part6.md | §6.5 | Write missing stage-specific domain service sections for: `QuotationService`, `HoldService`, `PaymentService`, `PreArrivalService`, `CheckInService`, `CheckOutService`, `RoomAssignmentService`, `DuplicateDetectionService`. Backfill session Step 1. | Gates 10 DTOs affected: `CreateQuotationRequestDTO`, `SendQuotationRequestDTO`, `AcceptQuotationRequestDTO`, `QuotationResponseDTO`, `PlaceSpeculativeHoldRequestDTO`, `PlaceCommittedHoldRequestDTO`, `SpeculativeHoldResponseDTO`, `CommittedHoldResponseDTO` — all carry P5 flags. Verification pass at backfill Step 3 removes flags and confirms or corrects field definitions against the written Part 6 sections. |
| B4-001 | B — **Part 10 DONE. Parts 2 and 9 pending.** | Part 9 §9.2.3; Part 2 four models | Optimistic locking mechanism — Architect locked Candidate A | (1) Part 2: add `version Int @default(1)` to `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem` (`WorkOrder` field already exists). (2) Part 9 §9.2.3: write the complete concurrent editing middleware section with Prisma `where` clause pattern and `ConcurrentEditingError` throwing condition. Part 10 `version` fields already applied. | Part 2 and Part 9 §9.2.3 only. Gate 11 not affected. |
| NAMING-001 | **CLOSED** | N/A | N/A | No action required. Architect locked Option B (Part 9 convention). Parts 9 and 10 consistent as written. | None. |

---

### Backfill Session Execution Order

All items are actioned in a single coordinated session after all gates are complete:

```
Step 1 — P5: Write missing Part 6 service sections
          Declared sources: Canon Blocks 5–8
          Output: eight new §6.5.X sections appended to Part 6
                    ↓
Step 2 — Part 9 verification pass
          Load new Part 6 sections.
          Confirm route entries in §9.4 against new service contracts.
          Expected outcome: no structural changes to Part 9 routes.
                    ↓
Step 3 — Part 10 verification pass
          Load new Part 6 sections.
          Remove P5 flags from affected DTOs.
          Confirm or correct field definitions against written service contracts.
                    ↓
Step 4 — B4-001 (remaining): Part 2 and Part 9 §9.2.3
          Part 2: add version Int @default(1) to Entry, GuestProfile,
          Quotation, WorkOrderToDoItem models.
          Part 9 §9.2.3: complete the blocked mechanism section.
          Part 10 version fields already applied — no action required here.
                    ↓
Step 5 — P4: Add config key to Part 2 §2.17.3
          Trivial addition. No verification pass required.

NAMING-001: Closed. No action required.
```

---

*End of DEV-SPEC-001-Part10.md*
*Gate 10 — DTOs*
*Prepared by: Claude (AI Architectural Partner)*
*Date: 08 April 2026*
*Authority: MOM-ARCH-2026-016*
*Status: DRAFT — nothing is locked until Architect confirms*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
