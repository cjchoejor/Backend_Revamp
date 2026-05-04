# S1 implementation report (SIG-S1 v1.2)

This report summarizes what was implemented/reconciled for **Stage 1 (S1 — Inquiry & Configuration)** and what remains intentionally out-of-scope for this stage pass.

## Summary

- **Schema**: reconciled to match SIG-S1 core S1 surfaces (Inquiry/Entry/Segment/AvailabilityConfiguration/ProcessingLockRecord/RevalidationDeltaRecord/StageDwellRecord/TraceEvent/ConfigurationEntry) and added `StaffUser` + session models for SIG-S1 auth routes.
- **Engines**: implemented pure `AvailabilityEngine.query()` and indicative `PricingPipelineEngine.resolve()` scaffolding.
- **Workers**: implemented W1/W16/W20 handlers and a pg-boss runner.
- **Routes**: added SIG-S1 auth endpoints and processing-lock endpoints; kept existing stage router file as the single API router mount under `/api`.
- **Tests**: `scripts/s1-acceptance-tests.ts` passes on the current dev DB seed.

## What changed (high-signal)

### Schema

- **`ConfigurationEntry`**: changed from simple `{configKey unique, value}` to SIG-style effective dating (`effectiveFrom`, `effectiveTo`) and canonical JSON field name `configValue`.
- **`Inquiry`**: `referenceNumber`, `guestProfileId`, and `defaultCustodianId` are required as per SIG-S1.
- **`TraceEvent`**: expanded toward SIG-S1 append-only trace model shape (`actorId`, `actorLevel`, `entityType`, `entityId`, `operation`, `timestamp`, etc.).
- **Sessions**: added `StaffUser`, `SessionRecord`, `SessionEventRecord` to support SIG-S1 `/auth/*` routes.

### Infra / timers / workers

- Added `src/lib/timer-engine.ts` (pg-boss wrapper) and `src/services/timer-management-service.ts`.
- Added worker handlers:
  - `src/workers/w1-stage-dwell-monitor.ts`
  - `src/workers/w16-processing-lock-expiry-worker.ts`
  - `src/workers/w20-entry-expiry-worker.ts`
- Added `src/workers/runner.ts` and optional worker boot via `RUN_WORKERS=true`.

### S1 services

- Updated S1 inquiry/entry/availability services to align closer to SIG-S1 intent:
  - Custodian assignment uses `ownership.assignmentRules`
  - Availability uses `AvailabilityEngine.query()` with config injection
  - Progress S1→S2 seals the selected configuration in the same transaction
- Added `src/services/s1-processing-lock-service.ts` and wired routes:
  - `POST /processing-locks`
  - `POST /processing-locks/:id/reconfirm`
  - `GET /processing-locks/:id`

## Acceptance tests

The current automated suite is in:

- `back_end/scripts/s1-acceptance-tests.ts`

Outputs:

- `Documentation_V2/S1-test-report.md`
- `Documentation_V2/S1-test-output.json`

Current run status: **Passed 7/7** (this suite is a focused subset of AC-S1-001 → AC-S1-036).

## Known gaps vs SIG-S1 (to be completed)

These items are specified in SIG-S1 but not fully implemented in this pass yet:

- **Full route surface**: SIG-S1 lists additional endpoints (list/get for inquiries/entries, inquiry park/unpark, custodian reassignment endpoints, availability config get/recall). Only a subset is currently exposed.
- **Duplicate detection**: Policy 12 is still stubbed (currently supported via input `duplicateCheck` flag).
- **TimerRecord surface**: SIG describes `TimerManagementService` + `TimerRecord` governance; the implementation currently schedules key jobs, but does not yet expose timer query/status endpoints.
- **W7 OTA email parser**: explicitly out-of-scope for now (requires IMAP integration + AI draft workflow models).
- **S3→S1 re-entry consequence execution**: referenced in SIG-S1 acceptance criteria, but will be validated when S3/Hold/Folio/Invoice timer cancellation is fully aligned to the worker/timer registry.

## Next step

Proceed to **S5→S9 reconciliation and retest**, then return to **S2→S4 reconciliation and retest**, per your requested order.

