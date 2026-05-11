# Stage 01 (S1) — Audit report

- **Doc**: `SIG-S1-v1_2.md` + `LEGPHEL_Implementation_Reference_v1_1.html` (Layer 03a · S1 inquiry flow)
- **Scope**: policies, stage identity, schema, engines, services, workers, routes, config keys, acceptance criteria, and scenario tests.
- **Generated**: 2026-05-06

---

## 0) Completion status (DONE / PARTIAL / NOT DONE)

- **DONE**: Shadow inventory policy surface + filtering (`Room.isShadowInventory` + Policy 14 filter at query time)
- **DONE**: Duplicate flag persistence + resolution path (blocks S1 exit until resolved)
- **DONE**: Corporate/Government context persistence + exit guard enforcement
- **DONE**: Apartment duration + rate-tier capture + exit guard enforcement
- **PARTIAL**: Conference requirements (we enforce seatingConfig + attendeeCount ≤ capacity for at least one `SpaceAllocation`; full conference flow may require richer eventBlock schema and multi-space support)
- **NOT DONE**: Full automated duplicate detection (we persist the flag, but the detection itself is still a “provided by controller/operator” stub)

---

## 1) What’s implemented (high-signal map)

### 1.1 Stage identity + forbiddens
- **S1 begins at `(ACTIVE, S1)`** on `POST /entries` (`s1-entry-service.ts`).
- **No folio creation at S1**: `createEntry()` does not touch `Folio`.
- **No hold placement at S1**: hold routes are under later-stage endpoints (`/entries/:id/holds/*`), not S1.
- **No quotation creation at S1**: quotation routes are S2.

### 1.2 Services
- **Inquiry**: `src/services/s1-inquiry-service.ts`
  - `createInquiry()` implements Policy 3 via config key `ownership.assignmentRules`.
  - `parkInquiry()` / `unparkInquiry()` now exist + are wired to routes (Inquiry-level park cascade).
  - `captureCorporateContext()` persists corporate/government details for S1 exit gating.
  - `resolveDuplicateFlag()` persists duplicate adjudication.
- **Entry**: `src/services/s1-entry-service.ts`
  - `createEntry()` creates Entry + Segment(1) + StageDwellRecord.
  - `progressS1ToS2()` now enforces a larger subset of the doc’s exit guards.
- **Availability**: `src/services/s1-availability-service.ts`
  - `queryAvailability()` persists `AvailabilityConfiguration` with engine result.
  - `selectOption()` now enforces “must select from persisted result set” + blocks unavailable rooms.
- **Processing locks**: `src/services/s1-processing-lock-service.ts`
  - schedules `PROCESSING_LOCK_TTL` pg-boss job.
  - creates `RevalidationDeltaRecord` on reconfirm.

### 1.3 Engines
- `src/engines/availability-engine.ts` exists; now respects `availability.bookablePhysicalStates` for “physical not ready”.
- `src/engines/pricing-pipeline-engine.ts` exists (indicative only; not fully evaluated in S1 routes).

### 1.4 Workers active at S1
- **W1**: `STAGE_DWELL_MONITOR` — also marks availability staleness based on `availability.staleness.ttlSeconds`.
- **W16**: `PROCESSING_LOCK_TTL` (expiry worker exists in `src/workers`).
- **W20**: `ENTRY_EXPIRY` (expiry worker exists in `src/workers`).

### 1.5 API routes at S1
Routes are defined in `src/routes/s5-routes.ts` under `/api`:
- `POST /inquiries`
- `POST /inquiries/:id/park`
- `POST /inquiries/:id/unpark`
- `PATCH /inquiries/:id/corporate-context`
- `POST /duplicate-flags/:id/resolve`
- `POST /entries`
- `POST /entries/:id/park`
- `POST /entries/:id/unpark`
- `PATCH /entries/:id/apartment-context`
- `POST /entries/:id/availability/query`
- `PATCH /availability/configurations/:id/select`
- `POST /entries/:id/progress-stage` with `targetStage="S2"`
- `POST /processing-locks` + `GET /processing-locks/:id` + `POST /processing-locks/:id/reconfirm`

---

## 2) S1 exit guard coverage (doc vs code)

The doc exit gate enumerates 11 conditions (HTML deep dive + SIG §1.4). Current code coverage is:

- **Implemented (schema-backed)**:
  - **≥1 AvailabilityConfiguration exists** and **preferred selected** (`NO_PREFERRED_CONFIGURATION`).
  - **Preferred not stale** (`PREFERRED_CONFIGURATION_STALE`).
  - **DEFICIENT acknowledgement required** when selected option is deficient (`DEFICIENT_ACK_REQUIRED`).
  - **Mandatory entry fields subset**: `guestProfileId`, `useType`, `guestCount`, `checkInDate/checkOutDate`.
  - **Primary contact guard**: requires at least one contact-ish field on `GuestProfile` (best-effort due to schema variability).
  - **Maintenance/blocked conflict guard (selected)**: rejects if selected option bucket is unavailable due to MAINTENANCE_CONFLICT/BLOCKED.
  - **Conference subset**: requires at least one `SpaceAllocation` row if `useType=CONFERENCE` and validates `eventBlock` has `attendeeCount` + `seatingConfig`, and attendeeCount ≤ space capacity.
  - **Duplicate gate**: blocks S1 exit if any `DuplicateDetectionFlag.status=OPEN` exists.
  - **Corporate/Government gate**: requires `Inquiry.corporateClientRef` + `Inquiry.corporateCoordinator` when `Inquiry.sourceChannel` is `CORPORATE` or `GOVERNMENT`.
  - **Apartment gate**: requires `Entry.apartmentDurationNights` + `Entry.apartmentRateTierCode` for `EntryUseType.APARTMENT`.

- **Not implemented / not representable with current schema** (architectural gaps):
  - **Full automated duplicate detection** remains stubbed (we persist the flag and resolution, but do not compute it from identity matching rules yet).

---

## 3) Key architectural gaps (must be tracked)

### 3.1 Shadow inventory policy can’t be enforced fully
- **Status**: DONE
- Config key: `availability.shadowInventory.visibilityRules`
- Schema: `Room.isShadowInventory`
- Behaviour: shadow rooms are filtered at availability query time based on actor level.

### 3.2 Duplicate detection / resolution paths are not persisted
- **Status**: PARTIAL
- Persisted: `DuplicateDetectionFlag` + resolution route + S1 exit block until resolved.
- Missing: automated detection logic itself (still provided/stubbed).

---

## 4) Scenario tests (what ran)

Reports are in this folder:
- `README.md` (index)
- `scenario_01_happy_path.md`
- `scenario_02_select_non_result_room_rejected.md`
- `scenario_03_inquiry_park_unpark.md`
- `scenario_04_exit_block_missing_contact.md`
- `scenario_05_deficient_ack_required.md`
- `scenario_06_w1_marks_stale.md`
- `scenario_07_w16_reconfirm_delta.md`
- `scenario_08_w20_entry_expiry.md`
- `scenario_09_shadow_inventory_hidden_l1.md`
- `scenario_10_duplicate_blocks_exit_until_resolved.md`
- `scenario_11_corporate_context_required.md`
- `scenario_12_apartment_context_required.md`

All scenarios currently pass (see `README.md` for the pass counts).

---

## 5) What remains to reach “SIG-S1 complete”

Remaining work is now mostly **policy depth** (not missing tables):
- Implement true **duplicate detection** (Policy 12) using real matching rules and persist the OPEN flag based on computed evidence.
- Expand conference flow modelling (if you need multi-space allocations, richer `eventBlock`, and more guard conditions).
- Add walk-in compressed S1–S5 orchestration checks if you want S1 to fully assert that cross-stage mechanism.

