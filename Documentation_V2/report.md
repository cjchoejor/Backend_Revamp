# Backend Structural Atlas v1.1 — Refactor Report

Generated: 2026-05-08

## Summary of what changed

- **Created Atlas folder skeleton** under `back_end/src/`:
  - `services/{domain,application,infrastructure}/`
  - `routes/` + 20 route-group folders
  - `policies/` + 33 policy-group folders
  - `state-machines/`, `dtos/`, `integrations/`, `bootstrap/`, `reports/` (placeholders)
- **Removed `back_end/src/errors/`** (confirmed unused; project continues using `back_end/src/lib/errors.ts` as the canonical error taxonomy module).
- **Moved services into tiers** and updated all internal imports (ESM/NodeNext `.js` specifiers preserved).
- **Started splitting routes**:
  - New composed router: `back_end/src/routes/api-router.ts`
  - New route modules:
    - `back_end/src/routes/session-and-authentication/router.ts`
    - `back_end/src/routes/inquiries/router.ts`
    - `back_end/src/routes/inquiries/duplicate-flags-router.ts`
    - `back_end/src/routes/entries/router.ts`
    - `back_end/src/routes/availability/router.ts`
    - `back_end/src/routes/processing-locks/router.ts`
    - `back_end/src/routes/quotations-and-holds/router.ts`
    - `back_end/src/routes/s3-ops/router.ts`
    - `back_end/src/routes/reservations/router.ts`
    - `back_end/src/routes/guest-profiles/router.ts`
    - `back_end/src/routes/handoffs/router.ts`
    - `back_end/src/routes/room-assignments/router.ts`
    - `back_end/src/routes/pre-arrival/router.ts`
    - `back_end/src/routes/work-orders/router.ts`
    - `back_end/src/routes/disputes/router.ts`
    - `back_end/src/routes/night-audit/router.ts`
    - `back_end/src/routes/space-allocation/router.ts`
    - `back_end/src/routes/folios/router.ts`
    - `back_end/src/routes/invoices/router.ts`
    - `back_end/src/routes/amendments/router.ts`
    - `back_end/src/routes/cancellations/router.ts`
    - `back_end/src/routes/no-show/router.ts`
    - `back_end/src/routes/admin/router.ts`
  - Server now mounts `apiRouter` in `back_end/src/index.ts`.
  - Legacy consolidated router (`back_end/src/routes/s5-routes.ts`) has now been fully eliminated (all endpoints extracted and file deleted).
- **Started extracting policies into `src/policies/`** (see Cat 06 section).

## Atlas catalogue gaps / mismatches (current code vs Layer 1)

### Cat 03 — State Machines (17 governed machines)
- **Atlas expects**: 17 explicit state-machine modules with named states/transitions/guards.
- **Code reality**: transition/guard logic is currently **embedded inside services** (guard clauses + typed errors + trace events).

**Why extraction was not done earlier**
- The initial refactor pass prioritized **structural moves + import correctness + keeping `tsc` green**. Extracting state machines safely requires:
  - identifying *all* guard/transition code paths per entity,
  - ensuring no behavioral changes in edge cases,
  - and adding a stable calling convention so services don’t diverge.
- We created the `back_end/src/state-machines/` folder so the next pass can extract machine-by-machine without forcing a risky “all-at-once” move.

### Cat 05 — Engines (12)
- **Atlas expects** 12 engines; the Atlas itself contains a placeholder 12th row (“Engine 12 per §4.12 completeness statement”).
- **Code has** several engine modules implemented under `back_end/src/engines/`, but not a full 12-engine surface.
- **Action**: not adding missing engines yet (per your instruction). Will be listed as missing by name when we finalize the inventory.

### Cat 06 — Policies (77 policies in 33 groups)
- **Atlas expects** 77 policies across 33 groups.
- **Important correction**: policies *do exist* in the current backend, but **they were implemented inline inside services** (e.g., comments like “Policy 40 …”, “Policy 23 …”, plus `PolicyGateBlockedError` enforcement).

**What we did now**
- **Cat 06 folder names and `NN-` prefixes** match `BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html` §5.2.1–§5.2.33 (group number = first path segment). Empty groups use a tracked **`.gitkeep`** so all **33** group directories remain present in git.
- Removed misaligned buckets: `01-custodianship`, `02-duplicate-detection`, `12-multi-booking`, `18-conference`, `21-settlement`, `20-communication-ack-tracking` (duplicate / wrong group numbers vs Atlas).
- Began extracting real policy logic into standalone modules (no behavior changes):
  - **Policy 40** extracted to `back_end/src/policies/16-confirmation-authority/p40-confirmation-authority.ts`
  - **Policy 23 (send requires approval trace)** extracted to `back_end/src/policies/09-discount/p23-discount-send-requires-approval.ts`
  - Additional extracted policies (so far):
    - **Policy 03** (group **02** Ownership / Custodian Assignment) → `back_end/src/policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.ts`
    - **Policy 12** (group **04** Duplicate Detection) → `back_end/src/policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.ts`
    - **Policy 13** (group **04** Duplicate Detection) → `back_end/src/policies/04-duplicate-detection/p13-multi-booking-ack-required.ts`
    - **Policy 38** → `back_end/src/policies/15-foc/p38-foc-validation-for-committed-hold.ts`
    - **Policy 38 (GM approval surface)** → `back_end/src/policies/15-foc/p38-foc-gm-approval-authority.ts`
    - **Policy 39** → `back_end/src/policies/15-foc/p39-foc-reverify-before-confirmation.ts`
    - **Policy 41** → `back_end/src/policies/17-overbooking/p41-overbooking-requires-gm-mitigation.ts`
    - **Policy 67** (group **27** Work Order) → `back_end/src/policies/27-work-order/p67-conference-verification-required.ts`
    - **Policy 28** (group **12** Advance Payment) → `back_end/src/policies/12-advance-payment/p28-s5-advance-payment-reconciliation-required.ts`
    - **Policy 48** (group **19** DEFICIENT Condition) → `back_end/src/policies/19-deficient-condition/p48-deficient-room-assignment-decision.ts`
    - **Policy 23 (discount authority + request constraints)**:
      - `back_end/src/policies/09-discount/p23-discount-approval-authority.ts`
      - `back_end/src/policies/09-discount/p23-discount-request-constraints.ts`
    - Additional extracted policies (mapped back into Atlas Cat 06 groups + P-numbers):
      - **Policy 01** (group **01** Availability) → `back_end/src/policies/01-availability/p01-assigned-room-physical-readiness-for-arrival.ts`
        - (S3 re-entry authority guard) `back_end/src/policies/01-availability/p01-reentry-authority.ts`
        - (S3 stage for folio/billing setup and committed-hold placement) `back_end/src/policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts`
        - (S1 conference space allocation) `back_end/src/policies/01-availability/p01-entry-at-s1-for-conference-space-allocation.ts`
        - (S5 / S6 / S7 / S5 no-show / H4 / createH2 stage gates + S5 cancellation stub) `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
        - (S8→S9 progression + S8 settlement entry stage) `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - (S9 closure entry stage) `back_end/src/policies/01-availability/p01-entry-at-s9-for-closure.ts`
        - (Prisma `$extends` immutability / mutation guards wired from `db.ts`) `back_end/src/policies/01-availability/p01-prisma-extension-blocking-guards.ts`
      - **Policy 27** (group **12** Advance Payment) → `back_end/src/policies/12-advance-payment/p27-advance-payment-reconciliation.ts`
      - **Policy 52 (Communication / Acknowledgement Tracking)** → `back_end/src/policies/20-communication-acknowledgement-tracking/p52-ack-open-loop-resolution-requires-fom.ts`
      - **Policy 42 (Credit Extension Ceiling)** → `back_end/src/policies/18-credit-extension-ceiling/p42-credit-ceiling-mandatory-set.ts`
        - (S3 pre-condition) `back_end/src/policies/18-credit-extension-ceiling/p42-advance-payment-or-credit-extension-required.ts`
      - **Policy 44** (group **18** Credit Extension Ceiling) → `back_end/src/policies/18-credit-extension-ceiling/p44-credit-ceiling-proximity-check.ts`
      - **Policy 45 (Credit Ceiling Active Monitoring — charge posting gate)** → `back_end/src/policies/18-credit-extension-ceiling/p45-credit-ceiling-charge-posting-gate.ts`
      - **Policy 16** (group **06** Guest Identity) → `back_end/src/policies/06-guest-identity/p16-accepted-document-types.ts`
        - (S6→S7 check-in completion) `back_end/src/policies/06-guest-identity/p16-identity-verified-before-checkin-completion.ts`, `back_end/src/policies/06-guest-identity/p16-checkin-completion-ceremony-gates.ts`
      - **Policy 54** (group **21** Service Recovery / Dispute) → `back_end/src/policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts` (includes `enforceNoOpenDisputesForS9Closure`, `enforceDisputeGateClearForS8ToS9`)
      - **Policy 09** (group **03** Expiry / Parking) → `back_end/src/policies/03-expiry-parking/p09-s5-normal-exit-pre-arrival-tasks-terminal.ts`
      - **Policy 05** (group **02** Ownership / Custodian Assignment) → `back_end/src/policies/02-ownership-custodian-assignment/p05-h1-fulfilled-required-for-checkin.ts`
      - **Policy 25** (group **10** Speculative Hold) → `back_end/src/policies/10-speculative-hold/p25-speculative-hold-placement.ts`
      - **Policy 71** (group **31** Processing Lock) → `back_end/src/policies/31-processing-lock/p71-processing-lock-ttl.ts`
      - **Policy 72** (group **31** Processing Lock) → `back_end/src/policies/31-processing-lock/p72-processing-lock-priority-queue.ts`
      - **Policy 49** (group **19** DEFICIENT Condition) → `back_end/src/policies/19-deficient-condition/p49-deficient-carry-into-h2.ts`
      - **Policy 51** (group **19** DEFICIENT Condition) → `back_end/src/policies/19-deficient-condition/p51-deficient-inspection-review.ts`
      - **Policy 63** (group **25** Handoff) → `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts` (includes `enforceH2H3NotRejectedAtS6CheckIn` for S6 completion)
      - **Policy 26** (group **11** Committed Hold) → `back_end/src/policies/11-committed-hold/p26-committed-hold-inventory-availability.ts`
        - (S3→S1) `back_end/src/policies/11-committed-hold/p26-committed-hold-release-on-reentry-requires-fom.ts`
      - **Policy 34** (group **14** Cancellation) → `back_end/src/policies/14-cancellation/p34-cancellation-terms-disclosure-required.ts`
        - (S3 disclosure) `back_end/src/policies/14-cancellation/p34-no-show-treatment-statement-required.ts`
      - **Policy 33 (Billing Model)**:
        - `back_end/src/policies/13-billing-model/p33-billing-model-confirmation-match.ts`
        - `back_end/src/policies/13-billing-model/p33-billing-model-settlement-method-compatibility.ts`
      - **SIG-S9 §8.8 — Write-Off Policy** (named in the route table; not a `### Policy N —` line in §4’s numbered envelope; Cat 06’s S9 column also omits `13-Bill`, so there is no `P30–P33` token for this action on the stage matrix):
        - `back_end/src/policies/13-billing-model/write-off-policy-constraints.ts`
      - **Policy 56** (group **22** No-Show) → `back_end/src/policies/22-no-show/p56-no-show-determination-prereqs.ts`
        - (S5 sub-state) `back_end/src/policies/22-no-show/p56-awaiting-written-confirmation-blocks-s5-exit.ts`
      - **Policy 7** (group **08** Pricing / Rate Plan) → `back_end/src/policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.ts` (validity lapse + accepted quotation on segment; wired from `s3-reservation-setup-service.ts` S2→S3)
      - **Policy 12** (OPEN duplicate blocks S2→S3) → `back_end/src/policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s2-exit.ts` (alongside the inquiry-time P12 flag creator in the same group)
      - **Policy 25** (speculative hold must be active for S2→S3) → `back_end/src/policies/10-speculative-hold/p25-speculative-hold-active-for-s2-exit.ts`
      - **Policy 52** (quotation ack open loop cleared before S2→S3) → `back_end/src/policies/20-communication-acknowledgement-tracking/p52-quotation-ack-open-loop-resolved-for-s2-exit.ts`
      - **Policy 30** (billing model allowlist from config) → `back_end/src/policies/13-billing-model/p30-billing-model-allowlist-from-config.ts` (wired from `ensureProvisionalFolioAndBillingModel`)
      - **Policy 1** (S6 check-in completion: assignment + strict `AVAILABLE_*` readiness) → `back_end/src/policies/01-availability/p01-room-assignment-and-physical-ready-s6-checkin.ts` (`services/domain/check-in-service.ts`)
      - **Policy 5** (S6 completion H1 eligibility / walk-in) → `back_end/src/policies/02-ownership-custodian-assignment/p05-h1-eligible-for-s6-checkin-completion.ts`
      - **Policy 29** (advance reconciliation before check-in completion) → `back_end/src/policies/12-advance-payment/p29-advance-payment-reconciled-before-checkin-completion.ts`
      - **Policy 31** (folio `PROVISIONAL` before `convertToLive`) → `back_end/src/policies/13-billing-model/p31-folio-provisional-before-checkin-completion.ts`
        - (S3 committed hold) `back_end/src/policies/13-billing-model/p31-folio-required-before-committed-hold-s3.ts`
        - (S8 settlement must be on LIVE folio) `back_end/src/policies/13-billing-model/p31-folio-live-required-for-s8-settlement.ts`
      - **Policy 52** (VIP arrival notification persisted for VIP check-in completion) → `back_end/src/policies/20-communication-acknowledgement-tracking/p52-vip-arrival-notification-recorded-for-checkin.ts`
      - **SIG-S8 / `s8-checkout-service.ts` — S8→S9 progression guards**:
        - **Policy 1** (entry at S8 for `progressStageS8ToS9`) → `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - **Policy 33** (folio SETTLED or OUTSTANDING) → `back_end/src/policies/13-billing-model/p33-folio-state-allows-s8-to-s9-progression.ts`
        - **Policy 1** (room `DEPARTED_DIRTY` + key return row) → `back_end/src/policies/01-availability/p01-s8-to-s9-room-and-keys-gates.ts`
        - **Policy 51** (room inspection record present) → `back_end/src/policies/19-deficient-condition/p51-room-inspection-exists-for-s8-to-s9.ts`
        - **Policy 54** (dispute gate CLEAR for S8→S9) → `enforceDisputeGateClearForS8ToS9` in `back_end/src/policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`
        - **Policy 63** (H4 fulfilled/auto; H5 present at S8→S9; H5 not open at S9 closure) → `enforceH4FulfilledOrAutoBeforeS8Exit`, `enforceH5PresentForS8ToS9`, `enforceH5NotBlockingS9Closure` in `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts`
      - **`entry-service.ts` — stage progression guards**:
        - **Policy 1** (S5 / S6 re-entry / S7 stage placement for progression and re-entry) → `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
        - **Policy 16** (guest physically present S5→S6) → `back_end/src/policies/06-guest-identity/p16-guest-physically-present-s5-to-s6.ts`
        - **Policy 1** (room assignment S5→S6) → `back_end/src/policies/01-availability/p01-room-assignment-present-s5-to-s6.ts`
        - **Policy 31** (folio PROVISIONAL S5→S6) → `back_end/src/policies/13-billing-model/p31-folio-provisional-required-s5-to-s6.ts`
        - **Policy 51** (deficient records terminal status S7→S8) → `back_end/src/policies/19-deficient-condition/p51-deficient-final-status-before-s7-to-s8.ts`
        - **Policy 63** (H4 initiated or same-day path S7→S8; plus S8→S9 / S9 H5 surfaces above) → `enforceH4InitiatedBeforeS7ToS8UnlessSameDayDeparture` in `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts`
        - **Policy 1** (occupied assignment + checkout date S7→S8) → `back_end/src/policies/01-availability/p01-s7-exit-room-and-checkout-gates.ts`
        - **Policy 61** (night audit COMPLETE for last operating date before checkout) → `back_end/src/policies/24-night-audit/p61-night-audit-complete-before-s7-to-s8.ts`
      - **`s1-entry-service.ts` — S1→S2 (`progressS1ToS2`) and S2 auto-fulfil (`autoFulfilS2ToS3`)**:
        - **Policy 16** (guest profile, use type, guest count, stay dates, primary contact) → `back_end/src/policies/06-guest-identity/p16-s1-exit-entry-and-contact-gates.ts`
        - **Policy 12** (OPEN duplicate flags block S1 exit) → `back_end/src/policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s1-exit.ts`
        - **Policy 17** (CORPORATE/GOVERNMENT inquiry ref + coordinator) → `back_end/src/policies/07-guest-data-governance/p17-corporate-government-inquiry-context-s1-exit.ts`
        - **Policy 33** (apartment duration + rate tier for S1 exit) → `back_end/src/policies/13-billing-model/p33-apartment-commercial-fields-s1-exit.ts`
        - **Policy 1** (preferred availability config selected, not stale, deficient ack, room not maintenance/blocked) → `back_end/src/policies/01-availability/p01-s1-exit-preferred-configuration-and-room-eligibility.ts`
        - **Policy 67** (conference space allocation / capacity for S1 exit + shared attendee vs capacity helper) → `back_end/src/policies/27-work-order/p67-conference-s1-exit-space-gates.ts` (`enforceConferenceSpaceAttendeeCapacity` also used by `space-allocation-service.ts`)
        - **Policy 1** (entry must be at S1 for auto-fulfil) → `back_end/src/policies/01-availability/p01-entry-at-s1-for-auto-fulfil-s2-to-s3.ts`
      - **`s2-quotation-service.ts` — `createQuotation`**:
        - **Policy 1** (S2 stage; sealed preferred availability configuration; resolved roomTypeId) → `back_end/src/policies/01-availability/p01-s2-create-quotation-configuration-gates.ts`
      - **`s2-hold-service.ts` — `placeSpeculativeHold`**:
        - **Policy 25** (S2 stage for speculative hold placement) → `back_end/src/policies/10-speculative-hold/p25-s2-stage-for-speculative-hold-placement.ts`
      - **`s4-confirmation-service.ts` — `confirmReservation` (readiness slice)**:
        - **Policy 40** (S3 stage; accepted quotation; plus existing high-value authority) → `back_end/src/policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.ts` (stage + quotation) and `p40-confirmation-authority.ts`
        - **Policy 31** (provisional folio present) / **Policy 33** (billing model fixated; proforma invoice) / **Policy 26** (committed hold PLACED with room) → same `p40-s4-confirmation-readiness-gates.ts` module
      - **`room-assignment-service.ts` — `assignRoom`**:
        - **Policy 1** (S5/re-entry stage; immutability; hold; room type; arrival; physical assignability) → `back_end/src/policies/01-availability/p01-s5-room-assignment-eligibility-gates.ts`
      - **`s3-reservation-setup-service.ts`**:
        - **Policy 7** (accepted quotation on active segment for S2→S3) → `enforceAcceptedQuotationPresentForS2Exit` in `back_end/src/policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.ts` (with `enforceQuotationValidityNotLapsedForS2Exit`, duplicate flags, discount send, speculative hold, ack open loop)
        - **Policy 1** (S3 stage for `ensureProvisionalFolioAndBillingModel`) → `back_end/src/policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts`
      - **`s3-hold-service.ts` — `placeCommittedHold`**:
        - **Policy 1** (S3 stage) → `back_end/src/policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts`
        - **Policy 31** (folio required before committed hold) → `back_end/src/policies/13-billing-model/p31-folio-required-before-committed-hold-s3.ts`
      - **`s3-reentry-service.ts`** — `initiateS3ToS2Backflow` / `initiateS3ToS1Backflow`:
        - **Policy 1** (S3 stage) → `back_end/src/policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts` (with **Policy 1** re-entry actor authority in `p01-reentry-authority.ts`)
      - **`s3-use-type-service.ts`** — `approveFocGm` / `confirmCoordinator` / `schedulePaymentMilestones`:
        - **Policy 1** (S3 stage) → `back_end/src/policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.ts`
      - **`space-allocation-service.ts` — `allocateConferenceSpace`**:
        - **Policy 1** (S1 stage) → `back_end/src/policies/01-availability/p01-entry-at-s1-for-conference-space-allocation.ts`
        - **Policy 67** (attendee vs space capacity) → `enforceConferenceSpaceAttendeeCapacity` in `back_end/src/policies/27-work-order/p67-conference-s1-exit-space-gates.ts`
      - **`check-in-service.ts` — `completeCheckInToS7`**:
        - **Policy 1** (S6 stage) → `enforceEntryAtS6ForCheckInCompletionToS7` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
      - **`cancellation-service.ts` — `cancelEntryAtS5` (stub)**:
        - **Policy 1** (S5 stage for this route) → `enforceEntryAtS5ForS5CancellationRoute` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
      - **`no-show-service.ts` — `determineNoShow` (entry stage + duplicate determination)**:
        - **Policy 1** (S5 stage) → `enforceEntryAtS5ForNoShowActions` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
        - **Policy 56** (single determination slot) → `enforceNoShowDeterminationNotAlreadyRecorded` in `back_end/src/policies/22-no-show/p56-no-show-determination-prereqs.ts`
      - **`handoff-service.ts` — `createH4` / `createH2` (entry context)**:
        - **Policy 1** (S7 + ACTIVE for H4; S6 + ACTIVE for H2) → `enforceEntryAtS7ForH4Initiation`, `enforceEntryActiveForH4Initiation`, `enforceEntryAtS6AndActiveForCreateH2` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
      - **`s8-settlement-service.ts` — `initiateSettlement`**:
        - **Policy 1** (S8 stage) → `enforceEntryAtS8ForSettlementOperations` in `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - **Policy 31** (folio LIVE) → `back_end/src/policies/13-billing-model/p31-folio-live-required-for-s8-settlement.ts`
      - **`db.ts` — Prisma client `$extends` query layer**:
        - Immutability / transition guards → `back_end/src/policies/01-availability/p01-prisma-extension-blocking-guards.ts` (reservation, OTA overbooking trigger, folio create/update, folioLine, VIP notification, night audit, dispute override, room assignment, room claim path)
      - **SIG-S9 / `s9-service.ts` — entry closure + post-stay charge**:
        - **Policy 1** (S9 stage for `closeEntryAtS9`) → `back_end/src/policies/01-availability/p01-entry-at-s9-for-closure.ts`
        - **Policy 54** (no open disputes for S9 closure) → `enforceNoOpenDisputesForS9Closure` in `back_end/src/policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`
        - **Policy 33** (invoice dispatch; GOVERNMENT / DIRECT_BILL payment paths; OUTSTANDING + W8/write-off; apartment deposit; post-stay charge window + stage) → `back_end/src/policies/13-billing-model/p33-s9-closure-invoice-payment-and-poststay-gates.ts`
        - **Policy 51** (inspection resolution for closure) → `back_end/src/policies/19-deficient-condition/p51-s9-closure-inspection-resolution.ts`
        - **Policy 1** (equipment return evidence for closure) → `back_end/src/policies/01-availability/p01-equipment-return-resolved-for-s9-closure.ts`
        - **Policy 56** (no-show determination row when folio is NO_SHOW_CLOSED) → `back_end/src/policies/22-no-show/p56-no-show-determination-required-for-s9-closure.ts`
        - **Policy 63** (H5 not blocking S9 closure) → `enforceH5NotBlockingS9Closure` in `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts`
  - Services were updated to call these policy functions.
  - **Cat 06 “done” criteria (Atlas vs this repo)**: The Structural Atlas lists **77** numbered policies in Cat 06, but the backend slice does **not** implement every Atlas policy name-by-name, and some Atlas rows are placeholders or aggregate several runtime checks. Treat “all policies extracted” as **complete** only when: (1) every **409-style gate** (`PolicyGateBlockedError` / `StageGateBlockedError`) that remains in `services/`, `routes/`, and **`db.ts` extension hooks** is either implemented via **`src/policies/**`** with stable `blockingCondition` codes or explicitly documented as out-of-scope for this slice; and (2) a maintained mapping ties each **implemented** Atlas policy number to a module (or marks it **not implemented**). **Workers (33) and engines (12)** are separate catalogues—counts will not match Atlas until a dedicated alignment pass is done.
  - **Approximate extraction progress (policy numbers only)**: Atlas Cat 06 lists **77** policies; this codebase has extracted at least one enforcement surface for **37** distinct numbered policies ≈ **48%** by that count, with ≈ **52%** of the numbered catalogue not yet represented as standalone modules. **`services/domain` and `services/application` do not construct `StageGateBlockedError` / `PolicyGateBlockedError` directly**; Prisma extension gates in **`db.ts`** now delegate to **`policies/01-availability/p01-prisma-extension-blocking-guards.ts`**. Remaining `StateTransitionError` / `ValidationError` checks (e.g. handoff state machines, route glue) can be promoted incrementally.
  - **Envelope note**: several S2→S3 / S3 folio gates that previously threw `StageGateBlockedError` now throw `PolicyGateBlockedError` with the same `blockingCondition` codes (still HTTP 409); only the `error` string in the JSON body changes.

**What’s still missing**
- The majority of the 77 policies are still **embedded in services**, not yet extracted into `src/policies/**` (we’ve extracted 37 unique policy numbers so far: 1, 3, 5, 7, 9, 12, 13, 16, 17, 23, 25, 26, 27, 28, 29, 30, 31, 33, 34, 38, 39, 40, 41, 42, 44, 45, 48, 49, 51, 52, 54, 56, 61, 63, 67, 71, 72, plus SIG-S9 §8.8 Write-Off Policy without a Cat 06 P-token).
- Next step is to systematically extract remaining policy blocks from services into the correct group folders, guided by the SIG files in `docs/` (e.g. `docs/SIG-S1-v1_2.md`, `docs/SIG-S2-v1_3.md`, …).

### Cat 07 — Services (31 across Domain/Application/Infrastructure)
- **Atlas expects** 31 services with tiering.
- **Code has** many services, but historically stage-sliced naming (e.g. `s1-*`, `s7-*`).
- **What we did**: moved all existing service modules into the correct tier folders under `back_end/src/services/`.
- **Current alignment (high level)**:
  - **Present (mapped by intent, not by name)**:
    - `InquiryService` → `services/domain/s1-inquiry-service.ts`
    - `EntryService` → `services/domain/entry-service.ts` (+ `services/domain/s1-entry-service.ts` for S1-specific entry ops)
    - `FolioService` → `services/domain/folio-service.ts` (+ `services/domain/s7-folio-lines-service.ts` and `services/domain/s8-settlement-service.ts` for sub-flows)
    - `AvailabilityService` → `services/domain/s1-availability-service.ts`
    - `QuotationService` → `services/domain/s2-quotation-service.ts`
    - `HoldService` → `services/domain/s2-hold-service.ts` and `services/domain/s3-hold-service.ts` (stage-sliced today)
    - `PreArrivalService` → `services/domain/pre-arrival-service.ts`
    - `RoomAssignmentService` → `services/domain/room-assignment-service.ts`
    - `CheckInService` → `services/domain/check-in-service.ts`
    - `CheckOutService` (partial) → `services/domain/s8-checkout-service.ts`
    - `PaymentService` (partial) → `services/domain/s3-payment-service.ts`
    - `ProcessingLockService` → `services/domain/s1-processing-lock-service.ts`
    - `SpaceAllocationService` → `services/domain/space-allocation-service.ts`
    - `HandoffService` → `services/domain/handoff-service.ts`
    - `DisputeService` → `services/domain/s7-dispute-service.ts`
    - `WorkOrderService` → `services/domain/s7-work-order-service.ts`
    - `GuestProfileService` → `services/domain/guest-profile-service.ts`
  - **Application tier present**:
    - `AmendmentService` → `services/application/s7-amendment-service.ts`
    - `CancellationService` → `services/application/cancellation-service.ts`
    - `NoShowService` → `services/application/no-show-service.ts`
    - `NightAuditService` → `services/application/s7-night-audit-service.ts`
  - **Infrastructure tier present (partial)**:
    - `TimerManagementService` → `services/infrastructure/timer-management-service.ts`
    - `SessionService` → `services/infrastructure/session-service.ts`
    - `NotificationService`/`CommunicationService`/`AuditService` are not yet implemented as dedicated services.
  - **Missing vs Atlas (not implemented yet; recorded only)**:
    - `ReservationService` as a single consolidated domain service (today it’s split across `s3-reservation-setup-service.ts`, `s4-confirmation-service.ts`, plus entry progression in `entry-service.ts`)
    - `IncidentService`
    - `VoiceNoteRoutingService`
    - `DuplicateDetectionService` (some behavior exists via flags, but no dedicated service module)
    - `AIAgentApprovalService`
    - `CommunicationService`, `NotificationService`, `AuditService`

- **Note**: canonical Atlas service naming (the exact 31 named modules) is still not fully aligned; we kept refactor conservative to avoid behavioral change. Next service pass would consolidate/rename stage-sliced modules into Atlas-named service surfaces once policy and state-machine extraction reduces coupling.

### Cat 08 — Workers (33)
- **Atlas expects** 33 workers.
- **Code has** more (we’ve seen workers up to at least `w35-*`).
- **Action**: mismatch recorded only; we did not delete or add workers.

### Cat 10 — Routes (20 route groups)
- **Atlas expects** 20 route groups, each a thin controller layer.
- **Code started as** a single consolidated router file (`back_end/src/routes/s5-routes.ts`).
- **What we did**:
  - Introduced a composed router (`back_end/src/routes/api-router.ts`)
  - Fully split out the legacy monolith into route-group modules.
  - **Why we briefly exceeded 20 groups**: during extraction we created a few “mechanical split” folders (e.g. `s3-ops/`, `invoices/`, `pre-arrival/`, `room-assignments/`, `space-allocation/`) to keep the refactor incremental and `tsc`-green. Those were not meant to be permanent Atlas groups.
  - **Atlas alignment fix**: we then merged these back into the Atlas-defined route groups based on the Cat 10 “Principal Service” rule:
    - `s3-ops/*` redistributed into `reservations/`, `folios/`, and `cancellations/` (same URLs preserved)
    - `invoices/*` merged into `folios/`
    - `pre-arrival/*`, `room-assignments/*`, `space-allocation/*` merged into `reservations/`
  - Remaining non-Atlas surface: `admin/` is a dev/test helper namespace (kept isolated under `/admin/*`).

### Cat 11 — Middleware (5 stages)
- **Atlas expects** 5 middleware stages (Auth, Validation, Concurrent Editing, Rate Limiting, CORS).
- **Code currently has** only `back_end/src/middleware/auth.ts` (header-based actor context).
- **Action**: recorded as missing; not implemented in this refactor.

### Cat 13 — DTOs (20 domain groups)
- **Atlas expects** 20 DTO groups and DTO-bound validation middleware.
- **Why there are “no DTOs” in this codebase**
  - The current API layer (`s5-routes.ts`) reads directly from `req.body` and performs only ad-hoc checks in a few routes.
  - There is no DTO directory, no DTO types, and no validation middleware binding requests to DTO schemas.
  - This repo slice is closer to an “acceptance-testable vertical slice” than a fully layered Atlas implementation.
- **What we did**: created `back_end/src/dtos/` as the target location. No DTOs were invented/added (per your instruction).

### Cat 14 — Error taxonomy (11 classes)
- **Atlas expects** 11 typed error classes.
- **Code currently uses** a single module: `back_end/src/lib/errors.ts`.

**Your request**
> “If that will churn then keep using lib/src and delete errors for now.”

**Recommendation**
- Keeping `back_end/src/lib/errors.ts` as the single source is the safest path right now because:
  - it is widely imported,
  - the error envelope shape is already relied upon by routes and tests.
- The `back_end/src/errors/` folder is currently only a structural placeholder. It can be removed safely *once we confirm nothing imports from it*.

## Cats 15–22 (cross-cutting) status
- **Cat 15 Auth & Session**: partially present (`services/infrastructure/session-service.ts`, `middleware/auth.ts`), but not Atlas-complete.
- **Cat 16 Audit & Trace**: present implicitly via `traceEvent` writes; no dedicated `AuditService` module yet.
- **Cat 17 Transactions**: present implicitly via `$transaction`.
- **Cat 18 Integrations**: missing interface abstraction modules.
- **Cat 19 Bootstrap readiness gate**: missing (server starts without readiness validation).
- **Cat 20 Config surfaces**: partially present (`lib/config-store.ts` + dotted keys).
- **Cat 21 Reports**: missing report modules.
- **Cat 22 Forbidden patterns**: treated as refactor constraints (no new violations introduced).

## Notes about Cat 01 / 02 / 04 “not needed”
- **Cat 01 (domain entity map)**: conceptual catalogue; no direct `src/` folder needed.
- **Cat 02 (schema)**: lives under `back_end/prisma/` already; not a `src/` refactor target.
- **Cat 04 (vocabulary)**: mostly represented by Prisma enums/TS types; no dedicated module was created in this refactor.

