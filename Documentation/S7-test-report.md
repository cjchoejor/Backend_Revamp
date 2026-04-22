# S7 test report

This report is produced by `back_end/scripts/s7-acceptance-tests.ts`. Each case below states **what** is being validated, **which HTTP call** is made (with actor headers), **what the backend checks**, and **which database tables** receive rows or updates when data is persisted.

**Prisma `@@map` → PostgreSQL table names** (use these in pgAdmin): `FolioLine` → `folio_lines`, `Folio` → `folios`, `NightAuditRecord` → `night_audit_records`, `NightAuditAnomaly` → `night_audit_anomalies`, `DisputeRecord` → `dispute_records`, `DisputeGateOverrideRecord` → `dispute_gate_override_records`, `Entry` → `entries`, `StageDwellRecord` → `stage_dwell_records`, `Reservation` → `reservations` (e.g. `frozen_inclusions`, `frozen_check_out_date`), `HandoffRecord` → `handoff_records` (H4 gate), `RoomAssignment` → `room_assignments`, `Room` → `rooms`, `DeficientConditionRecord` → `deficient_condition_records`, `ConfigurationEntry` → `configuration_entries` (e.g. `nightAudit.expectedDailyFAndBCharge`).

## Re-running after a successful pass

The script ends by moving the seeded entry to **S8**, so the next run will not find `current_stage = S7` unless you **re-seed** or point at another row:

1. `cd back_end && npx prisma db seed` (restores the console line **Seeded S7 entry id:** …).
2. Start the API (`npm run dev` on port 4000).
3. `npx tsx scripts/s7-acceptance-tests.ts`

Optional: `S7_TEST_ENTRY_ID=<uuid>` forces a specific entry (must still be **S7** or the script exits with an error).

- **Ran at**: 2026-04-21T04:15:28.492Z
- **Base URL**: `http://localhost:4000/api`
- **Pass**: 13
- **Fail**: 0

## Cases

### ✅ AC-S7-03-setup — Run night audit (seal operating date) (HTTP 200)

**What is happening**

Calls **POST /night-audit/run** as an **L2** actor (`X-Actor-Id: test-fom-1`, `X-Actor-Level: L2`). The night-audit service processes **2026-04-20** (UTC calendar day). For each active S7 entry it posts a **ROOM_CHARGE** folio line for that operating date (if not already present), then marks the run **COMPLETE**. Once `runStatus` is **COMPLETE** for that `operatingDate`, the same calendar day is treated as **sealed** for backdated manual charges (AC-S7-03).

**Database (PostgreSQL)**

**INSERT** into `night_audit_records` (`id`, `operating_date`, `run_status`, `entries_processed_count`, `entries_not_processed`, `created_at`, `created_by`). **INSERT** into `folio_lines` (`folio_id`, `line_type` = ROOM_CHARGE, `description`, `amount`, `currency`, `charge_date`, `stage`, `posted_by`, `night_audit_record_id`, `created_at`). **UPDATE** `folios` (`outstanding_balance` incremented by the room charge amount). If any entry fails processing, the run can be **PARTIAL** with `entries_not_processed` JSON — not exercised in this happy-path setup.

**API response**

```json
{
  "id": "4a84e60a-6a55-477d-a0fa-fad5161be8c2",
  "operatingDate": "2026-04-20T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 1,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-21T04:15:28.362Z",
  "createdBy": "test-fom-1"
}
```
### ✅ AC-S7-03 — Posting a charge on a sealed audit date is blocked (HTTP 409)

**What is happening**

Calls **POST /folios/:id/charges** as **L1** with `chargeDate` on **2026-04-20**, the same UTC operating date that already has a `night_audit_records` row with `run_status = COMPLETE`. The folio charge service normalises the charge date to an operating date and refuses new lines for sealed days. This matches SIG expectation **SEALED_AUDIT_DATE** (no silent backdating after audit close).

**Database (PostgreSQL)**

**No INSERT** on success path — request is rejected before `folio_lines` is written. The service **reads** `night_audit_records` (`operating_date`, `run_status`) to decide if the date is sealed.

**API response**

```json
{
  "error": "StateTransitionError",
  "message": "Charge date is sealed by completed night audit",
  "blockingCondition": "SEALED_AUDIT_DATE",
  "details": {
    "operatingDate": "2026-04-20T00:00:00.000Z"
  }
}
```
### ✅ AC-S7-01 — PostCharge creates a FolioLine (no update path) (HTTP 200)

**What is happening**

Calls **POST /folios/:id/charges** as **L1** with `lineType: OTHER` (mini bar style charge). The entry must be **S7** and the folio **LIVE**. Posted charges are **append-only**: there is no Prisma `update` on `FolioLine` after creation (AC-S7-01).

**Database (PostgreSQL)**

**INSERT** `folio_lines`: `id`, `folio_id`, `line_type`, `description`, `amount`, `currency`, `charge_date`, `stage`, `posted_by`, `night_audit_record_id` (null for manual post), `created_at`. **UPDATE** `folios`: `outstanding_balance` += charge `amount`.

**API response**

```json
{
  "id": "3730feb4-41fb-4388-b4a6-c9df519d5729",
  "folioId": "609957b6-50a3-461f-b178-303179701022",
  "lineType": "OTHER",
  "description": "Mini bar",
  "amount": "25",
  "currency": "BTN",
  "chargeDate": "2026-04-21T10:00:00.000Z",
  "stage": "S7",
  "postedBy": "test-fd-1",
  "nightAuditRecordId": null,
  "createdAt": "2026-04-21T04:15:28.401Z"
}
```
### ✅ AC-S7-02 — Correction creates a new FolioLine (original unchanged) (HTTP 200)

**What is happening**

Calls **POST /folios/:id/corrections** with `originalFolioLineId` pointing at the line from AC-S7-01. Corrections are modelled as a **new** `folio_lines` row (typically negative `amount`), not an UPDATE of the original row (AC-S7-02). The original row’s columns remain unchanged in the database.

**Database (PostgreSQL)**

**INSERT** another row into `folio_lines` (same columns as AC-S7-01). **UPDATE** `folios.outstanding_balance` by the correction `amount` (here −5). The row referenced by `original_folio_line_id` in the request is **not updated** — only read for validation and description text.

**API response**

```json
{
  "id": "35f0e24d-6de8-4b93-8e6e-4e4d45a05567",
  "folioId": "609957b6-50a3-461f-b178-303179701022",
  "lineType": "OTHER",
  "description": "Correction for 3730feb4-41fb-4388-b4a6-c9df519d5729: Wrong amount",
  "amount": "-5",
  "currency": "BTN",
  "chargeDate": "2026-04-21T10:05:00.000Z",
  "stage": "S7",
  "postedBy": "test-fd-1",
  "nightAuditRecordId": null,
  "createdAt": "2026-04-21T04:15:28.411Z"
}
```
### ✅ AC-S7-05 — Night audit first run creates record (HTTP 200)

**What is happening**

First run for **2026-04-21** (UTC). The seeded S7 reservation has `frozen_inclusions` with `dailyFAndBExpected: true`, so the engine expects an **F_AND_B** line for that operating date. If none exists, it records an anomaly instead of auto-posting the missing charge (AC-S7-04). It still posts **ROOM_CHARGE** for the night when applicable (AC-S7-05).

**Database (PostgreSQL)**

**INSERT** `night_audit_records` for `operating_date = 2026-04-21`. **INSERT** `folio_lines` for night-audit room charge with `night_audit_record_id` set. **INSERT** `night_audit_anomalies` (`night_audit_record_id`, `entry_id`, `anomaly_type` = MISSING_EXPECTED_CHARGE, `description`, …) when expected F&B is missing. **UPDATE** `folios.outstanding_balance` for the room charge.

**API response**

```json
{
  "id": "cf2705c2-a5b4-4554-b061-001f5606aabf",
  "operatingDate": "2026-04-21T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 1,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-21T04:15:28.420Z",
  "createdBy": "test-fom-1"
}
```
### ✅ AC-S7-04 — Night audit creates MISSING_EXPECTED_CHARGE anomaly when expected daily F&B missing

**What is happening**

This case does not call the HTTP API again; it **queries Prisma** after the AC-S7-05 run to assert that `night_audit_anomalies` contains at least one row with `anomaly_type = MISSING_EXPECTED_CHARGE` for the new `night_audit_records.id`. That proves the audit detected a missing expected F&B charge **without** inserting a compensating `folio_lines` row for F&B.

**Database (PostgreSQL)**

**SELECT** from `night_audit_anomalies` filtered by `night_audit_record_id`. Expected row columns include `anomaly_type`, `entry_id`, `description`, `created_at`.

**Notes**

Anomalies found: MISSING_EXPECTED_CHARGE
### ✅ AC-S7-05-idempotent — Night audit rerun does not add new FolioLines (HTTP 200)

**What is happening**

Calls **POST /night-audit/run** again with the **same** `operatingDate`. The service returns the **existing** `night_audit_records` row and must **not** create duplicate `folio_lines` tied to that audit (AC-S7-05 idempotency). The script compares `COUNT(*)` from `folio_lines` where `night_audit_record_id` matches before vs after the second call.

**Database (PostgreSQL)**

Second call: typically **no new** `folio_lines` for that `night_audit_record_id`; **no duplicate** `night_audit_records` for the same `operating_date` (unique constraint).

**Notes**

FolioLines for record: before=1, after=1

**API response**

```json
{
  "id": "cf2705c2-a5b4-4554-b061-001f5606aabf",
  "operatingDate": "2026-04-21T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 1,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-21T04:15:28.420Z",
  "createdBy": "test-fom-1"
}
```
### ✅ AC-S7-17-setup — Open dispute (HTTP 200)

**What is happening**

Calls **POST /disputes/open** as **L1** with `entryId`, `folioId`, `title`, `description`. This creates an open dispute tied to the stay’s folio. Later, `canProgressToS8` treats an open dispute without an S8 gate override as **BLOCKED_WITH_OVERRIDE_AVAILABLE** (policy gate).

**Database (PostgreSQL)**

**INSERT** `dispute_records`: `id`, `entry_id`, `folio_id`, `status` (default OPEN), `title`, `description`, `opened_at`, `opened_by`, `updated_at`, optional `updated_by`, closure fields null.

**API response**

```json
{
  "id": "73705882-6ae5-4fca-81d4-456824b550fc",
  "entryId": "5f9a6d52-a1fa-4662-bf4e-a3a1a62a3c31",
  "folioId": "609957b6-50a3-461f-b178-303179701022",
  "status": "OPEN",
  "title": "Charge dispute",
  "description": "Guest disputes minibar",
  "openedAt": "2026-04-21T04:15:28.443Z",
  "openedBy": "test-fd-1",
  "updatedAt": "2026-04-21T04:15:28.443Z",
  "updatedBy": null,
  "closedAt": null,
  "closedBy": null,
  "closureReason": null
}
```
### ✅ AC-S7-25 — S7→S8 requires version (optimistic lock guard) (HTTP 409)

**What is happening**

Calls **POST /entries/:id/progress-stage** with `targetStage: S8` but **omits** `version`. Per SIG AC-S7-25 / optimistic locking, the handler rejects the request immediately with **OptimisticLockError** so the client must send the current `entries.version`.

**Database (PostgreSQL)**

**No database writes** — validation fails before transaction.

**API response**

```json
{
  "error": "OptimisticLockError",
  "message": "Entry version mismatch — refresh and retry"
}
```
### ✅ AC-S7-17 — Dispute gate blocks S7→S8 until GM override (HTTP 409)

**What is happening**

With a valid `version`, progression still fails because an **open** dispute exists and no **DisputeGateOverrideRecord** yet exists for `target_stage = S8`. The API returns **PolicyGateBlockedError** with `blockingCondition: DISPUTE_GATE_BLOCKED`. Other S7→S8 gates (H4, night audit for last stay night, deficient conditions) must also pass when implemented in `progressStageS7ToS8`.

**Database (PostgreSQL)**

**Reads** `dispute_records`, `dispute_gate_override_records`, `handoff_records` (H4), `night_audit_records`, `deficient_condition_records`, `entries`, `folios`. **No writes** on this failed attempt.

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Dispute gate blocks S7→S8 until GM override is recorded",
  "blockingCondition": "DISPUTE_GATE_BLOCKED"
}
```
### ✅ AC-S7-18 — Create dispute gate override (immutable) (HTTP 200)

**What is happening**

Calls **POST /disputes/:id/gate-override** as **L3** (GM) with mandatory `freeTextReason` and `targetStage: S8`. This records an immutable override row (AC-S7-18 — no UPDATE path in app code). After this, `canProgressToS8` returns clear for that dispute.

**Database (PostgreSQL)**

**INSERT** `dispute_gate_override_records`: `id`, `dispute_id`, `target_stage`, `free_text_reason`, `created_at`, `created_by`.

**API response**

```json
{
  "id": "3a65d645-d84d-4319-b1e6-2add0423d501",
  "disputeId": "73705882-6ae5-4fca-81d4-456824b550fc",
  "targetStage": "S8",
  "freeTextReason": "GM override for checkout continuity",
  "createdAt": "2026-04-21T04:15:28.472Z",
  "createdBy": "test-gm-1"
}
```
### ✅ AC-S7-19 — Override not available for S8→S9 (HTTP 409)

**What is happening**

Attempts a gate override with `targetStage: S9`. Per AC-S7-19, dispute overrides are **not** permitted for the S8→S9 transition; the service rejects with **PolicyGateBlockedError**.

**Database (PostgreSQL)**

**No INSERT** into `dispute_gate_override_records` on rejected path.

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Dispute gate override is not available for S8→S9",
  "blockingCondition": "DISPUTE_OVERRIDE_NOT_AVAILABLE"
}
```
### ✅ S7→S8 — Progress S7→S8 after audit complete + H4 + override (HTTP 200)

**What is happening**

Successful **POST /entries/:id/progress-stage** with `targetStage: S8` and current `version`. The entry moves from **S7** to **S8**: closes the open S7 dwell record and opens an S8 dwell. Preconditions satisfied in this seed: **H4** exists in an allowed state, **night audit COMPLETE** for the last operating night before checkout, no deficient blocker, dispute gate cleared by GM override.

**Database (PostgreSQL)**

**UPDATE** `stage_dwell_records`: set `exited_at` on the active S7 row. **INSERT** `stage_dwell_records` for `stage = S8` with `entered_at`. **UPDATE** `entries`: `current_stage` → S8, `version` incremented, `updated_at` set.

**API response**

```json
{
  "id": "5f9a6d52-a1fa-4662-bf4e-a3a1a62a3c31",
  "inquiryId": "15e17650-b213-42be-be50-acbd965832cd",
  "guestProfileId": "d2123b16-085b-431e-82cc-cc71040c3ad2",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S8",
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z",
  "guestCount": 2,
  "otaSource": false,
  "createdAt": "2026-04-21T04:15:13.600Z",
  "updatedAt": "2026-04-21T04:15:28.483Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-21T04:15:13.598Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-21T04:15:13.598Z",
  "registrationCompletedBy": "actor-seed-system"
}
```
