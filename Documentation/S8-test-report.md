# S8 test report

- **Ran at**: 2026-04-25T08:53:23.635Z
- **Base URL**: `http://localhost:4000/api`
- **Pass**: 27
- **Fail**: 0

## Cases

### ✅ SETUP-S7->S8 — Setup: progress S7->S8 (HTTP 200)

**API response**

```json
{
  "id": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "inquiryId": "2cfa54d4-4be0-4e52-86eb-400ac8eb3a5d",
  "guestProfileId": "7d989f03-036f-48ac-8557-77407de48c81",
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
  "createdAt": "2026-04-25T08:53:21.311Z",
  "updatedAt": "2026-04-25T08:53:22.956Z",
  "createdBy": "actor-seed-system",
  "version": 2,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T08:53:21.309Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T08:53:21.309Z",
  "registrationCompletedBy": "actor-seed-system"
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
### ✅ AC-S8-26 — KeyReturnRecord with discrepancy satisfies key-return condition (HTTP 200)

**API response**

```json
{
  "id": "adea660e-de12-49cd-ba93-af6b2917c34b",
  "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "roomId": "27a7dea0-f839-4a77-904b-9d112c12b458",
  "receivedBy": "test-fd-1",
  "returnedAt": "2026-04-25T08:53:23.001Z",
  "keyCountIssued": 2,
  "keyCountReturned": 0,
  "countReconciled": false,
  "reconciliationNote": "Guest lost key; governed resolution recorded",
  "createdAt": "2026-04-25T08:53:23.002Z"
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
### ✅ AC-S8-14 — RoomInspectionRecord always carries deficientFlagStatus and can schedule deferral (W9) (HTTP 200)

**API response**

```json
{
  "id": "8b80612f-3c03-4b25-b07e-17e2503cb36d",
  "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "roomId": "27a7dea0-f839-4a77-904b-9d112c12b458",
  "segmentId": "12b0777d-f519-4a58-aff1-31b6bc817dc3",
  "inspectedBy": "test-fd-1",
  "inspectedAt": "2026-04-25T08:53:23.038Z",
  "isDeferred": true,
  "deficientFlagStatus": "UNRESOLVED_AT_CHECKOUT",
  "deficientConditionId": "6b60f102-7f68-4342-978b-5a233bf4569c",
  "inspectorAssessment": "Condition present; governed service recovery",
  "damageFound": false,
  "damageNotes": null,
  "createdAt": "2026-04-25T08:53:23.040Z"
}
```
### ✅ AC-S8-23 — Inspection deferral registers W9 timer in same workflow

**API response**

```json
{
  "id": "8400d636-6e29-4b69-8682-7237fc0a3204",
  "dueAt": "2026-04-27T08:53:23.043Z",
  "timerCode": "POST_CHECKOUT_INSPECTION_W9"
}
```
### ✅ AC-S8-06 — Guest-pay CASH settlement transitions folio to SETTLED and creates payment record (HTTP 200)

**API response**

```json
{
  "id": "caa7cb00-8131-4852-9dbd-d3618464eefb",
  "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "state": "SETTLED",
  "billingModel": "GUEST_PAY",
  "createdAt": "2026-04-25T08:53:21.320Z",
  "createdBy": "actor-seed-system",
  "convertedToLiveAt": "2026-04-25T08:53:21.319Z",
  "convertedBy": "actor-seed-system",
  "closedAt": "2026-04-25T08:53:23.073Z",
  "closedBy": "test-fd-1",
  "noShowPenaltyAmount": null,
  "noShowAdvancePaymentAmount": null,
  "noShowNetPosition": null,
  "noShowFomDetermination": null,
  "outstandingBalance": "700",
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
  "id": "18d4e6a2-ead6-45b3-9d6f-36e016bd40f2",
  "dueAt": "2026-04-25T11:53:23.081Z"
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
  "id": "10b8701e-3e10-4a0a-b727-b9ce492fda6f",
  "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
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
  "fulfilledAt": "2026-04-25T08:53:23.143Z",
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
  "createdAt": "2026-04-25T08:53:21.329Z",
  "createdBy": "actor-seed-system",
  "stageContext": "S7"
}
```
### ✅ AC-S8-18 — S8->S9 blocked when H4 is not fulfilled/auto-fulfilled (HTTP 409)

**API response**

```json
{
  "error": "StageGateBlockedError",
  "message": "H4 must be fulfilled before S8 exit",
  "blockingCondition": "H4_NOT_FULFILLED"
}
```
### ✅ AC-S8-11 — S8->S9 blocked when dispute gate BLOCKED (no override) (HTTP 409)

**API response**

```json
{
  "error": "StageGateBlockedError",
  "message": "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)",
  "blockingCondition": "DISPUTE_GATE_BLOCKED"
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
  "id": "a77a3cda-f8d5-4295-8eb2-003f6dde27a1",
  "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "folioId": "caa7cb00-8131-4852-9dbd-d3618464eefb",
  "status": "CLOSED",
  "title": "Checkout dispute",
  "description": null,
  "openedAt": "2026-04-25T08:53:23.261Z",
  "openedBy": "test-fd-1",
  "updatedAt": "2026-04-25T08:53:23.283Z",
  "updatedBy": "test-gm-1",
  "closedAt": "2026-04-25T08:53:23.281Z",
  "closedBy": "test-gm-1",
  "closureReason": "GM closed at checkout"
}
```
### ✅ S8->S9 — Progress S8->S9 after settlement + key return + inspection + dispute clear (HTTP 200)

**API response**

```json
{
  "id": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
  "inquiryId": "2cfa54d4-4be0-4e52-86eb-400ac8eb3a5d",
  "guestProfileId": "7d989f03-036f-48ac-8557-77407de48c81",
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
  "createdAt": "2026-04-25T08:53:21.311Z",
  "updatedAt": "2026-04-25T08:53:23.307Z",
  "createdBy": "actor-seed-system",
  "version": 3,
  "closedAt": null,
  "closedBy": null,
  "noShowCutoffReachedAt": null,
  "creditCeilingTier2AcknowledgedAt": null,
  "creditCeilingTier2AcknowledgedBy": null,
  "awaitingWrittenConfirmationActive": false,
  "keysIssuedAt": "2026-04-25T08:53:21.309Z",
  "keysIssuedCount": 2,
  "keysIssuedBy": "actor-seed-system",
  "registrationCompletedAt": "2026-04-25T08:53:21.309Z",
  "registrationCompletedBy": "actor-seed-system"
}
```
### ✅ AC-S8-07 — Partial payment produces OUTSTANDING (HTTP 200)

**API response**

```json
{
  "f1": {
    "id": "8ccf3ac2-cdcd-4fec-b85a-715bcc7a1bbd",
    "entryId": "52077612-e2f3-4e11-b690-9c1bfac38375",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-25T08:53:23.330Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-04-25T08:53:23.334Z",
    "convertedBy": "test",
    "closedAt": "2026-04-25T08:53:23.345Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "100",
    "advancePaymentReconciliationComplete": false
  },
  "r1": {
    "id": "8ccf3ac2-cdcd-4fec-b85a-715bcc7a1bbd",
    "entryId": "52077612-e2f3-4e11-b690-9c1bfac38375",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-25T08:53:23.330Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-04-25T08:53:23.334Z",
    "convertedBy": "test",
    "closedAt": "2026-04-25T08:53:23.345Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "100",
    "advancePaymentReconciliationComplete": false
  }
}
```
### ✅ AC-S8-08 — Direct bill produces OUTSTANDING + DISPATCHED FINAL invoice (HTTP 200)

**API response**

```json
{
  "f2": {
    "id": "5592a9d1-0257-4b1d-9bef-d1826aa16d1f",
    "entryId": "8151ada5-fd5f-4c8d-abed-97e86577ecfe",
    "state": "OUTSTANDING",
    "billingModel": "DIRECT_BILL",
    "createdAt": "2026-04-25T08:53:23.371Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-04-25T08:53:23.373Z",
    "convertedBy": "test",
    "closedAt": "2026-04-25T08:53:23.383Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "50",
    "advancePaymentReconciliationComplete": false
  },
  "inv": {
    "id": "ac386768-614e-4829-b4df-decb3be16fdf",
    "folioId": "5592a9d1-0257-4b1d-9bef-d1826aa16d1f",
    "entryId": "8151ada5-fd5f-4c8d-abed-97e86577ecfe",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "final-v1",
    "issuedAt": "2026-04-25T08:53:23.381Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-04-25T08:53:23.381Z",
    "dispatchedBy": "test-fd-1",
    "dispatchedTo": null,
    "supersededById": null,
    "versionNumber": 1,
    "metadata": {
      "billingModel": "DIRECT_BILL",
      "settlementMethod": "DIRECT_BILL",
      "outstandingBalance": "50"
    },
    "createdAt": "2026-04-25T08:53:23.383Z"
  }
}
```
### ✅ AC-S8-09 — Voucher path invoices difference and sets OUTSTANDING (HTTP 200)

**API response**

```json
{
  "f3": {
    "id": "6c717b81-df77-40fa-9fd9-e3fc98a9a306",
    "entryId": "62c8a9dd-98d5-4979-936d-8003ff27775c",
    "state": "OUTSTANDING",
    "billingModel": "GUEST_PAY",
    "createdAt": "2026-04-25T08:53:23.411Z",
    "createdBy": "test",
    "convertedToLiveAt": "2026-04-25T08:53:23.413Z",
    "convertedBy": "test",
    "closedAt": "2026-04-25T08:53:23.426Z",
    "closedBy": "test-fd-1",
    "noShowPenaltyAmount": null,
    "noShowAdvancePaymentAmount": null,
    "noShowNetPosition": null,
    "noShowFomDetermination": null,
    "outstandingBalance": "100",
    "advancePaymentReconciliationComplete": false
  },
  "inv2": {
    "id": "61644d11-095c-4ea3-bcdd-d682e510f718",
    "folioId": "6c717b81-df77-40fa-9fd9-e3fc98a9a306",
    "entryId": "62c8a9dd-98d5-4979-936d-8003ff27775c",
    "invoiceType": "FINAL",
    "state": "DISPATCHED",
    "invoiceNumber": null,
    "totalAmount": null,
    "templateKey": "agent-billing-v1",
    "issuedAt": "2026-04-25T08:53:23.424Z",
    "issuedBy": "test-fd-1",
    "dispatchedAt": "2026-04-25T08:53:23.424Z",
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
    "createdAt": "2026-04-25T08:53:23.426Z"
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
  "id": "f702f2be-bfc8-445b-b7cf-b9ade0ed2977",
  "entryId": "38c022ec-3cbf-4364-b867-abcfc75abfd7",
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
  "createdAt": "2026-04-25T08:53:23.543Z",
  "createdBy": "test-fd-1",
  "stageContext": "S8"
}
```
### ✅ AC-S8-20 — SETTLED auto-fulfils H5 with HANDOFF.AUTO_FULFILLED trace

**API response**

```json
{
  "h5a": {
    "id": "faf79461-e15b-47e0-9d20-982652e8b5b0",
    "entryId": "b11c2adc-cfdd-4243-938f-103071d4f007",
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
    "fulfilledAt": "2026-04-25T08:53:23.562Z",
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
    "createdAt": "2026-04-25T08:53:23.563Z",
    "createdBy": "system",
    "stageContext": "S8"
  },
  "te": {
    "id": "267c981a-6f63-4293-8812-5e965fcd4c79",
    "eventType": "HANDOFF.AUTO_FULFILLED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "HandoffRecord",
    "entityId": "faf79461-e15b-47e0-9d20-982652e8b5b0",
    "operation": "TRANSITION",
    "payload": {
      "entryId": "b11c2adc-cfdd-4243-938f-103071d4f007",
      "handoffId": "faf79461-e15b-47e0-9d20-982652e8b5b0",
      "handoffType": "H5"
    },
    "timestamp": "2026-04-25T08:53:23.562Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": "2cfa54d4-4be0-4e52-86eb-400ac8eb3a5d",
    "entryId": "b11c2adc-cfdd-4243-938f-103071d4f007",
    "createdAt": "2026-04-25T08:53:23.565Z",
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
    "id": "ef3ab177-700f-4e07-b179-5154ee844360",
    "eventType": "FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "DisputeGateOverrideRecord",
    "entityId": "W33",
    "operation": "ALERT",
    "payload": {
      "count": 2,
      "since": "2026-04-18T08:53:23.595Z",
      "maxFrequency": 1,
      "rollingWindowDays": 7
    },
    "timestamp": "2026-04-25T08:53:23.595Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-04-25T08:53:23.599Z",
    "createdBy": "SYSTEM"
  },
  "te2": {
    "id": "6cb9b5b5-ee55-405f-a26f-c19e28de40e8",
    "eventType": "FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "DisputeGateOverrideRecord",
    "entityId": "W33",
    "operation": "ALERT",
    "payload": {
      "count": 2,
      "since": "2026-04-18T08:53:23.601Z",
      "maxFrequency": 1,
      "rollingWindowDays": 7
    },
    "timestamp": "2026-04-25T08:53:23.601Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": null,
    "entryId": null,
    "createdAt": "2026-04-25T08:53:23.603Z",
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
    "timerId": "8400d636-6e29-4b69-8682-7237fc0a3204"
  },
  "te": {
    "id": "686f11c0-c714-4791-be5c-6f73b481cac7",
    "eventType": "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED",
    "actorId": "SYSTEM",
    "actorLevel": "SYSTEM",
    "entityType": "Entry",
    "entityId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
    "operation": "ALERT",
    "payload": {
      "dueAt": "2026-04-27T08:53:23.043Z",
      "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
      "timerId": "8400d636-6e29-4b69-8682-7237fc0a3204"
    },
    "timestamp": "2026-04-25T08:53:23.630Z",
    "stageContext": "S8",
    "segmentContext": null,
    "correlationId": null,
    "inquiryId": "2cfa54d4-4be0-4e52-86eb-400ac8eb3a5d",
    "entryId": "0d79d3b2-1f58-421a-8436-a6a646ea342e",
    "createdAt": "2026-04-25T08:53:23.633Z",
    "createdBy": "SYSTEM"
  }
}
```
