# S9 test report

- **Ran at**: 2026-05-13T12:18:44.747Z
- **Base URL**: `http://127.0.0.1:4069/api`
- **Pass**: 55
- **Fail**: 0

### ✅ SETUP-S7->S8 — Setup progress S7->S8 (HTTP 200)

```json
{
  "id": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "inquiryId": "36a9c520-b09a-4e4e-97b3-0ae4891d1a88",
  "guestProfileId": "e88e311d-490b-4e08-bd4a-096dcb87fc01",
  "segmentNumber": 1,
  "useType": "GROUP",
  "status": "ACTIVE",
  "currentStage": "S8",
  "walkInCompressed": false,
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z",
  "guestCount": 10,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-13T12:18:40.918Z",
  "updatedAt": "2026-05-13T12:18:43.361Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-05-13T12:18:40.916Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-05-13T12:18:40.916Z",
  "registrationCompletedBy": "actor-seed-system",
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ SETUP-S8-SETTLE — Setup settle to OUTSTANDING (HTTP 200)

```json
{
  "id": "4fbe2bd8-c162-40f3-b17d-54cd60abc9e4",
  "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "state": "OUTSTANDING",
  "billingModel": "DIRECT_BILL",
  "createdAt": "2026-05-13T12:18:40.926Z",
  "createdBy": "actor-seed-system",
  "convertedToLiveAt": "2026-05-13T12:18:40.924Z",
  "convertedBy": "actor-seed-system",
  "closedAt": "2026-05-13T12:18:43.423Z",
  "closedBy": "test-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "1200",
  "advancePaymentReconciliationComplete": true
}
```
### ✅ SETUP-S8->S9 — Setup progress S8->S9 (HTTP 200)

```json
{
  "id": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "inquiryId": "36a9c520-b09a-4e4e-97b3-0ae4891d1a88",
  "guestProfileId": "e88e311d-490b-4e08-bd4a-096dcb87fc01",
  "segmentNumber": 1,
  "useType": "GROUP",
  "status": "ACTIVE",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z",
  "guestCount": 10,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-13T12:18:40.918Z",
  "updatedAt": "2026-05-13T12:18:43.559Z",
  "createdBy": "actor-seed-system",
  "version": 3,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-05-13T12:18:40.916Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-05-13T12:18:40.916Z",
  "registrationCompletedBy": "actor-seed-system",
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S9-036 — post-stay charges require isPostStay=true (HTTP 400)

```json
{
  "error": "ValidationError",
  "message": "isPostStay must be true for S9 post-stay charge"
}
```
### ✅ AC-S9-037 — post-stay charge creates guest notification CommunicationRecord (HTTP 200)

```json
{
  "ok": {
    "id": "3f3e2cce-9aff-4e64-9212-5e4d2ed1a48a",
    "folioId": "4fbe2bd8-c162-40f3-b17d-54cd60abc9e4",
    "lineType": "OTHER",
    "description": "Post stay minibar",
    "amount": "10",
    "currency": "BTN",
    "chargeDate": "2026-05-13T12:18:43.578Z",
    "stage": "S9",
    "postedBy": "test-fom-1",
    "nightAuditRecordId": null,
    "isPostStay": true,
    "postedAt": "2026-05-13T12:18:43.578Z",
    "createdAt": "2026-05-13T12:18:43.584Z"
  },
  "comm": {
    "id": "311bdc2b-45fe-48c5-a331-7f9159a35eea",
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "channel": "EMAIL",
    "commType": "POST_STAY_CHARGE_NOTICE",
    "stageContext": null,
    "direction": "OUTBOUND",
    "messageId": null,
    "sendStatus": "PENDING",
    "acknowledgementStatus": "PENDING",
    "acknowledgementReceivedAt": null,
    "acknowledgementTimeoutAt": null,
    "threadId": null,
    "inReplyToId": null,
    "contentSummary": null,
    "actorId": null,
    "payload": {
      "amount": 10,
      "folioId": "4fbe2bd8-c162-40f3-b17d-54cd60abc9e4",
      "currency": "BTN",
      "folioLineId": "3f3e2cce-9aff-4e64-9212-5e4d2ed1a48a"
    },
    "createdAt": "2026-05-13T12:18:43.585Z",
    "createdBy": "test-fom-1"
  }
}
```
### ✅ AC-S9-003 — S9 FolioLine isPostStay=true and postedAt is transaction date

```json
{
  "id": "3f3e2cce-9aff-4e64-9212-5e4d2ed1a48a",
  "isPostStay": true,
  "postedAt": "2026-05-13T12:18:43.578Z"
}
```
### ✅ AC-S9-004 — S9 FolioLine not backdated into stay window

```json
{
  "postedAt": "2026-05-13T12:18:43.578Z",
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z"
}
```
### ✅ AC-S9-038 — write-off below L3 rejected (HTTP 403)

```json
{
  "error": "AuthorizationError",
  "message": "Insufficient authority"
}
```
### ✅ AC-S9-039 — write-off requires reason (HTTP 409)

```json
{
  "error": "PolicyGateBlockedError",
  "message": "reason is required",
  "blockingCondition": "WRITE_OFF_REASON_REQUIRED"
}
```
### ✅ AC-S9-009 — close blocked when dispute OPEN/IN_PROGRESS/REOPENED (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Cannot close entry with an open dispute",
  "blockingCondition": "DISPUTE_NOT_TERMINAL"
}
```
### ✅ AC-S9-017 — undispatched invoice blocks closure (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Undispatched invoice blocks closure",
  "blockingCondition": "INVOICE_NOT_DISPATCHED"
}
```
### ✅ AC-S9-018 — unmatched payment blocks closure (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Unmatched payment blocks closure",
  "blockingCondition": "PAYMENT_NOT_MATCHED"
}
```
### ✅ AC-S9-012 — OUTSTANDING with zero balance blocks closure (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "OUTSTANDING folio cannot have zero balance",
  "blockingCondition": "OUTSTANDING_ZERO_BALANCE"
}
```
### ✅ AC-S9-019 — OUTSTANDING closure schedules W8 follow-up (no CLOSED without W8/write-off) (HTTP 200)

```json
{
  "r": {
    "id": "48691f72-a6c6-48e6-9501-d8e233acfbe9",
    "inquiryId": "f68fa80d-81a3-42d0-b4fd-4df0c7c2d2f3",
    "guestProfileId": "30ee3855-4794-408b-9987-72fe51ecd277",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "CLOSED",
    "currentStage": "S9",
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
    "createdAt": "2026-05-13T12:18:43.864Z",
    "updatedAt": "2026-05-13T12:18:43.933Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-05-13T12:18:43.932Z",
    "closedBy": "test-fom-1",
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null,
    "apartmentDurationNights": null,
    "apartmentRateTierCode": null
  },
  "w8": {
    "id": "acaaddb8-ef63-4296-b02b-6d8b76a907d0",
    "dueAt": "2026-05-20T12:18:43.914Z"
  }
}
```
### ✅ AC-S9-020 — deferred inspection unresolved blocks closure (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Deferred inspection window not resolved",
  "blockingCondition": "INSPECTION_DEFERRED_UNRESOLVED"
}
```
### ✅ AC-S9-046 — H5 open blocks closure (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "H5 must be fulfilled/closed before entry closure",
  "blockingCondition": "H5_NOT_FULFILLED"
}
```
### ✅ AC-S9-045 — progress-stage S8->S9 requires version (HTTP 400)

```json
{
  "error": "ValidationError",
  "message": "version is required"
}
```
### ✅ AC-S9-011 — close succeeds when loop closure satisfied (HTTP 200)

```json
{
  "id": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "inquiryId": "36a9c520-b09a-4e4e-97b3-0ae4891d1a88",
  "guestProfileId": "e88e311d-490b-4e08-bd4a-096dcb87fc01",
  "segmentNumber": 1,
  "useType": "GROUP",
  "status": "CLOSED",
  "currentStage": "S9",
  "walkInCompressed": false,
  "checkInDate": "2026-04-20T09:00:00.000Z",
  "checkOutDate": "2026-04-22T09:00:00.000Z",
  "guestCount": 10,
  "otaSource": false,
  "otaReference": null,
  "groupBillingMode": null,
  "parkedAt": null,
  "parkedBy": null,
  "parkedIndividually": false,
  "createdAt": "2026-05-13T12:18:40.918Z",
  "updatedAt": "2026-05-13T12:18:44.020Z",
  "createdBy": "actor-seed-system",
  "version": 4,
  "closedAt": "2026-05-13T12:18:44.018Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-05-13T12:18:40.916Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-05-13T12:18:40.916Z",
  "registrationCompletedBy": "actor-seed-system",
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S9-007 — closedAt populated only for CLOSED

```json
{
  "status": "CLOSED",
  "closedAt": "2026-05-13T12:18:44.018Z"
}
```
### ✅ AC-S9-044 — ENTRY_CLOSED and FOLIO_SEALED trace events exist

```json
{
  "entryClosed": "dc5edd39-2c1c-45cd-b57e-2c540dac1f9b",
  "folioSealed": "713967a2-c839-4ad0-8e01-7244eca6e6ef"
}
```
### ✅ AC-S9-015 — progress-stage rejected for CLOSED entry (HTTP 409)

```json
{
  "error": "StateTransitionError",
  "message": "Cannot progress stage for CLOSED entry",
  "blockingCondition": "ENTRY_ALREADY_CLOSED"
}
```
### ✅ AC-S9-026 — W28 timer is scheduled after delay (not immediate)

```json
{
  "dueAt": "2026-05-13T13:18:44.008Z"
}
```
### ✅ AC-S9-027 — W28 writes exactly two CommunicationRecords (EMAIL + WHATSAPP)

```json
[
  {
    "id": "a551ba72-19d5-44f3-b699-9daa4e3dbe6f",
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "channel": "EMAIL",
    "commType": "FEEDBACK_SOLICITATION",
    "stageContext": "S9",
    "direction": "OUTBOUND",
    "messageId": null,
    "sendStatus": "PENDING",
    "acknowledgementStatus": "PENDING",
    "acknowledgementReceivedAt": null,
    "acknowledgementTimeoutAt": null,
    "threadId": null,
    "inReplyToId": null,
    "contentSummary": null,
    "actorId": null,
    "payload": {
      "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a"
    },
    "createdAt": "2026-05-13T12:18:44.054Z",
    "createdBy": "SYSTEM"
  },
  {
    "id": "97e972ad-735a-4416-8d50-96c2f11198a7",
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "channel": "WHATSAPP",
    "commType": "FEEDBACK_SOLICITATION",
    "stageContext": "S9",
    "direction": "OUTBOUND",
    "messageId": null,
    "sendStatus": "PENDING",
    "acknowledgementStatus": "PENDING",
    "acknowledgementReceivedAt": null,
    "acknowledgementTimeoutAt": null,
    "threadId": null,
    "inReplyToId": null,
    "contentSummary": null,
    "actorId": null,
    "payload": {
      "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a"
    },
    "createdAt": "2026-05-13T12:18:44.054Z",
    "createdBy": "SYSTEM"
  }
]
```
### ✅ AC-S9-028 — FEEDBACK.SOLICITATION_SENT trace lists both channels

```json
{
  "id": "41800eb2-7781-41c2-be0e-306153bd8532",
  "eventType": "FEEDBACK.SOLICITATION_SENT",
  "actorId": "SYSTEM",
  "actorLevel": "SYSTEM",
  "entityType": "Entry",
  "entityId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "operation": "ALERT",
  "payload": {
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "channelsDispatched": [
      "EMAIL",
      "WHATSAPP"
    ]
  },
  "timestamp": "2026-05-13T12:18:44.050Z",
  "stageContext": "S9",
  "segmentContext": null,
  "correlationId": null,
  "inquiryId": "36a9c520-b09a-4e4e-97b3-0ae4891d1a88",
  "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "createdAt": "2026-05-13T12:18:44.055Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-030 — W28 idempotent (no duplicates when trace exists)

```json
{
  "r1": {
    "skipped": false,
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "timerId": "5f79fcaf-a10b-41df-96d9-52b1ae7dbd4b"
  },
  "r2": {
    "skipped": true,
    "reason": "IDEMPOTENT_TRACE_EXISTS"
  },
  "comms2": 2
}
```
### ✅ AC-S9-013 — SETTLED while balance remains is forbidden

```json
{
  "ok": false
}
```
### ✅ AC-S9-016 — Room claim transitions to FREE at closure

```json
{
  "roomId": "9bd9b29e-ccea-4c85-8d99-dec069ff1541",
  "currentClaimState": "FREE"
}
```
### ✅ AC-S9-032 — Invoice reconciliation post-closure does not change EntryStatus (HTTP 200)

```json
{
  "invoice": {
    "id": "42f5a2b4-fa35-4dc6-a630-344d36769119",
    "folioId": "4fbe2bd8-c162-40f3-b17d-54cd60abc9e4",
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "invoiceType": "FINAL",
    "state": "RECONCILED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "final-v1",
    "issuedAt": "2026-05-13T12:18:43.421Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-05-13T12:18:43.421Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "updatedAt": "2026-05-13T12:18:44.069Z",
      "updatedBy": "test-fom-1",
      "paymentRef": "bank-123",
      "billingModel": "DIRECT_BILL",
      "referenceNumber": null,
      "settlementMethod": "DIRECT_BILL",
      "proofAttachmentId": null,
      "outstandingBalance": "1200"
    },
    "createdAt": "2026-05-13T12:18:43.422Z"
  },
  "entryStatus": "CLOSED"
}
```
### ✅ AC-S9-042 — Cannot modify existing FolioLine after closure

```json
{
  "updated": false
}
```
### ✅ AC-S9-043 — L2 can add post-closure FolioLine via /charges at S9 (HTTP 200)

```json
{
  "id": "0fedb9d5-a45c-4b3e-89b4-5f63757adb94",
  "folioId": "4fbe2bd8-c162-40f3-b17d-54cd60abc9e4",
  "lineType": "OTHER",
  "description": "After close adjustment",
  "amount": "1",
  "currency": "BTN",
  "chargeDate": "2026-05-13T12:18:44.075Z",
  "stage": "S9",
  "postedBy": "test-fom-1",
  "nightAuditRecordId": null,
  "isPostStay": true,
  "postedAt": "2026-05-13T12:18:44.075Z",
  "createdAt": "2026-05-13T12:18:44.081Z"
}
```
### ✅ AC-S9-002 — No CommissionDueRecord when agent has no commissionRate (HTTP 200)

```json
{
  "rec": null
}
```
### ✅ AC-S9-021 — Closure not blocked when agent commissionRate absent (HTTP 200)

```json
{
  "id": "b8feac84-1b4e-4a21-a82a-3f07dcce0d8e",
  "inquiryId": "28596aab-b73d-43aa-a9c6-e5911717e27a",
  "guestProfileId": "d8912a14-b9af-44cc-b33d-aa3c0c3a6f52",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "CLOSED",
  "currentStage": "S9",
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
  "createdAt": "2026-05-13T12:18:44.092Z",
  "updatedAt": "2026-05-13T12:18:44.125Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-05-13T12:18:44.124Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null,
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S9-001 — CommissionDueRecord exists when commissionRate configured (HTTP 200)

```json
{
  "id": "6416fc7f-2a1b-43f7-8d34-b11595e594dd",
  "entryId": "1adfa48d-375a-4000-bead-155a058f40d9",
  "agentProfileId": "42a14bd7-ea7f-4058-bfb7-661f8ae44d6c",
  "commissionRate": "0.1",
  "commissionBasis": "TOTAL_FOLIO",
  "calculatedAmount": "10",
  "currency": "BTN",
  "status": "PENDING",
  "createdAt": "2026-05-13T12:18:44.169Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-022 — CommissionDueRecord created with status PENDING when basis configured

```json
{
  "id": "6416fc7f-2a1b-43f7-8d34-b11595e594dd",
  "entryId": "1adfa48d-375a-4000-bead-155a058f40d9",
  "agentProfileId": "42a14bd7-ea7f-4058-bfb7-661f8ae44d6c",
  "commissionRate": "0.1",
  "commissionBasis": "TOTAL_FOLIO",
  "calculatedAmount": "10",
  "currency": "BTN",
  "status": "PENDING",
  "createdAt": "2026-05-13T12:18:44.169Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-023 — RATE_MISSING CommissionDueRecord schedules W11 (HTTP 200)

```json
{
  "rec": {
    "id": "ba7a7faa-6818-4639-88a8-16abfabdca4b",
    "entryId": "64bb08b7-d3b9-4e3c-8041-ff752d9e4f04",
    "agentProfileId": "5c5703bb-8e39-4bc1-a9ce-f66398282a9f",
    "commissionRate": "0.1",
    "commissionBasis": null,
    "calculatedAmount": null,
    "currency": "BTN",
    "status": "RATE_MISSING",
    "createdAt": "2026-05-13T12:18:44.220Z",
    "createdBy": "SYSTEM"
  },
  "w11": {
    "id": "1626937f-e502-448e-8464-56711c6b7e83",
    "entryId": "64bb08b7-d3b9-4e3c-8041-ff752d9e4f04",
    "entityType": "CommissionDueRecord",
    "entityId": "ba7a7faa-6818-4639-88a8-16abfabdca4b",
    "timerType": "COMMISSION_RATE_MISSING_W11",
    "timerCode": "COMMISSION_RATE_MISSING_W11",
    "stageContext": null,
    "firesAt": "2026-05-13T12:19:44.218Z",
    "dueAt": "2026-05-13T12:19:44.218Z",
    "warningAt": null,
    "criticalAt": null,
    "status": "SCHEDULED",
    "payload": {
      "entryId": "64bb08b7-d3b9-4e3c-8041-ff752d9e4f04",
      "timerRecordId": "1626937f-e502-448e-8464-56711c6b7e83",
      "commissionDueId": "ba7a7faa-6818-4639-88a8-16abfabdca4b"
    },
    "pgBossJobId": "18a5eab8-8cad-47df-9cf6-9b5fcb542873",
    "cancelledAt": null,
    "cancelledBy": null,
    "cancelledReason": null,
    "firedAt": null,
    "createdAt": "2026-05-13T12:18:44.225Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S9-024 — W11 emits COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED

```json
{
  "out": {
    "skipped": false,
    "commissionDueId": "ba7a7faa-6818-4639-88a8-16abfabdca4b"
  },
  "te": {
    "id": "8293c5e4-baf2-40e7-a5eb-1b89bf7921ef",
    "eventType": "COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "CommissionDueRecord",
    "entityId": "ba7a7faa-6818-4639-88a8-16abfabdca4b",
    "operation": "ALERT",
    "payload": {
      "entryId": "64bb08b7-d3b9-4e3c-8041-ff752d9e4f04",
      "commissionDueId": "ba7a7faa-6818-4639-88a8-16abfabdca4b"
    },
    "timestamp": "2026-05-13T12:18:44.242Z",
    "stageContext": "S9",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "64bb08b7-d3b9-4e3c-8041-ff752d9e4f04",
    "createdAt": "2026-05-13T12:18:44.243Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S9-025 — W11 does not fire when no CommissionDueRecord exists

```json
{
  "skipped": true,
  "reason": "COMMISSION_DUE_NOT_FOUND"
}
```
### ✅ AC-S9-048 — FollowUpTaskRecord exists for CONFERENCE closure and dueAt is set

```json
{
  "id": "70671fde-9080-48b2-9afb-05c5764642c9",
  "entryId": "cd4c66e3-c669-416f-978b-65780784003c",
  "status": "PENDING",
  "assignedTo": null,
  "dueAt": "2026-05-20T12:18:44.277Z",
  "completedAt": null,
  "completedBy": null,
  "notes": null,
  "createdAt": "2026-05-13T12:18:44.278Z",
  "createdBy": "system"
}
```
### ✅ AC-S9-005 — FollowUpTaskRecord exists for GROUP closure

```json
{
  "id": "37c44c4b-61ba-4491-9b25-f26edd616116",
  "entryId": "47916efc-6ef6-4246-a80c-2d549b088a0d",
  "status": "PENDING",
  "assignedTo": null,
  "dueAt": "2026-05-20T12:18:44.324Z",
  "completedAt": null,
  "completedBy": null,
  "notes": null,
  "createdAt": "2026-05-13T12:18:44.326Z",
  "createdBy": "system"
}
```
### ✅ AC-S9-005b — No FollowUpTaskRecord for non GROUP/CONFERENCE

```json
{
  "fu3": null
}
```
### ✅ AC-S9-031a — Government DISPATCHED blocks closure until PAYMENT_TRACKED (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Government invoice must be PAYMENT_TRACKED before closure",
  "blockingCondition": "GOV_PAYMENT_NOT_TRACKED"
}
```
### ✅ AC-S9-031 — Government closure succeeds at PAYMENT_TRACKED (no RECONCILED required) (HTTP 200)

```json
{
  "id": "7177bf84-2756-4f9d-a27c-c0bff6662153",
  "inquiryId": "27567ebc-1138-423f-9185-570dddb6b53f",
  "guestProfileId": "dbfb35bc-d4d3-4b52-a859-0e75806b91ec",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "CLOSED",
  "currentStage": "S9",
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
  "createdAt": "2026-05-13T12:18:44.394Z",
  "updatedAt": "2026-05-13T12:18:44.439Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-05-13T12:18:44.437Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null,
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S9-029 — No-show closure does not schedule W28 (HTTP 200)

```json
{
  "r": {
    "id": "9cfc871c-9704-492b-8a40-342843196aff",
    "inquiryId": "27567ebc-1138-423f-9185-570dddb6b53f",
    "guestProfileId": "bedd2712-dae6-4629-b29b-51bd49e2a83a",
    "segmentNumber": 1,
    "useType": "LEISURE",
    "status": "CLOSED",
    "currentStage": "S9",
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
    "createdAt": "2026-05-13T12:18:44.447Z",
    "updatedAt": "2026-05-13T12:18:44.482Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-05-13T12:18:44.481Z",
    "closedBy": "test-fom-1",
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null,
    "apartmentDurationNights": null,
    "apartmentRateTierCode": null
  },
  "w28": null
}
```
### ✅ AC-S9-033 — No-show retained penalty creates penalty invoice before closure (HTTP 200)

```json
{
  "inv": {
    "id": "6e8a69d5-645a-420a-bca2-817811965143",
    "folioId": "4d5b5e86-8521-412d-9e63-6e4f745de7bb",
    "entryId": "5b77a415-a265-4e98-bebc-9a21dc302342",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": null,
    "issuedAt": "2026-05-13T12:18:44.498Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-05-13T12:18:44.498Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "noShowDeterminationId": "e51e5b93-2852-4a22-a33d-8c3eb32e8689"
    },
    "createdAt": "2026-05-13T12:18:44.499Z"
  }
}
```
### ✅ AC-S9-035a — No-show S9 invoice carries NoShowDeterminationRecord reference

```json
{
  "id": "6e8a69d5-645a-420a-bca2-817811965143",
  "folioId": "4d5b5e86-8521-412d-9e63-6e4f745de7bb",
  "entryId": "5b77a415-a265-4e98-bebc-9a21dc302342",
  "invoiceType": "FINAL",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": null,
  "issuedAt": "2026-05-13T12:18:44.498Z",
  "issuedBy": "test-fd-1",
  "dispatchedAt": "2026-05-13T12:18:44.498Z",
  "dispatchedBy": "test-fd-1",
  "dispatchedTo": null,
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "noShowDeterminationId": "e51e5b93-2852-4a22-a33d-8c3eb32e8689"
  },
  "createdAt": "2026-05-13T12:18:44.499Z"
}
```
### ✅ AC-S9-034 — No-show refund obligation confirms outgoing PaymentRecord before closure (HTTP 200)

```json
{
  "pay": {
    "id": "c73b94b6-344f-4b1b-931f-d1c0fae326c3",
    "folioId": "5f573810-19c6-4b27-a175-433806a6b959",
    "invoiceId": null,
    "entryId": "1aa77e99-41df-4ada-9932-3c4caac36927",
    "amount": "15",
    "currency": "BTN",
    "foreignCurrencyAmount": null,
    "btnEquivalent": null,
    "exchangeRate": null,
    "paymentMethod": "CASH",
    "paymentDirection": "OUT",
    "createdAt": "2026-05-13T12:18:44.550Z",
    "receivedAt": null,
    "recordedBy": "test-fom-1",
    "stage": "S9",
    "notes": "NO_SHOW_REFUND:16ac8aa5-9e6e-4f2c-b679-8e76a3e7e4d6"
  }
}
```
### ✅ AC-S9-035b — No-show refund PaymentRecord carries NoShowDeterminationRecord reference

```json
{
  "id": "c73b94b6-344f-4b1b-931f-d1c0fae326c3",
  "folioId": "5f573810-19c6-4b27-a175-433806a6b959",
  "invoiceId": null,
  "entryId": "1aa77e99-41df-4ada-9932-3c4caac36927",
  "amount": "15",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "OUT",
  "createdAt": "2026-05-13T12:18:44.550Z",
  "receivedAt": null,
  "recordedBy": "test-fom-1",
  "stage": "S9",
  "notes": "NO_SHOW_REFUND:16ac8aa5-9e6e-4f2c-b679-8e76a3e7e4d6"
}
```
### ✅ AC-S9-040 — write-off exceeding authority band is blocked (HTTP 409)

```json
{
  "error": "PolicyGateBlockedError",
  "message": "write-off amount exceeds GM authority band",
  "blockingCondition": "WRITE_OFF_EXCEEDS_AUTHORITY_BAND"
}
```
### ✅ AC-S9-006 — WriteOffRecord exists with non-empty reason when folio WRITTEN_OFF

```json
{
  "id": "f4f8658a-e36d-4f90-b9c8-d2540b5192af",
  "folioId": "c5864016-d438-425d-aad0-3bb9f309f1b3",
  "entryId": "3e880fe5-8d2d-499e-94a9-847fe3d7f43d",
  "writtenOffAmount": "4000",
  "currency": "BTN",
  "reason": "uncollectable",
  "createdAt": "2026-05-13T12:18:44.589Z",
  "createdBy": "test-gm-1"
}
```
### ✅ AC-S9-041 — After write-off, folio is WRITTEN_OFF and record preserves amount (HTTP 200)

```json
{
  "folio": {
    "id": "c5864016-d438-425d-aad0-3bb9f309f1b3",
    "entryId": "3e880fe5-8d2d-499e-94a9-847fe3d7f43d",
    "state": "WRITTEN_OFF",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-05-13T12:18:44.579Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-05-13T12:18:44.579Z",
    "convertedBy": "test",
    "closedAt": null,
    "closedBy": null,
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "0",
    "advancePaymentReconciliationComplete": false
  },
  "rec": {
    "id": "f4f8658a-e36d-4f90-b9c8-d2540b5192af",
    "folioId": "c5864016-d438-425d-aad0-3bb9f309f1b3",
    "entryId": "3e880fe5-8d2d-499e-94a9-847fe3d7f43d",
    "writtenOffAmount": "4000",
    "currency": "BTN",
    "reason": "uncollectable",
    "createdAt": "2026-05-13T12:18:44.589Z",
    "createdBy": "test-gm-1"
  }
}
```
### ✅ AC-S9-014 — Dispute gate override rejected for targetStage S9 (HTTP 409)

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Dispute gate override is not available for S8→S9",
  "blockingCondition": "DISPUTE_OVERRIDE_NOT_AVAILABLE"
}
```
### ✅ AC-S9-049a — Apartment closure blocked when deposit not resolved (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Apartment security deposit not resolved",
  "blockingCondition": "SECURITY_DEPOSIT_NOT_RESOLVED"
}
```
### ✅ AC-S9-049 — Apartment closure succeeds when deposit return recorded (HTTP 200)

```json
{
  "id": "6e09ecc4-3a31-477c-bc0a-4ef544e015e8",
  "inquiryId": "27567ebc-1138-423f-9185-570dddb6b53f",
  "guestProfileId": "cc5a3e8f-5809-4d9c-8e1d-87ae8ef724e7",
  "segmentNumber": 1,
  "useType": "APARTMENT",
  "status": "CLOSED",
  "currentStage": "S9",
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
  "createdAt": "2026-05-13T12:18:44.624Z",
  "updatedAt": "2026-05-13T12:18:44.675Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-05-13T12:18:44.673Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null,
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S9-050a — Catering closure blocked when equipment return unresolved (HTTP 409)

```json
{
  "error": "StageGateBlockedError",
  "message": "Equipment return not resolved",
  "blockingCondition": "EQUIPMENT_RETURN_NOT_RESOLVED"
}
```
### ✅ AC-S9-050 — Equipment breach surfaces + resolution event allows closure (HTTP 200)

```json
{
  "ok": {
    "id": "1918b5fb-a1a3-4bd2-97de-a775be49365e",
    "inquiryId": "27567ebc-1138-423f-9185-570dddb6b53f",
    "guestProfileId": "0173e8a0-714d-4b79-b056-f8a55d64768d",
    "segmentNumber": 1,
    "useType": "CATERING",
    "status": "CLOSED",
    "currentStage": "S9",
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
    "createdAt": "2026-05-13T12:18:44.685Z",
    "updatedAt": "2026-05-13T12:18:44.739Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-05-13T12:18:44.737Z",
    "closedBy": "test-fom-1",
    "noShowCutoffReachedAt": null,
    "creditCeilingTier2AcknowledgedAt": null,
    "creditCeilingTier2AcknowledgedBy": null,
    "awaitingWrittenConfirmationActive": false,
    "keysIssuedAt": null,
    "keysIssuedCount": null,
    "keysIssuedBy": null,
    "registrationCompletedAt": null,
    "registrationCompletedBy": null,
    "apartmentDurationNights": null,
    "apartmentRateTierCode": null
  },
  "breach": {
    "id": "24d9e46d-217b-4952-ba41-d963a8d9e0ef",
    "eventType": "EQUIPMENT_RETURN.DEADLINE_BREACHED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "EquipmentAllocation",
    "entityId": "a287e06c-b4ff-4c79-8aeb-bc90577af02f",
    "operation": "ALERT",
    "payload": {
      "entryId": "1918b5fb-a1a3-4bd2-97de-a775be49365e",
      "equipmentCode": "CHAIR_10",
      "equipmentAllocationId": "a287e06c-b4ff-4c79-8aeb-bc90577af02f"
    },
    "timestamp": "2026-05-13T12:18:44.708Z",
    "stageContext": "S9",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "1918b5fb-a1a3-4bd2-97de-a775be49365e",
    "createdAt": "2026-05-13T12:18:44.710Z",
    "createdBy": "SYSTEM"
  }
}
```
