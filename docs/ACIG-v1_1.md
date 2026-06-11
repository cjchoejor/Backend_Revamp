# LEGPHEL PMS — Admin Console Implementation Guideline
## ACIG v1.1

| Attribute | Value |
|---|---|
| Document | ACIG (Admin Console Implementation Guideline) |
| Version | 1.1 |
| Date | 28 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Derives from | DEV-SPEC-001 Parts 0, 2, 3, 4, 5, 6, 8, 9, 12, 13; ACTOR-AUTHORITY-MATRIX-LOCKED; MCL v2.3 |
| Paired with | SIGs S1–S9 (read-side counterparts) |
| Supersedes | ACIG v1.0 |
| Revision summary | v1.1 closes structural gaps surfaced in v1.0 review: missing schemas for `HotelProfile`, `Department`, `AiActorIdentity`, `RolePermissionMapping`, `ModeConfiguration`, and `RoleSessionConfig` are added with field-level definitions derived from DEV-SPEC-001 Part 12 §12.2; `PolicyRegistry` constraint corrected to `@@unique([policyId, version])`; optimistic locking `version` field added to seven registry models (resolves B4-001 at the ACIG layer); mode lifecycle state field defined; session management surface restructured from four FOM/FrontDesk-only dotted keys to a per-role surface covering all defined roles with manual-lock availability; AC-S-1 expanded to cover all admin-owned models; A1 forbidden-patterns list carves out the `agent-profiles` exception explicitly; six-vs-seven principle count corrected; new schema findings (ACIG-COR-055 through ACIG-COR-061) registered. |

---

## Section 1 — Surface Identity

### 1.1 Surface Name

**Admin Console** — the configuration authority surface of the LEGPHEL PMS. The name is canonical. No synonym is introduced.

### 1.2 Architectural Position

The Admin Console is an off-axis governance surface. It is not a stage in the nine-stage operational lifecycle (S1–S9). It governs the rules under which operational stages execute. Stages read configuration at runtime; they never write to it. The Admin Console writes configuration; it never creates, updates, or closes operational records.

The Admin Console operates outside the S1–S9 state machine. It has no stage gate, no stage progression, no stage charter. Its lifecycle is configuration-temporal (see Section 3), not stage-sequential.

### 1.3 Authority Model

Every admin write path is guarded by L4 authority. The L4 actor is the General Manager or a designated administrator operating through the Admin Console surface.

- **Write authority (all admin surfaces):** L4 only. L1 (Front Desk / Reservations), L2 (FOM), and L3 (GM operating in the operational workflow) cannot invoke any admin write service or admin write route. The middleware-layer rejection is returned as `AuthorizationError` (HTTP 403) — not a generic 401 — so the caller's authority level is recorded.
- **Read authority (audit visibility surfaces):** A subset of admin read paths may extend to actors below L4 per the role-permission mapping. The permitted read surfaces are: audit event listings scoped to records the caller has operational visibility into; the caller's own session events; the readiness status summary. All other admin reads are L4-only.
- **Mode activation — custom modes:** L4 (GM) specifically. A custom mode cannot be activated by any other actor, even one otherwise authorised to save mode configurations. This is a hard requirement, not a configurable one.

The L4 designation is neither a UI access-control list nor a convenience. It is an architectural constraint woven through every admin service, every admin middleware, and every admin route.

### 1.4 Entry and Session Model

- Entry to the Admin Console requires a fully authenticated L4 session. PIN-session validation from the operational authentication middleware applies identically — the admin surface does not introduce a parallel authentication mechanism.
- Admin session configuration (idle auto-lock timeout, hard logout timeout, manual lock availability) follows the session management configuration saved for the L4 role via `RoleSessionConfig` (§2.1A.5). An administrator's Admin Console session locks and expires on the same rules that govern any role's session. Manual lock availability is a boolean control flag (whether the role's UI exposes a one-tap manual-lock button), not a duration threshold.
- Admin sessions are individually attributed. Every admin action carries the `actorId` of the specific administrator who performed it. Credential sharing is prevented structurally; there is no shared admin account.

### 1.5 Single-Tenant Namespace

One deployment serves one property. One deployment has one configuration namespace. The Admin Console manages configuration for the single hotel at which the system is deployed. No admin table carries a tenant identifier. No admin query carries a tenant partition filter. No admin surface presents a property selector or a tenant selector to the administrator.

Multi-property deployment is not a current requirement. No architectural decision made in this guideline structurally precludes multi-property as a future formally scoped extension, but no multi-tenancy scaffolding is built now.

### 1.6 Scope Boundary

The Admin Console **configures**. It does not **operate**.

The Admin Console writes to configuration tables. Operational stages read from configuration tables at runtime. These two directions of motion define a hard boundary. Any admin code path that creates, updates, closes, or otherwise writes to an operational entity is a structural violation regardless of the business justification offered. Operational entities include, without limitation:

- Inquiry, Entry, Segment
- Quotation, SpeculativeHold, CommittedHold, Reservation
- Folio, Invoice, PaymentRecord, CreditNote, CommercialAdjustmentEntry
- WorkOrder, WorkOrderToDoItem
- HandoffRecord, CommunicationRecord
- DisputeRecord, ServiceRecoveryRecord, IncidentRecord
- RoomAssignment, PreArrivalTask
- NightAuditRecord, NoShowDeterminationRecord
- ProcessingLockRecord, AiDraftRecord, VoiceNoteRecord
- Any record whose creating service resides outside the admin service layer

### 1.7 Scope Exclusions

The following are explicitly outside the scope of this guideline and of the Admin Console surface it specifies:

1. **Multi-property / multi-tenant deployment.** Single-tenant is locked. Extending the Admin Console to manage multiple properties is a formally scoped architectural extension requiring its own decision process and its own implementation guideline.

2. **Staff training and onboarding flows.** Staff registry CRUD (creating staff records, assigning roles, setting PINs, deactivating departed staff) is in scope. Interactive training curricula, onboarding checklists, learning management functionality, and related operator development surfaces are not. Those are a separate product concern, not a configuration authority concern.

3. **Admin Console analytics and dashboards beyond audit visibility.** The admin surface exposes configuration change logs, session event logs, audit trail queries, and readiness status. It does not expose operational KPI dashboards, revenue analytics, occupancy trend dashboards, or forecasting surfaces. Those are reporting outputs sourced from governed operational data and are built elsewhere in the system.

A requirement that would extend the Admin Console into any of these three areas is a scope-extension decision, not an implementation task within this guideline.

### 1.8 What This Guideline Does Not Do

- It does not re-specify operational state machines, operational policies, operational engines, or operational services. Those specifications reside in Parts 3, 5, 4, and 6 respectively and in the SIGs S1–S9 that derive from them.
- It does not introduce new Canon obligations. It realises the Admin Console obligations already stated in the system specification layer.
- It does not reference Canon sections, foundational architecture principles, or source document numbers. Every obligation is recast as an implementation requirement.
- It does not depend on any PENDING MCL item. All source gaps affecting the Admin Console surface are absorbed as positive assertions in this document. Derived services and route groups are registered in the Findings Register at the end.

### 1.9 Enum and Type Cross-Reference

The Prisma schemas in Section 2 reference several enum types defined in DEV-SPEC-001 Part 2 §2.0. These enums are not redefined here; the implementation must import them from the same enum module Part 2 declares. The cross-reference is:

| Enum | Defined in | Used by ACIG schema |
|---|---|---|
| `Stage` | DEV-SPEC-001 Part 2 §2.0 | `CommunicationTemplate.stage` |
| `ActorLevel` | DEV-SPEC-001 Part 2 §2.0 | `Role.actorLevel`, `AiActorIdentity.actorType`, `VipNotificationRoutingConfig.notifyRoles` (array values) |
| `EntryUseType` | DEV-SPEC-001 Part 2 §2.0 | `WorkOrderTemplate.useType` |
| `DeficientConditionCategory` | DEV-SPEC-001 Part 2 §2.0 | Underlying enum for `deficientCondition.categories` config-key values |
| `InvoiceType` | DEV-SPEC-001 Part 2 §2.0 | `InvoiceTemplate.invoiceType` |
| `HandoffType` | DEV-SPEC-001 Part 2 §2.0 | `HandoffChecklistTemplate.handoffType` |
| `CommunicationChannel` | DEV-SPEC-001 Part 2 §2.0 | `CommunicationTemplate.channel` |
| `ModeLifecycleState` | ACIG §2.1A.7 | `ModeConfiguration.lifecycleState` (defined in this guideline; absent from Part 2) |

The enum `ModeLifecycleState` is the only enum defined in the ACIG itself; it is registered as part of finding ACIG-COR-060 for absorption into Part 2 §2.0. All other enums must resolve at compile time to the Part 2 declaration.

---

## Section 2 — Schema Models

This section enumerates every Prisma model the Admin Console reads or writes, plus the full set of keyed configuration entries managed through `ConfigurationEntry`. Operational models are referenced only where they are read by the Admin Console for validation purposes (e.g., checking whether a department can be deactivated); no admin surface writes to operational models.

### 2.1 Configuration and Policy Registry Models

#### 2.1.1 `ConfigurationEntry`

```prisma
model ConfigurationEntry {
  id              String    @id @default(uuid())
  configKey       String    // canonical configuration key (dotted notation)
  configValue     Json      // structured value — type depends on configKey
  effectiveFrom   DateTime
  effectiveTo     DateTime? // null = currently active
  setBy           String    // actor_id — L4 required — NOT NULL
  setAt           DateTime
  notes           String?
  createdAt       DateTime  @default(now())

  @@index([configKey, effectiveFrom])
  @@map("configuration_entries")
}
```

**Mutation rule — absolute.** A `ConfigurationEntry` row is never edited in place. When configuration for a given `configKey` changes, a new row is created with the new value and a new `effectiveFrom`. The prior row's `effectiveTo` is set to the new row's `effectiveFrom` in the same transaction. The prior row is thereby superseded, not modified. Historical rows remain queryable for temporal audit (the `ConfigurationService` `getActiveAt(key, asOf)` method executes against the `effectiveFrom`/`effectiveTo` window).

**Field notes:**
- `configKey` — dotted notation throughout (e.g., `advancePayment.thresholds`, `session.idle.fom.thresholdSeconds`). Flat key names are not permitted.
- `configValue` — typed at the application layer per `configKey`; Prisma stores it as `Json`. Validation of value shape is performed by the owning admin service before write.
- `setBy` — NOT NULL. The actor who authored this entry. Always an L4 staff member.
- `effectiveTo` — NULL while this entry is the active value; set at supersession.

#### 2.1.2 `PolicyRegistry`

```prisma
model PolicyRegistry {
  id                String    @id @default(uuid())
  policyId          String    // canonical policy identifier — repeatable across versions
  policyClass       String    // canonical policy class name
  policyDefinition  Json      // structured policy parameters
  version           Int       @default(1)
  effectiveFrom     DateTime
  isActive          Boolean   @default(true)
  createdBy         String    // actor_id — L4 required — NOT NULL
  createdAt         DateTime  @default(now())

  @@unique([policyId, version])
  @@map("policy_registry")
}
```

**Mutation rule.** `PolicyRegistry` entries carry a `version`. The constraint `@@unique([policyId, version])` permits multiple rows per `policyId` distinguished by `version`. Two write operations on a `PolicyRegistry` row are permitted: (1) **supersession** — when a policy's parameters change, a new row is created with `version` incremented and a new `effectiveFrom`, and the prior row's `isActive` is set to `false` in the same transaction; (2) **lifecycle status flip** — `isActive` may be transitioned from `true` to `false` for the purpose of deactivation without supersession. No other in-place edit of any field is permitted. The `policyDefinition`, `policyClass`, `policyId`, `version`, `effectiveFrom`, and `createdBy` fields are immutable from creation.

### 2.1A Identity, Personnel, Authentication, and Mode Configuration Models

The following Prisma models are admin-owned configuration tables required by the services in Section 6 but not previously defined at the schema level. Field-level definitions are derived directly from DEV-SPEC-001 Part 12 §12.2.1, §12.2.2, and §12.2.5 implementation requirements.

#### 2.1A.1 `HotelProfile`

```prisma
model HotelProfile {
  id                  String    @id @default(uuid())
  hotelName           String
  registeredAddress   String
  tradingAddress      String?   // null when same as registeredAddress
  contactNumbers      Json      // array of { label, number, type }
  primaryEmail        String
  operatingHours      Json      // per day-of-week: { dayOfWeek, openTime, closeTime } — HH:MM 24h
  publicHolidaySchedule Json    // array of { date, label }
  timeZone            String    // IANA timezone identifier (e.g., "Asia/Thimphu")
  propertyCurrency    String    // ISO 4217 currency code (e.g., "BTN", "USD")
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  createdBy           String    // L4 actor — NOT NULL

  @@map("hotel_profile")
}
```

**Cardinality rule.** Exactly one `HotelProfile` row exists in any operational deployment. The `HotelProfileService` enforces this — `createHotelProfile` is not exposed; only `getHotelProfile()` and `updateHotelProfile()`. The single row is seeded at deployment.

**Validation rules at save time.** `hotelName` non-empty; `registeredAddress` non-empty; `primaryEmail` passes RFC 5321 format check; `timeZone` is a valid IANA identifier; `propertyCurrency` is a valid ISO 4217 code; every `operatingHours` entry has a recognised `dayOfWeek` and `openTime < closeTime` (or both null for closed days).

#### 2.1A.2 `Department`

```prisma
model Department {
  id                  String    @id @default(uuid())
  departmentCode      String    @unique
  departmentName      String
  isActive            Boolean   @default(true)
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  createdBy           String    // L4 actor — NOT NULL

  @@map("departments")
}
```

**Deactivation rule.** A `Department` row may not be deleted if any active `StaffUser` references it via `departmentId` or any open `WorkOrder` references it via routing fields. Deactivation (`isActive = false`) is permitted; deletion is not. The precondition check reads `StaffUser` and `WorkOrder` in read-only mode — operational reads for configuration integrity checks are not operational writes (per §6.4).

**Reactivation guard.** A deactivated `Department` may be reactivated only if no other active `Department` carries the same `departmentCode`.

#### 2.1A.3 `Role`

```prisma
model Role {
  id                  String    @id @default(uuid())
  roleCode            String    @unique // e.g., "L1_FRONT_DESK", "L2_FOM", "L3_GM_OPERATIONAL", "L4_GM_ADMIN"
  roleName            String
  actorLevel          ActorLevel
  isPredefined        Boolean   @default(true)  // true for system-defined roles; false for any future custom-defined role
  isActive            Boolean   @default(true)
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  createdBy           String    // L4 actor — NOT NULL — 'SYSTEM_SEED' for predefined roles

  permissionMappings  RolePermissionMapping[]
  sessionConfig       RoleSessionConfig?

  @@map("roles")
}
```

**Mutation rule.** Predefined roles (`isPredefined = true`) are seeded at deployment; their `roleCode`, `roleName`, and `actorLevel` are immutable. Their permission set is mutable through `RolePermissionMapping` updates. Predefined roles cannot be deleted or deactivated. Any future custom roles are out of scope for v1.0 admin operations and will be addressed in a formally scoped extension.

#### 2.1A.4 `RolePermissionMapping`

```prisma
model RolePermissionMapping {
  id                  String    @id @default(uuid())
  roleId              String
  permissionKey       String    // canonical permission identifier from the system permission catalogue
  isGranted           Boolean   @default(true)
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  createdBy           String    // L4 actor — NOT NULL

  role                Role      @relation(fields: [roleId], references: [id])

  @@unique([roleId, permissionKey])
  @@map("role_permission_mappings")
}
```

**Save validation.** `RoleService.updateRolePermissions()` performs `RequiredControlCheck` to confirm that, after the proposed change, every required operational action (per the system permission catalogue) is covered by at least one active role. A change that would orphan a required action is rejected with `ConfigurationViolationError` per Policy A5.

#### 2.1A.5 `RoleSessionConfig`

```prisma
model RoleSessionConfig {
  id                          String    @id @default(uuid())
  roleId                      String    @unique  // one config per role
  idleLockTimeoutSeconds      Int                // period of inactivity before terminal locks (PIN re-entry required)
  hardLogoutTimeoutSeconds    Int                // period after which session is fully terminated (full re-auth required)
  manualLockAvailable         Boolean   @default(true) // whether the role's UI exposes a one-tap manual lock control
  version                     Int       @default(1)
  createdAt                   DateTime  @default(now())
  updatedAt                   DateTime  @updatedAt
  createdBy                   String    // L4 actor — NOT NULL

  role                        Role      @relation(fields: [roleId], references: [id])

  @@map("role_session_configs")
}
```

**Save validation.** `idleLockTimeoutSeconds > 0`; `hardLogoutTimeoutSeconds > 0`; `idleLockTimeoutSeconds < hardLogoutTimeoutSeconds`. A zero or negative value disables the timer mechanism and is rejected by `RequiredControlCheck` per Policy A5.

**Snapshot relationship to `StaffUser`.** Operational reads for live session enforcement use `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` (defined in DEV-SPEC-001 Part 2 §2.5). These fields are snapshots populated from the active `RoleSessionConfig` row at staff-user create-time and at any subsequent `RoleSessionConfig` save. The `RoleService.updateSessionConfig()` save transaction includes a same-transaction update of the snapshot fields on every active `StaffUser` whose `roleId` matches the changed config row. This is the single permitted operational-record write from an admin service for the purpose of snapshot propagation; it is governed by the same audit-event-on-save guarantee as any other admin write (Policy A2). The audit event records the affected `StaffUser` IDs in the `fieldsChanged` payload.

This snapshot pattern reconciles three previously divergent positions: the canonical "configured per role" obligation, DEV-SPEC-001 Part 2 §2.5 (`StaffUser` carries `idleThresholdSeconds` and `hardLogoutThresholdSeconds` as fields), and MCL MC-013 ("model-level — not a `ConfigurationEntry` key"). The source of truth is the per-role `RoleSessionConfig` row; the operational-fast-path read is from `StaffUser`; the propagation is admin-write-time, not read-time.

#### 2.1A.6 `AiActorIdentity`

```prisma
model AiActorIdentity {
  id                  String    @id @default(uuid())
  displayName         String                          // name shown in audit events and communication attribution
  actorType           ActorLevel @default(L0_SYSTEM_ACTOR)
  isActive            Boolean   @default(true)
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  createdBy           String    // L4 actor — NOT NULL

  @@map("ai_actor_identity")
}
```

**Cardinality rule.** Exactly one `AiActorIdentity` row exists. Setup is required before the AI agent configuration block (`AIAgentConfigService`) can be saved. `actorType` is fixed to `L0_SYSTEM_ACTOR` and rejected on save if any other value is supplied.

#### 2.1A.7 `ModeConfiguration`

```prisma
model ModeConfiguration {
  id                          String              @id @default(uuid())
  modeKey                     String                            // canonical handle, e.g., "NEW_BOOKING", "ROOM_CHANGE"
  modeName                    String                            // display name
  isPredefined                Boolean             @default(true) // true for the eight seed modes
  stageRoute                  Json                              // ordered array of stage identifiers the mode presents
  autoFulfilmentConditions    Json                              // array of { stage, condition } pairs
  featureDependencies         Json                              // array of service / engine names the mode requires
  lifecycleState              ModeLifecycleState  @default(DRAFT)
  isActive                    Boolean             @default(false) // true only when lifecycleState == ACTIVE
  version                     Int                 @default(1)
  effectiveFrom               DateTime
  createdAt                   DateTime            @default(now())
  updatedAt                   DateTime            @updatedAt
  createdBy                   String              // L4 actor — NOT NULL

  @@unique([modeKey, version])
  @@map("mode_configurations")
}

enum ModeLifecycleState {
  DRAFT       // saved but not validated
  VALIDATED   // ModeValidationEngine.validate() returned ACCEPTED; not yet activated
  ACTIVE      // operational code may route through this mode
  SUPERSEDED  // a newer version replaced this row
}
```

**Lifecycle invariants.**
- A `ModeConfiguration` row is created in `lifecycleState = DRAFT`.
- Transition `DRAFT → VALIDATED` requires `ModeValidationEngine.validate()` returning `ACCEPTED`.
- Transition `VALIDATED → ACTIVE` requires L4 GM authority specifically for custom modes (`isPredefined = false`); predefined modes (`isPredefined = true`) may transition by any L4 actor.
- Transition `ACTIVE → SUPERSEDED` occurs automatically when a new row with the same `modeKey` reaches `ACTIVE`.
- No transition from `SUPERSEDED` to any other state is permitted. Re-activation requires a new supersession.
- `isActive = true` is invariant-bound to `lifecycleState = ACTIVE`. Setting `isActive = true` while `lifecycleState != ACTIVE` is a structural defect.

**Predefined mode preservation.** The eight seed modes (New Booking, Room Change, Rate Revision, Date Extension, Early Departure / Cancellation, Billing Model Change, Guest Composition Change, Complaint Resolution / Goodwill) ship with `isPredefined = true`, `lifecycleState = ACTIVE`, and `version = 1`. Customisation produces a new row via supersession; the predefined seed row may itself be superseded but never deleted. An attempted delete of any `ModeConfiguration` row is rejected with `ValidationError`.

### 2.2 Structured Registry Models

The following registry tables are managed directly by the Admin Console. Each has a dedicated admin service (Section 6) and a dedicated route group (Section 8). Operational code reads from these tables at runtime and never writes to them.

#### 2.2.1 `RoomTypeRegistry`

```prisma
model RoomTypeRegistry {
  id              String    @id @default(uuid())
  name            String    @unique
  description     String?
  baseCapacity    Int
  maxCapacity     Int
  amenities       Json?
  isActive        Boolean   @default(true)
  version         Int       @default(1)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  createdBy       String    // L4 actor — NOT NULL

  @@map("room_type_registry")
}
```

**Deletion rule:** A `RoomTypeRegistry` row may not be deleted if any active room instance, rate plan entry, or open entry references it. It is deactivated (`isActive = false`) instead. Historical references remain resolvable.

#### 2.2.2 `CancellationPolicyRegistry`

```prisma
model CancellationPolicyRegistry {
  id                String    @id @default(uuid())
  name              String    @unique
  penaltyTiers      Json      // array of {daysBeforeArrival, penaltyPercentage}
  noShowTreatment   String
  isActive          Boolean   @default(true)
  version           Int       @default(1)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  createdBy         String    // L4 actor — NOT NULL

  @@map("cancellation_policy_registry")
}
```

**Tier consistency rule:** `penaltyTiers` must form a non-overlapping, non-decreasing sequence covering the full window from far-out cancellations to day-of-arrival. Save-time validation is the `CancellationPolicyService` responsibility.

#### 2.2.3 `HandoffChecklistTemplate`

```prisma
model HandoffChecklistTemplate {
  id              String      @id @default(uuid())
  handoffType     HandoffType
  checklistItems  Json        // array of {itemKey, description, isRequired}
  version         Int         @default(1)
  isActive        Boolean     @default(true)
  createdAt       DateTime    @default(now())
  createdBy       String      // L4 actor — NOT NULL

  @@unique([handoffType, version])
  @@map("handoff_checklist_templates")
}
```

**Version rule:** A checklist template is immutable once saved. Modifications produce a new row with `version + 1`. The prior row's `isActive` is set to `false` in the same transaction. Operational code resolves the active template by `(handoffType, isActive = true)`.

**Completeness rule:** Templates must exist for each of the five handoff types (H1, H2, H3, H4, H5). Absence of any one blocks the readiness group that depends on it (§ Section 10).

#### 2.2.4 `WorkOrderTemplate`

```prisma
model WorkOrderTemplate {
  id              String    @id @default(uuid())
  name            String
  useType         EntryUseType?
  templateItems   Json      // array of default to-do item templates
  isActive        Boolean   @default(true)
  version         Int       @default(1)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  createdBy       String    // L4 actor — NOT NULL

  @@map("work_order_templates")
}
```

**Deletion rule:** A template referenced by any open work order may not be deleted. Deactivation is permitted.

#### 2.2.5 `CommunicationTemplate`

```prisma
model CommunicationTemplate {
  id              String                @id @default(uuid())
  name            String
  channel         CommunicationChannel
  templateType    String                // QUOTATION | CONFIRMATION | AMENDED | CANCELLED | PRE_ARRIVAL | ...
  subjectLine     String?               // EMAIL channel; includes prefix convention
  bodyTemplate    String                // interpolation tokens permitted
  stage           Stage?
  isActive        Boolean               @default(true)
  version         Int                   @default(1)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  createdBy       String                // L4 actor — NOT NULL

  @@map("communication_templates")
}
```

**Token validation rule:** Interpolation tokens in `bodyTemplate` must resolve against fields available at the send point for `templateType`. Token validation is the `CommunicationConfigService` responsibility at save time. Unknown tokens cause save rejection with `ValidationError`.

#### 2.2.6 `InvoiceTemplate`

```prisma
model InvoiceTemplate {
  id              String      @id @default(uuid())
  invoiceType     InvoiceType // PROFORMA | FINAL
  templateContent Json
  isActive        Boolean     @default(true)
  version         Int         @default(1)
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
  createdBy       String      // L4 actor — NOT NULL

  @@map("invoice_templates")
}
```

**Presence rule:** At least one active `PROFORMA` template and at least one active `FINAL` template must exist before S3 and S8 respectively are live.

#### 2.2.7 `FeedbackSurveyTemplate`

```prisma
model FeedbackSurveyTemplate {
  id              String    @id @default(uuid())
  name            String
  surveyContent   Json      // structured survey questions
  channels        Json      // array of channels (EMAIL | WHATSAPP)
  isActive        Boolean   @default(true)
  version         Int       @default(1)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  createdBy       String    // L4 actor — NOT NULL

  @@map("feedback_survey_templates")
}
```

#### 2.2.8 `VipNotificationRoutingConfig`

```prisma
model VipNotificationRoutingConfig {
  id              String    @id @default(uuid())
  vipTier         String
  notifyRoles     Json      // array of ActorLevel values
  notifyActorIds  Json?     // specific actor IDs always notified
  isActive        Boolean   @default(true)
  version         Int       @default(1)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  createdBy       String    // L4 actor — NOT NULL

  @@map("vip_notification_routing_configs")
}
```

### 2.3 Foreign Key Boundary

No foreign key exists from any configuration table into any operational record. Configuration tables reference each other where consistency requires it (e.g., `WorkOrderTemplate.useType` references the `EntryUseType` enum; `VipNotificationRoutingConfig.notifyRoles` contains `ActorLevel` enum values). Configuration tables do not reference `Entry.id`, `Folio.id`, `Inquiry.id`, `Reservation.id`, `Invoice.id`, `WorkOrder.id`, `CommunicationRecord.id`, or any other operational record identifier. Violations of this rule — a configuration column typed as a foreign key into an operational table — are structural defects.

### 2.4 Configuration Keys Managed via `ConfigurationEntry`

The following canonical keys are managed as rows in `ConfigurationEntry`. All keys are in dotted notation. The full meta-registry is reproduced in Section 9 for cross-reference against SIG-S1 through SIG-S9 read-side consumption. For each key, Section 9 also identifies the owning admin service.

**Expiry and timer keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `expiry.s1.defaultTtlSeconds` | S1 | Integer |
| `expiry.s2.quotationValidityDays` | S2 | Integer |
| `expiry.s2.speculativeHoldTtlSeconds` | S2 | Integer |
| `expiry.s3.committedHoldTtlSeconds` | S3 | Integer |

**Availability and inventory keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `availability.staleness.ttlSeconds` | S1–S2 | Integer |
| `availability.shadowInventory.visibilityRules` | S1 | Json |
| `availability.bookablePhysicalStates` | S1 | Json |
| `availability.walkIn.ratePlanId` | S1 | String |
| `deficientCondition.categories` | S1 | Json |

**Ownership and assignment**

| configKey | Stage dependency | Type |
|---|---|---|
| `ownership.assignmentRules` | S1 | Json |

**Processing lock keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `processingLock.ttl.perChannel` | S1 | Json (all four channels: EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE) |

**OTA keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `ota.sourceFlagConfig` | S1 | Json |
| `ota.inbox.pollingIntervalSeconds` | S1 | Integer |

**Discount authority keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `discount.fom.maxPercentage` | S2, S7 | Decimal |
| `discount.gm.maxPercentage` | S2, S7 | Decimal |

**Financial and billing keys**

| configKey | Stage dependency | Type |
|---|---|---|
| `advancePayment.thresholds` | S3 | Json |
| `advancePayment.followUpWindowSeconds` | S3 | Integer |
| `advancePayment.escalationWindowSeconds` | S3 | Integer |
| `billingModel.availablePerSource` | S3 | Json |
| `cancellation.policyTiers` | S3 | Json |
| `foc.configuration` | S3 | Json |
| `proformaInvoice.templates` | S3 | Json |
| `creditCeiling.clientTier.thresholds` | S3 | Json (all tiers: standard, preferred, caution, restricted) |
| `creditCeiling.proximityThresholds` | S3, S7 | Json |
| `overbooking.maxAllowedRooms` | S4 | Integer |

**No-show and identity**

| configKey | Stage dependency | Type |
|---|---|---|
| `noShow.cutoffMinutes` | S5 | Integer |
| `noShow.penaltyStructure` | S5 | Json |
| `identity.retentionPeriodDays` | S6, S9 | Json (by document type) |

**Night audit and checkout**

| configKey | Stage dependency | Type |
|---|---|---|
| `nightAudit.scheduleTime` | S7 | String (cron expression) |
| `nightAudit.expectedChargesRules` | S7 | Json |
| `checkout.cutoffTime` | S8 | String (HH:MM) |

**Damage, dispute, and post-stay**

| configKey | Stage dependency | Type |
|---|---|---|
| `damage.rateList` | S8 | Json |
| `dispute.fomOverride.maxFrequency` | S8 | Integer |
| `payment.followUpIntervalDays` | S9 | Integer |
| `commission.calculationBasis` | S9 | String |
| `feedback.platformLinks` | S9 | Json |
| `government.submissionConfig` | S9 | Json |

**Stage dwell**

| configKey | Stage dependency | Type |
|---|---|---|
| `stageDwell.thresholds` | All | Json (all 9 stages × 3 dwell modes) |

**Session management** — managed through the `RoleSessionConfig` model (see §2.1A.5). Per-role session timeout values are stored as table rows, one per role, not as `ConfigurationEntry` keys. This is a deliberate departure from the original v1.0 dotted-key design (which covered only Front Desk and FOM and omitted manual-lock availability) to align with the per-role obligation in DEV-SPEC-001 Part 12 §12.2.2 and Part 2 §2.5 `StaffUser.idleThresholdSeconds` / `hardLogoutThresholdSeconds` which are populated as snapshots from the per-role row.

**Communication acknowledgement**

| configKey | Stage dependency | Type |
|---|---|---|
| `acknowledgement.windowPerType` | S2–S9 | Json (all types: quotation, pi, voucher, preArrival, amendment, cancellation, invoice) |

**Payment milestone**

| configKey | Stage dependency | Type |
|---|---|---|
| `paymentMilestone.scheduleTemplates` | S3 | Json |
| `paymentMilestone.warningOffsetDays` | S3–S7 | Integer |

**AI agent**

| configKey | Stage dependency | Type |
|---|---|---|
| `ai.confidenceThreshold.autoApprove` | All | Decimal |
| `ai.correctionLog.maximumSize` | All | Integer |

All of the above keys are L4-managed. Each key has exactly one owning admin service; the mapping is in Section 9.

---

## Section 3 — Configuration Lifecycle & Temporal Model

The Admin Console has no stage state machine. Its lifecycle is configuration-temporal: a configuration value is active during a time window defined by `effectiveFrom` and `effectiveTo`. This section specifies exactly how configuration moves through its lifecycle and how operational code resolves the active value at any given moment.

### 3.1 Temporal Model — `effectiveFrom` / `effectiveTo`

Every `ConfigurationEntry` row carries `effectiveFrom` (when this value becomes active) and `effectiveTo` (when it is superseded). The invariant is:

- The **currently active** entry for a given `configKey` has `effectiveTo = NULL` and `effectiveFrom ≤ now()`.
- At most one entry per `configKey` may have `effectiveTo = NULL` at any time.
- Historical entries carry a non-null `effectiveTo` equal to the `effectiveFrom` of the entry that superseded them.

The same invariant applies to `PolicyRegistry` rows via `(version, isActive)`: exactly one active row per `policyId` at any moment; superseded rows have `isActive = false`.

The same invariant applies to registry table rows (room types, rate plans, templates, etc.) via `isActive = true`; superseded entries have `isActive = false`.

### 3.2 Runtime Read — Always Through the Temporal Filter

Operational code reading configuration must apply the temporal filter on every read. The canonical runtime query for a keyed configuration is:

```
SELECT configValue
FROM configuration_entries
WHERE configKey = $1
  AND effectiveFrom <= NOW()
  AND (effectiveTo IS NULL OR effectiveTo > NOW())
LIMIT 1
```

Shortcut queries of the form `findFirst({ where: { configKey } })` without the temporal filter are architectural defects. The `ConfigurationService` exposes the correct filter as its canonical read method; operational code should call the service, not compose the query directly.

For registry tables, the canonical read is `{ where: { isActive: true } }`. A read without the `isActive: true` filter is a defect.

For temporal audit (reconstructing what value was active at a historical moment), the query substitutes `$2` for `NOW()`:

```
SELECT configValue
FROM configuration_entries
WHERE configKey = $1
  AND effectiveFrom <= $2
  AND (effectiveTo IS NULL OR effectiveTo > $2)
LIMIT 1
```

### 3.3 Lifecycle of a Configuration Change

#### 3.3.1 Keyed Configuration (`ConfigurationEntry`)

The lifecycle is three-state: **ACTIVE → SUPERSEDED → (retained as history)**.

1. **ACTIVE.** A row with `effectiveTo = NULL` whose `effectiveFrom ≤ now()`. Operational code reading this key at runtime returns this row's `configValue`.

2. **Supersession event.** An administrator saves a new value for the same `configKey`. The admin service opens a transaction and performs the following atomic sequence:
   - Validate the new `configValue` against the key's typed shape.
   - Run the `ModeValidationEngine` if the key is mode-affecting (see Section 5); run the required-control check in all cases (see Section 4 Policy A5).
   - `UPDATE configuration_entries SET effectiveTo = :now WHERE configKey = :key AND effectiveTo IS NULL` — supersede the prior active row.
   - `INSERT INTO configuration_entries (configKey, configValue, effectiveFrom = :now, effectiveTo = NULL, setBy, setAt)` — insert the new active row.
   - `INSERT INTO trace_events (eventType = 'CONFIGURATION_CHANGE', surfaceModified, fieldsChanged, priorValue, newValue, actorId, actorRole, timestamp, operationType = 'UPDATE', requestId)` — record the audit event.
   - Commit.

3. **SUPERSEDED.** The prior row, now with `effectiveTo` set. Retained indefinitely as history. Queryable for temporal audit. Never deleted.

A configuration entry is never edited in place. `UPDATE` on the `configValue` column of an existing row is a structural defect.

#### 3.3.2 Registry Table Rows

Registry table rows (room types, rate plans, cancellation policies, handoff templates, etc.) carry `isActive: Boolean` and `updatedAt @updatedAt`. The lifecycle is per-row and depends on the nature of the change:

- **Field-level edit (cosmetic / non-governed fields):** `UPDATE` in place with `updatedAt` refreshed. Example: updating the `description` field on a `RoomTypeRegistry` row. An audit event records `operationType = 'UPDATE'` and the field-level diff.
- **Governed-field edit (fields that affect operational behaviour):** Supersede by creating a new row and setting `isActive = false` on the prior row. Example: changing `penaltyTiers` on a `CancellationPolicyRegistry` row. The service performs the supersession in a transaction with the audit event.
- **Deactivation:** `UPDATE` the row with `isActive = false`. The row is preserved so that historical references from operational records remain resolvable. An audit event records `operationType = 'UPDATE'` with the `isActive` transition.
- **Deletion:** Permitted only where the registry has no operational references and deactivation would leave the surface unusable. Example: deleting a never-activated `CommunicationTemplate`. `DELETE` with an audit event of `operationType = 'DELETE'`. Historical references from operational records — if any — must be checked before deletion; if any reference exists, the service raises `ValidationError` and refuses the delete.

#### 3.3.3 `PolicyRegistry` Rows

Policy rows are always superseded, never edited in place. `isActive = false` on the prior row and `version + 1` on the new row, written in the same transaction with the audit event.

### 3.4 Concurrent Edit Protection

Two administrators may attempt to save the same configuration surface simultaneously. The admin service layer must protect against silent overwrite and composite state corruption.

- **For `ConfigurationEntry`:** The atomic supersession transaction above is the protection. The `UPDATE ... WHERE effectiveTo IS NULL` clause combined with a database-enforced uniqueness guarantee on `(configKey, effectiveTo IS NULL)` means that two concurrent supersession attempts will not both succeed — one will find zero rows to update and will surface `ConcurrentEditingError`. The rejected administrator must re-read the current active entry and re-apply their change.
- **For registry tables:** The concurrency protection mechanism follows the system-wide concurrent editing protocol. A `version` integer field on registry rows, carried in the update request and matched on update, rejects second-write attempts as `ConcurrentEditingError`. This applies to `CancellationPolicyRegistry`, `RoomTypeRegistry`, `WorkOrderTemplate`, `CommunicationTemplate`, `InvoiceTemplate`, `FeedbackSurveyTemplate`, `VipNotificationRoutingConfig`.
- **For `HandoffChecklistTemplate` and `PolicyRegistry`:** The `(handoffType, version)` and `(policyId, version)` uniqueness constraints enforce non-concurrent version advancement at the schema level. Concurrent attempts will reject one caller with a database uniqueness violation, which the service translates to `ConcurrentEditingError`.

Across every admin write path, the invariant is: no second writer silently overwrites a first writer's changes. The rejected caller receives a typed `ConcurrentEditingError` with `{ entityType, entityId, currentEditorSession, conflictDetectedAt, resolution }` and is directed to re-read and re-apply.

### 3.5 Mode Lifecycle

Operational modes carry a dedicated lifecycle within the Admin Console. Mode records are subject to save-time validation, so their lifecycle includes a validation gate that the general configuration lifecycle does not.

- **DRAFT.** A mode record is being edited by an administrator. The record exists in the mode storage surface but has not been validated. Operational code cannot route through a `DRAFT` mode.
- **VALIDATED.** The mode passes the `ModeValidationEngine` check at save time (see Section 5). The record carries `isActive = false` until activation.
- **ACTIVE.** The mode is marked `isActive = true`. Operational code may route through the mode. Activation of a custom mode (one not shipped as seed data) requires L4 (GM) authority specifically.
- **SUPERSEDED.** A new `VALIDATED` or `ACTIVE` version of the same mode is saved; the prior row is retained with `isActive = false`.

A mode that fails validation at save never reaches `VALIDATED` and therefore never reaches `ACTIVE`. The save is rejected and the administrator is returned a typed `ConfigurationViolationError` (see Section 5) identifying the specific constraint violated.

Predefined modes (eight seed modes: New Booking, Room Change, Rate Revision, Date Extension, Early Departure / Cancellation, Billing Model Change, Guest Composition Change, Complaint Resolution / Goodwill) ship `ACTIVE`. They may be customised through supersession but they may not be deleted. An attempt to delete a predefined mode is rejected with `ValidationError`.

### 3.6 Seed Data

System seed values for keyed configuration (default timer durations, default thresholds, default retention periods) are inserted as `ConfigurationEntry` rows at system initialisation. The seeded row carries `setBy = 'SYSTEM_SEED'` or an equivalent system actor identifier. These rows are marked at the UI layer as default values so they are visually distinguished from administrator-reviewed values (see Section 4 Policy A3 and Section 8 UI contract).

A seeded default value is a valid `ConfigurationEntry`. It is not a placeholder; the system reads it at runtime as a real value. The default-value indicator does not change its validity — it informs the administrator that this value has not yet been consciously reviewed and owned.

### 3.7 Configuration Effective-From Activation

A configuration change does not require a worker to activate. The runtime read in §3.2 resolves the active value at every read; when the new entry's `effectiveFrom ≤ NOW()`, it is read. There is no background worker that "applies" configuration changes. Operational services pick up the new value on their next configuration read.

Where a configuration change affects a timer-governed event (e.g., changing `expiry.s3.committedHoldTtlSeconds`), the existing timers already scheduled by the `TimerEngine` continue to use the value that was active at the time they were scheduled. New timers scheduled after the change use the new value. The configuration change does not retroactively alter in-flight timers.

### 3.8 Rollback

An administrator may revert a configuration change by issuing a new save of the prior value. This is a new entry with `effectiveFrom = NOW()` and the prior value as `configValue`. The superseded-then-restored entry is the historically correct representation: two supersession events, not a deletion of the intermediate entry. The audit trail carries both events.

No delete-based rollback is supported. A configuration entry is never removed from `ConfigurationEntry`.

### 3.9 Configuration Visibility Across Session Events

A configuration change made by an administrator during an active admin session is immediately visible to operational code on the next read. There is no cache-layer propagation delay. Admin services do not write through a cache; they write to the database directly within the transaction. Operational code reads from the database; any cache layer in operational services is the operational service's responsibility to invalidate on receipt of the `CONFIGURATION_CHANGE` trace event.

---

## Section 4 — Policies (Admin Console Design Principles as Implementation Policies)

The Admin Console is governed by seven design principles. Each is restated below as an implementation policy with applicability, enforcement mechanism, error contract, and audit event on violation attempt. These policies are not design preferences. They are structural constraints.

### 4.1 Policy A1 — Strict Separation from Operational Code

**Requirement.** The admin code layer writes to configuration tables. The operational code layer reads from configuration tables at runtime. The two layers do not share imports.

- Admin code (admin services, admin controllers, admin middleware, admin route files) must not import from operational services, operational controllers, or operational route files.
- Operational code (operational services, operational controllers, operational middleware, operational route files) must not import from admin services or admin controllers.
- The Admin Console must not create, update, close, seal, or delete any operational record. The full operational entity list is enumerated in Section 1.6.

**Applicability.** Every admin service in Section 6; every admin route group in Section 8; every admin controller.

**Enforcement mechanism.** Repository-level module boundary enforcement. The codebase organises admin code and operational code in separate top-level directories (e.g., `src/admin/` and `src/operations/`). A lint rule or compile-time boundary check prohibits cross-directory imports. A second enforcement occurs at review time: any pull request that imports across the boundary is rejected before merge. A runtime check is neither sufficient nor appropriate — by the time runtime detects the violation, the code has already shipped.

**Error contract when violated.** At build time: the import rule produces a build failure with a clear message naming the forbidden import. At runtime (if the build-time check has been bypassed): the first operational consequence surfaces as a structural error. This is not a caller-recoverable condition; it is a code defect requiring rollback of the offending change.

**Audit event on violation attempt.** Not applicable at runtime for this policy — the violation is structural and detected at build/review time, not at service-call time. When an administrator attempts an action that would cause an admin surface to create an operational record (e.g., a misconfigured route wiring), the admin service raises `AuthorizationError` with `code = 'ADMIN_OPERATIONAL_RECORD_FORBIDDEN'` and the attempt is logged as a trace event with the `actorId`, the `surfaceAttempted`, and the operational entity type the action would have created.

### 4.2 Policy A2 — Audit Event on Every Configuration Save

**Requirement.** Every `CREATE`, `UPDATE`, and `DELETE` operation on any configuration surface produces a `TraceEvent` row in the same database transaction as the configuration change. The audit event cannot succeed while the configuration change rolls back; the configuration change cannot succeed while the audit event rolls back. If the transaction rolls back for any reason, both roll back together.

The audit event record carries:

| Field | Content |
|---|---|
| `surfaceModified` | The canonical surface name (from Section 9) |
| `fieldsChanged` | Array of field names modified |
| `priorValue` | Per-field prior value (for `UPDATE` and `DELETE`) |
| `newValue` | Per-field new value (for `CREATE` and `UPDATE`) |
| `actorId` | Authenticated L4 staff member's ID |
| `actorRole` | Actor's role at the time of the save |
| `timestamp` | UTC timestamp |
| `operationType` | `CREATE` \| `UPDATE` \| `DELETE` |
| `requestId` | UUID correlating the audit event to the inbound request |

**Applicability.** All 26 admin services in Section 6 and every route in every admin route group in Section 8 that performs a write.

**Enforcement mechanism.** Service-layer. Every admin service write method opens a Prisma `$transaction` that contains both the configuration write and the audit event write. A canonical helper method exposed on the admin service base class enforces that the audit event write is always part of the save transaction; admin services call the helper, not `prisma.configurationEntry.update()` directly. The service gate in Section 10 verifies this pattern through a direct code inspection assertion.

**Error contract when violated.** A configuration save without a same-transaction audit event is a Section 10 gate failure. There is no runtime error code for this — the configuration save must not be permitted to exist in the codebase. Gate enforcement at implementation review prevents the defect.

**Audit event on violation attempt.** Not applicable — this policy cannot be "attempted to be violated" at runtime; the violation is a code defect in the admin service itself.

### 4.3 Policy A3 — Default Values Visually Distinguished

**Requirement.** Every admin surface that renders a configurable value displays a non-intrusive indicator when the value being shown is a seeded default that has not been consciously reviewed and saved by an administrator. The indicator is a muted label, a subtle icon marker, a distinct background styling, or a subtle text marker (e.g., "system default"). The indicator is not a popup, not a modal, not an interruption. It is visible at a glance without requiring interaction.

When an administrator explicitly saves a value for that surface, the indicator disappears or changes state — the value is now administrator-reviewed, not a default.

**Applicability.** Every admin UI surface that renders a configurable value. This includes every form field on every admin screen, every table cell displaying a configuration value, every readout of threshold or duration, and every surface preview of a template.

**Enforcement mechanism.** The admin UI layer resolves, for every rendered configuration value, whether the source `ConfigurationEntry.setBy` is a system seed marker (e.g., `'SYSTEM_SEED'`) or a real staff member identifier. The resolution is carried in the API response envelope alongside the value itself. For registry tables, the UI checks whether the row was seeded at initialisation or created by an administrator — the `createdBy` field is the discriminator.

The specific UI mechanism (CSS class, icon component, adjacent label text) is an implementation choice within the non-intrusive constraint. The constraint is: the indicator exists and is visible at a glance.

**Error contract when violated.** If the admin UI renders a seeded default with no indicator, this is a UI-layer defect detected at acceptance review, not a runtime error. The Section 10 acceptance criteria include a visual inspection assertion.

**Audit event on violation attempt.** Not applicable — this policy is UI-presentational.

### 4.4 Policy A4 — Mode Configuration Validated at Save Time

**Requirement.** Every mode save — creating a new mode, updating a mode's configuration, activating a custom mode — is validated against three constraint categories before the save is committed:

1. **Policy constraints.** The mode must not auto-approve or silently bypass any action for which an active policy requires explicit approval or escalation. Example: a mode that auto-confirms reservations above the FOM confirmation authority threshold is rejected regardless of business justification.
2. **State machine constraints.** The mode's stage route must be a valid path through the operational state machine. A mode that skips a mandatory gate or routes through a forbidden transition is rejected.
3. **Service dependency constraints.** If the mode activates or includes a feature that depends on a service (e.g., commission calculation depends on `PostStayAndGovernanceService` being configured), the dependency must be reachable and correctly configured.

Validation is the `ModeValidationEngine` responsibility (Section 5). The engine returns `ACCEPTED` or `REJECTED` with a specific violation list. Save proceeds only on `ACCEPTED`.

**Applicability.** Every mode save path. Every mode activation path. Every mode-affecting configuration change that alters the stage route, auto-fulfilment conditions, or feature dependencies of an existing mode.

**Enforcement mechanism.** The `ModeService.save()` and `ModeService.activate()` methods invoke `ModeValidationEngine.validate()` before persisting any change. A save that bypasses the engine — direct `prisma.modeRecord.update()` — is a code defect detected at service-gate review.

Authority to save a mode is not authority to bypass validation. An L4 actor's save attempt runs through validation identically to any other save attempt. There is no administrator-level override of mode validation.

**Error contract when violated.** The save is rejected with `ConfigurationViolationError` carrying:

| Field | Content |
|---|---|
| `control` | The constraint the mode change would violate (policy name, state machine transition identifier, or service dependency name) |
| `requirement` | Human-readable description of what the constraint enforces |
| `proposedChange` | The mode configuration values that triggered the rejection |

HTTP status: 422.

**Audit event on violation attempt.** A `TraceEvent` is written with `eventType = 'MODE_VALIDATION_REJECTED'`, the `actorId` of the administrator who attempted the save, the `modeId`, and the violation payload. This is an audit of the attempt. It carries the same attribution as a successful save.

### 4.5 Policy A5 — Configuration Cannot Disable a Required Control

**Requirement.** Configuration tunes parameters within bounds. Configuration does not disable controls that the system requires for operational integrity. A save operation that would have the effect of disabling a required control is rejected at save time.

Required controls that configuration may not disable include, without limitation:

- **Exit evidence on stage gate transitions.** No threshold or timeout value may bypass the evidence requirement for a stage exit.
- **Timer Engine governance** for any event the Timer Engine governs (hold expiry, quotation validity, parking follow-up, no-show contact window, SLA breach escalation, processing lock expiry, feedback solicitation). Configuration may adjust durations; it may not disable the mechanism.
- **Human approval gate for AI outbound drafts** when the trust level for a category is set to `ALWAYS_REQUIRE_APPROVAL`. Configuration may change the trust level; it may not bypass the approval mechanism through a confidence threshold configured to auto-approve all drafts.
- **Audit event generation on governed operations.** No configuration value may suppress audit event writes.
- **Financial record immutability.** Configuration may not enable destructive editing of posted financial lines.

**Applicability.** Every admin write path. The check is performed at save time by the owning admin service and by the `ModeValidationEngine` for mode saves.

**Enforcement mechanism.** A dedicated `RequiredControlCheck` helper is invoked by every admin service before commit. The helper takes the proposed configuration change and evaluates whether any required control would be disabled or bypassed. The check is deterministic: given the proposed change, the answer is `PASS` or a specific violation.

Examples of check logic:

- A save to `expiry.s3.committedHoldTtlSeconds = 0` is rejected — zero would disable the expiry mechanism.
- A save to AI agent trust level that evaluates to "always auto-approve regardless of confidence" while `ALWAYS_REQUIRE_APPROVAL` categories exist is rejected.
- A save to `nightAudit.scheduleTime` that would prevent the night audit from ever running is rejected.

**Error contract when violated.** The save is rejected with `ConfigurationViolationError` carrying the three fields defined in Policy A4 (`control`, `requirement`, `proposedChange`). HTTP status: 422.

**Audit event on violation attempt.** A `TraceEvent` with `eventType = 'REQUIRED_CONTROL_VIOLATION_ATTEMPTED'` and the violation payload is written. This records who attempted to disable which control.

### 4.6 Policy A6 — Single-Tenant Namespace

**Requirement.** No configuration table carries a `tenant_id` column. No configuration query carries a tenant partition filter. No admin surface presents a property selector or tenant selector to the administrator.

**Applicability.** Every admin schema definition (§ Section 2); every admin service read and write path (§ Section 6); every admin route (§ Section 8); every admin UI surface.

**Enforcement mechanism.** Schema review at the time of any schema change. Any Prisma model added to the admin schema is inspected for the absence of a `tenantId`, `propertyId`, or similar field. Admin service code review rejects any query that includes such a partition filter.

**Error contract when violated.** A schema or code defect; detected at review, not at runtime. No runtime error code.

**Audit event on violation attempt.** Not applicable.

### 4.7 Policy A7 — L4 Authority on Every Admin Write

**Requirement.** Every admin write route is guarded by middleware that rejects non-L4 actors with `AuthorizationError` (HTTP 403) before the controller handler executes. The rejection carries the actor's authenticated level so that the rejection is itself audit-traceable.

This is not a redundancy with Policy A1. Policy A1 governs code-layer separation. This policy governs runtime authorisation. Both are required.

**Applicability.** Every admin write route in every admin route group in Section 8.

**Enforcement mechanism.** Route registration middleware chain: every admin write route registers `requireL4()` immediately after auth middleware, before validation middleware. A route registered without `requireL4()` is a route-gate defect detected at Section 10 acceptance review.

For admin read routes extended to non-L4 actors (audit visibility only): a different middleware `requireAdminRead()` performs the extended check against the role-permission mapping. Both middleware functions exist; the two are not interchangeable.

**Error contract when violated.** `AuthorizationError` with HTTP status 403, `code = 'L4_REQUIRED'`, and a context payload identifying the route, the required authority (`L4`), and the caller's authenticated authority.

**Audit event on violation attempt.** The rejection is recorded as a `TraceEvent` with `eventType = 'ADMIN_AUTHORITY_REJECTION'`. The event records `{ actorId, actorLevel, attemptedRoute, timestamp, requestId }`. The caller is attributed in the rejection trace event identically to a successful caller.

### 4.8 Applicability Summary

| Policy | Applies to | Enforcement layer |
|---|---|---|
| A1 Separation | Every admin service, controller, route | Build-time / review-time |
| A2 Audit on save | Every admin write path | Service layer (transaction) |
| A3 Default indicator | Every admin UI rendered value | UI layer |
| A4 Mode save validation | `ModeService.save()`, `ModeService.activate()` | Service layer (via engine) |
| A5 Required control | Every admin write path | Service layer (check helper) |
| A6 Single-tenant | Every schema and query | Schema / code review |
| A7 L4 authority | Every admin write route | Middleware layer |

---

## Section 5 — Engines

The Admin Console introduces two engines. Both are pure computation engines in the sense specified for Part 4 engines system-wide: they take typed inputs, they return typed outputs, and they do not maintain their own state. They are invoked by admin services and operational orchestration.

Neither engine is currently present in the concern-layer Part 4 engine catalogue. Their derivation in this guideline is registered as a finding in the Findings Register (Section 11) for absorption into a future Part 4 revision.

### 5.1 `ReadinessGateEngine`

#### 5.1.1 Purpose

The `ReadinessGateEngine` evaluates, at system startup and on demand, whether every required configuration surface for every stage readiness group is populated, valid, and in a fit state to be read by operational code. The engine produces a structured readiness report. A stage readiness group with any failure is not live; the system is not considered operationally ready for that group until the failures are resolved.

#### 5.1.2 Invocation

- **At startup.** Invoked by the system bootstrap sequence before any operational request is accepted. The engine evaluates all readiness groups in one pass and collects all failures across all groups. Startup does not complete until the evaluation runs (but see §5.1.5 — the presence of failures does not necessarily halt startup; the system logs and surfaces the report).
- **On demand.** Invoked by the `ReadinessService` when an administrator requests re-validation through the admin API. Re-validation is a full re-run against the current configuration state; no incremental evaluation is performed.

#### 5.1.3 Input Contract

```
input: {
  groups: ReadinessGroupIdentifier[]   // which groups to evaluate; omitted = all groups
  asOf: Date                           // temporal point — usually NOW(); supports historical audit queries
}
```

Valid group identifiers: `S1_READINESS`, `S2_READINESS`, `S3_READINESS`, `S4_READINESS`, `S5_READINESS`, `S6_READINESS`, `S7_READINESS`, `S8_READINESS`, `S9_READINESS`, `CROSS_STAGE_READINESS`.

#### 5.1.4 Output Contract

```
output: {
  asOf: Date
  groupResults: Array<{
    group: ReadinessGroupIdentifier
    status: 'LIVE' | 'BLOCKED'
    failures: MissingConfigurationError[]
  }>
  overallStatus: 'ALL_LIVE' | 'SOME_BLOCKED'
}
```

Each `MissingConfigurationError` in a failure list carries:

| Field | Type | Content |
|---|---|---|
| `missingConfigurationSurface` | `string` | Canonical surface name (from Section 9) |
| `stageGroup` | `string` | The group identifier |
| `consequence` | `string` | What operational behaviour is not available until this surface is configured |

#### 5.1.5 Collection, Not Fail-Fast

The engine does not halt on the first failure. It runs the full evaluation and collects every failure across every requested group. This is essential: an administrator resolving readiness must see every gap in one configuration session, not discover them one at a time across multiple restart cycles.

#### 5.1.6 Validity Criteria

For each required surface in a readiness group, the engine confirms:

1. The surface record exists in the database (for registry tables, at least one `isActive = true` row; for keyed configurations, a `ConfigurationEntry` row with `effectiveTo = NULL`).
2. All mandatory fields on the surface are non-empty.
3. Any referential dependencies are resolvable (e.g., a `RoomInstance` referencing a `RoomType` must find the type; a rate plan referencing a season must find the season; a VIP notification routing entry referencing a role must find the role).

The exact per-surface validity criteria are defined per surface in Section 10 (acceptance criteria). The engine delegates per-surface validity check logic to the owning admin service's `validateForReadiness()` method — the engine orchestrates; the service owns the per-surface truth.

#### 5.1.7 No Fallback Defaults

If a required surface is absent or invalid, no service, engine, or controller may substitute a hardcoded default value in its place. Absence is a `MissingConfigurationError`, not an occasion for silent default substitution. A worker or operational service that encounters a missing configuration at runtime — outside the startup readiness check — raises a `MissingConfigurationError` and halts the operation; it does not proceed with an assumed value.

#### 5.1.8 Readiness Groups and Required Surfaces

The required surface list per readiness group is consolidated in Section 10 acceptance criteria. The engine reads the list from a dedicated readiness manifest (not from inline hardcoded constants) so that the manifest can be versioned alongside the surface catalogue.

#### 5.1.9 Hardcoded vs Configurable

- **Hardcoded behaviour:** the collection-not-fail-fast rule; the validity-criteria structure; the prohibition on fallback defaults; the requirement that every failure be returned.
- **Configurable parameter:** none. The readiness manifest is a code artifact, not a configuration surface. Changes to which surfaces are required at which readiness groups are specification changes, not configuration changes.

### 5.2 `ModeValidationEngine`

#### 5.2.1 Purpose

The `ModeValidationEngine` evaluates whether a proposed mode configuration satisfies the three constraint categories of Policy A4: policy constraints, state machine constraints, and service dependency constraints. The engine returns `ACCEPTED` or `REJECTED` with a specific violation list.

#### 5.2.2 Invocation

Invoked by `ModeService.save()` and `ModeService.activate()` before the mode record is persisted or marked active. The engine runs synchronously; the save path awaits the result and commits or rejects accordingly. There is no async mode validation path.

#### 5.2.3 Input Contract

```
input: {
  modeId: string            // existing mode being updated, or new-mode placeholder
  modeDefinition: {
    name: string
    stageRoute: StageSequence
    autoFulfilmentConditions: Array<{ stage, condition }>
    featureDependencies: string[]
    // ... other mode-specific fields
  }
  actorId: string           // the administrator attempting the save
  context: 'SAVE' | 'ACTIVATE'
}
```

#### 5.2.4 Output Contract

```
output: {
  status: 'ACCEPTED' | 'REJECTED'
  violations: Array<{
    category: 'POLICY' | 'STATE_MACHINE' | 'SERVICE_DEPENDENCY'
    control: string           // policy name, transition identifier, or service name
    requirement: string       // what the violated constraint enforces
    proposedChange: object    // the mode configuration that triggered the violation
  }>
}
```

If `status = 'ACCEPTED'`, `violations` is an empty array. If `status = 'REJECTED'`, `violations` contains at least one entry and the service raises `ConfigurationViolationError` with the first violation as the surfaced error (the full violation list is included in the error context).

#### 5.2.5 Constraint Evaluation

- **Policy constraints.** The engine loads the active policy set from the `PolicyRegistryService` and evaluates whether the proposed mode's auto-fulfilment conditions would cause any policy to be bypassed. A policy requiring explicit approval or escalation cannot be auto-fulfilled by a mode, regardless of the data conditions the auto-fulfilment tests.
- **State machine constraints.** The engine loads the operational state machine definitions (Part 3 derivation) and walks the mode's `stageRoute` to confirm every transition is valid. Invalid transitions (a transition not present in the state machine) and omitted mandatory gates (a stage the state machine requires as non-skippable) are violations.
- **Service dependency constraints.** The engine walks the mode's `featureDependencies` list and confirms each named service is present, configured, and reachable per the readiness criteria in Section 10.

#### 5.2.6 Authority Interaction

The engine does not evaluate the caller's authority. Authority to save a mode is enforced by the `requireL4` middleware before the service method is invoked, and authority to activate a custom mode specifically is enforced by the `ModeService.activate()` method (which requires L4 GM). The engine's role is validation of the mode content, not authorisation of the caller.

#### 5.2.7 Hardcoded vs Configurable

- **Hardcoded behaviour:** the three-category constraint structure; the synchronous invocation from `ModeService`; the rejection-on-any-violation rule; the enumeration of violations (not first-fail).
- **Configurable parameter:** none at the engine level. The policies evaluated, the state machine definitions, and the service dependency set are themselves governed by their respective specifications, which the engine consumes as inputs. The engine's hardcoded behaviour is stable regardless of how those inputs evolve.

### 5.3 Engines Consumed as Read-Only Dependencies

The following operational engines are referenced by the Admin Console through their configuration surface dependencies. The Admin Console does not re-specify their behaviour; it owns only the configuration surfaces each engine reads.

- **TimerEngine** — reads all `expiry.*` keys, `acknowledgement.windowPerType`, `noShow.cutoffMinutes`, `processingLock.ttl.perChannel`, `paymentMilestone.*`, `voice_note_review_sla_per_channel`, `deficient_resolution_deadline`, and others. Admin surfaces that feed TimerEngine configuration are enumerated in Section 9.
- **PricingPipelineEngine** — reads `rate_plan_registry`, `season_calendar`, `package_registry`, `override_margin_per_rate_plan`, `discount.*` keys.
- **AvailabilityEngine** — reads `availability.*` keys, `deficientCondition.categories`, `room_type_registry`, `room_instance_registry`.
- **OverbookingDetectionEngine** — reads `overbooking.maxAllowedRooms`, `ota_conflict_trigger_rules`.
- **CreditCeilingMonitorEngine** — reads `creditCeiling.*` keys.
- **DisputeGateEngine** — reads `dispute_gate_function_config`, `dispute.fomOverride.maxFrequency`.
- **FOCValidationEngine** — reads `foc.configuration`.
- **NightAuditEngine** — reads `nightAudit.*` keys.
- **ReEntryConsequenceEngine** — reads configuration keys that govern re-entry consequences per stage pair.
- **RoomAssignmentSuggestionEngine** — reads `room_assignment_priority_rules`.

For each of these engines, the admin-side obligation is: the admin service owning the configuration surface must ensure that the value saved is of the type and shape the engine expects. Shape validation is the owning admin service's save-time responsibility. Type-shape mismatches are rejected with `ValidationError` before the save commits.

---

## Section 6 — Services

This section enumerates every admin service required to realise the full configuration surface catalogue. Twenty-six admin services are specified. Each is derived positively from the Section 2 schema and the surface catalogue; each is registered as a finding in the Findings Register for absorption into a future Part 6 revision.

### 6.1 Service Design Contract

Every admin service in this section obeys the following contract:

- **Canonical save pattern.** Every write method opens a Prisma `$transaction` and performs: (1) validation of input; (2) `RequiredControlCheck` invocation; (3) `ModeValidationEngine` invocation if the save is mode-affecting; (4) the configuration write; (5) the audit event write; (6) commit. The pattern is:

```typescript
async saveSurface(input, actorId) {
  await this.validateInput(input);
  await requiredControlCheck(input);
  return prisma.$transaction(async (tx) => {
    // Supersede prior row (for ConfigurationEntry) or update in place (for registry tables
    // on non-governed fields), per the Section 3 lifecycle for this surface type
    const result = await this.writeConfiguration(tx, input, actorId);
    await tx.traceEvent.create({
      data: buildAuditEvent({
        surfaceModified: this.surfaceName,
        operationType: result.operation,
        fieldsChanged: result.diff.fields,
        priorValue: result.diff.prior,
        newValue: result.diff.new,
        actorId,
        actorRole: 'L4',
        timestamp: new Date(),
        requestId: result.requestId
      })
    });
    return result;
  });
}
```

- **Import constraints (Policy A1).** Admin services do not import operational services, operational controllers, or operational state machine functions. They may import: Prisma client; `TraceEvent` helpers; the `RequiredControlCheck` helper; the `ModeValidationEngine` and `ReadinessGateEngine`; other admin services (with care — circular import avoidance); Part 11 integration interfaces (for services that validate external connectivity at save time, e.g., `AIAgentConfigService` testing LLM credentials).
- **Transaction rollback behaviour.** A thrown error anywhere in the transaction callback triggers full rollback. Services do not `try/catch` and suppress errors within the transaction callback. The audit event and the configuration write are bound together.
- **Forbidden patterns.** No admin service creates an operational record. No admin service invokes an operational service. No admin service writes to a configuration table outside its owned surface set.

Each service specification below enumerates: owned surface(s), methods, transaction pattern reference, forbidden patterns (where service-specific), and the correction ID under which the derivation is registered.

### 6.1A Service-Layer Helpers

Two service-layer helpers are referenced repeatedly across the catalogue. Their location, signature, and behaviour are specified once here and are not repeated per service.

#### 6.1A.1 `RequiredControlCheck` Helper

- **Location.** `src/admin/helpers/requiredControlCheck.ts` (or the equivalent path under the admin code boundary).
- **Signature.** `requiredControlCheck(input: RequiredControlCheckInput): Promise<void>` — throws `ConfigurationViolationError` on violation; returns `void` on pass.
- **Input shape.**

```typescript
interface RequiredControlCheckInput {
  surfaceName: string;          // canonical surface name from §9
  proposedChange: object;       // the configuration values being saved
  currentValue?: object;        // for UPDATE — the value being superseded
  operationType: 'CREATE' | 'UPDATE' | 'DELETE';
  actorId: string;
}
```

- **Per-surface check registry.** The helper consults a registry that maps `surfaceName` to its applicable required-control checks (see §4.5 examples). The registry is a code artifact, not configurable. Each entry in the registry is a deterministic function `(proposedChange, currentValue) => RequiredControlViolation | null`.
- **Invocation.** Every admin service write method invokes this helper before opening the Prisma `$transaction`. A save that bypasses the helper is a §10 gate failure (see AC-SV-4).
- **Failure shape.** When a check fails, the helper throws `ConfigurationViolationError` with the three-field context payload from §4.4 (`control`, `requirement`, `proposedChange`). HTTP 422 surfaces at the controller boundary.

#### 6.1A.2 `requireGmRole` Authorisation Helper

The `requireL4()` middleware enforces L4 authority but does not distinguish among L4 actors. Two operations require GM specifically (not just any L4): activation of a custom `ModeConfiguration` (per §6.2.14) and any future operation explicitly designated as GM-only.

- **Location.** `src/admin/helpers/requireGmRole.ts`.
- **Signature.** `requireGmRole(actorId: string): Promise<void>` — throws `AuthorizationError` (HTTP 403, `code = 'GM_REQUIRED'`) if the actor's `roleCode` is not `L4_GM_ADMIN`; returns `void` on pass.
- **Implementation.** The helper resolves the actor by `actorId` against the `StaffUser` table joined on `Role`, and confirms `Role.roleCode === 'L4_GM_ADMIN'`. The check happens inside the service method, after `requireL4()` has already passed at the middleware layer; this helper is the second-tier discriminator.
- **Distinction from `requireL4`.** `requireL4()` is a route-level middleware that runs on every admin write route. `requireGmRole()` is a service-level helper invoked only where the GM-specific carve-out is documented. The two are complementary, not interchangeable.
- **Audit attribution.** A failed `requireGmRole` check produces a `TraceEvent` with `eventType = 'GM_AUTHORITY_REJECTION'` carrying `{ actorId, actorRoleCode, attemptedOperation, surfaceModified, requestId }`.

### 6.2 Service Catalogue

#### 6.2.1 `HotelProfileService` [ACIG-COR-003]

- **Owned surface:** `HotelProfile` (§2.1A.1) — single-record table.
- **Methods:** `getHotelProfile()`, `updateHotelProfile(input, actorId)`. No `create` or `delete` — the profile is a single record that exists from deployment.
- **Save transaction:** per §6.1. The hotel profile is a mutable single row; saves apply as field-level updates with an audit event showing the field diff. Save-time validation per §2.1A.1 (non-empty `hotelName` and `registeredAddress`; valid email format; valid IANA timezone; valid ISO 4217 currency; coherent `operatingHours` per day).
- **Forbidden:** no deletion path; no second-record creation path.

#### 6.2.2 `DepartmentService` [ACIG-COR-004]

- **Owned surface:** `Department` (§2.1A.2).
- **Methods:** `listDepartments()`, `getDepartment(id)`, `createDepartment(input, actorId)`, `updateDepartment(id, input, actorId)`, `deactivateDepartment(id, actorId)`. No hard delete method.
- **Save transaction:** per §6.1. Deactivation (`deactivateDepartment`) is an update that sets `isActive = false`; it runs a precondition check that the department is not referenced by any active staff member or open work order. The precondition check reads operational tables in read-only mode — this is permitted; operational table reads for configuration integrity checks are not operational writes.
- **Forbidden:** no deletion of a referenced department; no reactivation of an inactive department that would cause ambiguity in historical work order routing (a deactivated department may be reactivated only if no other active department uses its code).

#### 6.2.3 `StaffService` [ACIG-COR-005]

- **Owned surfaces:** `StaffUser` (DEV-SPEC-001 Part 2 §2.5), `AiActorIdentity` (§2.1A.6).
- **Methods:** `listStaff()`, `getStaff(id)`, `createStaff(input, actorId)`, `updateStaff(id, input, actorId)`, `resetPin(id, newPin, actorId)`, `deactivateStaff(id, actorId)`; `getAIActorIdentity()`, `setAIActorIdentity(input, actorId)`.
- **Save transaction:** per §6.1. PIN storage uses a one-way hash; the plaintext PIN is never persisted, never logged, and is not returned in any API response after creation or reset. The audit event for PIN operations records the fact of the PIN change, not the PIN value. `createStaff` and any `updateStaff` that changes `roleId` snapshot `idleThresholdSeconds` and `hardLogoutThresholdSeconds` from the active `RoleSessionConfig` row for that role into the `StaffUser` fields, in the same transaction. `createStaff` rejects if the referenced `roleId` has no active `RoleSessionConfig` row. `createStaff` rejects if the referenced `departmentId` is not active.
- **Forbidden:** no deletion of staff records; staff are deactivated only. No display of PIN values after creation. No creation of the AI actor identity with an `actorType` other than `L0_SYSTEM_ACTOR`. No write to `idleThresholdSeconds` or `hardLogoutThresholdSeconds` outside the snapshot pattern (i.e., not exposed as direct API fields on `updateStaff`).

#### 6.2.4 `RoleService` [ACIG-COR-006]

- **Owned surfaces:** `Role` (§2.1A.3), `RolePermissionMapping` (§2.1A.4), `RoleSessionConfig` (§2.1A.5).
- **Methods:** `listRoles()`, `getRole(id)`, `getRolePermissions(id)`, `updateRolePermissions(id, permissionMappings, actorId)`; `getSessionConfig(roleId)`, `updateSessionConfig(roleId, input, actorId)`. Inputs to `updateSessionConfig` carry `idleLockTimeoutSeconds`, `hardLogoutTimeoutSeconds`, and `manualLockAvailable` — all three together; partial updates are rejected.
- **Save transaction:** per §6.1. The `updateRolePermissions` save invokes `RequiredControlCheck` with special attention to whether the resulting permission set leaves any required operational action without a role capable of performing it. If so, the save is rejected. The `updateSessionConfig` save validates `idleLockTimeoutSeconds < hardLogoutTimeoutSeconds` and that both are positive; it then performs a same-transaction propagation update to `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` for every active `StaffUser` whose `roleId` matches the changed config row. The audit event records both the `RoleSessionConfig` change and the affected `StaffUser` IDs in `fieldsChanged`. Although `StaffUser` is the owned surface of `StaffService`, this propagation write is a controlled cross-service write of two specific snapshot fields only — no other `StaffUser` field is touched by this transaction. This carve-out is registered in §6.4 alongside the `AgentProfile.commissionRate` exception.
- **Forbidden:** no role definition mutation that would eliminate operational coverage; no session configuration that sets either timer to zero or makes idle ≥ hardLogout; no creation or deletion of `Role` rows (predefined roles are seeded; custom roles are out of scope per §2.1A.3); no manual edit of `StaffUser.idleThresholdSeconds` / `hardLogoutThresholdSeconds` outside the propagation transaction.

#### 6.2.5 `RoomTypeService` [ACIG-COR-007]

- **Owned surface:** `RoomTypeRegistry`.
- **Methods:** `listRoomTypes()`, `getRoomType(id)`, `createRoomType(input, actorId)`, `updateRoomType(id, input, actorId)`, `deactivateRoomType(id, actorId)`.
- **Save transaction:** per §6.1. Governed-field edits (`baseCapacity`, `maxCapacity`, `amenities` where referenced by active rate plans) trigger supersession; cosmetic edits (`description`) may update in place with an audit event.
- **Forbidden:** no deletion if any active room instance, active rate plan, or open entry references the type. No mutation of `name` after creation (name is the stable handle referenced by operational records).

#### 6.2.6 `RoomInstanceService` [ACIG-COR-008]

- **Owned surfaces:** `Room` (DEV-SPEC-001 Part 2 §2.4 — `rooms` table), and two configuration keys via `ConfigurationEntry`: `deficientCondition.categories` (Json — list of permitted DEFICIENT category codes; the underlying enum `DeficientConditionCategory` is defined in Part 2 §2.0 enums), and `deficientResolution.deadlineHours` (Integer — referenced in v1.0 as `deficient_resolution_deadline`).
- **Methods:** `listRooms()`, `getRoom(id)`, `createRoom(input, actorId)`, `updateRoom(id, input, actorId)`, `deactivateRoom(id, actorId)`; `listDeficientCategories()`, `updateDeficientCategories(input, actorId)`; `getDeficientResolutionDeadline()`, `updateDeficientResolutionDeadline(input, actorId)`.
- **Save transaction:** per §6.1. The two configuration-key methods write to `ConfigurationEntry` via the supersession pattern (§3.3.1); the room-instance methods write to `Room` directly. Both run within the canonical save transaction with audit event.
- **Forbidden:** no deletion of a room instance; deactivation only. No mutation of a room's `roomType` reference after creation. No deletion of a DEFICIENT category code from `deficientCondition.categories` if any open `DeficientConditionRecord` references that category — `RequiredControlCheck` enforces this at save time.

#### 6.2.7 `SpaceInventoryService` [ACIG-COR-009]

- **Owned surface:** `space_inventory`.
- **Methods:** `listSpaces()`, `getSpace(id)`, `createSpace(input, actorId)`, `updateSpace(id, input, actorId)`, `deactivateSpace(id, actorId)`.
- **Save transaction:** per §6.1.
- **Forbidden:** no deletion of a space with open conference or event references; deactivation only.

#### 6.2.8 `RatePlanService` [ACIG-COR-010]

- **Owned surfaces:** `rate_plan_registry`, `override_margin_per_rate_plan`, `walk_in_rate_plan` (a designation, not a separate table — `availability.walkIn.ratePlanId` points to a `rate_plan_registry` row).
- **Methods:** `listRatePlans()`, `getRatePlan(id)`, `createRatePlan(input, actorId)`, `updateRatePlan(id, input, actorId)`, `deactivateRatePlan(id, actorId)`; `getOverrideMargin(ratePlanId)`, `setOverrideMargin(ratePlanId, margin, actorId)`; `getWalkInRatePlan()`, `setWalkInRatePlan(ratePlanId, actorId)`.
- **Save transaction:** per §6.1. The governance-heaviest admin service — every save that affects pricing integrity invokes `RequiredControlCheck`.
- **Forbidden:** no deletion if referenced by any active entry, reservation, quotation, or hold; deactivation only. No designation of an inactive rate plan as walk-in.

#### 6.2.9 `SeasonService` [ACIG-COR-011]

- **Owned surface:** `season_calendar`.
- **Methods:** `listSeasons()`, `getSeason(id)`, `createSeason(input, actorId)`, `updateSeason(id, input, actorId)`, `deactivateSeason(id, actorId)`.
- **Save transaction:** per §6.1. Save-time validation rejects overlapping date ranges among active seasons.
- **Forbidden:** no deletion of a season referenced by active rate plans or historical reservations.

#### 6.2.10 `PackageService` [ACIG-COR-012]

- **Owned surface:** `package_registry`.
- **Methods:** `listPackages()`, `getPackage(id)`, `createPackage(input, actorId)`, `updatePackage(id, input, actorId)`, `deactivatePackage(id, actorId)`.
- **Save transaction:** per §6.1.
- **Forbidden:** no deletion if referenced by any active entry or quotation.

#### 6.2.11 `CommercialThresholdService` [ACIG-COR-013]

- **Owned surfaces:** `discount_thresholds` (`discount.fom.maxPercentage`, `discount.gm.maxPercentage`), `speculative_hold_thresholds`, `foc.configuration`, `confirmation_authority_thresholds`, `overbooking.maxAllowedRooms`, `credit_extension_ceiling_thresholds` (`creditCeiling.clientTier.thresholds`, `creditCeiling.proximityThresholds`), `write_off_authority_thresholds`.
- **Methods:** one `get` and one `set` per surface. `setDiscountThresholds(input, actorId)`, `setFOCConfiguration(input, actorId)`, `setConfirmationAuthorityThresholds(input, actorId)`, `setOverbookingLimits(input, actorId)`, `setCreditCeilingThresholds(input, actorId)`, `setSpeculativeHoldThresholds(input, actorId)`, `setWriteOffAuthorityThresholds(input, actorId)`.
- **Save transaction:** per §6.1. `setDiscountThresholds` validates that bands are contiguous and non-overlapping from zero to the maximum permitted. `setCreditCeilingThresholds` validates that every tier (standard, preferred, caution, restricted) has a threshold. Save-time validation is rigorous because the engines that read these keys (e.g., `CreditCeilingMonitorEngine`) fail-fast on malformed values.
- **Forbidden:** no partial save of credit ceiling tiers (all four tiers saved atomically); no negative thresholds.

#### 6.2.12 `CancellationPolicyService` [ACIG-COR-014]

- **Owned surfaces:** `CancellationPolicyRegistry`, `cancellation.policyTiers` (keyed mirror).
- **Methods:** `listPolicies()`, `getPolicy(id)`, `createPolicy(input, actorId)`, `updatePolicy(id, input, actorId)`, `deactivatePolicy(id, actorId)`.
- **Save transaction:** per §6.1. Save validates tier ordering (non-decreasing penalties as the arrival date approaches) and date coverage (contiguous from far-out to day-of-arrival).
- **Forbidden:** no deletion of a policy referenced by active reservations; deactivation only.

#### 6.2.13 `WorkflowConfigurationService` [ACIG-COR-015]

- **Owned surfaces:** `committed_hold_duration` (`expiry.s3.committedHoldTtlSeconds`), `expiry_defaults` (all `expiry.*` keys), `ownership_assignment_rules` (`ownership.assignmentRules`), `billing_model_availability` (`billingModel.availablePerSource`).
- **Methods:** `getCommittedHoldDuration()`, `setCommittedHoldDuration(input, actorId)`; `getExpiryDefaults()`, `setExpiryDefaults(input, actorId)`; `getOwnershipRules()`, `setOwnershipRules(input, actorId)`; `getBillingModelAvailability()`, `setBillingModelAvailability(input, actorId)`.
- **Save transaction:** per §6.1. `setExpiryDefaults` is the single largest shape-validated save in the Admin Console — every event type's duration is validated as positive; any event type required by a live stage that is absent from the input is rejected.
- **Forbidden:** no zero-second expiry values; no removal of an expiry key still referenced by a live stage.

#### 6.2.14 `ModeService` [ACIG-COR-016]

- **Owned surface:** `ModeConfiguration` (§2.1A.7).
- **Methods:** `listModes()`, `getMode(id)`, `saveMode(input, actorId)`, `activateMode(id, actorId)`, `deactivateMode(id, actorId)`. No delete method.
- **Save transaction:** per §6.1, with mandatory `ModeValidationEngine.validate()` invocation before the write. `saveMode` creates the row in `lifecycleState = DRAFT`, then on `ACCEPTED` validation transitions it to `lifecycleState = VALIDATED` in the same transaction. `activateMode` transitions `VALIDATED → ACTIVE` and sets `isActive = true`; for custom modes (`isPredefined = false`) the service invokes `requireGmRole(actorId)` (§6.1A.2) before persisting — non-GM L4 actors are rejected with `AuthorizationError` (`code = 'GM_REQUIRED'`). Predefined modes (`isPredefined = true`) skip the `requireGmRole` check and may be activated by any L4 actor. `deactivateMode` transitions `ACTIVE → SUPERSEDED` (for custom modes only) or sets `isActive = false` for predefined modes (which preserves `lifecycleState = ACTIVE` for the row but removes it from operational routing).
- **Forbidden:** no save of a predefined mode with its `modeKey` changed (`modeKey` is the stable handle); no deletion of any mode row regardless of `lifecycleState`; no activation of a row in `lifecycleState != VALIDATED`; no transition out of `SUPERSEDED`; no manual write of `lifecycleState` outside the service-managed transitions above.

#### 6.2.15 `PolicyRegistryService` [ACIG-COR-017]

- **Owned surface:** `PolicyRegistry`.
- **Methods:** `listPolicies()`, `getActivePolicy(policyId)`, `savePolicy(input, actorId)`, `deactivatePolicy(policyId, actorId)`.
- **Save transaction:** per §6.1. Every save supersedes via `version + 1` and sets the prior row `isActive = false` in the same transaction.
- **Forbidden:** no in-place edit; no deletion.

#### 6.2.16 `CommunicationConfigService` [ACIG-COR-018]

- **Owned surfaces:** `communication_channel_config`, `acknowledgement_window_per_type` (`acknowledgement.windowPerType`), `communication_templates` (`CommunicationTemplate` model).
- **Methods:** `listChannels()`, `getChannel(id)`, `updateChannel(id, input, actorId)`; `getAcknowledgementWindow()`, `setAcknowledgementWindow(input, actorId)`; `listTemplates()`, `getTemplate(id)`, `createTemplate(input, actorId)`, `updateTemplate(id, input, actorId)`, `deactivateTemplate(id, actorId)`.
- **Save transaction:** per §6.1. Credentials are stored as secrets — `updateChannel` never returns the credential value in any response after save; the response indicates only that the credential is set. Template `bodyTemplate` interpolation tokens are validated against the fields available at send time for the declared `templateType`; unknown tokens reject the save with `ValidationError`. Channel credential changes trigger a connectivity test — a save that produces a connectivity failure is rejected.
- **Forbidden:** no display of stored credentials after save; no deletion of a template referenced by any scheduled outbound communication.

#### 6.2.17 `HandoffTemplateService` [ACIG-COR-019]

- **Owned surface:** `HandoffChecklistTemplate`.
- **Methods:** `listTemplates()`, `getTemplate(handoffType)`, `saveTemplate(handoffType, checklistItems, actorId)`, `deactivateTemplate(id, actorId)`.
- **Save transaction:** per §6.1. Saves supersede by `version + 1`.
- **Forbidden:** no in-place edit; no deletion of a template if any handoff of that type is referenced in historical operational records.

#### 6.2.18 `WorkOrderTemplateService` [ACIG-COR-020]

- **Owned surface:** `WorkOrderTemplate`.
- **Methods:** `listTemplates()`, `getTemplate(id)`, `createTemplate(input, actorId)`, `updateTemplate(id, input, actorId)`, `deactivateTemplate(id, actorId)`.
- **Save transaction:** per §6.1.
- **Forbidden:** no deletion of a template referenced by any open work order.

#### 6.2.19 `FinancialConfigurationService` [ACIG-COR-021]

- **Owned surfaces:** `advance_payment_thresholds` (`advancePayment.thresholds`, `advancePayment.followUpWindowSeconds`, `advancePayment.escalationWindowSeconds`), `invoice_templates` (`InvoiceTemplate` model + `proformaInvoice.templates` key), `damage_rate_list` (`damage.rateList`), `payment_follow_up_intervals` (`payment.followUpIntervalDays`), `dispute_gate_function_config`, `fom_override_frequency_threshold` (`dispute.fomOverride.maxFrequency`).
- **Methods:** one `get`/`set` pair per surface plus CRUD on `InvoiceTemplate`. `getAdvancePaymentThresholds()`, `setAdvancePaymentThresholds(input, actorId)`; `listInvoiceTemplates()`, `getInvoiceTemplate(id)`, `createInvoiceTemplate(input, actorId)`, `updateInvoiceTemplate(id, input, actorId)`, `deactivateInvoiceTemplate(id, actorId)`; `getDamageRateList()`, `setDamageRateList(input, actorId)`; `getPaymentFollowUpIntervals()`, `setPaymentFollowUpIntervals(input, actorId)`; `getDisputeGateConfig()`, `setDisputeGateConfig(input, actorId)`; `getFOMOverrideFrequency()`, `setFOMOverrideFrequency(input, actorId)`.
- **Save transaction:** per §6.1.
- **Forbidden:** no deletion of an invoice template referenced by any historical invoice; `followUpWindowSeconds` must be less than `escalationWindowSeconds` (save-time validation).

#### 6.2.20 `OperationalScheduleService` [ACIG-COR-022]

- **Owned surfaces:** `night_audit_schedule` (`nightAudit.scheduleTime`), `night_audit_expected_charges_rules` (`nightAudit.expectedChargesRules`), `checkout_time` (`checkout.cutoffTime`), `room_assignment_priority_rules`.
- **Methods:** one `get`/`set` pair per surface.
- **Save transaction:** per §6.1. `setNightAuditSchedule` validates the cron expression against a cron parser; malformed expressions are rejected. `setNightAuditExpectedChargesRules` validates that every active rate plan has a complete set of expected-charge rules; incomplete rule coverage rejects the save.
- **Forbidden:** no night audit schedule that would prevent the audit from running (validated against the cron semantics).

#### 6.2.21 `VIPNotificationRoutingService` [ACIG-COR-023]

- **Owned surface:** `VipNotificationRoutingConfig`.
- **Methods:** `listRoutings()`, `getRouting(vipTier)`, `saveRouting(vipTier, input, actorId)`, `deactivateRouting(id, actorId)`.
- **Save transaction:** per §6.1. Save validates that every `notifyRole` references a real role identifier and every `notifyActorId` references an active staff member.
- **Forbidden:** no routing entry with no recipients.

#### 6.2.22 `PostStayAndGovernanceService` [ACIG-COR-024]

- **Owned surfaces:** `feedback_survey_templates` (`FeedbackSurveyTemplate` model), `online_review_platform_links` (`feedback.platformLinks`), `government_portal_submission_config` (`government.submissionConfig`), `commission_rate_per_agent_profile` (managed on `AgentProfile` operational records — see below), `commission_calculation_basis_rules` (`commission.calculationBasis`), `identity_document_types`, `identity_document_retention_period` (`identity.retentionPeriodDays`).
- **Methods:** one `get`/`set` pair per surface plus CRUD on `FeedbackSurveyTemplate`. `listFeedbackTemplates()`, `getFeedbackTemplate(id)`, `createFeedbackTemplate(input, actorId)`, `updateFeedbackTemplate(id, input, actorId)`, `deactivateFeedbackTemplate(id, actorId)`; `getPlatformLinks()`, `setPlatformLinks(input, actorId)`; `getGovernmentPortalConfig()`, `setGovernmentPortalConfig(input, actorId)`; `setCommissionRateOnAgentProfile(agentProfileId, rate, actorId)`; `getCommissionBasis()`, `setCommissionBasis(input, actorId)`; `listIdentityDocumentTypes()`, `updateIdentityDocumentTypes(input, actorId)`; `getIdentityRetentionPeriod()`, `setIdentityRetentionPeriod(input, actorId)`.
- **Save transaction:** per §6.1.
- **Note on commission rate:** `commission_rate_per_agent_profile` is a field on the operational `AgentProfile` record, not a configuration table row. Setting it is one of the two carved-out cross-write exceptions enumerated in §6.4. The permission is narrowly scoped: this service may update only the `commissionRate` and `commissionEffectiveFrom` fields on `AgentProfile`, nothing else. An audit event is written in the same transaction. This exception exists because the commission rate is configuration even though its carrier is operational. Every other field on `AgentProfile` remains off-limits to admin services.
- **Forbidden:** no update of `AgentProfile` fields other than `commissionRate` and `commissionEffectiveFrom`. No deletion of a feedback template referenced by any scheduled dispatch.

#### 6.2.23 `OTAConfigurationService` [ACIG-COR-025]

- **Owned surfaces:** `ota_source_flag_config` (`ota.sourceFlagConfig`), `ota.inbox.pollingIntervalSeconds`, `ota_conflict_trigger_rules`, `no_show_cutoff_period` (`noShow.cutoffMinutes`), `no_show_penalty_structure` (`noShow.penaltyStructure`).
- **Methods:** one `get`/`set` pair per surface.
- **Save transaction:** per §6.1. `setNoShowPenaltyStructure` validates that every source/tier combination present in the no-show cutoff configuration has a corresponding penalty entry; incomplete coverage rejects the save.
- **Forbidden:** no partial save of the no-show structure.

#### 6.2.24 `AIAgentConfigService` [ACIG-COR-026]

- **Owned surfaces:** `ai_agent_config` (the AI agent configuration block: LLM credentials, trust levels per category, confidence thresholds, escalation routing, per-channel overrides, correction log max size), `processing_lock_ttl_per_channel` (`processingLock.ttl.perChannel`), `voice_note_review_sla_per_channel`, `voice_note_escalation_routing`.
- **Methods:** `getAIAgentConfig()`, `updateAIAgentConfig(input, actorId)`; `getProcessingLockTTLs()`, `setProcessingLockTTLs(input, actorId)`; `getVoiceNoteSLAs()`, `setVoiceNoteSLAs(input, actorId)`; `getVoiceNoteEscalationRouting()`, `setVoiceNoteEscalationRouting(input, actorId)`.
- **Save transaction:** per §6.1. LLM API credentials are tested for connectivity at save time; a save that produces a connectivity failure is rejected with a descriptive error. Credentials are stored as secrets; the API key is never displayed after initial save. `updateAIAgentConfig` validates that every active intent category has a trust level, a confidence threshold (if the trust level is `AUTO_APPROVE_HIGH_CONFIDENCE`), and an escalation routing tier. `setProcessingLockTTLs` validates that all four channels are present.
- **Forbidden:** no display of LLM API credentials after save; no partial save of AI agent configuration (all six intent categories present on every save); no trust level value outside `ALWAYS_REQUIRE_APPROVAL` / `AUTO_APPROVE_HIGH_CONFIDENCE` / `FULL_AUTO`.

#### 6.2.25 `ConfigurationService` [ACIG-COR-027]

- **Owned surface:** the generic `ConfigurationEntry` table for keys not covered by the domain-specific services above. In practice, this service is the fallback for any dotted-notation key that does not belong to one of the services 6.2.1–6.2.24. Examples of keys owned here by default: `stageDwell.thresholds`, `availability.staleness.ttlSeconds`, `paymentMilestone.scheduleTemplates`, `paymentMilestone.warningOffsetDays`, `ai.confidenceThreshold.autoApprove`, `ai.correctionLog.maximumSize`, `availability.bookablePhysicalStates`, `availability.shadowInventory.visibilityRules`.
- **Methods:** `getConfiguration(key)`, `getConfigurationAt(key, asOf)`, `setConfiguration(key, value, actorId)`, `listConfigurationKeys()`, `listConfigurationHistory(key)`.
- **Save transaction:** per §6.1. The generic `setConfiguration` method looks up the typed validator for the key from a registry. Every dotted-notation key known to the system has a registered validator. A save attempt for an unknown key is rejected with `ValidationError`. A save that passes the key's typed validator runs the `RequiredControlCheck` and writes.
- **Forbidden:** no write to a key without a registered validator; no save of a key whose ownership belongs to a domain-specific service (the domain service's route is the correct path, and the `ConfigurationService` must reject the call). Ownership enforcement is a service-layer responsibility.

#### 6.2.26 `ReadinessService` [ACIG-COR-028]

- **Owned surface:** none. This service is the admin-facing endpoint to the `ReadinessGateEngine`.
- **Methods:** `runReadinessCheck(groups)`, `getLastReadinessReport()`.
- **Save transaction:** not applicable — this service performs no writes.
- **Forbidden:** no write paths of any kind. This service is read-only.

### 6.3 Service Inventory Summary

| # | Service | Correction |
|---|---|---|
| 1 | HotelProfileService | ACIG-COR-003 |
| 2 | DepartmentService | ACIG-COR-004 |
| 3 | StaffService | ACIG-COR-005 |
| 4 | RoleService | ACIG-COR-006 |
| 5 | RoomTypeService | ACIG-COR-007 |
| 6 | RoomInstanceService | ACIG-COR-008 |
| 7 | SpaceInventoryService | ACIG-COR-009 |
| 8 | RatePlanService | ACIG-COR-010 |
| 9 | SeasonService | ACIG-COR-011 |
| 10 | PackageService | ACIG-COR-012 |
| 11 | CommercialThresholdService | ACIG-COR-013 |
| 12 | CancellationPolicyService | ACIG-COR-014 |
| 13 | WorkflowConfigurationService | ACIG-COR-015 |
| 14 | ModeService | ACIG-COR-016 |
| 15 | PolicyRegistryService | ACIG-COR-017 |
| 16 | CommunicationConfigService | ACIG-COR-018 |
| 17 | HandoffTemplateService | ACIG-COR-019 |
| 18 | WorkOrderTemplateService | ACIG-COR-020 |
| 19 | FinancialConfigurationService | ACIG-COR-021 |
| 20 | OperationalScheduleService | ACIG-COR-022 |
| 21 | VIPNotificationRoutingService | ACIG-COR-023 |
| 22 | PostStayAndGovernanceService | ACIG-COR-024 |
| 23 | OTAConfigurationService | ACIG-COR-025 |
| 24 | AIAgentConfigService | ACIG-COR-026 |
| 25 | ConfigurationService | ACIG-COR-027 |
| 26 | ReadinessService | ACIG-COR-028 |

### 6.4 Cross-Service Rules

- **No admin service imports another admin service's write method.** Services may call each other's read methods for validation (e.g., `RoomInstanceService.createRoom()` reads `RoomTypeService.getRoomType()` to validate the type reference). Write methods are not shared.
- **No admin service imports operational services.** Restated for emphasis. This is Policy A1.
- **Operational read for integrity check is permitted.** Example: `DepartmentService.deactivateDepartment()` reads `StaffUser` and `WorkOrder` tables to confirm no active reference. This is a read, not a write, and is not a violation.
- **Two narrow cross-write exceptions** are permitted, each scoped to specific named fields:
  1. `AgentProfile.commissionRate` and `AgentProfile.commissionEffectiveFrom` — written by `PostStayAndGovernanceService.setCommissionRateOnAgentProfile()`. `AgentProfile` is otherwise an operational record; this is the single field-pair an admin service may write on it.
  2. `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` — written by `RoleService.updateSessionConfig()` as a same-transaction snapshot propagation, and by `StaffService.createStaff()` / `StaffService.updateStaff()` (when `roleId` changes) as a snapshot read from the active `RoleSessionConfig`. Both are admin services; the exception exists because `StaffUser` is `StaffService`'s owned surface but the propagation must be atomic with the role config save to avoid stale snapshots. No other field on `StaffUser` is touched by `RoleService`.
- **No third cross-write exception is permitted.** A new cross-service write requires architect deliberation and a formal extension of this rule.

---

## Section 7 — Workers

The Admin Console does not own any background workers. This section is short by design and is included to make the absence explicit — a reader who expects a worker catalogue parallel to the operational SIGs will find this section answering that expectation directly.

### 7.1 No Admin-Owned Workers

No pg-boss job type is owned by an admin service. No background worker writes to a configuration table. No recurring job runs against an admin surface. The admin surface has no scheduled batch processing obligations.

### 7.2 Why This Is Correct

Three realities justify the absence:

1. **Configuration changes are event-driven, not scheduled.** An administrator saves a configuration value when they decide to. There is no time-based trigger that "activates" a configuration change. Effective-from activation is handled at read time by the temporal filter (§3.2), not by a worker that flips a flag at a scheduled moment.

2. **Startup readiness is a startup-time engine, not a worker.** The `ReadinessGateEngine` (§5.1) runs at system bootstrap and on admin-initiated re-validation. It is not a pg-boss job. It executes synchronously in the bootstrap path and synchronously in response to the admin `runReadinessCheck` API call.

3. **Operational workers that consume admin-configured values are operational workers, not admin workers.** The `TimerEngine`, `NightAuditWorker`, `CorrectionLogAggregationWorker`, and every other worker in the system reads configuration values at runtime. The configuration values they read are owned by admin services in Section 6. The workers themselves are owned by the operational layer. No ambiguity exists about which layer the worker belongs to; the writer of the configuration is admin, the reader is operational, and the two layers do not share workers.

### 7.3 Explicit Non-Existence List

For the avoidance of doubt, the following do not exist as workers in the LEGPHEL PMS:

- No `AdminAuditRetentionWorker` — audit event retention is managed by the audit subsystem, not by an admin service.
- No `ConfigurationPropagationWorker` — configuration changes are read directly from the database; no propagation step exists.
- No `ReadinessMonitorWorker` — readiness is checked at startup and on admin demand; it is not monitored continuously.
- No `DefaultValueSeederWorker` — default values are seeded at initialisation by the seed script, which runs once at deployment, not as a recurring job.

### 7.4 Future Worker Decisions

A requirement to introduce a scheduled admin-related job (e.g., a recurring audit of configuration consistency, a scheduled cleanup of expired `ConfigurationEntry` history, a periodic re-validation push) would be a formally scoped extension of this guideline. It is not authorised by this version. Any such addition requires its own decision process and would be integrated into either the admin layer (with a dedicated admin worker catalogue section added to this guideline) or the operational layer (as a new operational worker with admin-owned configuration inputs).

---

## Section 8 — API Routes

This section derives twenty-six admin route groups, one per service in Section 6. Each route group is registered as a finding in the Findings Register for absorption into a future Part 9 revision.

### 8.1 Cross-Cutting Route Rules

The following rules apply uniformly to every admin route. They are stated once here and are not repeated per route group.

- **Route file separation.** Admin routes are registered in `src/admin/routes/*.ts` (or the equivalent under the admin code boundary). Operational routes remain in `src/operations/routes/*.ts` (or equivalent). The two sets do not share a route registration file.
- **Base path prefix.** Every admin route begins with `/admin/`. This prefix is the routing-layer manifestation of the Policy A1 separation.
- **Middleware chain.** The middleware chain for every admin write route is: CORS → auth → `requireL4` → validation → controller handler. For admin read routes: CORS → auth → `requireAdminRead` (which permits the specific read path based on role-permission mapping) → validation → controller handler. Neither `requireL4` nor `requireAdminRead` is optional on any admin route.
- **Response envelope.** Every admin route returns the standard response envelope — success (`success: true, data, meta, requestId`) or typed error (`success: false, error: { type, code, message, context }, requestId`). No admin route returns a naked object, a naked array, or a raw error string.
- **Error types surfaced.** The typed errors most frequently surfaced by admin routes:

| Class | HTTP | When |
|---|---|---|
| `ValidationError` | 400 | Request body, path, or query fails shape validation |
| `AuthorizationError` | 403 | Non-L4 actor attempts an admin write; or non-permitted actor attempts an admin read |
| `NotFoundError` | 404 | Requested configuration record does not exist |
| `ConcurrentEditingError` | 409 | Two concurrent saves on the same surface |
| `ConfigurationViolationError` | 422 | Save would disable a required control, or mode save violates validation |
| `MissingConfigurationError` | 503 | A readiness check surfaces missing configuration |

- **Pagination.** List routes use cursor-based pagination per the system-wide pagination contract. Offset-based pagination is not used.
- **Supersede-vs-delete semantics.** `PATCH` on a configuration surface supersedes via the Section 3 lifecycle: it appends a new row and sets `effectiveTo` (for `ConfigurationEntry`) or `isActive = false` (for registry tables) on the prior row. `DELETE` is reserved for cases where deactivation is the valid semantics (e.g., deactivating a staff member, deactivating a never-activated template). Historical configuration entries are never physically deleted. A `DELETE` request on a surface where deletion is not semantically valid returns `ValidationError` with a message indicating the correct path (`PATCH` to supersede, or `POST` to deactivate via status transition).
- **Forbidden route patterns.** No admin route is permitted to target an operational entity. The following path patterns are explicitly forbidden and must never exist in the admin route registration files:
  - `/admin/inquiries/*`, `/admin/entries/*`, `/admin/segments/*`
  - `/admin/quotations/*`, `/admin/reservations/*`, `/admin/holds/*`
  - `/admin/folios/*`, `/admin/invoices/*`, `/admin/payments/*`
  - `/admin/work-orders/*`, `/admin/handoffs/*`, `/admin/disputes/*`
  - `/admin/communications/*` (for individual communication records — templates are admin; sent communications are operational)
  - `/admin/processing-locks/*`, `/admin/ai-drafts/*`, `/admin/voice-notes/*`
- **Carved-out exceptions.** The following routes target tables that are otherwise operationally owned but are admitted as narrow exceptions per §6.4:
  - `PATCH /admin/agent-profiles/:id/commission-rate` — only `commissionRate` and `commissionEffectiveFrom` fields. Any admin route under `/admin/agent-profiles/*` other than this one is a defect.
  - `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` snapshot propagation occurs internally during `PATCH /admin/roles/:roleId/session-config` and `POST /admin/staff` / `PATCH /admin/staff/:id` — there is no separate admin route for these fields, and they must not be exposed as direct request body fields on the staff routes.

Any admin controller file that imports a route handler for a forbidden pattern is a structural defect detected at Section 10 acceptance review.

### 8.2 Route Groups

Each route group below follows a uniform shape: list, get-one, create (where applicable), supersede/update, deactivate (where applicable). Specific variations per surface are noted.

#### 8.2.1 Hotel Profile Routes [ACIG-COR-029]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/hotel-profile` | Retrieve current hotel profile |
| PATCH | `/admin/hotel-profile` | Update hotel profile (field-level update with audit event) |

No POST (single record); no DELETE.

#### 8.2.2 Department Routes [ACIG-COR-030]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/departments` | List departments (paginated) |
| GET | `/admin/departments/:id` | Retrieve a department |
| POST | `/admin/departments` | Create a new department |
| PATCH | `/admin/departments/:id` | Update a department's fields |
| POST | `/admin/departments/:id/deactivate` | Deactivate a department (action endpoint, not a field update — returns 422 if department has active references) |

#### 8.2.3 Staff Routes [ACIG-COR-031]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/staff` | List staff (paginated) |
| GET | `/admin/staff/:id` | Retrieve a staff record |
| POST | `/admin/staff` | Create a staff record |
| PATCH | `/admin/staff/:id` | Update a staff record (non-PIN fields) |
| POST | `/admin/staff/:id/reset-pin` | Reset staff PIN (request body carries new PIN; response does not echo the PIN) |
| POST | `/admin/staff/:id/deactivate` | Deactivate a staff record |
| GET | `/admin/ai-actor-identity` | Retrieve the AI actor identity |
| PATCH | `/admin/ai-actor-identity` | Update the AI actor identity |

#### 8.2.4 Role Routes [ACIG-COR-032]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/roles` | List roles |
| GET | `/admin/roles/:roleId/permissions` | Retrieve role's permission set |
| PATCH | `/admin/roles/:roleId/permissions` | Update role's permission set |
| GET | `/admin/roles/:roleId/session-config` | Retrieve `RoleSessionConfig` for this role |
| PATCH | `/admin/roles/:roleId/session-config` | Update `RoleSessionConfig` (idle lock timeout, hard logout timeout, manual lock availability — all three together) |

#### 8.2.5 Room Type Routes [ACIG-COR-033]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/room-types` | List room types |
| GET | `/admin/room-types/:id` | Retrieve a room type |
| POST | `/admin/room-types` | Create a room type |
| PATCH | `/admin/room-types/:id` | Update a room type (cosmetic fields update in place; governed fields supersede) |
| POST | `/admin/room-types/:id/deactivate` | Deactivate a room type |

#### 8.2.6 Room Instance Routes [ACIG-COR-034]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/rooms` | List room instances |
| GET | `/admin/rooms/:id` | Retrieve a room instance |
| POST | `/admin/rooms` | Create a room instance |
| PATCH | `/admin/rooms/:id` | Update a room instance |
| POST | `/admin/rooms/:id/deactivate` | Deactivate a room instance |
| GET | `/admin/deficient-condition-categories` | Retrieve DEFICIENT category list |
| PATCH | `/admin/deficient-condition-categories` | Update DEFICIENT category list |
| GET | `/admin/deficient-resolution-deadline` | Retrieve resolution deadline |
| PATCH | `/admin/deficient-resolution-deadline` | Update resolution deadline |

#### 8.2.7 Space Inventory Routes [ACIG-COR-035]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/spaces` | List spaces |
| GET | `/admin/spaces/:id` | Retrieve a space |
| POST | `/admin/spaces` | Create a space |
| PATCH | `/admin/spaces/:id` | Update a space |
| POST | `/admin/spaces/:id/deactivate` | Deactivate a space |

#### 8.2.8 Rate Plan Routes [ACIG-COR-036]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/rate-plans` | List rate plans |
| GET | `/admin/rate-plans/:id` | Retrieve a rate plan |
| POST | `/admin/rate-plans` | Create a rate plan |
| PATCH | `/admin/rate-plans/:id` | Update a rate plan |
| POST | `/admin/rate-plans/:id/deactivate` | Deactivate a rate plan |
| GET | `/admin/rate-plans/:id/override-margin` | Retrieve override margin for a rate plan |
| PATCH | `/admin/rate-plans/:id/override-margin` | Update override margin |
| GET | `/admin/walk-in-rate-plan` | Retrieve the walk-in rate plan designation |
| PATCH | `/admin/walk-in-rate-plan` | Set the walk-in rate plan designation |

#### 8.2.9 Season Routes [ACIG-COR-037]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/seasons` | List seasons |
| GET | `/admin/seasons/:id` | Retrieve a season |
| POST | `/admin/seasons` | Create a season |
| PATCH | `/admin/seasons/:id` | Update a season |
| POST | `/admin/seasons/:id/deactivate` | Deactivate a season |

#### 8.2.10 Package Routes [ACIG-COR-038]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/packages` | List packages |
| GET | `/admin/packages/:id` | Retrieve a package |
| POST | `/admin/packages` | Create a package |
| PATCH | `/admin/packages/:id` | Update a package |
| POST | `/admin/packages/:id/deactivate` | Deactivate a package |

#### 8.2.11 Commercial Threshold Routes [ACIG-COR-039]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/thresholds/discount` | Retrieve discount authority thresholds |
| PATCH | `/admin/thresholds/discount` | Update discount authority thresholds |
| GET | `/admin/thresholds/confirmation-authority` | Retrieve confirmation authority thresholds |
| PATCH | `/admin/thresholds/confirmation-authority` | Update confirmation authority thresholds |
| GET | `/admin/thresholds/overbooking` | Retrieve overbooking limits |
| PATCH | `/admin/thresholds/overbooking` | Update overbooking limits |
| GET | `/admin/thresholds/credit-ceiling` | Retrieve credit ceiling thresholds (all four tiers) |
| PATCH | `/admin/thresholds/credit-ceiling` | Update credit ceiling thresholds |
| GET | `/admin/thresholds/speculative-hold` | Retrieve speculative hold thresholds |
| PATCH | `/admin/thresholds/speculative-hold` | Update speculative hold thresholds |
| GET | `/admin/thresholds/write-off` | Retrieve write-off authority thresholds |
| PATCH | `/admin/thresholds/write-off` | Update write-off authority thresholds |
| GET | `/admin/foc-configuration` | Retrieve FOC configuration |
| PATCH | `/admin/foc-configuration` | Update FOC configuration |

#### 8.2.12 Cancellation Policy Routes [ACIG-COR-040]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/cancellation-policies` | List cancellation policies |
| GET | `/admin/cancellation-policies/:id` | Retrieve a cancellation policy |
| POST | `/admin/cancellation-policies` | Create a cancellation policy |
| PATCH | `/admin/cancellation-policies/:id` | Update a cancellation policy (supersedes) |
| POST | `/admin/cancellation-policies/:id/deactivate` | Deactivate a cancellation policy |

#### 8.2.13 Workflow Configuration Routes [ACIG-COR-041]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/workflow/committed-hold-duration` | Retrieve committed hold duration |
| PATCH | `/admin/workflow/committed-hold-duration` | Update committed hold duration |
| GET | `/admin/workflow/expiry-defaults` | Retrieve expiry defaults |
| PATCH | `/admin/workflow/expiry-defaults` | Update expiry defaults |
| GET | `/admin/workflow/ownership-rules` | Retrieve ownership assignment rules |
| PATCH | `/admin/workflow/ownership-rules` | Update ownership assignment rules |
| GET | `/admin/workflow/billing-model-availability` | Retrieve billing model availability |
| PATCH | `/admin/workflow/billing-model-availability` | Update billing model availability |

#### 8.2.14 Mode Routes [ACIG-COR-042]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/modes` | List modes |
| GET | `/admin/modes/:id` | Retrieve a mode |
| POST | `/admin/modes` | Create a mode (runs `ModeValidationEngine`; fails with 422 on rejection) |
| PATCH | `/admin/modes/:id` | Update a mode (runs `ModeValidationEngine`) |
| POST | `/admin/modes/:id/activate` | Activate a mode (requires L4 GM for custom modes) |
| POST | `/admin/modes/:id/deactivate` | Deactivate a mode |

#### 8.2.15 Policy Registry Routes [ACIG-COR-043]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/policies` | List policies |
| GET | `/admin/policies/:policyId` | Retrieve the active policy |
| GET | `/admin/policies/:policyId/history` | Retrieve version history |
| POST | `/admin/policies/:policyId/versions` | Save a new version (supersedes) |
| POST | `/admin/policies/:policyId/deactivate` | Deactivate a policy |

#### 8.2.16 Communication Config Routes [ACIG-COR-044]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/communication-channels` | List channels |
| GET | `/admin/communication-channels/:id` | Retrieve a channel |
| PATCH | `/admin/communication-channels/:id` | Update a channel (credentials never echoed in response) |
| GET | `/admin/acknowledgement-windows` | Retrieve acknowledgement windows |
| PATCH | `/admin/acknowledgement-windows` | Update acknowledgement windows |
| GET | `/admin/communication-templates` | List templates |
| GET | `/admin/communication-templates/:id` | Retrieve a template |
| POST | `/admin/communication-templates` | Create a template |
| PATCH | `/admin/communication-templates/:id` | Update a template |
| POST | `/admin/communication-templates/:id/deactivate` | Deactivate a template |

#### 8.2.17 Handoff Template Routes [ACIG-COR-045]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/handoff-templates` | List templates (grouped by handoff type) |
| GET | `/admin/handoff-templates/:handoffType` | Retrieve the active template for a handoff type |
| POST | `/admin/handoff-templates/:handoffType/versions` | Save a new version for a handoff type (supersedes) |
| GET | `/admin/handoff-templates/:handoffType/history` | Retrieve version history |

#### 8.2.18 Work Order Template Routes [ACIG-COR-046]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/work-order-templates` | List templates |
| GET | `/admin/work-order-templates/:id` | Retrieve a template |
| POST | `/admin/work-order-templates` | Create a template |
| PATCH | `/admin/work-order-templates/:id` | Update a template |
| POST | `/admin/work-order-templates/:id/deactivate` | Deactivate a template |

#### 8.2.19 Financial Configuration Routes [ACIG-COR-047]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/financial/advance-payment-thresholds` | Retrieve advance payment thresholds |
| PATCH | `/admin/financial/advance-payment-thresholds` | Update advance payment thresholds |
| GET | `/admin/financial/invoice-templates` | List invoice templates |
| GET | `/admin/financial/invoice-templates/:id` | Retrieve an invoice template |
| POST | `/admin/financial/invoice-templates` | Create an invoice template |
| PATCH | `/admin/financial/invoice-templates/:id` | Update an invoice template |
| POST | `/admin/financial/invoice-templates/:id/deactivate` | Deactivate an invoice template |
| GET | `/admin/financial/damage-rate-list` | Retrieve damage rate list |
| PATCH | `/admin/financial/damage-rate-list` | Update damage rate list |
| GET | `/admin/financial/payment-follow-up-intervals` | Retrieve payment follow-up intervals |
| PATCH | `/admin/financial/payment-follow-up-intervals` | Update payment follow-up intervals |
| GET | `/admin/financial/dispute-gate-config` | Retrieve dispute gate configuration |
| PATCH | `/admin/financial/dispute-gate-config` | Update dispute gate configuration |
| GET | `/admin/financial/fom-override-frequency` | Retrieve FOM override frequency threshold |
| PATCH | `/admin/financial/fom-override-frequency` | Update FOM override frequency threshold |

#### 8.2.20 Operational Schedule Routes [ACIG-COR-048]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/schedule/night-audit` | Retrieve night audit schedule |
| PATCH | `/admin/schedule/night-audit` | Update night audit schedule |
| GET | `/admin/schedule/night-audit-expected-charges` | Retrieve expected charges rules |
| PATCH | `/admin/schedule/night-audit-expected-charges` | Update expected charges rules |
| GET | `/admin/schedule/checkout-time` | Retrieve checkout time |
| PATCH | `/admin/schedule/checkout-time` | Update checkout time |
| GET | `/admin/schedule/room-assignment-priority` | Retrieve room assignment priority rules |
| PATCH | `/admin/schedule/room-assignment-priority` | Update room assignment priority rules |

#### 8.2.21 VIP Notification Routing Routes [ACIG-COR-049]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/vip-notification-routings` | List VIP notification routings by tier |
| GET | `/admin/vip-notification-routings/:vipTier` | Retrieve the active routing for a VIP tier |
| POST | `/admin/vip-notification-routings` | Save a routing for a VIP tier |
| POST | `/admin/vip-notification-routings/:id/deactivate` | Deactivate a routing |

#### 8.2.22 Post-Stay and Governance Routes [ACIG-COR-050]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/feedback-survey-templates` | List feedback templates |
| GET | `/admin/feedback-survey-templates/:id` | Retrieve a feedback template |
| POST | `/admin/feedback-survey-templates` | Create a feedback template |
| PATCH | `/admin/feedback-survey-templates/:id` | Update a feedback template |
| POST | `/admin/feedback-survey-templates/:id/deactivate` | Deactivate a feedback template |
| GET | `/admin/review-platform-links` | Retrieve review platform links |
| PATCH | `/admin/review-platform-links` | Update review platform links |
| GET | `/admin/government-portal-config` | Retrieve government portal submission configuration |
| PATCH | `/admin/government-portal-config` | Update government portal submission configuration |
| PATCH | `/admin/agent-profiles/:id/commission-rate` | Update an agent profile's commission rate (narrowly scoped — only `commissionRate` and `commissionEffectiveFrom`) |
| GET | `/admin/commission-basis` | Retrieve commission calculation basis |
| PATCH | `/admin/commission-basis` | Update commission calculation basis |
| GET | `/admin/identity-document-types` | Retrieve identity document types |
| PATCH | `/admin/identity-document-types` | Update identity document types |
| GET | `/admin/identity-retention-period` | Retrieve identity retention period |
| PATCH | `/admin/identity-retention-period` | Update identity retention period |

#### 8.2.23 OTA Configuration Routes [ACIG-COR-051]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/ota/source-flags` | Retrieve OTA source flag configuration |
| PATCH | `/admin/ota/source-flags` | Update OTA source flag configuration |
| GET | `/admin/ota/inbox-polling-interval` | Retrieve OTA inbox polling interval |
| PATCH | `/admin/ota/inbox-polling-interval` | Update OTA inbox polling interval |
| GET | `/admin/ota/conflict-rules` | Retrieve OTA conflict trigger rules |
| PATCH | `/admin/ota/conflict-rules` | Update OTA conflict trigger rules |
| GET | `/admin/no-show/cutoff-period` | Retrieve no-show cutoff period |
| PATCH | `/admin/no-show/cutoff-period` | Update no-show cutoff period |
| GET | `/admin/no-show/penalty-structure` | Retrieve no-show penalty structure |
| PATCH | `/admin/no-show/penalty-structure` | Update no-show penalty structure |

#### 8.2.24 AI Agent Configuration Routes [ACIG-COR-052]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/ai-agent-config` | Retrieve AI agent configuration (credentials never echoed) |
| PATCH | `/admin/ai-agent-config` | Update AI agent configuration (tests connectivity; rejects on failure) |
| GET | `/admin/processing-lock-ttls` | Retrieve processing lock TTLs |
| PATCH | `/admin/processing-lock-ttls` | Update processing lock TTLs (all four channels atomic) |
| GET | `/admin/voice-note-slas` | Retrieve voice note SLAs per channel |
| PATCH | `/admin/voice-note-slas` | Update voice note SLAs per channel |
| GET | `/admin/voice-note-escalation-routing` | Retrieve voice note escalation routing |
| PATCH | `/admin/voice-note-escalation-routing` | Update voice note escalation routing |

#### 8.2.25 Generic Configuration Routes [ACIG-COR-053]

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/configuration/:key` | Retrieve a configuration value by key (404 if unknown) |
| GET | `/admin/configuration/:key/at` | Retrieve historical value at a given `asOf` timestamp |
| PATCH | `/admin/configuration/:key` | Save a new value for a key (rejects keys owned by domain-specific services) |
| GET | `/admin/configuration/:key/history` | Retrieve history for a key |
| GET | `/admin/configuration` | List registered keys |

#### 8.2.26 Readiness Routes [ACIG-COR-054]

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/readiness/check` | Run readiness check (body: optional `groups` filter) |
| GET | `/admin/readiness/last-report` | Retrieve the last stored readiness report |

### 8.3 UI Contract Subsection

This subsection specifies the three UI contract requirements that apply across every admin route. These are implementation requirements, not design preferences.

#### 8.3.1 Default-Value Indicator Placement

Every admin UI surface that renders a configurable value displays a non-intrusive indicator when the rendered value is a seeded default that has not been consciously reviewed and saved by an administrator.

- **Placement convention:** inline adjacent to the field. Not a popup, not a modal, not an overlay.
- **Mechanism examples:** a muted label ("system default"), a small icon marker, a distinct background styling state, a subtle text marker. The specific CSS/component choice is an implementation decision. The constraint is non-intrusive and visible at a glance.
- **State transition:** the indicator disappears or transitions to "reviewed" state on first administrator save of that surface. The transition is immediate — no refresh required.
- **Signal from API:** the API response envelope for a GET on any admin surface includes, alongside the value, a discriminator indicating whether the current value is a seeded default or an administrator-reviewed value. The discriminator is derived from `ConfigurationEntry.setBy` or the registry row's `createdBy` — if the value is `'SYSTEM_SEED'` (or the deployment's canonical seed actor identifier), the discriminator is `true` (is-default); otherwise `false`.

#### 8.3.2 Validation Error Surfacing

Admin routes surface two typed validation errors with structured context payloads.

- **`ConfigurationViolationError` (HTTP 422).** Carries:
  - `control` — the control the save would violate (policy name, state machine transition, service dependency, or "required control" identifier)
  - `requirement` — human-readable description of what the control enforces
  - `proposedChange` — the submitted configuration values that triggered the rejection
- **`MissingConfigurationError` (HTTP 503).** Returned by the readiness check and by operational routes that encounter missing configuration at runtime. Carries:
  - `missingConfigurationSurface` — canonical surface name
  - `stageGroup` — which readiness group is blocked
  - `consequence` — what operational behaviour is not available

These error payloads are consumed directly by the Admin Console UI to render actionable error surfaces. The UI shows the specific control / surface that failed and the corrective action required. Generic error messages ("save failed, please try again") are not acceptable outputs for these typed errors.

#### 8.3.3 Supersede-vs-Delete Semantics

- **`PATCH` on a configuration surface.** Supersedes via the Section 3 lifecycle. Appends a new row; sets `effectiveTo` (for `ConfigurationEntry`) or `isActive = false` (for registry tables) on the prior row; emits an audit event. The prior value is retained as history.
- **`DELETE` on a configuration surface.** Reserved for narrow cases where deletion is semantically valid — specifically, deactivation of records that can be deactivated through a dedicated action endpoint (staff, departments, rate plans, packages, templates, etc.) is expressed as `POST /admin/{surface}/:id/deactivate`, not as `DELETE`. Physical DELETE of a configuration row is permitted only for never-activated registry rows that have no operational references and no historical audit significance. In practice, this is nearly never the correct path. The UI does not expose `DELETE` as a primary action on any configuration surface.
- **Historical entries are never physically deleted.** A superseded `ConfigurationEntry`, a superseded policy version, a deactivated registry row all remain in the database as read-only history.

---

## Section 9 — Configuration Key Meta-Registry

This section consolidates the full dotted-notation configuration key registry into a single ground-truth list, grouped by surface category, with the owning admin service named for each key. Every operational stage's Configuration Keys section (in SIG-S1 through SIG-S9) must find every key it reads listed here with a clearly named owner.

Keys appear in dotted notation throughout. Flat key names are not permitted.

### 9.1 Expiry and Timer Keys

| configKey | Type | Owning service |
|---|---|---|
| `expiry.s1.defaultTtlSeconds` | Integer | WorkflowConfigurationService |
| `expiry.s2.quotationValidityDays` | Integer | WorkflowConfigurationService |
| `expiry.s2.speculativeHoldTtlSeconds` | Integer | WorkflowConfigurationService |
| `expiry.s3.committedHoldTtlSeconds` | Integer | WorkflowConfigurationService |
| `acknowledgement.windowPerType` | Json (all types: quotation, pi, voucher, preArrival, amendment, cancellation, invoice) | CommunicationConfigService |

### 9.2 Availability and Inventory Keys

| configKey | Type | Owning service |
|---|---|---|
| `availability.staleness.ttlSeconds` | Integer | ConfigurationService |
| `availability.shadowInventory.visibilityRules` | Json | ConfigurationService |
| `availability.bookablePhysicalStates` | Json | ConfigurationService |
| `availability.walkIn.ratePlanId` | String | RatePlanService |
| `deficientCondition.categories` | Json | RoomInstanceService |

### 9.3 Ownership, Assignment, and OTA

| configKey | Type | Owning service |
|---|---|---|
| `ownership.assignmentRules` | Json | WorkflowConfigurationService |
| `ota.sourceFlagConfig` | Json | OTAConfigurationService |
| `ota.inbox.pollingIntervalSeconds` | Integer | OTAConfigurationService |

### 9.4 Processing Lock Keys

| configKey | Type | Owning service |
|---|---|---|
| `processingLock.ttl.perChannel` | Json (all four channels: EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE) | AIAgentConfigService |

### 9.5 Discount and Commercial Authority Keys

| configKey | Type | Owning service |
|---|---|---|
| `discount.fom.maxPercentage` | Decimal | CommercialThresholdService |
| `discount.gm.maxPercentage` | Decimal | CommercialThresholdService |

### 9.6 Financial Keys

| configKey | Type | Owning service |
|---|---|---|
| `advancePayment.thresholds` | Json | FinancialConfigurationService |
| `advancePayment.followUpWindowSeconds` | Integer | FinancialConfigurationService |
| `advancePayment.escalationWindowSeconds` | Integer | FinancialConfigurationService |
| `billingModel.availablePerSource` | Json | WorkflowConfigurationService |
| `cancellation.policyTiers` | Json | CancellationPolicyService |
| `foc.configuration` | Json | CommercialThresholdService |
| `proformaInvoice.templates` | Json | FinancialConfigurationService |
| `creditCeiling.clientTier.thresholds` | Json (all tiers: standard, preferred, caution, restricted) | CommercialThresholdService |
| `creditCeiling.proximityThresholds` | Json | CommercialThresholdService |
| `overbooking.maxAllowedRooms` | Integer | CommercialThresholdService |
| `paymentMilestone.scheduleTemplates` | Json | ConfigurationService |
| `paymentMilestone.warningOffsetDays` | Integer | ConfigurationService |

### 9.7 No-Show and Identity Keys

| configKey | Type | Owning service |
|---|---|---|
| `noShow.cutoffMinutes` | Integer | OTAConfigurationService |
| `noShow.penaltyStructure` | Json | OTAConfigurationService |
| `identity.retentionPeriodDays` | Json (by document type) | PostStayAndGovernanceService |

### 9.8 Operational Schedule Keys

| configKey | Type | Owning service |
|---|---|---|
| `nightAudit.scheduleTime` | String (cron expression) | OperationalScheduleService |
| `nightAudit.expectedChargesRules` | Json | OperationalScheduleService |
| `checkout.cutoffTime` | String (HH:MM) | OperationalScheduleService |

### 9.9 Damage, Dispute, and Post-Stay Keys

| configKey | Type | Owning service |
|---|---|---|
| `damage.rateList` | Json | FinancialConfigurationService |
| `dispute.fomOverride.maxFrequency` | Integer | FinancialConfigurationService |
| `payment.followUpIntervalDays` | Integer | FinancialConfigurationService |
| `commission.calculationBasis` | String | PostStayAndGovernanceService |
| `feedback.platformLinks` | Json | PostStayAndGovernanceService |
| `government.submissionConfig` | Json | PostStayAndGovernanceService |

### 9.10 Stage Dwell Keys

| configKey | Type | Owning service |
|---|---|---|
| `stageDwell.thresholds` | Json (all 9 stages × 3 dwell modes) | ConfigurationService |

**Session management note.** Per-role session timeouts (`idleLockTimeoutSeconds`, `hardLogoutTimeoutSeconds`, `manualLockAvailable`) are not `ConfigurationEntry` keys. They are stored in the `RoleSessionConfig` table (§2.1A.5), one row per role, owned by `RoleService`. Operational reads use `StaffUser.idleThresholdSeconds` and `StaffUser.hardLogoutThresholdSeconds` (snapshot fields populated from `RoleSessionConfig` at staff-create time and at every role-config save).

### 9.11 AI Agent Keys

| configKey | Type | Owning service |
|---|---|---|
| `ai.confidenceThreshold.autoApprove` | Decimal | ConfigurationService |
| `ai.correctionLog.maximumSize` | Integer | ConfigurationService |

### 9.12 Key Ownership Enforcement

Every dotted-notation key above has exactly one owning admin service. The `ConfigurationService.setConfiguration(key, value, actorId)` method must reject any attempt to write a key whose owner is a domain-specific service — the caller must use the domain-specific service's route instead. This enforcement lives at the service layer and is verified at Section 10 acceptance review.

A configKey appearing in any SIG-S1 through SIG-S9 Configuration Keys section that is not listed above is a completeness gap requiring surfacing. The self-check pass for this guideline (§ Section 11) cross-references every prior SIG's configKey set against this table.

---

## Section 10 — Acceptance Criteria

The acceptance criteria below are testable assertions. Each is expressible as a unit test, integration test, or verification script against the admin code layer. A failing assertion is a structural defect and blocks acceptance of the delivery that introduced it.

Acceptance criteria are grouped by area. Each area maps to the structural guarantees the Admin Console must provide.

### 10.1 Schema Acceptance

**AC-S-1.** Every Prisma model owned by the Admin Console exists in the compiled schema file. Direct string match on `model {ModelName} {` succeeds for each of: `ConfigurationEntry`, `PolicyRegistry`, `HotelProfile`, `Department`, `Role`, `RolePermissionMapping`, `RoleSessionConfig`, `AiActorIdentity`, `ModeConfiguration`, `RoomTypeRegistry`, `CancellationPolicyRegistry`, `HandoffChecklistTemplate`, `WorkOrderTemplate`, `CommunicationTemplate`, `InvoiceTemplate`, `FeedbackSurveyTemplate`, `VipNotificationRoutingConfig`. (Models defined in DEV-SPEC-001 Part 2 — `StaffUser`, `RatePlan`, `SeasonCalendar`, `PackageRegistry`, `Room`, `Space`, `AgentProfile` — are written to or referenced by Admin Console services but are not duplicated in §2 since their schemas are sourced from Part 2.)

**AC-S-1a.** Every admin-owned registry model in §2.1A and §2.2 carries a `version Int @default(1)` field for optimistic locking. Direct schema inspection confirms presence in: `HotelProfile`, `Department`, `Role`, `RolePermissionMapping`, `RoleSessionConfig`, `AiActorIdentity`, `ModeConfiguration`, `RoomTypeRegistry`, `CancellationPolicyRegistry`, `HandoffChecklistTemplate`, `WorkOrderTemplate`, `CommunicationTemplate`, `InvoiceTemplate`, `FeedbackSurveyTemplate`, `VipNotificationRoutingConfig`, and on `PolicyRegistry`.

**AC-S-1b.** `PolicyRegistry` carries `@@unique([policyId, version])` and not `policyId @unique`. Schema inspection confirms.

**AC-S-1c.** `ModeConfiguration` carries `@@unique([modeKey, version])` and the `ModeLifecycleState` enum is defined with exactly four members: `DRAFT`, `VALIDATED`, `ACTIVE`, `SUPERSEDED`. Schema inspection confirms.

**AC-S-2.** `ConfigurationEntry` carries `configKey`, `configValue`, `effectiveFrom`, `effectiveTo?`, `setBy`, `setAt`. `setBy` is `NOT NULL`.

**AC-S-3.** No configuration table carries a `tenantId` or `propertyId` field. Schema-level search for these field names returns zero matches in the configuration tables directory.

**AC-S-4.** No foreign key from a configuration table references an operational record identifier. Schema-level search for foreign keys into `Entry`, `Folio`, `Inquiry`, `Reservation`, `Invoice`, `WorkOrder`, `CommunicationRecord` from within configuration tables returns zero matches.

**AC-S-5.** Every `configKey` listed in Section 9 is in dotted notation. No flat key name (e.g., `expiry_s1_default_ttl_seconds`) appears in the Section 9 registry or in any seed script that populates `ConfigurationEntry` rows.

### 10.2 Service Acceptance

**AC-SV-1.** Every service listed in Section 6.3 exists as a named class in the admin code layer. Direct filesystem inspection produces one file per service, each containing the class definition.

**AC-SV-2.** Every admin service's write method opens a Prisma `$transaction` and performs both the configuration write and the audit event write within the callback. Code inspection of each write method confirms the `$transaction(async (tx) => { ... })` wrapper contains both writes.

**AC-SV-3.** No admin service imports from an operational service directory. Import-statement scan of every file under the admin code boundary returns zero imports from the operational code boundary, with the single exception of the permitted `AgentProfile.commissionRate` narrow-scope write path in `PostStayAndGovernanceService`.

**AC-SV-4.** The `RequiredControlCheck` helper is invoked by every admin service write method before the write. Code inspection confirms the call precedes the Prisma write in every write method.

**AC-SV-5.** `ModeService.save()` and `ModeService.activate()` invoke `ModeValidationEngine.validate()` before persisting. Code inspection confirms the invocation; bypassing the engine is a gate failure.

**AC-SV-6.** `StaffService` PIN operations never return the plaintext PIN in any response. Response shape inspection confirms no PIN field in `createStaff` or `resetPin` responses.

**AC-SV-7.** `CommunicationConfigService.updateChannel()` and `AIAgentConfigService.updateAIAgentConfig()` never return stored secret values. Response shape inspection confirms secret fields are absent from responses.

**AC-SV-8.** `ConfigurationService.setConfiguration()` rejects any key whose ownership belongs to a domain-specific service. Unit test: attempt to set `discount.fom.maxPercentage` via `ConfigurationService` and confirm rejection with a service-ownership error.

**AC-SV-9.** Every save transaction produces exactly one audit event per save. Integration test: perform a save, query `TraceEvent` for the generated `requestId`, confirm exactly one row with the correct `surfaceModified`, `fieldsChanged`, and `actorId`.

**AC-SV-10.** A save transaction that fails at any step rolls back both the configuration write and the audit event. Integration test: force the audit event write to throw; confirm the configuration write does not persist.

### 10.3 Policy Acceptance

**AC-P-1.** A write attempt by a non-L4 actor is rejected with `AuthorizationError` before reaching the service method. Integration test per route group: attempt a write as L1, L2, L3 actors and confirm 403 rejection at the middleware layer.

**AC-P-2.** Default-value indicator is rendered on every admin UI surface. Visual regression test: for each admin UI screen, render a surface backed by a seeded default value and confirm the indicator appears; re-save the value as an L4 actor and confirm the indicator transitions.

**AC-P-3.** A mode save that violates any of the three constraint categories is rejected with `ConfigurationViolationError` at 422. Unit test per category: construct a mode save that violates (a) a policy, (b) a state machine transition, (c) a service dependency — confirm rejection for each.

**AC-P-4.** A configuration save that would disable a required control is rejected with `ConfigurationViolationError` at 422. Unit test: attempt to set `expiry.s3.committedHoldTtlSeconds = 0` — confirm rejection with `control = 'timer_engine'`.

**AC-P-5.** No admin controller creates an operational record. Controller code inspection: for each admin controller, confirm absence of any Prisma create call against an operational model (excepting the narrow `AgentProfile.commissionRate` path).

### 10.4 Route Acceptance

**AC-R-1.** Every admin route registered in the admin route files begins with `/admin/`. Route manifest inspection confirms all 26 route groups' paths share the prefix.

**AC-R-2.** Every admin write route has `requireL4` middleware registered before the controller handler. Route registration inspection confirms the middleware is present; a route registered without it is a gate failure.

**AC-R-3.** Every admin read route has `requireAdminRead` (or `requireL4` for L4-only reads) middleware registered. Route registration inspection confirms.

**AC-R-4.** No admin route targets a forbidden operational entity pattern. Route manifest inspection against the Section 8.1 forbidden-patterns list returns zero matches.

**AC-R-5.** Every admin route returns the standard response envelope. Integration test per route: confirm success responses carry `{ success: true, data, meta, requestId }` and error responses carry `{ success: false, error: { type, code, message, context }, requestId }`.

**AC-R-6.** `ConfigurationViolationError` responses at 422 carry the three-field context payload (`control`, `requirement`, `proposedChange`). Integration test per admin write route: provoke a violation and confirm the context shape.

**AC-R-7.** `MissingConfigurationError` responses at 503 carry the three-field context payload (`missingConfigurationSurface`, `stageGroup`, `consequence`). Integration test: invoke `/admin/readiness/check` against a deliberately incomplete configuration state and confirm the response shape.

### 10.5 Readiness Acceptance

**AC-RD-1.** Startup does not declare operational readiness until `ReadinessGateEngine` runs and reports no failures. Integration test: start the system with a missing `hotel_profile` — confirm the readiness log surfaces `MissingConfigurationError` naming `hotel_profile` and `S1_READINESS`.

**AC-RD-2.** `ReadinessGateEngine` collects every failure across every group rather than halting at the first. Integration test: start with three missing surfaces across two groups — confirm all three appear in the returned failure list.

**AC-RD-3.** No operational service substitutes a hardcoded default value for a missing configuration. Code inspection of every operational service that reads configuration: confirm that a missing `ConfigurationEntry` throws `MissingConfigurationError` rather than returning a fallback value.

**AC-RD-4.** Admin re-validation endpoint (`POST /admin/readiness/check`) returns a report identical in shape to the startup report. Integration test: mutate configuration, invoke re-validation, confirm the report shape and content.

### 10.6 Temporal Acceptance

**AC-T-1.** A `ConfigurationEntry` row is never updated in place for its `configValue`. Code inspection of every admin service write method: confirm every `configValue` change produces a supersession (new row insert + prior row `effectiveTo` set), never a direct `UPDATE configurationEntry SET configValue = ...`.

**AC-T-2.** At any moment, at most one `ConfigurationEntry` row per `configKey` has `effectiveTo = NULL`. Database integrity check: `SELECT configKey, COUNT(*) FROM configuration_entries WHERE effectiveTo IS NULL GROUP BY configKey HAVING COUNT(*) > 1` returns zero rows.

**AC-T-3.** Operational code reads `ConfigurationEntry` through the temporal filter. Code inspection of every operational service that reads a configKey: confirm the `WHERE effectiveFrom <= NOW() AND (effectiveTo IS NULL OR effectiveTo > NOW())` predicate is applied.

**AC-T-4.** Historical configuration reads for temporal audit work identically to current reads with `asOf` substituted. Integration test: write two superseding `ConfigurationEntry` rows; query at a historical timestamp; confirm the query returns the row that was active at that moment.

### 10.7 Concurrency Acceptance

**AC-C-1.** Two concurrent saves to the same `ConfigurationEntry` key do not both succeed. Integration test: open two admin sessions; save the same key from both within the same millisecond; confirm exactly one save succeeds and the other returns `ConcurrentEditingError`.

**AC-C-2.** Two concurrent saves to the same registry row do not both succeed. Same test against a `RoomTypeRegistry` row.

### 10.8 Policy-to-Assertion Map

The table below confirms that every Section 4 policy is covered by at least one Section 10 assertion.

| Policy | Assertion(s) |
|---|---|
| A1 Separation | AC-SV-3, AC-P-5, AC-R-4 |
| A2 Audit on save | AC-SV-2, AC-SV-9, AC-SV-10 |
| A3 Default indicator | AC-P-2 |
| A4 Mode save validation | AC-SV-5, AC-P-3 |
| A5 Required control | AC-SV-4, AC-P-4 |
| A6 Single-tenant | AC-S-3, AC-S-4 |
| A7 L4 authority | AC-P-1, AC-R-2, AC-R-3 |

---

## Section 11 — Findings Register

This section enumerates every finding surfaced during ACIG generation (v1.0 baseline plus the v1.1 review pass). Each finding is registered for absorption into a future revision of the relevant DEV-SPEC Part. Findings are not blocking — the implementation guideline is internally complete and self-sufficient as written. Findings are recorded so that the DEV-SPEC layer can be brought into alignment in a planned revision pass.

All findings are sourced positively from the ACIG body. Each is a derivation that this guideline made because the source DEV-SPEC layer did not yet contain it. Each is registered in MCL v2.4 in the next session.

### 11.1 Findings Table

| ID | Type | Target | Description | Status |
|---|---|---|---|---|
| ACIG-COR-001 | NEW-CONTENT | DEV-SPEC-001 Part 4 | `ReadinessGateEngine` derived in ACIG §5.1. Engine evaluates all required configuration surfaces per readiness group at startup and on demand; collects all failures across all groups; returns `MissingConfigurationError` per failure. Currently absent from Part 4 §§4.2–4.12. | PENDING |
| ACIG-COR-002 | NEW-CONTENT | DEV-SPEC-001 Part 4 | `ModeValidationEngine` derived in ACIG §5.2. Engine validates proposed mode configurations against three constraint categories (policy, state machine, service dependency) at save time; returns `ACCEPTED` or `REJECTED` with a specific violation list. Currently absent from Part 4 §§4.2–4.12. | PENDING |
| ACIG-COR-003 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `HotelProfileService` derived in ACIG §6.2.1. Service owns the `hotel_profile` single-record surface; exposes `getHotelProfile()` and `updateHotelProfile()`. Currently absent from Part 6. | PENDING |
| ACIG-COR-004 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `DepartmentService` derived in ACIG §6.2.2. Service owns `department_registry`; exposes list/get/create/update/deactivate methods with referential integrity check on deactivation. Currently absent from Part 6. | PENDING |
| ACIG-COR-005 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `StaffService` derived in ACIG §6.2.3. Service owns `staff_registry` and `ai_actor_identity`; exposes CRUD plus PIN reset. Currently absent from Part 6. | PENDING |
| ACIG-COR-006 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `RoleService` derived in ACIG §6.2.4. Service owns `role_permission_mappings` and `session_management_config`; exposes role permission management and per-role session config CRUD. Currently absent from Part 6. | PENDING |
| ACIG-COR-007 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `RoomTypeService` derived in ACIG §6.2.5. Service owns `RoomTypeRegistry`; exposes CRUD plus deactivation with referential integrity. Currently absent from Part 6. | PENDING |
| ACIG-COR-008 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `RoomInstanceService` derived in ACIG §6.2.6. Service owns `room_instance_registry`, `deficient_condition_categories`, and `deficient_resolution_deadline`. Currently absent from Part 6. | PENDING |
| ACIG-COR-009 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `SpaceInventoryService` derived in ACIG §6.2.7. Service owns `space_inventory`. Currently absent from Part 6. | PENDING |
| ACIG-COR-010 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `RatePlanService` derived in ACIG §6.2.8. Service owns `rate_plan_registry`, `override_margin_per_rate_plan`, and the walk-in rate plan designation. Currently absent from Part 6. | PENDING |
| ACIG-COR-011 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `SeasonService` derived in ACIG §6.2.9. Service owns `season_calendar` with overlap-rejection save validation. Currently absent from Part 6. | PENDING |
| ACIG-COR-012 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `PackageService` derived in ACIG §6.2.10. Service owns `package_registry`. Currently absent from Part 6. | PENDING |
| ACIG-COR-013 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `CommercialThresholdService` derived in ACIG §6.2.11. Service owns discount thresholds, FOC configuration, confirmation authority thresholds, overbooking limits, credit ceiling thresholds, speculative hold thresholds, and write-off authority thresholds. Currently absent from Part 6. | PENDING |
| ACIG-COR-014 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `CancellationPolicyService` derived in ACIG §6.2.12. Service owns `CancellationPolicyRegistry` and `cancellation.policyTiers` keyed mirror with tier consistency validation. Currently absent from Part 6. | PENDING |
| ACIG-COR-015 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `WorkflowConfigurationService` derived in ACIG §6.2.13. Service owns committed hold duration, expiry defaults, ownership assignment rules, and billing model availability. Currently absent from Part 6. | PENDING |
| ACIG-COR-016 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `ModeService` derived in ACIG §6.2.14. Service owns `mode_configurations`; mandatory `ModeValidationEngine` invocation on save and activate. Currently absent from Part 6. | PENDING |
| ACIG-COR-017 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `PolicyRegistryService` derived in ACIG §6.2.15. Service owns `PolicyRegistry`; supersession-only via `version + 1`. Currently absent from Part 6. | PENDING |
| ACIG-COR-018 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `CommunicationConfigService` derived in ACIG §6.2.16. Service owns `communication_channel_config`, `acknowledgement_window_per_type`, and `CommunicationTemplate`; credentials never echoed; token validation on save. Currently absent from Part 6. | PENDING |
| ACIG-COR-019 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `HandoffTemplateService` derived in ACIG §6.2.17. Service owns `HandoffChecklistTemplate`; supersession via `(handoffType, version)`. Currently absent from Part 6. | PENDING |
| ACIG-COR-020 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `WorkOrderTemplateService` derived in ACIG §6.2.18. Service owns `WorkOrderTemplate`. Currently absent from Part 6. | PENDING |
| ACIG-COR-021 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `FinancialConfigurationService` derived in ACIG §6.2.19. Service owns advance payment thresholds, `InvoiceTemplate`, damage rate list, payment follow-up intervals, dispute gate config, and FOM override frequency threshold. Currently absent from Part 6. | PENDING |
| ACIG-COR-022 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `OperationalScheduleService` derived in ACIG §6.2.20. Service owns night audit schedule, night audit expected charges rules, checkout time, and room assignment priority rules. Currently absent from Part 6. | PENDING |
| ACIG-COR-023 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `VIPNotificationRoutingService` derived in ACIG §6.2.21. Service owns `VipNotificationRoutingConfig`. Currently absent from Part 6. | PENDING |
| ACIG-COR-024 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `PostStayAndGovernanceService` derived in ACIG §6.2.22. Service owns `FeedbackSurveyTemplate`, review platform links, government portal config, commission calculation basis, identity document types, and identity retention period; narrowly scoped `AgentProfile.commissionRate` write exception. Currently absent from Part 6. | PENDING |
| ACIG-COR-025 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `OTAConfigurationService` derived in ACIG §6.2.23. Service owns OTA source flag config, OTA inbox polling interval, OTA conflict trigger rules, no-show cutoff period, and no-show penalty structure. Currently absent from Part 6. | PENDING |
| ACIG-COR-026 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `AIAgentConfigService` derived in ACIG §6.2.24. Service owns AI agent configuration block, processing lock TTLs per channel, voice note SLAs per channel, and voice note escalation routing; LLM credential test on save. Currently absent from Part 6. | PENDING |
| ACIG-COR-027 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `ConfigurationService` derived in ACIG §6.2.25. Generic keyed CRUD over `ConfigurationEntry` for keys not owned by domain-specific services; rejects writes to keys whose ownership belongs elsewhere. Currently absent from Part 6. | PENDING |
| ACIG-COR-028 | NEW-CONTENT | DEV-SPEC-001 Part 6 | `ReadinessService` derived in ACIG §6.2.26. Admin-facing endpoint to `ReadinessGateEngine`; read-only. Currently absent from Part 6. | PENDING |
| ACIG-COR-029 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Hotel Profile route group derived in ACIG §8.2.1. Two routes (GET, PATCH) under `/admin/hotel-profile`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-030 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Department route group derived in ACIG §8.2.2. Five routes under `/admin/departments`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-031 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Staff route group derived in ACIG §8.2.3. Eight routes under `/admin/staff` and `/admin/ai-actor-identity`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-032 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Role route group derived in ACIG §8.2.4. Five routes under `/admin/roles`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-033 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Room Type route group derived in ACIG §8.2.5. Five routes under `/admin/room-types`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-034 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Room Instance route group derived in ACIG §8.2.6. Nine routes under `/admin/rooms`, `/admin/deficient-condition-categories`, and `/admin/deficient-resolution-deadline`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-035 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Space Inventory route group derived in ACIG §8.2.7. Five routes under `/admin/spaces`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-036 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Rate Plan route group derived in ACIG §8.2.8. Nine routes under `/admin/rate-plans` and `/admin/walk-in-rate-plan`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-037 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Season route group derived in ACIG §8.2.9. Five routes under `/admin/seasons`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-038 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Package route group derived in ACIG §8.2.10. Five routes under `/admin/packages`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-039 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Commercial Threshold route group derived in ACIG §8.2.11. Fourteen routes under `/admin/thresholds/*` and `/admin/foc-configuration`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-040 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Cancellation Policy route group derived in ACIG §8.2.12. Five routes under `/admin/cancellation-policies`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-041 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Workflow Configuration route group derived in ACIG §8.2.13. Eight routes under `/admin/workflow/*`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-042 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Mode route group derived in ACIG §8.2.14. Six routes under `/admin/modes`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-043 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Policy Registry route group derived in ACIG §8.2.15. Five routes under `/admin/policies`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-044 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Communication Config route group derived in ACIG §8.2.16. Ten routes under `/admin/communication-channels`, `/admin/acknowledgement-windows`, and `/admin/communication-templates`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-045 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Handoff Template route group derived in ACIG §8.2.17. Four routes under `/admin/handoff-templates`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-046 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Work Order Template route group derived in ACIG §8.2.18. Five routes under `/admin/work-order-templates`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-047 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Financial Configuration route group derived in ACIG §8.2.19. Fifteen routes under `/admin/financial/*`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-048 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Operational Schedule route group derived in ACIG §8.2.20. Eight routes under `/admin/schedule/*`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-049 | NEW-CONTENT | DEV-SPEC-001 Part 9 | VIP Notification Routing route group derived in ACIG §8.2.21. Four routes under `/admin/vip-notification-routings`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-050 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Post-Stay and Governance route group derived in ACIG §8.2.22. Sixteen routes covering feedback templates, review platform links, government portal config, agent commission rate, commission basis, identity document types, and identity retention period. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-051 | NEW-CONTENT | DEV-SPEC-001 Part 9 | OTA Configuration route group derived in ACIG §8.2.23. Ten routes under `/admin/ota/*` and `/admin/no-show/*`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-052 | NEW-CONTENT | DEV-SPEC-001 Part 9 | AI Agent Configuration route group derived in ACIG §8.2.24. Eight routes under `/admin/ai-agent-config`, `/admin/processing-lock-ttls`, `/admin/voice-note-slas`, and `/admin/voice-note-escalation-routing`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-053 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Generic Configuration route group derived in ACIG §8.2.25. Five routes under `/admin/configuration`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-054 | NEW-CONTENT | DEV-SPEC-001 Part 9 | Readiness route group derived in ACIG §8.2.26. Two routes under `/admin/readiness`. Currently absent from Part 9 §9.4. | PENDING |
| ACIG-COR-055 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `HotelProfile` Prisma model derived in ACIG §2.1A.1. Single-record model owning hotel name, registered address, trading address, contact numbers, primary email, operating hours, public holiday schedule, IANA timezone, and ISO 4217 property currency. Field-level requirements sourced from DEV-SPEC-001 Part 12 §12.2.1. Currently absent from Part 2. | PENDING |
| ACIG-COR-056 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `Department` Prisma model derived in ACIG §2.1A.2. Carries `departmentCode @unique`, `departmentName`, `isActive`, optimistic-locking `version`. Field-level requirements sourced from DEV-SPEC-001 Part 12 §12.2.1. Currently absent from Part 2. | PENDING |
| ACIG-COR-057 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `Role` and `RolePermissionMapping` Prisma models derived in ACIG §2.1A.3 and §2.1A.4. `Role` carries `roleCode @unique`, `actorLevel` enum reference, `isPredefined` flag, and a one-to-many relation to `RolePermissionMapping`. `RolePermissionMapping` carries `@@unique([roleId, permissionKey])`. Field-level requirements sourced from DEV-SPEC-001 Part 12 §12.2.2. Currently absent from Part 2. | PENDING |
| ACIG-COR-058 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `RoleSessionConfig` Prisma model derived in ACIG §2.1A.5. One row per role with `roleId @unique`, `idleLockTimeoutSeconds`, `hardLogoutTimeoutSeconds`, `manualLockAvailable`. Replaces the v1.0 dotted-key approach (`session.idle.fom.*`, `session.hardLogout.frontDesk.*`) which covered only two of the defined actor levels and omitted manual-lock availability. Source: DEV-SPEC-001 Part 12 §12.2.2. Currently absent from Part 2. Resolves the contradiction with MCL MC-013 by establishing snapshot-propagation pattern: source-of-truth is `RoleSessionConfig`; operational-fast-path read is from `StaffUser.idleThresholdSeconds` / `hardLogoutThresholdSeconds`; propagation occurs in the same transaction as the role config save. | PENDING |
| ACIG-COR-059 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `AiActorIdentity` Prisma model derived in ACIG §2.1A.6. Single-record model with `displayName`, `actorType` fixed to `L0_SYSTEM_ACTOR`, `isActive`. Field-level requirements sourced from DEV-SPEC-001 Part 12 §12.2.2. Currently absent from Part 2. | PENDING |
| ACIG-COR-060 | NEW-CONTENT | DEV-SPEC-001 Part 2 | `ModeConfiguration` Prisma model and `ModeLifecycleState` enum derived in ACIG §2.1A.7. Carries `@@unique([modeKey, version])`, `isPredefined` flag, `stageRoute`, `autoFulfilmentConditions`, `featureDependencies`, and `ModeLifecycleState` enum (DRAFT, VALIDATED, ACTIVE, SUPERSEDED). Field-level requirements sourced from DEV-SPEC-001 Part 12 §12.2.5. Currently absent from Part 2. | PENDING |
| ACIG-COR-061 | CORRECTION | DEV-SPEC-001 Part 2 | `PolicyRegistry.policyId` constraint changed from `@unique` to `@@unique([policyId, version])` per ACIG §2.1.2 mutation rule (supersession requires multiple rows per `policyId`). Also: ACIG §3.4 optimistic locking obligation requires `version Int @default(1)` on the seven structured registry models in §2.2 (`RoomTypeRegistry`, `CancellationPolicyRegistry`, `WorkOrderTemplate`, `CommunicationTemplate`, `InvoiceTemplate`, `FeedbackSurveyTemplate`, `VipNotificationRoutingConfig`). This finding consolidates the schema-correctness items previously tracked as B4-001 (Candidate A) into the ACIG layer; a coordinated end-session backfill against Part 2 will close both ACIG-COR-061 and B4-001 in one pass. | PENDING |

### 11.2 Findings Summary

| Target Part | Count | Range |
|---|---|---|
| Part 4 (Engines) | 2 | ACIG-COR-001 through ACIG-COR-002 |
| Part 6 (Services) | 26 | ACIG-COR-003 through ACIG-COR-028 |
| Part 9 (Routes) | 26 | ACIG-COR-029 through ACIG-COR-054 |
| Part 2 (Schemas) | 7 | ACIG-COR-055 through ACIG-COR-061 |
| **Total** | **61** | ACIG-COR-001 through ACIG-COR-061 |

### 11.3 Absorption Plan

All findings are absorbed into MCL v2.4 in the next session. The MCL entry per finding records: ID, type, target, the section reference within ACIG v1.1 where the derivation appears, and a `PENDING` status that flips to `RESOLVED` when the corresponding DEV-SPEC Part is revised in a future consolidated revision pass.

ACIG-COR-061 consolidates with the previously-tracked B4-001 backfill item; both close together in the Part 2 backfill session.

This guideline is internally complete and self-sufficient as written. No finding blocks implementation work against this document. Findings are forward-looking alignment items for the DEV-SPEC layer.

---

## Document Footer

| Attribute | Value |
|---|---|
| Document | ACIG v1.1 — LEGPHEL PMS Admin Console Implementation Guideline |
| Sections | 11 (Surface Identity; Schema Models; Configuration Lifecycle & Temporal Model; Policies; Engines; Services; Workers; API Routes; Configuration Key Meta-Registry; Acceptance Criteria; Findings Register) |
| Findings registered | 61 (ACIG-COR-001 through ACIG-COR-061) |
| Source documents | DEV-SPEC-001 Parts 0, 2, 3, 4, 5, 6, 8, 9, 12, 13; ACTOR-AUTHORITY-MATRIX-LOCKED; MCL v2.3 |
| Status | DRAFT — Pending Architect Review |
| Supersedes | ACIG v1.0 (28 April 2026 review pass) |
| Next steps | Architect review → lock → MCL v2.4 absorption pass → distribute to implementation team |

*End of ACIG v1.1*
