# S7 test report

This report is produced by `back_end/scripts/s7-acceptance-tests.ts`. Each case below states **what** is being validated, **which HTTP call** is made (with actor headers), **what the backend checks**, and **which database tables** receive rows or updates when data is persisted.

**Prisma `@@map` → PostgreSQL table names** (use these in pgAdmin): `FolioLine` → `folio_lines`, `Folio` → `folios`, `NightAuditRecord` → `night_audit_records`, `NightAuditAnomaly` → `night_audit_anomalies`, `DisputeRecord` → `dispute_records`, `DisputeGateOverrideRecord` → `dispute_gate_override_records`, `Entry` → `entries`, `StageDwellRecord` → `stage_dwell_records`.

- **Ran at**: 2026-04-25T06:30:29.512Z
- **Base URL**: `http://localhost:4000/api`
- **Pass**: 27
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
  "id": "841e6caa-97b5-4c69-936b-734d7482df52",
  "operatingDate": "2026-04-20T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 2,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-25T06:30:29.098Z",
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
  "id": "66788ddb-24d9-4ad4-b6f4-2da865dc8656",
  "folioId": "ea3b3f87-83d4-4d13-be4d-f73f6b91b559",
  "lineType": "OTHER",
  "description": "Mini bar",
  "amount": "25",
  "currency": "BTN",
  "chargeDate": "2026-04-21T10:00:00.000Z",
  "stage": "S7",
  "postedBy": "test-fd-1",
  "nightAuditRecordId": null,
  "isPostStay": false,
  "postedAt": "2026-04-25T06:30:29.127Z",
  "createdAt": "2026-04-25T06:30:29.127Z"
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
  "id": "bc90bc6a-b8c6-4438-bef1-a057591c39d5",
  "folioId": "ea3b3f87-83d4-4d13-be4d-f73f6b91b559",
  "lineType": "OTHER",
  "description": "Correction for 66788ddb-24d9-4ad4-b6f4-2da865dc8656: Wrong amount",
  "amount": "-5",
  "currency": "BTN",
  "chargeDate": "2026-04-21T10:05:00.000Z",
  "stage": "S7",
  "postedBy": "test-fd-1",
  "nightAuditRecordId": null,
  "isPostStay": false,
  "postedAt": "2026-04-25T06:30:29.142Z",
  "createdAt": "2026-04-25T06:30:29.142Z"
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
  "id": "fd2a9362-d86e-4241-99f3-039e6a2f6abb",
  "operatingDate": "2026-04-21T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 2,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-25T06:30:29.153Z",
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

FolioLines for record: before=2, after=2

**API response**

```json
{
  "id": "fd2a9362-d86e-4241-99f3-039e6a2f6abb",
  "operatingDate": "2026-04-21T00:00:00.000Z",
  "runStatus": "COMPLETE",
  "entriesProcessedCount": 2,
  "entriesNotProcessed": [],
  "createdAt": "2026-04-25T06:30:29.153Z",
  "createdBy": "test-fom-1"
}
```
### ✅ AC-S7-06 — PARTIAL night audit escalates to FOM (HTTP 200)

**API response**

```json
{
  "record": {
    "id": "b0545e02-0a65-43e8-aa21-b1458921ef59",
    "operatingDate": "2026-04-23T00:00:00.000Z",
    "runStatus": "PARTIAL",
    "entriesProcessedCount": 2,
    "entriesNotProcessed": [
      "7663d158-e4e3-4823-bf3c-3176071f362f"
    ],
    "createdAt": "2026-04-25T06:30:29.191Z",
    "createdBy": "test-fom-1"
  },
  "escalated": {
    "id": "50a27b34-4a1e-4fe3-9390-0d94b12f250e",
    "eventType": "NIGHT_AUDIT.PARTIAL_FOM_ESCALATED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "NightAuditRecord",
    "entityId": "b0545e02-0a65-43e8-aa21-b1458921ef59",
    "operation": "ALERT",
    "payload": {
      "operatingDate": "2026-04-23T00:00:00.000Z",
      "entriesNotProcessed": [
        "7663d158-e4e3-4823-bf3c-3176071f362f"
      ]
    },
    "timestamp": "2026-04-25T06:30:29.198Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-04-25T06:30:29.199Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S7-07 — After COMPLETE night audit, next-day timers are recalculated (HTTP 200)

**API response**

```json
{
  "record": {
    "id": "f2f2094a-f4fe-4596-bd3e-2fb146b810c2",
    "operatingDate": "2026-04-24T00:00:00.000Z",
    "runStatus": "COMPLETE",
    "entriesProcessedCount": 2,
    "entriesNotProcessed": [],
    "createdAt": "2026-04-25T06:30:29.218Z",
    "createdBy": "test-fom-1"
  },
  "called": {
    "id": "3658d96e-03be-4803-8385-7ef014feb09b",
    "eventType": "TIMER_MANAGEMENT.RECALCULATE_NEXT_DAY_TIMERS_CALLED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "NightAuditRecord",
    "entityId": "2026-04-24T00:00:00.000Z",
    "operation": "ALERT",
    "payload": {
      "operatingDate": "2026-04-24T00:00:00.000Z"
    },
    "timestamp": "2026-04-25T06:30:29.222Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-04-25T06:30:29.223Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S7-15 — S7→S8 blocked when H4 not initiated (HTTP 409)

**API response**

```json
{
  "error": "StageGateBlockedError",
  "message": "H4 must be initiated before S7→S8",
  "blockingCondition": "H4_NOT_INITIATED"
}
```
### ✅ AC-S7-16 — Same-day departure auto-fulfils H4 (HTTP 200)

**API response**

```json
{
  "response": {
    "id": "2821513e-0c99-406c-b54e-c348b966c8e1",
    "inquiryId": "175c3752-959c-4920-bed9-2611d87edc18",
    "guestProfileId": "923c1538-5c07-4f55-8244-1d9faff65476",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S8",
    "walkInCompressed": false,
    "checkInDate": null,
    "checkOutDate": null,
    "guestCount": null,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-25T06:30:29.269Z",
    "updatedAt": "2026-04-25T06:30:29.291Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": null,
    "closedBy": null,
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null
  },
  "h4auto": {
    "id": "05de35dd-c097-4409-9588-03b9f91387da",
    "entryId": "2821513e-0c99-406c-b54e-c348b966c8e1",
    "handoffType": "H4",
    "state": "FULFILLED",
    "fromRole": "FRONT_DESK",
    "fromActorId": "test-fd-1",
    "toRole": "HOUSEKEEPING",
    "toActorId": null,
    "checklistContent": {
      "auto": true
    },
    "deficientConditionStatus": null,
    "fulfilmentEvidence": {
      "basis": "SAME_DAY_DEPARTURE",
      "autoFulfilled": true
    },
    "assignedAt": null,
    "acceptedAt": null,
    "acceptedBy": null,
    "fulfilledAt": "2026-04-25T06:30:29.291Z",
    "fulfilledBy": "SYSTEM",
    "closedAt": null,
    "rejectedAt": null,
    "rejectedBy": null,
    "rejectionReason": null,
    "escalatedAt": null,
    "cancelledAt": null,
    "cancelledBy": null,
    "cancelledReason": null,
    "slaDeadlineAt": null,
    "isAutoFulfilled": true,
    "createdAt": "2026-04-25T06:30:29.293Z",
    "createdBy": "test-fd-1",
    "stageContext": "S7"
  },
  "trace": {
    "id": "e13c359d-305b-43b2-843d-64eb761b18c7",
    "eventType": "HANDOFF.H4_AUTO_FULFILLED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "HandoffRecord",
    "entityId": "05de35dd-c097-4409-9588-03b9f91387da",
    "operation": "TRANSITION",
    "payload": {
      "basis": "SAME_DAY_DEPARTURE",
      "entryId": "2821513e-0c99-406c-b54e-c348b966c8e1",
      "handoffId": "05de35dd-c097-4409-9588-03b9f91387da"
    },
    "timestamp": "2026-04-25T06:30:29.291Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": "175c3752-959c-4920-bed9-2611d87edc18",
    "entryId": "2821513e-0c99-406c-b54e-c348b966c8e1",
    "createdAt": "2026-04-25T06:30:29.294Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S7-08 — 75% advisory writes threshold event and notice trace (HTTP 200)

**API response**

```json
{
  "r1": {
    "id": "529c1849-e569-4edc-a6b4-08669b8a77ef",
    "folioId": "c06eb247-e551-4af1-bfa8-741221f47c28",
    "lineType": "OTHER",
    "description": "Advisory charge",
    "amount": "80",
    "currency": "BTN",
    "chargeDate": "2026-04-25T12:00:00.000Z",
    "stage": "S7",
    "postedBy": "test-fd-1",
    "nightAuditRecordId": null,
    "isPostStay": false,
    "postedAt": "2026-04-25T06:30:29.323Z",
    "createdAt": "2026-04-25T06:30:29.323Z"
  },
  "ev75": {
    "id": "bdbab959-cbb3-4bfc-9e56-d3aee8784a0d",
    "entryId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
    "folioId": "c06eb247-e551-4af1-bfa8-741221f47c28",
    "ceilingAmount": "100",
    "outstandingBalance": "80",
    "thresholdPercent": 75,
    "createdAt": "2026-04-25T06:30:29.326Z",
    "createdBy": "test-fd-1"
  },
  "te75": {
    "id": "e87aa7ae-aaad-4f84-b5d4-a411c333202d",
    "eventType": "CREDIT_CEILING.THRESHOLD_75_ADVISORY",
    "actorId": "test-fd-1",
    "actorLevel": "SYSTEM",
    "entityType": "Entry",
    "entityId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
    "operation": "ALERT",
    "payload": {
      "ratio": 0.8,
      "entryId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
      "threshold": 0.75
    },
    "timestamp": "2026-04-25T06:30:29.328Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
    "createdAt": "2026-04-25T06:30:29.329Z",
    "createdBy": "test-fd-1"
  }
}
```
### ✅ AC-S7-09 — 90% threshold blocks until FOM acknowledges (HTTP 409)

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Credit ceiling 90% threshold reached — FOM acknowledgement required",
  "blockingCondition": "CREDIT_CEILING_ACTIVE_INTERRUPTION"
}
```
### ✅ AC-S7-09-ack — FOM acknowledgement recorded at 90% (HTTP 200)

**API response**

```json
{
  "r3": {
    "id": "e208b040-7554-40ad-b3ef-68e677efd720",
    "folioId": "c06eb247-e551-4af1-bfa8-741221f47c28",
    "lineType": "OTHER",
    "description": "90% ack by FOM",
    "amount": "15",
    "currency": "BTN",
    "chargeDate": "2026-04-25T12:11:00.000Z",
    "stage": "S7",
    "postedBy": "test-fom-1",
    "nightAuditRecordId": null,
    "isPostStay": false,
    "postedAt": "2026-04-25T06:30:29.347Z",
    "createdAt": "2026-04-25T06:30:29.347Z"
  },
  "ack90": {
    "id": "78fdded3-6c7f-4c58-af91-4a0ad935d6cb",
    "eventType": "CREDIT_CEILING.THRESHOLD_90_ACKNOWLEDGED",
    "actorId": "test-fom-1",
    "actorLevel": "SYSTEM",
    "entityType": "Entry",
    "entityId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
    "operation": "ALERT",
    "payload": {
      "ratio": 0.95,
      "entryId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
      "threshold": 0.9
    },
    "timestamp": "2026-04-25T06:30:29.352Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "51b0cab9-166d-48c8-a1bf-aaf0a0977000",
    "createdAt": "2026-04-25T06:30:29.353Z",
    "createdBy": "test-fom-1"
  }
}
```
### ✅ AC-S7-10 — 100% soft gate blocks non-mandatory charges without acknowledgement (HTTP 409)

**API response**

```json
{
  "r4": {
    "id": "164e8870-b2d9-4cc4-9d59-4d1389600b78",
    "folioId": "c06eb247-e551-4af1-bfa8-741221f47c28",
    "lineType": "OTHER",
    "description": "to 100",
    "amount": "10",
    "currency": "BTN",
    "chargeDate": "2026-04-25T12:12:00.000Z",
    "stage": "S7",
    "postedBy": "test-fom-1",
    "nightAuditRecordId": null,
    "isPostStay": false,
    "postedAt": "2026-04-25T06:30:29.361Z",
    "createdAt": "2026-04-25T06:30:29.361Z"
  },
  "r5": {
    "error": "PolicyGateBlockedError",
    "message": "Credit ceiling reached — FOM acknowledgement required for non-mandatory charges",
    "blockingCondition": "CREDIT_CEILING_SOFT_GATE"
  }
}
```
### ✅ AC-S7-11 — Mandatory ROOM_CHARGE posts even at ceiling 100% (HTTP 200)

**API response**

```json
{
  "id": "b91232fb-e645-4376-a4b2-8eabf197a081",
  "folioId": "c06eb247-e551-4af1-bfa8-741221f47c28",
  "lineType": "ROOM_CHARGE",
  "description": "Mandatory room charge",
  "amount": "1",
  "currency": "BTN",
  "chargeDate": "2026-04-25T12:14:00.000Z",
  "stage": "S7",
  "postedBy": "test-fd-1",
  "nightAuditRecordId": null,
  "isPostStay": false,
  "postedAt": "2026-04-25T06:30:29.378Z",
  "createdAt": "2026-04-25T06:30:29.378Z"
}
```
### ✅ AC-S7-14 — UNRESOLVED deficient is carried as DEFICIENT_UNRESOLVED_AT_CHECKOUT at S8 (HTTP 200)

**API response**

```json
{
  "response": {
    "id": "9c4b20c9-0a7d-44a3-8878-79f5660e705f",
    "inquiryId": "175c3752-959c-4920-bed9-2611d87edc18",
    "guestProfileId": "e133ac3f-164b-4591-b520-53fac6b1dfdf",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S8",
    "walkInCompressed": false,
    "checkInDate": null,
    "checkOutDate": null,
    "guestCount": null,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-25T06:30:29.394Z",
    "updatedAt": "2026-04-25T06:30:29.424Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": null,
    "closedBy": null,
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null
  },
  "defAfter": {
    "id": "2ec84b48-5a17-43c0-9222-6a68d6b41327",
    "roomId": "8c1b1bf8-1ea9-4e46-990c-5ac6e187c30a",
    "category": "HOUSEKEEPING",
    "description": "Carry to S8 test",
    "detectedAt": "2026-04-25T06:30:29.388Z",
    "detectedBy": "test",
    "resolutionDeadline": "2026-04-27T06:30:29.388Z",
    "resolvedAt": null,
    "resolvedBy": null,
    "resolutionNotes": null,
    "status": "DEFICIENT_UNRESOLVED_AT_CHECKOUT"
  }
}
```
### ✅ AC-S7-21 — Direct room assignment edit is rejected

**API response**

```json
{
  "directEditAllowed": false
}
```
### ✅ AC-S7-20/22/23 — Room change creates new segment, seals old, applies inventory transitions atomically (HTTP 200)

**API response**

```json
{
  "response": {
    "id": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "inquiryId": "175c3752-959c-4920-bed9-2611d87edc18",
    "guestProfileId": "d87cce9f-7a0b-479c-aaa3-ad2a0a4582ff",
    "segmentNumber": 2,
    "useType": "LEISURE",
    "status": "ACTIVE",
    "currentStage": "S1",
    "walkInCompressed": false,
    "checkInDate": null,
    "checkOutDate": null,
    "guestCount": null,
    "otaSource": false,
    "otaReference": null,
    "groupBillingMode": null,
    "parkedAt": null,
    "parkedBy": null,
    "parkedIndividually": false,
    "createdAt": "2026-04-25T06:30:29.437Z",
    "updatedAt": "2026-04-25T06:30:29.445Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": null,
    "closedBy": null,
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null
  },
  "seg1After": {
    "id": "40acd62c-9a55-44e4-99d6-58c44a3a6cf2",
    "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "segmentNumber": 1,
    "stage": "S7",
    "startedAt": "2026-04-25T06:30:29.439Z",
    "sealedAt": "2026-04-25T06:30:29.445Z",
    "sealedBy": "test-fom-1",
    "notes": null,
    "createdBy": "test"
  },
  "seg2": {
    "id": "cb36c1e5-db89-4109-ac54-f9ef2baa45b8",
    "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "segmentNumber": 2,
    "stage": "S7",
    "startedAt": "2026-04-25T06:30:29.450Z",
    "sealedAt": null,
    "sealedBy": null,
    "notes": null,
    "createdBy": "test-fom-1"
  },
  "oldRoomAfter": {
    "id": "962d37cf-1940-4ddb-914a-a53fb244549e",
    "roomNumber": "S7-RC-OLD-1777098629432",
    "roomTypeId": "2e911619-5fd6-49be-a0ea-99b62e2dcffa",
    "floorNumber": 7,
    "capacity": 2,
    "currentClaimState": "DEPARTED_DIRTY",
    "physicalState": "AVAILABLE_CLEAN",
    "expectedReadyAt": null,
    "isDeficient": false,
    "deficientConditionCategory": null,
    "deficientSince": null,
    "deficientDeadline": null,
    "isUnderMaintenance": false,
    "maintenanceDeadline": null,
    "cleansingRitualCompleted": false,
    "isBlocked": false,
    "blockedReason": null,
    "createdAt": "2026-04-25T06:30:29.434Z",
    "updatedAt": "2026-04-25T06:30:29.452Z"
  },
  "newRoomAfter": {
    "id": "c1190dad-acc1-4bad-90a8-34850d50a3a5",
    "roomNumber": "S7-RC-NEW-1777098629434",
    "roomTypeId": "2e911619-5fd6-49be-a0ea-99b62e2dcffa",
    "floorNumber": 7,
    "capacity": 2,
    "currentClaimState": "OCCUPIED",
    "physicalState": "AVAILABLE_CLEAN",
    "expectedReadyAt": null,
    "isDeficient": false,
    "deficientConditionCategory": null,
    "deficientSince": null,
    "deficientDeadline": null,
    "isUnderMaintenance": false,
    "maintenanceDeadline": null,
    "cleansingRitualCompleted": false,
    "isBlocked": false,
    "blockedReason": null,
    "createdAt": "2026-04-25T06:30:29.435Z",
    "updatedAt": "2026-04-25T06:30:29.454Z"
  },
  "evOld": {
    "id": "12d61712-aca3-4efa-a6b0-8c03f83ec734",
    "roomId": "962d37cf-1940-4ddb-914a-a53fb244549e",
    "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "fromState": "OCCUPIED",
    "toState": "DEPARTED_DIRTY",
    "actorId": "test-fom-1",
    "reason": "S7 room change re-entry",
    "effectiveFrom": "2026-04-25T06:30:29.453Z",
    "effectiveTo": null,
    "createdAt": "2026-04-25T06:30:29.453Z"
  },
  "evNew": {
    "id": "46c3d895-6a79-437e-a31b-8fceb2a76845",
    "roomId": "c1190dad-acc1-4bad-90a8-34850d50a3a5",
    "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "fromState": "CONFIRMED",
    "toState": "OCCUPIED",
    "actorId": "test-fom-1",
    "reason": "S7 room change re-entry",
    "effectiveFrom": "2026-04-25T06:30:29.455Z",
    "effectiveTo": null,
    "createdAt": "2026-04-25T06:30:29.455Z"
  },
  "cons": {
    "id": "960a2908-6304-4ffe-8b19-ac1c57c0df60",
    "eventType": "REENTRY.CONSEQUENCES_COMPUTED",
    "actorId": "test-fom-1",
    "actorLevel": "SYSTEM",
    "entityType": "Entry",
    "entityId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "operation": "ALERT",
    "payload": {
      "reason": "Guest requested move",
      "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
      "toStage": "S1",
      "fromStage": "S7"
    },
    "timestamp": "2026-04-25T06:30:29.446Z",
    "stageContext": "S7",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "a6672107-36fa-4d79-9475-da8d6cdcb38a",
    "createdAt": "2026-04-25T06:30:29.447Z",
    "createdBy": "test-fom-1"
  }
}
```
### ✅ AC-S7-24 — OCCUPIED→DEPARTED_CLEAN direct transition rejected

**API response**

```json
{
  "illegal": false
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
  "id": "95a8e817-e5d5-46f4-ab68-5182c2d2b26c",
  "entryId": "7fca7774-e243-4899-ace0-d0780689e25c",
  "folioId": "ea3b3f87-83d4-4d13-be4d-f73f6b91b559",
  "status": "OPEN",
  "title": "Charge dispute",
  "description": "Guest disputes minibar",
  "openedAt": "2026-04-25T06:30:29.477Z",
  "openedBy": "test-fd-1",
  "updatedAt": "2026-04-25T06:30:29.477Z",
  "updatedBy": null,
  "closedAt": null,
  "closedBy": null,
  "closureReason": null
}
```
### ✅ AC-S7-25 — S7→S8 requires version (optimistic lock guard) (HTTP 400)

**What is happening**

Calls **POST /entries/:id/progress-stage** with `targetStage: S8` but **omits** `version`. Per SIG AC-S7-25 / optimistic locking, the handler rejects the request immediately with **ValidationError** so the client must send the current `entries.version`.

**Database (PostgreSQL)**

**No database writes** — validation fails before transaction.

**API response**

```json
{
  "error": "ValidationError",
  "message": "version is required for S7→S8 progression"
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
  "id": "b0970ec1-6bfc-4906-8f4e-2ada039968f1",
  "disputeId": "95a8e817-e5d5-46f4-ab68-5182c2d2b26c",
  "targetStage": "S8",
  "freeTextReason": "GM override for checkout continuity",
  "createdAt": "2026-04-25T06:30:29.491Z",
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
  "id": "7fca7774-e243-4899-ace0-d0780689e25c",
  "inquiryId": "175c3752-959c-4920-bed9-2611d87edc18",
  "guestProfileId": "baf9f346-3eea-4147-a6df-e698db2410a7",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S8",
  "walkInCompressed": false,
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z",
  "guestCount": 2,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-04-25T06:30:27.755Z",
  "updatedAt": "2026-04-25T06:30:29.500Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T06:30:27.753Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T06:30:27.753Z",
  "registrationCompletedBy": "actor-seed-system"
}
```
### ✅ AC-S7-26 — No W34/W35 workers active at S7 in this slice

**API response**

```json
{
  "w34": null,
  "w35": null
}
```
