# S8 test report

- **Ran at**: 2026-05-13T12:18:28.629Z
- **Base URL**: `http://127.0.0.1:4068/api`
- **Pass**: 27
- **Fail**: 0

## Cases

### ✅ SETUP-S7->S8 — Setup: progress S7->S8 (HTTP 200)

**API response**

```json
{
  "id": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "inquiryId": "876147af-6561-488b-a310-c0aadd98a6af",
  "guestProfileId": "d9310d99-9f56-47a7-9eb8-199f29bfb0a5",
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
  "createdAt": "2026-05-13T12:18:15.074Z",
  "updatedAt": "2026-05-13T12:18:27.727Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-05-13T12:18:15.072Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-05-13T12:18:15.072Z",
  "registrationCompletedBy": "actor-seed-system",
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S8-25 — Key return discrepancy requires reconciliationNote (HTTP 400)

**API response**

```json
{
  "error": "ValidationError",
  "message": "reconciliationNote is required when keyCountReturned differs from keysIssuedCount"
}
```
### ✅ AC-S8-26 — KeyReturnRecord with discrepancy satisfies key-return condition (HTTP 201)

**API response**

```json
{
  "id": "02c81178-d6b1-4a55-b729-c7d00b40ea86",
  "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "roomId": "fdfb7ffc-cd78-4b9c-9712-5fd0365cedf1",
  "receivedBy": "test-fd-1",
  "returnedAt": "2026-05-13T12:18:27.761Z",
  "keyCountIssued": 2,
  "keyCountReturned": 0,
  "countReconciled": false,
  "reconciliationNote": "Guest lost key; governed resolution recorded",
  "createdAt": "2026-05-13T12:18:27.762Z"
}
```
### ✅ AC-S8-15 — Inspection NOT_APPLICABLE rejected when unresolved deficient exists (HTTP 409)

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Active DEFICIENT flag exists — inspection must carry final deficient status",
  "blockingCondition": "DEFICIENT_REQUIRES_FLAG_STATUS"
}
```
### ✅ AC-S8-14 — RoomInspectionRecord always carries deficientFlagStatus and can schedule deferral (W9) (HTTP 201)

**API response**

```json
{
  "id": "4230bc39-0d08-41c0-9790-8a1c3f8f7c37",
  "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "roomId": "fdfb7ffc-cd78-4b9c-9712-5fd0365cedf1",
  "segmentId": "ce4290ef-f10d-4482-9f16-befa06cae633",
  "inspectedBy": "test-fd-1",
  "inspectedAt": "2026-05-13T12:18:27.789Z",
  "isDeferred": true,
  "deficientFlagStatus": "UNRESOLVED_AT_CHECKOUT",
  "deficientConditionId": "8035a12c-c1e2-49c9-bcfd-3175ffc4701b",
  "inspectorAssessment": "Condition present; governed service recovery",
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-05-13T12:18:27.790Z"
}
```
### ✅ AC-S8-23 — Inspection deferral registers W9 timer in same workflow

**API response**

```json
{
  "id": "44bc4fcc-0584-4f43-8e44-88078c70b1dc",
  "dueAt": "2026-05-15T12:18:27.800Z",
  "timerCode": "POST_CHECKOUT_INSPECTION_W9"
}
```
### ✅ AC-S8-06 — Guest-pay CASH settlement transitions folio to SETTLED and creates payment record (HTTP 200)

**API response**

```json
{
  "id": "30361352-0670-4288-8076-67f06252dac7",
  "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-05-13T12:18:15.081Z",
  "createdBy": "actor-seed-system",
  "convertedToLiveAt": "2026-05-13T12:18:15.080Z",
  "convertedBy": "actor-seed-system",
  "closedAt": "2026-05-13T12:18:27.973Z",
  "closedBy": "test-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "0",
  "advancePaymentReconciliationComplete": true
}
```
### ✅ AC-S8-01 — Checkout completion moves room OCCUPIED -> DEPARTED_DIRTY

**API response**

```json
{
  "before": "OCCUPIED",
  "after": "DEPARTED_DIRTY"
}
```
### ✅ AC-S8-04 — S8 does not release inventory claim (room is not FREE at checkout)

**API response**

```json
{
  "claimState": "DEPARTED_DIRTY"
}
```
### ✅ AC-S8-03 — DEPARTED_DIRTY write registers W24 timer

**API response**

```json
{
  "id": "2f183a85-35da-4338-8ad7-5a2d928b5d3e",
  "dueAt": "2026-05-13T15:18:28.009Z"
}
```
### ✅ AC-S8-02 — Direct OCCUPIED→DEPARTED_CLEAN is rejected

**API response**

```json
{
  "ok": false
}
```
### ✅ AC-S8-05 — DEPARTED_DIRTY room not bookable for new hold (HTTP 409)

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Room is not available for speculative hold",
  "blockingCondition": "ROOM_NOT_FREE"
}
```
### ✅ AC-S8-17 — H4 fulfilment evidence must be complete (HTTP 409)

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "fulfilmentEvidence.roomInspectionStatus is required",
  "blockingCondition": "H4_FULFILMENT_EVIDENCE_INCOMPLETE"
}
```
### ✅ SETUP-H4-FULFIL — Setup: fulfil H4 with complete evidence (HTTP 200)

**API response**

```json
{
  "id": "bd997922-00f7-4678-9dc6-ba127a613e88",
  "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "handoffType": "H4",
  "state": "FULFILLED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "actor-seed-system",
  "toRole": "HOUSEKEEPING",
  "toActorId": null,
  "checklistContent": {
    "roomNumber": "501",
    "expectedCheckoutDate": "2026-04-22T09:00:00.000Z"
  },
  "deficientConditionStatus": null,
  "fulfilmentEvidence": {
    "roomInspectionStatus": "RECORDED_OR_DEFERRED",
    "damageAssessmentStatus": "COMPLETE_OR_DEFERRED",
    "deficientFlagFinalStatus": "RECORDED",
    "chargesPostedConfirmation": true
  },
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": "2026-05-13T12:18:28.059Z",
  "fulfilledBy": "test-fd-1",
  "closedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "escalatedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelledReason": null,
  "slaDeadlineAt": null,
  "isAutoFulfilled": false,
  "createdAt": "2026-05-13T12:18:15.087Z",
  "createdBy": "actor-seed-system",
  "stageContext": "S7"
}
```
### ✅ AC-S8-18 — S8->S9 blocked when H4 is not fulfilled/auto-fulfilled (HTTP 409)

**API response**

```json
{
  "error": "StageGatesBlockedError",
  "message": "H4 must be fulfilled before S8 exit",
  "blockingCondition": "H4_NOT_FULFILLED",
  "details": {
    "failures": [
      {
        "blockingCondition": "H4_NOT_FULFILLED",
        "message": "H4 must be fulfilled before S8 exit"
      }
    ]
  }
}
```
### ✅ AC-S8-11 — S8->S9 blocked when dispute gate BLOCKED (no override) (HTTP 409)

**API response**

```json
{
  "error": "StageGatesBlockedError",
  "message": "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)",
  "blockingCondition": "DISPUTE_GATE_BLOCKED",
  "details": {
    "failures": [
      {
        "blockingCondition": "DISPUTE_GATE_BLOCKED",
        "message": "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)"
      }
    ]
  }
}
```
### ✅ AC-S8-12 — Dispute gate override endpoint rejects targetStage S9 (HTTP 409)

**API response**

```json
{
  "error": "PolicyGateBlockedError",
  "message": "Dispute gate override is not available for S8→S9",
  "blockingCondition": "DISPUTE_OVERRIDE_NOT_AVAILABLE"
}
```
### ✅ AC-S8-13-setup — GM closes dispute (HTTP 200)

**API response**

```json
{
  "id": "8d267d97-f7d2-491c-877c-869a62fca0a3",
  "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "folioId": "30361352-0670-4288-8076-67f06252dac7",
  "status": "CLOSED",
  "title": "Checkout dispute",
  "description": null,
  "openedAt": "2026-05-13T12:18:28.287Z",
  "openedBy": "test-fd-1",
  "updatedAt": "2026-05-13T12:18:28.333Z",
  "updatedBy": "test-gm-1",
  "closedAt": "2026-05-13T12:18:28.325Z",
  "closedBy": "test-gm-1",
  "closureReason": "GM closed at checkout"
}
```
### ✅ S8->S9 — Progress S8->S9 after settlement + key return + inspection + dispute clear (HTTP 200)

**API response**

```json
{
  "id": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
  "inquiryId": "876147af-6561-488b-a310-c0aadd98a6af",
  "guestProfileId": "d9310d99-9f56-47a7-9eb8-199f29bfb0a5",
  "segmentNumber": 1,
  "useType": "LEISURE",
  "status": "ACTIVE",
  "currentStage": "S9",
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
  "createdAt": "2026-05-13T12:18:15.074Z",
  "updatedAt": "2026-05-13T12:18:28.356Z",
  "createdBy": "actor-seed-system",
  "version": 3,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-05-13T12:18:15.072Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-05-13T12:18:15.072Z",
  "registrationCompletedBy": "actor-seed-system",
  "apartmentDurationNights": null,
  "apartmentRateTierCode": null
}
```
### ✅ AC-S8-07 — Partial payment produces OUTSTANDING (HTTP 200)

**API response**

```json
{
  "f1": {
    "id": "4704d3a6-e788-453d-9bea-bc6e94f2709e",
    "entryId": "69788707-567e-44e0-b649-4d750ca93046",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-05-13T12:18:28.372Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-05-13T12:18:28.372Z",
    "convertedBy": "test",
    "closedAt": "2026-05-13T12:18:28.432Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "90",
    "advancePaymentReconciliationComplete": false
  },
  "r1": {
    "id": "4704d3a6-e788-453d-9bea-bc6e94f2709e",
    "entryId": "69788707-567e-44e0-b649-4d750ca93046",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-05-13T12:18:28.372Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-05-13T12:18:28.372Z",
    "convertedBy": "test",
    "closedAt": "2026-05-13T12:18:28.432Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "90",
    "advancePaymentReconciliationComplete": false
  }
}
```
### ✅ AC-S8-08 — Direct bill produces OUTSTANDING + DISPATCHED FINAL invoice (HTTP 200)

**API response**

```json
{
  "f2": {
    "id": "29e38512-f99f-4748-8ea1-b76df782847d",
    "entryId": "109396f2-2673-4120-83f2-0830dedb4b79",
    "state": "OUTSTANDING",
    "billingModel": "DIRECT_BILL",
    "createdAt": "2026-05-13T12:18:28.461Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-05-13T12:18:28.462Z",
    "convertedBy": "test",
    "closedAt": "2026-05-13T12:18:28.492Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "50",
    "advancePaymentReconciliationComplete": false
  },
  "inv": {
    "id": "8b0ca663-ef45-452e-9ace-bc0e622e3ebb",
    "folioId": "29e38512-f99f-4748-8ea1-b76df782847d",
    "entryId": "109396f2-2673-4120-83f2-0830dedb4b79",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "final-v1",
    "issuedAt": "2026-05-13T12:18:28.483Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-05-13T12:18:28.483Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "billingModel": "DIRECT_BILL",
      "settlementMethod": "DIRECT_BILL",
      "outstandingBalance": "50"
    },
    "createdAt": "2026-05-13T12:18:28.484Z"
  }
}
```
### ✅ AC-S8-09 — Voucher path invoices difference and sets OUTSTANDING (HTTP 200)

**API response**

```json
{
  "f3": {
    "id": "96d36066-2284-47b9-bcc4-154f2d0c613b",
    "entryId": "3492097e-ca05-431b-b25b-c175cdbf991c",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-05-13T12:18:28.524Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-05-13T12:18:28.524Z",
    "convertedBy": "test",
    "closedAt": "2026-05-13T12:18:28.544Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "40",
    "advancePaymentReconciliationComplete": false
  },
  "inv2": {
    "id": "80ffd207-ab51-4db1-9305-18013550fd49",
    "folioId": "96d36066-2284-47b9-bcc4-154f2d0c613b",
    "entryId": "3492097e-ca05-431b-b25b-c175cdbf991c",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "agent-billing-v1",
    "issuedAt": "2026-05-13T12:18:28.543Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-05-13T12:18:28.543Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "remaining": 40,
      "billingModel": "GUEST_PAY",
      "voucherCovered": 60,
      "settlementMethod": "VOUCHER"
    },
    "createdAt": "2026-05-13T12:18:28.544Z"
  }
}
```
### ✅ AC-S8-10 — Dispute gate returns BLOCKED with overrideAvailable=false

**API response**

```json
{
  "result": "BLOCKED",
  "overrideAvailable": false
}
```
### ✅ AC-S8-19 — OUTSTANDING creates H5 CREATED

**API response**

```json
{
  "id": "ac718795-762c-4ee3-9f86-f01014266c4a",
  "entryId": "fc6a322c-eccd-4acf-934a-79a20ddabe1e",
  "handoffType": "H5",
  "state": "CREATED",
  "fromRole": "FRONT_DESK",
  "fromActorId": "test-fd-1",
  "toRole": "FINANCE",
  "toActorId": null,
  "checklistContent": {
    "basis": "Checkout governed outstanding",
    "outstandingBalance": "10"
  },
  "deficientConditionStatus": null,
  "fulfilmentEvidence": null,
  "assignedAt": null,
  "acceptedAt": null,
  "acceptedBy": null,
  "fulfilledAt": null,
  "fulfilledBy": null,
  "closedAt": null,
  "rejectedAt": null,
  "rejectedBy": null,
  "rejectionReason": null,
  "escalatedAt": null,
  "cancelledAt": null,
  "cancelledBy": null,
  "cancelledReason": null,
  "slaDeadlineAt": null,
  "isAutoFulfilled": false,
  "createdAt": "2026-05-13T12:18:28.580Z",
  "createdBy": "test-fd-1",
  "stageContext": "S8"
}
```
### ✅ AC-S8-20 — SETTLED auto-fulfils H5 with HANDOFF.AUTO_FULFILLED trace

**API response**

```json
{
  "h5a": {
    "id": "8a7f528b-b6d0-4a94-a27d-9f1822aceae9",
    "entryId": "28fb00ca-cfdd-4486-8c69-9d8e0eec6ef7",
    "handoffType": "H5",
    "state": "FULFILLED",
    "fromRole": "SYSTEM",
    "fromActorId": "system",
    "toRole": "FINANCE",
    "toActorId": null,
    "checklistContent": {
      "autoFulfilled": true
    },
    "deficientConditionStatus": null,
    "fulfilmentEvidence": null,
    "assignedAt": null,
    "acceptedAt": null,
    "acceptedBy": null,
    "fulfilledAt": "2026-05-13T12:18:28.592Z",
    "fulfilledBy": "system",
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
    "createdAt": "2026-05-13T12:18:28.593Z",
    "createdBy": "system",
    "stageContext": "S8"
  },
  "te": {
    "id": "06963c3f-037c-4b67-882d-8d5342a4bbfe",
    "eventType": "HANDOFF.AUTO_FULFILLED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "HandoffRecord",
    "entityId": "8a7f528b-b6d0-4a94-a27d-9f1822aceae9",
    "operation": "TRANSITION",
    "payload": {
      "entryId": "28fb00ca-cfdd-4486-8c69-9d8e0eec6ef7",
      "handoffId": "8a7f528b-b6d0-4a94-a27d-9f1822aceae9",
      "handoffType": "H5"
    },
    "timestamp": "2026-05-13T12:18:28.592Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": "bd52b248-f023-4939-afdb-9825d5ea25ba",
    "entryId": "28fb00ca-cfdd-4486-8c69-9d8e0eec6ef7",
    "createdAt": "2026-05-13T12:18:28.595Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S8-21/22 — W33 emits notice and does not block repeated overrides

**API response**

```json
{
  "o1": {
    "skipped": false,
    "count": 2,
    "maxFrequency": 1,
    "rollingWindowDays": 7
  },
  "o2": {
    "skipped": false,
    "count": 2,
    "maxFrequency": 1,
    "rollingWindowDays": 7
  },
  "te1": {
    "id": "c25d2996-70c0-47c0-8cdf-e5b47b3a1872",
    "eventType": "FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "DisputeGateOverrideRecord",
    "entityId": "W33",
    "operation": "ALERT",
    "payload": {
      "count": 2,
      "since": "2026-05-06T12:18:28.605Z",
      "maxFrequency": 1,
      "rollingWindowDays": 7
    },
    "timestamp": "2026-05-13T12:18:28.605Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-05-13T12:18:28.611Z",
    "createdBy": "SYSTEM"
  },
  "te2": {
    "id": "ed3ff5c3-7c3a-4bbc-9e5f-e08ea20241e4",
    "eventType": "FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "DisputeGateOverrideRecord",
    "entityId": "W33",
    "operation": "ALERT",
    "payload": {
      "count": 2,
      "since": "2026-05-06T12:18:28.612Z",
      "maxFrequency": 1,
      "rollingWindowDays": 7
    },
    "timestamp": "2026-05-13T12:18:28.612Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-05-13T12:18:28.615Z",
    "createdBy": "SYSTEM"
  }
}
```
### ✅ AC-S8-24 — W9 expiry emits POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED

**API response**

```json
{
  "r": {
    "skipped": false,
    "timerId": "44bc4fcc-0584-4f43-8e44-88078c70b1dc"
  },
  "te": {
    "id": "85b61915-b320-47c5-af40-09b19e86a6ac",
    "eventType": "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "Entry",
    "entityId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
    "operation": "ALERT",
    "payload": {
      "dueAt": "2026-05-15T12:18:27.800Z",
      "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
      "timerId": "44bc4fcc-0584-4f43-8e44-88078c70b1dc"
    },
    "timestamp": "2026-05-13T12:18:28.624Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": "876147af-6561-488b-a310-c0aadd98a6af",
    "entryId": "a5b2f94d-4e16-41fe-acb2-0ad245e8523a",
    "createdAt": "2026-05-13T12:18:28.627Z",
    "createdBy": "SYSTEM"
  }
}
```
