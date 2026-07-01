# LEGPHEL PMS — DEV-SPEC-001
# Part 4 — Engines
# §4.1 through §4.12

**Document:** DEV-SPEC-001-Part4.md
**Status:** DRAFT — awaiting Architect review and lock confirmation
**Canon version:** v2.5
**Authority:** MOM-ARCH-2026-013
**Gate:** Gate 4 — Engines
**Date:** 07 April 2026
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 4 — Engines |
| Sections covered | §4.1 through §4.12 |
| Declared Canon sources | Canon Block 11 §76A (Stage Transition Matrix — guard conditions reference); Canon Block 11 §76 (Stage-to-Timer/Worker Matrix — timer governance reference); Canon Blocks 5–8 §§42–50 (Stage charters S1–S9 — primary source for engine input/output detail, hardcoded vs configurable separation, and engine-specific rules per stage) |
| Schema reference | DEV-SPEC-001-Part2.md (LOCKED) — all Prisma model names, enum values, and field names used in this part are derived from Part 2; no model or enum is redefined here |
| State machine reference | DEV-SPEC-001-Part3.md (LOCKED) — engine outputs that trigger state transitions must align with Part 3 guard definitions; guard conditions are not redefined here |
| ToC source | DEV-SPEC-001_ToC_FINAL.md (LOCKED) |
| Part 1 dependency | DEV-SPEC-001-Part1.md (LOCKED) — controlled vocabulary, error taxonomy, forbidden patterns, technology stack in force for this gate |
| Part 2 dependency | DEV-SPEC-001-Part2.md (LOCKED) — schema in force |
| Part 3 dependency | DEV-SPEC-001-Part3.md (LOCKED) — state machines in force |
| Status | DRAFT — nothing is locked until Architect confirms |
| Previous gate | Gate 3 — State Machines (LOCKED) |

---

## Gate 4 Source Declaration

| Source | Scope |
|---|---|
| Canon Block 11 §76A — Stage Transition Matrix | Guard conditions that engine outputs must satisfy before state transitions may proceed. Engine sections that produce outputs consumed by state machine guards cross-reference §76A via Part 3. |
| Canon Block 11 §76 — Stage-to-Timer/Worker Matrix | Governing authority for all timers managed by the TimerEngine. Timer types, governed stages, activation conditions, warning thresholds, critical thresholds, and consequences derived verbatim from §76. |
| Canon Block 5 §§42–43 — Stage Charters S1, S2 | AvailabilityEngine DEFICIENT surface and OTA_SOURCE flag intake (§42.5, §42.7); PricingPipelineEngine activation and deterrent rate assignment (§43.4, §43.5); forbidden act: bypassing PricingPipelineEngine at S2 (§43.18). |
| Canon Block 6 §§44–45 — Stage Charters S3, S4 | FOCValidationEngine invocation at S3 exit (§44.14); OverbookingDetectionEngine trigger and OTA_SOURCE flag read at S4 (§45.5, §45.7); commitment snapshot freeze by PricingPipelineEngine output at S4 (§45.5); forbidden act: setting OTA_CONFLICT trigger as DELIBERATE (§45.18). |
| Canon Block 7 §§46–47 — Stage Charters S5, S6 | AvailabilityEngine DEFICIENT surface at S5 room assignment (§46.5); CreditCeilingMonitorEngine proximity check at S5 (§46.5); RoomAssignmentSuggestionEngine invocation at S5 (§46.5); VIP arrival notification at S6 (§47.5). |
| Canon Block 8 §§48–50 — Stage Charters S7, S8, S9 | CreditCeilingMonitorEngine active monitoring during S7 charge posting and night audit (§48.5); NightAuditEngine completeness check and idempotency guard (§48.9, §48.11); DisputeGateEngine invocation at S7→S8 and S8→S9 (§48.13, §48.14); DisputeGateEngine override tracking at S8 (§49.5); CommissionDueRecord production at S9 closure (§50.5). |

No mid-gate source loading was required. All engine content was derivable from the declared sources above plus the locked Part 2 schema and Part 3 state machines.

---

## §4.1 — Engine Design Principles

### 4.1.1 What an Engine Is

An engine is a pure computation unit. Given a set of inputs, an engine produces a deterministic output. Engines have no side effects. They do not:

- Persist any record to the database.
- Emit trace events.
- Dispatch jobs or messages.
- Call other services.
- Read from the database directly unless their input contract explicitly requires a read-only data dependency that is injected at call time.

Engines are the computation layer. Services are the orchestration layer. A service calls an engine, receives its output, and then acts on that output — posting records, emitting events, advancing state machines, dispatching workers. The engine never does this itself.

This boundary is non-negotiable. An engine method that persists a record, emits an event, or calls a service is an architectural violation, regardless of whether it produces the correct result.

### 4.1.2 Hardcoded vs Configurable Separation

Every engine section in this part carries an explicit, exhaustive separation of hardcoded behaviours from configurable parameters. This separation is a first-class architectural concern — not a documentation annotation.

**Hardcoded behaviour:** The logic is invariant. No configuration change, no runtime flag, no override permission changes this behaviour. It is encoded as unconditional logic in the engine. If a hardcoded behaviour appears to be configurable in the Admin Console, that is an architectural error.

**Configurable parameter:** The engine reads a value from the configuration tables (`ConfigurationEntry` or typed configuration models from Part 2) at invocation time. The business rule stays constant; the threshold, rate, or threshold value changes through the Admin Console. Configurable parameters are never hardcoded as constants in engine source code.

The distinction is stated explicitly for each engine below. Where an item could be misread as either, a clarifying note is provided.

### 4.1.3 Testability in Isolation

Every engine is testable in isolation: a test may construct the engine's input, call the engine, and assert the output — without any database connection, without any service context, without any pg-boss instance running. Engines must not require an application container or running infrastructure to be unit-tested.

**Consequence for implementation:** Engine classes do not use dependency injection of service containers. Required configuration values are passed as part of the input contract (injected by the calling service at invocation time). Required data reads are passed as already-resolved values. The engine receives structured input; it returns structured output.

### 4.1.4 Determinism

Given identical inputs, an engine always produces identical output. No engine introduces randomness, reads current time internally, or has internal state that varies between calls with the same arguments. If an engine needs the current timestamp (e.g., for staleness calculation), it receives it as an explicit input parameter — it does not call `Date.now()` internally.

This makes engine behaviour verifiable in tests without time-mocking.

### 4.1.5 TypeScript Interface Convention

Each engine is implemented as a class with a primary method named after the engine's main operation. Inputs and outputs are typed interfaces. No engine method accepts loose `any` types or unstructured objects.

The naming convention for the primary method:

| Engine | Primary Method |
|---|---|
| PricingPipelineEngine | `resolve(input: PricingInput): PricingResult` |
| AvailabilityEngine | `query(input: AvailabilityInput): AvailabilityResult` |
| TaxEngine | `calculate(input: TaxInput): TaxResult` |
| OverbookingDetectionEngine | `detect(input: OverbookingInput): OverbookingResult` |
| DisputeGateEngine | `canProgressStage(input: DisputeGateInput): DisputeGateResult` |
| FOCValidationEngine | `validate(input: FocValidationInput): FocValidationResult` |
| CreditCeilingMonitorEngine | `evaluate(input: CreditCeilingInput): CreditCeilingResult` |
| NightAuditEngine | `runAudit(input: NightAuditInput): NightAuditResult` |
| TimerEngine | `register(input: TimerRegistrationInput): TimerRegistration` |
| ReEntryConsequenceEngine | `compute(input: ReEntryInput): ReEntryConsequencePayload` |
| RoomAssignmentSuggestionEngine | `suggest(input: RoomSuggestionInput): RoomSuggestionResult` |

> **Notation note:** Interface definitions in this part use TypeScript-style `interface` and `type` syntax as specification notation only. The backend implementation language is JavaScript (`.js` files) per §1.8.1 — this applies to engines without exception. Stage Implementation Guidelines derived from this part must produce JavaScript engine classes, not TypeScript files. The interface definitions shown here are the structural contract — field names, types, and shapes — that JavaScript implementations realise using JSDoc annotations for IDE support and runtime validation for enforcement. No TypeScript compilation step is introduced on the backend.

---


## §4.2 — PricingPipelineEngine

### 4.2.1 Purpose

The PricingPipelineEngine resolves the applicable rate plan for a given booking context, applies any configured discounts or overrides within their governed bounds, validates the resolved rate against the Minimum Sell Rate (MSR), and produces the authoritative pricing basis for quotation or commitment. It is the sole mechanism through which a rate is determined. Manual rate entry that bypasses this engine is a forbidden pattern (§43.18).

### 4.2.2 Hardcoded Behaviours

The following behaviours are invariant. No configuration change may alter them:

**Rate plan priority order.** The engine evaluates applicable rate plans in this fixed sequence, selecting the first plan for which the booking context satisfies all conditions:

```
1. INDIVIDUAL   — individual-level rate agreements (guest_id or agent_id match)
2. PROMOTIONAL  — promotional plans (date range and eligibility conditions)
3. TIER         — guest tier rate plans (client tier match)
4. CHANNEL      — channel-specific rate plans (booking source match)
5. RACK         — base rack rate (always the final fallback)
```

This order is hardcoded in engine logic. It is not a sorted configuration table. It is a priority sequence encoded as ordered conditional evaluation. No Admin Console action may reorder these steps.

**MSR validation.** After resolving the applicable rate plan and applying any permitted discount or override, the engine validates that the final resolved rate is greater than or equal to the MSR (`RatePlan.minimumSellRate`) for the selected plan. If the resolved rate falls below the MSR, the engine returns a validation failure with `belowMsr: true` and the MSR value. The calling service must block progression until GM approval is obtained and recorded. The engine does not apply GM approval itself — it signals the failure; the service handles the authority chain.

**Deterrent rate auto-assignment.** If the guest profile carries a tier of `CAUTION` or `RESTRICTED`, the engine automatically selects the `DETERRENT` rate plan type, bypassing the standard priority evaluation. The guest is never informed that a deterrent rate applies. The deterrent rate appears on internal folio lines without disclosure language directed at the guest. The calling service must not surface the rate plan type `DETERRENT` in any guest-facing communication.

**Override margin enforcement boundary.** The engine receives the FOM override amount (if any) as an explicit input. It validates whether the override falls within `RatePlan.overrideMargin`. If the override exceeds the margin:
- The engine does not apply the override.
- It returns `overrideExceedsMargin: true` with the margin value and the proposed rate.
- The calling service is responsible for initiating the GM approval chain before re-calling the engine with the approved rate.

The engine enforces the boundary. It does not trigger the approval chain itself.

### 4.2.3 Configurable Parameters

The following are configurable and are read from the database at invocation time (injected as resolved values into the engine input):

- All rate values within rate plans (`RatePlan.minimumSellRate` and plan-specific rates per room type and season).
- Discount thresholds per authority level (front desk, FOM, GM) — from `ConfigurationEntry`.
- Override margin per rate plan (`RatePlan.overrideMargin`).
- FOC entitlement threshold (rooms per entitlement unit) — from `ConfigurationEntry`.
- Season calendar boundaries (`SeasonCalendar` model).
- Group size volume bands and associated rate multipliers — from `RatePlan.groupSizeConditions`.
- Package inclusions and their rate components — from the package registry.
- Which rate plan types are applicable to which source channels and client tiers.

### 4.2.4 Input Contract

```typescript
interface PricingInput {
  guestTier: string;                   // guest or corporate profile tier
  isDeficientTier: boolean;            // true for CAUTION or RESTRICTED guest tiers — triggers deterrent path.
                                       // NOTE: "CAUTION" and "RESTRICTED" are Canon terms (§30.3); their exact
                                       // string values in GuestProfile.tier are not locked in Part 2 (tier is
                                       // a String field, not an enum). Gate writer for guest profiling (Part 6)
                                       // must lock the canonical tier string values and verify this boolean flag
                                       // derivation. A boolean input is used here to avoid hardcoding unverified strings.
  sourceChannel: string;               // DIRECT | OTA | CORPORATE | WALK_IN | AGENT
  agentId?: string;                    // present if source is AGENT — individual agreement lookup
  corporateClientId?: string;          // present if source is CORPORATE
  checkInDate: Date;                   // as-of date for season and rate plan validity
  checkOutDate: Date;
  roomTypeId: string;
  groupSize?: number;                  // triggers volume band evaluation if present
  useType: EntryUseType;
  applicableRatePlans: RatePlanSummary[]; // resolved by calling service from DB; engine does not query
  seasonCalendar: SeasonCalendarEntry[];  // resolved by calling service from DB
  requestedDiscount?: {
    discountAmount: Decimal;
    requestingActorLevel: ActorLevel;
    discountThresholds: DiscountThreshold[]; // per-authority thresholds, resolved by calling service
  };
  fomOverrideRate?: Decimal;           // if FOM proposes a rate override; null if no override
  currentTimestamp: Date;              // explicit — engine does not call Date.now()
}

interface RatePlanSummary {
  id: string;
  ratePlanType: RatePlanType;
  minimumSellRate: Decimal;
  overrideMargin: Decimal | null;
  nightly_rate: Decimal;
  taxModel: TaxModel;
  taxRate: Decimal;
  serviceTaxRate: Decimal;
  applicableChannels: string[];
  applicableTiers: string[];
  applicableClientIds: string[];
  groupSizeConditions: GroupSizeBand[] | null;
  validFrom: Date;
  validTo: Date | null;
  isSingleUse: boolean;
}
```

### 4.2.5 Output Contract

```typescript
interface PricingResult {
  resolvedRatePlanId: string;
  resolvedRatePlanType: RatePlanType;
  resolvedNightlyRate: Decimal;          // pre-tax
  taxModel: TaxModel;
  taxRate: Decimal;                      // configurable rate; not hardcoded
  serviceTaxRate: Decimal;               // configurable rate; not hardcoded
  effectiveRate: Decimal;                // post-discount/override, pre-tax
  discountApplied: Decimal;             // 0 if no discount
  discountWithinAuthorityBounds: boolean;
  overrideApplied: Decimal;             // 0 if no override
  overrideWithinMargin: boolean | null;  // null if no override was requested
  belowMsr: boolean;                    // true if effective rate < MSR after any override
  msrValue: Decimal;                    // MSR of the resolved plan for GM approval display
  overrideExceedsMargin: boolean;
  marginValue: Decimal | null;
  isDeterrentRateApplied: boolean;      // true if CAUTION/RESTRICTED path triggered
  appliedGroupBand: GroupSizeBand | null;
  resolutionPath: PricingResolutionStep[]; // ordered log of which plan type was evaluated and why selected/skipped
}

interface PricingResolutionStep {
  ratePlanType: RatePlanType;
  evaluated: boolean;
  selected: boolean;
  skipReason?: string;
}
```

### 4.2.6 Invocation Context

| Stage | Invocation Point | Purpose |
|---|---|---|
| S2 | When PricingPipelineEngine is activated on quotation creation | Resolve rate basis for quotation |
| S2 | On each negotiation round (discount request, override request) | Validate discount/override and re-resolve rate |
| S3 | Carried forward from S2 accepted quotation — engine not re-called | Rate from S2 is the basis; engine output is preserved in quotation |
| S4 | Commitment snapshot freeze | The S2-resolved rate is frozen into `Reservation.frozenRate`; PricingPipelineEngine is not called again at S4 unless a re-entry has occurred |
| S7 | On rate amendment via universal amendment panel (PATH_2 or PATH_3) | Re-resolve rate for the amendment path |
| S7 | Room change — new room type requires rate evaluation | Re-resolve for new room type |

### 4.2.7 What the PricingPipelineEngine Does Not Do

- Does not persist the resolved rate. The calling service writes the quotation or commitment snapshot.
- Does not emit trace events.
- Does not trigger the GM approval chain. It returns `belowMsr: true` or `overrideExceedsMargin: true`; the service handles escalation.
- Does not read from the database. All rate plans, seasons, and thresholds are injected by the calling service.
- Does not produce the tax-inclusive breakdown. Tax extraction from inclusive rates is the TaxEngine's responsibility.

---

## §4.3 — AvailabilityEngine

### 4.3.1 Purpose

The AvailabilityEngine queries the two-model inventory architecture — Model 1 (claim state) and Model 2 (physical state) — to produce a structured availability result for a given date range, room type, and booking context. It is invoked at every availability search in S1, at room assignment in S5, and at re-entry points that require availability revalidation.

### 4.3.2 Hardcoded Behaviours

**Two-model evaluation is always concurrent.** The engine never returns an availability result based on Model 1 alone or Model 2 alone. Both models are evaluated together. A room that is claim-state FREE but physically BLOCKED or UNDER_MAINTENANCE is not available. A room that is physically AVAILABLE_CLEAN but claim-state CONFIRMED for the requested date range is not available. This conjunction is invariant.

**DEFICIENT flag always surfaces in results.** Any room in the search results that carries `Room.isDeficient = true` is returned with the DEFICIENT flag and condition description in the result. The flag is never suppressed from the availability result, regardless of context. The calling service determines whether to surface the flag in the UI and requires DEFICIENT flag acknowledgement before selection can be finalised.

**OTA_SOURCE flag affects result.** If the entry being searched for carries `Entry.otaSource = true`, this flag is passed through the engine. OTA-sourced entries may see different shadow inventory visibility (per shadow inventory configuration). The engine reads the shadow inventory visibility rules from the injected configuration — it does not hardcode OTA-specific visibility.

**Staleness is always flagged.** If an existing `AvailabilityConfiguration` has `isStale = true` (staleness timer fired), the engine marks the recalled configuration as requiring revalidation. The engine does not silently use a stale configuration.

**Maintenance conflict is always detected.** A room assigned to the search result set where `Room.isUnderMaintenance = true` and `Room.maintenanceDeadline` falls within the requested date range is flagged as a maintenance conflict. The engine returns it as a conflict entry, not as a silently excluded room.

### 4.3.3 Configurable Parameters

- Shadow inventory visibility rules per source channel and agent tier — from `ConfigurationEntry`.
- Which physical states are considered bookable for the search (the set is configurable, but BLOCKED and UNDER_MAINTENANCE with deadline within range are always maintenance conflicts regardless of this configuration — this is the hardcoded floor).
- DEFICIENT condition categories that trigger advisory-level vs blocking-level treatment (no category is unconditionally blocking — block vs advisory is configured per category per stage context).
- Staleness window for availability configurations — from `ConfigurationEntry`.

### 4.3.4 Input Contract

```typescript
interface AvailabilityInput {
  checkInDate: Date;
  checkOutDate: Date;
  roomTypeId?: string;          // null returns all room types
  spaceId?: string;             // for conference or catering space search
  guestCount: number;
  useType: EntryUseType;
  otaSource: boolean;           // Entry.otaSource value
  guestTier: string;
  agentTier?: string;
  shadowInventoryRules: ShadowInventoryRule[];     // injected by calling service
  bookablePhysicalStates: InventoryClaimState[];   // injected by calling service
  rooms: RoomAvailabilityRecord[];                  // resolved by calling service from DB
  spaces: SpaceAvailabilityRecord[];                // resolved by calling service from DB
  currentTimestamp: Date;
}

interface RoomAvailabilityRecord {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  capacity: int;
  currentClaimState: InventoryClaimState;
  claimConflicts: DateRangeConflict[];     // claim state events overlapping requested range
  isDeficient: boolean;
  deficientConditionCategory?: DeficientConditionCategory;
  deficientSince?: Date;
  deficientDeadline?: Date;
  deficientDescription?: string;
  isUnderMaintenance: boolean;
  maintenanceDeadline?: Date;
  isBlocked: boolean;
  blockedReason?: string;
}

interface DateRangeConflict {
  entryId: string;
  fromDate: Date;
  toDate: Date;
  claimState: InventoryClaimState;
}
```

### 4.3.5 Output Contract

```typescript
interface AvailabilityResult {
  availableRooms: AvailableRoomEntry[];
  unavailableRooms: UnavailableRoomEntry[];
  deficientRooms: DeficientRoomEntry[];    // available but DEFICIENT — requires acknowledgement
  maintenanceConflicts: MaintenanceConflictEntry[];
  searchTimestamp: Date;
  isRevalidationRequired: boolean;         // true if recalled configuration was stale
}

interface AvailableRoomEntry {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  isDeficient: false;
}

interface DeficientRoomEntry {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  isDeficient: true;
  deficientConditionCategory: DeficientConditionCategory;
  deficientDescription: string;
  deficientDeadline: Date;
  // Calling service requires explicit DEFICIENT flag acknowledgement before
  // this room may be included in a preferred configuration (§42.5, §46.5).
}

interface UnavailableRoomEntry {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  unavailabilityReason: 'CLAIMED' | 'MAINTENANCE_CONFLICT' | 'BLOCKED' | 'PHYSICAL_NOT_READY';
  claimConflicts?: DateRangeConflict[];
}

interface MaintenanceConflictEntry {
  roomId: string;
  roomNumber: string;
  maintenanceDeadline: Date;  // falls within requested range
  blockedReason?: string;
}
```

### 4.3.6 Invocation Context

| Stage | Invocation Point | Notes |
|---|---|---|
| S1 | On every availability search | DEFICIENT flag surface mandatory per §42.5 |
| S1 | On preferred configuration recall (revalidation check) | `isRevalidationRequired` returned if stale |
| S5 | Room assignment — physical readiness check | DEFICIENT status re-evaluated at current moment; S1 acknowledgement does not substitute for S5 check (§46.5) |
| S6 | Room confirmation — if room change requested at check-in | Same evaluation as S5 |
| S7 | Room change initiation — availability of alternative room | Model 1 + Model 2 for new room |
| ProcessingLock path | Reconfirmation after ProcessingLock expiry | Revalidation fires: availability state, DEFICIENT flag, and pricing re-verified at moment of new lock placement (§70A) |

### 4.3.7 What the AvailabilityEngine Does Not Do

- Does not write to `AvailabilityConfiguration`. The calling service creates the configuration record.
- Does not acknowledge DEFICIENT flags. Acknowledgement is a service-level action with actor attribution.
- Does not enforce shadow inventory access rules as a hard block — it returns visibility-filtered results per injected rules; the calling service applies the visibility.
- Does not resolve the committed date-range claim state across time. Date-range conflict detection uses `claimConflicts` injected by the calling service from `RoomClaimStateEvent` history.

---

## §4.4 — TaxEngine

### 4.4.1 Purpose

The TaxEngine computes the tax breakdown for a given charge. It handles both additive and inclusive tax models, extracts tax components from inclusive-rate charges for reporting and remittance, and applies the correct registered tax number, invoice number format, and disclosure text requirements for Bhutanese regulatory compliance. Tax correctness is non-negotiable, including on commercial adjustment entries and credit notes.

### 4.4.2 Hardcoded Behaviours

**Tax model determination logic.** The engine reads `RatePlan.taxModel` (enum `TaxModel`: `ADDITIVE` or `INCLUSIVE`) and applies the corresponding calculation path. This selection logic is hardcoded:

- `ADDITIVE`: result = net rate + BST component + service charge component as three separate lines.
- `INCLUSIVE`: result = gross rate decomposed into net component, BST component, and service charge component. The decomposition formula is: `bst_component = grossRate * (taxRate / (1 + taxRate + serviceTaxRate))`; `service_component = grossRate * (serviceTaxRate / (1 + taxRate + serviceTaxRate))`; `net_component = grossRate - bst_component - service_component`.

The switch between `ADDITIVE` and `INCLUSIVE` paths is based on the rate plan's `taxModel` field. The engine does not invent a third model.

**Tax correctness applies to all charge types.** The engine applies the same tax calculation logic to room charges, F&B charges, service charges, commercial adjustment entries, and credit note offsets. There is no charge type that is exempt from the tax engine's output validation.

### 4.4.3 Configurable Parameters

- **BST rate.** Currently 10%. Stored as `RatePlan.taxRate` (`Decimal` — not a hardcoded constant). Admin Console updates this value through the rate plan configuration surface.
- **Service charge rate.** Currently 10%. Stored as `RatePlan.serviceTaxRate`. Same Admin Console surface.
- **Tax-inclusive flag per rate plan.** `RatePlan.taxModel` is set per plan in the Admin Console.
- **Invoice number format.** Bhutanese regulatory requirement — configurable per `ConfigurationEntry` with key `bhutanese_invoice_number_format`. Not hardcoded.
- **Required disclosure text.** The regulatory disclosure text that appears on invoices — configurable per `ConfigurationEntry` with key `bhutanese_invoice_disclosure_text`. Not hardcoded.
- **Tax registration number.** Configurable per `ConfigurationEntry` with key `tax_registration_number`. Not hardcoded (§29.8).

### 4.4.4 Input Contract

```typescript
interface TaxInput {
  chargeAmount: Decimal;         // base charge before tax (ADDITIVE) or gross charge (INCLUSIVE)
  taxModel: TaxModel;            // ADDITIVE or INCLUSIVE — from rate plan
  taxRate: Decimal;              // BST rate — from rate plan; not hardcoded
  serviceTaxRate: Decimal;       // service charge rate — from rate plan; not hardcoded
  chargeType: string;            // ROOM_CHARGE | F_AND_B | SERVICE | ADJUSTMENT | OTHER
  currency: string;              // always BTN for primary computation
  invoiceContext?: {
    invoiceNumberFormat: string; // from ConfigurationEntry — for number generation
    disclosureText: string;      // from ConfigurationEntry — for invoice output
    taxRegistrationNumber: string; // from ConfigurationEntry
  };
}
```

### 4.4.5 Output Contract

```typescript
interface TaxResult {
  netAmount: Decimal;            // charge excluding all tax
  bstAmount: Decimal;            // BST component
  serviceChargeAmount: Decimal;  // service charge component
  grossAmount: Decimal;          // total inclusive of all tax
  taxModel: TaxModel;            // echoed for calling service confirmation
  appliedTaxRate: Decimal;       // echoed for audit — this is the configurable rate applied
  appliedServiceTaxRate: Decimal;
  invoiceLineItems: TaxLineItem[]; // structured line items for invoice assembly
}

interface TaxLineItem {
  description: string;
  amount: Decimal;
  type: 'NET' | 'BST' | 'SERVICE_CHARGE' | 'GROSS';
}
```

### 4.4.6 Invocation Context

| Stage | Invocation Point |
|---|---|
| S2 | Quotation creation — tax breakdown for guest |
| S3 | Proforma invoice generation |
| S7 | Every charge posting event — room, F&B, service |
| S8 | Final invoice generation; commercial adjustment entry |
| S9 | Post-stay charge posting; credit note computation |

### 4.4.7 What the TaxEngine Does Not Do

- Does not write folio lines. The calling service writes the `FolioLine` with `taxAmount`, `taxModel`, and `taxRate` from the engine's output.
- Does not enforce who is permitted to make commercial adjustments (that is a policy concern, not a tax concern).
- Does not apply exchange rate conversion. Foreign currency handling is in the service layer.

---

## §4.5 — OverbookingDetectionEngine

### 4.5.1 Purpose

The OverbookingDetectionEngine determines whether confirming a reservation creates an overbooking condition and, if so, sets the overbooking trigger type. It is the sole mechanism through which overbooking is detected and classified. The trigger type it sets — `DELIBERATE` or `OTA_CONFLICT` — is immutable once the engine sets it on the overbooking record.

### 4.5.2 Hardcoded Behaviours

**OTA_SOURCE flag determines trigger type.** If the entry being confirmed carries `Entry.otaSource = true`, and an overbooking condition is detected, the trigger type is unconditionally set to `OTA_CONFLICT`. The engine does not evaluate any other input to set the trigger type when the OTA flag is present. This is hardcoded. A confirming actor cannot override this classification; the engine returns `triggerType: OTA_CONFLICT` regardless.

Conversely, if `Entry.otaSource = false` and an overbooking condition is detected, the trigger type is `DELIBERATE`. This represents a hotel-initiated commercial overbooking decision.

**OTA_CONFLICT trigger type is immutable once set.** The engine returns `triggerType: OTA_CONFLICT`. The calling service writes this to `OtaConflictOverbookingRecord.triggerType`. Once written, this field is immutable. No subsequent action — including a GM override — may reclassify an `OTA_CONFLICT` record as `DELIBERATE`. Setting `OTA_CONFLICT` as `DELIBERATE` when the OTA flag is present is an explicitly named forbidden act (per ToC §4.5 content requirements, referencing §64 M.13 — §64 was not loaded at Gate 4). The engine enforces this by design: it does not accept a `requestedTriggerType` override parameter.

**Overbooking detection runs at two fixed points:**
1. At S4 confirmation — when `confirmEntry()` is called by the confirmation service.
2. At OTA booking verification click — when an OTA booking is manually verified by the operator (additional OTA-specific check at S4).

These are the only invocation points. Overbooking detection does not run at S1, S2, S3, or post-S4 stages.

**OTA_CONFLICT carries an additional open loop.** When the engine returns `triggerType: OTA_CONFLICT`, it also returns `requiresOtaPlatformNotification: true`. This open loop is tracked separately from the mitigation plan. The calling service creates the `OtaConflictOverbookingRecord` with both `otaNotificationStatus: 'OPEN'` and `mitigationPlanStatus: 'OPEN'`. The engagement record is not closed until both loops are resolved.

### 4.5.3 Configurable Parameters

- Overbooking approval limits — from `ConfigurationEntry` with key `overbooking_approval_limit`. Determines how many rooms above physical capacity may be simultaneously overbooked before an escalation threshold fires.
- OTA_CONFLICT trigger rules — from `ConfigurationEntry` with key `ota_conflict_trigger_rules`. Governs the conditions under which an OTA booking creates a conflict (e.g., which OTA channels are subject to which detection rules). The engine reads this configuration, but the OTA_SOURCE flag evaluation is still hardcoded.

### 4.5.4 Input Contract

```typescript
interface OverbookingInput {
  entryId: string;
  otaSource: boolean;                          // Entry.otaSource — hardcoded trigger type determination
  roomTypeId: string;
  requestedDateRange: { checkIn: Date; checkOut: Date };
  existingConfirmedClaims: ExistingClaim[];    // all CONFIRMED claims for the room type in the date range
  physicalInventoryCount: number;              // total rooms of this type
  overbookingApprovalLimit: number;            // from ConfigurationEntry — injected by calling service
  otaConflictTriggerRules: OtaTriggerRule[];   // from ConfigurationEntry — injected
  isOtaVerificationClick: boolean;             // true when called from OTA verification, not confirmation
}

interface ExistingClaim {
  entryId: string;
  roomId: string;
  claimState: InventoryClaimState;
  otaSource: boolean;
}
```

### 4.5.5 Output Contract

```typescript
interface OverbookingResult {
  overbookingDetected: boolean;
  triggerType: OverbookingTriggerType | null;  // null if no overbooking detected
  overbookedCount: number;                      // rooms over physical capacity
  conflictingClaims: ExistingClaim[];           // the claims that create the conflict
  requiresGmApproval: boolean;                  // true if any overbooking detected; GM must approve before S4 proceeds
  requiresOtaPlatformNotification: boolean;     // true if triggerType is OTA_CONFLICT
  mitigationPlanRequired: boolean;              // always true if overbookingDetected
  exceedsApprovalLimit: boolean;                // true if overbookedCount > overbookingApprovalLimit
}
```

### 4.5.6 Invocation Context

The confirmation service calls `OverbookingDetectionEngine.detect()` during S4 confirmation before the confirmation event is written. If `overbookingDetected: true`, the confirmation service halts progression and initiates the GM approval workflow. Only after GM approval is recorded does the calling service re-invoke the confirmation flow with the overbooking record written. The engine is not called again after GM approval — the approval record is the evidence that overbooking was reviewed.

### 4.5.7 What the OverbookingDetectionEngine Does Not Do

- Does not create the `OtaConflictOverbookingRecord`. The calling service creates this after receiving a positive detection result.
- Does not initiate the GM approval chain. It returns `requiresGmApproval: true`; the service handles escalation.
- Does not close the OTA notification open loop. That is a worker responsibility (OtaNotificationWorker).

---

## §4.6 — DisputeGateEngine

### 4.6.1 Purpose

The DisputeGateEngine evaluates whether a pending or active dispute blocks a stage progression. It is the sole mechanism through which dispute-governed stage exits are evaluated. The engine returns one of three values. The calling service acts on the return value; the engine does not block or advance the state machine itself.

### 4.6.2 Hardcoded Behaviours

**Three-value return.** The engine always returns exactly one of three values:

```typescript
type DisputeGateOutcome = 'CLEAR' | 'BLOCKED' | 'BLOCKED_WITH_OVERRIDE_AVAILABLE';
```

- `CLEAR`: no active dispute is configured to block this stage progression. Transition may proceed.
- `BLOCKED_WITH_OVERRIDE_AVAILABLE`: a dispute is configured to block this transition, but FOM override is available. The calling service handles the override path: if FOM records a `DisputeGateOverrideRecord`, the transition may proceed. The engine does not create the `DisputeGateOverrideRecord`.
- `BLOCKED`: a dispute is configured to block this transition and no override is available for this specific transition. Transition may not proceed under any circumstances at this gate.

**S8→S9 exception.** If the target stage transition is `S8 → S9` and any dispute on the entry is in state `OPEN` or `IN_PROGRESS`, the engine always returns `BLOCKED` — not `BLOCKED_WITH_OVERRIDE_AVAILABLE`. There is no override path at the S8→S9 gate when a dispute is unresolved. This is hardcoded and not overridable by configuration. A dispute must reach `RESOLVED` or `CLOSED` (GM authority) before S9 entry is permitted (per ToC §4.6 content requirements, referencing §53 M.7 — §53 was not loaded at Gate 4).

**DisputeGateOverrideRecord is created by the service, not the engine.** When the engine returns `BLOCKED_WITH_OVERRIDE_AVAILABLE` and FOM exercises the override, the service layer creates the `DisputeGateOverrideRecord` with FOM's identity, reason, dispute reference, and timestamp. The engine is not called again after the override record is written — the record is the authorised override evidence.

### 4.6.3 Configurable Parameters

- Which dispute types (`DisputeFailureCategory` values) block which stage progressions, per stage pair — from dispute gate function configuration (`ConfigurationEntry` with key `dispute_gate_function_config`). This is the gate function configuration referenced in §53 M.7.
- Whether FOM override is available at a given stage pair (per gate function configuration). The S8→S9 exception is hardcoded regardless of this configuration.

### 4.6.4 Input Contract

```typescript
interface DisputeGateInput {
  entryId: string;
  fromStage: Stage;
  toStage: Stage;
  activeDisputes: ActiveDisputeSummary[];      // injected by calling service
  gateConfig: DisputeGateConfig[];             // from ConfigurationEntry — injected
}

interface ActiveDisputeSummary {
  disputeId: string;
  failureCategory: DisputeFailureCategory;
  state: DisputeState;
}

interface DisputeGateConfig {
  fromStage: Stage;
  toStage: Stage;
  blockingCategories: DisputeFailureCategory[];
  overrideAvailable: boolean;
}
```

### 4.6.5 Output Contract

```typescript
interface DisputeGateResult {
  outcome: DisputeGateOutcome;       // CLEAR | BLOCKED | BLOCKED_WITH_OVERRIDE_AVAILABLE
  blockingDisputes: ActiveDisputeSummary[];  // empty if CLEAR
  overrideAvailable: boolean;
  // If outcome is BLOCKED: overrideAvailable is false
  // If outcome is BLOCKED_WITH_OVERRIDE_AVAILABLE: overrideAvailable is true;
  //   calling service must create DisputeGateOverrideRecord before state transition
  // S8→S9 with OPEN/IN_PROGRESS dispute: outcome is always BLOCKED, overrideAvailable is always false
}
```

### 4.6.6 Invocation Context

| Transition | Invocation point | Notes |
|---|---|---|
| S7 → S8 | S7 exit guard | Part 3 §3.2 guard: `disputeGate.canProgressStage()` must return `CLEAR` or `BLOCKED_WITH_OVERRIDE_AVAILABLE` |
| S8 → S9 | S8 exit guard | S8→S9 exception applies: `OPEN` or `IN_PROGRESS` dispute returns `BLOCKED`, no override |

The engine is not called at other stage progressions unless the gate function configuration explicitly adds a gate at an additional stage pair. Adding a gate at an additional stage pair requires Admin Console configuration change — it does not require code change.

### 4.6.7 FOM Override Tracking

When FOM exercises a `BLOCKED_WITH_OVERRIDE_AVAILABLE` override at S8, the calling service creates a `DisputeGateOverrideRecord` (Part 2 §2.9). The override frequency tracking is a separate concern handled by the `FomOverrideFrequencyWorker` (Part 8), which evaluates whether the FOM actor has exceeded the configured frequency threshold within the rolling period. The engine does not track or evaluate override frequency.

### 4.6.8 What the DisputeGateEngine Does Not Do

- Does not resolve or close disputes. Dispute lifecycle is governed by its own state machine (Part 3 §3.4).
- Does not create override records. The calling service creates `DisputeGateOverrideRecord`.
- Does not track FOM override frequency. That is a worker concern.
- Does not evaluate payment or folio state — those are separate S8 exit guards evaluated independently.

---

## §4.7 — FOCValidationEngine

### 4.7.1 Purpose

The FOCValidationEngine validates whether a Free of Charge (FOC) room allocation meets the three governing conditions: the MSR check, the seasonality check, and the entitlement check. It is invoked before an FOC room may be included in a speculative hold (S2), committed hold (S3), or confirmed reservation (S4). All three checks must pass before FOC is valid. The engine does not approve FOC — it returns a validation result; GM approval is obtained by the calling service after a passing result.

### 4.7.2 Hardcoded Behaviours

**All three checks are mandatory.** The engine evaluates all three checks in every call. There is no configuration that disables a check. A partial validation (only MSR, only entitlement) is not a valid engine state.

**MSR check.** The FOC room rate — even though it is complimentary — must be above the applicable MSR. This prevents FOC allocation from being used to circumvent the MSR floor. The engine compares the applicable rack rate (the benchmark for FOC) against `RatePlan.minimumSellRate` for the room type and date range. If the applicable rate falls below MSR (e.g., if the MSR has been raised since the FOC was originally discussed), the check fails. Failure reason: `msr_check_failed`.

**GM approval is always required for FOC.** The engine returns `requiresGmApproval: true` regardless of the validation outcome. Passing validation does not grant FOC — it enables the GM approval request. If the engine returns any failure, GM approval cannot be sought until the failure is remediated. This is hardcoded — no authority level substitutes for GM on FOC decisions (§30.3).

### 4.7.3 Configurable Parameters

- **Entitlement formula.** FOC entitlement is typically one complimentary room per N paid rooms (default: one per 10 paid rooms, as stated in §30.3 and ToC §4.7 content requirements). The formula is configurable: the entitlement ratio and whether entitlement applies per booking or per contract terms — from `ConfigurationEntry` with key `foc_entitlement_formula`.
- **Seasonality restriction.** FOC may be restricted to specific seasons or excluded from peak season — from `ConfigurationEntry` with key `foc_season_restrictions`. If no restriction is configured, the seasonality check always passes.

### 4.7.4 Input Contract

```typescript
interface FocValidationInput {
  entryId: string;
  roomTypeId: string;
  checkInDate: Date;
  checkOutDate: Date;
  applicableRackRate: Decimal;        // resolved by calling service
  applicableMsr: Decimal;             // resolved by calling service from RatePlan
  groupSize: number;                  // total paid rooms in the group booking
  existingFocAllocations: number;     // FOC rooms already allocated to this group
  entitlementFormula: FocEntitlementFormula; // from ConfigurationEntry — injected
  seasonRestrictions: FocSeasonRestriction[]; // from ConfigurationEntry — injected
  currentTimestamp: Date;
}

interface FocEntitlementFormula {
  paidRoomsPerFoc: number;            // e.g., 10 means 1 FOC per 10 paid rooms
  basis: 'PER_BOOKING' | 'PER_CONTRACT'; // configurable basis
  maxFocRooms?: number;               // optional cap per engagement
}

interface FocSeasonRestriction {
  seasonName: string;
  restrictionType: 'EXCLUDED' | 'ADVISORY';
  fromDate: Date;
  toDate: Date;
}
```

### 4.7.5 Output Contract

```typescript
interface FocValidationResult {
  isValid: boolean;             // true only if all three checks pass
  msrCheckPassed: boolean;
  seasonalityCheckPassed: boolean;
  entitlementCheckPassed: boolean;
  failureReasons: FocFailureReason[];
  entitlementAllowance: number;   // how many FOC rooms are entitled given group size
  entitlementUsed: number;        // how many already allocated
  entitlementRemaining: number;   // allowance minus used
  requiresGmApproval: boolean;    // always true — hardcoded
  seasonRestrictionType?: 'EXCLUDED' | 'ADVISORY'; // populated if seasonality check triggered
}

type FocFailureReason = 'msr_check_failed' | 'season_excluded' | 'entitlement_exceeded';
```

### 4.7.6 Invocation Context

| Stage | Invocation Point | Notes |
|---|---|---|
| S2 | On FOC room inclusion in speculative hold | Validation required before hold may include FOC room |
| S3 | S3 exit gate — FOC room in committed hold | `S3 exit blocked if FOCValidationEngine returns isValid: false` (§44.14) |
| S4 | S4 FOC verification step | FOM verification for conference with complimentary coordinator room |

### 4.7.7 What the FOCValidationEngine Does Not Do

- Does not record GM approval. The calling service records the GM approval event with actor attribution.
- Does not evaluate commission on FOC rooms (commission calculation is the service layer's responsibility using `CommissionDueRecord` logic at S9).

---

## §4.8 — CreditCeilingMonitorEngine

### 4.8.1 Purpose

The CreditCeilingMonitorEngine evaluates the current outstanding balance against the credit extension ceiling for an entry, determines which threshold tier applies, and produces the appropriate response — advisory notice, FOM interruption, or soft gate on non-mandatory charges. It is invoked on every charge posting event during S7 and on every night audit cycle.

### 4.8.2 Hardcoded Behaviours

**Three threshold tiers — fixed percentages.**

```
75%  → ADVISORY: ambient notice surfaced on FOM dashboard
90%  → ACTIVE_INTERRUPTION: non-dismissible FOM notification requiring acknowledgement
100% → SOFT_GATE: FOM acknowledgement required before each non-mandatory charge posts
```

These percentages are not configurable. The threshold response type at each tier is not configurable.

**Night audit mandatory room charges always continue at 100%.** Even when the ceiling is reached or exceeded, the night audit posts mandatory room charges without FOM acknowledgement. This is hardcoded. Non-mandatory charges (F&B, service, extras) require FOM acknowledgement at and above 100%. The engine marks which charges are mandatory vs non-mandatory based on the charge type:
- Mandatory: `ROOM_CHARGE` posted by night audit.
- Non-mandatory: `F_AND_B`, `SERVICE`, any other charge type.

**Night audit cycle and every charge posting event both trigger evaluation.** The engine is called after every `FolioLine` create event during S7, and after every night audit completion. Neither trigger is optional.

**Every threshold crossing produces a `CreditCeilingThresholdEvent` record.** The engine returns `thresholdCrossed: true` when a threshold is crossed for the first time. The calling service writes the `CreditCeilingThresholdEvent` record. If the balance has already crossed a threshold in a prior evaluation, the engine returns the active tier without flagging a new crossing.

**Ceiling monitoring transfers with ownership during shift handover.** The engine does not enforce this — it is a service-layer concern. The engine evaluates the ceiling state as of the injected balance; who is responsible for acknowledging it is a staffing concern.

### 4.8.3 Configurable Parameters

- **Credit ceiling amount per entry.** Set at S3 and recorded in `CreditExtensionCeilingRecord.ceilingAmount`. Configurable per engagement — not a system-wide constant. Ceiling revisions during the stay add a new `CreditExtensionCeilingRecord`; the engine uses the most recent active ceiling.
- **Charge posting rules that define which charges are mandatory vs non-mandatory** — from `ConfigurationEntry` with key `night_audit_mandatory_charge_types`. This configuration extends the mandatory set if additional charge types are designated mandatory for a specific property configuration. The baseline `ROOM_CHARGE` from night audit is always mandatory regardless of this configuration.

### 4.8.4 Input Contract

```typescript
interface CreditCeilingInput {
  entryId: string;
  ceilingAmount: Decimal;                  // from most recent CreditExtensionCeilingRecord
  currentOutstandingBalance: Decimal;      // computed by calling service from live folio
  priorThresholdsCrossed: number[];        // [75, 90, 100] — already-crossed percentages
  proposedChargeAmount: Decimal;           // the charge being evaluated; 0 if night audit cycle evaluation
  proposedChargeType: string;             // ROOM_CHARGE | F_AND_B | SERVICE | OTHER
  isNightAuditCycle: boolean;             // true when called from night audit; false from charge posting
  mandatoryChargeTypes: string[];          // from ConfigurationEntry — injected
}
```

### 4.8.5 Output Contract

```typescript
interface CreditCeilingResult {
  currentUtilisationPercentage: Decimal;
  activeTier: 75 | 90 | 100 | null;        // null if below 75%
  thresholdCrossed: boolean;               // true if this evaluation crossed a new threshold
  crossedThreshold: 75 | 90 | 100 | null;
  response: 'NONE' | 'ADVISORY' | 'ACTIVE_INTERRUPTION' | 'SOFT_GATE';
  chargeIsNonMandatory: boolean;           // true if proposed charge requires FOM ack at 100%
  chargeBlockedPendingAcknowledgement: boolean; // true if SOFT_GATE and charge is non-mandatory
  // Calling service:
  // — writes CreditCeilingThresholdEvent if thresholdCrossed: true
  // — blocks charge posting if chargeBlockedPendingAcknowledgement: true
  //   until FOM acknowledgement event is recorded
  // — surfaces ACTIVE_INTERRUPTION to FOM before continuing
}
```

### 4.8.6 Invocation Context

| Trigger | Stage | Notes |
|---|---|---|
| Every `FolioLine` create | S7 | Called in the same service transaction as the charge posting |
| Night audit completion | S7 nightly | Called by `NightAuditService` after charge posting loop |
| S5 advance payment reconciliation | S5 | Proximity check — ceiling surfaced if current balance approaching threshold at pre-arrival |

### 4.8.7 What the CreditCeilingMonitorEngine Does Not Do

- Does not create `CreditCeilingThresholdEvent`. The calling service writes the record.
- Does not send notifications to FOM. Notification dispatch is a worker concern (`CreditCeilingNotificationWorker`).
- Does not calculate the outstanding balance. The calling service computes the balance from the live folio and injects it.
- Does not block charge posting itself — it returns `chargeBlockedPendingAcknowledgement: true`; the calling service enforces the block.

---

## §4.9 — NightAuditEngine

### 4.9.1 Purpose

The NightAuditEngine processes all active in-stay entries for a given operating date: it posts daily room charges per each entry's commitment snapshot and rate plan, runs the occupancy reconciliation, performs the missing expected charges completeness check, and produces the `NightAuditRecord`. Night audit is atomic in intent — either every eligible entry is processed, or the run status is `PARTIAL` with an explicit record of which entries were not processed and why.

### 4.9.2 Hardcoded Behaviours

**Atomic intent with PARTIAL status.** The engine processes entries in sequence. If processing for an individual entry fails in a way that cannot be recovered within the run (a data integrity exception, an unexpected null, a rate plan gap), the engine does not halt the entire audit. It flags that entry as `AUDIT_EXCEPTION`, continues processing remaining entries, and produces a `NightAuditRecord` with `runStatus: PARTIAL`. A `PARTIAL` status is escalated to FOM immediately after the run (§62 M.14). A `FAILED` status is produced only if the audit cannot be initiated at all (pre-run validation failure).

**Idempotency guard.** Before processing any entry, the engine checks whether a `FolioLine` with `chargeDate` matching the operating date and `lineType: 'ROOM_CHARGE'` and `nightAuditRecordId` already exists on the entry's live folio. If such a line exists, the entry is skipped for charge posting. The skip is recorded in the `NightAuditRecord.entriesFullyProcessed` list as already-processed, not as an anomaly. This allows a failed audit to be re-run safely without double-posting charges. **The idempotency guard is hardcoded and cannot be bypassed.**

**Missing expected charges completeness check.** After posting charges for each entry, the engine evaluates whether all charges expected per the entry's commitment snapshot and rate plan have been posted for the operating date. Expected charges are determined by the rate plan's `expected_charges` configuration (from `ConfigurationEntry` with key `night_audit_expected_charges_rules`). If expected charges are missing:
- The engine creates a `NightAuditAnomaly` with `anomalyType: 'MISSING_EXPECTED_CHARGE'` for each missing charge.
- The missing charge is **not** auto-posted. It is flagged for FOM review. This is hardcoded (§62 M.8).
- FOM determines whether to post the charge, defer it, or record a reason for omission.

**Charge posting logic per rate plan.** Room charge amount is derived from `Reservation.frozenRate` (the commitment snapshot — not the current rate plan). The commitment snapshot is the authority for charge posting throughout the stay. If the current rate plan has changed since S4, the night audit continues to use the frozen rate. This is hardcoded — night audit never re-resolves the rate.

**AI Audit Supplement Record.** After the charge posting and completeness check loop, the engine produces metadata that the AI Audit Supplement service uses to generate the nightly AI Audit Supplement Record and attach it to the `NightAuditRecord`. The engine itself does not generate the AI observations — it produces the structured data input for the AI supplement. The AI supplement generation is a separate service call made by `NightAuditService` after the engine completes.

**Re-calculation of next-day timers.** After the engine completes, the calling service triggers `TimerEngine` to recalculate all next-day timers (§62 M.10). This is a service-layer responsibility; the engine does not call the TimerEngine directly.

### 4.9.3 Configurable Parameters

- **Audit schedule or trigger type.** Automated time-based trigger or staff-initiated trigger — from `ConfigurationEntry` with key `night_audit_schedule`. The engine itself is not schedule-aware; the `NightAuditSchedulerWorker` triggers it per the configured schedule.
- **Anomaly detection thresholds.** What constitutes an anomaly beyond missing expected charges — from `ConfigurationEntry` with key `night_audit_anomaly_thresholds`.
- **Expected charges completeness rules per rate plan.** Which charges are expected for which rate plans — from `ConfigurationEntry` with key `night_audit_expected_charges_rules`. This is the configurable surface; the completeness check logic itself is hardcoded.
- **Mandatory charge types for credit ceiling monitoring.** The engine reads this configuration when evaluating ceiling status during charge posting — same key as §4.8.3.

### 4.9.4 Input Contract

```typescript
interface NightAuditInput {
  operatingDate: Date;                         // the date being audited
  eligibleEntries: NightAuditEntryContext[];   // all in-stay entries for this date — injected
  expectedChargesRules: ExpectedChargesRule[]; // from ConfigurationEntry — injected
  anomalyThresholds: AnomalyThreshold[];       // from ConfigurationEntry — injected
  currentTimestamp: Date;                      // explicit — engine does not call Date.now()
}

interface NightAuditEntryContext {
  entryId: string;
  folioId: string;
  frozenRate: Decimal;               // from Reservation.frozenRate — commitment snapshot
  frozenRatePlanId: string;
  taxModel: TaxModel;
  taxRate: Decimal;
  serviceTaxRate: Decimal;
  creditCeilingAmount?: Decimal;     // null if no credit ceiling on this entry
  priorThresholdsCrossed: number[];  // for CreditCeilingMonitorEngine evaluation
  existingChargeEvents: ExistingChargeEvent[]; // for idempotency guard check
}

interface ExistingChargeEvent {
  chargeDate: Date;
  lineType: string;
  nightAuditRecordId: string | null;
}

interface ExpectedChargesRule {
  ratePlanId: string;
  expectedChargeTypes: string[];     // ROOM_CHARGE | F_AND_B | SERVICE | etc.
}
```

### 4.9.5 Output Contract

```typescript
interface NightAuditResult {
  operatingDate: Date;
  runStatus: NightAuditRunStatus;   // COMPLETE | PARTIAL | FAILED
  entriesProcessed: NightAuditEntryResult[];
  totalChargeSummary: ChargeSummary;
  occupancySummary: OccupancySummary;
  anomalies: NightAuditAnomalyEntry[];
  pointOfFailure?: string;          // populated on PARTIAL or FAILED
  entriesNotProcessed: string[];    // entry IDs for PARTIAL run
  auditSupplementInputData: AuditSupplementData; // structured data for AI supplement service
  // Calling service (NightAuditService):
  // — writes NightAuditRecord to DB
  // — writes FolioLine per processed entry per chargePosted in NightAuditEntryResult
  // — writes NightAuditAnomaly per anomaly
  // — calls TaxEngine for each charge amount before writing FolioLine
  // — calls CreditCeilingMonitorEngine after each FolioLine write for ceiling-monitored entries
  // — escalates PARTIAL run to FOM via notification worker
  // — triggers TimerEngine next-day recalculation after run completes
}

interface NightAuditEntryResult {
  entryId: string;
  processed: boolean;
  skippedByIdempotencyGuard: boolean;  // true if already processed for this date
  chargePosted: ChargePostedSummary | null;
  anomalies: NightAuditAnomalyEntry[];
  auditExceptionFlag: boolean;
  auditExceptionReason?: string;
}

interface ChargePostedSummary {
  amount: Decimal;
  chargeDate: Date;
  lineType: 'ROOM_CHARGE';
}

interface NightAuditAnomalyEntry {
  entryId: string;
  anomalyType: 'MISSING_EXPECTED_CHARGE' | 'AUDIT_EXCEPTION';
  description: string;
  expectedChargeRef?: string;
}

interface ChargeSummary {
  totalRoomCharges: Decimal;
  totalTaxCollected: Decimal;
  totalEntries: number;
  processedEntries: number;
  skippedEntries: number;  // idempotency guard skips
  anomalyEntries: number;
}

interface OccupancySummary {
  totalOccupied: number;
  checkInsToday: number;
  checkOutsToday: number;
  stayOvers: number;
}
```

### 4.9.6 Invocation Context

The `NightAuditSchedulerWorker` (or staff-initiated trigger through the Admin Console) calls `NightAuditService.runNightAudit()`. The service assembles the `NightAuditInput` from the database — resolving all active entries, their commitment snapshots, their folio states, and the configuration — then calls `NightAuditEngine.runAudit()`. After receiving the result, the service writes all records in a single database transaction per entry. A transaction failure for one entry produces an `AUDIT_EXCEPTION` for that entry; the audit continues with remaining entries.

### 4.9.7 What the NightAuditEngine Does Not Do

- Does not write `NightAuditRecord`, `FolioLine`, or `NightAuditAnomaly` to the database.
- Does not call the TaxEngine. The calling service calls TaxEngine per charge before writing the `FolioLine`.
- Does not call the CreditCeilingMonitorEngine. The calling service calls it per charge posting for ceiling-monitored entries.
- Does not escalate `PARTIAL` run to FOM. The calling service triggers the notification worker.
- Does not generate the AI Audit Supplement. It produces `auditSupplementInputData`; the service passes this to the AI supplement service.
- Does not recalculate next-day timers. The calling service triggers TimerEngine recalculation after run completion.

---

## §4.10 — TimerEngine

### 4.10.1 Purpose

The TimerEngine is the governance backbone for all time-governed events in the system. It registers, tracks, and fires all governed timers by dispatching events through pg-boss to the appropriate worker. It does not execute expiry actions itself — it delegates to workers. Its persistence backing (pg-boss job queue + `TimerRecord` / `TimerEvent` models from Part 2) ensures that timer state survives system restarts.

### 4.10.2 Infrastructure Foundation

**pg-boss.** The TimerEngine is implemented on pg-boss (PostgreSQL-native job scheduling). All timer jobs are persisted in pg-boss's job table. When the TimerEngine registers a timer, it creates both a `TimerRecord` (in the PMS schema) and a pg-boss job. The `TimerRecord.pgBossJobId` links the two. On timer fire, pg-boss executes the registered job handler, which dispatches the event to the correct worker.

**Polling interval.** pg-boss polls for due jobs at a configurable interval. Timer accuracy is within one polling interval. Timer exact-second precision is not guaranteed — only polling-interval precision. The polling interval is configurable via `ConfigurationEntry` with key `timer_engine_polling_interval_seconds`. The default should be set conservatively (30 seconds or less) to ensure governed timer accuracy is operationally acceptable.

**Failure recovery.** pg-boss provides durable job persistence. If the application restarts while a timer is in flight, pg-boss recovers the job state on restart. No timer is silently lost on restart. The `TimerRecord` state (`TimerStatus`) is kept consistent with the pg-boss job state by the registration and fire handlers.

### 4.10.3 Timer Registry

The following table enumerates all governed timers managed by this engine. The primary source for this registry is §76 (Stage-to-Timer/Worker Matrix, Canon Block 11). The majority of entries are derived from §76 without modification. Three additional timers — `PROCESSING_LOCK_TTL`, `VOICE_NOTE_SLA`, and `AI_DRAFT_REVIEW_TTL` — are included per the ToC §4.10 content requirements, which reference §70A, §70B, and §70C respectively. Those Canon sections were not declared Gate 4 sources and were not loaded at this gate; their content was derived from the ToC content requirements only. Gate writers for Parts 6 and 8 must verify these three entries against §70A, §70B, and §70C at their respective gates and surface any discrepancy as a Category 1 clarification request. Every timer listed here has a corresponding `timerType` value used as the key in `TimerRecord.timerType`.

| Timer Type Key | Governed Stages | Activation | Warning | Critical / Expiry | Dispatches To |
|---|---|---|---|---|---|
| `STAGE_DWELL_MONITOR` | S1–S9 | Entry enters stage | Mode-dependent threshold | Mode-dependent threshold | `StageDwellWorker` |
| `ENTRY_EXPIRY` | S1 (primary) | Entry created or unparked | Configurable | Configurable | `EntryExpiryWorker` |
| `AVAILABILITY_STALENESS` | S1–S2 | Availability configuration created | Configurable window | Window expires | `AvailabilityStalenessWorker` |
| `QUOTATION_VALIDITY` | S2 | Quotation sent | Approaching expiry | Validity window expires | `QuotationExpiryWorker` |
| `QUOTATION_ACK_TRACKER` | S2 | Quotation sent | Approaching response window | Window expires without acknowledgement | `QuotationAckWorker` |
| `SPECULATIVE_HOLD_EXPIRY` | S2 | Hold placed | Approaching expiry | Hold timer expires | `SpeculativeHoldExpiryWorker` |
| `COMMITTED_HOLD_EXPIRY` | S3–S4 | Hold placed | Approaching expiry | Timer expires without S4 confirmation | `CommittedHoldExpiryWorker` |
| `PAYMENT_MILESTONE` | S3–S7 | Milestone configured | Approaching deadline | Deadline missed | `PaymentMilestoneWorker` |
| `PRE_ARRIVAL_COUNTDOWN` | S4–S5 | S4 confirmation | Configurable window opens | Arrival imminent | `PreArrivalWorker` |
| `ACKNOWLEDGEMENT_WINDOW` | S2–S9 | Material communication sent | Approaching window close | Window expires without acknowledgement | `AcknowledgementTimeoutWorker` |
| `CONFIRMATION_ACK_TRACKER` | S4 | Confirmation voucher sent | Approaching response window | Window exceeded without acknowledgement | `ConfirmationAckWorker` |
| `ROOM_READINESS_SLA` | S5–S6 | Room assigned; not yet ready | SLA approaching | SLA breached | `RoomReadinessWorker` |
| `DEFICIENT_RESOLUTION_DEADLINE` | S5–S7 | DEFICIENT flag set on occupied or assigned room | Approaching deadline | Deadline breached | `DeficientResolutionWorker` |
| `HOUSEKEEPING_SLA` | S8 | Room transitions to DEPARTED_DIRTY | SLA approaching | SLA breached | `HousekeepingSlaWorker` |
| `H2_H3_ACCEPTANCE` | S6 | Handoff created | Configurable window | Unaccepted past window | `HandoffAcceptanceWorker` |
| `NIGHT_AUDIT_SCHEDULE` | S7 (daily) | Scheduled or triggered | N/A | Must complete before next operating day | `NightAuditSchedulerWorker` |
| `CHECKOUT_TIME` | S8 | Checkout date reached | Approaching checkout time | Overdue checkout | `CheckoutTimeWorker` |
| `DISPUTE_SLA` | S7–S9 | Dispute opened | Time-to-first-response target | Time-to-resolution target | `DisputeSlaWorker` |
| `RESOLUTION_EXECUTION` | S7–S9 | Resolution bundle approved | Commitment deadline approaching | Deadline passed | `ResolutionExecutionWorker` |
| `NO_SHOW_CUTOFF` | S5 | Expected arrival time reached | Cutoff approaching | Cutoff reached without arrival | `NoShowCutoffWorker` |
| `AWAITING_WRITTEN_CONFIRMATION` | S5 | Guest claims late arrival verbally | Window approaching | Window expires without written confirmation | `NoShowFinalisationWorker` |
| `OTA_NOTIFICATION_OPEN_LOOP` | S4–S5 | OTA_CONFLICT overbooking confirmed | Partner hotel contacted | Loop exceeds configured window | `OtaNotificationWorker` |
| `CREDIT_CEILING_MONITORING` | S5–S8 | Credit extension approved at S3 | 75% threshold crossed | 90% active interruption; 100% soft gate | `CreditCeilingNotificationWorker` |
| `PAYMENT_FOLLOW_UP` | S9 | Invoice dispatched with outstanding | Reminder intervals | Overdue past threshold | `PaymentFollowUpWorker` |
| `POST_CHECKOUT_INSPECTION` | S8–S9 | Inspection deferred at checkout | Window approaching | Window expires | `PostCheckoutInspectionWorker` |
| `FEEDBACK_SOLICITATION` | S9 | Checkout complete | Configurable delay | Sent (both channels) | `FeedbackSolicitationWorker` |
| `EQUIPMENT_RETURN` | S7–S9 | Equipment allocated to event | Return deadline approaching | Deadline passed | `EquipmentReturnWorker` |
| `LOST_FOUND_RETENTION` | S9+ | Item logged | Retention period approaching | Period expires | `LostFoundRetentionWorker` |
| `MAINTENANCE_EXPECTED_READY_AT` | Any | Room enters UNDER_MAINTENANCE | Approaching ready date | Ready date breached | `MaintenanceReadyWorker` |
| `BLOCKED_ROOM_UNBLOCK_DATE` | Any | Room BLOCKED | Approaching date | Date passed | `BlockedRoomWorker` |
| `COMMISSION_RATE_MISSING_ESCALATION` | S9 | Commission-due record created with RATE_MISSING status | Approaching resolution window | Window expires without resolution | `CommissionRateMissingWorker` |
| `FOM_OVERRIDE_FREQUENCY_WINDOW` | S8 | Rolling period (configurable default 30 days) | Override frequency approaching threshold | Threshold exceeded | `FomOverrideFrequencyWorker` |
| `RELOCATION_EXTERNAL_HANDSHAKE` | S4–S5 | Relocation decision recorded | Both loops approaching closure window | Window exceeded with open loops | `RelocationHandshakeWorker` |
| `PROCESSING_LOCK_TTL` | Any | Processing lock placed | N/A | TTL expires | `ProcessingLockExpiryWorker` |
| `VOICE_NOTE_SLA` | Any | Voice note received | SLA approaching | SLA breached | `VoiceNoteSlaWorker` |
| `AI_DRAFT_REVIEW_TTL` | Any | AI draft created and enters PENDING_REVIEW | N/A | TTL exceeded without human decision | `AiDraftReviewTtlWorker` |
| `SHIFT_BOUNDARY_CHECK` | Any | Shift boundary condition detected (configurable schedule or trigger) | N/A | Check fires | `ShiftBoundaryCheckWorker` |

### 4.10.4 Registration Contract

```typescript
interface TimerRegistrationInput {
  timerType: string;             // key from the registry above
  entityReference: string;       // ID of the governed entity (Entry.id, Quotation.id, etc.)
  entityType: string;            // canonical entity type name
  stageContext?: Stage;
  firesAt: Date;                 // absolute timestamp — not relative duration
  warningAt?: Date;
  criticalAt?: Date;
  payload?: Record<string, unknown>;  // passed through to worker on fire
  actorId: string;               // L0 SYSTEM actor for system-initiated timers
}

interface TimerRegistration {
  timerRecordId: string;         // created TimerRecord.id
  pgBossJobId: string;           // created pg-boss job ID
  registered: boolean;
  firesAt: Date;
}
```

### 4.10.5 Timer Fire Sequence

When a timer fires (pg-boss executes the job):

1. pg-boss handler receives the job payload.
2. Handler retrieves the `TimerRecord` by `pgBossJobId`.
3. Handler updates `TimerRecord.status` to `FIRED` and sets `firedAt`.
4. Handler creates a `TimerEvent` with `eventType: 'FIRED'` and `firedAt`.
5. Handler dispatches the appropriate worker via pg-boss job enqueue.
6. Worker executes the expiry action (inventory release, escalation, notification, etc.).
7. Worker writes audit records and trace events for the expiry action.

Step 6 and 7 are the worker's responsibility. The TimerEngine handler does not execute the expiry action itself.

### 4.10.6 Silent Expiry Prohibition

No timer may expire without producing a permanent audit record. A silent expiry — where a timer fires and an entity transitions to a new state without a corresponding `TimerEvent` and worker trace event — is a forbidden pattern (§32.4). The fire sequence above is mandatory for every timer type in the registry.

**ProcessingLock expiry specific rule:** When `PROCESSING_LOCK_TTL` fires, the `ProcessingLockExpiryWorker` sets `ProcessingLockRecord.status` to `EXPIRED`, sets `expiredAt`, and produces the mandatory expiry notification to the operator: *"Your inventory hold has expired — please reconfirm availability before proceeding."* The notification text is hardcoded — it is governance language, not configurable marketing copy. No heartbeat or renewal mechanism exists — the lock expires unconditionally at TTL (§70A REV-B10-V23-01).

### 4.10.7 Timer Recalculation After Night Audit

After `NightAuditEngine.runAudit()` completes and the `NightAuditService` writes all records, the service calls `TimerEngine` to recalculate all next-day timers (§62 M.10). Recalculation scope:

- `PRE_ARRIVAL_COUNTDOWN` — advance the window if arrival is now closer.
- `STAGE_DWELL_MONITOR` — reset idle detection for entries that have progressed.
- `CHECKOUT_TIME` — recalculate for entries with tomorrow as their checkout date.
- Any timer with a `firesAt` that was computed relative to the current date that may need updating based on the audit's occupancy output.

Recalculation is a full timer re-evaluation for affected entity references. It does not cancel and recreate all timers — only those whose `firesAt` needs adjustment based on post-audit state.

### 4.10.8 What the TimerEngine Does Not Do

- Does not execute expiry actions (inventory release, state transitions, notifications). Workers do this.
- Does not determine whether a timer should be registered — the calling service determines when to register.
- Does not cancel timers without a governing event. Timer cancellation requires a service call with actor attribution.

---

## §4.11 — ReEntryConsequenceEngine

### 4.11.1 Purpose

The ReEntryConsequenceEngine computes the consequence payload for a re-entry event. When a new segment is created on re-entry, the engine determines what must change across the entry's related structures — timers, folio, holds, handoffs, and inventory — as a result of the originating stage and the target re-entry stage. It is derived from MOM-003 D-16 and the amendment consequence chain defined in §51.

### 4.11.2 Design

The engine receives the re-entry context (originating stage, target stage, current entry state snapshot) and returns a structured consequence payload. The calling service uses this payload to execute the required updates — releasing holds, cancelling timers, adjusting folio lines, updating handoff states, or triggering inventory state changes. The engine computes; the service executes.

Consequence computation happens at the moment of segment creation. Every re-entry that creates a new segment must produce a consequence payload before the segment is written. There is no re-entry without a consequence computation.

### 4.11.3 Consequence Matrix

The following table defines the consequence categories for each re-entry origin. The matrix is derived from §76A (Re-Entry Transitions) and §51 (Amendment and Controlled Change).

| Originating Stage | Target Stage | Timer Consequences | Folio Consequences | Hold Consequences | Handoff Consequences | Inventory Consequences |
|---|---|---|---|---|---|---|
| S2 | S1 | Cancel: QUOTATION_VALIDITY, QUOTATION_ACK_TRACKER, SPECULATIVE_HOLD_EXPIRY (if hold placed) | None | Release speculative hold (if placed) | None | Inventory returns to QUOTED or FREE |
| S3 | S1 | Cancel: COMMITTED_HOLD_EXPIRY, PAYMENT_MILESTONE (if configured) | Provisional folio suspended; advance payments preserved | Release committed hold | None | Inventory returns to FREE |
| S3 | S2 | Cancel: COMMITTED_HOLD_EXPIRY | Rate component on provisional folio flagged for revision | Committed hold suspended | None | Hold state returns to SPECULATIVELY_HELD or renegotiated |
| S4 | S1 | Cancel: PRE_ARRIVAL_COUNTDOWN, COMMITTED_HOLD_EXPIRY, CONFIRMATION_ACK_TRACKER | Commitment snapshot frozen but marked as superseded by new segment | Release confirmed hold; inventory returns to FREE | Cancel H1 if not yet accepted | Inventory returns to FREE |
| S4 | S2 | Cancel: PRE_ARRIVAL_COUNTDOWN, CONFIRMATION_ACK_TRACKER | Rate on commitment snapshot superseded by new segment outcome | Confirmed hold releases; new negotiation path | Cancel H1 if not yet accepted | Inventory returns to COMMITTED_HELD pending new negotiation |
| S4 | S3 | Cancel: PRE_ARRIVAL_COUNTDOWN | Billing model or payment terms to be revised | Confirmed hold maintained during billing revision | None | Inventory remains CONFIRMED |
| S5 | S1 | Cancel: ROOM_READINESS_SLA, DEFICIENT_RESOLUTION_DEADLINE, PRE_ARRIVAL_COUNTDOWN | Provisional folio adjustments as required | Hold maintained | H1 returns to CREATED state; front desk releases | Inventory returns to COMMITTED_HELD |
| S6 | S1 | Cancel: ROOM_READINESS_SLA, H2_H3_ACCEPTANCE | Live folio: room change line adjustment; original room released | No hold change; assignment changes | Withdraw H2 and H3; re-create on new segment return | OCCUPIED → DEPARTED_DIRTY (old room); new room → OCCUPIED path begins |
| S7 | S1 | Cancel: STAGE_DWELL_MONITOR for current stage | Folio adjustment layer for rate delta; prior charges preserved | New segment holds new room assignment | Withdraw H2 (old room); re-create for new room | Old room: OCCUPIED → DEPARTED_DIRTY; new room: begins readiness path |
| S7 | S2 | Cancel: none (stay is live; dwell continues) | Amendment: rate revision tracked as amendment layer; prior charges immutable | No hold change | No handoff change unless meal plan changes (H3 update) | No inventory change |
| S7 | S3 | Cancel: none | Billing model change produces new billing configuration record | No hold change | No handoff change | No inventory change |
| S7 | S4 | Cancel: none | Date extension: folio extended for new checkout date | No hold change | New CHECKOUT_TIME timer registered | Inventory claim extended to new checkout date |
| S8 | S7 | Cancel: CHECKOUT_TIME | No folio change — return to S7 for additional charge posting | No hold change | H4 returns to IN_PROGRESS | Room remains in checkout process |
| S8 | S2 | Cancel: CHECKOUT_TIME | Rate disputed; folio revision pending | No hold change | H4 returns to IN_PROGRESS; dispute framework activates | Inventory remains DEPARTED_DIRTY pending resolution |

### 4.11.4 Input Contract

```typescript
interface ReEntryInput {
  entryId: string;
  segmentId: string;             // the NEW segment just created
  originatingStage: Stage;       // the stage the entry is leaving
  targetStage: Stage;            // the stage being re-entered
  entrySnapshot: ReEntryEntrySnapshot;  // current state of the entry before consequence execution
}

interface ReEntryEntrySnapshot {
  currentHolds: HoldSummary[];
  activeTimers: TimerSummary[];
  folioState: FolioState;
  activeHandoffs: HandoffSummary[];
  currentInventoryClaims: InventoryClaimSummary[];
  hasLiveFolio: boolean;          // true if folio has converted to LIVE at S6
}
```

### 4.11.5 Output Contract

```typescript
interface ReEntryConsequencePayload {
  timersToCancel: string[];          // TimerRecord.id values
  timersToRegister: TimerRegistrationInput[];  // new timers required on re-entry
  holdsToRelease: HoldReleaseAction[];
  holdsToSuspend: HoldSuspendAction[];
  folioActions: FolioConsequenceAction[];
  handoffActions: HandoffConsequenceAction[];
  inventoryActions: InventoryConsequenceAction[];
  consequenceNotes: string[];        // human-readable consequence log for trace event payload
}
```

### 4.11.6 Invocation Context

The segment creation service calls `ReEntryConsequenceEngine.compute()` as part of the segment creation transaction. The consequence payload is returned before the segment write is committed. The service executes each consequence action within the same transaction. If any consequence action fails, the entire segment creation rolls back — there is no partial consequence application.

---

## §4.12 — RoomAssignmentSuggestionEngine

### 4.12.1 Purpose

The RoomAssignmentSuggestionEngine produces a ranked list of room suggestions for a given entry at the room assignment decision point in S5. It is derived from MOM-007 §5.2 (Reservation Manager seam). The engine suggests — it does not assign. FOM or the assigned custodian makes the final room assignment decision. The engine output is advisory; it has no authority.

### 4.12.2 Design Constraints

**Suggestion only — not authority.** The engine's output is a ranked suggestion list. The calling service presents this list to the operator as a recommendation. The operator selects a room (which may or may not match the suggestion) and makes the assignment. The operator's decision is the governing action; the engine's suggestion is the input to that decision, not a pre-determined outcome.

**DEFICIENT flag is always surfaced in suggestions.** Any room in the suggestion list that carries `isDeficient: true` is returned with the DEFICIENT flag and condition description. A DEFICIENT room may appear in the suggestion list — it is not excluded — but it is marked. The operator must make an explicit assignment decision acknowledging the condition (as required by §46.5).

**Corporate group hierarchy awareness.** For group bookings where the entry carries a `GroupBillingMode` and a corporate profile exists, the engine applies a hierarchy-aware suggestion. The suggestion logic is:
- CEO / executive tier → suite class rooms first.
- Director tier → deluxe class rooms.
- Staff tier → standard rooms.

This hierarchy is derived from §56 M.8 and is applied based on the guest profile's role field within the corporate group. The engine does not hardcode "CEO", "director", or "staff" as strings — it reads the corporate group hierarchy configuration injected by the calling service.

**Model 1 + Model 2 conjunction.** The suggestion engine evaluates both models. It does not suggest a room that is not physically ready (`isUnderMaintenance: true` with deadline within the stay dates, or `isBlocked: true`), even if the claim state would allow it.

### 4.12.3 Suggestion Scoring Logic

The engine ranks rooms by evaluating the following factors in order of weight:

1. **Guest preference match** — guest profile preferences (floor, view, bed configuration, specific room features) from `GuestProfile.preferences` (highest weight).
2. **Corporate hierarchy match** — room class matches the corporate role tier (for group bookings).
3. **DEFICIENT flag penalty** — rooms with `isDeficient: true` are ranked lower than equivalent rooms without the flag.
4. **Physical readiness confidence** — rooms in `AVAILABLE_CLEAN` state (most confident) ranked above rooms in `AVAILABLE_INSPECTED` state.
5. **Assignment efficiency** — proximity to other group members (for group bookings); housekeeping zone efficiency (for repeat arrivals on the same day).

The scoring weights are configurable per `ConfigurationEntry` with key `room_suggestion_scoring_weights`. The scoring factors themselves (the five factors above) are hardcoded — what is configurable is their relative weight in the scoring formula.

### 4.12.4 Input Contract

```typescript
interface RoomSuggestionInput {
  entryId: string;
  roomTypeId: string;
  checkInDate: Date;
  checkOutDate: Date;
  useType: EntryUseType;
  guestProfile: GuestProfileSuggestionContext;
  isGroupBooking: boolean;
  corporateGroupRole?: string;          // role within group hierarchy (e.g., 'EXECUTIVE', 'DIRECTOR', 'STAFF')
  corporateHierarchyConfig?: CorporateHierarchyConfig;  // from ConfigurationEntry — injected if group booking
  availableRooms: RoomSuggestionCandidate[];  // pre-filtered available rooms — injected by calling service
  scoringWeights: RoomSuggestionScoringWeights; // from ConfigurationEntry — injected
  currentTimestamp: Date;
}

interface GuestProfileSuggestionContext {
  guestProfileId: string;
  tier: string;
  preferredFloor?: number;
  preferredView?: string;
  preferredBedConfiguration?: string;
  specialRequirements?: string[];
  priorRoomAssignments?: string[];   // Room.id values from past stays — preference signal
}

interface RoomSuggestionCandidate {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomClass: string;         // SUITE | DELUXE | STANDARD | etc.
  floorNumber?: number;
  view?: string;
  bedConfigurations: string[];
  isDeficient: boolean;
  deficientConditionCategory?: DeficientConditionCategory;
  deficientDescription?: string;
  physicalState: string;     // AVAILABLE_CLEAN | AVAILABLE_INSPECTED
}

interface CorporateHierarchyConfig {
  tiers: CorporateGroupTier[];
}

interface CorporateGroupTier {
  roleName: string;           // e.g., 'EXECUTIVE', 'DIRECTOR', 'STAFF'
  preferredRoomClass: string; // e.g., 'SUITE', 'DELUXE', 'STANDARD'
}

interface RoomSuggestionScoringWeights {
  guestPreferenceMatch: number;    // 0–100
  corporateHierarchyMatch: number;
  deficientPenalty: number;        // negative weight
  physicalReadiness: number;
  assignmentEfficiency: number;
}
```

### 4.12.5 Output Contract

```typescript
interface RoomSuggestionResult {
  suggestions: RankedRoomSuggestion[];   // ordered best-first
  suggestionBasis: string[];             // human-readable explanation of top suggestion rationale
  deficientSuggestionsPresent: boolean;  // true if any suggestion carries isDeficient: true
}

interface RankedRoomSuggestion {
  rank: number;           // 1 = best
  roomId: string;
  roomNumber: string;
  roomClass: string;
  score: Decimal;
  isDeficient: boolean;
  deficientConditionCategory?: DeficientConditionCategory;
  deficientDescription?: string;
  preferenceMatchReasons: string[];  // which preferences matched
  physicalState: string;
}
```

### 4.12.6 Invocation Context

The room assignment service calls `RoomAssignmentSuggestionEngine.suggest()` when the room assignment screen is loaded at S5. The result is presented to the operator as a ranked suggestion list. The operator selects a room and confirms the assignment. The confirmed assignment is written to the entry record (`Entry.currentStage` remains S5 until S5 exit conditions are met). The suggestion list itself is not persisted — it is a computed advisory output for operator use.

### 4.12.7 What the RoomAssignmentSuggestionEngine Does Not Do

- Does not assign rooms. The calling service records the room assignment with actor attribution.
- Does not acknowledge DEFICIENT flags. Flag acknowledgement is a service-level action with recorded actor.
- Does not evaluate the full set of S5 exit guards (payment reconciliation, H1 acceptance). Those are separate guard evaluations in the S5 exit path.

---

## Gate 4 Completeness Statement

Part 4 covers §§4.1 through §4.12 as specified in the locked ToC (DEV-SPEC-001_ToC_FINAL.md). All twelve engines are specified with:

- Explicit hardcoded vs configurable separation.
- Input and output TypeScript interface contracts.
- Invocation context per stage.
- Explicit statement of what each engine does not do (enforcement of the engine/service boundary).

Alignment with locked upstream documents:

| Upstream Document | Alignment |
|---|---|
| Part 2 schema | All model names (`Reservation`, `Folio`, `FolioLine`, `NightAuditRecord`, `TimerRecord`, `ProcessingLockRecord`, `CreditExtensionCeilingRecord`, `OtaConflictOverbookingRecord`, etc.) and enum values (`RatePlanType`, `OverbookingTriggerType`, `NightAuditRunStatus`, `TaxModel`, `ProcessingLockStatus`, `Stage`, etc.) used exactly as defined in Part 2. |
| Part 3 state machines | Engine outputs that produce inputs to state machine guards are aligned: `DisputeGateEngine` outcome feeds the Part 3 §3.2 S7→S8 and S8→S9 guard; `NightAuditEngine` produces the completeness check evidence required by the S7→S8 guard; `FOCValidationEngine` result feeds the S3 exit guard. |
| Canon §76A | Re-Entry Transitions table in §4.11 (ReEntryConsequenceEngine) derived from §76A without modification. |
| Canon §76 | TimerEngine registry table (§4.10.3) derived from §76 without modification. |
| MOM-ARCH-2026-013 | "Inquiry" used throughout (not "Engagement") per RF-2 decision. |

**Nothing in this part is locked until Architect confirms.**

---

*Prepared by Claude (AI Architectural Partner)*
*07 April 2026*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
