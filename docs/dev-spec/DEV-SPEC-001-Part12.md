# LEGPHEL PMS — DEV-SPEC-001
# Part 12 — Admin Console Configuration Surfaces
# §12.1 through §12.3

| Attribute | Value |
|---|---|
| Document | DEV-SPEC-001 |
| Part | 12 — Admin Console Configuration Surfaces |
| Version | 1.0-DRAFT |
| Date | 08 April 2026 |
| Status | DRAFT — Pending Architect Review |
| Declared sources | DEV-SPEC-001_ToC_FINAL.md (§§12.1–12.3); Canon_Block11 (§73, §79, §84); Canon_Block2 (§§17–20); DEV-SPEC-001-Part1.md (§1.8) |

---

## §12.1 — Admin Console Design Principles

This section states the six governing principles that apply to every Admin Console surface. Each principle is an implementation requirement, not a design preference. A surface that violates any of these principles is architecturally non-compliant.

---

### §12.1.1 — Strict Separation from Operational Code

**Implementation requirement:** The Admin Console writes to configuration tables. Operational stage code reads configuration tables at runtime. These two directions of movement define an absolute boundary.

Admin-layer code must not import or invoke operational services, operational controllers, or operational state machine functions. Operational-layer code must not import or invoke admin services or admin controllers. Admin code and operational code exist in separate organisational units within the codebase. This separation extends to modules, namespaces, and routing — admin and operational routes are defined in separate route files; admin middleware must not be applied to operational routes, and operational middleware must not be applied to admin routes.

The Admin Console does not create operational records. It does not create inquiries, entries, segments, quotations, holds, reservations, folios, invoices, payment records, work orders, charges, or any entity that belongs to the governed lifecycle. Any Admin Console code path that creates an operational record is an architectural violation and must be identified and removed during implementation review.

**Forbidden pattern:** An admin controller that calls an operational service method, or an admin route that writes to an operational entity table, is a violation regardless of the business justification offered. The boundary is not a suggestion; it is a structural constraint.

---

### §12.1.2 — Audit Event on Every Configuration Save

**Implementation requirement:** Every create, update, and delete operation on a configuration surface produces an audit event. The audit event is written in the same database transaction as the configuration change. If the transaction rolls back, the audit event rolls back with it. There is no scenario in which a configuration change succeeds without an audit event, and no scenario in which an audit event records a configuration change that did not succeed.

The audit event record must capture:

| Field | Content |
|---|---|
| `surfaceModified` | The canonical name of the configuration surface that was changed |
| `fieldsChanged` | Array of field names that were modified in this operation |
| `priorValue` | The value of each changed field before the operation |
| `newValue` | The value of each changed field after the operation |
| `actorId` | The identity of the authenticated staff member who performed the save |
| `actorRole` | The role of the actor at the time of the save |
| `timestamp` | UTC timestamp of the save operation |
| `operationType` | `CREATE`, `UPDATE`, or `DELETE` |

**Forbidden pattern:** A configuration save that writes to a configuration table without also writing an audit event in the same transaction. A fire-and-forget audit call outside the transaction boundary does not satisfy this requirement.

---

### §12.1.3 — Default Values Visually Distinguished from Explicitly Configured Values

**Implementation requirement:** Where the system ships with canonical default values for configurable parameters — expiry timers, discount thresholds, session management durations, authority limits, SLA durations, and all other seeded configuration defaults — the Admin Console interface must visually distinguish those defaults from values an administrator has explicitly reviewed and saved.

The distinction indicator must be non-intrusive. A muted label, a small icon marker, a distinct background styling, or a subtle text marker (e.g., "system default") placed adjacent to the field is sufficient. The indicator must be visible at a glance without requiring the administrator to interact with the field. The indicator must disappear or change state when the administrator explicitly saves a value for that surface.

The purpose of the indicator is operational confidence: an administrator certifying system readiness for live operation must be able to identify at a glance which configuration surfaces have been consciously reviewed and owned by the hotel and which are still running on unreviewed factory defaults.

**Forbidden pattern:** A configuration surface that presents a value to the administrator with no visual distinction between a system default and an explicitly configured value is a forbidden pattern. Storing a default silently in code and presenting it to the user as though it were a saved configuration is equally forbidden.

---

### §12.1.4 — Mode Configuration Validated at Save Time

**Implementation requirement:** Operational modes are configurable workflow templates that are subordinate to policies, state machine rules, and service dependencies. Mode configuration is managed through the Admin Console.

When an administrator saves a mode configuration, validation runs at save time against three constraint categories:
1. **Policy constraints** — the mode must not auto-approve or silently bypass any action for which a policy requires explicit approval or escalation.
2. **State machine constraints** — the mode must not route through stage transitions that the state machine does not permit, and must not omit a stage that the state machine requires as a mandatory gate.
3. **Service dependency constraints** — if the mode includes or activates a feature that depends on a service, that service must be reachable and correctly configured.

If validation fails, the save is rejected. The rejection response identifies the specific constraint violated. The administrator receives a typed error identifying which policy, which state machine rule, or which service dependency the proposed mode configuration conflicts with.

Predefined modes ship as seed data: New Booking, Room Change, Rate Revision, Date Extension, Early Departure / Cancellation, Billing Model Change, Guest Composition Change, and Complaint Resolution / Goodwill. Predefined modes may be customised but may not be deleted. Custom modes require GM authority to activate. Custom mode activation is subject to the same save-time validation.

**Forbidden pattern:** A mode save that skips validation when the administrator has authority to make the change. Authority to save a mode is not authority to bypass mode validation. The validation gate applies regardless of actor role.

---

### §12.1.5 — Configuration Cannot Disable a Required Control

**Implementation requirement:** Configuration tunes parameters within defined bounds. Configuration does not disable controls that are architecturally or operationally required. A save operation that would have the effect of disabling a required control is rejected with a typed `ConfigurationViolationError`.

The `ConfigurationViolationError` must carry:

| Field | Content |
|---|---|
| `control` | The name of the control that the configuration change would disable |
| `requirement` | A description of the requirement the control serves |
| `proposedChange` | The configuration value or combination that triggered the violation |

Required controls that configuration may not disable include, without limitation:

- **Exit evidence requirements.** Stage gate checks that require documented evidence before a stage transition may complete. No threshold or timeout value may be set to a value that bypasses the evidence requirement.
- **Timer mechanisms for timer-governed events.** The Timer Engine governs hold expiry, quotation validity, parking follow-up, no-show contact windows, SLA breach escalation, processing lock expiry, and feedback solicitation. Configuration may adjust the duration values. Configuration may not disable the timer mechanism itself for any event that is governed by it.
- **Human approval requirement for AI outbound drafts.** When the trust level for an action category is set to `ALWAYS_REQUIRE_APPROVAL`, configuration may not bypass the approval gate by adjusting confidence thresholds to a value that would route all drafts to auto-approval. The approval gate is a hard control; the trust level configuration governs which category requires it, but does not eliminate the mechanism.
- **Audit capture on governed operations.** No configuration value may suppress audit event generation for governed operations.
- **Financial record immutability.** Configuration may not enable destructive editing of posted financial lines.

**Forbidden pattern:** A configuration save that silently ignores or routes around this validation. The `ConfigurationViolationError` must be surfaced to the administrator with the full content described above. Silent acceptance followed by partial application of the configuration is a forbidden pattern.

---

### §12.1.6 — Single-Tenant Configuration Namespace

**Implementation requirement:** One deployment serves one property. One deployment has one configuration namespace. All configuration tables are designed without a `tenant_id` column. No configuration query includes a tenant partition filter. The Admin Console manages configuration for a single property — the hotel at which the system is deployed.

Multi-property deployment — a single instance serving multiple distinct properties — is not a current requirement. The data model, configuration hierarchy, and Admin Console surfaces must not be designed for multi-tenancy, and equally must not introduce patterns that structurally preclude it as a future extension. The boundary is: no tenant partitioning is built now, and no architectural decision is made now that would make tenant partitioning impossible later. Future multi-property support is a formally scoped architectural extension requiring its own decision process.

**Forbidden pattern:** A configuration table with a `tenant_id` column. A configuration query that includes a tenant partition filter. An Admin Console surface that presents a property-selector or tenant-selector to the administrator.

---

## §12.2 — Configuration Surface Catalogue

This section catalogues every configuration surface that the Admin Console must expose. Surfaces are grouped by domain to aid implementation navigation. For each surface, the entry provides: the canonical surface name (used in configuration table naming and Admin Console labels), the stages that depend on the surface at runtime, and the implementation requirement.

The canonical surface name is the authoritative reference used when this surface appears in `MissingConfigurationError` payloads, audit events, and readiness check output.

---

### §12.2.1 — Hotel Identity and Property

#### Hotel Profile

| Property | Value |
|---|---|
| Canonical name | `hotel_profile` |
| Stage dependency | All stages (S1–S9) |
| Implementation requirement | The hotel profile surface must expose and allow configuration of: hotel name, registered address, trading address (if different), contact numbers, primary email address, operating hours (open / close time per day of week), public holiday schedule, time zone (IANA timezone string), and property currency. The profile must be complete before any stage is considered live. Validation at save time confirms that all required fields are non-empty and that the time zone value is a valid IANA identifier. The hotel profile is a single record — it cannot be deleted, only updated. |

#### Departments

| Property | Value |
|---|---|
| Canonical name | `department_registry` |
| Stage dependency | All stages |
| Implementation requirement | The department registry exposes the list of hotel operational departments. Each department entry carries a department code, department name, and active/inactive flag. At least one department must be active before S1 is live. Departments are referenced by staff user assignments and work order routing. A department cannot be deleted if any active staff member or open work order references it; it must be deactivated instead. |

---

### §12.2.2 — Staff, Roles, and Authentication

#### Staff Registry

| Property | Value |
|---|---|
| Canonical name | `staff_registry` |
| Stage dependency | All stages |
| Implementation requirement | The staff registry exposes CRUD for staff user records. Each record carries: staff ID, full name, PIN (hashed, never stored in plaintext), assigned role, assigned department, active/inactive flag. At minimum, one GM and one Reception role staff member must be active before any stage is live. PIN is set or reset through the Admin Console. PIN must never be displayed after creation. Staff records cannot be deleted; they are deactivated. |

#### Role-Permission Mappings

| Property | Value |
|---|---|
| Canonical name | `role_permission_mappings` |
| Stage dependency | All stages |
| Implementation requirement | The role-permission mappings surface exposes the assignment of permissions to roles. Each mapping entry binds a role identifier to a set of permitted operations. Permissions are predefined by the system; the Admin Console allows the administrator to assign and revoke permissions per role. At save time, validation confirms that the resulting permission set does not leave any required stage operation without at least one active role that can perform it. Role-permission mapping changes produce audit events that include the prior and new permission sets. |

#### Session Management Configuration

| Property | Value |
|---|---|
| Canonical name | `session_management_config` |
| Stage dependency | S1–S9 (all stages) |
| Implementation requirement | Session management must be configured per role before the system is live. For each defined role, the surface exposes: idle auto-lock timeout duration in minutes (the period of inactivity after which the terminal locks and requires PIN re-entry), hard logout duration in minutes (the period after which the session is terminated and full authentication is required), and manual lock availability (boolean — whether the role's interface includes a one-tap lock control for staff stepping away from the terminal). These are not optional security preferences. They are operational workflow controls. A role with no session management configuration is not a validly configured role. Save-time validation confirms that idle lock duration is less than hard logout duration for every role. |

#### AI Actor Identity

| Property | Value |
|---|---|
| Canonical name | `ai_actor_identity` |
| Stage dependency | All stages where AI agent is active |
| Implementation requirement | The AI actor identity surface registers the AI agent as a named actor in the system's actor registry. The surface exposes: AI actor display name (the name that appears in audit events and communication attribution when the AI agent acts), actor type (fixed to `L0_SYSTEM_ACTOR`), and active/inactive flag. The AI actor identity must be registered before the AI agent configuration block can be saved. This surface is required when the AI feature is enabled. |

---

### §12.2.3 — Inventory

#### Room Type and Capacity Registry

| Property | Value |
|---|---|
| Canonical name | `room_type_registry` |
| Stage dependency | S1, S5, S6 |
| Implementation requirement | The room type registry exposes CRUD for room type definitions. Each entry carries: room type code, room type name, base capacity (adults), maximum capacity (adults + children), bed configuration options (array of named configurations per room type), and active/inactive flag. At least one room type must be active before S1 is live. A room type cannot be deleted if any active room instance, rate plan, or open entry references it. |

#### Room Instance Registry

| Property | Value |
|---|---|
| Canonical name | `room_instance_registry` |
| Stage dependency | S1, S5, S6, S7, S8 |
| Implementation requirement | The room instance registry exposes CRUD for individual room records. Each entry carries: room number, room type reference, floor, features (array), current operational state (READY / DEFICIENT / OUT_OF_ORDER), and active flag. Room instance records cannot be deleted; they are deactivated. Assignment of a room to a room type is immutable after creation. |

#### DEFICIENT Condition Categories

| Property | Value |
|---|---|
| Canonical name | `deficient_condition_categories` |
| Stage dependency | S1, S5, S6, S7, S8 |
| Implementation requirement | The surface exposes a configurable list of DEFICIENT condition category codes and labels used when raising DEFICIENT condition records against room instances. At least one active category must be configured before S1 is live. Categories may be added or deactivated; they may not be deleted if any open DEFICIENT condition record references them. |

#### DEFICIENT Resolution Deadline

| Property | Value |
|---|---|
| Canonical name | `deficient_resolution_deadline` |
| Stage dependency | S5, S7 |
| Implementation requirement | The surface configures the maximum elapsed time (in hours) permitted between a DEFICIENT condition being raised and its resolution being recorded. The Timer Engine uses this value to schedule SLA monitoring events for open DEFICIENT conditions. A value must be present before S5 is live. Save-time validation confirms the value is a positive integer. |

#### Space Inventory and Seating Configurations

| Property | Value |
|---|---|
| Canonical name | `space_inventory` |
| Stage dependency | S1, S4, S5, S6 |
| Implementation requirement | The space inventory surface exposes CRUD for non-room spaces (conference rooms, event spaces, dining rooms). Each entry carries: space code, space name, space type, capacity (theatre / classroom / banquet / board configurations as applicable), and active flag. If conference or event functionality is enabled, at least one space must be configured before S1 is live. |

#### Walk-In Rate Plan

| Property | Value |
|---|---|
| Canonical name | `walk_in_rate_plan` |
| Stage dependency | S1 |
| Implementation requirement | The walk-in rate plan surface configures the rate plan applied to walk-in guest interactions at S1. The surface exposes the selection of one rate plan (from the rate plan registry) designated as the walk-in rate plan. Only one rate plan may be designated as walk-in at a time. The walk-in designation does not prevent the rate plan from being used for other booking types. |

---

### §12.2.4 — Rate, Pricing, and Commercial

#### Rate Plan Registry

| Property | Value |
|---|---|
| Canonical name | `rate_plan_registry` |
| Stage dependency | S1 (indicative), S2, S4, S7 |
| Implementation requirement | The rate plan registry exposes CRUD for rate plan definitions. Each rate plan carries: plan code, plan name, base rate per room type per night, applicable seasons (references to season calendar entries), inclusions, channel restrictions, and active/inactive flag. At least one rate plan covering the current date must be active before S1 is live. Rate plans may not be deleted if any active entry or reservation references them. Override margin per rate plan is configured separately (see below). |

#### Season Calendar

| Property | Value |
|---|---|
| Canonical name | `season_calendar` |
| Stage dependency | S1, S2 |
| Implementation requirement | The season calendar surface exposes date range definitions for pricing seasons. Each entry carries: season code, season name, start date, end date, and active flag. Date ranges may not overlap for active seasons. At least one season covering the current date must be active before S1 is live. |

#### Package Registry

| Property | Value |
|---|---|
| Canonical name | `package_registry` |
| Stage dependency | S1, S2 |
| Implementation requirement | The package registry exposes CRUD for package definitions. Each package carries: package code, package name, included components (array), pricing model (per person / per room), applicable room types, applicable seasons, and active/inactive flag. At least one active package must be configured before S1 is live. |

#### Discount Thresholds

| Property | Value |
|---|---|
| Canonical name | `discount_thresholds` |
| Stage dependency | S2, S7 |
| Implementation requirement | The discount thresholds surface configures the discount authority bands. Each band entry carries: minimum discount percentage, maximum discount percentage, and the authority level required to approve a discount in this band. Bands must be contiguous and non-overlapping. The lowest band starts at zero percent. At save time, validation confirms that no authority gap exists — every possible discount percentage from zero to the maximum permitted has an assigned authority level. |

#### Speculative Hold Thresholds

| Property | Value |
|---|---|
| Canonical name | `speculative_hold_thresholds` |
| Stage dependency | S2 |
| Implementation requirement | The speculative hold thresholds surface configures the criteria under which a speculative hold request is approved or escalated. Threshold entries carry: booking source type, authority level required for approval, and maximum number of concurrently active speculative holds permitted per source type. This surface is required before speculative hold functionality is active at S2. |

#### FOC Configuration

| Property | Value |
|---|---|
| Canonical name | `foc_configuration` |
| Stage dependency | S2, S3, S4 |
| Implementation requirement | The FOC (Free of Charge) configuration surface exposes the rules governing complimentary room entitlements. Configuration entries carry: client tier or profile type, maximum number of FOC rooms permitted per booking, FOC entitlement calculation basis (per X paying rooms), and the authority level required to grant FOC rooms beyond the configured entitlement. Save-time validation confirms that FOC entitlement values are non-negative and that authority levels are valid role identifiers. |

#### Override Margin Per Rate Plan

| Property | Value |
|---|---|
| Canonical name | `override_margin_per_rate_plan` |
| Stage dependency | S2 |
| Implementation requirement | The override margin surface configures, per rate plan, the maximum percentage deviation from the plan's base rate that a sales staff member may apply without escalation. Each entry carries: rate plan reference, maximum override margin percentage, and the authority level required to exceed the margin. This surface is required before quotation creation at S2. |

#### Confirmation Authority Thresholds

| Property | Value |
|---|---|
| Canonical name | `confirmation_authority_thresholds` |
| Stage dependency | S4 |
| Implementation requirement | The surface configures the authority levels required to confirm reservations under different conditions: standard confirmation, confirmation with overbooking risk acknowledged, and confirmation with FOM override. Each condition carries an assigned authority level. All three conditions must be configured before S4 is live. |

#### Overbooking Limits

| Property | Value |
|---|---|
| Canonical name | `overbooking_limits` |
| Stage dependency | S4 |
| Implementation requirement | The overbooking limits surface configures the maximum number of confirmed reservations that may exceed physical room inventory for each room type. Each entry carries: room type reference, maximum overbooking count (integer ≥ 0), and the authority level required to confirm when the overbooking limit would be reached or exceeded. Save-time validation confirms that values are non-negative integers. |

#### Cancellation Penalty Tiers

| Property | Value |
|---|---|
| Canonical name | `cancellation_penalty_tiers` |
| Stage dependency | S3 (disclose), S4, S5, S6, S7 |
| Implementation requirement | The cancellation penalty tiers surface configures the penalty structure applied when a booking is cancelled at different points in the lifecycle. Each tier entry carries: days before arrival, penalty basis (percentage of total booking value / number of nights / flat amount), penalty amount or percentage, and applicable booking source or tier restrictions. Tiers must be logically consistent — penalties may not decrease as the arrival date approaches. At save time, validation confirms that tiers are non-overlapping and that the full date range from far out to day-of-arrival is covered. |

#### Credit Extension Ceiling Thresholds

| Property | Value |
|---|---|
| Canonical name | `credit_extension_ceiling_thresholds` |
| Stage dependency | S3, S5, S7, S8 |
| Implementation requirement | The credit extension ceiling surface configures, per client tier, the maximum credit amount that may be extended to a guest before a ceiling event is triggered. Each entry carries: client tier identifier, ceiling amount, currency, and the authority level required to extend credit beyond the ceiling. Save-time validation confirms that ceiling amounts are positive values and that currency matches the hotel's configured currency. |

#### Write-Off Authority Thresholds

| Property | Value |
|---|---|
| Canonical name | `write_off_authority_thresholds` |
| Stage dependency | S9 |
| Implementation requirement | The write-off authority thresholds surface configures the authority bands for approving debt write-offs. Each band carries: maximum write-off amount, and the authority level required. Bands must be contiguous from zero to the maximum write-off amount the system permits. |

---

### §12.2.5 — Workflow and Policy

#### Committed Hold Duration

| Property | Value |
|---|---|
| Canonical name | `committed_hold_duration` |
| Stage dependency | S3 |
| Implementation requirement | The surface configures the duration (in hours) of a committed hold before it expires if not converted to a reservation. This value is used by the Timer Engine when scheduling committed hold expiry events. A single value applies system-wide. Save-time validation confirms the value is a positive integer. This surface is required before S3 is live. |

#### Expiry Defaults Per Stage

| Property | Value |
|---|---|
| Canonical name | `expiry_defaults` |
| Stage dependency | S1, S2, S3, S5, S7, S8, S9 |
| Implementation requirement | The expiry defaults surface configures the default expiry durations for timer-governed lifecycle events, by stage. Configuration entries carry: stage identifier, event type (e.g., `QUOTATION_VALIDITY`, `SPECULATIVE_HOLD_EXPIRY`, `PARKING_FOLLOW_UP`, `NO_SHOW_CONTACT_WINDOW`, `FEEDBACK_SOLICITATION`), and duration (in hours or days as appropriate to the event type). Each event type must have a configured default before the stage that governs it is live. Configuration does not disable the Timer Engine mechanism; it sets the duration the Timer Engine uses. |

#### Ownership Assignment Rules

| Property | Value |
|---|---|
| Canonical name | `ownership_assignment_rules` |
| Stage dependency | S1, S4 |
| Implementation requirement | The surface configures the rules by which custodian ownership is assigned to entries. Rules carry: assignment basis (manual / channel-based / round-robin), any channel-to-custodian mappings, and the fallback assignment rule when no channel mapping matches. This surface is required before S1 is live. |

#### Billing Model Availability

| Property | Value |
|---|---|
| Canonical name | `billing_model_availability` |
| Stage dependency | S3, S6, S7, S8 |
| Implementation requirement | The billing model availability surface configures which billing models are active in the deployment. Billing model entries carry: model identifier (e.g., `INDIVIDUAL`, `CORPORATE_DIRECT`, `AGENT_CONSOLIDATED`, `CONFERENCE`), active/inactive flag, and the authority level required to apply the billing model at booking time. At least one billing model must be active before S3 is live. |

#### Mode Configurations

| Property | Value |
|---|---|
| Canonical name | `mode_configurations` |
| Stage dependency | All stages where modes are active |
| Implementation requirement | The mode configuration surface exposes the eight predefined modes (New Booking, Room Change, Rate Revision, Date Extension, Early Departure / Cancellation, Billing Model Change, Guest Composition Change, Complaint Resolution / Goodwill) and any custom modes created by the administrator. For each mode, the surface exposes: mode name, stage route (the ordered sequence of stages the mode presents), auto-fulfilment conditions per stage (conditions under which a stage is automatically satisfied), and active/inactive flag. Predefined modes may be customised but may not be deleted. Custom mode creation and activation require GM authority. Save-time validation applies as specified in §12.1.4. |

---

### §12.2.6 — Communication

#### Communication Channel Configuration

| Property | Value |
|---|---|
| Canonical name | `communication_channel_config` |
| Stage dependency | S2, S3, S4, S5, S7, S8, S9 |
| Implementation requirement | The channel configuration surface exposes the configuration for each communication channel: email and WhatsApp. For email: SMTP/SES credentials (stored as secrets, not displayed after save), sending domain, bounce handling address, and polling interval for inbound email. For WhatsApp: BSP API endpoint, API credentials (stored as secrets), and webhook configuration. Each channel entry carries an active/inactive flag. At least the email channel must be active before S2 is live. Save-time validation confirms that credentials are non-empty and that the sending domain passes basic format validation. |

#### Acknowledgement Window Per Type

| Property | Value |
|---|---|
| Canonical name | `acknowledgement_window_per_type` |
| Stage dependency | S2, S3, S4, S5, S7, S8, S9 |
| Implementation requirement | The acknowledgement window surface configures the maximum time (in hours) the system will wait for a guest acknowledgement response after a communication is sent, per communication type. Communication types include: quotation dispatch, proforma invoice dispatch, confirmation voucher dispatch, pre-arrival notification, amendment notification, and cancellation notification. Each entry carries: communication type identifier, window duration in hours. The Timer Engine uses these values to schedule acknowledgement timeout events. All types must be configured before the stage that sends the corresponding communication is live. |

#### Communication Templates Per Type

| Property | Value |
|---|---|
| Canonical name | `communication_templates` |
| Stage dependency | S2, S3, S4, S5, S6, S7, S8, S9 |
| Implementation requirement | The communication templates surface exposes template management for all outbound communication types: quotation (email and WhatsApp variants), proforma invoice, reservation confirmation voucher, pre-arrival notification, amendment notification, cancellation notification, and any additional templates required by the operational stages. Each template entry carries: template type identifier, channel identifier, subject line (for email), body content with merge-field placeholders, and active/inactive flag. Template content may include merge-field tokens (e.g., `{{guest.name}}`, `{{entry.dates}}`); the system validates that all tokens used in the template correspond to fields available at the send point. Required templates per stage must be active before the stage is live. |

---

### §12.2.7 — Financial

#### Advance Payment Thresholds

| Property | Value |
|---|---|
| Canonical name | `advance_payment_thresholds` |
| Stage dependency | S3, S5, S6 |
| Implementation requirement | The advance payment thresholds surface configures, per booking source type and client tier, the required advance payment amount or percentage at S3 (committed hold / PI stage). Each entry carries: booking source type, client tier (or `DEFAULT`), required advance amount basis (percentage of total booking value / flat amount), and amount or percentage value. This surface is required before S3 is live. Save-time validation confirms that threshold values are non-negative and that every active source/tier combination has an entry. |

#### Invoice Templates

| Property | Value |
|---|---|
| Canonical name | `invoice_templates` |
| Stage dependency | S3 (PI), S8 (final), S9 (final) |
| Implementation requirement | The invoice templates surface exposes templates for proforma invoice and final invoice document generation. Each template entry carries: invoice type (PROFORMA / FINAL), template body with merge-field placeholders, header content (hotel details, logo reference), footer content, and active flag. At minimum, one active PROFORMA template and one active FINAL invoice template must be present before S3 and S8 respectively are live. Merge-field tokens are validated against available invoice fields at save time. |

#### Damage Rate List

| Property | Value |
|---|---|
| Canonical name | `damage_rate_list` |
| Stage dependency | S8 |
| Implementation requirement | The damage rate list surface configures the catalogue of chargeable damage items and their standard rates. Each entry carries: damage category, description, standard charge amount, currency, and active/inactive flag. This surface is required before S8 is live. Items may not be deleted if referenced by an open damage charge record; they are deactivated instead. |

#### Payment Follow-Up Intervals

| Property | Value |
|---|---|
| Canonical name | `payment_follow_up_intervals` |
| Stage dependency | S9 |
| Implementation requirement | The payment follow-up intervals surface configures the schedule of automated payment follow-up communications sent to guests with outstanding balances post-checkout. Each interval entry carries: days after checkout, communication type (email / WhatsApp), and template reference. The Timer Engine uses these intervals to schedule post-checkout payment follow-up events. At least one interval must be configured before S9 is live. |

#### Dispute Gate Function Configuration

| Property | Value |
|---|---|
| Canonical name | `dispute_gate_function_config` |
| Stage dependency | S7, S8 |
| Implementation requirement | The dispute gate function configuration surface configures the operational parameters of the dispute gate mechanism. Configuration carries: the authority level required to open a dispute, the authority level required to resolve a dispute, the maximum duration (in days) a dispute may remain open before escalation, and the escalation notification tier. This surface is required before S7 is live. |

#### FOM Override Frequency Threshold

| Property | Value |
|---|---|
| Canonical name | `fom_override_frequency_threshold` |
| Stage dependency | S8 |
| Implementation requirement | The FOM override frequency threshold surface configures the number of FOM override events within a rolling time window that triggers a pattern visibility alert to the GM. Configuration carries: maximum override count, rolling window in days. This surface is required before S8 is live. Save-time validation confirms both values are positive integers. |

---

### §12.2.8 — Handoff and Operational

#### H1–H5 Handoff Checklists

| Property | Value |
|---|---|
| Canonical name | `handoff_checklists` |
| Stage dependency | S4, S5, S6, S7, S8 |
| Implementation requirement | The handoff checklists surface configures the checklist items required for each of the five handoff events (H1: Pre-Arrival to Arrival, H2: Check-In transition, H3: In-Stay inspection, H4: Pre-Departure, H5: Post-Departure). Each checklist entry carries: handoff type identifier, ordered list of checklist items (each with item code, description, and whether the item is mandatory or advisory), and the role responsible for the checklist. Mandatory checklist items must be completed before the corresponding handoff can be accepted. The checklist surface must be fully configured for all five handoff types before S4 is live. |

#### Work Order Templates

| Property | Value |
|---|---|
| Canonical name | `work_order_templates` |
| Stage dependency | S1, S3, S4, S5 |
| Implementation requirement | The work order templates surface configures the templates used for creating work orders. Each template entry carries: template code, work order category (maintenance / housekeeping / service), default assignee department, template description, and active flag. At least one active work order template per category used by the operational stages must be configured before S1 is live. |

#### Night Audit Schedule

| Property | Value |
|---|---|
| Canonical name | `night_audit_schedule` |
| Stage dependency | S7 |
| Implementation requirement | The night audit schedule surface configures the time at which the automated night audit runs each day. Configuration carries: scheduled run time (HH:MM, 24-hour format), time zone reference (inherits from hotel profile), and active flag. The night audit schedule must be configured before S7 is live. |

#### Night Audit Expected Charges Rules

| Property | Value |
|---|---|
| Canonical name | `night_audit_expected_charges_rules` |
| Stage dependency | S7 |
| Implementation requirement | The night audit expected charges rules surface configures the rules that determine which charge lines the night audit expects to post for a given rate plan and entry configuration. Each rule entry carries: rate plan reference, charge type (room rate / service charge / tax), calculation basis, and applicable entry type. Completeness rules are validated at save time — every active rate plan must have a complete set of expected charge rules before S7 is live. |

#### Checkout Time

| Property | Value |
|---|---|
| Canonical name | `checkout_time` |
| Stage dependency | S8 |
| Implementation requirement | The checkout time surface configures the standard checkout time for the property. Configuration carries: standard checkout time (HH:MM, 24-hour format). This value is used by the Timer Engine for pre-checkout notification scheduling and by the S8 stage for checkout time compliance checks. This surface must be configured before S8 is live. |

#### Room Assignment Priority Rules

| Property | Value |
|---|---|
| Canonical name | `room_assignment_priority_rules` |
| Stage dependency | S5 |
| Implementation requirement | The room assignment priority rules surface configures the ordered criteria by which rooms are assigned to arriving guests. Priority rule entries carry: priority order (integer), criterion type (e.g., VIP status, room type match, floor preference, bed configuration), and whether the criterion is mandatory (blocks assignment if not satisfiable) or advisory. This surface must be configured before S5 is live. |

#### VIP Notification Routing Per Tier

| Property | Value |
|---|---|
| Canonical name | `vip_notification_routing` |
| Stage dependency | S6 |
| Implementation requirement | The VIP notification routing surface configures which staff roles or notification tiers receive VIP arrival notifications for each VIP tier. Each entry carries: VIP tier identifier, notification recipient roles (array), and channel (email / in-system / both). This surface must be configured before S6 is live. |

---

### §12.2.9 — Post-Stay and Governance

#### Feedback Survey Templates

| Property | Value |
|---|---|
| Canonical name | `feedback_survey_templates` |
| Stage dependency | S9 |
| Implementation requirement | The feedback survey templates surface configures the post-stay guest feedback surveys. Each template entry carries: template code, survey questions (ordered array with question text and response type), delivery channel (email / WhatsApp), delivery delay after checkout (hours), and active flag. At least one active template must be configured before S9 is live. |

#### Online Review Platform Links

| Property | Value |
|---|---|
| Canonical name | `online_review_platform_links` |
| Stage dependency | S9 |
| Implementation requirement | The online review platform links surface configures the URLs used in post-stay communications that direct guests to leave reviews. Each entry carries: platform name, URL, booking source scope (which booking sources receive this platform's link), and active flag. This surface must be configured before S9 is live. Save-time validation confirms that all URLs are valid HTTPS URLs. |

#### Government Portal Submission Configuration

| Property | Value |
|---|---|
| Canonical name | `government_portal_submission_config` |
| Stage dependency | S9 |
| Implementation requirement | The government portal submission configuration surface configures the parameters for submitting guest identity information to the government registration portal. Configuration carries: portal endpoint URL, authentication credentials (stored as secrets, not displayed after save), submission schedule (real-time on check-in / batched), batch schedule if applicable (time of day, days of week), and active flag. This surface must be configured before S9 is live. |

#### Commission Rate Per Agent Profile

| Property | Value |
|---|---|
| Canonical name | `commission_rate_per_agent_profile` |
| Stage dependency | S9 |
| Implementation requirement | The commission rate surface configures the commission percentage applicable to each registered agent profile. Each entry carries: agent profile identifier, commission rate percentage, and effective date range. This surface is optional — it is required only when the commission feature is activated by configuring at least one agent profile with a commission rate. If configured, the commission calculation basis rules surface (below) must also be configured. |

#### Commission Calculation Basis Rules

| Property | Value |
|---|---|
| Canonical name | `commission_calculation_basis_rules` |
| Stage dependency | S9 |
| Implementation requirement | The commission calculation basis rules surface configures the calculation basis applied when computing agent commission: whether commission is calculated on room revenue only, total revenue excluding certain charge types, or total revenue. The configuration carries: calculation basis identifier, excluded charge type categories (if any), and rounding rule. This surface is required only when the commission feature is activated. |

#### Identity Document Types

| Property | Value |
|---|---|
| Canonical name | `identity_document_types` |
| Stage dependency | S6 |
| Implementation requirement | The identity document types surface configures which document types are accepted for guest identity verification at check-in. Each entry carries: document type code, document type name, applicable nationalities (array, or `ALL`), and active flag. At least one active document type must be configured before S6 is live. |

#### Identity Document Retention Period

| Property | Value |
|---|---|
| Canonical name | `identity_document_retention_period` |
| Stage dependency | S6, S9 |
| Implementation requirement | The identity document retention period surface configures the duration (in days) that captured identity document data is retained before automated deletion. Configuration carries: retention period in days and the authority level required to access retained data. Save-time validation confirms the value is a positive integer. This surface must be configured before S6 is live. |

---

### §12.2.10 — OTA and Channel

#### OTA_SOURCE Flag Configuration

| Property | Value |
|---|---|
| Canonical name | `ota_source_flag_config` |
| Stage dependency | S1 |
| Implementation requirement | The OTA_SOURCE flag configuration surface defines which booking source identifiers are classified as OTA sources. Each entry carries: source identifier code, source display name, and OTA_SOURCE flag (boolean). This classification drives OTA-specific workflow routing (dedicated OTA inbox polling, OTA_CONFLICT detection). This surface must be configured before S1 is live. |

#### OTA_CONFLICT Trigger Rules

| Property | Value |
|---|---|
| Canonical name | `ota_conflict_trigger_rules` |
| Stage dependency | S4 |
| Implementation requirement | The OTA_CONFLICT trigger rules surface configures the conditions under which an OTA_CONFLICT overbooking record is raised. Each rule entry carries: conflict type identifier, trigger condition (e.g., confirmed reservation count exceeds physical inventory for room type), and the authority level required to proceed with confirmation despite an active OTA_CONFLICT. This surface must be configured before S4 is live. |

#### No-Show Cutoff Period

| Property | Value |
|---|---|
| Canonical name | `no_show_cutoff_period` |
| Stage dependency | S5 |
| Implementation requirement | The no-show cutoff period surface configures, per booking source type and client tier, the elapsed time after the expected arrival time at which a guest who has not arrived is eligible for no-show determination. Each entry carries: booking source type, client tier (or `DEFAULT`), cutoff duration (in hours after expected arrival time). This surface must be configured before S5 is live. |

#### No-Show Penalty Structure

| Property | Value |
|---|---|
| Canonical name | `no_show_penalty_structure` |
| Stage dependency | S5 |
| Implementation requirement | The no-show penalty structure surface configures the penalty applied when a no-show determination is made. Each entry carries: booking source type, client tier (or `DEFAULT`), penalty basis (percentage of total booking value / number of nights / flat amount), and penalty amount or percentage. Save-time validation confirms that every source/tier combination in the no-show cutoff period configuration has a corresponding penalty structure entry. This surface must be configured before S5 is live. |

---

### §12.2.11 — Session Management

The session management configuration surface is catalogued in §12.2.2 (Staff, Roles, and Authentication) as it is configured per role. For the avoidance of doubt: session management configuration covers idle auto-lock timeout, hard logout duration, and manual lock availability per role, and applies across all stages (S1–S9).

---

### §12.2.12 — AI Agent and Processing Lock (v2.3 Additions)

This group reflects the v2.3 additions to the configuration surface catalogue. These surfaces must be treated as a distinct implementation group. Processing lock and AI agent configuration are new surfaces that did not exist in v2.2.

#### Processing Lock TTL Per Channel

| Property | Value |
|---|---|
| Canonical name | `processing_lock_ttl_per_channel` |
| Stage dependency | All stages where multi-channel booking operations occur |
| Implementation requirement | The processing lock TTL surface configures the duration (in minutes) of the processing lock applied per communication channel to prevent concurrent conflicting booking operations on the same entry. Configuration entries are required for each of the four channels: `EMAIL_AI`, `WHATSAPP_AI`, `FRONT_DESK`, `PHONE`. Each entry carries: channel identifier, TTL duration in minutes (default: 15). The four entries are configured independently — channels may have different TTL durations. The Timer Engine uses the TTL value to schedule processing lock expiry events. All four channel entries must be present before multi-channel booking operations begin. Save-time validation confirms that TTL values are positive integers. |

#### AI Agent Configuration Block

| Property | Value |
|---|---|
| Canonical name | `ai_agent_config` |
| Stage dependency | All stages where AI agent is active |
| Implementation requirement | The AI agent configuration block is required when the AI feature is enabled. It exposes the following sub-surfaces, all managed through a single configuration surface in the Admin Console: |

The AI agent configuration block sub-surfaces are:

**LLM API Connection Credentials**
Endpoint URL and API key for the external LLM API. Both are stored as secrets — the API key is never displayed after initial save. Save-time validation confirms the endpoint URL is a valid HTTPS URL. The credentials are tested for connectivity at save time; a save that produces a connectivity failure is rejected with a descriptive error.

**AI Actor Identity String**
The display name registered for the AI actor in the actor registry. Must match the entry in the `ai_actor_identity` surface. This field is read-only in the AI agent configuration block after the actor identity surface has been saved; changes to the actor identity are made through the `ai_actor_identity` surface.

**Trust Level Per Action Category**
For each of the six intent categories (booking, lifecycle, financial, operational, OTA-specific, unclassifiable), the trust level that governs how AI-drafted actions in that category are handled. Valid values:
- `ALWAYS_REQUIRE_APPROVAL` — every AI-drafted action in this category requires human review and approval before execution.
- `AUTO_APPROVE_HIGH_CONFIDENCE` — AI-drafted actions that meet the configured confidence threshold for this category are executed automatically; actions below the threshold are routed to the approval queue.
- `FULL_AUTO` — AI-drafted actions in this category are executed without human approval regardless of confidence score.

Trust level for each category is managed by GM authority. Save-time validation confirms that a valid trust level is selected for every active intent category.

**Confidence Threshold Per Intent Category**
For each of the six intent categories, the minimum confidence score (decimal, 0.00–1.00) required for auto-approval when the trust level is set to `AUTO_APPROVE_HIGH_CONFIDENCE`. An action with a confidence score below the threshold is routed to the escalation tier configured for that category. This field is active only when the trust level for the corresponding category is `AUTO_APPROVE_HIGH_CONFIDENCE`. Save-time validation confirms values are in range.

**Escalation Routing Per Intent Category**
For each of the six intent categories, the notification tier that receives below-threshold escalations. Each entry carries: intent category identifier, escalation notification tier identifier. Escalation routing must be configured for every category before AI agent operations begin. Save-time validation confirms that the referenced notification tier exists.

**Per-Channel Trust Overrides**
Optional trust level overrides that apply to a specific communication channel, independent of the category-level trust level. Each override entry carries: channel identifier, intent category identifier, override trust level. An override replaces the category-level trust level for actions arriving through the specified channel. Per-channel overrides allow stricter trust requirements on specific channels (e.g., `ALWAYS_REQUIRE_APPROVAL` on `WHATSAPP_AI` for financial actions regardless of the category-level trust). Override entries are validated against the same valid trust level values.

**Correction Log Maximum Size**
The maximum number of correction log entries retained before aggregation is triggered. Configuration carries: integer value representing the maximum entry count. Save-time validation confirms the value is a positive integer. When the correction log reaches this size, aggregation is triggered per the CorrectionLogService behaviour specified in Part 6.

#### Voice Note Review SLA Per Channel

| Property | Value |
|---|---|
| Canonical name | `voice_note_review_sla_per_channel` |
| Stage dependency | All stages where voice note intake is active |
| Implementation requirement | The voice note review SLA surface configures the maximum time permitted between receipt of a voice note and completion of staff review, per communication channel. Each entry carries: channel identifier, SLA duration in minutes during operating hours (default: 30 minutes). Channels are configured independently. The Timer Engine uses the SLA duration to schedule voice note review breach events. All active channel entries must be present before voice note intake is live. Save-time validation confirms that SLA values are positive integers. |

#### Voice Note Escalation Routing

| Property | Value |
|---|---|
| Canonical name | `voice_note_escalation_routing` |
| Stage dependency | All stages where voice note intake is active |
| Implementation requirement | The voice note escalation routing surface configures which notification tier receives the escalation event when a voice note review SLA is breached. Configuration carries: notification tier identifier. This surface must be configured before voice note SLA breach escalation can fire. The referenced notification tier must exist in the notification tier registry. Save-time validation confirms the tier reference is valid. |

---

### §12.2.13 — Dispute and Override

#### Dispute Gate Function Configuration

Catalogued in §12.2.7 (Financial) as it governs the financial dispute resolution gate. Reference entry: `dispute_gate_function_config`.

#### FOM Override Frequency Threshold

Catalogued in §12.2.7 (Financial) as it governs GM pattern visibility for FOM override events. Reference entry: `fom_override_frequency_threshold`.

---

## §12.3 — Minimum Configuration Readiness Gate

### §12.3.1 — Startup Validation Architecture

At startup, the system runs a readiness validation pass across all stage groups and the cross-stage group. The validation pass checks, for each readiness group, that all required configuration surfaces exist and are in a valid state. Validity requires that: the surface record exists in the database; all mandatory fields on the surface are non-empty; any referential dependencies between surfaces (e.g., a rate plan referenced by a season calendar entry) are resolvable.

When a required configuration surface is missing or invalid, the system raises a `MissingConfigurationError`. Each `MissingConfigurationError` carries:

| Field | Type | Content |
|---|---|---|
| `missingConfigurationSurface` | `string` | The canonical name of the missing or invalid configuration surface (as defined in §12.2) |
| `stageGroup` | `string` | The readiness group identifier that is blocked by this missing surface (e.g., `S1_READINESS`, `CROSS_STAGE_READINESS`) |
| `consequence` | `string` | A human-readable description of what is not operational until this surface is configured |

A stage group with any `MissingConfigurationError` is not live. The system does not simulate readiness by substituting code defaults for missing configuration. Hidden defaults that allow a stage to appear operational despite missing configuration are a structural violation of this requirement.

All `MissingConfigurationError` instances raised at startup are collected and logged before the system exits startup validation. The log entry is an audit event. The administrator receives a complete list of all missing surfaces, not only the first failure encountered.

---

### §12.3.2 — Stage Readiness Groups

The startup validation pass implements the following readiness groups. For each group, the required configuration surfaces are listed. A `MissingConfigurationError` for any surface in a group blocks that group.

---

#### S1 Readiness

**Stage group identifier:** `S1_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `hotel_profile` | S1 intake is not operational — hotel identity and time zone unavailable |
| `staff_registry` (GM + Reception minimum) | S1 intake is not operational — no authenticated staff members capable of operating S1 |
| `department_registry` (≥ 1 active) | Staff assignment and work order routing unavailable |
| `room_type_registry` (≥ 1 active) | Availability configuration cannot be created — no room types available |
| `room_instance_registry` (≥ 1 active) | Room inventory unavailable — no rooms to assign |
| `space_inventory` (≥ 1 active, if conference enabled) | Conference/event availability configuration unavailable |
| `rate_plan_registry` (≥ 1 covering current date) | Rate presentation at S1 unavailable — no valid rate covering current date |
| `season_calendar` (covering current date) | Seasonal pricing unavailable — no season covering current date |
| `package_registry` (≥ 1 active) | Package selection at S1 unavailable |
| `ownership_assignment_rules` | Custodian assignment cannot execute — no assignment rules defined |
| `expiry_defaults` (S1 event types) | Timer Engine cannot schedule S1 expiry events — durations not configured |
| `deficient_condition_categories` (≥ 1 active) | DEFICIENT condition records cannot be raised — no categories defined |
| `ota_source_flag_config` | OTA source classification unavailable — OTA-specific routing cannot execute |
| `work_order_templates` (≥ 1 active) | Work order creation at S1 unavailable |
| `walk_in_rate_plan` | Walk-in guest rate presentation unavailable |
| `session_management_config` (all active roles) | Session boundaries not configured — terminals operate without governed session control |
| `processing_lock_ttl_per_channel` (all four channels) | Processing lock mechanism cannot enforce channel TTL — multi-channel booking operations blocked |

---

#### S2 Readiness

**Stage group identifier:** `S2_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `discount_thresholds` | Discount authority validation at S2 cannot execute — approval bands not defined |
| `speculative_hold_thresholds` (if feature enabled) | Speculative hold creation cannot proceed — threshold validation unavailable |
| `expiry_defaults` (S2 event types — quotation validity, speculative hold) | Timer Engine cannot schedule S2 expiry events |
| `override_margin_per_rate_plan` | Override margin validation at quotation creation unavailable |
| `foc_configuration` | FOC entitlement calculation unavailable |
| `communication_templates` (quotation email, WhatsApp) | Quotation dispatch unavailable — templates not defined |
| `acknowledgement_window_per_type` (quotation type) | Quotation acknowledgement timeout event cannot be scheduled |
| `package_registry` (≥ 1 active) | Package selection in quotation unavailable |
| `season_calendar` (covering current date) | Seasonal rate application in quotation unavailable |
| `rate_plan_registry` (≥ 1 active) | Quotation pricing unavailable |

---

#### S3 Readiness

**Stage group identifier:** `S3_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `advance_payment_thresholds` | Advance payment requirement validation at S3 cannot execute |
| `committed_hold_duration` | Timer Engine cannot schedule committed hold expiry |
| `billing_model_availability` (≥ 1 active) | Billing model selection at S3 unavailable |
| `cancellation_penalty_tiers` | Cancellation penalty disclosure at S3 unavailable — tier structure not defined |
| `foc_configuration` | FOC calculation in PI unavailable |
| `expiry_defaults` (S3 event types) | Timer Engine cannot schedule S3 expiry events |
| `invoice_templates` (PROFORMA type) | Proforma invoice generation unavailable |
| `credit_extension_ceiling_thresholds` | Credit ceiling monitoring cannot execute — threshold values not defined |
| `communication_templates` (PI dispatch type) | PI dispatch unavailable — template not defined |
| `acknowledgement_window_per_type` (PI type) | PI acknowledgement timeout cannot be scheduled |

---

#### S4 Readiness

**Stage group identifier:** `S4_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `confirmation_authority_thresholds` | Confirmation authority validation cannot execute |
| `overbooking_limits` | Overbooking detection cannot execute — limit values not defined |
| `ota_conflict_trigger_rules` | OTA_CONFLICT detection cannot execute |
| `cancellation_penalty_tiers` | Cancellation terms cannot be presented at confirmation |
| `communication_templates` (confirmation voucher) | Confirmation voucher dispatch unavailable |
| `acknowledgement_window_per_type` (confirmation type) | Confirmation acknowledgement timeout cannot be scheduled |
| `ownership_assignment_rules` | Custodian assignment at confirmation unavailable |

---

#### S5 Readiness

**Stage group identifier:** `S5_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `communication_templates` (pre-arrival type) | Pre-arrival communication dispatch unavailable |
| `room_assignment_priority_rules` | Room assignment logic cannot execute — priority rules not defined |
| `handoff_checklists` (H1 type) | H1 handoff acceptance blocked — checklist not defined |
| `no_show_cutoff_period` | No-show determination cannot execute — cutoff period not defined |
| `no_show_penalty_structure` | No-show penalty cannot be applied — structure not defined |
| `deficient_resolution_deadline` | DEFICIENT SLA monitoring cannot execute — deadline not configured |
| `advance_payment_thresholds` | Advance payment verification at S5 unavailable |
| `expiry_defaults` (S5 event types — no-show contact window) | Timer Engine cannot schedule no-show contact events |
| `cancellation_penalty_tiers` | Cancellation terms at S5 unavailable |

---

#### S6 Readiness

**Stage group identifier:** `S6_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `identity_document_types` (≥ 1 active) | Identity verification at check-in cannot proceed — no document types defined |
| `identity_document_retention_period` | Identity data retention policy cannot enforce — retention period not defined |
| `vip_notification_routing` | VIP arrival notifications cannot be dispatched — routing not configured |
| `handoff_checklists` (H2 and H3 types) | H2 and H3 handoff acceptance blocked — checklists not defined |
| `advance_payment_thresholds` | Check-in payment threshold validation unavailable |
| `billing_model_availability` (≥ 1 active) | Folio conversion cannot proceed — billing model unavailable |

---

#### S7 Readiness

**Stage group identifier:** `S7_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `night_audit_schedule` | Night audit cannot execute — schedule not defined |
| `night_audit_expected_charges_rules` | Night audit completeness validation cannot execute — charge rules not defined |
| `handoff_checklists` (H4 type) | H4 handoff acceptance blocked |
| `discount_thresholds` | Amendment discount authority validation at S7 unavailable |
| `billing_model_availability` (≥ 1 active) | Billing model change during stay unavailable |
| `dispute_gate_function_config` | Dispute gate cannot open — function parameters not defined |
| `credit_extension_ceiling_thresholds` | Credit ceiling monitoring at S7 unavailable |
| `deficient_resolution_deadline` | DEFICIENT SLA monitoring during stay cannot execute |
| `expiry_defaults` (S7 event types) | Timer Engine cannot schedule S7 expiry events |

---

#### S8 Readiness

**Stage group identifier:** `S8_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `checkout_time` | Checkout time compliance checks cannot execute — standard checkout time not defined |
| `damage_rate_list` (≥ 1 active) | Damage charge posting unavailable — no damage rate catalogue |
| `dispute_gate_function_config` | Dispute gate at S8 unavailable |
| `fom_override_frequency_threshold` | FOM override pattern visibility cannot execute — threshold not defined |
| `invoice_templates` (FINAL type) | Final invoice generation unavailable |
| `handoff_checklists` (H5 type) | H5 handoff acceptance blocked |
| `billing_model_availability` (≥ 1 active) | Settlement routing unavailable — billing model not defined |
| `credit_extension_ceiling_thresholds` | Credit ceiling at S8 unavailable |

---

#### S9 Readiness

**Stage group identifier:** `S9_READINESS`

Required surfaces and consequences:

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `invoice_templates` (FINAL type) | Post-stay invoice generation unavailable |
| `payment_follow_up_intervals` (≥ 1 entry) | Post-checkout payment follow-up events cannot be scheduled |
| `feedback_survey_templates` (≥ 1 active) | Post-stay feedback dispatch unavailable |
| `online_review_platform_links` (≥ 1 active) | Review platform links in post-stay communications unavailable |
| `government_portal_submission_config` | Government identity submission cannot execute |
| `identity_document_retention_period` | Identity data retention policy cannot enforce at post-stay |
| `expiry_defaults` (S9 event types — feedback solicitation) | Timer Engine cannot schedule feedback events |

**Commission surfaces (conditional):** `commission_rate_per_agent_profile` and `commission_calculation_basis_rules` are included in the S9 readiness check only when the commission feature is activated by the presence of at least one agent profile with a commission rate configured. When no agent profile carries a commission rate, these surfaces are omitted from the S9 readiness check and their absence does not block S9.

| Surface (`missingConfigurationSurface`) | Consequence (when commission feature activated) |
|---|---|
| `commission_rate_per_agent_profile` | Commission calculation at S9 cannot execute — rate not defined for agent profile |
| `commission_calculation_basis_rules` | Commission calculation basis not defined — commission amount cannot be computed |

---

#### Cross-Stage Readiness

**Stage group identifier:** `CROSS_STAGE_READINESS`

Cross-stage readiness validates infrastructure and configuration that must be operational regardless of which stage is active. A failure in the cross-stage readiness group means the system is not operationally live in any stage.

| Surface (`missingConfigurationSurface`) | Consequence |
|---|---|
| `expiry_defaults` (all event types) | Timer Engine cannot schedule governed events — duration values missing |
| `role_permission_mappings` (all active roles complete) | Permission checks cannot execute for one or more roles — operational access control incomplete |
| `session_management_config` (all active roles) | Session boundary enforcement unavailable for one or more roles |
| `communication_channel_config` (≥ 1 active channel: email) | Outbound communication infrastructure unavailable — email channel not configured |
| `acknowledgement_window_per_type` (all active communication types) | Acknowledgement timeout scheduling unavailable for one or more communication types |
| `cancellation_penalty_tiers` | Cancellation policy not defined — disclosure and enforcement unavailable |
| `rate_plan_registry` (rate plan priority order verifiable) | PricingPipelineEngine cannot apply rate plan priority order — plan registry incomplete |

**AI agent surfaces (conditional):** The following cross-stage surfaces are included in the readiness check only when the AI feature is enabled:

| Surface (`missingConfigurationSurface`) | Consequence (when AI feature enabled) |
|---|---|
| `ai_actor_identity` | AI actor cannot be attributed in audit events or communications |
| `ai_agent_config` (LLM API credentials) | AI agent cannot connect to LLM API — processing blocked |
| `ai_agent_config` (trust level per action category — all six categories) | AI action routing cannot execute — trust level not defined for one or more categories |
| `ai_agent_config` (escalation routing per intent category — all six categories) | Below-threshold escalation cannot route — escalation tier not defined for one or more categories |
| `voice_note_review_sla_per_channel` (all active channels) | Voice note SLA monitoring cannot execute — SLA duration not defined for one or more channels |
| `voice_note_escalation_routing` | Voice note SLA breach escalation cannot fire — escalation routing not configured |
| `processing_lock_ttl_per_channel` (all four channels) | Processing lock expiry cannot be scheduled — TTL not defined for one or more channels |

---

### §12.3.3 — Startup Validation Implementation Notes

**Implementation note — collection not fail-fast:** The startup readiness validation collects all `MissingConfigurationError` instances across all groups before terminating startup. It does not halt on the first failure. The complete list of failures is logged and returned so that an administrator can resolve all missing surfaces in a single configuration session rather than discovering failures one at a time.

**Implementation note — re-validation:** The readiness check must be re-runnable via an admin endpoint without requiring a full process restart. An administrator who has addressed missing configuration must be able to trigger a re-validation pass and confirm that the stage group now passes before proceeding to live operation.

**Implementation note — error type:** `MissingConfigurationError` extends `AppError`. It does not extend `ValidationError`, as a missing configuration surface is a readiness condition, not a user input validation failure. The error carries the three fields specified in §12.3.1 and produces a structured error payload consumable by the Admin Console interface.

**Implementation note — no fallback defaults:** No service, engine, or controller may substitute a hardcoded default value as a fallback when a required configuration surface is absent. Absence of a configuration surface is a `MissingConfigurationError`, not an occasion for silent default substitution. A worker or engine that encounters a missing configuration surface at runtime (not at startup) raises a `MissingConfigurationError` and halts the operation; it does not proceed with an assumed value.

---

## Backfill Registry

The following backfill items are open at the close of Gate 12. No action is taken on these items at this gate. They are carried forward to the designated action gate.

| # | Category | Target | Location | Change Required | Blocking? | Action Gate |
|---|---|---|---|---|---|---|
| P4 | A — Non-blocking | DEV-SPEC-001-Part2.md | §2.17.3 | Add `ai.correctionLog.maximumSize` config key | No | End session |
| P5 | B — Blocking | DEV-SPEC-001-Part6.md | §6.5 | Write 8 missing domain service sections; triggers verification passes for Parts 9 and 10 | Blocks Part 10 full lock; does not block Gates 12–13 | Dedicated P5 session |
| B4-001 (remainder) | B — Blocking (Parts 2 and 9 only) | Part 2 (four models); Part 9 §9.2.3 | Add `version Int @default(1)` to `Entry`, `GuestProfile`, `Quotation`, `WorkOrderToDoItem`; complete §9.2.3 concurrent editing middleware section | Does not block Gates 12–13 | Dedicated B4 session |

---

*End of DEV-SPEC-001-Part12.md*
