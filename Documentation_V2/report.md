# Backend Structural Atlas v1.1 — Refactor Report

Generated: 2026-05-08

## Current focus (step-by-step backlog)

_Last touched: 2026-05-11_

- **Done (SIG-S1 P19 indicative at S1):** **`policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s1-indicative.ts`** — reads **`pricing.ratePlans`** (optional); **`resolveIndicativePricing`** attaches **`pricingIndicative`** on each **`availableRooms`** row + **`indicativePricing`** on the API **`results`** object; persisted **`resultSet`** matches; **`lineTotalIndicative`** = nightly × stay nights; **`INDICATIVE_ONLY_NO_QUOTATION`** disclaimer. Skips when config missing (no hard fail on availability).
- **Done (SIG-S1 space allocation at query):** **`p67-space-turnaround-buffer.ts`** + **`createQuotedSpaceAllocationForAvailabilityQuery`** / **`releaseAvailabilityQueryQuotedAllocations`** (`space-allocation-service.ts`); **`queryAvailability`** + **`recallConfiguration`** create **`SpaceAllocation` (QUOTED)** in the **same transaction** as **`AvailabilityConfiguration`** when **`spaceId`** is sent and effective use type is **CONFERENCE** or **CATERING**; **`eventBlock.source`** = **`AVAILABILITY_QUERY`** (manual **`allocateConferenceSpace`** rows untouched); config **`availability.conferenceSpace.turnaroundBufferMinutes`** (seed **120**). Optional body **`seatingConfig`** (default **`STANDARD`**).
- **Done (SIG-S1 inquiry/entry list):** **`listInquiries`** / **`getInquiryById`** (`s1-inquiry-service.ts`); **`listEntries`** (`s1-entry-service.ts`); **`GET /api/inquiries`**, **`GET /api/inquiries/:id`**, **`GET /api/entries`** — query validation via **`listInquiriesQuerySchema`** / **`listEntriesQuerySchema`**; list responses **`{ items, count }`**.
- **Done (SIG-S1 availability read/recall):** **`getConfiguration`** + **`recallConfiguration`** in `s1-availability-service.ts`; **`GET /api/availability/configurations/:id`**, **`POST /api/availability/configurations/:id/recall`** (stale-only; persists fresh **`resultSet`**, clears selection, **`isRevalidationRequired: true`** on result; trace **`AVAILABILITY_CONFIGURATION_RECALLED`**).
- **Done (SIG-S1 policies / routes):** **P1** `p01-availability-query-params-s1.ts`; **P4** `p04-custodian-reassignment.ts` + `POST /api/inquiries/:id/assign-custodian` + `POST /api/entries/:id/reassign-custodian`; **P12** `p12-inquiry-duplicate-at-creation.ts` (overlap gate when proposed stay sent); **P64** `p64-group-detection-at-entry-creation.ts` + seed threshold; **`ENTRY_EXPIRY`** on `createEntry`; `PolicyGateBlockedError` optional **`details`**.
- **Done:** Policy **19** — S2 rate plan load + `PricingPipelineEngine` selection moved to `policies/08-pricing-rate-plan/p19-rate-plan-resolution-for-s2-quotation.ts`; `s2-quotation-service.createQuotation` delegates there (no duplicate config path).
- **Done:** Policy **35** (SIG-S5 pre-arrival cancel at S5) — `p35-cancellation-penalty-from-commitment.ts` + `cancellation-service.cancelEntryAtS5` (folio line, refund OUT, trace, hold/room release, timers, `CANCELLED`/`TERMINAL`). **Waiver:** `p35-penalty-waiver-requires-gm-authority.ts`; `POST /entries/:id/cancel` + `cancelS5EntryRequestSchema` — `{ "penaltyWaiverRequested": true }` requires **L3/L4** and forces **penalty 0** (trace records `cappedPenalty` vs applied penalty); trace `actorLevel` follows session.
- **Done:** Shared **advance IN sum** + **penalty cap** — `sumAdvancePaymentInTotalForFolio` and `capCancellationPenaltyAtAdvancePayment` live in `p35-cancellation-penalty-from-commitment.ts`; used by `cancellation-service` and `no-show-service` (Policy 57 SUB_PATH_1).
- **Done:** Folio **`outstandingBalance` ledger** — **`recomputeFolioOutstandingBalance`** in `lib/folio-outstanding-from-payment.ts`: `max(0, lines − IN + OUT − write_offs)`; **invoices excluded** from the formula (document/AR only; JSDoc). **`applyInboundPaymentToFolioOutstanding`** delegates to it (third arg ignored). Runs after **`POST /folios/:id/payments`**, **S8 `initiateSettlement`** (payments → **recompute** → invoices with metadata from **ledger at issuance** → folio state), **S7 `postCharge`**, **night-audit** room charge lines, **`writeOffOutstandingBalance`**, and after **OUT** in **cancellation**, **no-show** refund, and **S9** no-show refund.
- **Done:** SIG-S1 v1.2 **strict cross-check** — full inventory in **§ SIG-S1 v1.2 — strict cross-check** below (policies, engines, services, workers, routes, re-entry, AC spot-notes + prioritized backlog).
- **Next:** (Open only if product expands) e.g. invoice PDF totals sourced from lines vs stored invoice line items; post-stay charges and credit notes vs recompute.

---

## SIG-S1 v1.2 — strict cross-check (2026-05-11)

Source: `docs/SIG-S1-v1_2.md`. For each Atlas slice: **OK** = matches SIG intent; **PARTIAL** = behaviour exists with gaps; **MISSING** = not implemented; **REFACTOR** = logic exists but wrong layer / wrong name vs SIG (extract or rename without changing product intent).

### Cat 06 — Policies (SIG §4 + §6 invocations)

| SIG policy | Repo status | Notes |
|------------|-------------|--------|
| **P1** Availability Query | **PARTIAL** | **`policies/01-availability/p01-availability-query-params-s1.ts`** validates query shape; `s1-availability-service` + engine execute search. |
| **P2** DEFICIENT surface | **PARTIAL** | Engine buckets + `selectOption` ack gate; S1→S2 exit: `p01-s1-exit-preferred-configuration-and-room-eligibility.js`. No dedicated “annotation only” policy module. |
| **P3** Initial custodian | **PARTIAL** | `policies/02-ownership-custodian-assignment/p03-initial-custodian-assignment.ts` + `s1-inquiry-service.createInquiry`. SIG **ESCALATE(FOM)** with **unset** custodian until FOM assigns is **not** modelled — code throws `MissingConfigurationError` if no rule (no partial inquiry). |
| **P4** Custodian reassignment | **PARTIAL** | **`policies/02-ownership-custodian-assignment/p04-custodian-reassignment.ts`** + `assignInquiryCustodian` + `reassignCustodianByEntryId` + routes **`POST /api/inquiries/:id/assign-custodian`**, **`POST /api/entries/:id/reassign-custodian`**. Conference/catering or **guestCount ≥ 50** requires **L2+**. |
| **P6** Inquiry expiry | **PARTIAL** | W20 + `w20-entry-expiry-worker.ts` expires entry; SIG names `EntryService.expireEntry()` — logic lives in worker, not a domain method. |
| **P12** Duplicate gate | **PARTIAL** | **`policies/04-duplicate-detection/p12-inquiry-duplicate-at-creation.ts`** — `assertNoConfirmedDuplicateInquiryForCreation` runs **before** `Inquiry.create` when **`proposedCheckIn` + `proposedCheckOut`** are supplied (stay overlap vs other inquiries’ active entries). Optional **`duplicateCheck`** still records an open flag **after** create when the server gate is **APPROVED** (tests / operator-marked path). **Gap:** no fuzzy / OTA-reference / ambiguous-FOM tier yet. |
| **P15** Guest identity capture | **PARTIAL** | S1 exit gates in `policies/06-guest-identity/p16-s1-exit-entry-and-contact-gates.js`; entry `createEntry` does not invoke a named Policy 15 module for OTA/source alignment at creation. |
| **P19** Rate plan (S1 indicative) | **PARTIAL** | **`p19-rate-plan-resolution-for-s1-indicative.ts`** + `runAvailabilityEngineForEntry` in `s1-availability-service.ts` — same **`PricingPipelineEngine.resolveIndicativePricing`** rules as S2; **no quotation** rows. **Gap:** not wired to **`ProcessingLockService.reconfirm`** in this pass; no per-**roomType** rate selection yet. |
| **P64** Group detection | **PARTIAL** | **`policies/12-multi-booking/p64-group-detection-at-entry-creation.ts`** + seed **`groupDetection.guestCountThreshold`** — sets **`groupBillingMode: GROUP_MASTER`** on `createEntry` when guest count ≥ threshold. |
| **P69** Session / PIN | **PARTIAL** | `session-service.ts` + `routes/session-and-authentication/router.js` under `/auth/*`; trace/session event completeness vs SIG not fully audited in this pass. |
| **P71 / P72** Processing lock TTL / priority | **OK** | `policies/31-processing-lock/p71-*.ts`, `p72-processing-lock-priority-queue.ts` + `s1-processing-lock-service.ts`. |
| **P67** (space allocation) | **PARTIAL** | **`p67-space-turnaround-buffer.ts`** + **`space-allocation-service`** — **`queryAvailability`** / **`recallConfiguration`** path: **QUOTED** allocation + turnaround vs other **QUOTED/HELD/CONFIRMED** rows when **`spaceId`** + **CONFERENCE/CATERING**; manual **`POST …/spaces/allocate`** unchanged. **Gap:** engine does not yet drive **spaceId** selection (client supplies id); **CATERING** not enforced at S1 exit like **CONFERENCE** in **P67** exit gate. |
| **P73–P75** AI trust (W7) | **MISSING** | No policy modules; W7 worker is NOOP. |

### Cat 05 — Engines (SIG §5)

| Engine | Repo status | Notes |
|--------|-------------|--------|
| **AvailabilityEngine** | **OK** | `engines/availability-engine.ts` — pure function, DB injected by service (matches SIG). |
| **PricingPipelineEngine** | **PARTIAL** | **`resolveIndicativePricing`** invoked from **`p19-rate-plan-resolution-for-s1-indicative`** on **`queryAvailability`** / **`recallConfiguration`** (via shared **`runAvailabilityEngineForEntry`**); still **not** duplicated into lock **reconfirm** here. |
| **ReEntryConsequenceEngine** | **PARTIAL** | `engines/re-entry-consequence-engine.ts` used in `s3-reentry-service`; S3→S1 also calls `s3HoldService` + inline `supersedePendingInvoices`. |

### Cat 07 — Services (SIG §6)

| SIG surface | Repo status | Notes |
|-------------|-------------|--------|
| **InquiryService** | **PARTIAL** | `s1-inquiry-service.ts`: create (with **P12** + **P3**), **`listInquiries`**, **`getInquiryById`** (entries summary, guest profile snippet, **open** duplicate flags), park/unpark, corporate context, duplicate resolution, **`assignInquiryCustodian`**. |
| **EntryService** (S1) | **PARTIAL** | `s1-entry-service.ts`: **`listEntries`**, create (**P64**, **ENTRY_EXPIRY** registered on create), park/unpark, **`reassignCustodianByEntryId`**, `progressS1ToS2`, `autoFulfilS2ToS3`. Missing: `expireEntry` facade (worker still owns expiry side-effects). |
| **AvailabilityService** | **PARTIAL** | `s1-availability-service.ts`: **P1** + **P19 indicative** + **`queryAvailability`** (optional **same-tx** space allocation when **`spaceId`** + conference/catering) + **`getConfiguration`** + **`recallConfiguration`** + **`selectOption`**. |
| **ProcessingLockService** | **PARTIAL** | `s1-processing-lock-service.ts`: place, reconfirm, status. Missing: `expireLock()` — expiry only in W16 worker. |
| **SpaceAllocationService** | **PARTIAL** | **`allocateConferenceSpace`** (by code) + **`createQuotedSpaceAllocationForAvailabilityQuery`** (availability search path, **`eventBlock.source: AVAILABILITY_QUERY`**). |
| **DuplicateDetectionService** | **PARTIAL** | Policy **P12** split: **`p12-inquiry-duplicate-at-creation.ts`** (gate) + **`p12-duplicate-flag-create-on-inquiry.ts`** (flag record) + exit gate module; not a separate named service class. |
| **SessionService / TimerManagement** | **PARTIAL** | Session + `getTimerEngine` / `timer-management-service` used; SIG “no pg-boss from services” is approximated via timer engine abstraction. |
| **NotificationService** | **MISSING** | W16 does not dispatch operator notification after commit (SIG §6.6). |
| **AuditService** | **MISSING** | Services write `traceEvent` directly — SIG requires canonical `AuditService.emit` / `emitAsync`. |

### Cat 08 — Workers (SIG §7)

| Worker | Repo status | Notes |
|--------|-------------|--------|
| **W1** StageDwellMonitor | **PARTIAL** | `w1-stage-dwell-monitor.ts` + registered in `workers/runner.ts`; implements dwell phases + availability staleness marking. FOM escalation notification path not verified vs SIG NotificationService. |
| **W16** ProcessingLockExpiry | **PARTIAL** | Implements EXPIRED + trace; **no** `NotificationService.dispatchOperatorExpiry`. |
| **W20** EntryExpiry | **PARTIAL** | Worker implements expiry; **`ENTRY_EXPIRY`** job registered on **`createEntry`** and **unpark**. Missing: `expireEntry` domain facade. |
| **W7** OTA email parser | **STUB** | `w7-ota-email-parser-worker.ts` — NOOP trace only; registered but not SIG-compliant ingestion. |

### Cat 10 / 12 / 13 — Routes, validation, DTOs (SIG §8)

| SIG route | Repo path | Status |
|-----------|-----------|--------|
| `POST /auth/*` | `routes/session-and-authentication/router.ts` → `/auth` | **OK** (names: `/logout` vs SIG `/auth/logout` — same mount). |
| `POST /inquiries` | `routes/inquiries/router.ts` | **OK** — body may include **`proposedCheckIn` / `proposedCheckOut`** to activate **P12** overlap gate. |
| `GET /inquiries`, `GET /inquiries/:id` | `inquiries/router.ts` | **OK** — list supports **`limit`**, optional **`guestProfileId`**; detail includes **open** duplicate flags. |
| `POST /inquiries/:id/assign-custodian` | `inquiries/router.ts` | **OK** |
| `POST /inquiries/:id/park`, `…/unpark` | `inquiries/router.ts` | **OK** |
| `POST /entries` | `routes/entries/router.ts` | **OK** |
| `GET /entries` (list) | `routes/entries/router.ts` | **OK** — **`limit`**, optional **`inquiryId`**, **`status`**, **`currentStage`**. |
| `GET /entries/:id` | `routes/reservations/router.ts` `GET /entries/:id` (mounted at root of `apiRouter`) | **PARTIAL** — lives under **reservations** module, not `entries` router; response shape may not match SIG `EntryDetailResponseDTO`. |
| `POST /entries/:id/progress-stage` | `routes/reservations/router.ts` | **PARTIAL** — mounted on `apiRouter` root (not `entries` router file). S1→S2 here; S2→S3 via `progressS2ToS3` when `targetStage === "S3"`. **S1→S3 auto-fulfil** is a **different** route on the same app: `POST /entries/:id/s2/auto-fulfil-to-s3` (`quotations-and-holds/router.ts`, no path prefix) → `s1EntryService.autoFulfilS2ToS3` (SIG documents this as `progress-stage` with `targetStage: S3` — **URL / flow divergence**). |
| `POST /entries/:id/reassign-custodian` | `routes/entries/router.ts` | **OK** |
| `POST /availability/search` | `routes/availability/router.ts` | **OK** (optional **`spaceAllocation`**; **`results.indicativePricing`** when **`pricing.ratePlans`** seeded). |
| `POST …/entries/:id/availability/query` | same | **OK** — **`spaceId`**, **`seatingConfig`**; **`spaceAllocation`**; **`result.indicativePricing`**. |
| `GET /availability/configurations/:id` | `routes/availability/router.ts` | **OK** |
| `POST /availability/configurations/:id/recall` | `routes/availability/router.ts` | **OK** — **stale-only**; envelope as search + optional **`spaceAllocation`** when **`searchCriteria.spaceId`** and conference/catering. |
| `PATCH /availability/configurations/:id/select` | `availability/router.ts` | **OK** |
| `POST /processing-locks` | `routes/processing-locks/router.ts` | **OK** |

**HTTP prefix:** Runtime mounts `apiRouter` at **`/api`** (`index.ts`), so e.g. `POST /api/inquiries`, `POST /api/availability/search`.

### S3→S1 re-entry (SIG §1.3, §6.2, AC-S1-029–036)

| Item | Status | Notes |
|------|--------|--------|
| `initiateS3ToS1Backflow` | **PARTIAL** | `s3-reentry-service.ts` — segment seal, new segment, hold release, invoice supersede, W22/W34 cancel, trace. |
| Invoice states | **PARTIAL** | Schema has `InvoiceState.DRAFT` (no `PROVISIONAL`); supersede targets **PROFORMA** + DRAFT/DISPATCHED — map to SIG semantics in docs. |
| `HOLD.RELEASED_ON_REENTRY` + reason | **OK** | `s3-hold-service.ts` uses `REENTRY_S3_TO_S1` / event type per implementation. |
| `FolioService.supersedePendingInvoices` | **REFACTOR** | Logic inlined in `s3-reentry-service` — consider extracting to `folio-service` for SIG naming. |
| Single folio / payment visibility (AC-S1-035/036) | **Not verified** | Requires targeted integration tests. |

### Acceptance criteria (SIG §10) — spot summary

- **Schema / immutability (AC-S1-002–005, 024–026):** rely on `db.ts` Prisma extensions + separate folio/hold routes — **not re-verified** in this pass.
- **AC-S1-006, 007, 020:** **P12** server overlap gate when proposed stay is sent; **007** unchanged (custodian still all-or-nothing at create). **020** — `PolicyGateBlockedError` may include **`details`** (`conflictingInquiryId`, …) via `lib/errors.ts` extension.  
- **AC-S1-008–010, 027–028:** largely covered by engine + `progressS1ToS2` policy imports — **retest** after duplicate fix.  
- **AC-S1-011–014:** engine unit tests — **existence not confirmed** in this pass.  
- **AC-S1-015–018:** **`ENTRY_EXPIRY`** now registered on **`createEntry`** (and still on **unpark**).  
- **AC-S1-021:** `placeLock` returns `meta.priorityNotice` — **verify** response DTO matches SIG.  
- **AC-S1-023:** `getActiveConfigEntry` / `requireActiveConfigValue` in `lib/config-store.ts` use **effectiveFrom / effectiveTo** window — **OK** vs SIG.  

### Recommended next actions (S1 backlog)

1. **Policy 12:** Extend fuzzy / OTA / ambiguous-FOM paths per SIG; optional gate without proposed dates if product requires.  
2. **Routes:** ~~SIG §8.2 inquiry list + get + **`GET /entries`** list~~ **Done** (2026-05-11); optional: alias **`GET /entries/:id`** on `entries` router to match SIG file layout (detail today on **`reservations`**).  
3. ~~**ENTRY_EXPIRY:** Register timer in `createEntry`~~ **Done** (2026-05-11).  
4. ~~**Policy 4 + assign-custodian**~~ **Done** (2026-05-11); ~~inquiry **list/get**~~ **Done** (2026-05-11).  
5. ~~**Policy 64** at entry create~~ **Done** (2026-05-11).  
6. ~~**Availability recall + getConfiguration** service + routes~~ **Done** (2026-05-11).  
7. ~~**Space allocation** from `queryAvailability` for CONFERENCE/CATERING~~ **Partial done** (2026-05-11) — **same transaction** when **`spaceId`** supplied; engine-driven space pick + **CATERING** S1 exit parity still open.  
8. ~~**Pricing indicative** at S1~~ **Done** (2026-05-11) — optional chip from **`pricing.ratePlans`**; **reconfirm** / per-room-type pricing still open.  
9. **W7 / P73–P75** or explicitly mark out of scope.  
10. **NotificationService** after W16 expiry (post-commit).  
11. **AuditService** extraction (large Cat 16 refactor) — schedule after S1 functional gaps.

---

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
  - **Route-layer errors**: group routers under `back_end/src/routes/**` use typed **`ValidationError`**, **`NotFoundError`**, and **`AuthorizationError`** from `back_end/src/lib/errors.ts` for input / 404 / authority failures instead of constructing ad-hoc **`AppError`** instances (the Express error handler in `back_end/src/index.ts` still treats all **`AppError`** subclasses uniformly).
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
        - (S5 / S6 / S7 / S5 no-show / H4 / createH2 / CLOSED blocks progress-route / S2→S3 / S7 room-change re-entry + S5 cancellation stub) `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
        - (S4 confirmation entry version `OPTIMISTIC_LOCK`) `back_end/src/policies/01-availability/p01-entry-version-optimistic-lock-match.ts`
        - (S1 park / unpark / S1→S2 EXPIRED + status + stage) `back_end/src/policies/01-availability/p01-s1-entry-status-and-stage-gates.ts`
        - (S8→S9 progression + S8 settlement + S8 checkout ops NOT_AT_S8) `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - (S8 checkout completion — room OCCUPIED) `back_end/src/policies/01-availability/p01-s8-checkout-room-occupied-gate.ts`
        - (S9 closure entry stage + already-CLOSED guard) `back_end/src/policies/01-availability/p01-entry-at-s9-for-closure.ts`
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
        - (pre-arrival task update — PENDING only) same module (`enforcePreArrivalTaskPendingForUpdate`)
      - **Policy 05** (group **02** Ownership / Custodian Assignment) → `back_end/src/policies/02-ownership-custodian-assignment/p05-h1-fulfilled-required-for-checkin.ts`
      - **Policy 25** (group **10** Speculative Hold) → `back_end/src/policies/10-speculative-hold/p25-speculative-hold-placement.ts`
      - **Policy 71** (group **31** Processing Lock) → `back_end/src/policies/31-processing-lock/p71-processing-lock-ttl.ts`
        - (reconfirm requires EXPIRED lock) `back_end/src/policies/31-processing-lock/p71-processing-lock-expired-for-reconfirm.ts`
      - **Policy 72** (group **31** Processing Lock) → `back_end/src/policies/31-processing-lock/p72-processing-lock-priority-queue.ts`
      - **Policy 49** (group **19** DEFICIENT Condition) → `back_end/src/policies/19-deficient-condition/p49-deficient-carry-into-h2.ts`
      - **Policy 51** (group **19** DEFICIENT Condition) → `back_end/src/policies/19-deficient-condition/p51-deficient-inspection-review.ts`
      - **Policy 63** (group **25** Handoff) → `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts` (includes `enforceH2H3NotRejectedAtS6CheckIn` for S6 completion)
        - (accept / fulfil / reject / H4 config `StateTransitionError` guards) `back_end/src/policies/25-handoff/p63-handoff-service-state-guards.ts`
      - **Policy 26** (group **11** Committed Hold) → `back_end/src/policies/11-committed-hold/p26-committed-hold-inventory-availability.ts`
        - (S3→S1) `back_end/src/policies/11-committed-hold/p26-committed-hold-release-on-reentry-requires-fom.ts`
      - **Policy 34** (group **14** Cancellation) → `back_end/src/policies/14-cancellation/p34-cancellation-terms-disclosure-required.ts`
        - (S3 disclosure) `back_end/src/policies/14-cancellation/p34-no-show-treatment-statement-required.ts`
      - **Policy 33 (Billing Model)**:
        - `back_end/src/policies/13-billing-model/p33-billing-model-confirmation-match.ts`
        - `back_end/src/policies/13-billing-model/p33-billing-model-settlement-method-compatibility.ts`
        - (invoice PAYMENT_TRACKED / RECONCILED state order) `back_end/src/policies/13-billing-model/p33-invoice-payment-state-transitions.ts`
        - (write-off requires OUTSTANDING folio) `back_end/src/policies/13-billing-model/p33-folio-outstanding-for-write-off.ts`
      - **SIG-S9 §8.8 — Write-Off Policy** (named in the route table; not a `### Policy N —` line in §4’s numbered envelope; Cat 06’s S9 column also omits `13-Bill`, so there is no `P30–P33` token for this action on the stage matrix):
        - `back_end/src/policies/13-billing-model/write-off-policy-constraints.ts`
      - **Policy 56** (group **22** No-Show) → `back_end/src/policies/22-no-show/p56-no-show-determination-prereqs.ts`
        - (S5 sub-state) `back_end/src/policies/22-no-show/p56-awaiting-written-confirmation-blocks-s5-exit.ts`
      - **Policy 7** (group **08** Pricing / Rate Plan) → `back_end/src/policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.ts` (validity lapse + accepted quotation on segment; wired from `s3-reservation-setup-service.ts` S2→S3)
        - (quotation supersede / send / accept `StateTransitionError` guards) `back_end/src/policies/08-pricing-rate-plan/p07-quotation-lifecycle-state-guards.ts`
      - **Policy 12** (OPEN duplicate blocks S2→S3) → `back_end/src/policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s2-exit.ts` (alongside the inquiry-time P12 flag creator in the same group)
      - **Policy 25** (speculative hold must be active for S2→S3) → `back_end/src/policies/10-speculative-hold/p25-speculative-hold-active-for-s2-exit.ts`
        - (release requires PLACED) `back_end/src/policies/10-speculative-hold/p25-speculative-hold-placed-for-release.ts`
      - **Policy 52** (quotation ack open loop cleared before S2→S3) → `back_end/src/policies/20-communication-acknowledgement-tracking/p52-quotation-ack-open-loop-resolved-for-s2-exit.ts`
      - **Policy 30** (billing model allowlist from config) → `back_end/src/policies/13-billing-model/p30-billing-model-allowlist-from-config.ts` (wired from `ensureProvisionalFolioAndBillingModel`)
      - **Policy 1** (S6 check-in completion: assignment + strict `AVAILABLE_*` readiness) → `back_end/src/policies/01-availability/p01-room-assignment-and-physical-ready-s6-checkin.ts` (`services/domain/check-in-service.ts`)
      - **Policy 5** (S6 completion H1 eligibility / walk-in) → `back_end/src/policies/02-ownership-custodian-assignment/p05-h1-eligible-for-s6-checkin-completion.ts`
      - **Policy 29** (advance reconciliation before check-in completion) → `back_end/src/policies/12-advance-payment/p29-advance-payment-reconciled-before-checkin-completion.ts`
      - **Policy 31** (folio `PROVISIONAL` before `convertToLive`) → `back_end/src/policies/13-billing-model/p31-folio-provisional-before-checkin-completion.ts`
        - (`convertToLive` PROVISIONAL gate) `back_end/src/policies/13-billing-model/p31-folio-provisional-required-to-convert-live.ts`
        - (S7 charge posting LIVE folio + S7 stage; night audit LIVE folio) `back_end/src/policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.ts`
        - (S3 committed hold) `back_end/src/policies/13-billing-model/p31-folio-required-before-committed-hold-s3.ts`
        - (S8 settlement must be on LIVE folio) `back_end/src/policies/13-billing-model/p31-folio-live-required-for-s8-settlement.ts`
      - **Policy 52** (VIP arrival notification persisted for VIP check-in completion) → `back_end/src/policies/20-communication-acknowledgement-tracking/p52-vip-arrival-notification-recorded-for-checkin.ts`
      - **SIG-S8 / `s8-checkout-service.ts` — S8→S9 progression guards**:
        - **Policy 1** (entry at S8 for `progressStageS8ToS9`; key return / inspection / checkout completion NOT_AT_S8) → `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - **Policy 1** (checkout completion — room OCCUPIED) → `back_end/src/policies/01-availability/p01-s8-checkout-room-occupied-gate.ts`
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
        - (charge posting blocked when operating date has COMPLETE night audit) `back_end/src/policies/24-night-audit/p61-charge-date-not-sealed-by-complete-night-audit.ts`
      - **`s1-entry-service.ts` — `parkEntry` / `unparkEntry`; S1→S2 (`progressS1ToS2`); S2 auto-fulfil (`autoFulfilS2ToS3`)**:
        - **Policy 1** (EXPIRED / ACTIVE→park / PARKED→unpark / S1 stage for `progressS1ToS2`) → `back_end/src/policies/01-availability/p01-s1-entry-status-and-stage-gates.ts`
        - **Policy 16** (guest profile, use type, guest count, stay dates, primary contact) → `back_end/src/policies/06-guest-identity/p16-s1-exit-entry-and-contact-gates.ts`
        - **Policy 12** (OPEN duplicate flags block S1 exit) → `back_end/src/policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s1-exit.ts`
        - **Policy 17** (CORPORATE/GOVERNMENT inquiry ref + coordinator) → `back_end/src/policies/07-guest-data-governance/p17-corporate-government-inquiry-context-s1-exit.ts`
        - **Policy 33** (apartment duration + rate tier for S1 exit) → `back_end/src/policies/13-billing-model/p33-apartment-commercial-fields-s1-exit.ts`
        - **Policy 1** (preferred availability config selected, not stale, deficient ack, room not maintenance/blocked) → `back_end/src/policies/01-availability/p01-s1-exit-preferred-configuration-and-room-eligibility.ts`
        - **Policy 67** (conference space allocation / capacity for S1 exit + shared attendee vs capacity helper) → `back_end/src/policies/27-work-order/p67-conference-s1-exit-space-gates.ts` (`enforceConferenceSpaceAttendeeCapacity` also used by `space-allocation-service.ts`)
        - **Policy 1** (entry must be at S1 for auto-fulfil) → `back_end/src/policies/01-availability/p01-entry-at-s1-for-auto-fulfil-s2-to-s3.ts`
      - **`s2-quotation-service.ts` — `createQuotation`; supersede / send / accept**:
        - **Policy 1** (S2 stage; sealed preferred availability configuration; resolved roomTypeId) → `back_end/src/policies/01-availability/p01-s2-create-quotation-configuration-gates.ts`
        - **Policy 7** (quotation supersede / send / accept state guards) → `back_end/src/policies/08-pricing-rate-plan/p07-quotation-lifecycle-state-guards.ts`
      - **`s2-hold-service.ts` — `placeSpeculativeHold` / `releaseSpeculativeHold`**:
        - **Policy 25** (S2 stage for speculative hold placement) → `back_end/src/policies/10-speculative-hold/p25-s2-stage-for-speculative-hold-placement.ts`
        - **Policy 25** (release requires PLACED) → `back_end/src/policies/10-speculative-hold/p25-speculative-hold-placed-for-release.ts`
      - **`s4-confirmation-service.ts` — `confirmReservation` (readiness slice)**:
        - **Policy 40** (S3 stage; accepted quotation; plus existing high-value authority) → `back_end/src/policies/16-confirmation-authority/p40-s4-confirmation-readiness-gates.ts` (stage + quotation) and `p40-confirmation-authority.ts`
        - **Policy 1** (entry version optimistic lock) → `enforceEntryVersionMatchesClientForOptimisticLock` in `back_end/src/policies/01-availability/p01-entry-version-optimistic-lock-match.ts`
        - **Policy 31** (provisional folio present) / **Policy 33** (billing model fixated; proforma invoice) / **Policy 26** (committed hold PLACED with room) → same `p40-s4-confirmation-readiness-gates.ts` module
      - **`room-assignment-service.ts` — `assignRoom`**:
        - **Policy 1** (S5/re-entry stage; immutability; hold; room type; arrival; physical assignability) → `back_end/src/policies/01-availability/p01-s5-room-assignment-eligibility-gates.ts`
      - **`s3-reservation-setup-service.ts`**:
        - **Policy 1** (S2 stage for `progressS2ToS3`) → `enforceEntryAtS2ForS2ToS3Progression` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
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
      - **`handoff-service.ts` — `createH4` / `createH2` (entry context); `acceptHandoff` / `fulfilHandoff` / `rejectHandoff` (state-machine)**:
        - **Policy 1** (S7 + ACTIVE for H4; S6 + ACTIVE for H2) → `enforceEntryAtS7ForH4Initiation`, `enforceEntryActiveForH4Initiation`, `enforceEntryAtS6AndActiveForCreateH2` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
        - **Policy 63** (`StateTransitionError` accept / fulfil / reject / H4 checklist config key) → `back_end/src/policies/25-handoff/p63-handoff-service-state-guards.ts`
      - **`s8-settlement-service.ts` — `initiateSettlement`**:
        - **Policy 1** (S8 stage) → `enforceEntryAtS8ForSettlementOperations` in `back_end/src/policies/01-availability/p01-entry-at-s8-for-checkout-progression.ts`
        - **Policy 31** (folio LIVE) → `back_end/src/policies/13-billing-model/p31-folio-live-required-for-s8-settlement.ts`
      - **`folio-service.ts` — `convertToLive`**:
        - **Policy 31** (folio must be PROVISIONAL) → `back_end/src/policies/13-billing-model/p31-folio-provisional-required-to-convert-live.ts`
      - **`s7-folio-lines-service.ts` — `postCharge`**:
        - **Policy 31** / **Policy 1** (LIVE folio + S7 stage) → `back_end/src/policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.ts`
        - **Policy 61** (charge date not sealed by COMPLETE night audit) → `back_end/src/policies/24-night-audit/p61-charge-date-not-sealed-by-complete-night-audit.ts`
      - **`s7-night-audit-service.ts` — `runNightAudit`**:
        - **Policy 31** (folio LIVE for in-scope entry processing) → `enforceFolioLiveForNightAuditProcessing` in `back_end/src/policies/13-billing-model/p31-folio-live-charge-and-night-audit-context.ts`
      - **`s7-amendment-service.ts` — `roomChangeReEntryToS1`**:
        - **Policy 1** (S7 stage) → `enforceEntryAtS7ForRoomChangeReEntry` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
      - **`s1-processing-lock-service.ts` — `reconfirm`**:
        - **Policy 71** (lock must be EXPIRED) → `back_end/src/policies/31-processing-lock/p71-processing-lock-expired-for-reconfirm.ts`
      - **`pre-arrival-service.ts` — `updatePreArrivalTask`**:
        - **Policy 09** (task must be PENDING) → `enforcePreArrivalTaskPendingForUpdate` in `back_end/src/policies/03-expiry-parking/p09-s5-normal-exit-pre-arrival-tasks-terminal.ts`
      - **`db.ts` — Prisma client `$extends` query layer**:
        - Immutability / transition guards → `back_end/src/policies/01-availability/p01-prisma-extension-blocking-guards.ts` (reservation, OTA overbooking trigger, folio create/update, folioLine, VIP notification, night audit, dispute override, room assignment, room claim path)
      - **SIG-S9 / `s9-service.ts` — entry closure + post-stay charge**:
        - **Policy 1** (S9 stage for `closeEntryAtS9`; reject duplicate close) → `enforceEntryAtS9ForS9Closure`, `enforceEntryNotAlreadyClosed` in `back_end/src/policies/01-availability/p01-entry-at-s9-for-closure.ts`
        - **Policy 33** (invoice PAYMENT_TRACKED / RECONCILED) → `back_end/src/policies/13-billing-model/p33-invoice-payment-state-transitions.ts`
        - **Policy 33** (write-off requires OUTSTANDING folio) → `back_end/src/policies/13-billing-model/p33-folio-outstanding-for-write-off.ts`
        - **Policy 54** (no open disputes for S9 closure) → `enforceNoOpenDisputesForS9Closure` in `back_end/src/policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.ts`
        - **Policy 33** (invoice dispatch; GOVERNMENT / DIRECT_BILL payment paths; OUTSTANDING + W8/write-off; apartment deposit; post-stay charge window + stage) → `back_end/src/policies/13-billing-model/p33-s9-closure-invoice-payment-and-poststay-gates.ts`
        - **Policy 51** (inspection resolution for closure) → `back_end/src/policies/19-deficient-condition/p51-s9-closure-inspection-resolution.ts`
        - **Policy 1** (equipment return evidence for closure) → `back_end/src/policies/01-availability/p01-equipment-return-resolved-for-s9-closure.ts`
        - **Policy 56** (no-show determination row when folio is NO_SHOW_CLOSED) → `back_end/src/policies/22-no-show/p56-no-show-determination-required-for-s9-closure.ts`
        - **Policy 63** (H5 not blocking S9 closure) → `enforceH5NotBlockingS9Closure` in `back_end/src/policies/25-handoff/p63-handoff-lifecycle-gates.ts`
      - **`routes/reservations/router.ts` — `POST /entries/:id/progress-stage`**:
        - **Policy 1** (CLOSED entry blocks stage progression) → `enforceEntryNotClosedForStageProgression` in `back_end/src/policies/01-availability/p01-entry-progression-stage-gates.ts`
  - Services were updated to call these policy functions.
  - **Cat 06 “done” criteria (Atlas vs this repo)**: The Structural Atlas lists **77** numbered policies in Cat 06, but the backend slice does **not** implement every Atlas policy name-by-name, and some Atlas rows are placeholders or aggregate several runtime checks. Treat “all policies extracted” as **complete** only when: (1) every **409-style gate** (`PolicyGateBlockedError` / `StageGateBlockedError` / `StateTransitionError`) that remains in **`routes/`** (outside thin delegation) and **`db.ts` extension hooks** is either implemented via **`src/policies/**`** with stable `blockingCondition` codes or explicitly documented as out-of-scope for this slice; and (2) a maintained mapping ties each **implemented** Atlas policy number to a module (or marks it **not implemented**). **Workers (33) and engines (12)** are separate catalogues—counts will not match Atlas until a dedicated alignment pass is done.
  - **Approximate extraction progress (policy numbers only)**: Atlas Cat 06 lists **77** policies; this codebase has extracted at least one enforcement surface for **37** distinct numbered policies ≈ **48%** by that count, with ≈ **52%** of the numbered catalogue not yet represented as standalone modules. **`services/domain` and `services/application` do not construct `StageGateBlockedError` / `PolicyGateBlockedError` directly**; they also **no longer import or throw `StateTransitionError`** — those envelopes are produced from **`src/policies/**`** (plus Prisma extension hooks in **`policies/01-availability/p01-prisma-extension-blocking-guards.ts`**). **`handoff-service.ts`** accept / fulfil / reject / H4-config paths delegate to **`policies/25-handoff/p63-handoff-service-state-guards.ts`**; **`s8-checkout-service.ts`** S8 stage + OCCUPIED-room gates delegate to **`p01-entry-at-s8-for-checkout-progression.ts`** and **`p01-s8-checkout-room-occupied-gate.ts`**. **`reservations/router.ts`** `progress-stage` CLOSED check throws via **`enforceEntryNotClosedForStageProgression`**. **`routes/**`** no longer builds raw **`AppError`** for 400/403/404 — they use the canonical **`ValidationError` / `NotFoundError` / `AuthorizationError`** classes so response bodies stay aligned with `lib/errors.ts`.
  - **Envelope note**: several S2→S3 / S3 folio gates that previously threw `StageGateBlockedError` now throw `PolicyGateBlockedError` with the same `blockingCondition` codes (still HTTP 409); only the `error` string in the JSON body changes.

**What’s still missing**
- **`ValidationError`** (and similar) remain in **`services/**`** for request-shape and field validation; optional follow-up is shared **Zod** (or DTO) schemas per route group.
- The majority of the 77 Atlas policy **rows** are still **not represented** as standalone modules beyond the ~37 numbered surfaces listed above (1, 3, 5, 7, 9, 12, 13, 16, 17, 23, 25, 26, 27, 28, 29, 30, 31, 33, 34, 38, 39, 40, 41, 42, 44, 45, 48, 49, 51, 52, 54, 56, 61, 63, 67, 71, 72, plus SIG-S9 §8.8 Write-Off Policy without a Cat 06 P-token).
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
- **What we did (2026-05-11)**: `middleware/concurrent-editing.ts` and `middleware/rate-limiting.ts` export **pass-through** handlers and are chained in `routes/api-router.ts` after `parseActorHeaders()`. **CORS** remains in `index.ts`; **validation** is `validate-body.ts` + Zod on routes. Real optimistic-lock and rate limits are still **TODO** (replace pass-throughs when requirements are fixed).
- **See also**: section **Atlas alignment inventory** below for the Cat 11 table.

### Cat 13 — DTOs (20 domain groups)
- **Atlas expects** 20 DTO groups and DTO-bound validation middleware.
- **What we did**
  - Added `back_end/src/dtos/` with **20 numbered folders** (`01-session-and-authentication` … `20-voice-notes`) aligned to Atlas Cat 13 / Cat 10 route group names and order.
  - Each implemented group exports **`request-schemas.ts`** (Zod `*RequestSchema` + `z.infer` types) and, where useful, **`response-dtos.ts`** (explicit response shapes, not Prisma dumps).
  - **`middleware/validate-body.ts`** parses JSON bodies with Zod; failures surface as **`ValidationError`** with `flatten()` details.
  - **Routers** under `back_end/src/routes/**` use `validateBody(...)` on POST/PATCH bodies (plus `validation/admin-schemas.ts` for `/admin/enqueue`).
  - **Cat 13 placeholders** (no matching routes in this slice yet): `16-incidents-and-lost-found`, `17-communications`, `19-ai-agent-draft-management`, `20-voice-notes` export empty placeholder types so the tree stays one-to-one with the atlas table.

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

## Atlas alignment inventory (Atlas HTML + `docs/SIG-S*.md` vs `back_end/src`)

_Last updated: 2026-05-11 — engines + middleware scaffolds + missing worker scaffolds; inventory only; **no new top-level `src/` folders**._

### Cat 05 — Engines (12 catalogue rows)

| Atlas # | Engine | Repo module | Notes |
|--------:|--------|-------------|------|
| 1 | PricingPipelineEngine | `engines/pricing-pipeline-engine.ts` | OK |
| 2 | AvailabilityEngine | `engines/availability-engine.ts` | OK |
| 3 | TaxEngine | `engines/tax-engine.ts` | **Added** — passthrough `calculateTax` until SIG tax rules are implemented. |
| 4 | OverbookingDetectionEngine | `engines/overbooking-detection-engine.ts` | OK |
| 5 | DisputeGateEngine | `engines/dispute-gate-engine.ts` | OK |
| 6 | FOCValidationEngine | `engines/foc-validation-engine.ts` | OK |
| 7 | CreditCeilingMonitorEngine | `engines/credit-ceiling-monitor-engine.ts` | **Added** — pure `evaluateCreditCeiling`; W12 remains async dispatch. |
| 8 | NightAuditEngine | `engines/night-audit-engine.ts` | **Added** — `planNightAudit` stub; real run stays `s7-night-audit-service` + W6. |
| 9 | TimerEngine | `engines/timer-engine.ts` | **Added** — re-exports `lib/timer-engine` for Atlas naming. |
| 10 | ReEntryConsequenceEngine | `engines/re-entry-consequence-engine.ts` | OK |
| 11 | RoomAssignmentSuggestionEngine | `engines/room-assignment-suggestion-engine.ts` | OK |
| 12 | *Placeholder row* | — | Atlas HTML: “Engine 12 per §4.12 completeness statement” — **no extra file** (Atlas documents the row as placeholder). |

### Cat 08 — Workers (Atlas 33 rows vs SIG W34/W35)

- **Atlas Cat 08** lists **W1–W33** only (`BACKEND-STRUCTURAL-ATLAS-v1_1 (1).html`).
- **SIG** extends with **W34 = AdvancePaymentFollowUpWorker** and **W35 = QuotationAckWorker** (`docs/SIG-S2-v1_3.md`, `docs/SIG-S7-v1_0.md`). Repo: `w34-advance-payment-follow-up-worker.ts`, `w35-quotation-ack-worker.ts`, registered in `workers/runner.ts` — **SIG catalogue extension**, not a duplicate of an Atlas row.
- **FOM / W32–W33 drift**: Atlas **W33 = FOMOverrideFrequencyWorker** → `w33-fom-override-frequency-worker.ts`; wrapper `w32-fom-override-frequency-worker.ts` documents historical numbering. Atlas **W32 = BlockedRoomUnblockWorker** → scaffold **`w32-blocked-room-unblock-worker.ts`** (not registered in runner until job type exists).
- **Scaffolds added (not in `runner.ts`)**: W13 RelocationExternalHandshake, W14 VIP arrival, W17 Voice note SLA, W19 Correction log aggregation, W31 Maintenance ready-at — each returns `{ skipped: true, reason: "NOT_IMPLEMENTED" }`.

### Cat 11 — Middleware (5 pipeline stages)

| Stage | Repo | Status |
|-------|------|--------|
| CORS | `index.ts` (`cors()`) | Global |
| Auth | `middleware/auth.ts` | After `/auth` mount |
| Validation | `middleware/validate-body.ts` + Zod per route | On mutating routes |
| Concurrent editing | `middleware/concurrent-editing.ts` | **Added** — pass-through; wired in `routes/api-router.ts` |
| Rate limiting | `middleware/rate-limiting.ts` | **Added** — pass-through; wired in `routes/api-router.ts` |

### Cat 06 — Policies (cross-check before next extraction)

Service files: stale “Policy N owns …” **inline** comments were swept (`s2-quotation`, `s4-confirmation`, `cancellation-service` user-visible strings). Policy catalogue remains in **`policies/**`** modules and file-level JSDoc where useful.

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

