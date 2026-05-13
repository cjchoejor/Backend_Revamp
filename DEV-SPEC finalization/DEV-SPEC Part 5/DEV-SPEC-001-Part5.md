# LEGPHEL PMS — DEV-SPEC-001
# Part 5 — Policies
# §5.1 through §5.2

**Document:** DEV-SPEC-001-Part5.md
**Status:** DRAFT — nothing is locked until Architect confirms
**Canon version:** v2.5
**Authority:** MOM-ARCH-2026-013 (most recent locked session)
**Gate:** Gate 5 — Policies
**Date:** 07 April 2026
**Prepared by:** Claude (AI Architectural Partner)

---

## Document Control

| Field | Detail |
|---|---|
| Gate | 5 — Policies |
| Sections covered | §5.1 through §5.2 |
| Declared Canon sources | Canon Block 11 §72 (Stage-to-Policy Matrix); Canon Block 10 §70A (Soft Processing Lock); Canon Block 10 §70B (AI Agent Operational Model); Canon Block 10 §70C (Voice Note Handling) |
| Schema reference | DEV-SPEC-001-Part2.md (LOCKED) — all model names and enum values |
| Engine reference | DEV-SPEC-001-Part4.md (LOCKED) — all engine names and method signatures |
| State machine reference | DEV-SPEC-001-Part3.md (LOCKED) — guard conditions; enforcement points must align, not duplicate or contradict |
| Status | DRAFT — nothing is locked until Architect confirms |
| Previous gate | Gate 4 (Part 4 — Engines) |
| Depends on | Parts 1–4 LOCKED; Actor-Authority Matrix LOCKED; Canon v2.5 confirmed |

---

## §5.1 — Policy Design Principles

### 5.1.1 What a Policy Is

A policy is a pure evaluator. It receives a typed input and returns a typed decision. It has no side effects. It does not persist records, emit events, call services, or advance state machines. Those actions are the responsibility of the service layer that invokes the policy and acts on its output.

Every policy returns one of three decision types:

- **APPROVED** — the operation may proceed under the current actor's authority.
- **DENIED** — the operation is refused. The calling service raises a typed `PolicyGateBlockedError` identifying the policy, the blocking condition, and the escalation path if one exists.
- **ESCALATE(`ActorLevel`)** — the operation exceeds the current actor's authority but may proceed if a higher-authority actor approves. The calling service initiates the escalation path. No operation is silently downgraded from ESCALATE to APPROVED — the higher-authority approval event must be recorded before the operation proceeds.

Some policies govern enforcement events rather than request-time decisions (for example, timer-governed expiry policies and session management policies). These are stated as enforcement rules applied by the calling service or worker at the time of the governed event.

### 5.1.2 Policy Enforcement Is Service-Layer Mandatory

Every named policy in the catalogue below has a corresponding enforcement point in the service layer. Policy enforcement is not optional and is not bypassed by any code path that reaches the service layer.

The following is absolute: calling a service method directly — bypassing the controller, the HTTP layer, or any middleware — must still trigger all policies that govern that service method. A policy that is only enforced through UI middleware is an architectural violation.

Acceptance gate §13.5 verifies this property: every policy in the catalogue is callable directly in isolation, and every named policy has an enforcement point.

### 5.1.3 Policies Operate Within Canon Bounds

A policy evaluates a condition against Canon-derived rules. It does not modify Canon rules, invent conditions that have no Canon basis, or apply configuration in a way that overrides a Canon constraint.

Configuration tunes policy parameters. It does not rewrite policy logic. A configuration change may move a threshold (for example, the credit ceiling proximity warning level) but may never disable a required evaluation or reclassify a denied outcome as approved.

### 5.1.4 Policy Parameters vs. Hardcoded Behaviour

Every policy entry in the catalogue distinguishes between:

- **Hardcoded behaviour** — the behaviour is invariant. No configuration, no authority level, and no runtime condition may change it. If a policy hardcodes a behaviour, it is stated as a constraint on the engine or service logic, not a configuration parameter.
- **Configurable parameter** — the behaviour is tunable within the bounds the policy defines. Configuration is read from the configuration tables at runtime. It is not hardcoded in the service layer.

This distinction applies to every policy. Where a policy delegates computation to an engine (§4.2–§4.12), the engine's own hardcoded/configurable distinction (stated in Part 4) governs the computation. The policy's enforcement point governs when the engine is invoked and how its result is acted on.

### 5.1.5 Policy Identity and Naming

Each policy in §5.2 carries a canonical name. The canonical name is used throughout Stage Implementation Guidelines and any code that references policy evaluation. Policy names must not be abbreviated, contracted, or paraphrased in implementation artefacts — the name is the contract identifier.

---

## §5.2 — Policy Catalogue

The catalogue is organised by policy class, following the row order of the §72 Stage-to-Policy Matrix. Three additional policy groups are added from cross-stage mechanisms §70A, §70B, and §70C. Each policy is stated with: active stage(s), input, decision, enforcement point, engine delegation (where applicable), hardcoded behaviour, and configurable parameters.

Cross-reference with Part 3: where a policy evaluation output feeds a state machine guard condition, the guard definition in Part 3 is the authority. The policy enforcement point described here governs when and how the policy is invoked. The guard condition in Part 3 governs what happens if the policy blocks the transition.

---

### §5.2.1 — Availability Policy Group

#### Policy 1 — Availability Query Policy

- **Active at:** S1 (availability search), S5 (room assignment), re-entry points requiring revalidation
- **Input:** Requested room type, date range, booking context (channel, guest tier, OTA\_SOURCE flag), current inventory claim states (Model 1) and physical states (Model 2)
- **Decision:** APPROVED (results returned with full availability state) | DENIED (invalid query parameters — missing required fields)
- **Enforcement point:** `AvailabilityService` before invoking `AvailabilityEngine.query()`; result passed to caller; DEFICIENT flags included in result set per Policy 2 (below)
- **Engine delegation:** `AvailabilityEngine.query(input: AvailabilityInput): AvailabilityResult`
- **Hardcoded:** Query combines Model 1 (claim state) and Model 2 (physical state) — results from either model alone are not a valid availability answer. OTA\_SOURCE flag affects claim state evaluation.
- **Configurable:** Shadow inventory visibility rules (whether shadow inventory appears in search results); DEFICIENT condition categories surfaced in results.

---

#### Policy 2 — DEFICIENT Condition Surface Policy

- **Active at:** S1 (availability search results)
- **Input:** `AvailabilityResult` from `AvailabilityEngine.query()`; `DeficientConditionRecord` status for each room in the result set
- **Decision:** Enforcement rule — every room with an active `DeficientConditionRecord` is flagged in the availability result before results are returned to the caller. Flagged rooms remain visible and selectable; their assignability is governed by Policy 48 (DEFICIENT Room Assignment Decision Policy), not by this policy.
- **Enforcement point:** `AvailabilityService` post-query annotation step — DEFICIENT flags annotated onto search results before results are returned; no write operation occurs at this step
- **Hardcoded:** DEFICIENT flags are always annotated on search results. They are never suppressed regardless of actor level or configuration. The annotation step does not block room selection — it informs it.
- **Configurable:** `DeficientConditionCategory` values surfaced in the flag (which categories are active and annotated in results).

---

### §5.2.2 — Ownership / Custodian Assignment Policy Group

#### Policy 3 — Initial Custodian Assignment Policy

- **Active at:** S1 (inquiry and entry creation)
- **Input:** Booking channel (walk-in, phone, email, WhatsApp, OTA), creating actor identity, ownership assignment rules configuration
- **Decision:** APPROVED (custodian assigned per configuration rules) | ESCALATE(`ActorLevel.FOM`) (no rule resolves — FOM assigns manually)
- **Enforcement point:** `InquiryService.create()` — custodian assignment evaluated immediately after inquiry creation
- **Hardcoded:** Every inquiry and entry must have a custodian at the moment of creation. No inquiry or entry may exist without a custodian assigned.
- **Configurable:** Ownership assignment rules per channel; default custodian per channel type.

---

#### Policy 4 — Custodian Reassignment Policy

- **Active at:** S4 (ownership reassignment on confirmation)
- **Input:** Entry identifier, new custodian identity, current entry stage, reassignment authority of requesting actor
- **Decision:** APPROVED (`ActorLevel.FRONT_DESK` for standard reassignment) | ESCALATE(`ActorLevel.FOM`) (high-value or conference entries per configuration threshold)
- **Enforcement point:** `EntryService.reassignCustodian()` — policy evaluated before custodian field is updated; reassignment event recorded
- **Hardcoded:** Every custodian change produces an immutable attribution event. Retrospective attribution change is forbidden — the historical custodian record is preserved.
- **Configurable:** High-value threshold above which FOM authority is required for reassignment.

---

#### Policy 5 — H1 Handoff Custodian Transfer Policy

- **Active at:** S5 (H1 acceptance)
- **Input:** H1 `HandoffRecord`, accepting actor identity, handoff checklist completion status
- **Decision:** APPROVED (H1 accepted — custodian transfers to front desk team) | DENIED (checklist incomplete — handoff blocked until conditions satisfied) | ESCALATE(`ActorLevel.FOM`) (H1 rejected — FOM routing required)
- **Enforcement point:** `HandoffService.acceptH1()` — policy evaluated before `HandoffState` is set to `ACCEPTED` and custodian transfer is recorded
- **Hardcoded:** Custodian does not transfer until H1 acceptance event is recorded. Auto-fulfilment of H1 (where reservations and front desk are the same team) records the acceptance event even when no inter-team transfer occurs — the audit trail is always present.
- **Configurable:** H1 checklist items per property configuration.

---

### §5.2.3 — Expiry / Parking Policy Group

#### Policy 6 — Inquiry Expiry Policy

- **Active at:** S1 (idle inquiry timer)
- **Input:** Inquiry age (time since last activity), configured expiry threshold for S1, current `EntryStatus`
- **Decision:** Enforcement event — when the governed timer fires, the service transitions the entry to `EntryStatus.EXPIRED`. No actor may approve continuation without a new inquiry.
- **Enforcement point:** `InquiryExpiryWorker` (timer-fired) — calls `InquiryService.expire()`; expiry event recorded; `EntryStatus` set to `EXPIRED`
- **Hardcoded:** Expiry is always a governed event with a permanent record. Silent expiry — expiry without a transition event and audit record — is forbidden. `EntryStatus.EXPIRED` is a terminal state; it cannot be reversed.
- **Configurable:** Expiry threshold duration for S1 (per expiry defaults configuration surface in §73).

---

#### Policy 7 — Quotation Validity Policy

- **Active at:** S2 (quotation issued)
- **Input:** Quotation creation timestamp, configured quotation validity window, current `QuotationState`
- **Decision:** Enforcement event — when the validity timer fires, `QuotationState` transitions to `EXPIRED`. An expired quotation remains recallable with revalidation; it is no longer directly selectable as an S3 progression basis without revalidation.
- **Enforcement point:** `QuotationExpiryWorker` (timer-fired) — calls `QuotationService.expire()`; state transitioned to `QuotationState.EXPIRED`; operator notified
- **Hardcoded:** A quotation in `QuotationState.EXPIRED` cannot be used as the basis for S3 progression without explicit revalidation. Revalidation re-runs `PricingPipelineEngine.resolve()` against current state before a new quotation version is issued.
- **Configurable:** Quotation validity window (per expiry defaults configuration surface).

---

#### Policy 8 — Committed Hold Expiry Policy

- **Active at:** S3 (committed hold in place)
- **Input:** Hold creation timestamp, configured committed hold duration, current `HoldState`
- **Decision:** Enforcement event — if the committed hold expires before S4 confirmation, `HoldState` transitions to `HoldState.RELEASED`; inventory claim state returns to `InventoryClaimState.FREE`; operator notified with explicit message.
- **Enforcement point:** `HoldExpiryWorker` (timer-fired) — calls `HoldService.expireCommittedHold()`; `HoldState` set to `RELEASED`; inventory claim state updated; expiry event recorded
- **Hardcoded:** Hold expiry is always a governed event. Inventory does not silently return to FREE — the release event and reason are permanently recorded. The expiry notification message is explicit: it identifies the hold that expired and requires operator reconfirmation.
- **Configurable:** Committed hold duration (per committed hold duration configuration surface in §73).

---

#### Policy 9 — Pre-Arrival Period Policy

- **Active at:** S5 (pre-arrival window opened by `TimerEngine`)
- **Input:** Entry arrival date, current date, pre-arrival window configuration
- **Decision:** Enforcement event — `TimerEngine` fires the S4-to-S5 transition when the pre-arrival window opens. Immediate activation applies when arrival is same-day or next-day at time of S4 confirmation.
- **Enforcement point:** `PreArrivalActivationWorker` (timer-fired) — calls `EntryService.activatePreArrival()`; S4→S5 transition recorded; pre-arrival task checklist initialised
- **Hardcoded:** S5 activates when the pre-arrival window opens — the timer fires unconditionally. Where arrival is same-day or next-day at S4 confirmation time, `TimerEngine` fires immediately and S5 activates in compressed mode.
- **Configurable:** Pre-arrival window duration (number of days before arrival at which S5 activates).

---

#### Policy 10 — Checkout Due Policy

- **Active at:** S7 (during stay — checkout time approaching)
- **Input:** Entry expected checkout date and time, current timestamp, configured checkout time
- **Decision:** Enforcement event — when the checkout due timer fires, front desk is prompted. If checkout is not initiated within the late checkout grace window, FOM is notified.
- **Enforcement point:** `CheckoutDueWorker` (timer-fired) — initiates checkout prompt notification; escalates to FOM if not actioned within grace period
- **Hardcoded:** The checkout due event is always recorded as a timed event. It does not block the guest but creates an open task that must be resolved.
- **Configurable:** Property checkout time; late checkout grace window duration.

---

#### Policy 11 — Post-Stay Payment Follow-Up Policy

- **Active at:** S9 (outstanding folio balance after closure)
- **Input:** `FolioState` (must be `OUTSTANDING`), last payment activity timestamp, configured follow-up interval sequence
- **Decision:** Enforcement event — follow-up communications dispatched at each configured interval until balance is settled or the follow-up sequence is exhausted.
- **Enforcement point:** `PaymentFollowUpWorker` (timer-fired) — calls `CommunicationService.dispatchFollowUp()`; follow-up event recorded against entry
- **Hardcoded:** Follow-up communications are only dispatched for entries with `FolioState.OUTSTANDING`. Entries with `FolioState.SETTLED` are never sent follow-up communications regardless of configuration.
- **Configurable:** Follow-up interval sequence (number of intervals, duration between intervals); follow-up communication templates.

---

### §5.2.4 — Duplicate Detection Policy Group

#### Policy 12 — Duplicate Inquiry and Entry Creation Gate Policy

- **Active at:** S1 (inquiry and entry creation)
- **Input:** Guest identity fields (name, contact, OTA reference if applicable), proposed arrival dates, proposed room type; existing active inquiries for the same guest identity
- **Decision:** APPROVED (no duplicate detected) | DENIED (duplicate detected — operator must resolve before proceeding) | ESCALATE(`ActorLevel.FOM`) (ambiguous match requiring judgement)
- **Enforcement point:** `InquiryService.create()` — duplicate check runs before inquiry record is written; `DuplicateDetectionService.checkAtCreation()` called
- **Hardcoded:** The duplicate check runs on every inquiry creation without exception. A confirmed duplicate match blocks creation — it is not a warning. The operator is shown the conflicting record.
- **Configurable:** Match threshold (exact vs. fuzzy identity matching rules); OTA reference matching rules.

---

#### Policy 13 — Multi-Booking Detection Policy

- **Active at:** S4 (confirmation)
- **Input:** Guest identity, all active entries in `InventoryClaimState.CONFIRMED` or `COMMITTED_HELD` for the same guest; proposed confirmation dates
- **Decision:** APPROVED (no overlap) | ESCALATE(`ActorLevel.FOM`) (overlapping confirmed bookings detected — simultaneous stay requires FOM explicit acknowledgement)
- **Enforcement point:** `ReservationService.confirm()` — multi-booking check runs before confirmation event is written; FOM acknowledgement event recorded if escalation is approved
- **Hardcoded:** Overlapping confirmed reservations for the same guest identity require explicit FOM acknowledgement. Auto-confirmation of overlapping reservations is forbidden.
- **Configurable:** Date overlap threshold (exact overlap vs. overlap with configured buffer).

---

### §5.2.5 — Shadow Inventory Policy Group

#### Policy 14 — Shadow Inventory Visibility Policy

- **Active at:** S1 (availability search)
- **Input:** Requesting actor `ActorLevel`, shadow inventory visibility configuration, shadow inventory room records
- **Decision:** Enforcement rule — shadow inventory rooms are included in or excluded from availability results based on the configuration and the requesting actor's role.
- **Enforcement point:** `AvailabilityService` — shadow inventory filter applied before results are returned from `AvailabilityEngine.query()`
- **Hardcoded:** Shadow inventory is always present in the underlying inventory model. Whether it is surfaced in search results is governed by configuration — it is never permanently invisible to the system itself.
- **Configurable:** Shadow inventory visibility per actor level; shadow inventory room configuration.

---

### §5.2.6 — Guest Identity Policy Group

#### Policy 15 — Guest Identity Capture Policy

- **Active at:** S1 (inquiry creation)
- **Input:** Guest profile fields submitted at inquiry creation; OTA\_SOURCE flag (present if booking source is OTA channel)
- **Decision:** APPROVED (all required fields present; OTA\_SOURCE flag set correctly) | DENIED (required identity fields missing)
- **Enforcement point:** `InquiryService.create()` and `GuestProfileService.createOrLink()` — field completeness validation and OTA\_SOURCE flag enforcement before profile record is written
- **Hardcoded:** OTA\_SOURCE flag must be set at S1 intake for OTA-originated inquiries. The flag cannot be added retrospectively after S1 exit. Guest profile records without the minimum required fields are rejected, not silently created with nulls.
- **Configurable:** Required identity fields per booking channel; OTA\_SOURCE flag trigger rules (per §73 OTA\_SOURCE flag configuration surface).

---

#### Policy 16 — Guest Identity Verification Policy

- **Active at:** S6 (check-in)
- **Input:** Identity document type, document data fields, verification actor identity and `ActorLevel`
- **Decision:** APPROVED (document verified and recorded per Section 16.1 governed procedure) | DENIED (required document not presented or not accepted document type)
- **Enforcement point:** `CheckInService` — identity verification gate enforced before `EntryStatus` can advance to S6; verification event recorded with actor identity and document type
- **Hardcoded:** Identity verification is a mandatory S6 gate condition. Check-in cannot complete without a recorded identity verification event. The verification event records the verifying actor, document type, and timestamp — not the document content (Section 16.1 governs document handling).
- **Configurable:** Accepted identity document types (per identity document types configuration surface in §73).

---

### §5.2.7 — Guest Data Governance Policy Group

#### Policy 17 — Guest Data Capture Governance Policy

- **Active at:** S6 (identity document capture)
- **Input:** Identity document data fields, data capture actor identity, data retention configuration
- **Decision:** Enforcement rule — document data is captured only through the governed capture procedure. Ungoverned capture (free-text notes containing identity document data, photos stored outside the governed attachment model) is detected and rejected.
- **Enforcement point:** `GuestProfileService.recordVerification()` — governed capture path is the only write path for identity document data
- **Hardcoded:** Identity document data can only be written through the governed capture method. Direct writes to guest profile fields containing document data from any other code path are forbidden.
- **Configurable:** Identity document retention period (per identity document retention period configuration surface in §73).

---

#### Policy 18 — Guest Data Retention and Deletion Policy

- **Active at:** S9 (post-closure)
- **Input:** Entry closure timestamp, `GuestProfile` linked to the closed entry, configured retention period, applicable regulatory requirements
- **Decision:** Enforcement event — when the retention timer fires, the deletion or anonymisation procedure is triggered. The deletion event is recorded; the audit trail of the guest's operational engagement is preserved without the personal data that has passed its retention period.
- **Enforcement point:** `GuestDataRetentionWorker` (timer-fired) — calls `GuestProfileService.applyRetentionPolicy()`; deletion / anonymisation event recorded
- **Hardcoded:** The retention timer is always set at S9 closure. Deletion of governed personal data without a retention event is forbidden. The operational records (folio, charges, events) are not deleted — only the personal identification data subject to the retention policy.
- **Configurable:** Retention period duration (per identity document retention period configuration surface in §73).

---

### §5.2.8 — Pricing / Rate Plan Policy Group

#### Policy 19 — Rate Plan Resolution Policy

- **Active at:** S2 (quotation creation)
- **Input:** Guest tier, booking channel, arrival and departure dates, room type, group size, applicable rate plans active for the date range
- **Decision:** APPROVED (rate resolved; `PricingResult` returned to calling service) | DENIED (no applicable rate plan exists for the combination — configuration gap; `MissingConfigurationError` raised)
- **Enforcement point:** `QuotationService.createQuotation()` — calls `PricingPipelineEngine.resolve()` before quotation record is written; resolved rate stored on quotation
- **Engine delegation:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult`
- **Hardcoded:** Rate plan priority order is invariant: individual-level agreements → promotional → tier → channel → rack. Configuration cannot reorder this hierarchy. Deterrent rate is automatically assigned to Caution and Restricted tier guests — the client is never informed of the deterrent classification. MSR validation is mandatory: the resolved rate must be ≥ MSR for the applicable rate plan. Manual rate entry that bypasses `PricingPipelineEngine` is a forbidden pattern.
- **Configurable:** All rate values within rate plans; MSR per rate plan; deterrent rate value; discount thresholds; override margins; FOC entitlement thresholds; season boundaries; group size volume bands.

---

#### Policy 20 — Commitment Rate Freeze Policy

- **Active at:** S4 (reservation confirmation)
- **Input:** S2-resolved rate (stored on quotation or prior segment), current entry identifier, `Reservation` record being created
- **Decision:** APPROVED (S2-resolved rate frozen into `Reservation.frozenRate`) | DENIED (no valid S2-resolved rate exists for this entry path — configuration or process error)
- **Enforcement point:** `ReservationService.confirm()` — rate freeze applied before confirmation event is written; `PricingPipelineEngine.resolve()` is NOT called at S4 unless a re-entry has occurred; the frozen rate from S2 is carried forward
- **Hardcoded:** The commitment snapshot rate is the S2-resolved rate. In-place modification of the commitment snapshot after S4 exit is the most dangerous forbidden pattern in the system — it is absolutely prohibited. A rate change after S4 requires a new segment (re-entry).
- **Configurable:** None — the freeze is a system invariant, not a configurable behaviour.

---

#### Policy 21 — Mid-Stay Rate Amendment Policy

- **Active at:** S7 (rate revision during stay)
- **Input:** Amendment request details, requesting actor `ActorLevel`, current folio state, override margin configuration, applicable rate plan
- **Decision:** APPROVED (`ActorLevel.FOM` within configured override margin) | ESCALATE(`ActorLevel.GM`) (beyond override margin; full rate renegotiation) | DENIED (amendment would violate MSR)
- **Enforcement point:** `AmendmentService.initiateAmendment()` — policy evaluated before amendment path (Path 2 or Path 3) is opened; authority check against configured margin; new segment created for full renegotiation
- **Engine delegation:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult` — invoked by the calling service when a new rate plan is being applied on full renegotiation (Path 3); not called for Path 2 folio adjustments where no rate plan change occurs
- **Hardcoded:** Rate cannot be revised below MSR regardless of authority level. Every mid-stay rate amendment produces a new segment.
- **Configurable:** FOM override margin per rate plan; GM authority thresholds.

---

#### Policy 22 — Settlement Rate Policy

- **Active at:** S8 (folio settlement)
- **Input:** `Reservation.frozenRate`, all folio lines, any approved amendments, `FolioState`
- **Decision:** Enforcement rule — settlement applies the frozen rate and all approved amendments. No rate adjustment at settlement without a prior amendment approval event in the record.
- **Enforcement point:** `FolioService.initiateSettlement()` — rate basis validated against `Reservation.frozenRate` and approved amendment records before settlement proceeds
- **Hardcoded:** Settlement cannot retroactively apply a rate that was not approved through the governed amendment path. Auto-closing outstanding payment balances is forbidden — `FolioState.OUTSTANDING` must be set and payment follow-up initiated.
- **Configurable:** None — settlement rate basis is invariant once amendments are approved.

---

### §5.2.9 — Discount Policy Group

#### Policy 23 — Discount Approval Policy

- **Active at:** S2 (quotation — discount on rate)
- **Input:** Requested discount value or percentage, requesting actor `ActorLevel`, discount threshold configuration for the applicable rate plan, guest tier
- **Decision:** APPROVED (`ActorLevel.FRONT_DESK` within configured threshold) | ESCALATE(`ActorLevel.FOM`) (discount exceeds front desk threshold but within FOM authority band) | ESCALATE(`ActorLevel.GM`) (discount exceeds FOM authority band)
- **Enforcement point:** `QuotationService.applyDiscount()` — policy evaluated before discount is applied to quotation; escalation approval event recorded before discount is written
- **Hardcoded:** Discount approval chain is complete before quotation is issued. A quotation containing an unapproved discount is not a valid quotation for S3 progression.
- **Configurable:** Discount thresholds per authority level (Appendix C seed data); discount threshold per rate plan type.

---

#### Policy 24 — Mid-Stay Discount Policy

- **Active at:** S7 (discount applied during stay)
- **Input:** Requested discount, requesting actor `ActorLevel`, current folio state, mid-stay discount threshold configuration
- **Decision:** APPROVED (`ActorLevel.FOM` within configured threshold) | ESCALATE(`ActorLevel.GM`) (beyond FOM authority)
- **Enforcement point:** `AmendmentService.applyMidStayDiscount()` — policy evaluated before discount folio line is written; amendment path determined; approval event recorded
- **Hardcoded:** Mid-stay discount always produces an amendment record. Folio line additions for discounts cannot be posted without a prior approval event.
- **Configurable:** Mid-stay discount thresholds per authority level (Appendix C seed data).

---

### §5.2.10 — Speculative Hold Policy Group

#### Policy 25 — Speculative Hold Placement Policy

- **Active at:** S2 (hold placed during quotation)
- **Input:** Inventory configuration selected, requesting actor identity, hold threshold configuration, current inventory claim state for the target rooms
- **Decision:** APPROVED (inventory available; `InventoryClaimState` may be set to `SPECULATIVELY_HELD`) | DENIED (inventory not available for speculative hold — rooms in claim state that blocks speculative hold) | ESCALATE(`ActorLevel.FOM`) (speculative hold request exceeds front desk authority — volume or commercial significance threshold)
- **Enforcement point:** `HoldService.placeSpeculativeHold()` — policy evaluated before `HoldRecord` is created and `InventoryClaimState` is updated; hold timer registered with `TimerEngine.register()`
- **Hardcoded:** A speculative hold does not guarantee the inventory. It sets `InventoryClaimState.SPECULATIVELY_HELD` and starts a governed timer. The hold is subject to Policy 8 expiry rules. A speculative hold cannot be placed at S1 — hold placement is a S2-only action.
- **Configurable:** Speculative hold duration; speculative hold thresholds (maximum simultaneous holds per actor level).

---

### §5.2.11 — Committed Hold Policy Group

#### Policy 26 — Committed Hold Placement Policy

- **Active at:** S3 (hold placed when advance payment condition is satisfied or credit extension is approved)
- **Input:** Advance payment confirmation or approved credit extension ceiling record, inventory configuration, committed hold duration configuration, current `InventoryClaimState`
- **Decision:** APPROVED (`HoldState.PLACED`; `InventoryClaimState` set to `COMMITTED_HELD`) | DENIED (advance payment not satisfied and no approved credit extension — hold cannot be placed) | ESCALATE(`ActorLevel.FOM`) (credit extension approval required before hold may be placed)
- **Enforcement point:** `HoldService.placeCommittedHold()` — policy evaluated before `HoldRecord` is created; advance payment or credit extension confirmation required; hold timer registered with `TimerEngine.register()`
- **Hardcoded:** A committed hold requires either advance payment condition satisfied or a credit extension ceiling approved and recorded. A hold without either condition is not a committed hold — it is a speculative hold and must not be labelled or stored as committed. Creating a committed hold at S1 is forbidden.
- **Configurable:** Committed hold duration (per committed hold duration configuration surface in §73).

---

### §5.2.12 — Advance Payment Policy Group

#### Policy 27 — Advance Payment Collection Policy

- **Active at:** S3 (advance payment collected as hold condition)
- **Input:** Required advance payment amount (derived from configuration), actual payment amount submitted, payment reference, no-show penalty doctrine
- **Decision:** APPROVED (payment meets minimum requirement) | DENIED (payment below minimum — hold cannot be placed; credit extension path must be taken explicitly) | ESCALATE(`ActorLevel.FOM`) (waiver of advance payment requirement requires FOM approval)
- **Enforcement point:** `PaymentService.recordAdvancePayment()` — policy evaluated before `PaymentRecord` is written and `HoldService.placeCommittedHold()` is called; payment record must precede hold creation
- **Hardcoded:** Advance payment collection at S3 implies the no-show doctrine applies: if the guest no-shows, the advance payment is subject to no-show penalty rules (Policy 57). This doctrine cannot be waived — it is a Canon constraint, not a configurable threshold.
- **Configurable:** Advance payment minimum percentage (per advance payment thresholds configuration surface in §73).

---

#### Policy 28 — Advance Payment Reconciliation Policy

- **Active at:** S5 (pre-arrival reconciliation)
- **Input:** Advance payment records for the entry, current folio provisional balance, proximity to arrival date
- **Decision:** Enforcement rule — reconciliation check confirms advance payments are correctly applied against the provisional folio. Discrepancies surface as reconciliation flags for FOM review. Discrepancies do not block the S4→S5 transition (entry may enter the pre-arrival stage); they do block the S5→S6 transition (check-in may not proceed) until FOM has reviewed and acknowledged each flag.
- **Enforcement point:** `PreArrivalService.reconcileAdvancePayments()` — reconciliation check run as part of pre-arrival task completion verification
- **Hardcoded:** Unresolved reconciliation flags block the S5→S6 transition until FOM has reviewed and acknowledged each flag. Silent reconciliation (auto-resolving discrepancies without FOM review) is forbidden.
- **Configurable:** Advance payment threshold for proximity notification (per advance payment thresholds configuration surface in §73).

---

#### Policy 29 — Advance Payment Balance Verification Policy

- **Active at:** S6 (balance confirmed at check-in)
- **Input:** Advance payment records, current provisional folio, `FolioState` (must be `PROVISIONAL`)
- **Decision:** APPROVED (advance payment fully reconciled against folio; folio ready for live conversion) | DENIED (unresolved advance payment discrepancy — must be resolved before check-in completes)
- **Enforcement point:** `CheckInService` — advance payment balance verification is a mandatory check before folio is converted from `FolioState.PROVISIONAL` to `FolioState.LIVE`
- **Hardcoded:** Folio conversion from PROVISIONAL to LIVE requires advance payment balance confirmed. The conversion is atomic — folio state change and balance confirmation are written in the same transaction.
- **Configurable:** None — the balance verification is a system invariant.

---

### §5.2.13 — Billing Model Policy Group

#### Policy 30 — Billing Model Initial Fix Policy

- **Active at:** S3 (billing model selected and fixed at hold placement)
- **Input:** Requested billing model, applicable billing models available for the entry's use type and rate plan, requesting actor `ActorLevel`
- **Decision:** APPROVED (selected billing model is available for this entry; `BillingModel` fixed on provisional folio) | DENIED (billing model not available for this use type or rate plan combination) | ESCALATE(`ActorLevel.FOM`) (billing model selection requires FOM authority — for example, apartment periodic billing model)
- **Enforcement point:** `FolioService.createProvisionalFolio()` — billing model validated and fixed before folio record is written
- **Hardcoded:** The billing model is fixed at S3. A billing model change after S3 requires a re-entry (new segment) — it cannot be changed by editing the provisional folio in place.
- **Configurable:** Billing model availability per use type (per billing model availability configuration surface in §73).

---

#### Policy 31 — Billing Model Activation Policy

- **Active at:** S6 (folio converts from provisional to live)
- **Input:** `FolioState` (must be `PROVISIONAL`), S3-fixed billing model, check-in completion event
- **Decision:** Enforcement rule — at check-in completion, `FolioState` transitions from `PROVISIONAL` to `LIVE` and the billing model activates. Billing model activation is atomic with folio conversion.
- **Enforcement point:** `CheckInService` → `FolioService.convertToLive()` — billing model activation is part of the folio conversion transaction
- **Hardcoded:** Billing model activation cannot precede check-in completion. A LIVE folio cannot be created before S6.
- **Configurable:** None — activation is triggered by check-in completion; it is not configurable.

---

#### Policy 32 — Billing Model Mid-Stay Transition Policy

- **Active at:** S7 (billing model change during stay)
- **Input:** Requested new billing model, requesting actor `ActorLevel`, current `FolioState` (must be `LIVE`), mid-stay transition configuration
- **Decision:** APPROVED (`ActorLevel.FOM` — within FOM authority for mid-stay transitions) | ESCALATE(`ActorLevel.GM`) (billing model change that constitutes full renegotiation of terms)
- **Enforcement point:** `AmendmentService.changeBillingModel()` — policy evaluated before billing model transition event is written; new segment created for full renegotiation; folio adjustment for simpler transitions
- **Hardcoded:** Mid-stay billing model changes always produce an amendment record. The prior billing model and its application period are preserved in the folio history.
- **Configurable:** Billing model availability during stay (per billing model availability configuration surface in §73).

---

#### Policy 33 — Billing Model Settlement Policy

- **Active at:** S8 (folio settlement)
- **Input:** Current `FolioState` (must be `LIVE`), active billing model, outstanding balance, settlement method
- **Decision:** Enforcement rule — settlement method must be compatible with the active billing model. Settlement closes the folio to `FolioState.SETTLED` or `FolioState.OUTSTANDING` depending on whether all balances are resolved.
- **Enforcement point:** `FolioService.initiateSettlement()` — billing model compatibility verified before settlement proceeds; folio state transition recorded
- **Hardcoded:** Auto-closing an outstanding balance to SETTLED without payment is forbidden. A folio with an unresolved balance must be set to `FolioState.OUTSTANDING`, not SETTLED. Payment follow-up (Policy 11) initiates automatically on OUTSTANDING folio closure.
- **Configurable:** Available settlement methods (per billing model availability configuration surface in §73).

---

### §5.2.14 — Cancellation Policy Group

#### Policy 34 — Cancellation Terms Disclosure Policy

- **Active at:** S3 (cancellation terms disclosed before committed hold)
- **Input:** Applicable cancellation penalty tier (derived from rate plan and stay date configuration), entry use type, advance payment amount
- **Decision:** Enforcement rule — cancellation terms must be disclosed before the committed hold is placed. The disclosure event is recorded with the terms shown, the actor who presented them, and the timestamp. S3 cannot proceed to committed hold without this event.
- **Enforcement point:** `HoldService.placeCommittedHold()` — disclosure event required as a pre-condition; no-show doctrine included in disclosed terms
- **Hardcoded:** Cancellation terms including the no-show treatment are disclosed at S3 without exception. A committed hold placed without a prior disclosure event is an architectural violation.
- **Configurable:** Cancellation penalty tier structure (per cancellation penalty tiers configuration surface in §73).

---

#### Policy 35 — Cancellation Enforcement Policy

- **Active at:** S4 (post-confirmation cancellation), S5 (pre-arrival cancellation), S6 (post-check-in cancellation)
- **Input:** Cancellation event, entry's current stage, applicable cancellation penalty tier, advance payments received, requesting actor `ActorLevel`
- **Decision:** APPROVED (`ActorLevel.FOM` — cancellation processed with penalty applied per the disclosed tier) | ESCALATE(`ActorLevel.GM`) (penalty waiver requested beyond FOM authority)
- **Enforcement point:** `CancellationService.processCancel()` — policy evaluated before cancellation event is written; penalty calculated and posted to folio; advance payment reconciliation triggered; `EntryStatus` set to `CANCELLED`; historical records preserved
- **Hardcoded:** Cancellation sets `EntryStatus.CANCELLED` — terminal state. All operational history is preserved on the cancelled entry. Financial residue (penalty charges, advance payment surplus) is governed through S9-equivalent processing. The financial residue does not disappear on cancellation.
- **Configurable:** Cancellation penalty tiers; penalty waiver authority thresholds.

---

#### Policy 36 — Early Departure Policy

- **Active at:** S7 (guest departs before scheduled checkout date)
- **Input:** Entry departure date, actual departure date, billing model, rate plan, early departure penalty configuration, requesting actor `ActorLevel`
- **Decision:** APPROVED (`ActorLevel.GM` — early departure processed; penalty applied if applicable) | DENIED (early departure not permissible under current rate plan terms without GM authority)
- **Enforcement point:** `AmendmentService.initiateEarlyDeparture()` — policy evaluated before departure date change is written; penalty calculation applied; GM authority confirmed before proceeding
- **Hardcoded:** Early departure requires GM authority. Shortened stay charges are calculated against the original commitment snapshot — the rate is not retrospectively renegotiated as a condition of early departure.
- **Configurable:** Early departure penalty terms per rate plan.

---

### §5.2.15 — FOC Policy Group

#### Policy 37 — FOC Entitlement Calculation Policy

- **Active at:** S2 (FOC entitlement calculated during group quotation)
- **Input:** Group size, applicable FOC entitlement formula, rate plan FOC configuration, seasonality configuration
- **Decision:** APPROVED (entitlement calculated; FOC rooms determined) | DENIED (group size below minimum FOC threshold) | ESCALATE(`ActorLevel.GM`) (FOC allocation requires GM approval before inclusion in quotation)
- **Enforcement point:** `QuotationService` for group bookings — calls `FOCValidationEngine.validate()` to evaluate entitlement before FOC rooms are included in quotation
- **Engine delegation:** `FOCValidationEngine.validate(input: FocValidationInput): FocValidationResult`
- **Hardcoded:** FOC room rate must be above MSR — FOC does not override the MSR floor. GM approval is required before FOC allocation is confirmed.
- **Configurable:** FOC entitlement formula (per-N-rooms, or per contract terms); seasonality restrictions on FOC; FOC configuration per rate plan (§73 FOC configuration surface).

---

#### Policy 38 — FOC Validation Policy

- **Active at:** S3 (committed hold — FOC room included)
- **Input:** Proposed FOC room allocation, applicable MSR, seasonality configuration, entitlement formula result from S2
- **Decision:** APPROVED (all three checks pass: MSR met, seasonality allows, entitlement confirmed) | DENIED (any check fails — FOC room cannot be included in committed hold)
- **Enforcement point:** `HoldService.placeCommittedHold()` — calls `FOCValidationEngine.validate()` before FOC rooms are included in the committed hold; S3 exit is blocked if `isValid: false`
- **Engine delegation:** `FOCValidationEngine.validate(input: FocValidationInput): FocValidationResult`
- **Hardcoded:** All three validation checks (MSR, seasonality, entitlement) must pass simultaneously. Partial pass is not sufficient. GM approval must be recorded before the FOC allocation is written.
- **Configurable:** FOC configuration per rate plan; seasonality restrictions; entitlement formula.

---

#### Policy 39 — FOC Verification Policy

- **Active at:** S4 (re-verification at confirmation)
- **Input:** FOC allocation from S3 committed hold, current MSR (re-verified at confirmation time), current seasonality configuration
- **Decision:** APPROVED (FOC still valid at confirmation time) | DENIED (FOC no longer valid — configuration or rate plan has changed since S3; FOC must be removed or renegotiated)
- **Enforcement point:** `ReservationService.confirm()` — calls `FOCValidationEngine.validate()` with current configuration; FOC stripped from confirmation if validation fails; FOM notified
- **Engine delegation:** `FOCValidationEngine.validate(input: FocValidationInput): FocValidationResult`
- **Hardcoded:** FOC validation is re-run at S4 using current configuration — it is not assumed to be valid because it passed at S3. The confirmation snapshot reflects the S4 validation result.
- **Configurable:** FOC configuration per rate plan (same configuration surface as S3).

---

### §5.2.16 — Confirmation Authority Policy Group

#### Policy 40 — Confirmation Authority Policy

- **Active at:** S4 (reservation confirmation)
- **Input:** Entry value (total room revenue), entry use type, requesting actor `ActorLevel`, confirmation authority thresholds configuration
- **Decision:** APPROVED (`ActorLevel.FRONT_DESK` — standard value entries) | ESCALATE(`ActorLevel.FOM`) (high-value entries or conference / event use type)
- **Enforcement point:** `ReservationService.confirm()` — authority check runs before confirmation event is written; the authority level of the confirming actor is recorded on the confirmation event
- **Hardcoded:** Conference and event use type entries always require FOM authority for confirmation. Authority checks against the confirming actor's `ActorLevel` at the time of confirmation — pre-approval by an absent FOM is not valid; the FOM must be the session actor at confirmation time.
- **Configurable:** High-value threshold (per confirmation authority thresholds configuration surface in §73).

---

### §5.2.17 — Overbooking Policy Group

#### Policy 41 — Overbooking Detection and Trigger Typing Policy

- **Active at:** S4 (reservation confirmation), OTA booking verification
- **Input:** Inventory claim state for all rooms in the confirmation; OTA\_SOURCE flag; overbooking limits configuration
- **Decision:** APPROVED (no overbooking detected) | ESCALATE(`ActorLevel.GM`) (overbooking detected — GM approval required before confirmation proceeds; `OverbookingRecord` created with trigger type)
- **Enforcement point:** `ReservationService.confirm()` — calls `OverbookingDetectionEngine.detect()` before confirmation event is written; if `overbookingDetected: true`, confirmation halts; GM approval required before re-invoking confirmation flow
- **Engine delegation:** `OverbookingDetectionEngine.detect(input: OverbookingInput): OverbookingResult`
- **Hardcoded:** OTA\_SOURCE flag determines trigger type: OTA-sourced overbooking is always typed as `OverbookingTriggerType.OTA_CONFLICT`; hotel-initiated overbooking is always typed as `OverbookingTriggerType.DELIBERATE`. `OTA_CONFLICT` trigger type is immutable once set — it cannot be reclassified as `DELIBERATE`. Auto-confirming an OTA booking with an overbooking condition without human verification is forbidden. OTA\_CONFLICT overbooking creates an additional open loop for OTA platform notification — tracked separately from the mitigation plan.
- **Configurable:** Overbooking approval limits (per overbooking limits configuration surface in §73); OTA\_CONFLICT trigger rules (per OTA\_CONFLICT trigger rules configuration surface in §73).

---

### §5.2.18 — Credit Extension Ceiling Policy Group

#### Policy 42 — Credit Ceiling Mandatory Set Policy

- **Active at:** S3 (committed hold placement when advance payment is not collected)
- **Input:** Credit extension request, approved credit ceiling amount, entry identifier, guest profile credit history
- **Decision:** APPROVED (`ActorLevel.FOM` approves ceiling; `CreditExtensionCeilingRecord` created) | DENIED (no credit ceiling approved — committed hold cannot proceed without advance payment or approved ceiling)
- **Enforcement point:** `HoldService.placeCommittedHold()` — credit ceiling record required as a pre-condition when advance payment is not satisfied; `CreditExtensionCeilingRecord` created before hold is placed
- **Hardcoded:** Every entry that proceeds to committed hold without advance payment must have an approved credit extension ceiling on record. There is no committed hold without either advance payment or an approved ceiling.
- **Configurable:** Credit ceiling threshold bands per client tier (Appendix C seed data; per credit extension ceiling thresholds configuration surface in §73).

---

#### Policy 43 — Credit Ceiling Commitment Snapshot Carry Policy

- **Active at:** S4 (confirmation snapshot)
- **Input:** Approved `CreditExtensionCeilingRecord`, `Reservation` record being created
- **Decision:** Enforcement rule — the approved credit ceiling is carried into the commitment snapshot at S4. The ceiling value in the snapshot is the ceiling that governs S5–S8 monitoring.
- **Enforcement point:** `ReservationService.confirm()` — `CreditExtensionCeilingRecord` reference included in the commitment snapshot before confirmation is written
- **Hardcoded:** The ceiling in the commitment snapshot cannot be modified after S4 exit without a new segment. In-place modification of the ceiling value in a locked snapshot is forbidden.
- **Configurable:** None — the carry is automatic; it is not configurable.

---

#### Policy 44 — Credit Ceiling Proximity Check Policy

- **Active at:** S5 (pre-arrival — proximity to ceiling checked against expected stay charges)
- **Input:** Approved credit ceiling (from commitment snapshot), projected total stay charges, proximity threshold configuration
- **Decision:** Enforcement rule — `CreditCeilingMonitorEngine.evaluate()` is called; the result determines whether advisory notice, FOM interruption, or soft gate activates. The result is returned to the calling service; the service takes the governed action.
- **Enforcement point:** `PreArrivalService` — calls `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult`
- **Engine delegation:** `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult`
- **Hardcoded:** If the 100% threshold is crossed (projected charges exceed approved ceiling), the soft gate on non-mandatory charges activates automatically. It cannot be suppressed.
- **Configurable:** Proximity threshold percentages (75%, 90%, 100% defaults — Appendix C seed data; per credit extension ceiling thresholds configuration surface in §73).

---

#### Policy 45 — Credit Ceiling Active Monitoring Policy

- **Active at:** S7 (every charge posting during stay; every night audit cycle)
- **Input:** Current outstanding balance, approved credit ceiling (from commitment snapshot), new charge being posted, proximity threshold configuration
- **Decision:** Enforcement rule — `CreditCeilingMonitorEngine.evaluate()` is called on every charge posting event and at each night audit cycle. The calling service acts on the result: advisory notice dispatched at 75%; FOM interruption at 90%; soft gate on non-mandatory charges at 100%.
- **Enforcement point:** `FolioService.postCharge()` and `NightAuditService` — both call `CreditCeilingMonitorEngine.evaluate()` per charge or per cycle; threshold-crossing events recorded as `CreditCeilingThresholdEvent` records
- **Engine delegation:** `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult`
- **Hardcoded:** The 100% soft gate cannot be bypassed by operational staff — it requires FOM authority. Threshold-crossing events are permanent records — they are not cleared when the balance subsequently decreases.
- **Configurable:** Proximity threshold percentages (per credit extension ceiling thresholds configuration surface in §73).

---

#### Policy 46 — Credit Ceiling Final Balance Policy

- **Active at:** S8 (folio settlement)
- **Input:** Final folio balance, approved credit ceiling, `FolioState`
- **Decision:** APPROVED (balance within ceiling; settlement proceeds) | ESCALATE(`ActorLevel.FOM`) (balance exceeds approved ceiling — FOM must explicitly acknowledge excess before settlement proceeds)
- **Enforcement point:** `FolioService.initiateSettlement()` — final balance check against ceiling before settlement event is written; FOM acknowledgement event recorded if ceiling is exceeded
- **Hardcoded:** A folio that settles with a balance above the approved ceiling must carry an explicit FOM acknowledgement event. Settlement without this event when ceiling is exceeded is forbidden.
- **Configurable:** None — the ceiling is the approved ceiling from the commitment snapshot.

---

### §5.2.19 — DEFICIENT Condition Policy Group

#### Policy 47 — DEFICIENT Surface in Search Policy (Cross-Group Reference)

- **Active at:** S1 (availability search results)
- **Cross-group note:** The §72 DEFICIENT condition policy class has its own S1 cell ("surface in search"). This cell and the Availability policy class S1 cell ("query + DEFICIENT surface") both point to the same enforcement event: the `AvailabilityService` post-query annotation step that flags DEFICIENT rooms in search results. There is one enforcement point, not two. Policy 2 (Availability group) is the authoritative definition of that enforcement point. Implementation must not create a second annotation step for this policy — doing so is an architectural violation.
- **Enforcement point:** Satisfied by Policy 2. No separate enforcement point exists or should be created.
- **S5 assignment gate:** Governed exclusively by Policy 48 (DEFICIENT Room Assignment Decision Policy). Policy 47 has no S5 scope.

---

#### Policy 48 — DEFICIENT Room Assignment Decision Policy

- **Active at:** S5 (room assignment)
- **Input:** `DeficientConditionRecord` for the proposed room, requesting actor `ActorLevel`, acknowledgement event
- **Decision:** APPROVED (DEFICIENT condition acknowledged; assignment may proceed; flag carried into assignment record) | DENIED (acknowledgement not recorded — assignment cannot proceed)
- **Enforcement point:** `RoomAssignmentService.assignRoom()` — policy evaluated before room assignment is written; DEFICIENT acknowledgement event required; acknowledgement actor and timestamp recorded
- **Hardcoded:** A DEFICIENT-flagged room cannot be assigned without an explicit acknowledgement event. The DEFICIENT flag is carried into the assignment record — it does not disappear on assignment.
- **Configurable:** DEFICIENT condition categories that trigger mandatory acknowledgement (per DEFICIENT condition categories configuration surface in §73).

---

#### Policy 49 — DEFICIENT Carry Policy

- **Active at:** S6 (check-in — H2 handoff to housekeeping)
- **Input:** DEFICIENT flag status on the assigned room, H2 `HandoffRecord` content
- **Decision:** Enforcement rule — H2 must explicitly reference any active DEFICIENT condition on the assigned room. A H2 that does not carry an active DEFICIENT flag to housekeeping is incomplete.
- **Enforcement point:** `HandoffService.createH2()` — DEFICIENT flag status is included in H2 handoff content; housekeeping is informed of the DEFICIENT condition on check-in
- **Hardcoded:** DEFICIENT conditions are not silently cleared at check-in. They are carried forward through H2 until resolved or until checkout.
- **Configurable:** None — DEFICIENT carry is a mandatory handoff element.

---

#### Policy 50 — DEFICIENT Resolution Tracking Policy

- **Active at:** S7 (resolution tracking during stay)
- **Input:** `DeficientConditionRecord`, resolution deadline (timer-governed), resolution event (if posted)
- **Decision:** Enforcement event — if the resolution deadline fires without a resolution event, FOM is escalated. Unresolved DEFICIENT conditions accumulate; they do not expire silently.
- **Enforcement point:** `DeficientResolutionWorker` (timer-fired) — escalation to FOM on deadline breach; `DeficientConditionRecord` updated with escalation event; original record preserved with resolution layered additively
- **Hardcoded:** `DEFICIENT_RESOLVED` state requires a resolution event record layered onto the original condition record. The original condition is preserved — the resolution is additive, not a replacement.
- **Configurable:** DEFICIENT resolution deadline per category (per DEFICIENT resolution deadline configuration surface in §73).

---

#### Policy 51 — DEFICIENT Inspection Review Policy

- **Active at:** S8 (room inspection at or before checkout)
- **Input:** `DeficientConditionRecord` status (resolved or unresolved), room inspection event
- **Decision:** Enforcement rule — room inspection at S8 must record DEFICIENT condition final status. If unresolved at checkout, `DEFICIENT_UNRESOLVED_AT_CHECKOUT` state is set permanently on the record.
- **Enforcement point:** `CheckOutService` — inspection review event required; `DeficientConditionRecord.finalStatus` written before S8→S9 transition
- **Hardcoded:** `DEFICIENT_UNRESOLVED_AT_CHECKOUT` is a permanent state on the guest's stay record. It cannot be retroactively resolved after checkout — post-checkout corrections require a post-closure additive record under appropriate authority.
- **Configurable:** None — inspection review is mandatory at S8.

---

### §5.2.20 — Communication / Acknowledgement Tracking Policy Group

#### Policy 52 — Communication Acknowledgement Tracking Policy

- **Active at:** S2 (quotation sent), S3 (PI sent), S4 (voucher sent), S5 (pre-arrival communications), S7 (amendment communications), S8 (settlement communications), S9 (invoice)
- **Input:** Outbound `CommunicationRecord`, configured acknowledgement window per communication type, acknowledgement event (explicit or implicit) | timeout event
- **Decision:** Enforcement rule — every outbound communication that requires acknowledgement opens an acknowledgement loop. The loop closes on: explicit acknowledgement received (`AcknowledgementStatus.RECEIVED`), implicit acknowledgement (guest arrives — closing pre-arrival acknowledgement loops), or governed timeout (`AcknowledgementStatus.TIMED_OUT`). Timed-out acknowledgements are not silent — `TIMED_OUT` is recorded as a flag on the communication record. Non-acknowledgement becomes a visible flag on the entry for the relevant stage.
- **Enforcement point:** `CommunicationService.send()` — acknowledgement loop opened on outbound send; `TimerEngine.register()` called for acknowledgement window; `AcknowledgementWorker` (timer-fired) transitions to `TIMED_OUT` and notifies responsible actor if window expires
- **Hardcoded:** Every governed communication has a tracked acknowledgement state — `AcknowledgementStatus.PENDING`, `RECEIVED`, or `TIMED_OUT`. There is no communication without an acknowledgement state.
- **Configurable:** Acknowledgement window per communication type (per acknowledgement window per type configuration surface in §73); communication channel per stage (per communication channel config in §73).

---

### §5.2.21 — Service Recovery / Dispute Policy Group

#### Policy 53 — Active Dispute Management Policy

- **Active at:** S7 (dispute open during in-stay period)
- **Input:** `DisputeRecord` state (must be `OPEN` or `IN_PROGRESS`), `DisputeFailureCategory`, resolution plan, responsible FOM actor
- **Decision:** Enforcement rule — an open dispute during S7 creates a mandatory tracking obligation. FOM is the responsible actor for in-stay dispute management. `ResolutionBundle` items are tracked to execution.
- **Enforcement point:** `DisputeService.createDispute()` and `DisputeService.updateDisputeProgress()` — dispute state transitions are governed; `ResolutionBundleItem` records are created on commitment and transitioned to `EXECUTED` or `CANCELLED` on action
- **Hardcoded:** `DISPUTE_EXHAUSTED` is not a valid `DisputeState`. There is no state representing an exhausted dispute — a dispute is either RESOLVED (guest accepted) or CLOSED (GM formal closure with recorded reason).
- **Configurable:** None at the tracking layer — active dispute management obligations are Canon invariants. Dispute gate function configuration (which dispute types block which stage progressions) is a configurable parameter of Policy 54, not this policy.

---

#### Policy 54 — Dispute Gate Stage Progression Policy

- **Active at:** S7→S8 transition (S8 entry gate — dispute check runs as S7 exit condition before S8 may be entered); S8→S9 transition (S9 entry gate — dispute check runs as S8 exit condition before S9 may be entered)
- **Input:** Entry identifier, target stage, `DisputeRecord` state for all disputes linked to the entry
- **Decision:** APPROVED (no blocking dispute — engine returns `CLEAR`) | ESCALATE(`ActorLevel.GM`) (blocking dispute with override available — engine returns `BLOCKED_WITH_OVERRIDE_AVAILABLE`; `DisputeGateOverrideRecord` created by service on GM approval) | DENIED (blocking dispute without override path — engine returns `BLOCKED` at S8→S9 when dispute is `OPEN` or `IN_PROGRESS`)
- **Enforcement point:** `EntryService.progressStage()` — calls `DisputeGateEngine.canProgressStage()` at every S7→S8 and S8→S9 transition; override records created by service layer (not engine); GM authority required for override
- **Engine delegation:** `DisputeGateEngine.canProgressStage(input: DisputeGateInput): DisputeGateResult`
- **Hardcoded:** At S8→S9, the engine returns `BLOCKED` (not `BLOCKED_WITH_OVERRIDE_AVAILABLE`) if any dispute is in `DisputeState.OPEN` or `IN_PROGRESS`. Override is not available at this transition — the dispute must reach `RESOLVED` or `CLOSED` before S8→S9 proceeds.
- **Configurable:** Which dispute types block which stage progressions (per dispute gate function config in §73).

---

#### Policy 55 — Dispute Closure Policy

- **Active at:** S9 (post-closure dispute finalisation)
- **Input:** `DisputeRecord` state, `ResolutionBundle` status, GM closure reason (if applicable)
- **Decision:** APPROVED (`DisputeState.RESOLVED` — guest accepted resolution; `ResolutionBundleStatus.SEALED`) | APPROVED (`DisputeState.CLOSED` — GM formal closure with recorded reason; `ResolutionBundleStatus.SEALED`)
- **Enforcement point:** `DisputeService.closeDispute()` — closure event recorded with actor, reason, and timestamp; `ResolutionBundle` sealed
- **Hardcoded:** GM closure requires a recorded reason. A dispute cannot be closed without either guest acceptance or GM formal closure. `ResolutionBundle` is sealed on dispute closure — no further items may be committed after sealing.
- **Configurable:** None — closure rules are Canon invariants.

---

### §5.2.22 — No-Show Policy Group

#### Policy 56 — No-Show Detection and Determination Policy

- **Active at:** S5 (cutoff period reached without guest arrival)
- **Input:** Entry arrival date, configured no-show cutoff period, contact attempt records, `FOM` determination event
- **Decision:**
  - **APPROVED — Sub-path 1 (No-show determined):** FOM formally determines no-show; `NoShowDeterminationRecord` created immediately; financial mechanics fire via Policy 57 — penalty posted, `FolioState` set to `NO_SHOW_CLOSED`, surplus advance payment refund record created, S9-equivalent processing initiated.
  - **APPROVED — Sub-path 2 (Written confirmation pending):** Guest has claimed late arrival verbally; FOM is not ready to finalise; entry enters `AWAITING_WRITTEN_CONFIRMATION` state; `TimerEngine.register()` called for the deferral window. Two outcomes: (a) written confirmation arrives before timer fires — no-show process abandoned, entry continues on its normal path, no `NoShowDeterminationRecord` created; (b) timer fires without written confirmation — no-show finalised automatically by system, Sub-path 1 mechanics execute at that point.
  - **DENIED:** Cutoff period not yet reached — no-show process cannot be initiated prematurely.
- **Enforcement point:** `NoShowService.determinateNoShow()` — FOM determination event required; `NoShowDeterminationRecord` created; `AWAITING_WRITTEN_CONFIRMATION` timer registered with `TimerEngine.register()` if deferral path is taken
- **Hardcoded:** No-show determination is a FOM authority action — it cannot be auto-determined by the system without FOM decision event. `AWAITING_WRITTEN_CONFIRMATION` timer expiry finalises no-show automatically if no written confirmation is received. For OTA-sourced entries: an additional communication obligation to the OTA platform creates a separate open loop — this loop is not a dependency on financial processing.
- **Configurable:** No-show cutoff period (per no-show cutoff period configuration surface in §73); `AWAITING_WRITTEN_CONFIRMATION` timer duration.

---

#### Policy 57 — No-Show Folio Financial Policy

- **Active at:** S5 (no-show financial mechanics)
- **Input:** `NoShowDeterminationRecord`, advance payment amount, no-show penalty configuration (aligned with same-day cancellation tier), folio state
- **Decision:** Enforcement rule — no-show penalty is posted to folio; penalty cannot exceed total advance payment received. Surplus advance payment creates a refund record tracked through S9-equivalent processing.
- **Enforcement point:** `NoShowService.processNoShowFolio()` — penalty calculated; posted to folio; `FolioState` set to `NO_SHOW_CLOSED`; refund record created if advance payment exceeds penalty; S9-equivalent processing initiated
- **Hardcoded:** No-show penalty cannot exceed total advance payment received — this ceiling is invariant, not configurable. No-show financial processing always produces a fully governed folio record. The folio is not informally closed.
- **Configurable:** No-show penalty structure (per no-show penalty structure configuration surface in §73; aligned with same-day cancellation tier).

---

### §5.2.23 — Room Change Policy Group

#### Policy 58 — Room Change Mode Trigger Policy

- **Active at:** S7 (room change during stay)
- **Input:** Room change request, requesting actor `ActorLevel`, current `InventoryClaimState` of source and target rooms, rate delta (if applicable)
- **Decision:** APPROVED (`ActorLevel.FRONT_DESK` — same rate, equivalent room) | ESCALATE(`ActorLevel.FOM`) (rate delta requires FOM authority; DEFICIENT condition on target room) | ESCALATE(`ActorLevel.GM`) (rate increase beyond FOM authority)
- **Enforcement point:** `RoomChangeService.initiateRoomChange()` — Room Change mode activated; new segment created for the entry; inventory claim state transitions applied; rate delta processed through `AmendmentService` if applicable
- **Hardcoded:** Room change always creates a new segment. The prior segment is sealed on room change mode exit. The original room assignment and rate are preserved in the sealed segment.
- **Configurable:** Rate delta threshold below which FOM authority is sufficient (Appendix C seed data).

---

### §5.2.24 — Night Audit Policy Group

#### Policy 59 — Night Audit Countdown Policy

- **Active at:** S5 (pre-arrival countdown for expected in-stay entries)
- **Input:** Night audit schedule configuration, entry expected arrival date, current operating date
- **Decision:** Enforcement rule — night audit schedule is confirmed for the entry's expected stay nights. Timer Engine registers night audit timers for each expected stay night.
- **Enforcement point:** `PreArrivalService` — registers night audit timers via `TimerEngine.register()` for each expected stay night; schedule derived from night audit schedule configuration
- **Hardcoded:** Night audit countdown timers are mandatory for every entry that will be in-stay. There is no in-stay period without night audit timer registration.
- **Configurable:** Night audit schedule (per night audit schedule configuration surface in §73).

---

#### Policy 60 — Night Audit Charge Posting and Completeness Policy

- **Active at:** S7 (every night audit cycle)
- **Input:** All active in-stay entries for the operating date, their commitment snapshots and rate plans, night audit expected charges configuration, prior audit state
- **Decision:** Enforcement rule — `NightAuditEngine.runAudit()` is invoked; room charges posted per commitment snapshot; occupancy reconciliation performed; completeness check run against expected charges configuration. If any entry cannot be processed, `NightAuditRunStatus.PARTIAL` is set; that entry receives an `AUDIT_EXCEPTION` record; audit continues with remaining entries.
- **Enforcement point:** `NightAuditService.runNightAudit()` — calls `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult`; `TaxEngine.calculate()` called per charge before folio line is written; `CreditCeilingMonitorEngine.evaluate()` called per charge for ceiling-monitored entries; all records written in a single transaction per entry; `TimerEngine.register()` called for next-day timer recalculation after run completes
- **Engine delegation:** `NightAuditEngine.runAudit(input: NightAuditInput): NightAuditResult`; `TaxEngine.calculate(input: TaxInput): TaxResult`; `CreditCeilingMonitorEngine.evaluate(input: CreditCeilingInput): CreditCeilingResult`
- **Hardcoded:** Night audit is idempotent — a double-run for the same operating date does not produce duplicate charges (idempotency guard is in the engine). Night audit seals the folio for the processed date — post-audit manual charge posting for a sealed date is forbidden. AI Audit Supplement is produced by the calling service after the engine run completes — the engine does not produce it.
- **Configurable:** Night audit expected charges rules (per night audit expected charges rules configuration surface in §73); night audit schedule.

---

#### Policy 61 — Night Audit Overdue Detection Policy

- **Active at:** S8 (checkout initiated — night audit status check)
- **Input:** Entry's night audit records for all stay nights, `NightAuditRunStatus` for each night, checkout initiation event
- **Decision:** Enforcement rule — if any stay night has `NightAuditRunStatus.PARTIAL` or no audit record, checkout is blocked until FOM explicitly acknowledges the overdue audit condition and decides how to proceed.
- **Enforcement point:** `CheckOutService` — night audit completeness check is a mandatory pre-condition before S8 progression; FOM acknowledgement event recorded for any overdue night
- **Hardcoded:** Checkout cannot proceed past a night with no completed audit record without FOM explicit acknowledgement. Silent bypass of missing night audit is forbidden.
- **Configurable:** None — overdue detection is a system invariant.

---

#### Policy 62 — Night Audit Stale Record Detection Policy

- **Active at:** S9 (post-closure review)
- **Input:** `NightAuditRecord` records for the closed entry's stay nights, closure timestamp
- **Decision:** Enforcement rule — stale or incomplete audit records detected post-closure are flagged in the audit trail. They do not block S9 closure but generate a permanent exception flag in the governance record.
- **Enforcement point:** `EntryService.close()` — post-closure audit health check fires; stale records flagged; governance event recorded
- **Hardcoded:** Post-closure stale detection is always run. Stale audit records at closure are never silently accepted — they are always flagged.
- **Configurable:** None — stale detection is a system invariant.

---

### §5.2.25 — Handoff Policy Group

#### Policy 63 — Handoff Lifecycle Policy

- **Active at:** S4 (H1 created), S5 (H1 accepted), S6 (H2 and H3 created), S7 (H4 initiated), S8 (H4 completed; H5 created), S9 (H5 closed)
- **Input per handoff type:** `HandoffType` (H1 through H5), responsible actors, checklist completion status, `HandoffState`
- **Decision (per handoff):**
  - H1 (S4 creation, S5 acceptance): APPROVED (acceptance recorded; custodian transfer completes) | DENIED (checklist incomplete) | ESCALATE(`ActorLevel.FOM`) (H1 rejected — FOM reroutes). Auto-fulfilment applies when reservations and front desk are the same team — acceptance event is recorded regardless.
  - H2 and H3 (S6 creation): Enforcement rule — created at check-in completion. H2 (to housekeeping) carries room assignment and DEFICIENT flags. H3 (to F&B) carries meal plan and dietary requirements. Neither is optional.
  - H4 (S7 initiation, S8 completion): APPROVED (pre-checkout coordination complete) | DENIED (checklist incomplete — S8 progression blocked). H4 completion is a mandatory S7→S8 gate condition.
  - H5 (S8 creation, S9 closure): Enforcement rule — H5 is created at S8 and closed at S9 when all post-departure accounting and records are complete. H5 auto-fulfilment is permitted where front desk and accounts are the same team — event recorded regardless.
- **Enforcement point:** `HandoffService.createHandoff()`, `HandoffService.acceptHandoff()`, `HandoffService.fulfillHandoff()`, `HandoffService.closeHandoff()` — all handoff state transitions produce permanent audit events
- **Hardcoded:** Every handoff produces an audit event — including auto-fulfilments. A handoff that is never recorded is an audit gap. `HandoffState.REJECTED` requires FOM rerouting — there is no silent rejection.
- **Configurable:** H1–H5 handoff checklists (per H1–H5 handoff checklists configuration surface in §73).

---

### §5.2.26 — Group FOC / Billing Policy Group

#### Policy 64 — Group Detection Policy

- **Active at:** S1 (inquiry creation)
- **Input:** Number of rooms requested, use type, guest or coordinator identity
- **Decision:** APPROVED (group flag set on inquiry; group billing and FOC rules apply from this point) | APPROVED without group flag (below group threshold — standard individual booking rules apply)
- **Enforcement point:** `InquiryService.create()` — group detection check runs at inquiry creation; group flag set on `Inquiry` record if threshold met
- **Hardcoded:** Group detection is automatic — the system sets the group flag; the operator does not manually designate a booking as a group booking. Group flag cannot be removed once set without creating a new inquiry.
- **Configurable:** Group size threshold; group billing mode options available (per `GroupBillingMode` enum: `CONSOLIDATED`, `INDIVIDUAL`, `SPLIT`).

---

#### Policy 65 — Group Rate Application Policy

- **Active at:** S2 (group quotation)
- **Input:** Group size, applicable group volume bands in rate plan configuration, `GroupBillingMode`
- **Decision:** APPROVED (group rate resolved; group volume band applied; FOC entitlement calculated) | ESCALATE(`ActorLevel.FOM`) (group rate requires FOM approval for non-standard commercial terms)
- **Enforcement point:** `QuotationService.createGroupQuotation()` — calls `PricingPipelineEngine.resolve()` with group context; group volume band applied in rate resolution; FOC entitlement calculation initiated (Policy 37)
- **Engine delegation:** `PricingPipelineEngine.resolve(input: PricingInput): PricingResult`
- **Hardcoded:** Group rate priority follows the same invariant rate plan priority order as individual bookings. Group volume bands are applied within the PricingPipelineEngine — they do not override the priority order.
- **Configurable:** Group size volume bands; group rate discounts within configured limits.

---

#### Policy 66 — Group FOC and Billing Split Policy

- **Active at:** S7 (billing split), S8 (group settlement). Note: S3 FOC validation is governed by Policy 38; S4 FOC verification is governed by Policy 39; S9 commission-due record creation is governed by Policy 68. Those policies apply to group entries in the same way they apply to all entries — Policy 66 does not duplicate them.
- **Input (varies by stage):** Group composition, `GroupBillingMode`, individual folio states for all entries in the group
- **Decision (varies by stage):**
  - S7 (billing split): APPROVED (billing mode activated; individual or consolidated folios structured per `GroupBillingMode`) | ESCALATE(`ActorLevel.FOM`) (billing mode change mid-stay)
  - S8 (group settlement): Enforcement rule — each folio within the group settled per its `GroupBillingMode`; settlement method compatible with each folio's active billing model
- **Enforcement point:** `GroupBillingService` — coordinates group-level billing operations; delegates to `FolioService` per individual entry
- **Hardcoded:** Group billing split follows the `GroupBillingMode` set at S3 — it cannot be changed after S4 confirmation without a new segment.
- **Configurable:** `GroupBillingMode` options (`CONSOLIDATED`, `INDIVIDUAL`, `SPLIT`).

---

### §5.2.27 — Work Order Policy Group

#### Policy 67 — Work Order Lifecycle Policy

- **Active at:** S1 (initiate), S3 (initiate), S4 (verify), S5 (to-do prep), S7 (consume), S8 (close)
- **Input (varies by stage):** Work order type, linked entry identifier, to-do items and deadlines, responsible staff assignments, completion evidence
- **Decision (varies by stage):**
  - S1 / S3 (initiate): APPROVED (work order and initial to-do items created) | DENIED (required fields missing)
  - S4 (verify): APPROVED (pre-arrival work order items verified complete or governed-deferred) | DENIED (blocking to-do items not complete — S4 exit condition not met)
  - S5 (to-do prep): Enforcement rule — to-do items for pre-arrival tasks are confirmed or governed-deferred with reason.
  - S7 (consume): Enforcement rule — in-stay work order items tracked to `WorkOrderItemState.COMPLETED` or `CANCELLED` with reason.
  - S8 (close): APPROVED (`WorkOrder` closed when all items are `COMPLETED` or `CANCELLED`). Items remaining `IN_PROGRESS` at S8 without FOM acknowledgement block S8 close.
- **Enforcement point:** `WorkOrderService` — all work order lifecycle transitions governed; `TimerEngine.register()` called for deadline timers on each to-do item; approaching deadline prompts assigned staff; breached deadline alerts FOM
- **Hardcoded:** Every work order amendment is a layered event — the work order never enters an "edited" state; it accumulates amendment layers. `WorkOrderItemState.CANCELLED` requires a recorded reason.
- **Configurable:** Work order templates per use type (per work order templates configuration surface in §73); to-do deadline defaults per template.

---

### §5.2.28 — Commission Production Policy Group

#### Policy 68 — Commission-Due Record Creation Policy

- **Active at:** S9 (entry closure)
- **Input:** Agent profile linked to the inquiry, commission rate configuration for the agent, entry's total qualifying revenue
- **Decision:** Enforcement rule — if agent profile has a commission rate configured, a `CommissionDueRecord` is created at S9 closure with `CommissionDueStatus.PENDING`. If no commission rate is configured, `CommissionDueStatus.RATE_MISSING` is set — this is an activation seam flag, not an error that blocks closure.
- **Enforcement point:** `EntryService.close()` — `CommissionDueRecord` creation is a mandatory step at S9 closure for entries with a linked agent profile; record creation event recorded
- **Hardcoded:** Commission-due record creation is automatic at S9 closure — it is not initiated by a staff action. The record is created even when `RATE_MISSING` — the seam is preserved for when configuration is later completed.
- **Configurable:** Commission rate per agent profile; commission calculation basis rules (per commission configuration surfaces in §73).

---

### §5.2.29 — Session Management Policy Group

#### Policy 69 — Session Management and PIN Authentication Policy

- **Active at:** All stages (S1 through S9)
- **Input:** Current session actor, session inactivity duration, PIN switch request (outgoing and incoming actor), manual lock request, hard logout condition
- **Decision:** Enforcement rule — session management events are governed at all stages. No session event is silent.
  - PIN switch: outgoing actor's session is suspended; incoming actor authenticates via PIN; `SessionEventType.PIN_SWITCH` recorded with both actor identities and timestamp.
  - Idle auto-lock: inactivity threshold reached; `SessionStatus.IDLE_LOCKED`; `SessionEventType.IDLE_AUTO_LOCK` recorded.
  - Manual lock: staff-initiated one-action lock; `SessionStatus.MANUALLY_LOCKED`; `SessionEventType.MANUAL_LOCK` recorded.
  - Hard logout: extended inactivity threshold reached; `SessionStatus.HARD_LOGGED_OUT`; `SessionEventType.HARD_LOGOUT` recorded; session terminated.
- **Enforcement point:** `SessionService` — all session transitions governed; `SessionEventRecord` created on every session event; attribution enforcement: every record written within a session carries the identity of the authenticated actor at the time of writing
- **Hardcoded:** Shared credentials are forbidden — this is a system design constraint, not a policy violation. Retrospective attribution change is structurally forbidden — the actor recorded on a transaction is the actor who was authenticated at the time; this cannot be corrected after the fact. Every session event produces a permanent `SessionEventRecord`.
- **Configurable:** Idle lock threshold per role; hard logout threshold per role; manual lock behaviour per role (per session management configuration surface in §73).

---

### §5.2.30 — Feedback Policy Group

#### Policy 70 — Feedback Solicitation Policy

- **Active at:** S9 (post-closure)
- **Input:** Entry `EntryStatus.CLOSED`, guest communication channel preferences, feedback solicitation configuration, online review platform configuration
- **Decision:** Enforcement rule — feedback solicitation is dispatched through dual channel at S9 closure. Both channels are attempted regardless of prior acknowledgement status on either channel.
- **Enforcement point:** `EntryService.close()` — feedback solicitation event registered with `CommunicationService`; government portal submission triggered if configured; online review platform links included per configuration
- **Hardcoded:** Feedback solicitation is dispatched only for entries with `EntryStatus.CLOSED` — cancelled, expired, and no-show entries are not solicited.
- **Configurable:** Feedback survey templates; online review platform links (per online review platform links configuration surface in §73); government portal submission configuration (per government portal submission config in §73).

---

### §5.2.31 — Processing Lock Policy Group (§70A)

#### Policy 71 — Processing Lock TTL Policy

- **Active at:** All stages where inventory selection occurs (primarily S1, S2, S3, and amendment paths involving room or space changes)
- **Input:** Lock placement trigger (AI agent drafting response, front desk beginning booking workflow), inventory configuration being referenced (room, hall, apartment unit, date range), TTL configuration per channel
- **Decision:** Enforcement rule — when any channel processor identifies a specific inventory configuration, a `ProcessingLockRecord` is created with `ProcessingLockStatus.ACTIVE` and a TTL timer registered. On TTL expiry: `ProcessingLockStatus` transitions to `EXPIRED`; inventory claim state is not affected; operator receives explicit expiry notification: the message explicitly states that the hold has expired and requires reconfirmation of availability before proceeding.
- **Enforcement point:** `ProcessingLockService.placeLock()` — `ProcessingLockRecord` created; `TimerEngine.register()` called for TTL; `ProcessingLockExpiryWorker` (timer-fired) transitions status to `EXPIRED` and dispatches expiry notification; all transitions produce permanent audit events (`lock_placed`, `lock_expired` with processing context, `lock_released`)
- **Hardcoded:** A processing lock is not a commercial hold. It does not alter `InventoryClaimState`. Silent expiry — expiry without an explicit notification and audit event — is forbidden. There is no heartbeat or renewal mechanism — the TTL is unconditional. When a lock expires and the operator reconfirms, a new `ProcessingLockRecord` is created (new instance, not a renewal); revalidation fires against current system state at the moment of new lock placement; a `RevalidationDeltaRecord` is created and attached to the draft communication record showing what changed during processing.
- **Configurable:** Lock TTL per channel (email AI, WhatsApp AI, front desk, phone) and per engagement type — per lock TTL configuration surface (§70A M.7).

---

#### Policy 72 — Processing Lock Priority Queue Policy

- **Active at:** All stages where inventory selection occurs
- **Input:** Existing `ProcessingLockRecord` for the target inventory, new lock placement request from a second actor
- **Decision:** Enforcement rule — the first lock (by timestamp) has priority. Subsequent actors placing a lock on the same inventory configuration receive an informational notification identifying that another actor has a prior lock on this inventory. Subsequent actors are not blocked from viewing inventory or continuing their workflow. The lock informs — it does not block.
- **Enforcement point:** `ProcessingLockService.placeLock()` — prior lock check runs before new lock creation; informational notification dispatched to second actor if prior lock exists
- **Hardcoded:** Priority order is determined by lock placement timestamp — first lock has priority. Using processing locks to block another actor's booking workflow is forbidden. Processing locks are not a reservation mechanism — they are an awareness mechanism.
- **Configurable:** Priority queue display configuration; revalidation check parameters (what is revalidated when a lock is reconfirmed after expiry: availability state, DEFICIENT flag status, and pricing — all three are always re-verified; the set is hardcoded, but the configuration surfaces they read from are themselves configurable).

---

### §5.2.32 — AI Agent Policy Group (§70B)

#### Policy 73 — AI Trust Level Policy

- **Active at:** All stages where the AI agent is processing communications or performing internal system actions
- **Input:** Action category being performed by AI agent, configured trust level for that action category (`TrustLevel`), action type (internal system action vs. outbound communication)
- **Decision:** Enforcement rule — trust level governs whether an AI action requires human review:
  - `TrustLevel.ALWAYS_REQUIRE_APPROVAL` — every AI output routes to human review queue before any action.
  - `TrustLevel.AUTO_APPROVE_HIGH_CONFIDENCE` — high-confidence AI outputs route to automatic approval for outbound communications; confidence below threshold routes to human review.
  - `TrustLevel.FULL_AUTO` — permitted for internal system actions only: intent classification, inquiry tagging, guest profile field updates, correction logging, and AI audit supplement generation. `FULL_AUTO` is absolutely forbidden for outbound communications of any type — outbound communications are subject to `ALWAYS_REQUIRE_APPROVAL` or `AUTO_APPROVE_HIGH_CONFIDENCE` regardless of the configured trust level for the action category.
- **Enforcement point:** `AIAgentApprovalService` — trust level evaluated for every AI action before the action proceeds; `AiDraftRecord` created for every draft regardless of trust level; `HumanDecisionRecord` created for every human approval, edit-and-approval, or rejection
- **Hardcoded:** `FULL_AUTO` does not apply to outbound communications — this is an absolute constraint. No trust level configuration may override it. Every AI output produces an `AiDraftRecord` regardless of whether it requires human review — the record is created even for `FULL_AUTO` internal actions.
- **Configurable:** Trust level per action category (managed in Admin Console by GM); confidence threshold per intent category; per-channel trust overrides. Note: four additional §70B M.7 configuration surfaces are not policy-level parameters and are addressed at their respective implementation layers — LLM API connection configuration (Part 11, AI Agent interface); AI actor identity in actor registry (Part 2 schema / Part 6 AIAgentApprovalService setup); correction log maximum size (Part 8, correction log aggregation worker); pattern rule registry (Part 6, AIAgentApprovalService runtime configuration).

---

#### Policy 74 — AI Authority Boundary Policy

- **Active at:** All stages where the AI agent is active
- **Input:** Proposed AI action (outbound communication draft, proposed system action), current session state, human approval event status
- **Decision:** Enforcement rule — the AI agent may not send any communication without a human approval event recorded. The AI agent may not execute governed actions (stage transitions, rate overrides, payment waivers, FOC grants) — it may only propose them for human approval. The AI agent operates at `ActorLevel.FRONT_DESK` authority — commercial decisions requiring `ActorLevel.FOM` or `ActorLevel.GM` are routed to humans, not executed by the AI.
- **Enforcement point:** `AIAgentApprovalService` and `CommunicationService.send()` — outbound send is blocked until `HumanDecisionRecord` with `HumanDecisionType.APPROVE` or `HumanDecisionType.EDIT_AND_APPROVE` exists for the draft; governed action proposals create pending action records that require human activation
- **Hardcoded:** AI agent sending communication without human approval event is an absolute forbidden act — no trust level, no configuration, and no operational condition creates an exception. AI agent approving its own drafts is forbidden. This constraint is enforced at `CommunicationService.send()` — it cannot be bypassed by any calling path.
- **Configurable:** Escalation routing per intent category.

---

#### Policy 75 — AI Escalation Policy

- **Active at:** All stages where the AI agent is processing communications
- **Input:** AI confidence score for intent classification, message content, applicable confidence threshold per intent category
- **Decision:** Enforcement rule — three guardrails govern AI escalation behaviour:
  1. **Never assume:** when information is ambiguous or missing, the AI asks rather than assuming. It does not draft a response that assumes unstated information.
  2. **Escalate when out of depth:** when confidence falls below the configured threshold, the AI does not draft a response. It creates an escalation record routing the message directly to a human. An AI draft is not produced for below-threshold confidence.
  3. **Tier 1 authority only:** the AI operates at `ActorLevel.FRONT_DESK` authority. Any message that requires Tier 2 (`ActorLevel.FOM`) or Tier 3 (`ActorLevel.GM`) decisions is routed to humans, not handled by the AI with proposed actions.
- **Enforcement point:** `AIAgentApprovalService` — confidence evaluation runs before draft generation; escalation record created when below threshold; escalation notification routed to FOM
- **Hardcoded:** Below-threshold confidence always produces an escalation, never a low-confidence draft. Escalation records are permanent — they are not cleared when a human handles the message. Every message reaches a terminal state — there is no indefinite processing state.
- **Configurable:** Confidence threshold per intent category; escalation routing per intent category; draft review TTL (beyond which FOM is notified of a pending review that has not been actioned).

---

### §5.2.33 — Voice Note Policy Group (§70C)

#### Policy 76 — Voice Note Routing Policy

- **Active at:** All stages (voice notes may arrive at any stage)
- **Input:** Inbound `CommunicationRecord` with `MessageType.VOICE_NOTE`, linked inquiry or entry, channel (`CommunicationChannel.WHATSAPP` or other voice-note-capable channel)
- **Decision:** Enforcement rule — the AI agent is blocked from processing voice note content. The block is enforced at the intake routing layer, not as a runtime check on the AI agent side. On detection of `MessageType.VOICE_NOTE`, the record is routed to the assigned staff member for the linked inquiry or entry; if the inquiry is unassigned, any front desk staff member may review; FOM handles escalation. `AcknowledgementStatus` on the voice note record is set to `PENDING` — the acknowledgement loop remains open until the staff member completes review and logs the summary. If the voice note is a reply to an outbound communication that was itself awaiting acknowledgement, that outbound communication's `AcknowledgementStatus` remains `PENDING` until the staff member has confirmed what the voice note said — the voice note does not implicitly close an existing acknowledgement loop.
- **Enforcement point:** `VoiceNoteRoutingService` — detects `MessageType.VOICE_NOTE` on inbound communication records; assigns `VOICE_NOTE_UNPROCESSED` status; registers SLA timer with `TimerEngine.register()`; blocks AI agent routing path before any AI processing can begin. The block is at routing — not a guard inside the AI agent that it could fail to apply.
- **Hardcoded:** AI agent does not receive voice note content for classification, drafting, or action proposal — this is a routing-layer exclusion, not a runtime AI decision. Marking a voice note as reviewed without listening to it is forbidden. Closing the voice note loop without a structured `StaffListeningSummaryRecord` is forbidden.
- **Configurable:** Voice note review SLA per channel (§70C M.7); escalation routing for overdue voice notes.

---

#### Policy 77 — Voice Note Review SLA Policy

- **Active at:** All stages (triggered on voice note receipt)
- **Input:** Voice note receipt timestamp, `VOICE_NOTE_UNPROCESSED` status, configured SLA window, SLA breach event
- **Decision:** Enforcement rule — when the SLA timer fires before review is complete: SLA approaching warning dispatched to responsible staff; SLA breach event produced; FOM escalated on breach. The voice note record transitions from `VOICE_NOTE_UNPROCESSED` to `REVIEWED` only when: the staff member has listened, logged the structured `StaffListeningSummaryRecord` (caller intent, commitments mentioned, dates and numbers, language used, staff identity, timestamp), and taken any required action.
- **Enforcement point:** `VoiceNoteRoutingService` — SLA timer registered with `TimerEngine.register()` at receipt; `VoiceNoteSLAWorker` (timer-fired) dispatches approaching warning and escalates on breach; status transition to `REVIEWED` is written by `CommunicationService.completeVoiceNoteReview()` after summary record is logged
- **Hardcoded:** SLA breach always escalates to FOM. There is no path by which a voice note sits unreviewed indefinitely — the SLA timer is always registered at receipt. Status transition to `REVIEWED` requires the structured summary record — a status-only update without a logged summary is rejected. If the voice note requires no action, the `StaffListeningSummaryRecord` must explicitly record "no action required" with reason — the loop closes only after this entry is made.
- **Configurable:** Voice note review SLA window (default: 30 minutes during operating hours); escalation routing for overdue voice notes (§70C M.7 configuration surfaces).

---

## §5.2.34 — Policy Catalogue Summary

The following table provides the complete catalogue index for navigation. Seventy-seven named policies derived from Canon §72 and §§70A–70C.

| # | Policy Name | Group | Stage(s) |
|---|---|---|---|
| 1 | Availability Query Policy | Availability | S1, S5, re-entry |
| 2 | DEFICIENT Condition Surface Policy | Availability | S1 |
| 3 | Initial Custodian Assignment Policy | Ownership | S1 |
| 4 | Custodian Reassignment Policy | Ownership | S4 |
| 5 | H1 Handoff Custodian Transfer Policy | Ownership | S5 |
| 6 | Inquiry Expiry Policy | Expiry / Parking | S1 |
| 7 | Quotation Validity Policy | Expiry / Parking | S2 |
| 8 | Committed Hold Expiry Policy | Expiry / Parking | S3 |
| 9 | Pre-Arrival Period Policy | Expiry / Parking | S5 |
| 10 | Checkout Due Policy | Expiry / Parking | S7 |
| 11 | Post-Stay Payment Follow-Up Policy | Expiry / Parking | S9 |
| 12 | Duplicate Inquiry and Entry Creation Gate Policy | Duplicate Detection | S1 |
| 13 | Multi-Booking Detection Policy | Duplicate Detection | S4 |
| 14 | Shadow Inventory Visibility Policy | Shadow Inventory | S1 |
| 15 | Guest Identity Capture Policy | Guest Identity | S1 |
| 16 | Guest Identity Verification Policy | Guest Identity | S6 |
| 17 | Guest Data Capture Governance Policy | Guest Data Governance | S6 |
| 18 | Guest Data Retention and Deletion Policy | Guest Data Governance | S9 |
| 19 | Rate Plan Resolution Policy | Pricing / Rate Plan | S2 |
| 20 | Commitment Rate Freeze Policy | Pricing / Rate Plan | S4 |
| 21 | Mid-Stay Rate Amendment Policy | Pricing / Rate Plan | S7 |
| 22 | Settlement Rate Policy | Pricing / Rate Plan | S8 |
| 23 | Discount Approval Policy | Discount | S2 |
| 24 | Mid-Stay Discount Policy | Discount | S7 |
| 25 | Speculative Hold Placement Policy | Speculative Hold | S2 |
| 26 | Committed Hold Placement Policy | Committed Hold | S3 |
| 27 | Advance Payment Collection Policy | Advance Payment | S3 |
| 28 | Advance Payment Reconciliation Policy | Advance Payment | S5 |
| 29 | Advance Payment Balance Verification Policy | Advance Payment | S6 |
| 30 | Billing Model Initial Fix Policy | Billing Model | S3 |
| 31 | Billing Model Activation Policy | Billing Model | S6 |
| 32 | Billing Model Mid-Stay Transition Policy | Billing Model | S7 |
| 33 | Billing Model Settlement Policy | Billing Model | S8 |
| 34 | Cancellation Terms Disclosure Policy | Cancellation | S3 |
| 35 | Cancellation Enforcement Policy | Cancellation | S4, S5, S6 |
| 36 | Early Departure Policy | Cancellation | S7 |
| 37 | FOC Entitlement Calculation Policy | FOC | S2 |
| 38 | FOC Validation Policy | FOC | S3 |
| 39 | FOC Verification Policy | FOC | S4 |
| 40 | Confirmation Authority Policy | Confirmation Authority | S4 |
| 41 | Overbooking Detection and Trigger Typing Policy | Overbooking | S4 |
| 42 | Credit Ceiling Mandatory Set Policy | Credit Extension Ceiling | S3 |
| 43 | Credit Ceiling Commitment Snapshot Carry Policy | Credit Extension Ceiling | S4 |
| 44 | Credit Ceiling Proximity Check Policy | Credit Extension Ceiling | S5 |
| 45 | Credit Ceiling Active Monitoring Policy | Credit Extension Ceiling | S7 |
| 46 | Credit Ceiling Final Balance Policy | Credit Extension Ceiling | S8 |
| 47 | DEFICIENT Surface in Search Policy | DEFICIENT Condition | S1 (see Policy 2) |
| 48 | DEFICIENT Room Assignment Decision Policy | DEFICIENT Condition | S5 |
| 49 | DEFICIENT Carry Policy | DEFICIENT Condition | S6 |
| 50 | DEFICIENT Resolution Tracking Policy | DEFICIENT Condition | S7 |
| 51 | DEFICIENT Inspection Review Policy | DEFICIENT Condition | S8 |
| 52 | Communication Acknowledgement Tracking Policy | Communication / Ack | S2–S9 |
| 53 | Active Dispute Management Policy | Service Recovery / Dispute | S7 |
| 54 | Dispute Gate Stage Progression Policy | Service Recovery / Dispute | S7→S8, S8→S9 transitions |
| 55 | Dispute Closure Policy | Service Recovery / Dispute | S9 |
| 56 | No-Show Detection and Determination Policy | No-Show | S5 |
| 57 | No-Show Folio Financial Policy | No-Show | S5 |
| 58 | Room Change Mode Trigger Policy | Room Change | S7 |
| 59 | Night Audit Countdown Policy | Night Audit | S5 |
| 60 | Night Audit Charge Posting and Completeness Policy | Night Audit | S7 |
| 61 | Night Audit Overdue Detection Policy | Night Audit | S8 |
| 62 | Night Audit Stale Record Detection Policy | Night Audit | S9 |
| 63 | Handoff Lifecycle Policy | Handoff | S4–S9 |
| 64 | Group Detection Policy | Group FOC / Billing | S1 |
| 65 | Group Rate Application Policy | Group FOC / Billing | S2 |
| 66 | Group FOC and Billing Split Policy | Group FOC / Billing | S7, S8 |
| 67 | Work Order Lifecycle Policy | Work Order | S1, S3, S4, S5, S7, S8 |
| 68 | Commission-Due Record Creation Policy | Commission Production | S9 |
| 69 | Session Management and PIN Authentication Policy | Session Management | All stages |
| 70 | Feedback Solicitation Policy | Feedback | S9 |
| 71 | Processing Lock TTL Policy | §70A — Processing Lock | All stages |
| 72 | Processing Lock Priority Queue Policy | §70A — Processing Lock | All stages |
| 73 | AI Trust Level Policy | §70B — AI Agent | All stages |
| 74 | AI Authority Boundary Policy | §70B — AI Agent | All stages |
| 75 | AI Escalation Policy | §70B — AI Agent | All stages |
| 76 | Voice Note Routing Policy | §70C — Voice Note | All stages |
| 77 | Voice Note Review SLA Policy | §70C — Voice Note | All stages |

---

## Cross-Reference Notes

**Part 3 alignment:** Policies 5, 9, 38, 39, 40, 41, 54 produce outputs that feed state machine guard conditions defined in Part 3. The guard conditions in Part 3 are authoritative. These policy enforcement points govern when the evaluation runs and what happens when it returns a non-APPROVED result — they do not restate or modify the guard logic.

**Part 4 alignment:** Policies 1, 19, 21, 37, 38, 39, 41, 44, 45, 46, 54, 60, and 65 delegate computation to engines defined in Part 4. The engine definitions in Part 4 govern the computation — including all hardcoded behaviours and configurable parameters within the engine. Policy enforcement points govern invocation and acting on results. Note: Policy 21's engine delegation applies only on full renegotiation (Path 3) where a new rate plan is applied; it does not fire on Path 2 folio adjustments.

**Part 2 alignment:** All enum values used in this part — `ActorLevel`, `Stage`, `EntryStatus`, `InventoryClaimState`, `HoldState`, `FolioState`, `QuotationState`, `AiDraftStatus`, `HumanDecisionType`, `TrustLevel`, `ProcessingLockStatus`, `MessageType`, `AcknowledgementStatus`, `DisputeState`, `SessionStatus`, `SessionEventType`, `CommissionDueStatus`, `OverbookingTriggerType`, `GroupBillingMode` — are defined in Part 2 §2.1.3. No enum is defined or extended in this part.

**IP boundary:** No DOSS principle numbers, no FAC references, and no canonical document provenance appear in this part. All obligations derive from Canon rules expressed as implementation requirements.

---

*End of Part 5 — Policies*

*Prepared by Claude (AI Architectural Partner)*
*07 April 2026*
*Gate 5 — Policies*
*For review and locking by: Dhendup Cheten, Architect, Fuzzy Automation*
*Nothing is locked until the Architect confirms.*
