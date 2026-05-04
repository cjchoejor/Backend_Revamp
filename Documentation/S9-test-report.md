# S9 test report

- **Ran at**: 2026-04-25T10:27:54.351Z
- **Base URL**: `http://localhost:4000/api`
- **Pass**: 55
- **Fail**: 0

### ✅ SETUP-S7->S8 — Setup progress S7->S8 (HTTP 200)

```json
{
  "id": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "inquiryId": "408d0088-fe21-4b6c-ba3b-d396437a2222",
  "guestProfileId": "bba8fc67-2510-42e7-b4c2-74d775309c52",
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
  "createdAt": "2026-04-25T10:27:51.477Z",
  "updatedAt": "2026-04-25T10:27:53.120Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T10:27:51.475Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T10:27:51.475Z",
  "registrationCompletedBy": "actor-seed-system"
}
```
### ✅ SETUP-S8-SETTLE — Setup settle to OUTSTANDING (HTTP 200)

```json
{
  "id": "92638d4c-edb8-4d4e-977d-383659536a1f",
  "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "state": "OUTSTANDING",
  "billingModel": "DIRECT_BILL",
  "createdAt": "2026-04-25T10:27:51.486Z",
  "createdBy": "actor-seed-system",
  "convertedToLiveAt": "2026-04-25T10:27:51.485Z",
  "convertedBy": "actor-seed-system",
  "closedAt": "2026-04-25T10:27:53.215Z",
  "closedBy": "test-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "50",
  "advancePaymentReconciliationComplete": true
}
```
### ✅ SETUP-S8->S9 — Setup progress S8->S9 (HTTP 200)

```json
{
  "id": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "inquiryId": "408d0088-fe21-4b6c-ba3b-d396437a2222",
  "guestProfileId": "bba8fc67-2510-42e7-b4c2-74d775309c52",
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
  "createdAt": "2026-04-25T10:27:51.477Z",
  "updatedAt": "2026-04-25T10:27:53.270Z",
  "createdBy": "actor-seed-system",
  "version": 3,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T10:27:51.475Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T10:27:51.475Z",
  "registrationCompletedBy": "actor-seed-system"
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
    "id": "b05e43ca-da56-464f-8a2a-29dc90b6cb9d",
    "folioId": "92638d4c-edb8-4d4e-977d-383659536a1f",
    "lineType": "OTHER",
    "description": "Post stay minibar",
    "amount": "10",
    "currency": "BTN",
    "chargeDate": "2026-04-25T10:27:53.285Z",
    "stage": "S9",
    "postedBy": "test-fom-1",
    "nightAuditRecordId": null,
    "isPostStay": true,
    "postedAt": "2026-04-25T10:27:53.285Z",
    "createdAt": "2026-04-25T10:27:53.294Z"
  },
  "comm": {
    "id": "258e722e-fb08-46dc-908d-c51dc5814c1e",
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
      "folioId": "92638d4c-edb8-4d4e-977d-383659536a1f",
      "currency": "BTN",
      "folioLineId": "b05e43ca-da56-464f-8a2a-29dc90b6cb9d"
    },
    "createdAt": "2026-04-25T10:27:53.295Z",
    "createdBy": "test-fom-1"
  }
}
```
### ✅ AC-S9-003 — S9 FolioLine isPostStay=true and postedAt is transaction date

```json
{
  "id": "b05e43ca-da56-464f-8a2a-29dc90b6cb9d",
  "isPostStay": true,
  "postedAt": "2026-04-25T10:27:53.285Z"
}
```
### ✅ AC-S9-004 — S9 FolioLine not backdated into stay window

```json
{
  "postedAt": "2026-04-25T10:27:53.285Z",
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
    "id": "534a7c65-27a5-43a7-b769-3c888cd23f5f",
    "inquiryId": "12e9fa75-c6a7-4c7d-a642-0af5f0bf5f16",
    "guestProfileId": "41437dca-5838-47cf-9a58-38bd3b5aba8a",
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
    "createdAt": "2026-04-25T10:27:53.443Z",
    "updatedAt": "2026-04-25T10:27:53.513Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-04-25T10:27:53.511Z",
    "closedBy": "test-fom-1",
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
  "w8": {
    "id": "75e4dcfd-3eb4-430a-8ce2-2ccbf77520bf",
    "dueAt": "2026-05-02T10:27:53.496Z"
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
  "inquiryId": "408d0088-fe21-4b6c-ba3b-d396437a2222",
  "guestProfileId": "bba8fc67-2510-42e7-b4c2-74d775309c52",
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
  "createdAt": "2026-04-25T10:27:51.477Z",
  "updatedAt": "2026-04-25T10:27:53.611Z",
  "createdBy": "actor-seed-system",
  "version": 4,
  "closedAt": "2026-04-25T10:27:53.610Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T10:27:51.475Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T10:27:51.475Z",
  "registrationCompletedBy": "actor-seed-system"
}
```
### ✅ AC-S9-007 — closedAt populated only for CLOSED

```json
{
  "status": "CLOSED",
  "closedAt": "2026-04-25T10:27:53.610Z"
}
```
### ✅ AC-S9-044 — ENTRY_CLOSED and FOLIO_SEALED trace events exist

```json
{
  "entryClosed": "d21cc2fa-d606-4071-88f7-d585387306de",
  "folioSealed": "038ef35a-b682-4873-9e81-7c5cf13d23cc"
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
  "dueAt": "2026-04-25T11:27:53.602Z"
}
```
### ✅ AC-S9-027 — W28 writes exactly two CommunicationRecords (EMAIL + WHATSAPP)

```json
[
  {
    "id": "6c1eb7d6-069f-40b5-938c-cbc5ac1929ae",
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
    "createdAt": "2026-04-25T10:27:53.636Z",
    "createdBy": "SYSTEM"
  },
  {
    "id": "66c3799b-8606-49e8-8822-f280adab01fd",
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
    "createdAt": "2026-04-25T10:27:53.636Z",
    "createdBy": "SYSTEM"
  }
]
```
### ✅ AC-S9-028 — FEEDBACK.SOLICITATION_SENT trace lists both channels

```json
{
  "id": "995dc78e-8644-459a-9683-d48a475e300b",
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
  "timestamp": "2026-04-25T10:27:53.632Z",
  "stageContext": "S9",
  "segmentContext": null,
  "correlationId": null,
  "inquiryId": "408d0088-fe21-4b6c-ba3b-d396437a2222",
  "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
  "createdAt": "2026-04-25T10:27:53.638Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-030 — W28 idempotent (no duplicates when trace exists)

```json
{
  "r1": {
    "skipped": false,
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "timerId": "4a68efb1-89f6-485a-a76d-810600deaff2"
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
  "roomId": "ef0a3811-7b60-4133-b72e-c9c1c5eda398",
  "currentClaimState": "FREE"
}
```
### ✅ AC-S9-032 — Invoice reconciliation post-closure does not change EntryStatus (HTTP 200)

```json
{
  "invoice": {
    "id": "68a6a5e9-45f3-4f0c-8d1e-e62c776fc1de",
    "folioId": "92638d4c-edb8-4d4e-977d-383659536a1f",
    "entryId": "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
    "invoiceType": "FINAL",
    "state": "RECONCILED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "final-v1",
    "issuedAt": "2026-04-25T10:27:53.204Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-04-25T10:27:53.204Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "updatedAt": "2026-04-25T10:27:53.652Z",
      "updatedBy": "test-fom-1",
      "paymentRef": "bank-123",
      "billingModel": "DIRECT_BILL",
      "settlementMethod": "DIRECT_BILL",
      "outstandingBalance": "50"
    },
    "createdAt": "2026-04-25T10:27:53.205Z"
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
  "id": "0b4e2653-840b-4916-bc40-47ed401dfa0f",
  "folioId": "92638d4c-edb8-4d4e-977d-383659536a1f",
  "lineType": "OTHER",
  "description": "After close adjustment",
  "amount": "1",
  "currency": "BTN",
  "chargeDate": "2026-04-25T10:27:53.656Z",
  "stage": "S9",
  "postedBy": "test-fom-1",
  "nightAuditRecordId": null,
  "isPostStay": true,
  "postedAt": "2026-04-25T10:27:53.656Z",
  "createdAt": "2026-04-25T10:27:53.664Z"
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
  "id": "d227aee6-2fc8-4bc5-adb5-77d04b50b932",
  "inquiryId": "a166647b-e7c0-4faf-be8c-96677f26636a",
  "guestProfileId": "196222a5-e6b6-4a6b-be36-be3248dfbf52",
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
  "createdAt": "2026-04-25T10:27:53.678Z",
  "updatedAt": "2026-04-25T10:27:53.711Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-04-25T10:27:53.710Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null
}
```
### ✅ AC-S9-001 — CommissionDueRecord exists when commissionRate configured (HTTP 200)

```json
{
  "id": "bbf650cc-44c8-45f5-bdc2-a842ea0400e8",
  "entryId": "f5f97b60-864a-48fe-92ed-5d361028032d",
  "agentProfileId": "fb994138-5580-4bc7-b139-54a10639eea4",
  "commissionRate": "0.1",
  "commissionBasis": "TOTAL_FOLIO",
  "calculatedAmount": "10",
  "currency": "BTN",
  "status": "PENDING",
  "createdAt": "2026-04-25T10:27:53.760Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-022 — CommissionDueRecord created with status PENDING when basis configured

```json
{
  "id": "bbf650cc-44c8-45f5-bdc2-a842ea0400e8",
  "entryId": "f5f97b60-864a-48fe-92ed-5d361028032d",
  "agentProfileId": "fb994138-5580-4bc7-b139-54a10639eea4",
  "commissionRate": "0.1",
  "commissionBasis": "TOTAL_FOLIO",
  "calculatedAmount": "10",
  "currency": "BTN",
  "status": "PENDING",
  "createdAt": "2026-04-25T10:27:53.760Z",
  "createdBy": "SYSTEM"
}
```
### ✅ AC-S9-023 — RATE_MISSING CommissionDueRecord schedules W11 (HTTP 200)

```json
{
  "rec": {
    "id": "776e7e9e-500e-4a7f-ac98-1d3899185787",
    "entryId": "80130067-845d-41bd-8eaa-cf8599221cf9",
    "agentProfileId": "0a8d3a12-9676-4f78-9ed1-c3ec33fd73b1",
    "commissionRate": "0.1",
    "commissionBasis": null,
    "calculatedAmount": null,
    "currency": "BTN",
    "status": "RATE_MISSING",
    "createdAt": "2026-04-25T10:27:53.804Z",
    "createdBy": "SYSTEM"
  },
  "w11": {
    "id": "ca5f14f4-dd56-439c-a691-93fa277eff9a",
    "entryId": "80130067-845d-41bd-8eaa-cf8599221cf9",
    "entityType": "CommissionDueRecord",
    "entityId": "776e7e9e-500e-4a7f-ac98-1d3899185787",
    "timerType": "COMMISSION_RATE_MISSING_W11",
    "timerCode": "COMMISSION_RATE_MISSING_W11",
    "stageContext": null,
    "firesAt": "2026-04-25T10:28:53.803Z",
    "dueAt": "2026-04-25T10:28:53.803Z",
    "warningAt": null,
    "criticalAt": null,
    "status": "SCHEDULED",
    "payload": {
      "entryId": "80130067-845d-41bd-8eaa-cf8599221cf9",
      "commissionDueId": "776e7e9e-500e-4a7f-ac98-1d3899185787"
    },
    "pgBossJobId": null,
    "cancelledAt": null,
    "cancelledBy": null,
    "cancelledReason": null,
    "firedAt": null,
    "createdAt": "2026-04-25T10:27:53.808Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S9-024 — W11 emits COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED

```json
{
  "out": {
    "skipped": false,
    "commissionDueId": "776e7e9e-500e-4a7f-ac98-1d3899185787"
  },
  "te": {
    "id": "3ba50776-f1da-4e1b-b6e0-3882d28e672a",
    "eventType": "COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "CommissionDueRecord",
    "entityId": "776e7e9e-500e-4a7f-ac98-1d3899185787",
    "operation": "ALERT",
    "payload": {
      "entryId": "80130067-845d-41bd-8eaa-cf8599221cf9",
      "commissionDueId": "776e7e9e-500e-4a7f-ac98-1d3899185787"
    },
    "timestamp": "2026-04-25T10:27:53.822Z",
    "stageContext": "S9",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "80130067-845d-41bd-8eaa-cf8599221cf9",
    "createdAt": "2026-04-25T10:27:53.825Z",
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
  "id": "57362e1c-cd63-4654-b572-c0231152e31e",
  "entryId": "c2e9d909-6323-4e53-857f-17d4191d055b",
  "status": "PENDING",
  "assignedTo": null,
  "dueAt": "2026-05-02T10:27:53.862Z",
  "completedAt": null,
  "completedBy": null,
  "notes": null,
  "createdAt": "2026-04-25T10:27:53.863Z",
  "createdBy": "system"
}
```
### ✅ AC-S9-005 — FollowUpTaskRecord exists for GROUP closure

```json
{
  "id": "b565163d-a835-4267-b6c4-4b0d76490204",
  "entryId": "7021c8fe-370f-4d26-9e9a-5253780d6692",
  "status": "PENDING",
  "assignedTo": null,
  "dueAt": "2026-05-02T10:27:53.908Z",
  "completedAt": null,
  "completedBy": null,
  "notes": null,
  "createdAt": "2026-04-25T10:27:53.909Z",
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
  "id": "9a09f7f4-66fd-4f6e-a0d0-54b75fe94910",
  "inquiryId": "08443d65-75bd-4d96-b7c7-ce603370dd1b",
  "guestProfileId": "7b0318f3-a707-481b-b993-7d0b4fe36fd5",
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
  "createdAt": "2026-04-25T10:27:53.977Z",
  "updatedAt": "2026-04-25T10:27:54.030Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-04-25T10:27:54.028Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null
}
```
### ✅ AC-S9-029 — No-show closure does not schedule W28 (HTTP 200)

```json
{
  "r": {
    "id": "640d2ca4-9c62-4072-8fc6-e6196159fc60",
    "inquiryId": "08443d65-75bd-4d96-b7c7-ce603370dd1b",
    "guestProfileId": "31896c76-ca34-41ee-94ec-fa1dbede5e3a",
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
    "createdAt": "2026-04-25T10:27:54.038Z",
    "updatedAt": "2026-04-25T10:27:54.074Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-04-25T10:27:54.073Z",
    "closedBy": "test-fom-1",
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
  "w28": null
}
```
### ✅ AC-S9-033 — No-show retained penalty creates penalty invoice before closure (HTTP 200)

```json
{
  "inv": {
    "id": "2b1ef824-52d6-40fc-9827-82d6a423b58a",
    "folioId": "6f1dbf4f-c871-4cc7-8a3c-3a3289860305",
    "entryId": "d0f62bc4-2175-401a-8aa4-dcc486648c70",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": null,
    "issuedAt": "2026-04-25T10:27:54.086Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-04-25T10:27:54.086Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "noShowDeterminationId": "dfebab67-271a-438e-b00b-b22d0a4d0bb4"
    },
    "createdAt": "2026-04-25T10:27:54.088Z"
  }
}
```
### ✅ AC-S9-035a — No-show S9 invoice carries NoShowDeterminationRecord reference

```json
{
  "id": "2b1ef824-52d6-40fc-9827-82d6a423b58a",
  "folioId": "6f1dbf4f-c871-4cc7-8a3c-3a3289860305",
  "entryId": "d0f62bc4-2175-401a-8aa4-dcc486648c70",
  "invoiceType": "FINAL",
  "state": "DISPATCHED",
  "invoiceNumber": null,
  "totalAmount": null,
  "templateKey": null,
  "issuedAt": "2026-04-25T10:27:54.086Z",
  "issuedBy": "test-fd-1",
  "dispatchedAt": "2026-04-25T10:27:54.086Z",
  "dispatchedBy": "test-fd-1",
  "dispatchedTo": null,
  "supersededById": null,
  "versionNumber": 1,
  "metadata": {
    "noShowDeterminationId": "dfebab67-271a-438e-b00b-b22d0a4d0bb4"
  },
  "createdAt": "2026-04-25T10:27:54.088Z"
}
```
### ✅ AC-S9-034 — No-show refund obligation confirms outgoing PaymentRecord before closure (HTTP 200)

```json
{
  "pay": {
    "id": "103fc4ef-150c-405c-b26f-b6581bf987cf",
    "folioId": "eecc7590-b986-45bd-98cc-82de5d221707",
    "invoiceId": null,
    "entryId": "886ccc65-fcfa-4da7-8f55-5ed5961d2aff",
    "amount": "15",
    "currency": "BTN",
    "foreignCurrencyAmount": null,
    "btnEquivalent": null,
    "exchangeRate": null,
    "paymentMethod": "CASH",
    "paymentDirection": "OUT",
    "createdAt": "2026-04-25T10:27:54.137Z",
    "receivedAt": null,
    "recordedBy": "test-fom-1",
    "stage": "S9",
    "notes": "NO_SHOW_REFUND:31d93a35-5924-405b-98e7-14fa2a0ab5f5"
  }
}
```
### ✅ AC-S9-035b — No-show refund PaymentRecord carries NoShowDeterminationRecord reference

```json
{
  "id": "103fc4ef-150c-405c-b26f-b6581bf987cf",
  "folioId": "eecc7590-b986-45bd-98cc-82de5d221707",
  "invoiceId": null,
  "entryId": "886ccc65-fcfa-4da7-8f55-5ed5961d2aff",
  "amount": "15",
  "currency": "BTN",
  "foreignCurrencyAmount": null,
  "btnEquivalent": null,
  "exchangeRate": null,
  "paymentMethod": "CASH",
  "paymentDirection": "OUT",
  "createdAt": "2026-04-25T10:27:54.137Z",
  "receivedAt": null,
  "recordedBy": "test-fom-1",
  "stage": "S9",
  "notes": "NO_SHOW_REFUND:31d93a35-5924-405b-98e7-14fa2a0ab5f5"
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
  "id": "0c00cc87-2ba6-4863-ad70-bacb8af4be00",
  "folioId": "88c51ac9-455b-48a0-a8a5-b17650f8ff7e",
  "entryId": "4eb10624-4655-48ec-b19c-7b311c5b81f9",
  "writtenOffAmount": "4000",
  "currency": "BTN",
  "reason": "uncollectable",
  "createdAt": "2026-04-25T10:27:54.178Z",
  "createdBy": "test-gm-1"
}
```
### ✅ AC-S9-041 — After write-off, folio is WRITTEN_OFF and record preserves amount (HTTP 200)

```json
{
  "folio": {
    "id": "88c51ac9-455b-48a0-a8a5-b17650f8ff7e",
    "entryId": "4eb10624-4655-48ec-b19c-7b311c5b81f9",
    "state": "WRITTEN_OFF",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-25T10:27:54.163Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-04-25T10:27:54.164Z",
    "convertedBy": "test",
    "closedAt": null,
    "closedBy": null,
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "6000",
    "advancePaymentReconciliationComplete": false
  },
  "rec": {
    "id": "0c00cc87-2ba6-4863-ad70-bacb8af4be00",
    "folioId": "88c51ac9-455b-48a0-a8a5-b17650f8ff7e",
    "entryId": "4eb10624-4655-48ec-b19c-7b311c5b81f9",
    "writtenOffAmount": "4000",
    "currency": "BTN",
    "reason": "uncollectable",
    "createdAt": "2026-04-25T10:27:54.178Z",
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
  "id": "dbaaf71c-cfcf-4bb4-a445-351c54d2b672",
  "inquiryId": "08443d65-75bd-4d96-b7c7-ce603370dd1b",
  "guestProfileId": "0054e851-a889-4100-b2b3-12f7ca0dcd0a",
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
  "createdAt": "2026-04-25T10:27:54.210Z",
  "updatedAt": "2026-04-25T10:27:54.274Z",
  "createdBy": "test",
  "version": 2,
  "closedAt": "2026-04-25T10:27:54.272Z",
  "closedBy": "test-fom-1",
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": null,
  "keysIssuedCount": null,
  "keysIssuedBy": null,
  "registrationCompletedAt": null,
  "registrationCompletedBy": null
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
    "id": "86e67196-b13f-4790-b9c7-d2c02c7b2ec6",
    "inquiryId": "08443d65-75bd-4d96-b7c7-ce603370dd1b",
    "guestProfileId": "565eb1e3-800c-4b91-9cd9-2aceacd441c7",
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
    "createdAt": "2026-04-25T10:27:54.282Z",
    "updatedAt": "2026-04-25T10:27:54.344Z",
    "createdBy": "test",
    "version": 2,
    "closedAt": "2026-04-25T10:27:54.343Z",
    "closedBy": "test-fom-1",
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
  "breach": {
    "id": "53c83e05-c6eb-4dbe-8506-e6d742ee13fd",
    "eventType": "EQUIPMENT_RETURN.DEADLINE_BREACHED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "EquipmentAllocation",
    "entityId": "c429a252-c174-430d-aff2-fb374c7b1214",
    "operation": "ALERT",
    "payload": {
      "entryId": "86e67196-b13f-4790-b9c7-d2c02c7b2ec6",
      "equipmentCode": "CHAIR_10",
      "equipmentAllocationId": "c429a252-c174-430d-aff2-fb374c7b1214"
    },
    "timestamp": "2026-04-25T10:27:54.312Z",
    "stageContext": "S9",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": "86e67196-b13f-4790-b9c7-d2c02c7b2ec6",
    "createdAt": "2026-04-25T10:27:54.314Z",
    "createdBy": "SYSTEM"
  }
}
```
